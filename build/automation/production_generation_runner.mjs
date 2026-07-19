import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildProductionPipelinePrompt,
  PRODUCTION_PIPELINE_PROMPT_VERSION,
} from "./production_pipeline_prompts.mjs";
import {
  assertDomesticWorkScope,
  DOMESTIC_WORK_SCOPE_POLICY_VERSION,
} from "./domestic_work_scope.mjs";
import { completeProductionPrompt } from "./production_model_client.mjs";
import { evaluateProductionRecordProfile, resolveProductionProfile } from "./production_profile.mjs";

export const PRODUCTION_GENERATION_RUNNER_ID = "production-generation-v1-model-router";
export const PRODUCTION_GENERATION_STAGES = Object.freeze([
  "reference-breakdown",
  "attachment-plan",
  "question-draft",
  "final-compiler",
]);

function required(value, label) {
  if (value == null || (typeof value === "string" && !value.trim())) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, "_");
}

function parseStrictJson(text) {
  const source = String(text ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  return JSON.parse(firstBrace >= 0 && lastBrace > firstBrace ? source.slice(firstBrace, lastBrace + 1) : source);
}

async function writeArtifact({ outDir, stage, questionIndex, value }) {
  await fs.mkdir(required(outDir, "outDir"), { recursive: true });
  const filePath = path.resolve(outDir, `${safeName(questionIndex)}_${safeName(stage)}_generation.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, "utf8");
  return { path: filePath, sha256: sha256(text) };
}

function auditStageInput(stage, input) {
  if (stage === "attachment-plan") {
    return assertDomesticWorkScope({ topic: input.topic, researchedAttachments: input.researchedAttachments }, {
      requireWorkScene: true,
    });
  }
  if (stage === "question-draft") {
    return assertDomesticWorkScope({
      attachmentPlan: input.attachmentPlan,
      factLedger: input.factLedger,
      sceneCard: input.sceneCard,
    }, { requireWorkScene: true });
  }
  if (stage === "final-compiler") {
    return assertDomesticWorkScope({
      question: input.secondQaResult?.modifiedQuestion,
      attachmentPlan: input.attachmentPlan,
      metadata: input.metadata,
    }, { requireWorkScene: true });
  }
  return { pass: true, issues: [], policyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION };
}

function auditStageOutput(stage, parsed, profile) {
  if (stage === "attachment-plan") return assertDomesticWorkScope(parsed);
  if (stage === "question-draft") {
    const scope = assertDomesticWorkScope(parsed?.question, { requireWorkScene: true });
    const profileAudit = evaluateProductionRecordProfile({ 题目: parsed?.question }, profile);
    if (profileAudit.status !== "PASS") {
      throw new Error(`Generated ${profile.id} question failed the profile gate: ${profileAudit.findings.map((item) => item.rule).join(", ")}`);
    }
    return { ...scope, profileAudit };
  }
  if (stage === "final-compiler") {
    const scope = assertDomesticWorkScope(parsed?.finalRecord?.题目, { requireWorkScene: true });
    const profileAudit = evaluateProductionRecordProfile(parsed?.finalRecord ?? {}, profile);
    if (profileAudit.status !== "PASS") {
      throw new Error(`Compiled ${profile.id} question failed the profile gate: ${profileAudit.findings.map((item) => item.rule).join(", ")}`);
    }
    return { ...scope, profileAudit };
  }
  return { pass: true, issues: [], policyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION };
}

export async function runProductionGenerationStageWithModel({
  stage,
  input,
  outDir,
  provider,
  apiKey,
  baseUrl,
  model,
  reasoningEffort = "high",
  temperature = 0.2,
  maxTokens = 8_000,
  timeoutMs = 420_000,
  retries = 1,
  stream = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!PRODUCTION_GENERATION_STAGES.includes(stage)) {
    throw new TypeError(`Unsupported production generation stage: ${stage}`);
  }
  required(input, "input");
  const profile = resolveProductionProfile(input.packet);
  const inputScopeAudit = auditStageInput(stage, input);
  const envelope = buildProductionPipelinePrompt(stage, input);
  const completion = await completeProductionPrompt({
    provider,
    apiKey,
    baseUrl,
    model,
    reasoningEffort,
    systemPrompt: `你是${profile.label}生产模型。完整执行用户提供的阶段提示词，只输出提示词要求的最终JSON。不得输出分析过程、思考过程、代码围栏、英文前言或额外说明。`,
    userPrompt: envelope.prompt,
    temperature,
    maxTokens,
    timeoutMs,
    retries,
    stream,
    fetchImpl,
  });
  const parsed = parseStrictJson(completion.content);
  const outputScopeAudit = auditStageOutput(stage, parsed, profile);
  const artifactValue = {
    schemaVersion: 1,
    kind: `${profile.id}-production-generation-response`,
    runnerId: PRODUCTION_GENERATION_RUNNER_ID,
    productionProfile: profile.id,
    stage,
    questionIndex: Number(input.questionIndex),
    promptVersion: envelope.promptVersion,
    renderedPromptHash: sha256(envelope.prompt),
    response: completion,
    parsed,
    contentScope: {
      policyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION,
      input: inputScopeAudit,
      output: outputScopeAudit,
    },
  };
  const artifact = await writeArtifact({ outDir, stage, questionIndex: input.questionIndex, value: artifactValue });
  return {
    ...parsed,
    execution: {
      runnerId: PRODUCTION_GENERATION_RUNNER_ID,
      provider: completion.provider,
      model: completion.model,
      stage,
      promptVersion: PRODUCTION_PIPELINE_PROMPT_VERSION,
      renderedPromptHash: sha256(envelope.prompt),
      rawResponsePath: artifact.path,
      rawResponseHash: artifact.sha256,
      completedAt: new Date().toISOString(),
      usage: completion.usage,
      contentScopePolicyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION,
    },
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    return match ? [match[1], match[2]] : [arg.replace(/^--/u, ""), true];
  }));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.stage || !args.input || !args["out-dir"]) {
    throw new Error(`Usage: node production_generation_runner.mjs --stage=<${PRODUCTION_GENERATION_STAGES.join("|")}> --input=<json> --out-dir=<directory>`);
  }
  const inputPath = path.resolve(args.input);
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  return runProductionGenerationStageWithModel({
    stage: args.stage,
    input,
    outDir: path.resolve(args["out-dir"]),
    provider: args.provider,
    model: args.model,
    reasoningEffort: args["reasoning-effort"] || undefined,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
