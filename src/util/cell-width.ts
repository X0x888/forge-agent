/**
 * Terminal cell width: grapheme clusters × East Asian Width.
 *
 * One column model for the prompt editor, dock clip, markdown wrap, and
 * menus. JS `.length` is UTF-16 units and is the wrong measure for 你 / 👍.
 *
 * Ambiguous (A) width is 1 (xterm / iTerm / Ghostty default). Combining
 * marks, ZWJ and variation selectors are 0; a cluster is as wide as its
 * widest scalar (emoji presentation + VS-16 forces 2).
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const SGR_RE = /\x1b\[[0-9;]*m/g;

/** Strip SGR colour. Other CSI is left (width 0 via controls). */
export function stripSgr(text: string): string {
  return text.replace(SGR_RE, "");
}

export function graphemes(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const { segment } of graphemeSegmenter.segment(text)) out.push(segment);
  return out;
}

/**
 * Width of one Unicode scalar in terminal cells: 0, 1 or 2.
 * Tab is 1 (editor column, not tab-stops).
 */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (!Number.isFinite(cp) || cp < 0) return 0;
  if (cp === 0x09) return 1;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;

  // Variation selectors, ZWJ / ZWNJ / WJ / ZWSP / BOM
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060) return 0;
  if (cp === 0xfeff) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 0;

  // Combining marks (Mn / Me) — zero width; the base carries the cell.
  if (isCombiningMark(cp)) return 0;

  if (isWideCp(cp)) return 2;
  return 1;
}

function isCombiningMark(cp: number): boolean {
  // Unicode property — Node 20. Covers Mn/Mc/Me; Mc (spacing combining,
  // Devanagari) is typically width 0 in terminals when inside a cluster
  // because the cluster takes the base's width. Isolated Mc is rare in
  // Forge prompts; treating Mc as 0 matches wcwidth for Latin+accent.
  try {
    return /\p{M}/u.test(String.fromCodePoint(cp));
  } catch {
    return cp >= 0x0300 && cp <= 0x036f;
  }
}

/**
 * East Asian Wide / Fullwidth + emoji blocks. Ambiguous (Greek, some
 * symbols) stay 1 unless the cluster has VS-16 (handled in clusterWidth).
 */
function isWideCp(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1aff0 && cp <= 0x1b122) ||
    (cp >= 0x1b150 && cp <= 0x1b152) ||
    (cp >= 0x1b164 && cp <= 0x1b167) ||
    (cp >= 0x1b170 && cp <= 0x1b2fb) ||
    (cp >= 0x1f000 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa00 && cp <= 0x1faff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

const VS16 = 0xfe0f;
const REGIONAL_A = 0x1f1e6;
const REGIONAL_B = 0x1f1ff;

/** Width of one grapheme cluster in terminal cells. */
export function clusterWidth(g: string): number {
  if (!g) return 0;
  let wide = false;
  let emoji = false;
  let max = 0;
  for (const ch of g) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === VS16) emoji = true;
    if (cp >= REGIONAL_A && cp <= REGIONAL_B) emoji = true;
    const w = codePointWidth(cp);
    if (w === 2) wide = true;
    if (w > max) max = w;
  }
  if (emoji || wide) return 2;
  return max;
}

/** Display columns of `text` (SGR stripped). */
export function stringWidth(text: string): number {
  const plain = stripSgr(text);
  if (!plain) return 0;
  let w = 0;
  for (const { segment } of graphemeSegmenter.segment(plain)) {
    w += clusterWidth(segment);
  }
  return w;
}

/**
 * UTF-16 index of the first grapheme whose start column is >= `col`.
 * `col` is a display column into `text` (SGR not expected). Clamps to
 * [0, text.length]. Mid-cluster columns round to the cluster start so a
 * click on the right half of 你 still selects 你.
 */
export function indexFromColumns(text: string, col: number): number {
  const plain = stripSgr(text);
  if (col <= 0 || !plain) return 0;
  let acc = 0;
  let idx = 0;
  for (const { segment } of graphemeSegmenter.segment(plain)) {
    const w = clusterWidth(segment);
    if (col < acc + w) return idx;
    acc += w;
    idx += segment.length;
  }
  return plain.length;
}

/** Display columns of `text.slice(0, index)` (index is UTF-16). */
export function columnsBefore(text: string, index: number): number {
  const plain = stripSgr(text);
  const i = Math.max(0, Math.min(index, plain.length));
  if (i <= 0) return 0;
  return stringWidth(plain.slice(0, i));
}

/**
 * Prefix of `text` with display width <= `max`. Never splits a grapheme
 * or a wide cell. If `max` is 0, empty. If the first cluster is wider
 * than `max`, empty (no half 你).
 */
export function sliceByColumns(text: string, max: number): string {
  if (max <= 0 || !text) return "";
  const hasSgr = text.includes("\x1b[");
  if (!hasSgr) return slicePlainByColumns(text, max);
  // Keep SGR in the prefix; measure only visible clusters.
  let out = "";
  let vis = 0;
  const re = /(\x1b\[[0-9;]*m)|([^\x1b]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      out += m[1];
      continue;
    }
    const chunk = m[2]!;
    let acc = "";
    for (const { segment } of graphemeSegmenter.segment(chunk)) {
      const w = clusterWidth(segment);
      if (vis + w > max) {
        return closeIfOpened(out + acc);
      }
      acc += segment;
      vis += w;
    }
    out += acc;
  }
  return out;
}

function slicePlainByColumns(text: string, max: number): string {
  let vis = 0;
  let out = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const w = clusterWidth(segment);
    if (vis + w > max) break;
    out += segment;
    vis += w;
  }
  return out;
}

function closeIfOpened(text: string): string {
  return text.includes("\x1b[") ? `${text}\x1b[0m` : text;
}

export type AnsiToken =
  | { kind: "sgr"; raw: string }
  | { kind: "cluster"; raw: string; width: number };

/**
 * Walk SGR + grapheme clusters. Used by wrap/clip so a 你 is one token
 * of width 2, never two UTF-16 units of width 1.
 */
export function tokenizeAnsi(text: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  if (!text) return tokens;
  const re = /(\x1b\[[0-9;]*m)|([^\x1b]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      tokens.push({ kind: "sgr", raw: m[1] });
      continue;
    }
    for (const { segment } of graphemeSegmenter.segment(m[2]!)) {
      tokens.push({
        kind: "cluster",
        raw: segment,
        width: clusterWidth(segment),
      });
    }
  }
  return tokens;
}
