import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  prepareJobAttachments,
  selectPreparedAttachments,
  validateAttachmentConfig,
  verifyPreparedAttachments,
} from "./attachment-files.mjs";
import {
  hydrateJobAttachmentsFromProductionTrace,
  validateProductionEvidenceConfig,
} from "./production-evidence.mjs";
import { artifactRootForResult } from "./artifact-root.mjs";
import {
  writeIncompleteSubmissionPackage,
  writeSubmissionPackage,
} from "./submission-package.mjs";
import { resolveProductRequirement, validateProductAssessment } from "./product-requirement.mjs";
import { abortableDelay, JOB_PAUSE_REQUESTED, throwIfJobPauseRequested } from "./job-control.mjs";
import {
  INTERACTION_QUOTA_SUSPENDED,
  InteractionQuotaGate,
} from "./quota-pause.mjs";
import {
  assertDomesticWorkScope,
  DOMESTIC_WORK_SCOPE_POLICY_VERSION,
} from "./domestic-work-scope.mjs";

import {
  copyLatestLogInfo,
  copyOpenShareLink,
  evaluateLatestResponse,
  inspectChat,
  openLatestShare,
  openNewOfficeTask,
  recoverLatestSentExchange,
  sendAndWait,
} from "./doubao-client.mjs";
import {
  auditVisibleResponse,
  requestInteractionRewrite,
  requestPolicyDecision,
  requestPromptPreflight,
  validateEvaluation,
  validateOutboundPrompt,
  validatePolicyDecision,
} from "./policy.mjs";
import { summarizeUsageEntries } from "./token-usage.mjs";

const RESUMABLE_VISIBLE_RESPONSE_STATUSES = new Set([
  "response_received",
  "capturing_product_screenshot",
  "response_visibility_pass",
  "feedback_rewriting",
  "feedback_preflight",
  "evaluating",
]);

export function isResumableVisibleResponseRound(round) {
  return RESUMABLE_VISIBLE_RESPONSE_STATUSES.has(String(round?.status ?? ""))
    && Boolean(String(round?.response?.response ?? "").trim())
    && Boolean(String(round?.response?.responseIdentity ?? "").trim());
}

export function isRepairablePromptQualityFailure(error) {
  return error?.code === "MODEL_INVOCATION_FAILED"
    && /returned an unusable (?:decision|result)/iu.test(String(error?.message ?? ""));
}

export function isResumablePromptQualityRound(round, error) {
  return ["rewriting", "preflight"].includes(String(round?.status ?? ""))
    && Boolean(String(round?.plannedPrompt ?? "").trim())
    && !round?.response
    && isRepairablePromptQualityFailure(error);
}

export function enforceFinalExperienceAcceptance(productAssessment, evaluation) {
  const assessment = structuredClone(productAssessment ?? {});
  if (assessment.accepted !== true) return assessment;
  const score = Number(evaluation?.score);
  const vote = String(evaluation?.vote ?? "");
  const pass = Number.isInteger(score) && score >= 3 && vote === "like";
  assessment.experienceGate = {
    evidenceQuote: String(evaluation?.evidenceQuote ?? ""),
    note: String(evaluation?.note ?? ""),
    pass,
    score: Number.isInteger(score) ? score : null,
    vote,
  };
  if (!pass) {
    assessment.accepted = false;
    assessment.overall = "rejected-by-final-experience-gate";
  }
  return assessment;
}

function configHash(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function isInside(targetPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateJobConfig(value) {
  if (!value || typeof value !== "object") throw new Error("Job config must be an object.");
  const jobId = String(value.jobId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(jobId)) {
    throw new Error("jobId must contain 3-128 safe filename characters.");
  }
  const mode = String(value.mode ?? "openai-compatible");
  const configuredRounds = Number(value.maxRounds ?? 6);
  const minimumRounds = mode === "scripted"
    ? configuredRounds
    : Number(value.minimumRounds ?? configuredRounds);
  const maxRounds = mode === "scripted"
    ? configuredRounds
    : Number(value.maximumRounds ?? Math.max(minimumRounds, 12));
  if (!Number.isInteger(minimumRounds) || minimumRounds < 6 || minimumRounds > 20) {
    throw new Error("minimumRounds must be an integer from 6 to 20.");
  }
  if (!Number.isInteger(maxRounds) || maxRounds < minimumRounds || maxRounds > 20) {
    throw new Error("maximumRounds must be an integer from minimumRounds to 20.");
  }
  if (mode === "scripted" && value.developmentOnlyScripted !== true) {
    throw new Error("Scripted mode is limited to explicit development regression jobs; production interactions must use openai-compatible dynamic planning.");
  }
  if (value.interactionRewrite?.type !== "openai-compatible") {
    throw new Error('interactionRewrite.type must be "openai-compatible" for every Doubao job.');
  }
  if (!String(value.interactionRewrite?.baseUrl ?? "").trim()
    || !String(value.interactionRewrite?.model ?? "").trim()) {
    throw new Error("interactionRewrite.baseUrl and interactionRewrite.model are required.");
  }
  if (!["local-codex", "responses-api"].includes(value.promptPreflight?.type)) {
    throw new Error('promptPreflight.type must be "local-codex" or "responses-api" for every Doubao job.');
  }
  if (!String(value.promptPreflight?.model ?? "").trim()) {
    throw new Error("promptPreflight.model is required.");
  }
  if (value.promptPreflight.type === "responses-api") {
    if (Object.hasOwn(value.promptPreflight, "apiKey")) {
      throw new Error("promptPreflight must reference an API key environment variable; inline apiKey is forbidden.");
    }
    if (!String(value.promptPreflight.baseUrl ?? "").trim()) {
      throw new Error("promptPreflight.baseUrl is required for responses-api.");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(value.promptPreflight.apiKeyEnv ?? ""))) {
      throw new Error("promptPreflight.apiKeyEnv must name a valid environment variable for responses-api.");
    }
  }
  if (String(value.promptPreflight.model).trim().toLowerCase()
    === String(value.interactionRewrite.model).trim().toLowerCase()) {
    throw new Error("promptPreflight and interactionRewrite must use different models.");
  }
  const allowDevelopmentFixtures = mode === "scripted" && value.developmentOnlyScripted === true;
  if (!allowDevelopmentFixtures && value._attachmentsHydratedFromProductionEvidence !== true) {
    throw new Error("Live Doubao jobs must compile attachments from productionEvidence before validation.");
  }
  const attachmentConfig = validateAttachmentConfig(value, { allowDevelopmentFixtures });
  validateProductionEvidenceConfig(value, { allowDevelopmentFixtures });
  const resolvedProductRequirement = resolveProductRequirement(value);
  if (mode === "scripted") {
    if (!Array.isArray(value.rounds) || value.rounds.length !== maxRounds) {
      throw new Error(`Scripted jobs must define exactly ${maxRounds} rounds.`);
    }
    value.rounds.forEach((round, index) => {
      if (!String(round?.prompt ?? "").trim()) throw new Error(`rounds[${index}].prompt must not be empty.`);
      if (round?.expectedResponse != null && !String(round.expectedResponse).trim()) {
        throw new Error(`rounds[${index}].expectedResponse must not be empty when provided.`);
      }
      validateEvaluation(round?.evaluation);
      if (round?.attachmentNames != null && !Array.isArray(round.attachmentNames)) {
        throw new Error(`rounds[${index}].attachmentNames must be an array when provided.`);
      }
    });
    const introduced = new Set(attachmentConfig.initialAttachmentNames);
    const knownAttachmentNames = new Set(attachmentConfig.attachments.map((attachment) => attachment.name));
    for (let index = 1; index < value.rounds.length; index += 1) {
      const names = (value.rounds[index].attachmentNames ?? []).map((name) => String(name ?? "").trim());
      if (new Set(names).size !== names.length) {
        throw new Error(`rounds[${index}].attachmentNames must not contain duplicates.`);
      }
      if (names.some((name) => !knownAttachmentNames.has(name))) {
        throw new Error(`rounds[${index}].attachmentNames contains an unknown file.`);
      }
      if (names.some((name) => introduced.has(name))) {
        throw new Error(`rounds[${index}].attachmentNames reuses a previously introduced file.`);
      }
      names.forEach((name) => introduced.add(name));
    }
  } else if (mode === "openai-compatible") {
    if (!String(value.initialPrompt ?? "").trim()) throw new Error("initialPrompt must not be empty.");
    if (!String(value.taskGoal ?? "").trim()) throw new Error("taskGoal must not be empty.");
    if (!["local-codex", "responses-api"].includes(value.policy?.type)) {
      throw new Error('policy.type must be "local-codex" or "responses-api".');
    }
    if (!String(value.policy?.model ?? "").trim()) {
      throw new Error("policy.model is required.");
    }
    if (value.policy.type === "responses-api") {
      if (Object.hasOwn(value.policy, "apiKey")) {
        throw new Error("policy must reference an API key environment variable; inline apiKey is forbidden.");
      }
      if (!String(value.policy.baseUrl ?? "").trim()) {
        throw new Error("policy.baseUrl is required for responses-api.");
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(value.policy.apiKeyEnv ?? ""))) {
        throw new Error("policy.apiKeyEnv must name a valid environment variable for responses-api.");
      }
    }
  } else {
    throw new Error('mode must be either "scripted" or "openai-compatible".');
  }
  return {
    ...value,
    initialAttachmentNames: attachmentConfig.initialAttachmentNames,
    jobId,
    minimumRounds,
    maxRounds,
    mode,
    resolvedProductRequirement,
  };
}

