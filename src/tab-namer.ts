import { createHash } from "node:crypto";
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
 * "Named once" is a claim file per herdr session and tab in the plugin's
 * state directory — public tab ids repeat across named herdr sessions, so
 * the session socket's stable hash scopes each claim. A completed claim also
 * carries the harness conversation's hash: a herdr server can later reuse a
 * restored numeric tab id for a new conversation, which must get a new name.
 * `pending <pid>` elects one polling namer and `named <conversation-hash>`
 * records the conversation whose rename landed. Older terminal claim formats
 * migrate only when the tab still carries a nonnumeric Name. The exclusive
 * create elects one owner among concurrent
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
const BRANCH_MARKER = "";
/** A pane outside any work tree keeps the row's two-part shape, and this
 * marker says the second half is not a branch. Plain Unicode rather than
 * the branch marker's Nerd Font glyph: nothing here needs a patched font,
 * and the multiplication sign reads small at the sidebar's weight. */
const UNTRACKED_MARKER = "×";
const UNTRACKED_BRANCH = "untracked";

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

/** Publish the label consumed by Herdr's configurable Agent sidebar. Every
 * checkout — a linked worktree or the repository's own — reads as the root
 * repository name plus the branch it has checked out, so the row names the
 * project rather than whichever directory herdr happened to label the
 * workspace with. A pane over no repository reads as the workspace label
 * badged "untracked", so the row keeps its two-part shape either way.
 *
 * The pane's own cwd is what herdr is asked about, not the workspace's
 * worktree record: that record is bound when the workspace is created and
 * does not follow the pane, so a workspace opened before its directory
 * became a repository carries none at all. One `worktree list` from the
 * pane's cwd answers both halves — its `source` names the repository, and
 * the matching entry names the branch. */
export async function reportSidebarProjectToken(call: HerdrCall, paneId: string): Promise<void> {
  const paneResult = (await invoke(call, ["pane", "get", paneId])) as {
    pane?: { workspace_id?: unknown; cwd?: unknown };
  } | null;
  const workspaceId = paneResult?.pane?.workspace_id;
  if (typeof workspaceId !== "string" || workspaceId === "") {
    throw new HerdrError("herdr's pane response named no workspace");
  }
  const paneCwd = paneResult?.pane?.cwd;

  const workspaceResult = (await invoke(call, ["workspace", "get", workspaceId])) as {
    workspace?: { label?: unknown };
  } | null;
  const label = workspaceResult?.workspace?.label;
  if (typeof label !== "string" || label === "") {
    throw new HerdrError("herdr's workspace response named no label");
  }

  let project = `${label} ${UNTRACKED_MARKER} ${UNTRACKED_BRANCH}`;
  if (typeof paneCwd === "string" && paneCwd !== "") {
    const checkout = await checkoutForCwd(call, paneCwd);
    if (checkout !== null) project = checkout;
  }

  await invoke(call, [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    SIDEBAR_METADATA_SOURCE,
    "--token",
    `project=${project}`,
  ]);
}

/** `<repo> <marker> <branch>` for the checkout holding `cwd`, or null when
 * herdr reports no work tree there — the pane sits outside a repository,
 * and the caller badges the workspace label as untracked instead. */
