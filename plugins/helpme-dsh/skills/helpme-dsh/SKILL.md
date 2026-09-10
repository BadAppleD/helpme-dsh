---
name: helpme-dsh
description: Delegate local coding and analysis tasks to DeepSeek Harness through the bundled DSH MCP tools, with explicit control over workspace, work mode, permissions, model, reasoning effort, and session continuity.
---

# HelpMe DSH

Use this skill when the user asks to call DSH, DeepSeek Harness, `helpme-dsh`, or the `dsh_subagent` custom agent.

If `dsh_subagent` is installed, delegate the complete task to that custom subagent. Otherwise, call the bundled DSH MCP tool directly.

Use these defaults unless the user explicitly overrides them:

- `work_mode`: `standard`
- `permission`: `workspace-write`
- `provider`: `deepseek-official`
- `model`: `deepseek-flash`
- `reasoning_effort`: `high`
- `cwd`: the active workspace

Use `dsh_run` for `read-only` and `workspace-write`. Use `dsh_run_danger` only after the user explicitly requests `danger-full-access`; never infer it. The dangerous tool must retain interactive approval.

Omit `session_id` for a new session. Pass a session ID only when the user explicitly asks to continue that exact DSH session.

Return the DSH answer and its effective configuration. Never expose DSH credentials, launch tokens, cookies, or `~/.dsh/.credentials.yaml`.
