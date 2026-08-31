/**
 * The agent contract: AgentSurface's one machine-readable self-description,
 * published as `agentsurface guide --json` and validated against the fleet
 * schema at agentstart/config/agent-contract/schema.json.
 *
 * This module is the only authorship of what this CLI is and what its
 * commands take. `--help`, `--agent-help`, and `--agent-teaser` are RENDERS
 * of it (help.ts), and every command's argv grammar is DERIVED from it
 * (`parseInvocation` below, used by main.ts, confirm.ts, close.ts, host.ts,
 * and conversation/slug.ts). A flag cannot exist in the parser and be
 * missing from `guide --json`, because there is no second place to write
 * one: the declaration below builds the parser that accepts it.
 */

import { DEFAULT_WAIT_TIMEOUT_MS } from "./bus.ts";
import { HARNESS_NAMES } from "./conversation/resolve.ts";
import { UsageError } from "./errors.ts";

export const CONTRACT_VERSION = 1;
export const ENVELOPE_SCHEMA_VERSION = 1;
export const CLI_VERSION = "0.1.0";

export type Audience = "agent" | "operator" | "internal";

export interface ContractArgument {
  readonly name: string;
  readonly type: "string" | "boolean" | "integer" | "number";
  readonly description: string;
  readonly format?: "path" | "url" | "duration" | "ref" | "json";
  readonly direction?: "in" | "out";
  readonly required?: boolean;
  readonly positional?: boolean;
  readonly repeatable?: boolean;
  readonly csv?: boolean;
  readonly choices?: readonly string[];
  readonly default?: unknown;
  readonly aliases?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  /** What kind of knob this is; a consumer building a call surface exposes
   * only `call`. Absent means `call`, which is every argument here but
   * `guide --json`. */
  readonly role?: "call" | "output-format" | "store-selection" | "meta";
  /**
   * An `x_` extension, because the contract has no vocabulary for it and
   * the parser it drives needs one: this positional is the trailing argv
   * handed to another program verbatim. `separator: "required"` means a
   * `--` must precede it (confirm, where the command is a gated payload);
   * `"optional"` means `--` is allowed but not needed (host, whose first
   * word is a tool name). Everything after it is that program's, never
   * ours, which is why the generic parser stops reading flags there.
   */
  readonly x_passthrough?: { readonly separator: "required" | "optional" };
}

export interface ContractExample {
  readonly invocation: string;
  readonly description: string;
}

export interface ContractStdin {
  readonly accepts: "text" | "json";
  readonly required?: boolean;
  readonly description: string;
}

export interface ContractConstraint {
  readonly kind: "one_of" | "at_least_one" | "conflicts" | "requires";
  readonly arguments: readonly string[];
  readonly required?: boolean;
  readonly description?: string;
}

export interface ContractCommand {
  readonly name: string;
  readonly summary: string;
  readonly audience: Audience;
  readonly mutates?: boolean;
  readonly guidance?: string;
  readonly arguments?: readonly ContractArgument[];
  readonly subcommands?: readonly ContractCommand[];
  readonly stdin?: ContractStdin;
  readonly constraints?: readonly ContractConstraint[];
  readonly examples?: readonly ContractExample[];
  /** The command waits on something outside itself and may not return
   * promptly: a caller with a request timeout needs to know before it
   * calls, not after it hangs. */
  readonly blocking?: boolean;
  readonly aliases?: readonly string[];
  readonly deprecated?: string;
}

export interface Contract {
  readonly contract_version: number;
  readonly meta: {
    readonly name: string;
    readonly version: string;
    readonly purpose: string;
    readonly audience: "agent" | "operator";
  };
  readonly guidance: string;
  readonly concepts: {
    readonly model: Record<string, string>;
    readonly output_contract: {
      readonly envelope: Record<string, string>;
      readonly exit_codes: Record<string, string>;
    };
    readonly error_codes: readonly {
      readonly code: string;
      readonly meaning: string;
      readonly recovery?: string;
    }[];
    readonly read_only_commands: readonly string[];
    readonly agent_defaults: readonly string[];
  };
  readonly commands: readonly ContractCommand[];
}

/** Routing doctrine, rendered verbatim by `--agent-help`. Its closing
 * paragraph is the operational footer — where state lives and what the CLI
 * needs to run — and `--help` prints that paragraph alone, so keep it last. */
