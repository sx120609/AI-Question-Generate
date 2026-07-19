import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatCompletionsRequest,
  createChatCompletion,
  normalizeOpenAiBaseUrl,
  parseChatCompletionStream,
} from "./openai_compatible_chat.mjs";

test("normalizes a root or v1 base URL to one chat-completions endpoint", () => {
  assert.equal(normalizeOpenAiBaseUrl("https://api.example.com/"), "https://api.example.com");
  assert.equal(normalizeOpenAiBaseUrl("https://api.example.com/v1/"), "https://api.example.com");
});

test("builds the standard non-streaming chat completions body", () => {
  assert.deepEqual(buildChatCompletionsRequest({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "改写" }],
    temperature: 0.2,
    maxTokens: 900,
  }), {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "改写" }],
    temperature: 0.2,
    max_tokens: 900,
    stream: false,
  });
});

test("calls chat completions with bearer auth without returning the credential", async () => {
  let captured;
  const result = await createChatCompletion({
    apiKey: "test-secret",
    baseUrl: "https://api.example.com/v1",
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "改写" }],
    retries: 0,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        id: "chat-1",
        model: "claude-opus-4-8",
        choices: [{ message: { content: "完成" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(captured.url, "https://api.example.com/v1/chat/completions");
  assert.equal(captured.options.headers.Authorization, "Bearer test-secret");
  assert.equal(result.content, "完成");
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
});

test("parses standard chat-completions SSE chunks with final usage", () => {
  const parsed = parseChatCompletionStream([
    'data: {"id":"chat-stream","model":"claude-opus-4-8","choices":[{"delta":{"content":"重新"},"finish_reason":null}]}',
    'data: {"id":"chat-stream","model":"claude-opus-4-8","choices":[{"delta":{"content":"起草"},"finish_reason":"stop"}]}',
    'data: {"id":"chat-stream","model":"claude-opus-4-8","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":3,"total_tokens":23}}',
    "data: [DONE]",
  ].join("\n"));
  assert.equal(parsed.content, "重新起草");
  assert.equal(parsed.finishReason, "stop");
  assert.deepEqual(parsed.usage, { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 });
});
