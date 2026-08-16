/** Domain failure: reported with its message and recovery, exit 1. */
export class CliError extends Error {
  readonly code: string;
  readonly recovery?: string;

  constructor(code: string, message: string, recovery?: string) {
    super(message);
    this.code = code;
    if (recovery !== undefined) this.recovery = recovery;
  }
}

/** Grammar fault: usage text on stderr, exit 2. */
export class UsageError extends Error {}
