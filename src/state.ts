import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  priming: string | null;
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

/** The interrupted form, shadowed on every repaint and cleared only on
 * submit: an escape, a crash, or a closed popup loses nothing, and the next
 * launcher opens exactly where this one stopped. A submitted launch starts
 * fresh through the normal default resolution instead. */
export interface FormDraft {
  prompt: string;
  project: string;
  worktree: boolean;
  harness: string;
  model: string;
  effort: string;
  priming: string;
}

export function formDraftPath(env: Environ, home: string): string {
  return join(stateDirectory(env, home, "agentsurface"), "form-draft.json");
}

export function readFormDraft(path: string): FormDraft | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FormDraft>;
    if (
      typeof parsed.prompt !== "string" ||
      typeof parsed.project !== "string" ||
      typeof parsed.worktree !== "boolean" ||
      typeof parsed.harness !== "string" ||
      typeof parsed.model !== "string" ||
      typeof parsed.effort !== "string" ||
      typeof parsed.priming !== "string"
    ) {
      return null;
    }
    return {
      prompt: parsed.prompt,
      project: parsed.project,
      worktree: parsed.worktree,
      harness: parsed.harness,
      model: parsed.model,
      effort: parsed.effort,
      priming: parsed.priming,
    };
  } catch {
    return null;
  }
}

export function writeFormDraft(path: string, draft: FormDraft | null): void {
  try {
    if (draft === null) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(draft)}\n`);
  } catch {
    // Draft persistence is insurance, never a reason to block editing.
  }
}

/** Every submitted plan, appended before the executor spawns: even a child
 * that dies before its own logging leaves the full intent recoverable. */
export function submittedLogPath(env: Environ, home: string): string {
  return join(stateDirectory(env, home, "agentsurface"), "submitted.jsonl");
}

export function appendSubmitted(path: string, plan: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), plan })}\n`);
  } catch {
    // Bookkeeping, never a launch blocker.
  }
}

/** The last launch's cascade and priming choices, for the next form's
 * defaults; priming is null where an older record never wrote one. */
export interface LastLevel {
  harness: string;
  model: string;
  effort: string;
  priming: string | null;
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
        priming?: unknown;
      };
      if (
        typeof record.harness === "string" &&
        typeof record.model === "string" &&
        typeof record.effort === "string"
      ) {
        last = {
          harness: record.harness,
          model: record.model,
          effort: record.effort,
          priming: typeof record.priming === "string" ? record.priming : null,
        };
      }
    } catch {
      // A garbled line names no choices.
    }
  }
  return last;
}
