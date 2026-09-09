# AgentSurface

Read [CONTEXT.md](CONTEXT.md) for the domain terms,
[architecture](docs/architecture.md) for subsystem ownership, and the
[decision log](docs/adr/README.md) before changing directives, messaging or recovery.

AgentSurface is the fleet's integration point with herdr, the launch surface:
each subcommand ties `~/code/agent*` tools to the running herdr session. The
first integration is `host` — run a fleet TUI on the popup's terminal and
realize every session directive it emits as a herdr workspace (or worktree)
with an agent started in it. The TUIs themselves live with the tools they
front (agentlaunch's `--x-surface` launch form is the first); the
`surface-handoff-protocol` wiki page is the directive contract, and
`directive.schema.json` its published format. The second is
`conversation slug` — a short list-ready name for any conversation, derived
from its first user prompt by the conversation's own harness at the
catalog's metadata level. The third is the message bus — `agents` and
`message` — agents on the surface listing and messaging each other, with
herdr delivering each message as typed input. `confirm` is the terminal
safety boundary for keybindings that must require an explicit decision before
running their command.

The boundary is strict in every direction. Herdr owns every topology
semantic: where worktrees go, what a workspace is, when a pane is an
available shell. The hosted tool owns its whole choice UX and everything in
its directives; AgentSurface never inspects why a directive says what it
says. AgentSurface realizes directives over herdr's public commands and
re-implements neither side.

## Commands

- `bun run check` — lint, typecheck, and tests.
- `bun run generate:schemas` — regenerate the checked-in JSON Schema.
- `bash scripts/install.sh --install` — hardened rerunnable source-link install.
- `bash scripts/install.sh --uninstall` — remove only a verified managed install.

## Architecture

Read the [subsystem map](docs/architecture.md) before editing routing, hosting,
messaging, conversation inference, session recovery or the Herdr plugin.

## Invariants

- A directive is executed exactly as written or refused exactly as
  received: strict parse, hard version gate, no defaults, no repair. The
  host never reorders, batches, or coalesces the stream.
- The launched process is herdr's, started by `herdr agent start` running
  the bare harness command — which is the fleet shim into agentlaunch. No
  harness binary is ever resolved or spawned by this repository; slug
  inference spawns `agentlaunch`, which owns that resolution.
- A bus message reaches its target only through `herdr agent prompt` —
  herdr's own typed-input path; this repository never writes to a pane.
  Delivery is not receipt: the confirmation carries the target's status so
  the sender knows a working harness queued the message.
- A hosted tool is a black box with a terminal: the host lends it the tty
  on stdin/stderr, the cwd, and the stdout pipe, and reads nothing back
  but directives and the exit code. Feedback about a directive's fate is the operator's (herdr
  notifications), never the tool's.
- A launch fails only when no harness ran. `herdr agent start` spawns and
  then waits to confirm the launch alias; every outcome of that wait —
  `agent_not_ready`, `timeout`, `agent_name_not_found` — is an unnamed but
  started launch, recorded with `named: false` and reported to nobody. The
  intent rides the argv, so the harness submits it on its own schedule. A
  genuine failure's notification names the spool file holding the prompt.
- A project already on the surface gets a tab in its workspace; a
  workspace is created only when none hosts the project. The project's
  basename must match the workspace label; a transient pane foreground cwd
  never gives an unrelated workspace ownership. Stable pane cwd only
  disambiguates duplicate labels.
- Launch records append to the state log; losing or garbling it only
  flattens the project ordering.
- Session resume never replaces a target session name Herdr already knows.
  The target defaults to the name stored in the one-session backup and may be
  overridden. Targets with running agents are no-ops; agent-free existing
  targets resume saved agents only after each agent-bearing pane matches the
  snapshot, recreating agent-bearing workspaces that are wholly absent;
  unrelated live topology is preserved.

## Validation

Before landing a change:

```sh
bun install --frozen-lockfile
bun run generate:schemas
bun run check
bash -n scripts/install.sh
```

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, and Codex uses
  `$agent:<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script.
  Skill names and descriptions provide capability discovery; do not add a
  second tool catalog to prompts. See `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
