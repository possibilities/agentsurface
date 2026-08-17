import { CliError } from "./errors.ts";
import {
  type AgentListing,
  getPaneContext,
  type HerdrCall,
  HerdrError,
  listAgents,
  listTabs,
  listWorkspaces,
  promptAgent,
  type TabSummary,
} from "./herdr.ts";
import { type Environ, tildePath } from "./paths.ts";

/**
 * The message bus: agents on the surface message each other through the
 * agentsurface CLI, and herdr delivers the text as typed input (`agent
 * prompt` — paste, then Enter), so a message lands exactly like an operator
 * message and a working harness queues it. This module never writes to a
 * pane itself.
 *
 * An agent's name on the bus is the label of the tab hosting its pane —
 * the slug the tab namer set, or whatever a hand rename chose. Names are
 * mutable and can collide; the agent session id is the stable authority,
 * so resolution runs name first (the sender's workspace preferred, then
 * the whole session), session id second, and reports a collision instead
 * of guessing. The sender identifies itself the same way, from the
 * HERDR_PANE_ID herdr exports into every managed pane shell.
 */

/** One live agent as the bus sees it: herdr's listing joined to its tab,
 * whose label is the agent's name here. */
export interface BusAgent {
  name: string;
  sessionId: string | null;
  harness: string | null;
  status: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  cwd: string | null;
}

export function tabLabels(tabs: readonly TabSummary[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const tab of tabs) {
    if (tab.label !== null && tab.label !== "") labels.set(tab.tabId, tab.label);
  }
  return labels;
}

/** An unlabeled tab leaves the tab id as the name: still addressable,
 * never blank. */
export function joinBusAgents(
  agents: readonly AgentListing[],
  labels: ReadonlyMap<string, string>,
): BusAgent[] {
  return agents.map((agent) => ({
    name: labels.get(agent.tabId) ?? agent.tabId,
    sessionId: agent.sessionValue,
    harness: agent.harness,
    status: agent.status,
    workspaceId: agent.workspaceId,
    tabId: agent.tabId,
    paneId: agent.paneId,
    cwd: agent.cwd,
  }));
}

export type Resolution =
  | { kind: "match"; agent: BusAgent }
  | { kind: "ambiguous"; candidates: BusAgent[] }
  | { kind: "none" };

/** Name before session id, and a name in the sender's workspace before the
 * same name elsewhere; more than one match in the deciding tier is reported,
 * never guessed. */
export function resolveTarget(
  agents: readonly BusAgent[],
  target: string,
  senderWorkspaceId: string | null,
): Resolution {
  const tiers: ((agent: BusAgent) => boolean)[] = [
    (agent) => agent.name === target && agent.workspaceId === senderWorkspaceId,
    (agent) => agent.name === target,
    (agent) => agent.sessionId !== null && agent.sessionId === target,
  ];
  for (const tier of tiers) {
    const matches = agents.filter(tier);
    const [first] = matches;
    if (first === undefined) continue;
    if (matches.length === 1) return { kind: "match", agent: first };
    return { kind: "ambiguous", candidates: matches };
  }
  return { kind: "none" };
}

export interface BusSender {
  name: string;
  sessionId: string | null;
}

/** The prefix names an addressable target, so the receiver can reply over
 * the bus without any other introduction. */
export function composeBusMessage(sender: BusSender, text: string): string {
  const session = sender.sessionId === null ? "" : ` (session ${sender.sessionId})`;
  return `Message sent over the agent message bus from agent named "${sender.name}"${session}: ${text}`;
}

/** Aligned columns; the workspace column appears only on the session-wide
 * view, where placement is not implied. Session ids print whole — they are
 * addresses, and a truncated address cannot be replied to. */
