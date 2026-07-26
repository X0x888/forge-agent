/**
 * Expert cheat sheet — single source for `forge tips` and `/tips`.
 * Keep CLI and REPL identical so docs/muscle-memory never drift.
 */

export function formatExpertTips(): string {
  return [
    `Forge expert tips`,
    `  Live mid-run:  /cycle 0|1  ·  /ulw-off  ·  /pause  ·  /unpause  ·  /done  ·  /status`,
    `  Sessions:      /sessions  ·  pinned  ·  search <q>  ·  /new [title]  ·  /clear hard  ·  /pin  ·  /path  ·  /share  ·  forge sessions title`,
    `  Resume:        bare forge (same-cwd)  ·  /resume <id|title>  ·  forge --session <id|title>`,
    `  CI:            forge run "…" --title job --json  ·  forge run "…" --continue  ·  forge doctor --json`,
    `  Safety:        /permissions plan|acceptEdits  ·  --sandbox workspace  ·  /diff (argv-safe)`,
    `  Attention:     /bell on  ·  /copy  ·  /last  ·  /files  ·  /path  ·  /logs  ·  /config  ·  /pin  ·  /stats 7  ·  /share  ·  /retry`,
    `  Recovery:      /undo  ·  /retry  ·  /init  ·  /review  ·  /compact-and  ·  /fork-and-compact  ·  forge logs  ·  forge config`,
    `  Docs:          docs/PRODUCTION.md  ·  docs/RELIABILITY.md  ·  forge tips  ·  forge news  ·  /help`,
  ].join("\n");
}