const GUIDANCE = `AgentSurface is the fleet's integration point with herdr, the terminal surface every fleet agent runs on. Most of its verbs are surface plumbing that herdr's plugin and agentlaunch invoke; the two an agent calls for itself are \`agents\` and \`message\`, the message bus.

Start with \`agents\`. It lists the live agents in your own workspace, and \`--all\` lists the whole session and adds each agent's place. Read the status column before you send: it decides what delivery will mean.

An agent answers to three addresses, and \`message\` resolves them in that order: its name — the label of the tab hosting it, matched in your workspace first and then across the session — then its session id, then its place, the worktree or workspace it works in, which addresses it only while it is the only agent there. A name always beats a spelling that is also somebody's worktree. More than one match in the deciding tier fails the send and lists the candidates' session ids; nothing is guessed, which is why a place that addressed an agent yesterday can refuse today once a second agent joined it.

Delivery is not receipt. herdr types the message into the target's harness exactly like an operator message, behind a prefix naming every address you answer to, so the receiver can reply without any other introduction. An idle or done target reads it as its next turn; a working target queues it behind the turn it is running; a blocked target — one waiting on the operator — rejects it, and nothing was delivered. There is no inbox and no deliver-later queue: a message that cannot be typed now was not sent. \`--wait-unblocked\` lingers and retries until \`--timeout\` (120s by default) and then reports the message undelivered; reach for it when a target is merely busy, not when it is blocked on a human.

The rest of the surface is not an agent interface. \`host\` and \`confirm\` are operator verbs bound to herdr keybindings; \`session dump\` and \`session resume\` are the backup and restore pair an operator drives; \`close-active\`, \`name-tab\`, \`execute-directive\`, and the \`conversation\` pair are subprocess entrypoints that herdr's plugin, the host, and agentlaunch's pickers invoke with context an agent does not have. Calling those by hand does nothing useful, and \`conversation slug\` spends real inference on somebody else's tab name.

Every command needs a running herdr session. State lives under ~/.local/state/agentsurface (XDG_STATE_HOME honoured): \`launches.jsonl\` records realized directives, \`directives/\` holds a per-run evidence log of every line read off a hosted tool's stdout, and \`session-backups/\` is the default session dump directory. The checked-in \`directive.schema.json\` publishes the session directive format, and the surface-handoff-protocol wiki page is its contract.`;

const AGENTS_COMMAND: ContractCommand = {
  name: "agents",
  summary: "List the surface's live agents",
  audience: "agent",
  mutates: false,
  guidance:
    "Name (the tab's label), session id, harness, status, and cwd for every agent in the caller's workspace. --all lists the whole session and adds each agent's place — its worktree name, or its workspace label. The status column is the one to read before messaging: it is what delivery will mean.",
  arguments: [
    {
      name: "--all",
      type: "boolean",
      description:
        "List every agent on the surface, not just the caller's workspace, with a place column.",
    },
  ],
  examples: [
    {
      invocation: "agentsurface agents",
      description: "The live agents in the caller's own workspace.",
    },
    {
      invocation: "agentsurface agents --all",
      description: "The whole session, each agent with the place that addresses it.",
    },
  ],
};

const MESSAGE_COMMAND: ContractCommand = {
  name: "message",
  summary: "Send text to another agent over the message bus",
  audience: "agent",
  mutates: true,
  // Only with --wait-unblocked, but a caller reads `blocking` before it
  // knows which flags it will pass, and a two-minute default wait is
  // exactly the hang a request timeout needs warning about.
  blocking: true,
  guidance:
    "herdr types the text into the target's harness like an operator message, behind a prefix naming the sender by every address it answers to. A working target queues it behind its current turn; an idle or done target reads it now; a blocked target rejects it and nothing is delivered. The confirmation line carries the target's status, so read it rather than assuming the message landed.",
  arguments: [
    {
      name: "target",
      type: "string",
      description:
        "A name, a session id, or a place holding exactly one agent — a worktree name, with or without herdr's worktree- prefix.",
      positional: true,
      required: true,
    },
    {
      name: "text",
      type: "string",
      description: "The message. One argument; quote it.",
      positional: true,
      required: true,
    },
    {
      name: "--wait-unblocked",
      type: "boolean",
      description:
        "Linger and retry while the target is blocked or not ready, instead of failing on the first rejection.",
    },
    {
      name: "--timeout",
      type: "integer",
      description:
        "How long --wait-unblocked lingers, in milliseconds, before reporting the message undelivered. Match it to your own patience: a harness that kills the tool call first leaves nothing delivered and nothing reported.",
      default: DEFAULT_WAIT_TIMEOUT_MS,
      minimum: 1,
    },
  ],
  constraints: [
    {
      kind: "requires",
      arguments: ["--timeout", "--wait-unblocked"],
      description: "A timeout only bounds the wait, so it is a usage fault without it.",
    },
  ],
  examples: [
    {
      invocation: 'agentsurface message fix-the-tests "how far along is the migration?"',
      description: "Address an agent by name — the label of the tab hosting it.",
    },
    {
      invocation:
        'agentsurface message quiet-valley-a17d "rebased onto main, pull before you push"',
      description:
        "Address it by place: a worktree name, in either spelling, while it holds exactly one agent.",
    },
    {
      invocation:
        'agentsurface message 019a3c4e-77b1-7f0a-9d2e-8f6b1c0d5e34 "answering your question: yes" --wait-unblocked --timeout 30000',
      description:
        "Reply to a session id — the address that cannot go stale — and linger up to 30s if the target is busy rather than failing on the first rejection.",
    },
  ],
};

