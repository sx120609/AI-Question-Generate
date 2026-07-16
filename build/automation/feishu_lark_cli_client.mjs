import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const DEFAULT_LARK_CLI_PACKAGE = "@larksuite/cli@latest";

function env(name) {
  return process.env[name]?.trim() || "";
}

function dependencyRootFromNode() {
  return path.resolve(path.dirname(process.execPath), "..", "..");
}

function bundledPnpmPath() {
  const explicit = env("PNPM_BIN");
  if (explicit) {
    // A JavaScript Corepack/pnpm entrypoint cannot be spawned directly on
    // Windows. Run it through the current Node executable instead. This also
    // lets callers recover when a bundled pnpm.cmd still points at an older
    // desktop-runtime directory.
    if (/\.(?:cjs|mjs|js)$/iu.test(explicit)) return process.execPath;
    return explicit;
  }
  const name = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return path.join(dependencyRootFromNode(), "bin", name);
}

function bundledPnpmNodeArgs() {
  const explicit = env("PNPM_BIN");
  if (explicit) return /\.(?:cjs|mjs|js)$/iu.test(explicit) ? [explicit] : null;
  const pnpmMjs = path.join(dependencyRootFromNode(), "node", "node_modules", "pnpm", "bin", "pnpm.mjs");
  return [pnpmMjs];
}

function withRuntimePath(extraEnv = {}) {
  const depRoot = dependencyRootFromNode();
  const nodeBin = path.dirname(process.execPath);
  const toolsBin = path.join(depRoot, "bin");
  const delimiter = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    ...extraEnv,
    PATH: [nodeBin, toolsBin, process.env.PATH || ""].filter(Boolean).join(delimiter),
  };
}

