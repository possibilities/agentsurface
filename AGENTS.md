# AgentSurface

AgentSurface is the fleet's integration point with herdr, the launch surface:
each subcommand ties `~/code/agent*` tools to the running herdr session. The
first integration is `launch` — a one-screen, prompt-first TUI that creates a
herdr workspace (or worktree), starts a balanced agent there through the
fleet's launch policy, and submits the typed intent. The second is
`conversation slug` — a short list-ready name for any conversation, derived
from its first user prompt by the conversation's own harness at the
catalog's metadata level. The third is the message bus — `agents` and
`message` — agents on the surface listing and messaging each other, with
herdr delivering each message as typed input.

The boundary is strict in both directions. Herdr owns every topology
semantic: where worktrees go, what a workspace is, when a pane is an
available shell. AgentLaunch owns the catalog, balancing, yolo, and native
argv composition. AgentSurface composes the two over their public commands
and re-implements neither.

## Commands

- `bun run check` — lint, typecheck, and tests.
- `bun run generate:schemas` — regenerate the checked-in JSON Schema.
- `bash scripts/install.sh --install` — hardened rerunnable source-link install.
- `bash scripts/install.sh --uninstall` — remove only a verified managed install.

## Architecture

- `main.ts` owns routing, exit semantics, and the popup-friendly failure
  hold. Routes are `launch`, `conversation slug`, `agents`, `message`, the internal
  `execute-launch` and `name-tab`, `--help`, `--version`. The conversation
  route holds nothing on screen and exits 3 (no such transcript) or 4 (no
  user prompt yet) so machine callers can poll.
- `launch/model.ts` is the pure form: fields, focus, the harness → model →
  effort cascade, validation, and line building. Everything decidable
  without a terminal is decided here, where tests reach it. Defaults come
  from the world: the project from the focused pane's cwd, the cascade from
  the last launch where the catalog still allows it.
- `launch/app.ts` is the thin OpenTUI shell over the model. The intent
  field is OpenTUI's Textarea; `syncIntent` is the ONE place that ever
  calls `focus()`/`blur()` on it, strictly following `state.focus` — a
  second focus path means the renderer routes every key twice. The body
  is one renderable per form row so rows are pointer targets: a press
  runs the row's primary action (chooser, toggle, intent focus), the
  wheel steps the value, and a press outside an open overlay dismisses
  it. `launch/theme.ts` holds the Signal Room tokens;
  `launch/overlay.ts` is the palette anatomy, generalized one notch into
  the five choosers.
- `launch/executor.ts` is the detached half: submitting must close the
  popup at once, and a popup closes only with its process — so the TUI
  spawns `agentsurface execute-launch <plan-json>` detached and exits (or,
  submitted unfocused with `a`, resets for another intent). The executor
  reuses a workspace already hosting the project (a tab), creates one
  otherwise, starts the agent, retries a raced `agent_name_taken`, appends
  the record, and reports failure through a herdr notification.
- `herdr.ts` speaks the herdr CLI's socket API: workspace/worktree/tab
  create, the surface listings, and agent start (with the pane-busy ready
  retry). The intent rides the launch as an `--x-prompt-file` spool
  reference — herdr types the command into the pane's shell and refuses
  control characters, so the text itself cannot travel as an argument;
  agentlaunch appends the file's text as the final native token, which is
  why a startup dialog still cannot drop it. The executor prunes the spool
  by age. JSON answers only; success on stdout, errors on stderr.
