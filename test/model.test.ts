import { describe, expect, test } from "bun:test";
import type { LaunchHarness } from "../src/catalog.ts";
import {
  buildPlan,
  createForm,
  currentEffort,
  currentHarness,
  currentModel,
  type FormState,
  failRun,
  handleFormKey,
  type KeyEvent,
  slugify,
} from "../src/launch/model.ts";
import type { ProjectChoice } from "../src/projects.ts";

const HARNESSES: LaunchHarness[] = [
  {
    harness: "claude",
    defaultModel: "opus",
    defaultEffort: "medium",
    models: [
      { model: "fable", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null },
      { model: "opus", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null },
    ],
  },
  {
    harness: "codex",
    defaultModel: "sol",
    defaultEffort: "high",
    models: [
      {
        model: "sol",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: null,
      },
      { model: "luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null },
      { model: "spark", efforts: ["low", "high"], defaultEffort: "low" },
    ],
  },
];

const PROJECTS: ProjectChoice[] = [
  { path: "/home/u/code/alpha", display: "~/code/alpha", count: 3 },
  { path: "/home/u/code/beta", display: "~/code/beta", count: 0 },
];

function form(): FormState {
  return createForm({ projects: [...PROJECTS], harnesses: HARNESSES });
}

function key(name: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  return { name, sequence: name.length === 1 ? name : "", ...extra };
}

function type(state: FormState, text: string): void {
  for (const character of text) {
    handleFormKey(state, { name: character, sequence: character });
  }
}

describe("createForm", () => {
  test("starts at the prompt with the harness's catalog defaults", () => {
    const state = form();
    expect(state.focus).toBe("prompt");
    expect(currentHarness(state).harness).toBe("claude");
    expect(currentModel(state).model).toBe("opus");
    expect(currentEffort(state)).toBe("medium");
  });
});

describe("prompt and branch", () => {
  test("typing feeds the intent and suggests a branch until edited", () => {
    const state = form();
    type(state, "Fix the bug");
    expect(state.prompt).toBe("Fix the bug");
    expect(state.branch).toBe("fix-the-bug");

    handleFormKey(state, key("tab"));
    handleFormKey(state, key("w"));
    expect(state.worktree).toBe(true);
    state.focus = "branch";
    type(state, "x");
    expect(state.branch).toBe("fix-the-bugx");
    expect(state.branchEdited).toBe(true);

    state.focus = "prompt";
    type(state, "!");
    expect(state.branch).toBe("fix-the-bugx");
  });

  test("branch input keeps only branch-safe characters", () => {
    const state = form();
    state.worktree = true;
    state.focus = "branch";
    type(state, "a b!c/d");
    expect(state.branch).toBe("abc/d");
  });

  test("cursor editing inserts and deletes at the cursor", () => {
    const state = form();
    type(state, "abd");
    handleFormKey(state, key("left"));
    type(state, "c");
    expect(state.prompt).toBe("abcd");
    handleFormKey(state, key("backspace"));
    expect(state.prompt).toBe("abd");
  });

  test("a paste with newlines lands as one spaced line", () => {
    const state = form();
    handleFormKey(state, { name: "", sequence: "one\ntwo" });
    expect(state.prompt).toBe("one two");
  });
});

describe("focus traversal", () => {
  test("enter leaves the prompt, then launches from any config row", () => {
    const state = form();
    expect(handleFormKey(state, key("return")).kind).toBe("none");
    expect(state.focus).toBe("project");
    expect(handleFormKey(state, key("return")).kind).toBe("launch");
  });

  test("tab order skips the branch row until a worktree is asked for", () => {
    const state = form();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      handleFormKey(state, key("tab"));
      seen.push(state.focus);
    }
    expect(seen).toEqual(["project", "worktree", "harness", "model", "effort", "prompt"]);

    state.worktree = true;
    state.focus = "worktree";
    handleFormKey(state, key("tab"));
    expect(state.focus as string).toBe("branch");
  });

  test("escape quits; shift-tab and up go backwards", () => {
    const state = form();
    expect(handleFormKey(state, key("escape")).kind).toBe("quit");
    state.focus = "worktree";
    handleFormKey(state, key("tab", { shift: true }));
    expect(state.focus as string).toBe("project");
    handleFormKey(state, key("up"));
    expect(state.focus as string).toBe("prompt");
  });
});

