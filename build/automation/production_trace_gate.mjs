import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseTsvRows } from "./structure_fingerprint.mjs";
import { writeJsonAtomic } from "./run_context.mjs";
import { evaluateNarrativeHardRules, validateContinuityAudit } from "./narrative_language_rules.mjs";
import { evaluateAttachmentSemantics } from "./attachment_semantic_rules.mjs";
import { buildFormatCoverageAssignments, evaluateProductFormatBatch } from "./product_format_diversity.mjs";
import { analyzeProductFormat } from "./product_format.mjs";
import { evaluateProductionRecordProfile, resolveProductionProfile } from "./production_profile.mjs";
import { isAllowedLevel1Category } from "./production_taxonomy.mjs";

export const PRODUCTION_TRACE_GATE_ID = "production-trace-gate-v6-profiled";
const LEGACY_PRODUCTION_TRACE_GATE_IDS = new Set(["l2-production-trace-gate-v5-real-quality-gates"]);
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
const ALL_RECORD_FIELDS = [
  "题目", "任务类型", "一级目录", "二级目录", "三级目录", "任务概括",
  "标注专家工作年限", "人类完成时间", "相关附件", "附件格式", "附件内容",
  "产物格式", "产物内容", "做题关键步骤",
];
const REQUIRED_NARRATIVE_PLAN_FIELDS = ["题目", "任务概括", "附件内容", "产物内容", "做题关键步骤"];
const STRUCTURE_KEYS = [
  "businessScene", "coreBlockage", "mainTask", "attachmentSupport",
  "deliverableOrigin", "imitableStructure", "forbiddenReuse",
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function readBoundJson(filePath) {
  const text = await fs.readFile(path.resolve(filePath), "utf8");
  return { value: JSON.parse(text), hash: sha256(text), path: path.resolve(filePath) };
}

function fillPlanRecord(row) {
  return Object.fromEntries((row?.updates ?? []).map((update) => [String(update.field ?? ""), String(update.value ?? "")]));
}

function inside(targetPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function urls(value = "") {
  return new Set(String(value).match(/https?:\/\/[^\s）)]+/giu) ?? []);
}

function validateLanguage(question, findings, uid, profile) {
  if (/问题不在于.{0,80}而是|有的.{0,80}有的/u.test(question)) findings.push({ uid, rule: "second-gate-banned-frame" });
  for (const finding of evaluateNarrativeHardRules(question, {
    minimumExplanatoryParentheses: profile.language.minimumExplanatoryParentheses,
    forbidSemicolon: profile.language.forbidSemicolon,
  })) findings.push({ uid, ...finding });
}

async function validateQualityGateExecution({ result, stage, expectedPromptHash, uid, qaRoot, findings, profile }) {
  const execution = result?.execution;
  if (!execution || !SUPPORTED_QUALITY_GATE_RUNNER_IDS.has(execution.runnerId)) {
    findings.push({ uid, rule: `${stage}-real-execution-missing` });
    return;
  }
  if (!SUPPORTED_QUALITY_GATE_PROVIDERS.has(execution.provider) || !String(execution.model ?? "").trim()) {
    findings.push({ uid, rule: `${stage}-model-provenance-missing` });
  }
  const developmentCodexSession = profile.runMode === "development-codex-session"
    && execution.runnerId === "exact-two-quality-gates-v2-codex-session"
    && execution.provider === "codex-session";
  if (profile.id === "l1" && !developmentCodexSession && (execution.runnerId !== "exact-two-quality-gates-v3-model-router"
    || !["codex-model", "third-party-openai-compatible"].includes(execution.provider))) {
    findings.push({ uid, rule: `${stage}-legacy-provider-not-allowed-for-l1` });
  }
  if (execution.sourcePromptHash !== expectedPromptHash) {
    findings.push({ uid, rule: `${stage}-source-prompt-hash-mismatch`, expected: expectedPromptHash, actual: execution.sourcePromptHash ?? "" });
  }
  if (!String(execution.rawResponsePath ?? "").trim() || !inside(execution.rawResponsePath, qaRoot)) {
    findings.push({ uid, rule: `${stage}-raw-response-path-invalid` });
    return;
  }
  try {
    const text = await fs.readFile(path.resolve(execution.rawResponsePath), "utf8");
    if (sha256(text) !== execution.rawResponseHash) {
      findings.push({ uid, rule: `${stage}-raw-response-hash-mismatch` });
      return;
    }
    const raw = JSON.parse(text);
    if (!SUPPORTED_QUALITY_GATE_RUNNER_IDS.has(raw.runnerId) || raw.runnerId !== execution.runnerId || raw.sourcePromptHash !== expectedPromptHash) {
      findings.push({ uid, rule: `${stage}-raw-response-binding-mismatch` });
    }
    const parsed = stage === "first-quality-gate"
      ? raw.parsed
      : raw.attempts?.[Number(raw.acceptedRound ?? 0) - 1]?.parsed;
    if (!parsed) {
      findings.push({ uid, rule: `${stage}-raw-parsed-result-missing` });
    } else if (stage === "first-quality-gate") {
      if (parsed.pass !== result.pass || JSON.stringify(parsed.issues) !== JSON.stringify(result.issues)) {
        findings.push({ uid, rule: `${stage}-raw-result-mismatch` });
      }
    } else if (parsed.conclusion !== result.conclusion || parsed.modifiedQuestion !== result.modifiedQuestion) {
      findings.push({ uid, rule: `${stage}-raw-result-mismatch` });
    }
  } catch (error) {
    findings.push({ uid, rule: `${stage}-raw-response-unreadable`, message: error.message });
  }
}

export async function runProductionTraceGate({ packetPath, tracePath, candidatePath, fillPlanPath, reportPath, receiptPath, attachmentRoot = "" } = {}) {
  const [packetBound, traceBound, candidateText, fillPlanBound] = await Promise.all([
    readBoundJson(packetPath),
    readBoundJson(tracePath),
    fs.readFile(path.resolve(candidatePath), "utf8"),
    readBoundJson(fillPlanPath),
  ]);
  const packet = packetBound.value;
  const profile = resolveProductionProfile(packet);
  const validationProfile = { ...profile, runMode: packet.runMode || "production-api" };
  const trace = traceBound.value;
  const candidateRows = parseTsvRows(candidateText);
  const candidateByUid = new Map(candidateRows.map((row) => [String(row.UID), row]));
  const fillPlanRows = fillPlanBound.value?.rows ?? [];
  const fillPlanByUid = new Map(fillPlanRows.map((row, index) => {
    const record = fillPlanRecord(row);
    const uid = record.UID || String(candidateRows[index]?.UID ?? "");
    return [uid, { row, record: { ...record, UID: uid } }];
  }));
  const sampleByIndex = new Map(packet.inputs.referenceWorkbook.samples.map((sample) => [Number(sample.questionIndex), sample]));
  const findings = [];
  const attachmentBindings = [];
  const resolvedAttachmentRoot = path.resolve(attachmentRoot || path.join(path.dirname(packetBound.path), "..", "attachments"));
  if (packet.status !== "READY") findings.push({ rule: "input-packet-not-ready", status: packet.status });
  if (packet.kind !== profile.packetKind) findings.push({ rule: "input-packet-profile-kind-mismatch", expected: profile.packetKind, actual: packet.kind });
  if (trace.kind && trace.kind !== profile.traceKind) findings.push({ rule: "trace-profile-kind-mismatch", expected: profile.traceKind, actual: trace.kind });
  if (trace.protocolId !== packet.protocolId) findings.push({ rule: "protocol-id-mismatch" });
  if (!Array.isArray(trace.questions) || trace.questions.length !== packet.questionCount) {
    findings.push({ rule: "trace-question-count", expected: packet.questionCount, actual: trace.questions?.length ?? 0 });
  }
  if (candidateRows.length !== packet.questionCount) {
    findings.push({ rule: "candidate-question-count", expected: packet.questionCount, actual: candidateRows.length });
  }
  if (fillPlanRows.length !== packet.questionCount) {
    findings.push({ rule: "fill-plan-question-count", expected: packet.questionCount, actual: fillPlanRows.length });
  }
  if (candidateByUid.size !== candidateRows.length) findings.push({ rule: "candidate-uid-not-unique" });
  if (fillPlanByUid.size !== fillPlanRows.length || fillPlanByUid.has("")) findings.push({ rule: "fill-plan-uid-missing-or-not-unique" });
  const tracedUids = new Set((trace.questions ?? []).map((item) => String(item.recordUid ?? "")));
  const formatRequirements = profile.productFormat.requireBatchCoverage
    ? buildFormatCoverageAssignments(packet.questionCount, { seed: packet.runId ?? trace.runId ?? "" })
    : Array.from({ length: packet.questionCount }, () => null);
  const requiredRecordFields = profile.id === "l1"
    ? ALL_RECORD_FIELDS.filter((field) => field !== "产物格式")
    : ALL_RECORD_FIELDS;
  if (tracedUids.size !== (trace.questions ?? []).length || tracedUids.has("")) findings.push({ rule: "trace-uid-missing-or-not-unique" });
  for (const uid of candidateByUid.keys()) if (!tracedUids.has(uid)) findings.push({ uid, rule: "candidate-row-not-traced" });
  for (const uid of fillPlanByUid.keys()) if (!tracedUids.has(uid)) findings.push({ uid, rule: "fill-plan-row-not-traced" });
  for (const [index, item] of (trace.questions ?? []).entries()) {
    const uid = String(item.recordUid ?? "");
    const sample = sampleByIndex.get(index + 1);
    const record = item.finalRecord;
    if (!isAllowedLevel1Category(record?.一级目录)) {
      findings.push({ uid, rule: "level1-category-not-from-feishu-options", actual: String(record?.一级目录 ?? "") });
    }
    const expectedFormatRequirement = formatRequirements[index];
    if ((item.formatRequirement ?? null) !== expectedFormatRequirement) {
      findings.push({ uid, rule: "format-coverage-requirement-mismatch", expected: expectedFormatRequirement, actual: item.formatRequirement ?? null });
    }
    if (!sample || item.referenceLocation?.sheet !== sample.sheet || Number(item.referenceLocation?.row) !== Number(sample.row)) {
      findings.push({ uid, rule: "reference-sample-mismatch" });
    }
    for (const key of STRUCTURE_KEYS) {
      if (!String(item.referenceQuestionStructure?.[key] ?? "").trim()) findings.push({ uid, rule: `missing-structure-${key}` });
    }
    if (!String(item.referenceAttachmentStructure ?? "").trim()) findings.push({ uid, rule: "missing-reference-attachment-structure" });
    if (!String(item.newQuestionStructureMapping ?? "").trim()) findings.push({ uid, rule: "missing-new-structure-mapping" });
    if (!String(item.newAttachmentSupport ?? "").trim()) findings.push({ uid, rule: "missing-new-attachment-support" });
    const sourceUrls = urls(sample?.attachmentSummary);
    const attachments = item.attachmentBuild?.attachments ?? [];
    for (const finding of evaluateAttachmentSemantics(item.attachmentBuild, {
      allowPreservedLegacy: packet.runMode === "managed-record-upgrade-preserve-attachments-v1",
      allowEmpty: profile.attachments.minimum === 0,
      maximumAttachments: profile.attachments.maximum,
      minimumSpecificBusinessShare: profile.attachments.minimumSpecificBusinessShare,
    }).findings) {
      findings.push({ uid, ...finding });
    }
    if (attachments.length < profile.attachments.minimum) findings.push({ uid, rule: "new-attachment-set-below-minimum", expectedMinimum: profile.attachments.minimum, actual: attachments.length });
    if (profile.attachments.maximum != null && attachments.length > profile.attachments.maximum) {
      findings.push({ uid, rule: "new-attachment-set-above-maximum", expectedMaximum: profile.attachments.maximum, actual: attachments.length });
    }
    const preservedLegacyAttachments = packet.runMode === "managed-record-upgrade-preserve-attachments-v1"
      && item.attachmentBuild?.mode === "preserved-existing-verified";
    if (profile.attachments.requireSpecificObjectEvidence && !preservedLegacyAttachments
      && !attachments.some((attachment) => attachment.classification === "specific-business")
      && !String(item.attachmentBuild?.objectSupportInQuestion ?? "").trim()) {
      findings.push({ uid, rule: "specific-business-attachment-missing" });
    }
    for (const attachment of attachments) {
      if (!attachment.name || !attachment.sourceUrl || !attachment.summary || !attachment.classification || !attachment.localPath || !attachment.sha256) {
        findings.push({ uid, rule: "attachment-trace-incomplete", attachment: attachment.name ?? "" });
      }
      if (sourceUrls.has(attachment.sourceUrl)) findings.push({ uid, rule: "reference-attachment-reused", url: attachment.sourceUrl });
      if (/用于支持|为.{0,24}提供依据/u.test(String(attachment.summary ?? ""))) {
        findings.push({ uid, rule: "attachment-summary-contains-purpose-language", attachment: attachment.name ?? "" });
      }
      if (attachment.localPath && attachment.sha256) {
        const localPath = path.resolve(resolvedAttachmentRoot, attachment.localPath);
        if (!inside(localPath, resolvedAttachmentRoot)) {
          findings.push({ uid, rule: "attachment-path-outside-run", attachment: attachment.name ?? "" });
        } else {
          try {
            const bytes = await fs.readFile(localPath);
            const actualHash = sha256(bytes);
            if (!bytes.length) findings.push({ uid, rule: "attachment-file-empty", attachment: attachment.name ?? "" });
            if (actualHash !== attachment.sha256) findings.push({ uid, rule: "attachment-file-hash-mismatch", attachment: attachment.name ?? "" });
            attachmentBindings.push({ uid, name: attachment.name, path: localPath, sha256: actualHash, bytes: bytes.length });
          } catch (error) {
            findings.push({ uid, rule: "attachment-file-missing", attachment: attachment.name ?? "", message: error.message });
          }
        }
      }
    }
    const firstQa = item.firstQaFullResult;
    if (firstQa?.pass !== true || !Array.isArray(firstQa?.issues) || firstQa.issues.length) {
      findings.push({ uid, rule: "first-quality-gate-not-pass" });
    }
    await validateQualityGateExecution({
      result: firstQa,
      stage: "first-quality-gate",
      expectedPromptHash: packet.inputs.firstQaPrompt.sha256,
      uid,
      qaRoot: path.dirname(traceBound.path),
      findings,
      profile: validationProfile,
    });
    const secondQa = item.secondQaFullResult;
    if (!secondQa || !["通过", "需语言小修"].includes(secondQa.conclusion) || !String(secondQa.modifiedQuestion ?? "").trim()) {
      findings.push({ uid, rule: "second-language-gate-not-pass" });
    }
    await validateQualityGateExecution({
      result: secondQa,
      stage: "second-language-gate",
      expectedPromptHash: packet.inputs.secondQaPrompt.sha256,
      uid,
      qaRoot: path.dirname(traceBound.path),
      findings,
      profile: validationProfile,
    });
    if (profile.language.requireContinuityAudit && secondQa?.execution?.provider === "codex-session") {
      const selfCheck = secondQa?.secondPromptSelfCheck;
      const requiredTrue = ["atLeastThreeMeaningfulParentheses", "productParagraphReferenceLogic", "narrativeFlowReviewed"];
      const requiredFalse = ["semicolonUsed", "overTwoEnumerationCommas", "commaDisguisedList", "labelParentheses", "overloadedParallelSentence", "bannedProblemRatherThan", "bannedSomeSome", "mechanicalDepartmentOpposition"];
      for (const key of requiredTrue) if (selfCheck?.[key] !== true) findings.push({ uid, rule: `second-prompt-self-check-${key}` });
      for (const key of requiredFalse) if (selfCheck?.[key] !== false) findings.push({ uid, rule: `second-prompt-self-check-${key}` });
    } else if (profile.language.requireContinuityAudit) {
      for (const finding of validateContinuityAudit(String(secondQa?.modifiedQuestion ?? ""), secondQa?.continuityAudit)) {
        findings.push({ uid, ...finding });
      }
    }
    if (!Array.isArray(item.revisionLog)) findings.push({ uid, rule: "revision-log-missing" });
    if (!record) {
      findings.push({ uid, rule: "final-record-missing" });
      continue;
    }
    for (const field of requiredRecordFields) {
      if (!String(record[field] ?? "").trim()) findings.push({ uid, rule: "final-record-field-missing", field });
    }
    if (profile.id === "l1") {
      for (const finding of evaluateProductionRecordProfile(record, profile).findings) findings.push({ uid, ...finding });
    }
    const deAiRewrite = item.deAiRewrite;
    if (profile.id === "l1") {
      if (deAiRewrite?.kind !== "de-ai-question-rewrite"
        || !["mugua-openai-compatible", "external-rewrite-api"].includes(deAiRewrite?.provider)
        || deAiRewrite?.validation?.pass !== true
        || !String(deAiRewrite?.rewrite?.question ?? "").trim()) {
        findings.push({ uid, rule: "de-ai-rewrite-not-pass" });
      } else {
        if (deAiRewrite.sourceQuestionHash !== sha256(String(secondQa?.modifiedQuestion ?? ""))) {
          findings.push({ uid, rule: "de-ai-source-question-hash-mismatch" });
        }
        if (deAiRewrite.rewrittenQuestionHash !== sha256(String(deAiRewrite.rewrite.question))) {
          findings.push({ uid, rule: "de-ai-rewritten-question-hash-mismatch" });
        }
      }
    }
    const expectedFinalQuestion = deAiRewrite?.rewrite?.question ?? secondQa?.modifiedQuestion;
    if (record.题目 !== expectedFinalQuestion) findings.push({ uid, rule: "quality-chain-final-question-mismatch" });
    const finalFormatAnalysis = analyzeProductFormat(record.产物格式);
    const draftFormatAnalysis = analyzeProductFormat(item.draftedProductFormats);
    const bothFormatsEmpty = profile.productFormat.optional && !draftFormatAnalysis.source && !finalFormatAnalysis.source;
    if (!bothFormatsEmpty && (!draftFormatAnalysis.isCanonical || draftFormatAnalysis.canonical !== finalFormatAnalysis.canonical)) {
      findings.push({ uid, rule: "draft-final-product-format-mismatch", drafted: item.draftedProductFormats ?? "", final: record.产物格式 ?? "" });
    }
    if (expectedFormatRequirement && !finalFormatAnalysis.formats.includes(expectedFormatRequirement)) {
      findings.push({ uid, rule: "reserved-product-format-missing", format: expectedFormatRequirement });
    }
    if (draftFormatAnalysis.formats.length && !Array.isArray(item.deliverableRationale)) findings.push({ uid, rule: "deliverable-rationale-missing" });
    if (/\n\s*\n/u.test(String(record.附件内容 ?? ""))) findings.push({ uid, rule: "attachment-content-blank-line" });
    validateLanguage(String(record.题目 ?? ""), findings, uid, profile);
    const candidate = candidateByUid.get(uid);
    if (!candidate) findings.push({ uid, rule: "candidate-row-missing" });
    else {
      for (const field of ALL_RECORD_FIELDS) {
        if (String(candidate[field] ?? "").trim() !== String(record[field] ?? "").trim()) {
          findings.push({ uid, rule: "candidate-final-record-mismatch", field });
        }
      }
    }
    const planned = fillPlanByUid.get(uid);
    if (!planned) findings.push({ uid, rule: "fill-plan-row-missing" });
    else {
      for (const field of REQUIRED_NARRATIVE_PLAN_FIELDS) {
        if (!(field in planned.record)) findings.push({ uid, rule: "fill-plan-required-narrative-field-missing", field, sheetRow: planned.row.sheetRow });
      }
      for (const field of Object.keys(planned.record).filter((field) => ALL_RECORD_FIELDS.includes(field))) {
        if (String(planned.record[field] ?? "").trim() !== String(record[field] ?? "").trim()) {
          findings.push({ uid, rule: "fill-plan-final-record-mismatch", field, sheetRow: planned.row.sheetRow });
        }
      }
      for (const attachment of attachments) {
        if (!String(record.相关附件 ?? "").includes(String(attachment.name ?? ""))) {
          findings.push({ uid, rule: "final-record-attachment-name-missing", attachment: attachment.name ?? "" });
        }
      }
    }
  }
  const productFormatDiversity = profile.productFormat.requireBatchCoverage
    ? evaluateProductFormatBatch(candidateRows)
    : { policyId: "not-required-for-l1", status: "SKIPPED", rowCount: candidateRows.length, findings: [] };
  for (const finding of productFormatDiversity.findings) findings.push({ scope: "product-format-diversity", ...finding });
  const report = {
    schemaVersion: 1,
    kind: `${profile.id}-production-trace-gate-report`,
    productionProfile: profile.id,
    gateId: PRODUCTION_TRACE_GATE_ID,
    status: findings.length ? "FAIL" : "PASS",
    generatedAt: new Date().toISOString(),
    packetPath: packetBound.path,
    packetHash: packetBound.hash,
    tracePath: traceBound.path,
    traceHash: traceBound.hash,
    candidatePath: path.resolve(candidatePath),
    candidateHash: sha256(candidateText),
    fillPlanPath: fillPlanBound.path,
    fillPlanHash: fillPlanBound.hash,
    rowCount: candidateRows.length,
    attachmentRoot: resolvedAttachmentRoot,
    attachmentBindings,
    productFormatDiversity,
    findings,
  };
  await writeJsonAtomic(reportPath, report);
  if (findings.length) {
    await fs.rm(receiptPath, { force: true });
    return { report, receipt: null };
  }
  const receipt = {
    schemaVersion: 1,
    kind: `${profile.id}-production-trace-gate-receipt`,
    productionProfile: profile.id,
    gateId: PRODUCTION_TRACE_GATE_ID,
    status: "PASS",
    reportPath: path.resolve(reportPath),
    reportHash: sha256(`${JSON.stringify(report, null, 2)}\n`),
    packetHash: packetBound.hash,
    traceHash: traceBound.hash,
    candidateHash: report.candidateHash,
    fillPlanHash: fillPlanBound.hash,
  };
  await writeJsonAtomic(receiptPath, receipt);
  return { report, receipt };
}

export async function verifyProductionTraceReceipt({ receiptPath, fillPlanPath = "" } = {}) {
  const receiptBound = await readBoundJson(receiptPath);
  const receipt = receiptBound.value;
  const kindIsSupported = /^l[12]-production-trace-gate-receipt$/u.test(String(receipt.kind ?? ""));
  const gateIsSupported = receipt.gateId === PRODUCTION_TRACE_GATE_ID || LEGACY_PRODUCTION_TRACE_GATE_IDS.has(receipt.gateId);
  if (!kindIsSupported || !gateIsSupported || receipt.status !== "PASS") {
    throw new Error("Production trace receipt is missing a current PASS binding.");
  }
  const reportText = await fs.readFile(path.resolve(receipt.reportPath), "utf8");
  const report = JSON.parse(reportText);
  if (sha256(reportText) !== receipt.reportHash || report.status !== "PASS" || report.gateId !== receipt.gateId) {
    throw new Error("Production trace report hash or status mismatch.");
  }
  const [packetText, traceText, candidateText, currentFillPlanText] = await Promise.all([
    fs.readFile(report.packetPath, "utf8"),
    fs.readFile(report.tracePath, "utf8"),
    fs.readFile(report.candidatePath, "utf8"),
    fs.readFile(report.fillPlanPath, "utf8"),
  ]);
  if (sha256(packetText) !== receipt.packetHash || sha256(traceText) !== receipt.traceHash
    || sha256(candidateText) !== receipt.candidateHash || sha256(currentFillPlanText) !== receipt.fillPlanHash) {
    throw new Error("Production trace receipt artifacts changed after the gate.");
  }
  for (const attachment of report.attachmentBindings ?? []) {
    const bytes = await fs.readFile(attachment.path);
    if (sha256(bytes) !== attachment.sha256 || bytes.length !== attachment.bytes) {
      throw new Error(`Production attachment changed after the gate: ${attachment.name}`);
    }
  }
  if (fillPlanPath && path.resolve(fillPlanPath) !== path.resolve(report.fillPlanPath)) {
    throw new Error("Production trace receipt is bound to a different fill plan.");
  }
  return { ok: true, receipt, report, receiptPath: receiptBound.path };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    return match ? [match[1], match[2]] : [arg, true];
  }));
  runProductionTraceGate({
    packetPath: args.packet,
    tracePath: args.trace,
    candidatePath: args.candidate,
    fillPlanPath: args["fill-plan"],
    reportPath: args.report,
    receiptPath: args.receipt,
    attachmentRoot: args["attachment-root"] || "",
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.receipt) process.exitCode = 1;
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
