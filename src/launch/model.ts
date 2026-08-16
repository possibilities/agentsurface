import type { LaunchHarness } from "../catalog.ts";
import type { ProjectChoice } from "../projects.ts";
import { GLYPHS, type Line, type Span } from "./theme.ts";

/**
 * The launcher's form: a pure state machine over the one screen. The shell
 * (app.ts) feeds it key events and paints the lines it builds; everything
 * decidable without a terminal is decided here, where tests can reach it.
 *
 * The screen is prompt-first: the operator types the intent, and enter moves
 * on to confirming project, worktree, and the harness → model → effort
 * cascade, whose choices come pre-validated from agentlaunch's catalog — an
 * invalid pair can never be on screen.
 */

/** Keys as OpenTUI keypress events spell them. */
export interface KeyEvent {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
}

export type Field = "prompt" | "project" | "worktree" | "branch" | "harness" | "model" | "effort";

export type Phase =
  | { kind: "form" }
  | { kind: "running"; step: string }
  | { kind: "failed"; message: string };

export type FormAction =
  | { kind: "none" }
  | { kind: "quit" }
  | { kind: "launch" }
  | { kind: "chooseProject" };

export interface FormState {
  prompt: string;
  cursor: number;
  projects: ProjectChoice[];
  projectIndex: number;
  worktree: boolean;
  branch: string;
  branchEdited: boolean;
  harnesses: LaunchHarness[];
  harnessIndex: number;
  modelIndex: number;
  effortIndex: number;
  focus: Field;
  phase: Phase;
  notice: string | null;
}

export function createForm(inputs: {
  projects: ProjectChoice[];
  harnesses: LaunchHarness[];
}): FormState {
  const state: FormState = {
    prompt: "",
    cursor: 0,
    projects: inputs.projects,
    projectIndex: 0,
    worktree: false,
    branch: "",
    branchEdited: false,
    harnesses: inputs.harnesses,
    harnessIndex: 0,
    modelIndex: 0,
    effortIndex: 0,
    focus: "prompt",
    phase: { kind: "form" },
    notice: null,
  };
  snapToHarnessDefaults(state);
  return state;
}

export function currentHarness(state: FormState): LaunchHarness {
  return state.harnesses[state.harnessIndex]!;
}

export function currentModel(state: FormState) {
  return currentHarness(state).models[state.modelIndex]!;
}

export function currentEffort(state: FormState): string {
  return currentModel(state).efforts[state.effortIndex]!;
}

function snapToHarnessDefaults(state: FormState): void {
  const harness = currentHarness(state);
  const at = harness.models.findIndex((model) => model.model === harness.defaultModel);
  state.modelIndex = at >= 0 ? at : 0;
  snapEffort(state, null);
}

/** Effort follows the model: keep the operator's effort when the new model
 * allows it, else the model's own default, else the harness default, else
 * the strongest the model takes. */
function snapEffort(state: FormState, keep: string | null): void {
  const model = currentModel(state);
  const harness = currentHarness(state);
  const want = [keep, model.defaultEffort, harness.defaultEffort].find(
    (effort): effort is string => effort !== null && model.efforts.includes(effort),
  );
  state.effortIndex = want !== undefined ? model.efforts.indexOf(want) : model.efforts.length - 1;
}

function fieldOrder(state: FormState): Field[] {
  return state.worktree
    ? ["prompt", "project", "worktree", "branch", "harness", "model", "effort"]
    : ["prompt", "project", "worktree", "harness", "model", "effort"];
}

function moveFocus(state: FormState, delta: number): void {
  const order = fieldOrder(state);
  const at = Math.max(0, order.indexOf(state.focus));
  state.focus = order[(at + delta + order.length) % order.length]!;
}

function wrap(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (index + delta + length) % length;
}

function cycleValue(state: FormState, delta: number): void {
  switch (state.focus) {
    case "project":
      state.projectIndex = wrap(state.projectIndex, delta, state.projects.length);
      return;
    case "worktree":
      toggleWorktree(state);
      return;
    case "harness":
      cycleHarness(state, delta);
      return;
    case "model":
      cycleModel(state, delta);
      return;
    case "effort":
      cycleEffort(state, delta);
      return;
    default:
      return;
  }
}

