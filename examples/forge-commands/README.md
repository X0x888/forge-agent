# Project custom slash commands

Copy these into your repo's `.forge/commands/` (or `~/.forge/commands/`):

```bash
mkdir -p .forge/commands
cp examples/forge-commands/*.md .forge/commands/
```

Then run `/review`, `/shipcheck`, or `forge run "/review"`.

Placeholders: `$ARGUMENTS`, `$1`…`$9`. List with `/commands`.
