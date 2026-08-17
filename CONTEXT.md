# Glossary

**Integration** — One AgentSurface subcommand tying fleet tools to the herdr
session. `launch` is the first. _Avoid_: feature, mode.

**Launch** — The whole flow one `launch` commit performs: create the herdr
workspace or worktree, start the balanced agent in its root pane, submit the
intent. _Avoid_: run, spawn.

**Intent** — The prompt the operator types first; it rides the launch as a
native positional token, so the harness queues it behind any startup dialog
(folder trust) and submits it once the dialog clears. _Avoid_: task, message.

**Project** — A directory one level under a configured root. Not necessarily
a git repository; only the worktree option needs one. _Avoid_: repo.

**Root** — A configured parent directory scanned one level deep for
projects. Default `~/code` and `~/src`.

**Frequency** — How often a project was launched, counted from AgentSurface's
own launch log; orders the project list, most-used first. The log is
bookkeeping, never authority.

**Level** — AgentLaunch's `<model>:<effort>` pair, passed through as the one
`--x-level` value. The catalog validates the pair; AgentSurface only offers
combinations the catalog already allows.

**Cascade** — The harness → model → effort dependency in the form: changing
a harness snaps to its default model and effort; changing a model keeps the
effort when allowed, else snaps to the model's, else the harness's, default.

**Surface** — Herdr, the terminal workspace manager the fleet launches onto.
AgentSurface drives it only through the `herdr` CLI's socket API.

**Conversation** — One harness session's transcript in its native store,
named by harness plus session id (or a literal transcript path). _Avoid_:
chat, thread.

**Slug** — The `[a-z0-9-]` name (max 64 chars) representing a conversation
in a list, derived from its first substantive user prompt by the
conversation's own harness. _Avoid_: title, summary — the future longer
form is a summary, not a slug.

**Metadata level** — The catalog's designated cheap `model:effort` pair for
metadata completions (slugs, and later summaries): declared per harness in
agentlaunch's catalog, read from `x-catalog` as one `metadata_level` value,
passed back as one `--x-level`. Distinct from agentlaunch's "utility
invocation", where model and effort never apply. _Avoid_: utility level.
