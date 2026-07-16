import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  NATURALNESS_GATE_ID,
  NATURALNESS_METRICS_VERSION,
  QUESTION_LANGUAGE_POLICY_ID,
  evaluateNaturalnessRows,
  resolveNaturalnessBaseline,
  runNaturalnessGate,
  verifyNaturalnessReviewRequest,
  verifyNaturalnessReviewSignoff,
} from "./naturalness_gate.mjs";
import {
  loadStructuralDiversityPolicy,
  parseTsvRows,
  verifyReceiptRows,
} from "./structure_fingerprint.mjs";
import {
  runStructureGate,
  verifyStructureReviewRequest,
  verifyStructureReviewSignoff,
} from "./structure_gate.mjs";
import {
  SCENE_CARD_GATE_ID,
  SCENE_CARD_PROTOCOL_ID,
  runSceneCardGate,
  verifySceneCardGateReport,
} from "./scene_card.mjs";
import { REPO_ROOT, writeJsonAtomic } from "./run_context.mjs";

export const RELEASE_GATE_ID = "combined-release-gate-v2";
export const RELEASE_RECEIPT_KIND = "release-gate-receipt";
export const RELEASE_SCHEMA_VERSION = 2;

const RELEASE_BOUND_NARRATIVE_COLUMNS = new Set(["B", "G", "L", "N", "O"]);

function updateColumn(update) {
  const address = String(update?.address ?? "").trim().split("!").at(-1) ?? "";
  const fromAddress = address.replace(/\$/gu, "").match(/^([A-Z]+)/iu)?.[1]?.toUpperCase() ?? "";
  if (fromAddress) return fromAddress;
  return String(update?.column ?? "").trim().toUpperCase();
}