export function validateCompletedJobResult(value) {
  if (value?.status !== "complete") throw new Error("Job result is not complete.");
  const minimumRounds = Number(value.minimumRounds ?? 6);
  const maxRounds = Number(value.maxRounds);
  if (!Number.isInteger(minimumRounds) || minimumRounds < 6
    || !Number.isInteger(maxRounds) || maxRounds < minimumRounds
    || value.rounds?.length < minimumRounds || value.rounds?.length > maxRounds) {
    throw new Error("Job result does not contain the required round count.");
  }
  if (value?.attachmentManifest?.pass !== true || Number(value.attachmentManifest.attachmentCount) < 1) {
    throw new Error("Job result has no passing attachment manifest.");
  }
  const manifestNames = value.attachmentManifest.attachments?.map((attachment) => attachment.name) ?? [];
  if (new Set(manifestNames).size !== manifestNames.length
    || manifestNames.length !== Number(value.attachmentManifest.attachmentCount)) {
    throw new Error("Job attachment manifest names/count are inconsistent.");
  }
  const uploadedAttachmentNames = new Set();
  value.rounds.forEach((round, index) => {
    if (round?.status !== "complete" || !String(round?.response?.response ?? "").trim()) {
      throw new Error(`Round ${index + 1} is incomplete.`);
    }
    if (!round?.evaluation?.submitted || !round?.evaluation?.panelClosed) {
      throw new Error(`Round ${index + 1} feedback was not verified as submitted.`);
    }
    validateEvaluation({
      evidenceQuote: round.evaluation.evidenceQuote,
      labels: round.evaluation.labels,
      note: round.evaluation.note,
      score: round.evaluation.score,
      vote: round.evaluation.vote,
    }, {
      artifacts: round.response.artifacts ?? [],
      requireExperienceEvidence: value.mode !== "scripted",
      responseText: round.response.response,
    });
    if (round?.preflight?.pass !== true || !String(round?.preflight?.model ?? "").trim()) {
      throw new Error(`Round ${index + 1} has no passing model prompt preflight.`);
    }
    if (round?.rewrite?.pass !== true || !String(round?.rewrite?.model ?? "").trim()) {
      throw new Error(`Round ${index + 1} has no passing interaction de-AI rewrite.`);
    }
    if (round?.feedbackPreflight?.pass !== true || !String(round?.feedbackPreflight?.model ?? "").trim()) {
      throw new Error(`Round ${index + 1} has no passing model feedback preflight.`);
    }
    if (round?.feedbackRewrite?.pass !== true || !String(round?.feedbackRewrite?.model ?? "").trim()) {
      throw new Error(`Round ${index + 1} has no passing feedback de-AI rewrite.`);
    }
    if (round.prompt !== round.rewrite.prompt || round.evaluation.note !== round.feedbackRewrite.prompt) {
      throw new Error(`Round ${index + 1} visible text changed after its de-AI rewrite.`);
    }
    validateOutboundPrompt(round.prompt, {
      recentPrompts: value.rounds.slice(Math.max(0, index - 3), index).map((item) => item.prompt),
      requireInteractionAdvance: index > 0,
      requirePersonalPronoun: false,
    });
    validateOutboundPrompt(round.evaluation.note, { textPurpose: "feedback-note" });
    assertDomesticWorkScope(round.prompt, {
      context: { taskGoal: value.taskGoal, successCriteria: value.successCriteria },
      requireInteractionAdvance: index > 0,
      requireWorkScene: true,
    });
    if (round?.responseVisibility?.pass !== true) {
      throw new Error(`Round ${index + 1} did not pass the visible response gate.`);
    }
    const expectedAttachmentNames = Array.isArray(round.attachmentNames) ? round.attachmentNames : [];
    const verificationNames = round?.attachmentVerification?.attachments?.map((attachment) => attachment.name) ?? [];
    const upload = round?.response?.attachmentUpload;
    if (index === 0 && expectedAttachmentNames.length < 1) {
      throw new Error("Round 1 must introduce at least one attachment.");
    }
    if (expectedAttachmentNames.some((name) => !manifestNames.includes(name))) {
      throw new Error(`Round ${index + 1} references an attachment outside the job manifest.`);
    }
    if (expectedAttachmentNames.some((name) => uploadedAttachmentNames.has(name))) {
      throw new Error(`Round ${index + 1} reuploaded an attachment already introduced earlier.`);
    }
    if (expectedAttachmentNames.length) {
      if (round?.attachmentVerification?.pass !== true
        || verificationNames.length !== expectedAttachmentNames.length
        || expectedAttachmentNames.some((name) => !verificationNames.includes(name))) {
        throw new Error(`Round ${index + 1} attachment files were not reverified before send.`);
      }
      if (upload?.pass !== true
        || upload.expectedCount !== expectedAttachmentNames.length
        || upload.visibleCount !== expectedAttachmentNames.length
        || expectedAttachmentNames.some((name) => !upload.visibleNames?.includes(name))) {
        throw new Error(`Round ${index + 1} attachment upload names/count were not read back exactly.`);
      }
      expectedAttachmentNames.forEach((name) => uploadedAttachmentNames.add(name));
    } else if (round?.attachmentVerification != null || upload != null) {
      throw new Error(`Round ${index + 1} recorded an unplanned attachment upload.`);
    }
  });
  const usedResponsesApi = value.rounds.some((round) => [
    round?.preflight?.provider,
    round?.decision?.evaluator?.provider,
    round?.feedbackPreflight?.provider,
  ].includes("openai-compatible-responses-api"));
  if (usedResponsesApi && value.codexUsageSummary?.completeMetering !== true) {
    throw new Error("Completed Responses API job does not have complete Codex token metering.");
  }
  const initialNames = value.attachmentManifest.initialAttachmentNames ?? manifestNames;
  const firstRoundNames = value.rounds[0]?.attachmentNames ?? [];
  if (JSON.stringify(firstRoundNames) !== JSON.stringify(initialNames)) {
    throw new Error("Round 1 attachment names do not match the initial attachment plan.");
  }
  const completionOutcome = String(value?.completionOutcome ?? "complete");
  const productAccepted = value?.finalProductAcceptance?.accepted === true;
  const submittableProductGap = ["doubao-unable", "hard-limit-reached"].includes(completionOutcome)
    && value?.finalProductAcceptance?.accepted === false
    && Array.isArray(value?.unresolvedIssues)
    && value.unresolvedIssues.length > 0;
  if (!productAccepted && !submittableProductGap) {
    throw new Error("Job result has neither an accepted product nor a documented Doubao product gap.");
  }
  if (value.mode !== "scripted" && productAccepted) {
    const finalEvaluation = value.rounds.at(-1)?.evaluation;
    if (Number(finalEvaluation?.score) < 3 || finalEvaluation?.vote !== "like") {
      throw new Error("Job result final experience score is below the submission threshold.");
    }
  }
  if (!/^https:\/\/www\.doubao\.com\/thread\/x[0-9a-f]+$/iu.test(String(value.shareLink ?? ""))) {
    throw new Error("Job result shareLink is invalid.");
  }
  if (!/^https:\/\/www\.doubao\.com\/thread\/x[0-9a-f]+$/iu.test(String(value.feedbackUrl ?? ""))) {
    throw new Error("Job result feedbackUrl is invalid.");
  }
  if (!/^[A-Za-z0-9_-]{20,}$/u.test(String(value.logId ?? ""))) {
    throw new Error("Job result logId is invalid.");
  }
  if (!/^\d+$/u.test(String(value.conversationId ?? ""))) {
    throw new Error("Job result conversationId is invalid.");
  }
  const shareReceipt = value.shareReceipt;
  if (shareReceipt?.pass !== true
    || shareReceipt.selectAll !== true
    || shareReceipt.allSelected !== true
    || shareReceipt.selectionProof !== "global-select-all-checkbox"
    || shareReceipt.shareLink !== value.shareLink) {
    throw new Error("Job result has no verified all-messages share receipt.");
  }
  if (value.logReceipt?.pass !== true
    || value.logReceipt.feedbackUrl !== value.feedbackUrl
    || value.logReceipt.logId !== value.logId) {
    throw new Error("Job result has no verified log ID receipt.");
  }
  const expectedSubmissionStatus = productAccepted ? "READY_NOT_SUBMITTED" : "READY_WITH_DOUBAO_GAP";
  if (value.submissionPackage?.pass !== true
    || value.submissionPackage.status !== expectedSubmissionStatus
    || value.submissionPackage.writeApplied !== false
    || Number(value.submissionPackage.roundCount) !== value.rounds.length
    || !/^[a-f0-9]{64}$/u.test(String(value.submissionPackage.sha256 ?? ""))
    || Number(value.submissionPackage.sizeBytes) < 1) {
    throw new Error("Job result has no verified Feishu-ready submission package.");
  }
  return {
    conversationId: String(value.conversationId),
    feedbackUrl: String(value.feedbackUrl),
    jobId: String(value.jobId),
    logId: String(value.logId),
    roundCount: value.rounds.length,
    shareLink: String(value.shareLink),
    submissionStatus: value.submissionPackage.status,
    status: "complete",
  };
}

