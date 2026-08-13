/**
 * Cross-session project memory.
 *
 * Session decisions.json dies with the session. Experts need durable notes that
 * survive /new, resume on a different session, and weekend gaps — without
 * re-steering the same constraints every time.
 *
 * Storage (both, best-effort):
 * - ~/.forge/project-memory/<key>.json  (authoritative machine store, mode 0600)
 * - <project>/.forge/MEMORY.md          (human-editable mirror; optional)
 *
 * Keyed by git root when available, else absolute workspace path.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ensureDir,
  forgeHome,
  nowIso,
  readJsonFile,
  writeJsonFile,
} from "../util/fs.js";
import { findGitRoot } from "../agent/worktree.js";

export type ProjectMemoryKind =
  | "constraint"
  | "decision"
  | "fact"
  | "out_of_scope"
  | "priority"
  | "blocker"
  | "observation"
  | "convention"
  | "gotcha";

export interface ProjectMemoryRecord {
  id: string;
  at: string;
  kind: ProjectMemoryKind;
  text: string;
  source: "agent" | "user" | "import";
  status: "active" | "archived";
}

export interface ProjectMemoryStore {
  version: 1;
  /** Stable project key (hash of root path). */
  key: string;
  /** Absolute project root used when last written. */
  root: string;
  records: ProjectMemoryRecord[];
  updatedAt: string;
}

const MAX_RECORDS = 200;
const MAX_TEXT = 600;
/** Prompt injection budget (chars). */
export const PROJECT_MEMORY_PROMPT_BUDGET = 2_000;

const KIND_SET = new Set<ProjectMemoryKind>([
  "constraint",
  "decision",
  "fact",
  "out_of_scope",
  "priority",
  "blocker",
  "observation",
  "convention",
  "gotcha",
]);

export function normalizeProjectMemoryKind(raw: unknown): ProjectMemoryKind {
  const k = String(raw ?? "fact")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (KIND_SET.has(k as ProjectMemoryKind)) return k as ProjectMemoryKind;
  // aliases
  if (k === "rule" || k === "pref" || k === "preference") return "convention";
  if (k === "warning" || k === "trap" || k === "landmine") return "gotcha";
  if (k === "note") return "observation";
  return "fact";
}

/** Resolve project root for memory scoping. */
export function resolveProjectMemoryRoot(workspace: string): string {
  const start = path.resolve(workspace || process.cwd());
  return findGitRoot(start) || start;
}

