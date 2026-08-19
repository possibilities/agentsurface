import type { Environ } from "./paths.ts";

/**
 * A thin client for the herdr CLI, which speaks to the running session over
 * its socket API. Herdr owns every topology semantic — where worktrees go,
 * what a workspace is, when a pane counts as an available shell — and this
 * module only phrases requests and reads the JSON answers.
 *
 * Herdr exports HERDR_BIN_PATH into custom command bindings (the popup this
 * TUI usually runs in); PATH resolution is the fallback for ordinary shells.
 * Successful responses arrive on stdout, error responses on stderr.
 */

export class HerdrError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

export interface HerdrResponse {
  result?: unknown;
  error?: { code?: string; message?: string } | null;
}

export type HerdrCall = (args: string[]) => Promise<HerdrResponse>;

export function herdrBinary(env: Environ): string {
  return env["HERDR_BIN_PATH"] ?? "herdr";
}

export function createHerdrCall(env: Environ): HerdrCall {
  const binary = herdrBinary(env);
  return async (args) => {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([binary, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: env as Record<string, string>,
      });
    } catch (error) {
      throw new HerdrError(`${binary} could not be run: ${(error as Error).message}`);
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    await proc.exited;
    for (const stream of [stdout, stderr]) {
      if (stream.trim() === "") continue;
      try {
        const parsed = JSON.parse(stream);
        if (typeof parsed === "object" && parsed !== null) return parsed as HerdrResponse;
      } catch {
        // Not JSON; try the other stream, then report the raw text below.
      }
    }
    throw new HerdrError(
      `herdr ${args.join(" ")}: ${stderr.trim() || stdout.trim() || "no response"}`,
    );
  };
}

export async function invoke(call: HerdrCall, args: string[]): Promise<unknown> {
  const response = await call(args);
  if (response.error !== undefined && response.error !== null) {
    throw new HerdrError(
      response.error.message ?? `herdr ${args.join(" ")} failed`,
      response.error.code ?? null,
    );
  }
  return response.result;
}

/** What a launch needs from a create response. Every create carries
 * workspace, tab, and root_pane by herdr's API schema; a worktree create
 * also names the branch herdr generated. */
export interface CreatedSurface {
  workspaceId: string;
  paneId: string;
  /** The branch herdr chose for a worktree; null for plain surfaces. */
  branch: string | null;
}

function surfaceFrom(result: unknown, what: string): CreatedSurface {
  const body = result as {
    workspace?: { workspace_id?: unknown };
    root_pane?: { pane_id?: unknown };
    worktree?: { branch?: unknown };
  } | null;
  const workspaceId = body?.workspace?.workspace_id;
  const paneId = body?.root_pane?.pane_id;
  if (typeof workspaceId !== "string" || typeof paneId !== "string") {
    throw new HerdrError(`herdr's ${what} response named no workspace and root pane`);
  }
  const branch = body?.worktree?.branch;
  return { workspaceId, paneId, branch: typeof branch === "string" ? branch : null };
}

export async function createWorkspace(
  call: HerdrCall,
  options: { cwd: string; label: string; focus: boolean },
): Promise<CreatedSurface> {
  const result = await invoke(call, [
    "workspace",
    "create",
    "--cwd",
    options.cwd,
    "--label",
    options.label,
    options.focus ? "--focus" : "--no-focus",
  ]);
  return surfaceFrom(result, "workspace create");
}

/** No --branch: herdr generates and owns the worktree's branch name; the
 * response reports what it chose. */
export async function createWorktree(
  call: HerdrCall,
  options: { cwd: string; focus: boolean },
): Promise<CreatedSurface> {
  const result = await invoke(call, [
    "worktree",
    "create",
    "--cwd",
    options.cwd,
    options.focus ? "--focus" : "--no-focus",
  ]);
  return surfaceFrom(result, "worktree create");
}

export async function createTab(
  call: HerdrCall,
  options: { workspaceId: string; cwd: string; focus: boolean },
): Promise<CreatedSurface> {
  const result = (await invoke(call, [
    "tab",
    "create",
    "--workspace",
    options.workspaceId,
    "--cwd",
    options.cwd,
    options.focus ? "--focus" : "--no-focus",
  ])) as { root_pane?: { pane_id?: unknown } } | null;
  const paneId = result?.root_pane?.pane_id;
  if (typeof paneId !== "string") {
    throw new HerdrError("herdr's tab create response named no root pane");
  }
  return { workspaceId: options.workspaceId, paneId, branch: null };
}

export async function focusWorkspace(call: HerdrCall, workspaceId: string): Promise<void> {
  await invoke(call, ["workspace", "focus", workspaceId]);
}

export async function focusTab(call: HerdrCall, tabId: string): Promise<void> {
  await invoke(call, ["tab", "focus", tabId]);
}

export interface WorkspaceSummary {
  workspaceId: string;
  label: string | null;
}

