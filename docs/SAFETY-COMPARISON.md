# Safety comparison: open-source references → Forge

Sources inspected locally under `Documents/open source/`:

| Project | What we took |
|---------|----------------|
| **Grok Build** (`xai-grok-sandbox`) | Fail-closed missing sandbox, network restrict on read-only/strict, project config cannot hollow global deny/profiles, violation logging |
| **OpenCode** | once/always/reject permission replies, saved allows, command arity prefixes, external_directory gate |
| **Warp** | Redirection blocks auto-exec, denylist precedence, explainable permission reasons, read-only command heuristic |

See `docs/SAFETY.md` for the live policy. Wave 4 (Docker/devbox isolation) is intentionally deferred.

## Tool-quality follow-on (v0.7)

Same sources also drove **tool** improvements (not only authorization): realpath containment, shell env secret scrub, managed tool-output truncation, ripgrep-backed grep, line-trimmed edit fallback, richer tool descriptions. See `docs/TOOLS.md`.

## Bar A daily-driver (v0.8)

Fail-closed headless permissions, segment-strict bash allow rules, expanded hard-deny variants (`${HOME}`, `find -delete`, `git push -f`, `git -C …`), protected path writes, project config safety overlay (no project YOLO / base_url / sandbox off).