export function projectMemoryKey(root: string): string {
  const norm = path.resolve(root).replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export function projectMemoryJsonPath(root: string): string {
  const key = projectMemoryKey(root);
  return path.join(forgeHome(), "project-memory", `${key}.json`);
}

export function projectMemoryMarkdownPath(root: string): string {
  return path.join(path.resolve(root), ".forge", "MEMORY.md");
}

function emptyStore(root: string): ProjectMemoryStore {
  return {
    version: 1,
    key: projectMemoryKey(root),
    root: path.resolve(root),
    records: [],
    updatedAt: nowIso(),
  };
}

function makeId(): string {
  return `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadProjectMemory(workspace: string): ProjectMemoryStore {
  const root = resolveProjectMemoryRoot(workspace);
  const p = projectMemoryJsonPath(root);
  try {
    const raw = readJsonFile<ProjectMemoryStore | null>(p, null);
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.records)) {
      // Seed from markdown mirror if present
      const fromMd = importMarkdownMirror(root);
      if (fromMd.records.length) return fromMd;
      return emptyStore(root);
    }
    return {
      version: 1,
      key: typeof raw.key === "string" ? raw.key : projectMemoryKey(root),
      root: path.resolve(root),
      records: raw.records
        .filter((r) => r && typeof r === "object" && typeof (r as ProjectMemoryRecord).text === "string")
        .map((r) => normalizeRecord(r as ProjectMemoryRecord)),
      updatedAt:
        typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
    };
  } catch {
    return emptyStore(root);
  }
}

function normalizeRecord(r: ProjectMemoryRecord): ProjectMemoryRecord {
  return {
    id: String(r.id || makeId()),
    at: String(r.at || nowIso()),
    kind: normalizeProjectMemoryKind(r.kind),
    text: String(r.text || "")
      .trim()
      .slice(0, MAX_TEXT),
    source: (r.source === "user" || r.source === "import"
      ? r.source
      : "agent") as ProjectMemoryRecord["source"],
    status: r.status === "archived" ? "archived" : "active",
  };
}

function saveStore(store: ProjectMemoryStore): void {
  ensureDir(path.dirname(projectMemoryJsonPath(store.root)));
  store.updatedAt = nowIso();
  // Cap records (keep newest active first, then archived)
  if (store.records.length > MAX_RECORDS) {
    const active = store.records.filter((r) => r.status === "active");
    const archived = store.records.filter((r) => r.status !== "active");
    store.records = [...active.slice(-Math.floor(MAX_RECORDS * 0.85)), ...archived].slice(
      -MAX_RECORDS,
    );
  }
  writeJsonFile(projectMemoryJsonPath(store.root), store, 0o600);
  // Best-effort human mirror
  try {
    writeMarkdownMirror(store);
  } catch {
    /* */
  }
}

/** Active records, newest last (stable for prompt + status). */
export function listActiveProjectMemory(
  workspace: string,
): ProjectMemoryRecord[] {
  return loadProjectMemory(workspace).records.filter((r) => r.status === "active");
}

/**
 * Append a project memory record. Dedupes identical active text+kind.
 * Returns null when no-op.
 */
export function appendProjectMemory(
  workspace: string,
  opts: {
    text: string;
    kind?: ProjectMemoryKind | string;
    source?: ProjectMemoryRecord["source"];
  },
): ProjectMemoryRecord | null {
  const text = String(opts.text || "")
    .trim()
    .slice(0, MAX_TEXT);
  if (!text) return null;
  const kind = normalizeProjectMemoryKind(opts.kind);
  const root = resolveProjectMemoryRoot(workspace);
  const store = loadProjectMemory(workspace);
  const fp = `${kind}::${text.toLowerCase()}`;
  const exists = store.records.some(
    (r) =>
      r.status === "active" &&
      `${r.kind}::${r.text.toLowerCase()}` === fp,
  );
  if (exists) return null;
  const rec: ProjectMemoryRecord = {
    id: makeId(),
    at: nowIso(),
    kind,
    text,
    source: opts.source || "agent",
    status: "active",
  };
  store.records.push(rec);
  saveStore(store);
  return rec;
}

/** Archive (soft-delete) by id or exact text match. */
export function archiveProjectMemory(
  workspace: string,
  idOrText: string,
): number {
  const q = String(idOrText || "").trim();
  if (!q) return 0;
  const store = loadProjectMemory(workspace);
  let n = 0;
  for (const r of store.records) {
    if (r.status !== "active") continue;
    if (r.id === q || r.text === q || r.text.toLowerCase() === q.toLowerCase()) {
      r.status = "archived";
      n++;
    }
  }
  if (n) saveStore(store);
  return n;
}

/** Format for system-prompt / compact injection. */
export function formatProjectMemoryForPrompt(
  workspace: string,
  budget = PROJECT_MEMORY_PROMPT_BUDGET,
): string {
  const recs = listActiveProjectMemory(workspace);
  if (!recs.length) return "";
  // Priority order for injection when over budget
  const rank: Record<string, number> = {
    constraint: 0,
    priority: 1,
    decision: 2,
    gotcha: 3,
    convention: 4,
    out_of_scope: 5,
    blocker: 6,
    fact: 7,
    observation: 8,
  };
  const sorted = [...recs].sort(
    (a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.at.localeCompare(b.at),
  );
  const lines: string[] = [
    "## Project memory (cross-session — honor unless superseded)",
  ];
  let used = lines.join("\n").length;
  for (const r of sorted) {
    const line = `- [${r.kind}] ${r.text}`;
    if (used + line.length + 1 > budget) {
      lines.push(`- … (+more in .forge/MEMORY.md · /memory project)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

export function formatProjectMemoryStatus(workspace: string): string {
  const store = loadProjectMemory(workspace);
  const active = store.records.filter((r) => r.status === "active");
  const lines = [
    `Project memory: ${active.length} active · key=${store.key}`,
    `  root: ${store.root}`,
    `  store: ${projectMemoryJsonPath(store.root)}`,
    `  mirror: ${projectMemoryMarkdownPath(store.root)}`,
  ];
  for (const r of active.slice(-12)) {
    lines.push(`  - [${r.kind}] ${r.text}`);
  }
  if (active.length > 12) {
    lines.push(`  … +${active.length - 12} more`);
  }
  lines.push(
    "  /memory project add <text>  ·  memory_write scope=project  ·  /memory project clear",
  );
  return lines.join("\n");
}

/**
 * Ignore the volatile `key=… · updated=…` line so a no-op save (JSON
 * re-import, identical append dedupe path that still called saveStore)
 * does not dirty a tracked `.forge/MEMORY.md`.
 */
export function stableProjectMemoryMarkdown(text: string): string {
  return String(text || "")
    .replace(/^> key=.*$/gm, "")
    .replace(/\s+$/g, "")
    .trim();
}

function writeMarkdownMirror(store: ProjectMemoryStore): void {
  const mdPath = projectMemoryMarkdownPath(store.root);
  ensureDir(path.dirname(mdPath));
  const active = store.records.filter((r) => r.status === "active");
  const body = [
    `# Project memory`,
    ``,
    `> Auto-maintained by Forge. Edit carefully — agent loads this across sessions.`,
    `> key=${store.key} · updated=${store.updatedAt}`,
    ``,
  ];
  const byKind = new Map<string, ProjectMemoryRecord[]>();
  for (const r of active) {
    const list = byKind.get(r.kind) || [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  const order: ProjectMemoryKind[] = [
    "constraint",
    "priority",
    "decision",
    "gotcha",
    "convention",
    "out_of_scope",
    "blocker",
    "fact",
    "observation",
  ];
  for (const kind of order) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    body.push(`## ${kind}`, ``);
    for (const r of list) {
      body.push(`- ${r.text}`);
    }
    body.push(``);
  }
  const next = body.join("\n");
  try {
    if (fs.existsSync(mdPath)) {
      const prev = fs.readFileSync(mdPath, "utf8");
      if (stableProjectMemoryMarkdown(prev) === stableProjectMemoryMarkdown(next)) {
        return;
      }
    }
  } catch {
    /* write anyway */
  }
  // Repo-tracked human mirror — not a secret store (JSON under ~/.forge is 0600).
  fs.writeFileSync(mdPath, next, { encoding: "utf8", mode: 0o644 });
}

/** Import active bullets from .forge/MEMORY.md when JSON is empty/missing. */
function importMarkdownMirror(root: string): ProjectMemoryStore {
  const store = emptyStore(root);
  const mdPath = projectMemoryMarkdownPath(root);
  try {
    if (!fs.existsSync(mdPath)) return store;
    const txt = fs.readFileSync(mdPath, "utf8");
    let kind: ProjectMemoryKind = "fact";
    for (const line of txt.split("\n")) {
      const h = line.match(/^##\s+(\w[\w-]*)\s*$/);
      if (h) {
        kind = normalizeProjectMemoryKind(h[1]);
        continue;
      }
      const b = line.match(/^\s*-\s+(.+)\s*$/);
      if (b) {
        const text = b[1].trim().slice(0, MAX_TEXT);
        if (!text || text.startsWith("Auto-maintained")) continue;
        store.records.push({
          id: makeId(),
          at: nowIso(),
          kind,
          text,
          source: "import",
          status: "active",
        });
      }
    }
    if (store.records.length) {
      // Persist imported mirror into JSON so subsequent loads are fast
      saveStore(store);
    }
  } catch {
    /* */
  }
  return store;
}

/** Clear all active project memory (archives everything). */
export function clearProjectMemory(workspace: string): number {
  const store = loadProjectMemory(workspace);
  let n = 0;
  for (const r of store.records) {
    if (r.status === "active") {
      r.status = "archived";
      n++;
    }
  }
  if (n) saveStore(store);
  return n;
}
