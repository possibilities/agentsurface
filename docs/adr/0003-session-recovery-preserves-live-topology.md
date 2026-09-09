# 0003: Session recovery preserves live topology

Status: retrospective, recorded 2026-09-08 from the existing snapshot/resume contract.

A session snapshot records selected Herdr topology and Git metadata; it does
not capture uncommitted file contents. Resume never replaces a target that has
running agents. An agent-free existing target retains its topology and resumes
saved agents only into matching panes, recreating wholly absent agent-bearing
workspaces beside it. A missing target can be rebuilt from the snapshot.

The snapshot is evidence for recovery, not authority to overwrite newer work.
A missing dirty worktree is refused because branch and HEAD metadata cannot
reconstruct its working changes. This deliberately gives up blind exact-image
restoration in favor of preserving live state and reporting mismatches.

The read-only dump fallback for an older Herdr protocol does not grant resume
an alternative mutation transport. Recovery still uses the supported owner.

Evidence: [session snapshot/resume implementation](../../src/session-snapshot.ts)
and [repository recovery invariants](../../AGENTS.md).
