import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Environ } from "./paths.ts";
import { stateDirectory } from "./paths.ts";

/**
 * The launch log: one JSON line per realized directive. Bookkeeping, never
 * authority — a missing or partly garbled file loses nothing but history.
 */

export interface LaunchRecord {
  at: string;
  project: string;
  harness: string;
  worktree: boolean;
  branch: string | null;
  workspace: string;
  agent: string;
  /** Whether herdr kept the launch alias as a live target. A started harness
   * whose name herdr released during startup is a recorded launch all the
   * same — the record is bookkeeping, and the agent is running. */
  named: boolean;
  /** A directive's record extras ride along beside the host's own fields. */
  [extra: string]: unknown;
}

export function launchLogPath(env: Environ, home: string): string {
  return join(stateDirectory(env, home, "agentsurface"), "launches.jsonl");
}

export function appendLaunch(path: string, record: LaunchRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}