/** The cascade cyclers focus their row as they change it, so a palette run
 * or a direct key shows where the change landed. */
export function cycleHarness(state: FormState, delta: number): void {
  state.focus = "harness";
  state.harnessIndex = wrap(state.harnessIndex, delta, state.harnesses.length);
  snapToHarnessDefaults(state);
}

export function cycleModel(state: FormState, delta: number): void {
  state.focus = "model";
  const keep = currentEffort(state);
  state.modelIndex = wrap(state.modelIndex, delta, currentHarness(state).models.length);
  snapEffort(state, keep);
}

export function cycleEffort(state: FormState, delta: number): void {
  state.focus = "effort";
  state.effortIndex = wrap(state.effortIndex, delta, currentModel(state).efforts.length);
}

export function toggleWorktree(state: FormState): void {
  state.worktree = !state.worktree;
  if (!state.worktree && state.focus === "branch") state.focus = "worktree";
}

export function setProject(state: FormState, index: number): void {
  if (index >= 0 && index < state.projects.length) state.projectIndex = index;
}

/** A branch name suggested from the intent, until the operator edits it. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

const BRANCH_CHARACTER = /[A-Za-z0-9._/-]/;

function editPrompt(state: FormState, edit: () => void): void {
  edit();
  if (!state.branchEdited) state.branch = slugify(state.prompt);
}

function insertIntoPrompt(state: FormState, text: string): void {
  const clean = text.replace(/[\r\n]+/g, " ");
  editPrompt(state, () => {
    state.prompt = state.prompt.slice(0, state.cursor) + clean + state.prompt.slice(state.cursor);
    state.cursor += clean.length;
  });
}

/** Printable input, as OpenTUI hands it over: a sequence with no control
 * modifier, one character from typing or many from a paste. */
function printable(key: KeyEvent): string | null {
  if (key.ctrl === true || key.meta === true) return null;
  const sequence = key.sequence ?? "";
  if (sequence.length === 0) return null;
  for (const character of sequence) {
    if (character < " " && character !== "\r" && character !== "\n") return null;
  }
  return sequence;
}

export function handleFormKey(state: FormState, key: KeyEvent): FormAction {
  if (state.phase.kind === "running") return { kind: "none" };
  if (state.phase.kind === "failed") {
    if (key.name === "return" || key.name === "enter") {
      state.phase = { kind: "form" };
      return { kind: "none" };
    }
    if (key.name === "escape" || key.name === "q") return { kind: "quit" };
    return { kind: "none" };
  }

  state.notice = null;
  const name = key.name;

  if (name === "escape") return { kind: "quit" };
  if (name === "tab") {
    moveFocus(state, key.shift === true ? -1 : 1);
    return { kind: "none" };
  }
  if (name === "backtab") {
    moveFocus(state, -1);
    return { kind: "none" };
  }
  if (name === "return" || name === "enter") {
    if (state.focus === "prompt") {
      state.focus = "project";
      return { kind: "none" };
    }
    return { kind: "launch" };
  }
  if (name === "down") {
    moveFocus(state, 1);
    return { kind: "none" };
  }
  if (name === "up") {
    moveFocus(state, -1);
    return { kind: "none" };
  }

  if (state.focus === "prompt") {
    if (name === "left") {
      state.cursor = Math.max(0, state.cursor - 1);
      return { kind: "none" };
    }
    if (name === "right") {
      state.cursor = Math.min(state.prompt.length, state.cursor + 1);
      return { kind: "none" };
    }
    if (name === "backspace") {
      if (state.cursor > 0) {
        editPrompt(state, () => {
          state.prompt = state.prompt.slice(0, state.cursor - 1) + state.prompt.slice(state.cursor);
          state.cursor -= 1;
        });
      }
      return { kind: "none" };
    }
    const text = printable(key);
    if (text !== null) insertIntoPrompt(state, text);
    return { kind: "none" };
  }

  if (state.focus === "branch") {
    if (name === "backspace") {
      state.branch = state.branch.slice(0, -1);
      state.branchEdited = true;
      return { kind: "none" };
    }
    const text = printable(key);
    if (text !== null) {
      const clean = [...text].filter((character) => BRANCH_CHARACTER.test(character)).join("");
      if (clean.length > 0) {
        state.branch += clean;
        state.branchEdited = true;
      }
      return { kind: "none" };
    }
    return { kind: "none" };
  }

  // Select rows: arrows cycle; space, and the palette's advertised letters,
  // act directly — text fields above consumed their printables already.
  if (name === "left") {
    cycleValue(state, -1);
    return { kind: "none" };
  }
  if (name === "right") {
    cycleValue(state, 1);
    return { kind: "none" };
  }
  if (key.sequence === " " || name === "space") {
    if (state.focus === "project") return { kind: "chooseProject" };
    if (state.focus === "worktree") {
      toggleWorktree(state);
      return { kind: "none" };
    }
    return { kind: "none" };
  }
  const letter = key.sequence !== undefined && key.sequence.length === 1 ? key.sequence : name;
  const backward = key.shift === true || (letter >= "A" && letter <= "Z");
  switch (letter.toLowerCase()) {
    case "p":
      return { kind: "chooseProject" };
    case "w":
      toggleWorktree(state);
      return { kind: "none" };
    case "h":
      cycleHarness(state, backward ? -1 : 1);
      return { kind: "none" };
    case "m":
      cycleModel(state, backward ? -1 : 1);
      return { kind: "none" };
    case "e":
      cycleEffort(state, backward ? -1 : 1);
      return { kind: "none" };
    default:
      return { kind: "none" };
  }
}

