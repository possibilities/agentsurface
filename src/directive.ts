import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionDirective } from "./directive-schema.ts";
import {
  createTab,
  createWorkspace,
  createWorktree,
  focusTab,
  focusWorkspace,
  type HerdrCall,
  HerdrError,
  herdrBinary,
  listAgents,
  listPanes,
  listWorkspaces,
  liveAgentNames,
  nextAgentName,
  startAgentWhenReady,
} from "./herdr.ts";
import type { Environ } from "./paths.ts";
import { appendLaunch } from "./state.ts";

/**
 * Realizing one session directive: create the workspace or worktree
 * (focused or not, by the directive), start the agent with the intent
 * riding the launch as a spool-file reference, and append the launch
 * record. Runs detached from the host — a hosted TUI's popup closes with
 * its process, so execution cannot live there — and with no terminal to
 * report to, a failure goes to a herdr notification.
 */

/** A directive that never reached a running harness. It carries the spool
 * file holding the intent, because a failure notification the operator can
 * act on has to name where the prompt went — recovering one otherwise means
 * reading the state directory by hand. */
export class LaunchFailure extends Error {
  readonly intentPath: string | null;

  constructor(message: string, intentPath: string | null) {
    super(message);
    this.intentPath = intentPath;
  }
}

/** Two directives can still race on an opaque alias before either agent
 * registers; `agent_name_taken` re-derives against the fresh list, excluding
 * names this launch already tried.
 *
 * A failure here is a failure to *start*: herdr's post-spawn confirmation
 * outcomes come back as an unnamed-but-started launch instead, recorded and
 * silent. */
export async function executeDirective(
  call: HerdrCall,
  logPath: string,
  directive: SessionDirective,
): Promise<void> {
  const intent: { path: string | null } = { path: null };
  try {
    await startSession(call, logPath, directive, intent);
  } catch (error) {
    throw new LaunchFailure(error instanceof Error ? error.message : String(error), intent.path);
  }
}

