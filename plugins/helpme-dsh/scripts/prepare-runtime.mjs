import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = await realpath(dirname(dirname(fileURLToPath(import.meta.url))));
const serverDir = join(pluginRoot, "server");
const files = (await readdir(serverDir)).filter((name) =>
  name.endsWith(".mjs") || name === "package.json" || name === "package-lock.json"
).sort();
const contents = await Promise.all(files.map(async (name) => {
  if (!(await lstat(join(serverDir, name))).isFile()) {
    throw new Error(`HelpMe DSH runtime source must be a regular file: ${name}`);
  }
  return readFile(join(serverDir, name));
}));
const hash = createHash("sha256");
const mcpConfig = await readFile(join(pluginRoot, ".mcp.json"));
hash.update(".mcp.json\0").update(mcpConfig).update("\0");
for (const [index, name] of files.entries()) {
  hash.update(name).update("\0").update(contents[index]).update("\0");
}

const cacheRoot = resolve(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "helpme-dsh", "runtimes");
function insidePlugin(path) {
  const child = relative(pluginRoot, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
async function destinationPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return join(await destinationPath(dirname(path)), basename(path));
  }
}
if (insidePlugin(await destinationPath(cacheRoot))) {
  throw new Error("HelpMe DSH runtime must be outside the plugin directory");
}
await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
async function checkDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error(`HelpMe DSH runtime must be a directory owned by the current user: ${path}`);
  }
  await chmod(path, 0o700);
}
await checkDirectory(cacheRoot);
const generationDir = join(cacheRoot, hash.digest("hex"));
const runtimeDir = join(generationDir, "server");
async function runtimeReady() {
  try {
    await checkDirectory(generationDir);
    await checkDirectory(runtimeDir);
    return (await lstat(join(runtimeDir, ".ready"))).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

if (!(await runtimeReady())) {
  // shortcut: concurrent cold starts may each install; add shared coordination if startup load warrants it.
  // shortcut: SIGKILL can leave unpublished staging directories; add pruning if interrupted installs accumulate.
  const staging = await mkdtemp(join(cacheRoot, ".install-"));
  try {
    const stagedServer = join(staging, "server");
    await mkdir(stagedServer, { mode: 0o700 });
    await writeFile(join(staging, ".mcp.json"), mcpConfig, { mode: 0o600 });
    for (const [index, name] of files.entries()) {
      await writeFile(join(stagedServer, name), contents[index], { mode: 0o600 });
    }
    process.stderr.write("helpme-dsh: installing pinned dependencies in external runtime...\n");
    await new Promise((resolveInstall, reject) => {
      const child = spawn("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: stagedServer,
        stdio: ["ignore", 2, 2],
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolveInstall();
        else reject(new Error(`HelpMe DSH dependency installation failed (code=${code}, signal=${signal})`));
      });
    });
    await writeFile(join(stagedServer, ".ready"), "", { mode: 0o600 });
    try {
      await rename(staging, generationDir);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !(await runtimeReady())) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
process.stdout.write(`${runtimeDir}\n`);
