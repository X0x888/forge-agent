# Forge

**Forge** is an open-source AI coding agent CLI with a **first-class harness** — the control plane that other tools partially implement.

> **v0.9.0** — **Production reliability**: Retry-After backoff, abortable streams + bash, JSON tool-arg repair, orphan tool_call heal, `finish_reason=length` continue, context-overflow→compact, OAuth refresh (start + mid-run 401), doom-loop detection, session locks + `meta.json` sidecar + prune, `forge doctor --json` / `completion` / `npm run smoke`. Builds on v0.8 Bar A daily-driver safety + harness (blocking Stop, `/goal`, ULW).

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
| Stream/tool **self-heal** (JSON repair, orphan tools, doom-loop) | partial | partial | partial | ✅ |

> **Why this exists:** Grok Build has hooks, but `Stop` cannot block the agent. Harnesses that depend on “don’t stop until tests pass” or Codex-style `/goal` simply don’t work there. Forge implements those semantics natively.

---

## Install

```bash
cd CLI
npm install
npm run build
npm link          # puts `forge` on your PATH
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
# 1. Auth — API key (always works)
export XAI_API_KEY=xai-...          # or ANTHROPIC_API_KEY / OPENAI_API_KEY / …
# or:
forge login --provider xai --api-key

# OAuth / subscription when the provider exposes it:
forge login --provider xai --oauth
forge login --provider openai --device   # headless device code

# 2. Init project scaffolding (config, example Stop hook, AGENTS.md)
forge init

# 3. Interactive REPL
forge

# 4. Headless / CI
forge run "add a healthcheck endpoint and tests" --ulw --permission-mode acceptEdits
```

---

## Authentication

Forge supports **both API keys and subscription/OAuth** where providers allow public client flows.

| Method | How | Notes |
|---|---|---|
| **API key** | `XAI_API_KEY` / `forge login --api-key` | CI-friendly; always available |
| **OAuth (browser)** | `forge login --oauth` | xAI, OpenAI when client id is accepted |
| **Device code** | `forge login --device` | Headless SSH / remote |
| **Stored session** | `~/.forge/auth.json` (mode `0600`) | Auto-used when env key absent |

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

```text
/ulw improve the code          # cycle=1 even for weak prompts
/cycle 0                       # you're satisfied — finish this wave
/cycle 1                       # resume relentless loops
/ulw-off
```

See [docs/ULW.md](docs/ULW.md).

### 4. Production reliability (v0.9)

Forge is built for long expert sessions and CI, not just demos:

- **Retry-After** backoff on `429`/`5xx`; provider wall-clock timeout (default 5m, `FORGE_PROVIDER_TIMEOUT_MS`)
- **Abortable** streams + sandboxed bash (Ctrl+C actually stops work)
- **Self-heal**: truncated JSON tool args, orphaned `tool_call` pairs after abort/compact, empty/`length` model turns
- **Doom-loop** detection when the same tool+args repeat
- **OAuth refresh** at start and once mid-run on `401`
- **Session locks** so two REPLs don’t thrash the same `session.json`
- Accurate **stream token usage** for `/cost`

Full contract: [docs/RELIABILITY.md](docs/RELIABILITY.md) · expert checklist: [docs/PRODUCTION.md](docs/PRODUCTION.md) · release notes: [CHANGELOG.md](CHANGELOG.md)

---

## Slash commands

| Command | Action |
|---|---|
| `/help` | Help |
| `/goal …` | Goal lifecycle |
| `/ulw [task]` | ULW + cycle=1 (soft prompts OK) |
| `/cycle 1` / `0` | Continue waves / last wave then stop |
| `/ulw-off` | Disarm ULW + cycle |
| `/hooks` | List hooks |
| `/status` · `/hud` | Full inline HUD + session detail (no second panel) |
| `/tasks` | Background shell tasks (running / recent) |
| `/context` | Context window bar |
| `/cost` | Token usage + rough $ |
| `/todos` | Agent todos |
| `/model <id> [effort]` | Switch model; optional `low`\|`medium`\|`high` (persists) |
| `/effort [level]` | Reasoning effort for models that support it (e.g. grok-4.5) |
| `/permissions <mode>` | `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` (persists) |
| `/compact` | Compact history |
| `/rewind [n]` | Undo last n turns |
| `/export [path]` | Export session markdown |
| `/copy` | Clipboard last reply |
| `/new` / `/clear` | Fresh or wipe conversation |
| `/resume [id]` | Resume by id/prefix |
| `/sessions` | List sessions · `delete <id>` · `prune` |
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

Tab completes slash commands. While the agent is working you can still run **live controls** (`/cycle 0`, `/cycle 1`, `/ulw-off`, `/goal pause`, `/status`, …) without aborting — harness state updates apply at the next model step. **Free-text** mid-run is queued as an interjection (Grok-style) for the next LLM call. **Ctrl+C** aborts the current agent turn (again at idle prompt to exit).

---

## Configuration

`~/.forge/config.toml` and/or `.forge/config.toml`:

```toml
provider = "xai"
model = "grok-4.5"
reasoning_effort = "high"   # low | medium | high (grok-4.5+)
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

Built-in agent tools: `bash`, `read_file`, `write_file`, `search_replace`, `grep`, `glob`, `todo_write`.

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
- **OpenCode** — multi-provider, `/connect`-style login, project `AGENTS.md`  
- **Grok Build** — auth shapes, slash surface, compat hooks (plus the Stop gap we close)  
- **oh-my-claude** — ultrawork, goal auto-arm, stop-guard composition  

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
