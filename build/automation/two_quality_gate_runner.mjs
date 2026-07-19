import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { completeProductionPrompt } from "./production_model_client.mjs";
import {
  assertDomesticWorkScope,
  DOMESTIC_WORK_SCOPE_POLICY_VERSION,
} from "./domestic_work_scope.mjs";
import {
  buildFirstQualityGatePrompt,
  buildSecondLanguageGatePrompt,
  parseFirstQualityGateResponse,
  parseSecondLanguageGateResponse,
} from "./production_pipeline_prompts.mjs";
import {
  evaluateNarrativeHardRules,
  splitNarrativeParagraphs,
  splitNarrativeSentences,
  validateContinuityAudit,
} from "./narrative_language_rules.mjs";
import { resolveProductionProfile } from "./production_profile.mjs";

export const TWO_QUALITY_GATE_RUNNER_ID = "exact-two-quality-gates-v3-model-router";

function narrativeFindings(question, profile) {
  return evaluateNarrativeHardRules(question, {
    minimumExplanatoryParentheses: profile.language.minimumExplanatoryParentheses,
    forbidSemicolon: profile.language.forbidSemicolon,
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function required(value, label) {
  if (value == null || (typeof value === "string" && !value.trim())) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, "_");
}

async function writeRawArtifact({ outDir, fileName, value }) {
  required(outDir, "outDir");
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.resolve(outDir, fileName);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, "utf8");
  return { path: filePath, sha256: sha256(text) };
}

function executionRecord({ packet, stage, renderedPrompt, completion, artifact }) {
  const source = stage === "first-quality-gate"
    ? packet.inputs.firstQaPrompt
    : packet.inputs.secondQaPrompt;
  return {
    runnerId: TWO_QUALITY_GATE_RUNNER_ID,
    provider: completion.provider,
    model: completion.model,
    sourcePromptPath: source.path,
    sourcePromptHash: source.sha256,
    renderedPromptHash: sha256(renderedPrompt),
    rawResponsePath: artifact.path,
    rawResponseHash: artifact.sha256,
    completedAt: new Date().toISOString(),
    usage: completion.usage,
  };
}

async function completePrompt({ prompt, provider, apiKey, baseUrl, model, reasoningEffort, temperature, maxTokens, timeoutMs, retries, stream, fetchImpl }) {
  return completeProductionPrompt({
    provider,
    apiKey,
    baseUrl,
    model,
    reasoningEffort,
    systemPrompt: "你是独立质检模型。完整执行用户提供的质检提示词，严格遵守其判断范围和输出格式，不替生产脚本补造通过结果。不要输出分析过程、思考过程、英文说明或格式前言，只输出提示词要求的最终结果。",
    userPrompt: prompt,
    temperature,
    maxTokens,
    timeoutMs,
    retries,
    stream,
    fetchImpl,
  });
}

export async function runFirstQualityGateWithModel({
  packet,
  questionIndex,
  candidate,
  attachmentPlan,
  referenceBreakdown,
  outDir,
  provider,
  apiKey,
  baseUrl,
  model,
  reasoningEffort = "high",
  temperature = 0.1,
  maxTokens = 2_400,
  timeoutMs = 300_000,
  retries = 1,
  stream = true,
  fetchImpl = globalThis.fetch,
  attempt = 1,
} = {}) {
  const profile = resolveProductionProfile(packet);
  const contentScope = assertDomesticWorkScope({ question: candidate?.question, attachmentPlan }, {
    requireWorkScene: true,
  });
  const envelope = buildFirstQualityGatePrompt({ packet, questionIndex, candidate, attachmentPlan, referenceBreakdown });
  const initialCompletion = await completePrompt({
    prompt: envelope.prompt,
    provider,
    apiKey,
    baseUrl,
    model,
    reasoningEffort,
    temperature,
    maxTokens,
    timeoutMs,
    retries,
    stream,
    fetchImpl,
  });
  let completion = initialCompletion;
  let parsed;
  let formatRepair = null;
  try {
    parsed = parseFirstQualityGateResponse(initialCompletion.content);
  } catch (error) {
    const repairPrompt = `下面是第一道质检模型已经完成的最终判断，但输出不是合法JSON。你只能修复JSON语法，不能改变pass、issues数量或任何问题的实质内容。保留原提示词定义的rule和字段，只输出合法JSON，不加代码围栏和解释。\n\n原始返回：\n${initialCompletion.content}`;
    const repairedCompletion = await completePrompt({
      prompt: repairPrompt,
      provider,
      apiKey,
      baseUrl,
      model,
      reasoningEffort,
      temperature: 0,
      maxTokens,
      timeoutMs,
      retries,
      stream,
      fetchImpl,
    });
    parsed = parseFirstQualityGateResponse(repairedCompletion.content);
    formatRepair = {
      parseError: error.message,
      renderedPromptHash: sha256(repairPrompt),
      response: repairedCompletion,
    };
    completion = {
      ...repairedCompletion,
      usage: [initialCompletion.usage, repairedCompletion.usage].reduce((total, usage) => ({
        inputTokens: total.inputTokens + Number(usage?.inputTokens ?? 0),
        outputTokens: total.outputTokens + Number(usage?.outputTokens ?? 0),
        totalTokens: total.totalTokens + Number(usage?.totalTokens ?? 0),
      }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    };
  }
  const artifactValue = {
    schemaVersion: 1,
    kind: `${profile.id}-first-quality-gate-raw-response`,
    runnerId: TWO_QUALITY_GATE_RUNNER_ID,
    questionIndex: Number(questionIndex),
    sourcePromptHash: packet.inputs.firstQaPrompt.sha256,
    renderedPromptHash: sha256(envelope.prompt),
    response: completion,
    initialResponse: initialCompletion,
    formatRepair,
    parsed,
    contentScope,
  };
  const artifact = await writeRawArtifact({
    outDir,
    fileName: `${safeName(questionIndex)}_first_quality_gate_attempt_${safeName(attempt)}.json`,
    value: artifactValue,
  });
  return {
    ...parsed,
    execution: executionRecord({ packet, stage: "first-quality-gate", renderedPrompt: envelope.prompt, completion, artifact }),
  };
}

export async function repairCandidateAfterFirstQualityGate({
  questionIndex,
  candidate,
  attachmentPlan,
  firstQaResult,
  outDir,
  provider,
  apiKey,
  baseUrl,
  model,
  reasoningEffort = "high",
  temperature = 0.2,
  maxTokens = 3_500,
  timeoutMs = 300_000,
  retries = 1,
  stream = true,
  fetchImpl = globalThis.fetch,
  attempt = 1,
} = {}) {
  if (firstQaResult?.pass === true || !Array.isArray(firstQaResult?.issues) || !firstQaResult.issues.length) {
    throw new Error("First-gate repair requires a failed real first quality gate result.");
  }
  const prompt = `你是第一道质检后的业务修复员。只修复质检指出的附件支撑或信息缺失问题，不做语言美化，也不提前执行第二道语言质检。

优先采用质检意见中的最小修复：能够通过收窄主任务、把真实个案结论改成待核验事项、把验证矩阵改成待填模板解决时，不虚构或声称新增附件。必须保留现有对象、附件、真实事实、产物类型和合规边界。不得把附件没有提供的对象级数据、生产状态或验证结果写成已知事实。

只输出严格JSON：{"question":"修复后的完整题面"}

原题面：
${candidate.question}

现有附件方案：
${JSON.stringify(attachmentPlan, null, 2)}

第一道质检真实返回：
${JSON.stringify({ pass: firstQaResult.pass, issues: firstQaResult.issues }, null, 2)}`;
  const completion = await completePrompt({
    prompt,
    provider,
    apiKey,
    baseUrl,
    model,
    reasoningEffort,
    temperature,
    maxTokens,
    timeoutMs,
    retries,
    stream,
    fetchImpl,
  });
  const parsed = parseStrictJson(completion.content);
  const question = String(parsed?.question ?? "").trim();
  if (!question) throw new Error("First-gate repair returned no complete question.");
  const contentScope = assertDomesticWorkScope({ question, attachmentPlan }, { requireWorkScene: true });
  const artifact = await writeRawArtifact({
    outDir,
    fileName: `${safeName(questionIndex)}_first_quality_repair_attempt_${safeName(attempt)}.json`,
    value: {
      schemaVersion: 1,
      kind: "l2-first-quality-gate-repair-raw-response",
      runnerId: TWO_QUALITY_GATE_RUNNER_ID,
      questionIndex: Number(questionIndex),
      renderedPromptHash: sha256(prompt),
      failedGateArtifact: firstQaResult.execution?.rawResponsePath ?? "",
      response: completion,
      parsed: { question },
      contentScope,
    },
  });
  return {
    question,
    execution: {
      runnerId: TWO_QUALITY_GATE_RUNNER_ID,
      provider: completion.provider,
      model: completion.model,
      renderedPromptHash: sha256(prompt),
      rawResponsePath: artifact.path,
      rawResponseHash: artifact.sha256,
      completedAt: new Date().toISOString(),
      usage: completion.usage,
    },
  };
}

function continuityPrompt(question) {
  const sentenceCount = splitNarrativeSentences(question).length;
  const paragraphCount = splitNarrativeParagraphs(question).length;
  return `你是第二道语言质检后的独立承接审计员。不要改写题面，只检查相邻句和相邻段是否真实承接。句子和段落都从1开始编号，每一对相邻项必须逐一输出，不能抽样。本题按句末标点切分后共有${sentenceCount}句，因此sentenceLinks必须正好输出${Math.max(0, sentenceCount - 1)}条；共有${paragraphCount}段，因此paragraphLinks必须正好输出${Math.max(0, paragraphCount - 1)}条。relation只能从“因果、解释、递进、转折、条件、时间推进、对象延续、任务收束”中选择，不能组合两个标签。reason必须具体说明后一项如何接住前一项，不能统一写套话。若题面存在逗号伪装清单、外行无法理解的术语或叙事跳跃，对应布尔值必须为false并如实列出术语。

只输出严格JSON，不加代码围栏：
{
  "sentenceLinks": [{"from":1,"to":2,"relation":"解释","reason":"具体说明"}],
  "paragraphLinks": [{"from":1,"to":2,"relation":"递进","reason":"具体说明"}],
  "commaListFree": true,
  "outsiderReadable": true,
  "narrativeFlow": true,
  "unexplainedProfessionalTerms": []
}

待审计题面：
${question}`;
}

function parseStrictJson(text) {
  const source = String(text ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  return JSON.parse(source);
}

export async function runContinuityAuditWithModel({
  questionIndex,
  question,
  outDir,
  provider,
  apiKey,
  baseUrl,
  model,
  reasoningEffort = "high",
  timeoutMs = 360_000,
  retries = 2,
  stream = false,
  fetchImpl = globalThis.fetch,
  attempt = "resume",
} = {}) {
  const contentScope = assertDomesticWorkScope(question, { requireWorkScene: true });
  const prompt = continuityPrompt(required(question, "question"));
  const completion = await completePrompt({
    prompt,
    provider,
    apiKey,
    baseUrl,
    model,
    reasoningEffort,
    temperature: 0.1,
    maxTokens: 6_000,
    timeoutMs,
    retries,
    stream,
    fetchImpl,
  });
  const parsed = parseStrictJson(completion.content);
  const findings = [
    ...evaluateNarrativeHardRules(question),
    ...validateContinuityAudit(question, parsed),
  ];
  const artifact = await writeRawArtifact({
    outDir,
    fileName: `${safeName(questionIndex)}_continuity_audit_attempt_${safeName(attempt)}.json`,
    value: {
      schemaVersion: 1,
      kind: "l2-second-language-continuity-audit-attempt",
      runnerId: TWO_QUALITY_GATE_RUNNER_ID,
      questionIndex: Number(questionIndex),
      attempt,
      renderedPromptHash: sha256(prompt),
      response: completion,
      parsed,
      findings,
      contentScope,
    },
  });
  return {
    parsed,
    findings,
    response: completion,
    renderedPromptHash: sha256(prompt),
    rawResponsePath: artifact.path,
    rawResponseHash: artifact.sha256,
  };
}

export async function runSecondLanguageGateWithModel({
  packet,
  questionIndex,
  firstQaResult,
  candidate,
  referenceBreakdown,
  outDir,
  provider,
  apiKey,
  baseUrl,
  model,
  reasoningEffort = "high",
  temperature = 0.3,
  maxTokens = 6_500,
  timeoutMs = 360_000,
  retries = 1,
  stream = true,
  fetchImpl = globalThis.fetch,
  maxLanguageRounds = 5,
} = {}) {
  if (firstQaResult?.pass !== true || firstQaResult?.issues?.length) {
    throw new Error("Second language gate is blocked until the real first quality gate passes.");
  }
  const profile = resolveProductionProfile(packet);
  const initialContentScope = assertDomesticWorkScope(candidate?.question, { requireWorkScene: true });
  let currentCandidate = structuredClone(candidate);
  const attempts = [];
  const continuityAttempts = [];
  let auditFeedback = [];
  let accepted;
  let acceptedContinuityAudit;
  let acceptedAuditCompletion;

  for (let round = 1; round <= maxLanguageRounds; round += 1) {
    const envelope = buildSecondLanguageGatePrompt({
      packet,
      questionIndex,
      firstQaResult,
      candidate: currentCandidate,
      referenceBreakdown,
    });
    const renderedPrompt = auditFeedback.length
      ? `${envelope.prompt}\n\n【上轮独立校验未通过】\n下面的问题必须在本轮修改后题面中真实修复，不能只修改自检答案：\n${JSON.stringify(auditFeedback, null, 2)}`
      : envelope.prompt;
    const completion = await completePrompt({
      prompt: renderedPrompt,
      provider,
      apiKey,
      baseUrl,
      model,
      reasoningEffort,
      temperature,
      maxTokens,
      timeoutMs,
      retries,
      stream,
      fetchImpl,
    });
    const parsed = parseSecondLanguageGateResponse(completion.content);
    const contentScope = assertDomesticWorkScope(parsed.modifiedQuestion, { requireWorkScene: true });
    const attempt = {
      round,
      sourcePromptHash: packet.inputs.secondQaPrompt.sha256,
      renderedPromptHash: sha256(renderedPrompt),
      response: completion,
      parsed,
      contentScope,
    };
    attempts.push(attempt);
    await writeRawArtifact({
      outDir,
      fileName: `${safeName(questionIndex)}_second_language_attempt_${safeName(round)}.json`,
      value: {
        schemaVersion: 1,
        kind: `${profile.id}-second-language-gate-attempt`,
        runnerId: TWO_QUALITY_GATE_RUNNER_ID,
        questionIndex: Number(questionIndex),
        ...attempt,
      },
    });
    if (parsed.conclusion === "退回第一道质检") {
      throw new Error(`Second language gate returned the question to the first gate in round ${round}.`);
    }
    if (["通过", "需语言小修"].includes(parsed.conclusion)) {
      const hardRuleFindings = narrativeFindings(parsed.modifiedQuestion, profile);
      let auditCompletion = null;
      let continuityAudit = null;
      let combinedFindings = hardRuleFindings;
      if (profile.language.requireContinuityAudit) {
        const auditPrompt = continuityPrompt(parsed.modifiedQuestion);
        auditCompletion = await completePrompt({
          prompt: auditPrompt,
          provider,
          apiKey,
          baseUrl,
          model,
          reasoningEffort,
          temperature: 0.1,
          maxTokens: 6_000,
          timeoutMs,
          retries,
          stream: false,
          fetchImpl,
        });
        continuityAudit = parseStrictJson(auditCompletion.content);
        combinedFindings = [...hardRuleFindings, ...validateContinuityAudit(parsed.modifiedQuestion, continuityAudit)];
        continuityAttempts.push({
          round,
          renderedPromptHash: sha256(auditPrompt),
          response: auditCompletion,
          parsed: continuityAudit,
          findings: combinedFindings,
        });
        await writeRawArtifact({
          outDir,
          fileName: `${safeName(questionIndex)}_continuity_audit_attempt_${safeName(round)}.json`,
          value: {
            schemaVersion: 1,
            kind: `${profile.id}-second-language-continuity-audit-attempt`,
            runnerId: TWO_QUALITY_GATE_RUNNER_ID,
            questionIndex: Number(questionIndex),
            ...continuityAttempts.at(-1),
          },
        });
      }
      if (!combinedFindings.length) {
        accepted = { parsed, completion, renderedPrompt };
        acceptedContinuityAudit = continuityAudit;
        acceptedAuditCompletion = auditCompletion;
        break;
      }
      auditFeedback = combinedFindings;
    }
    currentCandidate = { ...currentCandidate, question: parsed.modifiedQuestion };
  }
  if (!accepted) {
    throw new Error(`Second language gate did not reach a real audited completion within ${maxLanguageRounds} rounds; latest findings: ${auditFeedback.map((item) => item.rule).join(", ")}.`);
  }

  const artifactValue = {
    schemaVersion: 1,
    kind: `${profile.id}-second-language-gate-raw-response`,
    runnerId: TWO_QUALITY_GATE_RUNNER_ID,
    questionIndex: Number(questionIndex),
    sourcePromptHash: packet.inputs.secondQaPrompt.sha256,
    attempts,
    acceptedRound: attempts.findIndex((item) => item === attempts.at(-1)) + 1,
    continuityAudit: {
      response: acceptedAuditCompletion,
      parsed: acceptedContinuityAudit,
    },
    continuityAttempts,
    contentScope: {
      policyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION,
      initial: initialContentScope,
      accepted: accepted?.parsed?.modifiedQuestion
        ? assertDomesticWorkScope(accepted.parsed.modifiedQuestion, { requireWorkScene: true })
        : null,
    },
  };
  const artifact = await writeRawArtifact({
    outDir,
    fileName: `${safeName(questionIndex)}_second_language_gate.json`,
    value: artifactValue,
  });
  const combinedUsage = [...attempts.map((item) => item.response.usage), ...continuityAttempts.map((item) => item.response.usage)]
    .reduce((total, usage) => ({
      inputTokens: total.inputTokens + Number(usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + Number(usage?.outputTokens ?? 0),
      totalTokens: total.totalTokens + Number(usage?.totalTokens ?? 0),
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return {
    ...accepted.parsed,
    continuityAudit: acceptedContinuityAudit,
    execution: {
      ...executionRecord({
        packet,
        stage: "second-language-gate",
        renderedPrompt: accepted.renderedPrompt,
        completion: { ...accepted.completion, usage: combinedUsage },
        artifact,
      }),
      languageAttempts: attempts.length,
      continuityResponseHash: acceptedAuditCompletion ? sha256(acceptedAuditCompletion.content) : "",
    },
  };
}
