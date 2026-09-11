# HelpMe DSH plugin

This plugin bundles a concise `SessionStart` routing hint and a three-process pool of self-describing local DSH MCP bridges with named persistent-session management. Each bridge subscribes to its isolated Host's persisted Session events for event-driven final completion; it does not forward token streams. It does not install a Skill or Codex custom subagent. The repository also provides `scripts/update.sh` for non-destructive in-place updates. See the repository [README](../../README.md) for installation, update, configuration, and security guidance.
