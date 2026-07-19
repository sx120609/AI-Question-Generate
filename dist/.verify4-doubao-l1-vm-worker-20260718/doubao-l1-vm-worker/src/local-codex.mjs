import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function nonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} must not be empty.`);
  return text;
}

async function existingExecutable(candidate) {
  if (!candidate) return "";
  try {
    await access(candidate);
    const info = await stat(candidate);
    return info.isFile() ? candidate : "";
  } catch {
    return "";
  }
}

export async function findLocalCodexExecutable({
  env = process.env,
  executablePath,
} = {}) {
  const explicit = await existingExecutable(executablePath || env.CODEX_CLI_PATH);
  if (explicit) return explicit;

  const localAppData = String(env.LOCALAPPDATA ?? "").trim();
  if (localAppData) {
    const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
    try {
      const entries = await readdir(binRoot, { withFileTypes: true });
      const candidates = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(binRoot, entry.name, "codex.exe");
        const found = await existingExecutable(candidate);
        if (found) candidates.push({ path: found, mtimeMs: (await stat(found)).mtimeMs });
      }
      candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
      if (candidates.length) return candidates[0].path;
    } catch {
      // The VM may expose Codex only through PATH.
    }
  }
  return process.platform === "win32" ? "codex.exe" : "codex";
}

export function buildLocalCodexArgs({
  model,
  outputPath,
  reasoningEffort = "high",
  schemaPath,
  workingDirectory,
}) {
  return [
    "exec",
    "--model", nonEmpty(model, "Local Codex model"),
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--color", "never",
    "-c", `model_reasoning_effort=${JSON.stringify(String(reasoningEffort || "high"))}`,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "--cd", workingDirectory,
    "-",
  ];
}

function appendLimited(chunks, chunk, state) {
  if (state.bytes >= MAX_CAPTURE_BYTES) return;
  const buffer = Buffer.from(chunk);
  const remaining = MAX_CAPTURE_BYTES - state.bytes;
  chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(buffer.length, remaining);
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  try {
    child.kill();
  } catch {
    // Best effort; the exact process tree is also terminated below on Windows.
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } catch {
      // The parent timeout/abort still fails closed if taskkill is unavailable.
    }
  }
}

export async function runLocalCodexProcess({
  args,
  env = process.env,
  executablePath,
  prompt,
  signal,
  timeoutMs,
}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      env: { ...env, CI: "1", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    let timedOut = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      terminateProcessTree(child);
      const error = new Error("Local Codex invocation was aborted.");
      error.code = "LOCAL_CODEX_ABORTED";
      finish(() => reject(error));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => appendLimited(stdout, chunk, stdoutState));
    child.stderr.on("data", (chunk) => appendLimited(stderr, chunk, stderrState));
    child.once("error", (cause) => finish(() => reject(cause)));
    child.once("exit", (code, exitSignal) => finish(() => {
      const result = {
        code: Number(code ?? -1),
        signal: exitSignal ?? "",
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (timedOut) {
        const error = new Error(`Local Codex timed out after ${timeoutMs}ms.`);
        error.code = "LOCAL_CODEX_TIMEOUT";
        error.retryable = true;
        error.result = result;
        reject(error);
      } else {
        resolve(result);
      }
    }));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    child.stdin.end(prompt, "utf8");
  });
}

function codexPrompt({ systemPrompt, userPrompt }) {
  return [
    "You are a JSON-only decision component inside an unattended workflow.",
    "Do not call tools, do not inspect files, do not run commands, and do not explain your answer.",
    "Apply the SYSTEM REQUIREMENTS to the USER INPUT and return only the JSON object required by the output schema.",
    "SYSTEM REQUIREMENTS:",
    nonEmpty(systemPrompt, "Local Codex system prompt"),
    "USER INPUT:",
    nonEmpty(userPrompt, "Local Codex user prompt"),
  ].join("\n\n");
}

function sanitizeFailureText(value) {
  return String(value ?? "")
    .replace(/[A-Za-z]:\\[^\r\n]{1,400}/gu, "[local-path]")
    .trim()
    .slice(-1_000);
}

export async function completeWithLocalCodex({
  env = process.env,
  executablePath,
  model = "gpt-5.6-sol",
  outputSchema,
  processRunner = runLocalCodexProcess,
  reasoningEffort = "high",
  signal,
  systemPrompt,
  timeoutMs = 360_000,
  userPrompt,
} = {}) {
  if (!outputSchema || typeof outputSchema !== "object") {
    throw new Error("Local Codex outputSchema is required.");
  }
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "doubao-local-codex-"));
  const schemaPath = path.join(runtimeDir, "output.schema.json");
  const outputPath = path.join(runtimeDir, "last-message.json");
  try {
    await writeFile(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, "utf8");
    const resolvedExecutable = await findLocalCodexExecutable({ env, executablePath });
    const args = buildLocalCodexArgs({
      model,
      outputPath,
      reasoningEffort,
      schemaPath,
      workingDirectory: runtimeDir,
    });
    const processResult = await processRunner({
      args,
      env,
      executablePath: resolvedExecutable,
      prompt: codexPrompt({ systemPrompt, userPrompt }),
      signal,
      timeoutMs: Number(timeoutMs),
    });
    if (processResult.code !== 0) {
      const detail = sanitizeFailureText(processResult.stderr || processResult.stdout);
      const error = new Error(`Local Codex exited with code ${processResult.code}${detail ? `: ${detail}` : "."}`);
      error.code = "LOCAL_CODEX_EXIT_FAILED";
      error.retryable = /network|timed?\s*out|429|rate limit|temporar|unavailable|connection/iu.test(detail);
      throw error;
    }
    const content = processResult.lastMessage == null
      ? await readFile(outputPath, "utf8")
      : String(processResult.lastMessage);
    JSON.parse(content);
    return {
      content,
      id: `local-codex-${Date.now()}`,
      model,
      provider: "local-codex-cli",
      usage: {},
    };
  } finally {
    await rm(runtimeDir, { force: true, recursive: true });
  }
}
