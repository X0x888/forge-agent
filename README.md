# Forge

**Forge** is an open-source AI coding agent CLI with a **first-class harness** — the control plane that other tools partially implement.

> **v0.7.1** — **Tool quality**: realpath containment, secret env scrub, ripgrep grep, managed truncation, fuzzy edits (line-trim + block-anchor), **`web_fetch` + SSRF**, **background bash** (`get_task_output` / `kill_task`). Plus **v0.6 safety stack** and harness (blocking Stop, `/goal`, ULW).

Key capability comparison:

| Capability | Claude Code | Codex | Grok Build | **Forge** |
|---|---|---|---|---|
| Blocking **Stop** hooks (force agent to keep working) | ✅ | partial | ❌ passive only | ✅ |
| **`/goal`** relentless driver | via plugins | ✅ | ❌ | ✅ |
| Ultrawork / no-defer autonomy mode | via oh-my-claude | — | limited | ✅ |
| API key auth | ✅ | ✅ | ✅ | ✅ |
| OAuth / subscription (where provider allows) | ✅ | ✅ | ✅ | ✅ |
| Multi-provider (xAI, Anthropic, OpenAI, OpenRouter, Google) | limited | limited | xAI-first | ✅ |
| Claude / Cursor hook compatibility | n/a | — | ✅ | ✅ |

> **Why this exists:** Grok Build has hooks, but `Stop` cannot block the agent. Harnesses that depend on “don’t stop until tests pass” or Codex-style `/goal` simply don’t work there. Forge implements those semantics natively.

---

## Install

```bash
cd CLI
npm install
npm run build
npm link          # puts `forge` on your PATH
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
| `/status` | Session / auth / goal |
| `/context` | Context window bar |
| `/cost` | Token usage + rough $ |
| `/todos` | Agent todos |
| `/model <id>` | Switch model |
| `/permissions <mode>` | `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` |
| `/compact` | Compact history |
| `/rewind [n]` | Undo last n turns |
| `/export [path]` | Export session markdown |
| `/copy` | Clipboard last reply |
| `/new` / `/clear` | Fresh or wipe conversation |
| `/resume [id]` | Resume by id/prefix |
| `/sessions` | Recent sessions |
| `/doctor` | Env health check |
| `/statusline` / `/hud` | Native statusline snapshot |
| `/quit` | Exit |

### Statusline HUD

```bash
forge status              # one-shot
forge status --watch      # live second pane
forge status --tmux       # for tmux status-right
```

Works for **any** auth method: always shows session context/tokens/git/liveness; plan credits only when the provider exposes them (e.g. SuperGrok via imported Grok session). See [docs/STATUSLINE.md](docs/STATUSLINE.md).

Tab completes slash commands. **Ctrl+C** aborts the current agent run (again to exit).

---

## Configuration

`~/.forge/config.toml` and/or `.forge/config.toml`:

```toml
provider = "xai"
model = "grok-4"
permission_mode = "default"
blocking_stop_hooks = true

[goal]
enabled = true
stuck_threshold = 3
auto_arm = true
```

Environment:

| Variable | Meaning |
|---|---|
| `XAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / … | Provider keys |
| `FORGE_HOME` | Config root (default `~/.forge`) |
| `FORGE_MODEL` / `FORGE_PROVIDER` / `FORGE_BASE_URL` | Overrides |
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
