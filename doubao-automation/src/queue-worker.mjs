import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { connectDoubao } from "./doubao-client.mjs";
import { runDoubaoJob } from "./job-runner.mjs";
import {
  createInteractionQuotaGate,
  INTERACTION_QUOTA_SUSPENDED,
} from "./quota-pause.mjs";
import {
  claimNextInteractionJob,
  finishInteractionClaim,
  heartbeatInteractionClaim,
  loadClaimedInteractionConfig,
  recoverStaleInteractionClaims,
  retryFailedInteractionJob,
  resultPathForInteractionJob,
  withInteractionQueueResourceLock,
} from "./task-queue.mjs";

export const MAX_INTERACTION_WORKERS = 3;

function abortableWait(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Worker aborted."));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Worker aborted."));
    }, { once: true });
  });
}

async function savedResultStatus(resultPath) {
  try {
    return String(JSON.parse(await readFile(resultPath, "utf8"))?.status ?? "");
  } catch {
    return "";
  }
}

export async function runInteractionQueueWorker({
  connection = null,
  connectImpl = connectDoubao,
  endpoint,
  heartbeatMs = 30_000,
  idleMs = 1_000,
  maxJobs = 0,
  quotaGate = null,
  queueRoot,
  runJobImpl = runDoubaoJob,
  shouldStopWhenIdle = null,
  signal,
  targetId,
  workerId = `worker-${process.pid}-${randomUUID()}`,
} = {}) {
  if (!String(targetId ?? "").trim()) throw new Error("A queue worker must bind one explicit Doubao targetId.");
  const completed = [];
  let handled = 0;
  let activeConnection = connection;
  const interactionGate = quotaGate ?? await createInteractionQuotaGate({ queueRoot });

  while (!signal?.aborted && (maxJobs === 0 || handled < maxJobs)) {
    try {
      await interactionGate.waitIfPaused({ signal });
    } catch (error) {
      if (error?.code !== INTERACTION_QUOTA_SUSPENDED) throw error;
      return {
        handled,
        jobs: completed,
        quotaPause: error.quotaPause ?? interactionGate.snapshot(),
        status: "quota-suspended",
        targetId,
        workerId,
      };
    }
    await recoverStaleInteractionClaims({ queueRoot });
    const claim = await claimNextInteractionJob({ queueRoot, targetId, workerId });
    if (!claim) {
      if (maxJobs > 0) break;
      if (typeof shouldStopWhenIdle === "function" && await shouldStopWhenIdle()) break;
      await abortableWait(idleMs, signal);
      continue;
    }
    const resultPath = resultPathForInteractionJob(queueRoot, claim.jobId);
    let heartbeat;
    let heartbeatInFlight = Promise.resolve();
    const stopHeartbeat = async () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      await heartbeatInFlight;
    };
    try {
      if (!activeConnection) activeConnection = await connectImpl(endpoint, { targetId });
      if (activeConnection.pageInfo?.targetId !== targetId) {
        throw new Error(`Worker ${workerId} connected to the wrong Doubao target.`);
      }
      const config = await loadClaimedInteractionConfig(claim);
      heartbeat = setInterval(() => {
        heartbeatInFlight = heartbeatInFlight
          .then(() => heartbeatInteractionClaim(claim))
          .catch(() => {});
      }, heartbeatMs);
      heartbeat.unref?.();
      const result = await runJobImpl({
        config,
        executionSlot: {
          browserContextId: activeConnection.pageInfo?.browserContextId ?? "",
          endpoint,
          targetId,
          workerId,
        },
        outputPath: resultPath,
        page: activeConnection.page,
        interactionGate,
        resume: claim.resume === true,
        runId: randomUUID(),
        signal,
        withSharedResource: (resource, fn) => withInteractionQueueResourceLock({
          fn,
          queueRoot,
          resource,
          signal,
        }),
      });
      await stopHeartbeat();
      await finishInteractionClaim(claim, { resultPath, state: "completed" });
      completed.push({ jobId: claim.jobId, resultPath, status: result.status });
    } catch (error) {
      await stopHeartbeat();
      const savedStatus = await savedResultStatus(resultPath);
      const terminalState = savedStatus.startsWith("paused") ? "paused" : "failed";
      await finishInteractionClaim(claim, { error, resultPath, state: terminalState });
      const conversationRestarted = terminalState === "failed"
        && ["RECOVERY_PROMPT_MISMATCH", "RECOVERY_ATTACHMENT_MISMATCH"].includes(String(error?.code ?? ""));
      if (conversationRestarted) {
        await retryFailedInteractionJob({ jobId: claim.jobId, queueRoot });
      }
      completed.push({
        error: { code: String(error.code ?? ""), message: String(error.message ?? error) },
        jobId: claim.jobId,
        resultPath,
        status: conversationRestarted ? "restarted-fresh" : terminalState,
      });
    } finally {
      await stopHeartbeat();
    }
    handled += 1;
  }
  const quotaPause = interactionGate.snapshot();
  return {
    handled,
    jobs: completed,
    quotaPause,
    status: quotaPause?.mode === "manual" ? "quota-suspended" : "complete",
    targetId,
    workerId,
  };
}

export async function runInteractionQueuePool({
  connectImpl = connectDoubao,
  endpoint,
  maxJobsPerWorker = 0,
  queueRoot,
  runJobImpl = runDoubaoJob,
  quotaGate = null,
  shouldStopWhenIdle = null,
  signal,
  targetIds = [],
} = {}) {
  const uniqueTargets = [...new Set(targetIds.map((item) => String(item).trim()).filter(Boolean))];
  if (!uniqueTargets.length) throw new Error("Queue pool requires at least one targetId.");
  if (uniqueTargets.length !== targetIds.length) throw new Error("Queue pool targetIds must be unique.");
  if (uniqueTargets.length > MAX_INTERACTION_WORKERS) {
    throw new Error(`Queue pool supports at most ${MAX_INTERACTION_WORKERS} concurrent interaction windows.`);
  }
  const interactionGate = quotaGate ?? await createInteractionQuotaGate({ queueRoot });
  const connections = await Promise.all(uniqueTargets.map((targetId) => connectImpl(endpoint, { targetId })));
  const rawContextIds = connections.map((connection) => String(connection.pageInfo?.browserContextId ?? ""));
  const contextIds = new Set(rawContextIds.filter(Boolean));
  if (contextIds.size > 1 || (contextIds.size === 1 && rawContextIds.some((item) => !item))) {
    throw new Error("All pool windows must share one browser context/login state.");
  }
  const workers = uniqueTargets.map((targetId, index) => runInteractionQueueWorker({
    connection: connections[index],
    endpoint,
    maxJobs: maxJobsPerWorker,
    queueRoot,
    quotaGate: interactionGate,
    runJobImpl,
    shouldStopWhenIdle,
    signal,
    targetId,
    workerId: `slot-${index + 1}-${targetId}`,
  }));
  const results = await Promise.all(workers);
  return {
    browserContextId: [...contextIds][0] ?? "",
    handled: results.reduce((sum, item) => sum + item.handled, 0),
    quotaPause: interactionGate.snapshot(),
    status: results.some((item) => item.status === "quota-suspended") ? "quota-suspended" : "complete",
    workers: results,
  };
}
