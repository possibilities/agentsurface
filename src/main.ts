#!/usr/bin/env bun
import { runAgents, runMessage } from "./bus.ts";
import { closeActive } from "./close.ts";
import {
  CONFIRM_USAGE,
  processTerminal,
  runConfirmation,
  spawnConfirmedCommand,
} from "./confirm.ts";
import { contractEnvelope, ENTRYPOINT_FLAGS, parseInvocation, usageLine } from "./contract.ts";
import {
  conversationSlug,
  EXIT_NO_PROMPT,
  EXIT_TRANSCRIPT_NOT_FOUND,
} from "./conversation/slug.ts";
import {
  executeDirective,
  LaunchFailure,
  launchFailureBody,
  notifyLaunchFailure,
} from "./directive.ts";
import { parseDirective } from "./directive-schema.ts";
import { CliError, UsageError } from "./errors.ts";
import { renderAgentHelp, renderAgentTeaser, renderHelp, VERSION } from "./help.ts";
import { createHerdrCall, HerdrError } from "./herdr.ts";
import { runHost } from "./host.ts";
import { expandTilde } from "./paths.ts";
import {
  dumpSessionsToDirectory,
  resolveSessionBackupPath,
  resumeSessionFromFile,
  sessionBackupDirectory,
} from "./session-snapshot.ts";
import { launchLogPath } from "./state.ts";
import { nameTabFromEnvironment } from "./tab-namer.ts";

/** The host usually runs inside a herdr popup, which closes with the
 * process — hold a failure on screen until a key or a timeout, so the
 * message can actually be read. */
async function holdForKeypress(): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stderr.write("\npress any key to close\n");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    };
    const timer = setTimeout(finish, 30_000);
    process.stdin.once("data", finish);
  });
}

/** A usage fault: the message, the help, exit 2. */
function usage(error: unknown, help = true): number {
  console.error(error instanceof Error ? error.message : String(error));
  if (help) process.stderr.write(renderHelp());
  return 2;
}

