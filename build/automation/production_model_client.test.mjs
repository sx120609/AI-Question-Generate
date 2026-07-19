import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_MODEL_PROVIDER,
  completeProductionPrompt,
  normalizeProductionModelProvider,
  THIRD_PARTY_MODEL_PROVIDER,
} from "./production_model_client.mjs";

test("Codex model is the default and third-party selection is explicit", () => {
  assert.equal(normalizeProductionModelProvider(), CODEX_MODEL_PROVIDER);
  assert.equal(normalizeProductionModelProvider("third-party"), THIRD_PARTY_MODEL_PROVIDER);
  assert.throws(() => normalizeProductionModelProvider("rewrite-api"), /Unsupported production model provider/u);
});

test("default production completion uses the Responses API", async () => {
  let captured;
  const result = await completeProductionPrompt({
    apiKey: "codex-key",
    baseUrl: "https://api.openai.com",
    model: "gpt-5.6-sol",
    systemPrompt: "系统",
    userPrompt: "用户",
    retries: 0,
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "resp_2",
        model: "gpt-5.6-sol",
        status: "completed",
        output_text: "完成",
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.body.model, "gpt-5.6-sol");
  assert.equal(result.provider, CODEX_MODEL_PROVIDER);
});

test("third-party compatibility route requires an explicit provider and settings", async () => {
  let captured;
  const result = await completeProductionPrompt({
    provider: "third-party",
    apiKey: "third-party-key",
    baseUrl: "https://compatible.example/v1",
    model: "provider-model",
    systemPrompt: "系统",
    userPrompt: "用户",
    stream: false,
    retries: 0,
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "chat_2",
        model: "provider-model",
        choices: [{ message: { content: "完成" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(captured.url, "https://compatible.example/v1/chat/completions");
  assert.equal(captured.body.model, "provider-model");
  assert.equal(result.provider, THIRD_PARTY_MODEL_PROVIDER);
});