export async function verifyCompletedJobArtifacts(value, { resultPath } = {}) {
  const summary = validateCompletedJobResult(value);
  if (!path.isAbsolute(String(resultPath ?? ""))) {
    throw new Error("resultPath must be absolute for artifact verification.");
  }
  const artifactRoot = artifactRootForResult(resultPath);
  const rootInfo = await lstat(artifactRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("The result artifact root is missing, not a directory, or is a symlink.");
  }
  const rootRealPath = await realpath(artifactRoot);
  const submissionReceipt = value.submissionPackage;
  const submissionPath = path.resolve(path.dirname(resultPath), submissionReceipt.artifactPath);
  if (!isInside(submissionPath, artifactRoot)) throw new Error("Submission package path escaped artifact root.");
  const submissionInfo = await lstat(submissionPath);
  if (!submissionInfo.isFile() || submissionInfo.isSymbolicLink()) throw new Error("Submission package is not a regular file.");
  const submissionRealPath = await realpath(submissionPath);
  if (!isInside(submissionRealPath, rootRealPath)) throw new Error("Submission package real path escaped artifact root.");
  const submissionBytes = await readFile(submissionRealPath);
  const submissionHash = createHash("sha256").update(submissionBytes).digest("hex");
  if (submissionHash !== submissionReceipt.sha256 || submissionBytes.length !== Number(submissionReceipt.sizeBytes)) {
    throw new Error("Submission package hash/size readback mismatch.");
  }
  const submission = JSON.parse(submissionBytes.toString("utf8"));
  const productAccepted = value.finalProductAcceptance?.accepted === true;
  const expectedSubmissionStatus = productAccepted ? "READY_NOT_SUBMITTED" : "READY_WITH_DOUBAO_GAP";
  if (submission.status !== expectedSubmissionStatus
    || submission.writeback?.applied !== false
    || submission.roundCount !== value.rounds.length
    || submission.conversation?.shareLink !== value.shareLink
    || submission.conversation?.logId !== value.logId
    || submission.conversation?.conversationId !== value.conversationId
    || submission.productAcceptance?.accepted !== productAccepted
    || (!productAccepted && submission.completionOutcome !== value.completionOutcome)
    || (!productAccepted && JSON.stringify(submission.unresolvedIssues) !== JSON.stringify(value.unresolvedIssues))
    || submission.rows?.length !== value.rounds.length) {
    throw new Error("Submission package content does not match the completed result.");
  }
  for (const [index, row] of submission.rows.entries()) {
    const round = value.rounds[index];
    if (row.roundNumber !== index + 1
      || row.prompt !== round.prompt
      || row.responseIdentity !== round.response.responseIdentity
      || row.humanEvaluation?.vote !== round.evaluation.vote
      || row.humanEvaluation?.note !== round.evaluation.note
      || JSON.stringify(row.humanEvaluation?.labels) !== JSON.stringify(round.evaluation.labels)) {
      throw new Error(`Submission package round ${index + 1} does not match the completed result.`);
    }
  }
  return {
    ...summary,
    artifactRoot: rootRealPath,
    submissionPackage: {
      artifactPath: submissionReceipt.artifactPath,
      sha256: submissionHash,
      status: submission.status,
    },
  };
}

