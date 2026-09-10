#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import lockfile from "proper-lockfile";
import { z } from "zod";

const BUNDLED_DSH_ENTRY = fileURLToPath(
  new URL("./node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url),
);
const DSH_COMMAND = process.env.DSH_BINARY ?? process.execPath;
const DSH_ARGV_PREFIX = process.env.DSH_BINARY === undefined ? [BUNDLED_DSH_ENTRY] : [];
const DSH_VERSION = "0.1.5-rc.1";
const START_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 20_000;
const STOP_GRACE_MS = 3_000;
const POLL_INTERVAL_MS = 500;

const WORK_MODES = ["standard", "ptc", "minimal", "cordis"];
const PERMISSION_PRESETS = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];
const SAFE_PERMISSION_PRESETS = ["read-only", "workspace-write"];
const REASONING_EFFORTS = ["off", "low", "high", "max"];

const allowedRootsFile = join(homedir(), ".config", "helpme-dsh", "allowed-roots");
let configuredRoots;
if (process.env.DSH_ALLOWED_ROOTS !== undefined) {
  configuredRoots = process.env.DSH_ALLOWED_ROOTS.split(delimiter).filter(Boolean);
} else {
  try {
    configuredRoots = readFileSync(allowedRootsFile, "utf8")
      .split(/\r?\n/)
      .map((root) => root.trim())
      .filter(Boolean);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    configuredRoots = [homedir()];
  }
}
if (configuredRoots.length === 0) {
  throw new Error("DSH workspace allowlist is empty");
}
const SESSION_LOCK_DIR = join(tmpdir(), "codex-dsh-mcp-locks");
let hostRunBusy = false;

