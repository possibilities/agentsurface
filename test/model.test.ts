import { describe, expect, test } from "bun:test";
import type { LaunchHarness } from "../src/catalog.ts";
import {
  buildPlan,
  createForm,
  currentEffort,
  currentHarness,
  currentModel,
  currentPriming,
  type FormState,
  failRun,
  handleFormKey,
  type KeyEvent,
  normalizeEditedIntent,
  resetForAnother,
  setEffort,
  setHarness,
  setModel,
  setPriming,
} from "../src/launch/model.ts";
import type { ProjectChoice } from "../src/projects.ts";

const HARNESSES: LaunchHarness[] = [
  {
    harness: "claude",
    defaultModel: "opus",
    defaultEffort: "medium",
    metadataLevel: "haiku:low",
    models: [
      { model: "fable", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null },
      { model: "opus", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null },
    ],
  },
  {
    harness: "codex",
    defaultModel: "sol",
    defaultEffort: "high",
    metadataLevel: "mini:low",
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

describe("createForm", () => {
  test("starts at the prompt with the harness's catalog defaults", () => {
    const state = form();
    expect(state.focus).toBe("prompt");
    expect(currentHarness(state).harness).toBe("claude");
    expect(currentModel(state).model).toBe("opus");
    expect(currentEffort(state)).toBe("medium");
  });
});

describe("the prompt", () => {
  test("editing keys are the textarea's, not the model's", () => {
    const state = form();
    expect(handleFormKey(state, key("x")).kind).toBe("none");
    expect(handleFormKey(state, key("backspace")).kind).toBe("none");
    expect(state.prompt).toBe("");
  });
});

describe("focus traversal", () => {
  test("enter leaves the prompt, then launches from any config row", () => {
    const state = form();
    expect(handleFormKey(state, key("return")).kind).toBe("none");
    expect(state.focus).toBe("project");
    expect(handleFormKey(state, key("return")).kind).toBe("launch");
  });

  test("tab cycles the seven rows", () => {
    const state = form();
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      handleFormKey(state, key("tab"));
      seen.push(state.focus);
    }
    expect(seen).toEqual([
      "project",
      "worktree",
      "harness",
      "model",
      "effort",
      "priming",
      "prompt",
    ]);
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
    expect(handleFormKey(state, key("a")).kind).toBe("none");
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

  test("w toggles the worktree from a select row, never from the prompt", () => {
    const state = form();
    state.focus = "harness";
    handleFormKey(state, key("w"));
    expect(state.worktree).toBe(true);
    state.focus = "prompt";
    handleFormKey(state, key("w"));
    expect(state.worktree).toBe(true);
  });
});

describe("priming", () => {
  const withPrimings = (): FormState =>
    createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      primings: ["collab", "build", "orchestrate"],
    });

  test("offers none first, then the config's order; none is the default", () => {
    const state = withPrimings();
    expect(state.primingOptions).toEqual(["none", "collab", "build", "orchestrate"]);
    expect(currentPriming(state)).toBe("none");
    expect(form().primingOptions).toEqual(["none"]);
  });

  test("cycles, chooses via i, and rides the plan as null-for-none", () => {
    const state = withPrimings();
    state.focus = "priming";
    handleFormKey(state, key("right"));
    expect(currentPriming(state)).toBe("collab");
    expect(buildPlan(state)?.priming).toBe("collab");
    state.focus = "harness";
    expect(handleFormKey(state, key("i"))).toEqual({ kind: "choose", field: "priming" });
    setPriming(state, 0);
    expect(buildPlan(state)?.priming).toBeNull();
  });

  test("a remembered priming applies only while still configured", () => {
    const kept = createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      primings: ["collab"],
      remembered: { harness: "claude", model: "opus", effort: "medium", priming: "collab" },
    });
    expect(currentPriming(kept)).toBe("collab");
    const gone = createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      primings: ["build"],
      remembered: { harness: "claude", model: "opus", effort: "medium", priming: "collab" },
    });
    expect(currentPriming(gone)).toBe("none");
  });
});

describe("buildPlan", () => {
  test("freezes the launch with the level as one value", () => {
    const state = form();
    state.prompt = "Fix the bug";
    const plan = buildPlan(state);
    expect(plan).not.toBeNull();
    expect(plan?.level).toBe("opus:medium");
    expect(plan?.project.path).toBe("/home/u/code/alpha");
    expect(plan?.prompt).toBe("Fix the bug");
  });

  test("a worktree launch needs no branch: herdr names it", () => {
    const state = form();
    state.worktree = true;
    const plan = buildPlan(state);
    expect(plan?.worktree).toBe(true);
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

describe("ctrl+g", () => {
  test("asks for the editor from any focus", () => {
    const state = form();
    expect(handleFormKey(state, { name: "g", ctrl: true, sequence: "" }).kind).toBe("editIntent");
    state.focus = "harness";
    expect(handleFormKey(state, { name: "g", ctrl: true, sequence: "" }).kind).toBe("editIntent");
  });
});

describe("normalizeEditedIntent", () => {
  test("normalizes line endings and trims the editor's trailing newline", () => {
    expect(normalizeEditedIntent("Fix the queue\r\nand add a test\n\n")).toBe(
      "Fix the queue\nand add a test",
    );
    expect(normalizeEditedIntent("")).toBe("");
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

  test("an interrupted draft outranks remembered and cwd, degrading gracefully", () => {
    const state = createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      cwd: "/home/u/code/alpha",
      remembered: { harness: "claude", model: "fable", effort: "max" },
      draft: {
        prompt: "held",
        project: "/home/u/code/beta",
        worktree: true,
        harness: "codex",
        model: "luna",
        effort: "xhigh",
      },
    });
    expect(state.projects[state.projectIndex]?.path).toBe("/home/u/code/beta");
    expect(state.worktree).toBe(true);
    expect(currentHarness(state).harness).toBe("codex");
    expect(currentModel(state).model).toBe("luna");
    expect(currentEffort(state)).toBe("xhigh");
    expect(state.focus).toBe("prompt");

    const degraded = createForm({
      projects: [...PROJECTS],
      harnesses: HARNESSES,
      draft: {
        prompt: "held",
        project: "/gone",
        worktree: false,
        harness: "codex",
        model: "renamed-away",
        effort: "ultra",
      },
    });
    expect(currentHarness(degraded).harness).toBe("codex");
    expect(currentModel(degraded).model).toBe("sol");
    expect(degraded.projects[degraded.projectIndex]?.path).toBe("/home/u/code/alpha");
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
  test("clears the intent, keeps the config, and confirms", () => {
    const state = form();
    state.prompt = "First launch";
    state.worktree = true;
    setHarness(state, 1);
    resetForAnother(state, "started codex · ~/code/alpha");
    expect(state.prompt).toBe("");
    expect(state.worktree).toBe(true);
    expect(currentHarness(state).harness).toBe("codex");
    expect(state.focus).toBe("prompt");
    expect(state.notice?.tone).toBe("ok");
  });
});
