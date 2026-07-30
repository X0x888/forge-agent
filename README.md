# Forge

**Forge** is an open-source AI coding agent CLI with a **first-class harness** — the control plane that other tools partially implement.

> **v0.9.38** — **`/plan` ↔ `/build`** (session-scoped design mode), **project custom slash** (`.forge/commands`), **headless slash** (`forge run "/plan"`), **provider recovery tips**, multi-source **AGENTS/CLAUDE/cursor** rules, live **`/model`**, smarter session titles, **`/news` Unreleased**. Builds on **v0.9.5** SuperGrok OIDC, file-aware `/undo`, `/init`, `/review`, `/compact-and`, `/logs`, export `0600`. Still includes Retry-After, doom-loop + error-streak, **apply_patch**, session lock + auto-resume, structured **`doctor --json`**, `npm run smoke`. Harness: blocking Stop, `/goal`, ULW.

Key capability comparison:

| Capability | Claude Code | Codex | Grok Build | **Forge** |
|---|---|---|---|---|
| Blocking **Stop** hooks (force agent to keep working) | ✅ | partial | ❌ passive only | ✅ |
| **`/goal`** relentless driver | via plugins | ✅ | ❌ | ✅ |
| Ultrawork / no-defer autonomy mode | via oh-my-claude | — | limited | ✅ |
| API key auth | ✅ | ✅ | ✅ | ✅ |
| OAuth / subscription (where provider allows) | ✅ | ✅ | ✅ | ✅ |
| OAuth **refresh** + long-session auth | ✅ | ✅ | partial | ✅ |
| Multi-provider (xAI, Anthropic, OpenAI, OpenRouter, Google) | limited | limited | xAI-first | ✅ |
| Claude / Cursor hook compatibility | n/a | — | ✅ | ✅ |
| Stream/tool **self-heal** (JSON repair, orphan tools, doom-loop, error-streak, empty-SSE) | partial | partial | partial | ✅ |
| Multi-file **apply_patch** + atomic writes + **file-aware undo** | partial | ✅ | partial | ✅ |
| Headless **session resume** + file lock | partial | partial | partial | ✅ |
| Interactive **same-cwd auto-resume** + `/title` / `/bell` | partial | ✅ continue | — | ✅ |

> **Why this exists:** Grok Build has hooks, but `Stop` cannot block the agent. Harnesses that depend on “don’t stop until tests pass” or Codex-style `/goal` simply don’t work there. Forge implements those semantics natively.

---

## Install

```bash
git clone https://github.com/X0x888/forge-agent.git
cd forge-agent
npm install
npm run build
npm link          # puts `forge` on your PATH
# or: ./install.sh
eval "$(forge completion bash)"   # optional
```

Or run without linking:

```bash
npx tsx src/cli.ts
```

Requirements: **Node.js 20+**

---

## Quick start

```bash
# 1. Auth — SuperGrok subscription (browser OIDC, default for xai)
forge login                         # opens browser → SuperGrok / X Premium
forge login --device                # headless / SSH device code
forge login --from-grok             # reuse existing Grok Build ~/.grok session
forge login --from-copilot          # reuse local GitHub Copilot CLI / VS Code session
forge login -p copilot              # same: local import, then GitHub device code
# or API key (CI / multi-day unattended):
export XAI_API_KEY=xai-...          # or: forge login --api-key
forge login --provider openai --device

# 2. Init project scaffolding (config, example Stop hook, AGENTS.md)
forge init

# 3. Interactive REPL (resumes newest same-cwd session ≤14d; --new for fresh)
forge
forge --new

# 4. Headless / CI
forge doctor --json                 # exit 1 if unhealthy (auth, Blocking Stop, 0600 files, …)
forge run "add a healthcheck endpoint and tests" \
  --ulw --permission-mode acceptEdits --sandbox workspace --json
# Multi-step CI: resume the same session (exit 0/1/124/130 — see forge run --help)
forge run "continue from last failure" --session <id> --json
forge run "next step" --continue --json            # newest same-cwd session (no id copy)
forge run "ship it" --title ci-pipeline-42 --json   # label + searchable via sessions list -q
# Resume by title too: forge --session ci-pipeline-42  ·  /resume ci-pipeline-42
# Relabel later: forge sessions title <id> my long label  ·  /title in REPL
```

