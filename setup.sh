#!/usr/bin/env bash
# Codex As Subagent 本地安装前检查与准备：Node 版本、vendor 子模块、依赖、Codex runtime 探测。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found. Install Node.js >= 24 first (e.g. via mise or Homebrew)." >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 24 ]; then
  echo "error: Node.js >= 24 required, found $(node --version)." >&2
  exit 1
fi

git submodule update --init --recursive
npm install

echo
echo "Environment check (doctor):"
node src/cli/main.mjs doctor --json || echo "warning: doctor reported issues; see output above."

echo
echo "Setup complete. Install into your harness:"
echo "  node src/cli/main.mjs install --host=kimi-code   # Kimi Code (then /reload or new session)"
echo "  node src/cli/main.mjs install --host=zcode       # ZCode"
