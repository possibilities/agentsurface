import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHarnessName, resolveTranscript } from "../src/conversation/resolve.ts";
import { type CliError, UsageError } from "../src/errors.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "agentsurface-resolve-"));
  roots.push(root);
  return root;
}

function write(path: string, content = "{}"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("parseHarnessName", () => {
  test("accepts the fleet harnesses and nothing else", () => {
    expect(parseHarnessName("claude")).toBe("claude");
    expect(() => parseHarnessName("gemini")).toThrow(UsageError);
  });
});

describe("resolveTranscript", () => {
  test("each store resolves its id-in-filename shape", () => {
    const h = home();
    const claude = join(h, ".claude", "projects", "-work-app", "abc-123.jsonl");
    write(claude);
    const codex = join(
      h,
      ".codex",
      "sessions",
      "2026",
      "08",
      "16",
      "rollout-2026-08-16T01-02-03-def456.jsonl",
    );
    write(codex);
    expect(resolveTranscript("claude", "abc-123", {}, h)).toBe(claude);
    expect(resolveTranscript("codex", "def456", {}, h)).toBe(codex);
  });

  test("a literal path wins; a missing one is transcript_not_found", () => {
    const h = home();
    const path = join(h, "anywhere.jsonl");
    write(path);
    expect(resolveTranscript("claude", path, {}, h)).toBe(path);
    let caught: unknown;
    try {
      resolveTranscript("claude", join(h, "gone.jsonl"), {}, h);
    } catch (error) {
      caught = error;
    }
    expect((caught as CliError).code).toBe("transcript_not_found");
  });

  test("an unknown id in an existing store is transcript_not_found", () => {
    const h = home();
    write(join(h, ".claude", "projects", "-work-app", "other.jsonl"));
    let caught: unknown;
    try {
      resolveTranscript("claude", "missing-id", {}, h);
    } catch (error) {
      caught = error;
    }
    expect((caught as CliError).code).toBe("transcript_not_found");
  });

  test("a glob-hostile ref is a usage fault", () => {
    expect(() => resolveTranscript("claude", "a*b", {}, home())).toThrow(UsageError);
  });

  test("two matches resolve to the newer transcript", () => {
    const h = home();
    const older = join(h, ".claude", "projects", "-old", "twin.jsonl");
    const newer = join(h, ".claude", "projects", "-new", "twin.jsonl");
    write(older);
    write(newer);
    utimesSync(older, new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(newer, new Date("2026-08-16"), new Date("2026-08-16"));
    expect(resolveTranscript("claude", "twin", {}, h)).toBe(newer);
  });

  test("store roots honor each harness's environment override", () => {
    const h = home();
    const custom = join(h, "custom-codex-home");
    const path = join(custom, "sessions", "2026", "08", "16", "rollout-x-zed1.jsonl");
    write(path);
    expect(resolveTranscript("codex", "zed1", { CODEX_HOME: custom }, h)).toBe(path);
  });
});