Bare interactive `forge` continues your latest workspace session (OpenCode-style). Use `forge --new`, `/new`, or `FORGE_NO_AUTO_RESUME=1` for a clean slate. Headless starts fresh unless you pass `--session <id|title>` or `--continue` (newest same-cwd) — works on both `forge run "…"` and bare `forge "…"` (e.g. `FORGE_HEADLESS=1 forge "next" --continue`). Bare `forge "…" --json` emits the same structured payload as `forge run --json` (forces headless even on a TTY).

---

## Authentication

Forge supports **both API keys and subscription/OAuth** where providers allow public client flows.

| Method | How | Notes |
|---|---|---|
| **SuperGrok OIDC (browser)** | `forge login` / `--oauth` | Native xAI OIDC (public Grok CLI client); SuperGrok / X Premium subscription |
| **SuperGrok device code** | `forge login --device` | Headless SSH / remote |
| **Import Grok Build** | `forge login --from-grok` | Copy live `~/.grok/auth.json` session |
| **Local GitHub Copilot** | `forge login --from-copilot` / `-p copilot` | Import Copilot CLI keychain or VS Code `~/.config/github-copilot/apps.json` |
| **Copilot device code** | `forge login -p copilot --device` | GitHub device flow when no local session |
| **API key** | `XAI_API_KEY` / `forge login --api-key` | CI / multi-day unattended |
| **Stored session** | `~/.forge/auth.json` (mode `0600`) | Auto-used when env key absent; OAuth refresh when possible |

Precedence when resolving credentials:

1. Environment API key for the active provider  
2. Stored OAuth / subscription token (if not expired)  
3. Stored API key  
4. Any other known provider env key (auto-detect)

```bash
forge auth          # status
forge logout        # clear all
forge logout -p xai
```

---

## The harness

### 1. Blocking Stop hooks (Claude Code parity)

Unlike Grok Build, Forge’s `Stop` event can **prevent the agent from finishing** and inject continuation instructions.

**Exit code 2** or JSON `{"decision":"block","reason":"..."}` → agent keeps working.

```json
// ~/.forge/hooks/stop-tests.json  or  .forge/hooks/stop-tests.json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ./hooks/examples/block-if-tests-fail.mjs",
            "timeout": 120
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          {
            "type": "command",
            "command": "your-safety-check.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

| Event | Blocking? |
|---|---|
| `PreToolUse` | Yes — deny tool |
| **`Stop`** | **Yes — force continue** |
| `SubagentStop` | Yes |
| `PostToolUse`, `SessionStart`, … | No (observe / inject) |

Also loads Claude (`~/.claude/settings.json`) and Cursor (`~/.cursor/hooks.json`) hook configs when enabled (default on).

Disable blocking Stop (Grok-compatible passive mode):

```bash
forge --no-blocking-stop
# or FORGE_BLOCKING_STOP=0
```

### 2. `/goal` relentless driver (Codex port)

```text
/goal migrate this package to TypeScript and make the full test suite pass
/goal                 # status
/goal pause
/goal resume
/goal clear
/goal done            # user lifecycle only
```

While a goal is active:

1. Every time the model tries to stop, the harness **blocks Stop** and re-injects the objective + acceptance criteria.
2. Release only when the model attests **`**Goal achieved.**`** (after real work), or the **stuck-wall** fires (default: 3 consecutive Stop attempts with no file edits).
3. Arming `/goal` also enables ultrawork mode for that session.

CLI equivalent:

```bash
forge --goal "ship feature X with tests green"
forge run "continue" --goal "…"
```

Auto-arm from prose (default on): prompts like `don't stop until tests pass` or `goal: …` arm the same driver.

### 3. Ultrawork cycle (`/ulw` + `/cycle`)

