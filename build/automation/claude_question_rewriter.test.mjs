import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeRewriteMessages,
  buildClaudeQuestionOnlyMessages,
  measureQuestionSimilarity,
  parseClaudeRewriteResponse,
  rewriteQuestionWithDeAiApi,
  synthesizeRewriteSidecars,
  validateClaudeRewrite,
} from "./claude_question_rewriter.mjs";

function input() {
  return {
    uid: "1",
    record: {
      UID: "1",
      题目: "原始题面是项目试点材料核对任务。",
      任务概括: "主任务",
      附件内容: "附件边界",
      产物格式: "docx, xlsx",
      产物内容: "Word 和 Excel 的内容",
      做题关键步骤: "1. 核对\n2. 判断",
    },
    sceneCard: {
      requester: { functionalRole: "项目负责人" },
      scene: { mainDecision: "是否进入试点" },
      informationBoundary: { knownFactIds: ["F1"] },
      voice: { channel: "工作消息" },
    },
    requestContract: { requestSpan: "原请求" },
    roleTrace: { blockageSpan: "原卡点" },
    knownFactIds: ["F1"],
  };
}

test("builds a from-scratch request without leaking the old question or sidecar wording", () => {
  const messages = buildClaudeRewriteMessages(input());
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /从空白页/u);
  assert.match(messages[0].content, /不得增加或改变/u);
  assert.doesNotMatch(messages[1].content, /原始题面/u);
  assert.doesNotMatch(messages[1].content, /原请求|原卡点/u);
  assert.match(messages[1].content, /docx, xlsx/u);
});

test("measures copied wording as highly similar", () => {
  const similarity = measureQuestionSimilarity(
    "设备证书轮换前需要核对证书状态，确认失败后退回旧证书。",
    "设备证书轮换前需要核对证书状态，确认失败后退回原有证书。",
  );
  assert.ok(similarity.editSimilarity > 0.8);
  assert.ok(similarity.trigramJaccard > 0.7);
  assert.ok(similarity.longestExactCopyRun >= 20);
  assert.ok(similarity.longestExactCopySpan.length >= 20);
});

test("distinguishes a genuinely reconstructed request", () => {
  const similarity = measureQuestionSimilarity(
    "值班同事拿到清单后先查设备能否回连，试点失败就恢复原配置并停止扩批。",
    "请整理设备证书信息并制作一份轮换方案，内容包括证书状态和操作步骤。",
  );
  assert.ok(similarity.editSimilarity < 0.5);
  assert.ok(similarity.trigramJaccard < 0.3);
});

test("question-only prompt excludes the old question and machine-derived delivery prose", () => {
  const messages = buildClaudeQuestionOnlyMessages(input());
  const serialized = JSON.stringify(messages);
  assert.doesNotMatch(serialized, /原始题面|Word 和 Excel 的内容|1\. 核对/u);
  assert.doesNotMatch(serialized, /至少三个|娓娓道来|熟悉业务的人/u);
  assert.match(serialized, /不是角色扮演者|克制/u);
  assert.match(serialized, /主任务|附件边界|docx, xlsx/u);
});

test("L1 rewrite prompts keep the attachment upgrade separate from visible question density", () => {
  const value = input();
  value.record.任务类型 = "L1 探索型";
  value.record.产物格式 = "";
  const messages = buildClaudeQuestionOnlyMessages(value);
  const serialized = JSON.stringify(messages);
  assert.match(serialized, /L1 探索型/u);
  assert.match(serialized, /一个主要判断/u);
  assert.match(serialized, /硬上限为700个可见字符/u);
  assert.doesNotMatch(serialized, /900至1100/u);
});

