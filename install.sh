#!/usr/bin/env bash
# Install or update Forge on this machine. Safe to re-run after git pull:
#   bash install.sh
# bash 3.2 compatible (macOS /bin/bash). Does not die on `npm link` failure.
set -euo pipefail
unset CDPATH

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
cd "$ROOT"

node_major() {
  local bin="$1"
  local maj
  maj="$("$bin" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
  case "$maj" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$maj" ;;
  esac
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local maj
  maj="$(node_major node)"
  [ "$maj" -ge 20 ]
}

prepend_path() {
  local d="$1"
  [ -n "$d" ] || return 0
  case ":$PATH:" in
    *":$d:"*) ;;
    *) PATH="$d:$PATH"; export PATH ;;
  esac
}

load_node_managers() {
  if [ -z "${NVM_DIR:-}" ] && [ -d "$HOME/.nvm" ]; then
    NVM_DIR="$HOME/.nvm"
    export NVM_DIR
  fi
  if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
    set +eu
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    set -euo pipefail
  fi
  if command -v fnm >/dev/null 2>&1; then
    set +eu
    eval "$(fnm env 2>/dev/null)" || true
    set -euo pipefail
  elif [ -x "$HOME/.local/share/fnm/fnm" ]; then
    set +eu
    eval "$("$HOME/.local/share/fnm/fnm" env 2>/dev/null)" || true
    set -euo pipefail
  fi
  if [ -x "$HOME/.volta/bin/volta" ]; then
    prepend_path "$HOME/.volta/bin"
  fi
  if [ -s "$HOME/.asdf/asdf.sh" ]; then
    set +eu
    # shellcheck disable=SC1090
    . "$HOME/.asdf/asdf.sh"
    set -euo pipefail
  fi
}

consider_node() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  local maj
  maj="$(node_major "$bin")"
  [ "$maj" -ge 20 ] || return 1
  prepend_path "$(dirname "$bin")"
  return 0
}

ensure_node() {
  if node_ok; then return 0; fi
  load_node_managers
  if node_ok; then return 0; fi
  local c d
  for c in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node"
  do
    if consider_node "$c" && node_ok; then return 0; fi
  done
  if [ -d "$HOME/.nvm/versions/node" ]; then
    for d in "$HOME/.nvm/versions/node"/v*/bin/node; do
      if consider_node "$d" && node_ok; then return 0; fi
    done
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 20+ is required (node not found on PATH)." >&2
    echo "Install Node, or run this from a shell where \`node -v\` works (nvm/fnm/volta/asdf)." >&2
    exit 1
  fi
  echo "Node.js 20+ is required (found $(node -v 2>/dev/null || echo unknown))." >&2
  exit 1
}

ensure_node

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required (Node $(node -v) is on PATH but npm is not)." >&2
  exit 1
fi

echo "Installing dependencies…"
npm install --no-audit --no-fund
echo "Building…"
npm run build

echo "Linking forge onto PATH…"
export FORGE_NODE="$(command -v node)"
set +e
LINK_OUT="$(node "$ROOT/scripts/link-forge.mjs" 2>&1)"
LINK_ST=$?
set -e
printf '%s\n' "$LINK_OUT"
if [ "$LINK_ST" -ne 0 ]; then
  echo "Link failed. Forge is built at $ROOT/dist/cli.js — you can still run: node dist/cli.js" >&2
  exit "$LINK_ST"
fi

FORGE_BIN="$(printf '%s\n' "$LINK_OUT" | awk '/^FORGE_BIN=/{print substr($0, 11)}' | tail -n 1)"
if [ -z "${FORGE_BIN:-}" ] || [ ! -e "$FORGE_BIN" ]; then
  echo "Linker wrote no FORGE_BIN. See notes above." >&2
  exit 1
fi

prepend_path "$(dirname "$FORGE_BIN")"
hash -r 2>/dev/null || true

echo ""
echo "Forge $(node -p "require('./package.json').version") installed."
echo "Launcher: $FORGE_BIN"
if ! "$FORGE_BIN" --version >/dev/null 2>&1; then
  echo "Launcher did not run ($FORGE_BIN --version failed)." >&2
  exit 1
fi
echo "Running forge doctor…"
"$FORGE_BIN" doctor || true

if command -v forge >/dev/null 2>&1; then
  RESOLVED="$(command -v forge)"
  if [ "$RESOLVED" != "$FORGE_BIN" ]; then
    echo ""
    echo "This shell's \`forge\` is $RESOLVED, not $FORGE_BIN."
    echo "Run:  hash -r"
    echo "Or:   export PATH=\"$(dirname "$FORGE_BIN"):\$PATH\""
  fi
fi

echo ""
echo "Next:"
echo "  hash -r                   # drop a hashed stale forge in this shell"
echo "  forge login"
echo "  forge setup"
echo "  forge init"
echo "  forge"
echo "  eval \"\$(forge completion bash)\"   # optional"
echo ""
echo "Update later (same clone): git pull && bash install.sh"
echo ""
echo "Add another account (same email without --add updates in place):"
echo "  forge login --add                         # another SuperGrok / xAI"
echo "  forge login -p cursor --oauth --add       # another Cursor (--oauth skips local import)"
echo "  forge login -p copilot --add              # another Copilot"
echo "  forge accounts                            # list"
echo "  forge accounts switch <email>             # make it active"
echo ""
echo "Headless / CI:"
echo "  forge run \"…\" --permission-mode acceptEdits --json"
echo "  forge run \"continue\" --session <id> --json   # multi-step by id"
echo "  forge run \"next\" --continue --json           # multi-step same-cwd (no id)"
echo "  forge doctor --json"
echo "  forge sessions prune --keep 50"
echo "  forge prune-metrics --keep 500"
echo ""
echo "Interactive tips:"
echo "  forge                 # auto-resumes newest same-cwd session"
echo "  forge --new           # fresh session"
echo "  forge news            # what's new in this version"
echo "  forge tips            # expert cheat sheet"
echo "  forge logs            # tail sandbox/safety events"
echo "  forge config --json   # effective config (no secrets)"
echo "  /bell on              # terminal BEL when long turns finish"
echo "  /undo · /retry · /last · /share   # recover, peek, handoff"
echo "  /init · /review · /config · /compact-and · /fork-and-compact"
echo "Docs: docs/PRODUCTION.md · docs/RELIABILITY.md · docs/HARNESS.md"
