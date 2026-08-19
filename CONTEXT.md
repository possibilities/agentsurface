# Glossary

**Integration** — One AgentSurface subcommand tying fleet tools to the herdr
session. `host` is the first. _Avoid_: feature, mode.

**Host** — The `host` integration: run one fleet TUI on the popup's
terminal and realize every session directive it emits, at once and
detached. The tool is a black box with a terminal; directives are the only
thing read back. _Avoid_: wrapper, launcher.

**Session directive** — One schema-versioned JSON line a hosted tool
appends to the sink, describing a session for the surface to realize: cwd,
worktree, focus, the agent kind with its arguments, the composed intent,
and opaque record extras. Strictly validated, hard version gate, published
as `directive.schema.json`; the `surface-handoff-protocol` wiki page is
the contract. _Avoid_: plan, launch request.

**Sink** — The fresh per-run append-only file the host creates and names to
its tool in `AGENTSURFACE_DIRECTIVES`; the host tails it for complete
lines while the tool runs, and keeps it afterwards as evidence, pruned by
age. _Avoid_: pipe, socket.

**Launch** — Realizing one session directive: create the herdr workspace
or worktree, start the agent in its root pane, deliver the intent.
_Avoid_: run, spawn.

**Intent** — The directive's composed prompt text; it rides the launch as a
native positional token (via the spool file and `--x-prompt-file`), so the
harness queues it behind any startup dialog (folder trust) and submits it
once the dialog clears. _Avoid_: task, message.

**Project** — The directive's cwd: the directory the session works in. Not
necessarily a git repository; only the worktree option needs one.
_Avoid_: repo.

**Surface** — Herdr, the terminal workspace manager the fleet launches onto.
AgentSurface drives it only through the `herdr` CLI's socket API.

**Conversation** — One harness session's transcript in its native store,
named by harness plus session id (or a literal transcript path). _Avoid_:
chat, thread.

**Slug** — The `[a-z0-9-]` name (max 64 chars) representing a conversation
in a list, derived from its first substantive user prompt by the
conversation's own harness. _Avoid_: title, summary — the future longer
form is a summary, not a slug.

**Bus** — The message-bus integration: `message` sends text from one agent
to another, and herdr delivers it as typed input (`agent prompt` — paste,
then Enter) behind a prefix naming the sender. _Avoid_: chat, IPC,
steering — herdr's word for the capability, not this integration's name.

**Name** — An agent's addressable identity on the bus: the label of the
tab hosting its pane, as the tab namer or a hand rename set it. Mutable
and collidable — the session id is the stable address — and distinct from
herdr's opaque launch alias. _Avoid_: alias, handle.

**Message** — The text one agent sends another over the bus; it lands
exactly like an operator's typed message, so a working harness queues it
behind the running turn. Delivery is not receipt. Distinct from the
intent, which rides a launch. _Avoid_: prompt.

**Metadata level** — The catalog's designated cheap `model:effort` pair for
metadata completions (slugs, and later summaries): declared per harness in
agentlaunch's catalog, read from `x-catalog` as one `metadata_level` value,
passed back as one `--x-level`. Distinct from agentlaunch's "utility
invocation", where model and effort never apply. _Avoid_: utility level.
