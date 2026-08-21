import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The hook's own record of what it did. Herdr keeps a plugin command log,
 * but it is a 50-entry in-memory ring shared by every hook run on the
 * surface, and status transitions fire often enough to evict a detection's
 * entry within hours — the one run worth reading afterwards is the one
 * already gone. This log is per-plugin, on disk, and only detections and
 * failures reach it, so a blank sidebar row hours later still has a witness.
 *
 * It lives in the plugin's state directory beside the tab claims, so it
 * survives a herdr restart the way the claims do.
 */

const HOOK_LOG_NAME = "hook-log.jsonl";
/** Long enough that a detection survives the status transitions around it,
 * short enough that the file stays readable by hand. */
const HOOK_LOG_MAX_RECORDS = 500;

export interface HookRecord {
  /** ISO timestamp; the surface's own clock, not herdr's. */
  at: string;
  /** The run's pid, so its two records pair up and either can be lined up
   * against herdr's own plugin log entry for the same run. */
  pid: number;
  /** `start` is written before any work: its absence means the hook never
   * ran at all, which is a different bug from a publish that failed. */
  phase: "start" | "tokens";
  event: string;
  paneId: string | null;
  /** The event as herdr sent it, kept on the start record: `released` and
   * the agent it names are not recoverable afterwards. */
  eventJson?: string;
  /** One entry per side effect the run attempted: "ok" or the error text. */
  outcomes?: Record<string, string>;
  /** What herdr reports holding once the publishes settle — the difference
   * between a write we believe landed and one herdr confirmed. */
  held?: Record<string, string> | string | null;
}

export function hookLogPath(stateDir: string): string {
  return join(stateDir, HOOK_LOG_NAME);
}

/** Append one record, trimming the file to its last records when it grows
 * past the cap. Never throws: a hook that cannot write its evidence still
 * has work to finish, and losing the log is not worth losing the run. */
export function appendHookRecord(stateDir: string, record: HookRecord): void {
  const path = hookLogPath(stateDir);
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    trimHookLog(path);
  } catch {
    // No evidence home; the run itself still matters more than its record.
  }
}

function trimHookLog(path: string): void {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    return;
  }
  if (lines.length <= HOOK_LOG_MAX_RECORDS) return;
  const kept = lines.slice(lines.length - HOOK_LOG_MAX_RECORDS);
  writeFileSync(path, `${kept.join("\n")}\n`);
}
