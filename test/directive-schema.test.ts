import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDirectiveSchema } from "../scripts/generate-schema.ts";
import { parseDirective, type SessionDirective } from "../src/directive-schema.ts";
import type { CliError } from "../src/errors.ts";

const DIRECTIVE: SessionDirective = {
  schema_version: 1,
  cwd: "/code/alpha",
  worktree: false,
  focus: true,
  agent: { kind: "claude", args: ["--x-level", "fable:max"] },
  intent: "fix it",
  record: { model: "fable", effort: "max", priming: null },
};

describe("directive.schema.json", () => {
  test("the checked-in schema matches its zod source", () => {
    const published = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "directive.schema.json"), "utf8"),
    );
    expect(published).toEqual(buildDirectiveSchema());
  });
});

describe("parseDirective", () => {
  test("round-trips a directive, with and without the optional record", () => {
    expect(parseDirective(JSON.stringify(DIRECTIVE))).toEqual(DIRECTIVE);
    const { record: _record, ...bare } = DIRECTIVE;
    expect(parseDirective(JSON.stringify({ ...bare, intent: null }))).toEqual({
      ...bare,
      intent: null,
    });
  });

  test("refuses non-JSON, missing fields, and unknown keys by name", () => {
    const faults = [
      "",
      "not json",
      JSON.stringify({}),
      JSON.stringify({ ...DIRECTIVE, cwd: "" }),
      JSON.stringify({ ...DIRECTIVE, agent: { kind: "claude" } }),
      JSON.stringify({ ...DIRECTIVE, surprise: true }),
    ];
    for (const line of faults) {
      let caught: unknown;
      try {
        parseDirective(line);
      } catch (error) {
        caught = error;
      }
      expect((caught as CliError).code).toBe("directive_invalid");
    }
  });

  test("an unknown schema_version fails loudly, never executes approximately", () => {
    let caught: unknown;
    try {
      parseDirective(JSON.stringify({ ...DIRECTIVE, schema_version: 2 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as CliError).code).toBe("directive_unsupported");
    expect((caught as CliError).message).toContain("2");
  });
});
