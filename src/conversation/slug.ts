import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { loadLaunchCatalog } from "../catalog.ts";
import { CliError, UsageError } from "../errors.ts";
import type { Environ } from "../paths.ts";
import { expandTilde } from "../paths.ts";
import { extractFirstPrompt } from "./extract.ts";
import { composeInference, createInferenceRunner, generateSlug } from "./infer.ts";
import {
  buildInstruction,
  centerTruncate,
  expandFileMentions,
  MENTION_FILE_CAP,
  stripSlashCommand,
} from "./prompt.ts";
import { parseHarnessName, resolveTranscript } from "./resolve.ts";

/**
 * `conversation slug <harness> <id-or-path>`: derive a short list-ready
 * slug from a conversation's first user prompt, using the conversation's
 * own harness at the catalog's metadata level. The distinct exit codes let
 * a caller distinguish "wrong reference" from "no prompt yet" — the
 * tab-naming plugin polls on the latter.
 */

export const EXIT_TRANSCRIPT_NOT_FOUND = 3;
export const EXIT_NO_PROMPT = 4;

/** Build the excerpt from a transcript's first prompt — the pure pipeline,
 * separated so tests drive it without a store or a catalog. */
export function excerptFrom(
  prompt: string,
  transcriptCwd: string | null,
  home: string,
  readFile: (path: string) => string | null = readMentionFile,
): string {
  const stripped = stripSlashCommand(prompt);
  const expanded = expandFileMentions(stripped, (mention) => {
    const tilded = expandTilde(mention, home);
    const path = isAbsolute(tilded) ? tilded : join(transcriptCwd ?? ".", tilded);
    return isAbsolute(path) ? readFile(path) : null;
  });
  return centerTruncate(expanded);
}

function readMentionFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8").slice(0, MENTION_FILE_CAP);
  } catch {
    return null;
  }
}

export async function conversationSlug(
  args: string[],
  env: Environ,
  home: string,
): Promise<string> {
  const [harnessArg, ref, ...extra] = args;
  if (harnessArg === undefined || ref === undefined || extra.length > 0) {
    throw new UsageError("conversation slug takes exactly <harness> <session-id-or-path>");
  }
  const harness = parseHarnessName(harnessArg);
  const path = resolveTranscript(harness, ref, env, home);
  const extracted = extractFirstPrompt(harness, readFileSync(path, "utf8"));
  if (extracted === null) {
    throw new CliError(
      "transcript_no_prompt",
      `${path} holds no user prompt yet`,
      "the conversation has not started; try again after the first prompt",
    );
  }
  const catalog = await loadLaunchCatalog(env);
  const level = catalog.find((entry) => entry.harness === harness)?.metadataLevel;
  if (level === undefined || level === null) {
    throw new CliError(
      "catalog_no_metadata_level",
      `the agentlaunch catalog designates no metadata level for ${harness}`,
      'give the harness a "metadata" level in agentlaunch\'s catalog',
    );
  }
  const excerpt = excerptFrom(extracted.prompt, extracted.cwd ?? dirname(path), home);
  const invocation = composeInference(
    harness,
    level,
    buildInstruction(excerpt),
    crypto.randomUUID(),
  );
  return generateSlug(invocation, createInferenceRunner(env));
}
