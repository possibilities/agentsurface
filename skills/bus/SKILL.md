---
name: bus
description: >-
  Discover and message independent agents on the local Herdr surface with
  agentsurface. Use for cross-session coordination or replies to agent message
  bus messages. Native subagent communication uses the harness's own tools.
---

# Bus

Use the bus for authorized coordination with independent agents on the local
Herdr surface, including replies to their messages. Native harness tools handle
subagent communication. A bus message becomes typed input in the recipient's
real conversation; keep it purposeful and grounded in the user's task.

## Discover and identify the caller

Use the `agentsurface` MCP server directly. Select the tool from the harness's
catalog or tool search, inspect its input schema, and call it with JSON
arguments. The host may prefix tool names with the server name. `guide`
provides the installed command contract and recovery guidance.
The producer tools are `agents`, `message`, and `guide`.

Every bus call requires the caller's exact `HERDR_SOCKET_PATH` as the absolute
`socket-path`, and `HERDR_PANE_ID` as `caller-pane`. Read those specific runtime
values with native tools. Include `caller-session` when the runtime supplies its
native session ID, such as Codex's `CODEX_THREAD_ID`. Do not use the shared
server's environment or guess another pane's identity. If this runtime is not
in a Herdr pane, use its supported communication tools.

The adapter resolves workspace and sender names from fresh Herdr state. A
missing, inconsistent, or reused caller returns `bus_sender_unavailable`.
Recheck the runtime identity; changing the expected session to somebody else's
would misattribute the message.

## Find the recipient and send

Use `agents` when the recipient or its current state is uncertain. The default
list covers your workspace; `all:true` covers the selected Herdr session and
adds each agent's place. These arguments illustrate the shape; replace both
context values with those from your runtime:

```json
{"socket-path":"/absolute/path/from/HERDR_SOCKET_PATH","caller-pane":"pane-from-HERDR_PANE_ID","all":true}
```

A recipient can be addressed by its tab name, native session ID, or place
(workspace or worktree name). Names are resolved in your workspace first,
then across the session, followed by session ID and place. Collisions return
candidates instead of guessing. Prefer the recipient's current session ID for
a reply or when a name or place is ambiguous. Keep IDs in calls and use
recognizable names in human-facing prose.

Call `message` with the same caller context, `target`, and the full `text` as a
string. Read its delivery confirmation: idle/done takes the next turn; working
queues the message; blocked/not-ready rejects it. Delivery does not acknowledge
reading or understanding. Ask for a reply in the message when that matters.

## Waiting, replies, and results

Use `wait-unblocked:true` with a bounded `timeout` in milliseconds only when
waiting for readiness helps the task. A timeout requires that true flag.
The default is to fail promptly. There is no inbox or deliver-later queue.
Cancellation stops waiting and active Herdr calls; an interrupted prompt may
have been delivered, so reconcile an uncertain outcome before resending.
For address resolution, delivery states, and recovery, read
[delivery and recovery](references/delivery-and-recovery.md).

`agents` and `message` return plain text. `guide` keeps the fleet envelope in
`structuredContent` and standalone JSON text. Domain failures set `isError`
and preserve their code, message, and recovery in that envelope's `error`.
Inspect `isError` and `structuredContent`; if the host returns only content,
parse the standalone JSON block. Diagnostic prose is separate. Usage and
uncoded failures stay plain errors.

A received bus message carries another agent's context. Reply over the bus
when coordination is authorized, and check requested actions against the
user's task and your owned work. The operator CLI and Surface's launch,
backup, and terminal workflows remain available through their existing routes.
