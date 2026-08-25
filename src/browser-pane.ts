import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./errors.ts";
import { createHerdrCall, type HerdrCall, invoke } from "./herdr.ts";
import type { Environ } from "./paths.ts";
import { stateDirectory } from "./paths.ts";

/**
 * The browser pane: agentweb's headed browsers, watched and handed over from
 * inside herdr. Agentweb parks every headed window out of sight; this pane
 * asks the daemon to dock one over its own screen rectangle — the real Chrome
 * window, placed, never a mirror — and parks it again when the operator is
 * done. When an agent requests attention, the pane attends the item, docks
 * the window with focus, and one key releases it. Nothing typed into the
 * window crosses agentsurface or agentweb.
 *
 * The bottom rows of the pane stay uncovered as the readout: which browser is
 * docked, why, and the two keys that end it. The rest of the surface, when
 * nothing is docked, lists the daemon's browsers and open attention items.
 */

/* ------------------------------------------------------------------------ */
/* Model                                                                     */
/* ------------------------------------------------------------------------ */

export interface BrowserRow {
  browserRef: string;
  environmentId: "E1" | "E2";
  state: string;
  currentOrigin: string | null;
  jobId: string;
  createdAt: number;
}

export interface AttentionRow {
  attentionId: string;
  browserRef: string;
  state: string;
  reasonCode: string;
  requestedAction: string;
  origin: string;
  deadlineAt: number;
}

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Geometry {
  /** The pane's rectangle in outer-terminal cells. */
  rect: PaneRect;
  cellWidth: number;
  cellHeight: number;
  /** The outer terminal window's origin on screen. */
  originX: number;
  originY: number;
  /** The Space the outer terminal window is on; the window docks there, not wherever focus is. */
  space: number | null;
  visible: boolean;
}

export type DockMode = "observe" | "attend";

export interface Docked {
  browserRef: string;
  mode: DockMode;
  attentionId: string | null;
  capabilityFile: string | null;
  /** Parked because the pane is hidden; re-docked when it shows again. */
  hidden: boolean;
}

export interface Palette {
  filter: string;
  selected: number;
}

export interface PaneModel {
  browsers: BrowserRow[];
  attention: AttentionRow[];
  selected: number;
  docked: Docked | null;
  palette: Palette | null;
  notice: string | null;
  geometry: Geometry | null;
}

export type Action =
  | { kind: "dock"; browserRef: string; mode: DockMode; attentionId: string | null }
  | { kind: "park"; browserRef: string }
  | { kind: "release" }
  | { kind: "quit" }
  | { kind: "none" };

export interface Command {
  key: string;
  label: string;
  action: Action["kind"] | "up" | "down";
}

/** Rows kept clear under a docked window: the readout the operator can still read. */
export const READOUT_ROWS = 2;

export function initialModel(): PaneModel {
  return {
    browsers: [],
    attention: [],
    selected: 0,
    docked: null,
    palette: null,
    notice: null,
    geometry: null,
  };
}

