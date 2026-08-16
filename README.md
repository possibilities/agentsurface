# AgentSurface

AgentSurface ties the `~/code/agent*` fleet to [herdr](https://github.com/wilkystyle/herdr),
the terminal workspace manager fleet agents run inside. Each subcommand is
one integration; the first is `launch`.

## Launch

```sh
agentsurface launch
```

One screen, prompt-first: type what you want done, then confirm the rest.

- **Intent** — the multiline prompt at the top; it becomes the agent's first
  prompt. Enter moves on to the configuration rows.
- **Project** — directories one level under the configured roots, ordered by
  how often you have launched into them (alphabetical until then). Space or
  `p` opens the filterable picker.
- **Worktree** — off by default. On, herdr creates a new git worktree for
  the project (branch name suggested from the intent, editable) and opens it
  as its own workspace.
- **Harness → model → effort** — the cascade from agentlaunch's catalog,
  fetched at runtime via `agentlaunch x-catalog`; only validated
  combinations are offered, e.g. `claude → fable → xhigh`.

Enter on any configuration row launches: agentsurface creates the herdr
workspace (or worktree) focused, starts the agent in its root pane —
`herdr agent start` runs the bare harness command, which is the fleet shim
into agentlaunch, so balancing, yolo policy, and model injection all apply —
submits the intent, records the launch, and exits. Closing the popup lands
you in the new workspace.

Every action lives in the ctrl+k command palette. Esc quits without
launching; ctrl+c is always the terminal interrupt.

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

## Install

Requirements: Bun 1.3.14+, a running herdr session, agentlaunch on PATH
(with the fleet's bare-harness shims for balanced launches).

```sh
git clone https://github.com/possibilities/agentsurface.git ~/code/agentsurface
~/code/agentsurface/scripts/install.sh --install
```

The hardened, rerunnable installer links `~/.local/bin/agentsurface` to the
checkout and writes a deployment receipt under
`~/.local/state/agentsurface/`. It accepts `--uninstall` and refuses foreign
or unsafe paths instead of replacing them.

## Configuration

`~/.config/agentsurface/config.json`, optional and strictly validated
([schema](config.schema.json)):

```json
{
  "roots": ["~/code", "~/src"]
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
