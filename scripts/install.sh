#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE="$ROOT/src/main.ts"
BIN_DIR="${AGENTSURFACE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${AGENTSURFACE_INSTALL_STATE_DIR:-$HOME/.local/state/agentsurface}"
# The command is an EDITABLE install: ~/.local/bin/agentsurface links
# straight to this checkout's src/main.ts and runs the live working tree,
# like the rest of the fleet's tools. The snapshot deploy that preceded it
# (and its deployed-sha receipt) is recognized only to be cleaned up.
SNAP_DIR="${AGENTSURFACE_INSTALL_SNAP_DIR:-$HOME/.local/share/agentsurface/app}"
SNAP_SOURCE="$SNAP_DIR/src/main.ts"
TARGET="$BIN_DIR/agentsurface"
RECEIPT="$STATE_DIR/deployed-sha"
UPSTREAM_ORIGIN="git@github.com:possibilities/agentsurface.git"
# A fork installs from its own checkout, so the origin this refuses to
# install from has to be overridable; the upstream spelling is the default.
EXPECTED_ORIGIN="${AGENTSURFACE_INSTALL_EXPECTED_ORIGIN:-$UPSTREAM_ORIGIN}"
TMP_PATH=""

cleanup() {
  if [[ -n "$TMP_PATH" ]]; then
    rm -f -- "$TMP_PATH"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [--install|--uninstall|--help]

With no option, installs agentsurface. Installation runs Bun's frozen
dependency install and links ~/.local/bin/agentsurface straight to the
checkout's src/main.ts — an editable install: the command runs the live
working tree, like the rest of the fleet. Rerunning converges the link,
and removes the retired snapshot deploy (~/.local/share/agentsurface/app)
and its ~/.local/state/agentsurface/deployed-sha receipt when found.

Set AGENTSURFACE_INSTALL_BIN_DIR, AGENTSURFACE_INSTALL_STATE_DIR, and
AGENTSURFACE_INSTALL_SNAP_DIR to use other locations (including for
hermetic tests).
USAGE
}

die() {
  echo "$1" >&2
  exit "${2:-1}"
}

owner_uid() {
  stat -c %u "$1" 2>/dev/null || stat -f %u "$1"
}

file_mode() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"
}

validate_path() {
  local path="$1"
  local label="$2"
  local component current="" remainder platform

  [[ -n "$path" && "$path" == /* ]] || die "Refusing unsafe $label path (must be absolute): $path"
  [[ "$path" != "/" && "$path" != *//* && "$path" != */./* && "$path" != */../* && "$path" != */. && "$path" != */.. ]] || \
    die "Refusing unsafe $label path: $path"

  platform="$(uname -s)"
  remainder="${path#/}"
  while [[ -n "$remainder" ]]; do
    component="${remainder%%/*}"
    current="$current/$component"
    if [[ "$remainder" == */* ]]; then
      remainder="${remainder#*/}"
    else
      remainder=""
    fi

    # macOS exposes these two stable lexical aliases into /private. Preserve
    # normal /tmp and /var paths while rejecting every application-controlled
    # symlink component below them.
    if [[ "$platform" == "Darwin" ]]; then
      case "$current:$(readlink "$current" 2>/dev/null || true)" in
        /tmp:private/tmp|/tmp:/private/tmp|/var:private/var|/var:/private/var)
          continue
          ;;
      esac
    fi
    [[ ! -L "$current" ]] || die "Refusing symlinked $label path component: $current"
  done
}