- `bus.ts` is the message bus. An agent's name on the bus is the label of
  the tab hosting its pane — the tab namer's slug, or a hand rename —
  mutable and collidable, so the session id is the stable address.
  `agents` joins herdr's `agent list` to `tab list` (the caller's
  workspace by default, `--all` for the session); `message` resolves a
  name (sender's workspace first, then the session) or a session id to
  exactly one agent — a collision errors with candidates, never guesses —
  and delivers through `herdr agent prompt`, behind a prefix naming the
  sender (identity from the pane env herdr exports). The prompt response's
  fresh status becomes the confirmation's delivery note: a working target
  queued the message behind its turn; a blocked one rejected it — the
  caller decides whether to linger (`--wait-unblocked`, the delivery
  attempt as the probe, retried until `--timeout`). There is deliberately
  no deliver-later queue. `skills/bus/SKILL.md` is the runbook agents
  load; agentstart's skills scan installs it.
- `catalog.ts` consumes `agentlaunch x-catalog --x-json` — the resolved,
  validated pair space, plus each harness's designated metadata level. The
  TUI can never offer an invalid model:effort.
- `conversation/` is the slug pipeline: `resolve.ts` finds the transcript
  by id-in-filename glob over the harness's native store (no index in
  between, so nothing can be stale); `extract.ts` reads the first
  substantive user prompt per store grammar (meta lines, sidechains,
  local-command output, and codex's injected instruction items are not
  prompts; housekeeping commands stand only when nothing else follows);
  `prompt.ts` holds the pure transforms — slash-command stripping,
  @-mention expansion against the transcript's cwd, center truncation, and
  keeper's slug normalization with its unsafe-text strip; `infer.ts`
  composes the non-interactive completion and runs it in the fixed
  `/tmp/agentsurface/inference` cwd so recorded sessions collect in one
  quarantined workspace. Inference names `agentlaunch` directly — the bare
  shims would exec the native binary under a session's AGENTLAUNCH_LAUNCH
  sentinel and drop the level.
- `projects.ts` + `state.ts`: roots scanned one level deep, ordered by the
  launch log's frequency counts; the log is bookkeeping, never authority.
- `config*.ts` strictly load `~/.config/agentsurface/config.json`; absence
  means the default roots (`~/code`, `~/src`).
- `plugin/` is the herdr plugin (id `agentsurface`), linked by agentstart's
  installer and the shared home for popup-bound fleet TUIs. Its `launch` pane
  entrypoint runs `agentsurface launch` in a titled session-modal popup;
  AgentStart's keybinding passes the active pane's cwd when it opens the
  entrypoint. Its `usage` pane entrypoint runs `agentusage` through the
  escape-to-close wrapper in a popup titled `Subscription usage`. Its
  `pane.agent_detected` hook runs `agentsurface name-tab`; `tab-namer.ts`
  first publishes the `$project`
  sidebar token (the current workspace label, or the root repository name plus
  its worktree branch), then polls the pane for its agent session, claims the tab
  in the plugin's state directory (a `pending <pid>` state
  file, rewritten to `named` after the rename; a dead claimant's pending
  claim is taken over), and polls `conversation slug` while the transcript
  has no prompt — re-reading the pane's live session each round, so a
  crashed agent's replacement becomes the name source — then renames the
  tab. Failures release only a claim the namer still owns and reach only
  herdr's plugin log.

## Invariants

- The TUI is chromeless Signal Room: no header, footer, identity row, or
  help line; status lives in-body; every action is in the ctrl+k palette;
  ctrl+c is never consumed. The `fleet-tui-design` wiki page is the contract.
- Model and effort travel as one `--x-level <model>:<effort>` value. The
  pair is validated by agentlaunch's catalog, never split or re-validated
  here.
- The launched process is herdr's, started by `herdr agent start` running
  the bare harness command — which is the fleet shim into agentlaunch. No
  harness binary is ever resolved or spawned by this repository; slug
  inference spawns `agentlaunch`, which owns that resolution.
- A bus message reaches its target only through `herdr agent prompt` —
  herdr's own typed-input path; this repository never writes to a pane.
  Delivery is not receipt: the confirmation carries the target's status so
  the sender knows a working harness queued the message.
- A launch fails only when no harness ran. `herdr agent start` spawns and
  then waits to confirm the launch alias; every outcome of that wait —
  `agent_not_ready`, `timeout`, `agent_name_not_found` — is an unnamed but
  started launch, recorded with `named: false` and reported to nobody. The
  intent rides the argv, so the harness submits it on its own schedule. A
  genuine failure's notification names the spool file holding the prompt.
- A project already on the surface gets a tab in its workspace; a
  workspace is created only when none hosts the project (a pane working
  inside it, else its name as the label).
- Launch records append to the state log; losing or garbling it only
  flattens the project ordering.

## Validation

Before landing a change:

```sh
bun install --frozen-lockfile
bun run generate:schemas
bun run check
bash -n scripts/install.sh
```

## The fleet

This checkout is one of the agent* fleet under `~/code`. Adding or removing
a call to another fleet tool changes the fleet map: update
`~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet` skill, every
edge with evidence) in the same change. The popup keybinding that opens the
launcher lives in `~/code/funk` (herdr's config owner), not here.
