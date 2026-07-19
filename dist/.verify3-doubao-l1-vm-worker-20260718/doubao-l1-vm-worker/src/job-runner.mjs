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
  artifactRootForResult,
  captureLatestResponseScreenshot,
  isPngBytes,
  responseScreenshotPath,
} from "./artifact-capture.mjs";
import { writeSubmissionPackage } from "./submission-package.mjs";
import { resolveProductRequirement, validateProductAssessment } from "./product-requirement.mjs";
import { JOB_PAUSE_REQUESTED, throwIfJobPauseRequested } from "./job-control.mjs";
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
  sendAndWait,
} from "./doubao-client.mjs";
import {
  auditVisibleResponse,
  requestInteractionRewrite,
  requestPolicyDecision,
  requestPromptPreflight,
  validateEvaluation,
  validateOutboundPrompt,
} from "./policy.mjs";

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
  const maxRounds = Number(value.maxRounds ?? 6);
  if (!Number.isInteger(maxRounds) || maxRounds < 6 || maxRounds > 20) {
    throw new Error("maxRounds must be an integer from 6 to 20.");
  }
  const mode = String(value.mode ?? "openai-compatible");
  if (value.interactionRewrite?.type !== "openai-compatible") {
    throw new Error('interactionRewrite.type must be "openai-compatible" for every Doubao job.');
  }
  if (!String(value.interactionRewrite?.baseUrl ?? "").trim()
    || !String(value.interactionRewrite?.model ?? "").trim()) {
    throw new Error("interactionRewrite.baseUrl and interactionRewrite.model are required.");
  }
  if (value.promptPreflight?.type !== "local-codex") {
    throw new Error('promptPreflight.type must be "local-codex" for every Doubao job.');
  }
  if (!String(value.promptPreflight?.model ?? "").trim()) {
    throw new Error("promptPreflight.model is required.");
  }
  if (String(value.promptPreflight.model).trim().toLowerCase()
    === String(value.interactionRewrite.model).trim().toLowerCase()) {
    throw new Error("promptPreflight and interactionRewrite must use different models.");
  }
  const attachmentConfig = validateAttachmentConfig(value);
  const resolvedProductRequirement = resolveProductRequirement(value);
  if (mode === "scripted") {
    if (value.developmentOnlyScripted !== true) {
      throw new Error("Scripted mode is limited to explicit development regression jobs; production interactions must use openai-compatible dynamic planning.");
    }
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
    if (value.policy?.type !== "local-codex") {
      throw new Error('policy.type must be "local-codex".');
    }
    if (!String(value.policy?.model ?? "").trim()) {
      throw new Error("policy.model is required.");
    }
  } else {
    throw new Error('mode must be either "scripted" or "openai-compatible".');
  }
  return {
    ...value,
    initialAttachmentNames: attachmentConfig.initialAttachmentNames,
    jobId,
    maxRounds,
    mode,
    resolvedProductRequirement,
  };
}

