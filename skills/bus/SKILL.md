---
name: bus
description: Message the other live agents on this machine's herdr surface with the agentsurface CLI — discover who is running, send, reply, and reason about what delivery does and does not promise. Use when coordinating with another running agent ("tell the reviewer session…", "ask the other agent…"), when a message prefixed "Message sent over the agent message bus" arrives and deserves a reply, or when checking which agents are on the surface.
---

# Bus — messages between agents on the surface

The bus is agent-to-agent messaging over herdr, the terminal surface every
fleet agent runs on. A message is delivered as **typed input**: herdr pastes
it into the target agent's harness and submits it, so it lands in that
agent's conversation exactly as if the operator had typed it — same turn
mechanics, same queueing, same transcript. There is no inbox, no broker,
and no store: a message that cannot be typed right now is not delivered,
and the CLI tells you so.

Verified against agentsurface 0.1.0. When this document and the installed
CLI disagree (`agentsurface --help`), the CLI wins.

## Who is around

```sh
agentsurface agents          # live agents in your workspace
agentsurface agents --all    # the whole surface, with a workspace column
```

Columns: `name`, `session`, `harness`, `status`, `cwd`. The **name** is the
label of the tab hosting the agent — usually a slug of its conversation's
first prompt, set automatically. Names are mutable (a tab rename changes
them) and can collide; the **session id** is the stable address. An agent
whose harness hasn't reported a session yet shows `-` and is addressable
only by name.

The `status` column is worth reading before you send — it tells you what
delivery will mean (see below).

## Sending

```sh
agentsurface message <target> "<text>" [--wait-unblocked] [--timeout <ms>]
```

The target is a name or a session id. A name is resolved in your workspace
first, then across the whole surface; if it matches more than one agent,
the send fails and the error lists the candidates' session ids — resend
with one of those. Your message arrives behind a prefix naming you:

```
Message sent over the agent message bus from agent named "<your-name>" (session <your-id>): <text>
```

so the receiver can reply without any other introduction. The confirmation
line echoes who it went to and — importantly — what state they were in.

## Delivery is not receipt

The target's status at the moment of delivery decides when (and whether)
your message is actually read:

- **idle / done** — the harness takes it as the next turn. The
  confirmation says "it will be read now".
- **working** — the harness queues it like any typed input. The
  confirmation says "queued behind its current turn". The target may
  surface it mid-turn or when the turn ends; there is no guarantee when,
  and a long-running turn can hold your message for a long time.
- **blocked** — the target is stuck on an interactive prompt (a trust
  dialog, a permission ask) that only a human can answer. Herdr refuses to
  type into it, the message is **not delivered**, and the CLI errors
  saying so.

Nothing acknowledges reading. If you need to know your message was seen,
say so in the message and ask for a reply over the bus; watching
`agentsurface agents` for the target to go `working` and back to `idle`
after your send is evidence of processing, not proof of understanding.

## When the target is blocked

A blocked agent is waiting on the operator, not on you. What you do about
it depends on how much the message matters and how long you can afford to
wait — these are the options, and the choice is yours:

- **Fail fast and move on.** The default. The error tells you it was not
  delivered; nothing is silently queued, so there is nothing to clean up.
- **Linger and retry**: `--wait-unblocked` keeps the sender process alive,
  retrying delivery every couple of seconds until it lands or `--timeout`
  (milliseconds, default 120000) expires — then reports the message
  undelivered, honestly. Match the timeout to your own patience: if your
  harness kills the tool call before the bus gives up, the process dies
  silently and nothing is delivered or reported.
- **Watch and resend yourself**: poll `agentsurface agents` for the status
  to change, then send again. More work than `--wait-unblocked`, but you
  stay free to do other things between polls.
- **Escalate to the human**: a blocked agent usually stays blocked until
  the operator returns, so if the message matters, more retries may be the
  wrong tool — the `notify` skill reaches the operator away from the
  terminal.

There is deliberately no deliver-later queue: a message held for hours
would land in a conversation that has moved on, seeming fresh when it
isn't.

## Receiving and replying

A bus message reaches you as a user turn prefixed with the sender's name
and session id. Reply over the bus, preferably to the **session id** —
names can have changed since the message was sent:

```sh
agentsurface message <sender-session-id> "<your reply>"
```

Like any typed message, one can surface in the middle of your turn if you
were working when it arrived; treat it as part of the turn and address it
as you continue.

## Cautions

- Messages are real user turns in the recipient's real conversation —
  recorded in its transcript, acted on by its harness. Keep them
  purposeful; a chatty back-and-forth burns the recipient's turns.
- Both commands need a herdr pane: the CLI reads your identity from the
  `HERDR_PANE_ID` herdr exports into every pane's environment.
- Messaging yourself works — the message queues behind your current turn
  and arrives when it ends. Occasionally useful, easy to confuse yourself
  with.
