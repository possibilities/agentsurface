import { describe, expect, test } from "bun:test";
import {
  type BusAgent,
  composeBusMessage,
  deliveryNote,
  joinBusAgents,
  placesByWorkspace,
  renderBusAgents,
  resolveTarget,
  runAgents,
  runMessage,
  tabLabels,
} from "../src/bus.ts";
import { CliError } from "../src/errors.ts";
import type { HerdrCall } from "../src/herdr.ts";

const AGENT_ROWS = [
  {
    name: "a-1111111111",
    agent: "claude",
    agent_status: "working",
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-plan" },
    workspace_id: "ws1",
    tab_id: "t1",
    pane_id: "p1",
    cwd: "/home/op/code/planner",
  },
  {
    name: null,
    agent: "codex",
    agent_status: "idle",
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "s-rev" },
    workspace_id: "ws1",
    tab_id: "t2",
    pane_id: "p2",
    cwd: "/home/op/code/reviewer",
  },
  {
    name: null,
    agent: "claude",
    agent_status: "idle",
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-plan2" },
    workspace_id: "ws2",
    tab_id: "t3",
    pane_id: "p3",
    cwd: null,
  },
];

const WORKSPACE_ROWS = [
  { workspace_id: "ws1", label: "alpha" },
  {
    workspace_id: "ws2",
    label: "worktree-quiet-valley",
    worktree: {
      checkout_path: "/home/op/.herdr/worktrees/alpha/worktree-quiet-valley",
      is_linked_worktree: true,
      repo_name: "alpha",
      repo_root: "/home/op/code/alpha",
    },
  },
];

const TAB_ROWS = [
  { tab_id: "t1", workspace_id: "ws1", label: "planner" },
  { tab_id: "t2", workspace_id: "ws1", label: "reviewer" },
  { tab_id: "t3", workspace_id: "ws2", label: "planner" },
];

interface FakeSurface {
  call: HerdrCall;
  prompts: string[][];
}

function surface(
  options: {
    promptStatus?: string;
    promptError?: { code: string; message: string };
    /** Fail only the first N prompt attempts; permanent when omitted. */
    promptErrorTimes?: number;
    agents?: unknown[];
    tabs?: unknown[];
    workspaces?: unknown[];
    paneSession?: string | null;
  } = {},
): FakeSurface {
  const fake: FakeSurface = { prompts: [], call: undefined as never };
  fake.call = async (args) => {
    if (args[0] === "agent" && args[1] === "list") {
      return { result: { agents: options.agents ?? AGENT_ROWS } };
    }
    if (args[0] === "tab" && args[1] === "list") {
      return { result: { tabs: options.tabs ?? TAB_ROWS } };
    }
    if (args[0] === "workspace" && args[1] === "list") {
      return { result: { workspaces: options.workspaces ?? WORKSPACE_ROWS } };
    }
    if (args[0] === "pane" && args[1] === "get") {
      const value = options.paneSession === undefined ? "s-rev" : options.paneSession;
      return {
        result: {
          pane: {
            tab_id: args[2] === "p2" ? "t2" : "t9",
            agent_session: value === null ? null : { agent: "codex", kind: "id", value },
          },
        },
      };
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      fake.prompts.push(args.slice(2));
      const promptError = options.promptError;
      if (
        promptError !== undefined &&
        (options.promptErrorTimes === undefined || fake.prompts.length <= options.promptErrorTimes)
      ) {
        return { error: promptError };
      }
      return { result: { agent: { agent_status: options.promptStatus ?? "working" } } };
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
  return fake;
}

function busAgents(): BusAgent[] {
  return joinBusAgents(
    AGENT_ROWS.map((row) => ({
      name: row.name,
      harness: row.agent,
      status: row.agent_status,
      sessionValue: row.agent_session?.value ?? null,
      workspaceId: row.workspace_id,
      tabId: row.tab_id,
      paneId: row.pane_id,
      cwd: row.cwd,
    })),
    tabLabels([
      { tabId: "t1", workspaceId: "ws1", label: "planner" },
      { tabId: "t2", workspaceId: "ws1", label: "reviewer" },
      { tabId: "t3", workspaceId: "ws2", label: "planner" },
    ]),
    placesByWorkspace([
      { workspaceId: "ws1", label: "alpha", worktreePath: null },
      {
        workspaceId: "ws2",
        label: "worktree-quiet-valley",
        worktreePath: "/home/op/.herdr/worktrees/alpha/worktree-quiet-valley",
      },
    ]),
  );
}

async function expectCliError(work: Promise<unknown>, code: string): Promise<CliError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(code);
    return error as CliError;
  }
  throw new Error(`expected CliError ${code}`);
}

