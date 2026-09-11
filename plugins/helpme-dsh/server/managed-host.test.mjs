import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  ensureManagedHost,
  managedHostPaths,
  requestManagedHost,
  stopManagedHost,
} from "./managed-host.mjs";

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fakeDsh(root) {
  const script = join(root, "fake-dsh.mjs");
  await writeFile(script, `#!/usr/bin/env node
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const server = createServer((_request, response) => response.end("ok"));
server.once("error", (error) => { console.error(error.message); process.exit(1); });
setTimeout(() => server.listen(port, "127.0.0.1", () => {
  console.log(\`dsh web: http://127.0.0.1:\${port}/?token=test-secret\`);
}), Number(process.env.FAKE_DSH_START_DELAY_MS ?? 0));
process.once("SIGTERM", () => setTimeout(
  () => server.close(() => process.exit(0)),
  Number(process.env.FAKE_DSH_STOP_DELAY_MS ?? 0),
));
`, { mode: 0o700 });
  await chmod(script, 0o700);
  return script;
}

test("one managed daemon is shared and stopped through its protected socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "helpme-dsh-host-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await unusedPort();
  const env = {
    ...process.env,
    HELPME_DSH_RUNTIME_DIR: join(root, "runtime"),
    HELPME_DSH_PORT: String(port),
    DSH_BINARY: await fakeDsh(root),
  };
  const paths = managedHostPaths(env);
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o777 });
  await chmod(paths.runtimeDir, 0o777);
  t.after(() => stopManagedHost({ paths }).catch(() => {}));

  const [first, second] = await Promise.all([
    ensureManagedHost({ env, paths }),
    ensureManagedHost({ env, paths }),
  ]);
  assert.equal(first.pid, second.pid);
  assert.equal(first.origin, `http://127.0.0.1:${port}`);
  assert.match(first.launchUrl, /token=test-secret/u);

  const status = await requestManagedHost("status", { paths });
  assert.equal(status.running, true);
  assert.equal(status.pid, first.pid);
  assert.equal((await stat(paths.runtimeDir)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.socketPath)).mode & 0o777, 0o600);
  const state = await readFile(paths.statePath, "utf8");
  assert.doesNotMatch(state, /test-secret/u);

  assert.equal(await stopManagedHost({ paths }), true);
});

test("a concurrent ensure waits for stop and starts a new generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "helpme-dsh-host-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await unusedPort();
  const env = {
    ...process.env,
    HELPME_DSH_RUNTIME_DIR: join(root, "runtime"),
    HELPME_DSH_PORT: String(port),
    DSH_BINARY: await fakeDsh(root),
    FAKE_DSH_STOP_DELAY_MS: "300",
  };
  const paths = managedHostPaths(env);
  t.after(() => stopManagedHost({ paths }).catch(() => {}));
  const first = await ensureManagedHost({ env, paths });

  const stopping = stopManagedHost({ paths });
  await delay(50);
  const restarted = ensureManagedHost({ env, paths });
  assert.equal(await stopping, true);
  const second = await restarted;
  assert.notEqual(second.pid, first.pid);
  assert.equal((await requestManagedHost("status", { paths })).pid, second.pid);
});

test("a second cold-start caller waits longer than five seconds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "helpme-dsh-host-slow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await unusedPort();
  const env = {
    ...process.env,
    HELPME_DSH_RUNTIME_DIR: join(root, "runtime"),
    HELPME_DSH_PORT: String(port),
    HELPME_DSH_START_TIMEOUT_MS: "10000",
    FAKE_DSH_START_DELAY_MS: "5200",
    DSH_BINARY: await fakeDsh(root),
  };
  const paths = managedHostPaths(env);
  t.after(() => stopManagedHost({ paths }).catch(() => {}));

  const [first, second] = await Promise.all([
    ensureManagedHost({ env, paths }),
    ensureManagedHost({ env, paths }),
  ]);
  assert.equal(first.pid, second.pid);
});

test("an unknown listener is preserved and startup fails clearly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "helpme-dsh-host-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const { port } = blocker.address();
  const env = {
    ...process.env,
    HELPME_DSH_RUNTIME_DIR: join(root, "runtime"),
    HELPME_DSH_PORT: String(port),
    HELPME_DSH_START_TIMEOUT_MS: "3000",
    DSH_BINARY: await fakeDsh(root),
  };
  const paths = managedHostPaths(env);

  await assert.rejects(
    ensureManagedHost({ env, paths }),
    /DSH Web exited before startup.*EADDRINUSE/u,
  );
  assert.equal(blocker.listening, true);
});
