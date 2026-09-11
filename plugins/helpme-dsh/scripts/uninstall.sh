#!/bin/sh
set -eu

PLUGIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CODEX_DIR=${CODEX_HOME:-"$HOME/.codex"}
LEGACY_AGENT="$CODEX_DIR/agents/dsh-subagent.toml"
PLUGIN_COMMAND_DIR=${HELPME_DSH_BIN_DIR:-"$HOME/.local/bin"}
PLUGIN_COMMAND="$PLUGIN_COMMAND_DIR/helpme-dsh"

if ! command -v codex >/dev/null 2>&1; then
  echo "helpme-dsh: Codex CLI must be installed and available on PATH" >&2
  exit 1
fi

node "$PLUGIN_ROOT/server/host-cli.mjs" stop

if codex plugin list --json | grep -Fq '"pluginId": "helpme-dsh@helpme-dsh-team"'; then
  codex plugin remove helpme-dsh@helpme-dsh-team
fi

if [ -f "$LEGACY_AGENT" ]; then
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA256=$(shasum -a 256 "$LEGACY_AGENT" | awk '{print $1}')
  else
    ACTUAL_SHA256=$(sha256sum "$LEGACY_AGENT" | awk '{print $1}')
  fi
  case "$ACTUAL_SHA256" in
    bdbfe7c4e90297477d2938aae05c9af7ad79bc13cf4af6d7a76221fd4f59c2b0|2a171d23033fd3bec713d8f35a23294dc4cfe3eef68e4c274fb032a888f8046a)
      rm "$LEGACY_AGENT"
      ;;
    *)
      echo "helpme-dsh: preserved user-modified legacy agent: $LEGACY_AGENT" >&2
      ;;
  esac
fi

node "$PLUGIN_ROOT/scripts/cleanup-legacy-config.mjs"
node "$PLUGIN_ROOT/scripts/global-agent-rule.mjs" --remove

if [ -L "$PLUGIN_COMMAND" ] && [ "$(readlink "$PLUGIN_COMMAND")" = "$PLUGIN_ROOT/scripts/update.sh" ]; then
  rm "$PLUGIN_COMMAND"
fi

echo "helpme-dsh uninstalled and its managed Host was stopped. DSH credentials, sessions, workspace allowlist, and marketplace registration were preserved."
