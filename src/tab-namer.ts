import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_NAMES, type HarnessName } from "./conversation/resolve.ts";
import { conversationSlug } from "./conversation/slug.ts";
import { CliError } from "./errors.ts";
import { createHerdrCall, type HerdrCall, HerdrError, invoke } from "./herdr.ts";
import { appendHookRecord } from "./hook-log.ts";
import type { Environ } from "./paths.ts";

/**
 * The plugin's event half: herdr runs `agentsurface name-tab` on every
 * `pane.agent_detected` and `pane.agent_status_changed`, and this names the
 * pane's tab after the agent's conversation — once — while keeping the
 * sidebar's `$conversation` token in step: an untitled placeholder from
 * detection, the slug once naming lands. Each invocation is one
 * bounded attempt: the pane is polled until its agent_session appears, then
 * the transcript until it holds a first prompt (exit 4 from `conversation
 * slug` underneath), with windows sized for machine lag — herdr reports the
 * session moments after the harness starts, the harness flushes the prompt
 * moments after submit. Human-scale gaps need no window at all: a harness
 * held at a startup dialog (a trust prompt, a login) or an agent idling
 * unprompted has no session or prompt to name, the attempt expires quietly,
 * and the status transition that ends the wait — the dialog accepted, the
 * first prompt typed, days later or not — fires the hook again. While
 * polling, the pane's session is re-read each round and the current ref is
 * the one slugged: the name follows the tab's live conversation, so an
 * agent that crashes and is replaced inside the window hands naming to its
 * successor instead of orphaning the tab on a dead ref.
 *
 * "Named once" is a claim file per tab in the plugin's state directory —
 * `pending <pid>` while a namer polls, `named` once a rename has landed,
 * and anything else (the legacy timestamp format, a hand-written marker)
 * terminal. The exclusive create elects one owner among concurrent
 * attempts — status transitions fire on every turn boundary, so a named
 * tab's claim is also what makes those firings cheap; a pending claim
 * whose namer is dead was orphaned (killed mid-poll, a reboot) and is
 * taken over, so a wedged claim cannot lock its tab out of naming forever.
 * The claim is released when an attempt fails or expires — only by its
 * current owner — so the next event re-arms a fresh attempt; it stays with
 * the tab's name on success. Every failure is quiet by design — a tab
 * keeping its default label is not worth a notification — but a detection
 * run appends its outcomes to the plugin's own hook log, because herdr's
 * shared ring evicts the rare detection long before anyone notices the
 * sidebar row it left blank.
 */

export interface PaneEvent {
  kind: "agent_detected" | "status_changed";
  paneId: string;
  /** Only a detection can carry a release; a status event never does. */
  released: boolean;
}

const SIDEBAR_METADATA_SOURCE = "agentsurface:sidebar";
const UNTITLED_CONVERSATION = "untitled agent";
const WORKTREE_MARKER = "";

