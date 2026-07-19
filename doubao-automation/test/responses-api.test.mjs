import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponsesRequest,
  completeWithResponsesApi,
  normalizeResponsesUsage,
  responsesEndpoint,
} from "../src/responses-api.mjs";

test("targets a custom official-compatible Responses endpoint", () => {
  assert.equal(
    responsesEndpoint("https://gateway.example/team/v1/responses"),
    "https://gateway.example/team/v1/responses",
  );
});

test("builds strict Responses structured output and meters detailed usage", async () => {
  let captured;
  const schema = {
    type: "object",
    properties: { pass: { type: "boolean" } },
    required: ["pass"],
    additionalProperties: false,
  };
  const result = await completeWithResponsesApi({
    apiKey: "secret-not-persisted",
    baseUrl: "https://gateway.example/team/v1",
    model: "gpt-5.6-sol",
    outputSchema: schema,
    outputSchemaName: "preflight",
    systemPrompt: "Return the required object.",
    userPrompt: "Check this input.",
    retries: 0,
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "resp_custom_1",
        model: "gpt-5.6-sol",
        status: "completed",
        output_text: "{\"pass\":true}",
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 35,
          output_tokens_details: { reasoning_tokens: 30 },
          total_tokens: 155,
        },
      }), { status: 200, headers: { "Content-Type": "application/json", "x-request-id": "req_1" } });
    },
  });
  assert.equal(captured.url, "https://gateway.example/team/v1/responses");
  assert.equal(captured.body.model, "gpt-5.6-sol");
  assert.equal(captured.body.reasoning.effort, "high");
  assert.deepEqual(captured.body.text.format.schema, schema);
  assert.equal(result.requestId, "req_1");
  assert.equal(result.usage.cachedInputTokens, 20);
  assert.equal(result.usage.reasoningTokens, 30);
  assert.equal(result.usage.visibleOutputTokens, 5);
  assert.equal(JSON.stringify(result).includes("secret-not-persisted"), false);
});

test("normalizes the official Responses usage object", () => {
  const usage = normalizeResponsesUsage({
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens: 8,
    output_tokens_details: { reasoning_tokens: 6 },
    total_tokens: 18,
  });
  assert.equal(usage.uncachedInputTokens, 7);
  assert.equal(usage.visibleOutputTokens, 2);
  assert.equal(usage.totalTokens, 18);
});

test("preserves returned usage when structured output is invalid", async () => {
  await assert.rejects(
    completeWithResponsesApi({
      apiKey: "secret-not-persisted",
      baseUrl: "https://gateway.example/team/v1",
      outputSchema: {
        type: "object",
        properties: { pass: { type: "boolean" } },
        required: ["pass"],
        additionalProperties: false,
      },
      retries: 0,
      userPrompt: "Check this input.",
      fetchImpl: async () => new Response(JSON.stringify({
        id: "resp_invalid_json",
        model: "gpt-5.6-sol",
        status: "completed",
        output_text: "not-json",
        usage: {
          input_tokens: 42,
          output_tokens: 9,
          output_tokens_details: { reasoning_tokens: 7 },
          total_tokens: 51,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    }),
    (error) => error.usage?.totalTokens === 51
      && error.provider === "openai-compatible-responses-api"
      && error.responseId === "resp_invalid_json",
  );
});

test("redacts a credential echoed by a custom gateway error", async () => {
  const credential = "custom-secret-must-not-leak";
  await assert.rejects(
    completeWithResponsesApi({
      apiKey: credential,
      baseUrl: "https://gateway.example/team/v1",
      retries: 0,
      userPrompt: "Check this input.",
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: `invalid bearer ${credential}` },
      }), { status: 401, headers: { "Content-Type": "application/json" } }),
    }),
    (error) => !error.message.includes(credential) && error.message.includes("[REDACTED]"),
  );
});

test("keeps an unstructured request free of text.format", () => {
  const request = buildResponsesRequest({ input: "hello" });
  assert.equal("text" in request, false);
});
