# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.9.x | ✅ |
| < 0.9 | Best-effort |

## Reporting a vulnerability

Please **do not** open a public issue for security bugs that could enable:

- Arbitrary code execution outside the intended sandbox profile
- Credential / token exfiltration from `~/.forge/auth.json`
- Bypass of hard-deny shell rules or workspace write containment

Email or private channel preferred when available; otherwise open a minimal public issue without exploit details and request a secure contact.

## Hardening already in place

- Auth store written mode `0600`
- Preferences + saved always-allow rules (`preferences.json`, `permissions.json`) written mode `0600` (`forge doctor` / `doctor --json` flags otherwise and exits `1`)
- Fail-closed headless permissions
- Segment-strict allow rules; deny wins under YOLO
- Protected paths (`.git`, `.forge`, credentials) — including paths inside `apply_patch` hunks
- OS sandbox profiles (`workspace` / `read-only` / `strict`) with fail-closed missing backend
- Atomic file writes (tmp+rename) for `write_file` / `search_replace` / `apply_patch`
- Session file lock (`session.lock`) on REPL + `forge run`; auto-resume skips foreign live locks
- Session export files mode `0600` (`forge sessions export --out`, `/export path`)
- File mutation journal (`mutations.jsonl` mode `0600`) enables `/undo` disk restore; pre-images may include workspace secrets — keep `~/.forge` private
- SSRF guards on `web_fetch` (stream body caps)
- Shell env scrubbing for secret-looking variables; MCP/LSP stdio also drop Forge/LLM provider keys (`XAI_API_KEY`, `CURSOR_ACCESS_TOKEN`, …) even under `keepSecrets`
- Project config cannot force `bypassPermissions`, turn sandbox off, or redirect credential paths
- JSON config loaders clone object fallbacks (no shared mutable empty stores)
- `/config` and `/logs` are live-safe and never dump API keys

See [docs/SAFETY.md](./docs/SAFETY.md) and [docs/PRODUCTION.md](./docs/PRODUCTION.md).