export interface LaunchPlan {
  project: ProjectChoice;
  worktree: boolean;
  branch: string | null;
  harness: string;
  model: string;
  effort: string;
  level: string;
  prompt: string;
}

/** Validate and freeze the launch. A refusal states itself on the form. */
export function buildPlan(state: FormState): LaunchPlan | null {
  if (state.projects.length === 0) {
    state.notice = "no projects under the configured roots";
    return null;
  }
  if (state.worktree && state.branch === "") {
    state.notice = "a worktree needs a branch name";
    state.focus = "branch";
    return null;
  }
  const model = currentModel(state);
  const effort = currentEffort(state);
  return {
    project: state.projects[state.projectIndex]!,
    worktree: state.worktree,
    branch: state.worktree ? state.branch : null,
    harness: currentHarness(state).harness,
    model: model.model,
    effort,
    level: `${model.model}:${effort}`,
    prompt: state.prompt.trim(),
  };
}

export function beginRunning(state: FormState, step: string): void {
  state.phase = { kind: "running", step };
}

export function failRun(state: FormState, message: string): void {
  state.phase = { kind: "failed", message };
}

// --- rendering ------------------------------------------------------------

const LABEL_WIDTH = 11;
const PROMPT_ROWS_MAX = 8;

function span(text: string, token: Span["token"], bold?: boolean): Span {
  return bold === true ? { text, token, bold: true } : { text, token };
}

function fit(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return GLYPHS.ellipsis;
  return `${text.slice(0, max - 1)}${GLYPHS.ellipsis}`;
}

function centered(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return `${" ".repeat(pad)}${text}`;
}

/** The intent block: an amber input rail, wrapped text, a cursor when
 * focused, and an invitation when empty. */
function promptLines(state: FormState, width: number): Line[] {
  const inner = Math.max(8, width - 4);
  const focused = state.focus === "prompt";
  if (state.prompt.length === 0) {
    return [
      [
        span(`${GLYPHS.inputRail} `, "local"),
        focused ? span(GLYPHS.cursor, "accent") : span("", "text"),
        span("describe the work", "muted"),
        span(GLYPHS.ellipsis, "muted"),
      ],
    ];
  }
  interface Row {
    text: string;
    cursorAt: number | null;
  }
  const rows: Row[] = [];
  for (let start = 0; start < state.prompt.length; start += inner) {
    const text = state.prompt.slice(start, start + inner);
    const cursorAt =
      focused && state.cursor >= start && state.cursor < start + inner
        ? state.cursor - start
        : null;
    rows.push({ text, cursorAt });
  }
  const last = rows[rows.length - 1]!;
  if (focused && state.cursor === state.prompt.length) {
    if (last.text.length >= inner) rows.push({ text: "", cursorAt: 0 });
    else last.cursorAt = last.text.length;
  }
  let visible = rows;
  if (rows.length > PROMPT_ROWS_MAX) {
    const cursorRow = Math.max(
      0,
      rows.findIndex((row) => row.cursorAt !== null),
    );
    const start = Math.min(
      Math.max(0, cursorRow - (PROMPT_ROWS_MAX - 1)),
      rows.length - PROMPT_ROWS_MAX,
    );
    visible = rows.slice(start, start + PROMPT_ROWS_MAX);
  }
  return visible.map((row) => {
    const parts: Span[] = [span(`${GLYPHS.inputRail} `, "local")];
    if (row.cursorAt === null) {
      parts.push(span(row.text, "text"));
    } else {
      parts.push(
        span(row.text.slice(0, row.cursorAt), "text"),
        span(GLYPHS.cursor, "accent"),
        span(row.text.slice(row.cursorAt), "text"),
      );
    }
    return parts;
  });
}

