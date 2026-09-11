import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceSession,
  ensureDshWorkspace,
} from "./workspace-binding.mjs";

test("creates or reuses a DSH workspace for the exact validated cwd", async () => {
  const calls = [];
  const bridge = {
    async rpc(method, payload, signal) {
      calls.push({ method, payload, signal });
      return {
        workspace: {
          workspaceId: "workspace-train-mac",
          path: "/Users/stevendeng/train_mac",
          title: "train_mac",
        },
        created: false,
      };
    },
  };
  const signal = AbortSignal.timeout(1_000);

  const workspace = await ensureDshWorkspace(
    bridge,
    "/Users/stevendeng/train_mac",
    signal,
  );

  assert.equal(workspace.workspaceId, "workspace-train-mac");
  assert.deepEqual(calls, [{
    method: "workspace/create",
    payload: { request: { path: "/Users/stevendeng/train_mac" } },
    signal,
  }]);
});

test("rejects a workspace response for a different path", async () => {
  const bridge = {
    async rpc() {
      return {
        workspace: {
          workspaceId: "workspace-wrong",
          path: "/Users/stevendeng",
        },
      };
    },
  };

  await assert.rejects(
    ensureDshWorkspace(bridge, "/Users/stevendeng/train_mac"),
    /workspace path mismatch/,
  );
});

test("creates or adopts a session through workspaceId without passing cwd", async () => {
  const calls = [];
  const bridge = {
    async rpc(method, payload, signal) {
      calls.push({ method, payload, signal });
      return { sessionId: payload.request.sessionId ?? "session-new" };
    },
  };

  const created = await createWorkspaceSession(bridge, {
    workspaceId: "workspace-train-mac",
    agentPreset: "standard",
    sessionId: "session-existing",
  });

  assert.equal(created.sessionId, "session-existing");
  assert.deepEqual(calls[0].payload, {
    request: {
      workspaceId: "workspace-train-mac",
      agentPreset: "standard",
      sessionId: "session-existing",
    },
  });
  assert.equal("cwd" in calls[0].payload.request, false);
});
