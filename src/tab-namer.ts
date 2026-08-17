import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
 *
 * "Named once" is a claim file per tab in the plugin's state directory,
 * taken with an exclusive create before inference so concurrent detections
 * and later agents in the same tab no-op. The claim is released when
 * naming fails, so the tab gets another chance on the next agent; it stays
 * with the tab's name on success. Every failure is quiet by design — a tab
 * keeping its default label is not worth a notification, and herdr's
 * plugin log already records the run.
 */

interface AgentDetectedEvent {
  paneId: string;
  released: boolean;
}

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

export interface TabNamerOptions {
  call: HerdrCall;
  stateDir: string;
  eventJson: string;
  slug: (harness: HarnessName, ref: string) => Promise<SlugOutcome>;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for herdr to learn the pane's session. */
  sessionTimeoutMs?: number;
  sessionPollMs?: number;
  /** How long to wait for the conversation's first prompt. */
  promptTimeoutMs?: number;
  promptPollMs?: number;
}

export async function runTabNamer(options: TabNamerOptions): Promise<number> {
  const sleep = options.sleep ?? Bun.sleep;
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
  const sessionDeadline = Date.now() + sessionTimeoutMs;
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
    if (Date.now() >= sessionDeadline) return 0;
    await sleep(sessionPollMs);
  }

  const claimDir = join(options.stateDir, "named-tabs");
  const claim = join(claimDir, session.tabId);
  mkdirSync(claimDir, { recursive: true });
  try {
    writeFileSync(claim, `${new Date().toISOString()}\n`, { flag: "wx" });
  } catch {
    return 0;
  }

  const promptDeadline = Date.now() + promptTimeoutMs;
  for (;;) {
    const outcome = await options.slug(session.harness, session.ref);
    if (outcome.kind === "slug") {
      try {
        await invoke(options.call, ["tab", "rename", session.tabId, outcome.value]);
      } catch (error) {
        rmSync(claim, { force: true });
        console.error(`name-tab: tab rename failed: ${(error as Error).message}`);
        return 1;
      }
      return 0;
    }
    if (outcome.kind === "failed") {
      rmSync(claim, { force: true });
      console.error(`name-tab: ${outcome.message}`);
      return 1;
    }
    if (Date.now() >= promptDeadline) {
      rmSync(claim, { force: true });
      return 0;
    }
    await sleep(promptPollMs);
  }
}

export async function nameTabFromEnvironment(env: Environ, home: string): Promise<number> {
  const stateDir = env["HERDR_PLUGIN_STATE_DIR"];
  const eventJson = env["HERDR_PLUGIN_EVENT_JSON"];
  if (stateDir === undefined || stateDir === "" || eventJson === undefined) {
    console.error("name-tab runs as a herdr plugin event hook; herdr provides its environment");
    return 2;
  }
  return runTabNamer({
    call: createHerdrCall(env),
    stateDir,
    eventJson,
    slug: createSlugAttempt(env, home),
  });
}
