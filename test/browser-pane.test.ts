import { describe, expect, test } from "bun:test";
import {
  Agentweb,
  type AttentionRow,
  BrowserPane,
  type BrowserRow,
  COMMANDS,
  dockFrame,
  type Geometry,
  hostTerminalWindow,
  initialModel,
  orderedBrowsers,
  type PaneModel,
  type PaneTerminal,
  paletteRows,
  READOUT_ROWS,
  type Runner,
  reduceKey,
  render,
} from "../src/browser-pane.ts";

const NOW = 1_800_000_000_000;

function browser(overrides: Partial<BrowserRow> & { browserRef: string }): BrowserRow {
  return {
    environmentId: "E2",
    state: "AGENT_ACTIVE",
    currentOrigin: "https://jobs.example.test",
    jobId: "job-1",
    createdAt: NOW - 60_000,
    ...overrides,
  };
}

function attention(overrides: Partial<AttentionRow> & { attentionId: string }): AttentionRow {
  return {
    browserRef: "br-headed-one",
    state: "QUEUED",
    reasonCode: "CAPTCHA_HUMAN_COMPLETION",
    requestedAction: "Solve the hCaptcha; the form is filled.",
    origin: "https://jobs.example.test",
    deadlineAt: NOW + 25 * 60_000,
    ...overrides,
  };
}

const GEOMETRY: Geometry = {
  rect: { x: 26, y: 1, width: 100, height: 40 },
  cellWidth: 12,
  cellHeight: 31,
  originX: 0,
  originY: 0,
  space: 3,
  visible: true,
};

function modelWith(rows: BrowserRow[], items: AttentionRow[] = []): PaneModel {
  return { ...initialModel(), browsers: rows, attention: items, geometry: GEOMETRY };
}

describe("model", () => {
  test("orders headed browsers first, newest first, and drops closed ones", () => {
    const rows = orderedBrowsers([
      browser({ browserRef: "br-old-headless", environmentId: "E1", createdAt: NOW - 10 }),
      browser({ browserRef: "br-closed", state: "CLOSED" }),
      browser({ browserRef: "br-older-headed", createdAt: NOW - 500 }),
      browser({ browserRef: "br-newer-headed", createdAt: NOW - 100 }),
    ]);
    expect(rows.map((row) => row.browserRef)).toEqual([
      "br-newer-headed",
      "br-older-headed",
      "br-old-headless",
    ]);
  });

  test("j/k and arrows move the selection inside the list", () => {
    const model = modelWith([browser({ browserRef: "br-a" }), browser({ browserRef: "br-b" })]);
    const down = reduceKey(model, "j").model;
    expect(down.selected).toBe(1);
    expect(reduceKey(down, "j").model.selected).toBe(1);
    expect(reduceKey(down, "k").model.selected).toBe(0);
    expect(reduceKey(model, "[B").model.selected).toBe(1);
    expect(reduceKey(down, "[A").model.selected).toBe(0);
  });

  test("enter docks the selected headed browser to watch; a headless one is refused with a notice", () => {
    const model = modelWith([
      browser({ browserRef: "br-headed-one" }),
      browser({ browserRef: "br-headless", environmentId: "E1" }),
    ]);
    expect(reduceKey(model, "\r").action).toEqual({
      kind: "dock",
      browserRef: "br-headed-one",
      mode: "observe",
      attentionId: null,
    });
    const onHeadless = reduceKey({ ...model, selected: 1 }, "\r");
    expect(onHeadless.action).toEqual({ kind: "none" });
    expect(onHeadless.model.notice).toMatch(/headless/);
  });

  test("a attends only when the browser has a queued attention item", () => {
    const withItem = modelWith(
      [browser({ browserRef: "br-headed-one" })],
      [attention({ attentionId: "attn-1" })],
    );
    expect(reduceKey(withItem, "a").action).toEqual({
      kind: "dock",
      browserRef: "br-headed-one",
      mode: "attend",
      attentionId: "attn-1",
    });
    const without = reduceKey(modelWith([browser({ browserRef: "br-headed-one" })]), "a");
    expect(without.action).toEqual({ kind: "none" });
    expect(without.model.notice).toMatch(/no attention item/);
  });

  test("r releases only an attended browser; p parks whatever is docked", () => {
    const base = modelWith([browser({ browserRef: "br-headed-one" })]);
    expect(reduceKey(base, "r").model.notice).toMatch(/nothing is being attended/);
    expect(reduceKey(base, "p").model.notice).toMatch(/nothing is docked/);
    const observing: PaneModel = {
      ...base,
      docked: {
        browserRef: "br-headed-one",
        mode: "observe",
        attentionId: null,
        capabilityFile: null,
        hidden: false,
      },
    };
    expect(reduceKey(observing, "r").action).toEqual({ kind: "none" });
    expect(reduceKey(observing, "p").action).toEqual({ kind: "park", browserRef: "br-headed-one" });
    const attending: PaneModel = {
      ...base,
      docked: {
        browserRef: "br-headed-one",
        mode: "attend",
        attentionId: "attn-1",
        capabilityFile: "/x",
        hidden: false,
      },
    };
    expect(reduceKey(attending, "r").action).toEqual({ kind: "release" });
  });

  test("q and ctrl+c quit; ctrl+k opens a palette that filters, moves, and runs on enter", () => {
    const model = modelWith([browser({ browserRef: "br-headed-one" })]);
    expect(reduceKey(model, "q").action).toEqual({ kind: "quit" });
    expect(reduceKey(model, "").action).toEqual({ kind: "quit" });
    const open = reduceKey(model, "").model;
    expect(open.palette).toEqual({ filter: "", selected: 0 });
    expect(paletteRows("")).toHaveLength(COMMANDS.length);
    const filtered = ["p", "a", "r", "k"].reduce((state, key) => reduceKey(state, key).model, open);
    expect(filtered.palette?.filter).toBe("park");
    expect(paletteRows("park").map((row) => row.key)).toEqual(["p", "q"]);
    const moved = reduceKey(filtered, "[B").model;
    expect(moved.palette?.selected).toBe(1);
    const ran = reduceKey(moved, "\r");
    expect(ran.model.palette).toBeNull();
    expect(ran.action).toEqual({ kind: "quit" });
    expect(reduceKey(open, "").model.palette).toBeNull();
    expect(reduceKey(open, "").model.palette).toBeNull();
  });
});

