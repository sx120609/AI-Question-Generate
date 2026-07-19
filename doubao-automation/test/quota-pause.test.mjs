import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createInteractionQuotaGate,
  InteractionQuotaGate,
  InteractionQuotaSuspendedError,
  parseDoubaoQuotaRecovery,
  releaseInteractionQuotaPause,
} from "../src/quota-pause.mjs";

test("parses today's Doubao recovery clock and adds exactly one minute of grace", () => {
  const now = new Date(2026, 6, 19, 14, 0, 0, 0);
  const parsed = parseDoubaoQuotaRecovery(
    "5 小时的额度用完了，预计今日 15:11 恢复为你服务。",
    { now },
  );
  assert.equal(parsed.mode, "automatic");
  assert.equal(new Date(parsed.serviceRecoveryAt).getHours(), 15);
  assert.equal(new Date(parsed.serviceRecoveryAt).getMinutes(), 11);
  assert.equal(new Date(parsed.interactionResumeAt).getHours(), 15);
  assert.equal(new Date(parsed.interactionResumeAt).getMinutes(), 12);
  assert.equal(parsed.waitMs, 72 * 60 * 1000);
});

test("turns waits longer than one day and unparseable quota notices into manual suspension", () => {
  const now = new Date(2026, 6, 19, 10, 0, 0, 0);
  const tomorrow = parseDoubaoQuotaRecovery(
    "额度用完，预计明日 11:01 恢复为你服务。",
    { now },
  );
  assert.equal(tomorrow.waitMs, (25 * 60 + 2) * 60 * 1000);
  assert.equal(tomorrow.mode, "manual");

  const unknown = parseDoubaoQuotaRecovery("专业版功能的免费额度用完了，请稍后再试。", { now });
  assert.equal(unknown.parseStatus, "unparsed");
  assert.equal(unknown.mode, "manual");
});

test("automatic quota gate waits without invoking any work callback and then releases", async () => {
  let now = new Date(2026, 6, 19, 9, 59, 30, 0);
  const delays = [];
  let workCalls = 0;
  const gate = new InteractionQuotaGate({
    delayImpl: async (ms) => {
      delays.push(ms);
      now = new Date(now.getTime() + ms);
    },
    nowImpl: () => new Date(now),
  });
  const receipt = await gate.triggerFromNotice({
    jobId: "quota-short",
    notice: "额度用完了，预计今日 10:00 恢复为你服务。",
    targetId: "target-a",
  });
  assert.equal(receipt.mode, "automatic");
  await gate.waitIfPaused();
  workCalls += 1;
  assert.deepEqual(delays, [30_000, 30_000, 30_000]);
  assert.equal(workCalls, 1);
  assert.equal(gate.snapshot(), null);
});

test("manual quota suspension is durable and requires an explicit release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-quota-"));
  try {
    const now = new Date(2026, 6, 19, 10, 0, 0, 0);
    const gate = await createInteractionQuotaGate({ nowImpl: () => new Date(now), queueRoot: root });
    await gate.triggerFromNotice({
      jobId: "quota-long",
      notice: "额度用完了，预计明日 11:01 恢复为你服务。",
      targetId: "target-a",
    });
    await assert.rejects(gate.waitIfPaused(), InteractionQuotaSuspendedError);

    const restored = await createInteractionQuotaGate({ nowImpl: () => new Date(now), queueRoot: root });
    await assert.rejects(restored.waitIfPaused(), InteractionQuotaSuspendedError);
    const release = await releaseInteractionQuotaPause({ queueRoot: root });
    assert.equal(release.released, true);
    assert.equal(JSON.parse(await readFile(path.join(root, "quota-pause.json"), "utf8")).status, "released-manually");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
