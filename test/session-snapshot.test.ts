import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrCall, HerdrResponse } from "../src/herdr.ts";
import {
  captureCallWithProtocolFallback,
  captureSessionSnapshot,
  dumpSessionSnapshots,
  parseRawBackupSocketResponse,
  parseSessionSnapshot,
  resolveSessionBackupPath,
  restoreSessionSnapshot,
  type SessionSnapshot,
  type SnapshotServices,
  sessionBackupDirectory,
} from "../src/session-snapshot.ts";

function snapshot(
  git: SessionSnapshot["session"]["workspaces"][number]["git"] = null,
): SessionSnapshot {
  return {
    schema_version: 1,
    captured_at: "2026-08-26T12:00:00.000Z",
    session: {
      name: "archive",
      workspaces: [
        {
          label: "fix-the-thing",
          cwd: git?.checkout_path ?? "/code/project",
          git,
          tabs: [
            {
              label: "fix-the-thing",
              panes: [
                {
                  cwd: git?.checkout_path ?? "/code/project",
                  label: null,
                  agent: {
                    name: "saved-agent",
                    harness: "codex",
                    session: {
                      source: "herdr:codex",
                      agent: "codex",
                      kind: "id",
                      value: "session-123",
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function fakeServices(
  options: {
    sessions?: { name: string; running: boolean }[];
    call?: (session: string, args: string[]) => Promise<HerdrResponse>;
  } = {},
): SnapshotServices & { starts: string[]; calls: { session: string; args: string[] }[] } {
  const sessions = [...(options.sessions ?? [])];
  const starts: string[] = [];
  const calls: { session: string; args: string[] }[] = [];
  return {
    starts,
    calls,
    listSessions: () => Promise.resolve(sessions.map((session) => ({ ...session }))),
    call:
      (session): HerdrCall =>
      async (args) => {
        calls.push({ session, args });
        return options.call?.(session, args) ?? { result: {} };
      },
    git: () => Promise.resolve(null),
    startServer: (name) => {
      starts.push(name);
      const existing = sessions.find((session) => session.name === name);
      if (existing === undefined) sessions.push({ name, running: true });
      else existing.running = true;
    },
    sleep: () => Promise.resolve(),
    now: () => new Date("2026-08-26T12:00:00.000Z"),
  };
}

function existingTopologyCall(agents: unknown[] = []): (args: string[]) => Promise<HerdrResponse> {
  return async (args) => {
    switch (args.slice(0, 2).join(" ")) {
      case "agent list":
        return { result: { agents } };
      case "workspace list":
        return {
          result: {
            workspaces: [{ workspace_id: "w1", label: "fix-the-thing", worktree: null }],
          },
        };
      case "tab list":
        return {
          result: {
            tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "fix-the-thing" }],
          },
        };
      case "pane list":
        return {
          result: {
            panes: [
              {
                pane_id: "w1:p1",
                workspace_id: "w1",
                tab_id: "w1:t1",
                cwd: "/code/project",
              },
            ],
          },
        };
      default:
        return { result: {} };
    }
  };
}

describe("session snapshot capture", () => {
  test("uses raw capture only when the installed client is newer than the server", async () => {
    const socketCalls: string[][] = [];
    const socketCall: HerdrCall = async (args) => {
      socketCalls.push(args);
      return { result: { type: "workspace_list", workspaces: [] } };
    };
    const fallback = captureCallWithProtocolFallback(
      () =>
        Promise.resolve({
          error: {
            code: "protocol_mismatch",
            message: "client protocol 21 is newer than server protocol 20; restart it",
          },
        }),
      socketCall,
    );
    expect(await fallback(["workspace", "list"])).toEqual({
      result: { type: "workspace_list", workspaces: [] },
    });
    expect(socketCalls).toEqual([["workspace", "list"]]);

    const oldClient = captureCallWithProtocolFallback(
      () =>
        Promise.resolve({
          error: {
            code: "protocol_mismatch",
            message: "client protocol 20 is older than server protocol 21",
          },
        }),
      socketCall,
    );
    expect(await oldClient(["workspace", "list"])).toMatchObject({
      error: { code: "protocol_mismatch" },
    });
    expect(socketCalls).toHaveLength(1);
  });

  test("strictly validates raw socket fallback responses before using them", () => {
    expect(
      parseRawBackupSocketResponse(
        "workspace.list",
        "request-1",
        JSON.stringify({
          id: "request-1",
          result: {
            type: "workspace_list",
            workspaces: [
              {
                workspace_id: "w1",
                label: "project",
                focused: true,
                worktree: null,
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ result: { workspaces: [{ workspace_id: "w1", label: "project" }] } });

    expect(() =>
      parseRawBackupSocketResponse(
        "workspace.list",
        "request-1",
        JSON.stringify({
          id: "request-1",
          result: {
            type: "workspace_list",
            workspaces: [{ workspace_id: "w1" }],
          },
        }),
      ),
    ).toThrow("incompatible format");
    expect(() =>
      parseRawBackupSocketResponse(
        "workspace.list",
        "request-1",
        JSON.stringify({
          id: "request-1",
          result: { type: "workspace_list", workspaces: [], renamed_field: [] },
        }),
      ),
    ).toThrow("incompatible format");
  });

  test("uses the app state directory for bare dumps and named restores", () => {
    expect(sessionBackupDirectory({}, "/home/person")).toBe(
      "/home/person/.local/state/agentsurface/session-backups",
    );
    expect(sessionBackupDirectory({ XDG_STATE_HOME: "/state" }, "/home/person")).toBe(
      "/state/agentsurface/session-backups",
    );
    expect(resolveSessionBackupPath("default", {}, "/home/person")).toBe(
      "/home/person/.local/state/agentsurface/session-backups/default.json",
    );
    expect(resolveSessionBackupPath("jobs", { XDG_STATE_HOME: "/state" }, "/home/person")).toBe(
      "/state/agentsurface/session-backups/jobs.json",
    );
    expect(resolveSessionBackupPath("~/backups/jobs.json", {}, "/home/person")).toBe(
      "/home/person/backups/jobs.json",
    );
    expect(resolveSessionBackupPath("./jobs.json", {}, "/home/person")).toBe("./jobs.json");
  });

  test("captures one named running server with topology, worktree git state, and native sessions", async () => {
    const service = fakeServices({
      sessions: [
        { name: "default", running: true },
        { name: "jobs", running: true },
        { name: "old", running: false },
      ],
      call: async (session, args) => {
        const command = args.slice(0, 2).join(" ");
        if (command === "workspace list") {
          return {
            result: {
              workspaces:
                session === "default"
                  ? [
                      {
                        workspace_id: "w1",
                        label: "project-worktree",
                        worktree: {
                          repo_root: "/code/project",
                          checkout_path: "/worktrees/project-one",
                          is_linked_worktree: true,
                        },
                      },
                    ]
                  : [],
            },
          };
        }
        if (command === "tab list") {
          return {
            result: {
              tabs:
                session === "default"
                  ? [{ tab_id: "w1:t1", workspace_id: "w1", label: "review-code" }]
                  : [],
            },
          };
        }
        if (command === "pane list") {
          return {
            result: {
              panes:
                session === "default"
                  ? [
                      {
                        pane_id: "w1:p1",
                        workspace_id: "w1",
                        tab_id: "w1:t1",
                        cwd: "/worktrees/project-one",
                      },
                    ]
                  : [],
            },
          };
        }
        return {
          result: {
            agents:
              session === "default"
                ? [
                    {
                      name: "reviewer",
                      agent: "claude",
                      pane_id: "w1:p1",
                      agent_session: {
                        source: "herdr:claude",
                        agent: "claude",
                        kind: "id",
                        value: "session-abc",
                      },
                    },
                  ]
                : [],
          },
        };
      },
    });
    service.git = async (_cwd, args) => {
      const command = args.join(" ");
      if (command === "rev-parse --abbrev-ref HEAD") return "worktree/one";
      if (command === "rev-parse HEAD") return "abc123";
      if (command === "status --porcelain") return " M file.ts";
      return null;
    };

    const result = await captureSessionSnapshot(service);

    expect(result.session.name).toBe("default");
    expect(result.session.workspaces[0]?.git).toEqual({
      repo_root: "/code/project",
      checkout_path: "/worktrees/project-one",
      linked_worktree: true,
      branch: "worktree/one",
      head: "abc123",
      dirty: true,
    });
    expect(result.session.workspaces[0]?.tabs[0]?.panes[0]?.agent?.session?.value).toBe(
      "session-abc",
    );
    expect(service.calls.some((call) => call.session === "jobs")).toBeFalse();
    expect(service.calls.some((call) => call.session === "old")).toBeFalse();
  });

  test("writes one backup file for each requested session", async () => {
    const service = fakeServices({
      sessions: [
        { name: "default", running: true },
        { name: "jobs", running: true },
      ],
    });
    const directory = mkdtempSync(join(tmpdir(), "agentsurface-session-dump-"));
    try {
      const result = await dumpSessionSnapshots(directory, ["default", "jobs"], service);

      expect(result.map((item) => item.name)).toEqual(["default", "jobs"]);
      expect(
        parseSessionSnapshot(readFileSync(join(directory, "default.json"), "utf8")).session.name,
      ).toBe("default");
      expect(
        parseSessionSnapshot(readFileSync(join(directory, "jobs.json"), "utf8")).session.name,
      ).toBe("jobs");
      expect(await dumpSessionSnapshots(join(directory, "implicit"), [], service)).toMatchObject([
        { name: "default" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("session snapshot resume", () => {
  test("an occupied running session is left untouched", async () => {
    const saved = snapshot();
    saved.session.name = "default";
    const service = fakeServices({
      sessions: [{ name: "default", running: true }],
      call: (_session, args) => existingTopologyCall([{ name: "live-agent" }])(args),
    });

    expect(await restoreSessionSnapshot(saved, service)).toEqual({
      name: "default",
      action: "skipped_running",
      agents_started: 0,
      agents_skipped: 0,
    });
    expect(service.starts).toEqual([]);
    expect(service.calls.map((call) => call.args)).toEqual([["agent", "list"]]);
  });

  test("an agent-free running default session resumes into its existing topology", async () => {
    const saved = snapshot();
    saved.session.name = "default";
    saved.session.workspaces.unshift({
      label: "closed-shell-workspace",
      cwd: "/code/closed",
      git: null,
      tabs: [
        {
          label: "1",
          panes: [{ cwd: "/code/closed", label: null, agent: null }],
        },
      ],
    });
    const service = fakeServices({
      sessions: [{ name: "default", running: true }],
      call: (_session, args) => existingTopologyCall()(args),
    });

    expect(await restoreSessionSnapshot(saved, service)).toEqual({
      name: "default",
      action: "resumed_existing",
      agents_started: 1,
      agents_skipped: 0,
    });
    expect(service.starts).toEqual([]);
    expect(service.calls.map((call) => call.args)).toContainEqual([
      "agent",
      "start",
      "saved-agent",
      "--kind",
      "codex",
      "--pane",
      "w1:p1",
      "--timeout",
      "120000",
      "--",
      "--x-resume",
      "session-123",
    ]);
    expect(service.calls.map((call) => call.args)).toContainEqual([
      "pane",
      "report-metadata",
      "w1:p1",
      "--source",
      "agentsurface:sidebar",
      "--token",
      "conversation=fix-the-thing",
    ]);
  });

  test("a stopped existing session starts and then resumes its saved agents", async () => {
    const stopped = snapshot();
    stopped.session.name = "jobs";
    const stoppedService = fakeServices({
      sessions: [{ name: "jobs", running: false }],
      call: (_session, args) => existingTopologyCall()(args),
    });
    expect(await restoreSessionSnapshot(stopped, stoppedService)).toEqual({
      name: "jobs",
      action: "resumed_existing",
      agents_started: 1,
      agents_skipped: 0,
    });
    expect(stoppedService.starts).toEqual(["jobs"]);
  });

  test("a restarted default session recreates a missing saved agent workspace", async () => {
    const saved = snapshot();
    saved.session.name = "default";
    const service = fakeServices({
      sessions: [{ name: "default", running: true }],
      call: async (_session, args) => {
        switch (args.slice(0, 2).join(" ")) {
          case "agent list":
            return { result: { agents: [] } };
          case "workspace list":
            return {
              result: { workspaces: [{ workspace_id: "home", label: "~", worktree: null }] },
            };
          case "tab list":
            return {
              result: { tabs: [{ tab_id: "home:t1", workspace_id: "home", label: "1" }] },
            };
          case "pane list":
            return {
              result: {
                panes: [
                  {
                    pane_id: "home:p1",
                    workspace_id: "home",
                    tab_id: "home:t1",
                    cwd: "/home/person",
                  },
                ],
              },
            };
          case "workspace create":
            return {
              result: {
                workspace: { workspace_id: "w9" },
                tab: { tab_id: "w9:t1" },
                root_pane: { pane_id: "w9:p1" },
              },
            };
          default:
            return { result: {} };
        }
      },
    });

    expect(await restoreSessionSnapshot(saved, service)).toMatchObject({
      name: "default",
      action: "resumed_existing",
      agents_started: 1,
    });
    expect(service.calls.map((call) => call.args)).toContainEqual([
      "workspace",
      "create",
      "--cwd",
      "/code/project",
      "--label",
      "fix-the-thing",
      "--no-focus",
    ]);
    expect(service.calls.map((call) => call.args)).toContainEqual([
      "agent",
      "start",
      "saved-agent",
      "--kind",
      "codex",
      "--pane",
      "w9:p1",
      "--timeout",
      "120000",
      "--",
      "--x-resume",
      "session-123",
    ]);
  });

  test("topology drift is refused before any saved agent starts", async () => {
    const saved = snapshot();
    saved.session.name = "default";
    const service = fakeServices({
      sessions: [{ name: "default", running: true }],
      call: async (_session, args) => {
        if (args[0] === "agent" && args[1] === "list") return { result: { agents: [] } };
        if (args[0] === "workspace" && args[1] === "list")
          return {
            result: {
              workspaces: [{ workspace_id: "w1", label: "fix-the-thing", worktree: null }],
            },
          };
        if (args[0] === "tab" && args[1] === "list") return { result: { tabs: [] } };
        if (args[0] === "pane" && args[1] === "list") return { result: { panes: [] } };
        return { result: {} };
      },
    });

    await expect(restoreSessionSnapshot(saved, service)).rejects.toThrow(
      "live topology does not match the snapshot",
    );
    expect(
      service.calls.some((call) => call.args[0] === "agent" && call.args[1] === "start"),
    ).toBeFalse();
  });

  test("a wholly missing session is reconstructed and its native conversation resumed", async () => {
    const service = fakeServices({
      call: async (_session, args) => {
        const command = args.slice(0, 2).join(" ");
        if (command === "workspace create") {
          return {
            result: {
              workspace: { workspace_id: "w9" },
              tab: { tab_id: "w9:t1" },
              root_pane: { pane_id: "w9:p1" },
            },
          };
        }
        if (command === "agent start") return { result: {} };
        return { result: {} };
      },
    });

    expect(await restoreSessionSnapshot(snapshot(), service)).toEqual({
      name: "archive",
      action: "restored_missing",
      agents_started: 1,
      agents_skipped: 0,
    });
    expect(service.starts).toEqual(["archive"]);
    expect(service.calls.map((call) => call.args)).toContainEqual([
      "workspace",
      "create",
      "--cwd",
      "/code/project",
      "--label",
      "fix-the-thing",
      "--no-focus",
    ]);
    expect(service.calls.map((call) => call.args)).toContainEqual([
      "agent",
      "start",
      "saved-agent",
      "--kind",
      "codex",
      "--pane",
      "w9:p1",
      "--timeout",
      "120000",
      "--",
      "--x-resume",
      "session-123",
    ]);
  });

  test("fleet harnesses resume through AgentLaunch rather than native open argv", async () => {
    for (const harness of ["claude", "codex"] as const) {
      const saved = snapshot();
      const agent = saved.session.workspaces[0]?.tabs[0]?.panes[0]?.agent;
      if (agent === null || agent === undefined || agent.session === null)
        throw new Error("fixture");
      agent.harness = harness;
      agent.session.source = `herdr:${harness}`;
      agent.session.agent = harness;
      const service = fakeServices({
        call: async (_session, args) => {
          if (args[0] === "workspace" && args[1] === "create") {
            return {
              result: {
                workspace: { workspace_id: "w9" },
                tab: { tab_id: "w9:t1" },
                root_pane: { pane_id: "w9:p1" },
              },
            };
          }
          return { result: {} };
        },
      });

      await restoreSessionSnapshot(saved, service);

      expect(service.calls.map((call) => call.args)).toContainEqual([
        "agent",
        "start",
        "saved-agent",
        "--kind",
        harness,
        "--pane",
        "w9:p1",
        "--timeout",
        "120000",
        "--",
        "--x-resume",
        "session-123",
      ]);
    }
  });

  test("starts independent conversation resumes concurrently", async () => {
    const saved = snapshot();
    const panes = saved.session.workspaces[0]?.tabs[0]?.panes;
    if (panes === undefined) throw new Error("fixture");
    panes.push({
      cwd: "/code/project",
      label: null,
      agent: {
        name: "second-agent",
        harness: "codex",
        session: {
          source: "herdr:codex",
          agent: "codex",
          kind: "id",
          value: "session-456",
        },
      },
    });

    const startedPanes: string[] = [];
    let releaseStarts: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseStarts = resolve;
    });
    const service = fakeServices({
      call: async (_session, args) => {
        const command = args.slice(0, 2).join(" ");
        if (command === "workspace create") {
          return {
            result: {
              workspace: { workspace_id: "w9" },
              tab: { tab_id: "w9:t1" },
              root_pane: { pane_id: "w9:p1" },
            },
          };
        }
        if (command === "pane split") return { result: { pane: { pane_id: "w9:p2" } } };
        if (command === "agent start") {
          startedPanes.push(args[args.indexOf("--pane") + 1] ?? "missing");
          if (startedPanes.length === 2) releaseStarts();
          await bothStarted;
        }
        return { result: {} };
      },
    });

    expect(await restoreSessionSnapshot(saved, service)).toMatchObject({ agents_started: 2 });
    expect(startedPanes).toEqual(["w9:p1", "w9:p2"]);
  });

  test("can restore into an explicitly overridden session name", async () => {
    const service = fakeServices({
      call: async (_session, args) => {
        if (args[0] === "workspace" && args[1] === "create") {
          return {
            result: {
              workspace: { workspace_id: "w9" },
              tab: { tab_id: "w9:t1" },
              root_pane: { pane_id: "w9:p1" },
            },
          };
        }
        return { result: {} };
      },
    });

    expect(await restoreSessionSnapshot(snapshot(), service, "recovered")).toMatchObject({
      name: "recovered",
      action: "restored_missing",
    });
    expect(service.starts).toEqual(["recovered"]);
    expect(service.calls.every((call) => call.session === "recovered")).toBeTrue();
  });

  test("never recreates a missing dirty worktree", async () => {
    const service = fakeServices({
      call: async (_session, args) => {
        if (args[0] === "worktree" && args[1] === "open") {
          return { error: { code: "worktree_not_found", message: "gone" } };
        }
        return { result: {} };
      },
    });
    const dirty = snapshot({
      repo_root: "/code/project",
      checkout_path: "/worktrees/missing",
      linked_worktree: true,
      branch: "worktree/missing",
      head: "abc123",
      dirty: true,
    });

    await expect(restoreSessionSnapshot(dirty, service)).rejects.toThrow(
      "refusing to recreate missing dirty worktree",
    );
    expect(service.calls.some((call) => call.args[1] === "create")).toBeFalse();
  });
});

describe("session snapshot validation", () => {
  test("accepts exactly one session and rejects unknown keys", () => {
    expect(parseSessionSnapshot(JSON.stringify(snapshot())).session.name).toBe("archive");

    const aggregate = { ...snapshot(), sessions: [snapshot().session] };
    expect(() => parseSessionSnapshot(JSON.stringify(aggregate))).toThrow("Unrecognized key");

    const extra = { ...snapshot(), surprise: true };
    expect(() => parseSessionSnapshot(JSON.stringify(extra))).toThrow("Unrecognized key");
  });
});