const HOST_COMMAND: ContractCommand = {
  name: "host",
  summary: "Run a fleet TUI on this terminal and realize every session directive it emits",
  audience: "operator",
  // Operator, not agent: herdr keybindings invoke it inside a popup that
  // owns this terminal, and it runs for as long as the operator drives the
  // hosted TUI. An agent calling it has no terminal to give it.
  mutates: true,
  blocking: true,
  guidance:
    "The host holds the tool's stdout as a pipe — the tool renders on stderr, still the popup's tty — and each complete JSON line it reads becomes a herdr workspace (or worktree) with an agent started in it, at once and detached. The launch form is `agentsurface host -- agentlaunch --x-surface`. Directive failures reach the operator as herdr notifications; the tool never learns what became of one. Runs until the hosted tool exits. An operator verb, not an agent one: herdr's launch keybinding invokes it, and it owns this terminal for as long as the hosted tool draws on it.",
  arguments: [
    {
      name: "command",
      type: "string",
      description:
        "The tool to run and its arguments, after an optional -- separator. Spawned exactly as given, in the focused pane's cwd; every word after the first is the tool's, not this CLI's.",
      positional: true,
      required: true,
      repeatable: true,
      x_passthrough: { separator: "optional" },
    },
  ],
  examples: [
    {
      invocation: "agentsurface host -- agentlaunch --x-surface",
      description:
        "The launch form: agentlaunch's picker draws on this terminal and every session it submits is realized on the surface.",
    },
  ],
};

const CONFIRM_COMMAND: ContractCommand = {
  name: "confirm",
  summary: "Show a fail-closed terminal confirmation and run the command only when approved",
  audience: "operator",
  // Operator, not agent: herdr's plugin binds it to the destructive keys,
  // and its whole value is that a human answers. An agent that could pass
  // the gate has not been gated.
  mutates: true,
  blocking: true,
  guidance:
    "Yes is selected by default; Enter or y confirms, and n, Esc, or q cancels. A missing interactive terminal refuses the command rather than assuming either answer. The command argv follows -- and is spawned exactly as given. Waits for a keypress, so it returns when the operator answers and not before. An operator verb, not an agent one: herdr's plugin binds it to the destructive keys, and a gate an agent could pass on its own behalf is not a gate.",
  arguments: [
    {
      name: "--title",
      type: "string",
      description: "The question shown above the choices.",
      required: true,
    },
    {
      name: "command",
      type: "string",
      description:
        "The exact argv to run on approval, after a required -- separator. Everything after it belongs to that command.",
      positional: true,
      required: true,
      repeatable: true,
      x_passthrough: { separator: "required" },
    },
  ],
  examples: [
    {
      invocation: 'agentsurface confirm --title "Close pane?" -- agentsurface close-active pane',
      description:
        "The plugin's close entrypoints: the gate asks, and only an approved answer reaches close-active.",
    },
  ],
};

/** The pieces of herdr's captured context `close-active` can close —
 * declared here because the contract's `choices` and close.ts's own type
 * are the same fact, and this is where facts about arguments live. */
export const CLOSE_TARGETS = ["pane", "tab", "workspace"] as const;

const CLOSE_ACTIVE_COMMAND: ContractCommand = {
  name: "close-active",
  summary: "Close the herdr pane, tab, or workspace named in the plugin's captured context",
  // Internal: it reads the ids out of HERDR_PLUGIN_CONTEXT_JSON, which only
  // a herdr plugin pane entrypoint sets, so a call from anywhere else has
  // nothing to close and refuses.
  audience: "internal",
  mutates: true,
  guidance:
    "The plugin's close entrypoints pair this with `confirm`. It reads the active ids from HERDR_PLUGIN_CONTEXT_JSON, which only a herdr plugin pane entrypoint sets, and closes through herdr's public command.",
  arguments: [
    {
      name: "target",
      type: "string",
      description: "Which piece of the captured context to close.",
      positional: true,
      required: true,
      choices: CLOSE_TARGETS,
    },
  ],
};