/** Headed browsers first, newest first; headless browsers are listed but inert. */
export function orderedBrowsers(browsers: BrowserRow[]): BrowserRow[] {
  return [...browsers]
    .filter((browser) => browser.state !== "CLOSED")
    .sort((a, b) => {
      if (a.environmentId !== b.environmentId) return a.environmentId === "E2" ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
}

export function openAttention(model: PaneModel): AttentionRow[] {
  return model.attention.filter((item) =>
    ["QUEUED", "CLAIMED", "HUMAN_ACTIVE"].includes(item.state),
  );
}

/** The attention item an operator should be handling for a browser, if any. */
export function pendingAttention(model: PaneModel, browserRef: string): AttentionRow | null {
  return (
    openAttention(model).find(
      (item) => item.browserRef === browserRef && item.state === "QUEUED",
    ) ?? null
  );
}

export function selectedBrowser(model: PaneModel): BrowserRow | null {
  const rows = orderedBrowsers(model.browsers);
  return rows[Math.min(model.selected, Math.max(0, rows.length - 1))] ?? null;
}

export const COMMANDS: Command[] = [
  { key: "enter", label: "dock the selected browser and watch it", action: "dock" },
  { key: "a", label: "attend the selected browser's attention item", action: "dock" },
  { key: "r", label: "release the attended browser back to its agent", action: "release" },
  { key: "p", label: "park the docked browser out of sight", action: "park" },
  { key: "j", label: "select the next browser", action: "down" },
  { key: "k", label: "select the previous browser", action: "up" },
  { key: "q", label: "quit, parking any docked browser", action: "quit" },
];

export function paletteRows(filter: string): Command[] {
  const needle = filter.toLowerCase();
  return COMMANDS.filter(
    (command) =>
      needle === "" ||
      command.label.toLowerCase().includes(needle) ||
      command.key.toLowerCase().includes(needle),
  );
}

/** Keys arrive raw; the pane treats ctrl+c as the terminal's, never its own. */
export function reduceKey(model: PaneModel, key: string): { model: PaneModel; action: Action } {
  const none: Action = { kind: "none" };
  if (key === "") return { model, action: { kind: "quit" } };

  if (model.palette) {
    const palette = model.palette;
    const rows = paletteRows(palette.filter);
    if (key === "" || key === "") return { model: { ...model, palette: null }, action: none };
    if (key === "[A" || key === "")
      return {
        model: { ...model, palette: { ...palette, selected: Math.max(0, palette.selected - 1) } },
        action: none,
      };
    if (key === "[B" || key === "")
      return {
        model: {
          ...model,
          palette: { ...palette, selected: Math.min(rows.length - 1, palette.selected + 1) },
        },
        action: none,
      };
    if (key === "" || key === "\b")
      return {
        model: { ...model, palette: { filter: palette.filter.slice(0, -1), selected: 0 } },
        action: none,
      };
    if (key === "\r" || key === "\n") {
      const chosen = rows[Math.min(palette.selected, rows.length - 1)];
      const closed = { ...model, palette: null };
      if (!chosen) return { model: closed, action: none };
      return runCommand(closed, chosen);
    }
    if (key.length === 1 && key >= " ")
      return {
        model: { ...model, palette: { filter: palette.filter + key, selected: 0 } },
        action: none,
      };
    return { model, action: none };
  }

  if (key === "")
    return { model: { ...model, palette: { filter: "", selected: 0 } }, action: none };
  const command = COMMANDS.find(
    (entry) =>
      entry.key === key ||
      (entry.key === "enter" && (key === "\r" || key === "\n")) ||
      (entry.action === "down" && key === "[B") ||
      (entry.action === "up" && key === "[A"),
  );
  if (!command) return { model, action: none };
  return runCommand(model, command);
}

function runCommand(model: PaneModel, command: Command): { model: PaneModel; action: Action } {
  const none: Action = { kind: "none" };
  const rows = orderedBrowsers(model.browsers);
  switch (command.action) {
    case "up":
      return { model: { ...model, selected: Math.max(0, model.selected - 1) }, action: none };
    case "down":
      return {
        model: { ...model, selected: Math.min(Math.max(0, rows.length - 1), model.selected + 1) },
        action: none,
      };
    case "quit":
      return { model, action: { kind: "quit" } };
    case "park":
      if (!model.docked) return { model: withNotice(model, "nothing is docked"), action: none };
      return { model, action: { kind: "park", browserRef: model.docked.browserRef } };
    case "release":
      if (model.docked?.mode !== "attend")
        return { model: withNotice(model, "nothing is being attended"), action: none };
      return { model, action: { kind: "release" } };
    case "dock": {
      const browser = selectedBrowser(model);
      if (!browser) return { model: withNotice(model, "no browser to dock"), action: none };
      if (browser.environmentId !== "E2")
        return {
          model: withNotice(model, `${shortRef(browser.browserRef)} is headless: no window`),
          action: none,
        };
      const attending = command.key === "a";
      const item = pendingAttention(model, browser.browserRef);
      if (attending && !item)
        return {
          model: withNotice(model, `${shortRef(browser.browserRef)} has no attention item`),
          action: none,
        };
      return {
        model,
        action: {
          kind: "dock",
          browserRef: browser.browserRef,
          mode: attending ? "attend" : "observe",
          attentionId: attending && item ? item.attentionId : null,
        },
      };
    }
    default:
      return { model, action: none };
  }
}

export function withNotice(model: PaneModel, notice: string): PaneModel {
  return { ...model, notice };
}

export function shortRef(browserRef: string): string {
  return browserRef.length > 12 ? `${browserRef.slice(0, 12)}…` : browserRef;
}

/** A docked window covers the pane except its readout rows. */
export function dockFrame(geometry: Geometry): ScreenFrame {
  const rows = Math.max(1, geometry.rect.height - READOUT_ROWS);
  return {
    x: geometry.originX + geometry.rect.x * geometry.cellWidth,
    y: geometry.originY + geometry.rect.y * geometry.cellHeight,
    width: Math.max(1, geometry.rect.width * geometry.cellWidth),
    height: Math.max(1, rows * geometry.cellHeight),
  };
}

export function sameFrame(a: ScreenFrame | null, b: ScreenFrame | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/* ------------------------------------------------------------------------ */
/* Render                                                                    */
/* ------------------------------------------------------------------------ */

const CLEAR = "[2J[H";
const HIDE_CURSOR = "[?25l";
const SHOW_CURSOR = "[?25h";
const RESET = "[0m";
const BOLD = "[1m";
const DIM = "[2m";
const ACCENT = "[36m";
const WARN = "[33m";

function moveTo(row: number, col: number): string {
  return `[${row};${col}H`;
}

function clip(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function stateWord(browser: BrowserRow, docked: Docked | null): string {
  if (docked?.browserRef === browser.browserRef)
    return docked.mode === "attend" ? "attending" : "docked";
  switch (browser.state) {
    case "AGENT_ACTIVE":
      return "agent driving";
    case "QUIESCING":
      return "quiescing";
    case "HUMAN_ACTIVE":
      return "human active";
    case "READY_FOR_AGENT":
      return "ready";
    case "STOPPED":
      return "stopped";
    default:
      return browser.state.toLowerCase();
  }
}

function deadline(item: AttentionRow, now: number): string {
  const left = Math.max(0, item.deadlineAt - now);
  const minutes = Math.floor(left / 60_000);
  return minutes >= 1 ? `${minutes}m left` : `${Math.floor(left / 1000)}s left`;
}

export function render(model: PaneModel, columns: number, rows: number, now: number): string {
  const out: string[] = [CLEAR];
  const width = Math.max(10, columns);
  const readoutTop = Math.max(1, rows - READOUT_ROWS + 1);

  if (!model.docked) {
    const list = orderedBrowsers(model.browsers);
    const open = openAttention(model);
    let row = 1;
    if (list.length === 0) {
      const line = "no agentweb browsers";
      out.push(
        moveTo(
          Math.max(1, Math.floor(rows / 2)),
          Math.max(1, Math.floor((width - line.length) / 2)),
        ),
      );
      out.push(`${DIM}${line}${RESET}`);
    }
    for (const [index, browser] of list.entries()) {
      if (row >= readoutTop) break;
      const selected = index === Math.min(model.selected, list.length - 1);
      const rail = selected ? `${ACCENT}▎${RESET}` : " ";
      const item = pendingAttention(model, browser.browserRef);
      const label = `${shortRef(browser.browserRef)}  ${browser.environmentId}  ${stateWord(browser, model.docked)}  ${browser.currentOrigin ?? ""}`;
      const tone = selected ? BOLD : "";
      out.push(moveTo(row, 1), rail, tone, clip(label, width - 2), RESET);
      row += 1;
      if (item && row < readoutTop) {
        const text = `   ${WARN}${item.reasonCode}${RESET} ${clip(item.requestedAction, width - 24)} ${DIM}${deadline(item, now)}${RESET}`;
        out.push(moveTo(row, 1), text);
        row += 1;
      }
    }
    if (open.length > 0 && row < readoutTop) {
      const strays = open.filter(
        (item) => !list.some((browser) => browser.browserRef === item.browserRef),
      );
      for (const item of strays) {
        if (row >= readoutTop) break;
        out.push(
          moveTo(row, 1),
          `   ${DIM}${item.attentionId} ${item.state} ${clip(item.requestedAction, width - 40)}${RESET}`,
        );
        row += 1;
      }
    }
  }

  // The readout: the rows a docked window never covers.
  const readout: string[] = [];
  if (model.docked) {
    const browser = model.browsers.find((entry) => entry.browserRef === model.docked?.browserRef);
    const item = model.docked.attentionId
      ? model.attention.find((entry) => entry.attentionId === model.docked?.attentionId)
      : null;
    const head =
      model.docked.mode === "attend"
        ? `${ACCENT}▎${RESET}${BOLD}${shortRef(model.docked.browserRef)}${RESET} attending${item ? ` · ${WARN}${item.reasonCode}${RESET} ${deadline(item, now)}` : ""}${model.docked.hidden ? ` ${DIM}(pane hidden — parked)${RESET}` : ""}`
        : `${ACCENT}▎${RESET}${BOLD}${shortRef(model.docked.browserRef)}${RESET} docked · ${DIM}live window, clicks reach the site${RESET}${model.docked.hidden ? ` ${DIM}(pane hidden — parked)${RESET}` : ""}`;
    readout.push(clip(head, width + 40));
    const action = item?.requestedAction ?? browser?.currentOrigin ?? "";
    const keys =
      model.docked.mode === "attend"
        ? `${BOLD}r${RESET} release  ${BOLD}p${RESET} park`
        : `${BOLD}p${RESET} park`;
    readout.push(`${clip(action, Math.max(0, width - 20))}  ${keys}`);
  } else if (model.notice) {
    readout.push(`${WARN}${clip(model.notice, width)}${RESET}`);
  }
  for (const [index, line] of readout.entries()) out.push(moveTo(readoutTop + index, 1), line);

  if (model.palette) {
    const entries = paletteRows(model.palette.filter);
    const boxWidth = Math.min(width - 2, 56);
    const boxHeight = Math.min(rows - 2, entries.length + 3);
    const top = Math.max(1, Math.floor((rows - boxHeight) / 2));
    const left = Math.max(1, Math.floor((width - boxWidth) / 2));
    const border = "─".repeat(boxWidth - 2);
    out.push(moveTo(top, left), `┌${border}┐`);
    out.push(
      moveTo(top + 1, left),
      `│ ${clip(`› ${model.palette.filter}`, boxWidth - 4).padEnd(boxWidth - 4)} │`,
    );
    const visible = entries.slice(0, boxHeight - 3);
    for (const [index, command] of visible.entries()) {
      const selected = index === Math.min(model.palette.selected, visible.length - 1);
      const rail = selected ? `${ACCENT}▎${RESET}` : " ";
      const text = `${rail}${BOLD}${ACCENT}[${command.key}]${RESET} ${selected ? "" : DIM}${command.label}${RESET}`;
      out.push(
        moveTo(top + 2 + index, left),
        `│${clip(text, boxWidth - 2 + 24).padEnd(boxWidth - 2)}│`,
      );
    }
    out.push(moveTo(top + boxHeight - 1, left), `└${border}┘`);
  }
  return out.join("");
}

/* ------------------------------------------------------------------------ */
/* Effects: agentweb, herdr, yabai                                           */
/* ------------------------------------------------------------------------ */

export type Runner = (
  argv: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export async function runProcess(
  argv: string[],
  env: Environ,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    });
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: (error as Error).message };
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

/** Where agentweb lives: an override for a checkout under test, else PATH. */
export function agentwebArgv(env: Environ): string[] {
  const override = env["AGENTSURFACE_AGENTWEB"];
  if (override !== undefined && override !== "") return override.split(" ").filter(Boolean);
  return ["agentweb"];
}

export class Agentweb {
  constructor(
    private readonly run: Runner,
    private readonly env: Environ,
    private readonly home: string,
  ) {}

  private async json<T>(args: string[], role?: "operator"): Promise<T> {
    const argv = [...agentwebArgv(this.env), ...args, "--json"];
    if (role === "operator") argv.push("--credential-file", this.operatorToken());
    const result = await this.run(argv);
    const text = result.stdout.trim() || result.stderr.trim();
    let envelope: { ok?: boolean; data?: T; error?: { code?: string; message?: string } };
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new CliError(
        "agentweb_unreadable",
        `agentweb ${args[0]} ${args[1] ?? ""}: ${clip(text, 200) || `exit ${result.exitCode}`}`,
      );
    }
    if (!envelope.ok) {
      throw new CliError(
        envelope.error?.code ?? "agentweb_failed",
        envelope.error?.message ?? `agentweb ${args.join(" ")} failed`,
      );
    }
    return envelope.data as T;
  }

  private operatorToken(): string {
    const stateRoot =
      this.env["AGENTWEB_STATE_DIR"] ??
      join(this.env["XDG_STATE_HOME"] ?? join(this.home, ".local", "state"), "agentweb");
    return join(stateRoot, "operator-token");
  }

  listBrowsers(): Promise<BrowserRow[]> {
    return this.json<BrowserRow[]>(["browser", "list"], "operator");
  }

  listAttention(): Promise<AttentionRow[]> {
    return this.json<AttentionRow[]>(["attention", "list"]);
  }

  dock(
    browserRef: string,
    frame: ScreenFrame,
    focus: boolean,
    space: number | null,
  ): Promise<unknown> {
    return this.json([
      "browser",
      "window",
      "dock",
      browserRef,
      "--x",
      String(frame.x),
      "--y",
      String(frame.y),
      "--width",
      String(frame.width),
      "--height",
      String(frame.height),
      ...(space === null ? [] : ["--space", String(space)]),
      ...(focus ? ["--focus"] : []),
    ]);
  }

  park(browserRef: string): Promise<unknown> {
    return this.json(["browser", "window", "park", browserRef]);
  }

  async attend(attentionId: string): Promise<string> {
    const directory = join(stateDirectory(this.env, this.home, "agentsurface"), "attention");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `human-${attentionId}.capability`);
    await this.json(["attention", "attend", attentionId, "--capability-out", file]);
    return file;
  }

  async release(attentionId: string, capabilityFile: string): Promise<void> {
    await this.json(["attention", "release", attentionId, "--capability-file", capabilityFile]);
  }
}

interface HerdrGraphicsInfo {
  cell_width_px?: number;
  cell_height_px?: number;
  pane_visible?: boolean;
}

/** One request over herdr's socket: a JSON line in, the first JSON line out. */
export function herdrSocketRequest(
  socketPath: string,
  request: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new Error("herdr socket timed out"))), 3000);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(socket, data) {
          buffer += data.toString();
          const at = buffer.indexOf("\n");
          if (at < 0) return;
          clearTimeout(timer);
          try {
            settle(() => resolve(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>));
          } catch (error) {
            settle(() => reject(error));
          }
          socket.end();
        },
        error(_socket, error) {
          clearTimeout(timer);
          settle(() => reject(error));
        },
        close() {
          clearTimeout(timer);
          settle(() => reject(new Error("herdr socket closed")));
        },
      },
    }).catch((error) => {
      clearTimeout(timer);
      settle(() => reject(error));
    });
  });
}

