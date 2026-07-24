/**
 * Path-not-found enrichment (Grok/OpenCode pattern).
 */
import fsp from "node:fs/promises";
import path from "node:path";

const MAX_SIMILAR = 3;
const MIN_LEAF = 2;

export async function pathNotFoundHint(
  missingPath: string,
  workspace: string,
): Promise<string> {
  const leaf = path.basename(missingPath);
  const parent = path.dirname(missingPath);
  const parts: string[] = [];

  if (leaf.length >= MIN_LEAF) {
    try {
      const entries = await fsp.readdir(parent);
      const lower = leaf.toLowerCase();
      const similar = entries
        .filter((e) => {
          const el = e.toLowerCase();
          return el.includes(lower) || lower.includes(el);
        })
        .slice(0, MAX_SIMILAR);
      if (similar.length) {
        parts.push(`Did you mean one of these?\n${similar.map((s) => `  ${path.join(parent, s)}`).join("\n")}`);
      }
    } catch {
      /* parent missing */
    }
  }

  parts.push(`Note: workspace root is ${workspace}`);
  return parts.join("\n");
}
