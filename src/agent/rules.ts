/**
 * Permission rules engine (Grok/Claude-compatible shape).
 *
 * Evaluation order: deny > ask > allow
 * Deny ALWAYS applies, including under bypassPermissions (YOLO).
 * Ask still prompts for bash segments under YOLO (Grok parity).
 */
import path from "node:path";
import type { PermissionRule, PermissionAction } from "../config/types.js";
import { commandCheckTargets, primaryCommand } from "./shell-parse.js";

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
  // Bash matches bash
  if (r === "bash" && (a === "bash" || a === "run_terminal_command")) return true;
  return false;
}

/**
 * Convert a rule pattern to a RegExp.
 * Supports * wildcards (not full glob ** unless written as *).
 * "rm -rf *" → /^rm -rf [\s\S]*$/i with word-ish start
 */
export function patternToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  // strip trailing :* (Claude Bash(git commit:*) form)
  if (p.endsWith(":*")) p = p.slice(0, -2) + "*";
  // escape regex specials except *
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") re += "[\\s\\S]*";
    else if (/[.+?^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  // prefix match for command rules without leading *
  if (!pattern.trim().startsWith("*")) {
    return new RegExp("^" + re, "i");
  }
  return new RegExp(re, "i");
}

function pathMatchesGlob(filePath: string, pattern: string, workspace: string): boolean {
  const rel = path.relative(workspace, path.resolve(workspace, filePath)).replace(/\\/g, "/");
  const abs = path.resolve(workspace, filePath).replace(/\\/g, "/");
  // very small glob: ** / * 
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

function matchBashRule(rule: PermissionRule, command: string): string | null {
  const targets = commandCheckTargets(command);
  const re = patternToRegExp(rule.pattern || "*");
  for (const t of targets) {
    if (re.test(t) || re.test(primaryCommand(t))) return t;
    // also prefix style: pattern "git" matches "git status"
    const pat = (rule.pattern || "").replace(/\*$/, "").trim();
    if (pat && (t === pat || t.startsWith(pat + " "))) return t;
  }
  return null;
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

export function evaluateRules(
  rules: PermissionRule[],
  toolName: string,
  toolInput: Record<string, unknown>,
  workspace: string,
): RulesEvaluation {
  const matches: RuleMatch[] = [];
  let deny: RuleMatch | undefined;
  let ask: RuleMatch | undefined;
  let allow: RuleMatch | undefined;

  for (const rule of rules) {
    if (!toolMatches(rule.tool, toolName)) continue;

    let matched: string | null = null;
    const t = normalizeToolName(toolName);
    if (t === "bash" || t === "run_terminal_command") {
      matched = matchBashRule(rule, String(toolInput.command || ""));
    } else if (
      t === "read_file" ||
      t === "write_file" ||
      t === "search_replace" ||
      t === "grep" ||
      t === "glob" ||
      t === "list_dir"
    ) {
      matched = matchPathRule(rule, toolInput, workspace);
      // grep/glob may use path as directory
      if (!matched && toolInput.path) {
        matched = matchPathRule(rule, toolInput, workspace);
      }
    } else {
      // generic: pattern against JSON
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

  // priority
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
      "Bash(*curl*|*sh*)", // weak; hard safety is primary
      "Edit(**/.ssh/**)",
      "Write(**/.ssh/**)",
      "Edit(/etc/**)",
      "Write(/etc/**)",
    ],
  }).filter((r) => {
    // drop the weak curl rule - hard safety handles it better
    return !(r.pattern || "").includes("curl");
  });
}
