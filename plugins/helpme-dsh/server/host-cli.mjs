#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { ensureManagedHost, requestManagedHost, stopManagedHost } from "./managed-host.mjs";

const [command = "status"] = process.argv.slice(2);

if (command === "start") {
  const value = await ensureManagedHost();
  process.stdout.write(`HelpMe DSH Host is ready at ${value.origin}\n`);
} else if (command === "status") {
  try {
    const value = await requestManagedHost("status");
    process.stdout.write(`HelpMe DSH Host is running at ${value.origin} (pid ${value.pid})\n`);
  } catch {
    process.stdout.write("HelpMe DSH Host is stopped\n");
    process.exitCode = 1;
  }
} else if (command === "stop") {
  const stopped = await stopManagedHost();
  process.stdout.write(stopped ? "HelpMe DSH Host stopped\n" : "HelpMe DSH Host was not running\n");
} else if (command === "restart") {
  await stopManagedHost();
  const value = await ensureManagedHost();
  process.stdout.write(`HelpMe DSH Host restarted at ${value.origin}\n`);
} else if (command === "ui") {
  const value = await ensureManagedHost();
  const hasDisplay = process.platform === "darwin" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (hasDisplay) {
    const opened = spawnSync(opener, [value.launchUrl], { stdio: "ignore" });
    if (opened.status === 0) {
      process.stdout.write(`Opened HelpMe DSH UI at ${value.origin}\n`);
    } else {
      process.stdout.write(`${value.launchUrl}\n`);
      process.stderr.write("Could not open a browser. Open this secret authentication URL manually.\n");
    }
  } else {
    process.stdout.write(`${value.launchUrl}\n`);
    process.stderr.write("Open this secret authentication URL through an SSH tunnel to 127.0.0.1:3080.\n");
  }
} else {
  process.stderr.write(`Unknown Host command: ${command}\n`);
  process.exitCode = 2;
}
