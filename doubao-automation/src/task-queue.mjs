import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { prepareJobAttachments } from "./attachment-files.mjs";
import { validateJobConfig } from "./job-runner.mjs";
import { hydrateJobAttachmentsFromProductionTrace } from "./production-evidence.mjs";

export const INTERACTION_QUEUE_SCHEMA_VERSION = 1;
export const INTERACTION_QUEUE_STATES = Object.freeze([
  "pending",
  "running",
  "completed",
  "paused",
  "failed",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeJobId(value) {
  const jobId = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(jobId)) {
    throw new Error("Queue jobId must contain 3-128 safe filename characters.");
  }
  return jobId;
}

function safeResourceName(value) {
  const resource = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/u.test(resource)) {
    throw new Error("Queue resource name must contain 2-64 safe filename characters.");
  }
  return resource;
}

function queuePaths(queueRoot) {
  const root = path.resolve(queueRoot);
  return {
    root,
    packages: path.join(root, "packages"),
    results: path.join(root, "results"),
    locks: path.join(root, "locks"),
    state: Object.fromEntries(INTERACTION_QUEUE_STATES.map((name) => [name, path.join(root, name)])),
  };
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(temporary, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EACCES", "EBUSY", "EPERM"].includes(error?.code) || attempt === 7) break;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  await rm(temporary, { force: true });
  throw lastError;
}

async function renameWithTransientWindowsRetry(sourcePath, targetPath, { attempts = 8 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EACCES", "EBUSY", "EPERM"].includes(error?.code) || attempt === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function ensureInteractionQueue(queueRoot) {
  const paths = queuePaths(queueRoot);
  await Promise.all([
    mkdir(paths.packages, { recursive: true }),
    mkdir(paths.results, { recursive: true }),
    mkdir(paths.locks, { recursive: true }),
    ...Object.values(paths.state).map((dir) => mkdir(dir, { recursive: true })),
  ]);
  return paths;
}

function abortableWait(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Queue resource wait aborted."));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Queue resource wait aborted."));
    }, { once: true });
  });
}

