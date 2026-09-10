# Security

## Trust boundary

`helpme-dsh` launches DeepSeek Harness on the user's machine. `workspace-write` allows DSH to modify files inside the selected workspace. Review the task and workspace before each run.

`danger-full-access` is exposed through a separate MCP tool configured for interactive approval. Do not configure it for automatic approval.

`dsh_session_close` is also configured for interactive approval. It archives a
session from visible DSH lists but deliberately retains the session history and
does not delete workspace files.

## Credentials

DSH authentication remains in the user's local DSH configuration. The MCP bridge keeps its loopback launch token and session cookie in memory and never includes them in tool results.

Never commit:

- `~/.dsh/`
- API keys or access tokens
- DSH launch URLs or cookies
- session exports containing private source code
- generated `node_modules/`

## Reporting

Report security issues privately to the repository owner rather than opening a public issue.
