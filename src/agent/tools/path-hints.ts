/**
 * Path-not-found enrichment (Grok/OpenCode pattern).
 * Suggests similar sibling names (substring + small edit distance for typos).
 * When the immediate parent is missing, walks up one level to suggest
 * similarly-named directories (e.g. `srcx/foo.ts` → `src/`).
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { editDistance } from "../../util/string-distance.js";

const MAX_SIMILAR = 3;
const MIN_LEAF = 2;
/** Max Levenshtein distance for typo suggestions (scaled for short names). */
const MAX_EDIT_DISTANCE = 3;

export { editDistance };

function isSimilarName(leaf: string, entry: string): boolean {
  const a = leaf.toLowerCase();
  const b = entry.toLowerCase();
  if (a === b) return true;
  if (b.includes(a) || a.includes(b)) return true;
  // Typo tolerance: allow small edit distance relative to name length
  const maxDist = Math.min(
    MAX_EDIT_DISTANCE,
    Math.max(1, Math.floor(Math.min(a.length, b.length) / 3)),
  );
  // Only compare when lengths are close (cheap reject)
  if (Math.abs(a.length - b.length) > maxDist) return false;
  return editDistance(a, b) <= maxDist;
}

async function similarEntries(
  parent: string,
  leaf: string,
): Promise<string[]> {
  if (leaf.length < MIN_LEAF) return [];
  try {
    const entries = await fsp.readdir(parent);
    return entries
      .filter((e) => isSimilarName(leaf, e))
      .map((e) => ({
        e,
        d: editDistance(leaf.toLowerCase(), e.toLowerCase()),
      }))
      .sort((x, y) => x.d - y.d || x.e.localeCompare(y.e))
      .slice(0, MAX_SIMILAR)
      .map((x) => x.e);
  } catch {
    return [];
  }
}

export async function pathNotFoundHint(
  missingPath: string,
  workspace: string,
): Promise<string> {
  const leaf = path.basename(missingPath);
  const parent = path.dirname(missingPath);
  const parts: string[] = [];

  const scored = await similarEntries(parent, leaf);
  if (scored.length) {
    parts.push(
      `Did you mean one of these?\n${scored
        .map((s) => `  ${path.join(parent, s)}`)
        .join("\n")}`,
    );
  } else {
    // Parent dir missing — walk up and suggest similar directory names.
    // e.g. `srcx/system-prompt.ts` → Did you mean `src/`?
    const grand = path.dirname(parent);
    const parentLeaf = path.basename(parent);
    if (
      parentLeaf &&
      parentLeaf !== "." &&
      parentLeaf !== path.sep &&
      grand !== parent
    ) {
      const dirHits = await similarEntries(grand, parentLeaf);
      if (dirHits.length) {
        parts.push(
          `Did you mean one of these?\n${dirHits
            .map((s) => `  ${path.join(grand, s)}${path.sep}`)
            .join("\n")}`,
        );
      }
    }
  }

  parts.push(`Note: workspace root is ${workspace}`);
  return parts.join("\n");
}
