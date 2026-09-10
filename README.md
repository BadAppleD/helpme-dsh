# helpme-dsh

Private team plugin that connects Codex App and Codex CLI to a local DeepSeek Harness process through MCP.

## What it provides

- `dsh_run` for `read-only` and `workspace-write` sessions
- `dsh_run_danger` for explicitly approved `danger-full-access` sessions
- per-call work mode, model, reasoning effort, workspace, timeout, and session controls
- complete DSH responses retrieved by request ID
- cancellation forwarding and cross-process session locking
- a `helpme-dsh` skill and optional `dsh_subagent` custom agent

Default DSH controls are:

```text
work_mode=standard
permission=workspace-write
provider=deepseek-official
model=deepseek-flash
reasoning_effort=high
```

## Requirements

- macOS or Linux
- Node.js 20 or newer with npm
- Codex CLI available as `codex`
- access to this private GitHub repository

DSH and all runtime dependencies are pinned in `plugins/helpme-dsh/server/package-lock.json`. The first setup downloads them from npm. Every user authenticates DSH locally; credentials and sessions are never stored in this repository.

## Install from a clone

```bash
gh repo clone BadAppleD/helpme-dsh
cd helpme-dsh
./plugins/helpme-dsh/scripts/install.sh
```

Then configure DSH once if the user has not already done so:

```bash
./plugins/helpme-dsh/server/node_modules/.bin/dsh web
```

Quit and reopen Codex App, or start a new Codex CLI session.

## Install the Marketplace directly

The plugin itself can be installed from the private GitHub Marketplace source:

```bash
codex plugin marketplace add BadAppleD/helpme-dsh --ref main
codex plugin add helpme-dsh@helpme-dsh-team
```

This installs the MCP and skill. To also install the optional custom subagent, clone the repository and run `plugins/helpme-dsh/scripts/install.sh`.

## Workspace allowlist

By default the installer writes the user's home directory to:

```text
~/.config/helpme-dsh/allowed-roots
```

Use one absolute directory per line. For example:

```text
/Users/alice/code
/Volumes/team-work
```

The `DSH_ALLOWED_ROOTS` environment variable overrides this file. Use the platform path delimiter (`:` on macOS and Linux).

## Use

```text
Call dsh_subagent for this task using the defaults.
```

Or select controls explicitly:

```text
Call dsh_subagent with cwd=/path/to/project, work_mode=ptc,
permission=read-only, model=deepseek-flash, reasoning_effort=max.
Task: inspect the build pipeline without changing files.
```

`danger-full-access` is a separate MCP tool and must keep interactive approval enabled. Do not weaken this policy in team configuration.

## Development

```bash
cd plugins/helpme-dsh/server
npm ci
node --check server.mjs
cd ../../..
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/helpme-dsh
```

After changing an installed local build, reinstall the plugin and start a new Codex task.

## Compatibility

The plugin and MCP work in Codex App and Codex CLI. Codex IDE extensions do not currently load plugins. The custom agent is installed separately under `~/.codex/agents/` because custom-agent sharing is not yet part of the portable plugin manifest.

## Security

See [SECURITY.md](SECURITY.md). This repository must never contain `~/.dsh`, API keys, launch tokens, cookies, or exported DSH sessions.
