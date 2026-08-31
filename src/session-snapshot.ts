import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CliError } from "./errors.ts";
import {
  createHerdrCall,
  type HerdrCall,
  HerdrError,
  type HerdrResponse,
  herdrBinary,
  invoke,
  nextAgentName,
  startAgentWhenReady,
} from "./herdr.ts";
import { type Environ, expandTilde, stateDirectory } from "./paths.ts";
import { reportConversationValue } from "./tab-namer.ts";

const safeText = z.string().refine(
  (value) =>
    ![...value].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    }),
  { message: "control characters are not allowed" },
);
const optionalText = safeText.nullable();
const absolutePath = safeText.refine(isAbsolute, { message: "path must be absolute" });
const optionalPath = absolutePath.nullable();
const sessionName = safeText
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..");
const agentName = safeText.regex(/^[a-z][a-z0-9_-]{0,31}$/).nullable();

const agentSessionSchema = z
  .object({
    source: safeText,
    agent: safeText,
    kind: z.enum(["id", "path"]),
    value: safeText.min(1).max(4096),
  })
  .strict()
  .refine((session) => session.kind !== "path" || isAbsolute(session.value), {
    message: "path session references must be absolute",
    path: ["value"],
  });

const agentSchema = z
  .object({
    name: agentName,
    harness: optionalText,
    session: agentSessionSchema.nullable(),
  })
  .strict();

const paneSchema = z
  .object({
    cwd: optionalPath,
    label: optionalText,
    agent: agentSchema.nullable(),
  })
  .strict();

const tabSchema = z
  .object({
    label: safeText,
    panes: z.array(paneSchema),
  })
  .strict();

const gitCheckoutSchema = z
  .object({
    repo_root: absolutePath,
    checkout_path: absolutePath,
    linked_worktree: z.boolean(),
    branch: optionalText,
    head: optionalText,
    dirty: z.boolean().nullable(),
  })
  .strict();

const workspaceSchema = z
  .object({
    label: safeText,
    cwd: optionalPath,
    git: gitCheckoutSchema.nullable(),
    tabs: z.array(tabSchema),
  })
  .strict();

const savedSessionSchema = z
  .object({
    name: sessionName,
    workspaces: z.array(workspaceSchema),
  })
  .strict();

export const sessionSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    captured_at: z.string().datetime(),
    session: savedSessionSchema,
  })
  .strict();

export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
type SavedSession = SessionSnapshot["session"];
type SavedWorkspace = SavedSession["workspaces"][number];
type SavedAgent = SavedWorkspace["tabs"][number]["panes"][number]["agent"];

export interface HerdrSessionInfo {
  name: string;
  running: boolean;
  socketPath?: string;
}

