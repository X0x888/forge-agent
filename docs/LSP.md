# Forge LSP (Language Server Protocol)

Forge exposes language intelligence through the **`lsp` tool** (and `/lsp` in the REPL). Servers are **lazy-started** when first needed and stay process-scoped for the session.

## Tool actions

| Action | Args | Purpose |
|--------|------|---------|
| `diagnostics` | `path` | Errors/warnings for a file (primary after edits) |
| `hover` | `path`, `line`, `character?` | Type / doc at position (1-based) |
| `definition` | `path`, `line`, `character?` | Go-to-definition locations |
| `references` | `path`, `line`, `character?` | Find references |
| `symbols` | `path` | Document outline |
| `workspace_symbols` | `query`, `language?` | Workspace symbol search |
| `status` | — | Server readiness + install tips |

Example:

```json
{ "action": "diagnostics", "path": "src/agent/loop.ts" }
```

## Install language servers

Binaries must be on **`PATH`**. Forge does not vendor them.

| Language | Command | Install |
|----------|---------|---------|
| TypeScript / JS | `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| Python | `pyright-langserver` | `npm install -g pyright` (or `pip install pyright`) |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| JSON | `vscode-json-language-server` | `npm install -g vscode-langservers-extracted` |
| CSS | `vscode-css-language-server` | same package as JSON |
| HTML | `vscode-html-language-server` | same package as JSON |
| YAML | `yaml-language-server` | `npm install -g yaml-language-server` |

REPL: **`/lsp install`** prints the same recipes (with missing-on-PATH highlights).  
**`/lsp status`** shows state + missing tips. **`/lsp restart`** disposes and reloads configs.

## Config

Optional overrides:

- `~/.forge/lsp.json` (user)
- `<workspace>/.forge/lsp.json` (project)
- `FORGE_LSP_CONFIG=/path/to/lsp.json`
- `FORGE_LSP=0` — disable entirely

Example `.forge/lsp.json`:

```json
{
  "enabled": true,
  "servers": {
    "python": {
      "command": "pylsp",
      "args": []
    },
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"]
    }
  }
}
```

Set `"noDefaults": true` to skip built-in recipes and only use your `servers` map.

## Safety / scope

- Workspace-scoped paths only (same containment as `read_file`).
- Missing binary → clear error + install tip (not a crash).
- Process exit disposes running language servers.

## Related

- Agent tool: `lsp` in `src/agent/tools/definitions.ts`
- Implementation: `src/lsp/`
- Install recipes: `src/lsp/install-guide.ts`
