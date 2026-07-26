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
  "nohup",
  "setsid",
  "setuidgid",
  "chpst",
  "softlimit",
]);

/** Shells that take `-c` / `-lc` script payloads we must peel for safety. */
const SHELL_BINARIES = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "busybox", // busybox sh -c '…'
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
  /** Active heredoc delimiter (unquoted form); newlines inside are not segment breaks. */
  let heredocDelim: string | null = null;

  const push = () => {
    const t = cur.trim();
    if (t) segments.push(t);
    cur = "";
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    // Inside a heredoc body: only the closing delimiter line ends it.
    if (heredocDelim) {
      if (ch === "\n") {
        cur += ch;
        // Peek whether the next line is exactly the delimiter
        let j = i + 1;
        while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
        const end = j + heredocDelim.length;
        if (
          s.slice(j, end) === heredocDelim &&
          (end >= s.length || s[end] === "\n" || s[end] === "\r")
        ) {
          cur += s.slice(i + 1, end);
          i = end - 1;
          heredocDelim = null;
        }
        continue;
      }
      cur += ch;
      continue;
    }

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
    // Heredoc start: <<[-]WORD or <<[-]'WORD' / <<"WORD"
    if (ch === "<" && s[i + 1] === "<") {
      cur += "<<";
      i += 2;
      if (s[i] === "-") {
        cur += "-";
        i++;
      }
      while (i < s.length && (s[i] === " " || s[i] === "\t")) {
        cur += s[i];
        i++;
      }
      let delim = "";
      if (s[i] === "'" || s[i] === '"') {
        const q = s[i];
        cur += q;
        i++;
        while (i < s.length && s[i] !== q) {
          delim += s[i];
          cur += s[i];
          i++;
        }
        if (i < s.length && s[i] === q) {
          cur += q;
          // i points at closing quote; loop will i++ via for
        }
      } else {
        while (i < s.length && !/[\s|&;<>()]/.test(s[i])) {
          delim += s[i];
          cur += s[i];
          i++;
        }
        i--; // compensate for for-loop increment
      }
      if (delim) heredocDelim = delim;
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
    // newlines as separators (outside heredoc)
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
/**
 * Peel `bash -c '…'` / `sh -lc "…"` so hard-deny sees the inner script.
 * Returns null when the segment is not a shell -c form.
 */
export function peelShellDashC(segment: string): string | null {
  const parts = tokenizeSimple(stripEnvPrefixes(segment));
  if (parts.length < 3) return null;
  let head = pathBase(parts[0]);
  let i = 1;
  // busybox sh -c '…' / busybox ash -c '…'
  if (head === "busybox" && parts.length >= 4) {
    const sub = pathBase(parts[1]);
    if (SHELL_BINARIES.has(sub) || sub === "ash") {
      head = sub === "ash" ? "sh" : sub;
      i = 2;
    }
  }
  // su -c '…' / su user -c '…'
  if (head === "su") {
    // su [-] [user] -c cmd
    while (i < parts.length) {
      const t = parts[i];
      if (t === "-c" || t === "-lc" || t === "-cl") {
        i++;
        break;
      }
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t) && t.includes("c")) {
        i++;
        break;
      }
      if (t === "-" || t.startsWith("-")) {
        i++;
        continue;
      }
      // username
      i++;
    }
    if (i >= parts.length) return null;
    return parts[i].trim() || null;
  }
  if (!SHELL_BINARIES.has(head) && head !== "ash") return null;
  // Skip login/interactive/etc flags until we hit -c / -lc / combined -c…
  while (i < parts.length) {
    const t = parts[i];
    if (t === "-c" || t === "-lc" || t === "-cl") {
      i++;
      break;
    }
    // Combined short flags containing c: -ec, -xc, -ic, …
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t) && t.includes("c")) {
      i++;
      break;
    }
    if (t.startsWith("-") && t !== "--") {
      i++;
      continue;
    }
    return null;
  }
  if (i >= parts.length) return null;
  // Next token is the script body (tokenizeSimple already unquoted it).
  return parts[i].trim() || null;
}

function pathBase(bin: string): string {
  const s = bin.replace(/\\/g, "/");
  const slash = s.lastIndexOf("/");
  return (slash >= 0 ? s.slice(slash + 1) : s).toLowerCase();
}

/**
 * Re-join tokens so a later tokenizeSimple/peelShellDashC round-trip keeps
 * multi-word `-c` script bodies intact (`bash -c "rm -rf /"` must not become
 * `bash -c rm -rf /` after peeling `env`).
 */