function codexUsageEntries(state) {
  const entries = [...(state.codexUsageHistory ?? [])];
  for (const round of state.rounds ?? []) {
    const roundNumber = Number(round.index ?? entries.length + 1);
    for (const [stage, result] of [
      ["prompt-preflight", round.preflight],
      ["evaluation-planner", round.decision?.evaluator],
      ["feedback-preflight", round.feedbackPreflight],
    ]) {
      if (!result || typeof result !== "object") continue;
      entries.push({
        round: roundNumber,
        stage,
        provider: String(result.provider ?? ""),
        model: String(result.model ?? ""),
        usage: result.usage ?? null,
      });
    }
    for (const [stage, trace] of [
      ["prompt-preflight-rejected", round.promptQualityRetryTrace],
      ["feedback-preflight-rejected", round.feedbackQualityRetryTrace],
    ]) {
      for (const item of trace ?? []) {
        if (!item?.usage) continue;
        entries.push({
          round: roundNumber,
          stage,
          provider: String(item.provider ?? ""),
          model: String(item.model ?? ""),
          usage: item.usage,
        });
      }
    }
  }
  return entries;
}

async function persistState(outputPath, state) {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  state.codexUsageSummary = summarizeUsageEntries(codexUsageEntries(state));
  const serialized = `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  await writeFile(temporary, serialized, "utf8");
  await rename(temporary, resolved);
}

function retryStateRecorder({ outputPath, round, stage, state }) {
  return async (snapshot) => {
    round.modelRetries ??= {};
    round.modelRetries[stage] = snapshot;
    await persistState(outputPath, state);
  };
}

function scriptedDecision(config, index) {
  const terminal = index + 1 === config.maxRounds;
  return {
    evaluation: validateEvaluation(config.rounds[index].evaluation),
    nextAttachmentNames: !terminal
      ? [...(config.rounds[index + 1].attachmentNames ?? [])]
      : [],
    nextPrompt: !terminal ? config.rounds[index + 1].prompt : "",
    productAssessment: terminal
      ? validateProductAssessment(null, { requirement: config.resolvedProductRequirement })
      : null,
    taskOutcome: terminal ? "complete" : "continue",
    unresolvedIssues: [],
  };
}

function promptForRound(config, index, state) {
  if (config.mode === "scripted") return config.rounds[index].prompt;
  if (index === 0) return String(config.initialPrompt);
  return state.rounds[index - 1].decision.nextPrompt;
}

function attachmentNamesForRound(config, index, state) {
  if (index === 0) return [...config.initialAttachmentNames];
  if (config.mode === "scripted") return [...(config.rounds[index].attachmentNames ?? [])];
  return [...(state.rounds[index - 1].decision.nextAttachmentNames ?? [])];
}

function availableAttachmentsForPlanner(preparedAttachments, uploadedAttachmentNames) {
  const uploaded = new Set(uploadedAttachmentNames);
  return preparedAttachments.receipt.attachments
    .filter((attachment) => !uploaded.has(attachment.name))
    .map((attachment) => ({
      classification: attachment.classification,
      introductionHint: attachment.introductionHint ?? "",
      name: attachment.name,
      sourceUrl: attachment.sourceUrl,
      summary: attachment.summary ?? "",
    }));
}

async function collectShareAndLog(page, state, config, signal, quotaGate) {
  throwIfJobPauseRequested(signal);
  await quotaGate.waitIfPaused({ signal });
  await openLatestShare(page, { signal });
  await quotaGate.waitIfPaused({ signal });
  const share = await copyOpenShareLink(page, { selectAll: true, signal });
  if (!/^https:\/\/www\.doubao\.com\/thread\/x[0-9a-f]+$/iu.test(share.clipboardText)) {
    throw new Error("Copied share link did not match the expected Doubao thread format.");
  }
  await quotaGate.waitIfPaused({ signal });
  const log = await copyLatestLogInfo(page, { signal });
  throwIfJobPauseRequested(signal);
  state.feedbackUrl = log.feedbackUrl;
  state.logId = log.logId;
  state.shareLink = share.clipboardText;
  state.shareReceipt = {
    allSelected: share.selectAllCheckedAfter === true,
    checkboxCount: share.checkboxCount,
    clipboardReadError: share.clipboardReadError,
    copied: share.copied,
    pass: share.copied === true
      && !share.clipboardReadError
      && share.selectAllCheckedAfter === true,
    selectAll: share.selectAll,
    selectionProof: "global-select-all-checkbox",
    selectedCount: share.checkedAfter.filter(Boolean).length,
    shareLink: share.clipboardText,
    verifiedAt: new Date().toISOString(),
  };
  if (!state.shareReceipt.pass) {
    throw new Error("Share selection/link readback did not prove that every conversation item was selected.");
  }
  state.logReceipt = {
    feedbackUrl: log.feedbackUrl,
    logId: log.logId,
    pass: Boolean(log.feedbackUrl && log.logId),
    responseCount: log.responseCount,
    verifiedAt: new Date().toISOString(),
  };
  if (!state.logReceipt.pass) throw new Error("Doubao log information was incomplete.");
  return { log, share };
}

export async function runDoubaoJob({
  config: rawConfig,
  executionSlot = null,
  interactionGate = null,
  outputPath,
  page,
  resume = false,
  runId = randomUUID(),
  signal,
  withSharedResource = async (_resource, fn) => fn(),
  workerPid = process.pid,
} = {}) {
  if (typeof withSharedResource !== "function") throw new Error("withSharedResource must be a function.");
  const quotaGate = interactionGate ?? new InteractionQuotaGate();
  const beforeModelAttempt = () => quotaGate.waitIfPaused({ signal });
  const interactionAwareModelDelay = async (delayMs, retrySignal) => {
    let remainingMs = Number(delayMs);
    while (remainingMs > 0) {
      await quotaGate.waitIfPaused({ signal: retrySignal });
      const chunkMs = Math.min(remainingMs, 1_000);
      await abortableDelay(chunkMs, retrySignal);
      remainingMs -= chunkMs;
    }
  };
  const hydratedConfig = await hydrateJobAttachmentsFromProductionTrace(rawConfig);
  const config = validateJobConfig(hydratedConfig);
  if (!outputPath) throw new Error("outputPath is required.");
  const currentConfigHash = configHash(config);
  const normalizedExecutionSlot = executionSlot && typeof executionSlot === "object"
    ? {
      browserContextId: String(executionSlot.browserContextId ?? ""),
      endpoint: String(executionSlot.endpoint ?? ""),
      targetId: String(executionSlot.targetId ?? ""),
      workerId: String(executionSlot.workerId ?? ""),
    }
    : null;
  const freshState = {
    configHash: currentConfigHash,
    conversationId: "",
    jobId: config.jobId,
    minimumRounds: config.minimumRounds,
    maxRounds: config.maxRounds,
    mode: config.mode,
    contentScopePolicyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION,
    executionSlot: normalizedExecutionSlot,
    finalProductAcceptance: null,
    productRequirement: config.resolvedProductRequirement,
    rounds: [],
    runId,
    schemaVersion: 8,
    successCriteria: config.successCriteria ?? [],
    taskGoal: config.taskGoal ?? "",
    startedAt: new Date().toISOString(),
    status: "starting",
    codexUsageHistory: [],
    uploadedAttachmentNames: [],
    workerPid,
    workerStartedAt: new Date().toISOString(),
  };
  const state = resume
    ? JSON.parse(await readFile(path.resolve(outputPath), "utf8"))
    : freshState;
  let resumablePromptRound = null;
  let resumableQuotaRound = null;
  let resumableSendingRound = null;
  let resumableResponseRound = null;
  let resumePostInteraction = false;
  if (resume) {
    if (state.configHash !== currentConfigHash || state.jobId !== config.jobId
      || state.mode !== config.mode || Number(state.minimumRounds ?? 6) !== config.minimumRounds
      || Number(state.maxRounds) !== config.maxRounds) {
      throw new Error("Resume result does not match the current job config.");
    }
    if (state.executionSlot?.targetId && normalizedExecutionSlot?.targetId
      && state.executionSlot.targetId !== normalizedExecutionSlot.targetId) {
      throw new Error("Resume must use the same Doubao window target as the saved job state.");
    }
    if (normalizedExecutionSlot) state.executionSlot = normalizedExecutionSlot;
    const completedPrefix = [];
    for (const round of state.rounds ?? []) {
      if (round?.status !== "complete") break;
      completedPrefix.push(round);
    }
    if ((state.rounds ?? []).slice(completedPrefix.length).some((round) => round?.status === "complete")) {
      throw new Error("Resume result contains a non-contiguous completed round sequence.");
    }
    const nextRound = (state.rounds ?? [])[completedPrefix.length];
    resumePostInteraction = completedPrefix.length >= config.minimumRounds
      && !nextRound
      && state.finalProductAcceptance != null
      && ["complete", "doubao-unable"].includes(String(state.completionOutcome ?? ""))
      && completedPrefix.at(-1)?.decision?.taskOutcome !== "continue";
    if (nextRound?.status === "feedback_preflight"
      && state.error?.code === "MODEL_INVOCATION_FAILED"
      && /Codex prompt quality gate/iu.test(String(state.error?.message ?? ""))) {
      nextRound.feedbackPreflightFailure ??= {
        failedAt: state.failedAt ?? "",
        message: state.error.message,
        recoveredFromRunError: true,
      };
    }
    if (state.error?.code === INTERACTION_QUOTA_SUSPENDED
      && ["rewriting", "preflight"].includes(String(nextRound?.status ?? ""))
      && nextRound?.plannedPrompt && !nextRound?.response) {
      resumablePromptRound = nextRound;
    } else if (state.error?.code === INTERACTION_QUOTA_SUSPENDED
      && ["quota_waiting", "quota_retry_ready"].includes(String(nextRound?.status ?? ""))
      && nextRound?.prompt) {
      resumableQuotaRound = nextRound;
    } else if (isResumablePromptQualityRound(nextRound, state.error)) {
      nextRound.promptQualityFailure ??= {
        failedAt: state.failedAt ?? "",
        message: state.error.message,
        recoveredFromRunError: true,
      };
      resumablePromptRound = nextRound;
    } else if (["sending", "recovering_visible_response"].includes(nextRound?.status)
      && nextRound.prompt && !nextRound.response) {
      resumableSendingRound = nextRound;
    } else if (isResumableVisibleResponseRound(nextRound)) {
      resumableResponseRound = nextRound;
    }
    for (const round of [
      ...completedPrefix,
      resumablePromptRound,
      resumableQuotaRound,
      resumableSendingRound,
      resumableResponseRound,
    ]) {
      if (round) delete round.responseScreenshot;
    }
    state.rounds = completedPrefix;
    state.schemaVersion = 8;
    state.resumeHistory ??= [];
    state.resumeHistory.push({
      previousRunId: state.runId ?? "",
      previousStatus: state.status ?? "",
      resumedAt: new Date().toISOString(),
    });
    state.runId = runId;
    state.status = "resuming";
    state.workerPid = workerPid;
    state.workerStartedAt = new Date().toISOString();
    delete state.error;
    delete state.failedAt;
    delete state.pause;
  }
  await persistState(outputPath, state);

  try {
    throwIfJobPauseRequested(signal);
    await quotaGate.waitIfPaused({ signal });
    state.initialContentScope = assertDomesticWorkScope(promptForRound(config, 0, state), {
      context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
      requireWorkScene: true,
    });
    const preparedAttachments = await prepareJobAttachments(config);
    state.attachmentManifest = preparedAttachments.receipt;
    await persistState(outputPath, state);
    let initial = await inspectChat(page);
    throwIfJobPauseRequested(signal);
    if (initial.loginRequired) throw new Error("Doubao login is required.");
    if (resume && state.conversationId
      && (!initial.officeModeActive || initial.composerKind !== "office")) {
      const currentConversationId = String(page.url()).match(/\/chat\/(\d+)(?:[/?#]|$)/u)?.[1] ?? "";
      if (currentConversationId === state.conversationId) {
        await page.goto(`chrome://doubao-chat/chat/${state.conversationId}`, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForTimeout(5_000);
        initial = await inspectChat(page);
        if (!initial.officeModeActive || initial.composerKind !== "office") {
          await page.waitForTimeout(3_000);
          initial = await inspectChat(page);
        }
      }
    }
    const hasResumableConversation = resume && Boolean(state.conversationId);
    if (!hasResumableConversation) await quotaGate.waitIfPaused({ signal });
    const office = hasResumableConversation ? initial : await openNewOfficeTask(page);
    throwIfJobPauseRequested(signal);
    if (!office.officeModeActive || office.composerKind !== "office") {
      throw new Error(hasResumableConversation
        ? "The resumable Office Task is not active."
        : "A new Office Task did not become active.");
    }
    if (!office.localComputerStateKnown || office.localComputerActive !== false) {
      throw new Error("Local Computer was active or its disabled state could not be verified.");
    }
    if (resume && state.conversationId) {
      const currentConversationId = String(page.url()).match(/\/chat\/(\d+)(?:[/?#]|$)/u)?.[1] ?? "";
      if (!state.conversationId || currentConversationId !== state.conversationId) {
        throw new Error("The active Doubao conversation does not match the resumable result.");
      }
    }
    state.status = "running";
    await persistState(outputPath, state);

    for (let index = state.rounds.length; !resumePostInteraction && index < config.maxRounds; index += 1) {
      throwIfJobPauseRequested(signal);
      await quotaGate.waitIfPaused({ signal });
      if (resumableQuotaRound && index === state.rounds.length) {
        const round = resumableQuotaRound;
        state.rounds.push(round);
        delete round.response;
        delete round.responseVisibility;
        round.status = "quota_retry_ready";
        resumableQuotaRound = null;
        await persistState(outputPath, state);
        await quotaGate.waitIfPaused({ signal });
        round.status = "sending";
        await persistState(outputPath, state);
        round.response = await sendAndWait(page, round.prompt, {
          attachments: [],
          attachmentUploadTimeoutMs: Number(config.attachmentUploadTimeoutMs ?? 180_000),
          signal,
          timeoutMs: config.mode === "scripted" ? Number(config.responseTimeoutMs ?? 300_000) : 0,
        });
        round.status = "response_received";
        state.conversationId = round.response.conversationId;
        await persistState(outputPath, state);
      } else if (resumableSendingRound && index === state.rounds.length) {
        const round = resumableSendingRound;
        state.rounds.push(round);
        round.status = "recovering_visible_response";
        await persistState(outputPath, state);
        const response = await recoverLatestSentExchange(page, round.prompt, {
          attachmentNames: round.attachmentNames,
          signal,
          timeoutMs: config.mode === "scripted" ? Number(config.responseTimeoutMs ?? 300_000) : 0,
        });
        round.response = response;
        state.uploadedAttachmentNames.push(...round.attachmentNames);
        round.status = "response_received";
        state.conversationId = response.conversationId;
        resumableSendingRound = null;
        await persistState(outputPath, state);
      } else if (resumableResponseRound && index === state.rounds.length) {
        const round = resumableResponseRound;
        state.rounds.push(round);
        if (round.response.conversationId !== state.conversationId) {
          throw new Error("The visible-response recovery conversation does not match the current task.");
        }
        round.status = "response_received";
        resumableResponseRound = null;
        await persistState(outputPath, state);
      } else {
        const recoveredPromptRound = resumablePromptRound && index === state.rounds.length
          ? resumablePromptRound
          : null;
        const plannedPrompt = recoveredPromptRound?.plannedPrompt
          ?? promptForRound(config, index, state);
        const roundAttachmentNames = recoveredPromptRound?.attachmentNames
          ?? attachmentNamesForRound(config, index, state);
        if (roundAttachmentNames.some((name) => state.uploadedAttachmentNames.includes(name))) {
          throw new Error(`Round ${index + 1} attempted to reupload an attachment already introduced earlier.`);
        }
        const roundAttachments = selectPreparedAttachments(preparedAttachments, roundAttachmentNames);
        const contentScopeBeforeModel = assertDomesticWorkScope(plannedPrompt, {
          context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
          requireInteractionAdvance: index > 0,
          requireWorkScene: true,
        });
        const round = recoveredPromptRound ?? {
            contentScopeBeforeModel,
            contentScopeAfterModel: null,
            evaluation: null,
            feedbackPreflight: null,
            feedbackRewrite: null,
            attachmentNames: roundAttachmentNames,
            index: index + 1,
            plannedPrompt,
            preflight: null,
            prompt: "",
            response: null,
            rewrite: null,
            status: "rewriting",
          };
        round.contentScopeBeforeModel = contentScopeBeforeModel;
        state.rounds.push(round);
        resumablePromptRound = null;
        await persistState(outputPath, state);

        let promptQualityIssue = String(round.promptQualityFailure?.message ?? "");
        round.promptQualityRetryTrace ??= [];
        for (let promptAttempt = 1; promptAttempt <= 3; promptAttempt += 1) {
          try {
            if (!round.rewrite?.pass || promptQualityIssue) {
              await quotaGate.waitIfPaused({ signal });
              round.status = "rewriting";
              await persistState(outputPath, state);
              round.rewrite = await requestInteractionRewrite({
                beforeModelAttempt,
                job: config,
                onRetryState: retryStateRecorder({ outputPath, round, stage: "prompt_de_ai_rewrite", state }),
                policy: config.interactionRewrite,
                prompt: plannedPrompt,
                recentPrompts: state.rounds.slice(Math.max(0, index - 3), index).map((item) => item.prompt),
                roundNumber: index + 1,
                signal,
                sleepImpl: interactionAwareModelDelay,
                validationFeedback: promptQualityIssue,
              });
              round.preflight = null;
            }
            throwIfJobPauseRequested(signal);
            round.contentScopeAfterRewrite = assertDomesticWorkScope(round.rewrite.prompt, {
              context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
              requireInteractionAdvance: index > 0,
              requireWorkScene: true,
            });
            if (!round.preflight?.pass) {
              await quotaGate.waitIfPaused({ signal });
              round.status = "preflight";
              await persistState(outputPath, state);
              round.preflight = await requestPromptPreflight({
                beforeModelAttempt,
                conversationContext: index > 0 ? {
                  previousPrompt: state.rounds[index - 1].prompt,
                  previousResponse: state.rounds[index - 1].response?.response ?? "",
                  previousResponseArtifacts: state.rounds[index - 1].response?.artifacts ?? [],
                  recentPrompts: state.rounds.slice(Math.max(0, index - 3), index).map((item) => item.prompt),
                } : null,
                job: config,
                onRetryState: retryStateRecorder({ outputPath, round, stage: "prompt_preflight", state }),
                policy: config.promptPreflight,
                prompt: round.rewrite.prompt,
                roundNumber: index + 1,
                signal,
                sleepImpl: interactionAwareModelDelay,
                sourcePrompt: plannedPrompt,
              });
            }
            round.promptQualityRetryTrace.push({ attempt: promptAttempt, status: "accepted" });
            delete round.promptQualityFailure;
            break;
          } catch (error) {
            promptQualityIssue = error.message;
            round.promptQualityFailure = {
              failedAt: new Date().toISOString(),
              message: error.message,
            };
            round.promptQualityRetryTrace.push({
              attempt: promptAttempt,
              issue: error.message,
              model: error.model ?? config.promptPreflight.model,
              provider: error.provider ?? "",
              status: "rejected",
              usage: error.usage ?? null,
            });
            if (error.usage) error.usageRecorded = true;
            await persistState(outputPath, state);
            if (promptAttempt >= 3 || !isRepairablePromptQualityFailure(error)) throw error;
          }
        }
      throwIfJobPauseRequested(signal);
      round.prompt = round.preflight.prompt;
      round.contentScopeAfterModel = assertDomesticWorkScope(round.prompt, {
        context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
        requireInteractionAdvance: index > 0,
        requireWorkScene: true,
      });
      await quotaGate.waitIfPaused({ signal });
      round.status = "sending";
      if (roundAttachmentNames.length) {
        round.attachmentVerification = await verifyPreparedAttachments(preparedAttachments, {
          names: roundAttachmentNames,
        });
      }
      await persistState(outputPath, state);

      const response = await sendAndWait(page, round.prompt, {
        attachments: roundAttachments,
        attachmentUploadTimeoutMs: Number(config.attachmentUploadTimeoutMs ?? 180_000),
        signal,
        timeoutMs: config.mode === "scripted" ? Number(config.responseTimeoutMs ?? 300_000) : 0,
      });
      throwIfJobPauseRequested(signal);
      round.response = response;
      state.uploadedAttachmentNames.push(...roundAttachmentNames);
      round.status = "response_received";
      state.conversationId = response.conversationId;
      await persistState(outputPath, state);
      }

      const round = state.rounds[index];

      while (true) {
        round.responseVisibility = auditVisibleResponse(round.response.response);
        delete round.responseScreenshot;
        round.status = "response_visibility_pass";
        await persistState(outputPath, state);
        if (!round.responseVisibility.observations?.includes("doubao-quota-unavailable")) break;

        const quotaResponse = structuredClone(round.response);
        const quotaPause = await quotaGate.triggerFromNotice({
          jobId: state.jobId,
          notice: quotaResponse.response,
          targetId: state.executionSlot?.targetId ?? "",
        });
        if (!quotaPause) throw new Error("Doubao quota response was detected but its pause receipt could not be created.");
        round.quotaHistory ??= [];
        round.quotaHistory.push({
          detectedAt: quotaPause.detectedAt,
          pause: quotaPause,
          response: quotaResponse,
        });
        delete round.response;
        delete round.responseVisibility;
        round.status = "quota_waiting";
        state.pause = {
          ...quotaPause,
          reason: "doubao-quota-unavailable",
          resumePolicy: quotaPause.mode === "automatic"
            ? "resume-at-doubao-recovery-time-plus-one-minute-and-retry-the-same-round"
            : "manual-resume-only-after-operator-instruction",
        };
        state.status = "paused_quota_wait";
        await persistState(outputPath, state);

        await quotaGate.waitIfPaused({ signal });
        delete state.pause;
        state.status = "running";
        round.status = "quota_retry_ready";
        await persistState(outputPath, state);

        await quotaGate.waitIfPaused({ signal });
        round.status = "sending";
        await persistState(outputPath, state);
        round.response = await sendAndWait(page, round.prompt, {
          attachments: [],
          attachmentUploadTimeoutMs: Number(config.attachmentUploadTimeoutMs ?? 180_000),
          signal,
          timeoutMs: config.mode === "scripted" ? Number(config.responseTimeoutMs ?? 300_000) : 0,
        });
        throwIfJobPauseRequested(signal);
        round.status = "response_received";
        state.conversationId = round.response.conversationId;
        await persistState(outputPath, state);
      }

      if (config.mode === "scripted" && config.rounds[index].expectedResponse != null) {
        const expected = String(config.rounds[index].expectedResponse).trim();
        if (round.response.response.trim() !== expected) {
          throw new Error(`Round ${index + 1} response did not match expectedResponse.`);
        }
      }

      const transcript = state.rounds.map((item) => ({
        artifacts: item.response?.artifacts ?? [],
        prompt: item.prompt,
        response: item.response?.response ?? "",
        round: item.index,
      }));
      await quotaGate.waitIfPaused({ signal });
      let decision = round.decision;
      if (decision && config.mode !== "scripted") {
        try {
          validatePolicyDecision(decision, {
            availableAttachmentNames: availableAttachmentsForPlanner(
              preparedAttachments,
              state.uploadedAttachmentNames,
            ).map((attachment) => attachment.name),
            finalRound: index + 1 === config.maxRounds,
            latestArtifacts: round.response?.artifacts ?? [],
            latestResponse: round.response?.response ?? "",
            minimumRounds: config.minimumRounds,
            productRequirement: config.resolvedProductRequirement,
            roundNumber: index + 1,
          });
        } catch (error) {
          round.invalidatedDecision = {
            invalidatedAt: new Date().toISOString(),
            message: error.message,
          };
          delete round.decision;
          delete round.feedbackSourceNote;
          delete round.feedbackRewrite;
          delete round.feedbackPreflight;
          delete round.feedbackPreflightFailure;
          decision = null;
          await persistState(outputPath, state);
        }
      }
      decision ??= (config.mode === "scripted"
        ? scriptedDecision(config, index)
        : await requestPolicyDecision({
          availableAttachments: availableAttachmentsForPlanner(
            preparedAttachments,
            state.uploadedAttachmentNames,
          ),
          beforeModelAttempt,
          decisionValidator: index + 1 < config.maxRounds
            ? (candidate) => candidate.taskOutcome === "continue" && assertDomesticWorkScope(candidate.nextPrompt, {
                context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
                requireInteractionAdvance: true,
                requireWorkScene: true,
              })
            : undefined,
          job: config,
          maxRounds: config.maxRounds,
          minimumRounds: config.minimumRounds,
          onRetryState: retryStateRecorder({ outputPath, round, stage: "evaluation_planner", state }),
          policy: config.policy,
          productRequirement: config.resolvedProductRequirement,
          roundNumber: index + 1,
          signal,
          sleepImpl: interactionAwareModelDelay,
          transcript,
        }));
      throwIfJobPauseRequested(signal);
      if (decision.taskOutcome === "continue") {
        round.nextPromptContentScope = assertDomesticWorkScope(decision.nextPrompt, {
          context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
          requireInteractionAdvance: true,
          requireWorkScene: true,
        });
      }
      round.decision = decision;
      round.feedbackSourceNote ||= decision.evaluation.note;
      let feedbackQualityIssue = String(round.feedbackPreflightFailure?.message ?? "");
      round.feedbackQualityRetryTrace ??= [];
      for (let feedbackAttempt = 1; feedbackAttempt <= 3; feedbackAttempt += 1) {
        if (!round.feedbackRewrite?.pass || feedbackQualityIssue) {
          await quotaGate.waitIfPaused({ signal });
          round.status = "feedback_rewriting";
          await persistState(outputPath, state);
          round.feedbackRewrite = await requestInteractionRewrite({
            beforeModelAttempt,
            job: config,
            onRetryState: retryStateRecorder({ outputPath, round, stage: "feedback_de_ai_rewrite", state }),
            policy: config.interactionRewrite,
            prompt: round.feedbackSourceNote,
            roundNumber: index + 1,
            signal,
            sleepImpl: interactionAwareModelDelay,
            textPurpose: "feedback-note",
            validationFeedback: feedbackQualityIssue,
          });
          round.feedbackPreflight = null;
        }
        throwIfJobPauseRequested(signal);
        round.feedbackRewriteContentScope = assertDomesticWorkScope(round.feedbackRewrite.prompt, {
          enforceCalculationComplexity: false,
        });
        try {
          if (!round.feedbackPreflight?.pass) {
            await quotaGate.waitIfPaused({ signal });
            round.status = "feedback_preflight";
            await persistState(outputPath, state);
            round.feedbackPreflight = await requestPromptPreflight({
              beforeModelAttempt,
              conversationContext: {
                currentPrompt: round.prompt,
                currentResponse: round.response?.response ?? "",
                currentResponseArtifacts: round.response?.artifacts ?? [],
                proposedScore: decision.evaluation.score ?? null,
                proposedVote: decision.evaluation.vote,
                proposedLabels: decision.evaluation.labels,
                evidenceQuote: decision.evaluation.evidenceQuote ?? "",
                successCriteria: config.successCriteria ?? [],
              },
              job: config,
              onRetryState: retryStateRecorder({ outputPath, round, stage: "feedback_preflight", state }),
              policy: config.promptPreflight,
              prompt: round.feedbackRewrite.prompt,
              roundNumber: index + 1,
              signal,
              sleepImpl: interactionAwareModelDelay,
              sourcePrompt: round.feedbackSourceNote,
              textPurpose: "feedback-note",
            });
          }
          round.feedbackQualityRetryTrace.push({ attempt: feedbackAttempt, status: "accepted" });
          delete round.feedbackPreflightFailure;
          break;
        } catch (error) {
          feedbackQualityIssue = error.message;
          round.feedbackPreflightFailure = {
            failedAt: new Date().toISOString(),
            message: error.message,
          };
          round.feedbackQualityRetryTrace.push({
            attempt: feedbackAttempt,
            issue: error.message,
            model: error.model ?? config.promptPreflight.model,
            provider: error.provider ?? "",
            status: "rejected",
            usage: error.usage ?? null,
          });
          if (error.usage) error.usageRecorded = true;
          await persistState(outputPath, state);
          if (feedbackAttempt >= 3 || !isRepairablePromptQualityFailure(error)) throw error;
        }
      }
      throwIfJobPauseRequested(signal);
      await quotaGate.waitIfPaused({ signal });
      decision.evaluation.note = round.feedbackPreflight.prompt;
      round.feedbackContentScope = assertDomesticWorkScope(decision.evaluation.note, {
        enforceCalculationComplexity: false,
      });
      round.status = "evaluating";
      await persistState(outputPath, state);

      const submittedEvaluation = await evaluateLatestResponse(page, { ...decision.evaluation, signal });
      round.evaluation = {
        ...submittedEvaluation,
        evidenceQuote: decision.evaluation.evidenceQuote ?? "",
        score: decision.evaluation.score ?? null,
      };
      throwIfJobPauseRequested(signal);
      round.productAssessment = decision.productAssessment;
      round.status = "complete";
      await persistState(outputPath, state);
      if (decision.taskOutcome !== "continue") {
        const formatAssessment = decision.productAssessment
          ?? validateProductAssessment(null, { requirement: config.resolvedProductRequirement });
        state.finalProductAcceptance = config.mode === "scripted"
          ? formatAssessment
          : enforceFinalExperienceAcceptance(formatAssessment, decision.evaluation);
        state.completionOutcome = decision.taskOutcome;
        state.unresolvedIssues = [...(decision.unresolvedIssues ?? [])];
        if (decision.taskOutcome === "doubao-unable") {
          state.finalProductAcceptance.accepted = false;
          state.finalProductAcceptance.overall = "doubao-unable-to-complete-task";
        }
        await persistState(outputPath, state);
        break;
      }
    }

    state.status = "sharing";
    await persistState(outputPath, state);
    await quotaGate.waitIfPaused({ signal });
    await withSharedResource("system-clipboard", async () => {
      await quotaGate.waitIfPaused({ signal });
      return collectShareAndLog(page, state, config, signal, quotaGate);
    });
    state.status = "packaging_submission";
    await persistState(outputPath, state);
    state.submissionPackage = state.finalProductAcceptance?.accepted === true
      ? await writeSubmissionPackage(state, {
        resultPath: path.resolve(outputPath),
        target: config.feishuSubmissionTarget ?? null,
      })
      : await writeIncompleteSubmissionPackage(state, {
        resultPath: path.resolve(outputPath),
        target: config.feishuSubmissionTarget ?? null,
      });
    state.completedAt = new Date().toISOString();
    state.status = "complete";
    state.stoppedWorkerPid = state.workerPid;
    state.workerPid = null;
    state.workerStoppedAt = new Date().toISOString();
    validateCompletedJobResult(state);
    await verifyCompletedJobArtifacts(state, { resultPath: path.resolve(outputPath) });
    await persistState(outputPath, state);
    return state;
  } catch (error) {
    if (error?.usage && error.usageRecorded !== true) {
      state.codexUsageHistory ??= [];
      state.codexUsageHistory.push({
        round: Number(state.rounds?.at(-1)?.index ?? 0),
        stage: "failed-codex-call",
        provider: String(error.provider ?? ""),
        model: String(error.model ?? ""),
        usage: error.usage,
      });
    }
    state.error = {
      code: error.code ?? "",
      message: error.message,
      stack: error.stack,
      attempts: error.attempts ?? [],
      issues: error.issues ?? [],
      productAssessment: error.productAssessment ?? null,
      usage: error.usage ?? null,
    };
    state.failedAt = new Date().toISOString();
    if (error?.code === JOB_PAUSE_REQUESTED) {
      state.pause = {
        reason: "operator-request",
        resumePolicy: "manual-resume-only-no-fallback",
      };
      state.status = "paused_by_operator";
    } else if (error?.code === INTERACTION_QUOTA_SUSPENDED) {
      state.pause = {
        ...(error.quotaPause ?? quotaGate.snapshot() ?? {}),
        reason: "doubao-quota-unavailable",
        resumePolicy: "manual-resume-only-after-operator-instruction",
      };
      state.status = "paused_quota_wait";
    } else if (error?.code === "MODEL_INVOCATION_EXHAUSTED") {
      state.pause = {
        reason: "upstream-model-unavailable",
        resumePolicy: "manual-resume-only-no-fallback",
        retrySchedule: "three-quick-retries-within-two-minutes-then-three-six-minute-retries",
      };
      state.status = "paused_model_unavailable";
    } else if (error?.code === "MODEL_INVOCATION_FAILED") {
      state.pause = {
        reason: "model-invocation-failed",
        resumePolicy: "manual-resume-only-no-fallback",
        retrySchedule: "non-retryable-model-errors-pause-immediately",
      };
      state.status = "paused_model_error";
    } else if (error?.code === "FINAL_PRODUCT_NOT_ACCEPTED") {
      state.pause = {
        reason: "final-product-not-accepted",
        resumePolicy: "continue-corrective-follow-ups-or-package-a-documented-doubao-product-gap",
      };
      state.status = "paused_final_product";
    } else if (error?.code === "CONTENT_SCOPE_BLOCKED") {
      state.pause = {
        reason: "domestic-work-scope-blocked",
        resumePolicy: error.afterVisibleResponse
          ? "do-not-continue-or-share-this-conversation"
          : "resample-or-rewrite-before-manual-resume-no-fallback",
        policyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION,
      };
      state.status = "paused_content_scope_blocked";
    } else if (["ATTACHMENT_UPLOAD_FAILED", "ATTACHMENT_UPLOAD_TIMEOUT"].includes(error?.code)) {
      state.pause = {
        reason: "attachment-upload-not-verified",
        resumePolicy: "discard-current-composer-and-restart-a-new-office-task-no-fallback",
      };
      state.status = "paused_attachment_upload";
    } else if (error?.code === "SEND_READBACK_FAILED") {
      state.pause = {
        reason: "sent-prompt-not-verified",
        resumePolicy: "verify-the-active-conversation-before-resume-no-blind-duplicate-send",
      };
      state.status = "paused_send_readback";
    } else {
      state.status = "failed";
    }
    state.stoppedWorkerPid = state.workerPid;
    state.workerPid = null;
    state.workerStoppedAt = new Date().toISOString();
    await persistState(outputPath, state);
    throw error;
  }
}