async function startSession(
  call: HerdrCall,
  logPath: string,
  directive: SessionDirective,
  intent: { path: string | null },
): Promise<void> {
  // A directive that names its native session is a resume, and a session
  // already live on the surface is not resumed again — its surface is
  // focused (per the directive's own focus) and the record says so. The
  // emitting tool cannot know this: reading surface state is the host's
  // side of the protocol.
  if (directive.session_id !== undefined) {
    const live = (await listAgents(call)).find(
      (agent) => agent.sessionValue === directive.session_id,
    );
    if (live !== undefined) {
      if (directive.focus) {
        await focusWorkspace(call, live.workspaceId);
        await focusTab(call, live.tabId);
      }
      appendLaunch(logPath, {
        ...directive.record,
        at: new Date().toISOString(),
        project: directive.cwd,
        harness: directive.agent.kind,
        worktree: directive.worktree,
        branch: null,
        workspace: live.workspaceId,
        // The live agent may run under a name herdr released or one this
        // executor never assigned; the record is bookkeeping either way.
        agent: live.name ?? "",
        named: live.name !== null,
        focused_existing: true,
      });
      return;
    }
  }
  let surface: Awaited<ReturnType<typeof createWorkspace>>;
  if (directive.worktree) {
    surface = await createWorktree(call, { cwd: directive.cwd, focus: directive.focus });
  } else {
    // A project already on the surface gets a new tab in its workspace; a
    // workspace is created only when none exists.
    const existing = await findProjectWorkspace(call, directive.cwd);
    if (existing !== null) {
      surface = await createTab(call, {
        workspaceId: existing,
        cwd: directive.cwd,
        focus: directive.focus,
      });
      // Focusing a tab focuses it within its workspace; the jump between
      // workspaces is its own move.
      if (directive.focus) await focusWorkspace(call, existing);
    } else {
      surface = await createWorkspace(call, {
        cwd: directive.cwd,
        label: basename(directive.cwd),
        focus: directive.focus,
      });
    }
  }
  const agentArgs = [...directive.agent.args];
  if (directive.intent !== null && directive.intent !== "") {
    intent.path = writeIntentFile(dirname(logPath), directive.intent);
    agentArgs.push("--x-prompt-file", intent.path);
  }
  const tried = new Set<string>();
  let name = "";
  let outcome: Awaited<ReturnType<typeof startAgentWhenReady>>;
  for (let attempt = 0; ; attempt++) {
    name = nextAgentName(new Set([...(await liveAgentNames(call)), ...tried]));
    tried.add(name);
    try {
      outcome = await startAgentWhenReady(call, {
        name,
        kind: directive.agent.kind,
        paneId: surface.paneId,
        agentArgs,
      });
      break;
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_name_taken" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
  // The directive's record extras ride along; the host's own fields win a
  // name collision, so the record's provenance stays trustworthy.
  appendLaunch(logPath, {
    ...directive.record,
    at: new Date().toISOString(),
    project: directive.cwd,
    harness: directive.agent.kind,
    worktree: directive.worktree,
    branch: surface.branch,
    workspace: surface.workspaceId,
    agent: name,
    named: outcome.named,
  });
}

/** Herdr types the launch into the pane's interactive shell and refuses
 * control characters in agent arguments, so a multi-line intent cannot ride
 * the argv as literal text. It travels as a spool file instead:
 * agentlaunch's `--x-prompt-file` appends the file's text as the final
 * native token once the shell boundary is behind it. Agentlaunch never
 * deletes the file, and the executor cannot know when it was read, so the
 * spool is pruned by age — one unlink at a time, like the log beside it. */
export function writeIntentFile(
  stateDir: string,
  intent: string,
  now: number = Date.now(),
): string {
  const spool = join(stateDir, "intents");
  mkdirSync(spool, { recursive: true });
  pruneSpool(spool, now, INTENT_SPOOL_MAX_AGE_MS);
  const path = join(spool, `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}.txt`);
  writeFileSync(path, intent);
  return path;
}

const INTENT_SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Old spool entries, removed one at a time; a raced unlink is a peer's
 * prune finishing first, and costs nothing. */
export function pruneSpool(spool: string, now: number, maxAgeMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(spool);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(spool, entry);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) unlinkSync(path);
    } catch {
      // A concurrent pruner may have won; the work goes on.
    }
  }
}

/** The workspace already hosting a project: one carrying the project's name
 * as its label. Herdr's foreground cwd is transient — a shell or popup can
 * visit another project without changing which project its workspace hosts.
 * When duplicate labels exist, a pane's stable cwd breaks the tie. Null means
 * the project is not on the surface. */
export async function findProjectWorkspace(
  call: HerdrCall,
  projectPath: string,
): Promise<string | null> {
  const inside = (cwd: string | null): boolean =>
    cwd !== null && (cwd === projectPath || cwd.startsWith(`${projectPath}/`));
  const panes = await listPanes(call);
  const label = basename(projectPath);
  const candidates = (await listWorkspaces(call)).filter((workspace) => workspace.label === label);
  if (candidates.length === 0) return null;
  const candidateIds = new Set(candidates.map((workspace) => workspace.workspaceId));
  const byStableCwd = panes.find((pane) => candidateIds.has(pane.workspaceId) && inside(pane.cwd));
  return byStableCwd?.workspaceId ?? candidates[0]!.workspaceId;
}

/** The failure as the operator should read it: what went wrong, and where the
 * prompt is still sitting when one was spooled. */
export function launchFailureBody(message: string, intentPath: string | null): string {
  return intentPath === null ? message : `${message}\n\nPrompt: ${intentPath}`;
}

/** Best-effort: the executor has no terminal, so the surface itself carries
 * the failure to the operator. */
export async function notifyLaunchFailure(env: Environ, message: string): Promise<void> {
  try {
    const proc = Bun.spawn(
      [herdrBinary(env), "notification", "show", "agentsurface launch failed", "--body", message],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: env as Record<string, string>,
      },
    );
    await proc.exited;
  } catch {
    // stderr already carries the failure; there is nothing else to reach.
  }
}