async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  // The entrypoint flags are spelled once, in contract.ts, so routing them
  // and printing them in the usage line cannot disagree.
  const entrypoint =
    first === undefined
      ? "help"
      : ENTRYPOINT_FLAGS.find((flag) => flag.spellings.includes(first))?.kind;
  if (entrypoint === "help") {
    process.stdout.write(renderHelp());
    return 0;
  }
  if (entrypoint === "agent-help") {
    process.stdout.write(renderAgentHelp());
    return 0;
  }
  if (entrypoint === "agent-teaser") {
    process.stdout.write(renderAgentTeaser());
    return 0;
  }
  if (entrypoint === "version") {
    console.log(VERSION);
    return 0;
  }
  if (first === "guide") {
    // The contract itself. Every other help surface in this CLI renders from
    // the same document, so there is nothing here authored twice.
    try {
      if (parseInvocation("guide", argv.slice(1)).flag("--json")) {
        console.log(JSON.stringify(contractEnvelope(), null, 2));
        return 0;
      }
    } catch (error) {
      return usage(error);
    }
    process.stdout.write(renderAgentHelp());
    return 0;
  }
  if (first === "host") {
    try {
      const code = await runHost(process.env, process.env["HOME"] ?? "", argv.slice(1));
      // A tool that failed printed to this terminal; hold the popup so the
      // message can be read. An operator's ctrl+c (130) asked for the close.
      if (code !== 0 && code !== 130) await holdForKeypress();
      return code;
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(error.message);
        process.stderr.write(renderHelp());
        return 2;
      }
      if (error instanceof CliError) {
        console.error(`error: ${error.message}`);
        if (error.recovery !== undefined) console.error(error.recovery);
      } else if (error instanceof HerdrError) {
        console.error(`error: ${error.message}`);
        console.error("is the herdr session running?");
      } else {
        console.error(`error: ${(error as Error).message ?? String(error)}`);
      }
      await holdForKeypress();
      return 1;
    }
  }
  if (first === "confirm") {
    try {
      return await runConfirmation(argv.slice(1), processTerminal(), spawnConfirmedCommand);
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(error.message);
        console.error(`Usage: agentsurface ${CONFIRM_USAGE}`);
        return 2;
      }
      if (error instanceof CliError) {
        console.error(`error: ${error.message}`);
        return 1;
      }
      console.error(`error: ${(error as Error).message ?? String(error)}`);
      return 1;
    }
  }
  if (first === "close-active") {
    try {
      await closeActive(createHerdrCall(process.env), process.env, argv.slice(1));
      return 0;
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(error.message);
        return 2;
      }
      if (error instanceof CliError || error instanceof HerdrError) {
        console.error(`error: ${error.message}`);
        return 1;
      }
      console.error(`error: ${(error as Error).message ?? String(error)}`);
      return 1;
    }
  }
  if (first === "session") {
    const action = argv[1];
    if (action !== "dump" && action !== "resume") {
      console.error("session takes dump or resume");
      process.stderr.write(renderHelp());
      return 2;
    }
    let pathArgument: string | undefined;
    let sessionNames: string[];
    try {
      // Which positional each takes, whether --session repeats, and that
      // resume takes at most one override are all read off the contract.
      const parsed = parseInvocation(`session ${action}`, argv.slice(2));
      pathArgument = parsed.positional[0];
      sessionNames = [...parsed.options("--session")];
    } catch (error) {
      return usage(error);
    }
    try {
      const env = process.env;
      const home = env["HOME"] ?? "";
      const resolvedPath =
        pathArgument === undefined
          ? sessionBackupDirectory(env, home)
          : action === "resume"
            ? resolveSessionBackupPath(pathArgument, env, home)
            : expandTilde(pathArgument, home);
      if (action === "dump") {
        console.log(
          JSON.stringify(
            { sessions: await dumpSessionsToDirectory(resolvedPath, sessionNames, env) },
            null,
            2,
          ),
        );
      } else {
        console.log(
          JSON.stringify(
            {
              session: await resumeSessionFromFile(resolvedPath, env, sessionNames[0]),
            },
            null,
            2,
          ),
        );
      }
      return 0;
    } catch (error) {
      if (error instanceof CliError || error instanceof HerdrError) {
        console.error(`error: ${error.message}`);
        if (error instanceof CliError && error.recovery !== undefined) {
          console.error(error.recovery);
        }
        return 1;
      }
      console.error(`error: ${(error as Error).message ?? String(error)}`);
      return 1;
    }
  }
  if (first === "conversation") {
    const second = argv[1];
    if (second === "describe") {
      try {
        parseInvocation("conversation describe", argv.slice(2));
      } catch (error) {
        return usage(error, false);
      }
      const { runDescribe } = await import("./conversation/describe.ts");
      const stdin = await new Response(process.stdin as unknown as ReadableStream).text();
      process.stdout.write(runDescribe(stdin, process.env, process.env["HOME"] ?? ""));
      return 0;
    }
    if (second !== "slug") {
      console.error(
        second === undefined ? "conversation takes a subcommand" : `unknown subcommand "${second}"`,
      );
      process.stderr.write(renderHelp());
      return 2;
    }
    // Machine-invoked (the tab-naming plugin polls the distinct exit
    // codes), so failures report and exit — no popup hold.
    try {
      console.log(await conversationSlug(argv.slice(2), process.env, process.env["HOME"] ?? ""));
      return 0;
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(error.message);
        process.stderr.write(renderHelp());
        return 2;
      }
      if (error instanceof CliError) {
        console.error(`error: ${error.message}`);
        if (error.recovery !== undefined) console.error(error.recovery);
        if (error.code === "transcript_not_found") return EXIT_TRANSCRIPT_NOT_FOUND;
        if (error.code === "transcript_no_prompt") return EXIT_NO_PROMPT;
        return 1;
      }
      console.error(`error: ${(error as Error).message ?? String(error)}`);
      return 1;
    }
  }
  if (first === "agents" || first === "message") {
    // Machine-invoked (agents call the bus from their panes), so failures
    // report and exit — no popup hold.
    try {
      if (first === "agents") {
        const all = parseInvocation("agents", argv.slice(1)).flag("--all");
        const env = process.env;
        console.log(await runAgents(createHerdrCall(env), env, env["HOME"] ?? "", all));
        return 0;
      }
      // Flags, arity, the positive-integer timeout and its dependence on
      // --wait-unblocked are the contract's; an empty text is the one thing
      // it cannot say, so it stays here.
      const parsed = parseInvocation("message", argv.slice(1));
      const [target, text] = parsed.positional;
      if (target === undefined || text === undefined || text === "") {
        throw new UsageError(`give a target and one text argument: ${usageLine("message")}`);
      }
      const waitUnblocked = parsed.flag("--wait-unblocked");
      const timeoutMs = parsed.integer("--timeout");
      console.log(
        await runMessage(createHerdrCall(process.env), process.env, target, text, {
          waitUnblocked,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }),
      );
      return 0;
    } catch (error) {
      if (error instanceof UsageError) return usage(error);
      if (error instanceof CliError) {
        console.error(`error: ${error.message}`);
        if (error.recovery !== undefined) console.error(error.recovery);
        return 1;
      }
      if (error instanceof HerdrError) {
        console.error(`error: ${error.message}`);
        console.error("is the herdr session running?");
        return 1;
      }
      console.error(`error: ${(error as Error).message ?? String(error)}`);
      return 1;
    }
  }
  if (first === "name-tab") {
    // Internal: herdr's plugin hook on agent detection and status changes.
    // Quiet by design — failures reach herdr's plugin log, never a notification.
    try {
      parseInvocation("name-tab", argv.slice(1));
    } catch (error) {
      return usage(error, false);
    }
    return await nameTabFromEnvironment(process.env, process.env["HOME"] ?? "");
  }
  if (first === "execute-directive") {
    // Internal: the host spawns this detached so a hosted TUI's popup can
    // close the moment a directive is submitted. There is no terminal to
    // hold — errors go to stderr and, best-effort, to a herdr notification.
    try {
      const [json] = parseInvocation("execute-directive", argv.slice(1)).positional;
      const directive = parseDirective(json as string);
      const env = process.env;
      await executeDirective(
        createHerdrCall(env),
        launchLogPath(env, env["HOME"] ?? ""),
        directive,
      );
      return 0;
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(error.message);
        return 2;
      }
      const message = error instanceof Error ? error.message : String(error);
      const intentPath = error instanceof LaunchFailure ? error.intentPath : null;
      console.error(`error: ${message}`);
      if (intentPath !== null) console.error(`prompt: ${intentPath}`);
      await notifyLaunchFailure(process.env, launchFailureBody(message, intentPath));
      return 1;
    }
  }
  console.error(`unknown command "${first}"`);
  process.stderr.write(renderHelp());
  return 2;
}

process.exit(await main(process.argv.slice(2)));
