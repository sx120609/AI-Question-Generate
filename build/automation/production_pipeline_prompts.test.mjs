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
  const second = parseSecondLanguageGateResponse(`【第二道质检结论】\n通过\n【核心判断】\n自然\n【主要修改点】\n无\n【修改后题面】\n完整题面\n【标点与括号自检】\n均通过\n【仍需注意】\n可进入最终出题表`);
  assert.equal(second.conclusion, "通过");
  assert.equal(second.modifiedQuestion, "完整题面");
  assert.equal(second.remainingNote, "可进入最终出题表");
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
  assert.match(result.prompt, /必须完整执行上面的原版第二道质检提示词/u);
  assert.match(result.prompt, /不得用其他标点配额、语言规则或本地模板覆盖/u);
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

test("L1 prompts inherit the L2 attachment hard standard while keeping staged interaction and optional product format", () => {
  const l1Packet = {
    ...packet(),
    kind: "l1-production-input-packet",
    productionProfile: "l1",
  };
  const attachmentPrompt = buildQuestionDraftPrompt({
    packet: l1Packet,
    questionIndex: 1,
    referenceBreakdown: { mainTask: "结构主任务" },
    attachmentPlan: { attachments: [{ name: "对象记录.xlsx", classification: "specific-business" }] },
    factLedger: { facts: [{ id: "F1", value: "事实" }] },
    sceneCard: { requester: "方案负责人" },
  });
  assert.equal(attachmentPrompt.kind, "l1-production-pipeline-prompt");
  assert.match(attachmentPrompt.prompt, /数量限定为1—3个/u);
  assert.match(attachmentPrompt.prompt, /推荐1—2个核心文件/u);
  assert.match(attachmentPrompt.prompt, /具体业务文件占比至少80%/u);
  assert.match(attachmentPrompt.prompt, /对象级证据/u);
  assert.match(attachmentPrompt.prompt, /多轮交互的第一轮/u);
  assert.match(attachmentPrompt.prompt, /L2标准不提高L1题面的篇幅/u);
  assert.match(attachmentPrompt.prompt, /围绕一个当前判断展开/u);
  assert.match(attachmentPrompt.prompt, /多个核验维度可以共同服务它/u);
  assert.match(attachmentPrompt.prompt, /只能作为附带交付动作/u);
  assert.match(attachmentPrompt.prompt, /deferredToLaterRounds/u);
  assert.match(attachmentPrompt.prompt, /可为空字符串/u);
  assert.match(attachmentPrompt.prompt, /必须先读取并核验真实附件/u);
  assert.match(attachmentPrompt.prompt, /只有行业相同、标题相关或关键词相近不构成支撑/u);
  assert.match(attachmentPrompt.prompt, /一级目录不是自由生成字段/u);
  assert.match(attachmentPrompt.prompt, /法律、政务与公共服务/u);

  const finalPrompt = buildFinalCompilerPrompt({
    packet: l1Packet,
    questionIndex: 1,
    secondQaResult: { conclusion: "通过", modifiedQuestion: "最终题面" },
    attachmentPlan: { attachments: [{ name: "对象记录.xlsx", classification: "specific-business" }] },
    metadata: { productContent: "证据清单" },
  });
  assert.match(finalPrompt.prompt, /"任务类型": "L1 探索型"/u);
  assert.match(finalPrompt.prompt, /产物格式可以留空/u);
  assert.match(finalPrompt.prompt, /只能根据附件实际内容/u);
});