Max-autonomy **relentless loop**. Soft prompts like `improve the code` are expanded to god-scope (research → waves → serendipity → review → repeat).

| Flag | Meaning |
|------|---------|
| **`cycle=1`** (default on `/ulw`) | Keep going — Stop is blocked between waves |
| **`cycle=0`** | Last wave — finish current work, attest `**Cycle complete.**`, then Stop |
| **`max_waves=N`** (optional) | Cap waves; auto LAST when wave hits N (default unlimited) |

```text
/ulw improve the code          # cycle=1 even for weak prompts
/max-waves 3                   # optional cap (live mid-run too)
/cycle 0                       # you're satisfied — finish this wave
/cycle 1                       # resume relentless loops
/ulw-off
```

CLI: `forge --ulw --max-waves 5 "harden the CLI"` · `forge run "…" --ulw --max-waves 3`

See [docs/ULW.md](docs/ULW.md).

### 4. Production reliability (v0.9.3+) + expert UX (v0.9.5)

Forge is built for long expert sessions and CI, not just demos:

- **Retry-After** backoff on `429`/`5xx`; provider wall-clock timeout (default 5m, `FORGE_PROVIDER_TIMEOUT_MS`)
- **Abortable** streams + sandboxed bash (Ctrl+C actually stops work)
- **Self-heal**: truncated JSON tool args, orphaned `tool_call` pairs after abort/compact, empty/`length` model turns
- **Doom-loop** + **error-streak** circuit breakers (identical args ×3; any errors ×5)
- **`apply_patch`** multi-file edits + **atomic** file writes
- **OAuth refresh** at start and once mid-run on `401`
- **Session locks** (headless fail-closed; optional `FORGE_FORCE_SESSION_LOCK=1`), fork/export/import (export mode `0600`), crash tmp recovery, lock-safe prune/delete, **metrics.jsonl**
- **Stream-capped** `web_fetch` / search HTML bodies; **grep/glob** external-directory gate
- **`forge run --session <id|title>`** and **`--continue`** for multi-step headless CI without copying UUIDs
- **Expert orientation**: `/last` · `/files` · `/path` · `/pin` · `/share` · `/undo` (disk+chat) · `/init` · `/review` · `/compact-and` · `/retry` · `forge stats` · `forge news`
- **Tunable bash timeouts**: `FORGE_BASH_TIMEOUT_MS` / `FORGE_BASH_BG_TIMEOUT_MS` (surfaced in `forge doctor --json`)
- Accurate **stream token usage** for `/cost`; optional `FORGE_PERMISSION_TIMEOUT_MS`

Full contract: [docs/RELIABILITY.md](docs/RELIABILITY.md) · expert checklist: [docs/PRODUCTION.md](docs/PRODUCTION.md) · release notes: [CHANGELOG.md](CHANGELOG.md)

---

## Slash commands