export async function listWorkspaces(call: HerdrCall): Promise<WorkspaceSummary[]> {
  const result = (await invoke(call, ["workspace", "list"])) as { workspaces?: unknown } | null;
  if (!Array.isArray(result?.workspaces)) return [];
  const summaries: WorkspaceSummary[] = [];
  for (const row of result.workspaces) {
    const workspaceId = (row as { workspace_id?: unknown }).workspace_id;
    const label = (row as { label?: unknown }).label;
    if (typeof workspaceId === "string") {
      summaries.push({ workspaceId, label: typeof label === "string" ? label : null });
    }
  }
  return summaries;
}

export interface PaneSummary {
  workspaceId: string;
  cwd: string | null;
  foregroundCwd: string | null;
}

export async function listPanes(call: HerdrCall): Promise<PaneSummary[]> {
  const result = (await invoke(call, ["pane", "list"])) as { panes?: unknown } | null;
  if (!Array.isArray(result?.panes)) return [];
  const summaries: PaneSummary[] = [];
  for (const row of result.panes) {
    const workspaceId = (row as { workspace_id?: unknown }).workspace_id;
    const cwd = (row as { cwd?: unknown }).cwd;
    const foregroundCwd = (row as { foreground_cwd?: unknown }).foreground_cwd;
    if (typeof workspaceId === "string") {
      summaries.push({
        workspaceId,
        cwd: typeof cwd === "string" ? cwd : null,
        foregroundCwd: typeof foregroundCwd === "string" ? foregroundCwd : null,
      });
    }
  }
  return summaries;
}

/** One live agent from herdr's `agent list`: enough to address it (pane),
 * place it (workspace, tab, cwd), and describe it (harness, status,
 * session). `name` is herdr's own agent name — the opaque launch alias for
 * agents this tool started — not the bus name, which is the tab's label. */
export interface AgentListing {
  name: string | null;
  harness: string | null;
  status: string;
  sessionValue: string | null;
  workspaceId: string;
  tabId: string;
  paneId: string;
  cwd: string | null;
}

export async function listAgents(call: HerdrCall): Promise<AgentListing[]> {
  const result = (await invoke(call, ["agent", "list"])) as { agents?: unknown } | null;
  if (!Array.isArray(result?.agents)) return [];
  const listings: AgentListing[] = [];
  for (const row of result.agents) {
    const agent = row as {
      name?: unknown;
      agent?: unknown;
      agent_status?: unknown;
      agent_session?: { value?: unknown } | null;
      workspace_id?: unknown;
      tab_id?: unknown;
      pane_id?: unknown;
      cwd?: unknown;
    };
    const { workspace_id, tab_id, pane_id } = agent;
    if (
      typeof workspace_id !== "string" ||
      typeof tab_id !== "string" ||
      typeof pane_id !== "string"
    ) {
      continue;
    }
    const sessionValue = agent.agent_session?.value;
    listings.push({
      name: typeof agent.name === "string" ? agent.name : null,
      harness: typeof agent.agent === "string" ? agent.agent : null,
      status: typeof agent.agent_status === "string" ? agent.agent_status : "unknown",
      sessionValue: typeof sessionValue === "string" ? sessionValue : null,
      workspaceId: workspace_id,
      tabId: tab_id,
      paneId: pane_id,
      cwd: typeof agent.cwd === "string" ? agent.cwd : null,
    });
  }
  return listings;
}

export async function liveAgentNames(call: HerdrCall): Promise<Set<string>> {
  const names = new Set<string>();
  for (const agent of await listAgents(call)) {
    if (agent.name !== null) names.add(agent.name);
  }
  return names;
}

export interface TabSummary {
  tabId: string;
  workspaceId: string;
  label: string | null;
}

export async function listTabs(call: HerdrCall): Promise<TabSummary[]> {
  const result = (await invoke(call, ["tab", "list"])) as { tabs?: unknown } | null;
  if (!Array.isArray(result?.tabs)) return [];
  const summaries: TabSummary[] = [];
  for (const row of result.tabs) {
    const tabId = (row as { tab_id?: unknown }).tab_id;
    const workspaceId = (row as { workspace_id?: unknown }).workspace_id;
    const label = (row as { label?: unknown }).label;
    if (typeof tabId === "string" && typeof workspaceId === "string") {
      summaries.push({ tabId, workspaceId, label: typeof label === "string" ? label : null });
    }
  }
  return summaries;
}

/** The pane's placement and reported agent session, for identifying the
 * caller of a bus command: which tab holds it and which conversation it is. */
export interface PaneContext {
  tabId: string | null;
  sessionValue: string | null;
}

