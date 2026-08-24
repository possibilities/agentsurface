import { basename } from "node:path";
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
  type WorkspaceSummary,
} from "./herdr.ts";
import { type Environ, tildePath } from "./paths.ts";

/**
 * The message bus: agents on the surface message each other through the
 * agentsurface CLI, and herdr delivers the text as typed input (`agent
 * prompt` — paste, then Enter), so a message lands exactly like an operator
 * message and a working harness queues it. This module never writes to a
 * pane itself.
 *
 * An agent answers to three addresses. Its name is the label of the tab
 * hosting its pane — the conversation slug the tab namer set, or whatever a
 * hand rename chose. Its session id is the stable authority, the only
 * address that is neither mutable nor collidable. Its place is the
 * workspace it works in — for the common case, the worktree — and addresses
 * it only while it is the single agent there. Resolution runs name first
 * (the sender's workspace preferred, then the whole session), session id
 * second, place last, and reports a collision instead of guessing. The
 * sender identifies itself the same way, from the HERDR_PANE_ID and
 * HERDR_WORKSPACE_ID herdr exports into every managed pane shell.
 */

/** Where an agent works, as an address. Herdr labels a linked worktree's
 * workspace with the worktree's own name, so a place is the worktree name
 * for a worktree session and the project's workspace label otherwise. */
export interface Place {
  /** The spelling listings and messages print: the label without herdr's
   * `worktree-` prefix, which is how the sidebar and the operator say it. */
  name: string;
  /** Every spelling that addresses the place — the workspace label and the
   * worktree checkout's basename, each with and without the prefix — so a
   * sender may type what herdr shows or what this CLI shows. */
  aliases: string[];
  isWorktree: boolean;
}

const WORKTREE_PREFIX = /^worktree-/;

/** The place of every workspace that has one; an unlabeled workspace with
 * no worktree has no name to be addressed by and is left out. */
export function placesByWorkspace(workspaces: readonly WorkspaceSummary[]): Map<string, Place> {
  const places = new Map<string, Place>();
  for (const workspace of workspaces) {
    const checkout = workspace.worktreePath === null ? null : basename(workspace.worktreePath);
    // The label is what herdr shows and a rename owns; the checkout basename
    // is the worktree's name on disk. They agree unless someone renamed the
    // workspace, and then both still address it.
    const label = workspace.label === null || workspace.label === "" ? checkout : workspace.label;
    if (label === null || label === "") continue;
    const aliases: string[] = [];
    for (const spelling of [
      label,
      label.replace(WORKTREE_PREFIX, ""),
      ...(checkout === null ? [] : [checkout, checkout.replace(WORKTREE_PREFIX, "")]),
    ]) {
      if (spelling !== "" && !aliases.includes(spelling)) aliases.push(spelling);
    }
    places.set(workspace.workspaceId, {
      name: label.replace(WORKTREE_PREFIX, ""),
      aliases,
      isWorktree: workspace.worktreePath !== null,
    });
  }
  return places;
}

/** One live agent as the bus sees it: herdr's listing joined to its tab,
 * whose label is the agent's name here, and to its workspace's place. */
export interface BusAgent {
  name: string;
  sessionId: string | null;
  harness: string | null;
  status: string;
  workspaceId: string;
  place: Place | null;
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
  places: ReadonlyMap<string, Place> = new Map(),
): BusAgent[] {
  return agents.map((agent) => ({
    name: labels.get(agent.tabId) ?? agent.tabId,
    sessionId: agent.sessionValue,
    harness: agent.harness,
    status: agent.status,
    workspaceId: agent.workspaceId,
    place: places.get(agent.workspaceId) ?? null,
    tabId: agent.tabId,
    paneId: agent.paneId,
    cwd: agent.cwd,
  }));
}

export type Resolution =
  | { kind: "match"; agent: BusAgent }
  | { kind: "ambiguous"; candidates: BusAgent[] }
  | { kind: "none" };

/** Name before session id before place, and a name in the sender's
 * workspace before the same name elsewhere; more than one match in the
 * deciding tier is reported, never guessed — which is what makes a place
 * an address exactly while one agent works there. */
