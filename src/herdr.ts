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

/** What a launch needs from a workspace or worktree create response. Both
 * responses carry workspace, tab, and root_pane by herdr's API schema. */
export interface CreatedSurface {
  workspaceId: string;
  paneId: string;
}

function surfaceFrom(result: unknown, what: string): CreatedSurface {
  const body = result as {
    workspace?: { workspace_id?: unknown };
    root_pane?: { pane_id?: unknown };
  } | null;
  const workspaceId = body?.workspace?.workspace_id;
  const paneId = body?.root_pane?.pane_id;
  if (typeof workspaceId !== "string" || typeof paneId !== "string") {
    throw new HerdrError(`herdr's ${what} response named no workspace and root pane`);
  }
  return { workspaceId, paneId };
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

export async function createWorktree(
  call: HerdrCall,
  options: { cwd: string; branch: string; focus: boolean },
): Promise<CreatedSurface> {
  const result = await invoke(call, [
    "worktree",
    "create",
    "--cwd",
    options.cwd,
    "--branch",
    options.branch,
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
  return { workspaceId: options.workspaceId, paneId };
}

export async function focusWorkspace(call: HerdrCall, workspaceId: string): Promise<void> {
  await invoke(call, ["workspace", "focus", workspaceId]);
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

export async function liveAgentNames(call: HerdrCall): Promise<Set<string>> {
  const result = (await invoke(call, ["agent", "list"])) as { agents?: unknown } | null;
  const names = new Set<string>();
  if (Array.isArray(result?.agents)) {
    for (const agent of result.agents) {
      const name = (agent as { name?: unknown }).name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

/** Agent names are unique among live agents: number per kind and take the
 * first free slot, the fleet's existing naming idiom. */
export function nextAgentName(kind: string, taken: ReadonlySet<string>): string {
  let index = 1;
  while (taken.has(`${kind}-${index}`)) index += 1;
  return `${kind}-${index}`;
}

/** A freshly created pane is not an available shell until its startup files
 * finish; the server's own readiness check is the only authority, so retry
 * against agent_pane_busy rather than guessing from process state.
 *
 * `agent_not_ready` is a soft outcome, not a failure: the agent is present
 * and named, but blocked on a startup dialog (folder trust, first run) only
 * the operator can answer. The intent already rides the launch argv, so the
 * harness submits it once the dialog clears — nothing is lost. */
export async function startAgentWhenReady(
  call: HerdrCall,
  options: {
    name: string;
    kind: string;
    paneId: string;
    agentArgs: string[];
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<{ ready: boolean }> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  const args = [
    "agent",
    "start",
    options.name,
    "--kind",
    options.kind,
    "--pane",
    options.paneId,
    ...(options.agentArgs.length > 0 ? ["--", ...options.agentArgs] : []),
  ];
  for (;;) {
    const response = await call(args);
    const error = response.error;
    if (error === undefined || error === null) return { ready: true };
    if (error.code === "agent_not_ready") return { ready: false };
    if (error.code !== "agent_pane_busy" || Date.now() >= deadline) {
      throw new HerdrError(
        error.message ?? `agent start ${options.name} failed`,
        error.code ?? null,
      );
    }
    await Bun.sleep(pollMs);
  }
}
