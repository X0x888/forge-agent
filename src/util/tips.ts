/**
 * Expert cheat sheet — single source for `forge tips` and `/tips`.
 * Keep CLI and REPL identical so docs/muscle-memory never drift.
 */

export function expertTipsLines(): string[] {
  return [
    `Forge expert tips`,
    `  Live mid-run:  /improve  ·  /hooks init  ·  /cycle 0|1  ·  /max-waves N|off  ·  /ulw-off  ·  /budget N|off  ·  /notify on  ·  /plan  ·  /build  ·  enter_plan_mode  ·  exit_plan_mode  ·  /model  ·  /fallback  ·  /pause  ·  /unpause  ·  /done  ·  /status  ·  /checkpoint  ·  /tasks kill|log  ·  get_task_output wait= / wait_mode=any|all  ·  !cmd  ·  @path`,
    `  Less steering:  handoff-guard blocks "shall I continue?" · proof-claim blocks "tests pass" / bare "Done." / silent edits-without-verify without a *successful* check (+ self-audit checklist) · soft TodoGate outside ULW · /done winds ULW+goal · state your reading first · safety valves flip ULW to LAST`,
    `  Verify trail:   successful checks stamp last-verify · failed re-runs clear it · edits after verify → ✓~ stale · surfaces on /status /stats /share /done /export · sessions list ✓/✓~ · /commit do + /done warn`,
    `  ULW proof:      wave proof + proof-demand prefer successful checks · reanchor names preferred project commands · failed runs don't clear proofDemands`,
    `  Advisory ULW:   pure Q&A mid-run or post-compact is framed ADVISORY — answer first; ULW momentum does not authorize unsolicited edits · TodoGate/TodoNudge/handoff/proof-claim Done. release on advisory turns`,
    `  Project stack:  auto pm+checks+monorepo in prompt · /context · doctor/status/run JSON · /memory project · memory_write scope=project · /init writes AGENTS.md · /setup first-day hub · FORGE_VERIFY_HINT=0 · FORGE_FILE_READ_GUARD=0 · FORGE_EDIT_RECEIPT=legacy · FORGE_UNCHANGED_READ_STUB=0 · FORGE_AUTO_VERIFY_NUDGE=0 · FORGE_FIX_UNTIL_GREEN=0`,
    `  Pin keepers:    /sessions pin <id> · forge sessions pin <id> · /sessions pinned · prune-safe`,
    `  Sessions:      /sessions  ·  pinned  ·  search <q>  ·  forge sessions search <q>  ·  /new [title]  ·  /clear hard  ·  /pin  ·  /path  ·  /share  ·  forge sessions title  ·  export/import --json (envelope round-trip)  ·  action typos → Did you mean?`,
    `  Resume:        bare forge (same-cwd)  ·  /resume <id|title>  ·  forge --session <id|title>`,
    `  CI:            forge run "…" --title job --json  ·  forge "…" --json  ·  forge run "…" --continue (fail-closed)  ·  never --continue --new · never --session --continue  ·  session_not_found/continue_miss → suggestions[]  ·  empty run → ok:false reason=empty_run  ·  run --json sessionPath+forgeHome  ·  forge models -p xai --json  ·  -p claude|gpt|oai|copilot|cursor  ·  FORGE_PROVIDER=claude  ·  forge login --from-copilot  ·  forge login --from-cursor  ·  --sandbox readonly  ·  forge auth --json  ·  forge accounts list --json  ·  forge login --api-key $KEY --json  ·  forge login --add  ·  login -p sticks provider  ·  FORGE_JSON_COMPACT=1  ·  FORGE_MAX_RUN_MS=30m  ·  forge doctor --json  ·  doctor/config what-if --sandbox/--read-outside  ·  run --json productionWarnings[]  ·  --max-turns N  ·  --max-cost N  ·  FORGE_MAX_COST_USD  ·  unknown flags + --json → unknown_option  ·  bare typos/aliases (cfg→config, whoami→auth) → Did you mean?`,
    `  Safety:        /plan → design (session-only)  ·  Context7 query-docs is plan-safe  ·  enter_plan_mode (agent) or /plan · exit_plan_mode or /build → implement  ·  /permissions acceptEdits|dontAsk (sticky)  ·  --sandbox workspace  ·  --sandbox-missing fail-closed  ·  --read-outside deny  ·  /diff (argv-safe)  ·  deny Bash not Bash()  ·  no curl IMDS 169.254.169.254  ·  no curl file://`,
    `  Accounts:      forge accounts list|switch|auto-switch  ·  forge login --add  ·  /accounts  ·  /auth  ·  auto-switch on 429/quota + plan threshold  ·  /fallback after 429/5xx (defaults on; off warns at posture)`,
    `  Attention:     /setup  ·  /bell on  ·  /notify on  ·  /budget N  ·  /copy  ·  /last  ·  /files  ·  /path  ·  /logs  ·  /config  ·  /pin  ·  /stats 7|week  ·  /news all  ·  /share  ·  /memory  ·  /checkpoint  ·  /retry  ·  unknown /cmd → Did you mean?`,
    `  Recovery:      /undo  ·  /checkpoint (/snap)  ·  /retry  ·  /sessions errors  ·  /context  ·  /compact  ·  sessions prune --force-last-error  ·  /init  ·  forge logs`,
    `  Custom cmds:    .forge/commands/<name>.md  ($ARGUMENTS $1..$9)  ·  .cursor/commands/  ·  ~/.forge/commands/  ·  /commands`,
    `  Worktrees:      doctor/status show linked worktree · spawn_subagent general-purpose defaults to isolation=worktree (auto-lands) (FORGE_SUBAGENT_LAND=auto|keep|discard) · /undo reverts a journaled land · FORGE_SUBAGENT_KEEP_WORKTREE=1 · one session per worktree`,
    `  LSP:            forge lsp ensure  (TS+Python default; Rust/Go if project)  ·  /lsp ensure  ·  FORGE_LSP_AUTO=0  ·  docs/LSP.md  ·  prefer lsp references/definition/workspace_symbols over repo-wide grep for known symbols`,
    `  Session titles: /sessions untitled · list --untitled · /title · --title · /goal auto-titles`,
    `  Session inventory: sessions list --json · doctor warns at ≥100 sessions · run --json productionWarnings · forge sessions prune --keep 50`,
    `  Project skills: /skills · .forge/skills/<name>/SKILL.md playbooks in system prompt`,
    `  /commit [do]:    draft commit message from git diff (do = create commit, never push)`,
    `  Project stack:  /context + doctor + /config show pm/checks/workspaces · monorepo walk-up (git-bounded) · turbo/nx · /init+/review+/plan use detected checks · bash tips: wrong-PM (Corepack) · missing-script · missing-binary (pnpm dlx/npx) · monorepo layout · next-check · post-edit verify tip (FORGE_VERIFY_HINT=0 off) · stale-edit guard needs read_file first (FORGE_FILE_READ_GUARD=0 off) · search_replace/write_file strip pasted N| line prefixes`,
    `  Editor:         ↑↓ history  ·  Ctrl+R / Ctrl+S incremental search (esc / ^G cancel)  ·  Ctrl+←/→ word  ·  ^J newline  ·  ^U clear`,
    `  Mentions:       @src/cli.ts inlines the file (already-read) · Tab-completes · images still use @shot.png / [[image:path]] · /paste clipboard screenshot`,
    `  Bang-shell:     !git status / !npm test run now (same PermissionGate as bash) · mid-run queues output for the next model step`,
    `  Ask user:       ask_user tool for clarifying questions (interactive; headless fails closed)`,
    `  Format-on-write: /format on|off · auto when prettier/biome/ruff detected · FORGE_FORMAT_ON_WRITE=0/1 force`,
    `  Dirty trees:    doctor warns at ≥20 changed files under ULW · ULW arm auto-checkpoints (FORGE_ULW_CHECKPOINT=0 off) · wave-close + Cycle complete auto-commit locally (FORGE_ULW_AUTO_COMMIT=0 off) · /checkpoint restore`,
    `  Docs:          docs/GETTING-STARTED.md  ·  /help  ·  docs/PRODUCTION.md  ·  docs/RELIABILITY.md  ·  forge tips  ·  forge news`,
  ];
}

export function formatExpertTips(): string {
  return expertTipsLines().join("\n");
}