describe("joinBusAgents", () => {
  test("names each agent by its tab's label, tab id when unlabeled", () => {
    const agents = joinBusAgents(
      [
        {
          name: null,
          harness: "claude",
          status: "idle",
          sessionValue: null,
          workspaceId: "ws1",
          tabId: "t-unlabeled",
          paneId: "p9",
          cwd: null,
        },
      ],
      tabLabels([{ tabId: "t-unlabeled", workspaceId: "ws1", label: null }]),
    );
    expect(agents[0]?.name).toBe("t-unlabeled");
    expect(busAgents().map((agent) => agent.name)).toEqual(["planner", "reviewer", "planner"]);
  });
});

describe("placesByWorkspace", () => {
  test("a linked worktree answers to its name with and without the prefix", () => {
    const places = placesByWorkspace([
      {
        workspaceId: "ws2",
        label: "worktree-quiet-valley",
        worktreePath: "/home/op/.herdr/worktrees/alpha/worktree-quiet-valley",
      },
    ]);
    expect(places.get("ws2")).toEqual({
      name: "quiet-valley",
      aliases: ["worktree-quiet-valley", "quiet-valley"],
      isWorktree: true,
    });
  });

  test("a renamed worktree workspace keeps the checkout's name as an address", () => {
    const place = placesByWorkspace([
      {
        workspaceId: "ws2",
        label: "review",
        worktreePath: "/home/op/.herdr/worktrees/alpha/worktree-quiet-valley",
      },
    ]).get("ws2");
    expect(place?.name).toBe("review");
    expect(place?.aliases).toEqual(["review", "worktree-quiet-valley", "quiet-valley"]);
  });

  test("an ordinary workspace is its label; a nameless one has no place", () => {
    const places = placesByWorkspace([
      { workspaceId: "ws1", label: "alpha", worktreePath: null },
      { workspaceId: "ws9", label: null, worktreePath: null },
    ]);
    expect(places.get("ws1")).toEqual({ name: "alpha", aliases: ["alpha"], isWorktree: false });
    expect(places.has("ws9")).toBe(false);
  });
});

describe("resolveTarget", () => {
  test("a name in the sender's workspace wins over the same name elsewhere", () => {
    const resolution = resolveTarget(busAgents(), "planner", "ws1");
    expect(resolution).toMatchObject({ kind: "match", agent: { paneId: "p1" } });
  });

  test("a name unique to another workspace still resolves", () => {
    const resolution = resolveTarget(busAgents(), "reviewer", "ws2");
    expect(resolution).toMatchObject({ kind: "match", agent: { paneId: "p2" } });
  });

  test("a colliding name with no workspace to prefer is ambiguous", () => {
    const resolution = resolveTarget(busAgents(), "planner", null);
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.candidates.map((agent) => agent.paneId)).toEqual(["p1", "p3"]);
    }
  });

  test("a session id resolves regardless of workspace", () => {
    const resolution = resolveTarget(busAgents(), "s-plan2", "ws1");
    expect(resolution).toMatchObject({ kind: "match", agent: { paneId: "p3" } });
  });

  test("a worktree names the one agent working in it, either spelling", () => {
    for (const spelling of ["worktree-quiet-valley", "quiet-valley"]) {
      expect(resolveTarget(busAgents(), spelling, "ws1")).toMatchObject({
        kind: "match",
        agent: { paneId: "p3" },
      });
    }
  });

  test("a place holding two agents is ambiguous, not a guess", () => {
    const resolution = resolveTarget(busAgents(), "alpha", "ws2");
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.candidates.map((agent) => agent.paneId)).toEqual(["p1", "p2"]);
    }
  });

  test("a name beats a place that shares the spelling", () => {
    const agents = busAgents().map((agent) =>
      agent.paneId === "p1" ? { ...agent, name: "quiet-valley" } : agent,
    );
    expect(resolveTarget(agents, "quiet-valley", null)).toMatchObject({
      kind: "match",
      agent: { paneId: "p1" },
    });
  });

  test("no match is reported as none", () => {
    expect(resolveTarget(busAgents(), "stranger", "ws1").kind).toBe("none");
  });
});

