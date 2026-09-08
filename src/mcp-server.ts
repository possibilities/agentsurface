import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runAgents, runMessage } from "./bus.ts";
import { CONTRACT, contractEnvelope } from "./contract.ts";
import { CliError, UsageError } from "./errors.ts";
import { createHerdrCall, HerdrError } from "./herdr.ts";
import { agentTools, invocationFor, serverInstructions } from "./mcp-tools.ts";
import type { Environ } from "./paths.ts";

export function createAgentsurfaceMcpServer(env: Environ = process.env) {
  const fixedEnv = { ...env };
  for (const name of Object.keys(fixedEnv)) {
    if (name.startsWith("HERDR_") && name !== "HERDR_BIN_PATH" && name !== "HERDR_CONFIG_PATH") {
      delete fixedEnv[name];
    }
  }
  const lifetime = new AbortController();
  const active = new Set<Promise<CallToolResult>>();
  const server = new McpServer(
    { name: CONTRACT.meta.name, version: CONTRACT.meta.version },
    { instructions: serverInstructions() },
  );
  server.server.onclose = () => lifetime.abort();
  for (const tool of agentTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      async (args: unknown, extra): Promise<CallToolResult> => {
        const signal = AbortSignal.any([lifetime.signal, extra.signal]);
        const running = (async (): Promise<CallToolResult> => {
          try {
            signal.throwIfAborted();
            const input = (args ?? {}) as Record<string, unknown>;
            const parsed = invocationFor(tool, input);
            if (tool.path === "guide") {
              const envelope = contractEnvelope();
              return {
                structuredContent: envelope,
                content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
              };
            }
            const callerEnv = { ...fixedEnv, HERDR_SOCKET_PATH: String(input["socket-path"]) };
            const call = createHerdrCall(callerEnv, undefined, { signal });
            const context = {
              callerPane: String(input["caller-pane"]),
              ...(input["caller-session"] === undefined
                ? {}
                : { callerSession: String(input["caller-session"]) }),
              signal,
            };
            if (tool.path !== "agents" && tool.path !== "message") {
              throw new Error(`No shared producer handler for ${tool.path}`);
            }
            const text =
              tool.path === "agents"
                ? await runAgents(
                    call,
                    callerEnv,
                    fixedEnv["HOME"] ?? "",
                    parsed.flag("--all"),
                    context,
                  )
                : await runMessage(call, callerEnv, parsed.positional[0]!, parsed.positional[1]!, {
                    ...context,
                    waitUnblocked: parsed.flag("--wait-unblocked"),
                    ...(parsed.integer("--timeout") === undefined
                      ? {}
                      : { timeoutMs: parsed.integer("--timeout")! }),
                  });
            return { content: [{ type: "text", text }] };
          } catch (error) {
            if (signal.aborted) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      tool.path === "message"
                        ? "Call cancelled. An in-flight message may have been delivered; reconcile its outcome before resending."
                        : "Call cancelled.",
                  },
                ],
              };
            }
            if (error instanceof CliError || (error instanceof HerdrError && error.code !== null)) {
              const recovery =
                error instanceof CliError
                  ? error.recovery
                  : "check the selected Herdr socket and live target";
              const envelope = {
                schema_version: 1,
                ok: false,
                data: null,
                error: {
                  code: error.code,
                  message: error.message,
                  ...(recovery ? { recovery } : {}),
                },
              };
              return {
                isError: true,
                structuredContent: envelope,
                content: [
                  {
                    type: "text",
                    text: `${error.code}: ${error.message}${recovery ? `\nrecovery: ${recovery}` : ""}`,
                  },
                  { type: "text", text: JSON.stringify(envelope, null, 2) },
                ],
              };
            }
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `${error instanceof UsageError ? "invalid call" : "unexpected failure"}: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        })();
        active.add(running);
        try {
          return await running;
        } finally {
          active.delete(running);
        }
      },
    );
  }
  return {
    server,
    drain: async () => {
      await Promise.allSettled([...active]);
    },
  };
}
