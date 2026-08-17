import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROOTS, loadConfig } from "../src/config.ts";
import type { CliError } from "../src/errors.ts";
import type { Environ } from "../src/paths.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function home(): { env: Environ; home: string } {
  const root = mkdtempSync(join(tmpdir(), "agentsurface-config-"));
  roots.push(root);
  return { env: {}, home: join(root, "home") };
}

function writeConfig(content: string): { env: Environ; home: string } {
  const context = home();
  const directory = join(context.home, ".config", "agentsurface");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), content);
  return context;
}

describe("loadConfig", () => {
  test("no file means the personal default roots", () => {
    const context = home();
    const config = loadConfig(context.env, context.home);
    expect(config.exists).toBe(false);
    expect(config.roots).toEqual([...DEFAULT_ROOTS]);
  });

  test("a valid file's roots win, and $schema is tooling, not a setting", () => {
    const context = writeConfig(
      JSON.stringify({ $schema: "./config.schema.json", roots: ["~/work"] }),
    );
    const config = loadConfig(context.env, context.home);
    expect(config.exists).toBe(true);
    expect(config.roots).toEqual(["~/work"]);
  });

  test("priming choices parse; a malformed name refuses loudly", () => {
    const context = writeConfig(JSON.stringify({ priming: ["collab", "build", "orchestrate"] }));
    const config = loadConfig(context.env, context.home);
    expect(config.priming).toEqual(["collab", "build", "orchestrate"]);
    expect(config.roots).toEqual([...DEFAULT_ROOTS]);

    const bad = writeConfig(JSON.stringify({ priming: ["Not A Skill"] }));
    let caught: unknown;
    try {
      loadConfig(bad.env, bad.home);
    } catch (error) {
      caught = error;
    }
    expect((caught as CliError).code).toBe("config_invalid");
  });

  test("mistyped keys, empty roots, and broken JSON all refuse loudly", () => {
    for (const content of [
      JSON.stringify({ root: ["~/code"] }),
      JSON.stringify({ roots: [] }),
      "{not json",
      JSON.stringify(["~/code"]),
    ]) {
      const context = writeConfig(content);
      let caught: unknown;
      try {
        loadConfig(context.env, context.home);
      } catch (error) {
        caught = error;
      }
      expect((caught as CliError).code).toBe("config_invalid");
    }
  });
});