export interface GeometrySources {
  herdr: HerdrCall;
  socket: (request: unknown) => Promise<Record<string, unknown>>;
  yabai: Runner;
  paneId: string;
  /** The outer terminal's pid when the environment names it (Ghostty does not, today). */
  hostPid: number | null;
}

/** The pane's own screen rectangle: herdr's cell rect, the client's cell size, the outer window's origin. */
export async function readGeometry(sources: GeometrySources): Promise<Geometry> {
  const layout = (await invoke(sources.herdr, ["pane", "layout", "--pane", sources.paneId])) as {
    layout?: { panes?: Array<{ pane_id?: string; rect?: PaneRect }> };
  } | null;
  const pane = layout?.layout?.panes?.find((entry) => entry.pane_id === sources.paneId);
  if (!pane?.rect)
    throw new CliError("pane_not_in_layout", `herdr does not place pane ${sources.paneId}`);

  const info = await sources.socket({
    id: "graphics",
    method: "pane.graphics.info",
    params: { pane_id: sources.paneId },
  });
  const result = (info["result"] ?? {}) as HerdrGraphicsInfo;
  const cellWidth = result.cell_width_px;
  const cellHeight = result.cell_height_px;
  if (typeof cellWidth !== "number" || typeof cellHeight !== "number")
    throw new CliError(
      "cell_size_unknown",
      "herdr did not report a cell size; enable [experimental] kitty_graphics = true and reload",
    );

  const windows = await sources.yabai(["yabai", "-m", "query", "--windows"]);
  const host = hostTerminalWindow(windows.stdout, sources.hostPid);
  return {
    rect: pane.rect,
    cellWidth,
    cellHeight,
    originX: host?.x ?? 0,
    originY: host?.y ?? 0,
    space: host?.space ?? null,
    visible: result.pane_visible !== false,
  };
}