export function renderBusAgents(
  agents: readonly BusAgent[],
  options: { home: string; workspaceLabels: ReadonlyMap<string, string> | null },
): string {
  const header = ["name", "session", "harness", "status"];
  if (options.workspaceLabels !== null) header.push("workspace");
  header.push("cwd");
  const rows = [
    header,
    ...agents.map((agent) => {
      const row = [agent.name, agent.sessionId ?? "-", agent.harness ?? "-", agent.status];
      if (options.workspaceLabels !== null) {
        row.push(options.workspaceLabels.get(agent.workspaceId) ?? agent.workspaceId);
      }
      row.push(agent.cwd === null ? "-" : tildePath(agent.cwd, options.home));
      return row;
    }),
  ];
  const widths = header.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export async function runAgents(
  call: HerdrCall,
  env: Environ,
  home: string,
  all: boolean,
): Promise<string> {
  const [agents, tabs] = await Promise.all([listAgents(call), listTabs(call)]);
  const workspaceId = env["HERDR_WORKSPACE_ID"];
  const scopedToWorkspace = !all && workspaceId !== undefined && workspaceId !== "";
  const joined = joinBusAgents(agents, tabLabels(tabs));
  const scoped = scopedToWorkspace
    ? joined.filter((agent) => agent.workspaceId === workspaceId)
    : joined;
  if (scoped.length === 0) {
    return scopedToWorkspace
      ? "no agents in this workspace; agentsurface agents --all lists the whole session"
      : "no agents on the surface";
  }
  let workspaceLabels: Map<string, string> | null = null;
  if (!scopedToWorkspace) {
    workspaceLabels = new Map();
    for (const workspace of await listWorkspaces(call)) {
      if (workspace.label !== null) workspaceLabels.set(workspace.workspaceId, workspace.label);
    }
  }
  return renderBusAgents(scoped, { home, workspaceLabels });
}

export interface MessageOptions {
  /** Linger and retry a blocked or not-ready target until the deadline,
   * instead of failing on the first rejection. */
  waitUnblocked?: boolean;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const WAIT_POLL_MS = 2_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

export async function runMessage(
  call: HerdrCall,
  env: Environ,
  target: string,
  text: string,
  options: MessageOptions = {},
): Promise<string> {
  const paneId = env["HERDR_PANE_ID"];
  if (paneId === undefined || paneId === "") {
    throw new CliError(
      "bus_outside_pane",
      "the message bus identifies the sender by its herdr pane, and HERDR_PANE_ID is not set",
      "run from a shell inside a herdr pane",
    );
  }
  const [agents, tabs, pane] = await Promise.all([
    listAgents(call),
    listTabs(call),
    getPaneContext(call, paneId),
  ]);
  const labels = tabLabels(tabs);
  const resolution = resolveTarget(
    joinBusAgents(agents, labels),
    target,
    env["HERDR_WORKSPACE_ID"] ?? null,
  );
  if (resolution.kind === "none") {
    throw new CliError(
      "bus_target_not_found",
      `no agent is named "${target}" and no agent session has that id`,
      "agentsurface agents --all lists every live agent",
    );
  }
  if (resolution.kind === "ambiguous") {
    const candidates = resolution.candidates
      .map((candidate) => `"${candidate.name}" (${candidate.sessionId ?? candidate.paneId})`)
      .join(", ");
    throw new CliError(
      "bus_target_ambiguous",
      `"${target}" matches more than one agent: ${candidates}`,
      "address the agent by its session id",
    );
  }
  const sender: BusSender = {
    name: (pane.tabId === null ? undefined : labels.get(pane.tabId)) ?? pane.sessionValue ?? paneId,
    sessionId: pane.sessionValue,
  };
  const agent = resolution.agent;
  const waitUnblocked = options.waitUnblocked ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const composed = composeBusMessage(sender, text);
  // The delivery attempt is the probe: herdr rejects a blocked or not-ready
  // target before writing, so retrying the prompt itself leaves no gap
  // between observing the state and delivering into it.
  let delivered: { status: string };
  for (;;) {
    try {
      delivered = await promptAgent(call, agent.paneId, composed);
      break;
    } catch (error) {
      const code = error instanceof HerdrError ? error.code : null;
      if (code !== "agent_blocked" && code !== "agent_not_ready") throw error;
      if (waitUnblocked && now() < deadline) {
        await sleep(WAIT_POLL_MS);
        continue;
      }
      const waited = waitUnblocked ? ` after waiting ${Math.round(timeoutMs / 1000)}s` : "";
      if (code === "agent_blocked") {
        throw new CliError(
          "bus_target_blocked",
          `agent "${agent.name}" is blocked on interactive input${waited}; the message was not delivered`,
          waitUnblocked
            ? "a blocked agent is waiting on the operator; more waiting may not free it"
            : "the pane needs the operator before it can take a message; --wait-unblocked lingers and retries",
        );
      }
      throw new CliError(
        "bus_target_not_ready",
        `agent "${agent.name}" is not ready for input${waited}; the message was not delivered`,
      );
    }
  }
  const described = [agent.sessionId ?? agent.paneId, agent.harness ?? "unknown"];
  return `delivered to "${agent.name}" (${described.join(", ")})${deliveryNote(delivered.status)}`;
}

/** The target's status from the prompt response, translated into what it
 * means for the message: a working harness queues typed input behind the
 * running turn, so delivery is not the same as being read. */
export function deliveryNote(status: string): string {
  if (status === "working") return " while working — queued behind its current turn";
  if (status === "idle" || status === "done") return ` while ${status} — it will be read now`;
  return `; target status ${status}`;
}
