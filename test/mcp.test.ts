import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { CONTRACT } from "../src/contract.ts";

const MAIN = resolve(import.meta.dir, "../src/main.ts");

interface RpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** A real stdio peer. Every stdout line must parse as JSON-RPC. */
class Wire {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: RpcMessage[] = [];
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  readonly reading: Promise<void>;
  stderr = "";
  private nextId = 1;

  constructor(env: Record<string, string | undefined>) {
    this.child = spawn(process.execPath, [MAIN, "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.exit = new Promise((resolveExit, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
    const child = this.child;
    this.reading = (async () => {
      for await (const line of createInterface({ input: child.stdout })) {
        const message = JSON.parse(line) as RpcMessage;
        expect(message.jsonrpc).toBe("2.0");
        this.messages.push(message);
      }
    })();
  }

  send(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  start(method: string, params: unknown = {}): number {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    const id = this.start(method, params);
    await until(() => this.messages.some((message) => message.id === id));
    const response = this.messages.find((message) => message.id === id);
    if (response?.error) throw new Error(JSON.stringify(response.error));
    return response?.result as T;
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request<Record<string, unknown>>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "surface-wire-test", version: "1" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return this.request("tools/call", { name, arguments: args });
  }

  async stop(signal?: "SIGTERM"): Promise<void> {
    if (signal) this.child.kill(signal);
    else this.child.stdin.end();
    let forced = false;
    const timeout = setTimeout(() => {
      forced = true;
      this.child.kill("SIGKILL");
    }, 4000);
    try {
      expect(await this.exit).toEqual({ code: 0, signal: null });
      await this.reading;
      expect(forced).toBe(false);
      expect(this.stderr).toBe("");
    } finally {
      clearTimeout(timeout);
    }
  }

  async cleanup(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exit;
    await this.reading;
  }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the MCP peer");
    await Bun.sleep(10);
  }
}

function value(result: CallToolResult): Record<string, any> {
  const block = result.content.find((entry) => entry.type === "text" && entry.text.startsWith("{"));
  if (block?.type !== "text") throw new Error("Missing standalone JSON value");
  const parsed = JSON.parse(block.text);
  expect(parsed).toEqual(result.structuredContent);
  return parsed;
}

function plain(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const AGENTS = [
  {
    name: "a-one",
    agent: "codex",
    agent_status: "working",
    agent_session: { value: "s-plan" },
    workspace_id: "w1",
    tab_id: "t1",
    pane_id: "p1",
    cwd: "/tmp/one",
  },
  {
    name: "a-two",
    agent: "codex",
    agent_status: "idle",
    agent_session: { value: "s-review" },
    workspace_id: "w1",
    tab_id: "t2",
    pane_id: "p2",
    cwd: "/tmp/one",
  },
  {
    name: "a-three",
    agent: "claude",
    agent_status: "working",
    agent_session: { value: "s-plan2" },
    workspace_id: "w2",
    tab_id: "t3",
    pane_id: "p3",
    cwd: "/tmp/two",
  },
  {
    name: "a-four",
    agent: "claude",
    agent_status: "idle",
    agent_session: { value: "s-review2" },
    workspace_id: "w2",
    tab_id: "t4",
    pane_id: "p4",
    cwd: "/tmp/two",
  },
];
const TABS = AGENTS.map((agent, index) => ({
  tab_id: agent.tab_id,
  workspace_id: agent.workspace_id,
  label: index % 2 ? `reviewer${index === 1 ? "" : "2"}` : "planner",
}));
const WORKSPACES = [
  { workspace_id: "w1", label: "alpha" },
  { workspace_id: "w2", label: "beta" },
];

/** Only this process-local fake speaks to the test peer; it cannot reach Herdr. */
const FAKE = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const root = process.env.FAKE_SURFACE_ROOT;
const config = JSON.parse(readFileSync(root + "/config.json", "utf8"));
const args = process.argv.slice(2);
const record = { args, pid:process.pid, socket:process.env.HERDR_SOCKET_PATH, pane:process.env.HERDR_PANE_ID ?? null, workspace:process.env.HERDR_WORKSPACE_ID ?? null };
appendFileSync(root + "/calls.jsonl", JSON.stringify(record) + "\\n");
const agents = ${JSON.stringify(AGENTS)};
const tabs = ${JSON.stringify(TABS)};
const workspaces = ${JSON.stringify(WORKSPACES)};
if ((config.mode === "hang" && args[0] === "agent" && args[1] === "list") || (config.mode === "prompt-hang" && args[1] === "prompt")) {
  process.on("SIGTERM", () => {});
  appendFileSync(root + "/hanging.jsonl", JSON.stringify(record) + "\\n");
  await new Promise(resolve => setTimeout(resolve, 30000));
}
let response;
if (args[0] === "agent" && args[1] === "list") response = {result:{agents}};
else if (args[0] === "tab" && args[1] === "list") response = {result:{tabs}};
else if (args[0] === "workspace" && args[1] === "list") response = {result:{workspaces}};
else if (args[0] === "pane" && args[1] === "get") {
 const row = agents.find(a => a.pane_id === args[2]);
 response = {result:{pane:row ? {tab_id:row.tab_id,agent_session:{value:config.changedCaller ? "reused-session" : row.agent_session.value}} : null}};
} else if (args[0] === "agent" && args[1] === "prompt") {
 response = config.mode === "blocked" ? {error:{code:"agent_blocked",message:"blocked by human input"}} : config.mode === "upstream-error" ? {error:{code:"no_such_pane",message:"target disappeared"}} : {result:{agent:{agent_status:"working"}}};
} else throw new Error("unexpected fake argv");
console.log(JSON.stringify(response));
`;

describe("Surface producer MCP", () => {
  let directory: string;
  let env: Record<string, string | undefined>;
  let context: Record<string, unknown>;
  const peers: Wire[] = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agentsurface-mcp-"));
    const fake = join(directory, "herdr");
    writeFileSync(fake, FAKE);
    chmodSync(fake, 0o755);
    writeFileSync(join(directory, "config.json"), "{}");
    env = {
      ...process.env,
      HERDR_BIN_PATH: fake,
      FAKE_SURFACE_ROOT: directory,
      HERDR_PANE_ID: "wrong-shared-pane",
      HERDR_WORKSPACE_ID: "wrong-shared-workspace",
      HERDR_SOCKET_PATH: "/wrong/shared.sock",
    };
    context = {
      "socket-path": join(directory, "caller.sock"),
      "caller-pane": "p2",
      "caller-session": "s-review",
    };
  });
  afterEach(async () => {
    for (const peer of peers.splice(0)) await peer.cleanup();
    for (const row of rows("hanging.jsonl")) {
      if (running(row.pid)) process.kill(row.pid, "SIGKILL");
    }
    rmSync(directory, { recursive: true, force: true });
  });
  function peer() {
    const wire = new Wire(env);
    peers.push(wire);
    return wire;
  }
  function config(value: Record<string, unknown>) {
    writeFileSync(join(directory, "config.json"), JSON.stringify(value));
  }
  function rows(file = "calls.jsonl"): Array<Record<string, any>> {
    const path = join(directory, file);
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  function prompts() {
    return rows().filter((row) => row.args[0] === "agent" && row.args[1] === "prompt");
  }

  test("discovers exactly the three producer tools and an offline guide", async () => {
    const wire = peer();
    const init = await wire.initialize();
    expect(init.instructions).toContain("caller-pane");
    const { tools } = await wire.request<{ tools: Tool[] }>("tools/list");
    expect(tools.map((tool) => tool.name).sort()).toEqual(["agents", "guide", "message"]);
    const message = tools.find((tool) => tool.name === "message")!;
    expect(message.inputSchema.required).toEqual(["target", "text", "socket-path", "caller-pane"]);
    expect(message.inputSchema.properties?.["timeout"]).toMatchObject({
      default: 120000,
      minimum: 1,
    });
    expect(message.inputSchema.dependentSchemas).toEqual({
      timeout: { required: ["wait-unblocked"], properties: { "wait-unblocked": { const: true } } },
    });
    expect(message.annotations?.idempotentHint).toBe(false);
    expect(value(await wire.call("guide")).data).toEqual(CONTRACT);
    expect(rows()).toEqual([]);
    await wire.stop();
  });

  test("scopes two concurrent callers independently and ignores the shared daemon identity", async () => {
    const wire = peer();
    await wire.initialize();
    const other = {
      ...context,
      "socket-path": join(directory, "other.sock"),
      "caller-pane": "p4",
      "caller-session": "s-review2",
    };
    const [one, two, all] = await Promise.all([
      wire.call("agents", context),
      wire.call("agents", other),
      wire.call("agents", { ...context, all: true }),
    ]);
    expect(plain(one)).toContain("s-review");
    expect(plain(one)).not.toContain("s-plan2");
    expect(plain(two)).toContain("s-review2");
    expect(plain(two)).not.toContain("s-plan ");
    expect(plain(all)).toContain("beta");
    expect(plain(all)).toContain("s-plan2");
    expect(new Set(rows().map((row) => row.socket))).toEqual(
      new Set([context["socket-path"], other["socket-path"]]),
    );
    expect(rows().every((row) => row.pane === null && row.workspace === null)).toBe(true);
    await wire.stop();
  });

  test("preserves terminal tables and attributes messages to fresh caller state", async () => {
    const wire = peer();
    await wire.initialize();
    const listing = await wire.call("agents", context);
    const cli = Bun.spawn([process.execPath, MAIN, "agents"], {
      env: { ...env, HERDR_PANE_ID: "p2", HERDR_WORKSPACE_ID: "w1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(cli.stdout).text()).toBe(`${plain(listing)}\n`);
    expect(await cli.exited).toBe(0);
    const text = "A literal `$(touch never)`\n--all stays message text.";
    const result = await wire.call("message", { ...context, target: "planner", text });
    expect(result.isError).not.toBe(true);
    expect(plain(result)).toContain('delivered to "planner" (s-plan, codex)');
    expect(plain(result)).toContain("queued behind its current turn");
    expect(prompts().at(-1)?.args).toEqual([
      "agent",
      "prompt",
      "p1",
      `Message sent over the agent message bus from agent named "reviewer" (session s-review, workspace alpha): ${text}`,
    ]);
    await wire.stop();
  });

  test("refuses stale caller identities before sending and preserves the domain envelope", async () => {
    const wire = peer();
    await wire.initialize();
    for (const candidate of [
      { ...context, "caller-pane": "gone" },
      { ...context, "caller-session": "old" },
    ]) {
      const result = await wire.call("message", { ...candidate, target: "planner", text: "test" });
      expect(result.isError).toBe(true);
      expect(value(result).error.code).toBe("bus_sender_unavailable");
    }
    config({ changedCaller: true });
    expect(value(await wire.call("agents", context)).error.code).toBe("bus_sender_unavailable");
    expect(prompts()).toEqual([]);
    await wire.stop();
  });

  test("retains target and upstream errors without scraping diagnostics", async () => {
    const wire = peer();
    await wire.initialize();
    expect(
      value(await wire.call("message", { ...context, target: "missing", text: "test" })).error.code,
    ).toBe("bus_target_not_found");
    config({ mode: "blocked" });
    expect(
      value(await wire.call("message", { ...context, target: "s-plan", text: "test" })).error.code,
    ).toBe("bus_target_blocked");
    config({ mode: "upstream-error" });
    expect(
      value(await wire.call("message", { ...context, target: "s-plan", text: "test" })).error.code,
    ).toBe("no_such_pane");
    await wire.stop();
  });

  test("requires explicit context and validates presence without materializing a timeout", async () => {
    const wire = peer();
    await wire.initialize();
    const invalid = [
      { target: "planner", text: "test" },
      { ...context, "socket-path": "relative.sock", target: "planner", text: "test" },
      { ...context, target: "planner", text: "" },
      { ...context, target: "planner", text: "test", timeout: 100, "wait-unblocked": false },
      { ...context, target: "planner", text: "test", timeout: 100 },
      { ...context, target: "planner", text: "test", HOME: "/changed" },
    ];
    for (const args of invalid) expect((await wire.call("message", args)).isError).toBe(true);
    expect(rows()).toEqual([]);
    expect(
      (
        await wire.call("message", {
          ...context,
          target: "planner",
          text: "test",
          "wait-unblocked": false,
        })
      ).isError,
    ).not.toBe(true);
    expect(prompts()).toHaveLength(1);
    await wire.stop();
  });

  test("cancels a blocked wait without retrying and keeps discovery usable", async () => {
    config({ mode: "blocked" });
    const wire = peer();
    await wire.initialize();
    const requestId = wire.start("tools/call", {
      name: "message",
      arguments: {
        ...context,
        target: "s-plan",
        text: "test",
        "wait-unblocked": true,
        timeout: 30000,
      },
    });
    await until(() => prompts().length === 1);
    wire.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId, reason: "stop this bounded wait" },
    });
    // MCP deliberately suppresses the response to a cancelled request. Verify
    // its effects past the next retry interval instead of waiting for a reply.
    expect(value(await wire.call("guide")).ok).toBe(true);
    await Bun.sleep(2200);
    expect(prompts()).toHaveLength(1);
    await wire.stop();
  });

  for (const mode of ["hang", "prompt-hang"]) {
    test(`shutdown reaps an unresponsive ${mode === "hang" ? "read" : "prompt"} child before exiting`, async () => {
      config({ mode });
      const wire = peer();
      await wire.initialize();
      wire.start("tools/call", {
        name: mode === "hang" ? "agents" : "message",
        arguments: mode === "hang" ? context : { ...context, target: "s-plan", text: "test" },
      });
      await until(() => rows("hanging.jsonl").length > 0);
      const pid = rows("hanging.jsonl")[0]!.pid as number;
      expect(running(pid)).toBe(true);
      await wire.stop(mode === "hang" ? "SIGTERM" : undefined);
      expect(running(pid)).toBe(false);
    });
  }

  test("EOF before initialization and after an idle handshake exit without force", async () => {
    await peer().stop();
    const wire = peer();
    await wire.initialize();
    await wire.stop();
  });
});
