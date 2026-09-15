#!/usr/bin/env node

import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const configPath = join(codexHome, "config.toml");
const legacyPattern = /(?:^|\r?\n)\[agents\.dsh_subagent\]\r?\ndescription = "DSH broker subagent\. Spawn it with agent_type=dsh_subagent and pass DSH controls inside the task message; never use a DeepSeek model id as the Codex spawn_agent model override\."\r?\nconfig_file = "agents\/dsh-subagent\.toml"(?:\r?\n|$)/g;

function tableName(line) {
  return (
    /^\s*\[\[([^\]]+)\]\]\s*(?:#.*)?$/u.exec(line)?.[1] ??
    /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line)?.[1]
  );
}

export function removeLegacyDshMcp(content) {
  const lines = content.match(/.*(?:\r\n|\n|$)/gu)?.filter(Boolean) ?? [];
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    const name = tableName(lines[index].replace(/\r?\n$/u, ""));
    if (name !== undefined) sections.push({ index, name });
  }

  const root = sections.find(({ name }) => name === "mcp_servers.dsh");
  if (root === undefined) return { action: "absent", content };

  const next = sections.find(({ index }) => index > root.index)?.index ?? lines.length;
  const rootSection = lines.slice(root.index, next).join("");
  if (!/\.codex\/dsh-mcp\/server\.mjs/u.test(rootSection)) {
    return { action: "preserved-nonlegacy", content };
  }

  const removedIndexes = new Set();
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex];
    if (section.name !== "mcp_servers.dsh" && !section.name.startsWith("mcp_servers.dsh.")) continue;
    const end = sections[sectionIndex + 1]?.index ?? lines.length;
    for (let index = section.index; index < end; index += 1) {
      if (!/^\s*#/u.test(lines[index])) removedIndexes.add(index);
    }
  }

  return {
    action: "removed",
    content: lines.filter((_line, index) => !removedIndexes.has(index)).join(""),
  };
}

export async function replaceFileIfUnchanged(file, original, updated) {
  const metadata = await stat(file);
  const temporaryPath = `${file}.helpme-dsh-${process.pid}`;
  let replaced = false;
  try {
    await writeFile(temporaryPath, updated, { mode: metadata.mode, flag: "wx" });
    if (await readFile(file, "utf8") !== original) {
      throw new Error(`Codex config changed while HelpMe DSH was updating it: ${file}`);
    }
    await rename(temporaryPath, file);
    replaced = true;
  } finally {
    if (!replaced) await rm(temporaryPath, { force: true });
  }
}

export async function cleanupLegacyConfig(file = configPath, { removeMcp = true } = {}) {
  let original;
  try {
    original = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { action: "absent", file };
    throw error;
  }

  let updated = original.replace(legacyPattern, "\n");
  const agentRemoved = updated !== original;
  const mcp = removeMcp ? removeLegacyDshMcp(updated) : { action: "skipped", content: updated };
  updated = mcp.content;

  if (updated === original) {
    return {
      action: "preserved",
      file,
      agentAction: original.includes("[agents.dsh_subagent]") ? "preserved-nonlegacy" : "absent",
      mcpAction: mcp.action,
    };
  }

  await replaceFileIfUnchanged(file, original, updated);
  return {
    action: "updated",
    file,
    agentAction: agentRemoved ? "removed" : "absent",
    mcpAction: mcp.action,
  };
}

async function main() {
  const removeMcp = !process.argv.slice(2).includes("--preserve-mcp");
  const result = await cleanupLegacyConfig(configPath, { removeMcp });
  if (result.agentAction === "preserved-nonlegacy") {
    process.stderr.write(`helpme-dsh: preserved nonstandard legacy agent config in ${configPath}\n`);
  }
  if (result.mcpAction === "preserved-nonlegacy") {
    process.stderr.write(`helpme-dsh: preserved nonstandard dsh MCP config in ${configPath}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
