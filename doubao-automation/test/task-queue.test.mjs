import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  abandonPendingInteractionJob,
  claimNextInteractionJob,
  enqueueInteractionJob,
  finishInteractionClaim,
  interactionQueueStatus,
  loadClaimedInteractionConfig,
  recoverStaleInteractionClaims,
  resumeAllQuotaPausedInteractionJobs,
  resumeFailedInteractionJob,
  resultPathForInteractionJob,
} from "../src/task-queue.mjs";
import { createScriptedJob } from "./helpers/scripted-job.mjs";

test("snapshots a generated job into an immutable interaction package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-queue-"));
  try {
    const queueRoot = path.join(root, "queue");
    const source = await createScriptedJob(root, "job-one");
    const enqueued = await enqueueInteractionJob({ configPath: source.configPath, queueRoot });
    await writeFile(path.join(source.attachmentRoot, "附件一.txt"), "changed upstream bytes", "utf8");
    const claim = await claimNextInteractionJob({ queueRoot, targetId: "window-a", workerId: "worker-a" });
    const config = await loadClaimedInteractionConfig(claim);
    assert.equal(config.jobId, "job-one");
    assert.notEqual(config.attachmentRoot, source.attachmentRoot);
    assert.equal((await readFile(path.join(config.attachmentRoot, "附件一.txt"), "utf8")), "real attachment for job-one");
    assert.equal(enqueued.configSha256, claim.configSha256);
    await finishInteractionClaim(claim, { state: "completed", resultPath: path.join(root, "result.json") });
    assert.deepEqual((await interactionQueueStatus(queueRoot)).counts, {
      pending: 0, running: 0, completed: 1, paused: 0, failed: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claims jobs atomically and recovers an expired lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-queue-"));
  try {
    const queueRoot = path.join(root, "queue");
    for (const jobId of ["job-a", "job-b"]) {
      const { configPath } = await createScriptedJob(root, jobId);
      await enqueueInteractionJob({ configPath, queueRoot });
    }
    const [left, right] = await Promise.all([
      claimNextInteractionJob({ queueRoot, targetId: "window-a", workerId: "worker-a" }),
      claimNextInteractionJob({ queueRoot, targetId: "window-b", workerId: "worker-b" }),
    ]);
    assert.equal(new Set([left.jobId, right.jobId]).size, 2);
    const running = JSON.parse(await readFile(left.filePath, "utf8"));
    running.lease.heartbeatAt = "2020-01-01T00:00:00.000Z";
    await writeFile(left.filePath, `${JSON.stringify(running, null, 2)}\n`, "utf8");
    await writeFile(
      resultPathForInteractionJob(queueRoot, left.jobId),
      `${JSON.stringify({
        executionSlot: { targetId: left.lease.targetId },
        jobId: left.jobId,
        status: "running",
        rounds: [{ round: 1 }],
      })}\n`,
      "utf8",
    );
    const live = JSON.parse(await readFile(right.filePath, "utf8"));
    assert.deepEqual(await recoverStaleInteractionClaims({
      queueRoot,
      leaseTimeoutMs: 1_000,
      now: Date.parse(live.lease.heartbeatAt),
    }), [left.jobId]);
    const status = await interactionQueueStatus(queueRoot);
    assert.equal(status.counts.pending, 1);
    assert.equal(status.counts.running, 1);
    assert.equal(await claimNextInteractionJob({
      queueRoot,
      targetId: "window-c",
      workerId: "worker-c",
    }), null);
    const recoveredClaim = await claimNextInteractionJob({
      queueRoot,
      targetId: left.lease.targetId,
      workerId: "worker-recovered",
    });
    assert.equal(recoveredClaim.jobId, left.jobId);
    assert.equal(recoveredClaim.resume, true);
    assert.equal(recoveredClaim.resumeTargetId, left.lease.targetId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumes an interrupted result only on its original window target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-resume-target-"));
  try {
    const queueRoot = path.join(root, "queue");
    const { configPath } = await createScriptedJob(root, "resume-target");
    await enqueueInteractionJob({ configPath, queueRoot });
    const claim = await claimNextInteractionJob({
      queueRoot,
      targetId: "window-original",
      workerId: "worker-original",
    });
    const resultPath = resultPathForInteractionJob(queueRoot, claim.jobId);
    await writeFile(resultPath, `${JSON.stringify({
      executionSlot: { targetId: "window-original" },
      jobId: claim.jobId,
      status: "running",
    })}\n`, "utf8");
    await finishInteractionClaim(claim, {
      error: new Error("coordinator interrupted"),
      resultPath,
      state: "failed",
    });
    const resumed = await resumeFailedInteractionJob({ jobId: claim.jobId, queueRoot });
    assert.equal(resumed.resume, true);
    assert.equal(resumed.resumeTargetId, "window-original");
    assert.equal(await claimNextInteractionJob({
      queueRoot,
      targetId: "window-other",
      workerId: "worker-other",
    }), null);
    const originalWindowClaim = await claimNextInteractionJob({
      queueRoot,
      targetId: "window-original",
      workerId: "worker-resumed",
    });
    assert.equal(originalWindowClaim.jobId, claim.jobId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prioritizes a target-bound resume before ordinary warehouse work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-resume-priority-"));
  try {
    const queueRoot = path.join(root, "queue");
    for (const jobId of ["ordinary-a", "resume-z"]) {
      const { configPath } = await createScriptedJob(root, jobId);
      await enqueueInteractionJob({ configPath, queueRoot });
    }
    const resumeClaim = await claimNextInteractionJob({
      queueRoot,
      targetId: "window-resume",
      workerId: "worker-initial",
    });
    assert.equal(resumeClaim.jobId, "ordinary-a");
    const resultPath = resultPathForInteractionJob(queueRoot, resumeClaim.jobId);
    await writeFile(resultPath, `${JSON.stringify({
      executionSlot: { targetId: "window-resume" },
      jobId: resumeClaim.jobId,
      status: "running",
    })}\n`, "utf8");
    await finishInteractionClaim(resumeClaim, {
      error: new Error("interrupted"),
      resultPath,
      state: "failed",
    });
    await resumeFailedInteractionJob({ jobId: resumeClaim.jobId, queueRoot });
    const claimed = await claimNextInteractionJob({
      queueRoot,
      targetId: "window-resume",
      workerId: "worker-resumed",
    });
    assert.equal(claimed.jobId, "ordinary-a");
    assert.equal(claimed.resumeTargetId, "window-resume");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("abandons a polluted pending conversation before restarting it from scratch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-abandon-"));
  try {
    const queueRoot = path.join(root, "queue");
    const { configPath } = await createScriptedJob(root, "abandon-a");
    await enqueueInteractionJob({ configPath, queueRoot });
    const abandoned = await abandonPendingInteractionJob({
      jobId: "abandon-a",
      queueRoot,
      reason: "wrong prompt entered the conversation",
    });
    assert.equal(abandoned.state, "failed");
    assert.equal(abandoned.lastError.code, "CONVERSATION_ABANDONED");
    assert.equal((await interactionQueueStatus(queueRoot)).counts.failed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumes a quota-paused job in the same interaction window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-resume-paused-"));
  try {
    const queueRoot = path.join(root, "queue");
    const { configPath } = await createScriptedJob(root, "quota-paused-a");
    await enqueueInteractionJob({ configPath, queueRoot });
    const claim = await claimNextInteractionJob({
      queueRoot,
      targetId: "window-quota",
      workerId: "worker-before-quota",
    });
    const resultPath = resultPathForInteractionJob(queueRoot, claim.jobId);
    await writeFile(resultPath, `${JSON.stringify({
      executionSlot: { targetId: "window-quota" },
      jobId: claim.jobId,
      status: "paused_quota_wait",
    })}\n`, "utf8");
    await finishInteractionClaim(claim, {
      error: Object.assign(new Error("quota suspended"), { code: "INTERACTION_QUOTA_SUSPENDED" }),
      resultPath,
      state: "paused",
    });
    const [resumed] = await resumeAllQuotaPausedInteractionJobs({ queueRoot });
    assert.equal(resumed.resume, true);
    assert.equal(resumed.resumeTargetId, "window-quota");
    assert.equal((await interactionQueueStatus(queueRoot)).counts.pending, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
