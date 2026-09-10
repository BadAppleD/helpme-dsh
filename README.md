# helpme-dsh

Private team plugin that connects Codex App and Codex CLI to a local DeepSeek Harness process through MCP.

## What it provides

- `dsh_run` for `read-only` and `workspace-write` sessions
- `dsh_run_danger` for explicitly approved `danger-full-access` sessions
- per-call work mode, model, reasoning effort, workspace, timeout, and session controls
- complete DSH responses retrieved by request ID
- cancellation forwarding and cross-process session locking
- a concise `SessionStart` routing hint for startup, resume, clear, and context compaction
- self-describing MCP initialization instructions, tool descriptions, schemas, defaults, and safety annotations

The plugin does not install a Codex custom subagent or Skill. Requests for a
"DeepSeek subagent" are routed directly to the `helpme_dsh` MCP server.

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
Review and trust the plugin's `SessionStart` hook when Codex prompts you.

## Install the Marketplace directly

The plugin itself can be installed from the private GitHub Marketplace source:

```bash
codex plugin marketplace add BadAppleD/helpme-dsh --ref main
codex plugin add helpme-dsh@helpme-dsh-team
```

This installs the MCP and its bundled `SessionStart` hook. The clone-based installer also creates the default workspace allowlist and removes an unmodified legacy `dsh-subagent.toml` from version `0.1.0`.

## Uninstall

From a clone:

```bash
./plugins/helpme-dsh/scripts/uninstall.sh
```

This removes the installed plugin cache, known legacy custom-agent files, and
the exact legacy `agents.dsh_subagent` configuration block.
It preserves the marketplace registration, workspace allowlist, DSH credentials,
and DSH sessions so the plugin can be reinstalled without logging in again.

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
Use the DeepSeek subagent to inspect this workspace.
```

Or select controls explicitly:

```text
Use DeepSeek through helpme-dsh with cwd=/path/to/project, work_mode=ptc,
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

The plugin and MCP work in Codex App and Codex CLI. Codex IDE extensions do not currently load plugins.

## Security

See [SECURITY.md](SECURITY.md). This repository must never contain `~/.dsh`, API keys, launch tokens, cookies, or exported DSH sessions.
