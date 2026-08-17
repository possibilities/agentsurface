import { describe, expect, test } from "bun:test";
import type { LaunchHarness } from "../src/catalog.ts";
import {
  applyEditedIntent,
  buildPlan,
  createForm,
  currentEffort,
  currentHarness,
  currentModel,
  type FormState,
  failRun,
  handleFormKey,
  type KeyEvent,
  resetForAnother,
  setEffort,
  setHarness,
  setModel,
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
  test("space and the letter keys open the choosers from select rows", () => {
    const state = form();
    state.focus = "project";
    expect(handleFormKey(state, key(" ", { sequence: " " }))).toEqual({
      kind: "choose",
      field: "project",
    });
    state.focus = "effort";
    expect(handleFormKey(state, key("p"))).toEqual({ kind: "choose", field: "project" });
    expect(handleFormKey(state, key("h"))).toEqual({ kind: "choose", field: "harness" });
    expect(handleFormKey(state, key("m"))).toEqual({ kind: "choose", field: "model" });
    expect(handleFormKey(state, key("e"))).toEqual({ kind: "choose", field: "effort" });
    state.focus = "harness";
    expect(handleFormKey(state, key(" ", { sequence: " " }))).toEqual({
      kind: "choose",
      field: "harness",
    });
  });

  test("a submits for another; letters in text fields stay text", () => {
    const state = form();
    state.focus = "model";
    expect(handleFormKey(state, key("a")).kind).toBe("launchAnother");
    state.focus = "prompt";
    type(state, "ahme");
    expect(state.prompt).toBe("ahme");
  });

  test("the picker setters apply the cascade snapping", () => {
    const state = form();
    setHarness(state, 1);
    expect(currentHarness(state).harness).toBe("codex");
    expect(currentModel(state).model).toBe("sol");
    expect(currentEffort(state)).toBe("high");
    setEffort(state, 5);
    expect(currentEffort(state)).toBe("ultra");
    setModel(state, 2);
    expect(currentModel(state).model).toBe("spark");
    expect(currentEffort(state)).toBe("low");
    expect(state.focus as string).toBe("model");
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
    expect(state.notice?.text).toContain("branch");
    expect(state.focus).toBe("branch");
  });

  test("no projects refuses with a notice", () => {
    const state = createForm({ projects: [], harnesses: HARNESSES });
    expect(buildPlan(state)).toBeNull();
    expect(state.notice?.text).toContain("no projects");
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

describe("readline editing", () => {
  const seed = (): FormState => {
    const state = form();
    type(state, "alpha beta gamma");
    return state;
  };
  const press = (state: FormState, name: string, extra: Partial<KeyEvent> = {}): void => {
    handleFormKey(state, { name, sequence: "", ...extra });
  };

  test("ctrl motions move by character and line edge", () => {
    const state = seed();
    press(state, "a", { ctrl: true });
    expect(state.cursor).toBe(0);
    press(state, "f", { ctrl: true });
    press(state, "f", { ctrl: true });
    expect(state.cursor).toBe(2);
    press(state, "e", { ctrl: true });
    expect(state.cursor).toBe(16);
    press(state, "b", { ctrl: true });
    expect(state.cursor).toBe(15);
    press(state, "home");
    expect(state.cursor).toBe(0);
    press(state, "end");
    expect(state.cursor).toBe(16);
  });

  test("meta motions move by word", () => {
    const state = seed();
    press(state, "b", { meta: true });
    expect(state.cursor).toBe(11); // start of gamma
    press(state, "b", { meta: true });
    expect(state.cursor).toBe(6); // start of beta
    press(state, "f", { meta: true });
    expect(state.cursor).toBe(10); // end of beta
  });

  test("kills edit the intent and re-suggest the branch", () => {
    const state = seed();
    press(state, "w", { ctrl: true });
    expect(state.prompt).toBe("alpha beta ");
    expect(state.branch).toBe("alpha-beta");
    press(state, "a", { ctrl: true });
    press(state, "d", { meta: true });
    expect(state.prompt).toBe(" beta ");
    press(state, "e", { ctrl: true });
    press(state, "u", { ctrl: true });
    expect(state.prompt).toBe("");
    expect(state.branch).toBe("");
  });

  test("delete works forwards and ctrl+h backwards", () => {
    const state = form();
    type(state, "abc");
    press(state, "a", { ctrl: true });
    press(state, "delete");
    expect(state.prompt).toBe("bc");
    press(state, "f", { ctrl: true });
    press(state, "h", { ctrl: true });
    expect(state.prompt).toBe("c");
    expect(state.cursor).toBe(0);
  });

  test("ctrl+g asks for the editor from any focus", () => {
    const state = form();
    expect(handleFormKey(state, { name: "g", ctrl: true, sequence: "" }).kind).toBe("editIntent");
    state.focus = "harness";
    expect(handleFormKey(state, { name: "g", ctrl: true, sequence: "" }).kind).toBe("editIntent");
  });
});

describe("applyEditedIntent", () => {
  test("replaces the intent, trims the editor's trailing newline, re-suggests", () => {
    const state = form();
    type(state, "old words");
    applyEditedIntent(state, "Fix the queue\r\nand add a test\n\n");
    expect(state.prompt).toBe("Fix the queue\nand add a test");
    expect(state.cursor).toBe(state.prompt.length);
    expect(state.branch).toBe("fix-the-queue-and-add-a-test");
  });
});

describe("createForm defaults", () => {
  test("remembers the last launch's cascade where the catalog allows", () => {
    const state = createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      remembered: { harness: "codex", model: "luna", effort: "max" },
    });
    expect(currentHarness(state).harness).toBe("codex");
    expect(currentModel(state).model).toBe("luna");
    expect(currentEffort(state)).toBe("max");
    expect(state.focus).toBe("prompt");
  });

  test("a renamed model or narrowed effort degrades to catalog defaults", () => {
    const state = createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      remembered: { harness: "codex", model: "gone", effort: "max" },
    });
    expect(currentModel(state).model).toBe("sol");
    expect(currentEffort(state)).toBe("high");
    const narrowed = createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      remembered: { harness: "codex", model: "spark", effort: "ultra" },
    });
    expect(currentModel(narrowed).model).toBe("spark");
    // ultra is outlawed; the harness default (high) survives because spark
    // allows it, per the keep-when-allowed rule.
    expect(currentEffort(narrowed)).toBe("high");
  });

  test("the cwd picks the project the launcher opened over", () => {
    const state = createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      cwd: "/home/u/code/beta/sub/dir",
    });
    expect(state.projects[state.projectIndex]?.display).toBe("~/code/beta");
  });
});

describe("resetForAnother", () => {
  test("clears the intent and branch, keeps the config, and confirms", () => {
    const state = form();
    type(state, "First launch");
    state.worktree = true;
    setHarness(state, 1);
    resetForAnother(state, "started codex · ~/code/alpha");
    expect(state.prompt).toBe("");
    expect(state.branch).toBe("");
    expect(state.branchEdited).toBe(false);
    expect(state.worktree).toBe(true);
    expect(currentHarness(state).harness).toBe("codex");
    expect(state.focus).toBe("prompt");
    expect(state.notice?.tone).toBe("ok");
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
