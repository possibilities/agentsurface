# AgentSurface

AgentSurface ties the `~/code/agent*` fleet to [herdr](https://github.com/wilkystyle/herdr),
the terminal workspace manager fleet agents run inside. Its integrations host
fleet TUIs, name conversations, connect agents, and guard terminal commands.

## Confirmation

```sh
agentsurface confirm --title "Close pane?" -- command arg
```

`confirm` is the reusable safety boundary for terminal keybindings that would
otherwise act immediately. It reduces the decision to `<question> [Yes] No`,
with Yes selected, executes the exact argv after `--` only after interactive
confirmation, and refuses to run without a terminal. Enter or `y` confirms;
`n`, `Esc`, and `q` cancel; arrows, Tab, and `h`/`l` move between the choices.
Cancellation is a successful no-op, so dismissing a Herdr popup does not report
a command failure.

The bundled plugin exposes three compact `Confirm` entrypoints for closing a
pane, tab, or workspace. AgentStart binds Herdr's normal close keys to those
plugin panes; Herdr captures the active topology in the popup context, so that
captured target is the thing approved even if another client changes focus.

## Host

```sh
agentsurface host -- agentlaunch --x-surface
```

`host` runs one fleet TUI on the current terminal (usually a herdr popup)
and realizes every **session directive** it emits. The host resolves the
focused pane's cwd and runs the tool there with stdout held as a pipe —
the tool renders on stderr, which stays the popup's tty; each JSON line
the tool writes to stdout becomes — at once, detached from the tool — a herdr
workspace (or worktree, or a tab in the workspace already hosting the
project) with an agent started in its root pane and the directive's intent
delivered as the first prompt (`herdr agent start` runs the bare harness
command, the fleet shim into agentlaunch, so balancing, yolo policy, and
model injection all apply).

A directive says everything the surface needs: cwd, worktree, focus, the
agent kind with its launch arguments, the composed intent, and opaque
record extras for the launch log. The format is
[directive.schema.json](directive.schema.json), strictly validated with a
hard `schema_version` gate; the `surface-handoff-protocol` wiki page is the
contract. The tool never calls herdr or agentsurface and never learns a
directive's fate — execution failures reach the operator as herdr
notifications, and a refused directive is reported without stopping the
stream.

The first hosted tool is agentlaunch's `--x-surface` launch form — the
one-screen, prompt-first launcher that used to live in this repository.
Its intent editor, project/harness/model/effort choosers, worktree toggle,
priming, drafts, and project-frequency ordering are all agentlaunch's now;
see agentlaunch's README.

The bundled herdr plugin declares the launcher as a popup pane titled
`Agent Launch` — popup titles are by convention the title-cased name of the
CLI the TUI fronts. AgentStart links the plugin and opens that entrypoint
from the keybinding:

```toml
[[keys.command]]
key = "prefix+l"
type = "shell"
command = '"$HERDR_BIN_PATH" plugin pane open --plugin agentsurface --entrypoint launch --cwd "${HERDR_ACTIVE_PANE_CWD:-$PWD}"'
description = "launch an agent"
```

The plugin is also the shared home for fleet TUIs bound to popups. Its `usage`
entrypoint runs `agentusage` through the escape-to-close wrapper in an 80%
popup titled `Agent Usage`; AgentStart binds `prefix+u` to that
entrypoint instead of duplicating the title and geometry in the keybinding.

Its `voice` entrypoint runs `agentvoice remote` in an 80% popup titled `Agent
Voice`, bound the same way to `prefix+t` — `t` for talk, because `prefix+v` is
Herdr's own vertical split. It is the remote control for the voice console
already running on this machine, so mute, redial, and Fresh are a chord away
without leaving the surface, and it runs unwrapped: that TUI spends esc on its
own ctrl+k palette and quits on `q`.

## Conversation slug

```sh
agentsurface conversation slug <harness> <session-id-or-path>
```

Prints a short list-ready slug for any claude, codex, or pi conversation —
`build-agentsurface-launch-tui` — derived from its first substantive user
prompt: housekeeping commands are skipped, a leading slash command and its
`--flags` are stripped, valid `@path` mentions are replaced by the files
they name (resolved against the conversation's own working directory), and
the middle of a long prompt is cut before the conversation's own harness
condenses it at the catalog's designated cheap metadata level. Exit `3`
means no such transcript, `4` a transcript with no user prompt yet, so
callers can poll a conversation that has not started.

The repository ships that launcher entrypoint and the tab-naming hook in one
herdr plugin (`plugin/`, linked by agentstart's installer). When herdr detects
an agent in a pane, the hook renames its tab after the agent's conversation —
once per tab, quietly skipping anything that never produces a prompt.

## Message bus

Agents on the surface can message each other:

```sh
agentsurface agents            # live agents in your workspace
agentsurface agents --all      # the whole session, with workspaces
agentsurface message fix-the-tests "how far along is the migration?"
```

An agent's name on the bus is its tab's label — the slug the tab namer set.
`message` takes a name or a session id; a name is resolved in the sender's
workspace first, then across the session, and a collision is reported with
the candidates' session ids instead of guessed at. Herdr delivers the text
as typed input (paste, then Enter) behind a prefix naming the sender, so
the receiving harness treats it exactly like an operator message.

Delivery is not receipt: the confirmation reports the target's status — a
`working` agent queued the message behind its current turn; a `blocked`
agent (stuck on an interactive dialog) rejects it, and the CLI says the
message was not delivered. `--wait-unblocked` lingers and retries a
blocked target until `--timeout` (default 120s) instead; there is
deliberately no deliver-later queue. Both commands need to run from
inside a herdr pane, where herdr's exported `HERDR_PANE_ID` identifies
the sender.

## Install

Requirements: Bun 1.3.14+, a running herdr session, agentlaunch on PATH
(with the fleet's bare-harness shims for balanced launches).

```sh
git clone https://github.com/possibilities/agentsurface.git ~/code/agentsurface
~/code/agentsurface/scripts/install.sh --install
```

The hardened, rerunnable installer links `~/.local/bin/agentsurface`
straight to the checkout's `src/main.ts` — an editable install that runs
the live working tree, like the rest of the fleet's tools. It accepts
`--uninstall` and refuses foreign or unsafe paths instead of replacing
them.

## State

AgentSurface has no config file — project roots and priming moved to
agentlaunch's config with the launch form. The launch log at
`~/.local/state/agentsurface/launches.jsonl` records each realized
directive (with the emitting tool's record extras riding along), and
`~/.local/state/agentsurface/directives/` keeps each host run's directive
stream as an evidence log, pruned by age. Both are bookkeeping; deleting them loses only
history.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

MIT licensed.
