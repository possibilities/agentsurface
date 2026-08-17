import { closeSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { UsageError } from "../errors.ts";
import {
  createTab,
  createWorkspace,
  createWorktree,
  focusWorkspace,
  type HerdrCall,
  HerdrError,
  herdrBinary,
  listPanes,
  listWorkspaces,
  liveAgentNames,
  nextAgentName,
  startAgentWhenReady,
} from "../herdr.ts";
import type { Environ } from "../paths.ts";
import { appendLaunch } from "../state.ts";
import type { LaunchPlan } from "./model.ts";

/**
 * The detached half of a launch. Submitting must close the popup right
 * away, and a popup closes only when its process exits — so the TUI hands
 * the frozen plan to `agentsurface execute-launch <json>` spawned detached,
 * and exits. The executor creates the workspace or worktree (focused or
 * not, by submit mode), starts the agent with the intent riding the argv,
 * and appends the launch record. With no terminal to report to, a failure
 * goes to a herdr notification.
 */

export interface DetachedLaunch extends LaunchPlan {
  focus: boolean;
}

export function parseDetachedLaunch(json: string): DetachedLaunch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new UsageError("execute-launch takes the launch plan as one JSON argument");
  }
  const plan = parsed as DetachedLaunch;
  if (
    typeof plan?.project?.path !== "string" ||
    typeof plan.harness !== "string" ||
    typeof plan.model !== "string" ||
    typeof plan.effort !== "string" ||
    typeof plan.level !== "string" ||
    typeof plan.prompt !== "string" ||
    typeof plan.worktree !== "boolean" ||
    typeof plan.focus !== "boolean" ||
    (plan.priming !== null && typeof plan.priming !== "string")
  ) {
    throw new UsageError("execute-launch plan is missing fields");
  }
  return plan;
}

/** The child's stderr appends to a log beside the launch records: a crash
 * before the executor's own failure handling must still leave evidence. */
export function spawnDetachedLaunch(env: Environ, logPath: string, plan: DetachedLaunch): void {
  let stderr: number | "ignore" = "ignore";
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    stderr = openSync(join(dirname(logPath), "executor.log"), "a");
  } catch {
    // No log home; the launch still matters more than its evidence.
  }
  const proc = Bun.spawn(
    [process.execPath, process.argv[1] ?? "agentsurface", "execute-launch", JSON.stringify(plan)],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr,
      env: env as Record<string, string>,
    },
  );
  proc.unref();
  if (typeof stderr === "number") closeSync(stderr);
}

/** A priming rides the intent as each harness's own skill spelling: /name
 * for claude and pi, $name for codex — the prefix alone when the intent is
 * empty, so the skill still primes the session. */
export function primedPrompt(plan: Pick<DetachedLaunch, "harness" | "prompt" | "priming">): string {
  if (plan.priming === null) return plan.prompt;
  const sigil = plan.harness === "codex" ? "$" : "/";
  return `${sigil}${plan.priming}${plan.prompt === "" ? "" : ` ${plan.prompt}`}`;
}

/** Two launches fired in quick succession can race to the same `<kind>-<n>`
 * before either agent registers; `agent_name_taken` re-derives against the
 * fresh list, excluding names this launch already tried. */
export async function executeLaunch(
  call: HerdrCall,
  logPath: string,
  plan: DetachedLaunch,
): Promise<void> {
  let surface: Awaited<ReturnType<typeof createWorkspace>>;
  if (plan.worktree) {
    surface = await createWorktree(call, { cwd: plan.project.path, focus: plan.focus });
  } else {
    // A project already on the surface gets a new tab in its workspace; a
    // workspace is created only when none exists.
    const existing = await findProjectWorkspace(call, plan.project.path);
    if (existing !== null) {
      surface = await createTab(call, {
        workspaceId: existing,
        cwd: plan.project.path,
        focus: plan.focus,
      });
      // Focusing a tab focuses it within its workspace; the jump between
      // workspaces is its own move.
      if (plan.focus) await focusWorkspace(call, existing);
    } else {
      surface = await createWorkspace(call, {
        cwd: plan.project.path,
        label: basename(plan.project.path),
        focus: plan.focus,
      });
    }
  }
  const primed = primedPrompt(plan);
  const agentArgs = ["--x-level", plan.level, ...(primed === "" ? [] : [primed])];
  const tried = new Set<string>();
  let name = "";
  for (let attempt = 0; ; attempt++) {
    name = nextAgentName(plan.harness, new Set([...(await liveAgentNames(call)), ...tried]));
    tried.add(name);
    try {
      await startAgentWhenReady(call, {
        name,
        kind: plan.harness,
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
  appendLaunch(logPath, {
    at: new Date().toISOString(),
    project: plan.project.path,
    harness: plan.harness,
    model: plan.model,
    effort: plan.effort,
    worktree: plan.worktree,
    branch: surface.branch,
    workspace: surface.workspaceId,
    agent: name,
    priming: plan.priming,
  });
}

/** The workspace already hosting a project: one with a pane working inside
 * it, else one carrying the project's name as its label (a pane may have
 * wandered elsewhere since). Null means the project is not on the surface. */
export async function findProjectWorkspace(
  call: HerdrCall,
  projectPath: string,
): Promise<string | null> {
  const inside = (cwd: string | null): boolean =>
    cwd !== null && (cwd === projectPath || cwd.startsWith(`${projectPath}/`));
  const panes = await listPanes(call);
  const byCwd = panes.find((pane) => inside(pane.foregroundCwd) || inside(pane.cwd));
  if (byCwd !== undefined) return byCwd.workspaceId;
  const label = basename(projectPath);
  const byLabel = (await listWorkspaces(call)).find((workspace) => workspace.label === label);
  return byLabel?.workspaceId ?? null;
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
