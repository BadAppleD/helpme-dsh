import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  END_MARKER,
  ROUTING_RULE,
  START_MARKER,
  ensureGlobalAgentRule,
  removeGlobalAgentRule,
} from "./global-agent-rule.mjs";

async function withTempAgentsFile(run) {
  const directory = await mkdtemp(join(tmpdir(), "helpme-dsh-agent-rule-"));
  try {
    await run(join(directory, "AGENTS.md"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("creates a missing global AGENTS.md and injects the routing rule", async () => {
  await withTempAgentsFile(async (file) => {
    assert.equal((await ensureGlobalAgentRule(file)).action, "added");
    const content = await readFile(file, "utf8");
    assert.match(content, new RegExp(START_MARKER));
    assert.match(content, new RegExp(END_MARKER));
    assert.ok(content.includes(ROUTING_RULE));
  });
});

test("preserves existing content and remains idempotent", async () => {
  await withTempAgentsFile(async (file) => {
    await writeFile(file, "# Existing rules\n\n- Keep this rule.\n", "utf8");
    await ensureGlobalAgentRule(file);
    const once = await readFile(file, "utf8");
    assert.equal((await ensureGlobalAgentRule(file)).action, "preserved");
    assert.equal(await readFile(file, "utf8"), once);
    assert.ok(once.startsWith("# Existing rules\n\n- Keep this rule.\n"));
    assert.equal(once.split(START_MARKER).length - 1, 1);
  });
});

test("does not claim an equivalent user-authored rule", async () => {
  await withTempAgentsFile(async (file) => {
    await writeFile(file, `# Existing rules\n\n${ROUTING_RULE}\n`, "utf8");
    assert.equal((await ensureGlobalAgentRule(file)).action, "preserved");
    const content = await readFile(file, "utf8");
    assert.ok(!content.includes(START_MARKER));
  });
});

test("uninstall removes only an unchanged managed block", async () => {
  await withTempAgentsFile(async (file) => {
    const original = "# Existing rules\n\n- Keep this rule.\n";
    await writeFile(file, original, "utf8");
    await ensureGlobalAgentRule(file);
    assert.equal((await removeGlobalAgentRule(file)).action, "removed");
    assert.equal(await readFile(file, "utf8"), original);

    await ensureGlobalAgentRule(file);
    const modified = (await readFile(file, "utf8")).replace(ROUTING_RULE, `${ROUTING_RULE} Extra.`);
    await writeFile(file, modified, "utf8");
    assert.equal((await removeGlobalAgentRule(file)).action, "preserved-modified");
    assert.equal(await readFile(file, "utf8"), modified);
  });
});