describe("composeBusMessage", () => {
  const worktree = { name: "quiet-valley", aliases: ["quiet-valley"], isWorktree: true };

  test("prefixes every address the sender answers to", () => {
    expect(
      composeBusMessage({ name: "reviewer", sessionId: "s-rev", place: worktree }, "hello"),
    ).toBe(
      'Message sent over the agent message bus from agent named "reviewer" (session s-rev, worktree quiet-valley): hello',
    );
  });

  test("a place that is not a worktree is named a workspace", () => {
    expect(
      composeBusMessage(
        {
          name: "reviewer",
          sessionId: "s-rev",
          place: { name: "alpha", aliases: ["alpha"], isWorktree: false },
        },
        "hello",
      ),
    ).toContain("(session s-rev, workspace alpha)");
  });

  test("omits the clauses the sender has none of", () => {
    expect(composeBusMessage({ name: "reviewer", sessionId: null, place: null }, "hello")).toBe(
      'Message sent over the agent message bus from agent named "reviewer": hello',
    );
    expect(
      composeBusMessage({ name: "reviewer", sessionId: null, place: worktree }, "hello"),
    ).toContain('named "reviewer" (worktree quiet-valley)');
  });
});

describe("deliveryNote", () => {
  test("translates the target's status into delivery semantics", () => {
    expect(deliveryNote("working")).toBe(" while working — queued behind its current turn");
    expect(deliveryNote("idle")).toBe(" while idle — it will be read now");
    expect(deliveryNote("done")).toBe(" while done — it will be read now");
    expect(deliveryNote("unknown")).toBe("; target status unknown");
  });
});

describe("renderBusAgents", () => {
  test("aligns columns and shortens cwd to ~", () => {
    const rendered = renderBusAgents(busAgents().slice(0, 2), {
      home: "/home/op",
      places: false,
    });
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("name      session  harness  status   cwd");
    expect(lines[1]).toBe("planner   s-plan   claude   working  ~/code/planner");
    expect(lines[2]).toBe("reviewer  s-rev    codex    idle     ~/code/reviewer");
  });

  test("the session-wide view adds a place column, worktree name or label", () => {
    const rendered = renderBusAgents(busAgents(), { home: "/home/op", places: true });
    const lines = rendered.split("\n");
    expect(lines[0]).toContain("place");
    expect(lines[1]).toContain("alpha");
    expect(lines[3]).toContain("quiet-valley");
  });

  test("a workspace with no place falls back to its id, never a blank cell", () => {
    const placeless = busAgents().map((agent) => ({ ...agent, place: null }));
    const rendered = renderBusAgents(placeless.slice(2), { home: "/home/op", places: true });
    expect(rendered.split("\n")[1]).toContain("ws2");
  });
});

describe("runAgents", () => {
  test("scopes to the caller's workspace by default", async () => {
    const fake = surface();
    const listed = await runAgents(fake.call, { HERDR_WORKSPACE_ID: "ws1" }, "/home/op", false);
    expect(listed).toContain("reviewer");
    expect(listed).not.toContain("s-plan2");
    expect(listed).not.toContain("place");
  });

  test("--all lists the whole session with places", async () => {
    const fake = surface();
    const listed = await runAgents(fake.call, { HERDR_WORKSPACE_ID: "ws1" }, "/home/op", true);
    expect(listed).toContain("s-plan2");
    expect(listed).toContain("alpha");
    expect(listed).toContain("quiet-valley");
  });

  test("no workspace in the environment behaves as --all", async () => {
    const listed = await runAgents(surface().call, {}, "/home/op", false);
    expect(listed).toContain("s-plan2");
  });

  test("an empty scope says so instead of printing a bare header", async () => {
    const fake = surface({ agents: [] });
    expect(await runAgents(fake.call, { HERDR_WORKSPACE_ID: "ws1" }, "/home/op", false)).toContain(
      "--all",
    );
    expect(await runAgents(fake.call, {}, "/home/op", false)).toBe("no agents on the surface");
  });
});

const SENDER_ENV = { HERDR_PANE_ID: "p2", HERDR_WORKSPACE_ID: "ws1" };

