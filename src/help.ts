export const VERSION = "agentsurface 0.1.0";

export const TOP_HELP = `agentsurface — fleet integrations over the herdr surface

Usage:
  agentsurface launch
  agentsurface conversation slug <harness> <session-id-or-path>
  agentsurface --help | --version

Commands:
  launch    One-screen launcher. Type the intent first, then confirm project,
            worktree, and the harness/model/effort cascade from agentlaunch's
            catalog; agentsurface creates a herdr workspace (or worktree),
            starts the balanced agent there, and submits the intent.
  conversation slug
            Print a short list-ready slug for a conversation, derived from
            its first user prompt by the conversation's own harness (claude,
            codex, or pi) at the catalog's metadata level. Exit 3: no such
            transcript; exit 4: transcript holds no user prompt yet.

Keys in the launcher:
  ctrl+k opens the command palette; every action lives there.

Files:
  ~/.config/agentsurface/config.json        project roots (default ~/code, ~/src)
  ~/.local/state/agentsurface/launches.jsonl  launch log; orders projects by use

Requires a running herdr session and agentlaunch on PATH.
`;
