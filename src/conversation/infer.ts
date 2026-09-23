import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import type { Environ } from "../paths.ts";
import { slugify, stripUnsafeText } from "./prompt.ts";
import type { HarnessName } from "./resolve.ts";

/**
 * The inference half: run the conversation's own harness non-interactively
 * on the built instruction and normalize its answer into a slug. The argv
 * names the conversation's native harness through PATH. The installed
 * permission shim supplies its default unattended setting.
 *
 * Every call runs in a fixed dedicated cwd so the sessions these
 * completions inevitably record collect under one quarantined workspace
 * (`~/.claude/projects/-tmp-agentsurface-inference`, codex's recorded cwd)
 * instead of polluting real projects' transcript spaces. The path is constant
 * and created once.
 */

export const INFERENCE_CWD = "/tmp/agentsurface/inference";

/** Bounded completion: a slug needs very few tokens and no patience. */
export const INFERENCE_TIMEOUT_MS = 60_000;
const INFERENCE_ATTEMPTS = 2;

export interface HarnessInvocation {
  argv: string[];
  /** codex prints event noise; its answer arrives via --output-last-message
   * into this file. Null for harnesses that answer on stdout. */
  lastMessageFile: string | null;
}

export function composeInference(
  harness: HarnessName,
  instruction: string,
  runToken: string,
): HarnessInvocation {
  const launch = [harness];
  if (harness === "claude") {
    return { argv: [...launch, "-p", instruction], lastMessageFile: null };
  }
  const file = join(INFERENCE_CWD, `last-message-${runToken}.txt`);
  return {
    argv: [...launch, "exec", "--output-last-message", file, instruction],
    lastMessageFile: file,
  };
}

export interface InferenceOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type InferenceRunner = (argv: string[]) => Promise<InferenceOutcome>;

/** A metadata completion is not an occupant of the pane whose hook launched
 * it. Strip every Herdr identity/context variable before starting the
 * hidden harness, or that harness's integration reports its temporary
 * conversation back onto the real pane and replaces the conversation ref. */
export function inferenceEnvironment(env: Environ): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("HERDR_"),
    ),
  );
}

export function createInferenceRunner(env: Environ): InferenceRunner {
  const childEnv = inferenceEnvironment(env);
  return async (argv) => {
    mkdirSync(INFERENCE_CWD, { recursive: true });
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, {
        cwd: INFERENCE_CWD,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: childEnv,
      });
    } catch (error) {
      throw new CliError(
        "harness_missing",
        `${argv[0]} could not be run: ${(error as Error).message}`,
        "install the native harness and make it available on PATH",
      );
    }
    const timer = setTimeout(() => proc.kill(), INFERENCE_TIMEOUT_MS);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { stdout, stderr, exitCode };
  };
}

function answerOf(invocation: HarnessInvocation, outcome: InferenceOutcome): string {
  if (invocation.lastMessageFile === null) return outcome.stdout;
  try {
    const text = readFileSync(invocation.lastMessageFile, "utf8");
    rmSync(invocation.lastMessageFile, { force: true });
    return text;
  } catch {
    return "";
  }
}

export async function generateSlug(
  invocation: HarnessInvocation,
  run: InferenceRunner,
): Promise<string> {
  let lastFailure = "no answer";
  for (let attempt = 0; attempt < INFERENCE_ATTEMPTS; attempt += 1) {
    const outcome = await run(invocation.argv);
    if (outcome.exitCode !== 0) {
      lastFailure = `exit ${outcome.exitCode}: ${outcome.stderr.trim().slice(-300) || "no output"}`;
      continue;
    }
    const slug = slugify(stripUnsafeText(answerOf(invocation, outcome)).trim());
    if (slug !== null) return slug;
    lastFailure = "the completion produced no sluggable text";
  }
  throw new CliError(
    "slug_inference_failed",
    `${invocation.argv[0]} could not produce a slug (${lastFailure})`,
    "run the printed command by hand to see the harness's own report",
  );
}
