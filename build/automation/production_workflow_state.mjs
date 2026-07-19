import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { evaluateNarrativeHardRules, validateContinuityAudit } from "./narrative_language_rules.mjs";
import { evaluateAttachmentSemantics } from "./attachment_semantic_rules.mjs";
import { buildFormatCoverageAssignments } from "./product_format_diversity.mjs";
import { analyzeProductFormat } from "./product_format.mjs";
import { isPacketForProfile, resolveProductionProfile } from "./production_profile.mjs";

export const PRODUCTION_WORKFLOW_SCHEMA_VERSION = 4;
export const MAX_FIRST_QA_FAILURES = 2;
const SUPPORTED_QUALITY_GATE_RUNNER_IDS = new Set([
  "exact-two-quality-gates-v1",
  "exact-two-quality-gates-v2-codex-session",
  "exact-two-quality-gates-v3-model-router",
]);
const SUPPORTED_QUALITY_GATE_PROVIDERS = new Set([
  "openai-compatible",
  "codex-session",
  "codex-model",
  "third-party-openai-compatible",
]);

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

function now() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function requireState(question, allowed, action) {
  if (!allowed.includes(question.state)) {
    throw new Error(`${action} is not allowed from ${question.state}; expected ${allowed.join(" or ")}.`);
  }
}

function appendEvent(question, type, detail = {}) {
  question.events.push({ at: now(), type, ...detail });
  question.updatedAt = now();
}

function questionAt(workflow, questionIndex) {
  const question = workflow.questions.find((item) => Number(item.questionIndex) === Number(questionIndex));
  if (!question) throw new Error(`Question ${questionIndex} does not exist in this workflow.`);
  return question;
}

function assertRealQualityGateExecution(workflow, result, stage) {
  const execution = result?.execution;
  const expectedHash = workflow?.qualityGatePromptHashes?.[stage];
  const profile = resolveProductionProfile(workflow);
  if (!execution || !SUPPORTED_QUALITY_GATE_RUNNER_IDS.has(execution.runnerId)) {
    throw new Error(`${stage} must contain a supported real quality-gate execution record.`);
  }
  if (!SUPPORTED_QUALITY_GATE_PROVIDERS.has(execution.provider) || !String(execution.model ?? "").trim()) {
    throw new Error(`${stage} must record its model provider and model.`);
  }
  const developmentCodexSession = workflow.runMode === "development-codex-session"
    && execution.runnerId === "exact-two-quality-gates-v2-codex-session"
    && execution.provider === "codex-session";
  if (profile.id === "l1" && !developmentCodexSession
    && (execution.runnerId !== "exact-two-quality-gates-v3-model-router"
      || !["codex-model", "third-party-openai-compatible"].includes(execution.provider))) {
    throw new Error(`${stage} must use the L1 production model router; legacy quality providers are replay-only.`);
  }
  if (!expectedHash || execution.sourcePromptHash !== expectedHash) {
    throw new Error(`${stage} did not use the prompt hash frozen into the workflow.`);
  }
  for (const key of ["renderedPromptHash", "rawResponsePath", "rawResponseHash", "completedAt"]) {
    if (!String(execution[key] ?? "").trim()) throw new Error(`${stage} execution is missing ${key}.`);
  }
}

export function initializeProductionWorkflow({ packet, runId = packet?.runId ?? "" } = {}) {
  const profile = resolveProductionProfile(packet);
  if (!isPacketForProfile(packet, profile)) {
    throw new Error(`Cannot initialize workflow without a READY ${profile.packetKind}.`);
  }
  const createdAt = now();
  const formatRequirements = profile.productFormat.requireBatchCoverage
    ? buildFormatCoverageAssignments(packet.inputs.referenceWorkbook.samples.length, { seed: runId })
    : Array.from({ length: packet.inputs.referenceWorkbook.samples.length }, () => null);
  return {
    schemaVersion: PRODUCTION_WORKFLOW_SCHEMA_VERSION,
    kind: profile.workflowKind,
    productionProfile: profile.id,
    taskType: profile.taskType,
    protocolId: packet.protocolId,
    runId,
    runMode: packet.runMode || "production-api",
    packetRunId: packet.runId,
    qualityGatePromptHashes: {
      "first-quality-gate": packet.inputs.firstQaPrompt.sha256,
      "second-language-gate": packet.inputs.secondQaPrompt.sha256,
    },
    createdAt,
    updatedAt: createdAt,
    questions: packet.inputs.referenceWorkbook.samples.map((sample, index) => ({
      questionIndex: Number(sample.questionIndex),
      state: "REFERENCE_SAMPLED",
      referenceLocation: { sheet: sample.sheet, row: sample.row },
      referenceHashes: {
        question: sample.questionHash,
        attachmentSummary: sample.attachmentSummaryHash,
      },
      firstQaFailureCount: 0,
      formatRequirement: formatRequirements[index],
      revisionLog: [],
      events: [{ at: createdAt, type: "reference.sampled", sheet: sample.sheet, row: sample.row }],
    })),
  };
}