export function resolveTarget(
  agents: readonly BusAgent[],
  target: string,
  senderWorkspaceId: string | null,
): Resolution {
  const tiers: ((agent: BusAgent) => boolean)[] = [
    (agent) => agent.name === target && agent.workspaceId === senderWorkspaceId,
    (agent) => agent.name === target,
    (agent) => agent.sessionId !== null && agent.sessionId === target,
    (agent) => agent.place?.aliases.includes(target) ?? false,
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
  place: Place | null;
}

/** The prefix names every address the sender answers to, so the receiver
 * can reply without any other introduction — and can say the worktree it
 * already knows the sender by. */
export function composeBusMessage(sender: BusSender, text: string): string {
  const clauses: string[] = [];
  if (sender.sessionId !== null) clauses.push(`session ${sender.sessionId}`);
  if (sender.place !== null) {
    clauses.push(`${sender.place.isWorktree ? "worktree" : "workspace"} ${sender.place.name}`);
  }
  const where = clauses.length === 0 ? "" : ` (${clauses.join(", ")})`;
  return `Message sent over the agent message bus from agent named "${sender.name}"${where}: ${text}`;
}

/** Aligned columns; the place column appears only on the session-wide
 * view, where an agent's workspace is not the reader's own. Session ids
 * print whole — they are addresses, and a truncated address cannot be
 * replied to. */
export function renderBusAgents(
  agents: readonly BusAgent[],
  options: { home: string; places: boolean },
): string {
  const header = ["name", "session", "harness", "status"];
  if (options.places) header.push("place");
  header.push("cwd");
  const rows = [
    header,
    ...agents.map((agent) => {
      const row = [agent.name, agent.sessionId ?? "-", agent.harness ?? "-", agent.status];
      if (options.places) row.push(agent.place?.name ?? agent.workspaceId);
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
  const [agents, tabs, workspaces] = await Promise.all([
    listAgents(call),
    listTabs(call),
    listWorkspaces(call),
  ]);
  const workspaceId = env["HERDR_WORKSPACE_ID"];
  const scopedToWorkspace = !all && workspaceId !== undefined && workspaceId !== "";
  const joined = joinBusAgents(agents, tabLabels(tabs), placesByWorkspace(workspaces));
  const scoped = scopedToWorkspace
    ? joined.filter((agent) => agent.workspaceId === workspaceId)
    : joined;
  if (scoped.length === 0) {
    return scopedToWorkspace
      ? "no agents in this workspace; agentsurface agents --all lists the whole session"
      : "no agents on the surface";
  }
  return renderBusAgents(scoped, { home, places: !scopedToWorkspace });
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
  const [agents, tabs, workspaces, pane] = await Promise.all([
    listAgents(call),
    listTabs(call),
    listWorkspaces(call),
    getPaneContext(call, paneId),
  ]);
  const labels = tabLabels(tabs);
  const places = placesByWorkspace(workspaces);
  const senderWorkspaceId = env["HERDR_WORKSPACE_ID"] ?? null;
  const resolution = resolveTarget(
    joinBusAgents(agents, labels, places),
    target,
    senderWorkspaceId,
  );
  if (resolution.kind === "none") {
    throw new CliError(
      "bus_target_not_found",
      `no agent is named "${target}", has that session id, or works alone in a place by that name`,
      "agentsurface agents --all lists every live agent with its place",
    );
  }
  if (resolution.kind === "ambiguous") {
    // Every agent the target matched — for a place, everyone working there.
    // A pane id is not an address on the bus, so an agent whose harness has
    // reported no session yet is named as having none rather than offered a
    // token that cannot be resent with.
    const candidates = resolution.candidates
      .map(
        (candidate) =>
          `"${candidate.name}" (${candidate.sessionId === null ? "no session yet" : `session ${candidate.sessionId}`})`,
      )
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
    place: senderWorkspaceId === null ? null : (places.get(senderWorkspaceId) ?? null),
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