describe("geometry", () => {
  test("the dock frame covers the pane except its readout rows, in screen pixels", () => {
    expect(dockFrame(GEOMETRY)).toEqual({
      x: 26 * 12,
      y: 31,
      width: 1200,
      height: (40 - READOUT_ROWS) * 31,
    });
    expect(dockFrame({ ...GEOMETRY, originX: 100, originY: 50 })).toMatchObject({ x: 412, y: 81 });
    expect(dockFrame({ ...GEOMETRY, rect: { ...GEOMETRY.rect, height: 1 } }).height).toBe(31);
  });

  test("the host terminal window is found by pid, then focus, then visibility", () => {
    const windows = JSON.stringify([
      {
        app: "Google Chrome",
        pid: 1,
        frame: { x: 5, y: 5 },
        space: 2,
        "has-focus": true,
        "is-visible": true,
      },
      {
        app: "Ghostty",
        pid: 10,
        frame: { x: 0, y: 0 },
        space: 1,
        "has-focus": false,
        "is-visible": false,
      },
      {
        app: "Ghostty",
        pid: 10,
        frame: { x: 0, y: 0 },
        space: 3,
        "has-focus": false,
        "is-visible": true,
      },
      {
        app: "Ghostty",
        pid: 11,
        frame: { x: 200, y: 100 },
        space: 4,
        "has-focus": true,
        "is-visible": true,
      },
    ]);
    expect(hostTerminalWindow(windows, 10)).toEqual({ x: 0, y: 0, space: 3 });
    expect(hostTerminalWindow(windows, null)).toEqual({ x: 200, y: 100, space: 4 });
    expect(hostTerminalWindow("[]", null)).toBeNull();
    expect(hostTerminalWindow("not json", null)).toBeNull();
  });
});

