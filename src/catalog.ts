import { z } from "zod";
import { CliError } from "./errors.ts";
import type { Environ } from "./paths.ts";

/**
 * The launch choice space, read from `agentlaunch x-catalog --x-json` at
 * runtime. AgentLaunch owns catalog resolution — families, spellings,
 * custom-file replacement — and this module only consumes the resolved
 * answer, so the two tools cannot drift on what a valid pair is.
 */

export interface LaunchModel {
  model: string;
  efforts: readonly string[];
  /** The model's own default effort, null when it falls through to the
   * harness default. */
  defaultEffort: string | null;
}

export interface LaunchHarness {
  harness: string;
  defaultModel: string;
  defaultEffort: string;
  /** The catalog's designated `model:effort` pair for metadata completions
   * (conversation slugs, summaries); null when the harness offers none. */
  metadataLevel: string | null;
  models: LaunchModel[];
}

const modelSchema = z.object({
  model: z.string().min(1),
  efforts: z.array(z.string().min(1)).min(1),
  default_effort: z.string().nullable(),
});

const harnessSchema = z.object({
  harness: z.string().min(1),
  default_model: z.string().min(1),
  default_effort: z.string().min(1),
  metadata_level: z.string().min(1).nullable(),
  models: z.array(modelSchema).min(1),
});

const envelopeSchema = z.object({
  schema_version: z.number(),
  ok: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      recovery: z.string().optional(),
    })
    .nullable(),
  data: z.object({ harnesses: z.array(harnessSchema).min(1) }).nullable(),
});

export function parseCatalogEnvelope(stdout: string): LaunchHarness[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError(
      "catalog_unreadable",
      "agentlaunch x-catalog did not print a JSON envelope",
      "run `agentlaunch x-catalog --x-json` by hand to see what it prints",
    );
  }
  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(
      "catalog_unreadable",
      "agentlaunch x-catalog printed an envelope this version does not understand",
      "update agentsurface and agentlaunch together",
    );
  }
  const envelope = result.data;
  if (!envelope.ok || envelope.data === null) {
    throw new CliError(
      envelope.error?.code ?? "catalog_failed",
      envelope.error?.message ?? "agentlaunch x-catalog failed",
      envelope.error?.recovery,
    );
  }
  return envelope.data.harnesses.map((entry) => ({
    harness: entry.harness,
    defaultModel: entry.default_model,
    defaultEffort: entry.default_effort,
    metadataLevel: entry.metadata_level,
    models: entry.models.map((model) => ({
      model: model.model,
      efforts: model.efforts,
      defaultEffort: model.default_effort,
    })),
  }));
}

export async function loadLaunchCatalog(env: Environ): Promise<LaunchHarness[]> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["agentlaunch", "x-catalog", "--x-json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    });
  } catch (error) {
    throw new CliError(
      "agentlaunch_missing",
      `agentlaunch could not be run: ${(error as Error).message}`,
      "install it: ~/code/agentlaunch/scripts/install.sh --install",
    );
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  const exitCode = await proc.exited;
  if (stdout.trim() !== "") return parseCatalogEnvelope(stdout);
  throw new CliError(
    "catalog_failed",
    `agentlaunch x-catalog exited ${exitCode} with no envelope: ${stderr.trim() || "no output"}`,
    "run `agentlaunch x-catalog --x-json` by hand",
  );
}
