import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { evaluateAttachmentSemantics } from "./attachment-semantic-rules.mjs";
import {
  assertNonPlaceholderSourceUrl,
  verifyProductionEvidence,
} from "./production-evidence.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(targetPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requireSafeRelativePath(value, label) {
  const relativePath = String(value ?? "").trim();
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must stay inside attachmentRoot.`);
  }
  return normalized;
}

export function validateAttachmentConfig(value, { allowDevelopmentFixtures = false } = {}) {
  if (!path.isAbsolute(String(value?.attachmentRoot ?? ""))) {
    throw new Error("attachmentRoot must be an absolute path.");
  }
  if (!Array.isArray(value?.attachments) || value.attachments.length < 1) {
    throw new Error("attachments must contain at least one real file.");
  }
  const names = new Set();
  for (const [index, attachment] of value.attachments.entries()) {
    const label = `attachments[${index}]`;
    const name = String(attachment?.name ?? "").trim();
    if (!name || name !== path.basename(name)) throw new Error(`${label}.name must be a filename without directories.`);
    if (names.has(name)) throw new Error(`Duplicate attachment name: ${name}.`);
    names.add(name);
    const relativePath = requireSafeRelativePath(attachment?.relativePath ?? attachment?.localPath, `${label}.relativePath`);
    if (path.basename(relativePath) !== name) throw new Error(`${label}.name must match the relative-path basename.`);
    if (!/^[a-f0-9]{64}$/u.test(String(attachment?.sha256 ?? "").trim().toLowerCase())) {
      throw new Error(`${label}.sha256 must be a complete SHA-256 digest.`);
    }
    if (!allowDevelopmentFixtures) assertNonPlaceholderSourceUrl(attachment?.sourceUrl, `${label}.sourceUrl`);
    else if (!/^https?:\/\//iu.test(String(attachment?.sourceUrl ?? "").trim())) throw new Error(`${label}.sourceUrl must be an HTTP(S) source URL.`);
  }
  const semantic = evaluateAttachmentSemantics({ attachments: value.attachments }, {
    allowEmpty: false,
    maximumAttachments: null,
    minimumSpecificBusinessShare: 0.8,
  });
  if (semantic.findings.length) {
    throw new Error(`Attachment semantics failed: ${semantic.findings.map((item) => item.rule).join(", ")}.`);
  }
  if (!value.attachments.some((attachment) => attachment.classification === "specific-business")) {
    throw new Error("At least one specific-business attachment is required.");
  }
  if (!Array.isArray(value.initialAttachmentNames ?? []) && value.initialAttachmentNames != null) {
    throw new Error("initialAttachmentNames must be an array when provided.");
  }
  const allNames = value.attachments.map((attachment) => String(attachment.name).trim());
  const initialAttachmentNames = value.initialAttachmentNames == null
    ? [...allNames]
    : value.initialAttachmentNames.map((name) => String(name ?? "").trim());
  if (initialAttachmentNames.length < 1 || initialAttachmentNames.some((name) => !name)) {
    throw new Error("initialAttachmentNames must contain at least one filename.");
  }
  if (new Set(initialAttachmentNames).size !== initialAttachmentNames.length) {
    throw new Error("initialAttachmentNames must not contain duplicates.");
  }
  const unknownInitialNames = initialAttachmentNames.filter((name) => !allNames.includes(name));
  if (unknownInitialNames.length) {
    throw new Error(`initialAttachmentNames contains unknown files: ${unknownInitialNames.join(", ")}.`);
  }
  if (!value.attachments.some((attachment) =>
    initialAttachmentNames.includes(String(attachment.name).trim())
      && attachment.classification === "specific-business")) {
    throw new Error("The initial attachment set must contain a specific-business file.");
  }
  return {
    attachmentRoot: path.resolve(value.attachmentRoot),
    attachments: value.attachments.map((attachment) => ({
      ...attachment,
      name: String(attachment.name).trim(),
      relativePath: requireSafeRelativePath(attachment.relativePath ?? attachment.localPath, "attachment.relativePath"),
      sha256: String(attachment.sha256).trim().toLowerCase(),
    })),
    initialAttachmentNames,
    semantic,
  };
}

async function verifyOneAttachment(rootRealPath, attachment) {
  const joined = path.resolve(rootRealPath, attachment.relativePath);
  if (!isInside(joined, rootRealPath)) throw new Error(`Attachment path escaped attachmentRoot: ${attachment.name}.`);
  const fileInfo = await lstat(joined);
  if (fileInfo.isSymbolicLink()) throw new Error(`Attachment symlinks are not allowed: ${attachment.name}.`);
  if (!fileInfo.isFile()) throw new Error(`Attachment is not a regular file: ${attachment.name}.`);
  const resolved = await realpath(joined);
  if (!isInside(resolved, rootRealPath)) throw new Error(`Attachment real path escaped attachmentRoot: ${attachment.name}.`);
  const bytes = await readFile(resolved);
  if (!bytes.length) throw new Error(`Attachment is empty: ${attachment.name}.`);
  const actualHash = sha256(bytes);
  if (actualHash !== attachment.sha256) throw new Error(`Attachment SHA-256 mismatch: ${attachment.name}.`);
  if (attachment.sizeBytes != null && Number(attachment.sizeBytes) !== bytes.length) {
    throw new Error(`Attachment byte length mismatch: ${attachment.name}.`);
  }
  return {
    absolutePath: resolved,
    classification: attachment.classification,
    introductionHint: String(attachment.introductionHint ?? "").trim(),
    name: attachment.name,
    relativePath: attachment.relativePath,
    sha256: actualHash,
    sizeBytes: bytes.length,
    sourceUrl: attachment.sourceUrl,
    summary: String(attachment.summary ?? "").trim(),
  };
}

export async function prepareJobAttachments(value) {
  const allowDevelopmentFixtures = value?.mode === "scripted" && value?.developmentOnlyScripted === true;
  const validated = validateAttachmentConfig(value, { allowDevelopmentFixtures });
  const rootInfo = await lstat(validated.attachmentRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("attachmentRoot must be a real directory, not a symlink.");
  }
  const rootRealPath = await realpath(validated.attachmentRoot);
  const attachments = [];
  for (const attachment of validated.attachments) {
    attachments.push(await verifyOneAttachment(rootRealPath, attachment));
  }
  const productionEvidence = await verifyProductionEvidence(value, validated.attachments, { allowDevelopmentFixtures });
  return {
    attachments,
    receipt: {
      attachmentCount: attachments.length,
      attachments: attachments.map(({ absolutePath: _absolutePath, ...item }) => item),
      initialAttachmentNames: [...validated.initialAttachmentNames],
      minimumSpecificBusinessShare: 0.8,
      pass: true,
      policyId: "doubao-l1-l2-attachment-policy-v1",
      productionEvidence,
      specificBusinessShare: validated.semantic.specificShare,
      verifiedAt: new Date().toISOString(),
    },
    rootRealPath,
    source: validated,
  };
}

export function selectPreparedAttachments(manifest, names) {
  const requestedNames = Array.isArray(names) ? names.map((name) => String(name ?? "").trim()) : [];
  if (new Set(requestedNames).size !== requestedNames.length) {
    throw new Error("A round attachment set must not contain duplicate filenames.");
  }
  const byName = new Map(manifest.attachments.map((attachment) => [attachment.name, attachment]));
  const unknown = requestedNames.filter((name) => !byName.has(name));
  if (unknown.length) throw new Error(`Unknown round attachments: ${unknown.join(", ")}.`);
  return requestedNames.map((name) => byName.get(name));
}

export async function verifyPreparedAttachments(manifest, { names = null } = {}) {
  const rootRealPath = await realpath(manifest.rootRealPath);
  if (rootRealPath !== manifest.rootRealPath) throw new Error("attachmentRoot changed after preparation.");
  const selected = names == null
    ? manifest.source.attachments
    : selectPreparedAttachments({ attachments: manifest.source.attachments }, names);
  const verified = [];
  for (const attachment of selected) {
    verified.push(await verifyOneAttachment(rootRealPath, attachment));
  }
  return {
    attachmentCount: verified.length,
    attachments: verified.map(({ absolutePath: _absolutePath, ...item }) => item),
    pass: true,
    verifiedAt: new Date().toISOString(),
  };
}