describe("render", () => {
  test("lists browsers with their attention, marks the selection by rail, and never draws chrome", () => {
    const model = modelWith(
      [
        browser({ browserRef: "br-headed-one" }),
        browser({ browserRef: "br-two", currentOrigin: null }),
      ],
      [attention({ attentionId: "attn-1" })],
    );
    const frame = render(model, 80, 20, NOW);
    expect(frame).toContain("▎");
    expect(frame).toContain("br-headed-on…");
    expect(frame).toContain("CAPTCHA_HUMAN_COMPLETION");
    expect(frame).toContain("25m left");
    expect(frame).not.toMatch(/agentsurface|help|ctrl\+k|⌃K/i);
  });

  test("an empty list says so in the middle, and the readout carries the docked state and keys", () => {
    expect(render(initialModel(), 60, 12, NOW)).toContain("no agentweb browsers");
    const docked: PaneModel = {
      ...modelWith(
        [browser({ browserRef: "br-headed-one" })],
        [attention({ attentionId: "attn-1" })],
      ),
      docked: {
        browserRef: "br-headed-one",
        mode: "attend",
        attentionId: "attn-1",
        capabilityFile: "/x",
        hidden: false,
      },
    };
    const frame = render(docked, 80, 20, NOW);
    expect(frame).toContain("attending");
    expect(frame).toContain("Solve the hCaptcha");
    expect(frame).toContain("release");
    expect(frame).not.toContain("br-two");
    const observing = render(
      { ...docked, docked: { ...docked.docked!, mode: "observe", attentionId: null } },
      80,
      20,
      NOW,
    );
    expect(observing).toContain("clicks reach the site");
    expect(observing).not.toContain("release");
  });

  test("the palette lists every command with its key and stays inside the viewport", () => {
    const model: PaneModel = { ...initialModel(), palette: { filter: "", selected: 0 } };
    const tall = render(model, 60, 20, NOW);
    for (const command of COMMANDS) expect(tall).toContain(`[${command.key}]`);
    expect(tall).toContain("┌");
    // A short viewport windows the list instead of overflowing it.
    const short = render(model, 40, 8, NOW);
    const rows = short
      .split(String.fromCharCode(27))
      .map((chunk) => /^\[(\d+);\d+H/.exec(chunk))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    expect(Math.max(...rows)).toBeLessThanOrEqual(8);
    expect(short).toContain("[enter]");
    expect(short).not.toContain("[q]");
  });
});

/* ------------------------------------------------------------------------ */
/* Loop                                                                      */
/* ------------------------------------------------------------------------ */

class FakeTerminal implements PaneTerminal {
  readonly isTTY = true;
  columns = 100;
  rows = 30;
  writes: string[] = [];
  raw: boolean[] = [];
  write(text: string): void {
    this.writes.push(text);
  }
  setRawMode(enabled: boolean): void {
    this.raw.push(enabled);
  }
  onKey(): () => void {
    return () => {};
  }
  onResize(): () => void {
    return () => {};
  }
}

interface FakeDaemon {
  browsers: BrowserRow[];
  attention: AttentionRow[];
  calls: string[];
  runner: Runner;
}

/** A canned agentweb CLI: answers list calls from state and records every argv. */
function fakeDaemon(): FakeDaemon {
  const daemon: FakeDaemon = {
    browsers: [],
    attention: [],
    calls: [],
    runner: async (argv) => {
      const args = argv.slice(1).filter((arg) => arg !== "--json");
      daemon.calls.push(args.join(" ").replace(/ --credential-file \S+/, ""));
      const ok = (data: unknown) => ({
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, data }),
        stderr: "",
      });
      if (args[0] === "browser" && args[1] === "list") return ok(daemon.browsers);
      if (args[0] === "attention" && args[1] === "list") return ok(daemon.attention);
      if (args[0] === "attention" && args[1] === "attend") {
        for (const item of daemon.attention)
          if (item.attentionId === args[2]) item.state = "HUMAN_ACTIVE";
        return ok({ item: {}, grant: {} });
      }
      if (args[0] === "attention" && args[1] === "release") {
        for (const item of daemon.attention)
          if (item.attentionId === args[2]) item.state = "RELEASED";
        return ok({});
      }
      if (args[0] === "browser" && args[1] === "window")
        return ok({ placement: args[2] === "park" ? "parked" : "docked" });
      return {
        exitCode: 1,
        stdout: "",
        stderr: JSON.stringify({
          ok: false,
          error: { code: "BAD_REQUEST", message: `unexpected ${args.join(" ")}` },
        }),
      };
    },
  };
  return daemon;
}

function makePane(daemon: FakeDaemon, geometry: () => Geometry) {
  const terminal = new FakeTerminal();
  const home = "/home/test";
  const env = {
    HOME: home,
    AGENTSURFACE_AGENTWEB: "agentweb-fake",
    XDG_STATE_HOME: "/tmp/agentsurface-test-state",
  };
  const pane = new BrowserPane({
    agentweb: new Agentweb(daemon.runner, env, home),
    geometry: () => Promise.resolve(geometry()),
    terminal,
    now: () => NOW,
    pollMs: 5,
  });
  return { pane, terminal };
}

