# Forge LSP (Language Server Protocol)

Forge exposes language intelligence through the **`lsp` tool** and **`forge lsp` / `/lsp`**. Servers are **lazy-started** when first needed — nothing runs until you (or the agent) use them.

## Bottom-line defaults

| Pack | Languages | When |
|------|-----------|------|
| **Default** | TypeScript/JS + Python (Pyright) | Always recommended |
| **Project** | Rust, Go | When `Cargo.toml` / `go.mod` (etc.) present |
| **Tips only** | Swift (macOS/Xcode), shellcheck | Not auto-installed |

**Smooth path — don’t forget installs:**

```bash
forge lsp ensure              # detect + install missing recommended servers
forge lsp ensure --dry-run    # plan only
forge lsp status              # readiness + ensure plan
forge lsp detect              # what the project looks like
```

Also: **`forge init`** runs ensure automatically, **`/lsp ensure`** in the REPL, and a **once-per-day tip** if something’s still missing.

Opt out:

| Env | Effect |
|-----|--------|
| `FORGE_LSP=0` | Disable LSP feature entirely |
| `FORGE_LSP_AUTO=0` | No init auto-ensure, no daily tip |
| `FORGE_LSP_AUTO_INSTALL=0` | Detect/report only (never run installers) |

## Tool actions

| Action | Args | Purpose |
|--------|------|---------|
| `diagnostics` | `path` | Errors/warnings (primary after edits) |
| `hover` | `path`, `line`, `character?` | Type / docs (1-based) |
| `definition` / `references` | path + position | Navigation |
| `symbols` / `workspace_symbols` | path / query | Outline / search |
| `status` | — | Server readiness |
| `install` | — | Full install recipes |
| `ensure` | `dry_run?` | Auto-install missing recommended servers |

```json
{ "action": "diagnostics", "path": "src/agent/loop.ts" }
{ "action": "ensure" }
```

## Install recipes (PATH)

| Language | Command | Install (used by `forge lsp ensure`) |
|----------|---------|--------------------------------------|
| TypeScript / JS | `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| Python | `pyright-langserver` | `npm install -g pyright` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| JSON / CSS / HTML | `vscode-*-language-server` | `npm install -g vscode-langservers-extracted` |
| YAML | `yaml-language-server` | `npm install -g yaml-language-server` |
| Shell | — | Prefer **shellcheck** (not an LSP); optional package-manager install |
| Swift | sourcekit-lsp | Xcode toolchain (manual; macOS) |

## Config

- `~/.forge/lsp.json` · `<workspace>/.forge/lsp.json`
- `FORGE_LSP_CONFIG=/path`
- Set `"noDefaults": true` to only use your `servers` map

## How it works

1. Agent or user calls `lsp` / ensure.
2. Forge maps file extension → language → command on PATH.
3. Spawns the server over stdio JSON-RPC (lazy, process-scoped).
4. Missing binary → clear tip + `forge lsp ensure` — not a crash.

## Related

- `src/lsp/ensure.ts` — detect + install
- `src/lsp/detect.ts` — project markers
- `src/lsp/install-guide.ts` — human recipes
