import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLocalCodexArgs,
  completeWithLocalCodex,
} from "../src/local-codex.mjs";

test("builds an ephemeral read-only local Codex invocation", () => {
  const args = buildLocalCodexArgs({
    model: "gpt-5.6-sol",
    outputPath: "C:\\runtime\\last.json",
    reasoningEffort: "high",
    schemaPath: "C:\\runtime\\schema.json",
    workingDirectory: "C:\\runtime",
  });
  assert.deepEqual(args.slice(0, 3), ["exec", "--model", "gpt-5.6-sol"]);
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("--output-schema"));
  assert.ok(args.includes("--output-last-message"));
  assert.equal(args.at(-1), "-");
});

test("uses the local Codex process without any API credential", async () => {
  let captured;
  const result = await completeWithLocalCodex({
    executablePath: process.execPath,
    model: "gpt-5.6-sol",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pass"],
      properties: { pass: { type: "boolean" } },
    },
    processRunner: async (value) => {
      captured = value;
      return { code: 0, lastMessage: '{"pass":true}', stderr: "", stdout: "" };
    },
    systemPrompt: "只判断是否放行。",
    userPrompt: '{"candidate":"请继续核对来源。"}',
  });
  assert.equal(JSON.parse(result.content).pass, true);
  assert.equal(result.provider, "local-codex-cli");
  assert.equal(captured.executablePath, process.execPath);
  assert.match(captured.prompt, /Do not call tools/u);
  assert.match(captured.prompt, /请继续核对来源/u);
});

test("marks local Codex capacity failures as retryable", async () => {
  await assert.rejects(
    completeWithLocalCodex({
      executablePath: process.execPath,
      model: "gpt-5.6-sol",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pass"],
        properties: { pass: { type: "boolean" } },
      },
      processRunner: async () => ({
        code: 1,
        stderr: "ERROR: Selected model is at capacity. Please try a different model.",
        stdout: "",
      }),
      systemPrompt: "只判断是否放行。",
      userPrompt: '{"candidate":"请继续核对来源。"}',
    }),
    (error) => error.retryable === true && /at capacity/iu.test(error.message),
  );
});
