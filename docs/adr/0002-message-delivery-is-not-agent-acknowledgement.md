# 0002: Message delivery is not agent acknowledgement

Status: retrospective, recorded 2026-09-08 from the current message-bus contract.

The bus identifies a live sender and recipient on Herdr and delivers through
Herdr's public typed-input path. Its successful result describes delivery to
that path, not proof that a model read, accepted or completed the request.
AgentSurface does not introduce a second durable inbox or acknowledgement
protocol over the harness's own conversation semantics.

Fresh identity checks and explicit delivery failures prevent a stale pane from
silently becoming another agent's recipient. Callers retain responsibility for
the desired outcome and any follow-up. This keeps the bus useful across sessions
without making a receipt claim the underlying transport cannot establish.

Evidence: [bus implementation](../../src/bus.ts),
[typed MCP handlers](../../src/mcp-server.ts), and
[current architecture](../architecture.md). Cancellation and EOF must drain
owned Herdr children rather than leave a late message behind.