export async function initializeProductionWorkflowFile({ packet, outPath, runId } = {}) {
  const workflow = initializeProductionWorkflow({ packet, runId });
  await writeJsonAtomic(outPath, workflow);
  return workflow;
}

export function recordReferenceBreakdown(workflow, questionIndex, breakdown) {
  const question = questionAt(workflow, questionIndex);
  requireState(question, ["REFERENCE_SAMPLED"], "recordReferenceBreakdown");
  const requiredKeys = ["businessScene", "coreBlockage", "mainTask", "attachmentSupport", "deliverableOrigin", "imitableStructure", "forbiddenReuse", "referenceAttachmentStructure", "referenceProductParagraphLogic"];
  for (const key of requiredKeys) {
    if (!String(breakdown?.[key] ?? "").trim()) throw new Error(`Reference breakdown is missing ${key}.`);
  }
  question.referenceBreakdown = structuredClone(breakdown);
  question.state = "STRUCTURE_READY";
  appendEvent(question, "reference.breakdown.recorded");
  workflow.updatedAt = now();
  return workflow;
}

export function recordAttachmentPlan(workflow, questionIndex, attachmentPlan) {
  const question = questionAt(workflow, questionIndex);
  requireState(question, ["STRUCTURE_READY", "FIRST_QA_REPAIR_REQUIRED"], "recordAttachmentPlan");
  const profile = resolveProductionProfile(workflow);
  if (!Array.isArray(attachmentPlan?.attachments)) {
    throw new Error("Attachment plan must contain an attachments array.");
  }
  if (attachmentPlan.attachments.length < profile.attachments.minimum
    || (profile.attachments.maximum != null && attachmentPlan.attachments.length > profile.attachments.maximum)) {
    throw new Error(`Attachment plan must contain ${profile.attachments.minimum}–${profile.attachments.maximum ?? "unlimited"} attachments.`);
  }
  const semanticResult = evaluateAttachmentSemantics(attachmentPlan, {
    allowEmpty: profile.attachments.minimum === 0,
    maximumAttachments: profile.attachments.maximum,
    minimumSpecificBusinessShare: profile.attachments.minimumSpecificBusinessShare,
  });
  if (semanticResult.findings.length) {
    throw new Error(`Attachment plan cannot pass the specific-evidence policy: ${semanticResult.findings.map((item) => item.rule).join(", ")}.`);
  }
  question.attachmentPlan = structuredClone(attachmentPlan);
  question.state = "ATTACHMENTS_READY";
  appendEvent(question, "attachments.recorded", { count: attachmentPlan.attachments.length });
  workflow.updatedAt = now();
  return workflow;
}

export function recordDraft(workflow, questionIndex, draft, { reason = "initial" } = {}) {
  const question = questionAt(workflow, questionIndex);
  requireState(question, ["ATTACHMENTS_READY", "FIRST_QA_REPAIR_REQUIRED"], "recordDraft");
  const profile = resolveProductionProfile(workflow);
  if (!String(draft?.question ?? "").trim() || !String(draft?.mainTask ?? "").trim()) {
    throw new Error("Draft must contain question and mainTask.");
  }
  const formatAnalysis = analyzeProductFormat(draft?.productFormats);
  const emptyFormatsAllowed = profile.productFormat.optional && !formatAnalysis.source;
  if (!emptyFormatsAllowed && !formatAnalysis.isCanonical) throw new Error("Draft productFormats must use canonical extension-only labels.");
  if (question.formatRequirement && !formatAnalysis.formats.includes(question.formatRequirement)) {
    throw new Error(`Draft must satisfy the reserved office-format coverage requirement: ${question.formatRequirement}.`);
  }
  if (formatAnalysis.formats.length && !Array.isArray(draft?.deliverableRationale)) throw new Error("Draft must include deliverableRationale.");
  for (const format of formatAnalysis.formats) {
    const rationale = draft.deliverableRationale.find((item) => item?.format === format);
    if (!rationale || !String(rationale.user ?? "").trim() || !String(rationale.purpose ?? "").trim() || !String(rationale.whyThisFormat ?? "").trim()) {
      throw new Error(`Draft is missing a complete deliverable rationale for ${format}.`);
    }
  }
  question.draft = structuredClone({
    ...draft,
    productFormats: String(draft?.productFormats ?? "").trim(),
    deliverableRationale: Array.isArray(draft?.deliverableRationale) ? draft.deliverableRationale : [],
  });
  question.state = "DRAFT_READY";
  if (reason !== "initial") question.revisionLog.push({ at: now(), stage: "first-quality-gate", reason });
  appendEvent(question, "draft.recorded", { reason });
  workflow.updatedAt = now();
  return workflow;
}

