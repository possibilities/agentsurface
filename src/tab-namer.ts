import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_NAMES, type HarnessName } from "./conversation/resolve.ts";
import { conversationSlug } from "./conversation/slug.ts";
import { CliError } from "./errors.ts";
import { createHerdrCall, type HerdrCall, HerdrError, invoke } from "./herdr.ts";
import type { Environ } from "./paths.ts";

/**
 * The plugin's event half: herdr runs `agentsurface name-tab` on every
 * `pane.agent_detected`, and this names the pane's tab after the agent's
 * conversation — once. Herdr's event does not yet know the session, so the
 * pane is polled until its agent_session appears (herdr's integrations
 * report it moments after detection), then the transcript is polled until
 * it holds a first prompt (exit 4 from `conversation slug` underneath).
 * While polling, the pane's session is re-read each round and the current
 * ref is the one slugged: the name follows the tab's live conversation, so
 * an agent that crashes and is replaced inside the window hands naming to
 * its successor instead of orphaning the tab on a dead ref.
 *
 * "Named once" is a claim file per tab in the plugin's state directory —
 * `pending <pid>` while a namer polls, `named` once a rename has landed,
 * and anything else (the legacy timestamp format, a hand-written marker)
 * terminal. The exclusive create makes concurrent detections and later
 * agents in the same tab no-op; a pending claim whose namer is dead was
 * orphaned (killed mid-poll, a reboot) and is taken over, so a wedged
 * claim cannot lock its tab out of naming forever. The claim is released
 * when naming fails — only by its current owner — so the tab gets another
 * chance on the next agent; it stays with the tab's name on success. Every
 * failure is quiet by design — a tab keeping its default label is not
 * worth a notification, and herdr's plugin log already records the run.
 */

interface AgentDetectedEvent {
  paneId: string;
  released: boolean;
}

const SIDEBAR_METADATA_SOURCE = "agentsurface:sidebar";
const WORKTREE_MARKER = "";

export function parseAgentDetected(eventJson: string): AgentDetectedEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventJson);
  } catch {
    return null;
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (typeof data !== "object" || data === null) return null;
  const paneId = (data as { pane_id?: unknown }).pane_id;
  if (typeof paneId !== "string" || paneId === "") return null;
  return { paneId, released: (data as { released?: unknown }).released === true };
}

/** Publish the label consumed by Herdr's configurable Agent sidebar. Linked
 * worktrees use the root repository name plus their branch; ordinary
 * workspaces preserve Herdr's current workspace label. */
