/**
 * Best-effort repair of incomplete / slightly-malformed JSON tool arguments.
 *
 * Streamed tool calls frequently truncate mid-object (max_tokens, network cut,
 * provider bugs). OpenCode/Claude-style agents recover instead of hard-failing
 * the whole tool turn — experts expect the same from production agents.
 */

export type JsonRepairResult =
  | { ok: true; value: Record<string, unknown>; repaired: boolean; note?: string }
  | { ok: false; error: string; raw: string };

/**
 * Parse tool-call argument JSON, applying light repairs when needed.
 * Always returns an object (never array/primitive) on success — tool args are objects.
 */
export function parseToolArguments(raw: string | null | undefined): JsonRepairResult {
  const input = (raw ?? "").trim();
  if (!input) {
    return { ok: true, value: {}, repaired: false };
  }

  // Fast path
  try {
    const v = JSON.parse(input);
    if (isPlainObject(v)) {
      return { ok: true, value: v, repaired: false };
    }
    // Models sometimes wrap args as a bare string/array — box it
    return {
      ok: true,
      value: { value: v },
      repaired: true,
      note: "non-object JSON boxed under `value`",
    };
  } catch {
    /* repair below */
  }

  const candidates = buildRepairCandidates(input);
  for (const { text, note } of candidates) {
    try {
      const v = JSON.parse(text);
      if (isPlainObject(v)) {
        return { ok: true, value: v, repaired: true, note };
      }
      if (v !== null && typeof v === "object") {
        return {
          ok: true,
          value: { value: v },
          repaired: true,
          note: `${note}; non-object boxed`,
        };
      }
    } catch {
      /* try next */
    }
  }

  return {
    ok: false,
    error: "Invalid JSON arguments (repair failed)",
    raw: input.length > 400 ? `${input.slice(0, 400)}…` : input,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function buildRepairCandidates(input: string): Array<{ text: string; note: string }> {
  const out: Array<{ text: string; note: string }> = [];

  // Strip common markdown fences / leading junk
  let s = input
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  // Extract outermost object if surrounded by prose
  const firstBrace = s.indexOf("{");
  const firstBracket = s.indexOf("[");
  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace <= firstBracket)) {
    s = s.slice(firstBrace);
  } else if (firstBracket >= 0) {
    s = s.slice(firstBracket);
  }
  if (s !== input) out.push({ text: s, note: "stripped fence/prose" });

  // Trailing commas before } or ]
  const noTrailingCommas = s.replace(/,\s*([}\]])/g, "$1");
  if (noTrailingCommas !== s) {
    out.push({ text: noTrailingCommas, note: "removed trailing commas" });
  }

  // Close unclosed strings + brackets (most common stream truncation)
  const closed = closeIncompleteJson(noTrailingCommas);
  if (closed !== noTrailingCommas) {
    out.push({ text: closed, note: "closed truncated JSON" });
  }

  // Trailing commas after close pass
  const closedNoComma = closed.replace(/,\s*([}\]])/g, "$1");
  if (closedNoComma !== closed) {
    out.push({ text: closedNoComma, note: "closed truncated JSON + trailing commas" });
  }

  // Single-quoted keys/strings → double (last resort, conservative)
  if (/^\s*\{/.test(s) && s.includes("'")) {
    const doubled = s
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, (_m, k: string) => `"${k}":`)
      .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, v: string) => `: "${v}"`);
    if (doubled !== s) {
      out.push({ text: closeIncompleteJson(doubled), note: "single→double quotes + close" });
    }
  }

  return out;
}

/**
 * Close an incomplete JSON string by terminating open strings and stacking
 * braces/brackets. Does not invent keys — only structural closers.
 *
 * Also heals a common model glitch: an unescaped `"` mid-value followed by
 * more text (`{"cmd":"grep "foo`) by treating that quote as literal content
 * when the remainder cannot be valid JSON structure.
 */
export function closeIncompleteJson(input: string): string {
  // First pass: detect "false string end" — quote followed by bare word chars
  // that are not structural JSON. Escape those quotes so the value continues.
  const healed = escapeSpuriousValueQuotes(input);
  return closeBalances(healed);
}

function closeBalances(input: string): string {
  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  let out = input;
  if (escape) {
    // dangling backslash at end of truncated escape — drop it
    out = out.slice(0, -1);
  }
  if (inString) out += '"';
  // Drop trailing comma / colon before closers so `{"a":` → `{"a":null}`
  out = out.replace(/,\s*$/, "");
  if (/:\s*$/.test(out)) out += "null";
  // Bare word after key colon (truncated unquoted string) → quote it.
  // Leave JSON literals (null/true/false/numbers) alone.
  out = out.replace(
    /:\s*([A-Za-z_][A-Za-z0-9_\-./]*)\s*$/,
    (full, word: string) => {
      if (/^(null|true|false)$/.test(word)) return full;
      return `:"${word}"`;
    },
  );
  while (stack.length) out += stack.pop();
  return out;
}

/**
 * Inside string values, a raw `"` followed by non-structural text usually means
 * the model forgot to escape. Convert those to `\"` so truncation repair works.
 */
function escapeSpuriousValueQuotes(input: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  // Track whether current string is a key (just after { or ,) vs a value (after :)
  let expectingKey = true;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (!inString) {
      out += ch;
      if (ch === "{" || ch === ",") expectingKey = true;
      else if (ch === ":") expectingKey = false;
      else if (ch === "[" ) expectingKey = false;
      if (ch === '"') {
        inString = true;
        escape = false;
      }
      i += 1;
      continue;
    }
    // in string
    if (escape) {
      out += ch;
      escape = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escape = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Lookahead: is this a real end-of-string?
      const rest = input.slice(i + 1);
      const realEnd = expectingKey
        ? /^\s*:/.test(rest) || rest.length === 0
        : /^\s*[,}\]]/.test(rest) || rest.length === 0 || /^\s*$/.test(rest);
      // Truncation mid-value: quote at end or quote + bare word (no comma/brace)
      if (!expectingKey && !realEnd && /^[^,}\]]/.test(rest)) {
        // Spurious quote inside value — escape it
        out += '\\"';
        i += 1;
        continue;
      }
      out += '"';
      inString = false;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
