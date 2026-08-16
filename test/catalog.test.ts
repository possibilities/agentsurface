import { describe, expect, test } from "bun:test";
import { parseCatalogEnvelope } from "../src/catalog.ts";
import { CliError } from "../src/errors.ts";

const GOOD = JSON.stringify({
  schema_version: 1,
  ok: true,
  error: null,
  data: {
    harnesses: [
      {
        harness: "claude",
        default_model: "opus-1m",
        default_effort: "medium",
        models: [
          {
            model: "fable",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            default_effort: null,
            family: "claude",
          },
        ],
      },
    ],
  },
});

describe("parseCatalogEnvelope", () => {
  test("maps the resolved catalog into launch choices", () => {
    const harnesses = parseCatalogEnvelope(GOOD);
    expect(harnesses).toHaveLength(1);
    const claude = harnesses[0]!;
    expect(claude.harness).toBe("claude");
    expect(claude.defaultModel).toBe("opus-1m");
    expect(claude.models[0]?.efforts).toContain("xhigh");
    expect(claude.models[0]?.defaultEffort).toBeNull();
  });

  test("carries agentlaunch's own failure through", () => {
    const envelope = JSON.stringify({
      schema_version: 1,
      ok: false,
      error: { code: "catalog_invalid", message: "bad catalog", recovery: "fix it" },
      data: null,
    });
    let caught: unknown;
    try {
      parseCatalogEnvelope(envelope);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe("catalog_invalid");
    expect((caught as CliError).message).toBe("bad catalog");
  });

  test("non-JSON and unrecognized envelopes are explicit failures", () => {
    for (const bad of ["", "not json", JSON.stringify({ ok: true, data: { harnesses: [] } })]) {
      let caught: unknown;
      try {
        parseCatalogEnvelope(bad);
      } catch (error) {
        caught = error;
      }
      expect((caught as CliError).code).toBe("catalog_unreadable");
    }
  });
});
