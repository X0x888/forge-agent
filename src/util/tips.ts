/**
 * Expert cheat sheet — single source for `forge tips` and `/tips`.
 * Keep CLI and REPL identical so docs/muscle-memory never drift.
 */

export function expertTipsLines(): string[] {
  return [
    `Forge expert tips`,
    `  Live mid-run:  /cycle 0|1  ·  /max-waves N|off  ·  /ulw-off  ·  /budget N|off  ·  /notify on  ·  /plan  ·  /build  ·  /model  ·  /pause  ·  /unpause  ·  /done  ·  /status  ·  /tasks kill|log`,
    `  Less steering:  handoff-guard blocks "shall I continue?" · proof-claim blocks "tests pass" / bare "Done." / silent edits-without-verify without a *successful* check (+ self-audit checklist) · soft TodoGate outside ULW · /done winds ULW+goal · state your reading first · safety valves flip ULW to LAST`,
    `  Verify trail:   successful checks stamp last-verify · failed re-runs clear it · edits after verify → ✓~ stale · surfaces on /status /stats /share /done /export · sessions list ✓/✓~ · /commit do + /done warn`,
    `  ULW proof:      wave proof + proof-demand prefer successful checks · reanchor names preferred project commands · failed runs don't clear proofDemands`,
    `  Advisory ULW:   pure Q&A mid-run or post-compact is framed ADVISORY — answer first; ULW momentum does not authorize unsolicited edits · TodoGate/TodoNudge/handoff/proof-claim Done. release on advisory turns`,
    `  Project stack:  auto pm+checks+monorepo in prompt · /context · doctor/status/run JSON · bash tips · /init /review /plan · FORGE_VERIFY_HINT=0 · FORGE_FILE_READ_GUARD=0`,
    `  Pin keepers:    /sessions pin <id> · forge sessions pin <id> · /sessions pinned · prune-safe`,
    `  Sessions:      /sessions  ·  pinned  ·  search <q>  ·  forge sessions search <q>  ·  /new [title]  ·  /clear hard  ·  /pin  ·  /path  ·  /share  ·  forge sessions title  ·  export/import --json (envelope round-trip)  ·  action typos → Did you mean?`,
    `  Resume:        bare forge (same-cwd)  ·  /resume <id|title>  ·  forge --session <id|title>`,
    `  CI:            forge run "…" --title job --json  ·  forge "…" --json  ·  forge run "…" --continue (fail-closed)  ·  never --continue --new · never --session --continue  ·  session_not_found/continue_miss → suggestions[]  ·  empty run → ok:false reason=empty_run  ·  run --json sessionPath+forgeHome  ·  forge models -p xai --json  ·  -p claude|gpt|oai|copilot  ·  FORGE_PROVIDER=claude  ·  forge login --from-copilot  ·  --sandbox readonly  ·  forge auth --json  ·  forge accounts list --json  ·  forge login --api-key $KEY --json  ·  forge login --add  ·  login -p sticks provider  ·  FORGE_JSON_COMPACT=1  ·  FORGE_MAX_RUN_MS=30m  ·  forge doctor --json  ·  doctor/config what-if --sandbox/--read-outside  ·  run --json productionWarnings[]  ·  --max-turns N  ·  --max-cost N  ·  FORGE_MAX_COST_USD  ·  unknown flags + --json → unknown_option  ·  bare typos/aliases (cfg→config, whoami→auth) → Did you mean?`,
    `  Safety:        /plan → design (session-only)  ·  /build → implement  ·  /permissions acceptEdits|dontAsk (sticky)  ·  --sandbox workspace  ·  --sandbox-missing fail-closed  ·  --read-outside deny  ·  /diff (argv-safe)  ·  deny Bash not Bash()  ·  no curl IMDS 169.254.169.254  ·  no curl file://`,
    `  Accounts:      forge accounts list|switch|auto-switch  ·  forge login --add  ·  /accounts  ·  /auth  ·  auto-switch on 429/quota + plan threshold`,
    `  Attention:     /bell on  ·  /notify on  ·  /budget N  ·  /copy  ·  /last  ·  /files  ·  /path  ·  /logs  ·  /config  ·  /pin  ·  /stats 7|week  ·  /news all  ·  /share  ·  /retry  ·  unknown /cmd → Did you mean?`,
    `  Recovery:      /undo  ·  /retry  ·  /sessions errors  ·  /context  ·  /compact  ·  sessions prune --force-last-error  ·  /init  ·  forge logs`,
    `  Custom cmds:    .forge/commands/<name>.md  ($ARGUMENTS $1..$9)  ·  ~/.forge/commands/  ·  /commands`,
    `  Worktrees:      doctor/status show linked worktree · forge status --json tags WORKTREE · one session per worktree`,
    `  Session titles: /sessions untitled · list --untitled · /title · --title · /goal auto-titles`,
    `  Session inventory: sessions list --json · doctor warns at ≥100 sessions · run --json productionWarnings · forge sessions prune --keep 50`,
    `  Project skills: /skills · .forge/skills/<name>/SKILL.md playbooks in system prompt`,
    `  /commit [do]:    draft commit message from git diff (do = create commit, never push)`,
    `  Project stack:  /context + doctor + /config show pm/checks/workspaces · monorepo walk-up (git-bounded) · turbo/nx · /init+/review+/plan use detected checks · bash tips: wrong-PM (Corepack) · missing-script · missing-binary (pnpm dlx/npx) · monorepo layout · next-check · post-edit verify tip (FORGE_VERIFY_HINT=0 off) · stale-edit guard needs read_file first (FORGE_FILE_READ_GUARD=0 off) · search_replace/write_file strip pasted N| line prefixes`,
    `  Ask user:       ask_user tool for clarifying questions (interactive; headless fails closed)`,
    `  Format-on-write: /format on · FORGE_FORMAT_ON_WRITE=1 · prettier/biome/ruff after file tools`,
    `  Dirty trees:    doctor warns at ≥20 changed files under ULW (or ≥100 always) · run --json productionWarnings · commit/stash before long ULW`,
    `  Docs:          docs/PRODUCTION.md  ·  docs/RELIABILITY.md  ·  forge tips  ·  forge news  ·  /help`,
  ];
}

export function formatExpertTips(): string {
  return expertTipsLines().join("\n");
}
