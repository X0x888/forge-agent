/**
 * Refuse Chrome/CDP look scripts under looks/. Mills wrote looks/*.mjs when
 * Playwright was down and drove another session's :5173. The look path is
 * call_mcp playwright or the leased session UDD.
 */

const LOOKS_SCRIPT_RE = /(^|\/)looks\/.+\.(mjs|cjs|js)$/i;
const LOOKS_CHROME_NAME_RE =
  /(^|\/)looks\/[^/]*(?:cdp|chrome)[^/]*\.(mjs|cjs|js|ts)$/i;
const CDP_BODY_RE =
  /--remote-debugging-port|chrome-for-testing|puppeteer\.launch|chromium\.launch|chrome\.debugger/i;

export function lookScriptWriteRefuse(
  relPath: string,
  content?: string,
): string | undefined {
  const rel = String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!rel) return undefined;
  const underLooks = /(^|\/)looks\//i.test(rel);
  if (LOOKS_SCRIPT_RE.test(rel) || LOOKS_CHROME_NAME_RE.test(rel)) {
    return refuseLine(rel);
  }
  if (underLooks && content && CDP_BODY_RE.test(content)) {
    return refuseLine(rel);
  }
  return undefined;
}

function refuseLine(rel: string): string {
  return (
    `write refused: ${rel} is a Chrome/CDP look script. ` +
    `Use call_mcp playwright (or the leased --user-data-dir) — do not write looks/*.mjs.`
  );
}