/**
 * The outer terminal window hosting this pane, from yabai's window list: by
 * the terminal's pid when the environment names one, else the focused
 * terminal window, else the visible one. Without yabai the terminal is taken
 * to sit at the screen origin on an unknown Space.
 */
export function hostTerminalWindow(
  yabaiWindowsJson: string,
  hostPid: number | null,
): { x: number; y: number; space: number | null } | null {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = JSON.parse(yabaiWindowsJson || "[]") as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
  const terminals = rows.filter((row) => TERMINAL_APPS.has(String(row["app"] ?? "")));
  const byPid =
    hostPid === null
      ? undefined
      : (terminals.find((row) => row["pid"] === hostPid && row["is-visible"] === true) ??
        terminals.find((row) => row["pid"] === hostPid));
  const host =
    byPid ??
    terminals.find((row) => row["has-focus"] === true) ??
    terminals.find((row) => row["is-visible"] === true) ??
    terminals[0];
  if (!host) return null;
  const frame = (host["frame"] ?? {}) as Record<string, unknown>;
  return {
    x: typeof frame["x"] === "number" ? Math.round(frame["x"]) : 0,
    y: typeof frame["y"] === "number" ? Math.round(frame["y"]) : 0,
    space: typeof host["space"] === "number" ? host["space"] : null,
  };
}

