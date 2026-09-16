import assert from "node:assert/strict";
import test from "node:test";

import { runBatch, validateRunTargets } from "./batch-run.mjs";

test("validateRunTargets rejects duplicate names before starting a batch", () => {
  assert.throws(
    () => validateRunTargets([
      { session_name: "Worker-A" },
      { session_name: "worker-a" },
    ]),
    /duplicate session target: worker-a/,
  );
});

test("validateRunTargets rejects ambiguous item references", () => {
  assert.throws(
    () => validateRunTargets([{ session_id: "session-a", session_name: "worker-a" }]),
    /either session_id or session_name, not both/,
  );
});

test("runBatch starts every item before waiting for completion", async () => {
  const started = [];
  const releases = new Map();
  const items = [{ name: "a" }, { name: "b" }, { name: "c" }];

  const pending = runBatch(items, async (item) => {
    started.push(item.name);
    await new Promise((resolve) => releases.set(item.name, resolve));
    return { sessionId: `session-${item.name}` };
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a", "b", "c"]);
  for (const release of releases.values()) release();

  assert.deepEqual(await pending, {
    results: [
      { index: 0, ok: true, value: { sessionId: "session-a" } },
      { index: 1, ok: true, value: { sessionId: "session-b" } },
      { index: 2, ok: true, value: { sessionId: "session-c" } },
    ],
    succeeded: 3,
    failed: 0,
  });
});

test("runBatch keeps sibling results when one item fails", async () => {
  const result = await runBatch(
    [{ name: "ok" }, { name: "bad" }],
    async (item) => {
      if (item.name === "bad") throw new Error("rejected task");
      return { sessionId: "session-ok" };
    },
  );

  assert.deepEqual(result, {
    results: [
      { index: 0, ok: true, value: { sessionId: "session-ok" } },
      { index: 1, ok: false, error: "rejected task" },
    ],
    succeeded: 1,
    failed: 1,
  });
});
