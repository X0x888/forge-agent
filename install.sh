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
echo ""
echo "Headless / CI:"
echo "  forge run \"…\" --permission-mode acceptEdits --json"
echo "  forge doctor --json"
echo "Docs: docs/PRODUCTION.md · docs/RELIABILITY.md"
