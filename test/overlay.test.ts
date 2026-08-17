import { describe, expect, test } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createListOverlay, type OverlayItem, overlayMatches } from "../src/launch/overlay.ts";

const TOKENS = {
  panel: "#131a1e",
  line: "#333333",
  accent: "#00ffff",
  muted: "#999999",
  text: "#eeeeee",
};

const commandItems = (ran: string[] = []): OverlayItem[] => [
  { id: "launch", key: "⏎", label: "launch", onRun: () => ran.push("launch") },
  { id: "project", key: "P", label: "choose project", onRun: () => ran.push("project") },
  { id: "worktree", key: "W", label: "toggle worktree", onRun: () => ran.push("worktree") },
  { id: "quit", key: "ESC", label: "quit without launching", onRun: () => ran.push("quit") },
];

const projectItems = (ran: string[] = []): OverlayItem[] => [
  { id: "0", label: "~/code/alpha", meta: "3×", onRun: () => ran.push("alpha") },
  { id: "1", label: "~/code/beta", onRun: () => ran.push("beta") },
];

const press = (name: string, extra: Partial<{ ctrl: boolean; sequence: string }> = {}) => ({
  name,
  ctrl: extra.ctrl ?? false,
  sequence: extra.sequence ?? name,
});

describe("overlayMatches", () => {
  test("filters label, key, and meta case-insensitively", () => {
    const all = commandItems();
    expect(overlayMatches(all, "")).toHaveLength(4);
    expect(overlayMatches(all, "work").map((item) => item.id)).toEqual(["worktree"]);
    expect(overlayMatches(all, "esc").map((item) => item.id)).toEqual(["quit"]);
    expect(overlayMatches(projectItems(), "3×").map((item) => item.id)).toEqual(["0"]);
  });
});

describe("list overlay", () => {
  test("closed it consumes nothing; open it lists rows with keys and meta", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const overlay = createListOverlay(core, setup.renderer, "test-commands", TOKENS, {
      title: " COMMANDS ",
      empty: "no matching command",
    });
    setup.renderer.root.add(overlay.root);
    overlay.update({ items: commandItems(), width: 80, height: 24 });

    expect(overlay.isOpen()).toBe(false);
    expect(overlay.handleKey(press("q"))).toBe(false);
    expect(overlay.handleKey(press("c", { ctrl: true }))).toBe(false);

    overlay.open();
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("COMMANDS");
    expect(frame).toContain("[⏎]");
    expect(frame).toContain("choose project");
    expect(overlay.handleKey(press("c", { ctrl: true }))).toBe(false);
    setup.renderer.destroy();
  });

  test("filters, runs the selection on enter, and closes", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const ran: string[] = [];
    const overlay = createListOverlay(core, setup.renderer, "filter-commands", TOKENS, {
      title: " COMMANDS ",
      empty: "no matching command",
    });
    setup.renderer.root.add(overlay.root);
    overlay.update({ items: commandItems(ran), width: 80, height: 24 });

    overlay.open();
    for (const letter of "quit") expect(overlay.handleKey(press(letter))).toBe(true);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("quit without launching");
    expect(overlay.handleKey(press("return", { sequence: "\r" }))).toBe(true);
    expect(ran).toEqual(["quit"]);
    expect(overlay.isOpen()).toBe(false);
    setup.renderer.destroy();
  });

  test("arrows move the accent rail; escape closes without running", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const ran: string[] = [];
    const overlay = createListOverlay(core, setup.renderer, "nav-projects", TOKENS, {
      title: " PROJECTS ",
      empty: "no matching project",
    });
    setup.renderer.root.add(overlay.root);
    overlay.update({ items: projectItems(ran), width: 80, height: 24 });

    overlay.open();
    overlay.handleKey(press("down", { sequence: "" }));
    await setup.flush();
    const selectedRow = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("▎"));
    expect(selectedRow).toContain("beta");

    // Left/right alias up/down, the form rows' spinner habit.
    overlay.handleKey(press("left", { sequence: "" }));
    await setup.flush();
    const afterLeft = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("▎"));
    expect(afterLeft).toContain("alpha");
    overlay.handleKey(press("right", { sequence: "" }));
    await setup.flush();
    const afterRight = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("▎"));
    expect(afterRight).toContain("beta");

    expect(overlay.handleKey(press("escape", { sequence: "" }))).toBe(true);
    expect(ran).toHaveLength(0);
    expect(overlay.isOpen()).toBe(false);
    setup.renderer.destroy();
  });

  test("runs an item from a pointer tap on its row", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const ran: string[] = [];
    const overlay = createListOverlay(core, setup.renderer, "tap-projects", TOKENS, {
      title: " PROJECTS ",
      empty: "no matching project",
    });
    setup.renderer.root.add(overlay.root);
    overlay.update({ items: projectItems(ran), width: 80, height: 24 });

    overlay.open();
    await setup.flush();
    const row = setup.renderer.root.findDescendantById("tap-projects-item-1");
    expect(row).toBeInstanceOf(core.BoxRenderable);
    await setup.mockMouse.click(row!.x + 2, row!.y);
    expect(ran).toEqual(["beta"]);
    expect(overlay.isOpen()).toBe(false);
    setup.renderer.destroy();
  });

  test("stays inside a shallow narrow terminal", async () => {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const overlay = createListOverlay(core, setup.renderer, "small-commands", TOKENS, {
      title: " COMMANDS ",
      empty: "no matching command",
    });
    setup.renderer.root.add(overlay.root);
    overlay.update({ items: commandItems(), width: 40, height: 12 });

    overlay.open();
    await setup.flush();
    expect(overlay.root.width).toBeLessThanOrEqual(36);
    expect(overlay.root.y + overlay.root.height).toBeLessThanOrEqual(12);
    setup.renderer.destroy();
  });
});
