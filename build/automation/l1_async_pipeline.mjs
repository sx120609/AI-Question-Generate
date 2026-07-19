import { spawn } from "node:child_process";
import path from "node:path";

function positiveInteger(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

export function safeBatchId(value) {
  const batchId = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  if (batchId.length < 3) throw new Error("batchId must contain at least three safe characters.");
  return batchId;
}

export function deriveAsyncBatchSpec(sourceBundle, {
  batchId: rawBatchId,
  slugs = [],
} = {}) {
  const batchId = safeBatchId(rawBatchId);
  const sourceTasks = Array.isArray(sourceBundle?.tasks) ? sourceBundle.tasks : [];
  const selectedSlugs = slugs.length
    ? [...new Set(slugs.map((item) => String(item).trim()).filter(Boolean))]
    : sourceTasks.map((item) => String(item.slug));
  if (!selectedSlugs.length) throw new Error("The async batch must select at least one task.");
  const bySlug = new Map(sourceTasks.map((item) => [String(item.slug), item]));
  const missing = selectedSlugs.filter((slug) => !bySlug.has(slug));
  if (missing.length) throw new Error(`Unknown source task slugs: ${missing.join(", ")}.`);
  const tasks = selectedSlugs.map((sourceSlug, index) => {
    const source = structuredClone(bySlug.get(sourceSlug));
    const sequence = String(index + 1).padStart(2, "0");
    return {
      ...source,
      slug: `${sourceSlug}_${batchId}`,
      runId: `l1_async_${batchId}_${sequence}_${sourceSlug}`.slice(0, 120),
      jobId: `l1-async-${batchId}-${sequence}`,
      recordUid: `沈礼_${batchId}_${sequence}`,
      asyncBatch: {
        batchId,
        sequence: index + 1,
        sourceJobId: source.jobId,
        sourceRunId: source.runId,
        sourceSlug,
      },
    };
  });
  return {
    schemaVersion: 1,
    kind: "l1-async-batch-production-specs",
    batchId,
    createdAt: new Date().toISOString(),
    sourceKind: String(sourceBundle?.kind ?? ""),
    tasks,
  };
}

export async function runAsyncProductionQueue({
  enqueue,
  onEvent = async () => {},
  produce,
  productionConcurrency = 1,
  tasks = [],
} = {}) {
  if (typeof produce !== "function") throw new Error("runAsyncProductionQueue requires produce.");
  if (typeof enqueue !== "function") throw new Error("runAsyncProductionQueue requires enqueue.");
  const concurrency = positiveInteger(productionConcurrency, "productionConcurrency", { max: 16 });
  const normalizedTasks = tasks.map((task, index) => ({ ...task, pipelineIndex: index }));
  const results = new Array(normalizedTasks.length);
  let cursor = 0;

  async function worker(workerIndex) {
    while (cursor < normalizedTasks.length) {
      const taskIndex = cursor;
      cursor += 1;
      const task = normalizedTasks[taskIndex];
      const startedAt = new Date().toISOString();
      await onEvent({ type: "production-started", workerIndex, task, startedAt });
      try {
        const produced = await produce(task, { taskIndex, workerIndex });
        const producedAt = new Date().toISOString();
        await onEvent({ type: "production-completed", workerIndex, task, produced, producedAt });
        const queued = await enqueue(produced, task, { taskIndex, workerIndex });
        const enqueuedAt = new Date().toISOString();
        results[taskIndex] = {
          ok: true,
          task,
          produced,
          queued,
          startedAt,
          producedAt,
          enqueuedAt,
        };
        await onEvent({ type: "interaction-enqueued", workerIndex, task, produced, queued, enqueuedAt });
      } catch (error) {
        const failedAt = new Date().toISOString();
        results[taskIndex] = {
          ok: false,
          task,
          startedAt,
          failedAt,
          error: {
            code: String(error?.code ?? ""),
            message: String(error?.message ?? error),
          },
        };
        await onEvent({ type: "production-failed", workerIndex, task, error: results[taskIndex].error, failedAt });
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, normalizedTasks.length)) },
    (_, index) => worker(index + 1),
  );
  await Promise.all(workers);
  return {
    ok: results.every((item) => item?.ok === true),
    productionConcurrency: concurrency,
    taskCount: normalizedTasks.length,
    producedCount: results.filter((item) => item?.produced).length,
    enqueuedCount: results.filter((item) => item?.queued).length,
    failedCount: results.filter((item) => item?.ok === false).length,
    results,
  };
}

export function runNodeProducer({
  args = [],
  cwd = process.cwd(),
  env = process.env,
  nodePath = process.execPath,
  onStderr = () => {},
  onStdout = () => {},
  scriptPath,
} = {}) {
  if (!path.isAbsolute(String(scriptPath ?? ""))) throw new Error("scriptPath must be absolute.");
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [scriptPath, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onStdout(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onStderr(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ code, signal: signal ?? "", stdout, stderr });
        return;
      }
      const error = new Error(`Producer exited with code ${code}${signal ? ` and signal ${signal}` : ""}.`);
      error.code = "L1_PRODUCER_FAILED";
      error.exitCode = code;
      error.signal = signal ?? "";
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}
