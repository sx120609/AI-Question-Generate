import fs from "node:fs/promises";
import path from "node:path";

import { evaluateNarrativeHardRules, validateContinuityAudit } from "./narrative_language_rules.mjs";
import { evaluateAttachmentSemantics } from "./attachment_semantic_rules.mjs";
import { buildFormatCoverageAssignments } from "./product_format_diversity.mjs";
import { analyzeProductFormat } from "./product_format.mjs";

export const PRODUCTION_WORKFLOW_SCHEMA_VERSION = 3;
export const MAX_FIRST_QA_FAILURES = 2;

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

function now() {
  return new Date().toISOString();
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

export function initializeProductionWorkflow({ packet, runId = packet?.runId ?? "" } = {}) {
  if (packet?.kind !== "l2-production-input-packet" || packet.status !== "READY") {
    throw new Error("Cannot initialize workflow without a READY l2-production-input-packet.");
  }
  const createdAt = now();
  const formatRequirements = buildFormatCoverageAssignments(packet.inputs.referenceWorkbook.samples.length, { seed: runId });
  return {
    schemaVersion: PRODUCTION_WORKFLOW_SCHEMA_VERSION,
    kind: "l2-production-workflow-state",
    protocolId: packet.protocolId,
    runId,
    packetRunId: packet.runId,
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
  if (!Array.isArray(attachmentPlan?.attachments) || !attachmentPlan.attachments.length) {
    throw new Error("Attachment plan must contain at least one attachment.");
  }
  const semanticResult = evaluateAttachmentSemantics(attachmentPlan);
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
  if (!String(draft?.question ?? "").trim() || !String(draft?.mainTask ?? "").trim()) {
    throw new Error("Draft must contain question and mainTask.");
  }
  const formatAnalysis = analyzeProductFormat(draft?.productFormats);
  if (!formatAnalysis.isCanonical) throw new Error("Draft productFormats must use canonical extension-only labels.");
  if (question.formatRequirement && !formatAnalysis.formats.includes(question.formatRequirement)) {
    throw new Error(`Draft must satisfy the reserved office-format coverage requirement: ${question.formatRequirement}.`);
  }
  if (!Array.isArray(draft?.deliverableRationale)) throw new Error("Draft must include deliverableRationale.");
  for (const format of formatAnalysis.formats) {
    const rationale = draft.deliverableRationale.find((item) => item?.format === format);
    if (!rationale || !String(rationale.user ?? "").trim() || !String(rationale.purpose ?? "").trim() || !String(rationale.whyThisFormat ?? "").trim()) {
      throw new Error(`Draft is missing a complete deliverable rationale for ${format}.`);
    }
  }
  question.draft = structuredClone(draft);
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
  requireState(question, ["FIRST_QA_PASS", "SECOND_QA_REWRITE_REQUIRED"], "recordSecondLanguageGate");
  const conclusion = result?.conclusion;
  if (!String(result?.modifiedQuestion ?? "").trim()) throw new Error("Second language gate must include the complete modifiedQuestion.");
  if (["通过", "需语言小修"].includes(conclusion)) {
    const findings = [
      ...evaluateNarrativeHardRules(result.modifiedQuestion),
      ...validateContinuityAudit(result.modifiedQuestion, result.continuityAudit),
    ];
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

export function recordFinalRecord(workflow, questionIndex, { recordUid, finalRecord } = {}) {
  const question = questionAt(workflow, questionIndex);
  requireState(question, ["SECOND_QA_PASS"], "recordFinalRecord");
  if (!String(recordUid ?? "").trim() || !finalRecord || typeof finalRecord !== "object") {
    throw new Error("Final compilation requires recordUid and finalRecord.");
  }
  if (finalRecord.题目 !== question.secondQaFullResult.modifiedQuestion) {
    throw new Error("Final question must exactly match the second-gate modified question.");
  }
  const finalFormats = analyzeProductFormat(finalRecord.产物格式);
  const draftFormats = analyzeProductFormat(question.draft.productFormats);
  if (!finalFormats.isCanonical || finalFormats.canonical !== draftFormats.canonical) {
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
  return {
    schemaVersion: 3,
    kind: "l2-production-trace",
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