function fieldRow(state: FormState, field: Field, label: string, value: Span[]): Line {
  const focused = state.focus === field && state.phase.kind === "form";
  return [
    focused ? span(`${GLYPHS.rail} `, "accent") : span("  ", "text"),
    span(label.padEnd(LABEL_WIDTH), "muted"),
    ...value,
  ];
}

function selectValue(state: FormState, field: Field, value: string): Span[] {
  const focused = state.focus === field && state.phase.kind === "form";
  if (!focused) return [span(value, "text")];
  return [
    span(`${GLYPHS.prev} `, "faint"),
    span(value, "text", true),
    span(` ${GLYPHS.next}`, "faint"),
  ];
}

/** The whole screen: intent block, fact rows, and the in-body status region.
 * No identity, no help line, no pinned chrome — the form is the instrument. */
export function buildFormLines(state: FormState, width: number): Line[] {
  const lines: Line[] = [];
  lines.push(...promptLines(state, width));
  lines.push([]);

  const project = state.projects[state.projectIndex];
  const projectValue: Span[] =
    project === undefined
      ? [span("no projects found", "danger")]
      : [
          ...selectValue(state, "project", fit(project.display, width - LABEL_WIDTH - 10)),
          ...(project.count > 0 ? [span(`  ${project.count}×`, "muted")] : []),
        ];
  lines.push(fieldRow(state, "project", "project", projectValue));

  lines.push(
    fieldRow(state, "worktree", "worktree", [
      state.worktree
        ? span(`${GLYPHS.live} new worktree`, "ok")
        : span(`${GLYPHS.idle} no worktree`, "muted"),
    ]),
  );
  if (state.worktree) {
    const focused = state.focus === "branch";
    lines.push(
      fieldRow(state, "branch", "branch", [
        state.branch === ""
          ? span("branch-name", "muted")
          : span(fit(state.branch, width - LABEL_WIDTH - 6), "text"),
        ...(focused ? [span(GLYPHS.cursor, "accent")] : []),
      ]),
    );
  }
  lines.push([]);

  lines.push(
    fieldRow(
      state,
      "harness",
      "harness",
      selectValue(state, "harness", currentHarness(state).harness),
    ),
  );
  lines.push(
    fieldRow(state, "model", "model", selectValue(state, "model", currentModel(state).model)),
  );
  lines.push(
    fieldRow(state, "effort", "effort", selectValue(state, "effort", currentEffort(state))),
  );

  const status = statusLines(state, width);
  if (status.length > 0) {
    lines.push([]);
    lines.push(...status);
  }
  return lines;
}

function statusLines(state: FormState, width: number): Line[] {
  if (state.phase.kind === "running") {
    return [[span(centered(`${GLYPHS.busy} ${state.phase.step}`, width), "accent")]];
  }
  if (state.phase.kind === "failed") {
    return [
      [
        span(
          centered(fit(`FAILED ${GLYPHS.sep} ${state.phase.message}`, width - 2), width),
          "danger",
        ),
      ],
      [span(centered(`ESC QUIT ${GLYPHS.sep} ⏎ BACK`, width), "muted")],
    ];
  }
  if (state.notice !== null) {
    return [[span(centered(state.notice, width), "local")]];
  }
  return [];
}
