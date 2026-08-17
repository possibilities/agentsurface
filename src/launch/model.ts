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

export type Field = "prompt" | "project" | "worktree" | "harness" | "model" | "effort" | "priming";

export type Phase = { kind: "form" } | { kind: "failed"; message: string };

/** The rows whose values are picked from a list overlay. */
export type ChooseField = "project" | "harness" | "model" | "effort" | "priming";

export type FormAction =
  | { kind: "none" }
  | { kind: "quit" }
  | { kind: "launch" }
  | { kind: "launchAnother" }
  | { kind: "choose"; field: ChooseField }
  | { kind: "editIntent" };

export const PRIMING_NONE = "none";

export interface FormState {
  /** The intent, synced from the textarea when a decision needs it. */
  prompt: string;
  projects: ProjectChoice[];
  projectIndex: number;
  worktree: boolean;
  harnesses: LaunchHarness[];
  harnessIndex: number;
  modelIndex: number;
  effortIndex: number;
  /** "none" first, then the config's primings in order. */
  primingOptions: string[];
  primingIndex: number;
  focus: Field;
  phase: Phase;
  notice: { text: string; tone: "warn" | "ok" } | null;
}

/** The previous launch's cascade choices, replayed as this form's defaults. */
export interface RememberedLevel {
  harness: string;
  model: string;
  effort: string;
  /** The last launch's priming; absent in older records means none. */
  priming?: string | null;
}

/** An interrupted launcher's whole form, restored with highest precedence.
 * The prompt travels too, but the shell owns feeding it to the textarea. */
export interface FormDraftValues extends RememberedLevel {
  prompt: string;
  project: string;
  worktree: boolean;
}

export function createForm(inputs: {
  projects: ProjectChoice[];
  harnesses: LaunchHarness[];
  /** Priming choices from the config, offered beside "none". */
  primings?: string[];
  /** The focused pane's cwd; preselects the project the launcher opened over. */
  cwd?: string;
  /** Applied where the catalog still allows it; catalog defaults otherwise. */
  remembered?: RememberedLevel | null;
  /** The interrupted form, over both of the above; a submitted launch
   * cleared it, so its presence means dismissal, not history. */
  draft?: FormDraftValues | null;
}): FormState {
  const state: FormState = {
    prompt: "",
    projects: inputs.projects,
    projectIndex: 0,
    worktree: false,
    harnesses: inputs.harnesses,
    harnessIndex: 0,
    modelIndex: 0,
    effortIndex: 0,
    primingOptions: [
      PRIMING_NONE,
      ...(inputs.primings ?? []).filter(
        (priming, at, all) => priming !== PRIMING_NONE && all.indexOf(priming) === at,
      ),
    ],
    primingIndex: 0,
    focus: "prompt",
    phase: { kind: "form" },
    notice: null,
  };
  snapToHarnessDefaults(state);
  if (inputs.remembered != null) {
    applyRemembered(state, inputs.remembered);
    applyPriming(state, inputs.remembered.priming);
  }
  if (inputs.cwd !== undefined) {
    state.projectIndex = projectIndexForCwd(state.projects, inputs.cwd);
  }
  const draft = inputs.draft;
  if (draft != null) {
    applyRemembered(state, draft);
    applyPriming(state, draft.priming);
    const at = state.projects.findIndex((project) => project.path === draft.project);
    if (at >= 0) state.projectIndex = at;
    state.worktree = draft.worktree;
  }
  state.focus = "prompt";
  return state;
}

