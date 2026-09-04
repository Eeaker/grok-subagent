#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ROOT="$ROOT/plugins/grok-subagent"
SKILL_SRC="$PLUGIN_ROOT/skills/grok-subagent"
CODEX_HOME=${CODEX_HOME:-"$HOME/.codex"}
SKILL_DST="$CODEX_HOME/skills/grok-subagent"
CONFIG_TOML="$CODEX_HOME/config.toml"

command -v node >/dev/null 2>&1 || { echo "Missing required command: node" >&2; exit 1; }
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else echo "Missing required command: python3" >&2; exit 1
fi

mkdir -p "$CODEX_HOME/skills"
rm -rf "$SKILL_DST"
cp -R "$SKILL_SRC" "$SKILL_DST"

"$PY" "$ROOT/scripts/cleanup-codex-config.py" --config "$CONFIG_TOML" --project-root "$ROOT"

printf '%s\n' "==> Installed Codex CLI fallback skill + MCP config"
if command -v grok >/dev/null 2>&1; then grok version 2>/dev/null | head -n 1 || true
else printf '%s\n' "WARN: grok CLI not found; run 'grok login' after installing Grok Build." >&2
fi

cd "$ROOT"
npm run doctor || true
printf '%s\n' "Install finished. Start a NEW Codex thread so MCP/skill configuration reloads."
