# AgentSurface

AgentSurface ties the `~/code/agent*` fleet to [herdr](https://github.com/wilkystyle/herdr),
the terminal workspace manager fleet agents run inside. Each subcommand is
one integration; the first is `launch`, the second `conversation slug`.

## Launch

```sh
agentsurface launch
```

One screen, prompt-first: type what you want done (or don't — the intent is
optional), then confirm the rest.

- **Intent** — the prompt at the top; it rides the launch as the agent's
  first prompt. The field is a real line editor (OpenTUI's textarea):
  readline motions and kills (ctrl+a/e/b/f, alt+b/f, ctrl+w/u, alt+d, and
  ctrl+k kill-to-line-end while focused) feeding a real kill ring —
  consecutive kills merge, ctrl+y yanks, alt+y cycles the ring —
  selection, native undo/redo (ctrl+- or ctrl+_ or ctrl+/ undo, ctrl+.
  redo), and paste all behave; a restored draft opens with the cursor at
  the end;
  shift+enter or ctrl+j insert a newline; ctrl+g opens the intent in
  `$EDITOR` (`$VISUAL` first) the way the harnesses do. Enter moves on to
  the configuration rows; the ctrl+k command palette answers from every
  other row. Escape always keeps your work: the whole form persists on
  every keystroke and an interrupted launcher reopens exactly where it
  stopped, while a submitted one starts fresh.
- **Project** — the configured roots themselves plus the directories one
  level under them, ordered by
  how often you have launched into them (alphabetical until then), and
  preselected from the pane the launcher opened over. Space or `p` opens the
  filterable picker.
- **Worktree** — off by default; `w` toggles. On, herdr creates a new git
  worktree for the project (branch name suggested from the intent, editable)
  and opens it as its own workspace.
- **Priming** — an optional skill prefixed onto the intent, chosen from the
  config's `priming` list (`i` or space opens the picker; "none" is the
  first picker option, while the first configured skill is the default).
  An interrupted form restores its selection. Priming travels in each
  harness's own spelling: `/collab …` for claude and pi, `$collab …` for
  codex — the prefix alone when the intent is empty.
- **Harness → model → effort** — the cascade from agentlaunch's catalog,
  fetched at runtime via `agentlaunch x-catalog`; only validated
  combinations are offered, e.g. `claude → fable → xhigh`. Each row is a
  filterable picker too (`h`, `m`, `e`, or space on the row), and the form
  defaults to the previous launch's choices where the catalog still allows
  them.

Enter submits and the popup closes at once; the launch continues detached.
A project already on the surface gets a new tab in its workspace — a
workspace is created only when none exists — the agent starts in the fresh
pane (`herdr agent start` runs the bare harness command, the fleet shim
into agentlaunch, so balancing, yolo policy, and model injection all
apply), the intent submits, and the launch is recorded. You land on it as
it appears; a background failure arrives as a herdr notification.

`a` submits without taking focus and clears the form for the next intent —
fire several launches from one popup. Every action lives in the ctrl+k
command palette. Esc quits without launching; ctrl+c is always the
terminal interrupt.

The launcher is made to live on a herdr popup keybinding:

```toml
[[keys.command]]
key = "prefix+l"
type = "popup"
command = "agentsurface launch"
description = "launch an agent"
width = "80%"
height = "80%"
```

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

The repository also ships a herdr plugin (`plugin/`, linked by agentstart's
installer) that puts the slug to work: when herdr detects an agent in a
pane, the pane's tab is renamed after the agent's conversation — once per
tab, quietly skipping anything that never produces a prompt.

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

## Configuration

`~/.config/agentsurface/config.json`, optional and strictly validated
([schema](config.schema.json)):

```json
{
  "roots": ["~/code", "~/src"],
  "priming": ["collab", "build", "orchestrate"]
}
```

Without the file, those two roots are the default. The launch log at
`~/.local/state/agentsurface/launches.jsonl` records each launch and feeds
the frequency ordering; deleting it only flattens the order.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

MIT licensed.