validate_directory() {
  local dir="$1"
  local label="$2"
  local mode mode_value

  validate_path "$dir" "$label"
  [[ -d "$dir" ]] || die "Refusing non-directory $label path: $dir"
  [[ "$(owner_uid "$dir")" == "$(id -u)" ]] || die "Refusing foreign $label directory: $dir"
  mode="$(file_mode "$dir")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "Could not validate permissions for $label directory: $dir"
  mode_value=$((8#$mode))
  (( (mode_value & 0022) == 0 )) || die "Refusing unsafe writable $label directory: $dir"
}

ensure_directory() {
  local dir="$1"
  local label="$2"
  local create_mode="$3"

  validate_path "$dir" "$label"
  if [[ -e "$dir" ]]; then
    [[ -d "$dir" ]] || die "Refusing non-directory $label path: $dir"
  else
    mkdir -p -- "$dir"
    chmod "$create_mode" "$dir"
  fi
  validate_directory "$dir" "$label"
}

validate_safe_file() {
  local path="$1"
  local label="$2"
  local mode mode_value

  [[ ! -L "$path" && -f "$path" ]] || die "Refusing unsafe $label: $path"
  [[ "$(owner_uid "$path")" == "$(id -u)" ]] || die "Refusing foreign $label: $path"
  mode="$(file_mode "$path")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "Could not validate permissions for $label: $path"
  mode_value=$((8#$mode))
  (( (mode_value & 0022) == 0 )) || die "Refusing unsafe writable $label: $path"
}

checkout_head() {
  local root="$1"
  local physical_root top sha

  [[ -d "$root/.git" || -f "$root/.git" ]] || return 1
  physical_root="$(cd "$root" && pwd -P)" || return 1
  top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$top" == "$physical_root" ]] || return 1
  sha="$(git -C "$root" rev-parse --verify HEAD 2>/dev/null)" || return 1
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$sha"
}

normalized_origin() {
  local origin="$1"
  origin="${origin%/}"
  case "$origin" in
    https://github.com/possibilities/agentsurface|https://github.com/possibilities/agentsurface.git)
      printf '%s\n' "$UPSTREAM_ORIGIN"
      ;;
    git@github.com:possibilities/agentsurface|git@github.com:possibilities/agentsurface.git|ssh://git@github.com/possibilities/agentsurface|ssh://git@github.com/possibilities/agentsurface.git)
      printf '%s\n' "$UPSTREAM_ORIGIN"
      ;;
    *)
      printf '%s\n' "$origin"
      ;;
  esac
}

validate_managed_checkout() {
  local root="$1"
  local source="$root/src/main.ts"
  local origin sha

  [[ "$root" == /* ]] || die "Refusing managed command with a non-absolute source root: $root"
  validate_path "$root" "source root"
  validate_directory "$root" "source root"
  validate_safe_file "$source" "agentsurface source command"
  [[ -x "$source" ]] || die "Refusing non-executable agentsurface source command: $source"
  sha="$(checkout_head "$root")" || die "Refusing agentsurface source outside an exact Git checkout: $root"
  origin="$(git -C "$root" remote get-url origin 2>/dev/null)" || die "Refusing agentsurface source without an origin: $root"
  [[ "$(normalized_origin "$origin")" == "$EXPECTED_ORIGIN" ]] || die "Refusing agentsurface source with foreign origin: $root"
  MANAGED_ROOT="$root"
  MANAGED_SHA="$sha"
}

classify_command() {
  local destination root
  MANAGED_KIND="absent"
  MANAGED_ROOT=""
  MANAGED_SHA=""

  if [[ ! -e "$TARGET" && ! -L "$TARGET" ]]; then
    return 0
  fi

  if [[ -L "$TARGET" ]]; then
    [[ "$(owner_uid "$TARGET")" == "$(id -u)" ]] || die "Refusing foreign command symlink: $TARGET"
    destination="$(readlink "$TARGET")"
    # The retired snapshot deploy: recognized as managed only so installing
    # replaces the link and uninstalling removes it; deletion safety for the
    # snapshot directory itself rests on its provenance file.
    if [[ "$destination" == "$SNAP_SOURCE" ]]; then
      MANAGED_KIND="snapshot"
      MANAGED_ROOT="$SNAP_DIR"
      return 0
    fi
    [[ "$destination" == /*/src/main.ts ]] || die "Refusing foreign command symlink: $TARGET"
    root="${destination%/src/main.ts}"
    [[ "$destination" == "$root/src/main.ts" ]] || die "Refusing foreign command symlink: $TARGET"
    validate_managed_checkout "$root"
    MANAGED_KIND="source-link"
    return 0
  fi

  die "Refusing foreign command path: $TARGET"
}

LEGACY_REMOVED=0

remove_legacy_snapshot() {
  # Only a directory this installer provably wrote — the provenance file is
  # the marker — is ever deleted; anything else at the path is left alone.
  if [[ -f "$SNAP_DIR/.deployed-sha" && ! -L "$SNAP_DIR/.deployed-sha" ]]; then
    validate_path "$SNAP_DIR" "snapshot"
    [[ "$(owner_uid "$SNAP_DIR")" == "$(id -u)" ]] || die "Refusing foreign snapshot directory: $SNAP_DIR"
    rm -rf -- "$SNAP_DIR"
    rmdir "$(dirname "$SNAP_DIR")" 2>/dev/null || true
    LEGACY_REMOVED=1
  fi
}

remove_legacy_receipt() {
  # deployed-sha recorded which commit the snapshot ran; an editable link
  # has no deploy to record, so the receipt retires with the snapshot.
  if [[ -e "$RECEIPT" || -L "$RECEIPT" ]]; then
    [[ ! -L "$RECEIPT" && -f "$RECEIPT" ]] || die "Refusing unsafe deployed receipt: $RECEIPT"
    [[ "$(owner_uid "$RECEIPT")" == "$(id -u)" ]] || die "Refusing foreign deployed receipt: $RECEIPT"
    rm -f -- "$RECEIPT"
    LEGACY_REMOVED=1
  fi
}

install_agentsurface() {
  command -v bun >/dev/null 2>&1 || die "Bun is required but was not found in PATH"
  validate_path "$SOURCE" "source command"
  validate_safe_file "$SOURCE" "source command"
  [[ -x "$SOURCE" ]] || die "Source command is not executable: $SOURCE"
  validate_managed_checkout "$ROOT"

  ensure_directory "$BIN_DIR" "bin" 755
  classify_command

  (cd "$ROOT" && bun install --frozen-lockfile)

  TMP_PATH="$BIN_DIR/.agentsurface-link.$$.$RANDOM"
  [[ ! -e "$TMP_PATH" && ! -L "$TMP_PATH" ]] || die "Refusing unsafe temporary command path: $TMP_PATH"
  ln -s -- "$SOURCE" "$TMP_PATH"
  mv -f -- "$TMP_PATH" "$TARGET"
  TMP_PATH=""

  [[ -L "$TARGET" ]] || die "Installed command is not a symlink: $TARGET"
  [[ "$(readlink "$TARGET")" == "$SOURCE" ]] || die "Installed command points to the wrong source: $TARGET"
  classify_command
  [[ "$MANAGED_KIND" == "source-link" && "$MANAGED_ROOT" == "$ROOT" ]] || \
    die "Installed command failed verification: $TARGET"

  # Legacy cleanup runs after the swap, so an interruption here still
  # leaves a working editable install rather than a dangling link.
  remove_legacy_snapshot
  remove_legacy_receipt

  echo "Installed $TARGET -> $SOURCE"
}

uninstall_agentsurface() {
  local have_state=0 removed=0

  validate_path "$BIN_DIR" "bin"
  validate_path "$STATE_DIR" "state"
  if [[ -e "$BIN_DIR" ]]; then
    validate_directory "$BIN_DIR" "bin"
  fi
  if [[ -e "$STATE_DIR" ]]; then
    validate_directory "$STATE_DIR" "state"
    have_state=1
  fi

  classify_command
  if [[ "$MANAGED_KIND" != "absent" ]]; then
    rm -f -- "$TARGET"
    removed=1
  fi
  remove_legacy_snapshot
  remove_legacy_receipt
  if (( have_state )); then
    rmdir "$STATE_DIR" 2>/dev/null || true
  fi

  if (( removed || LEGACY_REMOVED )); then
    echo "Removed agentsurface installation"
  else
    echo "AgentSurface is not installed"
  fi
}

if (( $# > 1 )); then
  die "Expected at most one installer option" 2
fi

case "${1:---install}" in
  --install)
    install_agentsurface
    ;;
  --uninstall)
    uninstall_agentsurface
    ;;
  --help|-h)
    usage
    ;;
  *)
    echo "Unknown installer option: $1" >&2
    usage >&2
    exit 2
    ;;
esac
