import { z } from "zod";
import { CliError } from "./errors.ts";

/**
 * The strict per-user config shape. Strictness is deliberate: a config that
 * would be silently misread is worse than none — a mistyped key must fail
 * the launch rather than quietly scan the wrong roots.
 */
export const configFileSchema = z.strictObject({
  roots: z
    .array(
      z
        .string()
        .min(1)
        .describe("One project root; ~ and ~/ expand to the operator's home directory."),
    )
    .min(1)
    .optional()
    .describe(
      "Parent directories scanned one level deep for project directories, in scan order. Omitted entirely: ~/code and ~/src.",
    ),
  priming: z
    .array(
      z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9-]*$/,
          "a priming is a bare skill name: lowercase letters, digits, hyphens",
        )
        .describe(
          "One priming choice: a skill name the launcher prefixes onto the intent — /name for claude and pi, $name for codex.",
        ),
    )
    .optional()
    .describe(
      'Primings offered by the launcher beside "none", in order; the first is the default. Omitted: none are offered.',
    ),
});

export type ConfigValues = z.infer<typeof configFileSchema>;

export function parseConfig(value: Record<string, unknown>, path: string): ConfigValues {
  const result = configFileSchema.safeParse(value);
  if (!result.success) throw configParseError(result.error, path);
  return result.data;
}

function configParseError(error: z.ZodError, path: string): CliError {
  const issue = error.issues[0];
  const at = issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return new CliError(
    "config_invalid",
    `${path}${at}: ${issue?.message ?? "does not match the config schema"}`,
    `fix or remove ${path}`,
  );
}