const CONVERSATION_COMMAND: ContractCommand = {
  name: "conversation",
  summary: "Name conversations from their first user prompt",
  audience: "internal",
  subcommands: [
    {
      name: "slug",
      summary: "Print a short list-ready slug for one conversation",
      audience: "internal",
      mutates: true,
      guidance:
        "Derived from the conversation's first user prompt by its own harness at the agentlaunch catalog's metadata level, so it costs a real inference call — the tab namer's entrypoint, not a lookup. Every computed slug is persisted to the slug store, so read-only surfaces never pay again. Exit 3: no such transcript. Exit 4: the transcript holds no user prompt yet, which is what the tab-naming plugin polls on.",
      arguments: [
        {
          name: "harness",
          type: "string",
          description: "The harness whose store holds the transcript.",
          positional: true,
          required: true,
          choices: HARNESS_NAMES,
        },
        {
          name: "session-id-or-path",
          type: "string",
          description:
            "A session id from the harness's own store, or a transcript path. herdr reports either, so both are accepted.",
          positional: true,
          required: true,
        },
      ],
      examples: [
        {
          invocation: "agentsurface conversation slug claude 019a3c4e-77b1-7f0a-9d2e-8f6b1c0d5e34",
          description: "Name a claude conversation by the session id herdr reports.",
        },
        {
          invocation:
            "agentsurface conversation slug codex ~/.codex/sessions/2026/08/30/rollout-01.jsonl",
          description: "A transcript path answers as well, which is the other thing herdr reports.",
        },
      ],
    },
    {
      name: "describe",
      summary: "Answer stored slugs and first-prompt excerpts for many transcripts at once",
      audience: "internal",
      mutates: false,
      guidance:
        "The bulk, read-only half of naming: it never infers and never reads the catalog. Built for the resume picker, which lists dozens of sessions per refresh and needs one subprocess rather than one per row.",
      stdin: {
        accepts: "json",
        required: true,
        description:
          'One request per line — {"harness": "claude", "path": "…"} — answered as {"path", "slug", "excerpt"} lines: the stored slug when naming ever computed one, and the first-prompt excerpt read from the transcript head. A line that is not JSON, or that names neither, is skipped rather than refused, so one bad row cannot cost the picker its listing.',
      },
      arguments: [],
      examples: [
        {
          invocation:
            'echo \'{"harness":"claude","path":"/home/u/.claude/projects/p/019a3c4e.jsonl"}\' | agentsurface conversation describe',
          description:
            "One request in, one answer line out. The picker pipes dozens per refresh through this single process.",
        },
      ],
    },
  ],
};

const SESSION_COMMAND: ContractCommand = {
  name: "session",
  summary: "Back up and restore whole herdr sessions",
  audience: "operator",
  subcommands: [
    {
      name: "dump",
      summary: "Save one strict, versioned JSON backup per selected herdr session",
      audience: "operator",
      mutates: true,
      guidance:
        "Each file captures topology, cwd, git and worktree state, and native session references. With no --session, the default session is backed up.",
      arguments: [
        {
          name: "directory",
          type: "string",
          description:
            "Where the backups are written. Defaults to ~/.local/state/agentsurface/session-backups (XDG_STATE_HOME honoured).",
          positional: true,
          format: "path",
          direction: "out",
        },
        {
          name: "--session",
          type: "string",
          description: "A running session to back up. Repeat to select several.",
          repeatable: true,
        },
      ],
      examples: [
        {
          invocation: "agentsurface session dump",
          description:
            "Back up the default session to ~/.local/state/agentsurface/session-backups/default.json.",
        },
        {
          invocation: "agentsurface session dump --session jobs --session review",
          description: "Several named sessions, one JSON file each.",
        },
        {
          invocation: "agentsurface session dump ~/herdr-sessions --session jobs",
          description: "An explicit output directory.",
        },
      ],
    },
    {
      name: "resume",
      summary: "Rebuild one backed-up session on the surface",
      audience: "operator",
      mutates: true,
      guidance:
        "Deliberately non-replacing. An occupied target is left untouched; an agent-free existing target reuses matching panes and recreates missing saved agent workspaces; a wholly missing target is fully reconstructed. A missing dirty worktree is refused, because metadata cannot carry uncommitted changes.",
      arguments: [
        {
          name: "name-or-path",
          type: "string",
          description:
            "A session name to resolve inside the default backup directory, or an explicit path to a snapshot file.",
          positional: true,
          required: true,
        },
        {
          name: "--session",
          type: "string",
          description: "Resume into this session name instead of the one saved in the snapshot.",
        },
      ],
      examples: [
        {
          invocation: "agentsurface session resume jobs",
          description:
            "Resolve `jobs` to jobs.json in the default backup directory and rebuild it under its saved name.",
        },
        {
          invocation: "agentsurface session resume ~/herdr-sessions/jobs.json --session recovered",
          description:
            "An explicit snapshot, rebuilt beside the original under a different session name.",
        },
      ],
    },
  ],
};

const NAME_TAB_COMMAND: ContractCommand = {
  name: "name-tab",
  summary: "Name the calling pane's tab after its agent's conversation",
  audience: "internal",
  mutates: true,
  guidance:
    "herdr's plugin hooks run this on agent detection and status changes. It is quiet by design and takes its whole input from the hook environment: failures reach herdr's plugin log and never a notification.",
  arguments: [],
};

const EXECUTE_DIRECTIVE_COMMAND: ContractCommand = {
  name: "execute-directive",
  summary: "Realize one session directive on the surface",
  audience: "internal",
  mutates: true,
  guidance:
    "The host spawns this detached, one per directive line, so a hosted TUI's popup can close the moment a directive is submitted. There is no terminal to hold: failures go to stderr and, best effort, to a herdr notification naming the spool file that holds the prompt.",
  arguments: [
    {
      name: "directive",
      type: "string",
      description:
        "The directive as one JSON argument, in the format directive.schema.json publishes. Parsed strictly: unknown keys and unknown schema_versions are refused, never repaired.",
      positional: true,
      required: true,
      format: "json",
    },
  ],
};