describe("the cascade", () => {
  test("changing harness snaps model and effort to its defaults", () => {
    const state = form();
    state.focus = "harness";
    handleFormKey(state, key("right"));
    expect(currentHarness(state).harness).toBe("codex");
    expect(currentModel(state).model).toBe("sol");
    expect(currentEffort(state)).toBe("high");
  });

  test("changing model keeps an allowed effort and snaps an outlawed one", () => {
    const state = form();
    state.focus = "harness";
    handleFormKey(state, key("right"));
    state.focus = "effort";
    for (let i = 0; i < 3; i++) handleFormKey(state, key("right"));
    expect(currentEffort(state)).toBe("ultra");

    state.focus = "model";
    handleFormKey(state, key("right"));
    expect(currentModel(state).model).toBe("luna");
    expect(currentEffort(state)).toBe("high");

    state.focus = "effort";
    handleFormKey(state, key("right"));
    expect(currentEffort(state)).toBe("xhigh");
    state.focus = "model";
    handleFormKey(state, key("right"));
    expect(currentModel(state).model).toBe("spark");
    expect(currentEffort(state)).toBe("low");
  });
});

describe("direct keys", () => {
  test("space or p opens the project picker from a select row", () => {
    const state = form();
    state.focus = "project";
    expect(handleFormKey(state, key(" ", { sequence: " " })).kind).toBe("chooseProject");
    state.focus = "effort";
    expect(handleFormKey(state, key("p")).kind).toBe("chooseProject");
  });

  test("w toggles the worktree from a select row, not from text", () => {
    const state = form();
    state.focus = "harness";
    handleFormKey(state, key("w"));
    expect(state.worktree).toBe(true);
    state.focus = "prompt";
    handleFormKey(state, key("w"));
    expect(state.worktree).toBe(true);
    expect(state.prompt).toBe("w");
  });
});

describe("buildPlan", () => {
  test("freezes the launch with the level as one value", () => {
    const state = form();
    type(state, "Fix the bug");
    const plan = buildPlan(state);
    expect(plan).not.toBeNull();
    expect(plan?.level).toBe("opus:medium");
    expect(plan?.project.path).toBe("/home/u/code/alpha");
    expect(plan?.branch).toBeNull();
    expect(plan?.prompt).toBe("Fix the bug");
  });

  test("a worktree without a branch refuses and focuses the branch row", () => {
    const state = form();
    state.worktree = true;
    const plan = buildPlan(state);
    expect(plan).toBeNull();
    expect(state.notice).toContain("branch");
    expect(state.focus).toBe("branch");
  });

  test("no projects refuses with a notice", () => {
    const state = createForm({ projects: [], harnesses: HARNESSES });
    expect(buildPlan(state)).toBeNull();
    expect(state.notice).toContain("no projects");
  });
});

describe("failed phase", () => {
  test("enter returns to the form; escape quits", () => {
    const state = form();
    failRun(state, "workspace create failed");
    expect(handleFormKey(state, key("x")).kind).toBe("none");
    expect(handleFormKey(state, key("return")).kind).toBe("none");
    expect(state.phase.kind).toBe("form");
    failRun(state, "again");
    expect(handleFormKey(state, key("escape")).kind).toBe("quit");
  });
});

describe("slugify", () => {
  test("kebabs, trims, and caps the suggestion", () => {
    expect(slugify("Fix the Flaky retry! test")).toBe("fix-the-flaky-retry-test");
    expect(slugify("  ")).toBe("");
    expect(slugify("a".repeat(60)).length).toBeLessThanOrEqual(40);
    expect(slugify("Trailing punctuation!!!")).toBe("trailing-punctuation");
  });
});
