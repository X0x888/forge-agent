/**
 * Grouped /help — first-day start vs full catalog vs topics vs word search.
 */
import { suggestName } from "../util/suggest.js";
import { clipAnsi, visibleWidth } from "../util/format.js";
import {
  formatHelpStartCard,
  formatHelpStartItem,
  parseHelpStartKey,
} from "../tui/help-card.js";


export const HELP_TOPICS = [
  "start",
  "all",
  "settings",
  "harness",
  "sessions",
  "safety",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

/** First-day `/help` card (numbered 1–6). Catalog is `/help all`. */
export const HELP_START = formatHelpStartCard();

export const HELP_TOUR = HELP_START;

export const HELP_SETTINGS = `
Settings
────────
  /setup              First-day hub (model, budget, notify, AGENTS.md, LSP)
  /config [json]      Effective snapshot (no secrets)
  /provider [name]    Switch provider (sticky)
  /model <name>       Switch model mid-run (sticky)
  /effort [level]     Thinking effort (default = model max)
  /budget [usd|off]   Session spend cap · HIT/none/ok
  /permissions [mode] default | acceptEdits | plan | bypassPermissions | dontAsk
  /notify [on|off]    Desktop alert when a turn ends
  /bell [on|off]      Terminal BEL when a turn ends
  /format [on|off]    Format-on-write after file tools
  /verbose            Full diffs + tool output (edits already show a short diff)
  /fallback [models]  Same-provider fallbacks after 429/5xx (off; floor grok-4.5 high)
  /mcp  /lsp          MCP servers · language servers
  forge setup         Same card from the CLI  ·  forge setup --json
  forge config        Snapshot  ·  forge doctor
`.trim();

export const HELP_HARNESS = `
Harness
───────
  Blocking Stop is on by default — unfinished work, soft handoffs, and unproven
  claims can be blocked. Finish or prove.

  /goal <objective>   Relentless driver (Stop blocked until attested)
  /goal pause|resume|clear|done
  /ulw [task]         Ultrawork: Wave 1 PLAN, then BUILD (cycle=1)
  /cycle 1|0          Continue waves or finish this + one more, then stop
  /max-waves N|off    Cap ULW waves (auto LAST at N)
  /done               Wind down + lastErr/verify Next
  /plan               Session-scoped read-only design
  /build              Leave plan and implement
  /improve [focus]    Optional focus for /ulw (same rails)

  Live (while working) — type at live › without Ctrl+C:
    /cycle 0  ·  /ulw-off  ·  /budget  ·  /done  ·  /status  ·  free-text queues

  Docs: docs/HARNESS.md  ·  docs/ULW.md
`.trim();

export const HELP_SESSIONS = `
Sessions
────────
  Bare forge resumes the newest same-cwd session (≤14d).  forge --new  for fresh.
  /sessions           Title-first list  ·  /sessions errors → /resume 1
  /resume [n|id|title]  Resume by list number, id prefix, or unique title
  /new [title]        Fresh session
  /title [name]       Label for resume-by-title / search
  /pin                Protect from prune
  /share              Pasteable handoff card + Next
  /last [n]           Conversation card + lastErr Next + files/verify
  /verify [cmd]       Run last/project check · stamp the trail
  /files              Paths touched this session
  /path               On-disk session directory
  /export             Markdown or JSON (mode 0600)
  /fork               Branch into a new session id
  /undo  /retry       Rewind last turn · 429 → /accounts not another burn
  /checkpoint         Safety snapshot · restore rewinds (/snap)

  CLI: forge sessions list --cwd  ·  -q  ·  prune --keep 50
`.trim();

export const HELP_SAFETY = `
Safety
──────
  Defaults: sandbox=workspace  ·  blocking Stop on  ·  permission_mode=default
            read-outside=ask  ·  missing sandbox backend fail-closed

  /permissions        Modes + saved always-allows
  /plan               Read-only design (no sticky prefs)
  /diff               Change-review card · /diff --full for the patch
  /logs               Sandbox / safety event tail
  /doctor             Flags YOLO, sandbox=off, mode 0600, Blocking Stop OFF
  /budget             Session spend cap · HIT Next is /budget off

  Project .forge/config.toml cannot set YOLO, sandbox=off, or disable Stop.

  Docs: docs/SAFETY.md  ·  docs/PRODUCTION.md
`.trim();

/** Current full catalog (was the only /help). */
export const HELP_ALL = `
Forge slash commands
────────────────────
  /help [topic|word]    1–6 start · all|settings|… · or a command word (budget, undo)
  /setup [skip|json]    First-day hub: model, budget, notify, AGENTS.md, LSP  [live]
  /goal <objective>     Arm relentless goal driver (Codex-style)
  /goal                 Show goal status  [live]
  /goal pause|resume|clear|done   [live]
  /done [note]          Wind down + lastErr/verify Next (goal + ULW LAST)  [live]
  /pause                Shorthand for /goal pause  [live]
  /unpause              Shorthand for /goal resume  [live]
  /ulw [task]           Arm ULW + cycle=1 (Wave 1 PLAN, then BUILD; soft/broad seeds backlog)
  /improve [focus…]     Same as /ulw with an optional focus (alias /ralph)
  /memory [list|add …]  Session decisions. /memory project [prune] for cross-session.
  /attach <image>       Attach image path for vision ([[image:path]] in next message)
  /paste                Attach clipboard image (pngpaste / osascript / wl-paste / xclip)
  /cycle 1|0|status     Continue waves (1) or finish this + one more then stop (0)  [live]
  /max-waves N|off      Cap ULW waves (auto LAST at N); default unlimited  [live]
  /ulw-off              Disarm ULW + cycle driver  [live]
  /hooks [init|reload]  List/scaffold/reload hooks  [live]
  /status · /hud        HUD + session · lastErr Next is a slash key  [live]
  /tasks [kill|log id]  Background shell tasks · kill/log subcommands  [live]
  /mcp [status|connect|tools|reload]  MCP servers (search_mcp · call_mcp)  [live]
  /lsp [status|ensure|install|detect|restart]  Language servers (auto-install TS/Python)  [live]
  /context              Context window usage bar  [live]
  /cost                 Token usage + rough cost + budget  [live]
  /budget [usd|off]     Session spend cap · HIT/none/ok (estimate USD)  [live]
  /metrics              Local metrics.jsonl + this session counters  [live]
  /stats [days|week]    Usage dashboard (runs/tokens/cost/projects)  [live]
  /todos                Work board (▶ next · ○ pending · ✓ done)  [live]
  /provider [name]      List / switch provider (openrouter, xai, …) — sticky  [live]
  /model <name> [effort] Switch model mid-run; free-form on OpenRouter  [live]
  /fallback [models|on|off] Same-provider fallbacks after 429/5xx (off; floor grok-4.5 high)  [live]
  /effort [level]       Thinking effort (default = model max; low…high|xhigh|max)  [live]
  /temperature [0–2]    Session sampling temperature (/temp)  [live]
  /max-tokens [n]       Session max output tokens  [live]
  /context-window [n|auto]  Pin or auto-follow model max context (/ctx-window)  [live]
  /plan [focus]         Session-scoped PLAN (ULW Wave 1 uses this; no sticky prefs)  [live]
  /build [note]         Leave plan → implement now (skips remaining ULW Wave 1 research)  [live]
  /permissions [mode]   Menu if empty; Tab / numbers / aliases (yolo, always…)
                        Sticky prefs · plan|build aliases · list|clear|revoke always-allows
  /compact              Compact conversation
  /compact-and <prompt> Compact then continue with follow-up (Warp-style)
  /fork-and-compact [prompt]  Fork, compact the fork, optional continue (Warp-style)
  /init [focus]         Guided AGENTS.md setup / improve (OpenCode-style)
  /review [target]      Code review: uncommitted|staged|<commit>|<branch>|<pr#>
  /checkpoint [snap|restore]  Safety snapshot · restore rewinds, never git stash apply (/snap)
  /commit [staged] [do]  Card from the dirty tree; do creates the commit (no push, no model)
                        /commit draft still starts a model message. ULW auto-commits on wave close (FORGE_ULW_AUTO_COMMIT=0 off)
  /rewind [n]           Undo last n user turns + restore journaled files (/undo)
  /retry [prompt]       Rewind last turn (+ disk) + re-run (/again; optional rewrite)
  /export [path] [--json]  Export session as markdown or JSON (files mode 0600)
  /fork [title]         Branch session into a new id (keep original)
  /title [name|clear]   Show / set / clear session title (/rename)  [live]
  /bell [on|off|test]   Terminal BEL when a turn ends (long-run attention)  [live]
  /notify [on|off|test] Desktop notify when a turn ends (osascript/notify-send)  [live]
  /format [on|off]      Format-on-write after file tools (prettier/biome/ruff/…)  [live]
  /verbose              Toggle full diffs + output (edits already show a short preview)  [live]
  ask_user              Model tool for clarifying questions (not a slash) — interactive; headless fails closed
  /diff [path]          Change-review card (Δ files + verify) · --full / -U3 for the patch  [live]
  /verify [cmd]         Run last/project check · stamp the trail (Next on stale/red)
  !<command>            Run a shell command now (same permissions as bash)  [live]
  /logs [n|0|all|path]  Tail sandbox/safety events (0/all = full window)  [live]
  /config [json]        Effective config snapshot (no secrets)  [live]
  /copy                 Copy last assistant reply (pbcopy/wl-copy/xclip/…)  [live]
  /share [nocopy]       Pasteable session card + lastErr/verify Next (clipboard)  [live]
  /last [n]             Conversation card + lastErr Next + files/verify  [live]
  /files [writes|n]     Paths touched by tools this session (newest first)  [live]
  /path [id|json]       On-disk session directory / session.json path  [live]
  /pin [on|off|toggle]  Protect session from prune (/unpin)  [live]
  /tips                 Expert keyboard / CI cheat sheet  [live]
  /report               Standalone run report: outcome · shipped · verified · not done · needs you  [live]
  /guidelines [audit|stamp|diff|apply|discard]  Agent-guidelines audit: facts fixed in place, doctrine proposals reviewed here  [live]
  /news [n|all]         What's new from CHANGELOG (/changelog)  [live]
  /new [title]          Fresh session (optional searchable label; ULW not inherited)
  /clear                Clear messages same id (counters+journal reset)
  /clear hard           Brand-new session id (same as /new; ULW not inherited)
  /resume [n|id|title|all] Resume #n from the picker, id prefix, or /title
  /sessions [all|search|delete|prune]  Title-first list (cwd) / search / delete [--force] / prune
  /auth                 Stored credentials · Next /accounts (not forge login)  [live]
  /accounts [status|switch|…]  Verdict-first list · Next is /accounts switch  [live]
  /doctor               Environment health check  [live]
  /skills               List skill packs (builtin forge-* · .forge/skills · .cursor/skills · ~/.forge/skills)  [live]
  /commands             List project/user custom slash templates (.forge/commands · .cursor/commands)  [live]
  /quit                 Exit  [live — aborts run then exits]

Tips
────
  Unknown /cmd typos suggest closest commands (e.g. /exprot → /export).
  Catalog typos: /model grok-45 · /effort medum · /permissions aceptEdits · /sessions prun.

Status (always on — no second panel)
────────────────────────────────────
  Bottom dock     Model · auth · ctx · plan use% · reset · ULW/GOAL
  Prompt flags    ULW · c=1/0 · GOAL · PLAN/YOLO · VERBOSE · bg:N  (on forge ›)
  While working   Spinner + phase (thinking / tool / compact / harness)
  After each turn Compact footer (ctx · turn tokens · bg · goal)
  /status         Verdict-first HUD · lastErr Next is a slash key
  forge status --watch   Optional external pane / tmux (still available)

Tips
────
  ↑ / ↓           Command history (persisted in ~/.forge/history)
  Ctrl+R / Ctrl+S Reverse / forward incremental history search (esc / ^G cancel)
  Ctrl+← / →      Jump by word (Alt+B / Alt+F)
  Tab             Autocomplete commands and parameters
  /permissions    Modes 1–4 · list|clear|revoke for saved always-allows
  Live controls   While the agent is working you can still type:
                  /cycle 0  ·  /cycle 1  ·  /max-waves N|off  ·  /ulw-off  ·  /goal pause  ·  /status
                  (no need to Ctrl+C first — harness updates apply at next Stop)
  Ctrl+C          Abort the current turn; twice at idle prompt to exit
`.trim();

export function parseHelpTopic(arg: string): HelpTopic | "unknown" {
  const a = String(arg || "").trim().toLowerCase();
  if (!a) return "start";
  if (
    a === "start" ||
    a === "getting-started" ||
    a === "intro" ||
    a === "tour"
  ) {
    return "start";
  }
  if (a === "all" || a === "full" || a === "commands" || a === "list") {
    return "all";
  }
  if (a === "settings" || a === "config" || a === "setup") return "settings";
  if (a === "harness" || a === "ulw" || a === "goal") return "harness";
  if (a === "sessions" || a === "session") return "sessions";
  if (a === "safety" || a === "sandbox" || a === "perms") return "safety";
  return "unknown";
}

export function helpTopicText(topic: HelpTopic): string {
  if (topic === "all") return HELP_ALL;
  if (topic === "settings") return HELP_SETTINGS;
  if (topic === "harness") return HELP_HARNESS;
  if (topic === "sessions") return HELP_SESSIONS;
  if (topic === "safety") return HELP_SAFETY;
  return HELP_START;
}

export type HelpResolveKind = HelpTopic | "unknown" | "search";

export interface HelpCatalogEntry {
  /** Primary slash, e.g. `/budget`. */
  command: string;
  /** Other slashes on the same catalog line (`/status · /hud`). */
  aliases: string[];
  usage: string;
  blurb: string;
}

export interface HelpSearchHit extends HelpCatalogEntry {
  score: number;
}

const HELP_SEARCH_MAX = 8;

function escapeHelpRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blobHasHelpWord(blob: string, q: string): boolean {
  if (q.length < 3) return false;
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeHelpRe(q)}(?:[^a-z0-9]|$)`, "i");
  return re.test(blob);
}

function uniqueSlashes(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const s = n.toLowerCase();
    if (!s.startsWith("/") || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Parenthetical aliases in blurbs: `(/undo)`, `(/again)`, `(/snap)`. */
function blurbAliasSlashes(blurb: string): string[] {
  return [...blurb.matchAll(/\(\/([a-z0-9_?-]+)\)/gi)].map(
    (x) => `/${String(x[1]).toLowerCase()}`,
  );
}

/** One catalog row → command + blurb, or null. */
export function parseHelpCatalogLine(line: string): HelpCatalogEntry | null {
  const t = line.replace(/\s+$/u, "");
  const m = t.match(/^\s+(\/\S[\s\S]*?)\s{2,}(\S.*)$/);
  if (!m) return null;
  const usage = m[1].replace(/\s+/g, " ").trim();
  const blurb = m[2].replace(/\s+\[live\]\s*$/i, "").trim();
  if (!usage.startsWith("/")) return null;
  const fromUsage = [...usage.matchAll(/\/[a-z0-9_?-]+/gi)].map((x) =>
    x[0].toLowerCase(),
  );
  const commands = uniqueSlashes([...fromUsage, ...blurbAliasSlashes(blurb)]);
  if (!commands.length) return null;
  return {
    command: commands[0]!,
    aliases: commands.slice(1),
    usage,
    blurb,
  };
}

/** Dedupe by primary command; keep the longer blurb. Alias names get their own row. */
export function parseHelpCatalog(text: string = HELP_ALL): HelpCatalogEntry[] {
  const byCmd = new Map<string, HelpCatalogEntry>();
  for (const line of text.split("\n")) {
    const e = parseHelpCatalogLine(line);
    if (!e) continue;
    const prev = byCmd.get(e.command);
    if (!prev || e.blurb.length > prev.blurb.length) {
      byCmd.set(e.command, e);
    } else if (e.aliases.length) {
      prev.aliases = uniqueSlashes([...prev.aliases, ...e.aliases]);
    }
  }
  for (const e of [...byCmd.values()]) {
    for (const alias of e.aliases) {
      if (byCmd.has(alias)) continue;
      byCmd.set(alias, {
        command: alias,
        aliases: uniqueSlashes([e.command, ...e.aliases.filter((a) => a !== alias)]),
        usage: alias,
        blurb: e.blurb,
      });
    }
  }
  return [...byCmd.values()];
}

export function scoreHelpEntry(entry: HelpCatalogEntry, q: string): number {
  const query = q.trim().toLowerCase().replace(/^\//, "");
  if (!query) return 0;
  const names = [
    entry.command.slice(1),
    ...entry.aliases.map((a) => a.replace(/^\//, "")),
  ];
  if (entry.command.slice(1) === query) return 110;
  if (names.some((n) => n === query)) return 100;
  if (names.some((n) => n.startsWith(query))) return 80;
  if (query.length >= 3 && names.some((n) => n.includes(query))) return 60;
  const blob = `${entry.usage} ${entry.blurb}`.toLowerCase();
  if (blobHasHelpWord(blob, query)) return 40 + Math.min(15, query.length);
  return 0;
}

/**
 * Rank catalog rows for a job word (`budget`, `spend`, `/undo`).
 * Typos fall through to suggestName on command names.
 */
export function searchHelpCatalog(
  query: string,
  opts?: { max?: number; catalog?: HelpCatalogEntry[] },
): HelpSearchHit[] {
  const q = String(query || "")
    .trim()
    .toLowerCase()
    .replace(/^\//, "");
  if (!q) return [];
  const entries = opts?.catalog ?? parseHelpCatalog();
  const max = Math.max(1, opts?.max ?? HELP_SEARCH_MAX);
  const scored = entries
    .map((e) => ({ ...e, score: scoreHelpEntry(e, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.command.localeCompare(b.command));
  const seenBlurb = new Set<string>();
  const deduped: HelpSearchHit[] = [];
  for (const h of scored) {
    const key = h.blurb || h.command;
    if (seenBlurb.has(key)) continue;
    seenBlurb.add(key);
    deduped.push(h);
  }
  if (deduped.length) return deduped.slice(0, max);

  const names = [
    ...new Set(
      entries.flatMap((e) => [
        e.command.slice(1),
        ...e.aliases.map((a) => a.replace(/^\//, "")),
      ]),
    ),
  ];
  // Prefix gate on: "nope" must not become /done (d=2, shared vowel).
  const tip = suggestName(q, names, {
    minLength: 4,
    minScore: 38,
    requirePrefix3: true,
  });
  if (!tip) return [];
  const hit = entries.find(
    (e) => e.command === `/${tip}` || e.aliases.includes(`/${tip}`),
  );
  return hit ? [{ ...hit, score: 35 }] : [];
}

export function formatHelpSearchEmpty(
  query: string,
  opts?: { topicTip?: string },
): string {
  const q = String(query || "").trim() || "that";
  const lines = [`No help for “${q}”.`];
  if (opts?.topicTip) {
    lines.push(`Did you mean /help ${opts.topicTip}?`);
  }
  lines.push(
    `Try a command word (budget, undo, notify)  ·  /help  ·  /help all`,
  );
  return lines.join("\n");
}

export function formatHelpSearchCard(
  query: string,
  hits: readonly HelpCatalogEntry[],
  opts?: { columns?: number; topicTip?: string },
): string {
  const q = String(query || "").trim();
  if (!hits.length) {
    return formatHelpSearchEmpty(q, { topicTip: opts?.topicTip });
  }
  const cols = Math.max(
    24,
    opts?.columns ??
      (process.stdout.isTTY ? process.stdout.columns || 80 : 80),
  );
  const cmdWidth = Math.min(
    18,
    Math.max(10, ...hits.map((h) => h.command.length)),
  );
  const lines = [`Help  ·  “${q}”`, "───────────────"];
  for (const h of hits) {
    const pad = Math.max(1, cmdWidth - h.command.length + 2);
    const row = `  ${h.command}${" ".repeat(pad)}${h.blurb}`;
    lines.push(visibleWidth(row) <= cols ? row : clipAnsi(row, cols));
  }
  if (opts?.topicTip) {
    lines.push(`Also a topic: /help ${opts.topicTip}`);
  }
  lines.push("");
  lines.push(
    `More  /help  ·  /help all  ·  topics: ${HELP_TOPICS.join(" · ")}`,
  );
  return lines.join("\n");
}

export function helpFor(arg: string): { topic: HelpResolveKind; text: string } {
  const startKey = parseHelpStartKey(arg);
  if (startKey != null) {
    return {
      topic: "start",
      text: formatHelpStartItem(startKey) || formatHelpStartCard(),
    };
  }
  const topic = parseHelpTopic(arg);
  if (topic !== "unknown") {
    return { topic, text: helpTopicText(topic) };
  }
  const raw = String(arg || "").trim();
  const q = raw.replace(/^\//, "");
  const topicTip = suggestName(q, [...HELP_TOPICS], {
    minLength: 3,
    minScore: 36,
    requirePrefix3: false,
  });
  const hits = searchHelpCatalog(q);
  const strongHits = hits.filter((h) => h.score >= 80);
  // Topic typo wins over weak/typo command hits (`setings` → settings).
  if (!strongHits.length && topicTip) {
    return {
      topic: topicTip as HelpTopic,
      text:
        `Showing ${topicTip} (not “${raw}”).\n\n` +
        helpTopicText(topicTip as HelpTopic),
    };
  }
  if (!hits.length) {
    return {
      topic: "unknown",
      text: formatHelpSearchEmpty(raw, {
        topicTip: topicTip ?? undefined,
      }),
    };
  }
  return {
    topic: "search",
    text: formatHelpSearchCard(raw, hits),
  };
}

/** @deprecated use helpFor("") — kept so existing HELP_TEXT imports still work. */
export const HELP_TEXT = HELP_START;
