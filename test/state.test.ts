import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLaunch, readLastLaunch, readLaunchCounts } from "../src/state.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function logPath(): string {
  const temp = mkdtempSync(join(tmpdir(), "agentsurface-state-"));
  temps.push(temp);
  return join(temp, "state", "launches.jsonl");
}

const RECORD = {
  at: "2026-08-16T00:00:00.000Z",
  project: "/code/alpha",
  harness: "claude",
  model: "fable",
  effort: "xhigh",
  worktree: false,
  branch: null,
  workspace: "w9",
  agent: "claude-1",
};

describe("the launch log", () => {
  test("appends records and counts launches per project", () => {
    const path = logPath();
    expect(readLaunchCounts(path).size).toBe(0);
    appendLaunch(path, RECORD);
    appendLaunch(path, RECORD);
    appendLaunch(path, { ...RECORD, project: "/code/beta" });
    const counts = readLaunchCounts(path);
    expect(counts.get("/code/alpha")).toBe(2);
    expect(counts.get("/code/beta")).toBe(1);
  });

  test("a garbled line loses one count, nothing more", () => {
    const path = logPath();
    appendLaunch(path, RECORD);
    appendFileSync(path, "{not json\n");
    appendLaunch(path, RECORD);
    expect(readLaunchCounts(path).get("/code/alpha")).toBe(2);
  });

  test("remembers the last launch's cascade, skipping garbage tails", () => {
    const path = logPath();
    expect(readLastLaunch(path)).toBeNull();
    appendLaunch(path, RECORD);
    appendLaunch(path, { ...RECORD, harness: "codex", model: "sol", effort: "ultra" });
    appendFileSync(path, "{garbage\n");
    expect(readLastLaunch(path)).toEqual({ harness: "codex", model: "sol", effort: "ultra" });
  });
});
