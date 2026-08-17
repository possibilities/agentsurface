import { describe, expect, test } from "bun:test";
import {
  createKillRing,
  KILL_RING_CAPACITY,
  killDirectionFor,
  pushKill,
  removedText,
  ringEntry,
} from "../src/launch/killring.ts";

describe("killDirectionFor", () => {
  test("maps the widget's kill chords and nothing else", () => {
    expect(killDirectionFor({ name: "k", ctrl: true })).toBe("append");
    expect(killDirectionFor({ name: "u", ctrl: true })).toBe("prepend");
    expect(killDirectionFor({ name: "w", ctrl: true })).toBe("prepend");
    expect(killDirectionFor({ name: "d", meta: true })).toBe("append");
    expect(killDirectionFor({ name: "backspace", meta: true })).toBe("prepend");
    expect(killDirectionFor({ name: "backspace" })).toBeNull();
    expect(killDirectionFor({ name: "delete" })).toBeNull();
    expect(killDirectionFor({ name: "x", ctrl: true })).toBeNull();
    expect(killDirectionFor({ name: "d", ctrl: true })).toBeNull();
  });
});

describe("pushKill", () => {
  test("unchained kills stack newest-first, capped", () => {
    const ring = createKillRing();
    pushKill(ring, "one", "append", false);
    pushKill(ring, "two", "append", false);
    expect(ring.entries).toEqual(["two", "one"]);
    for (let i = 0; i < KILL_RING_CAPACITY + 3; i++) pushKill(ring, `k${i}`, "append", false);
    expect(ring.entries.length).toBe(KILL_RING_CAPACITY);
    expect(ring.entries[0]).toBe(`k${KILL_RING_CAPACITY + 2}`);
  });

  test("chained kills merge directionally into one entry", () => {
    const ring = createKillRing();
    pushKill(ring, "beta ", "prepend", false);
    pushKill(ring, "alpha ", "prepend", true); // C-w C-w walks backwards
    expect(ring.entries).toEqual(["alpha beta "]);
    pushKill(ring, "gamma", "append", true); // then M-d forward
    expect(ring.entries).toEqual(["alpha beta gamma"]);
    expect(ringEntry(ring, 0)).toBe("alpha beta gamma");
  });

  test("empty kills leave the ring alone", () => {
    const ring = createKillRing();
    pushKill(ring, "", "append", false);
    expect(ring.entries).toEqual([]);
  });
});

describe("ringEntry", () => {
  test("wraps around in both directions and answers null when empty", () => {
    const ring = createKillRing();
    expect(ringEntry(ring, 0)).toBeNull();
    pushKill(ring, "c", "append", false);
    pushKill(ring, "b", "append", false);
    pushKill(ring, "a", "append", false);
    expect(ringEntry(ring, 0)).toBe("a");
    expect(ringEntry(ring, 1)).toBe("b");
    expect(ringEntry(ring, 3)).toBe("a");
    expect(ringEntry(ring, -1)).toBe("c");
  });
});

describe("removedText", () => {
  test("recovers what one contiguous deletion removed", () => {
    expect(removedText("alpha beta gamma", "alpha gamma")).toBe("beta ");
    expect(removedText("alpha beta", "alpha ")).toBe("beta");
    expect(removedText("alpha beta", "beta")).toBe("alpha ");
    expect(removedText("aaaa", "aa")).toBe("aa");
    expect(removedText("same", "same")).toBe("");
    expect(removedText("short", "longer than")).toBe("");
  });
});
