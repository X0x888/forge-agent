# Forge statusline

Native, **provider-agnostic** HUD for Forge — integrated into the REPL so you do **not** need a second panel.

```
  xai/grok-4.5  ████░░░░  32%  18.2k ~$0.04  use:22%  27.8k/150.0k  reset 3d  todos:2  ● live
[ULW c=1 GOAL] forge ›
…
⚒ forge  xai/grok-4.5  sub×2  ctx 32% 12.4k/500k  use:22%  27.8k/150.0k  reset 3d  ULW c=1
```

The **bottom status region** is always on in a TTY REPL (model · auth · context ·
active-account quota · weekly reset · harness flags). Disable with
`FORGE_BOTTOM_STATUS=0`.

While the agent works (native live chrome — not idle-only):

```
┌──────────────────────────────────────────────────────────
│ live run  (input stays open — no Ctrl+C needed)
│ xai/grok-4.5 · effort high
│ ULW c=1 w=0 CONTINUE
│ controls: /cycle 0 last · /cycle 1 continue · /ulw-off · /budget · /done · /notify · /status
│ type at the live › line below while the agent works
└──────────────────────────────────────────────────────────
⠋ ⚒ thinking… 12s xai/grok-4.5 high c=1 w=0/2 last=/cycle 0
[ULW c=1] live › _
  ▸ bash command=npm test
  ✓ bash  842ms  1.2KB
── live ✓ applied · /cycle 0 ──
Cycle flag → 0 (LAST) …
live › still open — type another control or wait for the run
[ULW c=0] live › _
```

After each turn:

```
──  ctx 32% (12.4k/128k)  turn in=1.2k out=400 ~$0.01  budget 12% $0.04/$5  todos:2
```

## Project stack (v0.9.97+)

HUD/`forge status` project labels append detected **package manager** + cheapest check
(e.g. `CLI · npm · npm run typecheck`). Nested monorepo packages also show
`mono:<root-basename>`. Status JSON includes top-level and per-session
`packageManager`, `checkCommands`, `projectStackSummary`, `monorepoRoot`.

## Design

| Principle | Behavior |
|-----------|----------|
| **Inline first** | Prompt strip + working spinner + turn footer live in the main REPL |
| **Native** | Reads `~/.forge/sessions/*` + `active_sessions.json` written by this CLI |
| **Generic** | Same layout for xAI, Anthropic, OpenAI/Codex, Copilot, OpenRouter, Google |
| **Honest** | Never invents plan/credit numbers; segments omit when unavailable |
| **Working-aware** | Shows `thinking` / `tool` / `compacting` / `harness` / background tasks |

### Always-on (in REPL)

| Surface | When | Shows |
|---------|------|--------|
| **Bottom status region** | Always (TTY REPL) | Model, auth, ctx %, **use:N%**, used/limit, **reset Nd**, ULW/GOAL/YOLO, bg |
| **Prompt strip** | Only when the dock is off (`FORGE_BOTTOM_STATUS=0` / non-TTY) | Model, context bar, tokens, **plan quota**, todos, `bg:N`, liveness (deduped) |
| **Prompt flags** | Idle input | `ULW`, `c=1/0`, `GOAL`, `PLAN`/`YOLO`/`auto`, `VERBOSE`, `bg:N` |
| **Live run header** | Start of every agent turn | Model, effort, ULW/GOAL, control legend, `live ›` affordance |
| **Busy status line** | Mid-turn (stderr) | Spinner + phase + model + effort + ULW `c=1 w=N/M` + `last=/cycle 0` hint |
| **Stream ticks** | While tokens stream | Newline status every ~10s (no `\r` garble) |
| **`live ›` prompt** | Entire busy turn | Always-open control line; re-shown after tools / harness / slash |
| **Live control ACK** | After mid-run `/cycle` etc. | Clear `live ✓ applied` box + re-prompt |
| **Turn footer** | After every agent turn | Context %, turn tokens/cost, **budget %** (when `/budget` or `--max-cost` armed), todos, bg, harness continues |
| **`/status`** | On demand (also mid-run) | Full 2-line HUD + session detail + bg task list |

