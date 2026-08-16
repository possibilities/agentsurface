import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Environ } from "./paths.ts";
import { stateDirectory } from "./paths.ts";

/**
 * The launch log: one JSON line per launch, the source of the project
 * list's frequency ordering. Bookkeeping, never authority — a missing or
 * partly garbled file only flattens the ordering.
 */

export interface LaunchRecord {
  at: string;
  project: string;
  harness: string;
  model: string;
  effort: string;
  worktree: boolean;
  branch: string | null;
  workspace: string;
  agent: string;
}

export function launchLogPath(env: Environ, home: string): string {
  return join(stateDirectory(env, home, "agentsurface"), "launches.jsonl");
}

export function readLaunchCounts(path: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!existsSync(path)) return counts;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return counts;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line) as { project?: unknown };
      if (typeof record.project === "string") {
        counts.set(record.project, (counts.get(record.project) ?? 0) + 1);
      }
    } catch {
      // A garbled line loses one count, nothing more.
    }
  }
  return counts;
}

export function appendLaunch(path: string, record: LaunchRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** The last launch's cascade choices, for the next form's defaults. */
export interface LastLevel {
  harness: string;
  model: string;
  effort: string;
}

export function readLastLaunch(path: string): LastLevel | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let last: LastLevel | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line) as {
        harness?: unknown;
        model?: unknown;
        effort?: unknown;
      };
      if (
        typeof record.harness === "string" &&
        typeof record.model === "string" &&
        typeof record.effort === "string"
      ) {
        last = { harness: record.harness, model: record.model, effort: record.effort };
      }
    } catch {
      // A garbled line names no choices.
    }
  }
  return last;
}
