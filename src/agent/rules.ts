/**
 * Permission rules engine (Grok/Claude-compatible shape).
 *
 * Evaluation order: deny > ask > allow
 * Deny ALWAYS applies, including under bypassPermissions (YOLO).
 *
 * Bash allow is **segment-strict**: every top-level segment must match an
 * allow rule. `Bash(git status)` must NOT approve `git status && curl …`.
 */
import path from "node:path";
import type { PermissionRule, PermissionAction } from "../config/types.js";
import {
  commandCheckTargets,
  primaryCommand,
  normalizeSegment,
} from "./shell-parse.js";

export interface RuleMatch {
  action: PermissionAction;
  rule: PermissionRule;
  /** Which text matched (segment or path) */
  matched: string;
}

export interface RulesEvaluation {
  /** Highest-priority decisive action for this tool call */
  decision: PermissionAction | "none";
  matches: RuleMatch[];
  deny?: RuleMatch;
  ask?: RuleMatch;
  allow?: RuleMatch;
  /** For bash: segments that did not match any allow rule */
  unmatchedSegments?: string[];
}

/** Parse Claude/Grok style string: Bash(rm …), Edit(path-glob), Read(…) */
export function parseRuleString(raw: string): PermissionRule | null {
  const s = raw.trim();
  if (!s) return null;
  // Tool(pattern)
  const m = s.match(/^([A-Za-z_*][A-Za-z0-9_*]*)\(([\s\S]*)\)$/);
  if (m) {
    return {
      action: "deny", // action set by caller list
      tool: normalizeToolName(m[1]),
      pattern: m[2],
      raw: s,
    };
  }
  // bare tool name
  return {
    action: "deny",
    tool: normalizeToolName(s),
    pattern: "*",
    raw: s,
  };
}

function normalizeToolName(t: string): string {
  const lower = t.toLowerCase();
  const map: Record<string, string> = {
    bash: "bash",
    shell: "bash",
    run_terminal_command: "bash",
    read: "read_file",
    read_file: "read_file",
    edit: "search_replace",
    write: "write_file",
    write_file: "write_file",
    search_replace: "search_replace",
    multiedit: "search_replace",
    grep: "grep",
    glob: "glob",
    list_dir: "list_dir",
    listdir: "list_dir",
    web_search: "web_search",
    websearch: "web_search",
    "*": "*",
  };
  return map[lower] || lower;
}

function toolMatches(ruleTool: string, actual: string): boolean {
  const a = normalizeToolName(actual);
  const r = normalizeToolName(ruleTool);
  if (r === "*" || r === "any") return true;
  if (r === a) return true;
  if (r === "bash" && (a === "bash" || a === "run_terminal_command")) return true;
  return false;
}

/**
 * Convert a rule pattern to a RegExp.
 * Supports * wildcards (not full glob ** unless written as *).
 */