test("blocks an overloaded L1 source before calling the de-AI API", async () => {
  let called = false;
  const value = input();
  value.record.任务类型 = "L1 探索型";
  value.record.产物格式 = "";
  value.record.题目 = Array.from({ length: 30 }, (_, index) => `配置${index + 1}为${index + 100}台。`).join("");
  await assert.rejects(
    rewriteQuestionWithDeAiApi({
      input: value,
      apiKey: "test-key",
      fetchImpl: async () => {
        called = true;
        throw new Error("must not call");
      },
    }),
    /must return to generation/u,
  );
  assert.equal(called, false);
});

test("synthesizes validation sidecars from a generated request sentence", () => {
  const question = "当前清单还没齐，需要把公开规则和现场数据分开。你帮我做一份 Word 说明和 Excel 台账，值班团队会据此验证并留痕。验证失败就退回原状态，结果交给运维同事继续处理。";
  const rewrite = synthesizeRewriteSidecars({
    question,
    record: input().record,
    sceneCard: input().sceneCard,
    knownFactIds: ["F1"],
  });
  assert.equal(rewrite.requestContract.requestSpan.includes("Word"), true);
  assert.deepEqual(rewrite.requestContract.outputs.map((item) => item.format), ["docx", "xlsx"]);
  assert.equal(rewrite.flowStages.length, 4);
});

test("synthesizes one exact request span across adjacent output sentences", () => {
  const question = "当前材料还不足以判断是否可以启动。请整理一份 Word 说明供团队评审。另做一张 Excel 台账记录验证证据。验证失败时退回原入口。";
  const rewrite = synthesizeRewriteSidecars({
    question,
    record: input().record,
    sceneCard: input().sceneCard,
    knownFactIds: ["F1"],
  });
  assert.match(rewrite.requestContract.requestSpan, /Word[\s\S]*Excel/u);
  assert.equal(question.includes(rewrite.requestContract.requestSpan), true);
});

test("parses a fenced strict JSON response", () => {
  const parsed = parseClaudeRewriteResponse('```json\n{"question":"改写题面"}\n```');
  assert.equal(parsed.question, "改写题面");
});

test("ignores a model preamble before the JSON object", () => {
  const parsed = parseClaudeRewriteResponse('I reviewed the constraints.\n{"question":"改写题面"}');
  assert.equal(parsed.question, "改写题面");
});

test("routes the B-column text through Mugua Gemini de-AI rewriting", async () => {
  let requestBody;
  let authorization;
  const result = await rewriteQuestionWithDeAiApi({
    input: input(),
    apiKey: "test-key",
    baseUrl: "https://api.mugua.link/v1",
    model: "gemini-3.1-pro-preview",
    retries: 0,
    contentAttempts: 1,
    fetchImpl: async (url, options) => {
      requestBody = JSON.parse(options.body);
      authorization = options.headers.Authorization;
      assert.equal(url, "https://api.mugua.link/v1/chat/completions");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: "gemini-3.1-pro-preview",
          choices: [{
            message: { content: '{"question":"当前材料还没齐，需要把公开规则和现场数据分开。你帮我做一份 Word 说明和 Excel 台账，值班团队会据此验证并留痕。验证失败就退回原状态，结果交给运维同事继续处理。"}' },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
        }),
      };
    },
  });

  assert.equal(requestBody.model, "gemini-3.1-pro-preview");
  assert.equal(requestBody.messages.at(-1).content.includes("原始题面"), true);
  assert.equal(authorization, "Bearer test-key");
  assert.equal(result.kind, "de-ai-question-rewrite");
  assert.equal(result.provider, "mugua-openai-compatible");
  assert.equal(result.attempts.length, 1);
  assert.match(result.rewrite.question, /Word 说明和 Excel 台账/u);
  assert.equal(result.rewrite.requestContract.outputs.length, 2);
});

