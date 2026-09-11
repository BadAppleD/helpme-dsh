# Security

## Trust boundary

`helpme-dsh` launches DeepSeek Harness on the user's machine. `workspace-write` allows DSH to modify files inside the selected workspace. Review the task and workspace before each run.

`danger-full-access` is exposed through a separate MCP tool configured for interactive approval. Do not configure it for automatic approval.

`dsh_session_close` is also configured for interactive approval. It archives a
session from visible DSH lists but deliberately retains the session history and
does not delete workspace files.

## Credentials

DSH authentication remains in the user's local DSH configuration. The managed
Host keeps its loopback launch token in memory behind a user-only Unix socket;
each MCP bridge keeps its session cookie in memory. Runtime state is stored in
`~/.config/helpme-dsh/runtime` with user-only permissions and never contains the
launch token or cookie. Neither secret is included in MCP tool results or logs.

Never commit:

- `~/.dsh/`
- API keys or access tokens
- DSH launch URLs or cookies
- session exports containing private source code
- generated `node_modules/`

## Reporting

Report vulnerabilities through
[GitHub Security Advisories](https://github.com/BadAppleD/helpme-dsh/security/advisories/new)
rather than opening a public issue. Include affected versions, impact, and a
minimal reproduction when possible.
