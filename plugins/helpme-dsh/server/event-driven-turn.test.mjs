import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EventDrivenTurn } from "./event-driven-turn.mjs";

function event(seq, type, data) {
  return { type: "event", event: { seq, type, data } };
}

function snapshot(cursor, records) {
  return { type: "snapshot", cursor, records };
}

test("completes only when the request-correlated turn reaches turn/end", () => {
  const turn = new EventDrivenTurn("request-a");
  turn.accept(snapshot(2, [
    event(1, "turn/start", { turn: 1 }),
    event(2, "turn/end", { turn: 1 }),
  ]));
  turn.markPromptIssued();

  assert.equal(turn.accept(event(3, "turn/start", { turn: 2 })), undefined);
  assert.equal(turn.accept(event(4, "user/message", {
    source: { kind: "user", rpcId: "request-a" },
  })), undefined);
  assert.equal(turn.accept(event(5, "assistant/message", {
    turn: 2,
    message: { content: [{ type: "text", text: "final answer" }] },
  })), undefined);

  assert.deepEqual(turn.accept(event(6, "turn/end", { turn: 2 })), {
    turn: 2,
    response: "final answer",
  });
});

test("ignores unrelated turn and request events", () => {
  const turn = new EventDrivenTurn("request-a");
  turn.accept(snapshot(-1, []));
  turn.markPromptIssued();

  turn.accept(event(0, "turn/start", { turn: 1 }));
  turn.accept(event(1, "user/message", {
    source: { kind: "user", rpcId: "request-other" },
  }));
  turn.accept(event(2, "assistant/message", {
    turn: 1,
    message: { content: [{ type: "text", text: "wrong answer" }] },
  }));
  assert.equal(turn.accept(event(3, "turn/end", { turn: 1 })), undefined);

  turn.accept(event(4, "turn/start", { turn: 2 }));
  turn.accept(event(5, "user/message", {
    source: { kind: "user", rpcId: "request-a" },
  }));
  turn.accept(event(6, "assistant/message", {
    turn: 2,
    message: { content: [{ type: "text", text: "right answer" }] },
  }));
  assert.equal(turn.accept(event(7, "assistant/message", {
    turn: 99,
    message: { content: [{ type: "text", text: "unrelated" }] },
  })), undefined);
  assert.equal(turn.completion, undefined);
  assert.equal(turn.accept(event(8, "turn/end", { turn: 2 }))?.response, "right answer");
});

test("reconnect snapshot replays duplicates but never permits a persisted gap", () => {
  const turn = new EventDrivenTurn("request-a");
  turn.accept(snapshot(-1, []));
  turn.markPromptIssued();
  turn.accept(event(0, "turn/start", { turn: 1 }));
  turn.accept(event(1, "user/message", {
    source: { kind: "user", rpcId: "request-a" },
  }));

  turn.accept(snapshot(3, [
    event(0, "turn/start", { turn: 1 }),
    event(1, "user/message", { source: { kind: "user", rpcId: "request-a" } }),
    event(2, "assistant/message", {
      turn: 1,
      message: { content: [{ type: "text", text: "recovered" }] },
    }),
    event(3, "step/end", { turn: 1, step: 1 }),
  ]));
  assert.equal(turn.accept(event(4, "turn/end", { turn: 1 }))?.response, "recovered");

  const gap = new EventDrivenTurn("request-b");
  gap.accept(snapshot(-1, []));
  gap.markPromptIssued();
  gap.accept(event(0, "turn/start", { turn: 1 }));
  assert.throws(() => gap.accept(snapshot(2, [
    event(2, "user/message", { source: { kind: "user", rpcId: "request-b" } }),
  ])), /missed persisted events/);
});

test("cancellation waits for the correlated turn/end even without final text", () => {
  const turn = new EventDrivenTurn("request-cancel", { requireResponse: false });
  turn.accept(snapshot(-1, []));
  turn.markPromptIssued();
  turn.accept(event(0, "turn/start", { turn: 1 }));
  turn.accept(event(1, "user/message", {
    source: { kind: "user", rpcId: "request-cancel" },
  }));

  // A successful cancellation RPC is only an acknowledgement. Completion
  // remains pending until the persisted terminal event arrives.
  assert.equal(turn.completion, undefined);
  assert.deepEqual(turn.accept(event(2, "turn/end", {
    turn: 1,
    reason: "cancelled",
  })), { turn: 1 });
});

test("server has no session-list completion polling", async () => {
  const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /waitForTurn/);
  assert.doesNotMatch(source, /POLL_INTERVAL_MS/);
  const cancelStart = source.indexOf("async function cancelAndSettle");
  const nextFunction = source.indexOf("async function runCreatedSession", cancelStart);
  assert.ok(cancelStart >= 0 && nextFunction > cancelStart);
  const cancellation = source.slice(cancelStart, nextFunction);
  assert.doesNotMatch(cancellation, /sessionSummary|while\s*\(/);
  assert.match(cancellation, /CANCEL_CONFIRM_GRACE_MS/);
  assert.match(cancellation, /session\/cancel[\s\S]*?confirmation\.waitForCompletion\(\)/);
  assert.doesNotMatch(cancellation, /quarantineExecutionScope/);
  assert.doesNotMatch(cancellation, /bridge\.stop\(\)/);
  assert.doesNotMatch(source, /execution-scope:/);
  assert.match(source, /max\(3600\)\.default\(1800\)/);
  assert.match(source, /reasoning_effort: z\.enum\(REASONING_EFFORTS\)\.default\("max"\)/);
  assert.match(source, /call dsh_run again with session_id set to the returned sessionId[\s\S]*?same DSH subagent fixes it/);
});

test("different sessions can write concurrently while one session remains locked", async () => {
  const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /async function withSessionLock/);
  assert.match(source, /return invokeDshRunUnlocked\(args, signal, permission\)/);
  assert.doesNotMatch(source, /Another write-capable DSH run is already active/);

  const config = JSON.parse(await readFile(new URL("../.mcp.json", import.meta.url), "utf8"));
  assert.ok(config.mcpServers.helpme_dsh.tool_timeout_sec > 3600);
  assert.equal(
    config.mcpServers.helpme_dsh.tools.dsh_run_danger.approval_mode,
    "prompt",
  );
});

test("validates session references and cwd before creating a persistent workspace", async () => {
  const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  const runStart = source.indexOf("async function invokeDshRunUnlocked");
  const runEnd = source.indexOf("async function invokeDshRun(", runStart);
  assert.ok(runStart >= 0 && runEnd > runStart);
  const run = source.slice(runStart, runEnd);

  const mutualExclusion = run.indexOf("Provide either session_id or session_name");
  const workspaceCreation = run.indexOf("ensureDshWorkspace");
  assert.ok(mutualExclusion >= 0 && mutualExclusion < workspaceCreation);
  assert.match(run, /sessionSummary\(sessionId, signal\)[\s\S]*?existing\.cwd[\s\S]*?ensureDshWorkspace/);
});
