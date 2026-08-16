import { describe, expect, test } from "bun:test";
import {
  createWorkspace,
  createWorktree,
  type HerdrCall,
  HerdrError,
  type HerdrResponse,
  invoke,
  liveAgentNames,
  nextAgentName,
  startAgentWhenReady,
} from "../src/herdr.ts";

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

const CREATED: HerdrResponse = {
  result: {
    workspace: { workspace_id: "w9", label: "alpha" },
    tab: { tab_id: "w9:t1" },
    root_pane: { pane_id: "w9:p1" },
  },
};

describe("createWorkspace / createWorktree", () => {
  test("phrases the request and reads the created surface", async () => {
    const { call, calls } = fake([CREATED]);
    const surface = await createWorkspace(call, { cwd: "/code/alpha", label: "alpha" });
    expect(surface).toEqual({ workspaceId: "w9", paneId: "w9:p1" });
    expect(calls[0]).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/code/alpha",
      "--label",
      "alpha",
      "--focus",
    ]);

    const worktree = fake([CREATED]);
    await createWorktree(worktree.call, { cwd: "/code/alpha", branch: "fix-it" });
    expect(worktree.calls[0]).toEqual([
      "worktree",
      "create",
      "--cwd",
      "/code/alpha",
      "--branch",
      "fix-it",
      "--focus",
    ]);
  });

  test("a response without the surface is an explicit failure", async () => {
    const { call } = fake([{ result: { workspace: { workspace_id: "w9" } } }]);
    let caught: unknown;
    try {
      await createWorkspace(call, { cwd: "/code/alpha", label: "alpha" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HerdrError);
  });
});

describe("invoke", () => {
  test("an error response throws with its code", async () => {
    const { call } = fake([{ error: { code: "workspace_not_found", message: "no such" } }]);
    let caught: unknown;
    try {
      await invoke(call, ["workspace", "get", "w404"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HerdrError);
    expect((caught as HerdrError).code).toBe("workspace_not_found");
  });
});

describe("agent naming", () => {
  test("numbers per kind and takes the first free slot", () => {
    expect(nextAgentName("claude", new Set())).toBe("claude-1");
    expect(nextAgentName("claude", new Set(["claude-1", "claude-2", "codex-1"]))).toBe("claude-3");
    expect(nextAgentName("claude", new Set(["claude-2"]))).toBe("claude-1");
  });

  test("reads live names, tolerating unnamed agents", async () => {
    const { call } = fake([
      { result: { agents: [{ name: "claude-1" }, { pane_id: "w1:p1" }, { name: "codex-1" }] } },
    ]);
    expect(await liveAgentNames(call)).toEqual(new Set(["claude-1", "codex-1"]));
  });
});

describe("startAgentWhenReady", () => {
  test("retries a busy pane until the shell is ready", async () => {
    const { call, calls } = fake([
      { error: { code: "agent_pane_busy", message: "busy" } },
      { error: { code: "agent_pane_busy", message: "busy" } },
      { result: {} },
    ]);
    const outcome = await startAgentWhenReady(call, {
      name: "claude-1",
      kind: "claude",
      paneId: "w9:p1",
      agentArgs: ["--x-level", "fable:max", "fix the bug"],
      pollMs: 1,
    });
    expect(outcome).toEqual({ ready: true });
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([
      "agent",
      "start",
      "claude-1",
      "--kind",
      "claude",
      "--pane",
      "w9:p1",
      "--",
      "--x-level",
      "fable:max",
      "fix the bug",
    ]);
  });

  test("an agent blocked on a startup dialog is a soft outcome, not a failure", async () => {
    const { call } = fake([
      { error: { code: "agent_not_ready", message: "blocked during startup" } },
    ]);
    const outcome = await startAgentWhenReady(call, {
      name: "claude-1",
      kind: "claude",
      paneId: "w9:p1",
      agentArgs: [],
      pollMs: 1,
    });
    expect(outcome).toEqual({ ready: false });
  });

  test("any other error is immediate; endless busy times out", async () => {
    const denied = fake([{ error: { code: "agent_pane_missing", message: "gone" } }]);
    let caught: unknown;
    try {
      await startAgentWhenReady(denied.call, {
        name: "claude-1",
        kind: "claude",
        paneId: "w9:p1",
        agentArgs: [],
        pollMs: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as HerdrError).code).toBe("agent_pane_missing");
    expect(denied.calls.length).toBe(1);

    const busy = fake([{ error: { code: "agent_pane_busy", message: "busy" } }]);
    caught = undefined;
    try {
      await startAgentWhenReady(busy.call, {
        name: "claude-1",
        kind: "claude",
        paneId: "w9:p1",
        agentArgs: [],
        timeoutMs: 30,
        pollMs: 5,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as HerdrError).code).toBe("agent_pane_busy");
  });
});
