import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  allocateProfiles,
  buildReceipt,
  evaluateDiversity,
  hashNarrativeRow,
  loadStructuralDiversityPolicy,
  parseTsvRows,
  verifyReceiptRows,
} from "./structure_fingerprint.mjs";
import {
  AUTO_RUNS_ROOT,
  REPO_ROOT,
  readJson,
  sanitizeId,
  withLock,
  writeJsonAtomic,
} from "./run_context.mjs";

export const STRUCTURE_REGISTRY_PATH = path.join(AUTO_RUNS_ROOT, "_structure_registry.json");
export const STRUCTURE_REVIEW_GATE_ID = "structure-review-gate-v1";
const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
    else if (arg.startsWith("--")) out[arg.slice(2)] = true;
    else out._.push(arg);
  }
  return out;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

async function sha256File(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function reportReviewSubject(report) {
  const { generatedAt: _generatedAt, reviewAuthorization: _reviewAuthorization, ...subject } = report ?? {};
  return subject;
}

function evaluationProjection(evaluation) {
  return {
    status: evaluation?.status,
    ok: evaluation?.ok,
    reviewRequired: evaluation?.reviewRequired,
    reviewCount: evaluation?.reviewCount,
    fingerprints: evaluation?.fingerprints ?? [],
    findings: evaluation?.findings ?? [],
    nearest: evaluation?.nearest ?? [],
  };
}

function structureReviewBindingHash({
  policyId,
  policyVersion,
  candidateHash,
  passportHash,
  fillPlanHash,
  reportSubjectHash,
  evaluationHash,
  requestedBy,
}) {
  return crypto.createHash("sha256").update([
    STRUCTURE_REVIEW_GATE_ID,
    policyId,
    policyVersion,
    candidateHash,
    passportHash,
    fillPlanHash,
    reportSubjectHash,
    evaluationHash,
    requestedBy,
  ].join("\n")).digest("hex");
}

export function buildStructureReviewRequest({
  report,
  reportPath,
  candidatePath,
  candidateHash,
  passportPath = "",
  passportHash = "",
  fillPlanPath = "",
  fillPlanHash = "",
  requestedBy = "structure-gate-automation",
}) {
  if (report?.status !== "REVIEW" || report?.ok !== false) {
    throw new Error("A structure review request can only be built for a blocking REVIEW report.");
  }
  if (!String(requestedBy).trim()) throw new Error("A structure review requester identity is required.");
  const reportSubjectHash = hashValue(reportReviewSubject(report));
  const evaluationHash = hashValue(evaluationProjection(report));
  const bindingHash = structureReviewBindingHash({
    policyId: report.policyId,
    policyVersion: report.policyVersion,
    candidateHash,
    passportHash,
    fillPlanHash,
    reportSubjectHash,
    evaluationHash,
    requestedBy: String(requestedBy).trim(),
  });
  return {
    schemaVersion: 1,
    kind: "structure-review-request",
    status: "PENDING_REVIEW",
    requestId: `structure_${bindingHash.slice(0, 24)}`,
    generatedAt: new Date().toISOString(),
    gateId: STRUCTURE_REVIEW_GATE_ID,
    policyId: report.policyId,
    policyVersion: report.policyVersion,
    requestedBy: String(requestedBy).trim(),
    reportPath: path.resolve(reportPath),
    reportSubjectHash,
    evaluationHash,
    candidatePath: path.resolve(candidatePath),
    candidateHash,
    passportPath: passportPath ? path.resolve(passportPath) : "",
    passportHash,
    fillPlanPath: fillPlanPath ? path.resolve(fillPlanPath) : "",
    fillPlanHash,
    bindingHash,
    reviewFindings: (report.findings ?? [])
      .filter((item) => item.level === "REVIEW")
      .map((item) => ({ uid: item.uid ?? "", index: item.index, rule: item.rule })),
    signoff: null,
    note: "This hash-bound request is not an approval. A separately authored independent signoff file is required.",
  };
}

export async function verifyStructureReviewRequest(request, overrides = {}) {
  const errors = [];
  if (request?.kind !== "structure-review-request") errors.push("Unexpected request kind.");
  if (request?.status !== "PENDING_REVIEW") errors.push("Review request is not pending.");
  if (request?.signoff != null) errors.push("Base review request must not contain an automatic signoff.");
  if (!String(request?.requestedBy ?? "").trim()) errors.push("Review requester identity is missing.");
  const candidatePath = overrides.candidatePath ?? request?.candidatePath;
  const passportPath = overrides.passportPath ?? request?.passportPath;
  const fillPlanPath = overrides.fillPlanPath ?? request?.fillPlanPath;
  const reportPath = overrides.reportPath ?? request?.reportPath;
  try {
    const [candidateHash, passportHash, fillPlanHash, report] = await Promise.all([
      sha256File(candidatePath),
      passportPath ? sha256File(passportPath) : "",
      fillPlanPath ? sha256File(fillPlanPath) : "",
      fs.readFile(reportPath, "utf8").then(JSON.parse),
    ]);
    if (path.resolve(candidatePath) !== path.resolve(request.candidatePath)) errors.push("Candidate path mismatch.");
    if ((passportPath ? path.resolve(passportPath) : "") !== request.passportPath) errors.push("Passport path mismatch.");
    if ((fillPlanPath ? path.resolve(fillPlanPath) : "") !== request.fillPlanPath) errors.push("Fill-plan path mismatch.");
    if (path.resolve(reportPath) !== path.resolve(request.reportPath)) errors.push("Report path mismatch.");
    if (candidateHash !== request.candidateHash) errors.push("Candidate hash mismatch.");
    if (passportHash !== request.passportHash) errors.push("Passport hash mismatch.");
    if (fillPlanHash !== request.fillPlanHash) errors.push("Fill-plan hash mismatch.");
    if (report.status !== "REVIEW" || report.ok !== false) errors.push("Bound report is not a blocking REVIEW.");
    if (report.policyId !== request.policyId || report.policyVersion !== request.policyVersion) {
      errors.push("Review request policy mismatch.");
    }
    const reportSubjectHash = hashValue(reportReviewSubject(report));
    const evaluationHash = hashValue(evaluationProjection(report));
    if (reportSubjectHash !== request.reportSubjectHash) errors.push("Report subject hash mismatch.");
    if (evaluationHash !== request.evaluationHash) errors.push("Review evaluation hash mismatch.");
    const expectedBinding = structureReviewBindingHash({
      policyId: request.policyId,
      policyVersion: request.policyVersion,
      candidateHash,
      passportHash,
      fillPlanHash,
      reportSubjectHash,
      evaluationHash,
      requestedBy: request.requestedBy,
    });
    if (expectedBinding !== request.bindingHash) errors.push("Review binding hash mismatch.");
    if (request.requestId !== `structure_${expectedBinding.slice(0, 24)}`) errors.push("Review requestId mismatch.");
  } catch (error) {
    errors.push(error?.message || String(error));
  }
  return { ok: errors.length === 0, pending: errors.length === 0, errors };
}

export function verifyStructureReviewSignoff(request, signoff, { requestHash = "" } = {}) {
  const errors = [];
  if (signoff?.kind !== "structure-review-signoff") errors.push("Unexpected signoff kind.");
  if (signoff?.requestId !== request?.requestId) errors.push("Signoff requestId mismatch.");
  if (signoff?.bindingHash !== request?.bindingHash) errors.push("Signoff bindingHash mismatch.");
  if (!requestHash || signoff?.requestHash !== requestHash) errors.push("Signoff requestHash mismatch.");
  if (!['APPROVE', 'REJECT'].includes(signoff?.decision)) errors.push("Signoff decision must be APPROVE or REJECT.");
  const reviewer = String(signoff?.reviewer ?? "").trim();
  const requestedBy = String(request?.requestedBy ?? "").trim();
  if (!reviewer) errors.push("Signoff reviewer is required.");
  if (!requestedBy) errors.push("Review requester identity is required.");
  if (reviewer && requestedBy && reviewer.toLocaleLowerCase() === requestedBy.toLocaleLowerCase()) {
    errors.push("Reviewer must be independent from requester; self-signoff is forbidden.");
  }
  if (!String(signoff?.rationale ?? "").trim()) errors.push("Signoff rationale is required.");
  if (!signoff?.reviewedAt || Number.isNaN(Date.parse(signoff.reviewedAt))) {
    errors.push("Valid signoff reviewedAt is required.");
  }
  return {
    ok: errors.length === 0,
    approved: errors.length === 0 && signoff.decision === "APPROVE",
    rejected: errors.length === 0 && signoff.decision === "REJECT",
    errors,
  };
}

function registryLockName(registryPath) {
  return path.resolve(registryPath) === path.resolve(STRUCTURE_REGISTRY_PATH)
    ? "structure_registry"
    : `structure_registry_${sanitizeId(registryPath)}`;
}

function emptyRegistry(policy) {
  return {
    version: 1,
    policyId: policy.policyId,
    policyVersion: policy.version,
    entries: [],
    reservations: [],
  };
}

function activeHistoryEntries(registry) {
  const active = new Set(["legacy", "reserved", "drafting", "submitted", "qa_loop", "accepted"]);
  return (registry.entries ?? []).filter((entry) => active.has(entry.status) && entry.fingerprint);
}

function cleanReservations(registry, now = Date.now()) {
  registry.reservations = (registry.reservations ?? []).filter((item) => {
    if (["accepted", "released", "abandoned"].includes(item.status)) return false;
    return !item.expiresAt || Date.parse(item.expiresAt) > now;
  });
}

function plannedHistory(registry) {
  return (registry.reservations ?? []).flatMap((reservation) =>
    (reservation.profiles ?? []).map((profile) => ({
      runId: reservation.runId,
      status: reservation.status,
      profile,
    })),
  );
}

async function loadCandidate(candidatePath) {
  const text = await fs.readFile(candidatePath, "utf8");
  const rows = parseTsvRows(text);
  if (!rows.length) throw new Error(`Candidate TSV has no data rows: ${candidatePath}`);
  return { text, rows };
}

async function loadPassport(passportPath) {
  if (!passportPath) return [];
  const value = JSON.parse(await fs.readFile(passportPath, "utf8"));
  return Array.isArray(value) ? value : value.profiles ?? [];
}

async function loadFillPlan(fillPlanPath) {
  if (!fillPlanPath) return null;
  const plan = JSON.parse(await fs.readFile(fillPlanPath, "utf8"));
  if (!Array.isArray(plan.rows) || !plan.rows.length) throw new Error(`Fill plan has no rows: ${fillPlanPath}`);
  return plan;
}

function verifyCandidateMatchesPlan(candidateRows, planRows) {
  if (candidateRows.length !== planRows.length) {
    throw new Error(`Candidate/fill-plan row count mismatch: ${candidateRows.length} vs ${planRows.length}`);
  }
  const mismatches = [];
  for (let index = 0; index < candidateRows.length; index += 1) {
    const planRow = planRows[index];
    const candidateProjection = Array.isArray(planRow?.updates)
      ? {
          updates: planRow.updates.map((item) => ({
            field: item.field,
            column: item.column,
            value: candidateRows[index]?.[item.field] ?? "",
          })),
        }
      : candidateRows[index];
    if (hashNarrativeRow(candidateProjection) !== hashNarrativeRow(planRow)) {
      mismatches.push(index + 1);
    }
  }
  if (mismatches.length) {
    throw new Error(`Candidate/fill-plan narrative hash mismatch at data rows: ${mismatches.join(", ")}`);
  }
}

export async function reserveProfilesForRun({
  runId,
  count,
  outPath,
  registryPath = STRUCTURE_REGISTRY_PATH,
  policyPath,
  owner = runId,
} = {}) {
  if (!runId) throw new Error("reserveProfilesForRun requires runId.");
  if (!Number.isInteger(count) || count < 1) throw new Error("reserveProfilesForRun requires a positive count.");
  const policy = await loadStructuralDiversityPolicy(policyPath);
  return withLock(registryLockName(registryPath), { owner, metadata: { runId, count } }, async () => {
    const registry = (await readJson(registryPath, null)) ?? emptyRegistry(policy);
    cleanReservations(registry);
    const history = [...activeHistoryEntries(registry), ...plannedHistory(registry)];
    const sourceDriven = policy.passport?.assignmentMode === "disabled-source-derived";
    const profiles = sourceDriven
      ? Array.from({ length: count }, (_, index) => ({
          slot: index + 1,
          index,
          profileId: `${runId}_source_${String(index + 1).padStart(2, "0")}`,
          sourceDriven: true,
        }))
      : allocateProfiles({ count, history, runId }, policy);
    const reservation = {
      runId,
      status: "planned",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + RESERVATION_TTL_MS).toISOString(),
      profiles,
    };
    registry.reservations = (registry.reservations ?? []).filter((item) => item.runId !== runId);
    registry.reservations.push(reservation);
    registry.policyId = policy.policyId;
    registry.policyVersion = policy.version;
    registry.updatedAt = new Date().toISOString();
    await writeJsonAtomic(registryPath, registry);
    const plan = {
      schemaVersion: 1,
      policyId: policy.policyId,
      policyVersion: policy.version,
      runId,
      generatedAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
      profiles,
      note: sourceDriven
        ? "No opening, evidence, flow, or product style is assigned. Draft from source facts, then use batch gates to detect accidental concentration."
        : "Generate at least two cheap task-spec candidates per slot, then choose the candidate maximizing minimum structural distance before researching attachments.",
    };
    if (outPath) await writeJsonAtomic(outPath, plan);
    return plan;
  });
}

