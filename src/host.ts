import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { notifyLaunchFailure, pruneSpool } from "./directive.ts";
import { DIRECTIVE_SINK_ENV, parseDirective } from "./directive-schema.ts";
import { UsageError } from "./errors.ts";
import { createHerdrCall, type HerdrCall, invoke } from "./herdr.ts";
import type { Environ } from "./paths.ts";
import { launchLogPath } from "./state.ts";

/**
 * The generic surface host: run one fleet TUI on this terminal and realize
 * every session directive it emits. The host creates a fresh sink file,
 * names it to the tool in AGENTSURFACE_DIRECTIVES, and tails it while the
 * tool runs — each complete line becomes a detached
 * `agentsurface execute-directive` at once, so a background submit launches
 * while the form stays open, and the popup still closes the moment the tool
 * exits. The tool never learns what became of a directive; execution
 * failures reach the operator as herdr notifications.
 */

const POLL_MS = 150;

/** Complete lines only: a directive is one line, and a partial tail is a
 * write still in flight — carried to the next read, never parsed early. */
export function splitCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const at = buffer.lastIndexOf("\n");
  if (at < 0) return { lines: [], rest: buffer };
  return {
    lines: buffer
      .slice(0, at)
      .split("\n")
      .filter((line) => line.trim() !== ""),
    rest: buffer.slice(at + 1),
  };
}

/** A fresh per-run sink under the state directory, kept afterwards as the
 * submitted-work evidence log and pruned by age like the intent spool. */
export function createDirectiveSink(env: Environ, home: string, now: number = Date.now()): string {
  const spool = join(dirname(launchLogPath(env, home)), "directives");
  mkdirSync(spool, { recursive: true });
  pruneSpool(spool, now, SINK_MAX_AGE_MS);
  const path = join(spool, `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}.jsonl`);
  writeFileSync(path, "");
  return path;
}

const SINK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The popup does not inherit the focused pane's cwd, but herdr names the
 * pane in the spawn environment; ask it. Outside a binding, the process cwd
 * is the answer already. */
export async function contextCwd(call: HerdrCall, env: Environ): Promise<string> {
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

/** The executor's stderr appends to a log beside the launch records: a crash
 * before its own failure handling must still leave evidence.
 *
 * `detached` is load-bearing, not hygiene: the host usually lives in a herdr
 * popup whose terminal closes the moment the host exits, and the pty
 * teardown SIGHUPs the foreground process group — which would silently kill
 * same-group executors mid-launch. A separate group survives the popup. */
export function spawnDetachedExecutor(
  env: Environ,
  logPath: string,
  directiveJson: string,
): ReturnType<typeof Bun.spawn> {
  let stderr: number | "ignore" = "ignore";
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    stderr = openSync(join(dirname(logPath), "executor.log"), "a");
  } catch {
    // No log home; the launch still matters more than its evidence.
  }
  const proc = Bun.spawn(
    [process.execPath, process.argv[1] ?? "agentsurface", "execute-directive", directiveJson],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr,
      detached: true,
      env: env as Record<string, string>,
    },
  );
  proc.unref();
  if (typeof stderr === "number") closeSync(stderr);
  return proc;
}

export async function runHost(env: Environ, home: string, argv: string[]): Promise<number> {
  const command = argv[0] === "--" ? argv.slice(1) : argv;
  if (command.length === 0 || (command[0] ?? "").startsWith("-")) {
    throw new UsageError("host takes the tool command to run: host [--] <command> [args…]");
  }

  // Everything fallible happens before the tool owns the terminal, so a
  // failure prints plainly where main's popup hold can show it.
  const call = createHerdrCall(env);
  await invoke(call, ["workspace", "list"]); // herdr reachability, before drawing
  const cwd = await contextCwd(call, env);
  const logPath = launchLogPath(env, home);
  const sink = createDirectiveSink(env, home);

  const tool = Bun.spawn(command as [string, ...string[]], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd,
    env: { ...env, [DIRECTIVE_SINK_ENV]: sink } as Record<string, string>,
  });

  // The tail: consume from the last read offset, act on complete lines. A
  // bad line cannot stop the stream — it is reported and the tail goes on.
  let offset = 0;
  let carry = "";
  const faults: string[] = [];
  const drain = (): void => {
    let size: number;
    try {
      size = statSync(sink).size;
    } catch {
      return; // The sink vanishing mid-run is itself reported at exit.
    }
    if (size <= offset) return;
    const text = readFileSync(sink, "utf8");
    const fresh = text.slice(offset);
    offset = text.length;
    const { lines, rest } = splitCompleteLines(carry + fresh);
    carry = rest;
    for (const line of lines) {
      try {
        parseDirective(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        faults.push(message);
        void notifyLaunchFailure(env, `directive refused: ${message}`);
        continue;
      }
      spawnDetachedExecutor(env, logPath, line);
    }
  };

  const tail = setInterval(drain, POLL_MS);
  const code = await tool.exited;
  clearInterval(tail);
  drain(); // The final submit lands right before exit; catch it always.

  if (faults.length > 0) {
    console.error(`error: ${faults.length} directive${faults.length > 1 ? "s" : ""} refused:`);
    for (const fault of faults) console.error(`  ${fault}`);
    return code === 0 ? 1 : code;
  }
  return code;
}
