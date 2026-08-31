import {
  CLI_VERSION,
  CONTRACT,
  type CommandNode,
  type ContractArgument,
  ENTRYPOINT_FLAGS,
  spellArgument,
  usageLine,
  walkCommands,
} from "./contract.ts";

/**
 * Every help surface this CLI prints is a render of the agent contract in
 * contract.ts — `--help`, `--agent-help`, `--agent-teaser`, and `guide` with
 * no --json. Nothing here restates what a command is or what it takes; a
 * command added to the contract appears in all four without an edit, and the
 * usage lines are spelled by the same function the parser obeys.
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

function argumentLine(argument: ContractArgument): string {
  const details: string[] = [];
  if (argument.choices !== undefined) details.push(`one of ${argument.choices.join(", ")}`);
  if (argument.default !== undefined) details.push(`default ${String(argument.default)}`);
  if (argument.repeatable === true) details.push("repeatable");
  if (argument.direction === "out") details.push("written by the command");
  const suffix = details.length === 0 ? "" : ` (${details.join("; ")})`;
  return `${spellArgument(argument)} — ${argument.description}${suffix}`;
}

function describe(node: CommandNode, indent: number): string[] {
  const lines: string[] = [];
  lines.push(...wrap(node.command.summary, indent));
  if (node.command.guidance !== undefined) lines.push(...wrap(node.command.guidance, indent));
  return lines;
}

/** Everything `--help` and `--agent-help` both print about one leaf, so the
 * two renders cannot describe the same command differently. */
function detail(node: CommandNode, indent: number): string[] {
  const lines = describe(node, indent);
  if (node.command.blocking === true) {
    lines.push(...wrap("Blocking: it waits, and may not return promptly.", indent));
  }
  for (const argument of node.command.arguments ?? []) {
    lines.push(...wrap(argumentLine(argument), indent, 2));
  }
  if (node.command.stdin !== undefined) {
    lines.push(
      ...wrap(
        `stdin (${node.command.stdin.accepts}) — ${node.command.stdin.description}`,
        indent,
        2,
      ),
    );
  }
  for (const constraint of node.command.constraints ?? []) {
    lines.push(...wrap(constraintLine(constraint), indent, 2));
  }
  // The worked invocations the hand-written help carried. A render that
  // dropped them would be visibly worse than what the contract replaced.
  for (const example of node.command.examples ?? []) {
    lines.push(...wrap(`$ ${example.invocation}`, indent, 4));
    lines.push(...wrap(example.description, indent + 2, 0));
  }
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
    lines.push(`  ${usageLine(node.path)}`);
  }
  lines.push(
    `  ${CONTRACT.meta.name} ${ENTRYPOINT_FLAGS.map((entry) => entry.spellings[0]).join(" | ")}`,
  );
  lines.push("");
  lines.push("Commands:");
  for (const node of visible) {
    lines.push(`  ${usageLine(node.path)}`);
    lines.push(...detail(node, 6));
    lines.push("");
  }
  lines.push("Internal — invoked by herdr, the host, and agentlaunch, not by hand:");
  for (const node of internal) {
    lines.push(`  ${usageLine(node.path)}`);
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
        : constraint.kind === "at_least_one"
          ? `at least one of ${named}`
          : `${constraint.required === true ? "exactly" : "at most"} one of ${named}`;
  return constraint.description === undefined ? shape : `${shape}: ${constraint.description}`;
}

/** The last paragraph of `guidance`, which contract.ts keeps as the operational
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
    lines.push(`  ${usageLine(node.path)}`);
    lines.push(...detail(node, 6));
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