export function recordFirstQualityGate(workflow, questionIndex, gateOutput) {
  const question = questionAt(workflow, questionIndex);
  requireState(question, ["DRAFT_READY"], "recordFirstQualityGate");
  const result = gateOutput?.firstQaResult ?? gateOutput;
  if (typeof result?.pass !== "boolean" || !Array.isArray(result?.issues)) {
    throw new Error("First quality gate must contain boolean pass and issues array.");
  }
  assertRealQualityGateExecution(workflow, result, "first-quality-gate");
  question.preQaStructureAudit = structuredClone(gateOutput?.preQaStructureAudit ?? {});
  question.firstQaFullResult = structuredClone(result);
  question.firstQaAttempts ??= [];
  question.firstQaAttempts.push({ at: now(), result: structuredClone(result) });
  if (result.pass === true && result.issues.length === 0) {
    question.state = "FIRST_QA_PASS";
    appendEvent(question, "first-qa.passed");
  } else {
    question.firstQaFailureCount += 1;
    question.state = question.firstQaFailureCount >= MAX_FIRST_QA_FAILURES
      ? "ABANDONED_RESAMPLE_REQUIRED"
      : "FIRST_QA_REPAIR_REQUIRED";
    question.revisionLog.push({ at: now(), stage: "first-quality-gate", issues: structuredClone(result.issues) });
    appendEvent(question, question.state === "ABANDONED_RESAMPLE_REQUIRED" ? "first-qa.abandoned" : "first-qa.repair-required", {
      failureCount: question.firstQaFailureCount,
    });
  }
  workflow.updatedAt = now();
  return workflow;
}

export function recordSecondLanguageGate(workflow, questionIndex, result) {
  const question = questionAt(workflow, questionIndex);
  const profile = resolveProductionProfile(workflow);
  requireState(question, ["FIRST_QA_PASS", "SECOND_QA_REWRITE_REQUIRED"], "recordSecondLanguageGate");
  const conclusion = result?.conclusion;
  if (!String(result?.modifiedQuestion ?? "").trim()) throw new Error("Second language gate must include the complete modifiedQuestion.");
  assertRealQualityGateExecution(workflow, result, "second-language-gate");
  if (["通过", "需语言小修"].includes(conclusion)) {
    const findings = [...evaluateNarrativeHardRules(result.modifiedQuestion, {
      minimumExplanatoryParentheses: profile.language.minimumExplanatoryParentheses,
      forbidSemicolon: profile.language.forbidSemicolon,
    })];
    if (profile.language.requireContinuityAudit && result.execution?.provider === "codex-session") {
      const selfCheck = result.secondPromptSelfCheck;
      const requiredTrue = ["atLeastThreeMeaningfulParentheses", "productParagraphReferenceLogic", "narrativeFlowReviewed"];
      const requiredFalse = ["semicolonUsed", "overTwoEnumerationCommas", "commaDisguisedList", "labelParentheses", "overloadedParallelSentence", "bannedProblemRatherThan", "bannedSomeSome", "mechanicalDepartmentOpposition"];
      for (const key of requiredTrue) if (selfCheck?.[key] !== true) findings.push({ rule: `second-prompt-self-check-${key}` });
      for (const key of requiredFalse) if (selfCheck?.[key] !== false) findings.push({ rule: `second-prompt-self-check-${key}` });
    } else if (profile.language.requireContinuityAudit) {
      findings.push(...validateContinuityAudit(result.modifiedQuestion, result.continuityAudit));
    }
    if (findings.length) {
      throw new Error(`Second language gate cannot pass the connected plain-narrative policy: ${findings.map((item) => item.rule).join(", ")}.`);
    }
  }
  if (["通过", "需语言小修"].includes(conclusion)) question.state = "SECOND_QA_PASS";
  else if (conclusion === "需重写题面") question.state = "SECOND_QA_REWRITE_REQUIRED";
  else if (conclusion === "退回第一道质检") question.state = "FIRST_QA_REPAIR_REQUIRED";
  else throw new Error(`Unsupported second language gate conclusion: ${conclusion}`);
  question.secondQaFullResult = structuredClone(result);
  question.secondQaAttempts ??= [];
  question.secondQaAttempts.push({ at: now(), result: structuredClone(result) });
  if (conclusion !== "通过") question.revisionLog.push({ at: now(), stage: "second-language-gate", conclusion });
  appendEvent(question, `second-qa.${question.state.toLowerCase().replaceAll("_", "-")}`);
  workflow.updatedAt = now();
  return workflow;
}

