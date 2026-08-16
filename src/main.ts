#!/usr/bin/env bun
import { CliError, UsageError } from "./errors.ts";
import { TOP_HELP, VERSION } from "./help.ts";
import { HerdrError } from "./herdr.ts";
import { runLaunch } from "./launch/app.ts";

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
  console.error(`unknown command "${first}"`);
  console.error(TOP_HELP);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
