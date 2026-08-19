import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HerdrCall, HerdrResponse } from "../src/herdr.ts";
import { contextCwd, createDirectiveLog, splitCompleteLines } from "../src/host.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function home(): string {
  const temp = mkdtempSync(join(tmpdir(), "agentsurface-host-"));
  temps.push(temp);
  return join(temp, "home");
}

describe("splitCompleteLines", () => {
  test("acts on complete lines only and carries the partial tail", () => {
    expect(splitCompleteLines("")).toEqual({ lines: [], rest: "" });
    expect(splitCompleteLines('{"a":1}')).toEqual({ lines: [], rest: '{"a":1}' });
    expect(splitCompleteLines('{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' });
    expect(splitCompleteLines('{"a":1}\n{"b":2}\n')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: "",
    });
    // Blank lines are whitespace, not directives.
    expect(splitCompleteLines('\n \n{"c":3}\n')).toEqual({ lines: ['{"c":3}'], rest: "" });
  });
});

describe("createDirectiveLog", () => {
  test("creates a fresh empty evidence log under the state spool and prunes stale ones", () => {
    const h = home();
    const first = createDirectiveLog({}, h);
    expect(existsSync(first)).toBe(true);
    expect(readFileSync(first, "utf8")).toBe("");
    expect(dirname(first).endsWith(join("agentsurface", "directives"))).toBe(true);

    const stale = join(dirname(first), "stale.jsonl");
    writeFileSync(stale, "");
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);
    const second = createDirectiveLog({}, h);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(first)).toBe(true); // fresh logs survive the prune
    expect(second).not.toBe(first);
  });
});

describe("contextCwd", () => {
  const fake = (responses: HerdrResponse[]): HerdrCall => {
    const queue = [...responses];
    return () => Promise.resolve(queue.shift() ?? { error: { message: "exhausted" } });
  };

  test("asks herdr for the named pane's cwd, preferring the foreground", async () => {
    const call = fake([{ result: { pane: { cwd: "/shell", foreground_cwd: "/code/alpha" } } }]);
    expect(await contextCwd(call, { HERDR_ACTIVE_PANE_ID: "p1" })).toBe("/code/alpha");
  });

  test("falls back to the process cwd without a pane or on a herdr error", async () => {
    expect(await contextCwd(fake([]), {})).toBe(process.cwd());
    const failing = fake([{ error: { message: "no such pane" } }]);
    expect(await contextCwd(failing, { HERDR_PANE_ID: "gone" })).toBe(process.cwd());
  });
});
