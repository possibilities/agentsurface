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
agentsurface agents --all    # the whole surface, with a place column
```

Columns: `name`, `session`, `harness`, `status`, `cwd`, and on `--all` a
`place`.

An agent answers to three addresses:

- **name** — the label of the tab hosting it, which is a slug of its
  conversation's first prompt, set automatically. Mutable (a tab rename
  changes it) and collidable.
- **session id** — the stable authority; neither mutable nor collidable.
  An agent whose harness hasn't reported one yet shows `-`.
- **place** — where it works: its worktree's name, or for a session that
  is not in a worktree, its workspace's label. A place addresses an agent
  only while it is the **only** agent there, which for a worktree session
  is the ordinary case.

The `status` column is worth reading before you send — it tells you what
delivery will mean (see below).

## Sending

```sh
agentsurface message <target> "<text>" [--wait-unblocked] [--timeout <ms>]
```

The target is a name, a session id, or a place. Resolution runs name first
(your workspace preferred, then the whole surface), then session id, then
place — so a name always wins a spelling that is also somebody's worktree.

A worktree name works in either spelling: `worktree-quiet-valley-a17d` as
herdr labels the workspace, or the short `quiet-valley-a17d` the sidebar
and the `place` column show.

Whichever tier decides, more than one match fails the send and the error
lists the candidates' session ids — resend with one of those. Two agents
sharing a worktree is exactly that case: the worktree stops being an
address the moment a second agent joins it, so a place that worked
yesterday can refuse today.

Your message arrives behind a prefix naming every address you answer to:

```
Message sent over the agent message bus from agent named "<your-name>" (session <your-id>, worktree <your-worktree>): <text>
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

A bus message reaches you as a user turn prefixed with every address the
sender answers to. Reply over the bus, preferably to the **session id** —
a name can have changed and a worktree can have gained a second agent
since the message was sent:

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
