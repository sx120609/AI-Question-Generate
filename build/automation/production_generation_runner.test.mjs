import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProductionGenerationStageWithModel } from "./production_generation_runner.mjs";

function packet() {
  return {
    kind: "l1-production-input-packet",
    productionProfile: "l1",
    status: "READY",
    inputs: {
      referenceWorkbook: {
        samples: [{
          questionIndex: 1,
          sheet: "三期示例数据",
          row: 2,
          question: "参考题面",
          attachmentSummary: "无",
          questionHash: "question-hash",
          attachmentSummaryHash: "attachment-hash",
        }],
      },
    },
  };
}

test("generation stages default to the Codex model and bind the raw response", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "production-generation-"));
  let captured;
  const generated = {
    businessScene: "真实工作场景",
    coreBlockage: "证据分散",
    mainTask: "整理证据边界",
    attachmentSupport: "无需附件",
    deliverableOrigin: "供下一轮判断使用",
    imitableStructure: "先核验再收束",
    forbiddenReuse: "不复用对象",
    referenceAttachmentStructure: "公开来源",
    referenceProductParagraphLogic: "以证据清单收束",
  };
  const result = await runProductionGenerationStageWithModel({
    stage: "reference-breakdown",
    input: { packet: packet(), questionIndex: 1 },
    outDir,
    apiKey: "codex-key",
    baseUrl: "https://api.openai.com",
    model: "gpt-5.6-sol",
    retries: 0,
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "resp_generation",
        model: "gpt-5.6-sol",
        status: "completed",
        output_text: JSON.stringify(generated),
        usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.body.reasoning.effort, "high");
  assert.equal(result.mainTask, generated.mainTask);
  assert.equal(result.execution.provider, "codex-model");
  assert.equal(result.execution.model, "gpt-5.6-sol");
  const artifact = JSON.parse(await fs.readFile(result.execution.rawResponsePath, "utf8"));
  assert.equal(artifact.runnerId, "production-generation-v1-model-router");
  assert.equal(artifact.parsed.mainTask, generated.mainTask);
  assert.equal(JSON.stringify(artifact).includes("codex-key"), false);
});

test("quality-gate stages cannot be sent through the generation runner", async () => {
  await assert.rejects(
    runProductionGenerationStageWithModel({ stage: "first-quality-gate", input: { packet: packet() }, outDir: os.tmpdir() }),
    /Unsupported production generation stage/u,
  );
});

test("blocks a foreign platform topic before any generation model call", async () => {
  let called = false;
  await assert.rejects(
    runProductionGenerationStageWithModel({
      stage: "attachment-plan",
      input: {
        packet: packet(),
        questionIndex: 1,
        topic: "比较 Zoom 和 Google Meet 的采购方案",
        researchedAttachments: [],
      },
      outDir: os.tmpdir(),
      fetchImpl: async () => {
        called = true;
        throw new Error("must not be called");
      },
    }),
    (error) => error.code === "CONTENT_SCOPE_BLOCKED" && error.issues.includes("foreign-platform"),
  );
  assert.equal(called, false);
});
