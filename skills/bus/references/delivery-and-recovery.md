# Delivery and recovery

## Addresses and identity

An agent's name is its tab label, usually a conversation slug or a hand rename.
Its native harness session ID is stable for that conversation. Its place is
the workspace label or worktree name. Names and places can collide or change.
A worktree accepts the label with or without Herdr's `worktree-` prefix, and
a renamed worktree also keeps its checkout basename as an alias.

Resolution checks, in order: matching names in the sender's workspace,
matching names in the whole Herdr session, native session IDs, then places.
More than one match in the first deciding tier returns `bus_target_ambiguous`
with candidates. A place stops uniquely addressing an agent as soon as a
second agent joins it. An agent that has not reported its session has no
native session ID yet; do not invent one.

MCP requires an explicit socket and caller pane per call, including listings.
The live agent row and pane context must agree; the adapter derives the
workspace and name from them. `caller-session`, when supplied, must match the
native session reported there. These values are local context, not credentials
or a replacement for task authorization. No global caller identity is stored.

Messages include a prefix naming the sender, native session when available,
and place when available. The recipient can reply using that session ID.
Plaintext message bodies, including newlines, travel as one value through the
existing Herdr client. They are never shell source.

## Delivery states

| State at delivery | Meaning |
|---|---|
| `idle` or `done` | Herdr submitted input for the recipient's next turn |
| `working` | Input was queued behind its current turn |
| `blocked` | Interactive input must be handled; Herdr refused delivery |
| `not ready` | The harness is not accepting input; Herdr refused delivery |

The confirmation uses the prompt response's fresh status. A working recipient
may surface the message during its turn or after it ends; timing is not
promised. Watching a status change is evidence of activity, not acknowledgment
of a particular message. Request an explicit reply when receipt matters.

There is no durable inbox, broker, or delayed delivery service. A rejected
message was not queued anywhere. `wait-unblocked` retries a delivery attempt
only after Herdr explicitly reports blocked or not-ready; the attempt is the
probe, so there is no separate status-read/send gap in that retry decision.
The default wait timeout is 120000 ms, but a smaller explicit bound usually
fits an agent turn better. Blocked human prompts may need the operator rather
than another retry. Use Notify when an authorized task needs to reach the
human away from the terminal.

Cancellation stops future retries and reaps an active Herdr child, including
one that ignores termination. An in-flight write may already have been
submitted before cancellation or connection loss. That is an uncertain
outcome, not evidence of non-delivery; reconcile before repeating the text.
A definite rejection with its domain code is different from a lost response.

## Recovery

| Code | Next step |
|---|---|
| `bus_sender_unavailable` | Recheck the caller's actual runtime socket, pane, and expected native session |
| `bus_target_not_found` | Refresh the listing and select the intended live recipient |
| `bus_target_ambiguous` | Use one of the reported native session IDs |
| `bus_target_blocked` | Continue other work, wait within a useful bound, or involve the operator |
| `bus_target_not_ready` | Retry only when readiness is expected to change |
| `bus_outside_pane` | The terminal caller lacks a Herdr pane identity |

Herdr's own coded failures remain intact when they reach MCP. Errors without
a domain code, including usage and connection failures, remain plain tool
errors. Fix an invalid argument or unavailable socket before retrying. Do not
interpret a failed listing as proof that no other agent exists.

## Operator routes

The terminal keeps `agentsurface agents [--all]` and
`agentsurface message <target> <text> [--wait-unblocked] [--timeout <ms>]`.
It reads the terminal's own Herdr environment and retains its human-readable
output. MCP calls the same handlers with explicit caller context.

The human popup host, confirmation dialogs, session dump/resume, tab naming,
and conversation helper routes remain operator or internal entrypoints.
Their tools own their choices and Herdr owns topology. MCP exposes only the
three producer tools; it has no arbitrary command or environment override.