### Optional external pane

Still available for tmux / multi-session monitoring — not required for normal use:

```bash
forge status              # one-shot
forge status --watch      # live external pane
forge status --tmux --plain
```

### What always shows (HUD)

- Project path (last 2 segments)
- Git branch / dirty (when in a repo)
- Provider + model
- Auth method shorthand: `sub` | `key` | `oauth`
- Flags: `ULW`, `GOAL`, `PLAN`, `YOLO`, `auto`, `PIN`, `BUDGET:N%` / `BUDGET:HIT` (when spend cap armed), foreign `LOCK:<pid>` when another process holds the session
- Liveness: `◉ working` / `● live` / `○ idle` / `◌ stale`
- Context bar + % + estimated tokens / window
- Session duration, token totals (+ rough $ when rates known)
- **Budget** segment when `/budget` / `--max-cost` / `max_cost_usd` is armed (`budget N% $spent/$cap`)
- Open todos, turn count, edit count
- **Activity** when mid-turn: `thinking…` / `tool:…` / `compacting…`
- **Background tasks**: `bg:N` + command hints; full list under `/tasks`

### What shows when available

| Auth path | Plan / quota segment |
|-----------|----------------------|
| **Grok / xAI subscription** (`forge login` SuperGrok OIDC or `--from-grok`) | Weekly SuperGrok Build usage via `cli-chat-proxy` (`creditUsagePercent` + period end; absolute used/limit from `/v1/billing` when present) |
| **xAI / OpenAI / Anthropic API key** | Session tokens + est. cost only |
| **OpenAI / Codex subscription** | Local rate-limit files under `~/.codex/` if present |
| **GitHub Copilot** | Explicit note: quota not exposed to third-party CLIs |

## Usage

### Inside the REPL (preferred)

```text
# Just use forge — status is already on the prompt
forge

# Full HUD + session detail + background tasks
/status
/hud

# Background shell tasks only
/tasks
```

### CLI

```bash
# One-shot (best matching recent session)
forge status

# Live pane (optional second terminal)
forge status --watch

# Filter
forge status --cwd ~/proj   # native listSessions cwd filter (before limit)
forge status --session abc123
forge status --all

# Machine / tmux
forge status --json
forge status --tmux --plain

# Skip network billing probe
forge status --no-plan
```

### tmux

```tmux
set -g status-right '#(forge status --tmux --plain) | %H:%M'
set -g status-interval 2
```

## Working status & background tasks

The agent loop publishes phase updates:

| Phase | Meaning |
|-------|---------|
| `thinking` | Waiting on / streaming the model |
| `tool` | Running a tool (name + short arg) |
| `compacting` | Auto-compacting context |
| `stop_guard` | Harness Stop evaluation (goal / ULW / hooks) |
| `waiting` | Snapshot-only: agent idle but background shells still running (prompt shows `bg:N`) |

Background bash (`background: true`) is tracked in-process:

- Prompt shows `bg:N` while any task is running
- Heartbeats write `busy` / `phase` / `bgRunning` to `active_sessions.json`
- External `forge status --watch` therefore shows **working**, not only live
- `/tasks` lists id, status, elapsed, command

## vs grok-statusline

| | grok-statusline | forge status |
|--|-----------------|--------------|
| Target CLI | Grok Build | Forge |
| Session source | `~/.grok/` | `~/.forge/sessions/` |
| In-REPL integration | External reader only | **Built into prompt / spinner / footer** |
| Multi-provider | Grok-centric | Built for multi-auth |
| Working phase | Limited | thinking / tool / harness / bg |
| SuperGrok credits | Yes | Yes when xAI sub auth available |

They can coexist: use `grok-statusline` while in Grok Build; use Forge’s inline HUD while in Forge.
