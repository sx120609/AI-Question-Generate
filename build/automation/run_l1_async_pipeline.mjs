import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { integerOption, parseArgs } from "../../doubao-automation/src/args.mjs";
import { cdpEndpoint, waitForCdp } from "../../doubao-automation/src/cdp.mjs";
import { runInteractionQueuePool } from "../../doubao-automation/src/queue-worker.mjs";
import {
  enqueueInteractionJob,
  ensureInteractionQueue,
  interactionQueueStatus,
  recoverStaleInteractionClaims,
} from "../../doubao-automation/src/task-queue.mjs";
import {
  deriveAsyncBatchSpec,
  runAsyncProductionQueue,
  runNodeProducer,
  safeBatchId,
} from "./l1_async_pipeline.mjs";
import { createAutoRun, writeJsonAtomic } from "./run_context.mjs";

const repoRoot = process.cwd();
const { options } = parseArgs(["run", ...process.argv.slice(2)]);

function requiredOption(name) {
  const value = String(options[name] ?? "").trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function targetIdsFromOptions() {
  return String(options["target-ids"] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function setSecretEnvironment(secrets) {
  if (secrets?.muguaApiKey) process.env.DE_AI_REWRITE_API_KEY ||= String(secrets.muguaApiKey);
  if (secrets?.muguaBaseUrl) process.env.DE_AI_REWRITE_BASE_URL ||= String(secrets.muguaBaseUrl);
  if (secrets?.muguaModel) process.env.DE_AI_REWRITE_MODEL ||= String(secrets.muguaModel);
}

function redactRuntimeSecrets(value) {
  let text = String(value ?? "");
  for (const secret of [process.env.CODEX_RESPONSES_API_KEY, process.env.DE_AI_REWRITE_API_KEY]) {
    if (secret) text = text.split(String(secret)).join("[REDACTED]");
  }
  return text;
}

async function acquireCoordinatorLock(batchRoot) {
  const lockPath = path.join(batchRoot, "coordinator.lock");
  const token = randomUUID();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }, null, 2)}\n`);
      await handle.close();
      const release = () => {
        try {
          const current = JSON.parse(fsSync.readFileSync(lockPath, "utf8"));
          if (current.pid === process.pid && current.token === token) fsSync.unlinkSync(lockPath);
        } catch {}
      };
      process.once("exit", release);
      return { lockPath, release };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = await readJson(lockPath); } catch {}
      let ownerAlive = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
          ownerAlive = true;
        } catch (probeError) {
          if (probeError?.code === "EPERM") ownerAlive = true;
        }
      }
      if (ownerAlive) {
        throw new Error(`Async batch already has a live coordinator (pid ${owner.pid}).`);
      }
      await fs.unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error(`Could not acquire async batch coordinator lock: ${lockPath}`);
}

const batchId = safeBatchId(requiredOption("batch-id"));
const sourceSpecPath = path.resolve(repoRoot, String(options["spec-file"] ?? "inputs/production/l1_six_task_specs_20260719.json"));
const selectedSlugs = String(options.slugs ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const productionConcurrency = integerOption(options, "production-concurrency", 2, { min: 1, max: 5 });
const producerAttempts = integerOption(options, "producer-attempts", 2, { min: 1, max: 3 });
const resumeBatch = [true, "1", "true", "yes"].includes(options["resume-batch"] ?? false);
const recoverRunning = [true, "1", "true", "yes"].includes(options["recover-running"] ?? false);
const targetIds = targetIdsFromOptions();
if (targetIds.length > 3) throw new Error("--target-ids accepts at most three interaction windows.");

const batchRoot = path.resolve(repoRoot, String(options["batch-root"] ?? path.join("outputs", "async_batches", batchId)));
const batchSpecPath = path.join(batchRoot, "batch_spec.json");
const batchStatePath = path.join(batchRoot, "pipeline_state.json");
const eventsPath = path.join(batchRoot, "pipeline_events.jsonl");
const queueRoot = path.resolve(repoRoot, String(options.queue ?? path.join(batchRoot, "interaction-queue")));
const topicRegistryPath = path.join(batchRoot, "topic_registry.json");
const structureRegistryPath = path.join(batchRoot, "structure_registry.json");
const producerScriptPath = path.resolve(repoRoot, "build", "automation", "produce_l1_single_task.mjs");
const secretFileOption = String(options["secret-file"] ?? "").trim();
const secretFilePath = secretFileOption ? path.resolve(repoRoot, secretFileOption) : "";

if (secretFilePath) setSecretEnvironment(await readJson(secretFilePath));
if (!process.env.DE_AI_REWRITE_API_KEY) {
  throw new Error("Missing DE_AI_REWRITE_API_KEY or --secret-file for the interaction rewrite route.");
}
process.env.CODEX_BACKEND = "responses-api";
process.env.CODEX_RESPONSES_BASE_URL ||= String(options["codex-base-url"] ?? "").trim();
process.env.CODEX_RESPONSES_MODEL ||= String(options["codex-model"] ?? "gpt-5.6-sol").trim();
process.env.CODEX_RESPONSES_REASONING_EFFORT ||= String(options["reasoning-effort"] ?? "high").trim();
if (!process.env.CODEX_RESPONSES_API_KEY) throw new Error("Missing CODEX_RESPONSES_API_KEY.");
if (!process.env.CODEX_RESPONSES_BASE_URL) throw new Error("Missing CODEX_RESPONSES_BASE_URL or --codex-base-url.");

await fs.mkdir(batchRoot, { recursive: true });
const coordinatorLock = await acquireCoordinatorLock(batchRoot);
await ensureInteractionQueue(queueRoot);
let batchSpec;
let pipelineState;
if (resumeBatch) {
  if (!await exists(batchSpecPath) || !await exists(batchStatePath)) {
    throw new Error(`Cannot resume a missing async batch: ${batchRoot}`);
  }
  batchSpec = await readJson(batchSpecPath);
  pipelineState = await readJson(batchStatePath);
  pipelineState.status = "running-recovery";
  pipelineState.recoveryStartedAt = new Date().toISOString();
  pipelineState.productionConcurrency = productionConcurrency;
  pipelineState.interactionConcurrency = targetIds.length;
  pipelineState.targetIds = targetIds;
  pipelineState.events ??= [];
} else {
  if (await exists(batchSpecPath) || await exists(batchStatePath)) {
    throw new Error(`Async batch already exists and will not be overwritten: ${batchRoot}`);
  }
  const sourceBundle = await readJson(sourceSpecPath);
  batchSpec = deriveAsyncBatchSpec(sourceBundle, { batchId, slugs: selectedSlugs });
  const originalBySlug = new Map(sourceBundle.tasks.map((task) => [String(task.slug), task]));
  for (const task of batchSpec.tasks) {
    const sourceTask = originalBySlug.get(task.asyncBatch.sourceSlug);
    const sourceAttachmentPath = path.resolve(
      repoRoot,
      "outputs",
      "auto_runs",
      sourceTask.runId,
      "attachments",
      sourceTask.attachment.name,
    );
    if (!await exists(sourceAttachmentPath)) {
      throw new Error(`Verified source attachment is missing: ${sourceAttachmentPath}`);
    }
    const run = await createAutoRun({
      annotator: "沈礼",
      count: 1,
      objective: `异步 Responses API 测试：${sourceTask.topic.title}`,
      operator: "codex",
      profile: "l1",
      runId: task.runId,
      structureRegistryPath,
    });
    await fs.copyFile(sourceAttachmentPath, path.join(run.dirs.attachments, task.attachment.name));
  }
  await writeJsonAtomic(batchSpecPath, batchSpec);
  pipelineState = {
    schemaVersion: 1,
    kind: "l1-async-production-interaction-pipeline",
    batchId,
    createdAt: new Date().toISOString(),
    status: "running",
    sourceSpecPath,
    batchSpecPath,
    queueRoot,
    productionConcurrency,
    producerAttempts,
    interactionConcurrency: targetIds.length,
    targetIds,
    codex: {
      backend: "responses-api",
      baseUrl: process.env.CODEX_RESPONSES_BASE_URL,
      model: process.env.CODEX_RESPONSES_MODEL,
      reasoningEffort: process.env.CODEX_RESPONSES_REASONING_EFFORT,
      apiKeyEnv: "CODEX_RESPONSES_API_KEY",
    },
    events: [],
  };
}
await writeJsonAtomic(batchStatePath, pipelineState);
if (resumeBatch && recoverRunning) {
  const recoveredJobIds = await recoverStaleInteractionClaims({ leaseTimeoutMs: 0, queueRoot });
  pipelineState.recoveredJobIds = recoveredJobIds;
  await writeJsonAtomic(batchStatePath, pipelineState);
}

let eventWrites = Promise.resolve();
function recordEvent(event) {
  const safeEvent = { at: new Date().toISOString(), ...event };
  pipelineState.events.push(safeEvent);
  pipelineState.updatedAt = safeEvent.at;
  eventWrites = eventWrites.then(async () => {
    await fs.appendFile(eventsPath, `${JSON.stringify(safeEvent)}\n`, "utf8");
    await writeJsonAtomic(batchStatePath, pipelineState);
  });
  return eventWrites;
}

let productionSettled = false;
let poolPromise = null;
if (targetIds.length) {
  const endpoint = cdpEndpoint({ host: String(options.host ?? "127.0.0.1"), port: integerOption(options, "port", 9229) });
  await waitForCdp(endpoint);
  poolPromise = runInteractionQueuePool({
    endpoint,
    queueRoot,
    shouldStopWhenIdle: async () => {
      if (!productionSettled) return false;
      const status = await interactionQueueStatus(queueRoot);
      return status.counts.pending === 0 && status.counts.running === 0;
    },
    targetIds,
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: { code: String(error?.code ?? ""), message: String(error?.message ?? error) } }),
  );
  await recordEvent({ type: "interaction-pool-started", endpoint, targetIds });
}

const queueBeforeProduction = await interactionQueueStatus(queueRoot);
const queuedJobIds = new Set(Object.values(queueBeforeProduction.jobs).flat());
const tasksToProduce = batchSpec.tasks.filter((task) => !queuedJobIds.has(task.jobId));
for (const task of batchSpec.tasks.filter((item) => queuedJobIds.has(item.jobId))) {
  await recordEvent({ type: "production-skipped-already-queued", task });
}

const production = await runAsyncProductionQueue({
  tasks: tasksToProduce,
  productionConcurrency,
  onEvent: recordEvent,
  produce: async (task) => {
    const logDir = path.resolve(repoRoot, "outputs", "auto_runs", task.runId, "logs");
    await fs.mkdir(logDir, { recursive: true });
    const stdoutPath = path.join(logDir, "async-producer.stdout.log");
    const stderrPath = path.join(logDir, "async-producer.stderr.log");
    let completed = null;
    let lastError = null;
    for (let attempt = 1; attempt <= producerAttempts; attempt += 1) {
      try {
        completed = await runNodeProducer({
          cwd: repoRoot,
          scriptPath: producerScriptPath,
          args: [
            "--spec-file", batchSpecPath,
            "--slug", task.slug,
            "--codex-backend", "responses-api",
            "--codex-base-url", process.env.CODEX_RESPONSES_BASE_URL,
            "--codex-model", process.env.CODEX_RESPONSES_MODEL,
            "--topic-registry", topicRegistryPath,
            ...((resumeBatch || attempt > 1) ? ["--resume", "1"] : []),
            ...(secretFilePath ? ["--secret-file", secretFilePath] : []),
          ],
        });
        await Promise.all([
          fs.writeFile(stdoutPath, redactRuntimeSecrets(completed.stdout), "utf8"),
          fs.writeFile(stderrPath, redactRuntimeSecrets(completed.stderr), "utf8"),
          fs.writeFile(path.join(logDir, `async-producer.attempt-${attempt}.stdout.log`), redactRuntimeSecrets(completed.stdout), "utf8"),
          fs.writeFile(path.join(logDir, `async-producer.attempt-${attempt}.stderr.log`), redactRuntimeSecrets(completed.stderr), "utf8"),
        ]);
        break;
      } catch (error) {
        lastError = error;
        await Promise.all([
          fs.writeFile(stdoutPath, redactRuntimeSecrets(error.stdout), "utf8"),
          fs.writeFile(stderrPath, redactRuntimeSecrets(error.stderr ?? error.message ?? error), "utf8"),
          fs.writeFile(path.join(logDir, `async-producer.attempt-${attempt}.stdout.log`), redactRuntimeSecrets(error.stdout), "utf8"),
          fs.writeFile(path.join(logDir, `async-producer.attempt-${attempt}.stderr.log`), redactRuntimeSecrets(error.stderr ?? error.message ?? error), "utf8"),
        ]);
        if (attempt < producerAttempts) {
          await recordEvent({ type: "production-retrying", task, attempt, error: { code: String(error.code ?? ""), message: error.message } });
        }
      }
    }
    if (!completed) throw lastError ?? new Error("Producer failed without an error.");
    const jobPath = path.resolve(repoRoot, "outputs", "auto_runs", task.runId, "doubao", "job.json");
    if (!await exists(jobPath)) throw new Error(`Producer completed without a Doubao job: ${jobPath}`);
    const usageSummaryPath = path.resolve(repoRoot, "outputs", "auto_runs", task.runId, "qa", "codex_usage_summary.json");
    return {
      jobId: task.jobId,
      jobPath,
      runId: task.runId,
      usageSummaryPath,
    };
  },
  enqueue: async (produced) => enqueueInteractionJob({ configPath: produced.jobPath, queueRoot }),
});
productionSettled = true;
await eventWrites;

const interactionPool = poolPromise ? await poolPromise : null;
const queueStatus = await interactionQueueStatus(queueRoot);
const quotaSuspended = interactionPool?.ok === true
  && interactionPool.value?.status === "quota-suspended";
if (quotaSuspended) {
  await recordEvent({
    type: "interaction-pool-quota-suspended",
    quotaPause: interactionPool.value.quotaPause ?? null,
  });
}
pipelineState.status = quotaSuspended
  ? "paused-quota"
  : production.ok && (!interactionPool || interactionPool.ok)
    ? (targetIds.length ? "finished" : "production-finished-interaction-pending")
    : "finished-with-errors";
pipelineState.productionRuns ??= [];
pipelineState.productionRuns.push({ resumeBatch, completedAt: new Date().toISOString(), ...production });
pipelineState.production = production;
pipelineState.interactionPool = interactionPool;
pipelineState.queueStatus = queueStatus;
pipelineState.finishedAt = new Date().toISOString();
await writeJsonAtomic(batchStatePath, pipelineState);

const finalExitCode = !production.ok || (interactionPool && !interactionPool.ok) ? 1 : 0;
await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify({
  ok: production.ok && (!interactionPool || interactionPool.ok),
  batchId,
  batchRoot,
  batchSpecPath,
  batchStatePath,
  queueRoot,
  quotaSuspended,
  production: {
    taskCount: production.taskCount,
    producedCount: production.producedCount,
    enqueuedCount: production.enqueuedCount,
    failedCount: production.failedCount,
  },
  interactionPool,
  queueStatus,
}, null, 2)}\n`, (error) => (error ? reject(error) : resolve())));
coordinatorLock.release();
process.exit(finalExitCode);