export function shellJoin(parts: string[]): string {
  return parts.map(shellQuoteToken).join(" ");
}

function shellQuoteToken(t: string): string {
  if (!t) return '""';
  // Safe bare token
  if (!/[\s'"\\$`|&;<>(){}*?[~]/.test(t)) return t;
  if (!t.includes("'")) return `'${t}'`;
  // Fallback: double-quote with escapes
  return `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

/**
 * Remove heredoc *bodies* (keep `<<DELIM` markers) so regex hard-deny does not
 * treat commit messages / `cat <<EOF` payloads as executable shell.
 * Shell-driven heredocs (`bash <<EOF`) should scan the body separately.
 */
export function stripHeredocBodies(command: string): string {
  const s = command;
  let out = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const consumeHeredocFrom = (start: number): { text: string; end: number } | null => {
    // start points at first `<` of `<<`
    let i = start;
    let text = "<<";
    i += 2;
    if (s[i] === "-") {
      text += "-";
      i++;
    }
    while (i < s.length && (s[i] === " " || s[i] === "\t")) {
      text += s[i];
      i++;
    }
    let delim = "";
    if (s[i] === "'" || s[i] === '"') {
      const q = s[i];
      text += q;
      i++;
      while (i < s.length && s[i] !== q) {
        delim += s[i];
        text += s[i];
        i++;
      }
      if (i < s.length && s[i] === q) {
        text += q;
        i++;
      }
    } else {
      while (i < s.length && !/[\s|&;<>()]/.test(s[i])) {
        delim += s[i];
        text += s[i];
        i++;
      }
    }
    if (!delim) return null;
    // rest of opener line
    while (i < s.length && s[i] !== "\n") {
      text += s[i];
      i++;
    }
    if (i < s.length && s[i] === "\n") {
      text += "\n";
      i++;
    }
    // skip body lines; keep only closing delimiter line
    while (i < s.length) {
      let j = i;
      while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
      const end = j + delim.length;
      if (
        s.slice(j, end) === delim &&
        (end >= s.length || s[end] === "\n" || s[end] === "\r")
      ) {
        text += s.slice(i, end);
        i = end;
        return { text, end: i - 1 };
      }
      while (i < s.length && s[i] !== "\n") i++;
      if (i < s.length && s[i] === "\n") i++;
    }
    return { text, end: Math.max(start, i - 1) };
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      out += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        quote = null;
        out += ch;
        continue;
      }
      // $(…) inside double quotes — strip heredocs inside the substitution
      if (ch === "$" && s[i + 1] === "(") {
        const body = readBalanced(s, i + 2, "(", ")");
        if (body != null) {
          out += "$(" + stripHeredocBodies(body.text) + ")";
          i = body.end;
          continue;
        }
      }
      // Heredoc can appear inside "$( cat <<EOF … )" after we enter the sub;
      // also handle rare unquoted << inside dq (not valid shell, skip).
      out += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    // $(…) outside quotes
    if (ch === "$" && s[i + 1] === "(") {
      const body = readBalanced(s, i + 2, "(", ")");
      if (body != null) {
        out += "$(" + stripHeredocBodies(body.text) + ")";
        i = body.end;
        continue;
      }
    }
    if (ch === "<" && s[i + 1] === "<") {
      const h = consumeHeredocFrom(i);
      if (h) {
        out += h.text;
        i = h.end;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * If segment is `bash <<DELIM …`, return the heredoc body for safety scanning.
 */
export function peelShellHeredocBody(segment: string): string | null {
  const parts = tokenizeSimple(stripEnvPrefixes(segment));
  if (parts.length === 0) return null;
  if (!SHELL_BINARIES.has(pathBase(parts[0]))) return null;
  // Find <<DELIM in the raw segment
  const m = segment.match(/<<(-?)\s*(?:'([^']+)'|"([^"]+)"|(\S+))/);
  if (!m) return null;
  const delim = m[2] || m[3] || m[4];
  if (!delim) return null;
  const startIdx = segment.indexOf(m[0]);
  if (startIdx < 0) return null;
  let i = startIdx + m[0].length;
  while (i < segment.length && segment[i] !== "\n") i++;
  if (i < segment.length && segment[i] === "\n") i++;
  const bodyStart = i;
  while (i < segment.length) {
    let j = i;
    while (j < segment.length && (segment[j] === " " || segment[j] === "\t")) j++;
    const end = j + delim.length;
    if (
      segment.slice(j, end) === delim &&
      (end >= segment.length || segment[end] === "\n" || segment[end] === "\r")
    ) {
      return segment.slice(bodyStart, i).trim() || null;
    }
    while (i < segment.length && segment[i] !== "\n") i++;
    if (i < segment.length && segment[i] === "\n") i++;
  }
  return segment.slice(bodyStart).trim() || null;
}

/**
 * Extract `$(…)` and `` `…` `` bodies for safety scanning.
 * Quote-aware enough for common agent commands (not a full shell parser).
 */
export function extractCommandSubstitutions(command: string): string[] {
  const out: string[] = [];
  const s = command;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      // $(…) still expands inside double quotes
      if (ch === "$" && s[i + 1] === "(") {
        const body = readBalanced(s, i + 2, "(", ")");
        if (body != null) {
          out.push(body.text.trim());
          i = body.end;
        }
      }
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "$" && s[i + 1] === "(") {
      const body = readBalanced(s, i + 2, "(", ")");
      if (body != null) {
        out.push(body.text.trim());
        i = body.end;
      }
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let body = "";
      let esc = false;
      while (j < s.length) {
        const c = s[j];
        if (esc) {
          body += c;
          esc = false;
          j++;
          continue;
        }
        if (c === "\\") {
          esc = true;
          j++;
          continue;
        }
        if (c === "`") break;
        body += c;
        j++;
      }
      if (j < s.length) {
        out.push(body.trim());
        i = j;
      }
    }
  }
  return out.filter(Boolean);
}

