import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const PLACEHOLDER_HOST = /(?:^|\.)(?:example(?:\.(?:com|net|org|cn))?|test|invalid|localhost)$/iu;
const PLACEHOLDER_TEXT = /(?:replace-with|placeholder|example\.(?:com|net|org|cn)|\.example(?:\/|$))/iu;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedHash(value) {
  return String(value ?? "").trim().toLowerCase();
}

function requireHash(value, label) {
  const hash = normalizedHash(value);
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`${label} must be a complete SHA-256 digest.`);
  return hash;
}

function validDate(value) {
  return Boolean(String(value ?? "").trim()) && Number.isFinite(Date.parse(String(value)));
}

export function assertNonPlaceholderSourceUrl(value, label = "sourceUrl") {
  const source = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) source URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must be a valid HTTP(S) source URL.`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (PLACEHOLDER_HOST.test(hostname) || PLACEHOLDER_TEXT.test(source)) {
    throw new Error(`${label} uses a placeholder or reserved source domain.`);
  }
  return parsed.toString();
}

export function validateProductionEvidenceConfig(value, { allowDevelopmentFixtures = false } = {}) {
  if (allowDevelopmentFixtures && value?.productionEvidence == null) {
    return { mode: "development-fixture" };
  }
  const evidence = value?.productionEvidence;
  if (!evidence || typeof evidence !== "object") {
    throw new Error("productionEvidence is required and must come from the L1/L2 production path.");
  }
  const recordUid = String(evidence.recordUid ?? "").trim();
  if (!recordUid) throw new Error("productionEvidence.recordUid is required.");
  const paths = {};
  for (const key of [
    "productionTracePath",
    "productionTraceGateReceiptPath",
    "releaseGateReceiptPath",
    "downloadManifestPath",
  ]) {
    const filePath = String(evidence[key] ?? "").trim();
    if (!path.isAbsolute(filePath)) throw new Error(`productionEvidence.${key} must be an absolute path.`);
    paths[key] = path.resolve(filePath);
  }
  return {
    mode: "production-path",
    recordUid,
    ...paths,
  };
}

async function readEvidenceJson(filePath, label) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular JSON file.`);
  const resolved = await realpath(filePath);
  const bytes = await readFile(resolved);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  return { bytes, hash: sha256(bytes), path: resolved, value };
}

export async function hydrateJobAttachmentsFromProductionTrace(value) {
  if (value?.mode === "scripted" && value?.developmentOnlyScripted === true) return structuredClone(value);
  if (Array.isArray(value?.attachments) && value.attachments.length) {
    throw new Error("Live Doubao job attachments must be compiled from productionEvidence; hand-written attachment arrays are forbidden.");
  }
  const evidence = validateProductionEvidenceConfig(value);
  const traceFile = await readEvidenceJson(evidence.productionTracePath, "production trace");
  const trace = traceFile.value;
  if (trace?.kind !== "l1-production-trace" || trace?.productionProfile !== "l1") {
    throw new Error("Doubao production jobs require an L1 production trace from the shared L1/L2 production path.");
  }
  const question = (trace.questions ?? []).find((item) => String(item?.recordUid ?? "").trim() === evidence.recordUid);
  if (!question) throw new Error("productionEvidence.recordUid is absent from the production trace.");
  const traceAttachments = question?.attachmentBuild?.attachments;
  if (!Array.isArray(traceAttachments) || traceAttachments.length < 1) {
    throw new Error("The selected production-trace record has no L2-grade attachments.");
  }
  const attachments = traceAttachments.map((attachment) => ({
    ...structuredClone(attachment),
    relativePath: String(attachment?.name ?? "").trim(),
    sizeBytes: Number(attachment?.bytes ?? attachment?.sizeBytes),
  }));
  return {
    ...structuredClone(value),
    _attachmentsHydratedFromProductionEvidence: true,
    _productionTraceHash: traceFile.hash,
    attachments,
  };
}

function compareAttachmentField(jobAttachment, traceAttachment, field) {
  const left = field === "sha256"
    ? normalizedHash(jobAttachment?.[field])
    : String(jobAttachment?.[field] ?? "").trim();
  const right = field === "sha256"
    ? normalizedHash(traceAttachment?.[field])
    : String(traceAttachment?.[field] ?? "").trim();
  if (left !== right) throw new Error(`Attachment ${jobAttachment.name} does not match production trace field ${field}.`);
}

function verifyTraceAttachment(jobAttachment, traceAttachment) {
  for (const field of ["name", "sourceUrl", "sha256", "summary", "classification", "timeAnchor"]) {
    compareAttachmentField(jobAttachment, traceAttachment, field);
  }
  if (jobAttachment.objectLevel !== traceAttachment.objectLevel) {
    throw new Error(`Attachment ${jobAttachment.name} does not match production trace field objectLevel.`);
  }
  for (const key of ["object", "periodOrEvent", "uniqueContent"]) {
    const jobValue = String(jobAttachment?.specificityEvidence?.[key] ?? "").trim();
    const traceValue = String(traceAttachment?.specificityEvidence?.[key] ?? "").trim();
    if (jobValue !== traceValue) {
      throw new Error(`Attachment ${jobAttachment.name} does not match production trace specificityEvidence.${key}.`);
    }
  }
  const traceBytes = Number(traceAttachment.bytes ?? traceAttachment.sizeBytes);
  if (!Number.isInteger(traceBytes) || traceBytes < 1) {
    throw new Error(`Attachment ${jobAttachment.name} has no valid byte length in the production trace.`);
  }
  if (Number(jobAttachment.sizeBytes) !== traceBytes) {
    throw new Error(`Attachment ${jobAttachment.name} byte length does not match the production trace.`);
  }
}

