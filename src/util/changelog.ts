/**
 * Parse packaged CHANGELOG.md for in-app "what's new" (forge news / /news).
 * Best-effort — never throws for missing/malformed files.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getForgeVersion } from "./version.js";

export interface ChangelogRelease {
  version: string;
  title: string;
  /** Full section body (markdown bullets). */
  body: string;
}

function changelogCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/util → ../..  or  dist/util → ../..
  const root = path.resolve(here, "../..");
  return [
    path.join(root, "CHANGELOG.md"),
    // Some installs nest package under node_modules/forge-agent
    path.join(root, "forge-agent", "CHANGELOG.md"),
  ];
}

/** Resolve path to packaged CHANGELOG.md (or null). */
export function findChangelogPath(): string | null {
  for (const p of changelogCandidates()) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* */
    }
  }
  return null;
}

/**
 * Parse `## x.y.z — title` sections from CHANGELOG markdown.
 * Stops at the next `## ` heading.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const lines = (markdown || "").split(/\r?\n/);
  const releases: ChangelogRelease[] = [];
  let cur: { version: string; title: string; body: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    releases.push({ version: cur.version, title: cur.title, body });
    cur = null;
  };

  for (const line of lines) {
    // Unreleased first (experts need in-flight notes before the next tag)
    const unrel = line.match(/^##\s+Unreleased\s*(?:[—–-]\s*(.*))?$/i);
    if (unrel) {
      flush();
      cur = {
        version: "Unreleased",
        title: (unrel[1] || "in development").trim(),
        body: [],
      };
      continue;
    }
    const m = line.match(/^##\s+(\d+\.\d+\.\d+)\s*(?:[—–-]\s*(.*))?$/);
    if (m) {
      flush();
      cur = {
        version: m[1],
        title: (m[2] || "").trim(),
        body: [],
      };
      continue;
    }
    if (cur) {
      // Nested ## under a release is rare; treat as body unless it looks like a version header
      if (/^##\s+(\d+\.\d+\.\d+|Unreleased)\b/i.test(line)) {
        flush();
        const u2 = line.match(/^##\s+Unreleased\s*(?:[—–-]\s*(.*))?$/i);
        if (u2) {
          cur = {
            version: "Unreleased",
            title: (u2[1] || "in development").trim(),
            body: [],
          };
          continue;
        }
        const m2 = line.match(/^##\s+(\d+\.\d+\.\d+)\s*(?:[—–-]\s*(.*))?$/);
        if (m2) {
          cur = {
            version: m2[1],
            title: (m2[2] || "").trim(),
            body: [],
          };
        }
        continue;
      }
      cur.body.push(line);
    }
  }
  flush();
  return releases;
}

export function loadChangelogReleases(): ChangelogRelease[] {
  const p = findChangelogPath();
  if (!p) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    return parseChangelog(raw);
  } catch {
    return [];
  }
}

/**
 * Format a compact "what's new" block for CLI / REPL.
 * @param count how many recent releases (default 1 = current highlights)
 * @param maxBullets max bullet lines per release (default 12)
 */
