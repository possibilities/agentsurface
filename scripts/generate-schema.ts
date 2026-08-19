/**
 * Generates `directive.schema.json` from the zod schema in
 * `src/directive-schema.ts` — the same schema the host validates stream lines
 * with, so the published file cannot drift from what the host executes. A
 * schema is the protocol's documentation for the tools on the other side of
 * the handoff, and this generator refuses to emit an undocumented key.
 *
 * Regenerate with `bun run generate:schemas`. `test/directive-schema.test.ts`
 * fails when the checked-in file drifts from its source.
 */
import { join } from "node:path";
import { z } from "zod";
import { sessionDirectiveSchema } from "../src/directive-schema.ts";

const DIRECTIVE_TITLE = "agentsurface session directive";
const DIRECTIVE_DESCRIPTION =
  "One session directive: a single JSON line a surface-hosted tool writes to its stdout — held as a pipe by `agentsurface host` while the tool renders on stderr — describing a session for agentsurface to realize on the herdr surface. The surface-handoff-protocol wiki page is the contract; agentsurface validates every line strictly and refuses unknown keys and unknown schema_versions.";

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every named property must carry a description: the schema documents the
 * protocol, and an undocumented key is a key an emitting tool cannot write. */
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

export function buildDirectiveSchema(): Schema {
  return publish(sessionDirectiveSchema, DIRECTIVE_TITLE, DIRECTIVE_DESCRIPTION);
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "directive.schema.json");
  await Bun.write(path, `${JSON.stringify(buildDirectiveSchema(), null, 2)}\n`);
  console.log(`wrote ${path}`);
}
