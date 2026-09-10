# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Development setup

```bash
git clone https://github.com/BadAppleD/helpme-dsh.git
cd helpme-dsh/plugins/helpme-dsh/server
npm ci
node --check server.mjs
```

Validate the plugin before opening a pull request:

```bash
cd ../../..
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/helpme-dsh
```

Keep changes scoped and preserve the default safety boundary. In particular,
do not weaken approval for `dsh_run_danger` or commit DSH credentials, launch
URLs, cookies, session exports, `.env` files, or generated `node_modules`.

Use [GitHub Security Advisories](https://github.com/BadAppleD/helpme-dsh/security/advisories/new)
instead of a public issue for vulnerabilities.
