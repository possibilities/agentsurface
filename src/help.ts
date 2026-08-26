export const VERSION = "agentsurface 0.1.0";

export const TOP_HELP = `agentsurface — fleet integrations over the herdr surface

Usage:
  agentsurface host [--] <command> [args…]
  agentsurface confirm --title <text> -- <command> [args…]
  agentsurface conversation slug <harness> <session-id-or-path>
  agentsurface conversation describe < requests.jsonl
  agentsurface session dump [directory] [--session <name>]…
  agentsurface session resume <name-or-path> [--session <name>]
  agentsurface agents [--all]
  agentsurface message <target> "<text>" [--wait-unblocked] [--timeout <ms>]
  agentsurface browser
  agentsurface --help | --version

Commands:
  host      Run a fleet TUI on this terminal and realize every session
            directive it emits. The host holds the tool's stdout as a pipe
            (the tool renders on stderr, still the popup's tty); each JSON
            line read becomes a herdr workspace (or worktree) with an agent
            started in it, at once and detached — the launch form is
            \`agentsurface host -- agentlaunch --x-surface\`. Directive
            failures reach the operator as herdr notifications.
  confirm   Show a fail-closed terminal confirmation and run the exact command
            argv only when approved. Yes is selected by default; Enter or y
            confirms, and n/Esc/q cancels. A missing
            interactive terminal refuses the command.
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
  session dump
            Save one strict, versioned JSON backup per selected Herdr session.
            The directory defaults to ~/.local/state/agentsurface/session-backups
            (or XDG_STATE_HOME). Repeat --session to select one or more running
            sessions; with no selection, back up default. Each file includes
            topology, cwd, git/worktree state, and native session references.
  session resume
            Resume one backup by session name from the default backup directory,
            or by explicit path, into its saved session name by default or the
            --session override. A running target is a no-op; a stopped existing
            target is only started; only a wholly missing target is
            reconstructed. Missing dirty worktrees are refused because metadata
            cannot contain uncommitted changes.
  agents    List the surface's live agents — name (the tab's label), session
            id, harness, status, cwd. Agents in the caller's workspace by
            default; --all lists the whole session and adds each agent's
            place — its worktree name, or its workspace label.
  message   Send text to another agent over the message bus. The target is a
            name, a session id, or a place holding exactly one agent (a
            worktree name, with or without herdr's worktree- prefix); herdr
            types the message into the target's harness like an operator
            message, behind a prefix naming the sender by every address it
            answers to. A working target queues it; a blocked target rejects
            it (--wait-unblocked lingers and retries until --timeout, 120s
            default, then reports the message undelivered).
  browser   The browser pane: agentweb's headed browsers, watched and handed
            over from inside herdr. Lists the daemon's browsers and open
            attention items; Enter docks the selected browser's real Chrome
            window over this pane to watch it (clicks reach the site), and a
            queued attention item is attended automatically — the window is
            docked with focus, you solve the wall in it, r releases it back to
            the agent, p parks it out of sight. Runs inside a herdr pane
            (the plugin's split entrypoint) against the agentweb daemon;
            AGENTSURFACE_AGENTWEB overrides the agentweb command under test.

Files:
  directive.schema.json (checked in)            the session directive format
  ~/.local/state/agentsurface/launches.jsonl    launch log of realized directives
  ~/.local/state/agentsurface/directives/       per-run directive evidence logs
  ~/.local/state/agentsurface/session-backups/  default session backup directory

Requires a running herdr session. The surface-handoff-protocol wiki page is
the directive contract.
`;
