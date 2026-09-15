/**
 * Per-session localhost port for ULW looks.
 * Concurrent mills (Scrapfall vs 魔塔) shared :5173/:5175 and drove the
 * other product. Hash the session id onto a stable range.
 */
export const LOOK_PORT_BASE = 5200;
export const LOOK_PORT_SPAN = 800;
/** Harness Chrome CDP sits in the next span so it never collides with Vite. */
export const LOOK_CHROME_PORT_BASE = LOOK_PORT_BASE + LOOK_PORT_SPAN;

export function lookPortForSession(sessionId: string): number {
  const id = (sessionId || "").trim() || "anon";
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return LOOK_PORT_BASE + (h >>> 0) % LOOK_PORT_SPAN;
}

export function lookChromePortForSession(sessionId: string): number {
  return LOOK_CHROME_PORT_BASE + (lookPortForSession(sessionId) - LOOK_PORT_BASE);
}
