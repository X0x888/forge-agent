# Contributing to Forge

## Dev loop

```bash
npm install
npm run check      # typecheck + tests
npm run smoke      # build + CLI binary smoke (doctor may be ok:false without auth)
npm run ci         # check + smoke (what GitHub Actions runs)
npm run dev        # tsx src/cli.ts
```

Requirements: **Node.js 20+**.

## Layout

See [AGENTS.md](./AGENTS.md). Non-negotiables:

1. `blockingStopHooks` defaults **true** (`forge doctor` treats OFF as an issue / exit 1)
2. `/goal` stuck-wall must be able to release
3. Sensitive JSON under `~/.forge` mode `0600` (`auth.json`, `permissions.json`, `preferences.json`)

## Tests

```bash
npm test           # uses workspace `.tmp` for tsx IPC
```

Add coverage next to the module under `tests/`. Prefer `node:test` + `tsx`.

## Production reliability

When changing providers, loop, tools, or auth, update [docs/RELIABILITY.md](./docs/RELIABILITY.md) and add a regression test under `tests/reliability.test.ts` when practical.

## PRs

- Keep diffs focused
- Do not weaken Stop blocking defaults
- Never log tokens / API keys
