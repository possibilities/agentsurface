import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildConfigSchema } from "../scripts/generate-schema.ts";

describe("config.schema.json", () => {
  test("the checked-in schema matches its zod source", () => {
    const published = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "config.schema.json"), "utf8"),
    );
    expect(published).toEqual(buildConfigSchema());
  });
});
