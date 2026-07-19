import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeAiRewriteRequest,
  rewriteDeAiText,
} from "./de_ai_rewrite_client.mjs";

test("builds the rewrite service request with its exact contract", () => {
  assert.deepEqual(buildDeAiRewriteRequest({
    text: "原题面",
    apiKey: "test-key",
    baseUrl: "https://api.mugua.link/v1",
    model: "gemini-3.1-pro-preview",
  }), {
    text: "原题面",
    apiKey: "test-key",
    baseUrl: "https://api.mugua.link/v1",
    model: "gemini-3.1-pro-preview",
  });
});

test("posts the original text and returns the rewritten text", async () => {
  let observed;
  const result = await rewriteDeAiText({
    text: "slgg好帅",
    apiKey: "test-key",
    endpoint: "http://rewrite.test/api/rewrite",
    baseUrl: "https://api.mugua.link/v1",
    model: "gemini-3.1-pro-preview",
    retries: 0,
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "slgg确实挺帅的。" }),
      };
    },
  });

  assert.equal(observed.url, "http://rewrite.test/api/rewrite");
  assert.equal(observed.options.method, "POST");
  assert.deepEqual(observed.options.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(observed.options.body), {
    text: "slgg好帅",
    apiKey: "test-key",
    baseUrl: "https://api.mugua.link/v1",
    model: "gemini-3.1-pro-preview",
  });
  assert.equal(result.text, "slgg确实挺帅的。");
  assert.equal(result.model, "gemini-3.1-pro-preview");
  assert.equal("apiKey" in result, false);
});

test("rejects an empty credential before making a request", async () => {
  let called = false;
  await assert.rejects(
    rewriteDeAiText({
      text: "原题面",
      apiKey: "",
      retries: 0,
      fetchImpl: async () => {
        called = true;
      },
    }),
    /DE_AI_REWRITE_API_KEY is required/u,
  );
  assert.equal(called, false);
});

test("does not expose the credential in HTTP errors", async () => {
  const secret = "do-not-print-this";
  await assert.rejects(
    rewriteDeAiText({
      text: "原题面",
      apiKey: secret,
      retries: 0,
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        text: async () => JSON.stringify({ message: `upstream rejected ${secret}` }),
      }),
    }),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /HTTP 502/u);
      return true;
    },
  );
});
