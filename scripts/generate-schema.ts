/**
 * Generates `config.schema.json` from the zod schema in
 * `src/config-schema.ts` — the same schema `loadConfig` validates with, so
 * the published file cannot drift from what the launcher accepts. A schema
 * is that file's documentation, and this generator refuses to emit an
 * undocumented key.
 *
 * Regenerate with `bun run generate:schemas`. `test/config-schema.test.ts`
 * fails when the checked-in file drifts from its source.
 */
import { join } from "node:path";
import { z } from "zod";
import { configFileSchema } from "../src/config-schema.ts";

const CONFIG_TITLE = "agentsurface configuration";
const CONFIG_DESCRIPTION =
  "Per-user configuration for agentsurface, read from ~/.config/agentsurface/config.json (XDG_CONFIG_HOME relocates the directory). The file is optional: with no file at all, the roots default to ~/code and ~/src. When the file does exist it is validated strictly and every fault is a config_invalid domain error — a config that would be silently misread is worse than none, because a mistyped key would quietly scan the wrong roots.";

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every named property must carry a description: the schema documents the
 * file, and an undocumented key is a key the operator cannot write. */
function assertDocumented(node: unknown, where: string): void {
  if (!isObject(node)) return;
  if (node["type"] === "object" || node["properties"] !== undefined) {
    if (typeof node["description"] !== "string" && where !== "root") {
      throw new Error(`schema node "${where}" has no description`);
    }
    const props = node["properties"];
    if (isObject(props)) {
      for (const [key, value] of Object.entries(props)) {
        if (!isObject(value) || typeof value["description"] !== "string") {
          throw new Error(`schema property "${where}.${key}" has no description`);
        }
        assertDocumented(value, `${where}.${key}`);
      }
    }
    return;
  }
  if (isObject(node["items"])) assertDocumented(node["items"], `${where}[]`);
}

function publish(schema: z.ZodType, title: string, description: string): Schema {
  const generated = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Schema;
  if (generated["type"] !== "object" || generated["additionalProperties"] !== false) {
    throw new Error(`the ${title} root is no longer a strict object schema`);
  }
  assertDocumented(generated, "root");
  const { $schema, ...rest } = generated;
  return { $schema, title, description, ...rest };
}

export function buildConfigSchema(): Schema {
  return publish(configFileSchema, CONFIG_TITLE, CONFIG_DESCRIPTION);
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "config.schema.json");
  await Bun.write(path, `${JSON.stringify(buildConfigSchema(), null, 2)}\n`);
  console.log(`wrote ${path}`);
}
