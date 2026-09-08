import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentsurfaceMcpServer } from "./mcp-server.ts";

/** stdout is exclusively JSON-RPC until EOF, transport close, or a signal. */
export async function serveAgentsurfaceMcp(): Promise<void> {
  const { server, drain } = createAgentsurfaceMcpServer();
  const abortCalls = server.server.onclose;
  let stopping = false;
  let rejectClosed: ((reason: unknown) => void) | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    rejectClosed = reject;
    server.server.onclose = () => {
      abortCalls?.();
      resolve();
    };
  });
  const onEnd = () => {
    if (stopping) return;
    stopping = true;
    void server.close().catch((error: unknown) => rejectClosed?.(error));
  };
  process.stdin.once("end", onEnd);
  process.stdin.once("close", onEnd);
  process.once("SIGINT", onEnd);
  process.once("SIGTERM", onEnd);
  try {
    await server.connect(new StdioServerTransport());
    if (process.stdin.readableEnded || process.stdin.destroyed) onEnd();
    await closed;
  } finally {
    process.stdin.off("end", onEnd);
    process.stdin.off("close", onEnd);
    process.off("SIGINT", onEnd);
    process.off("SIGTERM", onEnd);
    await server.close();
    await drain();
  }
}
