import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runInteractionQueuePool } from "../src/queue-worker.mjs";
import { InteractionQuotaGate } from "../src/quota-pause.mjs";
import {
  enqueueInteractionJob,
  interactionQueueStatus,
  resumeFailedInteractionJob,
} from "../src/task-queue.mjs";
import { createScriptedJob } from "./helpers/scripted-job.mjs";

test("runs two queued interactions concurrently in isolated windows sharing one login context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-pool-"));
  try {
    const queueRoot = path.join(root, "queue");
    for (const jobId of ["parallel-a", "parallel-b"]) {
      const { configPath } = await createScriptedJob(root, jobId);
      await enqueueInteractionJob({ configPath, queueRoot });
    }
    let active = 0;
    let maximumActive = 0;
    let clipboardActive = 0;
    let maximumClipboardActive = 0;
    const calls = [];
    const result = await runInteractionQueuePool({
      endpoint: "http://127.0.0.1:9229",
      maxJobsPerWorker: 1,
      queueRoot,
      targetIds: ["target-a", "target-b"],
      connectImpl: async (_endpoint, { targetId }) => ({
        page: { targetId },
        pageInfo: { browserContextId: "shared-login-context", targetId },
      }),
      runJobImpl: async ({ config, executionSlot, page, withSharedResource }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        calls.push({ jobId: config.jobId, pageTarget: page.targetId, slotTarget: executionSlot.targetId });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await withSharedResource("system-clipboard", async () => {
          clipboardActive += 1;
          maximumClipboardActive = Math.max(maximumClipboardActive, clipboardActive);
          await new Promise((resolve) => setTimeout(resolve, 30));
          clipboardActive -= 1;
        });
        active -= 1;
        return { status: "complete" };
      },
    });
    assert.equal(result.handled, 2);
    assert.equal(result.browserContextId, "shared-login-context");
    assert.equal(maximumActive, 2);
    assert.equal(maximumClipboardActive, 1);
    assert.equal(calls.every((item) => item.pageTarget === item.slotTarget), true);
    assert.equal(new Set(calls.map((item) => item.pageTarget)).size, 2);
    assert.equal((await interactionQueueStatus(queueRoot)).counts.completed, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects windows from different login contexts", async () => {
  await assert.rejects(
    runInteractionQueuePool({
      endpoint: "http://127.0.0.1:9229",
      maxJobsPerWorker: 1,
      queueRoot: path.join(os.tmpdir(), `doubao-context-${Date.now()}`),
      targetIds: ["target-a", "target-b"],
      connectImpl: async (_endpoint, { targetId }) => ({
        page: { targetId },
        pageInfo: { browserContextId: `context-${targetId}`, targetId },
      }),
    }),
    /share one browser context/u,
  );
});

test("rejects an ambiguous mix of default and named login contexts", async () => {
  await assert.rejects(
    runInteractionQueuePool({
      endpoint: "http://127.0.0.1:9229",
      maxJobsPerWorker: 1,
      queueRoot: path.join(os.tmpdir(), `doubao-context-mixed-${Date.now()}`),
      targetIds: ["target-default", "target-named"],
      connectImpl: async (_endpoint, { targetId }) => ({
        page: { targetId },
        pageInfo: {
          browserContextId: targetId === "target-default" ? "" : "named-context",
          targetId,
        },
      }),
    }),
    /share one browser context/u,
  );
});

test("caps one login state at three concurrent interaction windows", async () => {
  await assert.rejects(
    runInteractionQueuePool({
      endpoint: "http://127.0.0.1:9229",
      queueRoot: path.join(os.tmpdir(), `doubao-too-many-windows-${Date.now()}`),
      targetIds: ["target-a", "target-b", "target-c", "target-d"],
      connectImpl: async () => {
        throw new Error("must not connect before the concurrency limit is checked");
      },
    }),
    /at most 3 concurrent interaction windows/u,
  );
});