const TERMINAL_APPS = new Set(["Ghostty", "kitty", "WezTerm", "iTerm2", "Terminal"]);

/* ------------------------------------------------------------------------ */
/* Runtime loop                                                              */
/* ------------------------------------------------------------------------ */

export interface PaneTerminal {
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
  write(text: string): void;
  setRawMode(enabled: boolean): void;
  onKey(handler: (key: string) => void): () => void;
  onResize(handler: () => void): () => void;
}

export function processPaneTerminal(): PaneTerminal {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    get columns() {
      return process.stdout.columns ?? 80;
    },
    get rows() {
      return process.stdout.rows ?? 24;
    },
    write(text) {
      process.stdout.write(text);
    },
    setRawMode(enabled) {
      process.stdin.setRawMode(enabled);
      if (enabled) process.stdin.resume();
      else process.stdin.pause();
    },
    onKey(handler) {
      const listener = (chunk: Buffer): void => handler(chunk.toString("utf8"));
      process.stdin.on("data", listener);
      return () => process.stdin.off("data", listener);
    },
    onResize(handler) {
      process.stdout.on("resize", handler);
      return () => process.stdout.off("resize", handler);
    },
  };
}

export interface PaneDependencies {
  agentweb: Agentweb;
  geometry: () => Promise<Geometry>;
  terminal: PaneTerminal;
  now: () => number;
  pollMs?: number;
}

