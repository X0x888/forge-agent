/**
 * One ship-close grammar for wave stamps, ledger summaries, and
 * auto-commit subjects. Dogfood used Ship landed / Wave N ship /
 * Wave ship / **Ship:** / Wave shipped. — matchers used to disagree.
 */

const SHIP_LANDED_RE = /\*{0,2}Ship\s+landed:\*{0,2}/i;
const WAVE_SHIP_RE =
  /\*{0,2}Wave\s+(?:\d+\s+)?(?:LAST\s+)?(?:shipped|ship)\b\*{0,2}/i;
const BOLD_SHIP_RE = /\*\*Ship:\*\*/;
const LINE_SHIP_RE = /(?:^|\n)\s*Ship:\s+/m;

export function isShipCloseText(text: string): boolean {
  const t = text || "";
  if (!t.trim()) return false;
  return (
    SHIP_LANDED_RE.test(t) ||
    WAVE_SHIP_RE.test(t) ||
    BOLD_SHIP_RE.test(t) ||
    LINE_SHIP_RE.test(t)
  );
}

/** Agent closed a work unit in prose — that is a wave, not an idle heartbeat. */
export function isDeclaredWaveClose(message: string): boolean {
  const t = message || "";
  if (!t.trim()) return false;
  if (/\bCycle complete\b/i.test(t)) return true;
  if (/\bWave\s+\d+\s+LAST\b/i.test(t)) return true;
  return isShipCloseText(t);
}

function bodyAfter(marker: RegExp, t: string): string | undefined {
  const m = t.match(marker);
  if (!m || m.index == null) return undefined;
  const rest = t
    .slice(m.index + m[0].length)
    .replace(/^\s*[:.]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (rest.length < 10) return undefined;
  return rest.length <= 180 ? rest : rest.slice(0, 180);
}

/** Prefer a declared ship body over a reprinted Reading. */
export function extractShipSummary(text: string): string | undefined {
  const t = text || "";
  if (!t.trim()) return undefined;
  return (
    bodyAfter(SHIP_LANDED_RE, t) ||
    bodyAfter(WAVE_SHIP_RE, t) ||
    bodyAfter(BOLD_SHIP_RE, t) ||
    bodyAfter(LINE_SHIP_RE, t)
  );
}

export interface ShipHintRecord {
  at?: string;
  source?: string;
  text: string;
}

/**
 * Subject for the wave being closed. Prefer a ship written after the
 * previous wave; else the ledger row just stamped. Never fall back to
 * an older wave-1 Ship landed (Tab/resume freeze).
 */
export function pickShipHint(opts: {
  records?: ShipHintRecord[];
  prevWaveTs?: string;
  lastWaveSummary?: string;
}): string | undefined {
  const after = opts.prevWaveTs ?? "";
  const recs = opts.records ?? [];
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]!;
    if (r.source && r.source !== "agent") continue;
    if (!isShipCloseText(r.text)) continue;
    if (after && r.at && r.at <= after) continue;
    return r.text;
  }
  const ledger = (opts.lastWaveSummary || "").trim();
  if (ledger && (isShipCloseText(ledger) || extractShipSummary(ledger))) {
    return ledger;
  }
  return undefined;
}
