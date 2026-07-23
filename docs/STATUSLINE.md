# Forge statusline

Native, **provider-agnostic** HUD for Forge — not a Grok-only reader of `~/.grok/` artifacts.

```
my-app  git:main*  xai/grok-4  sub  ULW  GOAL  ● live
████░░░░░░░░  32% (12.4k/128k)  9m 45s  tok:18.2k ~$0.04  use:12%  1.2k left  reset 6d  todos:2
```

## Design

| Principle | Behavior |
|-----------|----------|
| **Native** | Reads `~/.forge/sessions/*` + `active_sessions.json` written by this CLI |
| **Generic** | Same layout for xAI, Anthropic, OpenAI/Codex, Copilot, OpenRouter, Google |
| **Honest** | Never invents plan/credit numbers; segments omit when unavailable |
| **Always useful** | Context bar, tokens, git, model, liveness work for every auth path |

### What always shows

- Project path (last 2 segments)
- Git branch / dirty (when in a repo)
- Provider + model
- Auth method shorthand: `sub` | `key` | `oauth`
- Flags: `ULW`, `GOAL`, `PLAN`
- Liveness: `● live` / `○ idle` / `◌ stale`
- Context bar + % + estimated tokens / window
- Session duration
- Session token totals (+ rough $ when rates known)
- Open todos, turn count

### What shows when available

| Auth path | Plan / quota segment |
|-----------|----------------------|
| **Grok / xAI subscription** (`forge login --from-grok`) | Best-effort SuperGrok credits via Grok billing proxy (`use:N%`, remaining, reset) |
| **xAI API key** | No credits bar — session tokens + est. cost only |
| **OpenAI API key** | Session tokens + est. cost |
| **OpenAI / Codex subscription** | Local rate-limit files under `~/.codex/` if present; else note only |
| **GitHub Copilot** | Explicit note: quota not exposed to third-party CLIs |
| **Anthropic / OpenRouter / Google keys** | Session tokens + est. cost |

## Usage

```bash
# One-shot (best matching recent session)
forge status

# Live pane (second terminal) — like grok-statusline --watch
forge status --watch

# Filter
forge status --cwd ~/proj
forge status --session abc123
forge status --all

# Machine / tmux
forge status --json
forge status --tmux --plain

# Skip network billing probe
forge status --no-plan
```

In the REPL:

```text
/statusline
/hud
```

### tmux

```tmux
set -g status-right '#(forge status --tmux --plain) | %H:%M'
set -g status-interval 2
```

### Side-by-side

```bash
# pane 1
forge

# pane 2
forge status --watch --cwd "$(pwd)"
```

## vs grok-statusline

| | grok-statusline | forge status |
|--|-----------------|--------------|
| Target CLI | Grok Build | Forge |
| Session source | `~/.grok/` | `~/.forge/sessions/` |
| Multi-provider | Grok-centric | Built for multi-auth |
| SuperGrok credits | Yes | Yes when xAI sub auth available |
| Copilot / Codex | N/A | Degrades gracefully |
| tmux / watch | Yes | Yes |

They can coexist: use `grok-statusline` while in Grok Build; use `forge status` while in Forge.