function readBalanced(
  s: string,
  start: number,
  open: string,
  close: string,
): { text: string; end: number } | null {
  let depth = 1;
  let i = start;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote === '"') {
        escaped = true;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { text: s.slice(start, i - 1), end: i - 1 };
}

/**
 * Peel `eval '…'` / `eval "…"` so hard-deny sees the evaluated script.
 */
export function peelEval(segment: string): string | null {
  const parts = tokenizeSimple(stripEnvPrefixes(segment));
  if (parts.length < 2) return null;
  if (pathBase(parts[0]) !== "eval") return null;
  // Tokens are already unquoted. Do NOT shellJoin — that would re-quote
  // `rm -rf /` as a single `'rm -rf /'` token and hide the rm hard-deny.
  return parts.slice(1).join(" ").trim() || null;
}

/**
 * Peel `xargs [flags] bash -c '…'` so the shell -c body is visible.
 * Conservative: only when a shell binary appears after xargs options.
 */
export function peelXargsShell(segment: string): string | null {
  const parts = tokenizeSimple(stripEnvPrefixes(segment));
  if (parts.length < 3) return null;
  if (pathBase(parts[0]) !== "xargs") return null;
  let i = 1;
  while (i < parts.length) {
    const t = parts[i];
    if (t === "--") {
      i++;
      break;
    }
    if (t.startsWith("-") && t !== "-") {
      // Options that take a separate argument: -I, -i, -L, -n, -P, -s, -E, -a, -d
      if (
        t === "-I" ||
        t === "-i" ||
        t === "-L" ||
        t === "-n" ||
        t === "-P" ||
        t === "-s" ||
        t === "-E" ||
        t === "-a" ||
        t === "-d" ||
        t === "--max-args" ||
        t === "--max-procs" ||
        t === "--replace" ||
        t === "--delimiter"
      ) {
        i += 2;
        continue;
      }
      // -I{} style combined
      if (/^-[InLPsEad]/.test(t) && t.length > 2) {
        i++;
        continue;
      }
      i++;
      continue;
    }
    break;
  }
  if (i >= parts.length) return null;
  if (!SHELL_BINARIES.has(pathBase(parts[i]))) return null;
  return shellJoin(parts.slice(i)).trim() || null;
}

