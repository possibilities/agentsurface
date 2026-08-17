import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "../src/errors.ts";
import type { HerdrCall, HerdrResponse } from "../src/herdr.ts";
import {
  type DetachedLaunch,
  executeLaunch,
  findProjectWorkspace,
  parseDetachedLaunch,
  primedPrompt,
  writeIntentFile,
} from "../src/launch/executor.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function logPath(): string {
  const temp = mkdtempSync(join(tmpdir(), "agentsurface-executor-"));
  temps.push(temp);
  return join(temp, "launches.jsonl");
}

/** A canned herdr: records every argv and answers from a queue. */
function fake(responses: HerdrResponse[]): { call: HerdrCall; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...responses];
  const call: HerdrCall = (args) => {
    calls.push(args);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return Promise.resolve(next);
  };
  return { call, calls };
}

const PLAN: DetachedLaunch = {
  project: { path: "/code/alpha", display: "~/code/alpha", count: 0 },
  worktree: false,
  priming: null,
  harness: "claude",
  model: "fable",
  effort: "max",
  level: "fable:max",
  prompt: "fix it",
  focus: false,
};

const CREATED: HerdrResponse = {
  result: {
    workspace: { workspace_id: "w9", label: "alpha" },
    tab: { tab_id: "w9:t1" },
    root_pane: { pane_id: "w9:p1" },
  },
};

