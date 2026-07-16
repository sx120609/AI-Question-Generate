import assert from "node:assert/strict";
import test from "node:test";

import {
  initializeProductionWorkflow,
  recordReferenceBreakdown,
  recordAttachmentPlan,
  recordDraft,
  recordFirstQualityGate,
  recordSecondLanguageGate,
  recordFinalRecord,
  buildProductionTrace,
} from "./production_workflow_state.mjs";

function packet(count = 1) {
  return {
    kind: "l2-production-input-packet", status: "READY", protocolId: "p", runId: "r",
    inputs: { referenceWorkbook: { samples: Array.from({ length: count }, (_, index) => ({
      questionIndex: index + 1, sheet: "Sheet1", row: index + 2, questionHash: `q${index}`, attachmentSummaryHash: `a${index}`,
    })) } },
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

const finalQuestion = "先整理合同、发票等材料。这样才能核对金额、日期等信息。最后说明缺件等情况。";
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
  recordFirstQualityGate(workflow, 1, { preQaStructureAudit: { uniqueMainTask: true }, firstQaResult: { pass: true, issues: [] } });
  recordSecondLanguageGate(workflow, 1, { conclusion: "通过", modifiedQuestion: finalQuestion, continuityAudit });
  recordFinalRecord(workflow, 1, { recordUid: "沈礼_01", finalRecord: { 题目: finalQuestion, 产物格式: "docx, xlsx" } });
  assert.equal(workflow.questions[0].state, "COMPLETE");
  const trace = buildProductionTrace(workflow);
  assert.equal(trace.questions[0].firstQaFullResult.pass, true);
  assert.equal(trace.questions[0].secondQaFullResult.conclusion, "通过");
});

test("second gate cannot self-declare pass without the new punctuation and continuity evidence", () => {
  const workflow = initializeProductionWorkflow({ packet: packet() });
  advanceToDraft(workflow);
  recordFirstQualityGate(workflow, 1, { pass: true, issues: [] });
  assert.throws(
    () => recordSecondLanguageGate(workflow, 1, { conclusion: "通过", modifiedQuestion: "合同、发票、回单都要核对。" }),
    /connected plain-narrative policy/u,
  );
});

test("two failed first-gate rounds force abandonment and resampling", () => {
  const workflow = initializeProductionWorkflow({ packet: packet() });
  advanceToDraft(workflow);
  recordFirstQualityGate(workflow, 1, { pass: false, issues: [{ rule: "附件支撑不足" }] });
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
  recordFirstQualityGate(workflow, 1, { pass: false, issues: [{ rule: "信息支撑不足" }] });
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
