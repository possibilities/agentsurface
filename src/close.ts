import { CliError, UsageError } from "./errors.ts";
import type { HerdrCall } from "./herdr.ts";
import { invoke } from "./herdr.ts";
import type { Environ } from "./paths.ts";

export type CloseTarget = "pane" | "tab" | "workspace";

function parseCloseTarget(argv: string[]): CloseTarget {
  const target = argv[0];
  if (argv.length !== 1 || (target !== "pane" && target !== "tab" && target !== "workspace")) {
    throw new UsageError("close-active takes exactly one target: pane, tab, or workspace");
  }
  return target;
}

export function closeTargetFromContext(env: Environ, target: CloseTarget): string {
  const raw = env["HERDR_PLUGIN_CONTEXT_JSON"];
  if (raw === undefined || raw === "") {
    throw new CliError(
      "missing_plugin_context",
      "close confirmation has no Herdr plugin context; nothing closed",
    );
  }

  let context: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    context = parsed as Record<string, unknown>;
  } catch {
    throw new CliError(
      "invalid_plugin_context",
      "close confirmation received invalid Herdr plugin context; nothing closed",
    );
  }

  const field =
    target === "pane" ? "focused_pane_id" : target === "tab" ? "tab_id" : "workspace_id";
  const id = context[field];
  if (typeof id !== "string" || id === "") {
    throw new CliError(
      "missing_close_target",
      `close confirmation context names no active ${target}; nothing closed`,
    );
  }
  return id;
}

export async function closeActive(call: HerdrCall, env: Environ, argv: string[]): Promise<void> {
  const target = parseCloseTarget(argv);
  await invoke(call, [target, "close", closeTargetFromContext(env, target)]);
}