export function recordDeAiRewrite(workflow, questionIndex, result) {
  const question = questionAt(workflow, questionIndex);
  requireState(question, ["SECOND_QA_PASS"], "recordDeAiRewrite");
  const sourceQuestion = String(question.secondQaFullResult?.modifiedQuestion ?? "").trim();
  const rewrittenQuestion = String(result?.rewrite?.question ?? "").trim();
  if (result?.kind !== "de-ai-question-rewrite"
    || !["mugua-openai-compatible", "external-rewrite-api"].includes(result?.provider)) {
    throw new Error("De-AI rewrite must come from an approved external rewrite provider.");
  }
  if (result?.validation?.pass !== true || !rewrittenQuestion) {
    throw new Error("De-AI rewrite must contain a passing validated question.");
  }
  if (result.sourceQuestionHash !== sha256(sourceQuestion)) {
    throw new Error("De-AI rewrite is not bound to the second-gate question.");
  }
  if (result.rewrittenQuestionHash !== sha256(rewrittenQuestion)) {
    throw new Error("De-AI rewrite output hash does not match the rewritten question.");
  }
  question.deAiRewrite = structuredClone(result);
  question.state = "DE_AI_REWRITE_PASS";
  appendEvent(question, "de-ai-rewrite.passed", {
    policyId: result.policyId,
    selectedAttempt: result.selectedAttempt,
  });
  workflow.updatedAt = now();
  return workflow;
}

export function recordFinalRecord(workflow, questionIndex, { recordUid, finalRecord } = {}) {
  const question = questionAt(workflow, questionIndex);
  const profile = resolveProductionProfile(workflow);
  requireState(question, profile.id === "l1" ? ["DE_AI_REWRITE_PASS"] : ["SECOND_QA_PASS", "DE_AI_REWRITE_PASS"], "recordFinalRecord");
  if (!String(recordUid ?? "").trim() || !finalRecord || typeof finalRecord !== "object") {
    throw new Error("Final compilation requires recordUid and finalRecord.");
  }
  const frozenQuestion = question.deAiRewrite?.rewrite?.question ?? question.secondQaFullResult.modifiedQuestion;
  if (finalRecord.题目 !== frozenQuestion) {
    throw new Error("Final question must exactly match the validated de-AI rewrite, or the second gate when no rewrite is required.");
  }
  const finalFormats = analyzeProductFormat(finalRecord.产物格式);
  const draftFormats = analyzeProductFormat(question.draft.productFormats);
  const bothFormatsEmpty = profile.productFormat.optional && !finalFormats.source && !draftFormats.source;
  if (!bothFormatsEmpty && (!finalFormats.isCanonical || finalFormats.canonical !== draftFormats.canonical)) {
    throw new Error("Final product formats must exactly match the formats selected before drafting.");
  }
  question.recordUid = recordUid;
  question.finalRecord = structuredClone(finalRecord);
  question.state = "COMPLETE";
  appendEvent(question, "final.completed");
  workflow.updatedAt = now();
  return workflow;
}

export function buildProductionTrace(workflow) {
  if (workflow.questions.some((question) => question.state !== "COMPLETE")) {
    throw new Error("Production trace cannot be finalized while any question is incomplete.");
  }
  const profile = resolveProductionProfile(workflow);
  return {
    schemaVersion: 3,
    kind: profile.traceKind,
    productionProfile: profile.id,
    protocolId: workflow.protocolId,
    runId: workflow.runId,
    generatedAt: now(),
    questions: workflow.questions.map((question) => ({
      recordUid: question.recordUid,
      referenceLocation: question.referenceLocation,
      referenceQuestionStructure: Object.fromEntries([
        "businessScene", "coreBlockage", "mainTask", "attachmentSupport",
        "deliverableOrigin", "imitableStructure", "forbiddenReuse",
      ].map((key) => [key, question.referenceBreakdown[key]])),
      referenceAttachmentStructure: question.referenceBreakdown.referenceAttachmentStructure,
      newQuestionStructureMapping: question.attachmentPlan.newQuestionStructureMapping ?? question.draft.structureMapping,
      newAttachmentSupport: question.attachmentPlan.newAttachmentSupport,
      attachmentBuild: structuredClone(question.attachmentPlan),
      formatRequirement: question.formatRequirement,
      draftedProductFormats: question.draft.productFormats,
      deliverableRationale: structuredClone(question.draft.deliverableRationale),
      preQaStructureAudit: question.preQaStructureAudit,
      firstQaFullResult: question.firstQaFullResult,
      firstQaRepairs: question.firstQaAttempts.filter((attempt) => attempt.result.pass !== true),
      secondQaFullResult: question.secondQaFullResult,
      deAiRewrite: question.deAiRewrite ?? null,
      revisionLog: question.revisionLog,
      finalRecord: question.finalRecord,
      workflowEvents: question.events,
    })),
  };
}

export async function saveProductionWorkflow(filePath, workflow) {
  await writeJsonAtomic(filePath, workflow);
  return workflow;
}

export async function loadProductionWorkflow(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
