#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { managedHostPaths } from "./managed-host.mjs";

process.umask(0o077);

const DSH_ENTRY = fileURLToPath(new URL("./node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url));
const DSH_COMMAND = process.env.DSH_BINARY ?? process.execPath;
const DSH_PREFIX = process.env.DSH_BINARY === undefined ? [DSH_ENTRY] : [];
const HOST = "127.0.0.1";
const PORT = Number(process.env.HELPME_DSH_PORT ?? 3080);
const START_TIMEOUT_MS = Number(process.env.HELPME_DSH_START_TIMEOUT_MS ?? 20_000);
const STOP_GRACE_MS = 3_000;
const paths = managedHostPaths();
const generation = process.env.HELPME_DSH_HOST_GENERATION;
if (typeof generation !== "string" || generation.length === 0) {
  throw new Error("HelpMe DSH Host daemon requires a lifecycle generation");
}

await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });

async function writeState(status, extra = {}) {
  await writeFile(paths.statePath, `${JSON.stringify({
    status,
    generation,
    pid: process.pid,
    host: HOST,
    port: PORT,
    updatedAt: Date.now(),
    ...extra,
  })}\n`, { mode: 0o600 });
  await chmod(paths.statePath, 0o600);
}

async function removeOwnedSocket() {
  try {
    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    if (state?.generation !== generation) return;
  } catch {
    return;
  }
  await rm(paths.socketPath, { force: true });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

await writeState("starting");
const child = spawn(DSH_COMMAND, [
  ...DSH_PREFIX,
  "web",
  "--no-open",
  "--host",
  HOST,
  "--port",
  String(PORT),
], {
  cwd: homedir(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

let launchUrl;
let startupOutput = "";
let startupSettled = false;
let resolveStartup;
let rejectStartup;
const startup = new Promise((resolve, reject) => {
  resolveStartup = resolve;
  rejectStartup = reject;
});
const startupTimer = setTimeout(() => {
  rejectStartup(new Error(`DSH Web did not publish a URL within ${START_TIMEOUT_MS} ms`));
}, START_TIMEOUT_MS);

function inspectLine(line) {
  if (!line.includes("?token=")) startupOutput = `${startupOutput}\n${line}`.slice(-4_000);
  const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/u.exec(line);
  if (match === null || startupSettled) return;
  startupSettled = true;
  clearTimeout(startupTimer);
  launchUrl = match[1];
  resolveStartup();
}

for (const stream of [child.stdout, child.stderr]) {
  const lines = createInterface({ input: stream });
  lines.on("line", inspectLine);
}
child.once("error", (error) => {
  if (startupSettled) return;
  startupSettled = true;
  clearTimeout(startupTimer);
  rejectStartup(error);
});
child.once("exit", (code, signal) => {
  if (startupSettled) return;
  startupSettled = true;
  clearTimeout(startupTimer);
  const detail = startupOutput.trim().split("\n").at(-1);
  rejectStartup(new Error(
    `DSH Web exited before startup (code=${code}, signal=${signal})${detail ? `: ${detail}` : ""}`,
  ));
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  control.close();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    if (!(await waitForExit(child, STOP_GRACE_MS))) {
      child.kill("SIGKILL");
      await waitForExit(child, STOP_GRACE_MS);
    }
  }
  await removeOwnedSocket();
  await writeState("stopped");
}

const control = createServer((socket) => {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    let command;
    try {
      command = JSON.parse(input.slice(0, newline))?.command;
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "invalid control request" })}\n`);
      return;
    }
    if (command === "connection") {
      socket.end(`${JSON.stringify({ ok: true, value: {
        origin: `http://${HOST}:${PORT}`,
        launchUrl,
        pid: process.pid,
      } })}\n`);
      return;
    }
    if (command === "status") {
      socket.end(`${JSON.stringify({ ok: true, value: {
        running: true,
        origin: `http://${HOST}:${PORT}`,
        pid: process.pid,
      } })}\n`);
      return;
    }
    if (command === "stop") {
      void shutdown().then(() => {
        socket.end(
          `${JSON.stringify({ ok: true, value: { stopped: true } })}\n`,
          () => process.exit(0),
        );
      });
      return;
    }
    socket.end(`${JSON.stringify({ ok: false, error: "unknown control command" })}\n`);
  });
});

try {
  await startup;
  await new Promise((resolve, reject) => {
    control.once("listening", resolve);
    control.once("error", reject);
    control.listen(paths.socketPath);
  });
  await chmod(paths.socketPath, 0o600);
  await writeState("ready");
} catch (error) {
  const message = error instanceof Error ? error.message.replace(/token=[^\s]+/gu, "token=[redacted]") : String(error);
  await writeState("failed", { error: message });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void shutdown().then(() => process.exit(0)));
}
child.once("exit", async (code, signal) => {
  if (stopping) return;
  control.close();
  await removeOwnedSocket();
  await writeState("failed", {
    error: `DSH Web exited unexpectedly (code=${code}, signal=${signal})`,
  });
  process.exit(1);
});
