import { describe, expect, test } from "bun:test";
import { closeActive, closeTargetFromContext } from "../src/close.ts";
import { CliError, UsageError } from "../src/errors.ts";
import type { HerdrCall } from "../src/herdr.ts";

const env = {
  HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
    workspace_id: "w1",
    tab_id: "w1:t2",
    focused_pane_id: "w1:p3",
  }),
};

describe("closeActive", () => {
  test("maps each topology target to the id captured in plugin context", async () => {
    const calls: string[][] = [];
    const call: HerdrCall = (args) => {
      calls.push(args);
      return Promise.resolve({ result: { ok: true } });
    };
    await closeActive(call, env, ["pane"]);
    await closeActive(call, env, ["tab"]);
    await closeActive(call, env, ["workspace"]);
    expect(calls).toEqual([
      ["pane", "close", "w1:p3"],
      ["tab", "close", "w1:t2"],
      ["workspace", "close", "w1"],
    ]);
  });

  test("rejects an unknown target before calling Herdr", async () => {
    let called = false;
    try {
      await closeActive(
        () => {
          called = true;
          return Promise.resolve({});
        },
        env,
        ["session"],
      );
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
    }
    expect(called).toBe(false);
  });

  test("fails closed for missing, malformed, or incomplete context", () => {
    for (const candidate of [
      {},
      { HERDR_PLUGIN_CONTEXT_JSON: "{" },
      { HERDR_PLUGIN_CONTEXT_JSON: "{}" },
    ]) {
      expect(() => closeTargetFromContext(candidate, "pane")).toThrow(CliError);
    }
  });
});
