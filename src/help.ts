export const VERSION = "agentsurface 0.1.0";

export const TOP_HELP = `agentsurface — fleet integrations over the herdr surface

Usage:
  agentsurface host [--] <command> [args…]
  agentsurface conversation slug <harness> <session-id-or-path>
  agentsurface conversation describe < requests.jsonl
  agentsurface agents [--all]
  agentsurface message <target> "<text>" [--wait-unblocked] [--timeout <ms>]
  agentsurface --help | --version

Commands:
  host      Run a fleet TUI on this terminal and realize every session
            directive it emits. The host holds the tool's stdout as a pipe
            (the tool renders on stderr, still the popup's tty); each JSON
            line read becomes a herdr workspace (or worktree) with an agent
            started in it, at once and detached — the launch form is
            \`agentsurface host -- agentlaunch --x-surface\`. Directive
            failures reach the operator as herdr notifications.
  conversation slug
            Print a short list-ready slug for a conversation, derived from
            its first user prompt by the conversation's own harness (claude,
            codex, or pi) at the catalog's metadata level. Exit 3: no such
            transcript; exit 4: transcript holds no user prompt yet. Every
            computed slug is persisted to the slug store, so read-only
            surfaces never pay for inference.
  conversation describe
            The bulk, read-only half: JSON lines on stdin — {"harness",
            "path"} per transcript — answer as {"path", "slug", "excerpt"}
            lines: the stored slug when naming ever computed one (never
            computed here), and the first-prompt excerpt read from the
            transcript head. Built for the resume picker's listing.
  agents    List the surface's live agents — name (the tab's label), session
            id, harness, status, cwd. Agents in the caller's workspace by
            default; --all lists the whole session.
  message   Send text to another agent over the message bus. The target is a
            name or a session id; herdr types the message into the target's
            harness like an operator message, behind a prefix naming the
            sender. A working target queues it; a blocked target rejects it
            (--wait-unblocked lingers and retries until --timeout, 120s
            default, then reports the message undelivered).

Files:
  directive.schema.json (checked in)            the session directive format
  ~/.local/state/agentsurface/launches.jsonl    launch log of realized directives
  ~/.local/state/agentsurface/directives/       per-run directive evidence logs

Requires a running herdr session. The surface-handoff-protocol wiki page is
the directive contract.
`;
