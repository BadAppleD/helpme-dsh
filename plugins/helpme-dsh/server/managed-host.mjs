import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, mkdir, open, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 3_000;

export function managedHostPaths(env = process.env) {
  const runtimeDir = env.HELPME_DSH_RUNTIME_DIR ??
    join(homedir(), ".config", "helpme-dsh", "runtime");
  return {
    runtimeDir,
    socketPath: join(runtimeDir, "host.sock"),
    statePath: join(runtimeDir, "host-state.json"),
    lockPath: join(runtimeDir, "host-start.lock"),
  };
}

async function prepareRuntime(paths) {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const metadata = await lstat(paths.runtimeDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`HelpMe DSH runtime path is not a real directory: ${paths.runtimeDir}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`HelpMe DSH runtime directory is not owned by the current user: ${paths.runtimeDir}`);
  }
  await chmod(paths.runtimeDir, 0o700);
  const marker = await open(paths.lockPath, "a", 0o600);
  await chmod(paths.lockPath, 0o600);
  await marker.close();
}

async function acquireLifecycleLock(paths) {
  await prepareRuntime(paths);
  return lockfile.lock(paths.lockPath, {
    realpath: false,
    retries: { retries: 600, factor: 1, minTimeout: 50, maxTimeout: 50 },
    stale: 30_000,
    update: 5_000,
  });
}

async function readState(paths) {
  try {
    return JSON.parse(await readFile(paths.statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function requestManagedHost(command, {
  paths = managedHostPaths(),
  timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(paths.socketPath);
    let settled = false;
    let input = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(new Error(`HelpMe DSH Host control timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(input.slice(0, newline));
        if (response?.ok !== true) {
          finish(new Error(response?.error ?? "HelpMe DSH Host rejected the request"));
          return;
        }
        finish(undefined, response.value);
      } catch (error) {
        finish(new Error("HelpMe DSH Host returned invalid control data", { cause: error }));
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ command })}\n`);
    });
  });
}

async function readFailure(paths, startedAfterMs) {
  const state = await readState(paths);
  if (state?.status === "failed" && state.updatedAt >= startedAfterMs) {
    return new Error(state.error ?? "HelpMe DSH Host failed to start");
  }
  return undefined;
}

export async function ensureManagedHost({
  env = process.env,
  paths = managedHostPaths(env),
  timeoutMs = Number(env.HELPME_DSH_START_TIMEOUT_MS ?? DEFAULT_START_TIMEOUT_MS),
} = {}) {
  let release;
  try {
    release = await acquireLifecycleLock(paths);
    try {
      return await requestManagedHost("connection", { paths });
    } catch {
      const state = await readState(paths);
      if ((state?.status === "ready" || state?.status === "starting") && processExists(state.pid)) {
        throw new Error(
          `HelpMe DSH Host process ${state.pid} is alive but its control socket is unavailable; refusing to orphan or replace it`,
        );
      }
      await rm(paths.socketPath, { force: true });
    }

    const startedAt = Date.now();
    const generation = randomUUID();
    await rm(paths.statePath, { force: true });
    const daemonEntry = fileURLToPath(new URL("./host-daemon.mjs", import.meta.url));
    const child = spawn(process.execPath, [daemonEntry], {
      cwd: homedir(),
      detached: true,
      env: { ...env, HELPME_DSH_HOST_GENERATION: generation },
      stdio: "ignore",
    });
    child.unref();

    const deadline = startedAt + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      const failure = await readFailure(paths, startedAt);
      if (failure !== undefined) throw failure;
      try {
        return await requestManagedHost("connection", { paths, timeoutMs: 500 });
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(
      `HelpMe DSH Host did not become ready on 127.0.0.1:${env.HELPME_DSH_PORT ?? "3080"}`,
      { cause: lastError },
    );
  } finally {
    await release?.();
  }
}

export async function stopManagedHost({
  paths = managedHostPaths(),
  timeoutMs = 10_000,
} = {}) {
  let release;
  try {
    release = await acquireLifecycleLock(paths);
    await requestManagedHost("stop", { paths, timeoutMs });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ECONNREFUSED") return false;
    throw error;
  } finally {
    await release?.();
  }
}
