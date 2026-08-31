import { z } from "zod";
import { CliError } from "./errors.ts";

/**
 * The session directive format as a zod schema — the protocol's single
 * source of truth: the host validates every line a hosted tool appends with
 * it, and `scripts/generate-schema.ts` emits `directive.schema.json` from
 * it for the tools on the other side of the handoff. AgentSurface owns the
 * schema because it owns the execution; emitting tools (agentlaunch's
 * `--x-surface` form is the first) target the published file. The
 * `surface-handoff-protocol` wiki page is the contract.
 */

export const DIRECTIVE_SCHEMA_VERSION = 1;

const agentSchema = z
  .strictObject({
    kind: z
      .string()
      .min(1)
      .describe(
        "The herdr agent kind to start — a fleet harness name (claude or codex). Herdr runs the kind's bare command, which is the fleet shim into agentlaunch.",
      ),
    args: z
      .array(
        z
          .string()
          .describe(
            "One launch argument, typed into the pane by herdr — so no control characters.",
          ),
      )
      .describe(
        "Arguments for the agent start, before any intent delivery the host appends. For agentlaunch-shimmed kinds these are --x-* extension flags and native tokens.",
      ),
  })
  .describe("The agent to start in the created surface's root pane.");

export const sessionDirectiveSchema = z.strictObject({
  schema_version: z
    .number()
    .int()
    .describe("The directive format version this line speaks. Currently 1."),
  cwd: z
    .string()
    .min(1)
    .describe(
      "Absolute project directory the session works in: the workspace cwd, or the worktree's source repository.",
    ),
  worktree: z
    .boolean()
    .describe(
      "True to create a herdr worktree from cwd (herdr names the branch); false for a workspace or tab at cwd.",
    ),
  focus: z
    .boolean()
    .describe("Whether the created surface takes focus or opens in the background."),
  agent: agentSchema,
  session_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The native session id this directive's agent continues — set by resume emitters. When an agent pane on the surface already hosts this session, the host focuses that surface (per `focus`) instead of starting a duplicate agent; absent, the directive always starts one.",
    ),
  intent: z
    .string()
    .nullable()
    .describe(
      "The composed prompt text the session starts with, or null for none. The host spools it to a file and delivers it via agentlaunch's --x-prompt-file, because herdr types the launch and refuses control characters in arguments.",
    ),
  record: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Opaque extras the host merges into its launch record — bookkeeping the emitting tool wants remembered beside the host's own fields.",
    ),
});

export type SessionDirective = z.infer<typeof sessionDirectiveSchema>;

/** One stream line, strictly validated. The version gate is deliberate: a
 * directive this host does not understand must fail loudly, never execute
 * approximately. */
export function parseDirective(line: string): SessionDirective {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CliError("directive_invalid", "a directive line is not JSON");
  }
  const result = sessionDirectiveSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? "" : issue.path.map(String).join(".");
    throw new CliError(
      "directive_invalid",
      `a directive line is malformed${where === "" ? "" : ` at ${where}`}`,
      "update agentsurface and the emitting tool together",
    );
  }
  if (result.data.schema_version !== DIRECTIVE_SCHEMA_VERSION) {
    throw new CliError(
      "directive_unsupported",
      `directive schema_version ${result.data.schema_version} is not understood (this host speaks ${DIRECTIVE_SCHEMA_VERSION})`,
      "update agentsurface and the emitting tool together",
    );
  }
  return result.data;
}