| Command | Action |
|---|---|
| `/help` | Help |
| `/goal …` | Goal lifecycle |
| `/ulw [task]` | ULW + cycle=1 (soft prompts OK) |
| `/cycle 1` / `0` | Continue waves / last wave then stop |
| `/max-waves N\|off` | Cap ULW waves (auto LAST at N); default unlimited |
| `/ulw-off` | Disarm ULW + cycle |
| `/hooks` | List hooks |
| `/status` · `/hud` | Full inline HUD + session detail (no second panel) |
| `/tasks` | Background shell tasks (running / recent) |
| `/context` | Context window bar |
| `/cost` | Token usage + rough $ |
| `/metrics` | Local metrics.jsonl + session counters |
| `/stats [days]` | Usage dashboard (runs/tokens/cost/projects) · CLI: `forge stats` |
| `/share` | Pasteable session card + resume/export commands (clipboard) |
| `/tips` | Expert cheat sheet · CLI: `forge tips` |
| `/todos` | Agent todos |
| `/model <id> [effort]` | Switch model mid-run; optional `low`\|`medium`\|`high` (persists) **[live]** |
| `/effort [level]` | Reasoning effort for models that support it (e.g. grok-4.5) **[live]** |
| `/plan [focus]` | Session-scoped PLAN mode (read-only design; no sticky prefs) **[live]** |
| `/build [note]` | Leave plan → restore prior mode and implement (`/execute`) **[live]** |
| `/commands` | List project/user custom slash templates (`.forge/commands/*.md`) |
| `/permissions <mode>` | Sticky prefs: `default` \| `acceptEdits` \| `plan` \| `bypassPermissions`; `plan`/`build` aliases; `list`/`clear`/`revoke` always-allows |
| `/compact` | Compact history |
| `/compact-and <prompt>` | Compact then continue with follow-up (Warp-style) |
| `/fork-and-compact [prompt]` | Fork, compact the fork, optional continue (original kept) |
| `/init [focus]` | Guided `AGENTS.md` setup / improve (OpenCode-style) |
| `/review [target]` | Code review: uncommitted (default) · staged · commit · branch · PR |
| `/rewind [n]` | Undo last n turns **+ restore journaled files** (`/undo`) |
| `/retry [prompt]` | Rewind last turn (+ disk) + re-run (`/again`; optional rewrite) |
| `/files [writes\|n]` | Paths touched by tools this session (newest first; live-safe) |
| `/path [id\|json]` | On-disk session directory / `session.json` (live-safe; CLI: `sessions path`) |
| `/pin` / `/unpin` | Protect session from prune (lists show `PIN`; live-safe) |
| `/done [note]` | Shorthand for `/goal done` (live-safe mid-run) |
| `/pause` | Shorthand for `/goal pause` (live-safe mid-run) |
| `/unpause` | Shorthand for `/goal resume` (live-safe; not session `/resume`) |
| `/last [n]` | Peek last n user/assistant turns (live-safe; great after resume) |
| `/news [n]` | What's new from CHANGELOG (`/changelog` · CLI: `forge news`) |
| `/export [path] [--json]` | Export session markdown or JSON (files mode `0600`) |
| `/fork [title]` | Branch session into a new id |
| `/title [name\|clear]` | Show / set / clear session title (`/rename`) |
| `/bell [on\|off\|test]` | Terminal BEL when a turn ends (long-run attention) |
| `/diff [path]` | Git status + diff (live-safe; argv + filter allowlist — no shell injection) |
| `/logs [n\|path]` | Tail sandbox/safety events (`forge logs`; live-safe; no secrets) |
| `/config [json]` | Effective config snapshot (live-safe; no secrets) · CLI: `forge config` |
| `/copy` | Clipboard last reply (pbcopy/wl-copy/xclip/…; live-safe) |
| `/new [title]` | Fresh session (optional label; **does not** inherit ULW — re-arm with `/ulw`) |
| `/clear` · `/clear hard` | Soft: wipe msgs/counters/journal same id · Hard: new session id |
| `/resume [id\|title]` | Resume by id prefix or unique `/title` (lists show relative ages + last prompt) |
| `/sessions` | List (same-cwd) · `all` · `pinned` · `search <q>` · `delete [--force]` · `prune` (CLI: `list --cwd`/`-q`/`--pinned`, `show`/`export`/`import`/`fork`/`pin`) |
| `/doctor` | Env health check |
| `/quit` | Exit |

### Status (inline — no second panel required)

Status is **built into the REPL**:

- **Prompt strip** — context %, tokens, todos, `bg:N`, liveness above every prompt
- **Working indicator** — spinner + phase (`thinking` / `tool` / `compact` / `harness`) while the agent runs
- **Turn footer** — compact ctx / turn cost / bg summary after each turn
- **`/status`** — full two-line HUD + session details when you want more

Optional external pane / tmux still works:

```bash
forge status              # one-shot
forge status --watch      # optional live second pane
forge status --tmux       # for tmux status-right
```

Works for **any** auth method: always shows session context/tokens/git/liveness/activity; plan credits only when the provider exposes them (e.g. SuperGrok via imported Grok session). See [docs/STATUSLINE.md](docs/STATUSLINE.md).

