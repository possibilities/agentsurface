import type { LaunchHarness } from "../catalog.ts";
import { type ProjectChoice, projectIndexForCwd } from "../projects.ts";
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

export type Phase = { kind: "form" } | { kind: "failed"; message: string };

/** The rows whose values are picked from a list overlay. */
export type ChooseField = "project" | "harness" | "model" | "effort";

export type FormAction =
  | { kind: "none" }
  | { kind: "quit" }
  | { kind: "launch" }
  | { kind: "launchAnother" }
  | { kind: "choose"; field: ChooseField }
  | { kind: "editIntent" };

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
  notice: { text: string; tone: "warn" | "ok" } | null;
}

/** The previous launch's cascade choices, replayed as this form's defaults. */
export interface RememberedLevel {
  harness: string;
  model: string;
  effort: string;
}

export function createForm(inputs: {
  projects: ProjectChoice[];
  harnesses: LaunchHarness[];
  /** The focused pane's cwd; preselects the project the launcher opened over. */
  cwd?: string;
  /** Applied where the catalog still allows it; catalog defaults otherwise. */
  remembered?: RememberedLevel | null;
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
  if (inputs.remembered != null) applyRemembered(state, inputs.remembered);
  if (inputs.cwd !== undefined) {
    state.projectIndex = projectIndexForCwd(state.projects, inputs.cwd);
  }
  state.focus = "prompt";
  return state;
}

/** Each dimension applies only while the previous one matched, so a renamed
 * model or a narrowed effort degrades to that level's catalog default. */
function applyRemembered(state: FormState, remembered: RememberedLevel): void {
  const harness = state.harnesses.findIndex((one) => one.harness === remembered.harness);
  if (harness < 0) return;
  setHarness(state, harness);
  const model = currentHarness(state).models.findIndex((one) => one.model === remembered.model);
  if (model < 0) return;
  setModel(state, model);
  const effort = currentModel(state).efforts.indexOf(remembered.effort);
  if (effort >= 0) setEffort(state, effort);
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
      setHarness(state, wrap(state.harnessIndex, delta, state.harnesses.length));
      return;
    case "model":
      setModel(state, wrap(state.modelIndex, delta, currentHarness(state).models.length));
      return;
    case "effort":
      setEffort(state, wrap(state.effortIndex, delta, currentModel(state).efforts.length));
      return;
    default:
      return;
  }
}

/** The picker setters focus the row they change, so the applied choice is
 * visible where it landed. Cascade snapping follows: a harness brings its
 * default model and effort; a model keeps the operator's effort when it may. */
export function setHarness(state: FormState, index: number): void {
  if (index < 0 || index >= state.harnesses.length) return;
  state.focus = "harness";
  state.harnessIndex = index;
  snapToHarnessDefaults(state);
}

export function setModel(state: FormState, index: number): void {
  if (index < 0 || index >= currentHarness(state).models.length) return;
  state.focus = "model";
  const keep = currentEffort(state);
  state.modelIndex = index;
  snapEffort(state, keep);
}

