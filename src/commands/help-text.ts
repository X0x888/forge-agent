/**
 * Grouped /help — first-day start vs full catalog vs topics.
 */

export const HELP_TOPICS = [
  "start",
  "all",
  "settings",
  "harness",
  "sessions",
  "safety",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

export const HELP_START = `
Getting started
───────────────
  Just type a coding task in English.
  /setup              Account, model, budget, notify, project
  /plan [focus]       Read-only design, then /build to implement
  /init               Write a real AGENTS.md for this repo
  /doctor             Health check (auth, sandbox, Stop, files)
  /help start         60-second tour
  /help all           Full command list
  /tips               Expert / CI cheat sheet

Daily
─────
  /model  /provider  /permissions  /budget  /notify  /undo  /commit

Harness (when you want the agent to not stop)
─────────────────────────────────────────────
  /goal <objective>   Relentless driver
  /ulw [task]         Ultrawork cycle (starts working immediately)
  /done               Wind down goal + ULW

Type /help <topic>  (start | all | settings | harness | sessions | safety)

Keys
────
  ↵ sends  ·  ^J newline  ·  ↑↓ history  ·  Tab starters · / Tab all · @path
  !cmd runs a shell now  ·  /paste clipboard image  ·  Ctrl+C abort (twice to quit)
`.trim();

export const HELP_TOUR = `
60-second tour
──────────────
  1. Type what you want in English. Forge edits the repo, runs checks, and shows a Δ summary.
  2. First time here?  /setup  — confirm model, set a spend cap, write AGENTS.md, turn on /notify.
  3. Unsure about the approach?  /plan  (read-only) then  /build  to implement.
  4. Permission prompts are normal in default mode. Enter / y = once. /permissions acceptEdits to skip asks.
  5. Long unattended work:  /budget 5  ·  /notify on  ·  /goal <objective>  or  /ulw <task>.
  6. Recover:  /undo  ·  /retry  ·  /checkpoint  ·  /doctor

  Docs: docs/GETTING-STARTED.md  ·  /tips  ·  /help all
`.trim();

export const HELP_SETTINGS = `
Settings
────────
  /setup              First-day hub (model, budget, notify, AGENTS.md, LSP)
  /config [json]      Effective snapshot (no secrets)
  /provider [name]    Switch provider (sticky)
  /model <name>       Switch model mid-run (sticky)
  /effort [level]     Thinking effort (default = model max)
  /budget [usd|off]   Session spend cap (estimate USD)
  /permissions [mode] default | acceptEdits | plan | bypassPermissions | dontAsk
  /notify [on|off]    Desktop alert when a turn ends
  /bell [on|off]      Terminal BEL when a turn ends
  /format [on|off]    Format-on-write after file tools
  /verbose            REPL diffs + full output (failures always show a tail)
  /fallback [models]  Same-provider fallbacks after 429/5xx
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
  /ulw [task]         Ultrawork + cycle=1 (starts working immediately)
  /cycle 1|0          Continue waves or last wave then stop
  /max-waves N|off    Cap ULW waves (auto LAST at N)
  /done               Wind down: goal done + ULW LAST
  /plan               Session-scoped read-only design
  /build              Leave plan and implement
  /improve [focus]    Continuous-improve on ULW rails

  Live (while working) — type at live › without Ctrl+C:
    /cycle 0  ·  /ulw-off  ·  /budget  ·  /done  ·  /status  ·  free-text queues

  Docs: docs/HARNESS.md  ·  docs/ULW.md
`.trim();

export const HELP_SESSIONS = `
Sessions
────────
  Bare forge resumes the newest same-cwd session (≤14d).  forge --new  for fresh.
  /sessions           List this cwd  ·  search  ·  pinned  ·  delete  ·  prune
  /resume [id|title]  Resume by id prefix or unique title
  /new [title]        Fresh session
  /title [name]       Label for resume-by-title / search
  /pin                Protect from prune
  /share              Pasteable handoff card
  /last [n]           Peek recent turns
  /files              Paths touched this session
  /path               On-disk session directory
  /export             Markdown or JSON (mode 0600)
  /fork               Branch into a new session id
  /undo  /retry       Rewind last turn (+ journaled files)
  /checkpoint         Safety snapshot (/snap)

  CLI: forge sessions list --cwd  ·  -q  ·  prune --keep 50
`.trim();

export const HELP_SAFETY = `
Safety
──────
  Defaults: sandbox=workspace  ·  blocking Stop on  ·  permission_mode=default
            read-outside=ask  ·  missing sandbox backend fail-closed

  /permissions        Modes + saved always-allows
  /plan               Read-only design (no sticky prefs)
  /diff               Git status + diff (argv-safe)
  /logs               Sandbox / safety event tail
  /doctor             Flags YOLO, sandbox=off, mode 0600, Blocking Stop OFF
  /budget             Session spend cap (unlimited until you set one)

  Project .forge/config.toml cannot set YOLO, sandbox=off, or disable Stop.

  Docs: docs/SAFETY.md  ·  docs/PRODUCTION.md
`.trim();

/** Current full catalog (was the only /help). */
export const HELP_ALL = `
Forge slash commands
────────────────────
  /help [topic]         Getting started (default) · all|start|settings|harness|sessions|safety
  /setup [skip|json]    First-day hub: model, budget, notify, AGENTS.md, LSP  [live]
  /goal <objective>     Arm relentless goal driver (Codex-style)
  /goal                 Show goal status  [live]
  /goal pause|resume|clear|done   [live]
  /done [note]          Wind down: /goal done + ULW cycle=0 (LAST)  [live]
  /pause                Shorthand for /goal pause  [live]
  /unpause              Shorthand for /goal resume  [live]
  /improve [focus…]       Continuous-improve (ULW; alias /ralph)
  /ulw [task]           Arm ULW + cycle=1 (soft/broad seeds backlog + decision memory)
  /memory [list|add …]  Session decisions. /memory project … for cross-session.
  /attach <image>       Attach image path for vision ([[image:path]] in next message)
  /paste                Attach clipboard image (pngpaste / osascript / wl-paste / xclip)
  /cycle 1|0|status     Continue waves (1) or last wave then stop (0)  [live]
  /max-waves N|off      Cap ULW waves (auto LAST at N); default unlimited  [live]
  /ulw-off              Disarm ULW + cycle driver  [live]
  /hooks [init|reload]  List/scaffold/reload hooks  [live]
  /status · /hud        Full inline HUD + session details (no second panel)  [live]
  /tasks [kill|log id]  Background shell tasks · kill/log subcommands  [live]
  /mcp [status|connect|tools|reload]  MCP servers (search_mcp · call_mcp)  [live]
  /lsp [status|ensure|install|detect|restart]  Language servers (auto-install TS/Python)  [live]
  /context              Context window usage bar  [live]
  /cost                 Token usage + rough cost + budget  [live]
  /budget [usd|off]     Session spend cap (estimate USD; 0/off = unlimited)  [live]
  /metrics              Local metrics.jsonl + this session counters  [live]
  /stats [days|week]    Usage dashboard (runs/tokens/cost/projects)  [live]
  /todos                Show agent todos  [live]
  /provider [name]      List / switch provider (openrouter, xai, …) — sticky  [live]
  /model <name> [effort] Switch model mid-run; free-form on OpenRouter  [live]
  /fallback [models|off] Same-provider fallbacks after 429/5xx (defaults on)  [live]
  /effort [level]       Thinking effort (default = model max; low…high|xhigh|max)  [live]
  /temperature [0–2]    Session sampling temperature (/temp)  [live]
  /max-tokens [n]       Session max output tokens  [live]
  /context-window [n|auto]  Pin or auto-follow model max context (/ctx-window)  [live]
  /plan [focus]         Session-scoped PLAN mode (read-only design; no sticky prefs)  [live]
  /build [note]         Leave plan → restore prior mode and implement (/execute)  [live]
  /permissions [mode]   Menu if empty; Tab / numbers / aliases (yolo, always…)
                        Sticky prefs · plan|build aliases · list|clear|revoke always-allows
  /compact              Compact conversation
  /compact-and <prompt> Compact then continue with follow-up (Warp-style)
  /fork-and-compact [prompt]  Fork, compact the fork, optional continue (Warp-style)
  /init [focus]         Guided AGENTS.md setup / improve (OpenCode-style)
  /review [target]      Code review: uncommitted|staged|<commit>|<branch>|<pr#>
  /checkpoint [restore] Safety snapshot (/snap)
  /commit [staged] [do] Draft commit message from git diff (do = create commit, no push)
                        Unattended ULW also commits locally on **Cycle complete.** (FORGE_ULW_AUTO_COMMIT=0 off)
  /rewind [n]           Undo last n user turns + restore journaled files (/undo)
  /retry [prompt]       Rewind last turn (+ disk) + re-run (/again; optional rewrite)
  /export [path] [--json]  Export session as markdown or JSON (files mode 0600)
  /fork [title]         Branch session into a new id (keep original)
  /title [name|clear]   Show / set / clear session title (/rename)  [live]
  /bell [on|off|test]   Terminal BEL when a turn ends (long-run attention)  [live]
  /notify [on|off|test] Desktop notify when a turn ends (osascript/notify-send)  [live]
  /format [on|off]      Format-on-write after file tools (prettier/biome/ruff/…)  [live]
  /verbose              Toggle diffs + full output (failures always show a tail)  [live]
  ask_user              Model tool for clarifying questions (not a slash) — interactive; headless fails closed
  /diff [path]          Git status + diff (argv-safe; pathspecs/refs only)  [live]
  !<command>            Run a shell command now (same permissions as bash)  [live]
  /logs [n|0|all|path]  Tail sandbox/safety events (0/all = full window)  [live]
  /config [json]        Effective config snapshot (no secrets)  [live]
  /copy                 Copy last assistant reply (pbcopy/wl-copy/xclip/…)  [live]
  /share [nocopy]       Pasteable session card + resume/export cmds (clipboard)  [live]
  /last [n]             Peek last n user/assistant turns (after resume)  [live]
  /files [writes|n]     Paths touched by tools this session (newest first)  [live]
  /path [id|json]       On-disk session directory / session.json path  [live]
  /pin [on|off|toggle]  Protect session from prune (/unpin)  [live]
  /tips                 Expert keyboard / CI cheat sheet  [live]
  /news [n|all]         What's new from CHANGELOG (/changelog)  [live]
  /new [title]          Fresh session (optional searchable label; ULW not inherited)
  /clear                Clear messages same id (counters+journal reset)
  /clear hard           Brand-new session id (same as /new; ULW not inherited)
  /resume [id|title|all] Resume by id prefix or unique /title (same-cwd picker)
  /sessions [all|search|delete|prune]  List (cwd default) / search / delete [--force] / prune
  /auth                 Show stored credentials (+ multi-account)  [live]
  /accounts [status|switch|…]  Multi-account list/status/switch/clear-cooldown  [live]
  /doctor               Environment health check  [live]
  /skills               List skill packs (builtin forge-* · .forge/skills · ~/.forge/skills)  [live]
  /commands             List project/user custom slash templates (.forge/commands)  [live]
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
  /status         Full two-line HUD + session detail
  forge status --watch   Optional external pane / tmux (still available)

Tips
────
  ↑ / ↓           Command history (persisted in ~/.forge/history)
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

export function helpFor(arg: string): { topic: HelpTopic | "unknown"; text: string } {
  const topic = parseHelpTopic(arg);
  if (topic === "unknown") {
    return {
      topic,
      text:
        `Unknown /help topic "${arg.trim()}".\n` +
        `Topics: ${HELP_TOPICS.join(" · ")}`,
    };
  }
  if (topic === "all") return { topic, text: HELP_ALL };
  if (topic === "settings") return { topic, text: HELP_SETTINGS };
  if (topic === "harness") return { topic, text: HELP_HARNESS };
  if (topic === "sessions") return { topic, text: HELP_SESSIONS };
  if (topic === "safety") return { topic, text: HELP_SAFETY };
  // start: show getting-started; /help start also appends the tour
  const raw = String(arg || "").trim().toLowerCase();
  if (raw === "start" || raw === "tour" || raw === "intro") {
    return { topic: "start", text: `${HELP_START}\n\n${HELP_TOUR}` };
  }
  return { topic: "start", text: HELP_START };
}

/** @deprecated use helpFor("") — kept so existing HELP_TEXT imports still work. */
export const HELP_TEXT = HELP_START;