describe("parseDetachedLaunch", () => {
  test("round-trips a plan and refuses anything else", () => {
    expect(parseDetachedLaunch(JSON.stringify(PLAN))).toEqual(PLAN);
    for (const bad of ["", "not json", JSON.stringify({ project: {} })]) {
      let caught: unknown;
      try {
        parseDetachedLaunch(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UsageError);
    }
  });
});

describe("findProjectWorkspace", () => {
  test("a pane working inside the project wins; a label match backs it up", () => {
    const byCwd = fake([
      {
        result: {
          panes: [{ workspace_id: "w7", cwd: "/elsewhere", foreground_cwd: "/code/alpha/sub" }],
        },
      },
    ]);
    expect(findProjectWorkspace(byCwd.call, "/code/alpha")).resolves.toBe("w7");

    const byLabel = fake([
      { result: { panes: [{ workspace_id: "w7", cwd: "/elsewhere", foreground_cwd: null }] } },
      { result: { workspaces: [{ workspace_id: "w3", label: "alpha" }] } },
    ]);
    expect(findProjectWorkspace(byLabel.call, "/code/alpha")).resolves.toBe("w3");

    const absent = fake([
      { result: { panes: [] } },
      { result: { workspaces: [{ workspace_id: "w3", label: "other" }] } },
    ]);
    expect(findProjectWorkspace(absent.call, "/code/alpha")).resolves.toBeNull();
  });
});

describe("primedPrompt", () => {
  test("each harness spells its own skill prefix; empty intents prime alone", () => {
    expect(primedPrompt({ harness: "claude", prompt: "fix it", priming: "collab" })).toBe(
      "/collab fix it",
    );
    expect(primedPrompt({ harness: "pi", prompt: "fix it", priming: "build" })).toBe(
      "/build fix it",
    );
    expect(primedPrompt({ harness: "codex", prompt: "fix it", priming: "collab" })).toBe(
      "$collab fix it",
    );
    expect(primedPrompt({ harness: "codex", prompt: "", priming: "orchestrate" })).toBe(
      "$orchestrate",
    );
    expect(primedPrompt({ harness: "claude", prompt: "fix it", priming: null })).toBe("fix it");
  });
});

describe("writeIntentFile", () => {
  test("stale spool entries are pruned by age; fresh ones survive", () => {
    const state = dirname(logPath());
    const spool = join(state, "intents");
    mkdirSync(spool, { recursive: true });
    const now = Date.now();
    const stale = join(spool, "stale.txt");
    const fresh = join(spool, "fresh.txt");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    const old = (now - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);

    const written = writeIntentFile(state, "the intent", now);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(readFileSync(written, "utf8")).toBe("the intent");
  });
});

describe("executeLaunch", () => {
  test("creates an unfocused workspace when the project is absent, retrying a taken name", async () => {
    const { call, calls } = fake([
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [{ name: "claude-1" }] } },
      { error: { code: "agent_name_taken", message: "taken" } },
      { result: { agents: [{ name: "claude-1" }] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeLaunch(call, path, PLAN);

    expect(calls[2]).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/code/alpha",
      "--label",
      "alpha",
      "--no-focus",
    ]);
    const starts = calls.filter((args) => args[0] === "agent" && args[1] === "start");
    expect(starts).toHaveLength(2);
    expect(starts[0]?.[2]).toMatch(/^a-[0-9a-f]{10}$/);
    expect(starts[1]?.[2]).toMatch(/^a-[0-9a-f]{10}$/);
    expect(starts[1]?.[2]).not.toBe(starts[0]?.[2]);
    expect(starts[1]?.slice(3, 9)).toEqual([
      "--kind",
      "claude",
      "--pane",
      "w9:p1",
      "--",
      "--x-level",
    ]);
    expect(starts[1]?.[9]).toBe("fable:max");
    expect(starts[1]?.[10]).toBe("--x-prompt-file");
    const intentPath = starts[1]?.[11] ?? "";
    expect(intentPath.startsWith(join(dirname(path), "intents"))).toBe(true);
    expect(readFileSync(intentPath, "utf8")).toBe("fix it");
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.agent).toBe(starts[1]?.[2]);
    expect(record.workspace).toBe("w9");
  });

  test("adds a tab to the hosting workspace and focuses it when asked", async () => {
    const { call, calls } = fake([
      {
        result: {
          panes: [{ workspace_id: "w7", cwd: "/code/alpha", foreground_cwd: "/code/alpha" }],
        },
      },
      { result: { tab: { tab_id: "w7:t4" }, root_pane: { pane_id: "w7:p9" } } },
      { result: {} },
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeLaunch(call, path, { ...PLAN, focus: true });

    expect(calls[1]).toEqual([
      "tab",
      "create",
      "--workspace",
      "w7",
      "--cwd",
      "/code/alpha",
      "--focus",
    ]);
    expect(calls[2]).toEqual(["workspace", "focus", "w7"]);
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.workspace).toBe("w7");
    expect(record.agent).toMatch(/^a-[0-9a-f]{10}$/);
  });

  test("a wild intent travels whole as a spool file; the argv stays control-char free", async () => {
    const { call, calls } = fake([
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    const prompt = "Survey the fleet.\n\nThen 'quotes', a\ttab, and $dollars.";
    await executeLaunch(call, path, { ...PLAN, prompt, priming: "collab" });

    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    for (const arg of start ?? []) {
      expect([...arg].some((ch) => ch < " ")).toBe(false);
    }
    const intentPath = start?.[start.indexOf("--x-prompt-file") + 1] ?? "";
    expect(readFileSync(intentPath, "utf8")).toBe(`/collab ${prompt}`);
  });

  test("an empty primed intent writes no spool file", async () => {
    const { call, calls } = fake([
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeLaunch(call, path, { ...PLAN, prompt: "" });

    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    expect(start).not.toContain("--x-prompt-file");
    expect(existsSync(join(dirname(path), "intents"))).toBe(false);
  });

  test("a worktree launch is branchless; herdr's chosen name lands in the record", async () => {
    const { call, calls } = fake([
      {
        result: {
          ...(CREATED.result as object),
          worktree: { branch: "worktree/calm-cloud-0009" },
        },
      },
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeLaunch(call, path, { ...PLAN, worktree: true });

    expect(calls[0]).toEqual(["worktree", "create", "--cwd", "/code/alpha", "--no-focus"]);
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.branch).toBe("worktree/calm-cloud-0009");
  });
});
