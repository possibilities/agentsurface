import { describe, expect, test } from "bun:test";
import type { LaunchHarness } from "../src/catalog.ts";
import { buildFormLines, createForm, type FormState, failRun } from "../src/launch/model.ts";
import type { ProjectChoice } from "../src/projects.ts";

const HARNESSES: LaunchHarness[] = [
  {
    harness: "claude",
    defaultModel: "fable",
    defaultEffort: "medium",
    models: [{ model: "fable", efforts: ["low", "medium", "high"], defaultEffort: null }],
  },
];

const PROJECTS: ProjectChoice[] = [
  { path: "/home/u/code/alpha", display: "~/code/alpha", count: 3 },
  {
    path: "/home/u/code/a-project-with-a-very-long-name-indeed",
    display: "~/code/a-project-with-a-very-long-name-indeed",
    count: 0,
  },
];

function form(): FormState {
  return createForm({ projects: [...PROJECTS], harnesses: HARNESSES });
}

function rows(state: FormState, width: number): string[] {
  return buildFormLines(state, width).map((line) => line.map((span) => span.text).join(""));
}

describe("buildFormLines", () => {
  test("shows the fact rows and the cascade", () => {
    const text = rows(form(), 76).join("\n");
    expect(text).toContain("project");
    expect(text).toContain("~/code/alpha");
    expect(text).not.toContain("3×"); // frequency orders the list, unshown
    expect(text).toContain("○ no worktree");
    expect(text).toContain("claude");
    expect(text).toContain("fable");
    expect(text).toContain("medium");
  });

  test("marks the focused row with the accent rail", () => {
    const state = form();
    state.focus = "project";
    const projectRow = rows(state, 76).find((row) => row.includes("project"));
    expect(projectRow?.startsWith("▎")).toBe(true);
  });

  test("the worktree row states itself; herdr owns the branch name", () => {
    const state = form();
    expect(rows(state, 76).some((row) => row.includes("branch"))).toBe(false);
    state.worktree = true;
    const text = rows(state, 76).join("\n");
    expect(text).toContain("● new worktree");
    expect(text).not.toContain("branch");
  });

  test("no row exceeds the frame at the contract widths", () => {
    for (const width of [36, 76, 96]) {
      for (const row of rows(form(), width)) {
        expect(row.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("renders no identity, no help line, no key advertisement", () => {
    const text = rows(form(), 76).join("\n").toLowerCase();
    expect(text).not.toContain("agentsurface");
    expect(text).not.toContain("ctrl");
    expect(text).not.toContain("⌃");
  });

  test("confirmation and failure live in the body with recovery keys", () => {
    const state = form();
    state.notice = { text: "started claude · ~/code/alpha", tone: "ok" };
    expect(rows(state, 76).join("\n")).toContain("started claude · ~/code/alpha");
    failRun(state, "workspace create: no repo");
    const text = rows(state, 76).join("\n");
    expect(text).toContain("FAILED · workspace create: no repo");
    expect(text).toContain("ESC QUIT · ⏎ BACK");
  });

  test("the intent renders no line here — the textarea above owns it", () => {
    const state = form();
    state.prompt = "words that must not appear in the fact rows";
    expect(rows(state, 76).join("\n")).not.toContain("words that must not appear");
  });
});
