/**
 * Segment-aware shell command parsing (Grok-style).
 *
 * Splits on top-level && || ; | so deny/hard-safety can reject one bad
 * segment without relying on the full string matching a single regex.
 *
 * Also peels common wrappers (env, timeout, nice, …) and ENV=value prefixes
 * so `FOO=1 rm -rf /` is still judged as `rm -rf /`.
 */

const WRAPPERS = new Set([
  "timeout",
  "nice",
  "ionice",
  "chrt",
  "stdbuf",
  "env",
  "time",
  "command",
  "builtin",
]);

/**
 * Split a shell command into top-level segments.
 * Does not fully parse shell quoting, but tracks ", ', and \ enough for
 * common agent-generated commands.
 */
export function splitShellSegments(command: string): string[] {
  const s = command.trim();
  if (!s) return [];

  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const push = () => {
    const t = cur.trim();
    if (t) segments.push(t);
    cur = "";
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote === '"') {
        escaped = true;
        cur += ch;
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    // operators
    if (ch === "&" && s[i + 1] === "&") {
      push();
      i++;
      continue;
    }
    if (ch === "|" && s[i + 1] === "|") {
      push();
      i++;
      continue;
    }
    if (ch === ";" || ch === "|") {
      // single | is pipe — still a segment boundary for safety (each side runs)
      push();
      continue;
    }
    // newlines as separators
    if (ch === "\n") {
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return segments;
}

/** Strip leading ENV=value assignments. */
export function stripEnvPrefixes(segment: string): string {
  let s = segment.trim();
  // FOO=bar BAZ=1 cmd ...
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
    // find end of assignment (respect simple quotes)
    const m = s.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

/**
 * Peel wrappers like `timeout 10`, `env -i`, `nice -n 5`.
 * Returns the inner command for matching purposes.
 */
export function peelWrappers(segment: string): string {
  let s = stripEnvPrefixes(segment);
  for (let n = 0; n < 6; n++) {
    const parts = tokenizeSimple(s);
    if (parts.length === 0) return s;
    const head = parts[0];
    if (!WRAPPERS.has(head)) return s;

    if (head === "timeout") {
      // timeout [options] DURATION command
      let i = 1;
      while (i < parts.length && parts[i].startsWith("-")) i++;
      if (i < parts.length && /^\d/.test(parts[i])) i++; // duration
      s = parts.slice(i).join(" ");
      continue;
    }
    if (head === "env") {
      let i = 1;
      while (i < parts.length && (parts[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i]))) {
        i++;
      }
      s = parts.slice(i).join(" ");
      continue;
    }
    if (head === "stdbuf") {
      // stdbuf -oL -eL cmd
      let i = 1;
      while (i < parts.length && parts[i].startsWith("-")) {
        // -oL style may be one token
        i++;
      }
      s = parts.slice(i).join(" ");
      continue;
    }
    // nice / ionice / time / command / builtin: skip flags then rest
    let i = 1;
    while (i < parts.length && parts[i].startsWith("-")) i++;
    s = parts.slice(i).join(" ");
  }
  return s.trim();
}

/** Lightweight tokenization (whitespace + simple quotes). */
export function tokenizeSimple(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Normalize a segment for pattern matching: peel wrappers + env. */
export function normalizeSegment(segment: string): string {
  return peelWrappers(segment);
}

/**
 * All segments of a command, normalized for safety/rule checks.
 * Always includes the full command string as the last entry so whole-string
 * allow rules (Grok-style) can still match.
 */
export function commandCheckTargets(command: string): string[] {
  const segs = splitShellSegments(command).map(normalizeSegment).filter(Boolean);
  const full = command.trim();
  if (segs.length === 0) return full ? [full] : [];
  // unique preserve order
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of [...segs, full]) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** Primary binary/word of a normalized segment. */
export function primaryCommand(segment: string): string {
  const toks = tokenizeSimple(normalizeSegment(segment));
  return toks[0] || "";
}
