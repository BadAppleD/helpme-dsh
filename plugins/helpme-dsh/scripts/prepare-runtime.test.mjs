import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "helpme-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, "plugin");
  const bin = join(root, "bin");
  await mkdir(join(plugin, "scripts"), { recursive: true });
  await mkdir(join(plugin, "server"));
  await mkdir(bin);
  const script = join(plugin, "scripts", "prepare-runtime.mjs");
  await copyFile(new URL("./prepare-runtime.mjs", import.meta.url), script);
  await writeFile(join(plugin, ".mcp.json"), '{}\n');
  await writeFile(join(plugin, "server", "server.mjs"), "console.log('fixture');\n");
  await writeFile(join(plugin, "server", "package.json"), '{"type":"module"}\n');
  await writeFile(join(plugin, "server", "package-lock.json"), '{}\n');
  await writeFile(join(bin, "npm"), "#!/bin/sh\nif [ \"${KILL_INSTALLER:-0}\" = 1 ]; then kill -KILL \"$PPID\"; exit 1; fi\nprintf 'install\\n' >> npm-calls\n[ \"${FAIL_INSTALL:-0}\" = 0 ]\n", { mode: 0o755 });
  const env = { ...process.env, XDG_DATA_HOME: join(root, "data"), PATH: `${bin}:${process.env.PATH}` };
  const run = async (extra = {}) => (await exec(process.execPath, [script], { env: { ...env, ...extra } })).stdout.trim();
  return { root, plugin, env, run };
}

test("concurrent launches publish one complete external runtime and source changes select a new one", async (t) => {
  const f = await fixture(t);
  const paths = await Promise.all([f.run(), f.run(), f.run()]);
  assert.equal(new Set(paths).size, 1);
  const runtime = paths[0];
  assert.ok(runtime.startsWith(join(f.root, "data")));
  assert.deepEqual(await readdir(join(f.plugin, "server")), ["package-lock.json", "package.json", "server.mjs"]);
  assert.equal(await readFile(join(runtime, "npm-calls"), "utf8"), "install\n");
  assert.equal((await stat(runtime)).mode & 0o777, 0o700);
  assert.equal(await f.run(), runtime);
  await writeFile(join(f.plugin, "server", "server.mjs"), "console.log('updated');\n");
  const updated = await f.run();
  assert.notEqual(updated, runtime);
  assert.equal(await readFile(join(updated, "server.mjs"), "utf8"), "console.log('updated');\n");
});

test("failed installation publishes nothing and can be retried", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ FAIL_INSTALL: "1" }), /installation failed/);
  const cache = join(f.env.XDG_DATA_HOME, "helpme-dsh", "runtimes");
  assert.deepEqual(await readdir(cache), []);
  const runtime = await f.run();
  assert.ok((await stat(join(runtime, ".ready"))).isFile());
});

test("a forcibly killed installer cannot block the next launch", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ KILL_INSTALLER: "1" }), { signal: "SIGKILL" });
  const runtime = await f.run();
  assert.ok((await stat(join(runtime, ".ready"))).isFile());
});

test("refuses runtime installation inside the plugin", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "plugin-alias");
  await symlink(f.plugin, alias);
  for (const path of [f.plugin, join(f.plugin, "..data"), alias]) {
    await assert.rejects(f.run({ XDG_DATA_HOME: path }), /outside the plugin/);
  }
  assert.deepEqual(await readdir(f.plugin), [".mcp.json", "scripts", "server"]);
});

test("refuses a symlink in place of the runtime cache", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.env.XDG_DATA_HOME, "helpme-dsh"), { recursive: true });
  const target = join(f.root, "other");
  await mkdir(target);
  await symlink(target, join(f.env.XDG_DATA_HOME, "helpme-dsh", "runtimes"));
  await assert.rejects(f.run(), /directory owned by the current user/);
});
