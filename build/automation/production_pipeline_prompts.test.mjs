import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReferenceBreakdownPrompt,
  buildQuestionDraftPrompt,
  buildFirstQualityGatePrompt,
  buildSecondLanguageGatePrompt,
  buildFinalCompilerPrompt,
  parseFirstQualityGateResponse,
  parseSecondLanguageGateResponse,
} from "./production_pipeline_prompts.mjs";

function packet() {
  return {
    kind: "l2-production-input-packet",
    status: "READY",
    inputs: {
      referenceWorkbook: { samples: [{ questionIndex: 1, sheet: "Sheet1", row: 9, question: "参考题面原文", attachmentSummary: "参考附件概括", questionHash: "q", attachmentSummaryHash: "a" }] },
      firstQaPrompt: { text: "原版第一道质检全文-唯一标识", sha256: "first" },
      secondQaPrompt: { text: "原版第二道质检全文-唯一标识", sha256: "second" },
    },
  };
}

test("reference breakdown is bound to the sampled question and only its two approved fields", () => {
  const result = buildReferenceBreakdownPrompt({ packet: packet(), questionIndex: 1 });
  assert.equal(result.stage, "reference-breakdown");
  assert.match(result.prompt, /参考题面原文/u);
  assert.match(result.prompt, /参考附件概括/u);
  assert.equal(result.bindings.row, 9);
});

test("first quality gate embeds the exact source prompt and keeps structure audit separate", () => {
  const result = buildFirstQualityGatePrompt({
    packet: packet(), questionIndex: 1,
    candidate: { question: "待检题面", mainTask: "唯一主任务" },
    attachmentPlan: { attachments: [{ name: "a.pdf" }] },
    referenceBreakdown: { mainTask: "结构主任务" },
  });
  assert.match(result.prompt, /原版第一道质检全文-唯一标识/u);
  assert.match(result.prompt, /只返回包含pass和issues的JSON/u);
  assert.match(result.preQaPrompt, /不决定原版第一道质检的pass/u);
  assert.equal(result.bindings.qaPromptHash, "first");
});

test("draft node receives the structure card but not the sampled question text", () => {
  const result = buildQuestionDraftPrompt({
    packet: packet(),
    questionIndex: 1,
    referenceBreakdown: { mainTask: "结构主任务" },
    attachmentPlan: { attachments: [{ name: "对象记录.xlsx" }] },
    factLedger: { facts: [{ id: "F1", value: "事实" }] },
    sceneCard: { requester: "项目负责人" },
  });
  assert.doesNotMatch(result.prompt, /参考题面原文/u);
  assert.match(result.prompt, /生成节点不得再读取抽样题面原文/u);
  assert.match(result.prompt, /不能默认写成Word加Excel/u);
});

test("gate response parsers preserve the two source formats", () => {
  assert.deepEqual(parseFirstQualityGateResponse('```json\n{"pass":true,"issues":[]}\n```'), { pass: true, issues: [] });
  const second = parseSecondLanguageGateResponse(`【第二道质检结论】\n通过\n【核心判断】\n自然\n【主要修改点】\n无\n【修改后题面】\n完整题面\n【标点与括号自检】\n均通过\n【叙事承接自检】\n{"sentenceLinks":[],"paragraphLinks":[],"commaListFree":true,"outsiderReadable":true,"narrativeFlow":true,"unexplainedProfessionalTerms":[]}\n【仍需注意】\n可进入最终出题表`);
  assert.equal(second.conclusion, "通过");
  assert.equal(second.modifiedQuestion, "完整题面");
  assert.equal(second.continuityAudit.narrativeFlow, true);
});

test("second gate cannot run before a clean first-gate pass", () => {
  assert.throws(() => buildSecondLanguageGatePrompt({
    packet: packet(), questionIndex: 1,
    firstQaResult: { pass: false, issues: [{}] },
    candidate: { question: "待检题面" },
    referenceBreakdown: { referenceProductParagraphLogic: "后半段逻辑" },
  }), /blocked/u);
  const result = buildSecondLanguageGatePrompt({
    packet: packet(), questionIndex: 1,
    firstQaResult: { pass: true, issues: [] },
    candidate: { question: "待检题面" },
    referenceBreakdown: { referenceProductParagraphLogic: "后半段逻辑" },
  });
  assert.match(result.prompt, /原版第二道质检全文-唯一标识/u);
  assert.match(result.prompt, /后半段逻辑/u);
  assert.match(result.prompt, /一句话最多一个顿号/u);
  assert.match(result.prompt, /娓娓道来/u);
});

test("final compiler freezes the second-gate question and normalizes file format labels", () => {
  const result = buildFinalCompilerPrompt({
    packet: packet(), questionIndex: 1,
    secondQaResult: { conclusion: "通过", modifiedQuestion: "最终题面" },
    attachmentPlan: { attachments: [{ name: "a.pdf" }] },
    metadata: { formats: ["docx", "xlsx"] },
  });
  assert.match(result.prompt, /必须逐字冻结/u);
  assert.match(result.prompt, /最终题面/u);
  assert.match(result.prompt, /Word文档（docx）/u);
});
