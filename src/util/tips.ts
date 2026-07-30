/**
 * Expert cheat sheet — single source for `forge tips` and `/tips`.
 * Keep CLI and REPL identical so docs/muscle-memory never drift.
 */

export function expertTipsLines(): string[] {
  return [
    `Forge expert tips`,
    `  Live mid-run:  /cycle 0|1  ·  /max-waves N|off  ·  /ulw-off  ·  /pause  ·  /unpause  ·  /done  ·  /status  ·  /tasks kill|log`,
    `  Sessions:      /sessions  ·  pinned  ·  search <q>  ·  forge sessions search <q>  ·  /new [title]  ·  /clear hard  ·  /pin  ·  /path  ·  /share  ·  forge sessions title  ·  export/import --json (envelope round-trip)  ·  action typos → Did you mean?`,
    `  Resume:        bare forge (same-cwd)  ·  /resume <id|title>  ·  forge --session <id|title>`,
    `  CI:            forge run "…" --title job --json  ·  forge "…" --json  ·  forge run "…" --continue (fail-closed)  ·  never --continue --new · never --session --continue  ·  session_not_found/continue_miss → suggestions[]  ·  empty run → ok:false reason=empty_run  ·  run --json sessionPath+forgeHome  ·  forge models -p xai --json  ·  -p claude|gpt|oai|copilot  ·  FORGE_PROVIDER=claude  ·  forge login --from-copilot  ·  --sandbox readonly  ·  forge auth --json  ·  forge accounts list --json  ·  forge login --api-key $KEY --json  ·  forge login --add  ·  login -p sticks provider  ·  FORGE_JSON_COMPACT=1  ·  FORGE_MAX_RUN_MS=30m  ·  forge doctor --json  ·  doctor/config what-if --sandbox/--read-outside  ·  run --json productionWarnings[]  ·  --max-turns N  ·  unknown flags + --json → unknown_option  ·  bare typos/aliases (cfg→config, whoami→auth) → Did you mean?`,
    `  Safety:        /plan → design (session-only)  ·  /build → implement  ·  /permissions acceptEdits|dontAsk (sticky)  ·  --sandbox workspace  ·  --sandbox-missing fail-closed  ·  --read-outside deny  ·  /diff (argv-safe)  ·  deny Bash not Bash()  ·  no curl IMDS 169.254.169.254  ·  no curl file://`,
    `  Accounts:      forge accounts list|switch|auto-switch  ·  forge login --add  ·  /accounts  ·  /auth  ·  auto-switch on 429/quota + plan threshold`,
    `  Attention:     /bell on  ·  /copy  ·  /last  ·  /files  ·  /path  ·  /logs  ·  /config  ·  /pin  ·  /stats 7|week  ·  /news all  ·  /share  ·  /retry  ·  unknown /cmd → Did you mean?`,
    `  Recovery:      /undo  ·  /retry  ·  /init  ·  /review  ·  /compact-and  ·  /fork-and-compact  ·  forge logs  ·  forge config  ·  sessions prune --keep all`,
    `  Docs:          docs/PRODUCTION.md  ·  docs/RELIABILITY.md  ·  forge tips  ·  forge news  ·  /help`,
  ];
}

export function formatExpertTips(): string {
  return expertTipsLines().join("\n");
}
