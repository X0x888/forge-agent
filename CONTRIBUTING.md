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

1. `blockingStopHooks` defaults **true**
2. `/goal` stuck-wall must be able to release
3. Auth files mode `0600`

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