test("waiting consumers stop only after the producer marks an empty queue drained", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-drained-"));
  try {
    let producerSettled = false;
    let checks = 0;
    const run = runInteractionQueuePool({
      endpoint: "http://127.0.0.1:9229",
      queueRoot: path.join(root, "queue"),
      targetIds: ["target-a", "target-b", "target-c"],
      connectImpl: async (_endpoint, { targetId }) => ({
        page: { targetId },
        pageInfo: { browserContextId: "shared-login-context", targetId },
      }),
      shouldStopWhenIdle: async () => {
        checks += 1;
        return producerSettled;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    producerSettled = true;
    const result = await run;
    assert.equal(result.handled, 0);
    assert.equal(result.workers.length, 3);
    assert.ok(checks >= 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumes a failed queue job from its saved result without archiving or restarting it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-resume-"));
  try {
    const queueRoot = path.join(root, "queue");
    const { configPath } = await createScriptedJob(root, "resume-a");
    await enqueueInteractionJob({ configPath, queueRoot });
    const connection = {
      page: { targetId: "target-a" },
      pageInfo: { browserContextId: "shared-login-context", targetId: "target-a" },
    };
    await runInteractionQueuePool({
      endpoint: "http://127.0.0.1:9229",
      maxJobsPerWorker: 1,
      queueRoot,
      targetIds: ["target-a"],
      connectImpl: async () => connection,
      runJobImpl: async ({ config, outputPath }) => {
        await writeFile(outputPath, `${JSON.stringify({ jobId: config.jobId, status: "failed" })}\n`);
        throw new Error("share panel was not ready");
      },
    });
    assert.equal((await interactionQueueStatus(queueRoot)).counts.failed, 1);
    await resumeFailedInteractionJob({ jobId: "resume-a", queueRoot });
    let receivedResume = false;
    await runInteractionQueuePool({
      endpoint: "http://127.0.0.1:9229",
      maxJobsPerWorker: 1,
      queueRoot,
      targetIds: ["target-a"],
      connectImpl: async () => connection,
      runJobImpl: async ({ config, outputPath, resume }) => {
        receivedResume = resume;
        await writeFile(outputPath, `${JSON.stringify({ jobId: config.jobId, status: "complete" })}\n`);
        return { status: "complete" };
      },
    });
    assert.equal(receivedResume, true);
    assert.equal((await interactionQueueStatus(queueRoot)).counts.completed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mismatched recovered conversation is discarded and requeued as a fresh interaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-restart-fresh-"));
  try {
    const queueRoot = path.join(root, "queue");
    const { configPath } = await createScriptedJob(root, "restart-fresh");
    await enqueueInteractionJob({ configPath, queueRoot });
    const result = await runInteractionQueuePool({
      endpoint: "http://127.0.0.1:9229",
      maxJobsPerWorker: 1,
      queueRoot,
      targetIds: ["target-a"],
      connectImpl: async () => ({
        page: { targetId: "target-a" },
        pageInfo: { browserContextId: "shared-login-context", targetId: "target-a" },
      }),
      runJobImpl: async ({ config, outputPath }) => {
        await writeFile(outputPath, `${JSON.stringify({ jobId: config.jobId, status: "failed" })}\n`);
        const error = new Error("visible prompt belongs to another task");
        error.code = "RECOVERY_PROMPT_MISMATCH";
        throw error;
      },
    });
    assert.equal(result.workers[0].jobs[0].status, "restarted-fresh");
    const status = await interactionQueueStatus(queueRoot);
    assert.equal(status.counts.pending, 1);
    assert.equal(status.counts.failed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one long quota notice suspends all interaction windows and leaves queued work untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-global-quota-"));
  try {
    const queueRoot = path.join(root, "queue");
    for (const jobId of ["quota-a", "quota-b", "quota-pending"]) {
      const { configPath } = await createScriptedJob(root, jobId);
      await enqueueInteractionJob({ configPath, queueRoot });
    }
    const quotaGate = new InteractionQuotaGate({
      nowImpl: () => new Date(2026, 6, 19, 10, 0, 0, 0),
      queueRoot,
    });
    let triggerSelected = false;
    let triggerReady;
    const triggered = new Promise((resolve) => { triggerReady = resolve; });
    let modelCallsAfterQuota = 0;
    const result = await runInteractionQueuePool({
      endpoint: "http://127.0.0.1:9229",
      maxJobsPerWorker: 1,
      queueRoot,
      quotaGate,
      targetIds: ["target-a", "target-b"],
      connectImpl: async (_endpoint, { targetId }) => ({
        page: { targetId },
        pageInfo: { browserContextId: "shared-login-context", targetId },
      }),
      runJobImpl: async ({ config, interactionGate, outputPath }) => {
        if (!triggerSelected) {
          triggerSelected = true;
          await interactionGate.triggerFromNotice({
            jobId: config.jobId,
            notice: "额度用完了，预计明日 11:01 恢复为你服务。",
            targetId: "target-a",
          });
          triggerReady();
        } else {
          await triggered;
        }
        try {
          await interactionGate.waitIfPaused();
          modelCallsAfterQuota += 1;
          return { status: "complete" };
        } catch (error) {
          await writeFile(outputPath, `${JSON.stringify({
            error: { code: error.code },
            jobId: config.jobId,
            status: "paused_quota_wait",
          })}\n`);
          throw error;
        }
      },
    });
    const status = await interactionQueueStatus(queueRoot);
    assert.equal(result.status, "quota-suspended");
    assert.equal(result.quotaPause.mode, "manual");
    assert.equal(modelCallsAfterQuota, 0);
    assert.equal(status.counts.paused, 2);
    assert.equal(status.counts.pending, 1);
    assert.equal(status.counts.failed, 0);
    assert.equal(status.quotaPause.mode, "manual");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
