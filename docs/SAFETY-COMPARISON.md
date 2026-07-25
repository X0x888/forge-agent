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

## Production reliability follow-on (v0.9.3)

Same sources plus Grok consecutive-failure patterns and OpenCode apply_patch / session hygiene:

- Error-streak circuit breaker, empty-SSE retry, apply_patch + atomic writes
- Session fork/export/import, headless `forge run --session`, session.lock on REPL + headless
- metrics.jsonl, permission ask timeout, readable apply_patch permission previews

See `docs/RELIABILITY.md` and `docs/PRODUCTION.md`.