const GUIDE_COMMAND: ContractCommand = {
  name: "guide",
  summary: "Print this CLI's agent contract",
  audience: "agent",
  mutates: false,
  guidance:
    "--json emits the fleet agent contract inside the standard envelope; without it the same document renders as agent-facing help. --help, --agent-help, and --agent-teaser are renders of this document too, so there is nothing here that is authored twice.",
  arguments: [
    {
      name: "--json",
      type: "boolean",
      description: "Emit the contract as the machine-readable envelope.",
      // Output shape, not a parameter: a consumer building a call surface
      // has already decided it wants the envelope.
      role: "output-format",
    },
  ],
  examples: [
    {
      invocation: "agentsurface guide --json",
      description: "The whole contract as the {schema_version, ok, error, data} envelope.",
    },
  ],
};

export const CONTRACT: Contract = {
  contract_version: CONTRACT_VERSION,
  meta: {
    name: "agentsurface",
    version: CLI_VERSION,
    purpose:
      "Fleet integrations over the herdr surface: host fleet TUIs and realize their session directives, name conversations, back up sessions, and carry messages between the agents running on the surface.",
    audience: "agent",
  },
  guidance: GUIDANCE,
  concepts: {
    model: {
      agent:
        "One harness running in a herdr pane. Live agents are what the bus addresses; an agent whose harness has not reported a session yet has no session id yet.",
      name: "The label of the tab hosting an agent — the conversation slug the tab namer set, or a hand rename. Mutable and collidable.",
      session_id:
        "The harness's own session identifier: the stable address, neither mutable nor collidable.",
      place:
        "The workspace an agent works in — the worktree's name for a worktree session, the workspace label otherwise. An address only while one agent is there.",
      delivery:
        "herdr typing a message into a target's harness. Queued behind a working turn, read now when idle, and refused outright when the target is blocked on the operator.",
      directive:
        "One JSON line a hosted tool writes to its stdout, describing a session for agentsurface to realize on the surface. directive.schema.json is the published format.",
    },
    output_contract: {
      envelope: {
        schema_version: "number — the envelope version, currently 1",
        ok: "boolean",
        error: "{code, message, recovery?} | null",
        data: "payload | null",
        scope:
          "guide --json only. Every other command prints human-readable text on stdout — session dump and resume print a JSON report, conversation describe prints JSON lines — and reports failure on stderr as `error: <message>` with an optional recovery line.",
      },
      exit_codes: {
        "0": "success",
        "1": "domain failure — an error code below, reported with its message and recovery",
        "2": "usage fault — the invocation was not understood; nothing ran",
        "3": "conversation slug: no transcript matches the reference",
        "4": "conversation slug: the transcript holds no user prompt yet — poll, do not retry differently",
        "130": "a hosted tool was interrupted by the operator; the popup closes without holding",
      },
    },
    error_codes: [
      {
        code: "bus_outside_pane",
        meaning: "The bus identifies the sender by its herdr pane, and HERDR_PANE_ID is not set.",
        recovery: "Run from a shell inside a herdr pane.",
      },
      {
        code: "bus_target_not_found",
        meaning:
          "No agent has that name or session id, and no place by that name holds exactly one agent.",
        recovery: "`agentsurface agents --all` lists every live agent with its place.",
      },
      {
        code: "bus_target_ambiguous",
        meaning: "The target matched more than one agent in the deciding tier; nothing was sent.",
        recovery: "Resend to one of the session ids the error lists.",
      },
      {
        code: "bus_target_blocked",
        meaning:
          "The target is blocked on interactive input and rejected the message; nothing was delivered.",
        recovery:
          "A blocked agent is waiting on the operator, so waiting may not free it; --wait-unblocked lingers and retries if you want to try anyway.",
      },
      {
        code: "bus_target_not_ready",
        meaning: "The target's harness is not accepting input yet; nothing was delivered.",
        recovery: "Retry, or --wait-unblocked to linger until it is ready.",
      },
      {
        code: "confirmation_requires_tty",
        meaning:
          "A confirmation was asked for without an interactive terminal; the command was not run.",
        recovery: "Run it from a real terminal, or run the command directly if it needs no gate.",
      },
      {
        code: "missing_plugin_context",
        meaning: "close-active found no herdr plugin context; nothing was closed.",
        recovery: "Only a herdr plugin pane entrypoint sets HERDR_PLUGIN_CONTEXT_JSON.",
      },
      {
        code: "invalid_plugin_context",
        meaning: "The herdr plugin context was not a JSON object; nothing was closed.",
      },
      {
        code: "missing_close_target",
        meaning:
          "The plugin context names no active pane, tab, or workspace of the requested kind.",
      },
      {
        code: "directive_invalid",
        meaning: "A directive line is not JSON, or does not match directive.schema.json.",
        recovery:
          "Update agentsurface and the emitting tool together; directives are never repaired.",
      },
      {
        code: "directive_unsupported",
        meaning: "A directive declares a schema_version this host does not speak.",
        recovery: "Update agentsurface and the emitting tool together.",
      },
      {
        code: "transcript_not_found",
        meaning: "No transcript in that harness's store matches the reference.",
        recovery:
          "Pass a session id from the harness's own store, or a transcript path. Exit code 3.",
      },
      {
        code: "transcript_no_prompt",
        meaning:
          "The transcript exists but holds no user prompt yet, so there is nothing to name it after.",
        recovery: "The conversation has not started; poll after the first prompt. Exit code 4.",
      },
      {
        code: "slug_inference_failed",
        meaning: "The harness could not produce a slug for the conversation.",
        recovery: "Run the printed command by hand to see the harness's own report.",
      },
      {
        code: "catalog_no_metadata_level",
        meaning: "The agentlaunch catalog designates no metadata level for that harness.",
        recovery: 'Give the harness a "metadata" level in agentlaunch\'s catalog.',
      },
      {
        code: "catalog_unreadable",
        meaning:
          "agentlaunch x-catalog printed no envelope, or one this version does not understand.",
        recovery:
          "Run `agentlaunch x-catalog --x-json` by hand; update agentsurface and agentlaunch together.",
      },
      {
        code: "catalog_failed",
        meaning: "agentlaunch x-catalog reported a failure of its own, or exited with no envelope.",
        recovery: "Run `agentlaunch x-catalog --x-json` by hand.",
      },
      {
        code: "agentlaunch_missing",
        meaning:
          "agentlaunch could not be run, so neither the catalog nor slug inference is reachable.",
        recovery: "Install it: ~/code/agentlaunch/scripts/install.sh --install",
      },
      {
        code: "herdr_session_not_found",
        meaning: "The named herdr session does not exist.",
      },
      {
        code: "herdr_session_not_running",
        meaning: "The named herdr session exists but is not running, so it cannot be captured.",
      },
      {
        code: "herdr_session_start_timeout",
        meaning: "A session being resumed did not start within the wait.",
      },
      {
        code: "invalid_session_name",
        meaning: "A herdr session name is not a name herdr accepts.",
      },
      {
        code: "duplicate_session_name",
        meaning: "The same session was requested more than once in one dump.",
      },
      {
        code: "session_snapshot_unreadable",
        meaning: "The snapshot file could not be read, or is not JSON.",
      },
      {
        code: "session_snapshot_invalid",
        meaning: "The snapshot is JSON but does not match the snapshot schema.",
        recovery:
          "Snapshots are versioned and strict; a snapshot from a newer agentsurface needs a newer one to read it.",
      },
      {
        code: "session_topology_mismatch",
        meaning:
          "The live session does not match the snapshot, so resuming into it would not be a restore.",
        recovery: "Resume into a fresh session name with --session.",
      },
      {
        code: "dirty_worktree_missing",
        meaning:
          "A worktree the snapshot needs is gone and had uncommitted changes; recreating it would lose them.",
        recovery: "Restore the worktree yourself, then resume.",
      },
      {
        code: "worktree_base_missing",
        meaning:
          "A missing worktree cannot be recreated because the snapshot recorded no commit for it.",
      },
    ],
    read_only_commands: ["guide", "agents", "conversation describe"],
    agent_defaults: [
      "Call `agentsurface agents` before addressing anyone: names change, and a place stops being an address the moment a second agent joins it.",
      "Prefer a session id whenever a name or place is contested — it is the only address that is neither mutable nor collidable.",
      "Read the target's status before sending, and read the confirmation line after: delivery is not receipt.",
    ],
  },
  commands: [
    GUIDE_COMMAND,
    AGENTS_COMMAND,
    MESSAGE_COMMAND,
    HOST_COMMAND,
    CONFIRM_COMMAND,
    SESSION_COMMAND,
    CONVERSATION_COMMAND,
    CLOSE_ACTIVE_COMMAND,
    NAME_TAB_COMMAND,
    EXECUTE_DIRECTIVE_COMMAND,
  ],
};

