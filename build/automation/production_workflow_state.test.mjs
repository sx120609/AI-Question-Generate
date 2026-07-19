import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  initializeProductionWorkflow,
  recordReferenceBreakdown,
  recordAttachmentPlan,
  recordDraft,
  recordFirstQualityGate,
  recordSecondLanguageGate,
  recordDeAiRewrite,
  recordFinalRecord,
  buildProductionTrace,
} from "./production_workflow_state.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function deAiResult(sourceQuestion, rewrittenQuestion = sourceQuestion) {
  return {
    kind: "de-ai-question-rewrite",
    policyId: "external-de-ai-rewrite-api-v1",
    provider: "external-rewrite-api",
    selectedAttempt: 1,
    sourceQuestionHash: sha256(sourceQuestion),
    rewrittenQuestionHash: sha256(rewrittenQuestion),
    rewrite: { question: rewrittenQuestion },
    validation: { pass: true, findings: [] },
  };
}

function packet(count = 1) {
  return {
    kind: "l2-production-input-packet", status: "READY", protocolId: "p", runId: "r",
    inputs: {
      referenceWorkbook: { samples: Array.from({ length: count }, (_, index) => ({
        questionIndex: index + 1, sheet: "Sheet1", row: index + 2, questionHash: `q${index}`, attachmentSummaryHash: `a${index}`,
      })) },
      firstQaPrompt: { sha256: "first-prompt" },
      secondQaPrompt: { sha256: "second-prompt" },
    },
  };
}

const breakdown = {
  businessScene: "场景", coreBlockage: "卡点", mainTask: "主任务", attachmentSupport: "支撑",
  deliverableOrigin: "产物来源", imitableStructure: "可仿结构", forbiddenReuse: "禁止复用",
  referenceAttachmentStructure: "附件结构", referenceProductParagraphLogic: "后半段逻辑",
};
const plan = {
  attachments: [{
    name: "项目2026年季度记录.xlsx",
    sourceUrl: "https://new.example/1",
    classification: "specific-business",
    objectLevel: true,
    timeAnchor: "2026年第一季度",
    summary: "项目2026年第一季度的订单与履约记录",
    specificityEvidence: {
      object: "测试项目",
      periodOrEvent: "2026年第一季度",
      uniqueContent: "包含该项目订单、履约和异常结果",
    },
  }],
  newAttachmentSupport: "记录进入判断", newQuestionStructureMapping: "只仿推进",
};

function advanceToDraft(workflow, index = 1) {
  recordReferenceBreakdown(workflow, index, breakdown);
  recordAttachmentPlan(workflow, index, plan);
  recordDraft(workflow, index, {
    question: "题面",
    mainTask: "主任务",
    structureMapping: "只仿推进",
    productFormats: "docx, xlsx",
    deliverableRationale: [
      { format: "docx", user: "项目负责人", purpose: "说明判断过程", whyThisFormat: "适合承载连续说明" },
      { format: "xlsx", user: "执行同事", purpose: "记录核对结果", whyThisFormat: "适合筛选和更新数据" },
    ],
  });
}

const finalQuestion = "先整理合同和发票（包括补充协议）。这样才能核对金额和日期（以原始回单为准）。最后说明缺件情况（注明责任人与补交节点）。";
function execution(stage, { l1 = false } = {}) {
  return {
    runnerId: l1 ? "exact-two-quality-gates-v3-model-router" : "exact-two-quality-gates-v1",
    provider: l1 ? "codex-model" : "openai-compatible",
    model: l1 ? "gpt-5.6-sol" : "claude-opus-4-8",
    sourcePromptHash: stage === "first-quality-gate" ? "first-prompt" : "second-prompt",
    renderedPromptHash: `${stage}-rendered`,
    rawResponsePath: `${stage}.json`,
    rawResponseHash: `${stage}-raw`,
    completedAt: new Date().toISOString(),
  };
}
const continuityAudit = {
  sentenceLinks: [
    { from: 1, to: 2, relation: "因果", reason: "第二句说明整理材料之后为什么要继续核对" },
    { from: 2, to: 3, relation: "任务收束", reason: "第三句把核对结果收束到缺件说明" },
  ],
  paragraphLinks: [],
  commaListFree: true,
  outsiderReadable: true,
  narrativeFlow: true,
  unexplainedProfessionalTerms: [],
};

test("workflow prevents stage skipping and permits finalization only after both gates", () => {
  const workflow = initializeProductionWorkflow({ packet: packet() });
  assert.throws(() => recordSecondLanguageGate(workflow, 1, { conclusion: "通过", modifiedQuestion: "题面" }), /not allowed/u);
  advanceToDraft(workflow);
  recordFirstQualityGate(workflow, 1, { preQaStructureAudit: { uniqueMainTask: true }, firstQaResult: { pass: true, issues: [], execution: execution("first-quality-gate") } });
  recordSecondLanguageGate(workflow, 1, { conclusion: "通过", modifiedQuestion: finalQuestion, continuityAudit, execution: execution("second-language-gate") });
  recordFinalRecord(workflow, 1, { recordUid: "沈礼_01", finalRecord: { 题目: finalQuestion, 产物格式: "docx, xlsx" } });
  assert.equal(workflow.questions[0].state, "COMPLETE");
  const trace = buildProductionTrace(workflow);
  assert.equal(trace.questions[0].firstQaFullResult.pass, true);
  assert.equal(trace.questions[0].secondQaFullResult.conclusion, "通过");
});

