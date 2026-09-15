import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupLegacyConfig,
  removeLegacyDshMcp,
  replaceFileIfUnchanged,
} from "./cleanup-legacy-config.mjs";

const legacyMcp = `[mcp_servers.dsh]
command = "/opt/homebrew/bin/node"
args = ["/Users/example/.codex/dsh-mcp/server.mjs"]
enabled = true

[mcp_servers.dsh.env]
DSH_ALLOWED_ROOTS = "/Users/example"

[mcp_servers.dsh.tools.dsh_run_danger]
approval_mode = "prompt"

`;

const legacyAgent = `[agents.dsh_subagent]
description = "DSH broker subagent. Spawn it with agent_type=dsh_subagent and pass DSH controls inside the task message; never use a DeepSeek model id as the Codex spawn_agent model override."
config_file = "agents/dsh-subagent.toml"

`;

test("removes the legacy dsh MCP and its nested tables only", () => {
  const input = `[mcp_servers.other]\nenabled = true\n\n${legacyMcp}[plugins.\"helpme-dsh@helpme-dsh-team\"]\nenabled = true\n`;
  const result = removeLegacyDshMcp(input);

  assert.equal(result.action, "removed");
  assert.ok(!result.content.includes("mcp_servers.dsh"));
  assert.ok(result.content.includes("[mcp_servers.other]"));
  assert.ok(result.content.includes("[plugins.\"helpme-dsh@helpme-dsh-team\"]"));
});

test("preserves a user-defined dsh MCP without the legacy launcher fingerprint", () => {
  const input = `[mcp_servers.dsh]\ncommand = \"custom-dsh\"\n`;
  assert.deepEqual(removeLegacyDshMcp(input), {
    action: "preserved-nonlegacy",
    content: input,
  });
});

test("preserves an array table following the legacy MCP", () => {
  const input = `${legacyMcp}# Keep this rule.\n[[tool_rules]]\nname = \"keep-me\"\n`;
  const result = removeLegacyDshMcp(input);

  assert.equal(result.action, "removed");
  assert.equal(result.content, "# Keep this rule.\n[[tool_rules]]\nname = \"keep-me\"\n");
});

test("cleanup removes legacy MCP config atomically and can preserve it for uninstall", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helpme-dsh-legacy-config-"));
  const file = join(directory, "config.toml");
  try {
    await writeFile(file, legacyMcp, { encoding: "utf8", mode: 0o640 });
    const preserved = await cleanupLegacyConfig(file, { removeMcp: false });
    assert.equal(preserved.mcpAction, "skipped");
    assert.equal(await readFile(file, "utf8"), legacyMcp);

    const removed = await cleanupLegacyConfig(file);
    assert.equal(removed.mcpAction, "removed");
    assert.equal(await readFile(file, "utf8"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uninstall cleanup removes the legacy agent block while preserving the legacy MCP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helpme-dsh-uninstall-config-"));
  const file = join(directory, "config.toml");
  try {
    await writeFile(file, `${legacyAgent}${legacyMcp}`, "utf8");
    const result = await cleanupLegacyConfig(file, { removeMcp: false });
    const content = await readFile(file, "utf8");

    assert.equal(result.agentAction, "removed");
    assert.equal(result.mcpAction, "skipped");
    assert.ok(!content.includes("[agents.dsh_subagent]"));
    assert.ok(content.includes("[mcp_servers.dsh]"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborts replacement instead of overwriting a concurrent config change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helpme-dsh-config-race-"));
  const file = join(directory, "config.toml");
  try {
    await writeFile(file, "original\n", "utf8");
    await writeFile(file, "concurrent change\n", "utf8");
    await assert.rejects(
      replaceFileIfUnchanged(file, "original\n", "replacement\n"),
      /config changed while HelpMe DSH was updating it/u,
    );
    assert.equal(await readFile(file, "utf8"), "concurrent change\n");
    assert.deepEqual(await readdir(directory), ["config.toml"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
