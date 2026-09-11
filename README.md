# helpme-dsh

Open-source plugin that connects Codex App and Codex CLI to a local DeepSeek Harness process through MCP.

## What it provides

- `dsh_run` for `read-only` and `workspace-write` sessions
- `dsh_run_danger` for explicitly approved `danger-full-access` sessions
- `dsh_sessions`, `dsh_session_get`, and `dsh_session_close` for persistent session management
- one plugin-managed DSH Host at `127.0.0.1:3080`, shared by Codex and the browser UI
- concurrent subagents as independent Sessions inside that Host
- per-call work mode, model, reasoning effort, workspace, timeout, and session controls
- event-driven completion from request-correlated persisted Session events; it returns only the final response and does not forward token streams
- cancellation forwarding and same-Session cross-process locking
- a concise `SessionStart` routing hint for startup, resume, clear, and context compaction
- self-describing MCP initialization instructions, tool descriptions, schemas, defaults, and safety annotations

The plugin does not install a Codex custom subagent or Skill. Requests for a
"DeepSeek subagent" are routed to `helpme_dsh`; each call can create or continue
an independent Session in the shared Host.

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
- network access to GitHub and npm during installation and updates

DSH and all runtime dependencies are pinned in `plugins/helpme-dsh/server/package-lock.json`. The first setup downloads them from npm. Every user authenticates DSH locally; credentials and sessions are never stored in this repository.

## Install from a clone

```bash
git clone https://github.com/BadAppleD/helpme-dsh.git
cd helpme-dsh
./plugins/helpme-dsh/scripts/install.sh
```

The installer starts the managed Host. Open its shared UI to authenticate DSH
or inspect Codex-created Sessions:

```bash
helpme-dsh ui
```

On a headless remote host, this prints a secret authentication URL. Forward
local port `3080` to remote `127.0.0.1:3080`, then open that URL locally.

Quit and reopen Codex App, or start a new Codex CLI session.
Review and trust the plugin's `SessionStart` hook when Codex prompts you.
The clone-based installer also creates `~/.local/bin/helpme-dsh`; no global npm
installation is required for this command. It adds an idempotent routing rule to
`$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`) so requests for a
`DSH subagent` use the HelpMe DSH MCP by default.

## Update in place

After a clone-based installation, run this from any directory:

```bash
helpme-dsh
```

`helpme-dsh update` is an equivalent explicit form. The updater requires a
clean checkout, performs a fast-forward-only pull, re-executes itself if the
updater changed, restarts the managed Host, refreshes pinned runtime dependencies,
and asks Codex to update the existing plugin registration in place. It does not call
`codex plugin remove` and does not modify DSH credentials, Web profiles,
workspace files, or persisted sessions.

For a checkout that was already synchronized by another trusted mechanism:

```bash
./plugins/helpme-dsh/scripts/update.sh --skip-pull
```

The public HTTPS remote supports anonymous updates, so a server does not need
a GitHub account, personal access token, or deploy key.

## Install the Marketplace directly

The plugin itself can be installed from the GitHub Marketplace source:

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

This stops the managed Host and removes the installed plugin cache, the `helpme-dsh` CLI symlink, known
legacy custom-agent files, and the exact legacy `agents.dsh_subagent`
configuration block. It also removes the unchanged global `AGENTS.md` block
managed by HelpMe DSH, while preserving user-authored or modified rules.
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

Create or continue a readable long-lived DSH subagent by passing the same
`session_name` on every related call:

```text
Use DeepSeek through helpme-dsh with session_name=perception-review.
Task: inspect the perception architecture and remember the findings.

Continue the DSH session named perception-review.
Task: implement the agreed fix and run the focused tests.
```

Every run returns both `sessionName` and the exact `sessionId`. `session_id`
remains supported for exact continuation and must not be combined with
`session_name`. Names are matched case-insensitively and are unique across
visible sessions; use the exact ID if an older DSH profile already contains
duplicate titles.

`dsh_sessions` lists recent sessions inside the configured workspace allowlist,
and `dsh_session_get` reads one summary without resuming it. `dsh_session_close`
archives a completed session from visible DSH lists while retaining its history;
it never deletes workspace files and rejects a session that is still running.

Multiple DSH Sessions may coexist and run concurrently through one MCP server
and one managed DSH Host. All Sessions appear in the same browser UI.
Cross-process locks prevent concurrent use of the same DSH Session. Different
Sessions may run concurrently with `read-only`, `workspace-write`, or
`danger-full-access`, including inside the same workspace. The caller must give
each write-capable Session a non-overlapping task and file ownership boundary;
HelpMe DSH does not detect or merge conflicting edits.

`timeout_seconds` accepts `10` through `1800` seconds. The default remains
`600` seconds, and the maximum is 30 minutes.

For example, ask Codex to create three independent Sessions in parallel:

```text
Run these three read-only DSH subagent tasks in parallel using helpme_dsh,
with a distinct session_name for each task.
```

Host lifecycle commands are `helpme-dsh host start`, `status`, `stop`, and
`restart`. Port `3080` is intentionally exclusive: if another process owns it,
HelpMe DSH reports the conflict and never kills that process automatically.

`danger-full-access` is a separate MCP tool and must keep interactive approval enabled. Parallel execution does not remove that approval requirement.

## Development

```bash
cd plugins/helpme-dsh/server
npm ci
node --check server.mjs
cd ../../..
node --test plugins/helpme-dsh/scripts/global-agent-rule.test.mjs
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/helpme-dsh
```

After changing an installed local build, run
`./plugins/helpme-dsh/scripts/update.sh --skip-pull` and start a new Codex task.

## Compatibility

The plugin and MCP work in Codex App and Codex CLI. Codex IDE extensions do not currently load plugins.

## Contributing and license

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Security
issues should follow [SECURITY.md](SECURITY.md).

Released under the [MIT License](LICENSE).

## Security

See [SECURITY.md](SECURITY.md). This repository must never contain `~/.dsh`, API keys, launch tokens, cookies, or exported DSH sessions.