export async function getPaneContext(call: HerdrCall, paneId: string): Promise<PaneContext> {
  const result = (await invoke(call, ["pane", "get", paneId])) as {
    pane?: { tab_id?: unknown; agent_session?: { value?: unknown } | null };
  } | null;
  const tabId = result?.pane?.tab_id;
  const sessionValue = result?.pane?.agent_session?.value;
  return {
    tabId: typeof tabId === "string" ? tabId : null,
    sessionValue: typeof sessionValue === "string" ? sessionValue : null,
  };
}

/** Deliver text to a live agent as typed input: herdr pastes it into the
 * agent's terminal and submits Enter. A working agent's harness queues it
 * like any typed message; a blocked agent rejects with agent_blocked. The
 * response carries the target's fresh status — the caller's evidence for
 * whether the message was read at once or queued behind a running turn. */
export async function promptAgent(
  call: HerdrCall,
  target: string,
  text: string,
): Promise<{ status: string }> {
  const result = (await invoke(call, ["agent", "prompt", target, text])) as {
    agent?: { agent_status?: unknown };
  } | null;
  const status = result?.agent?.agent_status;
  return { status: typeof status === "string" ? status : "unknown" };
}

/** Herdr requires a unique name before it starts an agent. Keep that launch
 * alias deliberately opaque: `a-` satisfies the leading-letter grammar and
 * ten random hex characters provide a compact, non-semantic live target. */
export function nextAgentName(
  taken: ReadonlySet<string>,
  randomUuid: () => string = () => crypto.randomUUID(),
): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const token = randomUuid().replaceAll("-", "").toLowerCase().slice(0, 10);
    if (!/^[0-9a-f]{10}$/.test(token)) continue;
    const candidate = `a-${token}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new HerdrError("could not allocate a unique opaque agent name");
}

/** How long herdr may spend confirming the started agent before giving up on
 * the name. Herdr's own default is 30s, which claude routinely overruns —
 * plugins, skills, and MCP servers all boot before the harness is
 * interactive. The executor is detached and has no screen to hold, so buy the
 * generous wait: a confirmed name is worth more than a fast answer. Herdr
 * caps the value at 300s. */
const AGENT_START_CONFIRM_MS = 120_000;

/** The outcomes of `agent start` that mean the harness is up even though
 * herdr never confirmed the name. All three arrive from herdr's post-spawn
 * confirmation wait — the server has already accepted the start and typed the
 * launch into the pane by the time any of them can be returned:
 *
 * - `agent_not_ready` — present and named, but blocked on a startup dialog
 *   (folder trust, first run) only the operator can answer.
 * - `timeout` — the harness had not become interactive before herdr's
 *   confirmation deadline.
 * - `agent_name_not_found` — herdr released the name during startup, which it
 *   does whenever screen detection flickers to none after first seeing the
 *   agent.
 *
 * The intent rides the launch argv either way, so the harness submits it on
 * its own schedule and nothing is lost. Treating these as failures is how
 * every claude launch came to report one. */
const UNCONFIRMED_START_CODES = new Set(["agent_not_ready", "timeout", "agent_name_not_found"]);

/** What `agent start` settled on. `started` is false only when the harness
 * never ran; `named` is false when it runs under a name herdr did not keep,
 * which makes the launch alias useless as a live target but costs the launch
 * nothing. */
export interface AgentStartOutcome {
  started: boolean;
  named: boolean;
  /** The confirmation-phase code, for the launch record's provenance. */
  unconfirmed: string | null;
}

/** A freshly created pane is not an available shell until its startup files
 * finish; the server's own readiness check is the only authority, so retry
 * against agent_pane_busy rather than guessing from process state.
 *
 * Everything else divides into the two halves of herdr's `agent start`: the
 * spawn, whose failures are real failures, and the confirmation wait, whose
 * failures are not — see UNCONFIRMED_START_CODES. */
export async function startAgentWhenReady(
  call: HerdrCall,
  options: {
    name: string;
    kind: string;
    paneId: string;
    agentArgs: string[];
    timeoutMs?: number;
    pollMs?: number;
    confirmMs?: number;
  },
): Promise<AgentStartOutcome> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const confirmMs = options.confirmMs ?? AGENT_START_CONFIRM_MS;
  const deadline = Date.now() + timeoutMs;
  const args = [
    "agent",
    "start",
    options.name,
    "--kind",
    options.kind,
    "--pane",
    options.paneId,
    "--timeout",
    String(confirmMs),
    ...(options.agentArgs.length > 0 ? ["--", ...options.agentArgs] : []),
  ];
  for (;;) {
    const response = await call(args);
    const error = response.error;
    if (error === undefined || error === null) {
      return { started: true, named: true, unconfirmed: null };
    }
    const code = error.code ?? null;
    if (code !== null && UNCONFIRMED_START_CODES.has(code)) {
      return { started: true, named: code === "agent_not_ready", unconfirmed: code };
    }
    if (code !== "agent_pane_busy" || Date.now() >= deadline) {
      throw new HerdrError(error.message ?? `agent start ${options.name} failed`, code);
    }
    await Bun.sleep(pollMs);
  }
}
