import assert from "node:assert/strict";
import test from "node:test";

import {
  SITUATED_GENERATION_PROMPT_VERSION,
  buildFieldCompilerPrompt,
  buildOutOfCharacterAuditPrompt,
  buildRequesterPrompt,
  buildSceneCardPrompt,
  buildSituatedPrompt,
} from "./situated_generation.mjs";

const topic = {
  topicId: "topic-1",
  role: "采购经办人",
  businessScenario: "设备到货后核对付款条件",
  mainDecision: "当前能否进入技术验收",
};
const factLedger = {
  facts: [{ id: "f1", text: "设备已经到货" }],
  unknowns: [{ id: "u1", text: "原始测试数据尚未取得" }],
};
const sceneCard = {
  schemaVersion: 1,
  policyId: "situated-requester-v1",
  topicId: "topic-1",
  personaId: "topic-1-requester",
};
const candidate = {
  question: "设备已经到了，但原始测试数据还没拿到，你帮我先做一份Word说明和一张Excel工作簿，给主任判断现在能签到哪一步。",
  requestContract: {
    requestSpan: "你帮我先做一份Word说明和一张Excel工作簿",
    action: "做",
    outputs: [
      { format: "docx", humanName: "Word", purpose: "说明当前可签范围" },
      { format: "xlsx", humanName: "Excel", purpose: "记录核对结果" },
    ],
  },
};

test("scene-card prompt builds a hidden finite-view requester instead of a story writer", () => {
  const result = buildSceneCardPrompt({ topic, factLedger });
  assert.equal(result.promptVersion, SITUATED_GENERATION_PROMPT_VERSION);
  assert.equal(result.stage, "scene-card");
  assert.match(result.prompt, /不是故事编写者/);
  assert.match(result.prompt, /不能创造事实/);
  assert.match(result.prompt, /沈礼和裴硬是系统标注身份/);
  assert.match(result.prompt, /informationBoundary/);
});

test("requester prompt produces multiple raw-message candidates and verifiable sidecars", () => {
  const result = buildRequesterPrompt({ sceneCard, factLedger, productFormats: "docx, xlsx" });
  assert.equal(result.stage, "requester");
  assert.match(result.prompt, /分别生成 3 条完整候选/);
  assert.match(result.prompt, /candidateId/);
  assert.match(result.prompt, /requestSpan/);
  assert.match(result.prompt, /roleTrace/);
  assert.match(result.prompt, /不是出题员/);
  assert.doesNotMatch(result.prompt, /轮换固定开头.*要求/u);
});

test("field compiler freezes B and only compiles remaining fields", () => {
  const result = buildFieldCompilerPrompt({ selectedCandidate: candidate, sceneCard, factLedger, outputColumns: ["任务概括", "产物内容"] });
  assert.equal(result.stage, "field-compiler");
  assert.match(result.prompt, /question 已由真实请求者视角选定并冻结/);
  assert.match(result.prompt, /禁止润色、扩写、缩写、换标点/);
  assert.match(result.prompt, /不能自行重写B列/);
});

test("out-of-character audit checks role swaps, masked author voice and dramatic invention", () => {
  const result = buildOutOfCharacterAuditPrompt({ candidate, sceneCard, factLedger, productFormats: "docx, xlsx" });
  assert.equal(result.stage, "audit");
  assert.match(result.prompt, /角色只是贴纸/);
  assert.match(result.prompt, /删除行业、组织、产品和角色专名/);
  assert.match(result.prompt, /戏剧化/);
  assert.match(result.prompt, /不提供替换文案/);
});

test("generic builder validates stages and requester candidate count", () => {
  assert.equal(buildSituatedPrompt("scene-card", { topic, factLedger }).stage, "scene-card");
  assert.throws(() => buildSituatedPrompt("unknown", {}), /Unsupported/);
  assert.throws(
    () => buildRequesterPrompt({ sceneCard, factLedger, productFormats: "docx", candidateCount: 1 }),
    /between 2 and 6/,
  );
});
