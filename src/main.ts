#!/usr/bin/env bun
import {
  conversationSlug,
  EXIT_NO_PROMPT,
  EXIT_TRANSCRIPT_NOT_FOUND,
} from "./conversation/slug.ts";
import { CliError, UsageError } from "./errors.ts";
import { TOP_HELP, VERSION } from "./help.ts";
import { createHerdrCall, HerdrError } from "./herdr.ts";
import { runLaunch } from "./launch/app.ts";
import { executeLaunch, notifyLaunchFailure, parseDetachedLaunch } from "./launch/executor.ts";
import { launchLogPath } from "./state.ts";
import { nameTabFromEnvironment } from "./tab-namer.ts";

/** The launcher usually runs inside a herdr popup, which closes with the
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
  if (first === "launch") {
    if (argv.length > 1) {
      console.error("launch takes no arguments");
      console.error(TOP_HELP);
      return 2;
    }
    try {
      return await runLaunch(process.env, process.env["HOME"] ?? "");
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
  if (first === "conversation") {
    const second = argv[1];
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
  if (first === "name-tab") {
    // Internal: herdr's plugin event hook on pane.agent_detected. Quiet by
    // design — failures reach herdr's plugin log, never a notification.
    if (argv.length > 1) {
      console.error("name-tab takes no arguments");
      return 2;
    }
    return await nameTabFromEnvironment(process.env, process.env["HOME"] ?? "");
  }
  if (first === "execute-launch") {
    // Internal: the launcher spawns this detached so the popup closes the
    // moment a launch is submitted. There is no terminal to hold — errors go
    // to stderr and, best-effort, to a herdr notification.
    try {
      const plan = parseDetachedLaunch(argv[1] ?? "");
      const env = process.env;
      await executeLaunch(createHerdrCall(env), launchLogPath(env, env["HOME"] ?? ""), plan);
      return 0;
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(error.message);
        return 2;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`error: ${message}`);
      await notifyLaunchFailure(process.env, message);
      return 1;
    }
  }
  console.error(`unknown command "${first}"`);
  console.error(TOP_HELP);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
