#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import lockfile from "proper-lockfile";
import WebSocket from "ws";
import { z } from "zod";
import { EventDrivenTurn } from "./event-driven-turn.mjs";
import { ensureManagedHost } from "./managed-host.mjs";
import {
  createWorkspaceSession,
  ensureDshWorkspace,
} from "./workspace-binding.mjs";

const DSH_VERSION = "0.1.5-rc.1";
const RPC_TIMEOUT_MS = 20_000;
const CANCEL_CONFIRM_GRACE_MS = 3_000;
const FOLLOW_RECONNECT_LIMIT = 3;
const FOLLOW_RECONNECT_DELAY_MS = 200;

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

function normalizeSessionName(value) {
  const name = value.trim();
  if (name.length === 0) throw new Error("DSH session name must not be empty");
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("DSH session name must not contain control characters");
  }
  if (Buffer.byteLength(name, "utf8") > 80) {
    throw new Error("DSH session name must be at most 80 UTF-8 bytes");
  }
  return name;
}

function sessionNameKey(value) {
  return normalizeSessionName(value).toLocaleLowerCase("en-US");
}

function combinedSignal(signal, timeoutMs = RPC_TIMEOUT_MS) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal !== undefined) signals.push(signal);
  return AbortSignal.any(signals);
}

async function withNamedLock(lockKey, busyMessage, operation) {
  await mkdir(SESSION_LOCK_DIR, { recursive: true, mode: 0o700 });
  const lockName = createHash("sha256").update(lockKey).digest("hex");
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
    if (error.code === "ELOCKED") throw new Error(busyMessage);
    throw error;
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function withSessionLock(sessionId, operation) {
  return withNamedLock(
    sessionId,
    `DSH session is busy: ${sessionId}`,
    operation,
  );
}

class AsyncStreamQueue {
  #values = [];
  #waiter;
  #closed = false;
  #failure;

  push(value) {
    if (this.#closed) return;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.#values.push(value);
  }

  close(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter === undefined) return;
    if (error === undefined) waiter.resolve({ value: undefined, done: true });
    else waiter.reject(error);
  }

  async next() {
    if (this.#values.length > 0) return { value: this.#values.shift(), done: false };
    if (this.#closed) {
      if (this.#failure !== undefined) throw this.#failure;
      return { value: undefined, done: true };
    }
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

class DshHostBridge {
  constructor() {
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
    const { origin, launchUrl } = await ensureManagedHost();
    try {
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
      if (parsed.origin !== origin) throw new Error("Managed DSH Host returned mismatched origins");
      this.origin = origin;
      this.cookie = setCookie.split(";", 1)[0];
    } catch (error) {
      this.origin = undefined;
      this.cookie = undefined;
      throw error;
    }
  }

  async rpc(method, args, signal, timeoutMs = RPC_TIMEOUT_MS) {
    await this.start();
    const rpcId = randomUUID();
    let response = await fetch(`${this.origin}/api/${method}`, {
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
    if (response.status === 401 || response.status === 403) {
      await this.stop();
      await this.start();
      response = await fetch(`${this.origin}/api/${method}`, {
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
    }
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

  async *follow(request, signal) {
    await this.start();
    const streamId = randomUUID();
    const queue = new AsyncStreamQueue();
    const streamOrigin = this.origin.replace(/^http/u, "ws");
    const websocket = new WebSocket(`${streamOrigin}/api/remote.mux`, {
      headers: { cookie: this.cookie },
    });
    let opened = false;
    let terminal = false;
    let openingSettled = false;
    let resolveOpening;
    let rejectOpening;
    const opening = new Promise((resolve, reject) => {
      resolveOpening = resolve;
      rejectOpening = reject;
    });
    const settleOpening = (error) => {
      if (openingSettled) return;
      openingSettled = true;
      if (error === undefined) resolveOpening();
      else rejectOpening(error);
    };
    const fail = (error) => {
      settleOpening(error);
      if (!terminal) queue.close(error);
    };
    const closeForAbort = () => {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : new Error("DSH session follow was cancelled", { cause: signal.reason });
      fail(reason);
      websocket.close();
    };
    const parseMessage = (data) => {
      let frame;
      try {
        frame = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch (error) {
        fail(new Error("DSH session follow delivered invalid JSON", { cause: error }));
        websocket.close();
        return;
      }
      if (frame?.streamId !== streamId) return;
      if (frame.type === "item") {
        queue.push(frame.value);
        return;
      }
      if (frame.type === "end") {
        terminal = true;
        queue.close();
        return;
      }
      if (frame.type === "error") {
        const failure = frame.error;
        const code = typeof failure?.code === "string" ? failure.code : "dsh/stream-error";
        const message = typeof failure?.message === "string"
          ? failure.message
          : "DSH session follow failed";
        fail(new Error(`${code}: ${message}`));
        return;
      }
      fail(new Error("DSH session follow delivered an invalid stream frame"));
      websocket.close();
    };
    const onOpen = () => {
      opened = true;
      try {
        websocket.send(JSON.stringify({
          type: "open",
          streamId,
          endpoint: "session/follow",
          payload: { args: { request } },
        }));
        settleOpening();
      } catch (error) {
        fail(error);
      }
    };
    const onError = (error) => fail(error);
    const onUnexpectedResponse = (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) void this.stop();
      fail(new Error(`DSH session follow WebSocket returned HTTP ${response.statusCode}`));
      websocket.close();
    };
    const onClose = () => {
      if (!terminal && !signal.aborted) {
        fail(new Error("DSH session follow WebSocket closed unexpectedly"));
      }
    };
    websocket.once("open", onOpen);
    websocket.on("message", parseMessage);
    websocket.once("error", onError);
    websocket.once("unexpected-response", onUnexpectedResponse);
    websocket.once("close", onClose);
    signal.addEventListener("abort", closeForAbort, { once: true });

    try {
      if (signal.aborted) closeForAbort();
      await opening;
      for await (const frame of queue) yield frame;
    } finally {
      signal.removeEventListener("abort", closeForAbort);
      websocket.removeListener("message", parseMessage);
      if (opened && !terminal && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: "cancel", streamId }));
      }
      terminal = true;
      queue.close();
      if (websocket.readyState === WebSocket.CONNECTING || websocket.readyState === WebSocket.OPEN) {
        websocket.close();
      }
    }
  }

  async stop() {
    this.origin = undefined;
    this.cookie = undefined;
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

async function listSessionSummaries(signal) {
  const value = await bridge.rpc("session/list", { _request: {} }, signal);
  const allowedRoots = await Promise.all(configuredRoots.map((root) => realpath(root)));
  const admitted = await Promise.all(value.items.map(async (item) => {
    if (typeof item.cwd !== "string") return undefined;
    let absolute;
    try {
      absolute = await realpath(item.cwd);
    } catch {
      return undefined;
    }
    const allowed = allowedRoots.some((root) => {
      const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
      return absolute === root || absolute.startsWith(prefix);
    });
    return allowed ? item : undefined;
  }));
  return admitted.filter((item) => item !== undefined);
}

function sessionTitle(summary) {
  const title = summary.projections?.values?.title;
  return typeof title === "string" && title.trim().length > 0 ? title : undefined;
}

function publicSessionSummary(summary) {
  const model = summary.projections?.values?.modelSelection?.lastUsed ?? null;
  const updatedAtMs = summary.updatedAt < 10_000_000_000
    ? summary.updatedAt * 1_000
    : summary.updatedAt;
  return {
    sessionId: summary.sessionId,
    sessionName: sessionTitle(summary) ?? null,
    cwd: summary.cwd ?? null,
    updatedAt: summary.updatedAt,
    updatedAtIso: new Date(updatedAtMs).toISOString(),
    running: summary.running,
    blank: summary.blank,
    workMode: summary.projections?.values?.agentPreset ?? null,
    model,
    stats: summary.projections?.values?.sessionStats ?? null,
  };
}

function validateSessionReference(sessionId, sessionName) {
  if (sessionId !== undefined && sessionName !== undefined) {
    throw new Error("Provide either session_id or session_name, not both");
  }
  if (sessionId === undefined && sessionName === undefined) {
    throw new Error("Provide session_id or session_name");
  }
  return sessionName === undefined
    ? { sessionId }
    : { sessionName: normalizeSessionName(sessionName) };
}

async function resolveSessionReference({ sessionId, sessionName }, signal) {
  const reference = validateSessionReference(sessionId, sessionName);
  const summaries = await listSessionSummaries(signal);
  if (reference.sessionId !== undefined) {
    const summary = summaries.find((item) => item.sessionId === reference.sessionId);
    if (summary === undefined) throw new Error(`DSH session does not exist: ${reference.sessionId}`);
    return summary;
  }

  const key = sessionNameKey(reference.sessionName);
  const matches = summaries.filter((item) => {
    const title = sessionTitle(item);
    return title !== undefined && sessionNameKey(title) === key;
  });
  if (matches.length === 0) throw new Error(`DSH session name does not exist: ${reference.sessionName}`);
  if (matches.length > 1) {
    throw new Error(
      `DSH session name is ambiguous: ${reference.sessionName}; use session_id instead`,
    );
  }
  return matches[0];
}

async function findSessionByName(sessionName, signal) {
  const name = normalizeSessionName(sessionName);
  const key = sessionNameKey(name);
  const summaries = await listSessionSummaries(signal);
  const matches = summaries.filter((item) => {
    const title = sessionTitle(item);
    return title !== undefined && sessionNameKey(title) === key;
  });
  if (matches.length > 1) {
    throw new Error(`DSH session name is ambiguous: ${name}; use session_id instead`);
  }
  return { name, summary: matches[0] };
}

async function withResolvedSessionLock({ session_id: sessionId, session_name: sessionName }, signal, operation) {
  const reference = validateSessionReference(sessionId, sessionName);
  if (reference.sessionId !== undefined) {
    return withSessionLock(reference.sessionId, async () => {
      const summary = await resolveSessionReference(reference, signal);
      return operation(summary);
    });
  }

  return withSessionLock(`name:${sessionNameKey(reference.sessionName)}`, async () => {
    const summary = await resolveSessionReference(reference, signal);
    return withSessionLock(summary.sessionId, async () => {
      const current = await resolveSessionReference({ sessionId: summary.sessionId }, signal);
      return operation(current);
    });
  });
}

class SessionTurnFollow {
  #sessionId;
  #signal;
  #abort = new AbortController();
  #iterator;
  #turn;
  #closed = false;

  constructor(sessionId, requestId, timeoutSeconds, signal, { requireResponse = true } = {}) {
    this.#sessionId = sessionId;
    const signals = [this.#abort.signal, AbortSignal.timeout(timeoutSeconds * 1_000)];
    if (signal !== undefined) signals.push(signal);
    this.#signal = AbortSignal.any(signals);
    this.#turn = new EventDrivenTurn(requestId, { requireResponse });
  }

  async open() {
    await this.#openStream();
  }

  markPromptIssued() {
    this.#turn.markPromptIssued();
  }

  async waitForCompletion() {
    let reconnects = 0;
    while (this.#turn.completion === undefined) {
      try {
        const frame = await this.#iterator.next();
        if (frame.done) throw new Error("DSH session follow ended before turn completion");
        this.#turn.accept(frame.value);
      } catch (error) {
        if (this.#signal.aborted) {
          throw this.#signal.reason instanceof Error
            ? this.#signal.reason
            : new Error("DSH session follow was cancelled", { cause: this.#signal.reason });
        }
        if (reconnects >= FOLLOW_RECONNECT_LIMIT) {
          throw new Error(
            `DSH session follow disconnected ${FOLLOW_RECONNECT_LIMIT} times`,
            { cause: error },
          );
        }
        reconnects += 1;
        await this.#releaseStream();
        await delay(FOLLOW_RECONNECT_DELAY_MS, undefined, { signal: this.#signal });
        await this.#openStream();
      }
    }
    return this.#turn.completion;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    await this.#releaseStream();
  }

  async #openStream() {
    this.#signal.throwIfAborted();
    const stream = bridge.follow({
      address: { kind: "session", sessionId: this.#sessionId },
      maxMessages: 1_000,
    }, this.#signal);
    this.#iterator = stream[Symbol.asyncIterator]();
    const opening = await this.#iterator.next();
    if (opening.done || opening.value?.type !== "snapshot") {
      throw new Error("DSH session follow did not confirm its opening snapshot");
    }
    if (opening.value.header?.id !== this.#sessionId) {
      throw new Error("DSH session follow snapshot identified the wrong session");
    }
    this.#turn.accept(opening.value);
  }

  async #releaseStream() {
    const iterator = this.#iterator;
    this.#iterator = undefined;
    if (iterator === undefined) return;
    try {
      await iterator.return?.();
    } catch {
      // The next reconnect or cancellation request is authoritative. A broken
      // carrier should not hide the original turn failure.
    }
  }
}

async function cancelAndSettle(sessionId, requestId, follower) {
  let confirmation;
  try {
    await bridge.rpc("session/cancel", { request: { sessionId } }, undefined, 5_000);
    // The original caller's AbortSignal may already have fired. Reopen the
    // durable stream with an independent grace timeout and do not release the
    // session lock until the exact prompt's turn has ended.
    await follower.close();
    confirmation = new SessionTurnFollow(
      sessionId,
      requestId,
      CANCEL_CONFIRM_GRACE_MS / 1_000,
      undefined,
      { requireResponse: false },
    );
    await confirmation.open();
    confirmation.markPromptIssued();
    await confirmation.waitForCompletion();
  } catch (error) {
    throw new Error(
      `DSH session ${sessionId} did not confirm cancellation; its state remains uncertain`,
      { cause: error },
    );
  } finally {
    await confirmation?.close();
  }
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
  const follower = new SessionTurnFollow(sessionId, requestId, timeoutSeconds, signal);
  let promptMayBeRunning = false;
  try {
    // The durable snapshot must arrive before prompt submission, otherwise a
    // very short task could complete before the subscriber is attached.
    await follower.open();
    promptMayBeRunning = true;
    follower.markPromptIssued();
    await bridge.rpc("session/prompt", {
      request: {
        requestId,
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: task }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }, signal);
    const completion = await follower.waitForCompletion();
    // This is one post-completion metadata lookup, not the completion signal.
    let summary = before;
    try {
      summary = (await sessionSummary(sessionId)) ?? before;
    } catch {
      // A result backed by turn/end remains valid even if the shared Host's
      // metadata endpoint is briefly unavailable.
    }
    const projections = summary.projections?.values ?? {};
    return {
      sessionId,
      sessionName: sessionTitle(summary) ?? null,
      response: completion.response,
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
        await cancelAndSettle(sessionId, requestId, follower);
      } catch (cancelError) {
        throw new AggregateError([error, cancelError], `DSH run failed and cancellation was not confirmed`);
      }
    } else {
      await follower.close();
    }
    throw error;
  } finally {
    await follower.close();
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
  session_name: requestedSessionName,
  timeout_seconds: timeoutSeconds,
}, signal, permission) {
  const workspace = await requireWorkspace(cwd);
  if (requestedSessionId !== undefined && requestedSessionName !== undefined) {
    throw new Error("Provide either session_id or session_name, not both");
  }
  const create = async (sessionId) => {
    if (sessionId !== undefined) {
      const existing = await sessionSummary(sessionId, signal);
      if (existing !== undefined && await realpath(existing.cwd) !== workspace) {
        throw new Error(
          `DSH session cwd does not match requested workspace: ${existing.cwd}`,
        );
      }
    }
    const dshWorkspace = await ensureDshWorkspace(bridge, workspace, signal);
    return createWorkspaceSession(bridge, {
      workspaceId: dshWorkspace.workspaceId,
      agentPreset: workMode,
      sessionId,
    }, signal);
  };
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
      const creation = await create(requestedSessionId);
      return execute(creation.sessionId);
    });
  } else if (requestedSessionName !== undefined) {
    const name = normalizeSessionName(requestedSessionName);
    value = await withSessionLock(`name:${sessionNameKey(name)}`, async () => {
      const existing = await findSessionByName(name, signal);
      if (existing.summary !== undefined) {
        return withSessionLock(existing.summary.sessionId, async () => {
          const creation = await create(existing.summary.sessionId);
          return execute(creation.sessionId);
        });
      }

      const creation = await create();
      await bridge.rpc("session/rename", {
        request: { sessionId: creation.sessionId, title: name },
      }, signal);
      return withSessionLock(creation.sessionId, () => execute(creation.sessionId));
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
  return invokeDshRunUnlocked(args, signal, permission);
}

async function invokeSessionList({ cwd, include_blank: includeBlank, limit }, signal) {
  const workspace = cwd === undefined ? undefined : await requireWorkspace(cwd);
  const summaries = await listSessionSummaries(signal);
  const sessions = summaries
    .filter((summary) => (includeBlank || !summary.blank) && (workspace === undefined || summary.cwd === workspace))
    .slice(0, limit)
    .map(publicSessionSummary);
  const value = { sessions };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function invokeSessionGet(args, signal) {
  const summary = await resolveSessionReference({
    sessionId: args.session_id,
    sessionName: args.session_name,
  }, signal);
  const value = { session: publicSessionSummary(summary) };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function invokeSessionClose(args, signal) {
  return withResolvedSessionLock(args, signal, async (summary) => {
    if (summary.running) throw new Error(`DSH session is still running: ${summary.sessionId}`);
    await bridge.rpc("workspace/archiveSession", {
      request: { sessionId: summary.sessionId },
    }, signal);
    const value = {
      sessionId: summary.sessionId,
      sessionName: sessionTitle(summary) ?? null,
      closed: true,
      archived: true,
      historyRetained: true,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
    };
  });
}

const commonRunInputSchema = {
  task: z.string().min(1).describe("Complete task for DeepSeek Harness."),
  cwd: z.string().min(1).describe("Absolute workspace directory."),
  work_mode: z.enum(WORK_MODES).default("standard").describe("DSH agent preset."),
  provider: z.string().min(1).default("deepseek-official"),
  model: z.string().min(1).default("deepseek-flash"),
  reasoning_effort: z.enum(REASONING_EFFORTS).default("high"),
  session_id: z.string().min(1).optional().describe("Existing DSH session to continue; omit for a fresh session."),
  session_name: z.string().min(1).max(80).optional().describe(
    "Readable persistent DSH session name. Reuses an existing matching session or creates and names a new one. Do not combine with session_id.",
  ),
  timeout_seconds: z.number().int().min(10).max(3600).default(1800).describe(
    "Maximum run time in seconds; defaults to 1800 seconds (30 minutes) and is capped at 3600 seconds (60 minutes).",
  ),
};

const sessionReferenceInputSchema = {
  session_id: z.string().min(1).optional().describe("Exact DSH session ID."),
  session_name: z.string().min(1).max(80).optional().describe(
    "Readable DSH session name. Names are matched case-insensitively. Do not combine with session_id.",
  ),
};

const server = new McpServer(
  { name: "helpme-dsh", version: "0.5.0" },
  {
    instructions:
      "Delegate bounded coding, analysis, debugging, and review tasks to DeepSeek Harness. Normally call dsh_run directly with cwd set to the active workspace; omitted controls default to standard mode, workspace-write, deepseek-official/deepseek-flash, high reasoning, and a 30-minute timeout. Independent sessions, including write-capable sessions, may run concurrently; give each one a non-overlapping task and never invoke the same session concurrently. Give a new long-lived subagent a session_name; reuse that name or the returned sessionId when the user says continue, and do not create a fresh session in that case. Use dsh_sessions only to resolve ambiguity, dsh_session_get for one summary, and dsh_session_close to archive a finished session without deleting its history. Call dsh_capabilities only for live alternatives. Use dsh_run_danger only for an explicit unrestricted-access request. Never expose DSH credentials, tokens, or cookies.",
  },
);

server.registerTool(
  "dsh_capabilities",
  {
    title: "List DeepSeek Harness capabilities",
    description:
      "Inspect the live DSH model catalog, work-mode presets, and permission choices. Use this only when the user asks what is available or requests a non-default selection that must be resolved; it is not required before a normal dsh_run call.",
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
      sessionManagement: {
        readableNames: true,
        multipleSessions: true,
        sharedUiOrigin: "http://127.0.0.1:3080",
        managedSingletonHost: true,
        automaticWorkspaceGrouping: true,
        parallelRunsPerMcpConnection: true,
        writeCapableRunsParallel: true,
        sameWritableWorkspaceParallel: true,
        dangerFullAccessParallel: true,
        closeBehavior: "archive-with-history-retained",
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
    };
  },
);

server.registerTool(
  "dsh_sessions",
  {
    title: "List DeepSeek Harness sessions",
    description:
      "List recent visible DSH sessions under the configured workspace allowlist. Use this only when the user asks for sessions or when a requested continuation is ambiguous. Returns readable names, IDs, workspaces, running state, model, and summary statistics.",
    inputSchema: {
      cwd: z.string().min(1).optional().describe("Optional absolute workspace directory filter."),
      include_blank: z.boolean().default(false).describe("Include sessions that have no completed prompt."),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args, { signal }) => invokeSessionList(args, signal),
);

server.registerTool(
  "dsh_session_get",
  {
    title: "Get one DeepSeek Harness session",
    description:
      "Get one visible DSH session summary by exact session_id or readable session_name. Provide exactly one reference. Use the returned identity when continuing the subagent with dsh_run.",
    inputSchema: sessionReferenceInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args, { signal }) => invokeSessionGet(args, signal),
);

server.registerTool(
  "dsh_session_close",
  {
    title: "Close one DeepSeek Harness session",
    description:
      "Close a completed DSH session by archiving it from visible session lists. This retains the persisted DSH history and does not delete workspace files. Provide exactly one of session_id or session_name. A running session is rejected rather than cancelled.",
    inputSchema: sessionReferenceInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args, { signal }) => invokeSessionClose(args, signal),
);

server.registerTool(
  "dsh_run",
  {
    title: "Run a DeepSeek Harness subagent",
    description:
      "Delegate one bounded coding, analysis, debugging, or review task to DeepSeek Harness. Set session_name to create or continue a readable long-lived subagent, or session_id to continue an exact session; omit both only for a fresh unnamed session. Set cwd to the active workspace. Omitted controls use standard mode, workspace-write, deepseek-official/deepseek-flash, high reasoning, and a 30-minute timeout. Returns the final answer, session name, session ID, and effective configuration.",
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
      "Delegate a task with danger-full-access. Use only when the user explicitly requests unrestricted access and approves the elevated risk; never select this tool merely because the normal workspace-write run failed.",
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

await server.connect(new StdioServerTransport());
