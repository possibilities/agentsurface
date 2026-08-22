import { CliError, UsageError } from "./errors.ts";

export const CONFIRM_USAGE = "confirm --title <text> -- <command> [args…]";

export interface Confirmation {
  title: string;
  command: [string, ...string[]];
}

export function parseConfirmation(argv: string[]): Confirmation {
  let title: string | undefined;
  let index = 0;

  while (index < argv.length && argv[index] !== "--") {
    const option = argv[index];
    const value = argv[index + 1];
    if (option !== "--title") {
      throw new UsageError(`unknown confirm option "${option ?? ""}"`);
    }
    if (value === undefined || value === "" || value === "--") {
      throw new UsageError(`${option} takes a non-empty value`);
    }
    title = value;
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
    return { selection: "confirm", decision: null };
  }
  if (key === "\u001b[C" || key === "l") {
    return { selection: "cancel", decision: null };
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
const REVERSE = "\u001b[7m";

function visibleLength(value: string): number {
  return [...value].length;
}

export function renderConfirmation(
  confirmation: Pick<Confirmation, "title">,
  selection: ConfirmationSelection,
  columns: number,
  rows: number,
): string {
  const yes = selection === "confirm" ? `${REVERSE}[Yes]${RESET}` : "Yes";
  const no = selection === "cancel" ? `${REVERSE}[No]${RESET}` : "No";
  const plainChoices = selection === "confirm" ? "[Yes] No" : "Yes [No]";
  const choices = `${yes} ${no}`;
  const choicesLeft = Math.max(0, columns - visibleLength(plainChoices));
  const top = Math.max(0, Math.floor((rows - 2) / 2));
  return `${CLEAR}${"\n".repeat(top)} ${confirmation.title}\n${" ".repeat(choicesLeft)}${choices}`;
}

export async function askForConfirmation(
  confirmation: Pick<Confirmation, "title">,
  terminal: ConfirmationTerminal,
): Promise<boolean> {
  if (!terminal.isTTY) {
    throw new CliError(
      "confirmation_requires_tty",
      "confirmation requires an interactive terminal; command not run",
    );
  }

  let selection: ConfirmationSelection = "confirm";
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