export function peelWrappers(segment: string): string {
  let s = stripEnvPrefixes(segment);
  for (let n = 0; n < 8; n++) {
    const parts = tokenizeSimple(s);
    if (parts.length === 0) return s;
    const head = parts[0];
    const headBase = pathBase(head);

    // bash -c 'rm -rf /' → peel to inner script before WRAPPERS check
    const dashC = peelShellDashC(s);
    if (dashC != null) {
      s = dashC;
      continue;
    }

    // eval 'rm -rf /' → peel evaluated body
    const ev = peelEval(s);
    if (ev != null) {
      s = ev;
      continue;
    }

    // xargs … bash -c '…' → peel to shell -c form then loop
    const xa = peelXargsShell(s);
    if (xa != null) {
      s = xa;
      continue;
    }

    if (!WRAPPERS.has(head) && !WRAPPERS.has(headBase)) return s;

    if (head === "timeout" || headBase === "timeout") {
      // timeout [options] DURATION command
      let i = 1;
      while (i < parts.length && parts[i].startsWith("-")) i++;
      if (i < parts.length && /^\d/.test(parts[i])) i++; // duration
      s = shellJoin(parts.slice(i));
      continue;
    }
    if (head === "env" || headBase === "env") {
      let i = 1;
      while (i < parts.length && (parts[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i]))) {
        i++;
      }
      s = shellJoin(parts.slice(i));
      continue;
    }
    if (head === "stdbuf" || headBase === "stdbuf") {
      // stdbuf -oL -eL cmd
      let i = 1;
      while (i < parts.length && parts[i].startsWith("-")) {
        // -oL style may be one token
        i++;
      }
      s = shellJoin(parts.slice(i));
      continue;
    }
    // nice / ionice / time / command / builtin: skip flags then rest
    let i = 1;
    while (i < parts.length && parts[i].startsWith("-")) i++;
    s = shellJoin(parts.slice(i));
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
  const push = (s: string) => {
    const t = s.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const pushScan = (raw: string) => {
    // Strip heredoc *data* so `git commit` / `cat <<EOF` payloads are not
    // mistaken for executable shell. Shell heredoc bodies are added below.
    const stripped = stripHeredocBodies(raw);
    push(normalizeSegment(stripped));
    push(stripped);
    const shBody = peelShellHeredocBody(raw);
    if (shBody) {
      push(normalizeSegment(shBody));
      push(shBody);
    }
    for (const sub of extractCommandSubstitutions(raw)) {
      pushScan(sub);
    }
  };
  for (const s of segs) {
    pushScan(s);
  }
  pushScan(full);
  return out;
}

/** Primary binary/word of a normalized segment. */
export function primaryCommand(segment: string): string {
  const toks = tokenizeSimple(normalizeSegment(segment));
  return toks[0] || "";
}

/**
 * Detect shell redirections that can write outside tools (Warp ContainsRedirection).
 * Tracks quotes so `echo "a > b"` is not a false positive.
 */
export function containsRedirection(command: string): boolean {
  const s = command;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // > >> >& n> n>> < << <<< <>
    if (ch === ">") return true;
    if (ch === "<" && s[i + 1] === ">") return true;
    if (ch === "<" && s[i + 1] === "<") return true;
  }
  return false;
}

/** True if command uses a pipe (not ||). */
export function containsPipe(command: string): boolean {
  const segs = splitShellSegments(command);
  // splitShellSegments treats | as boundary — multiple segments from pipes
  // Also detect raw pipe while respecting quotes
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "|") {
      // skip || (or) — only real pipes count
      if (command[i + 1] === "|") {
        i++;
        continue;
      }
      return true;
    }
  }
  return false;
}

const PATH_FILE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "cp",
  "mv",
  "chmod",
  "chown",
  "cat",
  "head",
  "tail",
  "touch",
  "mkdir",
  "ln",
  "install",
  "tee",
  "truncate",
]);

/**
 * Extract path-like arguments from a normalized segment for workspace checks.
 * Skips flags; returns tokens that look like paths.
 */
export function extractPathArgs(segment: string): string[] {
  const norm = normalizeSegment(segment);
  const toks = tokenizeSimple(norm);
  if (toks.length === 0) return [];
  const cmd = toks[0];
  if (!PATH_FILE_COMMANDS.has(cmd)) return [];
  const paths: string[] = [];
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith("-") && t !== "-") continue;
    // skip destination after cp/mv when multiple — still collect all path-like
    if (
      t.includes("/") ||
      t.startsWith("~") ||
      t.startsWith(".") ||
      t.includes("*") ||
      /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(t)
    ) {
      paths.push(t);
    }
  }
  return paths;
}

/** All path-like args across segments of a full command. */
export function extractCommandPaths(command: string): string[] {
  const out: string[] = [];
  for (const seg of splitShellSegments(command)) {
    out.push(...extractPathArgs(seg));
  }
  // redirection targets: cmd > /tmp/x
  const re = /(?:^|[\s])(?:>>?|>&)\s*([^\s|&;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const t = m[1];
    if (t && !t.startsWith("&")) out.push(t);
  }
  return out;
}

/**
 * Structured targets for hard-safety: normalized segments only (no full string).
 */
export function safetySegments(command: string): string[] {
  return splitShellSegments(command).map(normalizeSegment).filter(Boolean);
}
