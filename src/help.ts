import { CLI_VERSION, CONTRACT, type ContractArgument, type ContractCommand } from "./guide.ts";

/**
 * Every help surface this CLI prints is a render of the agent contract in
 * guide.ts — `--help`, `--agent-help`, `--agent-teaser`, and `guide` with no
 * --json. Nothing here restates what a command is or what it takes; a
 * command added to the contract appears in all four without an edit.
 */

export const VERSION = `agentsurface ${CLI_VERSION}`;

const WIDTH = 78;

/** `hang` indents every line after the first, so a bullet or a code name
 * stays visible down the left edge of its own paragraph. */
function wrap(text: string, indent: number, hang = 0): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let current = "";
    let margin = indent;
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (candidate.length + margin > WIDTH && current !== "") {
        lines.push(" ".repeat(margin) + current);
        margin = indent + hang;
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current !== "") lines.push(" ".repeat(margin) + current);
  }
  return lines;
}

interface Node {
  path: string;
  command: ContractCommand;
  isGroup: boolean;
}

/** The command forest flattened to full space-joined paths, groups kept in
 * place so `--help` can print the line a group owns. */
export function walkCommands(
  commands: readonly ContractCommand[] = CONTRACT.commands,
  prefix: readonly string[] = [],
): Node[] {
  const nodes: Node[] = [];
  for (const command of commands) {
    const path = [...prefix, command.name];
    const subcommands = command.subcommands ?? [];
    nodes.push({ path: path.join(" "), command, isGroup: subcommands.length > 0 });
    if (subcommands.length > 0) nodes.push(...walkCommands(subcommands, path));
  }
  return nodes;
}

/** A leaf's invocation, spelled from its own arguments: `<name>` for a
 * required positional, `[--flag <value>]` for an optional valued flag. The
 * one place argument syntax is rendered, so no usage line can drift from
 * the argument list beside it. */
export function usageFor(node: Node): string {
  const parts = [`agentsurface ${node.path}`];
  if (node.isGroup) {
    return `${parts[0]} <${(node.command.subcommands ?? []).map((sub) => sub.name).join("|")}>`;
  }
  for (const argument of node.command.arguments ?? []) {
    parts.push(spellArgument(argument));
  }
  const stdin = node.command.stdin;
  if (stdin !== undefined) parts.push(`< <${stdin.accepts}>`);
  return parts.join(" ");
}

function spellArgument(argument: ContractArgument): string {
  if (argument.positional === true) {
    const repeat = argument.repeatable === true ? "…" : "";
    const inner = `${argument.name}${repeat}`;
    return argument.required === true ? `<${inner}>` : `[${inner}]`;
  }
  const value = argument.type === "boolean" ? "" : ` <${valueLabel(argument)}>`;
  const repeat = argument.repeatable === true ? "…" : "";
  const spelled = `${argument.name}${value}`;
  return argument.required === true ? spelled : `[${spelled}]${repeat}`;
}

function valueLabel(argument: ContractArgument): string {
  if (argument.choices !== undefined) return argument.choices.join("|");
  return argument.name.replace(/^--/, "");
}

function argumentLine(argument: ContractArgument): string {
  const details: string[] = [];
  if (argument.choices !== undefined) details.push(`one of ${argument.choices.join(", ")}`);
  if (argument.default !== undefined) details.push(`default ${String(argument.default)}`);
  if (argument.repeatable === true) details.push("repeatable");
  if (argument.direction === "out") details.push("written by the command");
  const suffix = details.length === 0 ? "" : ` (${details.join("; ")})`;
  return `${spellArgument(argument)} — ${argument.description}${suffix}`;
}

function describe(node: Node, indent: number): string[] {
  const lines: string[] = [];
  lines.push(...wrap(node.command.summary, indent));
  if (node.command.guidance !== undefined) lines.push(...wrap(node.command.guidance, indent));
  return lines;
}

