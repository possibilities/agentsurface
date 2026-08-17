/**
 * Pure text transforms between a transcript's first user prompt and the
 * excerpt handed to metadata inference. Everything here is decidable
 * without a filesystem or a terminal: file mentions read through an
 * injected reader, so tests reach every branch.
 */

/** Character budget for the inference excerpt. Center truncation keeps the
 * head (where the ask usually is) and the tail (where constraints land). */
export const EXCERPT_BUDGET = 1_600;
const HEAD_SHARE = 0.6;
const TRUNCATION_MARK = "\n…\n";

/** Cap on any single file read into the excerpt via an @-mention; the
 * excerpt budget re-truncates the whole afterwards anyway. */
export const MENTION_FILE_CAP = 32 * 1024;

/** Max slug length after normalization — keeper's rename contract. */
export const SLUG_MAX_LENGTH = 64;

/**
 * A prompt that begins as a slash command names a workflow, not subject
 * matter: drop the command token and its --flag tokens, and slug what the
 * command was given. Claude records slash commands as a command wrapper
 * (`<command-name>…<command-args>`); other harnesses keep the typed line.
 * A command given nothing keeps its own name — a list entry reading
 * "reload-plugins" beats an empty one.
 */
export function stripSlashCommand(text: string): string {
  const wrapper = /<command-name>\s*\/?([^<]*?)\s*<\/command-name>/.exec(text);
  if (wrapper !== null) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    const rest = stripFlagTokens(args?.[1] ?? "");
    return rest !== "" ? rest : (wrapper[1] ?? "").trim();
  }
  const command = /^\s*\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (command === null) return text.trim();
  const rest = stripFlagTokens(command[2] ?? "");
  return rest !== "" ? rest : (command[1] ?? "");
}

function stripFlagTokens(text: string): string {
  return text
    .replace(/(^|\s)--[A-Za-z0-9][\w-]*(=\S*)?(?=\s|$)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** True when the prompt is a slash command with nothing substantive after
 * flag stripping — housekeeping (`/model`, a bare `/reload-plugins`), not
 * subject matter. Extraction skips these unless nothing better follows. */
export function isCommandOnly(text: string): boolean {
  const wrapper = /<command-name>[^<]*<\/command-name>/.test(text);
  if (wrapper) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    return stripFlagTokens(args?.[1] ?? "") === "";
  }
  const command = /^\s*\/\S+\s*([\s\S]*)$/.exec(text);
  return command !== null && stripFlagTokens(command[1] ?? "") === "";
}

/**
 * Replace each valid @-prefixed path with the file it names, so the slug
 * reflects what the prompt was about rather than where it pointed. The
 * reader returns null for anything unreadable — the mention then stays as
 * typed. Relative mentions resolve against the transcript's recorded cwd,
 * which the caller bakes into the reader.
 */
export function expandFileMentions(
  text: string,
  readMention: (path: string) => string | null,
): string {
  return text.replace(/(^|\s)@([A-Za-z0-9._~/-]+)/g, (whole, lead: string, path: string) => {
    const content = readMention(path);
    return content === null ? whole : `${lead}${content}`;
  });
}

/** Bound the excerpt by cutting the middle: head and tail survive, marked. */
export function centerTruncate(text: string, budget: number = EXCERPT_BUDGET): string {
  if (text.length <= budget) return text;
  const keep = budget - TRUNCATION_MARK.length;
  const head = Math.ceil(keep * HEAD_SHARE);
  return text.slice(0, head) + TRUNCATION_MARK + text.slice(text.length - (keep - head));
}

/** The metadata completion's instruction — keeper's `/rename` prompt (its
 * Claude-derived form), pointed at the conversation's first prompt. */
export function buildInstruction(excerpt: string): string {
  return (
    "Generate a short session title (3-6 words) summarizing the work requested " +
    "in the conversation-opening prompt below. Prioritize the user's requests, " +
    "goals, and repeated themes over implementation detail. Respond with ONLY " +
    `the title text: no punctuation, no quotes, no preamble.\n\n<prompt>\n${excerpt}\n</prompt>`
  );
}

/**
 * Strip ASCII control characters and Unicode bidi formatting/override
 * characters from raw model output BEFORE slugging — defense in depth
 * alongside slugify's own ASCII-only filter, so an accepted slug can never
 * carry an embedded control sequence toward a tab label.
 */
export function stripUnsafeText(text: string): string {
  return text
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate ASCII control strip.
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      " ",
    )
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** Normalize free text to a `[a-z0-9-]+` slug, or null when nothing
 * survives — keeper's rename normalization, byte for byte. */
export function slugify(text: string): string | null {
  let s = String(text).normalize("NFKD");
  s = s.replace(/\p{M}/gu, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII-only gate.
  s = s.replace(/[^\x00-\x7F]/g, "");
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  if (s.length > SLUG_MAX_LENGTH) {
    s = s.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, "");
  }
  return s === "" ? null : s;
}
