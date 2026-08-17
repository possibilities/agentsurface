import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  composeInference,
  generateSlug,
  INFERENCE_CWD,
  type InferenceOutcome,
} from "../src/conversation/infer.ts";
import { excerptFrom } from "../src/conversation/slug.ts";
import type { CliError } from "../src/errors.ts";

describe("composeInference", () => {
  test("each harness gets its native non-interactive shape behind one --x-level", () => {
    const claude = composeInference("claude", "haiku:low", "the instruction", "t1");
    expect(claude.argv).toEqual([
      "agentlaunch",
      "--x-harness",
      "claude",
      "--x-level",
      "haiku:low",
      "-p",
      "the instruction",
    ]);
    expect(claude.lastMessageFile).toBeNull();

    const codex = composeInference("codex", "gpt-5.4-mini:low", "the instruction", "t2");
    expect(codex.argv.slice(0, 6)).toEqual([
      "agentlaunch",
      "--x-harness",
      "codex",
      "--x-level",
      "gpt-5.4-mini:low",
      "exec",
    ]);
    expect(codex.argv).toContain("--output-last-message");
    expect(codex.lastMessageFile).toContain("t2");

    const pi = composeInference("pi", "gpt-5.4-mini:low", "the instruction", "t3");
    expect(pi.argv).toEqual([
      "agentlaunch",
      "--x-harness",
      "pi",
      "--x-level",
      "gpt-5.4-mini:low",
      "--mode",
      "text",
      "--no-session",
      "-p",
      "the instruction",
    ]);
  });
});

describe("generateSlug", () => {
  const ok = (stdout: string): InferenceOutcome => ({ stdout, stderr: "", exitCode: 0 });

  test("a clean answer becomes the slug", async () => {
    const invocation = composeInference("claude", "haiku:low", "x", "t");
    const slug = await generateSlug(invocation, async () => ok("Conversation Slug Subcommand\n"));
    expect(slug).toBe("conversation-slug-subcommand");
  });

  test("a failed attempt retries once, then reports the harness's failure", async () => {
    const invocation = composeInference("claude", "haiku:low", "x", "t");
    const calls: string[][] = [];
    const slug = await generateSlug(invocation, async (argv) => {
      calls.push(argv);
      return calls.length === 1 ? { stdout: "", stderr: "boom", exitCode: 1 } : ok("Second Try");
    });
    expect(slug).toBe("second-try");
    expect(calls).toHaveLength(2);

    let caught: unknown;
    try {
      await generateSlug(invocation, async () => ({ stdout: "", stderr: "down", exitCode: 1 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as CliError).code).toBe("slug_inference_failed");
    expect((caught as CliError).message).toContain("down");
  });

  test("codex answers arrive through the last-message file", async () => {
    const invocation = composeInference("codex", "gpt-5.4-mini:low", "x", crypto.randomUUID());
    mkdirSync(INFERENCE_CWD, { recursive: true });
    writeFileSync(invocation.lastMessageFile as string, "Rate Limiter Design\n");
    const slug = await generateSlug(invocation, async () => ok("event noise"));
    expect(slug).toBe("rate-limiter-design");
  });
});

describe("excerptFrom", () => {
  test("slash-strips, expands mentions against the transcript cwd, truncates", () => {
    const reads: string[] = [];
    const excerpt = excerptFrom(
      "/collab review @notes.md --fast",
      "/work/app",
      "/home/me",
      (path) => {
        reads.push(path);
        return path === "/work/app/notes.md" ? "the notes body" : null;
      },
    );
    expect(excerpt).toBe("review the notes body");
    expect(reads).toEqual(["/work/app/notes.md"]);
  });

  test("tilde mentions resolve against home", () => {
    const excerpt = excerptFrom("see @~/doc.md", null, "/home/me", (path) =>
      path === "/home/me/doc.md" ? "doc body" : null,
    );
    expect(excerpt).toBe("see doc body");
  });
});