export function setEffort(state: FormState, index: number): void {
  if (index < 0 || index >= currentModel(state).efforts.length) return;
  state.focus = "effort";
  state.effortIndex = index;
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

// --- readline-style intent editing --------------------------------------

const WORD_CHARACTER = /[A-Za-z0-9_]/;

function wordLeft(text: string, at: number): number {
  let index = at;
  while (index > 0 && !WORD_CHARACTER.test(text[index - 1]!)) index -= 1;
  while (index > 0 && WORD_CHARACTER.test(text[index - 1]!)) index -= 1;
  return index;
}

function wordRight(text: string, at: number): number {
  let index = at;
  while (index < text.length && !WORD_CHARACTER.test(text[index]!)) index += 1;
  while (index < text.length && WORD_CHARACTER.test(text[index]!)) index += 1;
  return index;
}

function killIntentRange(state: FormState, from: number, to: number): void {
  if (from >= to) return;
  editPrompt(state, () => {
    state.prompt = state.prompt.slice(0, from) + state.prompt.slice(to);
    state.cursor = from;
  });
}

/** The editor's answer replaces the intent wholesale; a trailing newline is
 * the editor's punctuation, not the operator's. */
export function applyEditedIntent(state: FormState, text: string): void {
  editPrompt(state, () => {
    state.prompt = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    state.cursor = state.prompt.length;
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
  if (key.ctrl === true && name === "g") return { kind: "editIntent" };
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
    const length = state.prompt.length;
    const backspace = (): void => killIntentRange(state, state.cursor - 1, state.cursor);
    const deleteForward = (): void => killIntentRange(state, state.cursor, state.cursor + 1);
    // The readline motions the fleet's shells already teach. ctrl+c and
    // ctrl+k never arrive here — the terminal owns the interrupt and the
    // palette owns its fleet-wide chord, so kill-to-end stays unbound.
    if (key.ctrl === true) {
      switch (name) {
        case "a":
          state.cursor = 0;
          break;
        case "e":
          state.cursor = length;
          break;
        case "b":
          state.cursor = Math.max(0, state.cursor - 1);
          break;
        case "f":
          state.cursor = Math.min(length, state.cursor + 1);
          break;
        case "d":
          deleteForward();
          break;
        case "h":
          backspace();
          break;
        case "u":
          killIntentRange(state, 0, state.cursor);
          break;
        case "w":
          killIntentRange(state, wordLeft(state.prompt, state.cursor), state.cursor);
          break;
        default:
          break;
      }
      return { kind: "none" };
    }
    if (key.meta === true) {
      switch (name) {
        case "b":
          state.cursor = wordLeft(state.prompt, state.cursor);
          break;
        case "f":
          state.cursor = wordRight(state.prompt, state.cursor);
          break;
        case "d":
          killIntentRange(state, state.cursor, wordRight(state.prompt, state.cursor));
          break;
        default:
          break;
      }
      return { kind: "none" };
    }
    if (name === "left") {
      state.cursor = Math.max(0, state.cursor - 1);
      return { kind: "none" };
    }
    if (name === "right") {
      state.cursor = Math.min(length, state.cursor + 1);
      return { kind: "none" };
    }
    if (name === "home") {
      state.cursor = 0;
      return { kind: "none" };
    }
    if (name === "end") {
      state.cursor = length;
      return { kind: "none" };
    }
    if (name === "delete") {
      deleteForward();
      return { kind: "none" };
    }
    if (name === "backspace") {
      backspace();
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
    if (state.focus === "worktree") {
      toggleWorktree(state);
      return { kind: "none" };
    }
    // Text fields consumed their space above; every other row is a chooser.
    return { kind: "choose", field: state.focus };
  }
  const letter = key.sequence !== undefined && key.sequence.length === 1 ? key.sequence : name;
  switch (letter.toLowerCase()) {
    case "p":
      return { kind: "choose", field: "project" };
    case "h":
      return { kind: "choose", field: "harness" };
    case "m":
      return { kind: "choose", field: "model" };
    case "e":
      return { kind: "choose", field: "effort" };
    case "w":
      toggleWorktree(state);
      return { kind: "none" };
    case "a":
      return { kind: "launchAnother" };
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
    state.notice = { text: "no projects under the configured roots", tone: "warn" };
    return null;
  }
  if (state.worktree && state.branch === "") {
    state.notice = { text: "a worktree needs a branch name", tone: "warn" };
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

export function failRun(state: FormState, message: string): void {
  state.phase = { kind: "failed", message };
}

/** After an unfocused launch: a blank intent for the next one, with the
 * config rows keeping their choices. */
export function resetForAnother(state: FormState, message: string): void {
  state.prompt = "";
  state.cursor = 0;
  state.branch = "";
  state.branchEdited = false;
  state.focus = "prompt";
  state.phase = { kind: "form" };
  state.notice = { text: message, tone: "ok" };
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

function cursorSpan(text: string): Span {
  return { text, token: "text", cursor: true };
}

interface PromptRow {
  text: string;
  start: number;
}

/** Logical lines split on newlines (the $EDITOR path writes them), each
 * wrapped to the frame; absolute offsets keep the cursor addressable. */
function promptRowsFor(prompt: string, inner: number): PromptRow[] {
  const rows: PromptRow[] = [];
  let offset = 0;
  for (const line of prompt.split("\n")) {
    if (line.length === 0) {
      rows.push({ text: "", start: offset });
    } else {
      for (let at = 0; at < line.length; at += inner) {
        rows.push({ text: line.slice(at, at + inner), start: offset + at });
      }
    }
    offset += line.length + 1;
  }
  return rows;
}

/** The intent block: an amber input rail, wrapped text, an overlay block
 * cursor when focused — it colors its character, never displaces it — and
 * an invitation when empty. */
function promptLines(state: FormState, width: number): Line[] {
  const inner = Math.max(8, width - 4);
  const focused = state.focus === "prompt" && state.phase.kind === "form";
  if (state.prompt.length === 0) {
    const invitation: Span[] = [span(`${GLYPHS.inputRail} `, "local")];
    if (focused) invitation.push(cursorSpan(" "));
    invitation.push(span("describe the work", "muted"), span(GLYPHS.ellipsis, "muted"));
    return [invitation];
  }
  const rows = promptRowsFor(state.prompt, inner);
  // The cursor's row: at a wrap boundary the later row wins, so the cursor
  // sits where the next character will land; at a newline the earlier row
  // keeps it, at its line's end.
  let cursorRow = rows.length - 1;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const next = rows[index + 1];
    const end = row.start + row.text.length;
    if (
      state.cursor >= row.start &&
      (state.cursor < end || next === undefined || state.cursor < next.start)
    ) {
      cursorRow = index;
      break;
    }
  }
  let visible = rows;
  let visibleCursorRow = cursorRow;
  if (rows.length > PROMPT_ROWS_MAX) {
    const start = Math.min(
      Math.max(0, cursorRow - (PROMPT_ROWS_MAX - 1)),
      rows.length - PROMPT_ROWS_MAX,
    );
    visible = rows.slice(start, start + PROMPT_ROWS_MAX);
    visibleCursorRow = cursorRow - start;
  }
  return visible.map((row, index) => {
    const parts: Span[] = [span(`${GLYPHS.inputRail} `, "local")];
    if (!focused || index !== visibleCursorRow) {
      parts.push(span(row.text, "text"));
      return parts;
    }
    const column = Math.min(Math.max(0, state.cursor - row.start), row.text.length);
    parts.push(span(row.text.slice(0, column), "text"));
    parts.push(cursorSpan(row.text.slice(column, column + 1) || " "));
    parts.push(span(row.text.slice(column + 1), "text"));
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
    const focused = state.focus === "branch" && state.phase.kind === "form";
    lines.push(
      fieldRow(state, "branch", "branch", [
        state.branch === ""
          ? span("branch-name", "muted")
          : span(fit(state.branch, width - LABEL_WIDTH - 6), "text"),
        ...(focused ? [cursorSpan(" ")] : []),
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
    const tone = state.notice.tone === "ok" ? "ok" : "local";
    return [[span(centered(fit(state.notice.text, width - 2), width), tone)]];
  }
  return [];
}