/** The contract inside the CLI's envelope — exactly what `guide --json`
 * prints and what agentstart's validator reads. */
export function contractEnvelope(): {
  schema_version: number;
  ok: true;
  error: null;
  data: Contract;
} {
  return {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    ok: true,
    error: null,
    data: CONTRACT,
  };
}

// --- The command tree, walked ---

export interface CommandNode {
  /** The full path, space-joined: the identity everything addresses a
   * command by, `read_only_commands` included. */
  readonly path: string;
  readonly command: ContractCommand;
  readonly isGroup: boolean;
}

/** The command forest flattened to full paths, groups kept in place so a
 * render can print the line a group owns. */
export function walkCommands(
  commands: readonly ContractCommand[] = CONTRACT.commands,
  prefix: readonly string[] = [],
): CommandNode[] {
  const nodes: CommandNode[] = [];
  for (const command of commands) {
    const path = [...prefix, command.name];
    const subcommands = command.subcommands ?? [];
    nodes.push({ path: path.join(" "), command, isGroup: subcommands.length > 0 });
    if (subcommands.length > 0) nodes.push(...walkCommands(subcommands, path));
  }
  return nodes;
}

export function findCommand(path: string): ContractCommand | undefined {
  return walkCommands().find((node) => node.path === path)?.command;
}

