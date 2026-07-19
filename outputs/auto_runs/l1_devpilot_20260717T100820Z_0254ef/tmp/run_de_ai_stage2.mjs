import fs from "node:fs/promises";
import path from "node:path";

import { rewriteQuestionWithDeAiApi } from "../../../../build/automation/claude_question_rewriter.mjs";

const runDir = path.resolve("outputs/auto_runs/l1_devpilot_20260717T100820Z_0254ef");
const draft = JSON.parse(await fs.readFile(path.join(runDir, "drafts", "01_pre_de_ai.json"), "utf8"));
const sceneSeed = JSON.parse(await fs.readFile(path.join(runDir, "sources", "scene_card_seed.json"), "utf8"));
const packet = JSON.parse(await fs.readFile(path.join(runDir, "sources", "production_input_packet.json"), "utf8"));
const apiKey = String(process.env.DE_AI_REWRITE_API_KEY ?? "").trim();
if (!apiKey) throw new Error("DE_AI_REWRITE_API_KEY is required for this isolated rewrite call.");

try {
  const result = await rewriteQuestionWithDeAiApi({
    input: {
      uid: draft.sourceRecord.UID,
      record: draft.sourceRecord,
      sceneCard: sceneSeed.sceneCard,
      knownFactIds: sceneSeed.sceneCard.informationBoundary.knownFactIds,
      avoidQuestions: packet.inputs.referenceWorkbook.samples.map((sample) => sample.question),
    },
    apiKey,
    baseUrl: "https://api.mugua.link/v1",
    model: "gemini-3.5-flash",
    timeoutMs: 120_000,
    retries: 1,
    contentAttempts: 3,
  });

  const outPath = path.join(runDir, "qa", "01_de_ai_rewrite.json");
  await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    outPath,
    provider: result.provider,
    model: result.model,
    selectedAttempt: result.selectedAttempt,
    pass: result.validation.pass,
    visibleLength: result.validation.visibleLength,
    findingRules: result.validation.findings.map((finding) => finding.rule),
    rewrittenQuestion: result.rewrite.question,
  }, null, 2));
  if (!result.validation.pass) process.exitCode = 2;
} catch (error) {
  const failure = {
    kind: "de-ai-question-rewrite-failure",
    policyId: "mugua-gemini-de-ai-rewrite-v2",
    uid: draft.sourceRecord.UID,
    generatedAt: new Date().toISOString(),
    status: "FAILED",
    provider: "mugua-openai-compatible",
    endpoint: "https://api.mugua.link/v1/chat/completions",
    model: "gemini-3.5-flash",
    sourceQuestionHash: await cryptoHash(draft.sourceRecord.题目),
    error: { name: error?.name || "Error", message: error?.message || String(error) },
    authorization: "BLOCK_FINALIZATION_AND_SUBMISSION",
  };
  const failurePath = path.join(runDir, "qa", "01_de_ai_failure.json");
  await fs.writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
  console.error(JSON.stringify({ failurePath, status: failure.status, message: failure.error.message }, null, 2));
  process.exitCode = 1;
}

async function cryptoHash(value) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(String(value)).digest("hex");
}
