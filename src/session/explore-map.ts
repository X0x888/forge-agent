/**
 * Structured explore-map: pick + citations, not a 17k essay.
 * Parent read_file of a mapped path is a dereference unless offset/limit.
 */
import type { SessionMeta } from "./session.js";

export interface ExploreMapFile {
  path: string;
  line: number | null;
  claim: string;
}

export interface ExploreMap {
  pick: string;
  passedOn: string;
  /** Optional: a capability the product lacks that no hole-fix delivers. */
  bet?: string;
  files: ExploreMapFile[];
  childSessionId?: string;
  at: string;
}

const MAX_MAPS = 6;
const MAX_FILES = 40;

function field(text: string, names: string[]): string {
  for (const name of names) {
    const re = new RegExp(
      `(?:^|\\n)[ \\t]*${name}[ \\t]*:[ \\t]*([^\\n]*)`,
      "i",
    );
    const m = text.match(re);
    if (m?.[1]) return m[1].trim().replace(/\s+/g, " ").slice(0, 400);
  }
  return "";
}

function parseFileLine(line: string): ExploreMapFile | null {
  const t = line.trim().replace(/^[-*]\s+/, "").replace(/^`|`$/g, "");
  if (!t) return null;
  const m = t.match(
    /^`?([^\s:`]+?\.[A-Za-z0-9]+)`?(?::(\d+)(?:-\d+)?)?\s*[-—:]?\s*(.*)$/,
  );
  if (!m) return null;
  const claim = (m[3] || "").trim();
  if (!claim && !m[2]) return null;
  return {
    path: m[1]!,
    line: m[2] ? Number(m[2]) : null,
    claim: claim.slice(0, 240),
  };
}

export function parseExploreMap(text: string): ExploreMap | null {
  const raw = String(text || "");
  const pick = field(raw, ["pick"]);
  const passedOn = field(raw, ["passed_on", "passed-on", "passed on"]);
  const bet = field(raw, ["bet"]);
  const files: ExploreMapFile[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const f = parseFileLine(line);
    if (!f) continue;
    const key = f.path.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(f);
    if (files.length >= MAX_FILES) break;
  }
  // A file list without a pick is an essay, not a map — maze_plus stored
  // four of these and never seeded a hold list.
  if (!pick.trim()) return null;
  return {
    pick,
    passedOn,
    ...(bet && !/^none\b/i.test(bet) ? { bet } : {}),
    files,
    at: new Date().toISOString(),
  };
}

export function formatExploreMap(map: ExploreMap): string {
  const lines = [
    map.pick ? `pick: ${map.pick}` : "",
    map.passedOn ? `passed_on: ${map.passedOn}` : "",
    map.bet ? `bet: ${map.bet}` : "",
    map.files.length ? "files:" : "",
    ...map.files.map(
      (f) =>
        `  ${f.path}${f.line != null ? `:${f.line}` : ""}  ${f.claim}`.trimEnd(),
    ),
  ];
  return lines.filter(Boolean).join("\n");
}

export function pathsMatch(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const nb = b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (na === nb) return true;
  return na.endsWith("/" + nb) || nb.endsWith("/" + na);
}

export function normalizeExploreMaps(raw: unknown): ExploreMap[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ExploreMap[] = [];
  for (const item of raw.slice(-MAX_MAPS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const files: ExploreMapFile[] = [];
    const seen = new Set<string>();
    if (Array.isArray(o.files)) {
      for (const f of o.files) {
        if (!f || typeof f !== "object" || Array.isArray(f)) continue;
        const ff = f as Record<string, unknown>;
        const path = typeof ff.path === "string" ? ff.path.trim() : "";
        if (!path) continue;
        const key = path.replace(/\\/g, "/").toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const line = Number(ff.line);
        files.push({
          path: path.slice(0, 400),
          line: Number.isFinite(line) && line >= 1 ? Math.floor(line) : null,
          claim: typeof ff.claim === "string" ? ff.claim.slice(0, 240) : "",
        });
        if (files.length >= MAX_FILES) break;
      }
    }
    const pick = typeof o.pick === "string" ? o.pick.trim().slice(0, 400) : "";
    const passedOn =
      typeof o.passedOn === "string" ? o.passedOn.trim().slice(0, 400) : "";
    const bet = typeof o.bet === "string" ? o.bet.trim().slice(0, 400) : "";
    if (!pick) continue;
    out.push({
      pick,
      passedOn,
      ...(bet ? { bet } : {}),
      files,
      ...(typeof o.childSessionId === "string" && o.childSessionId.trim()
        ? { childSessionId: o.childSessionId.trim().slice(0, 80) }
        : {}),
      at: typeof o.at === "string" ? o.at : "",
    });
  }
  return out.length ? out : undefined;
}

export function rememberExploreMap(
  meta: SessionMeta,
  map: ExploreMap,
): void {
  const prev = [...(meta.exploreMaps ?? [])];
  prev.push(map);
  meta.exploreMaps = prev.slice(-MAX_MAPS);
}

export function lookupExploreMapFile(
  meta: SessionMeta | undefined,
  path: string,
): { file: ExploreMapFile; map: ExploreMap } | null {
  if (!meta?.exploreMaps?.length || !path) return null;
  for (let i = meta.exploreMaps.length - 1; i >= 0; i--) {
    const map = meta.exploreMaps[i]!;
    const hit = map.files.find((f) => pathsMatch(f.path, path));
    if (hit) return { file: hit, map };
  }
  return null;
}

/** Lines either side of a cited map line when parent reads without a window. */
export const EXPLORE_MAP_WINDOW_PAD = 40;

export function exploreMapWindow(
  line: number,
  pad: number = EXPLORE_MAP_WINDOW_PAD,
): { offset: number; limit: number } {
  const n = Math.max(1, Math.floor(line));
  const p = Math.max(0, Math.floor(pad));
  return { offset: Math.max(1, n - p), limit: p * 2 + 1 };
}

export function formatExploreMapDeref(
  hit: { file: ExploreMapFile; map: ExploreMap },
  opts?: { autoWindow?: boolean },
): string {
  const loc =
    hit.file.line != null ? `${hit.file.path}:${hit.file.line}` : hit.file.path;
  const hint = opts?.autoWindow
    ? `Windowed ±${EXPLORE_MAP_WINDOW_PAD} around the cited line. Pass offset/limit to page.`
    : `Pass offset/limit to read the file body.`;
  return [
    `In explore map: ${loc}`,
    hit.file.claim ? `  ${hit.file.claim}` : "",
    hit.map.pick ? `Pick: ${hit.map.pick}` : "",
    hint,
  ]
    .filter(Boolean)
    .join("\n");
}

export function readHasExplicitWindow(args: Record<string, unknown>): boolean {
  return args.offset != null || args.limit != null;
}

/** Poke once, then stop — information-gain, not a turn cap. */
export const CITE_DELTA_POKE = "[Forge] Cite-delta is zero";

export function noteCiteDelta(
  seen: Set<string>,
  cited: string[],
  staleTurns: number,
): { grew: boolean; staleTurns: number } {
  let grew = false;
  for (const p of cited) {
    if (!seen.has(p)) {
      seen.add(p);
      grew = true;
    }
  }
  // Pathless grep/glob (cited=[]) is still a search — do not reset.
  // Only new paths reset the stale counter.
  if (grew) return { grew, staleTurns: 0 };
  return { grew, staleTurns: staleTurns + 1 };
}

export function citeDeltaShouldPoke(staleTurns: number): boolean {
  return staleTurns >= 2;
}

/**
 * Stop when the map is done (`pick:`) or the poke was ignored.
 * One tools-only turn after the first poke gets a report-only pick demand.
 * A second tools-only turn (`pickDemanded`) is ignore — stop.
 */
export function citeDeltaShouldStop(
  staleTurns: number,
  alreadyPoked: boolean,
  opts?: {
    hasPick?: boolean;
    lastWasToolsOnly?: boolean;
    pickDemanded?: boolean;
  },
): boolean {
  if (!alreadyPoked || staleTurns < 2) return false;
  if (opts?.hasPick) return true;
  if (opts?.pickDemanded) return true;
  if (opts?.lastWasToolsOnly) return false;
  return true;
}
