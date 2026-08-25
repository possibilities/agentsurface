import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrCall } from "../src/herdr.ts";
import {
  parsePaneEvent,
  reportConversationToken,
  reportSidebarProjectToken,
  runTabNamer,
  type SlugOutcome,
} from "../src/tab-namer.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "agentsurface-tab-namer-"));
  roots.push(root);
  return root;
}

const EVENT = JSON.stringify({
  event: "pane.agent_detected",
  data: { type: "pane_agent_detected", pane_id: "pane_1", workspace_id: "ws_1", agent: "claude" },
});

const STATUS_EVENT = JSON.stringify({
  event: "pane.agent_status_changed",
  data: {
    type: "pane_agent_status_changed",
    pane_id: "pane_1",
    workspace_id: "ws_1",
    agent: "claude",
    agent_status: "working",
  },
});

interface FakeSurface {
  call: HerdrCall;
  renames: string[][];
  reports: string[][];
  paneReads: number;
}

/** `session` is the pane's agent_session, or a function of the 1-based
 * read count when the occupant changes across reads. */
function surface(
  session: unknown,
  options: {
    sessionAfterReads?: number;
    tabForRead?: (read: number) => string;
    errorAfterReads?: number;
    tabLabel?: string;
    reportError?: boolean;
  } = {},
): FakeSurface {
  const fake: FakeSurface = { renames: [], reports: [], paneReads: 0, call: undefined as never };
  fake.call = async (args) => {
    if (args[0] === "pane" && args[1] === "report-metadata") {
      if (options.reportError === true) {
        return { error: { code: "pane_not_found", message: "no such pane" } };
      }
      fake.reports.push(args.slice(2));
      return { result: {} };
    }
    if (args[0] === "tab" && args[1] === "get") {
      return { result: { tab: { label: options.tabLabel ?? "1" } } };
    }
    if (args[0] === "pane" && args[1] === "get") {
      fake.paneReads += 1;
      if (options.errorAfterReads !== undefined && fake.paneReads > options.errorAfterReads) {
        return { error: { code: "pane_not_found", message: "no such pane" } };
      }
      const ready = fake.paneReads > (options.sessionAfterReads ?? 0);
      const value =
        typeof session === "function"
          ? (session as (read: number) => unknown)(fake.paneReads)
          : session;
      return {
        result: {
          pane: {
            tab_id: options.tabForRead?.(fake.paneReads) ?? "tab_1",
            agent_session: ready ? value : null,
          },
        },
      };
    }
    if (args[0] === "tab" && args[1] === "rename") {
      fake.renames.push(args.slice(2));
      return { result: {} };
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
  return fake;
}

const CLAUDE_SESSION = { source: "herdr:claude", agent: "claude", kind: "id", value: "abc-123" };

function namer(
  fake: FakeSurface,
  dir: string,
  slug: (harness: string, ref: string) => Promise<SlugOutcome>,
  overrides: Partial<Parameters<typeof runTabNamer>[0]> = {},
) {
  return runTabNamer({
    call: fake.call,
    stateDir: dir,
    eventJson: EVENT,
    slug: slug as never,
    sleep: async () => {},
    sessionPollMs: 0,
    promptPollMs: 0,
    ...overrides,
  });
}

describe("parsePaneEvent", () => {
  test("reads the envelope's kind, pane id, and released flag", () => {
    expect(parsePaneEvent(EVENT)).toEqual({
      kind: "agent_detected",
      paneId: "pane_1",
      released: false,
    });
    expect(parsePaneEvent(STATUS_EVENT)).toEqual({
      kind: "status_changed",
      paneId: "pane_1",
      released: false,
    });
    expect(parsePaneEvent("not json")).toBeNull();
    expect(parsePaneEvent(JSON.stringify({ data: {} }))).toBeNull();
    expect(
      parsePaneEvent(JSON.stringify({ data: { type: "pane_focused", pane_id: "pane_1" } })),
    ).toBeNull();
  });
});

describe("reportSidebarProjectToken", () => {
  test("marks a linked worktree with its root repository name", async () => {
    const calls: string[][] = [];
    const call: HerdrCall = async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return { result: { pane: { workspace_id: "ws_1" } } };
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return {
          result: {
            workspace: {
              label: "worktree-clear-valley-003a",
              worktree: {
                checkout_path: "/worktrees/clear-valley",
                is_linked_worktree: true,
                repo_name: "agentvoice",
                repo_root: "/code/agentvoice",
              },
            },
          },
        };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          result: {
            worktrees: [
              { branch: "main", path: "/code/agentvoice" },
              { branch: "worktree/clear-valley-003a", path: "/worktrees/clear-valley" },
            ],
          },
        };
      }
      if (args[0] === "pane" && args[1] === "report-metadata") return { result: {} };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    };

    await reportSidebarProjectToken(call, "pane_1");

    expect(calls[3]).toEqual([
      "pane",
      "report-metadata",
      "pane_1",
      "--source",
      "agentsurface:sidebar",
      "--token",
      "project=agentvoice  clear-valley-003a",
    ]);
  });

  test("names the branch of a repository's own checkout too", async () => {
    const calls: string[][] = [];
    const call: HerdrCall = async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return { result: { pane: { workspace_id: "ws_1" } } };
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return {
          result: {
            workspace: {
              label: "hand-renamed",
              worktree: {
                checkout_path: "/code/funk",
                is_linked_worktree: false,
                repo_name: "funk",
                repo_root: "/code/funk",
              },
            },
          },
        };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { result: { worktrees: [{ branch: "main", path: "/code/funk" }] } };
      }
      if (args[0] === "pane" && args[1] === "report-metadata") return { result: {} };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    };

    await reportSidebarProjectToken(call, "pane_1");

    expect(calls[3]).toEqual([
      "pane",
      "report-metadata",
      "pane_1",
      "--source",
      "agentsurface:sidebar",
      "--token",
      "project=funk  main",
    ]);
  });

  test("keeps the workspace label when no repository backs it", async () => {
    const calls: string[][] = [];
    const call: HerdrCall = async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return { result: { pane: { workspace_id: "ws_1" } } };
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return { result: { workspace: { label: "code" } } };
      }
      if (args[0] === "pane" && args[1] === "report-metadata") return { result: {} };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    };

    await reportSidebarProjectToken(call, "pane_1");

    expect(calls[2]).toEqual([
      "pane",
      "report-metadata",
      "pane_1",
      "--source",
      "agentsurface:sidebar",
      "--token",
      "project=code",
    ]);
  });
});

