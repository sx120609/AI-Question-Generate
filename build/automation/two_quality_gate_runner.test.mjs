import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runFirstQualityGateWithModel,
  runSecondLanguageGateWithModel,
} from "./two_quality_gate_runner.mjs";

function chatResponse(content) {
  return new Response(JSON.stringify({
    id: "test-completion",
    model: "claude-opus-4-8",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function responsesResponse(content) {
  return new Response(JSON.stringify({
    id: "test-response",
    model: "gpt-5.6-sol",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: content }] }],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function packet() {
  return {
    kind: "l2-production-input-packet",
    status: "READY",
    inputs: {
      referenceWorkbook: { samples: [{ questionIndex: 1, sheet: "Sheet1", row: 9 }] },
      firstQaPrompt: { path: "first.txt", sha256: "first-prompt", text: "第一道完整提示词" },
      secondQaPrompt: { path: "second.txt", sha256: "second-prompt", text: "第二道完整提示词" },
    },
  };
}

test("runs both exact prompts through the model and writes bound raw responses", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "two-quality-gates-"));
  const finalQuestion = "先核对合同（包括补充协议）。再核对回单（以原件为准）。结果写入交接表（注明责任人）。";
  const outputs = [
    '{"pass":true,"issues":[]}',
    `【第二道质检结论】\n通过\n【核心判断】\n语言自然\n【主要修改点】\n重组句子推进\n【修改后题面】\n${finalQuestion}\n【标点与括号自检】\n全部符合\n【仍需注意】\n可进入最终出题表`,
    JSON.stringify({
      sentenceLinks: [
        { from: 1, to: 2, relation: "递进", reason: "第二句沿着第一句的核对工作继续检查回单" },
        { from: 2, to: 3, relation: "任务收束", reason: "第三句把前面的核对结果收束到交接表" },
      ],
      paragraphLinks: [],
      commaListFree: true,
      outsiderReadable: true,
      narrativeFlow: true,
      unexplainedProfessionalTerms: [],
    }),
  ];
  const seenBodies = [];
  const fetchImpl = async (_url, init) => {
    seenBodies.push(JSON.parse(init.body));
    return chatResponse(outputs.shift());
  };
  const common = {
    packet: packet(),
    questionIndex: 1,
    candidate: { question: "项目交接前需要核对合同和回单，并把结果整理到团队交接表。" },
    referenceBreakdown: { mainTask: "主任务", referenceProductParagraphLogic: "按真实使用者收束" },
    outDir,
    provider: "third-party",
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "claude-opus-4-8",
    stream: false,
    fetchImpl,
  };
  const first = await runFirstQualityGateWithModel({
    ...common,
    attachmentPlan: { attachments: [{ name: "合同.xlsx" }] },
  });
  assert.equal(first.pass, true);
  assert.equal(first.execution.sourcePromptHash, "first-prompt");
  const second = await runSecondLanguageGateWithModel({ ...common, firstQaResult: first });
  assert.equal(second.conclusion, "通过");
  assert.equal(second.modifiedQuestion, finalQuestion);
  assert.equal(second.execution.sourcePromptHash, "second-prompt");
  assert.equal(seenBodies.length, 3);
  assert.match(seenBodies[0].messages[1].content, /第一道完整提示词/u);
  assert.match(seenBodies[1].messages[1].content, /第二道完整提示词/u);
  await fs.access(first.execution.rawResponsePath);
  await fs.access(second.execution.rawResponsePath);
});

test("L1 quality gates default to the Codex model without the L2 continuity-audit call", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-two-quality-gates-"));
  const l1Packet = {
    ...packet(),
    kind: "l1-production-input-packet",
    productionProfile: "l1",
  };
  const finalQuestion = "我负责客服AI试点入口评估。请核验三家产品的官方资料，整理一份证据清单，把已证实事实、合理推断和待确认项分开。这一轮先不下最终上线结论。";
  const outputs = [
    '{"pass":true,"issues":[]}',
    `【第二道质检结论】\n通过\n【核心判断】\n表达清楚\n【主要修改点】\n无\n【修改后题面】\n${finalQuestion}\n【标点与括号自检】\n自然且无强制括号\n【仍需注意】\n保留本轮边界`,
  ];
  let calls = 0;
  const seenBodies = [];
  const fetchImpl = async (_url, init) => {
    calls += 1;
    seenBodies.push(JSON.parse(init.body));
    return responsesResponse(outputs.shift());
  };
  const common = {
    packet: l1Packet,
    questionIndex: 1,
    candidate: { question: finalQuestion },
    referenceBreakdown: { mainTask: "主任务", referenceProductParagraphLogic: "按当前轮次收束" },
    outDir,
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "gpt-5.6-sol",
    stream: false,
    fetchImpl,
  };
  const first = await runFirstQualityGateWithModel({ ...common, attachmentPlan: { attachments: [] } });
  const second = await runSecondLanguageGateWithModel({ ...common, firstQaResult: first });
  assert.equal(second.conclusion, "通过");
  assert.equal(second.continuityAudit, null);
  assert.equal(second.execution.continuityResponseHash, "");
  assert.equal(first.execution.provider, "codex-model");
  assert.equal(second.execution.provider, "codex-model");
  assert.equal(seenBodies[0].model, "gpt-5.6-sol");
  assert.equal(seenBodies[0].reasoning.effort, "high");
  assert.equal("messages" in seenBodies[0], false);
  assert.equal(calls, 2);
});
