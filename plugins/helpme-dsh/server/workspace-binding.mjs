export async function ensureDshWorkspace(bridge, cwd, signal) {
  const value = await bridge.rpc("workspace/create", {
    request: { path: cwd },
  }, signal);
  const workspace = value?.workspace;
  if (typeof workspace?.workspaceId !== "string" || workspace.workspaceId.length === 0) {
    throw new Error("DSH workspace/create returned no workspaceId");
  }
  if (workspace.path !== cwd) {
    throw new Error(
      `DSH workspace path mismatch: requested ${cwd}, received ${String(workspace.path)}`,
    );
  }
  return workspace;
}

export async function createWorkspaceSession(
  bridge,
  { workspaceId, agentPreset, sessionId },
  signal,
) {
  return bridge.rpc("session/create", {
    request: {
      workspaceId,
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(sessionId === undefined ? {} : { sessionId }),
    },
  }, signal);
}
