import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildIncompleteSubmissionPackage,
  buildSubmissionPackage,
  writeIncompleteSubmissionPackage,
  writeSubmissionPackage,
} from "../src/submission-package.mjs";

function state() {
  return {
    status: "packaging_submission",
    jobId: "submission-test",
    configHash: "a".repeat(64),
    conversationId: "38434251747760642",
    feedbackUrl: "https://www.doubao.com/thread/x5ba098bae44281c38db11afe8c824c2d",
    finalProductAcceptance: { accepted: true, items: [], overall: "not-required" },
    logId: "202607171625513320A61F727FD9BB8B3A",
    shareLink: "https://www.doubao.com/thread/xe8fc46897243840ba5b55e500e317b94",
    shareReceipt: { allSelected: true, selectedCount: 12 },
    rounds: Array.from({ length: 6 }, (_, index) => ({
      status: "complete",
      prompt: `第${index + 1}轮工作追问`,
      response: { responseIdentity: `response-${index + 1}` },
      evaluation: {
        labels: ["内容准确", "其他"],
        note: `第${index + 1}轮评价说明`,
        vote: "like",
      },
    })),
  };
}

test("builds and atomically writes a six-row ready-not-submitted package", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "doubao-submission-package-"));
  const resultPath = path.join(directory, "result.json");
  try {
    const preview = buildSubmissionPackage(state());
    assert.equal(preview.status, "READY_NOT_SUBMITTED");
    assert.equal(preview.rows.length, 6);
    assert.equal(preview.productAcceptance.accepted, true);
    assert.equal(preview.writeback.applied, false);
    assert.equal(preview.schemaVersion, 2);
    assert.equal("productScreenshot" in preview.rows[0], false);
    const receipt = await writeSubmissionPackage(state(), { resultPath });
    assert.equal(receipt.pass, true);
    assert.equal("screenshotCount" in receipt, false);
    assert.equal(receipt.writeApplied, false);
    const parsed = JSON.parse(await readFile(path.resolve(directory, receipt.artifactPath), "utf8"));
    assert.equal(parsed.conversation.allMessagesSelected, true);
    assert.equal(parsed.rows[5].roundNumber, 6);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("refuses to package a conversation without final product acceptance", () => {
  const value = state();
  value.finalProductAcceptance = { accepted: false, overall: "missing-or-unacceptable" };
  assert.throws(() => buildSubmissionPackage(value), /accepted final product/u);
});

test("writes a submittable Doubao-gap package without pretending the final product exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "doubao-incomplete-package-"));
  const resultPath = path.join(directory, "result.json");
  const value = state();
  value.finalProductAcceptance = { accepted: false, items: [], overall: "missing-or-unacceptable" };
  value.minimumRounds = 6;
  value.completionOutcome = "doubao-unable";
  value.unresolvedIssues = ["豆包仍未生成要求的最终产物"];
  value.rounds.forEach((round) => {
    round.response.response = "专业版额度已用完，当前没有生成最终产物。";
    round.evaluation = {
      evidenceQuote: "专业版额度已用完",
      labels: ["其他"],
      note: "本轮没有完成要求。",
      score: 0,
      vote: "dislike",
    };
  });
  try {
    const preview = buildIncompleteSubmissionPackage(value);
    assert.equal(preview.status, "READY_WITH_DOUBAO_GAP");
    assert.equal(preview.productAcceptance.accepted, false);
    assert.equal(preview.writeback.applied, false);
    const receipt = await writeIncompleteSubmissionPackage(value, { resultPath });
    assert.equal(receipt.pass, true);
    const parsed = JSON.parse(await readFile(path.resolve(directory, receipt.artifactPath), "utf8"));
    assert.equal(parsed.blockingReason, "doubao-task-unfinished");
    assert.deepEqual(parsed.unresolvedIssues, value.unresolvedIssues);
    assert.equal(parsed.rows.length, 6);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
