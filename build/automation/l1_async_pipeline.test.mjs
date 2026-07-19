import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveAsyncBatchSpec,
  runAsyncProductionQueue,
} from "./l1_async_pipeline.mjs";

test("derives isolated repeatable task identities without changing source evidence", () => {
  const source = {
    kind: "source-specs",
    tasks: [
      { slug: "alpha", runId: "source-run-a", jobId: "source-job-a", recordUid: "old-a", facts: [{ id: "fact-a" }] },
      { slug: "beta", runId: "source-run-b", jobId: "source-job-b", recordUid: "old-b", facts: [{ id: "fact-b" }] },
    ],
  };
  const batch = deriveAsyncBatchSpec(source, { batchId: "batch-001", slugs: ["beta", "alpha"] });
  assert.equal(batch.tasks.length, 2);
  assert.equal(batch.tasks[0].asyncBatch.sourceRunId, "source-run-b");
  assert.equal(batch.tasks[0].facts[0].id, "fact-b");
  assert.match(batch.tasks[0].runId, /^l1_async_batch-001_01_/u);
  assert.notEqual(batch.tasks[0].jobId, source.tasks[1].jobId);
  assert.equal(source.tasks[1].runId, "source-run-b");
});

test("enqueues each completed production without waiting for slower producers", async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const enqueued = [];
  const execution = runAsyncProductionQueue({
    productionConcurrency: 2,
    tasks: [{ id: "slow" }, { id: "fast" }, { id: "next" }],
    produce: async (task) => {
      if (task.id === "slow") await slow;
      return { jobId: task.id };
    },
    enqueue: async (produced) => {
      enqueued.push(produced.jobId);
      return { state: "pending" };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(enqueued, ["fast", "next"]);
  releaseSlow();
  const result = await execution;
  assert.equal(result.ok, true);
  assert.equal(result.enqueuedCount, 3);
  assert.deepEqual(enqueued, ["fast", "next", "slow"]);
});

test("one production failure does not block other tasks from entering the warehouse", async () => {
  const enqueued = [];
  const result = await runAsyncProductionQueue({
    productionConcurrency: 3,
    tasks: [{ id: "ok-a" }, { id: "bad" }, { id: "ok-b" }],
    produce: async (task) => {
      if (task.id === "bad") throw new Error("generation failed");
      return { jobId: task.id };
    },
    enqueue: async (produced) => {
      enqueued.push(produced.jobId);
      return { state: "pending" };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failedCount, 1);
  assert.equal(result.enqueuedCount, 2);
  assert.deepEqual(enqueued.sort(), ["ok-a", "ok-b"]);
});
