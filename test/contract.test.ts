import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WAIT_TIMEOUT_MS } from "../src/bus.ts";
import {
  CONTRACT,
  type ContractCommand,
  contractEnvelope,
  parseInvocation,
  usageLine,
  walkCommands,
} from "../src/contract.ts";
import { UsageError } from "../src/errors.ts";
import { renderAgentHelp, renderAgentTeaser, renderHelp } from "../src/help.ts";

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

describe("the parser is derived from the contract", () => {
  test("every declared flag is accepted, and nothing else is", () => {
    for (const { path, command, isGroup } of walkCommands()) {
      if (isGroup) continue;
      const positionals = (command.arguments ?? []).filter((a) => a.positional === true);
      // A passthrough swallows the rest of argv, so an unknown flag after
      // its first word belongs to the other program, not to us.
      const passthrough = positionals.some((a) => a.x_passthrough !== undefined);
      if (passthrough) continue;
      expect(() => parseInvocation(path, ["--no-such-flag"]), path).toThrow(UsageError);
    }
  });

  test("arity, choices, and bounds come from the declaration", () => {
    expect(parseInvocation("agents", ["--all"]).flag("--all")).toBe(true);
    expect(parseInvocation("agents", []).flag("--all")).toBe(false);
    expect(() => parseInvocation("agents", ["surplus"])).toThrow(UsageError);

    expect(parseInvocation("close-active", ["pane"]).positional).toEqual(["pane"]);
    expect(() => parseInvocation("close-active", ["session"])).toThrow(UsageError);
    expect(() => parseInvocation("close-active", [])).toThrow(UsageError);

    expect(() => parseInvocation("conversation slug", ["gemini", "id"])).toThrow(UsageError);
    expect(() => parseInvocation("conversation slug", ["claude"])).toThrow(UsageError);

    // --timeout declares minimum 1, so the bound is enforced where it is
    // stated rather than restated in main.ts.
    const wait = ["--wait-unblocked"];
    expect(
      parseInvocation("message", ["a", "b", ...wait, "--timeout", "5"]).integer("--timeout"),
    ).toBe(5);
    expect(() => parseInvocation("message", ["a", "b", ...wait, "--timeout", "0"])).toThrow(
      UsageError,
    );
    expect(() => parseInvocation("message", ["a", "b", ...wait, "--timeout", "1.5"])).toThrow(
      UsageError,
    );
    expect(() =>
      parseInvocation("message", ["a", "b", ...wait, "--timeout", "9", "--timeout", "8"]),
    ).toThrow(UsageError);
  });

  test("a repeatable flag accumulates and a single one does not", () => {
    expect(
      parseInvocation("session dump", ["--session", "a", "--session", "b"]).options("--session"),
    ).toEqual(["a", "b"]);
    expect(() =>
      parseInvocation("session resume", ["snap", "--session", "a", "--session", "b"]),
    ).toThrow(UsageError);
  });

  test("the requires constraint is enforced from the contract", () => {
    // A timeout only bounds the wait, so it is a usage fault without it.
    expect(() => parseInvocation("message", ["a", "b", "--timeout", "5"])).toThrow(UsageError);
    const routed = parseInvocation("message", ["a", "b", "--wait-unblocked", "--timeout", "5"]);
    expect(routed.flag("--wait-unblocked")).toBe(true);
    // main.ts adds only the check the contract cannot state — an empty text.
    expect(() => parseInvocation("message", ["a"])).toThrow(UsageError);
  });

  test("a passthrough argument hands the rest of argv to the other program", () => {
    expect(parseInvocation("host", ["--", "agentlaunch", "--x-surface"]).rest).toEqual([
      "agentlaunch",
      "--x-surface",
    ]);
    expect(parseInvocation("host", ["agentlaunch", "--x-surface"]).rest).toEqual([
      "agentlaunch",
      "--x-surface",
    ]);
    expect(() => parseInvocation("host", ["--x-surface"])).toThrow(UsageError);
    expect(() => parseInvocation("host", [])).toThrow(UsageError);

    // confirm's separator is required: the command is a gated payload, and a
    // bare word before -- is a misspelled option, not the command.
    const gated = parseInvocation("confirm", ["--title", "Close pane?", "--", "herdr", "pane"]);
    expect(gated.option("--title")).toBe("Close pane?");
    expect(gated.rest).toEqual(["herdr", "pane"]);
    expect(() => parseInvocation("confirm", ["--title", "t", "herdr"])).toThrow(UsageError);
    expect(() => parseInvocation("confirm", ["--", "herdr"])).toThrow(UsageError);
    expect(() => parseInvocation("confirm", ["--title", "t", "--"])).toThrow(UsageError);
  });

  test("usage lines are spelled from the arguments the parser enforces", () => {
    expect(usageLine("host")).toBe("agentsurface host [--] <command…>");
    expect(usageLine("confirm")).toBe("agentsurface confirm --title <title> -- <command…>");
    expect(usageLine("conversation")).toBe("agentsurface conversation <slug|describe>");
    expect(usageLine("conversation describe")).toBe("agentsurface conversation describe < <json>");
  });
});

describe("the fields adoption asked for", () => {
  test("every example is a real invocation of the command that carries it", () => {
    let counted = 0;
    for (const { path, command } of walkCommands()) {
      for (const example of command.examples ?? []) {
        counted += 1;
        expect(example.invocation, path).toContain(`agentsurface ${path}`);
        expect(example.description.length, path).toBeGreaterThan(0);
      }
    }
    // The hand-written help carried worked invocations; a render without
    // them would be worse than what the contract replaced.
    expect(counted).toBeGreaterThan(10);
  });

  test("blocking is declared on the commands that wait, and on no others", () => {
    const blocking = walkCommands()
      .filter((node) => node.command.blocking === true)
      .map((node) => node.path);
    expect(blocking.sort()).toEqual(["confirm", "host", "message"]);
  });

  test("only guide --json is anything but a per-call knob", () => {
    for (const { path, command } of walkCommands()) {
      for (const argument of command.arguments ?? []) {
        if (argument.role === undefined) continue;
        expect(`${path} ${argument.name} ${argument.role}`).toBe("guide --json output-format");
      }
    }
  });

  test("a bound is declared where one exists", () => {
    const timeout = (findCommandArguments("message") ?? []).find((a) => a.name === "--timeout");
    expect(timeout?.minimum).toBe(1);
    expect(timeout?.default).toBe(DEFAULT_WAIT_TIMEOUT_MS);
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

function findCommandArguments(path: string) {
  return walkCommands().find((node) => node.path === path)?.command.arguments;
}
