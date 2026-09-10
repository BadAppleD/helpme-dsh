#!/bin/sh
set -eu

PLUGIN_ID="helpme-dsh@helpme-dsh-team"
SCRIPT_PATH=$0
while [ -L "$SCRIPT_PATH" ]; do
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)
  LINK_TARGET=$(readlink "$SCRIPT_PATH")
  case "$LINK_TARGET" in
    /*) SCRIPT_PATH=$LINK_TARGET ;;
    *) SCRIPT_PATH=$SCRIPT_DIR/$LINK_TARGET ;;
  esac
done
PLUGIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$PLUGIN_ROOT/../.." && pwd)
PLUGIN_COMMAND_DIR=${HELPME_DSH_BIN_DIR:-"$HOME/.local/bin"}
PLUGIN_COMMAND="$PLUGIN_COMMAND_DIR/helpme-dsh"
SKIP_PULL=false

usage() {
  cat <<'EOF'
Usage: helpme-dsh [update] [--skip-pull]

Update an existing helpme-dsh installation in place.

  --skip-pull  Use the repository's current checkout without running git pull.
               Intended for local development or an externally synchronized clone.
EOF
}

if [ "${1-}" = "update" ]; then
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-pull)
      SKIP_PULL=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "helpme-dsh: unknown update option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

for command_name in codex git node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "helpme-dsh: required command is unavailable: $command_name" >&2
    exit 1
  fi
done

if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "helpme-dsh: update must run from a Git clone of the repository" >&2
  exit 1
fi

if [ -e "$PLUGIN_COMMAND" ] && [ ! -L "$PLUGIN_COMMAND" ]; then
  echo "helpme-dsh: preserved existing non-symlink command: $PLUGIN_COMMAND" >&2
  echo "helpme-dsh: move it or set HELPME_DSH_BIN_DIR before updating" >&2
  exit 1
fi

if ! codex plugin list --json | grep -Fq "\"pluginId\": \"$PLUGIN_ID\""; then
  echo "helpme-dsh: $PLUGIN_ID is not installed; run scripts/install.sh first" >&2
  exit 1
fi

if [ "$SKIP_PULL" = false ]; then
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ]; then
    echo "helpme-dsh: repository has local changes; commit or preserve them before updating" >&2
    exit 1
  fi
  PREVIOUS_HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD)
  git -C "$REPO_ROOT" pull --ff-only
  UPDATED_HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD)
  if [ "$PREVIOUS_HEAD" != "$UPDATED_HEAD" ] && [ "${HELPME_DSH_REEXECUTED:-false}" = false ]; then
    exec env HELPME_DSH_REEXECUTED=true "$PLUGIN_ROOT/scripts/update.sh" --skip-pull
  fi
fi

npm --prefix "$PLUGIN_ROOT/server" ci
codex plugin add "$PLUGIN_ID"
mkdir -p "$PLUGIN_COMMAND_DIR"
ln -sfn "$PLUGIN_ROOT/scripts/update.sh" "$PLUGIN_COMMAND"

VERSION=$(node -e '
  const manifest = require(process.argv[1]);
  process.stdout.write(manifest.version);
' "$PLUGIN_ROOT/.codex-plugin/plugin.json")

echo "helpme-dsh updated in place to $VERSION. Existing DSH credentials, profiles, and sessions were preserved."
echo "Updater command: $PLUGIN_COMMAND"
echo "Start a new Codex task to load the updated MCP tools and SessionStart hook."
