# 0001: Herdr owns topology and tools own directives

Status: retrospective, recorded 2026-09-08 from the current integration contract.

Herdr owns workspace, pane, worktree and available-shell semantics. A hosted
tool owns its choice UI and the intent expressed by a session directive.
AgentSurface validates and realizes that directive through Herdr's public
commands without reconstructing either owner's policy.

The hosted tool renders its TUI on stderr and emits only strict versioned
directives on stdout. That separation lets a host consume deliberate outcomes
without scraping presentation or interpreting the reason behind a choice.
The cost is an explicit protocol and hard refusal of incompatible directives,
rather than permissive guesses that could launch work in the wrong place.

Evidence: [repository boundaries](../../AGENTS.md),
[directive schema](../../directive.schema.json), [host](../../src/host.ts),
and [directive realization](../../src/directive.ts). The authored cross-tool
contract is the `surface-handoff-protocol` wiki decision.