test("retries content failures and keeps the safest diagnostic candidate", async () => {
  const responses = [
    "当前项目先做 6 份材料，整理后给团队一份 Word 说明和 Excel 台账。",
    "当前材料还没齐，需要把公开规则和现场数据分开。你帮我做一份 Word 说明和 Excel 台账，值班团队会据此验证并留痕。验证失败就退回原状态，结果交给运维同事继续处理。",
  ];
  let calls = 0;
  const result = await rewriteQuestionWithDeAiApi({
    input: input(),
    apiKey: "test-key",
    contentAttempts: 2,
    retries: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: JSON.stringify({ question: responses[calls++] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
      }),
    }),
  });

  assert.equal(calls, 2);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.selectedAttempt, 2);
  assert.equal(result.validation.findings.some((finding) => finding.rule === "unsupported-fact-anchor"), false);
});

test("L1 de-AI validation accepts a shorter rewrite with no product-format label", () => {
  const record = {
    ...input().record,
    题目: "原始L1题面只作为改写来源。",
    任务类型: "L1 探索型",
    产物格式: "",
    产物内容: "一份证据清单",
  };
  const question = "我负责客服AI试点入口评估，现有公开资料对权限和数据边界的说明不一致。请核验三家产品的官方资料，整理一份证据清单，把已证实事实、合理推断和待确认项分开。附件里还包含当前试点对象和权限说明，请一并确认材料是否足以支持下一步评估。这一轮先不下最终上线结论，结果交给项目团队继续复核。";
  const sceneCard = structuredClone(input().sceneCard);
  sceneCard.scene.downstreamUse = "交给项目团队继续复核";
  const rewrite = synthesizeRewriteSidecars({
    question,
    record,
    sceneCard,
    knownFactIds: ["F1"],
  });
  const result = validateClaudeRewrite({
    sourceRecord: record,
    rewrite,
    sceneCard,
    knownFactIds: ["F1"],
  });
  assert.equal(result.pass, true, JSON.stringify(result.findings, null, 2));
  assert.equal(rewrite.requestContract.outputs.length, 0);
});

test("L1 validation accepts the 2026-07-17 naturalness baseline", () => {
  const question = `我们准备把跨地区员工培训改成常态化直播，考虑到部分同事需要用到实时字幕、屏幕阅读器或者键盘操作，得先摸底一下腾讯会议、钉钉和飞书这三个平台的无障碍支持情况。麻烦你根据截至2026年7月17日能访问的官方产品文档和帮助页面，整理一份Excel对比表。

表里需要详细核对这三家在实时字幕、翻译字幕、屏幕阅读器支持以及键盘与焦点操作兼容性上的表现。录制和转录的留存机制要单独说明，同时把主持人和管理员的具体控制权限理清楚。记得给表里的每一项判断都标上来源链接和具体的访问日期。如果官方公开页面没写清楚套餐限制、字幕支持的语言范围或者导出权限，直接留白就行，不要自己推测。至于保存期限和直播规模限制，统一列成待确认事项，并在旁边写明后续需要通过什么实测或询价方式来补充确认。

在表格最后，请根据对比结果推荐一个最适合优先进入POC阶段的平台并给出理由，顺便说明另外两家暂缓推进是因为存在哪些证据缺口。这次的评估结论只是用来安排下一阶段的实测，不作为最终的采购和合规决策。`;
  const record = {
    ...input().record,
    题目: "原始L1题面只作为改写来源。",
    任务概括: question,
    任务类型: "L1 探索型",
    产物格式: "xlsx",
    产物内容: "三家平台无障碍支持情况的Excel对比表",
  };
  const sceneCard = structuredClone(input().sceneCard);
  sceneCard.scene.downstreamUse = "安排下一阶段的平台实测";
  const rewrite = synthesizeRewriteSidecars({
    question,
    record,
    sceneCard,
    knownFactIds: ["F1"],
  });
  const result = validateClaudeRewrite({
    sourceRecord: record,
    rewrite,
    sceneCard,
    knownFactIds: ["F1"],
  });
  assert.equal(result.pass, true, JSON.stringify(result.findings, null, 2));
  assert.deepEqual(rewrite.requestContract.outputs.map((item) => item.format), ["xlsx"]);
});