async function checkoutForCwd(call: HerdrCall, cwd: string): Promise<string | null> {
  let listResult: {
    source?: { repo_name?: unknown; source_checkout_path?: unknown };
    worktrees?: unknown;
  } | null;
  try {
    listResult = (await invoke(call, ["worktree", "list", "--cwd", cwd])) as typeof listResult;
  } catch (error) {
    if (error instanceof HerdrError) return null;
    throw error;
  }
  const repoName = listResult?.source?.repo_name;
  const checkoutPath = listResult?.source?.source_checkout_path;
  if (typeof repoName !== "string" || repoName === "") return null;
  const entry = Array.isArray(listResult?.worktrees)
    ? listResult.worktrees.find(
        (candidate) => (candidate as { path?: unknown }).path === checkoutPath,
      )
    : undefined;
  const branch = (entry as { branch?: unknown } | undefined)?.branch;
  const displayBranch =
    typeof branch === "string" && branch !== "" ? branch.replace(/^worktree\//, "") : "detached";
  return `${repoName} ${BRANCH_MARKER} ${displayBranch}`;
}

export async function reportConversationValue(
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
  sessionScope: string,
): Promise<void> {
  const paneResult = (await invoke(call, ["pane", "get", paneId])) as {
    pane?: {
      tab_id?: unknown;
      agent_session?: { agent?: unknown; value?: unknown } | null;
      tokens?: unknown;
    };
  } | null;
  const pane = paneResult?.pane;
  const tabId = pane?.tab_id;
  if (typeof tabId !== "string" || tabId === "") {
    throw new HerdrError("herdr's pane response named no tab");
  }
  const tokens = pane?.tokens as Record<string, unknown> | null | undefined;
  const restored = tokens?.["conversation"];
  let value = typeof restored === "string" && restored !== "" ? restored : UNTITLED_CONVERSATION;
  const session = parsePaneSession(pane);
  const namedLabel =
    session === null || session === "unsupported"
      ? await legacyLabelWithoutSession(call, stateDir, sessionScope, tabId)
      : await namedLabelForSession(call, stateDir, sessionScope, session);
  if (namedLabel !== null) value = namedLabel;
  await reportConversationValue(call, paneId, value);
}

export interface PaneSession {
  tabId: string;
  harness: HarnessName;
  /** The session reference herdr reported — an id or a literal transcript
   * path; `conversation slug` accepts both. */
  ref: string;
}

function parsePaneSession(
  pane:
    | {
        tab_id?: unknown;
        agent_session?: { agent?: unknown; value?: unknown } | null;
      }
    | undefined,
): PaneSession | "unsupported" | null {
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
  return parsePaneSession(result?.pane);
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

type Claim =
  | { state: "pending"; pid: number }
  | { state: "named"; conversation: string | null }
  | { state: "absent" };

function claimDirectory(stateDir: string, sessionScope: string): string {
  return join(stateDir, "named-tabs", sessionScope);
}

function claimPath(stateDir: string, sessionScope: string, tabId: string): string {
  return join(claimDirectory(stateDir, sessionScope), tabId);
}

function legacyClaimPath(stateDir: string, tabId: string): string {
  return join(stateDir, "named-tabs", tabId);
}

/** Herdr's socket path is stable for a named session and distinct between
 * sessions. Hashing keeps machine-identifying paths out of the state shape. */
export function sessionClaimScope(socketPath: string): string {
  return createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
}

function conversationClaim(session: PaneSession): string {
  return createHash("sha256")
    .update(session.harness)
    .update("\0")
    .update(session.ref)
    .digest("hex");
}

function namedClaimContent(session: PaneSession): string {
  return `named ${conversationClaim(session)}\n`;
}

async function tabLabel(call: HerdrCall, tabId: string): Promise<string> {
  const tabResult = (await invoke(call, ["tab", "get", tabId])) as {
    tab?: { label?: unknown };
  } | null;
  const label = tabResult?.tab?.label;
  if (typeof label !== "string" || label === "") {
    throw new HerdrError("herdr's tab response named no label");
  }
  return label;
}

function isDefaultTabLabel(label: string): boolean {
  return /^\d+$/.test(label);
}

/** A claim with no conversation identity predates this claim format. Bind it
 * to the live conversation only when the tab itself proves a name landed.
 * Numeric labels are herdr's unnamed fallback and can belong to a later
 * server incarnation that reused the public tab id. */
async function namedLabelForSession(
  call: HerdrCall,
  stateDir: string,
  sessionScope: string,
  session: PaneSession,
): Promise<string | null> {
  const path = claimPath(stateDir, sessionScope, session.tabId);
  const expected = conversationClaim(session);
  const scoped = readClaim(path);
  if (scoped.state === "pending") return null;
  if (scoped.state === "named" && scoped.conversation !== null) {
    if (scoped.conversation !== expected) return null;
    const label = await tabLabel(call, session.tabId);
    return isDefaultTabLabel(label) ? null : label;
  }

  const hasLegacyScoped = scoped.state === "named";
  const hasLegacyUnscoped =
    scoped.state === "absent" &&
    readClaim(legacyClaimPath(stateDir, session.tabId)).state === "named";
  if (!hasLegacyScoped && !hasLegacyUnscoped) return null;

  const label = await tabLabel(call, session.tabId);
  if (isDefaultTabLabel(label)) return null;
  if (hasLegacyScoped) {
    if (readClaim(path).state === "named") writeFileSync(path, namedClaimContent(session));
  } else {
    try {
      writeFileSync(path, namedClaimContent(session), { flag: "wx" });
    } catch {
      // A concurrent hook owns the scoped claim now; its state governs.
    }
  }
  const migrated = readClaim(path);
  return migrated.state === "named" && migrated.conversation === expected ? label : null;
}

/** Detection can precede herdr's agent-session report by a few milliseconds.
 * During that gap preserve only a visible nonnumeric label backed by any
 * completed claim; the namer will bind a legacy claim after the session is
 * reportable. */
async function legacyLabelWithoutSession(
  call: HerdrCall,
  stateDir: string,
  sessionScope: string,
  tabId: string,
): Promise<string | null> {
  const scoped = readClaim(claimPath(stateDir, sessionScope, tabId));
  const legacy = readClaim(legacyClaimPath(stateDir, tabId));
  if (scoped.state !== "named" && legacy.state !== "named") return null;
  const label = await tabLabel(call, tabId);
  return isDefaultTabLabel(label) ? null : label;
}

function readClaim(path: string): Claim {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { state: "absent" };
  }
  const pending = /^pending (\d+)$/.exec(content.trim());
  if (pending !== null) return { state: "pending", pid: Number(pending[1]) };
  const named = /^named ([0-9a-f]{64})$/.exec(content.trim());
  return { state: "named", conversation: named?.[1] ?? null };
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
  /** Stable identity of the herdr session. Public tab ids are unique only
   * inside one session and therefore cannot key machine-global claims. */
  sessionScope: string;
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

  const claim = claimPath(options.stateDir, options.sessionScope, session.tabId);
  mkdirSync(claimDirectory(options.stateDir, options.sessionScope), { recursive: true });
  const existingLabel = await namedLabelForSession(
    options.call,
    options.stateDir,
    options.sessionScope,
    session,
  );
  if (existingLabel !== null) {
    try {
      await reportConversationValue(options.call, event.paneId, existingLabel);
    } catch (error) {
      console.error(`name-tab: conversation token failed: ${(error as Error).message}`);
    }
    return 0;
  }
  // A completed claim for another conversation, or a legacy claim backed by
  // herdr's numeric fallback, belongs to an earlier occupant/incarnation.
  if (readClaim(claim).state === "named") rmSync(claim, { force: true });
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
      writeFileSync(claim, namedClaimContent(session));
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

/** What herdr reports holding for the pane once the publishes settle. Read
 * back rather than assumed: a publish that returned cleanly and a token the
 * sidebar can actually draw are different claims, and only the second one
 * explains a blank row. Never throws — evidence is not worth a failed run. */
async function heldTokens(
  call: HerdrCall,
  paneId: string,
): Promise<Record<string, string> | string | null> {
  try {
    const result = (await invoke(call, ["pane", "get", paneId])) as {
      pane?: { tokens?: unknown };
    } | null;
    const tokens = result?.pane?.tokens;
    if (tokens === undefined || tokens === null) return null;
    return tokens as Record<string, string>;
  } catch (error) {
    return (error as Error).message;
  }
}

export async function nameTabFromEnvironment(env: Environ, home: string): Promise<number> {
  const stateDir = env["HERDR_PLUGIN_STATE_DIR"];
  const eventJson = env["HERDR_PLUGIN_EVENT_JSON"];
  const socketPath = env["HERDR_SOCKET_PATH"];
  if (
    stateDir === undefined ||
    stateDir === "" ||
    eventJson === undefined ||
    socketPath === undefined ||
    socketPath === ""
  ) {
    console.error("name-tab runs as a herdr plugin event hook; herdr provides its environment");
    return 2;
  }
  const sessionScope = sessionClaimScope(socketPath);
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
  // Only a detection is logged, and it is logged before any work: status
  // transitions fire on every turn boundary and would evict the run worth
  // reading, while a detection with no start record at all did not run —
  // which is a different bug from one whose publishes failed.
  if (detected !== null) {
    appendHookRecord(stateDir, {
      at: new Date().toISOString(),
      pid: process.pid,
      phase: "start",
      event: "pane.agent_detected",
      paneId: detected.paneId,
      eventJson,
    });
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
      await reportConversationToken(call, detected.paneId, stateDir, sessionScope);
      outcomes["conversation"] = "ok";
    } catch (error) {
      outcomes["conversation"] = (error as Error).message;
      console.error(`name-tab: conversation token failed: ${(error as Error).message}`);
    }
  }
  // The outcome record lands as soon as both publishes settle rather than at
  // the end of the run: the namer then polls for minutes, and a run killed
  // mid-poll — a restart, a reboot — must still leave the evidence that
  // explains the row. `held` is what herdr reports holding right after, so a
  // row that goes blank later is provably herdr dropping a write rather than
  // this hook never landing one.
  const recorded =
    detected === null
      ? Promise.resolve()
      : token.then(async () => {
          appendHookRecord(stateDir, {
            at: new Date().toISOString(),
            pid: process.pid,
            phase: "tokens",
            event: "pane.agent_detected",
            paneId: detected.paneId,
            outcomes,
            held: await heldTokens(call, detected.paneId),
          });
        });
  const code = await runTabNamer({
    call,
    stateDir,
    sessionScope,
    eventJson,
    slug: createSlugAttempt(env, home),
  });
  await token;
  await recorded;
  return code;
}
