#!/bin/sh
set -eu

PLUGIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$PLUGIN_ROOT/../.." && pwd)
AGENT_SOURCE="$PLUGIN_ROOT/agents/dsh-subagent.toml"
CODEX_DIR=${CODEX_HOME:-"$HOME/.codex"}
AGENT_DIR="$CODEX_DIR/agents"
AGENT_TARGET="$AGENT_DIR/dsh-subagent.toml"
DSH_CONFIG_DIR="$HOME/.config/helpme-dsh"
ALLOWED_ROOTS_FILE="$DSH_CONFIG_DIR/allowed-roots"

if ! command -v codex >/dev/null 2>&1; then
  echo "helpme-dsh: Codex CLI must be installed and available on PATH" >&2
  exit 1
fi

if [ -e "$AGENT_TARGET" ] && ! cmp -s "$AGENT_SOURCE" "$AGENT_TARGET"; then
  echo "helpme-dsh: refusing to overwrite $AGENT_TARGET" >&2
  echo "Move the existing file aside, then run this installer again." >&2
  exit 1
fi

if ! codex plugin marketplace list --json | grep -Fq '"name": "helpme-dsh-team"'; then
  codex plugin marketplace add "$REPO_ROOT"
fi
codex plugin add helpme-dsh@helpme-dsh-team

mkdir -p "$AGENT_DIR"
cp "$AGENT_SOURCE" "$AGENT_TARGET"

mkdir -p "$DSH_CONFIG_DIR"
if [ ! -e "$ALLOWED_ROOTS_FILE" ]; then
  printf '%s\n' "$HOME" > "$ALLOWED_ROOTS_FILE"
fi

echo "helpme-dsh installed. Restart Codex App or start a new Codex CLI session."
