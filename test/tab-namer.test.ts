import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrCall } from "../src/herdr.ts";
import { parseAgentDetected, runTabNamer, type SlugOutcome } from "../src/tab-namer.ts";

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

interface FakeSurface {
  call: HerdrCall;
  renames: string[][];
  paneReads: number;
}

function surface(session: unknown, options: { sessionAfterReads?: number } = {}): FakeSurface {
  const fake: FakeSurface = { renames: [], paneReads: 0, call: undefined as never };
  fake.call = async (args) => {
    if (args[0] === "pane" && args[1] === "get") {
      fake.paneReads += 1;
      const ready = fake.paneReads > (options.sessionAfterReads ?? 0);
      return {
        result: { pane: { tab_id: "tab_1", agent_session: ready ? session : null } },
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

describe("parseAgentDetected", () => {
  test("reads the envelope's pane id and released flag", () => {
    expect(parseAgentDetected(EVENT)).toEqual({ paneId: "pane_1", released: false });
    expect(parseAgentDetected("not json")).toBeNull();
    expect(parseAgentDetected(JSON.stringify({ data: {} }))).toBeNull();
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
    expect(existsSync(join(dir, "named-tabs", "tab_1"))).toBe(true);
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
});
