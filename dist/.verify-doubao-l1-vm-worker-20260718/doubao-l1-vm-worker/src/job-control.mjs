import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const JOB_PAUSE_REQUESTED = "JOB_PAUSE_REQUESTED";

const TERMINAL_STATUSES = new Set([
  "complete",
  "failed",
  "paused_by_operator",
  "paused_content_scope_blocked",
  "paused_doubao_unavailable",
  "paused_model_error",
  "paused_model_unavailable",
  "paused_visible_trace_detected",
  "paused_tool_confirmation_required",
]);

export class JobPauseRequestedError extends Error {
  constructor(message = "The job was paused by an operator request.") {
    super(message);
    this.name = "JobPauseRequestedError";
    this.code = JOB_PAUSE_REQUESTED;
  }
}

export function throwIfJobPauseRequested(signal) {
  if (!signal?.aborted) return;
  if (signal.reason?.code === JOB_PAUSE_REQUESTED) throw signal.reason;
  throw new JobPauseRequestedError();
}

export function abortableDelay(ms, signal) {
  throwIfJobPauseRequested(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason?.code === JOB_PAUSE_REQUESTED
        ? signal.reason
        : new JobPauseRequestedError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function stopRequestPath(outputPath) {
  return `${path.resolve(outputPath)}.stop.json`;
}

async function atomicWriteJson(filePath, value) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, resolved);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function startStopRequestMonitor({
  controller,
  outputPath,
  pollMs = 250,
  runId,
} = {}) {
  if (!(controller instanceof AbortController)) throw new Error("An AbortController is required.");
  if (!String(runId ?? "").trim()) throw new Error("runId is required.");
  const requestPath = stopRequestPath(outputPath);
  let closed = false;
  let polling = false;
  const timer = setInterval(async () => {
    if (closed || polling || controller.signal.aborted) return;
    polling = true;
    try {
      const request = await readJson(requestPath);
      if (request.runId === runId) controller.abort(new JobPauseRequestedError());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") {
        controller.abort(new JobPauseRequestedError(`The stop-control monitor failed: ${error.message}`));
      }
    } finally {
      polling = false;
    }
  }, pollMs);
  timer.unref?.();
  return {
    requestPath,
    stop() {
      closed = true;
      clearInterval(timer);
    },
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function matchesRunJobCommandLine(commandLine, outputPath) {
  const normalized = String(commandLine ?? "").replaceAll("\\", "/").toLowerCase();
  const expectedOutput = path.resolve(outputPath).replaceAll("\\", "/").toLowerCase();
  return /doubao-automation\/src\/cli\.mjs\s+run-job\b/u.test(normalized)
    && normalized.includes(expectedOutput);
}

async function readProcessCommandLine(pid) {
  if (process.platform !== "win32") {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
  }
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CommandLine`;
  const { stdout } = await execFileAsync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 10_000,
    windowsHide: true,
  });
  return stdout.trim();
}

export async function requestJobStop({
  forceAfterMs = 10_000,
  outputPath,
  pollMs = 250,
} = {}) {
  const resolved = path.resolve(String(outputPath ?? ""));
  if (!outputPath) throw new Error("outputPath is required.");
  const initial = await readJson(resolved);
  if (TERMINAL_STATUSES.has(initial.status)) {
    return { acknowledged: true, alreadyTerminal: true, forced: false, status: initial.status };
  }
  const pid = Number(initial.workerPid);
  const runId = String(initial.runId ?? "").trim();
  if (!Number.isInteger(pid) || pid <= 0 || !runId) {
    throw new Error("The active result has no valid workerPid and runId.");
  }
  await atomicWriteJson(stopRequestPath(resolved), {
    jobId: initial.jobId,
    requestedAt: new Date().toISOString(),
    runId,
    workerPid: pid,
  });

  const deadline = Date.now() + forceAfterMs;
  while (Date.now() < deadline) {
    const current = await readJson(resolved);
    if (current.runId !== runId) throw new Error("The result was replaced by a different run while stopping.");
    if (current.status === "paused_by_operator") {
      return { acknowledged: true, alreadyTerminal: false, forced: false, status: current.status };
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      return { acknowledged: true, alreadyTerminal: false, forced: false, status: current.status };
    }
    if (!isProcessAlive(pid)) break;
    await abortableDelay(pollMs);
  }

  let forced = false;
  if (isProcessAlive(pid)) {
    const commandLine = await readProcessCommandLine(pid);
    if (!matchesRunJobCommandLine(commandLine, resolved)) {
      throw new Error(`Refusing to terminate PID ${pid} because its command line is not the recorded run-job output.`);
    }
    process.kill(pid, "SIGTERM");
    forced = true;
  }
  const exitDeadline = Date.now() + 5_000;
  while (isProcessAlive(pid) && Date.now() < exitDeadline) await abortableDelay(pollMs);
  if (isProcessAlive(pid)) throw new Error(`Worker ${pid} did not stop after the forced termination request.`);

  const current = await readJson(resolved);
  if (current.runId !== runId) throw new Error("The result was replaced by a different run while stopping.");
  if (current.status !== "paused_by_operator") {
    await atomicWriteJson(resolved, {
      ...current,
      failedAt: current.failedAt ?? new Date().toISOString(),
      pause: {
        forcedTermination: forced,
        reason: "operator-request",
        resumePolicy: "manual-resume-only-no-fallback",
      },
      status: "paused_by_operator",
      stoppedWorkerPid: pid,
      updatedAt: new Date().toISOString(),
      workerPid: null,
    });
  }
  return { acknowledged: true, alreadyTerminal: false, forced, status: "paused_by_operator" };
}