describe("browser pane loop", () => {
  test("a queued attention item is attended and its window docked with focus on this pane's Space", async () => {
    const daemon = fakeDaemon();
    daemon.browsers = [browser({ browserRef: "br-headed-one", state: "QUIESCING" })];
    daemon.attention = [attention({ attentionId: "attn-1" })];
    const { pane } = makePane(daemon, () => GEOMETRY);
    await pane.tick();
    expect(pane.state.docked).toMatchObject({
      browserRef: "br-headed-one",
      mode: "attend",
      attentionId: "attn-1",
    });
    expect(pane.state.docked?.capabilityFile).toMatch(/human-attn-1\.capability$/);
    expect(daemon.calls.filter((call) => !call.endsWith(" list"))).toEqual([
      "attention attend attn-1 --capability-out /tmp/agentsurface-test-state/agentsurface/attention/human-attn-1.capability",
      "browser window dock br-headed-one --x 312 --y 31 --width 1200 --height 1178 --space 3 --focus",
    ]);

    // r releases with the minted capability and parks the window.
    await pane.handleKey("r");
    expect(daemon.calls.slice(-2)).toEqual([
      "attention release attn-1 --capability-file /tmp/agentsurface-test-state/agentsurface/attention/human-attn-1.capability",
      "browser window park br-headed-one",
    ]);
    expect(pane.state.docked).toBeNull();
    expect(pane.state.notice).toMatch(/released/);
    // The item is no longer queued, so the next tick does not attend again.
    await pane.tick();
    expect(pane.state.docked).toBeNull();
  });

  test("watching follows the pane: re-placed on resize, parked while hidden, re-docked when shown", async () => {
    const daemon = fakeDaemon();
    daemon.browsers = [browser({ browserRef: "br-headed-one" })];
    let geometry = GEOMETRY;
    const { pane } = makePane(daemon, () => geometry);
    await pane.tick();
    await pane.handleKey("\r");
    expect(pane.state.docked).toMatchObject({ browserRef: "br-headed-one", mode: "observe" });
    expect(daemon.calls.at(-1)).toBe(
      "browser window dock br-headed-one --x 312 --y 31 --width 1200 --height 1178 --space 3",
    );
    await pane.tick();
    expect(daemon.calls.filter((call) => call.startsWith("browser window"))).toHaveLength(1);

    geometry = { ...GEOMETRY, rect: { ...GEOMETRY.rect, width: 50 } };
    await pane.tick();
    expect(daemon.calls.at(-1)).toBe(
      "browser window dock br-headed-one --x 312 --y 31 --width 600 --height 1178 --space 3",
    );

    geometry = { ...geometry, visible: false };
    await pane.tick();
    const windowCalls = () => daemon.calls.filter((call) => call.startsWith("browser window"));
    expect(windowCalls().at(-1)).toBe("browser window park br-headed-one");
    expect(pane.state.docked?.hidden).toBe(true);
    // Still hidden: nothing more to do, and no repeated park.
    const before = windowCalls().length;
    await pane.tick();
    expect(windowCalls()).toHaveLength(before);

    geometry = { ...geometry, visible: true };
    await pane.tick();
    expect(daemon.calls.at(-1)).toBe(
      "browser window dock br-headed-one --x 312 --y 31 --width 600 --height 1178 --space 3",
    );
    expect(pane.state.docked?.hidden).toBe(false);
  });

  test("a docked browser that closes clears the dock, and quitting parks what is docked", async () => {
    const daemon = fakeDaemon();
    daemon.browsers = [browser({ browserRef: "br-headed-one" })];
    const { pane, terminal } = makePane(daemon, () => GEOMETRY);
    await pane.tick();
    await pane.handleKey("\r");
    daemon.browsers = [browser({ browserRef: "br-headed-one", state: "CLOSED" })];
    await pane.tick();
    expect(pane.state.docked).toBeNull();
    expect(pane.state.notice).toMatch(/closed/);

    daemon.browsers = [browser({ browserRef: "br-headed-one" })];
    await pane.tick();
    await pane.handleKey("\r");
    const running = pane.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pane.handleKey("q");
    expect(await running).toBe(0);
    expect(daemon.calls.at(-1)).toBe("browser window park br-headed-one");
    expect(terminal.raw).toEqual([true, false]);
  });

  test("a failing agentweb command lands on the readout instead of stopping the loop", async () => {
    const daemon = fakeDaemon();
    daemon.browsers = [browser({ browserRef: "br-headed-one" })];
    const failing: Runner = async (argv) => {
      if (argv.includes("dock"))
        return {
          exitCode: 1,
          stdout: "",
          stderr: JSON.stringify({
            ok: false,
            error: { code: "NOT_FOUND", message: "the browser has no window yet" },
          }),
        };
      return daemon.runner(argv);
    };
    const terminal = new FakeTerminal();
    const pane = new BrowserPane({
      agentweb: new Agentweb(
        failing,
        { HOME: "/home/test", AGENTSURFACE_AGENTWEB: "agentweb-fake" },
        "/home/test",
      ),
      geometry: () => Promise.resolve(GEOMETRY),
      terminal,
      now: () => NOW,
    });
    await pane.tick();
    await pane.handleKey("\r");
    expect(pane.state.docked).toBeNull();
    expect(pane.state.notice).toBe("the browser has no window yet");
    expect(terminal.writes.at(-1)).toContain("the browser has no window yet");
  });
});
