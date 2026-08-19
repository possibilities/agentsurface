import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeConversation,
  parseDescribeRequests,
  runDescribe,
} from "../src/conversation/describe.ts";
import { readStoredSlug, storeSlug } from "../src/conversation/store.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function scratch(): string {
  const temp = mkdtempSync(join(tmpdir(), "agentsurface-describe-"));
  temps.push(temp);
  return temp;
}

const jsonl = (lines: unknown[]): string => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

function claudeTranscript(prompt: string): string {
  return jsonl([
    {
      type: "user",
      cwd: "/work/app",
      message: { role: "user", content: prompt },
    },
  ]);
}

describe("the slug store", () => {
  test("round-trips by transcript basename, id-or-path agnostic", () => {
    const root = scratch();
    const env = { XDG_STATE_HOME: join(root, "state") };
    storeSlug(env, root, "/store/projects/x/abc-123.jsonl", "fix the queue");
    expect(readStoredSlug(env, root, "/elsewhere/abc-123.jsonl")).toBe("fix the queue");
    expect(readStoredSlug(env, root, "/store/other.jsonl")).toBeNull();
  });

  test("codex compressed and plain spellings share a key", () => {
    const root = scratch();
    const env = { XDG_STATE_HOME: join(root, "state") };
    storeSlug(env, root, "/s/rollout-2026-01-01T00-00-00-abc.jsonl.zst", "codex work");
    expect(readStoredSlug(env, root, "/s/rollout-2026-01-01T00-00-00-abc.jsonl")).toBe(
      "codex work",
    );
  });
});

describe("parseDescribeRequests", () => {
  test("reads JSON lines, skipping blanks and garbage", () => {
    const requests = parseDescribeRequests(
      `${JSON.stringify({ harness: "claude", path: "/a.jsonl" })}\n\nnot json\n${JSON.stringify({ harness: "codex" })}\n`,
    );
    expect(requests).toEqual([{ harness: "claude", path: "/a.jsonl" }]);
  });
});

describe("describeConversation", () => {
  test("answers with the stored slug and the first-prompt excerpt", () => {
    const root = scratch();
    const env = { XDG_STATE_HOME: join(root, "state") };
    const transcript = join(root, "abc.jsonl");
    writeFileSync(transcript, claudeTranscript("make the picker readable"));
    storeSlug(env, root, transcript, "picker readability");
    const description = describeConversation({ harness: "claude", path: transcript }, env, root);
    expect(description).toEqual({
      path: transcript,
      slug: "picker readability",
      excerpt: "make the picker readable",
    });
  });

  test("strips a slash-command wrapper from the excerpt", () => {
    const root = scratch();
    const env = { XDG_STATE_HOME: join(root, "state") };
    const transcript = join(root, "cmd.jsonl");
    writeFileSync(
      transcript,
      claudeTranscript(
        "<command-message>collab</command-message>\n<command-name>/collab</command-name>\n<command-args>fix the queue</command-args>",
      ),
    );
    const description = describeConversation({ harness: "claude", path: transcript }, env, root);
    expect(description.excerpt).not.toContain("<command-message>");
    expect(description.excerpt).toContain("fix the queue");
  });

  test("an unknown harness or missing transcript is slug-only, not an error", () => {
    const root = scratch();
    const env = { XDG_STATE_HOME: join(root, "state") };
    expect(describeConversation({ harness: "cursor", path: "/nope.jsonl" }, env, root)).toEqual({
      path: "/nope.jsonl",
      slug: null,
      excerpt: null,
    });
    expect(describeConversation({ harness: "claude", path: "/gone.jsonl" }, env, root)).toEqual({
      path: "/gone.jsonl",
      slug: null,
      excerpt: null,
    });
  });
});

describe("runDescribe", () => {
  test("one answer line per request line", () => {
    const root = scratch();
    const env = { XDG_STATE_HOME: join(root, "state") };
    const transcript = join(root, "abc.jsonl");
    writeFileSync(transcript, claudeTranscript("hello there"));
    const out = runDescribe(
      `${JSON.stringify({ harness: "claude", path: transcript })}\n`,
      env,
      root,
    );
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      path: transcript,
      slug: null,
      excerpt: "hello there",
    });
  });
});