export function patternToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  if (p.endsWith(":*")) p = p.slice(0, -2) + "*";
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") re += "[\\s\\S]*";
    else if (/[.+?^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  if (!pattern.trim().startsWith("*")) {
    return new RegExp("^" + re, "i");
  }
  return new RegExp(re, "i");
}

function pathMatchesGlob(filePath: string, pattern: string, workspace: string): boolean {
  const rel = path.relative(workspace, path.resolve(workspace, filePath)).replace(/\\/g, "/");
  const abs = path.resolve(workspace, filePath).replace(/\\/g, "/");
  const toRe = (g: string) => {
    let s = "";
    for (let i = 0; i < g.length; i++) {
      if (g[i] === "*" && g[i + 1] === "*") {
        s += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else if (g[i] === "*") s += "[^/]*";
      else if (g[i] === "?") s += "[^/]";
      else if (/[.+^${}()|[\]\\]/.test(g[i])) s += "\\" + g[i];
      else s += g[i];
    }
    return new RegExp("^" + s + "$", "i");
  };
  const re = toRe(pattern.replace(/\\/g, "/"));
  return re.test(rel) || re.test(abs) || re.test(path.basename(filePath));
}

/** Does a single shell segment match a bash rule pattern? */
export function segmentMatchesBashPattern(segment: string, pattern: string): boolean {
  const seg = normalizeSegment(segment);
  const re = patternToRegExp(pattern || "*");
  if (re.test(seg) || re.test(primaryCommand(seg))) return true;
  const pat = (pattern || "").replace(/\*$/, "").trim();
  if (pat && (seg === pat || seg.startsWith(pat + " "))) return true;
  return false;
}

function matchPathRule(
  rule: PermissionRule,
  toolInput: Record<string, unknown>,
  workspace: string,
): string | null {
  const p = String(toolInput.path || "");
  if (!p) return null;
  if (pathMatchesGlob(p, rule.pattern || "*", workspace)) return p;
  return null;
}

function evaluateBashRules(
  rules: PermissionRule[],
  command: string,
): RulesEvaluation {
  const targets = commandCheckTargets(command);
  const segments = targets.length ? targets : [command.trim()].filter(Boolean);
  const matches: RuleMatch[] = [];
  let deny: RuleMatch | undefined;
  let ask: RuleMatch | undefined;

  const bashRules = rules.filter((r) => toolMatches(r.tool, "bash"));

  // Deny: any segment matching any deny rule → deny whole command
  for (const seg of segments) {
    for (const rule of bashRules) {
      if (rule.action !== "deny") continue;
      if (segmentMatchesBashPattern(seg, rule.pattern || "*")) {
        const m: RuleMatch = { action: "deny", rule, matched: seg };
        matches.push(m);
        if (!deny) deny = m;
      }
    }
  }
  if (deny) return { decision: "deny", matches, deny };

  // Ask: any segment matching ask → ask (before allow)
  for (const seg of segments) {
    for (const rule of bashRules) {
      if (rule.action !== "ask") continue;
      if (segmentMatchesBashPattern(seg, rule.pattern || "*")) {
        const m: RuleMatch = { action: "ask", rule, matched: seg };
        matches.push(m);
        if (!ask) ask = m;
      }
    }
  }
  if (ask) return { decision: "ask", matches, ask };

  // Allow: EVERY segment must match at least one allow rule
  const allowRules = bashRules.filter((r) => r.action === "allow");
  if (!allowRules.length || !segments.length) {
    return { decision: "none", matches };
  }

  const unmatched: string[] = [];
  let firstAllow: RuleMatch | undefined;
  for (const seg of segments) {
    let hit: RuleMatch | undefined;
    for (const rule of allowRules) {
      if (segmentMatchesBashPattern(seg, rule.pattern || "*")) {
        hit = { action: "allow", rule, matched: seg };
        matches.push(hit);
        if (!firstAllow) firstAllow = hit;
        break;
      }
    }
    if (!hit) unmatched.push(seg);
  }

  if (unmatched.length === 0 && firstAllow) {
    return { decision: "allow", matches, allow: firstAllow };
  }

  // Partial allow is not an allow — fall through to prompt / fail-closed
  return {
    decision: "none",
    matches,
    allow: firstAllow,
    unmatchedSegments: unmatched,
  };
}

export function evaluateRules(
  rules: PermissionRule[],
  toolName: string,
  toolInput: Record<string, unknown>,
  workspace: string,
): RulesEvaluation {
  const t = normalizeToolName(toolName);
  if (t === "bash" || t === "run_terminal_command") {
    return evaluateBashRules(rules, String(toolInput.command || ""));
  }

  const matches: RuleMatch[] = [];
  let deny: RuleMatch | undefined;
  let ask: RuleMatch | undefined;
  let allow: RuleMatch | undefined;

  for (const rule of rules) {
    if (!toolMatches(rule.tool, toolName)) continue;

    let matched: string | null = null;
    if (
      t === "read_file" ||
      t === "write_file" ||
      t === "search_replace" ||
      t === "grep" ||
      t === "glob" ||
      t === "list_dir"
    ) {
      matched = matchPathRule(rule, toolInput, workspace);
    } else {
      const re = patternToRegExp(rule.pattern || "*");
      const blob = JSON.stringify(toolInput);
      if (re.test(blob)) matched = blob.slice(0, 80);
    }

    if (!matched) continue;
    const m: RuleMatch = { action: rule.action, rule, matched };
    matches.push(m);
    if (rule.action === "deny" && !deny) deny = m;
    if (rule.action === "ask" && !ask) ask = m;
    if (rule.action === "allow" && !allow) allow = m;
  }

  if (deny) return { decision: "deny", matches, deny, ask, allow };
  if (ask) return { decision: "ask", matches, deny, ask, allow };
  if (allow) return { decision: "allow", matches, deny, ask, allow };
  return { decision: "none", matches };
}

/** Build rules from config arrays + CLI extras. */
export function compileRules(opts: {
  deny?: string[];
  allow?: string[];
  ask?: string[];
  rules?: PermissionRule[];
}): PermissionRule[] {
  const out: PermissionRule[] = [];
  const add = (list: string[] | undefined, action: PermissionAction) => {
    for (const raw of list || []) {
      const r = parseRuleString(raw);
      if (r) out.push({ ...r, action });
    }
  };
  add(opts.deny, "deny");
  add(opts.ask, "ask");
  add(opts.allow, "allow");
  for (const r of opts.rules || []) {
    out.push({
      ...r,
      tool: normalizeToolName(r.tool),
    });
  }
  return out;
}

/** Default deny rules shipped with Forge (always on unless sandbox/rules disabled). */
export function defaultDenyRules(): PermissionRule[] {
  return compileRules({
    deny: [
      "Bash(rm -rf /)",
      "Bash(rm -fr /)",
      "Bash(rm -rf ~)",
      "Bash(rm -rf $HOME)",
      "Bash(*mkfs*)",
      "Edit(**/.ssh/**)",
      "Write(**/.ssh/**)",
      "Edit(/etc/**)",
      "Write(/etc/**)",
    ],
  });
}
