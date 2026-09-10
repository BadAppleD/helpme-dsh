#!/bin/sh
set -eu

PLUGIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$PLUGIN_ROOT/../.." && pwd)
CODEX_DIR=${CODEX_HOME:-"$HOME/.codex"}
LEGACY_AGENT="$CODEX_DIR/agents/dsh-subagent.toml"
DSH_CONFIG_DIR="$HOME/.config/helpme-dsh"
ALLOWED_ROOTS_FILE="$DSH_CONFIG_DIR/allowed-roots"

if ! command -v codex >/dev/null 2>&1; then
  echo "helpme-dsh: Codex CLI must be installed and available on PATH" >&2
  exit 1
fi

if ! codex plugin marketplace list --json | grep -Fq '"name": "helpme-dsh-team"'; then
  codex plugin marketplace add "$REPO_ROOT"
fi

if codex plugin list --json | grep -Fq '"pluginId": "helpme-dsh@helpme-dsh-team"'; then
  codex plugin remove helpme-dsh@helpme-dsh-team
fi

if [ -f "$LEGACY_AGENT" ]; then
  if command -v shasum >/dev/null 2>&1; then
    LEGACY_AGENT_ACTUAL_SHA256=$(shasum -a 256 "$LEGACY_AGENT" | awk '{print $1}')
  else
    LEGACY_AGENT_ACTUAL_SHA256=$(sha256sum "$LEGACY_AGENT" | awk '{print $1}')
  fi
  case "$LEGACY_AGENT_ACTUAL_SHA256" in
    bdbfe7c4e90297477d2938aae05c9af7ad79bc13cf4af6d7a76221fd4f59c2b0|2a171d23033fd3bec713d8f35a23294dc4cfe3eef68e4c274fb032a888f8046a)
      rm "$LEGACY_AGENT"
      ;;
    *)
      echo "helpme-dsh: preserved user-modified legacy agent: $LEGACY_AGENT" >&2
      ;;
  esac
fi

node "$PLUGIN_ROOT/scripts/cleanup-legacy-config.mjs"
codex plugin add helpme-dsh@helpme-dsh-team

mkdir -p "$DSH_CONFIG_DIR"
if [ ! -e "$ALLOWED_ROOTS_FILE" ]; then
  printf '%s\n' "$HOME" > "$ALLOWED_ROOTS_FILE"
fi

echo "helpme-dsh installed. Start a new Codex task and trust its SessionStart hook when prompted."
