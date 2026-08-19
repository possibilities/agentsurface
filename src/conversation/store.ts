import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Environ, stateDirectory } from "../paths.ts";

/**
 * The slug store: every successfully computed conversation slug, persisted
 * one file per transcript. A slug costs model inference, so read-only
 * surfaces (the resume picker's `conversation describe`) must never have to
 * compute one — they show what naming already paid for, or nothing. Keyed
 * by the transcript file's basename, which every native store makes unique
 * (claude's uuid, codex's rollout name, pi's stamped name), so an id-or-path
 * caller and a path-only reader agree without resolving anything.
 */

export function slugStoreDirectory(env: Environ, home: string): string {
  return join(stateDirectory(env, home, "agentsurface"), "slugs");
}

function slugKey(transcriptPath: string): string {
  return basename(transcriptPath).replace(/\.jsonl(\.zst)?$/, "");
}

export function slugPath(env: Environ, home: string, transcriptPath: string): string {
  return join(slugStoreDirectory(env, home), slugKey(transcriptPath));
}

export function readStoredSlug(env: Environ, home: string, transcriptPath: string): string | null {
  try {
    const slug = readFileSync(slugPath(env, home, transcriptPath), "utf8").trim();
    return slug === "" ? null : slug;
  } catch {
    return null;
  }
}

/** Best-effort: a slug that cannot be stored still names its tab. */
export function storeSlug(env: Environ, home: string, transcriptPath: string, slug: string): void {
  try {
    mkdirSync(slugStoreDirectory(env, home), { recursive: true });
    writeFileSync(slugPath(env, home, transcriptPath), `${slug}\n`);
  } catch {
    // The store is a cache of paid work, not a ledger; losing one write
    // only means a future reader shows the excerpt alone.
  }
}
