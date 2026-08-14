# Getting started with Forge

Forge is an AI coding agent you run in the terminal. Type a task in English. It edits the repo, runs checks, and shows a change summary.

This page is the first-day path. Harness details live in [HARNESS.md](./HARNESS.md) and [ULW.md](./ULW.md).

## 1. Install

```bash
git clone https://github.com/X0x888/forge-agent.git
cd forge-agent
npm install
npm run build
npm link          # puts `forge` on your PATH
# or: ./install.sh
```

Node.js 20+.

## 2. Sign in

```bash
forge login                         # SuperGrok / X Premium (browser)
forge login --api-key               # paste a key
forge login -p anthropic            # or openai / openrouter / copilot
```

A bare `forge` on a TTY also offers this picker if you are not signed in. Headless / `--json` still fail closed.

## 3. First `forge`

```
  ⚒  Forge v0.9.x
  xai/grok-4.6 · SuperGrok  ·  session a1b2c3d4  ·  perms default  ·  sandbox workspace

  Type a task in English.  Or:  /setup  ·  /help start  ·  /plan  ·  Tab starters
  setup 2/6  ·  no spend cap  ·  no AGENTS.md  ·  /setup to finish
```

Type a coding task. You do not need a slash command. Empty Tab offers first-day starters (`/help`, `/setup`, `/plan`, …); type `/` then Tab for the full catalog. Permission prompts: **Enter** or `y` allows once.

## 4. Finish settings (`/setup`)

`/setup` (or `forge setup`) is the one hub for the knobs first-timers miss:

| Item | Why | Command |
|---|---|---|
| Provider / model | Confirm you are on the right family | `/setup model` or `/provider` `/model` |
| Spend cap | Unattended ULW can spend unbounded | `/setup budget 5` |
| Project rules | Agent has no repo conventions | `/init` |
| Turn-end notify | Long runs finish silently | `/setup notify` |
| Language servers | Diagnostics | `/lsp ensure` |
| File scaffold | `config.toml`, MCP, stub AGENTS.md | `/setup scaffold` or `forge init` |

`/setup skip` hides the compact banner line. `FORGE_SETUP=0` disables the auto card.

## 5. Useful first-day commands

| Command | What it does |
|---|---|
| `/help` | Getting started (not the full catalog) |
| `/help all` | Every slash command |
| `/plan` | Read-only design, then `/build` to implement |
| `/doctor` | Health check (auth, sandbox, Stop, file modes) |
| `/budget 5` | Session spend cap (estimate USD, not a bill) |
| `/notify on` | Desktop alert when a turn ends |
| `/undo` | Rewind last turn + journaled files |
| `/tips` | Expert / CI cheat sheet |

## 6. Two different inits

- **`forge init`** — writes files (no model): `~/.forge/config.toml`, `mcp.json`, stub `AGENTS.md`, example Stop hook, LSP ensure.
- **`/init`** — model-driven research that writes a real `AGENTS.md` for this repo.

`/setup` item 3 is `/init`. Item 6 is `forge init`.

## 7. When you want the agent to not stop

Only after you are comfortable chatting:

```
/goal ship feature X with tests green
/ulw improve the codebase          # starts working immediately
/done                              # wind down both
```

See [HARNESS.md](./HARNESS.md) and [ULW.md](./ULW.md).

## Production defaults (already on)

- Sandbox `workspace`
- Blocking Stop hooks
- Missing sandbox backend fail-closed
- Permission mode `default` (asks on writes/shell)

Do not turn these off for a first project.
