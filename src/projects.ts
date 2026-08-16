import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandTilde, tildePath } from "./paths.ts";

/** A directory one level under a configured root. */
export interface ProjectChoice {
  path: string;
  display: string;
  count: number;
}

/** Scan each root one level deep. An absent root is a configuration written
 * for another machine, not a fault: it contributes nothing. */
export function scanProjects(roots: readonly string[], home: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const base = expandTilde(root, home);
    let entries: Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".")) continue;
      const path = join(base, name);
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(path).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (!isDirectory || seen.has(path)) continue;
      seen.add(path);
      found.push(path);
    }
  }
  return found;
}

/** Most-launched first, alphabetical on ties — which is also the cold-start
 * order, when nothing has been launched yet. */
export function orderProjects(
  paths: readonly string[],
  counts: ReadonlyMap<string, number>,
  home: string,
): ProjectChoice[] {
  return paths
    .map((path) => ({ path, display: tildePath(path, home), count: counts.get(path) ?? 0 }))
    .sort((a, b) => b.count - a.count || (a.display < b.display ? -1 : 1));
}
