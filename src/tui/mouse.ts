/**
 * SGR mouse (CSI ?1006h / ?1000h). Press/release only — no motion.
 * Shift-click is ignored so we do not fight native selection when the
 * terminal still reports it.
 *
 * Default **off**: mouse tracking steals drag-select and copy-on-select
 * from the terminal. Click-to-caret / dock chips: FORGE_MOUSE=1 | true | on.
 */

export const MOUSE_SGR_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_SGR_DISABLE = "\x1b[?1006l\x1b[?1000l";

export function isMouseEnabled(): boolean {
  const v = (process.env.FORGE_MOUSE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export interface MouseEvent {
  /** 0 left, 1 middle, 2 right */
  btn: number;
  /** 1-based cell */
  x: number;
  y: number;
  release: boolean;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  motion: boolean;
  wheel: 0 | 1 | -1;
}

/** Parse `CSI < btn ; x ; y M/m`. Returns null if incomplete or not SGR mouse. */
export function parseSgrMouse(seq: string): MouseEvent | null {
  const m = seq.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!m) return null;
  const code = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const release = m[4] === "m";
  const motion = (code & 32) !== 0;
  const shift = (code & 4) !== 0;
  const meta = (code & 8) !== 0;
  const ctrl = (code & 16) !== 0;
  const low = code & ~32 & ~16 & ~8 & ~4;
  let wheel: 0 | 1 | -1 = 0;
  let btn = low;
  if (low >= 64) {
    wheel = low === 64 ? 1 : -1;
    btn = 0;
  }
  return {
    btn,
    x: Math.max(1, x),
    y: Math.max(1, y),
    release,
    shift,
    meta,
    ctrl,
    motion,
    wheel,
  };
}

/**
 * Bytes consumed if `s` starts with an SGR mouse report (possibly incomplete).
 * 0 = not mouse; -1 = incomplete (wait); >0 = used.
 */
export function sgrMouseConsumed(s: string): number {
  if (!s.startsWith("\x1b[<")) {
    if (s === "\x1b" || s === "\x1b[" || "\x1b[<".startsWith(s)) return -1;
    return 0;
  }
  const m = s.match(/^\x1b\[<\d+;\d+;\d+[Mm]/);
  if (m) return m[0].length;
  if (s.length > 40) return 1;
  return -1;
}
