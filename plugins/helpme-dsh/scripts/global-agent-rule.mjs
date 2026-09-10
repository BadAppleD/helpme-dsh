#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const START_MARKER = "<!-- helpme-dsh:agent-routing:start -->";
export const END_MARKER = "<!-- helpme-dsh:agent-routing:end -->";
export const ROUTING_RULE =
  "- When the user mentions a `DSH subagent`, use the `HelpMe DSH` MCP by default unless the user explicitly requests another mechanism.";

export const MANAGED_BLOCK = `${START_MARKER}
## Agent Delegation

${ROUTING_RULE}
${END_MARKER}
`;

function defaultAgentsFile() {
  const codexDir = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexDir, "AGENTS.md");
}

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export async function ensureGlobalAgentRule(file = defaultAgentsFile()) {
  const content = await readIfPresent(file);
  if (content.includes(START_MARKER) || content.split(/\r?\n/u).includes(ROUTING_RULE)) {
    return { action: "preserved", file };
  }

  const separator = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${content}${separator}${MANAGED_BLOCK}`, "utf8");
  return { action: "added", file };
}

export async function removeGlobalAgentRule(file = defaultAgentsFile()) {
  const content = await readIfPresent(file);
  if (content.length === 0) return { action: "absent", file };

  let updated;
  if (content === MANAGED_BLOCK) {
    updated = "";
  } else if (content.includes(`\n${MANAGED_BLOCK}`)) {
    updated = content.replace(`\n${MANAGED_BLOCK}`, "");
  } else {
    return { action: content.includes(START_MARKER) ? "preserved-modified" : "absent", file };
  }

  await writeFile(file, updated, "utf8");
  return { action: "removed", file };
}

async function main() {
  const remove = process.argv.slice(2).includes("--remove");
  const result = remove ? await removeGlobalAgentRule() : await ensureGlobalAgentRule();
  const messages = {
    added: "added global DSH routing rule",
    preserved: "global DSH routing rule already exists",
    removed: "removed managed global DSH routing rule",
    absent: "managed global DSH routing rule is absent",
    "preserved-modified": "preserved user-modified global DSH routing rule",
  };
  process.stdout.write(`helpme-dsh: ${messages[result.action]}: ${result.file}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