test("second gate cannot self-declare pass without the new punctuation and continuity evidence", () => {
  const workflow = initializeProductionWorkflow({ packet: packet() });
  advanceToDraft(workflow);
  recordFirstQualityGate(workflow, 1, { pass: true, issues: [], execution: execution("first-quality-gate") });
  assert.throws(
    () => recordSecondLanguageGate(workflow, 1, { conclusion: "通过", modifiedQuestion: finalQuestion, execution: execution("second-language-gate") }),
    /connected plain-narrative policy/u,
  );
});

test("two failed first-gate rounds force abandonment and resampling", () => {
  const workflow = initializeProductionWorkflow({ packet: packet() });
  advanceToDraft(workflow);
  recordFirstQualityGate(workflow, 1, { pass: false, issues: [{ rule: "附件支撑不足" }], execution: execution("first-quality-gate") });
  assert.equal(workflow.questions[0].state, "FIRST_QA_REPAIR_REQUIRED");
  recordAttachmentPlan(workflow, 1, plan);
  recordDraft(workflow, 1, {
    question: "返修题面",
    mainTask: "主任务",
    productFormats: "docx, xlsx",
    deliverableRationale: [
      { format: "docx", user: "项目负责人", purpose: "说明判断过程", whyThisFormat: "适合承载连续说明" },
      { format: "xlsx", user: "执行同事", purpose: "记录核对结果", whyThisFormat: "适合筛选和更新数据" },
    ],
  }, { reason: "补对象级材料" });
  recordFirstQualityGate(workflow, 1, { pass: false, issues: [{ rule: "信息支撑不足" }], execution: execution("first-quality-gate") });
  assert.equal(workflow.questions[0].state, "ABANDONED_RESAMPLE_REQUIRED");
  assert.throws(() => recordDraft(workflow, 1, { question: "再修", mainTask: "主任务" }), /not allowed/u);
});

test("attachment node rejects a rule page relabeled as specific evidence", () => {
  const workflow = initializeProductionWorkflow({ packet: packet() });
  recordReferenceBreakdown(workflow, 1, breakdown);
  assert.throws(() => recordAttachmentPlan(workflow, 1, {
    attachments: [{
      name: "行业管理办法.html",
      classification: "specific-business",
      objectLevel: true,
      timeAnchor: "2026年",
      specificityEvidence: { object: "行业", periodOrEvent: "2026年", uniqueContent: "通用规则" },
    }],
  }), /specific-evidence policy/u);
});

test("L1 workflow rejects zero attachments but permits an empty product format with L2-grade evidence", () => {
  const l1Packet = {
    ...packet(),
    kind: "l1-production-input-packet",
    productionProfile: "l1",
  };
  const workflow = initializeProductionWorkflow({ packet: l1Packet });
  recordReferenceBreakdown(workflow, 1, breakdown);
  assert.throws(() => recordAttachmentPlan(workflow, 1, {
    attachments: [],
    newAttachmentSupport: "本题只使用公开官方来源，不设置文件附件",
    newQuestionStructureMapping: "保留证据核验和唯一判断结构",
  }), /1–3 attachments/u);
  recordAttachmentPlan(workflow, 1, plan);
  recordDraft(workflow, 1, {
    question: "请核验公开资料并形成初步判断，无法确认的信息单独列出。",
    mainTask: "核验资料并形成初步判断",
    productFormats: "",
    deliverableRationale: [],
  });
  recordFirstQualityGate(workflow, 1, { pass: true, issues: [], execution: execution("first-quality-gate", { l1: true }) });
  const l1Question = "我负责一个试点方案的入口评估，现有公开资料对权限和数据边界的说明并不完整。请核验官方文档，比较三个入口能够承担的范围，并把事实、合理推断和待确认项分开；这一轮先形成证据清单，不提前给最终上线结论。";
  recordSecondLanguageGate(workflow, 1, {
    conclusion: "通过",
    modifiedQuestion: l1Question,
    execution: execution("second-language-gate", { l1: true }),
  });
  recordDeAiRewrite(workflow, 1, deAiResult(l1Question));
  recordFinalRecord(workflow, 1, {
    recordUid: "沈礼_L1_01",
    finalRecord: { 题目: l1Question, 产物格式: "" },
  });
  const trace = buildProductionTrace(workflow);
  assert.equal(trace.kind, "l1-production-trace");
  assert.equal(trace.questions[0].attachmentBuild.attachments.length, 1);
  assert.equal(trace.questions[0].draftedProductFormats, "");
});

test("L1 rejects legacy quality providers even when their receipt shape is valid", () => {
  const l1Packet = {
    ...packet(),
    kind: "l1-production-input-packet",
    productionProfile: "l1",
  };
  const workflow = initializeProductionWorkflow({ packet: l1Packet });
  advanceToDraft(workflow);
  assert.throws(
    () => recordFirstQualityGate(workflow, 1, { pass: true, issues: [], execution: execution("first-quality-gate") }),
    /L1 production model router/u,
  );
});
