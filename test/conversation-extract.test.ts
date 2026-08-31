import { describe, expect, test } from "bun:test";
import { extractFirstPrompt } from "../src/conversation/extract.ts";

const jsonl = (lines: unknown[]): string => lines.map((line) => JSON.stringify(line)).join("\n");

describe("extractFirstPrompt claude", () => {
  test("skips meta and sidechain lines; reads the first typed prompt and cwd", () => {
    const transcript = jsonl([
      { type: "file-history-snapshot", messageId: "x" },
      {
        type: "user",
        isMeta: true,
        cwd: "/work/app",
        message: { role: "user", content: "<local-command-caveat>ignore</local-command-caveat>" },
      },
      {
        type: "user",
        isSidechain: true,
        message: { role: "user", content: "subagent task" },
      },
      {
        type: "user",
        cwd: "/work/app",
        message: { role: "user", content: [{ type: "text", text: "fix the tests" }] },
      },
    ]);
    expect(extractFirstPrompt("claude", transcript)).toEqual({
      prompt: "fix the tests",
      cwd: "/work/app",
    });
  });

  test("a tool-result-only user line is not a prompt", () => {
    const transcript = jsonl([
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "ran" }] },
      },
    ]);
    expect(extractFirstPrompt("claude", transcript)).toBeNull();
  });

  test("housekeeping commands are skipped when a substantive prompt follows", () => {
    const transcript = jsonl([
      {
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/model</command-name>\n<command-args></command-args>",
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: "<local-command-stdout>Set model to Fable</local-command-stdout>",
        },
      },
      {
        type: "user",
        cwd: "/work/app",
        message: { role: "user", content: "build the slug subcommand" },
      },
    ]);
    expect(extractFirstPrompt("claude", transcript)?.prompt).toBe("build the slug subcommand");
  });

  test("a conversation that only ever ran a command keeps the command", () => {
    const transcript = jsonl([
      {
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/reload-plugins</command-name>\n<command-args></command-args>",
        },
      },
    ]);
    expect(extractFirstPrompt("claude", transcript)?.prompt).toContain("reload-plugins");
  });

  test("string content and a half-written trailing line both work", () => {
    const whole = jsonl([{ type: "user", message: { role: "user", content: "plain ask" } }]);
    expect(extractFirstPrompt("claude", `${whole}\n{"type":"us`)?.prompt).toBe("plain ask");
  });
});

describe("extractFirstPrompt codex", () => {
  test("takes the first typed user response item, not injected wrappers", () => {
    const item = (role: string, text: string): unknown => ({
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    });
    const transcript = jsonl([
      { type: "session_meta", payload: { id: "abc" } },
      item("developer", "<skills_instructions>x</skills_instructions>"),
      item("user", "<user_instructions>x</user_instructions>"),
      item("user", "# AGENTS.md instructions for /work/api\n<INSTRUCTIONS>y</INSTRUCTIONS>"),
      item("user", "<environment_context>z</environment_context>"),
      { type: "turn_context", payload: { cwd: "/work/api" } },
      item("user", "add rate limiting"),
      item("user", "second turn"),
    ]);
    expect(extractFirstPrompt("codex", transcript)).toEqual({
      prompt: "add rate limiting",
      cwd: "/work/api",
    });
  });

  test("a rollout with no typed prompt yet is null", () => {
    const transcript = jsonl([{ type: "session_meta", payload: { id: "abc" } }]);
    expect(extractFirstPrompt("codex", transcript)).toBeNull();
  });
});