function normalizedUpdateAddress(update) {
  return String(update?.address ?? "")
    .trim()
    .split("!")
    .at(-1)
    ?.replace(/\$/gu, "")
    .toUpperCase() ?? "";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function naturalnessEvaluationProjection(value) {
  return {
    status: value?.status,
    ok: value?.ok,
    reviewRequired: value?.reviewRequired,
    blocked: value?.blocked,
    summary: value?.summary,
    rows: value?.rows ?? [],
    batch: value?.batch,
  };
}

function structureReceiptProjection(receipt) {
  return {
    schemaVersion: receipt?.schemaVersion,
    ok: receipt?.ok,
    status: receipt?.status,
    policyId: receipt?.policyId,
    policyVersion: receipt?.policyVersion,
    gateStatus: receipt?.gateStatus ?? "PASS",
    authorizationMode: receipt?.authorizationMode,
    reviewAuthorization: receipt?.reviewAuthorization ?? null,
    reportPath: receipt?.reportPath,
    reportHash: receipt?.reportHash,
    batchHash: receipt?.batchHash,
    rowHashes: receipt?.rowHashes ?? [],
  };
}

async function verifyCurrentNaturalnessReport({ candidatePath, baselinePath, reportPath }) {
  const [candidateText, baselineText, report, candidateHash, baselineHash, reportHash] = await Promise.all([
    fs.readFile(candidatePath, "utf8"),
    fs.readFile(baselinePath, "utf8"),
    readJson(reportPath),
    sha256File(candidatePath),
    sha256File(baselinePath),
    sha256File(reportPath),
  ]);
  if (report.kind !== "naturalness-gate-report" || report.gateId !== NATURALNESS_GATE_ID) {
    throw new Error("Naturalness report kind or gateId is invalid.");
  }
  if (report.metricsVersion !== NATURALNESS_METRICS_VERSION) {
    throw new Error("Naturalness report metrics version is invalid.");
  }
  if (report.questionLanguagePolicyId !== QUESTION_LANGUAGE_POLICY_ID) {
    throw new Error("Naturalness report question-language policy is invalid.");
  }
  if (path.resolve(report.candidatePath) !== path.resolve(candidatePath)) {
    throw new Error("Naturalness report candidatePath mismatch.");
  }
  if (path.resolve(report.baselinePath) !== path.resolve(baselinePath)) {
    throw new Error("Naturalness report baselinePath mismatch.");
  }
  if (report.candidateHash !== candidateHash) throw new Error("Naturalness candidate hash mismatch.");
  if (report.baselineHash !== baselineHash) throw new Error("Naturalness baseline hash mismatch.");

  const baseline = resolveNaturalnessBaseline(JSON.parse(baselineText));
  const evaluation = evaluateNaturalnessRows(parseTsvRows(candidateText), baseline);
  if (stableHash(naturalnessEvaluationProjection(report)) !== stableHash(naturalnessEvaluationProjection(evaluation))) {
    throw new Error("Naturalness report evaluation does not match the current candidate and baseline.");
  }
  if (report.baselineId !== baseline.baselineId || report.baselineSampleCount !== baseline.sampleCount) {
    throw new Error("Naturalness report baseline metadata mismatch.");
  }
  if (stableHash(report.effectiveThresholds) !== stableHash(baseline.thresholds)) {
    throw new Error("Naturalness report effective thresholds mismatch.");
  }
  return { report, reportHash, candidateHash, baselineHash, evaluation };
}

function roleConsistencyRowBindingsHash(report) {
  return stableHash((report?.rows ?? []).map((row) => ({
    uid: row?.uid ?? "",
    status: row?.status,
    ok: row?.ok,
    sceneCardHash: row?.sceneCardHash ?? "",
  })));
}

async function verifyCurrentRoleConsistencyReport({ candidatePath, sceneCardPath, reportPath }) {
  const verification = await verifySceneCardGateReport({
    candidatePath,
    sceneCardPath,
    reportPath,
  });
  if (!verification?.ok) {
    const details = verification?.errors?.length
      ? verification.errors.join("; ")
      : "report is not a current PASS evaluation";
    throw new Error(`Role-consistency report validation failed: ${details}`);
  }
  const report = verification.report ?? await readJson(reportPath);
  const [reportHash, candidateHash, sceneCardFileHash] = await Promise.all([
    sha256File(reportPath),
    sha256File(candidatePath),
    sha256File(sceneCardPath),
  ]);
  if (report.gateId !== SCENE_CARD_GATE_ID || report.protocolId !== SCENE_CARD_PROTOCOL_ID) {
    throw new Error("Role-consistency report gate or protocol is stale.");
  }
  if (report.status !== "PASS" || report.ok !== true) {
    throw new Error("Role-consistency report is not PASS.");
  }
  if (path.resolve(report.candidatePath) !== path.resolve(candidatePath)) {
    throw new Error("Role-consistency report candidatePath mismatch.");
  }
  if (path.resolve(report.sceneCardPath) !== path.resolve(sceneCardPath)) {
    throw new Error("Role-consistency report sceneCardPath mismatch.");
  }
  if (report.candidateHash !== candidateHash) throw new Error("Role-consistency candidate hash mismatch.");
  if (report.sceneCardFileHash !== sceneCardFileHash) throw new Error("Role-consistency scene-card hash mismatch.");
  return {
    report,
    reportHash,
    candidateHash,
    sceneCardFileHash,
    rowBindingsHash: roleConsistencyRowBindingsHash(report),
    rows: verification.rows ?? report.rows ?? [],
  };
}

async function runRoleConsistencyPhase({ candidatePath, sceneCardPath, reportPath }) {
  const generated = await runSceneCardGate({ candidatePath, sceneCardPath, reportPath });
  const report = generated?.report ?? generated;
  if (report?.status !== "PASS" || report?.ok !== true) {
    return {
      authorized: false,
      report,
      status: report?.status ?? "FAIL",
    };
  }
  const current = await verifyCurrentRoleConsistencyReport({ candidatePath, sceneCardPath, reportPath });
  return { ...current, authorized: true, status: "PASS" };
}

function naturalnessAuthorizationFrom({ request, requestPath, requestHash, signoff, signoffPath, signoffHash }) {
  return {
    status: "APPROVED",
    decision: "APPROVE",
    verified: true,
    requestPath: path.resolve(requestPath),
    requestHash,
    signoffPath: path.resolve(signoffPath),
    signoffHash,
    requestId: request.requestId,
    bindingHash: request.bindingHash,
    requestedBy: request.requestedBy,
    reviewer: String(signoff.reviewer).trim(),
    reviewedAt: signoff.reviewedAt,
    rationaleHash: stableHash(String(signoff.rationale).trim()),
  };
}

async function verifyNaturalnessApproval({
  candidatePath,
  baselinePath,
  reportPath,
  requestPath,
  signoffPath,
}) {
  if (!requestPath || !signoffPath || path.resolve(requestPath) === path.resolve(signoffPath)) {
    throw new Error("Naturalness review request and signoff must be separate files.");
  }
  const [request, signoff, requestHash, signoffHash] = await Promise.all([
    readJson(requestPath),
    readJson(signoffPath),
    sha256File(requestPath),
    sha256File(signoffPath),
  ]);
  const requestCheck = await verifyNaturalnessReviewRequest(request, {
    candidatePath,
    baselinePath,
    reportPath,
  });
  if (!requestCheck.ok) {
    throw new Error(`Naturalness review request validation failed: ${requestCheck.errors.join("; ")}`);
  }
  const signoffCheck = verifyNaturalnessReviewSignoff(request, signoff, { requestHash });
  if (!signoffCheck.approved) {
    const details = signoffCheck.errors.length ? signoffCheck.errors.join("; ") : "decision is not APPROVE";
    throw new Error(`Naturalness review signoff is not an independent approval: ${details}`);
  }
  return {
    request,
    signoff,
    authorization: naturalnessAuthorizationFrom({
      request,
      requestPath,
      requestHash,
      signoff,
      signoffPath,
      signoffHash,
    }),
  };
}

async function resolveNaturalnessPhase({
  candidatePath,
  baselinePath,
  reportPath,
  reviewRequestPath,
  reviewSignoffPath,
  reviewRequester,
}) {
  const signoffExists = await fileExists(reviewSignoffPath);
  let current = null;
  if (await fileExists(reportPath)) {
    try {
      current = await verifyCurrentNaturalnessReport({ candidatePath, baselinePath, reportPath });
      if (current.report.status === "REVIEW") {
        if (!(await fileExists(reviewRequestPath))) {
          throw new Error("Naturalness REVIEW report has no pending review request.");
        }
        const request = await readJson(reviewRequestPath);
        const requestCheck = await verifyNaturalnessReviewRequest(request, {
          candidatePath,
          baselinePath,
          reportPath,
        });
        if (!requestCheck.ok) throw new Error(requestCheck.errors.join("; "));
      }
    } catch (error) {
      if (signoffExists) {
        throw new Error(`Cannot reuse signed naturalness review artifacts: ${error?.message || String(error)}`);
      }
      current = null;
    }
  }

  if (!current) {
    if (signoffExists) {
      throw new Error("A naturalness signoff exists without a current hash-bound REVIEW report and request.");
    }
    await runNaturalnessGate({
      candidatePath,
      baselinePath,
      reportPath,
      reviewRequestPath,
      reviewRequester,
    });
    current = await verifyCurrentNaturalnessReport({ candidatePath, baselinePath, reportPath });
  }

  if (current.report.status === "FAIL") {
    return { ...current, authorized: false, authorizationMode: "BLOCKED_FAIL", reviewAuthorization: null };
  }
  if (current.report.status === "PASS") {
    return { ...current, authorized: true, authorizationMode: "DIRECT_PASS", reviewAuthorization: null };
  }
  if (!signoffExists) {
    return { ...current, authorized: false, authorizationMode: "PENDING_REVIEW", reviewAuthorization: null };
  }
  const approval = await verifyNaturalnessApproval({
    candidatePath,
    baselinePath,
    reportPath,
    requestPath: reviewRequestPath,
    signoffPath: reviewSignoffPath,
  });
  return {
    ...current,
    authorized: true,
    authorizationMode: "INDEPENDENT_REVIEW",
    reviewAuthorization: approval.authorization,
    reviewRequest: approval.request,
    reviewSignoff: approval.signoff,
  };
}

async function verifyStructureArtifacts({ receipt, candidatePath }) {
  const reportPath = receipt.reportPath;
  const [report, reportHash, candidateHash] = await Promise.all([
    readJson(reportPath),
    sha256File(reportPath),
    sha256File(candidatePath),
  ]);
  if (receipt.reportHash !== reportHash) throw new Error("Structure report hash mismatch.");
  if (path.resolve(report.candidatePath) !== path.resolve(candidatePath)) {
    throw new Error("Structure report candidatePath mismatch.");
  }
  if (report.candidateHash !== candidateHash) throw new Error("Structure candidate hash mismatch.");
  if (report.fillPlanPath && report.fillPlanHash !== await sha256File(report.fillPlanPath)) {
    throw new Error("Structure fill-plan hash mismatch.");
  }
  if (report.passportPath && report.passportHash !== await sha256File(report.passportPath)) {
    throw new Error("Structure passport hash mismatch.");
  }
  const gateStatus = receipt.gateStatus ?? "PASS";
  if (gateStatus === "PASS") {
    if (
      report.status !== "PASS" ||
      report.ok !== true ||
      receipt.reviewAuthorization != null ||
      report.reviewAuthorization != null
    ) {
      throw new Error("Structure receipt is not bound to a direct PASS report.");
    }
    return { report, reportHash };
  }
  if (gateStatus !== "REVIEW" || report.status !== "REVIEW" || report.ok !== false) {
    throw new Error("Structure REVIEW receipt is not bound to a blocking REVIEW report.");
  }
  const authorization = receipt.reviewAuthorization;
  if (stableHash(report.reviewAuthorization) !== stableHash(authorization)) {
    throw new Error("Structure review authorization differs between report and receipt.");
  }
  const [request, signoff, requestHash, signoffHash] = await Promise.all([
    readJson(authorization.requestPath),
    readJson(authorization.signoffPath),
    sha256File(authorization.requestPath),
    sha256File(authorization.signoffPath),
  ]);
  if (requestHash !== authorization.requestHash) throw new Error("Structure review request hash mismatch.");
  if (signoffHash !== authorization.signoffHash) throw new Error("Structure review signoff hash mismatch.");
  const requestCheck = await verifyStructureReviewRequest(request, {
    candidatePath: report.candidatePath,
    passportPath: report.passportPath,
    fillPlanPath: report.fillPlanPath,
    reportPath,
  });
  if (!requestCheck.ok) throw new Error(`Structure review request validation failed: ${requestCheck.errors.join("; ")}`);
  const signoffCheck = verifyStructureReviewSignoff(request, signoff, { requestHash });
  if (!signoffCheck.approved) {
    const details = signoffCheck.errors.length ? signoffCheck.errors.join("; ") : "decision is not APPROVE";
    throw new Error(`Structure review signoff is not an independent approval: ${details}`);
  }
  const authorizationMatches =
    authorization.status === "APPROVED" &&
    authorization.decision === "APPROVE" &&
    authorization.verified === true &&
    authorization.requestId === request.requestId &&
    authorization.bindingHash === request.bindingHash &&
    authorization.evaluationHash === request.evaluationHash &&
    authorization.requestedBy === request.requestedBy &&
    authorization.reviewer === String(signoff.reviewer).trim() &&
    authorization.reviewedAt === signoff.reviewedAt &&
    authorization.rationaleHash === stableHash(String(signoff.rationale).trim());
  if (!authorizationMatches) {
    throw new Error("Structure review authorization metadata does not match its request and signoff.");
  }
  return { report, reportHash, request, signoff };
}

function releaseReceiptFrom({
  structureReceipt,
  structureReceiptPath,
  structureReceiptHash,
  naturalness,
  roleConsistency,
  candidatePath,
  baselinePath,
  naturalnessReportPath,
  sceneCardPath,
  roleConsistencyReportPath,
}) {
  const naturalnessBlock = {
    gateId: NATURALNESS_GATE_ID,
    metricsVersion: NATURALNESS_METRICS_VERSION,
    questionLanguagePolicyId: QUESTION_LANGUAGE_POLICY_ID,
    status: naturalness.report.status,
    authorizationMode: naturalness.authorizationMode,
    reportPath: path.resolve(naturalnessReportPath),
    reportHash: naturalness.reportHash,
    candidatePath: path.resolve(candidatePath),
    candidateHash: naturalness.candidateHash,
    baselinePath: path.resolve(baselinePath),
    baselineHash: naturalness.baselineHash,
    reviewAuthorization: naturalness.reviewAuthorization,
  };
  const roleConsistencyBlock = {
    gateId: SCENE_CARD_GATE_ID,
    protocolId: SCENE_CARD_PROTOCOL_ID,
    status: roleConsistency.report.status,
    reportPath: path.resolve(roleConsistencyReportPath),
    reportHash: roleConsistency.reportHash,
    candidatePath: path.resolve(candidatePath),
    candidateHash: roleConsistency.candidateHash,
    sceneCardPath: path.resolve(sceneCardPath),
    sceneCardFileHash: roleConsistency.sceneCardFileHash,
    sceneCardSetHash: roleConsistency.report.sceneCardSetHash,
    sceneCardBundleHash: roleConsistency.report.sceneCardBundleHash,
    factLedgerPath: roleConsistency.report.factLedgerPath,
    factLedgerHash: roleConsistency.report.factLedgerHash,
    evaluationHash: roleConsistency.report.evaluationHash,
    rowBindingsHash: roleConsistency.rowBindingsHash,
  };
  return {
    ...structureReceipt,
    kind: RELEASE_RECEIPT_KIND,
    releaseSchemaVersion: RELEASE_SCHEMA_VERSION,
    releaseGateId: RELEASE_GATE_ID,
    generatedAt: new Date().toISOString(),
    structure: {
      receiptPath: path.resolve(structureReceiptPath),
      receiptHash: structureReceiptHash,
      reportPath: structureReceipt.reportPath,
      reportHash: structureReceipt.reportHash,
      gateStatus: structureReceipt.gateStatus ?? "PASS",
      authorizationMode: structureReceipt.authorizationMode,
    },
    naturalness: naturalnessBlock,
    roleConsistency: roleConsistencyBlock,
  };
}

async function rowsBoundByReleaseReceipt(receipt) {
  const report = await readJson(receipt.reportPath);
  if (report.fillPlanPath) {
    const plan = await readJson(report.fillPlanPath);
    if (Array.isArray(plan.rows) && plan.rows.length) return plan.rows;
  }
  return parseTsvRows(await fs.readFile(report.candidatePath, "utf8"));
}

export async function verifyReleaseReceipt({ receiptPath, rows = [], policyPath } = {}) {
  try {
    if (!receiptPath) throw new Error("verifyReleaseReceipt requires receiptPath.");
    const receipt = await readJson(receiptPath);
    if (receipt.kind !== RELEASE_RECEIPT_KIND) {
      throw new Error("Receipt is not a combined release-gate receipt.");
    }
    if (receipt.releaseGateId !== RELEASE_GATE_ID || receipt.releaseSchemaVersion !== RELEASE_SCHEMA_VERSION) {
      throw new Error("Release receipt is stale and historical-only; issue a current v2 receipt.");
    }
    if (receipt.status !== "PASS" || receipt.ok !== true) {
      throw new Error("Release receipt is not PASS.");
    }
    const policy = await loadStructuralDiversityPolicy(policyPath);
    const effectiveRows = rows.length ? rows : await rowsBoundByReleaseReceipt(receipt);
    const releaseRowCheck = verifyReceiptRows(receipt, effectiveRows, policy);
    if (!releaseRowCheck.ok) throw new Error(`Release row binding failed: ${releaseRowCheck.errors.join("; ")}`);

    const structureReceiptPath = receipt.structure?.receiptPath;
    if (!structureReceiptPath || path.resolve(structureReceiptPath) === path.resolve(receiptPath)) {
      throw new Error("Release receipt must bind a separate structure receipt file.");
    }
    const [structureReceipt, structureReceiptHash] = await Promise.all([
      readJson(structureReceiptPath),
      sha256File(structureReceiptPath),
    ]);
    if (structureReceipt.kind === RELEASE_RECEIPT_KIND) throw new Error("Nested structure receipt cannot be a release receipt.");
    if (structureReceiptHash !== receipt.structure.receiptHash) throw new Error("Structure receipt hash mismatch.");
    if (stableHash(structureReceiptProjection(receipt)) !== stableHash(structureReceiptProjection(structureReceipt))) {
      throw new Error("Release receipt structural projection does not match the bound structure receipt.");
    }
    const structureRowCheck = verifyReceiptRows(structureReceipt, effectiveRows, policy);
    if (!structureRowCheck.ok) throw new Error(`Structure row binding failed: ${structureRowCheck.errors.join("; ")}`);

    const naturalness = receipt.naturalness;
    if (!naturalness || naturalness.gateId !== NATURALNESS_GATE_ID) {
      throw new Error("Release receipt has no naturalness binding.");
    }
    if (naturalness.metricsVersion !== NATURALNESS_METRICS_VERSION
      || naturalness.questionLanguagePolicyId !== QUESTION_LANGUAGE_POLICY_ID) {
      throw new Error("Release receipt naturalness language policy is stale.");
    }
    const currentNaturalness = await verifyCurrentNaturalnessReport({
      candidatePath: naturalness.candidatePath,
      baselinePath: naturalness.baselinePath,
      reportPath: naturalness.reportPath,
    });
    if (currentNaturalness.reportHash !== naturalness.reportHash) throw new Error("Naturalness report hash mismatch.");
    if (currentNaturalness.candidateHash !== naturalness.candidateHash) throw new Error("Release candidate hash mismatch.");
    if (currentNaturalness.baselineHash !== naturalness.baselineHash) throw new Error("Release baseline hash mismatch.");
    if (currentNaturalness.report.status !== naturalness.status) throw new Error("Naturalness status mismatch.");
    if (path.resolve(naturalness.candidatePath) !== path.resolve((await readJson(structureReceipt.reportPath)).candidatePath)) {
      throw new Error("Naturalness and structure gates do not bind the same candidate.");
    }

    if (naturalness.status === "PASS") {
      if (naturalness.authorizationMode !== "DIRECT_PASS" || naturalness.reviewAuthorization != null) {
        throw new Error("Naturalness PASS has an invalid authorization mode.");
      }
    } else if (naturalness.status === "REVIEW") {
      if (naturalness.authorizationMode !== "INDEPENDENT_REVIEW" || !naturalness.reviewAuthorization) {
        throw new Error("Naturalness REVIEW lacks independent approval metadata.");
      }
      const approval = await verifyNaturalnessApproval({
        candidatePath: naturalness.candidatePath,
        baselinePath: naturalness.baselinePath,
        reportPath: naturalness.reportPath,
        requestPath: naturalness.reviewAuthorization.requestPath,
        signoffPath: naturalness.reviewAuthorization.signoffPath,
      });
      if (stableHash(approval.authorization) !== stableHash(naturalness.reviewAuthorization)) {
        throw new Error("Naturalness review authorization metadata mismatch.");
      }
    } else {
      throw new Error("Naturalness FAIL cannot appear in a release receipt.");
    }

    const roleConsistency = receipt.roleConsistency;
    if (!roleConsistency
      || roleConsistency.gateId !== SCENE_CARD_GATE_ID
      || roleConsistency.protocolId !== SCENE_CARD_PROTOCOL_ID) {
      throw new Error("Release receipt has no current role-consistency binding.");
    }
    if (roleConsistency.status !== "PASS") {
      throw new Error("Role-consistency FAIL cannot appear in a release receipt.");
    }
    const currentRoleConsistency = await verifyCurrentRoleConsistencyReport({
      candidatePath: roleConsistency.candidatePath,
      sceneCardPath: roleConsistency.sceneCardPath,
      reportPath: roleConsistency.reportPath,
    });
    if (currentRoleConsistency.reportHash !== roleConsistency.reportHash) {
      throw new Error("Role-consistency report hash mismatch.");
    }
    if (currentRoleConsistency.candidateHash !== roleConsistency.candidateHash) {
      throw new Error("Role-consistency candidate hash mismatch.");
    }
    if (currentRoleConsistency.sceneCardFileHash !== roleConsistency.sceneCardFileHash) {
      throw new Error("Role-consistency scene-card hash mismatch.");
    }
    if (currentRoleConsistency.rowBindingsHash !== roleConsistency.rowBindingsHash) {
      throw new Error("Role-consistency row binding mismatch.");
    }
    const roleReport = currentRoleConsistency.report;
    for (const field of [
      "sceneCardSetHash",
      "sceneCardBundleHash",
      "factLedgerPath",
      "factLedgerHash",
      "evaluationHash",
    ]) {
      if (roleConsistency[field] !== roleReport[field]) {
        throw new Error(`Role-consistency ${field} mismatch.`);
      }
    }
    if (path.resolve(roleConsistency.candidatePath) !== path.resolve(naturalness.candidatePath)
      || roleConsistency.candidateHash !== naturalness.candidateHash) {
      throw new Error("Naturalness and role-consistency gates do not bind the same candidate.");
    }

    const structureArtifacts = await verifyStructureArtifacts({
      receipt: structureReceipt,
      candidatePath: naturalness.candidatePath,
    });
    if (
      receipt.structure.reportPath !== structureReceipt.reportPath ||
      receipt.structure.reportHash !== structureArtifacts.reportHash ||
      receipt.structure.gateStatus !== (structureReceipt.gateStatus ?? "PASS") ||
      receipt.structure.authorizationMode !== structureReceipt.authorizationMode
    ) {
      throw new Error("Release structure metadata mismatch.");
    }
    return {
      ok: true,
      errors: [],
      receipt,
      policy,
      rows: effectiveRows,
      naturalnessReport: currentNaturalness.report,
      roleConsistencyReport: currentRoleConsistency.report,
      structureReceipt,
      structureReport: structureArtifacts.report,
    };
  } catch (error) {
    return { ok: false, errors: [error?.message || String(error)] };
  }
}

export async function verifyReleaseReceiptUpdates({ receiptPath, updates = [], policyPath } = {}) {
  const release = await verifyReleaseReceipt({ receiptPath, policyPath });
  if (!release.ok) return { ...release, matchedUpdates: [] };

  const errors = [];
  if (!Array.isArray(updates)) {
    return {
      ...release,
      ok: false,
      errors: ["Release-bound updates must be an array."],
      matchedUpdates: [],
    };
  }

  const releasedByAddress = new Map();
  for (const row of release.rows) {
    for (const update of Array.isArray(row?.updates) ? row.updates : []) {
      if (!RELEASE_BOUND_NARRATIVE_COLUMNS.has(updateColumn(update))) continue;
      const address = normalizedUpdateAddress(update);
      if (!address) continue;
      if (releasedByAddress.has(address)) {
        errors.push(`Release-bound fill plan contains duplicate narrative address: ${address}`);
        continue;
      }
      releasedByAddress.set(address, update);
    }
  }

  const matchedUpdates = [];
  const seen = new Set();
  for (const update of updates) {
    if (!RELEASE_BOUND_NARRATIVE_COLUMNS.has(updateColumn(update))) continue;
    const address = normalizedUpdateAddress(update);
    if (!/^[BGLNO][1-9]\d*$/u.test(address)) {
      errors.push(`Narrative update has an invalid address: ${address || "(missing)"}`);
      continue;
    }
    const explicitColumn = String(update?.column ?? "").trim().toUpperCase();
    if (explicitColumn && explicitColumn !== address.match(/^[A-Z]+/u)?.[0]) {
      errors.push(`Narrative update column mismatch at ${address}.`);
      continue;
    }
    if (seen.has(address)) {
      errors.push(`Narrative update address is duplicated: ${address}`);
      continue;
    }
    seen.add(address);

    const expected = releasedByAddress.get(address);
    if (!expected) {
      errors.push(`Narrative update is not bound by the release receipt: ${address}`);
      continue;
    }
    const actualField = String(update?.field ?? "");
    if (!actualField || actualField !== String(expected.field ?? "")) {
      errors.push(`Narrative update field mismatch at ${address}.`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(update ?? {}, "value")) {
      errors.push(`Narrative update value is missing at ${address}.`);
      continue;
    }
    if (String(update.value ?? "") !== String(expected.value ?? "")) {
      errors.push(`Narrative update value mismatch at ${address}.`);
      continue;
    }
    matchedUpdates.push({
      address,
      field: actualField,
      value: String(update.value ?? ""),
    });
  }

  return {
    ...release,
    ok: errors.length === 0,
    errors,
    matchedUpdates,
  };
}

export async function runReleaseGate({
  candidatePath,
  baselinePath,
  naturalnessReportPath,
  naturalnessReviewRequestPath = "",
  naturalnessReviewSignoffPath = "",
  naturalnessReviewRequester = "release-gate-naturalness-requester",
  sceneCardPath,
  roleConsistencyReportPath,
  passportPath = "",
  fillPlanPath = "",
  structureReportPath,
  structureReceiptPath,
  structureReviewRequestPath = "",
  structureReviewSignoffPath = "",
  structureReviewRequester = "release-gate-structure-requester",
  releaseReceiptPath,
  registryPath,
  policyPath,
} = {}) {
  if (releaseReceiptPath) await fs.rm(releaseReceiptPath, { force: true });
  if (!candidatePath || !baselinePath || !naturalnessReportPath || !structureReportPath
    || !sceneCardPath || !roleConsistencyReportPath || !structureReceiptPath || !releaseReceiptPath) {
    throw new Error("runReleaseGate requires candidate, baseline, naturalness/role-consistency/structure reports, sceneCardPath, structureReceiptPath, and releaseReceiptPath.");
  }
  const roleConsistency = await runRoleConsistencyPhase({
    candidatePath,
    sceneCardPath,
    reportPath: roleConsistencyReportPath,
  });
  if (!roleConsistency.authorized) {
    return {
      ok: false,
      phase: "role-consistency",
      status: roleConsistency.status,
      naturalnessReport: null,
      roleConsistencyReport: roleConsistency.report,
      structureReport: null,
      receipt: null,
    };
  }

  const reviewRequestPath = naturalnessReviewRequestPath || `${naturalnessReportPath}.review-request.json`;
  const naturalness = await resolveNaturalnessPhase({
    candidatePath,
    baselinePath,
    reportPath: naturalnessReportPath,
    reviewRequestPath,
    reviewSignoffPath: naturalnessReviewSignoffPath,
    reviewRequester: naturalnessReviewRequester,
  });
  if (!naturalness.authorized) {
    return {
      ok: false,
      phase: "naturalness",
      status: naturalness.report.status,
      naturalnessReport: naturalness.report,
      roleConsistencyReport: roleConsistency.report,
      structureReport: null,
      receipt: null,
      reviewRequestPath: naturalness.report.status === "REVIEW" ? path.resolve(reviewRequestPath) : "",
    };
  }

  const structure = await runStructureGate({
    candidatePath,
    passportPath,
    fillPlanPath,
    reportPath: structureReportPath,
    receiptPath: structureReceiptPath,
    reviewRequestPath: structureReviewRequestPath,
    reviewSignoffPath: structureReviewSignoffPath,
    reviewRequester: structureReviewRequester,
    registryPath,
    policyPath,
  });
  if (!structure.receipt) {
    return {
      ok: false,
      phase: "structure",
      status: structure.report.status,
      naturalnessReport: naturalness.report,
      roleConsistencyReport: roleConsistency.report,
      structureReport: structure.report,
      receipt: null,
    };
  }

  const structureReceiptHash = await sha256File(structureReceiptPath);
  const releaseReceipt = releaseReceiptFrom({
    structureReceipt: structure.receipt,
    structureReceiptPath,
    structureReceiptHash,
    naturalness,
    roleConsistency,
    candidatePath,
    baselinePath,
    naturalnessReportPath,
    sceneCardPath,
    roleConsistencyReportPath,
  });
  await writeJsonAtomic(releaseReceiptPath, releaseReceipt);
  const fillPlan = fillPlanPath ? await readJson(fillPlanPath) : null;
  const verification = await verifyReleaseReceipt({
    receiptPath: releaseReceiptPath,
    rows: fillPlan?.rows ?? [],
    policyPath,
  });
  if (!verification.ok) {
    await fs.rm(releaseReceiptPath, { force: true });
    throw new Error(`New release receipt failed verification: ${verification.errors.join("; ")}`);
  }
  return {
    ok: true,
    phase: "release",
    status: "PASS",
    naturalnessReport: naturalness.report,
    roleConsistencyReport: roleConsistency.report,
    structureReport: structure.report,
    structureReceipt: structure.receipt,
    receipt: releaseReceipt,
    releaseReceiptPath: path.resolve(releaseReceiptPath),
  };
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const sceneCardArgument = args["scene-card"] || args["scene-card-manifest"];
  const missing = [
    "candidate",
    "baseline",
    "naturalness-report",
    ...(sceneCardArgument ? [] : ["scene-card"]),
    "role-consistency-report",
    "structure-report",
    "structure-receipt",
    "release-receipt",
  ].filter((name) => !args[name]);
  if (missing.length) throw new Error(`Missing required release-gate arguments: ${missing.join(", ")}`);
  const result = await runReleaseGate({
    candidatePath: resolveFromRoot(args.candidate),
    baselinePath: resolveFromRoot(args.baseline),
    naturalnessReportPath: resolveFromRoot(args["naturalness-report"]),
    naturalnessReviewRequestPath: args["naturalness-review-request"] ? resolveFromRoot(args["naturalness-review-request"]) : "",
    naturalnessReviewSignoffPath: args["naturalness-review-signoff"] ? resolveFromRoot(args["naturalness-review-signoff"]) : "",
    naturalnessReviewRequester: args["naturalness-review-requester"] || "release-gate-naturalness-requester",
    sceneCardPath: resolveFromRoot(sceneCardArgument),
    roleConsistencyReportPath: resolveFromRoot(args["role-consistency-report"]),
    passportPath: args.passport ? resolveFromRoot(args.passport) : "",
    fillPlanPath: args["fill-plan"] ? resolveFromRoot(args["fill-plan"]) : "",
    structureReportPath: resolveFromRoot(args["structure-report"]),
    structureReceiptPath: resolveFromRoot(args["structure-receipt"]),
    structureReviewRequestPath: args["structure-review-request"] ? resolveFromRoot(args["structure-review-request"]) : "",
    structureReviewSignoffPath: args["structure-review-signoff"] ? resolveFromRoot(args["structure-review-signoff"]) : "",
    structureReviewRequester: args["structure-review-requester"] || "release-gate-structure-requester",
    releaseReceiptPath: resolveFromRoot(args["release-receipt"]),
    registryPath: args.registry ? resolveFromRoot(args.registry) : undefined,
    policyPath: args.policy ? resolveFromRoot(args.policy) : undefined,
  });
  if (!result.ok) process.exitCode = result.status === "REVIEW" ? 2 : 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