export function formatWhatsNew(opts?: {
  count?: number;
  maxBullets?: number;
  version?: string;
}): string {
  const count = Math.max(1, Math.min(10, opts?.count ?? 1));
  const maxBullets = Math.max(3, Math.min(40, opts?.maxBullets ?? 12));
  const version = opts?.version || getForgeVersion();
  const releases = loadChangelogReleases();

  if (releases.length === 0) {
    return [
      `Forge ${version}`,
      `No CHANGELOG.md found in this install.`,
      `See https://github.com/X0x888/forge-agent/blob/main/CHANGELOG.md`,
    ].join("\n");
  }

  // When Unreleased is present, default count=1 still shows the latest tagged
  // release too so experts see both in-flight work and the last ship.
  let sliceCount = count;
  if (
    count === 1 &&
    releases[0]?.version === "Unreleased" &&
    releases.some((r) => r.version !== "Unreleased")
  ) {
    sliceCount = 2;
  }
  const slice = releases.slice(0, sliceCount);
  const lines: string[] = [
    `Forge ${version} — what's new`,
  ];

  for (const r of slice) {
    const head = r.title ? `${r.version} — ${r.title}` : r.version;
    lines.push(``);
    lines.push(`## ${head}`);
    const rawLines = r.body
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => {
        const t = l.trim();
        if (!t) return false;
        // Keep bullets and short subheads; drop huge code fences
        if (t.startsWith("```")) return false;
        return t.startsWith("-") || t.startsWith("*") || t.startsWith("###");
      });
    // Drop ### heads that have no bullets before the next head / end
    const dropEmptyHeads = (rows: string[]): string[] => {
      const out: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const t = rows[i].trim();
        if (t.startsWith("###")) {
          let hasBullet = false;
          for (let j = i + 1; j < rows.length; j++) {
            const n = rows[j].trim();
            if (n.startsWith("###")) break;
            if (n.startsWith("-") || n.startsWith("*")) {
              hasBullet = true;
              break;
            }
          }
          if (!hasBullet) continue;
        }
        out.push(rows[i]);
      }
      return out;
    };
    // Prefer *newest* bullets from the first ### section (active development).
    // Convention: prepend new bullets at the top of the active ### section so
    // head-slice shows recent work. (Tail-slice hid prepended work and could
    // surface duplicate/stale bullets at the bottom of a long section.)
    // Still scope to the first ### only — never jump to Recovery/Docs later.
    const allClean = dropEmptyHeads(rawLines);
    const pickNewestFromActiveSection = (rows: string[], budget: number): string[] => {
      if (rows.length <= budget) return rows;
      // Find first ### that has bullets (active section).
      let headIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].trim().startsWith("###")) {
          // Does it have a bullet before the next head?
          let has = false;
          for (let j = i + 1; j < rows.length; j++) {
            const n = rows[j].trim();
            if (n.startsWith("###")) break;
            if (n.startsWith("-") || n.startsWith("*")) {
              has = true;
              break;
            }
          }
          if (has) {
            headIdx = i;
            break;
          }
        }
      }
      if (headIdx < 0) {
        // No section heads — take leading bullets (newest-first body).
        return rows.slice(0, budget);
      }
      let nextHead = rows.length;
      for (let i = headIdx + 1; i < rows.length; i++) {
        if (rows[i].trim().startsWith("###")) {
          nextHead = i;
          break;
        }
      }
      const head = rows[headIdx];
      const sectionBullets = rows
        .slice(headIdx + 1, nextHead)
        .filter((l) => {
          const t = l.trim();
          return t.startsWith("-") || t.startsWith("*");
        });
      // Leave room for the ### head line in the display budget.
      const bulletBudget = Math.max(1, budget - 1);
      const newest = sectionBullets.slice(0, bulletBudget);
      return [head, ...newest];
    };
    const cleaned = dropEmptyHeads(
      pickNewestFromActiveSection(allClean, maxBullets),
    );
    if (cleaned.length === 0) {
      // Fallback: leading non-empty lines (newest-first convention)
      const plain = r.body
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, maxBullets);
      lines.push(...plain.map((l) => (l.startsWith("-") ? l : `  ${l}`)));
    } else {
      for (const b of cleaned) {
        if (b.trim().startsWith("###")) {
          lines.push(b.trim());
        } else {
          lines.push(b);
        }
      }
      const totalBullets = rawLines.filter((l) => /^\s*[-*]/.test(l)).length;
      const shownBullets = cleaned.filter((l) => /^\s*[-*]/.test(l)).length;
      if (totalBullets > shownBullets) {
        lines.push(`  … +${totalBullets - shownBullets} more in CHANGELOG.md`);
      }
    }
  }

  if (releases.length > sliceCount) {
    lines.push(``);
    lines.push(
      `Older: forge news ${Math.min(releases.length, sliceCount + 2)}  ·  full: CHANGELOG.md`,
    );
  } else {
    lines.push(``);
    lines.push(`Tip: /plan · /build · /retry · /last · /share · forge tips`);
  }
  return lines.join("\n");
}