/** A remembered priming applies only while still configured; none otherwise. */
function applyPriming(state: FormState, priming: string | null | undefined): void {
  if (priming == null) return;
  const at = state.primingOptions.indexOf(priming);
  if (at >= 0) state.primingIndex = at;
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

const FIELD_ORDER: readonly Field[] = [
  "prompt",
  "project",
  "worktree",
  "harness",
  "model",
  "effort",
  "priming",
];

function moveFocus(state: FormState, delta: number): void {
  const at = Math.max(0, FIELD_ORDER.indexOf(state.focus));
  state.focus = FIELD_ORDER[(at + delta + FIELD_ORDER.length) % FIELD_ORDER.length]!;
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
    case "priming":
      setPriming(state, wrap(state.primingIndex, delta, state.primingOptions.length));
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

export function setPriming(state: FormState, index: number): void {
  if (index < 0 || index >= state.primingOptions.length) return;
  state.focus = "priming";
  state.primingIndex = index;
}

export function currentPriming(state: FormState): string {
  return state.primingOptions[state.primingIndex] ?? PRIMING_NONE;
}

export function toggleWorktree(state: FormState): void {
  state.worktree = !state.worktree;
}

export function setProject(state: FormState, index: number): void {
  if (index >= 0 && index < state.projects.length) state.projectIndex = index;
}

/** The editor's answer replaces the intent wholesale; a trailing newline is
 * the editor's punctuation, not the operator's. */
export function normalizeEditedIntent(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
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

  // Prompt-focused editing never arrives here: the shell routes those keys
  // to the intent textarea, which owns them.
  if (state.focus === "prompt") return { kind: "none" };

  // Select rows: arrows cycle; space, and the palette's advertised letters,
  // act directly — the textarea consumed its printables already.
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
    case "i":
      return { kind: "choose", field: "priming" };
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
  /** Herdr names a worktree's branch itself at creation; no name travels. */
  worktree: boolean;
  harness: string;
  model: string;
  effort: string;
  level: string;
  prompt: string;
  /** A configured skill name prefixed onto the intent by the executor —
   * /name for claude and pi, $name for codex; null when none. */
  priming: string | null;
}

/** Validate and freeze the launch. A refusal states itself on the form. */
export function buildPlan(state: FormState): LaunchPlan | null {
  if (state.projects.length === 0) {
    state.notice = { text: "no projects under the configured roots", tone: "warn" };
    return null;
  }
  const model = currentModel(state);
  const effort = currentEffort(state);
  const priming = currentPriming(state);
  return {
    project: state.projects[state.projectIndex]!,
    worktree: state.worktree,
    harness: currentHarness(state).harness,
    model: model.model,
    effort,
    level: `${model.model}:${effort}`,
    prompt: state.prompt.trim(),
    priming: priming === PRIMING_NONE ? null : priming,
  };
}

export function failRun(state: FormState, message: string): void {
  state.phase = { kind: "failed", message };
}

/** After an unfocused launch: a blank intent for the next one, with the
 * config rows keeping their choices. */
export function resetForAnother(state: FormState, message: string): void {
  state.prompt = "";
  state.focus = "prompt";
  state.phase = { kind: "form" };
  state.notice = { text: message, tone: "ok" };
}

// --- rendering ------------------------------------------------------------

const LABEL_WIDTH = 11;

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

function fieldRow(state: FormState, field: Field, label: string, value: Span[]): Line {
  const focused = state.focus === field && state.phase.kind === "form";
  return [
    focused ? span(`${GLYPHS.rail} `, "accent") : span("  ", "text"),
    span(label.padEnd(LABEL_WIDTH), "muted"),
    ...value,
  ];
}

function selectValue(
  state: FormState,
  field: Field,
  value: string,
  tone: Span["token"] = "text",
): Span[] {
  const focused = state.focus === field && state.phase.kind === "form";
  if (!focused) return [span(value, tone)];
  return [
    span(`${GLYPHS.prev} `, "faint"),
    span(value, tone, true),
    span(` ${GLYPHS.next}`, "faint"),
  ];
}

/** The whole screen: intent block, fact rows, and the in-body status region.
 * No identity, no help line, no pinned chrome — the form is the instrument. */
/** The fact rows and the in-body status region. The intent block above them
 * is the shell's textarea, not a line here. */
export function buildFormLines(state: FormState, width: number): Line[] {
  const lines: Line[] = [];

  const project = state.projects[state.projectIndex];
  const projectValue: Span[] =
    project === undefined
      ? [span("no projects found", "danger")]
      : [...selectValue(state, "project", fit(project.display, width - LABEL_WIDTH - 10))];
  lines.push(fieldRow(state, "project", "project", projectValue));

  lines.push(
    fieldRow(state, "worktree", "worktree", [
      state.worktree
        ? span(`${GLYPHS.live} new worktree`, "ok")
        : span(`${GLYPHS.idle} no worktree`, "muted"),
    ]),
  );
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
  const priming = currentPriming(state);
  lines.push(
    fieldRow(
      state,
      "priming",
      "priming",
      selectValue(state, "priming", priming, priming === PRIMING_NONE ? "muted" : "text"),
    ),
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