export function renderHelp(): string {
  const nodes = walkCommands();
  const visible = nodes.filter((node) => node.command.audience !== "internal");
  const internal = nodes.filter((node) => node.command.audience === "internal");

  const lines: string[] = [];
  lines.push(...wrap(`agentsurface — ${CONTRACT.meta.purpose}`, 0));
  lines.push("");
  lines.push("Usage:");
  for (const node of visible) {
    if (node.isGroup) continue;
    lines.push(`  ${usageFor(node)}`);
  }
  lines.push("  agentsurface --help | --agent-help | --version");
  lines.push("");
  lines.push("Commands:");
  for (const node of visible) {
    lines.push(`  ${usageFor(node)}`);
    lines.push(...describe(node, 6));
    for (const argument of node.command.arguments ?? []) {
      lines.push(...wrap(argumentLine(argument), 6, 2));
    }
    if (node.command.stdin !== undefined) {
      lines.push(
        ...wrap(`stdin (${node.command.stdin.accepts}) — ${node.command.stdin.description}`, 6, 2),
      );
    }
    for (const constraint of node.command.constraints ?? []) {
      lines.push(...wrap(constraintLine(constraint), 6, 2));
    }
    lines.push("");
  }
  lines.push("Internal — invoked by herdr, the host, and agentlaunch, not by hand:");
  for (const node of internal) {
    lines.push(`  ${usageFor(node)}`);
    lines.push(...describe(node, 6));
    lines.push("");
  }
  // The guidance's closing paragraph is its operational footer — where state
  // lives and what the CLI needs to run. `--agent-help` prints the guidance
  // whole; `--help` prints only this, so a human browsing commands is not
  // handed the bus's routing doctrine as well.
  lines.push(...wrap(operationalFooter(), 0));
  return `${lines.join("\n")}\n`;
}

function constraintLine(constraint: {
  kind: string;
  arguments: readonly string[];
  required?: boolean;
  description?: string;
}): string {
  const named = constraint.arguments.join(", ");
  const shape =
    constraint.kind === "requires"
      ? `${constraint.arguments[0]} requires ${constraint.arguments.slice(1).join(", ")}`
      : constraint.kind === "conflicts"
        ? `${named} may not be combined`
        : `${constraint.required === true ? "exactly" : "at most"} one of ${named}`;
  return constraint.description === undefined ? shape : `${shape}: ${constraint.description}`;
}

/** The last paragraph of `guidance`, which guide.ts keeps as the operational
 * footer. */
export function operationalFooter(): string {
  const paragraphs = CONTRACT.guidance.split("\n\n");
  return paragraphs[paragraphs.length - 1] ?? "";
}

export function renderAgentHelp(): string {
  const lines: string[] = [];
  lines.push(`${VERSION} — agent contract`);
  lines.push("");
  lines.push(...wrap(CONTRACT.meta.purpose, 0));
  lines.push("");
  lines.push(...wrap(CONTRACT.guidance, 0));
  lines.push("");
  lines.push("Commands for agents:");
  for (const node of walkCommands()) {
    if (node.command.audience !== "agent") continue;
    lines.push(`  ${usageFor(node)}`);
    lines.push(...describe(node, 6));
    for (const argument of node.command.arguments ?? []) {
      lines.push(...wrap(argumentLine(argument), 6, 2));
    }
    for (const constraint of node.command.constraints ?? []) {
      lines.push(...wrap(constraintLine(constraint), 6, 2));
    }
    lines.push("");
  }
  lines.push("Opening moves:");
  for (const move of CONTRACT.concepts.agent_defaults) lines.push(...wrap(`- ${move}`, 2, 2));
  lines.push("");
  lines.push("Output:");
  for (const [field, meaning] of Object.entries(CONTRACT.concepts.output_contract.envelope)) {
    lines.push(...wrap(`${field}: ${meaning}`, 2, 2));
  }
  for (const [code, meaning] of Object.entries(CONTRACT.concepts.output_contract.exit_codes)) {
    lines.push(...wrap(`exit ${code} — ${meaning}`, 2, 2));
  }
  lines.push("");
  // Every code, not a curated subset: the contract does not say which
  // command raises which, so any filter here would be a guess maintained
  // beside the truth — the exact thing this render exists to avoid.
  lines.push("Error codes — the `code` in a failure:");
  for (const error of CONTRACT.concepts.error_codes) {
    lines.push(...wrap(`${error.code} — ${error.meaning}`, 2, 2));
    if (error.recovery !== undefined) lines.push(...wrap(`→ ${error.recovery}`, 6, 2));
  }
  lines.push("");
  lines.push(
    ...wrap(
      "`agentsurface guide --json` is this document in full, every command and every error code included; `agentsurface --help` adds the operator and internal entrypoints.",
      0,
    ),
  );
  return `${lines.join("\n")}\n`;
}

export function renderAgentTeaser(): string {
  const verbs = walkCommands()
    .filter((node) => node.command.audience === "agent" && node.command.name !== "guide")
    .map((node) => node.path)
    .join(", ");
  return `${VERSION} — ${CONTRACT.meta.purpose} Agent verbs: ${verbs}. Run \`agentsurface --agent-help\` for the routing guidance, or \`agentsurface guide --json\` for the machine-readable contract.\n`;
}