/**
 * The loop: poll the daemon and the pane's geometry, keep the docked window
 * on the pane, attend attention as it arrives, and answer keys. Every effect
 * is one agentweb command; failures land on the readout, never in the loop.
 */
export class BrowserPane {
  private model = initialModel();
  private lastFrame: ScreenFrame | null = null;
  private stopped = false;
  private busy = false;

  constructor(private readonly deps: PaneDependencies) {}

  get state(): PaneModel {
    return this.model;
  }

  async run(): Promise<number> {
    const { terminal } = this.deps;
    if (!terminal.isTTY)
      throw new CliError("pane_requires_tty", "the browser pane needs an interactive terminal");
    terminal.setRawMode(true);
    terminal.write(HIDE_CURSOR);
    const offKey = terminal.onKey((key) => void this.handleKey(key));
    const offResize = terminal.onResize(() => this.draw());
    try {
      await this.tick();
      while (!this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? 1000));
        if (this.stopped) break;
        await this.tick();
      }
      return 0;
    } finally {
      offKey();
      offResize();
      await this.parkDocked();
      terminal.write(`${RESET}${SHOW_CURSOR}${CLEAR}`);
      terminal.setRawMode(false);
    }
  }

  /** One pass: refresh state, keep the docked window placed, attend what is queued. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.refresh();
      await this.followGeometry();
      await this.autoAttend();
      this.draw();
    } finally {
      this.busy = false;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const [browsers, attention, geometry] = await Promise.all([
        this.deps.agentweb.listBrowsers(),
        this.deps.agentweb.listAttention(),
        this.deps.geometry(),
      ]);
      this.model = { ...this.model, browsers, attention, geometry };
      if (
        this.model.docked &&
        !browsers.some(
          (b) => b.browserRef === this.model.docked?.browserRef && b.state !== "CLOSED",
        )
      ) {
        this.model = {
          ...withNotice(this.model, `${shortRef(this.model.docked.browserRef)} closed`),
          docked: null,
        };
        this.lastFrame = null;
      }
    } catch (error) {
      this.model = withNotice(this.model, (error as Error).message);
    }
  }

  /** The window follows the pane: re-placed on resize, parked while hidden, back when shown. */
  private async followGeometry(): Promise<void> {
    const docked = this.model.docked;
    const geometry = this.model.geometry;
    if (!docked || !geometry) return;
    try {
      if (!geometry.visible) {
        if (!docked.hidden) {
          await this.deps.agentweb.park(docked.browserRef);
          this.model = { ...this.model, docked: { ...docked, hidden: true } };
          this.lastFrame = null;
        }
        return;
      }
      const frame = dockFrame(geometry);
      if (docked.hidden || !sameFrame(frame, this.lastFrame)) {
        await this.deps.agentweb.dock(
          docked.browserRef,
          frame,
          docked.hidden && docked.mode === "attend",
          geometry.space,
        );
        this.lastFrame = frame;
        if (docked.hidden) this.model = { ...this.model, docked: { ...docked, hidden: false } };
      }
    } catch (error) {
      this.model = withNotice(this.model, (error as Error).message);
    }
  }

  /** A queued attention item on a headed browser is the pane's reason to exist: attend and dock it. */
  private async autoAttend(): Promise<void> {
    if (this.model.docked?.mode === "attend") return;
    const queued = openAttention(this.model).find((item) => item.state === "QUEUED");
    if (!queued) return;
    const browser = this.model.browsers.find((entry) => entry.browserRef === queued.browserRef);
    if (browser?.environmentId !== "E2") return;
    await this.dock(queued.browserRef, "attend", queued.attentionId);
  }

  private async dock(
    browserRef: string,
    mode: DockMode,
    attentionId: string | null,
  ): Promise<void> {
    const geometry = this.model.geometry;
    if (!geometry) {
      this.model = withNotice(this.model, "pane geometry unknown");
      return;
    }
    try {
      if (this.model.docked && this.model.docked.browserRef !== browserRef) await this.parkDocked();
      let capabilityFile: string | null = null;
      if (mode === "attend" && attentionId)
        capabilityFile = await this.deps.agentweb.attend(attentionId);
      const frame = dockFrame(geometry);
      await this.deps.agentweb.dock(
        browserRef,
        frame,
        mode === "attend" && geometry.visible,
        geometry.space,
      );
      this.lastFrame = frame;
      this.model = {
        ...this.model,
        notice: null,
        docked: { browserRef, mode, attentionId, capabilityFile, hidden: !geometry.visible },
      };
    } catch (error) {
      this.model = withNotice(this.model, (error as Error).message);
    }
  }

  private async parkDocked(): Promise<void> {
    const docked = this.model.docked;
    if (!docked) return;
    try {
      await this.deps.agentweb.park(docked.browserRef);
    } catch (error) {
      this.model = withNotice(this.model, (error as Error).message);
    }
    this.model = { ...this.model, docked: null };
    this.lastFrame = null;
  }

  private async release(): Promise<void> {
    const docked = this.model.docked;
    if (docked?.mode !== "attend" || !docked.attentionId) return;
    try {
      if (docked.capabilityFile)
        await this.deps.agentweb.release(docked.attentionId, docked.capabilityFile);
      this.model = withNotice(this.model, `${shortRef(docked.browserRef)} released to its agent`);
    } catch (error) {
      this.model = withNotice(this.model, (error as Error).message);
      return;
    }
    await this.parkDocked();
  }

  async handleKey(key: string): Promise<void> {
    const { model, action } = reduceKey(this.model, key);
    this.model = model;
    switch (action.kind) {
      case "quit":
        this.stopped = true;
        break;
      case "dock":
        await this.dock(action.browserRef, action.mode, action.attentionId);
        break;
      case "park":
        await this.parkDocked();
        break;
      case "release":
        await this.release();
        break;
      default:
        break;
    }
    this.draw();
  }

  draw(): void {
    const { terminal } = this.deps;
    terminal.write(render(this.model, terminal.columns, terminal.rows, this.deps.now()));
  }
}

/** Assemble the pane against the live herdr session and agentweb daemon. */
export function createBrowserPane(env: Environ, home: string): BrowserPane {
  const paneId = env["HERDR_PANE_ID"];
  const socketPath = env["HERDR_SOCKET_PATH"];
  if (!paneId || !socketPath)
    throw new CliError(
      "not_in_herdr",
      "the browser pane runs inside a herdr pane (HERDR_PANE_ID, HERDR_SOCKET_PATH)",
    );
  const run: Runner = (argv) => runProcess(argv, env);
  const herdr = createHerdrCall(env);
  return new BrowserPane({
    agentweb: new Agentweb(run, env, home),
    geometry: () =>
      readGeometry({
        herdr,
        socket: (request) => herdrSocketRequest(socketPath, request),
        yabai: run,
        paneId,
        hostPid: null,
      }),
    terminal: processPaneTerminal(),
    now: () => Date.now(),
  });
}
