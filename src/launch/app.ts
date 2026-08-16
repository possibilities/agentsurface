import { basename } from "node:path";
import { loadLaunchCatalog } from "../catalog.ts";
import { loadConfig } from "../config.ts";
import {
  createHerdrCall,
  createWorkspace,
  createWorktree,
  invoke,
  liveAgentNames,
  nextAgentName,
  startAgentWhenReady,
} from "../herdr.ts";
import type { Environ } from "../paths.ts";
import { orderProjects, scanProjects } from "../projects.ts";
import { appendLaunch, launchLogPath, readLaunchCounts } from "../state.ts";
import {
  beginRunning,
  buildFormLines,
  buildPlan,
  createForm,
  cycleEffort,
  cycleHarness,
  cycleModel,
  failRun,
  handleFormKey,
  setProject,
  toggleWorktree,
} from "./model.ts";
import { createListOverlay } from "./overlay.ts";
import { type Line, SIGNAL_ROOM } from "./theme.ts";

/**
 * The launcher shell: gathers inputs, runs the form on the alternate
 * screen, and executes the launch through herdr when the form commits.
 * Everything decidable without a terminal lives in model.ts.
 */
export async function runLaunch(env: Environ, home: string): Promise<number> {
  // Everything fallible happens before the alternate screen, so a failure
  // prints plainly where the shell — or main's popup hold — can show it.
  const config = loadConfig(env, home);
  const harnesses = await loadLaunchCatalog(env);
  const call = createHerdrCall(env);
  await invoke(call, ["workspace", "list"]); // herdr reachability, before drawing
  const logPath = launchLogPath(env, home);
  const projects = orderProjects(scanProjects(config.roots, home), readLaunchCounts(logPath), home);

  const state = createForm({ projects, harnesses });

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
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  const body = new core.TextRenderable(renderer, { id: "launch-body" });
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
  const picker = createListOverlay(core, renderer, "launch-projects", tokens, {
    title: " PROJECTS ",
    empty: "no matching project",
  });
  renderer.root.add(commands.root);
  renderer.root.add(picker.root);

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

  const projectItems = () =>
    state.projects.map((project, index) => ({
      id: String(index),
      label: project.display,
      ...(project.count > 0 ? { meta: `${project.count}×` } : {}),
      onRun: () => {
        setProject(state, index);
        paint();
      },
    }));

  const commandItems = () => [
    { id: "launch", key: "⏎", label: "launch", onRun: () => void launchNow() },
    { id: "project", key: "P", label: "choose project", onRun: () => picker.open() },
    {
      id: "worktree",
      key: "W",
      label: "toggle worktree",
      onRun: () => {
        toggleWorktree(state);
        paint();
      },
    },
    ...(
      [
        ["harness", "H", cycleHarness],
        ["model", "M", cycleModel],
        ["effort", "E", cycleEffort],
      ] as const
    ).flatMap(([field, letter, cycle]) => [
      {
        id: `${field}-next`,
        key: letter,
        label: `next ${field}`,
        onRun: () => {
          cycle(state, 1);
          paint();
        },
      },
      {
        id: `${field}-previous`,
        key: `⇧${letter}`,
        label: `previous ${field}`,
        onRun: () => {
          cycle(state, -1);
          paint();
        },
      },
    ]),
    { id: "quit", key: "ESC", label: "quit without launching", onRun: () => shutdown(0) },
  ];

  const paint = (): void => {
    const columns = process.stdout.columns ?? 80;
    const rows = renderer.height || process.stdout.rows || 24;
    const width = Math.max(36, Math.min(columns - 4, 96));
    body.content = linesToStyled(buildFormLines(state, width));
    commands.update({ width: columns, height: rows, items: commandItems() });
    picker.update({ width: columns, height: rows, items: projectItems() });
    renderer.requestRender();
  };

  const launchNow = async (): Promise<void> => {
    if (state.phase.kind !== "form") return;
    const plan = buildPlan(state);
    if (plan === null) {
      paint();
      return;
    }
    try {
      beginRunning(state, plan.worktree ? "CREATING WORKTREE" : "CREATING WORKSPACE");
      paint();
      const surface = plan.worktree
        ? await createWorktree(call, { cwd: plan.project.path, branch: plan.branch! })
        : await createWorkspace(call, {
            cwd: plan.project.path,
            label: basename(plan.project.path),
          });
      const name = nextAgentName(plan.harness, await liveAgentNames(call));
      beginRunning(state, `STARTING ${name.toUpperCase()}`);
      paint();
      // The intent rides the launch as a native positional token: the shim
      // hands it to the harness, which queues it behind any startup dialog
      // (folder trust, first run) and submits it once the dialog clears. A
      // post-start `agent prompt` would instead be refused while blocked.
      await startAgentWhenReady(call, {
        name,
        kind: plan.harness,
        paneId: surface.paneId,
        agentArgs: ["--x-level", plan.level, ...(plan.prompt === "" ? [] : [plan.prompt])],
      });
      appendLaunch(logPath, {
        at: new Date().toISOString(),
        project: plan.project.path,
        harness: plan.harness,
        model: plan.model,
        effort: plan.effort,
        worktree: plan.worktree,
        branch: plan.branch,
        workspace: surface.workspaceId,
        agent: name,
      });
      shutdown(0);
    } catch (error) {
      failRun(state, error instanceof Error ? error.message : String(error));
      paint();
    }
  };

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") {
      shutdown(130);
      return;
    }
    if (picker.isOpen()) {
      picker.handleKey(key);
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
    if (key.ctrl && key.name === "k") {
      commands.open();
      return;
    }
    const action = handleFormKey(state, key);
    if (action.kind === "quit") {
      shutdown(0);
      return;
    }
    if (action.kind === "chooseProject") {
      paint();
      picker.open();
      return;
    }
    if (action.kind === "launch") {
      void launchNow();
      return;
    }
    paint();
  });

  interval = setInterval(paint, 500);
  paint();
  return await finished;
}
