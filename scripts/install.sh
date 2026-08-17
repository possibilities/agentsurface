#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE="$ROOT/src/main.ts"
BIN_DIR="${AGENTSURFACE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${AGENTSURFACE_INSTALL_STATE_DIR:-$HOME/.local/state/agentsurface}"
# The deployed app is a SNAPSHOT of the checkout's src, not a link into the
# live working tree: this launcher is co-developed by concurrent agent
# sessions while being the operator's daily driver, and a mid-edit tree
# must never be what a popup keybinding runs. Installing is deploying.
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
dependency install, snapshots the checkout's committed src into
~/.local/share/agentsurface/app (node_modules linked to the checkout),
links ~/.local/bin/agentsurface to the snapshot, and writes the deployed
Git SHA to ~/.local/state/agentsurface/deployed-sha. The launcher keeps
running the snapshot while the working tree is edited; rerun this script
to deploy a new state. A dirty src refuses to deploy unless
AGENTSURFACE_INSTALL_ALLOW_DIRTY=1.

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

file_nlink() {
  stat -c %h "$1" 2>/dev/null || stat -f %l "$1"
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

validate_managed_snapshot() {
  local sha_file="$SNAP_DIR/.deployed-sha"
  local sha

  validate_path "$SNAP_DIR" "snapshot"
  validate_directory "$SNAP_DIR" "snapshot"
  validate_safe_file "$SNAP_SOURCE" "agentsurface snapshot command"
  [[ ! -L "$sha_file" && -f "$sha_file" ]] || die "Refusing snapshot without provenance: $SNAP_DIR"
  IFS= read -r sha <"$sha_file" || die "Refusing malformed snapshot provenance: $sha_file"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "Refusing malformed snapshot provenance: $sha_file"
  MANAGED_ROOT="$SNAP_DIR"
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
    if [[ "$destination" == "$SNAP_SOURCE" ]]; then
      validate_managed_snapshot
      MANAGED_KIND="snapshot"
      return 0
    fi
    # The earlier install shape linked straight into a checkout's live src;
    # still recognized as managed so an upgrade replaces it cleanly.
    [[ "$destination" == /*/src/main.ts ]] || die "Refusing foreign command symlink: $TARGET"
    root="${destination%/src/main.ts}"
    [[ "$destination" == "$root/src/main.ts" ]] || die "Refusing foreign command symlink: $TARGET"
    validate_managed_checkout "$root"
    MANAGED_KIND="source-link"
    return 0
  fi

  die "Refusing foreign command path: $TARGET"
}

validate_receipt() {
  local expected_sha="${1:-}"
  local sha

  [[ ! -L "$RECEIPT" && -f "$RECEIPT" ]] || die "Refusing unsafe deployed receipt: $RECEIPT"
  [[ "$(owner_uid "$RECEIPT")" == "$(id -u)" ]] || die "Refusing foreign deployed receipt: $RECEIPT"
  [[ "$(file_nlink "$RECEIPT")" == "1" ]] || die "Refusing hardlinked deployed receipt: $RECEIPT"
  [[ "$(file_mode "$RECEIPT")" == "600" ]] || die "Refusing deployed receipt with unsafe permissions: $RECEIPT"
  IFS= read -r sha <"$RECEIPT" || die "Refusing malformed deployed receipt: $RECEIPT"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "Refusing malformed deployed receipt: $RECEIPT"
  printf '%s\n' "$sha" | cmp -s - "$RECEIPT" || die "Refusing malformed deployed receipt: $RECEIPT"
  if [[ -n "$expected_sha" && "$sha" != "$expected_sha" ]]; then
    die "Refusing deployed receipt that does not match the managed command: $RECEIPT"
  fi
}

receipt_exists() {
  [[ -e "$RECEIPT" || -L "$RECEIPT" ]]
}

build_snapshot() {
  local sha="$1"
  local parent staging

  parent="$(dirname "$SNAP_DIR")"
  validate_path "$SNAP_DIR" "snapshot"
  ensure_directory "$parent" "snapshot parent" 755

  staging="$parent/.app-staging.$$"
  rm -rf -- "$staging"
  mkdir -p -- "$staging"
  cp -R "$ROOT/src" "$staging/src"
  cp "$ROOT/package.json" "$staging/package.json"
  # Dependencies stay the checkout's: bun install rewrites them atomically
  # enough, and duplicating the native OpenTUI build per deploy buys nothing.
  ln -s -- "$ROOT/node_modules" "$staging/node_modules"
  printf '%s\n' "$sha" >"$staging/.deployed-sha"

  rm -rf -- "$SNAP_DIR"
  mv -- "$staging" "$SNAP_DIR"
}

install_agentsurface() {
  local sha

  command -v bun >/dev/null 2>&1 || die "Bun is required but was not found in PATH"
  validate_path "$SOURCE" "source command"
  validate_safe_file "$SOURCE" "source command"
  [[ -x "$SOURCE" ]] || die "Source command is not executable: $SOURCE"
  sha="$(checkout_head "$ROOT")" || die "Could not derive a lowercase 40-hex Git HEAD from $ROOT"
  validate_managed_checkout "$ROOT"

  # The snapshot must equal the receipt's commit: a mid-edit working tree
  # is exactly what deploying exists to keep out of the popup.
  if [[ "${AGENTSURFACE_INSTALL_ALLOW_DIRTY:-}" != "1" ]] && \
      [[ -n "$(git -C "$ROOT" status --porcelain -- src package.json bun.lock 2>/dev/null)" ]]; then
    die "Refusing to deploy a dirty src (commit first, or AGENTSURFACE_INSTALL_ALLOW_DIRTY=1)"
  fi

  ensure_directory "$BIN_DIR" "bin" 755
  ensure_directory "$STATE_DIR" "state" 700
  classify_command
  if receipt_exists; then
    [[ "$MANAGED_KIND" != "absent" ]] || die "Refusing an uncorroborated deployed receipt: $RECEIPT"
    if [[ "$MANAGED_KIND" == "snapshot" && "$MANAGED_SHA" == "$sha" ]]; then
      # Recover if an earlier install replaced the snapshot but was
      # interrupted before atomically replacing its old valid receipt.
      validate_receipt
    else
      validate_receipt "$MANAGED_SHA"
    fi
  fi

  (cd "$ROOT" && bun install --frozen-lockfile)
  build_snapshot "$sha"

  TMP_PATH="$BIN_DIR/.agentsurface-link.$$.$RANDOM"
  [[ ! -e "$TMP_PATH" && ! -L "$TMP_PATH" ]] || die "Refusing unsafe temporary command path: $TMP_PATH"
  ln -s -- "$SNAP_SOURCE" "$TMP_PATH"
  mv -f -- "$TMP_PATH" "$TARGET"
  TMP_PATH=""

  [[ -L "$TARGET" ]] || die "Installed command is not a symlink: $TARGET"
  [[ "$(readlink "$TARGET")" == "$SNAP_SOURCE" ]] || die "Installed command points to the wrong source: $TARGET"
  classify_command
  [[ "$MANAGED_KIND" == "snapshot" && "$MANAGED_SHA" == "$sha" ]] || \
    die "Installed command failed verification: $TARGET"

  TMP_PATH="$(mktemp "$STATE_DIR/.deployed-sha.XXXXXX")"
  chmod 0600 "$TMP_PATH"
  printf '%s\n' "$sha" >"$TMP_PATH"
  [[ ! -L "$TMP_PATH" && -f "$TMP_PATH" && "$(owner_uid "$TMP_PATH")" == "$(id -u)" && "$(file_nlink "$TMP_PATH")" == "1" && "$(file_mode "$TMP_PATH")" == "600" ]] || \
    die "Temporary deployed receipt failed verification"
  printf '%s\n' "$sha" | cmp -s - "$TMP_PATH" || die "Temporary deployed receipt failed content verification"
  mv -f -- "$TMP_PATH" "$RECEIPT"
  TMP_PATH=""
  validate_receipt "$sha"

  echo "Installed $TARGET at $sha"
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
  if receipt_exists; then
    [[ "$MANAGED_KIND" != "absent" ]] || die "Refusing an uncorroborated deployed receipt: $RECEIPT"
    validate_receipt "$MANAGED_SHA"
  fi

  if [[ "$MANAGED_KIND" != "absent" ]]; then
    rm -f -- "$TARGET"
    removed=1
  fi
  if [[ "$MANAGED_KIND" == "snapshot" || -f "$SNAP_DIR/.deployed-sha" ]]; then
    validate_path "$SNAP_DIR" "snapshot"
    rm -rf -- "$SNAP_DIR"
    removed=1
  fi
  if receipt_exists; then
    rm -f -- "$RECEIPT"
    removed=1
  fi
  if (( have_state )); then
    rmdir "$STATE_DIR" 2>/dev/null || true
  fi

  if (( removed )); then
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