describe("runMessage", () => {
  test("resolves a name, prefixes the sender, and delivers to the pane", async () => {
    const fake = surface();
    const confirmation = await runMessage(fake.call, SENDER_ENV, "planner", "hello");
    expect(fake.prompts).toEqual([
      [
        "p1",
        'Message sent over the agent message bus from agent named "reviewer" (session s-rev, workspace alpha): hello',
      ],
    ]);
    expect(confirmation).toBe(
      'delivered to "planner" (s-plan, claude) while working — queued behind its current turn',
    );
  });

  test("reports an idle target as reading the message now", async () => {
    const fake = surface({ promptStatus: "idle" });
    const confirmation = await runMessage(fake.call, SENDER_ENV, "s-plan2", "hello");
    expect(fake.prompts[0]?.[0]).toBe("p3");
    expect(confirmation).toBe(
      'delivered to "planner" (s-plan2, claude) while idle — it will be read now',
    );
  });

  test("a sender pane without a session falls back to the tab label alone", async () => {
    const fake = surface({ paneSession: null });
    await runMessage(fake.call, SENDER_ENV, "planner", "hello");
    expect(fake.prompts[0]?.[1]).toBe(
      'Message sent over the agent message bus from agent named "reviewer" (workspace alpha): hello',
    );
  });

  test("a colliding name without a preferred workspace lists the candidates", async () => {
    const error = await expectCliError(
      runMessage(surface().call, { HERDR_PANE_ID: "p2" }, "planner", "hello"),
      "bus_target_ambiguous",
    );
    expect(error.message).toContain("s-plan");
    expect(error.message).toContain("s-plan2");
  });

  test("an unknown target reports not found", async () => {
    await expectCliError(
      runMessage(surface().call, SENDER_ENV, "stranger", "hello"),
      "bus_target_not_found",
    );
  });

  test("a worktree name addresses the one agent working there", async () => {
    const fake = surface({ promptStatus: "idle" });
    const confirmation = await runMessage(fake.call, SENDER_ENV, "quiet-valley", "hello");
    expect(fake.prompts[0]?.[0]).toBe("p3");
    expect(confirmation).toContain('delivered to "planner" (s-plan2, claude)');
  });

  test("a place holding two agents refuses and names each one", async () => {
    const error = await expectCliError(
      runMessage(surface().call, { HERDR_PANE_ID: "p2", HERDR_WORKSPACE_ID: "ws2" }, "alpha", "x"),
      "bus_target_ambiguous",
    );
    expect(error.message).toContain('"planner" (session s-plan)');
    expect(error.message).toContain('"reviewer" (session s-rev)');
    expect(error.recovery).toContain("session id");
  });

  test("a candidate with no session is named as having none, not by its pane", async () => {
    const sessionless = [
      { ...AGENT_ROWS[0], agent_session: null },
      { ...AGENT_ROWS[1], agent_session: null },
    ];
    const error = await expectCliError(
      runMessage(
        surface({ agents: sessionless }).call,
        { HERDR_PANE_ID: "p2", HERDR_WORKSPACE_ID: "ws2" },
        "alpha",
        "x",
      ),
      "bus_target_ambiguous",
    );
    expect(error.message).toContain('"planner" (no session yet)');
    expect(error.message).not.toContain("p1");
  });

  test("a blocked target is reported as undelivered", async () => {
    const fake = surface({ promptError: { code: "agent_blocked", message: "blocked" } });
    const error = await expectCliError(
      runMessage(fake.call, SENDER_ENV, "planner", "hello"),
      "bus_target_blocked",
    );
    expect(error.message).toContain("not delivered");
  });

  test("outside a herdr pane the bus refuses", async () => {
    await expectCliError(runMessage(surface().call, {}, "planner", "hello"), "bus_outside_pane");
  });

  test("without --wait-unblocked the recovery names the flag", async () => {
    const fake = surface({ promptError: { code: "agent_blocked", message: "blocked" } });
    const error = await expectCliError(
      runMessage(fake.call, SENDER_ENV, "planner", "hello"),
      "bus_target_blocked",
    );
    expect(fake.prompts.length).toBe(1);
    expect(error.recovery).toContain("--wait-unblocked");
  });

  test("--wait-unblocked retries a blocked target and delivers once it clears", async () => {
    const fake = surface({
      promptError: { code: "agent_blocked", message: "blocked" },
      promptErrorTimes: 2,
      promptStatus: "idle",
    });
    let clock = 0;
    const confirmation = await runMessage(fake.call, SENDER_ENV, "planner", "hello", {
      waitUnblocked: true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(fake.prompts.length).toBe(3);
    expect(confirmation).toContain("while idle");
  });

  test("--wait-unblocked also outlasts a briefly not-ready target", async () => {
    const fake = surface({
      promptError: { code: "agent_not_ready", message: "not ready" },
      promptErrorTimes: 1,
    });
    let clock = 0;
    await runMessage(fake.call, SENDER_ENV, "planner", "hello", {
      waitUnblocked: true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(fake.prompts.length).toBe(2);
  });

  test("--wait-unblocked reports honestly at the deadline", async () => {
    const fake = surface({ promptError: { code: "agent_blocked", message: "blocked" } });
    let clock = 0;
    const error = await expectCliError(
      runMessage(fake.call, SENDER_ENV, "planner", "hello", {
        waitUnblocked: true,
        timeoutMs: 5_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
      "bus_target_blocked",
    );
    expect(fake.prompts.length).toBeGreaterThan(1);
    expect(error.message).toContain("after waiting 5s");
    expect(error.message).toContain("not delivered");
  });
});