export function parsePaneEvent(eventJson: string): PaneEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventJson);
  } catch {
    return null;
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (typeof data !== "object" || data === null) return null;
  const type = (data as { type?: unknown }).type;
  const kind =
    type === "pane_agent_detected"
      ? ("agent_detected" as const)
      : type === "pane_agent_status_changed"
        ? ("status_changed" as const)
        : null;
  if (kind === null) return null;
  const paneId = (data as { pane_id?: unknown }).pane_id;
  if (typeof paneId !== "string" || paneId === "") return null;
  return { kind, paneId, released: (data as { released?: unknown }).released === true };
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

async function reportConversationValue(
  call: HerdrCall,
  paneId: string,
  value: string,
): Promise<void> {
  await invoke(call, [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    SIDEBAR_METADATA_SOURCE,
    "--token",
    `conversation=${value}`,
  ]);
}

/** Publish the pane's `$conversation` sidebar token. An unnamed tab holds
 * the untitled placeholder until the namer lands a slug; a named tab's
 * claim republishes the tab's current label instead — pane metadata does
 * not survive a herdr restart, and the re-detection that follows a restore
 * is what puts the token back. Runs to completion before the namer starts,
 * so the namer's slug report is always the later write. */
export async function reportConversationToken(
  call: HerdrCall,
  paneId: string,
  stateDir: string,
): Promise<void> {
  const paneResult = (await invoke(call, ["pane", "get", paneId])) as {
    pane?: { tab_id?: unknown };
  } | null;
  const tabId = paneResult?.pane?.tab_id;
  if (typeof tabId !== "string" || tabId === "") {
    throw new HerdrError("herdr's pane response named no tab");
  }
  let value = UNTITLED_CONVERSATION;
  if (readClaim(claimPath(stateDir, tabId)).state === "named") {
    const tabResult = (await invoke(call, ["tab", "get", tabId])) as {
      tab?: { label?: unknown };
    } | null;
    const label = tabResult?.tab?.label;
    if (typeof label !== "string" || label === "") {
      throw new HerdrError("herdr's tab response named no label");
    }
    value = label;
  }
  await reportConversationValue(call, paneId, value);
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

function claimPath(stateDir: string, tabId: string): string {
  return join(stateDir, "named-tabs", tabId);
}

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
  /** How long to wait for herdr to learn the pane's session. Sized for
   * report lag only: a harness held at a startup dialog reports no session
   * until the dialog clears, and clearing fires a status transition that
   * re-arms a fresh attempt — no window needs to outlast a human. */
  sessionTimeoutMs?: number;
  sessionPollMs?: number;
  /** How long to wait for the conversation's first prompt. Sized for flush
   * lag after a submit; an agent idling unprompted is re-armed by the
   * status transition its first prompt causes. */
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
  const promptTimeoutMs = options.promptTimeoutMs ?? 90_000;
  const promptPollMs = options.promptPollMs ?? 1_000;

  const event = parsePaneEvent(options.eventJson);
  if (event === null) {
    console.error("name-tab: HERDR_PLUGIN_EVENT_JSON held no pane agent event");
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

  const claim = claimPath(options.stateDir, session.tabId);
  mkdirSync(join(options.stateDir, "named-tabs"), { recursive: true });
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
      try {
        await reportConversationValue(options.call, event.paneId, outcome.value);
      } catch (error) {
        // The tab is named; the next detection republishes the token from it.
        console.error(`name-tab: conversation token failed: ${(error as Error).message}`);
      }
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
  const event = parsePaneEvent(eventJson);
  // The tokens ride detection only: neither a pane's project nor its tab's
  // named state moves on a status transition, and transitions fire every
  // turn boundary. The project token publishes beside the namer, off
  // naming's critical path; the conversation token publishes before it, so
  // the namer's slug report is always the later write.
  let token: Promise<void> = Promise.resolve();
  const outcomes: Record<string, string> = {};
  const detected =
    event !== null && event.kind === "agent_detected" && !event.released ? event : null;
  if (detected !== null) {
    token = reportSidebarProjectToken(call, detected.paneId).then(
      () => {
        outcomes["project"] = "ok";
      },
      (error: Error) => {
        outcomes["project"] = error.message;
        console.error(`name-tab: sidebar project token failed: ${error.message}`);
      },
    );
    try {
      await reportConversationToken(call, detected.paneId, stateDir);
      outcomes["conversation"] = "ok";
    } catch (error) {
      outcomes["conversation"] = (error as Error).message;
      console.error(`name-tab: conversation token failed: ${(error as Error).message}`);
    }
  }
  // A detection is the run worth keeping: it is the only one that publishes
  // the sidebar's tokens, and it is rare enough that herdr's shared ring
  // evicts it long before a blank sidebar row gets reported. The record
  // lands as soon as both publishes settle rather than at the end of the
  // run: the namer then polls for up to three minutes, and a run killed
  // mid-poll — a restart, a reboot — must still leave the token evidence
  // that explains the row.
  const recorded =
    detected === null
      ? Promise.resolve()
      : token.then(() => {
          appendHookRecord(stateDir, {
            at: new Date().toISOString(),
            event: "pane.agent_detected",
            paneId: detected.paneId,
            outcomes,
          });
        });
  const code = await runTabNamer({
    call,
    stateDir,
    eventJson,
    slug: createSlugAttempt(env, home),
  });
  await token;
  await recorded;
  return code;
}
