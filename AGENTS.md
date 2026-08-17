# AgentSurface

AgentSurface is the fleet's integration point with herdr, the launch surface:
each subcommand ties `~/code/agent*` tools to the running herdr session. The
first integration is `launch` — a one-screen, prompt-first TUI that creates a
herdr workspace (or worktree), starts a balanced agent there through the
fleet's launch policy, and submits the typed intent. The second is
`conversation slug` — a short list-ready name for any conversation, derived
from its first user prompt by the conversation's own harness at the
catalog's metadata level.

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
  hold. Routes are `launch`, `conversation slug`, the internal
  `execute-launch`, `--help`, `--version`. The conversation route holds
  nothing on screen and exits 3 (no such transcript) or 4 (no user prompt
  yet) so machine callers can poll.
- `launch/model.ts` is the pure form: fields, focus, the harness → model →
  effort cascade, validation, and line building. Everything decidable
  without a terminal is decided here, where tests reach it. Defaults come
  from the world: the project from the focused pane's cwd, the cascade from
  the last launch where the catalog still allows it.
- `launch/app.ts` is the thin OpenTUI shell over the model. The intent
  field is OpenTUI's Textarea, driven by ONE manual dispatch — never
  `focus()` it, or the renderer adds its own routing and every key lands
  twice; `showCursor` alone carries the focus visual. `launch/theme.ts`
  holds the Signal Room tokens; `launch/overlay.ts` is the palette
  anatomy, generalized one notch into the four choosers.
- `launch/executor.ts` is the detached half: submitting must close the
  popup at once, and a popup closes only with its process — so the TUI
  spawns `agentsurface execute-launch <plan-json>` detached and exits (or,
  submitted unfocused with `a`, resets for another intent). The executor
  reuses a workspace already hosting the project (a tab), creates one
  otherwise, starts the agent, retries a raced `agent_name_taken`, appends
  the record, and reports failure through a herdr notification.
- `herdr.ts` speaks the herdr CLI's socket API: workspace/worktree/tab
  create, the surface listings, and agent start (with the pane-busy ready
  retry). The intent travels as a native token on the launch itself, so a
  startup dialog cannot drop it. JSON answers only; success on stdout,
  errors on stderr.
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