function combinedSignal(signal, timeoutMs = RPC_TIMEOUT_MS) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal !== undefined) signals.push(signal);
  return AbortSignal.any(signals);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function withSessionLock(sessionId, operation) {
  await mkdir(SESSION_LOCK_DIR, { recursive: true, mode: 0o700 });
  const lockName = createHash("sha256").update(sessionId).digest("hex");
  const markerPath = join(SESSION_LOCK_DIR, lockName);
  const marker = await open(markerPath, "a", 0o600);
  await marker.close();
  let release;
  try {
    release = await lockfile.lock(markerPath, {
      realpath: false,
      retries: 0,
      stale: 120_000,
      update: 30_000,
    });
  } catch (error) {
    if (error.code === "ELOCKED") throw new Error(`DSH session is busy: ${sessionId}`);
    throw error;
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function withHostRunLock(operation) {
  if (hostRunBusy) throw new Error("DSH Host is busy with another run");
  hostRunBusy = true;
  try {
    return await operation();
  } finally {
    hostRunBusy = false;
  }
}

class DshHostBridge {
  constructor() {
    this.child = undefined;
    this.origin = undefined;
    this.cookie = undefined;
    this.startPromise = undefined;
  }

  async start() {
    if (this.origin !== undefined && this.cookie !== undefined) return;
    if (this.startPromise !== undefined) return this.startPromise;
    this.startPromise = this.#startOnce();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async #startOnce() {
    const child = spawn(DSH_COMMAND, [...DSH_ARGV_PREFIX, "web", "--no-open", "--port", "0"], {
      cwd: homedir(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    let settled = false;
    const urlPromise = new Promise((resolveUrl, rejectUrl) => {
      const timer = setTimeout(() => {
        rejectUrl(new Error(`DSH Web did not publish a URL within ${START_TIMEOUT_MS} ms`));
      }, START_TIMEOUT_MS);

      const inspectLine = (line) => {
        const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(line);
        if (match === null || settled) return;
        settled = true;
        clearTimeout(timer);
        resolveUrl(match[1]);
      };

      for (const stream of [child.stdout, child.stderr]) {
        const lines = createInterface({ input: stream });
        lines.on("line", (line) => {
          inspectLine(line);
          if (!line.includes("?token=")) process.stderr.write(`[dsh] ${line}\n`);
        });
      }

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectUrl(error);
      });
      child.once("exit", (code, signal) => {
        if (this.child === child) {
          this.child = undefined;
          this.origin = undefined;
          this.cookie = undefined;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectUrl(new Error(`DSH Web exited before startup (code=${code}, signal=${signal})`));
      });
    });

    try {
      const launchUrl = await urlPromise;
      const parsed = new URL(launchUrl);
      const response = await fetch(launchUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (response.status !== 302 && response.status !== 303) {
        throw new Error(`DSH token exchange returned HTTP ${response.status}`);
      }
      const setCookie = response.headers.getSetCookie?.()[0] ??
        response.headers.get("set-cookie");
      if (setCookie === null || setCookie === undefined) {
        throw new Error("DSH token exchange returned no browser-session cookie");
      }
      this.origin = parsed.origin;
      this.cookie = setCookie.split(";", 1)[0];
    } catch (error) {
      child.kill("SIGTERM");
      if (!(await waitForExit(child, STOP_GRACE_MS))) child.kill("SIGKILL");
      throw error;
    }
  }

  async rpc(method, args, signal, timeoutMs = RPC_TIMEOUT_MS) {
    await this.start();
    const rpcId = randomUUID();
    const response = await fetch(`${this.origin}/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: this.cookie,
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method,
        payload: { args },
      }),
      signal: combinedSignal(signal, timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`DSH RPC ${method} returned HTTP ${response.status}`);
    }
    const envelope = await response.json();
    if (envelope?.type !== "server-response" || envelope.rpcId !== rpcId) {
      throw new Error(`DSH RPC ${method} returned an invalid response envelope`);
    }
    if (envelope.result?.ok !== true) {
      const failure = envelope.result?.error;
      throw new Error(`${failure?.code ?? "dsh/error"}: ${failure?.message ?? "unknown DSH failure"}`);
    }
    return envelope.result.value;
  }

  async stop() {
    const child = this.child;
    this.child = undefined;
    this.origin = undefined;
    this.cookie = undefined;
    if (child === undefined || child.exitCode !== null) return;
    child.kill("SIGTERM");
    if (!(await waitForExit(child, STOP_GRACE_MS))) {
      child.kill("SIGKILL");
      await waitForExit(child, STOP_GRACE_MS);
    }
  }
}

const bridge = new DshHostBridge();

async function requireWorkspace(cwd) {
  const absolute = await realpath(cwd);
  const metadata = await stat(absolute);
  if (!metadata.isDirectory()) throw new Error(`cwd is not a directory: ${absolute}`);
  const allowedRoots = await Promise.all(configuredRoots.map((root) => realpath(root)));
  if (!allowedRoots.some((root) => {
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return absolute === root || absolute.startsWith(prefix);
  })) {
    throw new Error(`cwd is outside DSH_ALLOWED_ROOTS: ${absolute}`);
  }
  return absolute;
}

async function sessionSummary(sessionId, signal) {
  const value = await bridge.rpc("session/list", { _request: {} }, signal);
  return value.items.find((item) => item.sessionId === sessionId);
}

async function waitForTurn(sessionId, previousTurns, timeoutSeconds, signal) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const summary = await sessionSummary(sessionId, signal);
    const turns = summary?.projections?.values?.turnOutline;
    if (
      summary !== undefined &&
      summary.running === false &&
      Array.isArray(turns) &&
      turns.length > previousTurns
    ) {
      return summary;
    }
    await delay(POLL_INTERVAL_MS, undefined, signal === undefined ? {} : { signal });
  }
  throw new Error(`DSH session ${sessionId} did not finish within ${timeoutSeconds} seconds`);
}

async function fullResponse(sessionId, summary, requestId, signal) {
  const throughSeq = summary?.projections?.asOfSeq;
  if (!Number.isSafeInteger(throughSeq)) throw new Error("DSH session has no stable event cursor");
  let beforeSeq;
  const records = [];
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await bridge.rpc("session/page", {
      request: {
        address: { kind: "session", sessionId },
        throughSeq,
        maxMessages: 100,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      },
    }, signal);
    records.unshift(...page.records);
    const requestRecord = records.find(({ event }) =>
      event?.type === "user/message" && event.data?.source?.rpcId === requestId);
    if (requestRecord !== undefined) break;
    if (!page.hasMore || page.records.length === 0) {
      throw new Error(`DSH completed but request ${requestId} was not found in session history`);
    }
    beforeSeq = page.records[0].event.seq - 1;
  }

  const requestRecord = records.find(({ event }) =>
    event?.type === "user/message" && event.data?.source?.rpcId === requestId);
  if (requestRecord === undefined) throw new Error("DSH request history exceeded the paging safety limit");
  const turnStart = records
    .filter(({ event }) => event?.type === "turn/start" && event.seq <= requestRecord.event.seq)
    .at(-1);
  const turn = turnStart?.event?.data?.turn;
  if (!Number.isSafeInteger(turn)) throw new Error("DSH response has no matching turn boundary");
  const messages = records
    .filter(({ event }) => event?.type === "assistant/message" && event.data?.turn === turn)
    .map(({ event }) => event.data.message?.content)
    .filter(Array.isArray)
    .map((content) => content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(""))
    .filter((text) => text.trim().length > 0);
  const response = messages.at(-1);
  if (response === undefined) throw new Error(`DSH turn ${turn} produced no final assistant text`);
  return response;
}

async function cancelAndSettle(sessionId) {
  let cancelFailure;
  try {
    await bridge.rpc("session/cancel", { request: { sessionId } }, undefined, 5_000);
  } catch (error) {
    cancelFailure = error;
  }
  if (cancelFailure === undefined) {
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline) {
      try {
        const summary = await sessionSummary(sessionId);
        if (summary === undefined || summary.running === false) return;
      } catch (error) {
        cancelFailure = error;
        break;
      }
      await delay(POLL_INTERVAL_MS);
    }
  }
  await bridge.stop();
  throw new Error(
    `DSH session ${sessionId} did not confirm cancellation; its isolated Host was terminated`,
    cancelFailure === undefined ? undefined : { cause: cancelFailure },
  );
}

async function runCreatedSession({
  sessionId,
  task,
  permission,
  provider,
  model,
  reasoningEffort,
  timeoutSeconds,
  signal,
}) {
  const before = await sessionSummary(sessionId, signal);
  if (before === undefined) throw new Error(`DSH session does not exist: ${sessionId}`);
  if (before.running === true) throw new Error(`DSH session is already running: ${sessionId}`);
  const previousTurns = before.projections?.values?.turnOutline?.length ?? 0;

  await bridge.rpc("session/selectModel", {
    request: { sessionId, provider, model, reasoningEffort },
  }, signal);
  const permissionResult = await bridge.rpc("commands/execute", {
    agentId: sessionId,
    line: `/permission ${permission}`,
    submittedAttachments: [],
  }, signal);
  if (permissionResult?.result?.kind !== "success") {
    throw new Error(`DSH rejected permission preset ${permission}`);
  }

  const requestId = randomUUID();
  let promptMayBeRunning = false;
  try {
    promptMayBeRunning = true;
    await bridge.rpc("session/prompt", {
      request: {
        requestId,
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: task }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }, signal);
    const summary = await waitForTurn(sessionId, previousTurns, timeoutSeconds, signal);
    const response = await fullResponse(sessionId, summary, requestId, signal);
    const projections = summary.projections?.values ?? {};
    return {
      sessionId,
      response,
      effective: {
        cwd: summary.cwd,
        workMode: projections.agentPreset,
        permission: projections.permissions?.currentValue,
        model: projections.modelSelection?.lastUsed,
      },
      stats: projections.sessionStats,
    };
  } catch (error) {
    if (promptMayBeRunning) {
      try {
        await cancelAndSettle(sessionId);
      } catch (cancelError) {
        throw new AggregateError([error, cancelError], `DSH run failed and cancellation was not confirmed`);
      }
    }
    throw error;
  }
}

async function invokeDshRunUnlocked({
  task,
  cwd,
  work_mode: workMode,
  provider,
  model,
  reasoning_effort: reasoningEffort,
  session_id: requestedSessionId,
  timeout_seconds: timeoutSeconds,
}, signal, permission) {
  const workspace = await requireWorkspace(cwd);
  const create = async () => bridge.rpc("session/create", {
    request: {
      cwd: workspace,
      agentPreset: workMode,
      ...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
    },
  }, signal);
  const execute = async (sessionId) => runCreatedSession({
    sessionId,
    task,
    permission,
    provider,
    model,
    reasoningEffort,
    timeoutSeconds,
    signal,
  });

  let value;
  if (requestedSessionId !== undefined) {
    value = await withSessionLock(requestedSessionId, async () => {
      const creation = await create();
      return execute(creation.sessionId);
    });
  } else {
    const creation = await create();
    value = await withSessionLock(creation.sessionId, () => execute(creation.sessionId));
  }
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function invokeDshRun(args, signal, permission) {
  return withHostRunLock(() => invokeDshRunUnlocked(args, signal, permission));
}

const commonRunInputSchema = {
  task: z.string().min(1).describe("Complete task for DeepSeek Harness."),
  cwd: z.string().min(1).describe("Absolute workspace directory."),
  work_mode: z.enum(WORK_MODES).default("standard").describe("DSH agent preset."),
  provider: z.string().min(1).default("deepseek-official"),
  model: z.string().min(1).default("deepseek-flash"),
  reasoning_effort: z.enum(REASONING_EFFORTS).default("high"),
  session_id: z.string().min(1).optional().describe("Existing DSH session to continue; omit for a fresh session."),
  timeout_seconds: z.number().int().min(10).max(3600).default(600),
};

const server = new McpServer(
  { name: "dsh-subagent", version: "0.1.0" },
  {
    instructions:
      "Use dsh_run to delegate a task to DeepSeek Harness. Always select cwd, work_mode, permission, model, and reasoning_effort explicitly. Use a fresh session unless the user asks to continue an existing DSH session. Never weaken permission beyond the user's request.",
  },
);

server.registerTool(
  "dsh_capabilities",
  {
    title: "List DeepSeek Harness capabilities",
    description: "List the live DSH model catalog and work-mode presets before choosing run parameters.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (_args, { signal }) => {
    const [models, presets] = await Promise.all([
      bridge.rpc("session/modelCatalog", {}, signal),
      bridge.rpc("agentPresets/list", {}, signal),
    ]);
    const value = {
      dshVersion: DSH_VERSION,
      workModes: presets.presets,
      permissions: PERMISSION_PRESETS,
      models,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
    };
  },
);

server.registerTool(
  "dsh_run",
  {
    title: "Run a DeepSeek Harness subagent",
    description:
      "Run or continue one DSH session with an explicit workspace, DSH agent preset, permission preset, model, and reasoning effort. Returns the final answer and the effective session configuration.",
    inputSchema: {
      ...commonRunInputSchema,
      permission: z.enum(SAFE_PERMISSION_PRESETS).default("workspace-write").describe("DSH sandbox and approval preset."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ permission, ...args }, { signal }) => invokeDshRun(args, signal, permission),
);

server.registerTool(
  "dsh_run_danger",
  {
    title: "Run a DeepSeek Harness subagent with unrestricted access",
    description:
      "Run or continue one DSH session with danger-full-access. This tool always requires an explicit Codex user approval.",
    inputSchema: commonRunInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args, { signal }) => invokeDshRun(args, signal, "danger-full-access"),
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await bridge.stop();
    process.exit(0);
  });
}

process.once("exit", () => {
  if (bridge.child !== undefined && bridge.child.exitCode === null) {
    bridge.child.kill("SIGTERM");
  }
});

await server.connect(new StdioServerTransport());
