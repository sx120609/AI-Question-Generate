import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponsesRequest,
  createResponsesCompletion,
  normalizeResponsesBaseUrl,
} from "./openai_responses.mjs";

test("builds the Codex-model Responses request with explicit reasoning", () => {
  assert.equal(normalizeResponsesBaseUrl("https://api.openai.com/v1/"), "https://api.openai.com");
  assert.deepEqual(buildResponsesRequest({
    model: "gpt-5.6-sol",
    instructions: "只输出JSON",
    input: "生成题目",
    maxOutputTokens: 900,
    reasoningEffort: "high",
  }), {
    model: "gpt-5.6-sol",
    instructions: "只输出JSON",
    input: "生成题目",
    max_output_tokens: 900,
    reasoning: { effort: "high" },
    store: false,
  });
});

test("uses Responses structured outputs for a supplied JSON schema", () => {
  const schema = {
    type: "object",
    properties: { pass: { type: "boolean" } },
    required: ["pass"],
    additionalProperties: false,
  };
  const request = buildResponsesRequest({
    input: "check",
    outputSchema: schema,
    outputSchemaName: "quality gate",
  });
  assert.deepEqual(request.text, {
    format: {
      type: "json_schema",
      name: "quality_gate",
      strict: true,
      schema,
    },
  });
});

test("calls Responses API without returning or persisting the credential", async () => {
  let captured;
  const result = await createResponsesCompletion({
    apiKey: "test-secret",
    baseUrl: "https://gateway.example/openai/v1/responses",
    model: "gpt-5.6-sol",
    instructions: "只输出结果",
    input: "开始",
    retries: 0,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        id: "resp_1",
        model: "gpt-5.6-sol",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "完成" }] }],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 17,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(captured.url, "https://gateway.example/openai/v1/responses");
  assert.equal(captured.options.headers.Authorization, "Bearer test-secret");
  assert.equal(JSON.parse(captured.options.body).reasoning.effort, "high");
  assert.equal(result.content, "完成");
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
  assert.equal(result.provider, "openai-compatible-responses-api");
  assert.deepEqual({
    inputTokens: result.usage.inputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    uncachedInputTokens: result.usage.uncachedInputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.reasoningTokens,
    visibleOutputTokens: result.usage.visibleOutputTokens,
    totalTokens: result.usage.totalTokens,
  }, {
    inputTokens: 10,
    cachedInputTokens: 4,
    uncachedInputTokens: 6,
    outputTokens: 7,
    reasoningTokens: 5,
    visibleOutputTokens: 2,
    totalTokens: 17,
  });
});

test("fails closed when an official-compatible endpoint omits usage", async () => {
  await assert.rejects(createResponsesCompletion({
    apiKey: "test-secret",
    baseUrl: "https://gateway.example",
    input: "start",
    retries: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      id: "resp_without_usage",
      model: "gpt-5.6-sol",
      status: "completed",
      output_text: "done",
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  }), /exact token metering is unavailable/u);
});
