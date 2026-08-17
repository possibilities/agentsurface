import { describe, expect, test } from "bun:test";
import {
  buildInstruction,
  centerTruncate,
  EXCERPT_BUDGET,
  expandFileMentions,
  SLUG_MAX_LENGTH,
  slugify,
  stripSlashCommand,
  stripUnsafeText,
} from "../src/conversation/prompt.ts";

describe("stripSlashCommand", () => {
  test("a plain prompt passes through trimmed", () => {
    expect(stripSlashCommand("  fix the failing tests  ")).toBe("fix the failing tests");
  });

  test("a leading slash command and its --flags are dropped", () => {
    expect(stripSlashCommand("/collab build a slug subcommand --fast --level=high now")).toBe(
      "build a slug subcommand now",
    );
  });

  test("a slash command given nothing keeps its own name", () => {
    expect(stripSlashCommand("/reload-plugins")).toBe("reload-plugins");
    expect(stripSlashCommand("/compact --force")).toBe("compact");
  });

  test("claude's command wrapper yields the args, or the name when empty", () => {
    const wrapped =
      "<command-name>/collab</command-name>\n<command-message>collab</command-message>\n" +
      "<command-args>make a slug for --every conversation</command-args>";
    expect(stripSlashCommand(wrapped)).toBe("make a slug for conversation");
    const empty = "<command-name>/reload-plugins</command-name>\n<command-args></command-args>";
    expect(stripSlashCommand(empty)).toBe("reload-plugins");
  });

  test("a mid-prompt slash or double dash is untouched", () => {
    expect(stripSlashCommand("compare a/b and keep --force semantics")).toBe(
      "compare a/b and keep --force semantics",
    );
  });
});

describe("expandFileMentions", () => {
  test("a readable mention is replaced by its content", () => {
    const out = expandFileMentions("summarize @notes.md please", (path) =>
      path === "notes.md" ? "the notes body" : null,
    );
    expect(out).toBe("summarize the notes body please");
  });

  test("an unreadable mention stays as typed", () => {
    expect(expandFileMentions("see @gone.md", () => null)).toBe("see @gone.md");
  });

  test("an email-like token is not a mention", () => {
    expect(expandFileMentions("mail me@example.com", () => "boom")).toBe("mail me@example.com");
  });
});

describe("centerTruncate", () => {
  test("short text is untouched", () => {
    expect(centerTruncate("short")).toBe("short");
  });

  test("long text keeps head and tail around a mark, inside budget", () => {
    const long = `${"a".repeat(2000)}MIDDLE${"z".repeat(2000)}`;
    const out = centerTruncate(long);
    expect(out.length).toBeLessThanOrEqual(EXCERPT_BUDGET);
    expect(out.startsWith("aaa")).toBe(true);
    expect(out.endsWith("zzz")).toBe(true);
    expect(out).toContain("…");
    expect(out).not.toContain("MIDDLE");
  });
});

describe("buildInstruction", () => {
  test("carries the keeper-derived contract and the excerpt", () => {
    const instruction = buildInstruction("the excerpt");
    expect(instruction).toContain("3-6 words");
    expect(instruction).toContain("ONLY");
    expect(instruction).toContain("<prompt>\nthe excerpt\n</prompt>");
  });
});

describe("stripUnsafeText and slugify", () => {
  test("control and bidi characters never reach the slug", () => {
    expect(stripUnsafeText("a\u0000b\u202ec")).toBe("a bc");
    expect(slugify(stripUnsafeText("Fix the\u202e tests"))).toBe("fix-the-tests");
  });

  test("keeper's normalization: NFKD, ASCII gate, hyphen runs, cap", () => {
    expect(slugify("Fix Café Tests!")).toBe("fix-cafe-tests");
    expect(slugify("  --  ")).toBeNull();
    expect(slugify("日本語")).toBeNull();
    const long = slugify(`${"word ".repeat(30)}end`);
    expect(long).not.toBeNull();
    expect((long as string).length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect((long as string).endsWith("-")).toBe(false);
  });
});
