import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CliError, UsageError } from "../errors.ts";
import type { Environ } from "../paths.ts";

/**
 * Locate a conversation's transcript in its harness's native session store.
 * Every store keys the file by the session id in its filename, so an id
 * resolves by glob — no index in between, so there is nothing to be stale.
 * Herdr reports an agent session as an id or as a path; both are accepted.
 */

export const HARNESS_NAMES = ["claude", "codex"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export function parseHarnessName(value: string): HarnessName {
  if ((HARNESS_NAMES as readonly string[]).includes(value)) return value as HarnessName;
  throw new UsageError(`"${value}" is not a harness (expected claude or codex)`);
}

/** Store roots follow each harness's own environment contract. */
function storeRoot(harness: HarnessName, env: Environ, home: string): string {
  if (harness === "claude")
    return join(env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude"), "projects");
  return join(env["CODEX_HOME"] ?? join(home, ".codex"), "sessions");
}

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function transcriptNotFound(harness: HarnessName, ref: string): CliError {
  return new CliError(
    "transcript_not_found",
    `no ${harness} transcript matches "${ref}"`,
    "pass a session id from the harness's own store, or a transcript path",
  );
}

export function resolveTranscript(
  harness: HarnessName,
  ref: string,
  env: Environ,
  home: string,
): string {
  if (ref.includes("/")) {
    if (existsSync(ref) && statSync(ref).isFile()) return ref;
    throw transcriptNotFound(harness, ref);
  }
  if (!ID_PATTERN.test(ref)) throw new UsageError(`"${ref}" is not a session id or path`);
  const root = storeRoot(harness, env, home);
  if (!existsSync(root)) throw transcriptNotFound(harness, ref);
  const pattern = harness === "claude" ? `*/${ref}.jsonl` : `**/rollout-*-${ref}.jsonl`;
  let latest: { path: string; mtime: number } | null = null;
  for (const match of new Bun.Glob(pattern).scanSync({ cwd: root, absolute: true })) {
    const mtime = statSync(match).mtimeMs;
    if (latest === null || mtime > latest.mtime) latest = { path: match, mtime };
  }
  if (latest === null) throw transcriptNotFound(harness, ref);
  return latest.path;
}
