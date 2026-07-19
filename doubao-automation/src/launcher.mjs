import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { cdpEndpoint, waitForCdp } from "./cdp.mjs";

export async function reserveLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function launchDoubao({ executablePath, profileDir, port = 0 }) {
  if (!path.isAbsolute(executablePath)) {
    throw new Error("Doubao executable path must be absolute.");
  }
  if (!path.isAbsolute(profileDir)) {
    throw new Error("Doubao profile directory must be absolute.");
  }

  await mkdir(profileDir, { recursive: true });
  const selectedPort = port || await reserveLoopbackPort();
  const endpoint = cdpEndpoint({ port: selectedPort });
  const args = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${selectedPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
  ];
  const child = spawn(executablePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  const version = await waitForCdp(endpoint);
  return {
    endpoint,
    pid: child.pid,
    port: selectedPort,
    profileDir,
    version,
  };
}
