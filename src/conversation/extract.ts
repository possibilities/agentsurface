import { isCommandOnly } from "./prompt.ts";
import type { HarnessName } from "./resolve.ts";

/**
 * Per-harness extraction of the first user-submitted prompt from a native
 * transcript. Each store is JSONL with its own line grammar; these parsers
 * read only what the slug needs — the first thing the operator typed, and
 * the cwd the session ran in (for resolving relative @-mentions). A
 * transcript with no user prompt yet extracts to null, which the CLI
 * reports as its own exit code so a caller can poll.
 *
 * Shapes verified against live stores 2026-08-16 (claude 2.x and codex-cli
 * 0.147); fixtures in test/conversation pin them.
 */

export interface ExtractedPrompt {
  prompt: string;
  /** The session's recorded working directory, when the store records one. */
  cwd: string | null;
}

export function extractFirstPrompt(harness: HarnessName, jsonl: string): ExtractedPrompt | null {
  const lines: unknown[] = [];
  for (const raw of jsonl.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      // A live transcript's last line may still be mid-write; skip it.
    }
  }
  const candidates = harness === "claude" ? extractClaude(lines) : extractCodex(lines);
  // The opening prompt is the first substantive one: housekeeping commands
  // (a /model toggle, a bare /reload-plugins) name no work, so they only
  // stand when the conversation never says anything else.
  return candidates.find((candidate) => !isCommandOnly(candidate.prompt)) ?? candidates[0] ?? null;
}

type Line = Record<string, unknown>;

function asLine(value: unknown): Line | null {
  return typeof value === "object" && value !== null ? (value as Line) : null;
}

/** Join a Claude content value: a plain string, or blocks whose text
 * entries carry the typed prompt (tool results and images are not prose). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    const entry = asLine(block);
    if (entry?.["type"] === "text" && typeof entry["text"] === "string") {
      texts.push(entry["text"]);
    }
  }
  return texts.join("\n");
}

/** Claude Code: `type:"user"` lines are turns; meta lines (caveats),
 * sidechains (subagent transcripts), and local-command output wrappers —
 * user-role but not typed by anyone — are not prompts. */
function extractClaude(lines: unknown[]): ExtractedPrompt[] {
  const candidates: ExtractedPrompt[] = [];
  let cwd: string | null = null;
  for (const value of lines) {
    const line = asLine(value);
    if (line === null) continue;
    if (cwd === null && typeof line["cwd"] === "string") cwd = line["cwd"];
    if (line["type"] !== "user" || line["isMeta"] === true || line["isSidechain"] === true) {
      continue;
    }
    const message = asLine(line["message"]);
    if (message?.["role"] !== "user") continue;
    const text = contentText(message["content"]).trim();
    if (text === "" || /^<local-command-std(out|err)>/.test(text)) continue;
    candidates.push({ prompt: text, cwd: typeof line["cwd"] === "string" ? line["cwd"] : cwd });
  }
  return candidates;
}

/** Codex machine-authored user items: instruction and context injections
 * the operator never typed. (`user_message` events would be cleaner, but
 * codex-cli 0.148+ rollouts no longer emit them.) */
const CODEX_INJECTED = [
  /^<user_instructions>/,
  /^<environment_context>/,
  /^# AGENTS\.md instructions/,
];

/** Codex: typed prompts are user-role `response_item` messages — the one
 * shape every rollout era records them in — minus the injections. */
function extractCodex(lines: unknown[]): ExtractedPrompt[] {
  const candidates: ExtractedPrompt[] = [];
  let cwd: string | null = null;
  for (const value of lines) {
    const line = asLine(value);
    if (line === null) continue;
    const payload = asLine(line["payload"]);
    if (cwd === null && typeof payload?.["cwd"] === "string") cwd = payload["cwd"];
    if (line["type"] !== "response_item" || payload?.["type"] !== "message") continue;
    if (payload["role"] !== "user") continue;
    const texts: string[] = [];
    if (Array.isArray(payload["content"])) {
      for (const block of payload["content"]) {
        const entry = asLine(block);
        if (entry?.["type"] === "input_text" && typeof entry["text"] === "string") {
          texts.push(entry["text"]);
        }
      }
    }
    const text = texts.join("\n").trim();
    if (text === "" || CODEX_INJECTED.some((pattern) => pattern.test(text))) continue;
    candidates.push({ prompt: text, cwd });
  }
  return candidates;
}