export async function runStructureGate({
  candidatePath,
  passportPath = "",
  fillPlanPath = "",
  reportPath,
  receiptPath = "",
  reviewRequestPath = "",
  reviewSignoffPath = "",
  reviewRequester = "structure-gate-automation",
  registryPath = STRUCTURE_REGISTRY_PATH,
  policyPath,
} = {}) {
  if (!candidatePath) throw new Error("runStructureGate requires candidatePath.");
  if (!reportPath) throw new Error("runStructureGate requires reportPath.");
  const policy = await loadStructuralDiversityPolicy(policyPath);
  const [{ text, rows }, assignments, fillPlan, registry] = await Promise.all([
    loadCandidate(candidatePath),
    loadPassport(passportPath),
    loadFillPlan(fillPlanPath),
    readJson(registryPath, emptyRegistry(policy)),
  ]);
  if (fillPlan) verifyCandidateMatchesPlan(rows, fillPlan.rows);
  const evaluation = evaluateDiversity(rows, {
    policy,
    history: activeHistoryEntries(registry),
    assignments,
  });
  const [candidateHash, passportHash, fillPlanHash] = await Promise.all([
    sha256File(candidatePath),
    passportPath ? sha256File(passportPath) : "",
    fillPlanPath ? sha256File(fillPlanPath) : "",
  ]);
  const report = {
    schemaVersion: 1,
    kind: "structure-gate-report",
    generatedAt: new Date().toISOString(),
    policyId: policy.policyId,
    policyVersion: policy.version,
    candidatePath: path.resolve(candidatePath),
    candidateHash,
    passportPath: passportPath ? path.resolve(passportPath) : "",
    passportHash,
    fillPlanPath: fillPlanPath ? path.resolve(fillPlanPath) : "",
    fillPlanHash,
    candidateBytes: Buffer.byteLength(text, "utf8"),
    ...evaluation,
  };
  const resolvedReviewRequestPath = path.resolve(
    reviewRequestPath || `${reportPath}.review-request.json`,
  );
  const resolvedReviewSignoffPath = reviewSignoffPath ? path.resolve(reviewSignoffPath) : "";
  let receipt = null;
  let reviewRequest = null;
  let reviewSignoff = null;
  if (evaluation.status === "PASS") {
    report.reviewAuthorization = null;
    await writeJsonAtomic(reportPath, report);
    const receiptRows = fillPlan?.rows ?? rows;
    const reportHash = await sha256File(reportPath);
    receipt = buildReceipt({
      evaluation,
      rows: receiptRows,
      policy,
      reportPath: path.resolve(reportPath),
      reportHash,
    });
    if (receiptPath) await writeJsonAtomic(receiptPath, receipt);
    await fs.rm(resolvedReviewRequestPath, { force: true });
  } else if (evaluation.status === "FAIL") {
    report.reviewAuthorization = null;
    await writeJsonAtomic(reportPath, report);
    if (receiptPath) await fs.rm(receiptPath, { force: true });
    await fs.rm(resolvedReviewRequestPath, { force: true });
  } else {
    // REVIEW starts blocked and deletes any old receipt before attempting to
    // read a signoff. Invalid, missing, rejected, or stale approvals therefore
    // cannot leave a usable receipt behind.
    if (receiptPath) await fs.rm(receiptPath, { force: true });
    if (resolvedReviewSignoffPath && resolvedReviewSignoffPath === resolvedReviewRequestPath) {
      throw new Error("Structure review request and signoff must be separate files.");
    }

    const expectedRequest = buildStructureReviewRequest({
      report,
      reportPath,
      candidatePath,
      candidateHash,
      passportPath,
      passportHash,
      fillPlanPath,
      fillPlanHash,
      requestedBy: reviewRequester,
    });
    let existingRequest = null;
    try {
      existingRequest = JSON.parse(await fs.readFile(resolvedReviewRequestPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existingRequest) {
      // Write a provisional report so request verification reads the current
      // evaluation subject. reviewAuthorization is excluded from that subject.
      report.reviewAuthorization = {
        status: "PENDING_REVIEW",
        decision: null,
        verified: false,
        requestPath: resolvedReviewRequestPath,
        requestHash: await sha256File(resolvedReviewRequestPath),
        signoffPath: resolvedReviewSignoffPath,
        signoffHash: "",
        requestId: existingRequest.requestId ?? "",
        bindingHash: existingRequest.bindingHash ?? "",
        evaluationHash: existingRequest.evaluationHash ?? "",
        requestedBy: existingRequest.requestedBy ?? "",
        reviewer: "",
        reviewedAt: "",
      };
      await writeJsonAtomic(reportPath, report);
      const requestCheck = await verifyStructureReviewRequest(existingRequest, {
        candidatePath,
        passportPath,
        fillPlanPath,
        reportPath,
      });
      if (!requestCheck.ok) {
        if (resolvedReviewSignoffPath) {
          throw new Error(`Structure review request validation failed: ${requestCheck.errors.join("; ")}`);
        }
        existingRequest = null;
      }
    }
    if (!existingRequest) {
      reviewRequest = expectedRequest;
      await writeJsonAtomic(resolvedReviewRequestPath, reviewRequest);
    } else {
      reviewRequest = existingRequest;
    }
    const requestHash = await sha256File(resolvedReviewRequestPath);
    const pendingAuthorization = {
      status: "PENDING_REVIEW",
      decision: null,
      verified: false,
      requestPath: resolvedReviewRequestPath,
      requestHash,
      signoffPath: resolvedReviewSignoffPath,
      signoffHash: "",
      requestId: reviewRequest.requestId,
      bindingHash: reviewRequest.bindingHash,
      evaluationHash: reviewRequest.evaluationHash,
      requestedBy: reviewRequest.requestedBy,
      reviewer: "",
      reviewedAt: "",
    };
    report.reviewAuthorization = pendingAuthorization;

    if (resolvedReviewSignoffPath) {
      try {
        reviewSignoff = JSON.parse(await fs.readFile(resolvedReviewSignoffPath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!reviewSignoff) {
      await writeJsonAtomic(reportPath, report);
    } else {
      const signoffCheck = verifyStructureReviewSignoff(reviewRequest, reviewSignoff, { requestHash });
      const signoffHash = await sha256File(resolvedReviewSignoffPath);
      if (!signoffCheck.ok) {
        report.reviewAuthorization = {
          ...pendingAuthorization,
          status: "INVALID_SIGNOFF",
          signoffHash,
          errors: signoffCheck.errors,
        };
        await writeJsonAtomic(reportPath, report);
        throw new Error(`Structure review signoff validation failed: ${signoffCheck.errors.join("; ")}`);
      }
      const reviewedAuthorization = {
        ...pendingAuthorization,
        status: signoffCheck.approved ? "APPROVED" : "REJECTED",
        decision: reviewSignoff.decision,
        verified: true,
        signoffHash,
        reviewer: String(reviewSignoff.reviewer).trim(),
        reviewedAt: reviewSignoff.reviewedAt,
        rationaleHash: hashValue(String(reviewSignoff.rationale).trim()),
      };
      report.reviewAuthorization = reviewedAuthorization;
      await writeJsonAtomic(reportPath, report);
      if (signoffCheck.approved) {
        const receiptRows = fillPlan?.rows ?? rows;
        const reportHash = await sha256File(reportPath);
        receipt = buildReceipt({
          evaluation,
          rows: receiptRows,
          policy,
          reportPath: path.resolve(reportPath),
          reportHash,
          reviewAuthorization: reviewedAuthorization,
        });
        if (receiptPath) await writeJsonAtomic(receiptPath, receipt);
      }
    }
  }
  return {
    report,
    receipt,
    reviewRequest,
    reviewSignoff,
    reviewRequestPath: evaluation.status === "REVIEW" ? resolvedReviewRequestPath : "",
  };
}

async function verifyStructureReceiptArtifacts({
  receipt,
  receiptPath,
  policy,
  candidatePath = "",
  passportPath = "",
  fillPlanPath = "",
}) {
  if (!receipt?.reportPath) throw new Error("Structure receipt does not reference its gate report.");
  const resolvedReceiptPath = path.resolve(receiptPath);
  const reportPath = path.isAbsolute(receipt.reportPath)
    ? receipt.reportPath
    : path.resolve(path.dirname(resolvedReceiptPath), receipt.reportPath);
  const [reportText, actualReportHash] = await Promise.all([
    fs.readFile(reportPath, "utf8"),
    sha256File(reportPath),
  ]);
  if (!receipt.reportHash || receipt.reportHash !== actualReportHash) {
    throw new Error("Structure gate report hash does not match the receipt.");
  }
  const report = JSON.parse(reportText);
  if (report.policyId !== policy.policyId || report.policyVersion !== policy.version) {
    throw new Error("Referenced structure gate report policy does not match the current policy.");
  }
  if (candidatePath && path.resolve(candidatePath) !== path.resolve(report.candidatePath)) {
    throw new Error("Receipt report candidatePath does not match registration input.");
  }
  if (passportPath && path.resolve(passportPath) !== path.resolve(report.passportPath)) {
    throw new Error("Receipt report passportPath does not match registration input.");
  }
  if (fillPlanPath && path.resolve(fillPlanPath) !== path.resolve(report.fillPlanPath)) {
    throw new Error("Receipt report fillPlanPath does not match registration input.");
  }

  const gateStatus = receipt.gateStatus ?? "PASS";
  if (gateStatus === "PASS") {
    if (!report.ok || report.status !== "PASS") {
      throw new Error("Referenced structure gate report is not PASS.");
    }
    if (receipt.reviewAuthorization != null || report.reviewAuthorization != null) {
      throw new Error("Direct PASS receipt must not contain review authorization.");
    }
    return { report, reportPath };
  }
  if (gateStatus !== "REVIEW" || report.status !== "REVIEW" || report.ok !== false) {
    throw new Error("Reviewed structure receipt is not bound to a blocking REVIEW report.");
  }
  const authorization = receipt.reviewAuthorization;
  if (
    authorization?.status !== "APPROVED" ||
    authorization?.decision !== "APPROVE" ||
    authorization?.verified !== true
  ) {
    throw new Error("Reviewed structure receipt does not contain a verified APPROVE authorization.");
  }
  if (hashValue(report.reviewAuthorization) !== hashValue(authorization)) {
    throw new Error("Review authorization in report does not match the receipt.");
  }
  const requestPath = path.resolve(authorization.requestPath);
  const signoffPath = path.resolve(authorization.signoffPath);
  if (requestPath === signoffPath) throw new Error("Review request and signoff must be separate files.");
  const [requestText, signoffText, requestHash, signoffHash] = await Promise.all([
    fs.readFile(requestPath, "utf8"),
    fs.readFile(signoffPath, "utf8"),
    sha256File(requestPath),
    sha256File(signoffPath),
  ]);
  if (requestHash !== authorization.requestHash) throw new Error("Structure review request hash mismatch.");
  if (signoffHash !== authorization.signoffHash) throw new Error("Structure review signoff hash mismatch.");
  const request = JSON.parse(requestText);
  const signoff = JSON.parse(signoffText);
  const requestCheck = await verifyStructureReviewRequest(request, {
    candidatePath: report.candidatePath,
    passportPath: report.passportPath,
    fillPlanPath: report.fillPlanPath,
    reportPath,
  });
  if (!requestCheck.ok) {
    throw new Error(`Structure review request validation failed: ${requestCheck.errors.join("; ")}`);
  }
  const signoffCheck = verifyStructureReviewSignoff(request, signoff, { requestHash });
  if (!signoffCheck.approved) {
    const details = signoffCheck.errors.length ? signoffCheck.errors.join("; ") : "decision is not APPROVE";
    throw new Error(`Structure review signoff is not an independent approval: ${details}`);
  }
  const authorizationMatches =
    authorization.requestId === request.requestId &&
    authorization.bindingHash === request.bindingHash &&
    authorization.evaluationHash === request.evaluationHash &&
    authorization.requestedBy === request.requestedBy &&
    authorization.reviewer === String(signoff.reviewer).trim() &&
    authorization.reviewedAt === signoff.reviewedAt &&
    authorization.rationaleHash === hashValue(String(signoff.rationale).trim());
  if (!authorizationMatches) throw new Error("Review authorization metadata does not match request and signoff files.");
  return { report, reportPath, request, signoff };
}

export async function registerStructureRows({
  candidatePath,
  passportPath = "",
  fillPlanPath,
  receiptPath,
  runId,
  status = "accepted",
  registryPath = STRUCTURE_REGISTRY_PATH,
  policyPath,
  owner = runId,
  legacy = false,
} = {}) {
  if (!runId) throw new Error("registerStructureRows requires runId.");
  if (!fillPlanPath || !receiptPath) throw new Error("registerStructureRows requires fillPlanPath and receiptPath.");
  const policy = await loadStructuralDiversityPolicy(policyPath);
  const [{ rows }, assignments, fillPlan, receipt] = await Promise.all([
    loadCandidate(candidatePath),
    loadPassport(passportPath),
    loadFillPlan(fillPlanPath),
    fs.readFile(receiptPath, "utf8").then(JSON.parse),
  ]);
  verifyCandidateMatchesPlan(rows, fillPlan.rows);
  const receiptCheck = verifyReceiptRows(receipt, fillPlan.rows, policy);
  if (!receiptCheck.ok) throw new Error(`Structure receipt validation failed: ${receiptCheck.errors.join("; ")}`);
  await verifyStructureReceiptArtifacts({
    receipt,
    receiptPath,
    policy,
    candidatePath,
    passportPath,
    fillPlanPath,
  });

  return withLock(registryLockName(registryPath), { owner, metadata: { runId, count: rows.length } }, async () => {
    const registry = (await readJson(registryPath, null)) ?? emptyRegistry(policy);
    cleanReservations(registry);
    const expectedRegisteredRows = fillPlan.rows.map((planRow) => ({
      sheetRow: planRow.sheetRow,
      rowHash: hashNarrativeRow(planRow),
    }));
    const existingRunEntries = (registry.entries ?? []).filter((entry) => entry.runId === runId);
    if (existingRunEntries.length) {
      const existingByRow = new Map(existingRunEntries.map((entry) => [Number(entry.sheetRow), entry]));
      const exactExistingRun =
        existingRunEntries.length === expectedRegisteredRows.length &&
        expectedRegisteredRows.every(({ sheetRow, rowHash }) => {
          const existing = existingByRow.get(Number(sheetRow));
          return existing?.rowHash === rowHash && path.resolve(existing.sourcePath) === path.resolve(candidatePath);
        });
      if (!exactExistingRun) {
        throw new Error("Existing structure registration for this run does not match the current receipt rows.");
      }

      // Artifact and receipt hashes were revalidated above. At this point the
      // rows are already the exact reserved release, so only advance their
      // lifecycle state. Re-running the diversity comparison here would count
      // the same reviewed batch in a different history shape and can turn a
      // valid REVIEW authorization into a false collision.
      const now = new Date().toISOString();
      for (const entry of existingRunEntries) {
        entry.status = legacy ? "legacy" : status;
        entry.legacy = legacy;
        entry.acceptedAt = status === "accepted" ? now : "";
        entry.updatedAt = now;
      }
      registry.reservations = (registry.reservations ?? []).filter((item) => item.runId !== runId);
      registry.policyId = policy.policyId;
      registry.policyVersion = policy.version;
      registry.updatedAt = now;
      await writeJsonAtomic(registryPath, registry);
      return {
        ok: true,
        registered: existingRunEntries.length,
        status: legacy ? "legacy" : status,
        registryPath,
        stateTransitionOnly: true,
      };
    }

    // A receipt can be registered more than once while the same release moves
    // through reserved -> submitted -> accepted. Exclude this run's existing
    // rows from history so a reviewed intra-batch similarity is not counted a
    // second time as a new history collision during that status transition.
    const history = activeHistoryEntries(registry).filter((entry) => entry.runId !== runId);
    const evaluation = evaluateDiversity(rows, {
      policy,
      history,
      assignments,
    });
    const gateStatus = receipt.gateStatus ?? "PASS";
    const directPassStillValid = gateStatus === "PASS" && evaluation.status === "PASS" && evaluation.ok === true;
    const reviewedResultStillValid =
      gateStatus === "REVIEW" &&
      evaluation.status === "REVIEW" &&
      evaluation.ok === false &&
      hashValue(evaluationProjection(evaluation)) === receipt.reviewAuthorization?.evaluationHash;
    if (!directPassStillValid && !reviewedResultStillValid) {
      throw new Error(`Structure changed or collided before registration: ${evaluation.findings.map((item) => item.rule).join(", ")}`);
    }
    const now = new Date().toISOString();
    for (let index = 0; index < rows.length; index += 1) {
      const fingerprint = evaluation.fingerprints[index];
      const uid = fingerprint.uid || `row-${fillPlan.rows[index].sheetRow}`;
      const entry = {
        uid,
        runId,
        sheetRow: fillPlan.rows[index].sheetRow,
        status: legacy ? "legacy" : status,
        legacy,
        profile: assignments[index] ?? null,
        fingerprint,
        rowHash: hashNarrativeRow(fillPlan.rows[index]),
        sourcePath: path.resolve(candidatePath),
        acceptedAt: status === "accepted" ? now : "",
        updatedAt: now,
      };
      const existingIndex = (registry.entries ?? []).findIndex((item) => item.uid === uid);
      if (existingIndex >= 0) registry.entries[existingIndex] = { ...registry.entries[existingIndex], ...entry };
      else (registry.entries ??= []).push(entry);
    }
    registry.reservations = (registry.reservations ?? []).filter((item) => item.runId !== runId);
    registry.policyId = policy.policyId;
    registry.policyVersion = policy.version;
    registry.updatedAt = now;
    await writeJsonAtomic(registryPath, registry);
    return { ok: true, registered: rows.length, status: legacy ? "legacy" : status, registryPath };
  });
}

export async function registerStructureReceipt({
  receiptPath,
  status = "reserved",
  registryPath = STRUCTURE_REGISTRY_PATH,
  policyPath,
  owner = "structure_receipt_registration",
} = {}) {
  if (!receiptPath) throw new Error("registerStructureReceipt requires receiptPath.");
  const resolvedReceiptPath = path.resolve(receiptPath);
  const receipt = JSON.parse(await fs.readFile(resolvedReceiptPath, "utf8"));
  const policy = await loadStructuralDiversityPolicy(policyPath);
  const { report } = await verifyStructureReceiptArtifacts({
    receipt,
    receiptPath: resolvedReceiptPath,
    policy,
  });
  if (!report.candidatePath || !report.fillPlanPath) {
    throw new Error("Referenced structure gate report is missing candidatePath or fillPlanPath.");
  }

  let passport = null;
  if (report.passportPath) {
    if (!report.passportHash || report.passportHash !== await sha256File(report.passportPath)) {
      throw new Error("Structure passport hash does not match the gate report.");
    }
    passport = JSON.parse(await fs.readFile(report.passportPath, "utf8"));
  }
  let runId = report.runId || passport?.runId || "";
  if (!runId) runId = `structure_${String(receipt.batchHash || "unknown").slice(0, 16)}`;

  return registerStructureRows({
    candidatePath: report.candidatePath,
    passportPath: report.passportPath || "",
    fillPlanPath: report.fillPlanPath,
    receiptPath: resolvedReceiptPath,
    runId,
    status,
    registryPath,
    policyPath,
    owner: `${owner}_${runId}`,
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const mode = args.mode || "check";
  const registryPath = resolveFromRoot(args.registry || STRUCTURE_REGISTRY_PATH);
  const policyPath = args.policy ? resolveFromRoot(args.policy) : undefined;
  if (mode === "allocate") {
    const outPath = resolveFromRoot(args.out || path.join("outputs", "auto_runs", sanitizeId(args["run-id"]), "sources", "diversity_plan.json"));
    return reserveProfilesForRun({
      runId: args["run-id"],
      count: Number(args.count),
      outPath,
      registryPath,
      policyPath,
    });
  }
  if (mode === "register") {
    return registerStructureRows({
      candidatePath: resolveFromRoot(args.candidate),
      passportPath: args.passport ? resolveFromRoot(args.passport) : "",
      fillPlanPath: resolveFromRoot(args["fill-plan"]),
      receiptPath: resolveFromRoot(args.receipt),
      runId: args["run-id"],
      status: args.status || "accepted",
      registryPath,
      policyPath,
      legacy: args.legacy === true,
    });
  }
  const result = await runStructureGate({
    candidatePath: resolveFromRoot(args.candidate),
    passportPath: args.passport ? resolveFromRoot(args.passport) : "",
    fillPlanPath: args["fill-plan"] ? resolveFromRoot(args["fill-plan"]) : "",
    reportPath: resolveFromRoot(args.report),
    receiptPath: args.receipt ? resolveFromRoot(args.receipt) : "",
    reviewRequestPath: args["review-request"] ? resolveFromRoot(args["review-request"]) : "",
    reviewSignoffPath: args["review-signoff"] ? resolveFromRoot(args["review-signoff"]) : "",
    reviewRequester: args["review-requester"] || "structure-gate-automation",
    registryPath,
    policyPath,
  });
  if (!result.receipt) process.exitCode = 1;
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
