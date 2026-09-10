#!/bin/sh
set -eu

PLUGIN_ID="helpme-dsh@helpme-dsh-team"
PLUGIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$PLUGIN_ROOT/../.." && pwd)
SKIP_PULL=false

usage() {
  cat <<'EOF'
Usage: update.sh [--skip-pull]

Update an existing helpme-dsh installation in place.

  --skip-pull  Use the repository's current checkout without running git pull.
               Intended for local development or an externally synchronized clone.
EOF
}

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

if ! codex plugin list --json | grep -Fq "\"pluginId\": \"$PLUGIN_ID\""; then
  echo "helpme-dsh: $PLUGIN_ID is not installed; run scripts/install.sh first" >&2
  exit 1
fi

if [ "$SKIP_PULL" = false ]; then
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ]; then
    echo "helpme-dsh: repository has local changes; commit or preserve them before updating" >&2
    exit 1
  fi
  git -C "$REPO_ROOT" pull --ff-only
fi

npm --prefix "$PLUGIN_ROOT/server" ci
codex plugin add "$PLUGIN_ID"

VERSION=$(node -e '
  const manifest = require(process.argv[1]);
  process.stdout.write(manifest.version);
' "$PLUGIN_ROOT/.codex-plugin/plugin.json")

echo "helpme-dsh updated in place to $VERSION. Existing DSH credentials, profiles, and sessions were preserved."
echo "Start a new Codex task to load the updated MCP tools and SessionStart hook."
