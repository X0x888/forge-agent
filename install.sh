#!/usr/bin/env bash
# Install Forge into the current machine (local link).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null; then
  echo "Node.js 20+ is required (node not found on PATH)" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Node.js 20+ is required (found $(node -v))" >&2
  exit 1
fi

if ! command -v npm >/dev/null; then
  echo "npm is required" >&2
  exit 1
fi

echo "Installing dependencies…"
npm install
echo "Building…"
npm run build
echo "Linking forge onto PATH…"
npm link

echo ""
echo "Forge $(node -p "require('./package.json').version") installed."
if command -v forge >/dev/null 2>&1; then
  echo ""
  echo "Running forge doctor…"
  forge doctor || true
fi
echo ""
echo "Next:"
echo "  forge login"
echo "  forge init"
echo "  forge"
echo "  eval \"\$(forge completion bash)\"   # optional"
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