export function createUtf8Accumulator() {
  const decoder = new StringDecoder("utf8");
  let value = "";
  let ended = false;
  return {
    write(chunk) {
      if (ended) return;
      value += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    end() {
      if (!ended) {
        value += decoder.end();
        ended = true;
      }
      return value;
    },
    value() {
      return value;
    },
  };
}

function collectProcess(command, args, { input = "", timeoutMs = 120000, cwd = root, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: withRuntimePath(extraEnv),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutAccumulator = createUtf8Accumulator();
    const stderrAccumulator = createUtf8Accumulator();
    let stdout = "";
    let stderr = "";
    let finished = false;
    let streamsEnded = false;
    const endStreams = () => {
      if (streamsEnded) return;
      stdout = stdoutAccumulator.end();
      stderr = stderrAccumulator.end();
      streamsEnded = true;
    };
    const timer = setTimeout(() => {
      if (finished) return;
      child.kill();
      finished = true;
      endStreams();
      resolve({
        code: 124,
        stdout,
        stderr: `${stderr}\nProcess timed out after ${timeoutMs} ms.`.trim(),
        errorCode: "TIMEOUT",
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutAccumulator.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrAccumulator.write(chunk);
    });
    child.on("error", (error) => {
      if (finished) return;
      clearTimeout(timer);
      finished = true;
      endStreams();
      resolve({ code: 127, stdout, stderr: error.message, errorCode: error.code || "SPAWN_ERROR" });
    });
    child.on("close", (code) => {
      if (finished) return;
      clearTimeout(timer);
      finished = true;
      endStreams();
      resolve({ code, stdout, stderr, errorCode: "" });
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function inheritProcess(command, args, { cwd = root, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: withRuntimePath(extraEnv),
      windowsHide: false,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      resolve({ code: 127, errorCode: error.code || "SPAWN_ERROR", stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code, errorCode: "", stderr: "" });
    });
  });
}

function larkCliCandidates() {
  const candidates = [];
  const explicit = env("LARK_CLI_BIN");
  if (explicit) candidates.push({ command: explicit, prefixArgs: [], label: explicit });
  candidates.push({ command: "lark-cli", prefixArgs: [], label: "lark-cli" });
  const pnpmNodeArgs = bundledPnpmNodeArgs();
  if (pnpmNodeArgs) {
    candidates.push({
      command: process.execPath,
      prefixArgs: [...pnpmNodeArgs, "--silent", "dlx", env("LARK_CLI_PACKAGE") || DEFAULT_LARK_CLI_PACKAGE],
      label: `pnpm dlx ${env("LARK_CLI_PACKAGE") || DEFAULT_LARK_CLI_PACKAGE}`,
    });
  }
  candidates.push({
    command: bundledPnpmPath(),
    prefixArgs: ["--silent", "dlx", env("LARK_CLI_PACKAGE") || DEFAULT_LARK_CLI_PACKAGE],
    label: `pnpm dlx ${env("LARK_CLI_PACKAGE") || DEFAULT_LARK_CLI_PACKAGE}`,
  });
  return candidates;
}

export async function runLarkCli(args, options = {}) {
  const tried = [];
  for (const candidate of larkCliCandidates()) {
    const result = await collectProcess(candidate.command, [...candidate.prefixArgs, ...args], options);
    tried.push(candidate.label);
    if (result.errorCode === "ENOENT" || result.errorCode === "EINVAL") continue;
    return { ...result, commandLabel: candidate.label, tried };
  }
  throw new Error(`lark-cli is not available. Tried: ${tried.join(", ")}`);
}

export async function runLarkCliInteractive(args, options = {}) {
  const tried = [];
  for (const candidate of larkCliCandidates()) {
    const result = await inheritProcess(candidate.command, [...candidate.prefixArgs, ...args], options);
    tried.push(candidate.label);
    if (result.errorCode === "ENOENT" || result.errorCode === "EINVAL") continue;
    return { ...result, commandLabel: candidate.label, tried };
  }
  throw new Error(`lark-cli is not available. Tried: ${tried.join(", ")}`);
}

export function parseLastJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) throw new Error("No JSON output from lark-cli.");
  try {
    return JSON.parse(source);
  } catch {
    // pnpm and CLIs may prepend logs. Walk from the end and parse the last object.
  }

  for (let start = source.lastIndexOf("{"); start >= 0; start = source.lastIndexOf("{", start - 1)) {
    const candidate = source.slice(start).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning.
    }
  }
  throw new Error(`Unable to parse JSON from lark-cli output: ${source.slice(0, 500)}`);
}

function normalizeLarkCliEnvelope(parsed) {
  if (parsed?.ok === false) {
    const error = parsed.error || {};
    const hint = error.hint ? ` Hint: ${error.hint}` : "";
    throw new Error(`lark-cli failed: ${error.message || "unknown error"}${hint}`);
  }
  if (parsed?.ok === true) {
    const payload = parsed.data ?? {};
    if (payload && typeof payload === "object" && ("code" in payload || "msg" in payload || "data" in payload)) {
      return payload;
    }
    return { code: 0, data: payload };
  }
  return parsed;
}

async function writeTempJson(data) {
  const tmpDir = path.join(root, "outputs", "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(
    tmpDir,
    `lark_cli_api_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.json`
  );
  await fs.writeFile(filePath, JSON.stringify(data), "utf8");
  return filePath;
}

export async function requestLarkCliApi({
  method,
  apiPath,
  params = {},
  data,
  as = env("FEISHU_LARK_CLI_AS") || "user",
  timeoutMs = 180000,
} = {}) {
  if (!method || !apiPath) throw new Error("requestLarkCliApi requires method and apiPath.");
  const args = ["api", method.toUpperCase(), apiPath, "--as", as, "--format", "json"];
  const cleanParams = Object.fromEntries(
    Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  if (Object.keys(cleanParams).length) args.push("--params", JSON.stringify(cleanParams));

  const tempFiles = [];
  if (data !== undefined) {
    const dataPath = await writeTempJson(data);
    tempFiles.push(dataPath);
    const relativeDataPath = path.relative(root, dataPath).replace(/\\/g, "/");
    args.push("--data", `@${relativeDataPath}`);
  }

  try {
    const result = await runLarkCli(args, { timeoutMs });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const parsed = parseLastJsonObject(output);
    const normalized = normalizeLarkCliEnvelope(parsed);
    if (result.code !== 0 && normalized?.code === undefined) {
      throw new Error(`lark-cli exited with ${result.code}: ${output.slice(0, 800)}`);
    }
    return normalized;
  } finally {
    await Promise.all(
      tempFiles.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch {
          // Best-effort cleanup only.
        }
      })
    );
  }
}

export async function larkCliStatus() {
  const result = await runLarkCli(["whoami"], { timeoutMs: 60000 });
  const parsed = parseLastJsonObject([result.stdout, result.stderr].filter(Boolean).join("\n"));
  return { exitCode: result.code, command: result.commandLabel, parsed };
}

export function printLarkCliBootstrap() {
  const pnpm = bundledPnpmPath();
  const nodeBin = path.dirname(process.execPath);
  const toolsBin = path.join(dependencyRootFromNode(), "bin");
  return [
    "$env:PATH='" + nodeBin + ";" + toolsBin + ";' + $env:PATH",
    `& '${pnpm}' --silent dlx ${env("LARK_CLI_PACKAGE") || DEFAULT_LARK_CLI_PACKAGE} config init --new --lang zh`,
    `& '${pnpm}' --silent dlx ${env("LARK_CLI_PACKAGE") || DEFAULT_LARK_CLI_PACKAGE} auth login --recommend --domain sheets,drive,wiki --no-wait --json`,
    `& '${pnpm}' --silent dlx ${env("LARK_CLI_PACKAGE") || DEFAULT_LARK_CLI_PACKAGE} auth status --json --verify`,
  ].join("\n");
}