function verifyDownloadItem(jobAttachment, item) {
  if (!item) throw new Error(`Attachment ${jobAttachment.name} is absent from the L2 download manifest.`);
  if (normalizedHash(item.sha256) !== normalizedHash(jobAttachment.sha256)) {
    throw new Error(`Attachment ${jobAttachment.name} hash does not match the L2 download manifest.`);
  }
  if (String(item.url ?? "").trim() !== String(jobAttachment.sourceUrl).trim()) {
    throw new Error(`Attachment ${jobAttachment.name} source URL does not match the L2 download manifest.`);
  }
  if (Number(item.size ?? item.bytes) !== Number(jobAttachment.sizeBytes)) {
    throw new Error(`Attachment ${jobAttachment.name} byte length does not match the L2 download manifest.`);
  }
  if (!String(item.contentType ?? "").trim()) {
    throw new Error(`Attachment ${jobAttachment.name} has no content type in the L2 download manifest.`);
  }
  assertNonPlaceholderSourceUrl(item.finalUrl ?? item.url, `downloadManifest.${jobAttachment.name}.finalUrl`);
}

export async function verifyProductionEvidence(value, attachments, { allowDevelopmentFixtures = false } = {}) {
  const config = validateProductionEvidenceConfig(value, { allowDevelopmentFixtures });
  if (config.mode === "development-fixture") {
    return {
      mode: "development-fixture",
      pass: true,
      policyId: "development-fixture-only-v1",
      verifiedAt: new Date().toISOString(),
    };
  }

  const [traceFile, traceReceiptFile, releaseReceiptFile, downloadManifestFile] = await Promise.all([
    readEvidenceJson(config.productionTracePath, "production trace"),
    readEvidenceJson(config.productionTraceGateReceiptPath, "production trace gate receipt"),
    readEvidenceJson(config.releaseGateReceiptPath, "release gate receipt"),
    readEvidenceJson(config.downloadManifestPath, "download manifest"),
  ]);
  const trace = traceFile.value;
  const traceReceipt = traceReceiptFile.value;
  const releaseReceipt = releaseReceiptFile.value;
  const downloadManifest = downloadManifestFile.value;

  if (trace?.kind !== "l1-production-trace" || trace?.productionProfile !== "l1") {
    throw new Error("Doubao production jobs require an L1 production trace from the shared L1/L2 production path.");
  }
  if (traceReceipt?.status !== "PASS" || traceReceipt?.kind !== "l1-production-trace-gate-receipt") {
    throw new Error("The L1 production trace gate receipt must be PASS.");
  }
  if (requireHash(traceReceipt.traceHash, "production trace gate receipt traceHash") !== traceFile.hash) {
    throw new Error("The production trace gate receipt is not bound to the supplied production trace.");
  }
  if (releaseReceipt?.kind !== "release-gate-receipt" || releaseReceipt?.status !== "PASS" || releaseReceipt?.ok !== true) {
    throw new Error("The shared production release gate receipt must be PASS.");
  }
  const rowUids = new Set((releaseReceipt.rowHashes ?? []).map((item) => String(item?.uid ?? "").trim()));
  if (!rowUids.has(config.recordUid)) {
    throw new Error("productionEvidence.recordUid is absent from the release gate receipt.");
  }
  const releaseCandidateHash = normalizedHash(releaseReceipt?.naturalness?.candidateHash);
  if (!releaseCandidateHash || releaseCandidateHash !== normalizedHash(traceReceipt.candidateHash)) {
    throw new Error("Release and production-trace receipts are not bound to the same candidate batch.");
  }
  if (!validDate(downloadManifest?.generatedAt) || !Array.isArray(downloadManifest?.items)) {
    throw new Error("The L2 download manifest is missing generatedAt or items.");
  }

  const question = (trace.questions ?? []).find((item) => String(item?.recordUid ?? "").trim() === config.recordUid);
  if (!question) throw new Error("productionEvidence.recordUid is absent from the production trace.");
  const traceAttachments = question?.attachmentBuild?.attachments;
  if (!Array.isArray(traceAttachments) || traceAttachments.length < 1) {
    throw new Error("The selected production-trace record has no L2-grade attachments.");
  }
  const traceByName = new Map(traceAttachments.map((item) => [String(item?.name ?? "").trim(), item]));
  const jobNames = new Set(attachments.map((item) => item.name));
  if (traceByName.size !== traceAttachments.length || jobNames.size !== attachments.length
    || traceByName.size !== jobNames.size || [...jobNames].some((name) => !traceByName.has(name))) {
    throw new Error("Job attachments must exactly match the attachment set signed by the production trace.");
  }
  const manifestByName = new Map(downloadManifest.items.map((item) => [String(item?.name ?? "").trim(), item]));
  for (const attachment of attachments) {
    assertNonPlaceholderSourceUrl(attachment.sourceUrl, `attachments.${attachment.name}.sourceUrl`);
    verifyTraceAttachment(attachment, traceByName.get(attachment.name));
    verifyDownloadItem(attachment, manifestByName.get(attachment.name));
  }

  return {
    attachmentCount: attachments.length,
    downloadManifestHash: downloadManifestFile.hash,
    downloadManifestPath: downloadManifestFile.path,
    mode: "production-path",
    pass: true,
    policyId: "reuse-l2-source-acquisition-path-v1",
    productionRunId: trace.runId,
    productionTraceGateReceiptHash: traceReceiptFile.hash,
    productionTraceGateReceiptPath: traceReceiptFile.path,
    productionTraceHash: traceFile.hash,
    productionTracePath: traceFile.path,
    recordUid: config.recordUid,
    releaseGateReceiptHash: releaseReceiptFile.hash,
    releaseGateReceiptPath: releaseReceiptFile.path,
    verifiedAt: new Date().toISOString(),
  };
}
