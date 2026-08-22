import { CliError, UsageError } from "./errors.ts";

export const CONFIRM_USAGE =
  "confirm --title <text> [--message <text>] [--confirm-label <text>] -- <command> [args…]";

export interface Confirmation {
  title: string;
  message: string | null;
  confirmLabel: string;
  command: [string, ...string[]];
}

export function parseConfirmation(argv: string[]): Confirmation {
  let title: string | undefined;
  let message: string | null = null;
  let confirmLabel = "Confirm";
  let index = 0;

  while (index < argv.length && argv[index] !== "--") {
    const option = argv[index];
    const value = argv[index + 1];
    if (option !== "--title" && option !== "--message" && option !== "--confirm-label") {
      throw new UsageError(`unknown confirm option "${option ?? ""}"`);
    }
    if (value === undefined || value === "" || value === "--") {
      throw new UsageError(`${option} takes a non-empty value`);
    }
    if (option === "--title") title = value;
    if (option === "--message") message = value;
    if (option === "--confirm-label") confirmLabel = value;
    index += 2;
  }

  if (argv[index] !== "--") {
    throw new UsageError("confirm requires -- before the command");
  }
  const command = argv.slice(index + 1);
  if (title === undefined || title === "") {
    throw new UsageError("confirm requires --title <text>");
  }
  if (command.length === 0 || (command[0] ?? "").startsWith("-")) {
    throw new UsageError("confirm requires a command after --");
  }

  return {
    title,
    message,
    confirmLabel,
    command: command as [string, ...string[]],
  };
}

export type ConfirmationSelection = "cancel" | "confirm";
export type ConfirmationDecision = ConfirmationSelection | null;

export function interpretConfirmationKey(
  key: string,
  selection: ConfirmationSelection,
): { selection: ConfirmationSelection; decision: ConfirmationDecision } {
  if (
    key === "\u0003" ||
    key === "\u001b" ||
    key === "n" ||
    key === "N" ||
    key === "q" ||
    key === "Q"
  ) {
    return { selection: "cancel", decision: "cancel" };
  }
  if (key === "y" || key === "Y") {
    return { selection: "confirm", decision: "confirm" };
  }
  if (key === "\r" || key === "\n") {
    return { selection, decision: selection };
  }
  if (key === "\t" || key === "\u001b[Z") {
    return { selection: selection === "cancel" ? "confirm" : "cancel", decision: null };
  }
  if (key === "\u001b[D" || key === "h") {
    return { selection: "cancel", decision: null };
  }
  if (key === "\u001b[C" || key === "l") {
    return { selection: "confirm", decision: null };
  }
  return { selection, decision: null };
}

export interface ConfirmationTerminal {
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
  write(text: string): void;
  setRawMode(enabled: boolean): void;
  readKey(): Promise<string | null>;
}

const CLEAR = "\u001b[2J\u001b[H";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const REVERSE = "\u001b[7m";

function visibleLength(value: string): number {
  return [...value].length;
}

function centered(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, Math.floor((width - visibleLength(value)) / 2)))}${value}`;
}

function wrap(value: string, width: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") {
      line = word;
    } else if (visibleLength(`${line} ${word}`) <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

export function renderConfirmation(
  confirmation: Pick<Confirmation, "title" | "message" | "confirmLabel">,
  selection: ConfirmationSelection,
  columns: number,
  rows: number,
): string {
  const width = Math.max(20, columns);
  const contentWidth = Math.max(12, width - 4);
  const messageLines =
    confirmation.message === null ? [] : wrap(confirmation.message, contentWidth);
  const cancel = selection === "cancel" ? `${REVERSE} Cancel ${RESET}` : " Cancel ";
  const approveText = ` ${confirmation.confirmLabel} `;
  const approve = selection === "confirm" ? `${REVERSE}${approveText}${RESET}` : approveText;
  const buttons = `[${cancel}]  [${approve}]`;
  const plainButtons = `[ Cancel ]  [${approveText}]`;
  const body = [
    `${BOLD}${centered(confirmation.title, width)}${RESET}`,
    "",
    ...messageLines.map((line) => centered(line, width)),
    ...(messageLines.length > 0 ? [""] : []),
    `${" ".repeat(Math.max(0, Math.floor((width - visibleLength(plainButtons)) / 2)))}${buttons}`,
    "",
    centered("Enter selects · Esc cancels", width),
  ];
  const top = Math.max(0, Math.floor((rows - body.length) / 2));
  return `${CLEAR}${"\n".repeat(top)}${body.join("\n")}`;
}

export async function askForConfirmation(
  confirmation: Pick<Confirmation, "title" | "message" | "confirmLabel">,
  terminal: ConfirmationTerminal,
): Promise<boolean> {
  if (!terminal.isTTY) {
    throw new CliError(
      "confirmation_requires_tty",
      "confirmation requires an interactive terminal; command not run",
    );
  }

  let selection: ConfirmationSelection = "cancel";
  terminal.setRawMode(true);
  try {
    terminal.write(HIDE_CURSOR);
    while (true) {
      terminal.write(renderConfirmation(confirmation, selection, terminal.columns, terminal.rows));
      const key = await terminal.readKey();
      if (key === null) return false;
      const next = interpretConfirmationKey(key, selection);
      selection = next.selection;
      if (next.decision !== null) return next.decision === "confirm";
    }
  } finally {
    terminal.write(`${RESET}${SHOW_CURSOR}${CLEAR}`);
    terminal.setRawMode(false);
  }
}

export type CommandRunner = (command: [string, ...string[]]) => Promise<number>;

export async function runConfirmation(
  argv: string[],
  terminal: ConfirmationTerminal,
  runCommand: CommandRunner,
): Promise<number> {
  const confirmation = parseConfirmation(argv);
  if (!(await askForConfirmation(confirmation, terminal))) return 0;
  const code = await runCommand(confirmation.command);
  if (code !== 0) await acknowledgeFailure(code, terminal);
  return code;
}

async function acknowledgeFailure(code: number, terminal: ConfirmationTerminal): Promise<void> {
  if (!terminal.isTTY) return;
  terminal.setRawMode(true);
  terminal.write(`\ncommand failed with exit ${code}; press any key to close${HIDE_CURSOR}`);
  try {
    await terminal.readKey();
  } finally {
    terminal.write(`${RESET}${SHOW_CURSOR}`);
    terminal.setRawMode(false);
  }
}

export function processTerminal(): ConfirmationTerminal {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    get columns() {
      return process.stdout.columns ?? 60;
    },
    get rows() {
      return process.stdout.rows ?? 12;
    },
    write(text: string): void {
      process.stdout.write(text);
    },
    setRawMode(enabled: boolean): void {
      process.stdin.setRawMode(enabled);
      if (enabled) process.stdin.resume();
      else process.stdin.pause();
    },
    readKey(): Promise<string | null> {
      return new Promise((resolve) => {
        const onData = (chunk: Buffer): void => {
          cleanup();
          resolve(chunk.toString("utf8"));
        };
        const onEnd = (): void => {
          cleanup();
          resolve(null);
        };
        const cleanup = (): void => {
          process.stdin.off("data", onData);
          process.stdin.off("end", onEnd);
        };
        process.stdin.once("data", onData);
        process.stdin.once("end", onEnd);
      });
    },
  };
}

export async function spawnConfirmedCommand(command: [string, ...string[]]): Promise<number> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(command, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
  } catch (error) {
    console.error(`error: confirmed command could not be run: ${(error as Error).message}`);
    return 127;
  }
  return await child.exited;
}
