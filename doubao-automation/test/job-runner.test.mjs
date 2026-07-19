import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JobPauseRequestedError } from "../src/job-control.mjs";
import { artifactRootForResult } from "../src/artifact-root.mjs";
import {
  enforceFinalExperienceAcceptance,
  isRepairablePromptQualityFailure,
  isResumablePromptQualityRound,
  isResumableVisibleResponseRound,
  runDoubaoJob,
  validateCompletedJobResult,
  validateJobConfig,
  verifyCompletedJobArtifacts,
} from "../src/job-runner.mjs";

test("rejects an artifact-backed final product when the actual experience score is below 3", () => {
  const product = {
    accepted: true,
    items: [{ requestedFormat: "excel", status: "exact" }],
    overall: "accepted",
  };
  const rejected = enforceFinalExperienceAcceptance(product, {
    evidenceQuote: "只包含第139至535行",
    note: "最终文件没有覆盖完整数据。",
    score: 2,
    vote: "dislike",
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.overall, "rejected-by-final-experience-gate");
  assert.equal(rejected.experienceGate.pass, false);

  const accepted = enforceFinalExperienceAcceptance(product, {
    evidenceQuote: "文件内容完整",
    note: "最终文件覆盖完整数据并且可以使用。",
    score: 3,
    vote: "like",
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.experienceGate.pass, true);
});

test("retries only semantic prompt-quality failures and resumes the unsent candidate", () => {
  const semanticFailure = {
    code: "MODEL_INVOCATION_FAILED",
    message: "Codex prompt quality gate returned an unusable decision: rejected",
  };
  const infrastructureFailure = {
    code: "MODEL_INVOCATION_FAILED",
    message: "Codex prompt quality gate failed: executable unavailable",
  };
  const round = {
    plannedPrompt: "我想核对本轮附件并整理结论。",
    response: null,
    status: "preflight",
  };
  assert.equal(isRepairablePromptQualityFailure(semanticFailure), true);
  assert.equal(isRepairablePromptQualityFailure(infrastructureFailure), false);
  assert.equal(isResumablePromptQualityRound(round, semanticFailure), true);
  assert.equal(isResumablePromptQualityRound(round, infrastructureFailure), false);
  assert.equal(isResumablePromptQualityRound({ ...round, response: { response: "已发送" } }, semanticFailure), false);
});

test("resumes post-response feedback stages without sending the same prompt twice", () => {
  for (const status of [
    "response_received",
    "capturing_product_screenshot",
    "response_visibility_pass",
    "feedback_rewriting",
    "feedback_preflight",
    "evaluating",
  ]) {
    assert.equal(isResumableVisibleResponseRound({
      status,
      response: { response: "已完成本轮计算。", responseIdentity: "response-2" },
    }), true, status);
  }
  assert.equal(isResumableVisibleResponseRound({
    status: "sending",
    response: { response: "", responseIdentity: "" },
  }), false);
});

function scriptedJob(roundCount = 6) {
  return {
    attachmentRoot: "C:\\DoubaoAutomation\\attachments\\test-job-001",
    attachments: [{
      name: "附件一_运营台账.xlsx",
      relativePath: "附件一_运营台账.xlsx",
      sha256: "0".repeat(64),
      sourceUrl: "https://www.ccgp.gov.cn/cggg/dfgg/cjgg/202607/t20260718_000001.htm",
      summary: "记录测试项目2026年7月的运营对象、时间和复核状态。",
      classification: "specific-business",
      objectLevel: true,
      timeAnchor: "2026年7月运营复核",
      specificityEvidence: {
        object: "测试项目运营台账",
        periodOrEvent: "2026年7月复核",
        uniqueContent: "包含该项目逐项运营记录和实际复核状态",
      },
    }],
    jobId: "test-job-001",
    developmentOnlyScripted: true,
    maxRounds: roundCount,
    mode: "scripted",
    taskGoal: "核对公司运营台账并形成内部复核结论。",
    interactionRewrite: {
      type: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      model: "rewrite-model",
    },
    promptPreflight: {
      type: "local-codex",
      model: "gpt-codex-review-model",
    },
    rounds: Array.from({ length: roundCount }, (_, index) => ({
      prompt: `我需要继续核对公司运营台账并补充第${index + 1}批复核结论。`,
      evaluation: {
        vote: "like",
        labels: ["内容准确", "其他"],
        note: "回复满足本轮的明确要求，内容准确并且可以直接使用。",
      },
    })),
  };
}

test("accepts a six-round scripted job", () => {
  assert.equal(validateJobConfig(scriptedJob()).maxRounds, 6);
});

test("keeps scripted prompts out of production jobs", () => {
  const job = scriptedJob();
  delete job.developmentOnlyScripted;
  assert.throws(() => validateJobConfig(job), /development regression/u);
});

test("blocks live jobs that bypass the shared production evidence path", () => {
  const job = scriptedJob();
  job.mode = "openai-compatible";
  delete job.developmentOnlyScripted;
  delete job.rounds;
  job.attachments[0].sourceUrl = "https://www.ccgp.gov.cn/cggg/dfgg/cjgg/202607/t20260718_000001.htm";
  job.initialPrompt = "我需要核对这份真实业务材料，并形成可复核的阶段结论。";
  job.policy = { type: "local-codex", model: "gpt-5.6-sol" };
  assert.throws(() => validateJobConfig(job), /compile attachments from productionEvidence/u);
});

test("treats six rounds as the live minimum and reserves room for corrective follow-ups", () => {
  const job = scriptedJob();
  job.mode = "openai-compatible";
  delete job.developmentOnlyScripted;
  delete job.rounds;
  job._attachmentsHydratedFromProductionEvidence = true;
  job.initialPrompt = "我需要核对这份真实业务材料，并形成可复核的阶段结论。";
  job.policy = { type: "local-codex", model: "gpt-5.6-sol" };
  const evidenceRoot = path.resolve("outputs", "test-production-evidence");
  job.productionEvidence = {
    recordUid: "测试_7.18_L1_01",
    productionTracePath: path.join(evidenceRoot, "production_trace.json"),
    productionTraceGateReceiptPath: path.join(evidenceRoot, "production_trace_gate_receipt.json"),
    releaseGateReceiptPath: path.join(evidenceRoot, "release_gate_receipt.json"),
    downloadManifestPath: path.join(evidenceRoot, "download_manifest.json"),
  };
  const validated = validateJobConfig(job);
  assert.equal(validated.minimumRounds, 6);
  assert.equal(validated.maxRounds, 12);

  const explicitlyBounded = validateJobConfig({ ...job, maximumRounds: 9 });
  assert.equal(explicitlyBounded.minimumRounds, 6);
  assert.equal(explicitlyBounded.maxRounds, 9);
});

test("rejects a job shorter than the guide requirement", () => {
  assert.throws(() => validateJobConfig(scriptedJob(5)), /6 to 20/u);
});

test("accepts only a complete result with six verified evaluations and a Feishu-ready package", async () => {
  const attachment = {
    name: "附件一_运营台账.xlsx",
    relativePath: "附件一_运营台账.xlsx",
    sha256: "0".repeat(64),
    sizeBytes: 128,
  };
  const result = {
    attachmentManifest: {
      attachmentCount: 1,
      attachments: [attachment],
      initialAttachmentNames: [attachment.name],
      pass: true,
    },
    conversationId: "38434251747760642",
    feedbackUrl: "https://www.doubao.com/thread/x5ba098bae44281c38db11afe8c824c2d",
    jobId: "test-job-001",
    logId: "202607171625513320A61F727FD9BB8B3A",
    logReceipt: {
      feedbackUrl: "https://www.doubao.com/thread/x5ba098bae44281c38db11afe8c824c2d",
      logId: "202607171625513320A61F727FD9BB8B3A",
      pass: true,
    },
    maxRounds: 6,
    mode: "scripted",
    finalProductAcceptance: {
      accepted: true,
      items: [],
      overall: "not-required",
    },
    taskGoal: "核对公司运营台账并形成内部复核结论。",
    rounds: Array.from({ length: 6 }, (_, index) => {
      const prompt = "我想继续核对公司运营台账并补充复核结论。";
      const note = "回复符合本轮实际要求，内容准确并且可以直接使用。";
      const responseIdentity = `response-${index + 1}`;
      return {
        attachmentNames: index === 0 ? [attachment.name] : [],
        evaluation: {
          labels: ["内容准确", "其他"],
          note,
          panelClosed: true,
          submitted: true,
          vote: "like",
        },
        attachmentVerification: index === 0 ? { attachmentCount: 1, attachments: [attachment], pass: true } : null,
        response: {
          artifacts: [],
          response: "OK",
          responseCount: index + 1,
          responseIdentity,
          sendReceipt: {
            countAfter: index + 1,
            countBefore: index,
            pass: true,
            prompt,
          },
          attachmentUpload: index === 0 ? {
            pass: true,
            expectedCount: 1,
            expectedNames: [attachment.name],
            visibleCount: 1,
            visibleNames: [attachment.name],
          } : null,
        },
        responseVisibility: { pass: true, issues: [] },
        status: "complete",
        rewrite: { pass: true, model: "rewrite-model", prompt },
        preflight: {
          pass: true,
          model: "gpt-codex-review-model",
        },
        feedbackRewrite: { pass: true, model: "rewrite-model", prompt: note },
        feedbackPreflight: {
          pass: true,
          model: "gpt-codex-review-model",
        },
        prompt,
      };
    }),
    shareLink: "https://www.doubao.com/thread/xe8fc46897243840ba5b55e500e317b94",
    shareReceipt: {
      allSelected: true,
      checkboxCount: 5,
      pass: true,
      selectAll: true,
      selectedCount: 5,
      selectionProof: "global-select-all-checkbox",
      shareLink: "https://www.doubao.com/thread/xe8fc46897243840ba5b55e500e317b94",
    },
    status: "complete",
  };
  const submissionValue = {
    schemaVersion: 2,
    kind: "doubao-feishu-submission-package",
    status: "READY_NOT_SUBMITTED",
    roundCount: result.rounds.length,
    productAcceptance: result.finalProductAcceptance,
    conversation: {
      conversationId: result.conversationId,
      feedbackUrl: result.feedbackUrl,
      logId: result.logId,
      shareLink: result.shareLink,
    },
    rows: result.rounds.map((round, index) => ({
      roundNumber: index + 1,
      prompt: round.prompt,
      responseIdentity: round.response.responseIdentity,
      humanEvaluation: {
        labels: round.evaluation.labels,
        note: round.evaluation.note,
        vote: round.evaluation.vote,
      },
    })),
    writeback: { applied: false, readbackVerified: false },
  };
  const submissionBytes = Buffer.from(`${JSON.stringify(submissionValue, null, 2)}\n`, "utf8");
  result.submissionPackage = {
    artifactPath: "result.artifacts/feishu-submission-package.json",
    pass: true,
    roundCount: 6,
    sha256: createHash("sha256").update(submissionBytes).digest("hex"),
    sizeBytes: submissionBytes.length,
    status: "READY_NOT_SUBMITTED",
    writeApplied: false,
  };
  assert.equal(validateCompletedJobResult(result).roundCount, 6);
  assert.throws(
    () => validateCompletedJobResult({ ...result, rounds: result.rounds.slice(0, 5) }),
    /round count/u,
  );
  const changedAfterRewrite = structuredClone(result);
  changedAfterRewrite.rounds[0].prompt = "质检后又被改动的文本。";
  assert.throws(
    () => validateCompletedJobResult(changedAfterRewrite),
    /changed after its de-AI rewrite/u,
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "doubao-result-artifacts-"));
  const resultPath = path.join(directory, "result.json");
  try {
    await mkdir(artifactRootForResult(resultPath), { recursive: true });
    await writeFile(path.resolve(directory, result.submissionPackage.artifactPath), submissionBytes);
    const verified = await verifyCompletedJobArtifacts(result, { resultPath });
    assert.equal(verified.submissionPackage.status, "READY_NOT_SUBMITTED");
    assert.equal("screenshots" in verified, false);
    await writeFile(path.resolve(directory, result.submissionPackage.artifactPath), "tampered");
    await assert.rejects(verifyCompletedJobArtifacts(result, { resultPath }), /hash\/size/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects a job without the mandatory model prompt preflight", () => {
  const job = scriptedJob();
  delete job.promptPreflight;
  assert.throws(() => validateJobConfig(job), /promptPreflight/u);
});

test("accepts a custom official-compatible Responses preflight without persisting a credential", () => {
  const job = scriptedJob();
  job.promptPreflight = {
    type: "responses-api",
    baseUrl: "https://gateway.example/openai/v1",
    apiKeyEnv: "CODEX_RESPONSES_API_KEY",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  };
  const validated = validateJobConfig(job);
  assert.equal(validated.promptPreflight.type, "responses-api");
  assert.equal(JSON.stringify(validated).includes("Bearer"), false);

  job.promptPreflight.apiKey = "must-not-be-stored";
  assert.throws(() => validateJobConfig(job), /inline apiKey is forbidden/u);
});

test("rejects a job without the mandatory interaction de-AI rewrite", () => {
  const job = scriptedJob();
  delete job.interactionRewrite;
  assert.throws(() => validateJobConfig(job), /interactionRewrite/u);
});

test("persists an operator pause before touching Doubao when already aborted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "doubao-job-pause-"));
  const outputPath = path.join(directory, "result.json");
  const controller = new AbortController();
  controller.abort(new JobPauseRequestedError());
  try {
    await assert.rejects(
      runDoubaoJob({
        config: scriptedJob(),
        outputPath,
        page: {},
        runId: "run-pause-test",
        signal: controller.signal,
        workerPid: 12345,
      }),
      (error) => error.code === "JOB_PAUSE_REQUESTED",
    );
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.status, "paused_by_operator");
    assert.equal(result.pause.resumePolicy, "manual-resume-only-no-fallback");
    assert.equal(result.stoppedWorkerPid, 12345);
    assert.equal(result.workerPid, null);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("pauses a foreign-platform job before touching Doubao", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "doubao-scope-pause-"));
  const outputPath = path.join(directory, "result.json");
  const config = scriptedJob();
  config.rounds[0].prompt = "比较 Zoom 和 Google Meet，形成公司采购结论。";
  try {
    await assert.rejects(
      runDoubaoJob({ config, outputPath, page: {}, runId: "scope-block-test", workerPid: 12346 }),
      (error) => error.code === "CONTENT_SCOPE_BLOCKED" && error.issues.includes("foreign-platform"),
    );
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.status, "paused_content_scope_blocked");
    assert.equal(result.rounds.length, 0);
    assert.equal(result.workerPid, null);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
