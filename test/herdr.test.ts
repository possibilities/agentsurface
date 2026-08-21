import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHerdrCall,
  createTab,
  createWorkspace,
  createWorktree,
  type HerdrCall,
  HerdrError,
  type HerdrResponse,
  invoke,
  listPanes,
  listWorkspaces,
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

describe("createWorkspace / createWorktree / createTab", () => {
  test("phrases the requests, carrying the focus decision", async () => {
    const { call, calls } = fake([CREATED]);
    const surface = await createWorkspace(call, {
      cwd: "/code/alpha",
      label: "alpha",
      focus: true,
    });
    expect(surface).toEqual({ workspaceId: "w9", paneId: "w9:p1", branch: null });
    expect(calls[0]).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/code/alpha",
      "--label",
      "alpha",
      "--focus",
    ]);

    // No --branch: herdr names the worktree itself and reports its choice.
    const worktree = fake([
      {
        result: {
          ...(CREATED.result as object),
          worktree: { branch: "worktree/calm-cloud-0009" },
        },
      },
    ]);
    const worktreeSurface = await createWorktree(worktree.call, {
      cwd: "/code/alpha",
      focus: false,
    });
    expect(worktreeSurface.branch).toBe("worktree/calm-cloud-0009");
    expect(worktree.calls[0]).toEqual(["worktree", "create", "--cwd", "/code/alpha", "--no-focus"]);

    const tab = fake([{ result: { tab: { tab_id: "w9:t2" }, root_pane: { pane_id: "w9:p7" } } }]);
    const tabSurface = await createTab(tab.call, {
      workspaceId: "w9",
      cwd: "/code/alpha",
      focus: false,
    });
    expect(tabSurface).toEqual({ workspaceId: "w9", paneId: "w9:p7", branch: null });
    expect(tab.calls[0]).toEqual([
      "tab",
      "create",
      "--workspace",
      "w9",
      "--cwd",
      "/code/alpha",
      "--no-focus",
    ]);
  });

  test("a response without the surface is an explicit failure", async () => {
    const { call } = fake([{ result: { workspace: { workspace_id: "w9" } } }]);
    let caught: unknown;
    try {
      await createWorkspace(call, { cwd: "/code/alpha", label: "alpha", focus: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HerdrError);
  });
});

describe("surface listings", () => {
  test("read workspaces and panes, tolerating partial rows", async () => {
    const workspaces = fake([
      { result: { workspaces: [{ workspace_id: "w1", label: "alpha" }, { label: "orphan" }] } },
    ]);
    expect(await listWorkspaces(workspaces.call)).toEqual([{ workspaceId: "w1", label: "alpha" }]);

    const panes = fake([
      {
        result: {
          panes: [
            { workspace_id: "w1", cwd: "/code/alpha", foreground_cwd: "/code/alpha/sub" },
            { workspace_id: "w2" },
          ],
        },
      },
    ]);
    expect(await listPanes(panes.call)).toEqual([
      { workspaceId: "w1", cwd: "/code/alpha", foregroundCwd: "/code/alpha/sub" },
      { workspaceId: "w2", cwd: null, foregroundCwd: null },
    ]);
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
  test("uses an opaque Herdr-safe alias and skips live collisions", () => {
    const uuids = ["11111111-1111-4111-8111-111111111111", "abcdef12-3456-4789-8abc-def123456789"];
    expect(nextAgentName(new Set(["a-1111111111"]), () => uuids.shift()!)).toBe("a-abcdef1234");
  });

  test("reads live names, tolerating unnamed agents", async () => {
    const placed = (pane: string, name?: string) => ({
      name,
      workspace_id: "w1",
      tab_id: "t1",
      pane_id: pane,
    });
    const { call } = fake([
      {
        result: {
          agents: [placed("w1:p1", "claude-1"), placed("w1:p2"), placed("w1:p3", "codex-1")],
        },
      },
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
    expect(outcome).toEqual({ started: true, named: true, unconfirmed: null });
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([
      "agent",
      "start",
      "claude-1",
      "--kind",
      "claude",
      "--pane",
      "w9:p1",
      "--timeout",
      "120000",
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
    expect(outcome).toEqual({ started: true, named: true, unconfirmed: "agent_not_ready" });
  });

  test("an unconfirmed name is a started launch: the intent rides the argv", async () => {
    // Both codes come from herdr's post-spawn confirmation wait, so the
    // harness is running with the prompt whichever one comes back. Treating
    // them as failures reported one for every claude launch.
    for (const code of ["timeout", "agent_name_not_found"]) {
      const { call } = fake([{ error: { code, message: "not confirmed" } }]);
      const outcome = await startAgentWhenReady(call, {
        name: "a-0123456789",
        kind: "claude",
        paneId: "w9:p1",
        agentArgs: [],
        pollMs: 1,
      });
      expect(outcome).toEqual({ started: true, named: false, unconfirmed: code });
    }
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

describe("createHerdrCall", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  /** A stand-in herdr that prints what the test asks for and exits with the
   * given code — enough to exercise how a response is read. */
  function stubBinary(stdout: string, stderr: string, exitCode: number): string {
    const root = mkdtempSync(join(tmpdir(), "agentsurface-herdr-call-"));
    roots.push(root);
    const path = join(root, "herdr");
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s' ${JSON.stringify(stdout)}\nprintf '%s' ${JSON.stringify(stderr)} >&2\nexit ${exitCode}\n`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  test("a silent success is a success, not a missing response", async () => {
    // `pane report-metadata` and its siblings apply the change and answer
    // nothing at all; treating that silence as a failure once made every
    // sidebar token publish report an error for a write that had landed.
    const call = createHerdrCall({ HERDR_BIN_PATH: stubBinary("", "", 0) });
    expect(await call(["pane", "report-metadata", "w1:p1", "--token", "project=x"])).toEqual({});
  });

  test("silence with a nonzero exit still fails", async () => {
    const call = createHerdrCall({ HERDR_BIN_PATH: stubBinary("", "", 1) });
    let caught: unknown;
    try {
      await call(["pane", "get", "w1:p1"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HerdrError);
    expect((caught as HerdrError).message).toContain("no response");
  });

  test("a JSON body still wins over the exit code", async () => {
    const call = createHerdrCall({
      HERDR_BIN_PATH: stubBinary("", JSON.stringify({ error: { code: "no_such_pane" } }), 1),
    });
    expect(await call(["pane", "get", "gone"])).toEqual({ error: { code: "no_such_pane" } });
  });
});
