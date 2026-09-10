#!/usr/bin/env node

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const configPath = join(codexHome, "config.toml");
const legacyPattern = /(?:^|\r?\n)\[agents\.dsh_subagent\]\r?\ndescription = "DSH broker subagent\. Spawn it with agent_type=dsh_subagent and pass DSH controls inside the task message; never use a DeepSeek model id as the Codex spawn_agent model override\."\r?\nconfig_file = "agents\/dsh-subagent\.toml"(?:\r?\n|$)/g;

let original;
try {
  original = await readFile(configPath, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") process.exit(0);
  throw error;
}

const updated = original.replace(legacyPattern, "\n");
if (updated !== original) {
  const metadata = await stat(configPath);
  const temporaryPath = `${configPath}.helpme-dsh-${process.pid}`;
  await writeFile(temporaryPath, updated, { mode: metadata.mode, flag: "wx" });
  await rename(temporaryPath, configPath);
} else if (original.includes("[agents.dsh_subagent]")) {
  process.stderr.write(`helpme-dsh: preserved nonstandard legacy agent config in ${configPath}\n`);
}