describe("reportConversationToken", () => {
  test("an unclaimed tab gets the untitled placeholder", async () => {
    const fake = surface(null);
    await reportConversationToken(fake.call, "pane_1", stateDir());
    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=untitled agent"],
    ]);
  });

  test("a pending claim still reads as untitled", async () => {
    const fake = surface(null);
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs"), { recursive: true });
    writeFileSync(join(dir, "named-tabs", "tab_1"), "pending 99999\n");
    await reportConversationToken(fake.call, "pane_1", dir);
    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=untitled agent"],
    ]);
  });

  test("a named claim republishes the tab's current label", async () => {
    // Pane metadata does not survive a herdr restart; the re-detection that
    // follows a restore is what puts a named tab's token back.
    const fake = surface(null, { tabLabel: "fix-the-tests" });
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs"), { recursive: true });
    writeFileSync(join(dir, "named-tabs", "tab_1"), "named\n");
    await reportConversationToken(fake.call, "pane_1", dir);
    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=fix-the-tests"],
    ]);
  });

  test("a pane response without a tab is an error", async () => {
    const fake = surface(null, { tabForRead: () => "" });
    let thrown: Error | null = null;
    try {
      await reportConversationToken(fake.call, "pane_1", stateDir());
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("named no tab");
    expect(fake.reports).toHaveLength(0);
  });
});

