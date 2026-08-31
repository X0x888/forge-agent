/**
 * JSON that Rust serde_json (xAI, and other UTF-8 string deserializers) will
 * accept. JS strings are UTF-16: a `.slice` or scrape can leave a lone
 * high surrogate (e.g. 🔥 split into `\uD83D`). JSON.stringify then emits
 * `"\ud83d"`, and serde_json treats that as the start of a surrogate pair —
 * next char is usually `\n` or `"` → HTTP 400 "unexpected end of hex escape".
 */

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function clampIndex(n: number, len: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return Math.max(len + n, 0);
  return n > len ? len : n;
}

/** Replace unpaired UTF-16 surrogates so the string is valid Unicode scalar values. */
export function replaceUnpairedSurrogates(s: string, repl = "\uFFFD"): string {
  if (!s) return s;
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    repl,
  );
}

/**
 * `String.slice` that never splits a surrogate pair. Incomplete halves at the
 * cut are dropped (not kept as lone `\uD800`/`\uDFFF`).
 */
export function sliceUtf16Safe(s: string, start = 0, end = s.length): string {
  const len = s.length;
  let a = clampIndex(start, len);
  let b = clampIndex(end, len);
  if (a >= b) return "";
  if (
    a > 0 &&
    isLowSurrogate(s.charCodeAt(a)) &&
    isHighSurrogate(s.charCodeAt(a - 1))
  ) {
    a += 1;
    if (a >= b) return "";
  }
  if (b < len) {
    if (
      isHighSurrogate(s.charCodeAt(b - 1)) &&
      isLowSurrogate(s.charCodeAt(b))
    ) {
      b -= 1;
    }
  } else if (b > 0 && isHighSurrogate(s.charCodeAt(b - 1))) {
    b -= 1;
  }
  if (a >= b) return "";
  return s.slice(a, b);
}

function jsonUtf8Replacer(_key: string, value: unknown): unknown {
  return typeof value === "string" ? replaceUnpairedSurrogates(value) : value;
}

/** JSON.stringify that never emits a lone `\uD800`–`\uDFFF` escape. */
export function jsonStringifyUtf8(value: unknown): string {
  return JSON.stringify(value, jsonUtf8Replacer) ?? "null";
}
