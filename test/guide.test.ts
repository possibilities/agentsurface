import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT, type ContractCommand, contractEnvelope } from "../src/guide.ts";
import { renderAgentHelp, renderAgentTeaser, renderHelp, walkCommands } from "../src/help.ts";

/**
 * The repository owns its own conformance: agentstart publishes the fleet
 * contract, but a contract that only agentstart checks goes stale between
 * scans. These assertions are the ones the fleet validator makes, plus the
 * one it cannot: that the contract lists exactly the commands main.ts
 * routes.
 */

const leaves = walkCommands().filter((node) => !node.isGroup);
const groups = walkCommands().filter((node) => node.isGroup);

describe("agent contract", () => {
  test("guide --json is the envelope the fleet schema expects", () => {
    const envelope = contractEnvelope();
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeNull();
    expect(envelope.schema_version).toBe(1);
    expect(envelope.data.contract_version).toBe(1);
    expect(envelope.data.meta.audience).toBe("agent");
    // An agent-facing CLI owes the conceptual layer.
    expect(envelope.data.guidance.length).toBeGreaterThan(0);
    expect(envelope.data.concepts.error_codes.length).toBeGreaterThan(0);
    expect(Object.keys(envelope.data.concepts.output_contract.exit_codes)).toContain("2");
  });

  test("every leaf declares mutates and arguments, every group declares neither", () => {
    for (const { path, command } of leaves) {
      expect(typeof command.mutates, `${path}.mutates`).toBe("boolean");
      expect(Array.isArray(command.arguments), `${path}.arguments`).toBe(true);
    }
    for (const { path, command } of groups) {
      expect(command.mutates, `${path}.mutates`).toBeUndefined();
      expect(command.arguments, `${path}.arguments`).toBeUndefined();
    }
  });

  test("read_only_commands is exactly the non-mutating leaves, by full path", () => {
    const readOnly = leaves.filter((node) => node.command.mutates === false).map((n) => n.path);
    expect([...CONTRACT.concepts.read_only_commands].sort()).toEqual(readOnly.sort());
  });

  test("a flag wears its dashes and a positional does not", () => {
    for (const { path, command } of walkCommands()) {
      for (const argument of command.arguments ?? []) {
        const looksLikeFlag = argument.name.startsWith("-");
        expect(argument.positional === true, `${path} ${argument.name}`).toBe(!looksLikeFlag);
        if (argument.direction !== undefined) expect(argument.format).toBe("path");
      }
      for (const constraint of command.constraints ?? []) {
        const names = (command.arguments ?? []).map((argument) => argument.name);
        for (const named of constraint.arguments) expect(names).toContain(named);
      }
    }
  });

  test("no agent command requires stdin, which an out-of-process caller has not got", () => {
    for (const { path, command } of walkCommands()) {
      if (command.audience !== "agent") continue;
      expect(command.stdin?.required, `${path}.stdin`).not.toBe(true);
    }
  });

  test("every error code the CLI raises is declared, and every declared code exists", () => {
    const declared = new Set(CONTRACT.concepts.error_codes.map((error) => error.code));
    const raised = new Set<string>();
    for (const file of sourceFiles()) {
      for (const match of file.matchAll(/new CliError\(\s*"([a-z_]+)"/g)) {
        raised.add(match[1] as string);
      }
    }
    expect(raised.size).toBeGreaterThan(0);
    for (const code of raised) expect([...declared], `raised ${code}`).toContain(code);
    for (const code of declared) expect([...raised], `declared ${code}`).toContain(code);
  });

  test("the contract lists exactly the commands main.ts routes", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const routed = new Set<string>();
    for (const match of source.matchAll(/first === "([a-z][a-z-]*)"/g)) {
      routed.add(match[1] as string);
    }
    const declared = new Set(CONTRACT.commands.map((command: ContractCommand) => command.name));
    expect([...routed].sort()).toEqual([...declared].sort());
  });
});

describe("help renders from the contract", () => {
  test("--help names every command, internal ones included", () => {
    const help = renderHelp();
    for (const { path } of walkCommands()) expect(help).toContain(path);
  });

  test("--agent-help carries the guidance verbatim and only the agent verbs", () => {
    const agentHelp = renderAgentHelp();
    expect(agentHelp).toContain("Opening moves:");
    expect(agentHelp).toContain("names change, and a");
    expect(agentHelp).toContain("agentsurface message <target> <text>");
    // The internal entrypoints are named in the guidance as things not to
    // call, but never offered as invocations.
    expect(agentHelp).not.toContain("agentsurface execute-directive <directive>");
    for (const error of CONTRACT.concepts.error_codes) expect(agentHelp).toContain(error.code);
  });

  test("--agent-teaser is one line naming the agent verbs", () => {
    const teaser = renderAgentTeaser();
    expect(teaser.trimEnd().split("\n")).toHaveLength(1);
    expect(teaser).toContain("agents, message");
  });
});

/** agentstart owns the fleet schema; when this machine has that checkout,
 * hold the contract to it as well as to the assertions above. */
describe("fleet validator", () => {
  const validator = join(homedir(), "code", "agentstart", "scripts", "validate-agent-contract.ts");
  test.skipIf(!existsSync(validator))("agentstart validates this contract", () => {
    const path = join(tmpdir(), `agentsurface-contract-${process.pid}.json`);
    writeFileSync(path, JSON.stringify(contractEnvelope()));
    const run = Bun.spawnSync(["bun", validator, "--file", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    rmSync(path, { force: true });
    expect(run.stderr.toString() + run.stdout.toString()).toContain("conforms to version 1");
  });
});

function sourceFiles(): string[] {
  const root = new URL("../src/", import.meta.url);
  const files = [
    "bus.ts",
    "catalog.ts",
    "close.ts",
    "confirm.ts",
    "directive-schema.ts",
    "session-snapshot.ts",
    "conversation/infer.ts",
    "conversation/resolve.ts",
    "conversation/slug.ts",
  ];
  return files.map((name) => readFileSync(new URL(name, root), "utf8"));
}
