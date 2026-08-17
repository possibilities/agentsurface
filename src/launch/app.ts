import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLaunchCatalog } from "../catalog.ts";
import { loadConfig } from "../config.ts";
import { createHerdrCall, invoke } from "../herdr.ts";
import type { Environ } from "../paths.ts";
import { orderProjects, scanProjects } from "../projects.ts";
import {
  appendSubmitted,
  type FormDraft,
  formDraftPath,
  launchLogPath,
  readFormDraft,
  readLastLaunch,
  readLaunchCounts,
  submittedLogPath,
  writeFormDraft,
} from "../state.ts";
import { spawnDetachedLaunch } from "./executor.ts";
import {
  buildFormLines,
  buildPlan,
  type ChooseField,
  createForm,
  currentEffort,
  currentHarness,
  currentModel,
  currentPriming,
  failRun,
  handleFormKey,
  normalizeEditedIntent,
  resetForAnother,
  setEffort,
  setHarness,
  setModel,
  setPriming,
  setProject,
  toggleWorktree,
} from "./model.ts";
import { createListOverlay, type ListOverlay } from "./overlay.ts";
import { GLYPHS, type Line, SIGNAL_ROOM } from "./theme.ts";

/**
 * The launcher shell: gathers inputs, runs the form on the alternate
 * screen, and hands a committed plan to the detached executor so the popup
 * can close at once. Everything decidable without a terminal lives in
 * model.ts.
 */
interface IntentBinding {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  action: import("@opentui/core").TextareaAction;
}

/** The intent field's keymap: the widget's full default set (motions,
 * kills, selection, native undo/redo on ctrl+- and ctrl+.) with plain
 * enter submitting instead of inserting, explicit newline spellings, and
 * the classic undo aliases — C-_ as the legacy 0x1F spelling, emacs C-/. */
export function intentKeyBindings(defaults: readonly IntentBinding[]): IntentBinding[] {
  return [
    ...defaults.filter(
      (binding) =>
        !(
          (binding.name === "return" || binding.name === "kpenter") &&
          binding.shift !== true &&
          binding.action === "newline"
        ),
    ),
    { name: "return", action: "submit" },
    { name: "kpenter", action: "submit" },
    { name: "return", shift: true, action: "newline" },
    { name: "j", ctrl: true, action: "newline" },
    { name: "_", ctrl: true, action: "undo" },
    { name: "/", ctrl: true, action: "undo" },
  ];
}