export async function withInteractionQueueResourceLock({
  fn,
  queueRoot,
  resource,
  retryMs = 100,
  signal,
  staleMs = 5 * 60 * 1000,
} = {}) {
  if (typeof fn !== "function") throw new Error("Queue resource lock requires fn.");
  const paths = await ensureInteractionQueue(queueRoot);
  const resourceName = safeResourceName(resource);
  const lockDir = path.join(paths.locks, `${resourceName}.lock`);
  const lockFile = path.join(lockDir, "owner.json");
  const ownerToken = randomUUID();
  let acquired = false;

  while (!acquired) {
    if (signal?.aborted) throw signal.reason ?? new Error("Queue resource wait aborted.");
    try {
      await mkdir(lockDir);
      const acquiredAt = new Date().toISOString();
      await writeJsonAtomic(lockFile, {
        acquiredAt,
        heartbeatAt: acquiredAt,
        ownerPid: process.pid,
        ownerToken,
        resource: resourceName,
      });
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let staleOwner = null;
      try {
        staleOwner = await readJson(lockFile);
      } catch (readError) {
        if (readError?.code !== "ENOENT" && !(readError instanceof SyntaxError)) throw readError;
      }
      let heartbeatAt = Date.parse(staleOwner?.heartbeatAt ?? staleOwner?.acquiredAt ?? "");
      if (!Number.isFinite(heartbeatAt)) {
        try {
          heartbeatAt = (await stat(lockDir)).mtimeMs;
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw statError;
        }
      }
      if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt > staleMs) {
        const staleDir = path.join(paths.locks, `.${resourceName}.${randomUUID()}.stale`);
        try {
          await rename(lockDir, staleDir);
          await rm(staleDir, { recursive: true, force: true });
          continue;
        } catch (recoveryError) {
          if (!["ENOENT", "EACCES", "EPERM"].includes(recoveryError?.code)) throw recoveryError;
        }
      }
      await abortableWait(retryMs, signal);
    }
  }

  const heartbeatMs = Math.max(250, Math.min(30_000, Math.floor(staleMs / 3)));
  let heartbeatInFlight = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatInFlight = heartbeatInFlight.then(async () => {
      const current = await readJson(lockFile);
      if (current.ownerToken !== ownerToken) return;
      current.heartbeatAt = new Date().toISOString();
      await writeJsonAtomic(lockFile, current);
    }).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await heartbeatInFlight;
    try {
      const current = await readJson(lockFile);
      if (current.ownerToken === ownerToken) await rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function locateQueueItem(paths, jobId) {
  for (const state of INTERACTION_QUEUE_STATES) {
    const filePath = path.join(paths.state[state], `${jobId}.json`);
    if (await exists(filePath)) return { filePath, state };
  }
  return null;
}

function packagedEvidencePaths(rawConfig, evidenceDir) {
  if (!rawConfig.productionEvidence) return null;
  return {
    ...structuredClone(rawConfig.productionEvidence),
    productionTracePath: path.join(evidenceDir, "production_trace.json"),
    productionTraceGateReceiptPath: path.join(evidenceDir, "production_trace_gate_receipt.json"),
    releaseGateReceiptPath: path.join(evidenceDir, "release_gate_receipt.json"),
    downloadManifestPath: path.join(evidenceDir, "download_manifest.json"),
  };
}

const EVIDENCE_FILES = Object.freeze([
  ["productionTracePath", "production_trace.json"],
  ["productionTraceGateReceiptPath", "production_trace_gate_receipt.json"],
  ["releaseGateReceiptPath", "release_gate_receipt.json"],
  ["downloadManifestPath", "download_manifest.json"],
]);

export async function enqueueInteractionJob({ configPath, queueRoot } = {}) {
  if (!path.isAbsolute(String(configPath ?? ""))) throw new Error("configPath must be absolute.");
  const paths = await ensureInteractionQueue(queueRoot);
  const sourceBytes = await readFile(configPath);
  const rawConfig = JSON.parse(sourceBytes.toString("utf8"));
  const jobId = safeJobId(rawConfig.jobId);
  if (await locateQueueItem(paths, jobId) || await exists(path.join(paths.packages, jobId))) {
    throw new Error(`Queue job already exists: ${jobId}.`);
  }
  const hydrated = await hydrateJobAttachmentsFromProductionTrace(rawConfig);
  const validated = validateJobConfig(hydrated);
  const prepared = await prepareJobAttachments(validated);
  const enqueueLockPath = path.join(paths.packages, `.${jobId}.enqueue.lock`);
  try {
    await mkdir(enqueueLockPath);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Queue job is already being enqueued: ${jobId}.`);
    throw error;
  }
  if (await locateQueueItem(paths, jobId) || await exists(path.join(paths.packages, jobId))) {
    await rm(enqueueLockPath, { recursive: true, force: true });
    throw new Error(`Queue job already exists: ${jobId}.`);
  }
  const finalPackageDir = path.join(paths.packages, jobId);
  const stagingDir = path.join(paths.packages, `.${jobId}.${randomUUID()}.tmp`);
  const finalAttachmentDir = path.join(finalPackageDir, "attachments");
  const stagingAttachmentDir = path.join(stagingDir, "attachments");
  const finalEvidenceDir = path.join(finalPackageDir, "evidence");
  const stagingEvidenceDir = path.join(stagingDir, "evidence");
  try {
    await mkdir(stagingAttachmentDir, { recursive: true });
    await mkdir(stagingEvidenceDir, { recursive: true });
    for (const attachment of prepared.attachments) {
      await copyFile(attachment.absolutePath, path.join(stagingAttachmentDir, attachment.name));
    }
    if (rawConfig.productionEvidence) {
      for (const [key, filename] of EVIDENCE_FILES) {
        await copyFile(path.resolve(rawConfig.productionEvidence[key]), path.join(stagingEvidenceDir, filename));
      }
    }

    const packagedConfig = {
      ...structuredClone(rawConfig),
      attachmentRoot: finalAttachmentDir,
      ...(rawConfig.productionEvidence
        ? { productionEvidence: packagedEvidencePaths(rawConfig, finalEvidenceDir) }
        : {}),
    };
    if (Array.isArray(packagedConfig.attachments)) {
      packagedConfig.attachments = packagedConfig.attachments.map((attachment) => ({
        ...attachment,
        relativePath: String(attachment.name),
      }));
    }
    const packagedConfigBytes = Buffer.from(`${JSON.stringify(packagedConfig, null, 2)}\n`, "utf8");
    const packageManifest = {
      schemaVersion: INTERACTION_QUEUE_SCHEMA_VERSION,
      kind: "immutable-doubao-interaction-package",
      jobId,
      createdAt: new Date().toISOString(),
      sourceConfigPath: path.resolve(configPath),
      sourceConfigSha256: sha256(sourceBytes),
      configSha256: sha256(packagedConfigBytes),
      attachmentReceipt: prepared.receipt,
    };
    await writeFile(path.join(stagingDir, "job.json"), packagedConfigBytes);
    await writeJsonAtomic(path.join(stagingDir, "manifest.json"), packageManifest);
    await renameWithTransientWindowsRetry(stagingDir, finalPackageDir);

    const finalConfigPath = path.join(finalPackageDir, "job.json");
    const finalManifestPath = path.join(finalPackageDir, "manifest.json");
    const finalConfigBytes = await readFile(finalConfigPath);
    const finalManifestBytes = await readFile(finalManifestPath);
    if (sha256(finalConfigBytes) !== packageManifest.configSha256) {
      throw new Error("Packaged interaction config failed SHA-256 readback.");
    }
    const packagedHydrated = await hydrateJobAttachmentsFromProductionTrace(JSON.parse(finalConfigBytes.toString("utf8")));
    await prepareJobAttachments(validateJobConfig(packagedHydrated));

    const envelope = {
      schemaVersion: INTERACTION_QUEUE_SCHEMA_VERSION,
      kind: "doubao-interaction-queue-item",
      state: "pending",
      jobId,
      enqueuedAt: new Date().toISOString(),
      attempt: 0,
      configPath: finalConfigPath,
      configSha256: packageManifest.configSha256,
      packageManifestPath: finalManifestPath,
      packageManifestSha256: sha256(finalManifestBytes),
    };
    const pendingPath = path.join(paths.state.pending, `${jobId}.json`);
    await writeFile(pendingPath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { ...envelope, queueRoot: paths.root };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    if (!(await locateQueueItem(paths, jobId))) {
      await rm(finalPackageDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(enqueueLockPath, { recursive: true, force: true });
  }
}

export async function retryFailedInteractionJob({ jobId: rawJobId, queueRoot } = {}) {
  const jobId = safeJobId(rawJobId);
  const paths = await ensureInteractionQueue(queueRoot);
  const failedPath = path.join(paths.state.failed, `${jobId}.json`);
  const pendingPath = path.join(paths.state.pending, `${jobId}.json`);
  if (await exists(pendingPath)) throw new Error(`Queue job is already pending: ${jobId}.`);
  const envelope = await readJson(failedPath);
  if (envelope.jobId !== jobId || envelope.state !== "failed") {
    throw new Error(`Queue failed envelope is invalid for ${jobId}.`);
  }
  const previousResultPath = String(envelope.resultPath ?? "").trim();
  let archivedResultPath = "";
  if (previousResultPath && await exists(previousResultPath)) {
    const historyDir = path.join(paths.results, "history");
    await mkdir(historyDir, { recursive: true });
    archivedResultPath = path.join(
      historyDir,
      `${jobId}-attempt-${Number(envelope.attempt ?? 0)}-${randomUUID()}.json`,
    );
    await rename(previousResultPath, archivedResultPath);
  }
  envelope.retryHistory ??= [];
  envelope.retryHistory.push({
    archivedResultPath,
    attempt: Number(envelope.attempt ?? 0),
    failedAt: envelope.finishedAt ?? "",
    lastError: envelope.lastError ?? null,
    retriedAt: new Date().toISOString(),
  });
  envelope.state = "pending";
  envelope.retriedAt = new Date().toISOString();
  delete envelope.resume;
  delete envelope.resumeTargetId;
  delete envelope.finishedAt;
  delete envelope.lastError;
  delete envelope.lease;
  delete envelope.resultPath;
  await writeJsonAtomic(failedPath, envelope);
  await rename(failedPath, pendingPath);
  return { ...envelope, queueRoot: paths.root };
}

async function resumeTerminalInteractionJob({ jobId: rawJobId, queueRoot, sourceState } = {}) {
  const jobId = safeJobId(rawJobId);
  const paths = await ensureInteractionQueue(queueRoot);
  const sourcePath = path.join(paths.state[sourceState], `${jobId}.json`);
  const pendingPath = path.join(paths.state.pending, `${jobId}.json`);
  if (await exists(pendingPath)) throw new Error(`Queue job is already pending: ${jobId}.`);
  const envelope = await readJson(sourcePath);
  if (envelope.jobId !== jobId || envelope.state !== sourceState) {
    throw new Error(`Queue ${sourceState} envelope is invalid for ${jobId}.`);
  }
  const resultPath = String(envelope.resultPath ?? "").trim();
  if (!resultPath || !await exists(resultPath)) {
    throw new Error(`Queue job has no saved result to resume: ${jobId}.`);
  }
  const savedResult = await readJson(resultPath);
  if (savedResult.jobId !== jobId || savedResult.status === "complete") {
    throw new Error(`Queue saved result is not a resumable ${sourceState} job: ${jobId}.`);
  }
  envelope.queueResumeHistory ??= [];
  envelope.queueResumeHistory.push({
    attempt: Number(envelope.attempt ?? 0),
    failedAt: sourceState === "failed" ? envelope.finishedAt ?? "" : "",
    terminalAt: envelope.finishedAt ?? "",
    terminalState: sourceState,
    lastError: envelope.lastError ?? null,
    resumedAt: new Date().toISOString(),
  });
  envelope.state = "pending";
  envelope.resume = true;
  const resumeTargetId = String(savedResult.executionSlot?.targetId ?? "").trim();
  if (resumeTargetId) envelope.resumeTargetId = resumeTargetId;
  envelope.resumedAt = new Date().toISOString();
  delete envelope.finishedAt;
  delete envelope.lastError;
  delete envelope.lease;
  await writeJsonAtomic(sourcePath, envelope);
  await rename(sourcePath, pendingPath);
  return { ...envelope, queueRoot: paths.root };
}

export async function resumeFailedInteractionJob(options = {}) {
  return resumeTerminalInteractionJob({ ...options, sourceState: "failed" });
}

export async function resumePausedInteractionJob(options = {}) {
  return resumeTerminalInteractionJob({ ...options, sourceState: "paused" });
}

export async function resumeAllQuotaPausedInteractionJobs({ queueRoot } = {}) {
  const paths = await ensureInteractionQueue(queueRoot);
  const resumed = [];
  for (const filename of await listJson(paths.state.paused)) {
    const envelope = await readJson(path.join(paths.state.paused, filename));
    const resultPath = String(envelope.resultPath ?? "").trim();
    if (!resultPath || !await exists(resultPath)) continue;
    const savedResult = await readJson(resultPath);
    if (savedResult.status !== "paused_quota_wait") continue;
    resumed.push(await resumePausedInteractionJob({ jobId: envelope.jobId, queueRoot }));
  }
  return resumed;
}

export async function abandonPendingInteractionJob({
  jobId: rawJobId,
  queueRoot,
  reason = "The current conversation was abandoned and must restart from a new Office Task.",
} = {}) {
  const jobId = safeJobId(rawJobId);
  const paths = await ensureInteractionQueue(queueRoot);
  const pendingPath = path.join(paths.state.pending, `${jobId}.json`);
  const failedPath = path.join(paths.state.failed, `${jobId}.json`);
  const envelope = await readJson(pendingPath);
  if (envelope.jobId !== jobId || envelope.state !== "pending") {
    throw new Error(`Queue pending envelope is invalid for ${jobId}.`);
  }
  envelope.state = "failed";
  envelope.abandonedAt = new Date().toISOString();
  envelope.finishedAt = envelope.abandonedAt;
  envelope.lastError = {
    code: "CONVERSATION_ABANDONED",
    message: String(reason).trim(),
  };
  delete envelope.lease;
  await writeJsonAtomic(pendingPath, envelope);
  await renameWithTransientWindowsRetry(pendingPath, failedPath);
  return { ...envelope, queueRoot: paths.root };
}

async function listJson(dir) {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

export async function recoverStaleInteractionClaims({
  leaseTimeoutMs = 15 * 60 * 1000,
  now = Date.now(),
  queueRoot,
} = {}) {
  const paths = await ensureInteractionQueue(queueRoot);
  const recovered = [];
  for (const filename of await listJson(paths.state.running)) {
    const runningPath = path.join(paths.state.running, filename);
    const envelope = await readJson(runningPath);
    const heartbeatAt = Date.parse(envelope.lease?.heartbeatAt ?? envelope.lease?.claimedAt ?? "");
    if (Number.isFinite(heartbeatAt) && now - heartbeatAt <= leaseTimeoutMs) continue;
    const pendingPath = path.join(paths.state.pending, filename);
    envelope.state = "pending";
    envelope.recoveryCount = Number(envelope.recoveryCount ?? 0) + 1;
    envelope.recoveredAt = new Date(now).toISOString();
    const resultPath = resultPathForInteractionJob(paths.root, envelope.jobId);
    if (await exists(resultPath)) {
      const savedResult = await readJson(resultPath);
      if (savedResult?.jobId === envelope.jobId && savedResult?.status !== "complete") {
        envelope.resume = true;
        envelope.resultPath = resultPath;
        const resumeTargetId = String(
          savedResult.executionSlot?.targetId ?? envelope.lease?.targetId ?? "",
        ).trim();
        if (resumeTargetId) envelope.resumeTargetId = resumeTargetId;
      }
    }
    delete envelope.lease;
    await writeJsonAtomic(runningPath, envelope);
    try {
      await rename(runningPath, pendingPath);
      recovered.push(envelope.jobId);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return recovered;
}

export async function claimNextInteractionJob({
  queueRoot,
  targetId,
  workerId = `${process.pid}`,
} = {}) {
  const paths = await ensureInteractionQueue(queueRoot);
  const normalizedTargetId = String(targetId ?? "").trim();
  const candidates = [];
  for (const filename of await listJson(paths.state.pending)) {
    const pendingPath = path.join(paths.state.pending, filename);
    const pendingEnvelope = await readJson(pendingPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!pendingEnvelope) continue;
    const resumeTargetId = String(pendingEnvelope.resumeTargetId ?? "").trim();
    if (resumeTargetId && resumeTargetId !== normalizedTargetId) continue;
    candidates.push({ filename, priority: resumeTargetId ? 0 : 1 });
  }
  candidates.sort((left, right) => left.priority - right.priority
    || left.filename.localeCompare(right.filename));
  for (const { filename } of candidates) {
    const pendingPath = path.join(paths.state.pending, filename);
    const runningPath = path.join(paths.state.running, filename);
    try {
      await rename(pendingPath, runningPath);
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) continue;
      throw error;
    }
    const envelope = await readJson(runningPath);
    const leaseToken = randomUUID();
    const claimedAt = new Date().toISOString();
    envelope.state = "running";
    envelope.attempt = Number(envelope.attempt ?? 0) + 1;
    envelope.lease = {
      claimedAt,
      heartbeatAt: claimedAt,
      leaseToken,
      targetId: String(targetId ?? ""),
      workerId: String(workerId),
    };
    await writeJsonAtomic(runningPath, envelope);
    return { ...envelope, filePath: runningPath, leaseToken, queueRoot: paths.root };
  }
  return null;
}

async function assertClaimOwner(claim) {
  const current = await readJson(claim.filePath);
  if (current.state !== "running" || current.lease?.leaseToken !== claim.leaseToken) {
    throw new Error(`Queue claim ownership changed for ${claim.jobId}.`);
  }
  return current;
}

export async function heartbeatInteractionClaim(claim) {
  const envelope = await assertClaimOwner(claim);
  envelope.lease.heartbeatAt = new Date().toISOString();
  await writeJsonAtomic(claim.filePath, envelope);
  return envelope.lease.heartbeatAt;
}

export async function loadClaimedInteractionConfig(claim) {
  await assertClaimOwner(claim);
  const configBytes = await readFile(claim.configPath);
  if (sha256(configBytes) !== claim.configSha256) throw new Error(`Queue config hash changed for ${claim.jobId}.`);
  const manifestBytes = await readFile(claim.packageManifestPath);
  if (sha256(manifestBytes) !== claim.packageManifestSha256) {
    throw new Error(`Queue package manifest hash changed for ${claim.jobId}.`);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.jobId !== claim.jobId || manifest.configSha256 !== claim.configSha256) {
    throw new Error(`Queue package manifest binding changed for ${claim.jobId}.`);
  }
  return JSON.parse(configBytes.toString("utf8"));
}

export function resultPathForInteractionJob(queueRoot, jobId) {
  return path.join(queuePaths(queueRoot).results, `${safeJobId(jobId)}.json`);
}

export async function finishInteractionClaim(claim, {
  error = null,
  resultPath = "",
  state = "completed",
} = {}) {
  if (!INTERACTION_QUEUE_STATES.includes(state) || ["pending", "running"].includes(state)) {
    throw new Error(`Invalid terminal queue state: ${state}.`);
  }
  const envelope = await assertClaimOwner(claim);
  const paths = queuePaths(claim.queueRoot);
  envelope.state = state;
  envelope.finishedAt = new Date().toISOString();
  envelope.resultPath = resultPath ? path.resolve(resultPath) : "";
  envelope.lastError = error ? {
    code: String(error.code ?? ""),
    message: String(error.message ?? error),
  } : null;
  delete envelope.lease;
  await writeJsonAtomic(claim.filePath, envelope);
  await rename(claim.filePath, path.join(paths.state[state], path.basename(claim.filePath)));
  return envelope;
}

export async function interactionQueueStatus(queueRoot) {
  const paths = await ensureInteractionQueue(queueRoot);
  const entries = {};
  for (const state of INTERACTION_QUEUE_STATES) {
    const files = await listJson(paths.state[state]);
    entries[state] = files.map((name) => path.basename(name, ".json"));
  }
  const quotaPauseReceipt = await readJson(path.join(paths.root, "quota-pause.json")).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return {
    schemaVersion: INTERACTION_QUEUE_SCHEMA_VERSION,
    queueRoot: paths.root,
    quotaPause: quotaPauseReceipt?.status === "waiting" ? quotaPauseReceipt : null,
    counts: Object.fromEntries(INTERACTION_QUEUE_STATES.map((state) => [state, entries[state].length])),
    jobs: entries,
  };
}
