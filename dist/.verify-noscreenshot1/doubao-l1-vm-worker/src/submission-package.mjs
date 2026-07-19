import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { artifactRootForResult } from "./artifact-root.mjs";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function submissionPackagePath(resultPath) {
  return path.join(artifactRootForResult(resultPath), "feishu-submission-package.json");
}

export function incompleteSubmissionPackagePath(resultPath) {
  return path.join(artifactRootForResult(resultPath), "feishu-submission-package.incomplete.json");
}

export function buildSubmissionPackage(state, { target = null } = {}) {
  if (state?.status === "complete") throw new Error("Submission package must be built before final completion.");
  if (!Array.isArray(state?.rounds) || state.rounds.length < 6) {
    throw new Error("Submission package requires at least six completed rounds.");
  }
  if (state?.finalProductAcceptance?.accepted !== true) {
    throw new Error("Submission package requires an accepted final product assessment.");
  }
  return {
    schemaVersion: 2,
    kind: "doubao-feishu-submission-package",
    status: "READY_NOT_SUBMITTED",
    generatedAt: new Date().toISOString(),
    jobId: state.jobId,
    configHash: state.configHash,
    roundCount: state.rounds.length,
    productAcceptance: structuredClone(state.finalProductAcceptance),
    conversation: {
      conversationId: state.conversationId,
      feedbackUrl: state.feedbackUrl,
      logId: state.logId,
      shareLink: state.shareLink,
      allMessagesSelected: state.shareReceipt?.allSelected === true,
      selectedMessageCount: state.shareReceipt?.selectedCount ?? 0,
    },
    rows: state.rounds.map((round, index) => ({
      roundNumber: index + 1,
      prompt: round.prompt,
      responseIdentity: round.response?.responseIdentity ?? "",
      humanEvaluation: {
        labels: round.evaluation?.labels ?? [],
        note: round.evaluation?.note ?? "",
        vote: round.evaluation?.vote ?? "",
      },
    })),
    target: target && typeof target === "object" ? structuredClone(target) : null,
    writeback: {
      applied: false,
      policy: "prepare-only-until-an-exact-feishu-target-row-and-field-map-are-authorized",
      readbackVerified: false,
    },
  };
}

export async function writeSubmissionPackage(state, { resultPath, target = null } = {}) {
  if (!path.isAbsolute(String(resultPath ?? ""))) {
    throw new Error("resultPath must be absolute when writing the submission package.");
  }
  const packagePath = submissionPackagePath(resultPath);
  const value = buildSubmissionPackage(state, { target });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(packagePath), { recursive: true });
  const temporaryPath = `${packagePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes);
    const temporaryReadback = await readFile(temporaryPath);
    if (digest(temporaryReadback) !== digest(bytes)) throw new Error("Submission package temporary readback mismatch.");
    await rename(temporaryPath, packagePath);
    const finalBytes = await readFile(packagePath);
    const parsed = JSON.parse(finalBytes.toString("utf8"));
    if (parsed.status !== "READY_NOT_SUBMITTED" || parsed.roundCount !== state.rounds.length) {
      throw new Error("Submission package final readback failed structural verification.");
    }
    return {
      artifactPath: path.relative(path.dirname(resultPath), packagePath).replace(/\\/gu, "/"),
      pass: true,
      roundCount: parsed.roundCount,
      sha256: digest(finalBytes),
      sizeBytes: finalBytes.length,
      status: parsed.status,
      targetConfigured: parsed.target != null,
      writeApplied: parsed.writeback.applied,
      writtenAt: new Date().toISOString(),
    };
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function buildIncompleteSubmissionPackage(state, { target = null } = {}) {
  if (!Array.isArray(state?.rounds) || state.rounds.length < 6
    || state.rounds.some((round) => round?.status !== "complete")) {
    throw new Error("Incomplete submission package requires at least six completed rounds.");
  }
  if (state?.finalProductAcceptance?.accepted !== false) {
    throw new Error("Incomplete submission package requires a rejected final product assessment.");
  }
  return {
    schemaVersion: 2,
    kind: "doubao-feishu-submission-package",
    status: "INCOMPLETE_NOT_SUBMITTED",
    generatedAt: new Date().toISOString(),
    jobId: state.jobId,
    configHash: state.configHash,
    blockingReason: "final-product-not-accepted",
    roundCount: state.rounds.length,
    productAcceptance: structuredClone(state.finalProductAcceptance),
    conversation: {
      conversationId: state.conversationId,
      feedbackUrl: state.feedbackUrl,
      logId: state.logId,
      shareLink: state.shareLink,
      allMessagesSelected: state.shareReceipt?.allSelected === true,
      selectedMessageCount: state.shareReceipt?.selectedCount ?? 0,
    },
    rows: state.rounds.map((round, index) => ({
      roundNumber: index + 1,
      prompt: round.prompt,
      response: round.response?.response ?? "",
      responseIdentity: round.response?.responseIdentity ?? "",
      humanEvaluation: {
        evidenceQuote: round.evaluation?.evidenceQuote ?? "",
        labels: round.evaluation?.labels ?? [],
        note: round.evaluation?.note ?? "",
        score: round.evaluation?.score ?? null,
        vote: round.evaluation?.vote ?? "",
      },
    })),
    target: target && typeof target === "object" ? structuredClone(target) : null,
    writeback: {
      applied: false,
      policy: "blocked-because-final-product-was-not-accepted",
      readbackVerified: false,
    },
  };
}

export async function writeIncompleteSubmissionPackage(state, { resultPath, target = null } = {}) {
  if (!path.isAbsolute(String(resultPath ?? ""))) {
    throw new Error("resultPath must be absolute when writing the incomplete submission package.");
  }
  const packagePath = incompleteSubmissionPackagePath(resultPath);
  const value = buildIncompleteSubmissionPackage(state, { target });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(packagePath), { recursive: true });
  const temporaryPath = `${packagePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes);
    const temporaryReadback = await readFile(temporaryPath);
    if (digest(temporaryReadback) !== digest(bytes)) {
      throw new Error("Incomplete submission package temporary readback mismatch.");
    }
    await rename(temporaryPath, packagePath);
    const finalBytes = await readFile(packagePath);
    const parsed = JSON.parse(finalBytes.toString("utf8"));
    if (parsed.status !== "INCOMPLETE_NOT_SUBMITTED" || parsed.roundCount !== state.rounds.length) {
      throw new Error("Incomplete submission package final readback failed structural verification.");
    }
    return {
      artifactPath: path.relative(path.dirname(resultPath), packagePath).replace(/\\/gu, "/"),
      pass: true,
      roundCount: parsed.roundCount,
      sha256: digest(finalBytes),
      sizeBytes: finalBytes.length,
      status: parsed.status,
      targetConfigured: parsed.target != null,
      writeApplied: parsed.writeback.applied,
      writtenAt: new Date().toISOString(),
    };
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