export function validateCompletedJobResult(value) {
  if (value?.status !== "complete") throw new Error("Job result is not complete.");
  const maxRounds = Number(value.maxRounds);
  if (!Number.isInteger(maxRounds) || maxRounds < 6 || value.rounds?.length !== maxRounds) {
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
    validateOutboundPrompt(round.prompt);
    validateOutboundPrompt(round.evaluation.note);
    assertDomesticWorkScope(round.prompt, {
      context: { taskGoal: value.taskGoal, successCriteria: value.successCriteria },
      requireInteractionAdvance: index > 0,
      requireWorkScene: true,
    });
    if (round?.responseVisibility?.pass !== true) {
      throw new Error(`Round ${index + 1} did not pass the visible response gate.`);
    }
    const screenshot = round?.responseScreenshot;
    if (screenshot?.pass !== true
      || !String(screenshot.artifactPath ?? "").trim()
      || path.isAbsolute(String(screenshot.artifactPath))
      || path.normalize(String(screenshot.artifactPath)).startsWith("..")
      || !/^[a-f0-9]{64}$/u.test(String(screenshot.sha256 ?? ""))
      || Number(screenshot.sizeBytes) < 8
      || screenshot.responseIdentity !== round.response.responseIdentity
      || Number(screenshot.responseCount) !== Number(round.response.responseCount)) {
      throw new Error(`Round ${index + 1} has no hash-bound product screenshot.`);
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
  const initialNames = value.attachmentManifest.initialAttachmentNames ?? manifestNames;
  const firstRoundNames = value.rounds[0]?.attachmentNames ?? [];
  if (JSON.stringify(firstRoundNames) !== JSON.stringify(initialNames)) {
    throw new Error("Round 1 attachment names do not match the initial attachment plan.");
  }
  if (value?.finalProductAcceptance?.accepted !== true) {
    throw new Error("Job result has no accepted final product assessment.");
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
    || Number(shareReceipt.checkboxCount) < maxRounds
    || Number(shareReceipt.selectedCount) !== Number(shareReceipt.checkboxCount)
    || shareReceipt.shareLink !== value.shareLink) {
    throw new Error("Job result has no verified all-messages share receipt.");
  }
  if (value.logReceipt?.pass !== true
    || value.logReceipt.feedbackUrl !== value.feedbackUrl
    || value.logReceipt.logId !== value.logId) {
    throw new Error("Job result has no verified log ID receipt.");
  }
  if (value.submissionPackage?.pass !== true
    || value.submissionPackage.status !== "READY_NOT_SUBMITTED"
    || value.submissionPackage.writeApplied !== false
    || Number(value.submissionPackage.roundCount) !== maxRounds
    || Number(value.submissionPackage.screenshotCount) !== maxRounds
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
  const screenshots = [];
  for (const round of value.rounds) {
    const expected = round.responseScreenshot;
    const absolutePath = path.resolve(path.dirname(resultPath), expected.artifactPath);
    if (!isInside(absolutePath, artifactRoot)) throw new Error(`Screenshot path escaped artifact root: ${expected.artifactPath}.`);
    const fileInfo = await lstat(absolutePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error(`Screenshot is not a regular file: ${expected.artifactPath}.`);
    const realPath = await realpath(absolutePath);
    if (!isInside(realPath, rootRealPath)) throw new Error(`Screenshot real path escaped artifact root: ${expected.artifactPath}.`);
    const bytes = await readFile(realPath);
    if (!isPngBytes(bytes)) throw new Error(`Screenshot is not a valid PNG: ${expected.artifactPath}.`);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expected.sha256 || bytes.length !== Number(expected.sizeBytes)) {
      throw new Error(`Screenshot hash/size readback mismatch: ${expected.artifactPath}.`);
    }
    screenshots.push({ artifactPath: expected.artifactPath, sha256: actualHash, sizeBytes: bytes.length });
  }
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
  if (submission.status !== "READY_NOT_SUBMITTED"
    || submission.writeback?.applied !== false
    || submission.roundCount !== value.rounds.length
    || submission.conversation?.shareLink !== value.shareLink
    || submission.conversation?.logId !== value.logId
    || submission.conversation?.conversationId !== value.conversationId
    || submission.productAcceptance?.accepted !== true
    || submission.rows?.length !== value.rounds.length) {
    throw new Error("Submission package content does not match the completed result.");
  }
  for (const [index, row] of submission.rows.entries()) {
    const round = value.rounds[index];
    if (row.roundNumber !== index + 1
      || row.prompt !== round.prompt
      || row.responseIdentity !== round.response.responseIdentity
      || row.productScreenshot?.artifactPath !== round.responseScreenshot.artifactPath
      || row.productScreenshot?.sha256 !== round.responseScreenshot.sha256
      || row.humanEvaluation?.vote !== round.evaluation.vote
      || row.humanEvaluation?.note !== round.evaluation.note
      || JSON.stringify(row.humanEvaluation?.labels) !== JSON.stringify(round.evaluation.labels)) {
      throw new Error(`Submission package round ${index + 1} does not match the completed result.`);
    }
  }
  return {
    ...summary,
    artifactRoot: rootRealPath,
    screenshotCount: screenshots.length,
    screenshots,
    submissionPackage: {
      artifactPath: submissionReceipt.artifactPath,
      sha256: submissionHash,
      status: submission.status,
    },
  };
}

async function persistState(outputPath, state) {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
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
  return {
    evaluation: validateEvaluation(config.rounds[index].evaluation),
    nextAttachmentNames: index + 1 < config.maxRounds
      ? [...(config.rounds[index + 1].attachmentNames ?? [])]
      : [],
    nextPrompt: index + 1 < config.maxRounds ? config.rounds[index + 1].prompt : "",
    productAssessment: index + 1 === config.maxRounds
      ? validateProductAssessment(null, { requirement: config.resolvedProductRequirement })
      : null,
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

export async function runDoubaoJob({
  config: rawConfig,
  outputPath,
  page,
  runId = randomUUID(),
  signal,
  workerPid = process.pid,
} = {}) {
  const config = validateJobConfig(rawConfig);
  if (!outputPath) throw new Error("outputPath is required.");
  const state = {
    configHash: configHash(config),
    conversationId: "",
    jobId: config.jobId,
    maxRounds: config.maxRounds,
    mode: config.mode,
    contentScopePolicyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION,
    finalProductAcceptance: null,
    productRequirement: config.resolvedProductRequirement,
    rounds: [],
    runId,
    schemaVersion: 5,
    successCriteria: config.successCriteria ?? [],
    taskGoal: config.taskGoal ?? "",
    startedAt: new Date().toISOString(),
    status: "starting",
    uploadedAttachmentNames: [],
    workerPid,
    workerStartedAt: new Date().toISOString(),
  };
  await persistState(outputPath, state);

  try {
    throwIfJobPauseRequested(signal);
    state.initialContentScope = assertDomesticWorkScope(promptForRound(config, 0, state), {
      context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
      requireWorkScene: true,
    });
    const preparedAttachments = await prepareJobAttachments(config);
    state.attachmentManifest = preparedAttachments.receipt;
    await persistState(outputPath, state);
    const initial = await inspectChat(page);
    throwIfJobPauseRequested(signal);
    if (initial.loginRequired) throw new Error("Doubao login is required.");
    const office = await openNewOfficeTask(page);
    throwIfJobPauseRequested(signal);
    if (!office.officeModeActive || office.composerKind !== "office") {
      throw new Error("A new Office Task did not become active.");
    }
    if (!office.localComputerStateKnown || office.localComputerActive !== false) {
      throw new Error("Local Computer was active or its disabled state could not be verified.");
    }
    state.status = "running";
    await persistState(outputPath, state);

    for (let index = 0; index < config.maxRounds; index += 1) {
      throwIfJobPauseRequested(signal);
      const plannedPrompt = promptForRound(config, index, state);
      const roundAttachmentNames = attachmentNamesForRound(config, index, state);
      if (roundAttachmentNames.some((name) => state.uploadedAttachmentNames.includes(name))) {
        throw new Error(`Round ${index + 1} attempted to reupload an attachment already introduced earlier.`);
      }
      const roundAttachments = selectPreparedAttachments(preparedAttachments, roundAttachmentNames);
      const contentScopeBeforeModel = assertDomesticWorkScope(plannedPrompt, {
        context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
        requireInteractionAdvance: index > 0,
        requireWorkScene: true,
      });
      const round = {
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
      state.rounds.push(round);
      await persistState(outputPath, state);

      round.rewrite = await requestInteractionRewrite({
        job: config,
        onRetryState: retryStateRecorder({ outputPath, round, stage: "prompt_de_ai_rewrite", state }),
        policy: config.interactionRewrite,
        prompt: plannedPrompt,
        roundNumber: index + 1,
        signal,
      });
      throwIfJobPauseRequested(signal);
      round.contentScopeAfterRewrite = assertDomesticWorkScope(round.rewrite.prompt, {
        context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
        requireInteractionAdvance: index > 0,
        requireWorkScene: true,
      });
      round.status = "preflight";
      await persistState(outputPath, state);

      round.preflight = await requestPromptPreflight({
        conversationContext: index > 0 ? {
          previousPrompt: state.rounds[index - 1].prompt,
          previousResponse: state.rounds[index - 1].response?.response ?? "",
          previousResponseArtifacts: state.rounds[index - 1].response?.artifacts ?? [],
        } : null,
        job: config,
        onRetryState: retryStateRecorder({ outputPath, round, stage: "prompt_preflight", state }),
        policy: config.promptPreflight,
        prompt: round.rewrite.prompt,
        roundNumber: index + 1,
        signal,
        sourcePrompt: plannedPrompt,
      });
      throwIfJobPauseRequested(signal);
      round.prompt = round.preflight.prompt;
      round.contentScopeAfterModel = assertDomesticWorkScope(round.prompt, {
        context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
        requireInteractionAdvance: index > 0,
        requireWorkScene: true,
      });
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
        timeoutMs: Number(config.responseTimeoutMs ?? 300_000),
      });
      throwIfJobPauseRequested(signal);
      round.response = response;
      state.uploadedAttachmentNames.push(...roundAttachmentNames);
      round.status = "response_received";
      state.conversationId = response.conversationId;
      await persistState(outputPath, state);

      round.responseVisibility = auditVisibleResponse(response.response);
      round.status = "capturing_product_screenshot";
      await persistState(outputPath, state);
      const screenshotPath = responseScreenshotPath(outputPath, index + 1);
      const screenshot = await captureLatestResponseScreenshot(page, {
        expectedIdentity: response.responseIdentity,
        expectedText: response.response,
        outputPath: screenshotPath,
        signal,
      });
      round.responseScreenshot = {
        ...screenshot,
        artifactPath: path.relative(path.dirname(path.resolve(outputPath)), screenshotPath).replace(/\\/gu, "/"),
      };
      round.status = "response_visibility_pass";
      await persistState(outputPath, state);

      if (config.mode === "scripted" && config.rounds[index].expectedResponse != null) {
        const expected = String(config.rounds[index].expectedResponse).trim();
        if (response.response.trim() !== expected) {
          throw new Error(`Round ${index + 1} response did not match expectedResponse.`);
        }
      }

      const transcript = state.rounds.map((item) => ({
        artifacts: item.response?.artifacts ?? [],
        prompt: item.prompt,
        response: item.response?.response ?? "",
        round: item.index,
      }));
      const decision = config.mode === "scripted"
        ? scriptedDecision(config, index)
        : await requestPolicyDecision({
          availableAttachments: availableAttachmentsForPlanner(
            preparedAttachments,
            state.uploadedAttachmentNames,
          ),
          job: config,
          maxRounds: config.maxRounds,
          onRetryState: retryStateRecorder({ outputPath, round, stage: "evaluation_planner", state }),
          policy: config.policy,
          productRequirement: config.resolvedProductRequirement,
          roundNumber: index + 1,
          signal,
          transcript,
        });
      throwIfJobPauseRequested(signal);
      if (index + 1 < config.maxRounds) {
        round.nextPromptContentScope = assertDomesticWorkScope(decision.nextPrompt, {
          context: { taskGoal: config.taskGoal, successCriteria: config.successCriteria },
          requireInteractionAdvance: true,
          requireWorkScene: true,
        });
      }
      round.decision = decision;
      round.feedbackSourceNote = decision.evaluation.note;
      round.status = "feedback_rewriting";
      await persistState(outputPath, state);

      round.feedbackRewrite = await requestInteractionRewrite({
        job: config,
        onRetryState: retryStateRecorder({ outputPath, round, stage: "feedback_de_ai_rewrite", state }),
        policy: config.interactionRewrite,
        prompt: round.feedbackSourceNote,
        roundNumber: index + 1,
        signal,
        textPurpose: "feedback-note",
      });
      throwIfJobPauseRequested(signal);
      round.feedbackRewriteContentScope = assertDomesticWorkScope(round.feedbackRewrite.prompt);
      round.status = "feedback_preflight";
      await persistState(outputPath, state);

      round.feedbackPreflight = await requestPromptPreflight({
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
        sourcePrompt: round.feedbackSourceNote,
        textPurpose: "feedback-note",
      });
      throwIfJobPauseRequested(signal);
      decision.evaluation.note = round.feedbackPreflight.prompt;
      round.feedbackContentScope = assertDomesticWorkScope(decision.evaluation.note);
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
      if (index + 1 === config.maxRounds) {
        state.finalProductAcceptance = decision.productAssessment
          ?? validateProductAssessment(null, { requirement: config.resolvedProductRequirement });
        await persistState(outputPath, state);
        if (!state.finalProductAcceptance.accepted) {
          const error = new Error("The final Doubao response did not provide the requested product, an allowed equivalent online product, or an explicit best-effort alternative after stating that the original format was unavailable.");
          error.code = "FINAL_PRODUCT_NOT_ACCEPTED";
          error.productAssessment = state.finalProductAcceptance;
          throw error;
        }
      }
    }

    state.status = "sharing";
    await persistState(outputPath, state);
    throwIfJobPauseRequested(signal);
    await openLatestShare(page, { signal });
    const share = await copyOpenShareLink(page, { selectAll: true, signal });
    if (!/^https:\/\/www\.doubao\.com\/thread\/x[0-9a-f]+$/iu.test(share.clipboardText)) {
      throw new Error("Copied share link did not match the expected Doubao thread format.");
    }
    const log = await copyLatestLogInfo(page, { signal });
    throwIfJobPauseRequested(signal);
    state.feedbackUrl = log.feedbackUrl;
    state.logId = log.logId;
    state.shareLink = share.clipboardText;
    state.shareReceipt = {
      allSelected: share.checkboxCount >= config.maxRounds && share.checkedAfter.every(Boolean),
      checkboxCount: share.checkboxCount,
      clipboardReadError: share.clipboardReadError,
      copied: share.copied,
      pass: share.copied === true
        && !share.clipboardReadError
        && share.checkboxCount >= config.maxRounds
        && share.checkedAfter.length === share.checkboxCount
        && share.checkedAfter.every(Boolean),
      selectAll: share.selectAll,
      selectedCount: share.checkedAfter.filter(Boolean).length,
      shareLink: share.clipboardText,
      verifiedAt: new Date().toISOString(),
    };
    if (!state.shareReceipt.pass) throw new Error("Share selection/link readback did not prove that every conversation item was selected.");
    state.logReceipt = {
      feedbackUrl: log.feedbackUrl,
      logId: log.logId,
      pass: Boolean(log.feedbackUrl && log.logId),
      responseCount: log.responseCount,
      verifiedAt: new Date().toISOString(),
    };
    state.status = "packaging_submission";
    await persistState(outputPath, state);
    state.submissionPackage = await writeSubmissionPackage(state, {
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
    state.error = {
      code: error.code ?? "",
      message: error.message,
      stack: error.stack,
      attempts: error.attempts ?? [],
      issues: error.issues ?? [],
      productAssessment: error.productAssessment ?? null,
    };
    state.failedAt = new Date().toISOString();
    if (error?.code === JOB_PAUSE_REQUESTED) {
      state.pause = {
        reason: "operator-request",
        resumePolicy: "manual-resume-only-no-fallback",
      };
      state.status = "paused_by_operator";
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
        resumePolicy: "manual-review-or-new-six-round-task-no-silent-format-substitution",
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
    } else if (error?.code === "PRODUCT_SCREENSHOT_CAPTURE_FAILED") {
      state.pause = {
        reason: "product-screenshot-not-verified",
        resumePolicy: "retry-screenshot-for-the-same-response-before-feedback-no-fallback",
      };
      state.status = "paused_product_screenshot";
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
