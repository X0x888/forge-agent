# Safety comparison: open-source references → Forge

Sources inspected locally under `Documents/open source/`:

| Project | What we took |
|---------|----------------|
| **Grok Build** (`xai-grok-sandbox`) | Fail-closed missing sandbox, network restrict on read-only/strict, project config cannot hollow global deny/profiles, violation logging |
| **OpenCode** | once/always/reject permission replies, saved allows, command arity prefixes, external_directory gate |
| **Warp** | Redirection blocks auto-exec, denylist precedence, explainable permission reasons, read-only command heuristic |

See `docs/SAFETY.md` for the live policy. Wave 4 (Docker/devbox isolation) is intentionally deferred.
