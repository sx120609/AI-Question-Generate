import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMuguaDeAiMessages,
  loadMuguaDeAiPrompt,
  MUGUA_DE_AI_REWRITE_DEFAULTS,
  parseMuguaDeAiResponse,
  rewriteMuguaDeAiText,
} from "./mugua_de_ai_rewrite_client.mjs";

test("keeps the shared L1 de-AI prompt scene-neutral and repair-aware", async () => {
  const prompt = await loadMuguaDeAiPrompt();
  assert.match(prompt, /与原题大体相当，不套固定字数模板/u);
  assert.match(prompt, /多个核验维度可以共同服务同一个判断/u);
  assert.match(prompt, /“请”“帮我”“麻烦你”可按语境自然使用/u);
  assert.match(prompt, /顿号密度只作可读性建议/u);
  assert.match(prompt, /“在表格最后”“最后一列”/u);
  assert.match(prompt, /删除“刚传了”/u);
  assert.doesNotMatch(prompt, /设备预验收题|包1表达|满一年后的5%余款/u);
});

test("defaults all new de-AI runs to Gemini 3.1 Pro", () => {
  assert.equal(MUGUA_DE_AI_REWRITE_DEFAULTS.model, "gemini-3.1-pro-preview");
});

test("builds a prompt-bound request containing only the current question", () => {
  const messages = buildMuguaDeAiMessages({ text: "原题", promptText: "改写规则" });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, "改写规则");
  assert.match(messages[1].content, /原题/u);
  assert.doesNotMatch(messages[1].content, /附件内容|事实账本|角色卡/u);
});

test("parses strict or fenced JSON and rejects prose", () => {
  assert.equal(parseMuguaDeAiResponse('{"question":"新题"}'), "新题");
  assert.equal(parseMuguaDeAiResponse('```json\n{"question":"围栏题面"}\n```'), "围栏题面");
  assert.throws(() => parseMuguaDeAiResponse("这是改写结果"), /JSON/u);
});

test("calls Mugua chat completions without returning the credential", async () => {
  let captured;
  const result = await rewriteMuguaDeAiText({
    text: "整理公司门店库存记录并形成运营复核表。",
    apiKey: "secret-value",
    baseUrl: "https://api.mugua.link/v1",
    model: "gemini-3.1-pro-preview",
    promptText: "只输出严格 JSON",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: '{"question":"整理各门店库存记录，核对差异后形成运营复核表。"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(captured.url, "https://api.mugua.link/v1/chat/completions");
  assert.equal(captured.init.headers.Authorization, "Bearer secret-value");
  assert.equal(result.text, "整理各门店库存记录，核对差异后形成运营复核表。");
  assert.equal(result.model, "gemini-3.1-pro-preview");
  assert.ok(result.promptHash);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/u);
});

test("blocks a foreign-platform rewrite before it can continue", async () => {
  await assert.rejects(
    rewriteMuguaDeAiText({
      text: "整理公司会议平台采购评估并形成试点建议。",
      apiKey: "secret-value",
      promptText: "只输出严格 JSON",
      fetchImpl: async () => new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: '{"question":"比较 Zoom 和 Google Meet，形成采购建议。"}' } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    }),
    (error) => error.code === "CONTENT_SCOPE_BLOCKED" && error.issues.includes("foreign-platform"),
  );
});
