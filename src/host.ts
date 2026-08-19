import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { notifyLaunchFailure, pruneSpool } from "./directive.ts";
import { parseDirective } from "./directive-schema.ts";
import { UsageError } from "./errors.ts";
import { createHerdrCall, type HerdrCall, invoke } from "./herdr.ts";
import type { Environ } from "./paths.ts";
import { launchLogPath } from "./state.ts";

/**
 * The generic surface host: run one fleet TUI on this terminal and realize
 * every session directive it emits. The host holds the tool's stdout as a
 * pipe — the tool renders on stderr, which stays the popup's tty — and each
 * complete JSON line it reads becomes a detached
 * `agentsurface execute-directive` at once, so a background submit launches
 * while the form stays open, and the popup still closes the moment the tool
 * exits. The tool never learns what became of a directive; execution
 * failures reach the operator as herdr notifications.
 */

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

/** A fresh per-run evidence log under the state directory: every line read
 * off the tool's stdout, valid or not, appended as received — the submitted
 * work survives whatever happens downstream. Pruned by age like the intent
 * spool. */
export function createDirectiveLog(env: Environ, home: string, now: number = Date.now()): string {
  const spool = join(dirname(launchLogPath(env, home)), "directives");
  mkdirSync(spool, { recursive: true });
  pruneSpool(spool, now, LOG_MAX_AGE_MS);
  const path = join(spool, `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}.jsonl`);
  writeFileSync(path, "");
  return path;
}

const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  const evidence = createDirectiveLog(env, home);

  // stdout piped is the whole protocol; stdin and stderr stay the popup's
  // tty, where the tool reads keys and renders.
  const tool = Bun.spawn(command as [string, ...string[]], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
    cwd,
    env: env as Record<string, string>,
  });

  const faults: string[] = [];
  const act = (line: string): void => {
    try {
      appendFileSync(evidence, `${line}\n`);
    } catch {
      // Evidence is insurance, never a launch blocker.
    }
    try {
      parseDirective(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      faults.push(message);
      void notifyLaunchFailure(env, `directive refused: ${message}`);
      return;
    }
    spawnDetachedExecutor(env, logPath, line);
  };

  // Read the pipe as it flows: complete lines act at once; a partial line is
  // a write still in flight and carries to the next chunk. A bad line cannot
  // stop the stream — it is reported and the reading goes on.
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of tool.stdout as AsyncIterable<Uint8Array>) {
    const { lines, rest } = splitCompleteLines(carry + decoder.decode(chunk, { stream: true }));
    carry = rest;
    for (const line of lines) act(line);
  }
  // The stream is closed; a trailing unterminated line is still a submit —
  // the spec asks for terminated lines, but losing a launch to a missing
  // newline would be pedantry.
  carry += decoder.decode();
  if (carry.trim() !== "") act(carry.trim());

  const code = await tool.exited;
  if (faults.length > 0) {
    console.error(`error: ${faults.length} directive${faults.length > 1 ? "s" : ""} refused:`);
    for (const fault of faults) console.error(`  ${fault}`);
    return code === 0 ? 1 : code;
  }
  return code;
}
