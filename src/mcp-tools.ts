import { isAbsolute } from "node:path";
import * as z from "zod/v4";
import { CONTRACT, type ContractArgument, prepareInvocation, walkCommands } from "./contract.ts";
import { UsageError } from "./errors.ts";

function propertyName(argument: ContractArgument): string {
  return argument.name.replace(/^--/, "");
}

function property(argument: ContractArgument): z.ZodType {
  let scalar: z.ZodType;
  if (argument.choices) scalar = z.enum(argument.choices as [string, ...string[]]);
  else if (argument.type === "string") scalar = z.string().min(1);
  else if (argument.type === "boolean") scalar = z.boolean();
  else {
    let number = argument.type === "integer" ? z.number().int() : z.number();
    if (argument.minimum !== undefined) number = number.min(argument.minimum);
    if (argument.maximum !== undefined) number = number.max(argument.maximum);
    scalar = number;
  }
  const base = argument.repeatable ? z.array(scalar) : scalar;
  const described = base.describe(argument.description);
  const input = argument.required ? described : described.optional();
  return argument.default === undefined ? input : input.meta({ default: argument.default });
}

export function agentTools() {
  return walkCommands()
    .filter(({ command, isGroup }) => !isGroup && command.audience === "agent")
    .map(({ path, command }) => {
      const args = (command.arguments ?? []).filter(
        (argument) => (argument.role ?? "call") === "call",
      );
      const context = command.x_mcp_arguments ?? [];
      const shape: Record<string, z.ZodType> = {};
      for (const argument of [...args, ...context])
        shape[propertyName(argument)] = property(argument);
      const dependentSchemas: Record<string, unknown> = {};
      for (const constraint of command.constraints ?? []) {
        if (constraint.kind !== "requires") continue;
        const [source, ...targets] = constraint.arguments;
        if (source === undefined) continue;
        const sourceArgument = args.find((argument) => argument.name === source);
        if (sourceArgument?.type === "boolean") continue;
        dependentSchemas[source.replace(/^--/, "")] = {
          required: targets.map((name) => name.replace(/^--/, "")),
          properties: Object.fromEntries(
            targets.flatMap((name) =>
              args.find((argument) => argument.name === name)?.type === "boolean"
                ? [[name.replace(/^--/, ""), { const: true }]]
                : [],
            ),
          ),
        };
      }
      const input = z.strictObject(shape);
      return {
        path,
        name: path.replaceAll(" ", "_"),
        arguments: args,
        context,
        title: command.summary,
        description: [
          ...(command.blocking
            ? ["Blocks only when wait-unblocked is true; choose a bounded timeout."]
            : []),
          command.summary,
          `Runs the shared agentsurface ${path} handler in this process.`,
          ...(command.guidance ? [command.guidance] : []),
          ...(command.constraints ?? []).map(
            (constraint) =>
              constraint.description ?? `${constraint.kind}: ${constraint.arguments.join(", ")}`,
          ),
          ...(context.length
            ? [
                "Supply the caller's exact socket-path and caller-pane on every call; caller-session can verify the expected native session. The shared server never supplies a caller identity.",
              ]
            : []),
        ].join("\n\n"),
        input: Object.keys(dependentSchemas).length ? input.meta({ dependentSchemas }) : input,
        annotations: {
          readOnlyHint: command.mutates === false,
          destructiveHint: command.mutates === true,
          idempotentHint: command.mutates === false,
          openWorldHint: false,
        },
      };
    });
}

export type AgentTool = ReturnType<typeof agentTools>[number];

/** Structured call values, never an argv array passed back through a parser. */
export function invocationFor(tool: AgentTool, input: Record<string, unknown>) {
  const positional: string[] = [];
  const given = new Map<string, string[]>();
  for (const argument of [...tool.arguments, ...tool.context]) {
    const value = input[propertyName(argument)];
    if (value !== undefined && argument.format === "path" && !isAbsolute(String(value))) {
      throw new UsageError(`${propertyName(argument)} requires an absolute path for MCP`);
    }
  }
  for (const argument of tool.arguments) {
    const value = input[propertyName(argument)];
    if (value === undefined) continue;
    if (argument.positional) positional.push(String(value));
    else if (argument.type === "boolean") {
      if (value === true) given.set(argument.name, [""]);
    } else given.set(argument.name, Array.isArray(value) ? value.map(String) : [String(value)]);
  }
  return prepareInvocation(tool.path, positional, given);
}

export function serverInstructions(): string {
  return [
    CONTRACT.guidance,
    "Producer tools are agents, message, and guide. Operator and internal terminal workflows keep their existing entrypoints.",
    "Bus output remains plain text. Guide retains its fleet envelope in structuredContent and standalone JSON text. Domain failures set isError and preserve the original code, message, and recovery in that same envelope shape; the terminal's human output does not change. Usage and unexpected failures without a domain code stay plain tool errors.",
    "Use the caller's actual HERDR_SOCKET_PATH and HERDR_PANE_ID as socket-path and caller-pane. Include caller-session when the runtime supplies its native session ID. Live Herdr state determines workspace and sender names. No tool accepts a binary, environment, or arbitrary command override.",
    "Read each caller environment variable separately (for example, printenv HERDR_PANE_ID), or use labeled shell printf expansions. macOS printenv silently ignores all variable names after the first; omitted output from a multi-name printenv call is not evidence of missing pane identity. Recheck before reporting that the caller is outside Herdr.",
    "Messages need the task's authorization. Delivery confirmation is not proof of reading. Cancellation stops waiting and reaps active Herdr calls; if a prompt was in flight its delivery may be uncertain, so reconcile before resending. Native harness tools still handle subagent communication.",
  ].join("\n\n");
}
