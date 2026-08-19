import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Environ } from "../paths.ts";
import { extractFirstPrompt } from "./extract.ts";
import { parseHarnessName } from "./resolve.ts";
import { excerptFrom } from "./slug.ts";
import { readStoredSlug } from "./store.ts";

/**
 * `conversation describe`: the bulk, read-only half of naming. Requests
 * arrive as JSON lines on stdin — {"harness": "claude", "path": "…"} — and
 * each answers with {"path", "slug", "excerpt"}: the stored slug when
 * naming ever paid for one (never computed here — no inference, no
 * catalog), and the first-prompt excerpt from the transcript itself. Built
 * for the resume picker, which lists dozens of sessions per refresh and
 * needs one subprocess, not one per row.
 */

export interface DescribeRequest {
  harness: string;
  path: string;
}

export interface Description {
  path: string;
  slug: string | null;
  excerpt: string | null;
}

/** A transcript's opening prompt lives at the head; cap the read so a
 * gigabyte session costs the same as a small one. */
const TRANSCRIPT_HEAD_BYTES = 512 * 1024;

export function parseDescribeRequests(stdin: string): DescribeRequest[] {
  const requests: DescribeRequest[] = [];
  for (const line of stdin.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as { harness?: unknown; path?: unknown };
    if (typeof record.harness === "string" && typeof record.path === "string") {
      requests.push({ harness: record.harness, path: record.path });
    }
  }
  return requests;
}

export function describeConversation(
  request: DescribeRequest,
  env: Environ,
  home: string,
  readHead: (path: string) => string | null = readTranscriptHead,
): Description {
  const slug = readStoredSlug(env, home, request.path);
  let excerpt: string | null = null;
  try {
    const harness = parseHarnessName(request.harness);
    const head = readHead(request.path);
    if (head !== null) {
      const extracted = extractFirstPrompt(harness, head);
      if (extracted !== null) {
        excerpt = excerptFrom(extracted.prompt, extracted.cwd ?? dirname(request.path), home);
      }
    }
  } catch {
    // An unknown harness or unreadable transcript describes as slug-only;
    // the caller has its own fallback text.
  }
  return { path: request.path, slug, excerpt };
}

function readTranscriptHead(path: string): string | null {
  try {
    const head = readFileSync(path).subarray(0, TRANSCRIPT_HEAD_BYTES).toString("utf8");
    // A cut mid-line parses as garbage; extractFirstPrompt already skips
    // unparseable lines, so the cap needs no line alignment.
    return head;
  } catch {
    return null;
  }
}

export function runDescribe(stdin: string, env: Environ, home: string): string {
  return parseDescribeRequests(stdin)
    .map((request) => `${JSON.stringify(describeConversation(request, env, home))}\n`)
    .join("");
}