describe("runTabNamer", () => {
  test("names the tab from the session's slug and keeps the claim", async () => {
    const fake = surface(CLAUDE_SESSION, { sessionAfterReads: 2 });
    const dir = stateDir();
    const asked: string[][] = [];
    const code = await namer(fake, dir, async (harness, ref) => {
      asked.push([harness, ref]);
      return { kind: "slug", value: "fix-the-tests" };
    });
    expect(code).toBe(0);
    expect(fake.paneReads).toBe(3);
    expect(asked).toEqual([["claude", "abc-123"]]);
    expect(fake.renames).toEqual([["tab_1", "fix-the-tests"]]);
    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=fix-the-tests"],
    ]);
    expect(readFileSync(join(dir, "named-tabs", "tab_1"), "utf8")).toBe("named\n");
  });

  test("a failed slug report leaves the name and the claim standing", async () => {
    const fake = surface(CLAUDE_SESSION, { reportError: true });
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "slug", value: "kept" }));
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "kept"]]);
    expect(readFileSync(join(dir, "named-tabs", "tab_1"), "utf8")).toBe("named\n");
  });

  test("a status transition re-arms a naming attempt", async () => {
    // The detection-time attempt expired while a trust dialog held the
    // harness; the status change its acceptance fires names the tab.
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "slug", value: "after-the-dialog" }), {
      eventJson: STATUS_EVENT,
    });
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "after-the-dialog"]]);
    expect(readFileSync(join(dir, "named-tabs", "tab_1"), "utf8")).toBe("named\n");
  });

  test("an already-claimed tab no-ops before inference", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    let asked = 0;
    const slug = async (): Promise<SlugOutcome> => {
      asked += 1;
      return { kind: "slug", value: "again" };
    };
    expect(await namer(fake, dir, slug)).toBe(0);
    expect(await namer(fake, dir, slug)).toBe(0);
    expect(asked).toBe(1);
    expect(fake.renames).toHaveLength(1);
  });

  test("waits out a pending transcript, then names", async () => {
    const fake = surface(CLAUDE_SESSION);
    let attempts = 0;
    const code = await namer(fake, stateDir(), async () => {
      attempts += 1;
      return attempts < 3 ? { kind: "pending" } : { kind: "slug", value: "late-prompt" };
    });
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "late-prompt"]]);
  });

  test("a failed inference releases the claim and reports", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "failed", message: "boom" }));
    expect(code).toBe(1);
    expect(existsSync(join(dir, "named-tabs", "tab_1"))).toBe(false);
    expect(fake.renames).toHaveLength(0);
  });

  test("a prompt that never arrives gives up quietly and releases", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "pending" }), {
      promptTimeoutMs: 0,
    });
    expect(code).toBe(0);
    expect(existsSync(join(dir, "named-tabs", "tab_1"))).toBe(false);
  });

  test("an unsupported agent and a released detection both no-op", async () => {
    const fake = surface({ source: "x", agent: "copilot", kind: "id", value: "z" });
    const never = async (): Promise<SlugOutcome> => {
      throw new Error("should not infer");
    };
    expect(await namer(fake, stateDir(), never)).toBe(0);

    const released = JSON.stringify({
      event: "pane.agent_detected",
      data: { type: "pane_agent_detected", pane_id: "pane_1", released: true },
    });
    expect(await namer(fake, stateDir(), never, { eventJson: released })).toBe(0);
  });

  test("a session herdr never learns times out quietly", async () => {
    const fake = surface(null);
    const code = await namer(fake, stateDir(), async () => ({ kind: "slug", value: "x" }), {
      sessionTimeoutMs: 0,
    });
    expect(code).toBe(0);
    expect(fake.renames).toHaveLength(0);
  });

  test("pi sessions travel as paths", async () => {
    const fake = surface({
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: "/home/u/.pi/agent/sessions/x/y.jsonl",
    });
    const asked: string[][] = [];
    await namer(fake, stateDir(), async (harness, ref) => {
      asked.push([harness, ref]);
      return { kind: "slug", value: "pi-work" };
    });
    expect(asked).toEqual([["pi", "/home/u/.pi/agent/sessions/x/y.jsonl"]]);
  });

  const CRASHED_SESSION = {
    source: "herdr:claude",
    agent: "claude",
    kind: "id",
    value: "dead-999",
  };

  test("a replaced agent mid-poll becomes the name source", async () => {
    const fake = surface((read: number) => (read === 1 ? CRASHED_SESSION : CLAUDE_SESSION));
    const dir = stateDir();
    const asked: string[][] = [];
    const code = await namer(fake, dir, async (harness, ref) => {
      asked.push([harness, ref]);
      return ref === "dead-999" ? { kind: "pending" } : { kind: "slug", value: "debug-escaping" };
    });
    expect(code).toBe(0);
    expect(asked).toEqual([
      ["claude", "dead-999"],
      ["claude", "abc-123"],
    ]);
    expect(fake.renames).toEqual([["tab_1", "debug-escaping"]]);
    expect(readFileSync(join(dir, "named-tabs", "tab_1"), "utf8")).toBe("named\n");
  });

  test("an adopted conversation gets a fresh prompt window", async () => {
    let clock = 0;
    const fake = surface((read: number) => (read <= 2 ? CRASHED_SESSION : CLAUDE_SESSION));
    let liveAsks = 0;
    const code = await namer(
      fake,
      stateDir(),
      async (_harness, ref) => {
        if (ref === "dead-999") return { kind: "pending" };
        liveAsks += 1;
        return liveAsks < 2 ? { kind: "pending" } : { kind: "slug", value: "late-adoption" };
      },
      {
        now: () => clock,
        promptTimeoutMs: 100,
        sleep: async () => {
          clock += 60;
        },
      },
    );
    // The dead ref burned the first window (clock 120 > 100); only the
    // reset taken on adoption lets the live ref's second ask happen.
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "late-adoption"]]);
  });

  test("an orphaned pending claim is taken over", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs"), { recursive: true });
    writeFileSync(join(dir, "named-tabs", "tab_1"), "pending 999999\n");
    const code = await namer(fake, dir, async () => ({ kind: "slug", value: "rescued" }), {
      pidAlive: () => false,
    });
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "rescued"]]);
    expect(readFileSync(join(dir, "named-tabs", "tab_1"), "utf8")).toBe("named\n");
  });

  test("live pending, named, and legacy claims all no-op", async () => {
    const never = async (): Promise<SlugOutcome> => {
      throw new Error("should not infer");
    };
    for (const content of ["pending 4242\n", "named\n", "2026-08-17T03:34:41.794Z\n"]) {
      const fake = surface(CLAUDE_SESSION);
      const dir = stateDir();
      mkdirSync(join(dir, "named-tabs"), { recursive: true });
      writeFileSync(join(dir, "named-tabs", "tab_1"), content);
      expect(await namer(fake, dir, never, { pidAlive: () => true })).toBe(0);
      expect(readFileSync(join(dir, "named-tabs", "tab_1"), "utf8")).toBe(content);
      expect(fake.renames).toHaveLength(0);
    }
  });

  test("a superseded namer's failure leaves its successor's claim", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    const claim = join(dir, "named-tabs", "tab_1");
    const code = await namer(fake, dir, async () => {
      // Another namer took the claim over while this one was polling.
      writeFileSync(claim, "pending 777\n");
      return { kind: "failed", message: "boom" };
    });
    expect(code).toBe(1);
    expect(readFileSync(claim, "utf8")).toBe("pending 777\n");
  });

  test("an unsupported occupant mid-poll releases the claim", async () => {
    const fake = surface((read: number) =>
      read === 1 ? CLAUDE_SESSION : { source: "x", agent: "copilot", kind: "id", value: "z" },
    );
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "pending" }));
    expect(code).toBe(0);
    expect(existsSync(join(dir, "named-tabs", "tab_1"))).toBe(false);
    expect(fake.renames).toHaveLength(0);
  });

  test("a pane that left the claimed tab releases the claim", async () => {
    const fake = surface(CLAUDE_SESSION, {
      tabForRead: (read) => (read === 1 ? "tab_1" : "tab_2"),
    });
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "pending" }));
    expect(code).toBe(0);
    expect(existsSync(join(dir, "named-tabs", "tab_1"))).toBe(false);
    expect(fake.renames).toHaveLength(0);
  });

  test("a vanished pane mid-poll releases the claim", async () => {
    const fake = surface(CLAUDE_SESSION, { errorAfterReads: 1 });
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "pending" }));
    expect(code).toBe(0);
    expect(existsSync(join(dir, "named-tabs", "tab_1"))).toBe(false);
  });
});