export async function runLaunch(env: Environ, home: string): Promise<number> {
  // Everything fallible happens before the alternate screen, so a failure
  // prints plainly where the shell — or main's popup hold — can show it.
  const config = loadConfig(env, home);
  const harnesses = await loadLaunchCatalog(env);
  const call = createHerdrCall(env);
  await invoke(call, ["workspace", "list"]); // herdr reachability, before drawing
  const logPath = launchLogPath(env, home);
  const projects = orderProjects(scanProjects(config.roots, home), readLaunchCounts(logPath), home);

  const draftPath = formDraftPath(env, home);
  const interrupted = readFormDraft(draftPath);
  const state = createForm({
    projects,
    harnesses,
    primings: config.priming,
    cwd: await focusedCwd(call, env),
    remembered: readLastLaunch(logPath),
    draft: interrupted,
  });

  // @opentui/core is imported dynamically only — its platform-native package
  // top-level-awaits and races under parallel test isolation.
  const core = await import("@opentui/core");
  const renderer = await core.createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 30,
    autoFocus: false,
    exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
    backgroundColor: SIGNAL_ROOM.canvas,
  });

  const root = new core.BoxRenderable(renderer, {
    id: "launch-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  renderer.root.add(root);
  const frame = new core.BoxRenderable(renderer, {
    id: "launch-frame",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  // The intent block: an amber input rail beside OpenTUI's own textarea —
  // a real line editor (word motions, kills, selection, undo, paste).
  const promptRow = new core.BoxRenderable(renderer, {
    id: "launch-intent-row",
    width: "100%",
    flexDirection: "row",
    flexShrink: 0,
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  const rail = new core.TextRenderable(renderer, {
    id: "launch-intent-rail",
    content: GLYPHS.inputRail,
    fg: SIGNAL_ROOM.local,
    width: 2,
  });
  const intent = new core.TextareaRenderable(renderer, {
    id: "launch-intent",
    flexGrow: 1,
    minHeight: 1,
    height: 1,
    wrapMode: "word",
    backgroundColor: SIGNAL_ROOM.canvas,
    focusedBackgroundColor: SIGNAL_ROOM.canvas,
    textColor: SIGNAL_ROOM.text,
    focusedTextColor: SIGNAL_ROOM.text,
    cursorColor: SIGNAL_ROOM.accent,
    placeholder: `describe the work${GLYPHS.ellipsis}`,
    placeholderColor: SIGNAL_ROOM.muted,
    // Plain enter submits (the form advances); shift+enter and ctrl+j are
    // the newline spellings — ctrl+j needs its kitty spelling beside the
    // default map's legacy `linefeed`. The focused field keeps the FULL
    // readline set, ctrl+k kill-to-line-end included; the palette chord
    // applies from every other row.
    keyBindings: intentKeyBindings(core.defaultTextareaKeyBindings),
  });
  promptRow.add(rail);
  promptRow.add(intent);
  frame.add(promptRow);
  const body = new core.TextRenderable(renderer, { id: "launch-body", marginTop: 1 });
  frame.add(body);
  root.add(frame);

  const tokens = {
    panel: SIGNAL_ROOM.panel,
    line: SIGNAL_ROOM.line,
    accent: SIGNAL_ROOM.accent,
    muted: SIGNAL_ROOM.muted,
    text: SIGNAL_ROOM.text,
  };
  const commands = createListOverlay(core, renderer, "launch-commands", tokens, {
    title: " COMMANDS ",
    empty: "no matching command",
  });
  const choosers: Record<ChooseField, ListOverlay> = {
    project: createListOverlay(core, renderer, "launch-projects", tokens, {
      title: " PROJECTS ",
      empty: "no matching project",
    }),
    harness: createListOverlay(core, renderer, "launch-harnesses", tokens, {
      title: " HARNESSES ",
      empty: "no matching harness",
    }),
    model: createListOverlay(core, renderer, "launch-models", tokens, {
      title: " MODELS ",
      empty: "no matching model",
    }),
    effort: createListOverlay(core, renderer, "launch-efforts", tokens, {
      title: " EFFORTS ",
      empty: "no matching effort",
    }),
    priming: createListOverlay(core, renderer, "launch-primings", tokens, {
      title: " PRIMINGS ",
      empty: "no matching priming",
    }),
  };
  renderer.root.add(commands.root);
  for (const overlay of Object.values(choosers)) renderer.root.add(overlay.root);

  const linesToStyled = (lines: readonly Line[]): InstanceType<typeof core.StyledText> => {
    const chunks: ReturnType<typeof core.bold>[] = [];
    for (const line of lines) {
      for (const part of line) {
        if (part.text.length === 0) continue;
        let chunk = core.fg(SIGNAL_ROOM[part.token])(part.text);
        if (part.bold === true) chunk = core.bold(chunk);
        chunks.push(chunk);
      }
      chunks.push(core.fg(SIGNAL_ROOM.text)("\n"));
    }
    return new core.StyledText(chunks);
  };

  let interval: ReturnType<typeof setInterval> | null = null;
  let done!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    done = resolve;
  });
  let closed = false;
  const shutdown = (code: number): void => {
    if (closed) return;
    closed = true;
    if (interval !== null) clearInterval(interval);
    renderer.destroy();
    done(code);
  };
  process.once("SIGTERM", () => shutdown(1));
  process.once("SIGHUP", () => shutdown(1));

  const chooserItems = (field: ChooseField) => {
    switch (field) {
      case "project":
        // The launch count orders the list; it stays bookkeeping, unshown.
        return state.projects.map((project, index) => ({
          id: String(index),
          label: project.display,
          onRun: () => {
            setProject(state, index);
            paint();
          },
        }));
      case "harness":
        return state.harnesses.map((harness, index) => ({
          id: String(index),
          label: harness.harness,
          meta: `${harness.defaultModel}:${harness.defaultEffort}`,
          onRun: () => {
            setHarness(state, index);
            paint();
          },
        }));
      case "model":
        return currentHarness(state).models.map((model, index) => ({
          id: String(index),
          label: model.model,
          meta: model.efforts.join("/"),
          onRun: () => {
            setModel(state, index);
            paint();
          },
        }));
      case "effort":
        return currentModel(state).efforts.map((effort, index) => ({
          id: String(index),
          label: effort,
          onRun: () => {
            setEffort(state, index);
            paint();
          },
        }));
      case "priming":
        return state.primingOptions.map((priming, index) => ({
          id: String(index),
          label: priming,
          onRun: () => {
            setPriming(state, index);
            paint();
          },
        }));
    }
  };

  const chooserIndex = (field: ChooseField): number => {
    switch (field) {
      case "project":
        return state.projectIndex;
      case "harness":
        return state.harnessIndex;
      case "model":
        return state.modelIndex;
      case "effort":
        return state.effortIndex;
      case "priming":
        return state.primingIndex;
    }
  };

  const commandItems = () => [
    { id: "launch", key: "⏎", label: "launch", onRun: () => submitLaunch(true) },
    { id: "another", key: "A", label: "launch, then another", onRun: () => submitLaunch(false) },
    { id: "project", key: "P", label: "choose project", onRun: () => openChooser("project") },
    { id: "harness", key: "H", label: "choose harness", onRun: () => openChooser("harness") },
    { id: "model", key: "M", label: "choose model", onRun: () => openChooser("model") },
    { id: "effort", key: "E", label: "choose effort", onRun: () => openChooser("effort") },
    { id: "priming", key: "I", label: "choose priming", onRun: () => openChooser("priming") },
    {
      id: "worktree",
      key: "W",
      label: "toggle worktree",
      onRun: () => {
        toggleWorktree(state);
        paint();
      },
    },
    { id: "editor", key: "⌃G", label: "edit intent in $EDITOR", onRun: () => void editIntent() },
    { id: "quit", key: "ESC", label: "quit without launching", onRun: () => shutdown(0) },
  ];

  // The renderer routes keys and paste to the textarea exactly while it is
  // focused — the one dispatch path, which also renders the cursor. Focus
  // therefore follows the form strictly: prompt row, form phase, no overlay
  // above, no editor suspension.
  let intentFocused = false;
  let lastDraftJson = "";
  const syncIntent = (): void => {
    const overlayAbove =
      commands.isOpen() || Object.values(choosers).some((overlay) => overlay.isOpen());
    const promptFocused =
      state.focus === "prompt" && state.phase.kind === "form" && !overlayAbove && !editing;
    // lineInfo reports the native wrap layout independent of the current
    // height (virtualLineCount is viewport-capped and cannot grow it).
    const intentRows = Math.max(1, Math.min(8, intent.lineInfo.lineWraps.length));
    intent.height = intentRows;
    rail.content = Array.from({ length: intentRows }, () => GLYPHS.inputRail).join("\n");
    if (promptFocused && !intentFocused) {
      intent.focus();
      intentFocused = true;
    } else if (!promptFocused && intentFocused) {
      intent.blur();
      intentFocused = false;
    }
    // The draft file shadows the whole form on every repaint: nothing is
    // ever lost to a crash, a stray escape, or a closed popup, and capture
    // needs no dismissal hook — the current state is always already kept.
    const draft: FormDraft = {
      prompt: intent.plainText,
      project: state.projects[state.projectIndex]?.path ?? "",
      worktree: state.worktree,
      harness: currentHarness(state).harness,
      model: currentModel(state).model,
      effort: currentEffort(state),
      priming: currentPriming(state),
    };
    const serialized = JSON.stringify(draft);
    if (serialized !== lastDraftJson) {
      lastDraftJson = serialized;
      writeFormDraft(draftPath, draft);
    }
  };

  const paint = (): void => {
    const columns = process.stdout.columns ?? 80;
    const rows = renderer.height || process.stdout.rows || 24;
    const width = Math.max(36, columns - 4);
    syncIntent();
    body.content = linesToStyled(buildFormLines(state, width));
    commands.update({ width: columns, height: rows, items: commandItems() });
    for (const field of ["project", "harness", "model", "effort", "priming"] as const) {
      choosers[field].update({ width: columns, height: rows, items: chooserItems(field) });
    }
    renderer.requestRender();
  };

  // Enter submits inside the textarea; the flag tells the keypress listener
  // below that this very event was consumed, not a second enter to act on.
  let intentSubmitted = false;
  intent.onSubmit = () => {
    intentSubmitted = true;
    state.prompt = intent.plainText;
    if (state.focus === "prompt") state.focus = "project";
    paint();
  };

  // A form that survived a crash, an escape, or a closed popup comes back
  // whole and silently; createForm already re-applied its rows.
  if (interrupted !== null) {
    intent.setText(interrupted.prompt);
    state.prompt = interrupted.prompt;
  }

  const openChooser = (field: ChooseField): void => {
    paint();
    choosers[field].open(chooserIndex(field));
  };

  /** The way the harnesses do it: suspend the TUI, hand the intent to
   * $EDITOR (VISUAL first, its arguments honored through the shell), and
   * read the answer back on exit. */
  let editing = false;
  const editIntent = async (): Promise<void> => {
    if (editing || state.phase.kind !== "form") return;
    editing = true;
    const editor = env["VISUAL"] ?? env["EDITOR"] ?? "vi";
    const file = join(tmpdir(), `agentsurface-intent-${process.pid}-${Date.now()}.md`);
    let outcome: { kind: "edited"; text: string } | { kind: "unchanged" } | { kind: "unrunnable" };
    try {
      await Bun.write(file, intent.plainText);
      renderer.suspend();
      try {
        const proc = Bun.spawn(["/bin/sh", "-c", `${editor} "$1"`, "sh", file], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: env as Record<string, string>,
        });
        const code = await proc.exited;
        outcome =
          code === 0
            ? { kind: "edited", text: await Bun.file(file).text() }
            : { kind: "unchanged" };
      } finally {
        renderer.resume();
      }
    } catch {
      outcome = { kind: "unrunnable" };
    } finally {
      try {
        unlinkSync(file);
      } catch {
        // Already gone; nothing to clean.
      }
    }
    editing = false;
    if (outcome.kind === "edited") {
      intent.setText(normalizeEditedIntent(outcome.text));
      state.prompt = intent.plainText;
      state.focus = "prompt";
    } else if (outcome.kind === "unchanged") {
      state.notice = { text: "editor exited nonzero · intent unchanged", tone: "warn" };
    } else {
      state.notice = { text: `could not run ${editor}`, tone: "warn" };
    }
    paint();
  };

  /** Freeze the plan and hand it to the detached executor; the popup owes
   * the operator an immediate close (or, unfocused, the next blank form). */
  const submitLaunch = (focus: boolean): void => {
    if (state.phase.kind !== "form") return;
    state.prompt = intent.plainText;
    const plan = buildPlan(state);
    if (plan === null) {
      paint();
      return;
    }
    // The submitted plan is persisted before the spawn, and the draft
    // clears only after it: the intent is recoverable at every instant.
    appendSubmitted(submittedLogPath(env, home), { ...plan, focus });
    try {
      spawnDetachedLaunch(env, logPath, { ...plan, focus });
    } catch (error) {
      failRun(state, error instanceof Error ? error.message : String(error));
      paint();
      return;
    }
    writeFormDraft(draftPath, null);
    lastDraftJson = "";
    if (focus) {
      shutdown(0);
      return;
    }
    resetForAnother(
      state,
      `started ${plan.harness} ${GLYPHS.sep} ${plan.project.display}${plan.worktree ? ` ${GLYPHS.sep} worktree` : ""}`,
    );
    intent.setText("");
    paint();
  };

  // The focused textarea receives paste through the renderer itself; this
  // listener only repaints so height and the draft follow at once.
  renderer.keyInput.on("paste", () => {
    if (!editing) paint();
  });

  renderer.keyInput.on("keypress", (key) => {
    if (editing) return;
    // Kitty-mode terminals report key releases too; only presses act.
    if ((key as { eventType?: string }).eventType === "release") return;
    // The renderer already forwarded this event to the focused textarea; a
    // consumed enter arrives here with the focus ALREADY advanced by
    // onSubmit, so the flag keeps it from reading as a second enter.
    if (intentSubmitted) {
      intentSubmitted = false;
      return;
    }
    if (key.ctrl && key.name === "c") {
      shutdown(130);
      return;
    }
    const openOverlay = Object.values(choosers).find((overlay) => overlay.isOpen());
    if (openOverlay !== undefined) {
      openOverlay.handleKey(key);
      return;
    }
    if (commands.isOpen()) {
      if (key.ctrl && key.name === "k") {
        commands.close();
        return;
      }
      commands.handleKey(key);
      return;
    }
    // Prompt-focused, the field swallows every binding it knows — ctrl+k is
    // kill-to-line-end here, the palette's chord everywhere else. Only the
    // keys the textarea provably leaves alone are the form's.
    if (state.focus === "prompt" && state.phase.kind === "form") {
      const name = key.name;
      // Plain enter is structural too: the widget's submit skips an empty
      // field, and the intentSubmitted guard above already swallowed the
      // consumed case — this path only ever sees the unconsumed one.
      const structural =
        name === "escape" ||
        name === "tab" ||
        name === "backtab" ||
        ((name === "return" || name === "enter") && key.shift !== true) ||
        (key.ctrl === true && name === "g");
      if (!structural) {
        state.prompt = intent.plainText;
        paint();
        return;
      }
    }
    if (key.ctrl && key.name === "k") {
      commands.open();
      return;
    }
    const action = handleFormKey(state, key);
    switch (action.kind) {
      case "quit":
        shutdown(0);
        return;
      case "choose":
        openChooser(action.field);
        return;
      case "launch":
        submitLaunch(true);
        return;
      case "launchAnother":
        submitLaunch(false);
        return;
      case "editIntent":
        void editIntent();
        return;
      default:
        paint();
        return;
    }
  });

  interval = setInterval(paint, 500);
  paint();
  return await finished;
}

/** The popup does not inherit the focused pane's cwd, but herdr names the
 * pane in the spawn environment; ask it. Outside a binding, the process cwd
 * is the answer already. */
async function focusedCwd(call: ReturnType<typeof createHerdrCall>, env: Environ): Promise<string> {
  const paneId = env["HERDR_ACTIVE_PANE_ID"] ?? env["HERDR_PANE_ID"];
  if (paneId !== undefined && paneId !== "") {
    try {
      const result = (await invoke(call, ["pane", "get", paneId])) as {
        pane?: { foreground_cwd?: unknown; cwd?: unknown };
      } | null;
      const cwd = result?.pane?.foreground_cwd ?? result?.pane?.cwd;
      if (typeof cwd === "string" && cwd !== "") return cwd;
    } catch {
      // The pane may be gone; the process cwd below still answers.
    }
  }
  return process.cwd();
}
