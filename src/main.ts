#!/usr/bin/env bun
import { runAgents, runMessage } from "./bus.ts";
import { closeActive } from "./close.ts";
import {
  CONFIRM_USAGE,
  processTerminal,
  runConfirmation,
  spawnConfirmedCommand,
} from "./confirm.ts";
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
import { TOP_HELP, VERSION } from "./help.ts";
import { createHerdrCall, HerdrError } from "./herdr.ts";
import { runHost } from "./host.ts";
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

async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") {
    console.log(TOP_HELP);
    return 0;
  }
  if (first === "--version" || first === "-V") {
    console.log(VERSION);
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
        console.error(TOP_HELP);
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
  if (first === "browser") {
    if (argv.length > 1) {
      console.error("browser takes no arguments");
      return 2;
    }
    try {
      const { createBrowserPane } = await import("./browser-pane.ts");
      return await createBrowserPane(process.env, process.env["HOME"] ?? "").run();
    } catch (error) {
      if (error instanceof CliError || error instanceof HerdrError) {
        console.error(`error: ${error.message}`);
      } else {
        console.error(`error: ${(error as Error).message ?? String(error)}`);
      }
      await holdForKeypress();
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
  if (first === "conversation") {
    const second = argv[1];
    if (second === "describe") {
      if (argv.length > 2) {
        console.error("conversation describe reads its requests from stdin and takes no arguments");
        return 2;
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
      console.error(TOP_HELP);
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
        console.error(TOP_HELP);
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
        const rest = argv.slice(1);
        const all = rest[0] === "--all";
        if ((all ? rest.slice(1) : rest).length > 0) {
          console.error("agents takes only --all");
          console.error(TOP_HELP);
          return 2;
        }
        const env = process.env;
        console.log(await runAgents(createHerdrCall(env), env, env["HOME"] ?? "", all));
        return 0;
      }
      const usage =
        'message takes a target and one text argument: message <target> "<text>" [--wait-unblocked] [--timeout <ms>]';
      const positionals: string[] = [];
      let waitUnblocked = false;
      let timeoutMs: number | undefined;
      const rest = argv.slice(1);
      for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index] as string;
        if (arg === "--wait-unblocked") {
          waitUnblocked = true;
        } else if (arg === "--timeout") {
          const value = Number(rest[index + 1]);
          if (!Number.isInteger(value) || value <= 0) {
            console.error("--timeout takes a positive integer of milliseconds");
            return 2;
          }
          timeoutMs = value;
          index += 1;
        } else if (arg.startsWith("--")) {
          console.error(`unknown option "${arg}"`);
          console.error(usage);
          return 2;
        } else {
          positionals.push(arg);
        }
      }
      const [target, text] = positionals;
      if (target === undefined || text === undefined || text === "" || positionals.length > 2) {
        console.error(usage);
        console.error(TOP_HELP);
        return 2;
      }
      if (timeoutMs !== undefined && !waitUnblocked) {
        console.error("--timeout requires --wait-unblocked");
        return 2;
      }
      console.log(
        await runMessage(createHerdrCall(process.env), process.env, target, text, {
          waitUnblocked,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }),
      );
      return 0;
    } catch (error) {
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
    // Internal: herdr's plugin event hook on pane.agent_detected. Quiet by
    // design — failures reach herdr's plugin log, never a notification.
    if (argv.length > 1) {
      console.error("name-tab takes no arguments");
      return 2;
    }
    return await nameTabFromEnvironment(process.env, process.env["HOME"] ?? "");
  }
  if (first === "execute-directive") {
    // Internal: the host spawns this detached so a hosted TUI's popup can
    // close the moment a directive is submitted. There is no terminal to
    // hold — errors go to stderr and, best-effort, to a herdr notification.
    try {
      if (argv.length !== 2) {
        throw new UsageError("execute-directive takes the directive as one JSON argument");
      }
      const directive = parseDirective(argv[1] ?? "");
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
  console.error(TOP_HELP);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