/**
 * Flags recognized only before a command name, so they are not arguments of
 * anything and have no place in the contract document — but `--help` still
 * has to print them and main.ts still has to route them, and those are two
 * places to spell `--agent-teaser` wrong.
 */
export const ENTRYPOINT_FLAGS: readonly {
  readonly kind: "help" | "agent-help" | "agent-teaser" | "version";
  readonly spellings: readonly string[];
}[] = [
  { kind: "help", spellings: ["--help", "-h"] },
  { kind: "agent-help", spellings: ["--agent-help"] },
  { kind: "agent-teaser", spellings: ["--agent-teaser"] },
  { kind: "version", spellings: ["--version", "-V"] },
];

// --- Argument spelling, from the argument that owns it ---

function isFlag(argument: ContractArgument): boolean {
  return argument.positional !== true;
}

export function valueLabel(argument: ContractArgument): string {
  if (argument.choices !== undefined) return argument.choices.join("|");
  return argument.name.replace(/^--/, "");
}

/** How one argument appears in a usage line. The single place argument
 * syntax is rendered, so no usage line can drift from the argument list
 * beside it — and the parser refuses exactly what this spells. */
export function spellArgument(argument: ContractArgument): string {
  if (argument.positional === true) {
    const repeat = argument.repeatable === true ? "…" : "";
    const inner = `${argument.name}${repeat}`;
    const spelled = argument.required === true ? `<${inner}>` : `[${inner}]`;
    const separator = argument.x_passthrough?.separator;
    if (separator === "required") return `-- ${spelled}`;
    if (separator === "optional") return `[--] ${spelled}`;
    return spelled;
  }
  const value = argument.type === "boolean" ? "" : ` <${valueLabel(argument)}>`;
  const repeat = argument.repeatable === true ? "…" : "";
  const spelled = `${argument.name}${value}`;
  return argument.required === true ? spelled : `[${spelled}]${repeat}`;
}

/** A command's invocation, spelled from its own arguments. */
export function usageLine(path: string): string {
  const node = walkCommands().find((candidate) => candidate.path === path);
  if (node === undefined) throw new Error(`no contract command named "${path}"`);
  const head = `${CONTRACT.meta.name} ${path}`;
  if (node.isGroup) {
    return `${head} <${(node.command.subcommands ?? []).map((sub) => sub.name).join("|")}>`;
  }
  const parts = [head];
  for (const argument of node.command.arguments ?? []) parts.push(spellArgument(argument));
  const stdin = node.command.stdin;
  if (stdin !== undefined) parts.push(`< <${stdin.accepts}>`);
  return parts.join(" ");
}

// --- The parser, derived from the declaration above ---

/** What one parsed invocation answers. Values are read by the argument's
 * own contract name, so a caller cannot ask for a flag the contract does
 * not declare. */
export interface ParsedInvocation {
  /** The declared positionals, in declaration order. */
  readonly positional: readonly string[];
  /** The trailing argv of a passthrough positional — another program's
   * arguments, never read as ours. Empty when the command declares none. */
  readonly rest: readonly string[];
  flag(name: string): boolean;
  option(name: string): string | undefined;
  options(name: string): readonly string[];
  integer(name: string): number | undefined;
}

function leafFor(path: string): ContractCommand {
  const node = walkCommands().find((candidate) => candidate.path === path);
  if (node === undefined || node.isGroup) throw new Error(`no contract leaf named "${path}"`);
  return node.command;
}

function checkValue(path: string, argument: ContractArgument, value: string): string {
  if (argument.choices !== undefined && !argument.choices.includes(value)) {
    throw new UsageError(
      `${path} ${argument.name} must be one of ${argument.choices.join(", ")}, not "${value}"`,
    );
  }
  if (argument.type === "integer" || argument.type === "number") {
    const parsed = Number(value);
    const whole = argument.type === "integer" ? Number.isInteger(parsed) : Number.isFinite(parsed);
    if (!whole) {
      throw new UsageError(
        `${path} ${argument.name} takes ${argument.type === "integer" ? "an integer" : "a number"}, not "${value}"`,
      );
    }
    if (argument.minimum !== undefined && parsed < argument.minimum) {
      throw new UsageError(`${path} ${argument.name} is at least ${argument.minimum}`);
    }
    if (argument.maximum !== undefined && parsed > argument.maximum) {
      throw new UsageError(`${path} ${argument.name} is at most ${argument.maximum}`);
    }
  }
  return value;
}

