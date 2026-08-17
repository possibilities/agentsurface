import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "./config-schema.ts";
import { CliError } from "./errors.ts";
import type { Environ } from "./paths.ts";
import { configDirectory } from "./paths.ts";

/** Per-user configuration. The file is optional; without it the personal
 * default roots apply. When it exists it is validated strictly. */
export interface Config {
  roots: string[];
  /** Priming choices offered beside "none", in configured order. */
  priming: string[];
  path: string;
  exists: boolean;
}

export const DEFAULT_ROOTS = ["~/code", "~/src"] as const;

export function configPath(env: Environ, home: string): string {
  return join(configDirectory(env, home, "agentsurface"), "config.json");
}

export function loadConfig(env: Environ, home: string): Config {
  const path = configPath(env, home);
  if (!existsSync(path)) return { roots: [...DEFAULT_ROOTS], priming: [], path, exists: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(
      "config_invalid",
      `${path} is not valid JSON: ${(error as Error).message}`,
      `fix or remove ${path}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      "config_invalid",
      `${path} must hold a JSON object`,
      `fix or remove ${path}`,
    );
  }
  // "$schema" is editor tooling; it names no setting and is stripped
  // before validation, whatever its value.
  const { $schema: _schema, ...body } = parsed as Record<string, unknown>;
  const values = parseConfig(body, path);
  return {
    roots: values.roots ?? [...DEFAULT_ROOTS],
    priming: values.priming ?? [],
    path,
    exists: true,
  };
}