export interface SnapshotServices {
  listSessions: () => Promise<HerdrSessionInfo[]>;
  call: (sessionName: string) => HerdrCall;
  captureCall?: (sessionName: string) => HerdrCall;
  git: (cwd: string, args: string[]) => Promise<string | null>;
  startServer: (sessionName: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
}

const rawWorkspaceSchema = z
  .object({
    workspace_id: z.string(),
    label: z.string(),
    worktree: z
      .object({
        repo_root: z.string(),
        checkout_path: z.string(),
        is_linked_worktree: z.boolean(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
const rawTabSchema = z
  .object({
    tab_id: z.string(),
    workspace_id: z.string(),
    label: z.string(),
  })
  .passthrough();
const rawPaneSchema = z
  .object({
    pane_id: z.string(),
    workspace_id: z.string(),
    tab_id: z.string(),
    cwd: z.string().nullish(),
    label: z.string().nullish(),
  })
  .passthrough();
const rawAgentSchema = z
  .object({
    name: z.string().nullish(),
    agent: z.string().nullish(),
    pane_id: z.string(),
    agent_session: z
      .object({
        source: z.string(),
        agent: z.string(),
        kind: z.enum(["id", "path"]),
        value: z.string(),
      })
      .strict()
      .nullish(),
  })
  .passthrough();

type RawWorkspace = z.infer<typeof rawWorkspaceSchema>;
type RawTab = z.infer<typeof rawTabSchema>;
type RawPane = z.infer<typeof rawPaneSchema>;
type RawAgent = z.infer<typeof rawAgentSchema>;

const rawBackupResults = {
  "workspace.list": z
    .object({ type: z.literal("workspace_list"), workspaces: z.array(rawWorkspaceSchema) })
    .strict(),
  "tab.list": z.object({ type: z.literal("tab_list"), tabs: z.array(rawTabSchema) }).strict(),
  "pane.list": z.object({ type: z.literal("pane_list"), panes: z.array(rawPaneSchema) }).strict(),
  "agent.list": z
    .object({ type: z.literal("agent_list"), agents: z.array(rawAgentSchema) })
    .strict(),
} as const;

export type RawBackupMethod = keyof typeof rawBackupResults;

function rows(result: unknown, key: string): unknown[] {
  const value = (result as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function gitMetadata(
  services: SnapshotServices,
  repoRoot: string,
  checkoutPath: string,
): Promise<{ branch: string | null; head: string | null; dirty: boolean | null }> {
  const [rawBranch, head, status] = await Promise.all([
    services.git(checkoutPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    services.git(checkoutPath, ["rev-parse", "HEAD"]),
    services.git(checkoutPath, ["status", "--porcelain"]),
  ]);
  // Keep repoRoot in the call signature: it is the source Herdr needs to reopen
  // the checkout, while checkoutPath is the checkout whose exact state is read.
  void repoRoot;
  return {
    branch: rawBranch === "HEAD" ? null : rawBranch,
    head,
    dirty: status === null ? null : status !== "",
  };
}

function savedAgent(agent: RawAgent | undefined): Exclude<SavedAgent, null> | null {
  if (agent === undefined) return null;
  const rawSession = agent.agent_session;
  const source = text(rawSession?.source);
  const sessionAgent = text(rawSession?.agent);
  const kind = rawSession?.kind;
  const value = text(rawSession?.value);
  let session: z.infer<typeof agentSessionSchema> | null = null;
  if (
    source !== null &&
    sessionAgent !== null &&
    (kind === "id" || kind === "path") &&
    value !== null
  ) {
    session = { source, agent: sessionAgent, kind, value };
  }
  return {
    name: text(agent.name),
    harness: text(agent.agent),
    session,
  };
}

async function captureOneSession(services: SnapshotServices, name: string): Promise<SavedSession> {
  const call = services.captureCall?.(name) ?? services.call(name);
  const [workspaceResult, tabResult, paneResult, agentResult] = await Promise.all([
    invoke(call, ["workspace", "list"]),
    invoke(call, ["tab", "list"]),
    invoke(call, ["pane", "list"]),
    invoke(call, ["agent", "list"]),
  ]);
  const rawWorkspaces = rows(workspaceResult, "workspaces") as RawWorkspace[];
  const rawTabs = rows(tabResult, "tabs") as RawTab[];
  const rawPanes = rows(paneResult, "panes") as RawPane[];
  const rawAgents = rows(agentResult, "agents") as RawAgent[];
  const agentsByPane = new Map(
    rawAgents
      .map((agent) => [text(agent.pane_id), agent] as const)
      .filter((pair): pair is [string, RawAgent] => pair[0] !== null),
  );

  const workspaces: SavedWorkspace[] = [];
  for (const workspace of rawWorkspaces) {
    const workspaceId = text(workspace.workspace_id);
    const label = text(workspace.label);
    if (workspaceId === null || label === null) continue;
    const workspacePanes = rawPanes.filter((pane) => text(pane.workspace_id) === workspaceId);
    const checkoutPath = text(workspace.worktree?.checkout_path);
    const repoRoot = text(workspace.worktree?.repo_root);
    const linked = workspace.worktree?.is_linked_worktree === true;
    const git =
      checkoutPath !== null && repoRoot !== null
        ? {
            repo_root: repoRoot,
            checkout_path: checkoutPath,
            linked_worktree: linked,
            ...(await gitMetadata(services, repoRoot, checkoutPath)),
          }
        : null;
    const tabs = rawTabs
      .filter((tab) => text(tab.workspace_id) === workspaceId)
      .flatMap((tab) => {
        const tabId = text(tab.tab_id);
        const tabLabel = text(tab.label);
        if (tabId === null || tabLabel === null) return [];
        return [
          {
            label: tabLabel,
            panes: workspacePanes
              .filter((pane) => text(pane.tab_id) === tabId)
              .flatMap((pane) => {
                const paneId = text(pane.pane_id);
                if (paneId === null) return [];
                return [
                  {
                    cwd: text(pane.cwd),
                    label: text(pane.label),
                    agent: savedAgent(agentsByPane.get(paneId)),
                  },
                ];
              }),
          },
        ];
      });
    workspaces.push({
      label,
      cwd: workspacePanes.map((pane) => text(pane.cwd)).find(Boolean) ?? git?.checkout_path ?? null,
      git,
      tabs,
    });
  }
  return { name, workspaces };
}

export async function captureSessionSnapshot(
  services: SnapshotServices,
  name = "default",
): Promise<SessionSnapshot> {
  const session = (await services.listSessions()).find((candidate) => candidate.name === name);
  if (session === undefined) {
    throw new CliError("herdr_session_not_found", `Herdr session ${name} does not exist`);
  }
  if (!session.running) {
    throw new CliError("herdr_session_not_running", `Herdr session ${name} is not running`);
  }
  return sessionSnapshotSchema.parse({
    schema_version: 1,
    captured_at: services.now().toISOString(),
    session: await captureOneSession(services, name),
  });
}

export function parseSessionSnapshot(input: string): SessionSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new CliError(
      "session_snapshot_unreadable",
      `session snapshot is not JSON: ${(error as Error).message}`,
    );
  }
  const result = sessionSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(
      "session_snapshot_invalid",
      `session snapshot is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return result.data;
}

export function parseRawBackupSocketResponse(
  method: RawBackupMethod,
  requestId: string,
  line: string,
): HerdrResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new HerdrError(`Herdr session socket returned invalid JSON: ${(error as Error).message}`);
  }
  const errorEnvelope = z
    .object({
      id: z.literal(requestId),
      error: z.object({ code: z.string(), message: z.string() }).passthrough(),
    })
    .strict();
  const errorResult = errorEnvelope.safeParse(parsed);
  if (errorResult.success) return { error: errorResult.data.error };
  const successResult = z
    .object({ id: z.literal(requestId), result: rawBackupResults[method] })
    .strict()
    .safeParse(parsed);
  if (!successResult.success) {
    throw new HerdrError(
      `Herdr ${method} socket response has an incompatible format: ${successResult.error.issues
        .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return { result: successResult.data.result };
}

function rawHerdrCall(socketPath: string): HerdrCall {
  return (args) =>
    new Promise((resolve, reject) => {
      const method = args.slice(0, 2).join(".");
      if (!(method in rawBackupResults) || args.length !== 2) {
        reject(new HerdrError(`raw backup client does not support herdr ${args.join(" ")}`));
        return;
      }
      const backupMethod = method as RawBackupMethod;
      const requestId = `agentsurface_${crypto.randomUUID()}`;
      let buffer = "";
      let settled = false;
      const socket = createConnection(socketPath);
      const finish = (error: Error | null, response?: HerdrResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error !== null) reject(error);
        else resolve(response ?? {});
      };
      const timer = setTimeout(
        () => finish(new HerdrError(`timed out reading Herdr session socket ${socketPath}`)),
        5_000,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: requestId, method, params: {} })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          finish(
            null,
            parseRawBackupSocketResponse(backupMethod, requestId, buffer.slice(0, newline)),
          );
        } catch (error) {
          finish(error as Error);
        }
      });
      socket.on("error", (error) => {
        finish(
          new HerdrError(`could not read Herdr session socket ${socketPath}: ${error.message}`),
        );
      });
      socket.on("end", () => {
        if (!settled) finish(new HerdrError(`Herdr session socket closed without a response`));
      });
    });
}

export function captureCallWithProtocolFallback(
  cliCall: HerdrCall,
  socketCall: HerdrCall,
): HerdrCall {
  return async (args) => {
    try {
      const response = await cliCall(args);
      if (
        response.error?.code === "protocol_mismatch" &&
        response.error.message !== undefined &&
        /client protocol \d+ is newer than server protocol \d+/.test(response.error.message)
      ) {
        return socketCall(args);
      }
      return response;
    } catch (error) {
      if (
        !(error instanceof HerdrError) ||
        !/client protocol \d+ is newer than server protocol \d+/.test(error.message)
      ) {
        throw error;
      }
      return socketCall(args);
    }
  };
}

function productionServices(env: Environ): SnapshotServices {
  const listCall = createHerdrCall(env);
  const sockets = new Map<string, string>();
  return {
    listSessions: async () => {
      const response = (await listCall(["session", "list", "--json"])) as unknown as {
        sessions?: unknown;
      };
      if (!Array.isArray(response.sessions)) {
        throw new HerdrError("herdr session list returned no sessions");
      }
      return response.sessions.flatMap((row) => {
        const record = row as { name?: unknown; running?: unknown; socket_path?: unknown };
        const name = text(record.name);
        const running = record.running;
        const socketPath = text(record.socket_path);
        if (name === null || typeof running !== "boolean") return [];
        if (socketPath !== null) sockets.set(name, socketPath);
        return [{ name, running, ...(socketPath === null ? {} : { socketPath }) }];
      });
    },
    call: (name) => createHerdrCall(env, name),
    captureCall: (name) => {
      const cliCall = createHerdrCall(env, name);
      const socketPath = sockets.get(name);
      if (socketPath === undefined) {
        throw new HerdrError(`herdr session list returned no socket for ${name}`);
      }
      return captureCallWithProtocolFallback(cliCall, rawHerdrCall(socketPath));
    },
    git: async (cwd, args) => {
      const proc = Bun.spawn(["git", "-C", cwd, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: env as Record<string, string>,
      });
      const stdout = await new Response(proc.stdout as ReadableStream).text();
      return (await proc.exited) === 0 ? stdout.trimEnd() : null;
    },
    startServer: (name) => {
      const proc = Bun.spawn([herdrBinary(env), "--session", name, "server"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        env: env as Record<string, string>,
      });
      proc.unref();
    },
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    now: () => new Date(),
  };
}

function resumableAgentCount(snapshot: SessionSnapshot): number {
  return snapshot.session.workspaces.reduce(
    (workspaceCount, workspace) =>
      workspaceCount +
      workspace.tabs.reduce(
        (tabCount, tab) =>
          tabCount +
          tab.panes.filter((pane) => pane.agent !== null && pane.agent.session !== null).length,
        0,
      ),
    0,
  );
}

export interface SessionDumpResult {
  name: string;
  path: string;
  agents: number;
}

export function sessionBackupDirectory(env: Environ, home: string): string {
  return join(stateDirectory(env, home, "agentsurface"), "session-backups");
}

export function resolveSessionBackupPath(reference: string, env: Environ, home: string): string {
  const expanded = expandTilde(reference, home);
  if (isAbsolute(expanded) || reference.includes("/") || reference.endsWith(".json")) {
    return expanded;
  }
  if (!sessionName.safeParse(reference).success) return expanded;
  return join(sessionBackupDirectory(env, home), `${reference}.json`);
}

export async function dumpSessionSnapshots(
  directory: string,
  names: string[],
  services: SnapshotServices,
): Promise<SessionDumpResult[]> {
  const requested = names.length === 0 ? ["default"] : names;
  const uniqueNames = new Set<string>();
  for (const name of requested) {
    if (!sessionName.safeParse(name).success) {
      throw new CliError(
        "invalid_session_name",
        `invalid Herdr session name ${JSON.stringify(name)}`,
      );
    }
    if (uniqueNames.has(name)) {
      throw new CliError(
        "duplicate_session_name",
        `Herdr session ${name} was requested more than once`,
      );
    }
    uniqueNames.add(name);
  }

  const snapshots = await Promise.all(
    [...uniqueNames].map((name) => captureSessionSnapshot(services, name)),
  );
  mkdirSync(directory, { recursive: true });
  return snapshots.map((snapshot) => {
    const path = join(directory, `${snapshot.session.name}.json`);
    const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return { name: snapshot.session.name, path, agents: resumableAgentCount(snapshot) };
  });
}

export async function dumpSessionsToDirectory(
  directory: string,
  names: string[],
  env: Environ,
): Promise<SessionDumpResult[]> {
  return dumpSessionSnapshots(directory, names, productionServices(env));
}

interface CreatedLocation {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

function createdLocation(result: unknown, operation: string): CreatedLocation {
  const body = result as {
    workspace?: { workspace_id?: unknown };
    tab?: { tab_id?: unknown };
    root_pane?: { pane_id?: unknown };
  } | null;
  const workspaceId = text(body?.workspace?.workspace_id);
  const tabId = text(body?.tab?.tab_id);
  const paneId = text(body?.root_pane?.pane_id);
  if (workspaceId === null || tabId === null || paneId === null) {
    throw new HerdrError(`herdr's ${operation} response named no workspace, tab, and root pane`);
  }
  return { workspaceId, tabId, paneId };
}

async function createSavedWorkspace(
  call: HerdrCall,
  workspace: SavedWorkspace,
): Promise<CreatedLocation> {
  if (workspace.git?.linked_worktree !== true) {
    const args = ["workspace", "create"];
    if (workspace.cwd !== null) args.push("--cwd", workspace.cwd);
    args.push("--label", workspace.label, "--no-focus");
    return createdLocation(await invoke(call, args), "workspace create");
  }

  const { repo_root: repoRoot, checkout_path: checkoutPath, branch, head, dirty } = workspace.git;
  const open = async (
    selector: "--path" | "--branch",
    value: string,
  ): Promise<CreatedLocation | null> => {
    try {
      return createdLocation(
        await invoke(call, [
          "worktree",
          "open",
          "--cwd",
          repoRoot,
          selector,
          value,
          "--label",
          workspace.label,
          "--no-focus",
        ]),
        "worktree open",
      );
    } catch (error) {
      if (error instanceof HerdrError && error.code === "worktree_not_found") return null;
      throw error;
    }
  };
  const byPath = await open("--path", checkoutPath);
  if (byPath !== null) return byPath;
  if (branch !== null) {
    const byBranch = await open("--branch", branch);
    if (byBranch !== null) return byBranch;
  }
  if (dirty === true) {
    throw new CliError(
      "dirty_worktree_missing",
      `refusing to recreate missing dirty worktree ${checkoutPath}; its uncommitted changes are not in the snapshot`,
    );
  }
  if (head === null) {
    throw new CliError(
      "worktree_base_missing",
      `cannot recreate missing worktree ${checkoutPath}: the snapshot has no commit`,
    );
  }
  const args = [
    "worktree",
    "create",
    "--cwd",
    repoRoot,
    "--path",
    checkoutPath,
    "--base",
    head,
    "--label",
    workspace.label,
    "--no-focus",
  ];
  if (branch !== null) args.push("--branch", branch);
  return createdLocation(await invoke(call, args), "worktree create");
}

function resumeArgs(agent: Exclude<SavedAgent, null>): string[] | null {
  const session = agent.session;
  if (session === null || agent.harness === null) return null;
  if (session.agent !== agent.harness) return null;
  const value = session.value;
  switch (`${session.source}\0${agent.harness}`) {
    // Bare fleet harness commands resolve through AgentLaunch's shims. Its
    // extension flag enters the resume route before native argv is composed,
    // preserving the conversation's cwd, model-aware balancing, and policy.
    case "herdr:claude\0claude":
    case "herdr:codex\0codex":
      return ["--x-resume", value];
    case "herdr:devin\0devin":
    case "herdr:droid\0droid":
    case "herdr:hermes\0hermes":
    case "herdr:qodercli\0qodercli":
    case "herdr:qwen\0qwen":
    case "herdr:grok\0grok":
      return ["--resume", value];
    case "herdr:copilot\0copilot":
      return [`--resume=${value}`];
    case "herdr:kimi\0kimi":
    case "herdr:opencode\0opencode":
    case "herdr:kilo\0kilo":
      return ["--session", value];
    case "herdr:mastracode\0mastracode":
      return ["--thread", value];
    case "herdr:omp\0omp":
      return [`--resume=${value}`];
    case "herdr:cursor\0cursor":
      return ["--resume", value];
    case "herdr:antigravity_cli\0agy":
      return ["--conversation", value];
    default:
      return null;
  }
}

interface PendingAgent {
  paneId: string;
  agent: Exclude<SavedAgent, null>;
  conversation: string;
}

function topologyMismatch(targetName: string, detail: string): CliError {
  return new CliError(
    "session_topology_mismatch",
    `cannot resume Herdr session ${targetName}: its live topology does not match the snapshot (${detail})`,
  );
}

async function restoreSavedWorkspace(
  call: HerdrCall,
  workspace: SavedWorkspace,
): Promise<PendingAgent[]> {
  const pending: PendingAgent[] = [];
  const location = await createSavedWorkspace(call, workspace);
  for (const [tabIndex, tab] of workspace.tabs.entries()) {
    let tabId = location.tabId;
    let rootPaneId = location.paneId;
    if (tabIndex === 0) {
      await invoke(call, ["tab", "rename", tabId, tab.label]);
    } else {
      const args = ["tab", "create", "--workspace", location.workspaceId];
      const cwd = tab.panes[0]?.cwd ?? workspace.cwd;
      if (cwd !== null) args.push("--cwd", cwd);
      args.push("--label", tab.label, "--no-focus");
      const created = createdLocation(
        {
          ...((await invoke(call, args)) as object),
          workspace: { workspace_id: location.workspaceId },
        },
        "tab create",
      );
      tabId = created.tabId;
      rootPaneId = created.paneId;
    }
    for (const [paneIndex, pane] of tab.panes.entries()) {
      let paneId = rootPaneId;
      if (paneIndex > 0) {
        const args = ["pane", "split", rootPaneId, "--direction", "down"];
        if (pane.cwd !== null) args.push("--cwd", pane.cwd);
        args.push("--no-focus");
        const result = (await invoke(call, args)) as { pane?: { pane_id?: unknown } } | null;
        const splitPaneId = text(result?.pane?.pane_id);
        if (splitPaneId === null) throw new HerdrError("herdr's pane split response named no pane");
        paneId = splitPaneId;
      }
      if (pane.label !== null) await invoke(call, ["pane", "rename", paneId, pane.label]);
      if (pane.agent !== null) pending.push({ paneId, agent: pane.agent, conversation: tab.label });
    }
    void tabId;
  }
  return pending;
}

async function pendingAgentsInExistingSession(
  call: HerdrCall,
  session: SavedSession,
  targetName: string,
): Promise<PendingAgent[]> {
  const [workspaceResult, tabResult, paneResult] = await Promise.all([
    invoke(call, ["workspace", "list"]),
    invoke(call, ["tab", "list"]),
    invoke(call, ["pane", "list"]),
  ]);
  const liveWorkspaces = rows(workspaceResult, "workspaces") as RawWorkspace[];
  const liveTabs = rows(tabResult, "tabs") as RawTab[];
  const livePanes = rows(paneResult, "panes") as RawPane[];

  const pending: PendingAgent[] = [];
  const unmatchedWorkspaces = [...liveWorkspaces];
  for (const savedWorkspace of session.workspaces) {
    const agentTabs = savedWorkspace.tabs.filter((tab) =>
      tab.panes.some((pane) => pane.agent !== null),
    );
    if (agentTabs.length === 0) continue;
    let candidates =
      savedWorkspace.git === null
        ? unmatchedWorkspaces.filter((workspace) => text(workspace.label) === savedWorkspace.label)
        : unmatchedWorkspaces.filter(
            (workspace) =>
              text(workspace.worktree?.checkout_path) === savedWorkspace.git?.checkout_path,
          );
    if (candidates.length > 1 && savedWorkspace.cwd !== null) {
      candidates = candidates.filter((workspace) => {
        const workspaceId = text(workspace.workspace_id);
        return livePanes.some(
          (pane) =>
            text(pane.workspace_id) === workspaceId && text(pane.cwd) === savedWorkspace.cwd,
        );
      });
    }
    if (candidates.length === 0) {
      pending.push(...(await restoreSavedWorkspace(call, savedWorkspace)));
      continue;
    }
    if (candidates.length > 1) {
      throw topologyMismatch(
        targetName,
        `workspace ${JSON.stringify(savedWorkspace.label)} has ${candidates.length} matches`,
      );
    }
    const liveWorkspace = candidates[0] as RawWorkspace;
    unmatchedWorkspaces.splice(unmatchedWorkspaces.indexOf(liveWorkspace), 1);
    const workspaceId = text(liveWorkspace.workspace_id);
    if (workspaceId === null) {
      throw topologyMismatch(
        targetName,
        `workspace ${JSON.stringify(savedWorkspace.label)} has no id`,
      );
    }

    const workspaceTabs = liveTabs.filter((tab) => text(tab.workspace_id) === workspaceId);
    const unmatchedTabs = [...workspaceTabs];
    for (const savedTab of agentTabs) {
      const matchingTab = unmatchedTabs.find((tab) => text(tab.label) === savedTab.label);
      if (matchingTab === undefined) {
        throw topologyMismatch(
          targetName,
          `workspace ${JSON.stringify(savedWorkspace.label)} has no tab ${JSON.stringify(savedTab.label)}`,
        );
      }
      unmatchedTabs.splice(unmatchedTabs.indexOf(matchingTab), 1);
      const tabId = text(matchingTab.tab_id);
      if (tabId === null) {
        throw topologyMismatch(targetName, `tab ${JSON.stringify(savedTab.label)} has no id`);
      }
      const tabPanes = livePanes.filter((pane) => text(pane.tab_id) === tabId);
      for (const [paneIndex, savedPane] of savedTab.panes.entries()) {
        if (savedPane.agent === null) continue;
        const livePane = tabPanes[paneIndex];
        if (
          livePane === undefined ||
          text(livePane.cwd) !== savedPane.cwd ||
          text(livePane.label) !== savedPane.label
        ) {
          throw topologyMismatch(
            targetName,
            `tab ${JSON.stringify(savedTab.label)} pane ${paneIndex + 1} differs from the snapshot`,
          );
        }
        const paneId = text(livePane.pane_id);
        if (paneId === null) {
          throw topologyMismatch(
            targetName,
            `tab ${JSON.stringify(savedTab.label)} pane ${paneIndex + 1} has no id`,
          );
        }
        pending.push({ paneId, agent: savedPane.agent, conversation: savedTab.label });
      }
    }
  }
  return pending;
}

async function startPendingAgents(
  call: HerdrCall,
  pending: PendingAgent[],
): Promise<{ agentsStarted: number; agentsSkipped: number }> {
  let agentsSkipped = 0;
  const names = new Set<string>();
  const resumed = new Set<string>();
  const launches: Array<{ item: PendingAgent; start: Promise<unknown> }> = [];
  for (const item of pending) {
    const args = resumeArgs(item.agent);
    const session = item.agent.session;
    if (args === null || session === null || item.agent.harness === null) {
      agentsSkipped += 1;
      continue;
    }
    const key = `${session.source}\0${session.agent}\0${session.kind}\0${session.value}`;
    if (resumed.has(key)) {
      agentsSkipped += 1;
      continue;
    }
    resumed.add(key);
    const preferred = item.agent.name;
    const name = preferred !== null && !names.has(preferred) ? preferred : nextAgentName(names);
    names.add(name);
    launches.push({
      item,
      start: startAgentWhenReady(call, {
        name,
        kind: item.agent.harness,
        paneId: item.paneId,
        agentArgs: args,
      }),
    });
  }
  await Promise.all(launches.map((launch) => launch.start));
  await Promise.all(
    launches.map(async ({ item }) => {
      try {
        await reportConversationValue(call, item.paneId, item.conversation);
      } catch {
        // The harness is already running, so a cosmetic metadata failure
        // cannot turn the successful resume into a reported launch failure.
        // The detection hook remains the retry path.
      }
    }),
  );
  return { agentsStarted: launches.length, agentsSkipped };
}

async function restoreMissingSession(
  services: SnapshotServices,
  session: SavedSession,
  targetName: string,
): Promise<{ agentsStarted: number; agentsSkipped: number }> {
  const call = services.call(targetName);
  const pending: PendingAgent[] = [];
  for (const workspace of session.workspaces) {
    pending.push(...(await restoreSavedWorkspace(call, workspace)));
  }

  return startPendingAgents(call, pending);
}

async function waitUntilRunning(
  services: SnapshotServices,
  name: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = (await services.listSessions()).find((candidate) => candidate.name === name);
    if (session?.running === true) return;
    await services.sleep(100);
  }
  throw new CliError(
    "herdr_session_start_timeout",
    `Herdr session ${name} did not start within ${timeoutMs}ms`,
  );
}

export interface SessionRestoreResult {
  name: string;
  action: "skipped_running" | "resumed_existing" | "restored_missing";
  agents_started: number;
  agents_skipped: number;
}

export async function restoreSessionSnapshot(
  snapshot: SessionSnapshot,
  services: SnapshotServices,
  targetName = snapshot.session.name,
): Promise<SessionRestoreResult> {
  if (!sessionName.safeParse(targetName).success) {
    throw new CliError(
      "invalid_session_name",
      `invalid Herdr session name ${JSON.stringify(targetName)}`,
    );
  }
  const existing = (await services.listSessions()).find((session) => session.name === targetName);
  if (existing?.running !== true) {
    services.startServer(targetName);
    await waitUntilRunning(services, targetName);
  }
  if (existing !== undefined) {
    const call = services.call(targetName);
    const agentResult = await invoke(call, ["agent", "list"]);
    if (rows(agentResult, "agents").length > 0) {
      return {
        name: targetName,
        action: "skipped_running",
        agents_started: 0,
        agents_skipped: 0,
      };
    }
    const pending = await pendingAgentsInExistingSession(call, snapshot.session, targetName);
    const restored = await startPendingAgents(call, pending);
    return {
      name: targetName,
      action: "resumed_existing",
      agents_started: restored.agentsStarted,
      agents_skipped: restored.agentsSkipped,
    };
  }
  const restored = await restoreMissingSession(services, snapshot.session, targetName);
  return {
    name: targetName,
    action: "restored_missing",
    agents_started: restored.agentsStarted,
    agents_skipped: restored.agentsSkipped,
  };
}

export async function resumeSessionFromFile(
  path: string,
  env: Environ,
  targetName?: string,
): Promise<SessionRestoreResult> {
  let input: string;
  try {
    input = readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(
      "session_snapshot_unreadable",
      `could not read ${path}: ${(error as Error).message}`,
    );
  }
  return restoreSessionSnapshot(parseSessionSnapshot(input), productionServices(env), targetName);
}