/**
 * Parse one command's argv against its own declaration. Every grammar
 * decision — which flags exist, which take a value, which repeat, which
 * values are in the closed set, which bounds an integer honours, which
 * positionals are required, and which argument swallows a trailing argv —
 * is read off the contract, so the parser cannot accept an argument
 * `guide --json` does not publish. The commands themselves keep only the
 * checks the contract has no vocabulary for.
 */
export function parseInvocation(path: string, argv: readonly string[]): ParsedInvocation {
  const command = leafFor(path);
  const declared = command.arguments ?? [];
  const flags = new Map<string, ContractArgument>();
  for (const argument of declared.filter(isFlag)) {
    for (const spelling of [argument.name, ...(argument.aliases ?? [])]) {
      flags.set(spelling, argument);
    }
  }
  const positionalArguments = declared.filter((argument) => argument.positional === true);
  const passthrough = positionalArguments.find((argument) => argument.x_passthrough !== undefined);
  const leading = positionalArguments.filter((argument) => argument !== passthrough);

  const positional: string[] = [];
  const given = new Map<string, string[]>();
  let rest: string[] | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (passthrough !== undefined && token === "--") {
      rest = [...argv.slice(index + 1)];
      break;
    }
    if (token.startsWith("--")) {
      const argument = flags.get(token);
      if (argument === undefined) throw new UsageError(`unknown ${path} option "${token}"`);
      const occurrences = given.get(argument.name) ?? [];
      if (occurrences.length > 0 && argument.repeatable !== true) {
        throw new UsageError(`${path} takes at most one ${argument.name}`);
      }
      if (argument.type === "boolean") {
        occurrences.push("");
      } else {
        const value = argv[index + 1];
        if (value === undefined || value === "" || value === "--") {
          throw new UsageError(`${path} ${argument.name} takes a non-empty value`);
        }
        occurrences.push(checkValue(path, argument, value));
        index += 1;
      }
      given.set(argument.name, occurrences);
      continue;
    }
    if (positional.length >= leading.length) {
      if (passthrough === undefined) {
        throw new UsageError(`${path} takes no argument "${token}": ${usageLine(path)}`);
      }
      if (passthrough.x_passthrough?.separator === "required") {
        throw new UsageError(`${path} requires -- before <${passthrough.name}>`);
      }
      rest = [...argv.slice(index)];
      break;
    }
    positional.push(checkValue(path, leading[positional.length] as ContractArgument, token));
  }

  if (passthrough !== undefined) {
    const trailing = rest ?? [];
    if (passthrough.required === true && trailing.length === 0) {
      throw new UsageError(`${path} takes a command to run: ${usageLine(path)}`);
    }
    if ((trailing[0] ?? "").startsWith("-")) {
      throw new UsageError(
        `${path} takes a command, not an option, where <${passthrough.name}> is`,
      );
    }
    rest = trailing;
  }

  for (const [index, argument] of leading.entries()) {
    if (argument.required === true && positional[index] === undefined) {
      throw new UsageError(`${path} takes <${argument.name}>: ${usageLine(path)}`);
    }
  }
  for (const argument of declared.filter(isFlag)) {
    if (argument.required === true && !given.has(argument.name)) {
      throw new UsageError(`${path} requires ${spellArgument(argument)}`);
    }
  }

  const wasGiven = (name: string): boolean => {
    if (name.startsWith("-")) return given.has(name);
    const at = leading.findIndex((argument) => argument.name === name);
    return at >= 0 && positional[at] !== undefined;
  };
  for (const constraint of command.constraints ?? []) {
    const present = constraint.arguments.filter(wasGiven);
    const [first, ...others] = constraint.arguments;
    if (constraint.kind === "requires" && first !== undefined && wasGiven(first)) {
      for (const other of others) {
        if (!wasGiven(other)) throw new UsageError(`${first} requires ${other}`);
      }
    }
    if (constraint.kind === "conflicts" && present.length > 1) {
      throw new UsageError(`${present.join(" and ")} may not be combined`);
    }
    if (constraint.kind === "one_of") {
      if (present.length > 1) {
        throw new UsageError(`give only one of ${constraint.arguments.join(", ")}`);
      }
      if (constraint.required === true && present.length === 0) {
        throw new UsageError(`give exactly one of ${constraint.arguments.join(", ")}`);
      }
    }
    if (constraint.kind === "at_least_one" && present.length === 0) {
      throw new UsageError(`give at least one of ${constraint.arguments.join(", ")}`);
    }
  }

  return {
    positional,
    rest: rest ?? [],
    flag: (name) => (given.get(name)?.length ?? 0) > 0,
    option: (name) => given.get(name)?.at(-1),
    options: (name) => given.get(name) ?? [],
    integer: (name) => {
      const value = given.get(name)?.at(-1);
      return value === undefined ? undefined : Number(value);
    },
  };
}