export async function reportSidebarProjectToken(call: HerdrCall, paneId: string): Promise<void> {
  const paneResult = (await invoke(call, ["pane", "get", paneId])) as {
    pane?: { workspace_id?: unknown };
  } | null;
  const workspaceId = paneResult?.pane?.workspace_id;
  if (typeof workspaceId !== "string" || workspaceId === "") {
    throw new HerdrError("herdr's pane response named no workspace");
  }

  const workspaceResult = (await invoke(call, ["workspace", "get", workspaceId])) as {
    workspace?: {
      label?: unknown;
      worktree?: {
        checkout_path?: unknown;
        is_linked_worktree?: unknown;
        repo_name?: unknown;
        repo_root?: unknown;
      } | null;
    };
  } | null;
  const workspace = workspaceResult?.workspace;
  const label = workspace?.label;
  if (typeof label !== "string" || label === "") {
    throw new HerdrError("herdr's workspace response named no label");
  }
  const worktree = workspace?.worktree;
  let project = label;
  if (
    worktree?.is_linked_worktree === true &&
    typeof worktree.repo_name === "string" &&
    typeof worktree.repo_root === "string" &&
    typeof worktree.checkout_path === "string"
  ) {
    project = worktree.repo_name;
    const listResult = (await invoke(call, ["worktree", "list", "--cwd", worktree.repo_root])) as {
      worktrees?: unknown;
    } | null;
    const entry = Array.isArray(listResult?.worktrees)
      ? listResult.worktrees.find(
          (candidate) => (candidate as { path?: unknown }).path === worktree.checkout_path,
        )
      : undefined;
    const branch = (entry as { branch?: unknown } | undefined)?.branch;
    const displayBranch =
      typeof branch === "string" && branch !== "" ? branch.replace(/^worktree\//, "") : "detached";
    project = `${project} ${WORKTREE_MARKER} ${displayBranch}`;
  }

  const reportArgs = [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    SIDEBAR_METADATA_SOURCE,
    "--token",
    `project=${project}`,
  ];
  reportArgs.push("--clear-token", "worktree");
  await invoke(call, reportArgs);
}

export interface PaneSession {
  tabId: string;
  harness: HarnessName;
  /** The session reference herdr reported — an id or a literal transcript
   * path; `conversation slug` accepts both. */
  ref: string;
}

/** One pane read: null while the pane has no reportable agent session. A
 * session for an agent outside the slug's harnesses is a permanent no. */
async function paneSession(
  call: HerdrCall,
  paneId: string,
): Promise<PaneSession | "unsupported" | null> {
  const result = (await invoke(call, ["pane", "get", paneId])) as {
    pane?: {
      tab_id?: unknown;
      agent_session?: { agent?: unknown; value?: unknown } | null;
    };
  } | null;
  const pane = result?.pane;
  const session = pane?.agent_session;
  if (session === undefined || session === null) return null;
  const agent = session.agent;
  const ref = session.value;
  const tabId = pane?.tab_id;
  if (typeof agent !== "string" || typeof ref !== "string" || typeof tabId !== "string") {
    return null;
  }
  if (!(HARNESS_NAMES as readonly string[]).includes(agent)) return "unsupported";
  return { tabId, harness: agent as HarnessName, ref };
}

export type SlugOutcome =
  | { kind: "slug"; value: string }
  | { kind: "pending" }
  | { kind: "failed"; message: string };

export function createSlugAttempt(
  env: Environ,
  home: string,
): (harness: HarnessName, ref: string) => Promise<SlugOutcome> {
  return async (harness, ref) => {
    try {
      return { kind: "slug", value: await conversationSlug([harness, ref], env, home) };
    } catch (error) {
      if (error instanceof CliError) {
        // Not-found also polls: herdr can detect the agent before the
        // harness has written its transcript to the store.
        if (error.code === "transcript_no_prompt" || error.code === "transcript_not_found") {
          return { kind: "pending" };
        }
        return { kind: "failed", message: error.message };
      }
      return { kind: "failed", message: (error as Error).message ?? String(error) };
    }
  };
}

type Claim = { state: "pending"; pid: number } | { state: "named" } | { state: "absent" };

function readClaim(path: string): Claim {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { state: "absent" };
  }
  const pending = /^pending (\d+)$/.exec(content.trim());
  if (pending === null) return { state: "named" };
  return { state: "pending", pid: Number(pending[1]) };
}

function acquireClaim(path: string, pid: number, pidAlive: (pid: number) => boolean): boolean {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(path, `pending ${pid}\n`, { flag: "wx" });
      return true;
    } catch {
      // Held or raced; the claim's state decides below.
    }
    const claim = readClaim(path);
    if (claim.state === "named") return false;
    if (claim.state === "pending" && pidAlive(claim.pid)) return false;
    // Orphaned, or gone between create and read: clear and retry the
    // exclusive create, so concurrent takeovers still elect one owner.
    rmSync(path, { force: true });
  }
  return false;
}

/** Only the claim's current owner removes it: a taken-over namer's failure
 * path must not release its successor's claim. */
