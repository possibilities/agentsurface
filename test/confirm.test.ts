import { describe, expect, test } from "bun:test";
import {
  askForConfirmation,
  type ConfirmationTerminal,
  interpretConfirmationKey,
  parseConfirmation,
  renderConfirmation,
  runConfirmation,
} from "../src/confirm.ts";
import { CliError, UsageError } from "../src/errors.ts";

class FakeTerminal implements ConfirmationTerminal {
  readonly columns = 50;
  readonly rows = 10;
  readonly writes: string[] = [];
  readonly rawModes: boolean[] = [];
  readonly #keys: Array<string | null>;

  constructor(
    keys: Array<string | null>,
    readonly isTTY = true,
  ) {
    this.#keys = [...keys];
  }

  write(text: string): void {
    this.writes.push(text);
  }

  setRawMode(enabled: boolean): void {
    this.rawModes.push(enabled);
  }

  readKey(): Promise<string | null> {
    return Promise.resolve(this.#keys.shift() ?? null);
  }
}

const args = ["--title", "Close pane?", "--", "/path with spaces/herdr", "pane", "close", "w1:p2"];

describe("parseConfirmation", () => {
  test("preserves the command as exact argv", () => {
    expect(parseConfirmation(args)).toEqual({
      title: "Close pane?",
      command: ["/path with spaces/herdr", "pane", "close", "w1:p2"],
    });
  });

  test("rejects a missing question, separator, command, and unknown options", () => {
    for (const invalid of [
      ["--", "true"],
      ["--title", "Proceed?", "true"],
      ["--title", "Proceed?", "--"],
      ["--wat", "x", "--", "true"],
    ]) {
      expect(() => parseConfirmation(invalid)).toThrow(UsageError);
    }
  });
});

describe("confirmation interaction", () => {
  test("starts on Yes and Enter executes only the exact parsed argv", async () => {
    const terminal = new FakeTerminal(["\r"]);
    const commands: string[][] = [];
    const code = await runConfirmation(args, terminal, async (command) => {
      commands.push(command);
      return 0;
    });
    expect(code).toBe(0);
    expect(commands).toEqual([["/path with spaces/herdr", "pane", "close", "w1:p2"]]);
    expect(terminal.rawModes).toEqual([true, false]);
  });

  test("n cancels without invoking the command", async () => {
    const terminal = new FakeTerminal(["n"]);
    const commands: string[][] = [];
    const code = await runConfirmation(args, terminal, async (command) => {
      commands.push(command);
      return 0;
    });
    expect(code).toBe(0);
    expect(commands).toEqual([]);
  });

  test("navigation follows the displayed Yes / No order while escape always cancels", () => {
    expect(interpretConfirmationKey("y", "cancel").decision).toBe("confirm");
    expect(interpretConfirmationKey("n", "confirm").decision).toBe("cancel");
    expect(interpretConfirmationKey("\t", "confirm")).toEqual({
      selection: "cancel",
      decision: null,
    });
    expect(interpretConfirmationKey("\r", "confirm").decision).toBe("confirm");
    expect(interpretConfirmationKey("\u001b[D", "cancel").selection).toBe("confirm");
    expect(interpretConfirmationKey("\u001b[C", "confirm").selection).toBe("cancel");
    expect(interpretConfirmationKey("\u001b", "confirm")).toEqual({
      selection: "cancel",
      decision: "cancel",
    });
  });

  test("refuses without a tty before invoking the command", async () => {
    const terminal = new FakeTerminal([], false);
    let invoked = false;
    try {
      await runConfirmation(args, terminal, async () => {
        invoked = true;
        return 0;
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("confirmation_requires_tty");
    }
    expect(invoked).toBe(false);
  });

  test("propagates a command failure after holding it for acknowledgement", async () => {
    const terminal = new FakeTerminal(["y", " "]);
    expect(await runConfirmation(args, terminal, async () => 17)).toBe(17);
    expect(terminal.writes.join("")).toContain("command failed with exit 17");
    expect(terminal.rawModes).toEqual([true, false, true, false]);
  });

  test("EOF cancels and terminal state is restored", async () => {
    const terminal = new FakeTerminal([null]);
    expect(await askForConfirmation(parseConfirmation(args), terminal)).toBe(false);
    expect(terminal.rawModes).toEqual([true, false]);
  });

  test("renders the question above right-aligned Yes / No choices", () => {
    const rendered = renderConfirmation(parseConfirmation(args), "confirm", 22, 2);
    expect(rendered).toBe(
      "\u001b[2J\u001b[H Close pane?\n              \u001b[7m[Yes]\u001b[0m No",
    );
  });
});
