#!/usr/bin/env bash
# Install Forge into the current machine (local link).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
if ! command -v node >/dev/null; then
  echo "Node.js 20+ is required" >&2
  exit 1
fi
npm install
npm run build
npm link
echo ""
echo "Forge installed. Try:"
echo "  forge login"
echo "  forge init"
echo "  forge"