Tab completes slash commands (including project `.forge/commands`). While the agent is working you can still run **live controls** (`/cycle 0`, `/cycle 1`, `/max-waves N|off`, `/ulw-off`, `/plan`, `/build`, `/model`, `/pause`, `/unpause`, `/done`, `/status`, …) without aborting — harness state updates apply at the next model step. **Free-text** mid-run is queued as an interjection (Grok-style) for the next LLM call. **Ctrl+C** aborts the current agent turn (again at idle prompt to exit).

Headless CI can run slash prompts too: `forge run "/plan"` · `forge run "/commands"` · custom templates expand then run (`reason: "slash"` when no model call). Starter templates: `examples/forge-commands/`.

---

## Configuration

`~/.forge/config.toml` and/or `.forge/config.toml`:

```toml
provider = "xai"
model = "grok-4.5"
reasoning_effort = "high"   # low | medium | high (grok-4.5+)
max_turns = 0               # 0 = unlimited; set e.g. 200 to cap agent turns
permission_mode = "default"
blocking_stop_hooks = true

[goal]
enabled = true
stuck_threshold = 3
auto_arm = true
```

Interactive `/model`, `/effort`, and `/permissions` choices are saved to `~/.forge/preferences.json` and apply on every new session (any folder). Precedence: defaults → global config → project config → **preferences** → env → CLI flags. Env/`-m`/`--effort`/`--permission-mode` still win for one-shot overrides. `/resume` still restores that session’s model for the resumed conversation.

Environment:

| Variable | Meaning |
|---|---|
| `XAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / … | Provider keys |
| `FORGE_HOME` | Config root (default `~/.forge`) |
| `FORGE_MODEL` / `FORGE_PROVIDER` / `FORGE_BASE_URL` | Overrides |
| `FORGE_EFFORT` / `FORGE_REASONING_EFFORT` | `low` \| `medium` \| `high` |
| `FORGE_BLOCKING_STOP=0` | Passive Stop blocks |
| `FORGE_GOAL_STUCK_THRESHOLD` | Stuck-wall N |
| `FORGE_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

---

## Tools

Built-in agent tools: `bash`, `read_file`, `write_file`, `search_replace`, `apply_patch`, `grep`, `glob`, `list_dir`, `todo_write`, `web_search`, `web_fetch`, plus background task helpers. See [docs/TOOLS.md](docs/TOOLS.md).

Project instructions are loaded from `AGENTS.md`, `FORGE.md`, `CLAUDE.md`, or `.forge/rules.md`.

---

## Architecture

```
src/
  cli.ts              # commander entry (interactive + headless)
  auth/               # API key + OAuth/device + auth.json store
  providers/          # OpenAI-compat + Anthropic Messages
  agent/              # loop, tools, permissions, system prompt
  harness/
    hooks.ts          # Claude-compatible hooks, blocking Stop
    goal.ts           # /goal state machine
    stop-guard.ts     # composes hooks + goal + ultrawork
  session/            # durable sessions under ~/.forge/sessions
  commands/slash.ts   # /goal /ulw /hooks …
  tui/repl.ts         # interactive readline REPL
```

**Agent loop:** model → tools → (repeat) → **Stop guard** → either finish or inject re-anchor and continue.

---

## Learn from / ported ideas

- **Claude Code** — hook event model, exit code 2, PreToolUse deny, blocking Stop  
- **Codex** — `/goal` lifecycle, plan→act→verify loop, stuck-wall escape  
- **OpenCode** — multi-provider, `/connect`-style login, project `AGENTS.md`, `/plan`↔`/build`, custom commands, instruction walk-up  
- **Grok Build** — auth shapes, slash surface, compat hooks (plus the Stop gap we close)  
- **oh-my-claude** — ultrawork, goal auto-arm, stop-guard composition  
- **Warp** — `/compact-and`, agent workflow polish  

---

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev        # tsx src/cli.ts
```

---

## License

MIT