function releaseClaim(path: string, pid: number): void {
  const claim = readClaim(path);
  if (claim.state === "pending" && claim.pid === pid) rmSync(path, { force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a live process we may not signal; anything else is absence.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface TabNamerOptions {
  call: HerdrCall;
  stateDir: string;
  eventJson: string;
  slug: (harness: HarnessName, ref: string) => Promise<SlugOutcome>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The identity written into a pending claim; a claim whose owner is no
   * longer alive may be taken over. */
  pid?: number;
  pidAlive?: (pid: number) => boolean;
  /** How long to wait for herdr to learn the pane's session. */
  sessionTimeoutMs?: number;
  sessionPollMs?: number;
  /** How long to wait for the conversation's first prompt. */
  promptTimeoutMs?: number;
  promptPollMs?: number;
}

export async function runTabNamer(options: TabNamerOptions): Promise<number> {
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const pidAlive = options.pidAlive ?? processAlive;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? 90_000;
  const sessionPollMs = options.sessionPollMs ?? 1_000;
  const promptTimeoutMs = options.promptTimeoutMs ?? 600_000;
  const promptPollMs = options.promptPollMs ?? 3_000;

  const event = parseAgentDetected(options.eventJson);
  if (event === null) {
    console.error("name-tab: HERDR_PLUGIN_EVENT_JSON held no pane_agent_detected event");
    return 2;
  }
  if (event.released) return 0;

  let session: PaneSession | null = null;
  const sessionDeadline = now() + sessionTimeoutMs;
  for (;;) {
    let read: PaneSession | "unsupported" | null;
    try {
      read = await paneSession(options.call, event.paneId);
    } catch (error) {
      if (error instanceof HerdrError) return 0;
      throw error;
    }
    if (read === "unsupported") return 0;
    if (read !== null) {
      session = read;
      break;
    }
    if (now() >= sessionDeadline) return 0;
    await sleep(sessionPollMs);
  }

  const claimDir = join(options.stateDir, "named-tabs");
  const claim = join(claimDir, session.tabId);
  mkdirSync(claimDir, { recursive: true });
  if (!acquireClaim(claim, pid, pidAlive)) return 0;

  let promptDeadline = now() + promptTimeoutMs;
  for (;;) {
    const outcome = await options.slug(session.harness, session.ref);
    if (outcome.kind === "slug") {
      try {
        await invoke(options.call, ["tab", "rename", session.tabId, outcome.value]);
      } catch (error) {
        releaseClaim(claim, pid);
        console.error(`name-tab: tab rename failed: ${(error as Error).message}`);
        return 1;
      }
      writeFileSync(claim, "named\n");
      return 0;
    }
    if (outcome.kind === "failed") {
      releaseClaim(claim, pid);
      console.error(`name-tab: ${outcome.message}`);
      return 1;
    }
    if (now() >= promptDeadline) {
      releaseClaim(claim, pid);
      return 0;
    }
    await sleep(promptPollMs);

    let read: PaneSession | "unsupported" | null;
    try {
      read = await paneSession(options.call, event.paneId);
    } catch (error) {
      if (!(error instanceof HerdrError)) throw error;
      releaseClaim(claim, pid);
      return 0;
    }
    if (read === "unsupported" || (read !== null && read.tabId !== session.tabId)) {
      // The occupant cannot be slugged, or the pane left the claimed tab;
      // free the tab for a future agent's fresh chance.
      releaseClaim(claim, pid);
      return 0;
    }
    if (read !== null && (read.harness !== session.harness || read.ref !== session.ref)) {
      // A replaced agent is the tab's conversation now; a new conversation
      // gets a fresh prompt window.
      session = read;
      promptDeadline = now() + promptTimeoutMs;
    }
    // A null read keeps the last ref: a dead agent's successor shows up on
    // a later poll.
  }
}

export async function nameTabFromEnvironment(env: Environ, home: string): Promise<number> {
  const stateDir = env["HERDR_PLUGIN_STATE_DIR"];
  const eventJson = env["HERDR_PLUGIN_EVENT_JSON"];
  if (stateDir === undefined || stateDir === "" || eventJson === undefined) {
    console.error("name-tab runs as a herdr plugin event hook; herdr provides its environment");
    return 2;
  }
  const call = createHerdrCall(env);
  const event = parseAgentDetected(eventJson);
  if (event !== null && !event.released) {
    try {
      await reportSidebarProjectToken(call, event.paneId);
    } catch (error) {
      console.error(`name-tab: sidebar project token failed: ${(error as Error).message}`);
    }
  }
  return runTabNamer({
    call,
    stateDir,
    eventJson,
    slug: createSlugAttempt(env, home),
  });
}
