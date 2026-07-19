import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { abortableDelay } from "./job-control.mjs";

export const INTERACTION_QUOTA_SUSPENDED = "INTERACTION_QUOTA_SUSPENDED";
export const QUOTA_RESUME_GRACE_MS = 60_000;
export const MAX_AUTOMATIC_QUOTA_WAIT_MS = 24 * 60 * 60 * 1000;

const QUOTA_NOTICE_PATTERN = /(?:额度用完|额度耗尽|预计.{0,40}恢复为你服务|开通豆包专业版|升级到(?:标准|高级)套餐)/iu;

function localDate(year, month, day, hour, minute) {
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (value.getFullYear() !== year
    || value.getMonth() !== month - 1
    || value.getDate() !== day
    || value.getHours() !== hour
    || value.getMinutes() !== minute) return null;
  return value;
}

function clockOnRelativeDay(now, dayOffset, hour, minute) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const value = new Date(now);
  value.setHours(hour, minute, 0, 0);
  value.setDate(value.getDate() + dayOffset);
  return value;
}

export function isDoubaoQuotaNotice(text) {
  return QUOTA_NOTICE_PATTERN.test(String(text ?? ""));
}

export function parseDoubaoQuotaRecovery(text, {
  graceMs = QUOTA_RESUME_GRACE_MS,
  maxAutomaticWaitMs = MAX_AUTOMATIC_QUOTA_WAIT_MS,
  now = new Date(),
} = {}) {
  const notice = String(text ?? "").trim();
  const detectedAt = new Date(now);
  if (!isDoubaoQuotaNotice(notice)) return null;

  let serviceRecoveryAt = null;
  let sourcePattern = "unparsed";
  let match = notice.match(/(?:预计\s*)?(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\d]{0,12}(\d{1,2})\s*[:：]\s*(\d{2})/u);
  if (match) {
    const year = match[1] ? Number(match[1]) : detectedAt.getFullYear();
    serviceRecoveryAt = localDate(year, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
    sourcePattern = match[1] ? "absolute-cn-date" : "month-day-clock";
  }

  if (!serviceRecoveryAt) {
    match = notice.match(/(?:预计\s*)?(今日|今天|明日|明天)[^\d]{0,8}(\d{1,2})\s*[:：]\s*(\d{2})/u);
    if (match) {
      serviceRecoveryAt = clockOnRelativeDay(
        detectedAt,
        ["明日", "明天"].includes(match[1]) ? 1 : 0,
        Number(match[2]),
        Number(match[3]),
      );
      sourcePattern = ["明日", "明天"].includes(match[1]) ? "tomorrow-clock" : "today-clock";
    }
  }

  if (!serviceRecoveryAt) {
    match = notice.match(/(?:预计|大约|约)\s*(\d+(?:\.\d+)?)\s*(分钟|小时|天)后.{0,16}恢复/u);
    if (match) {
      const multiplier = match[2] === "分钟"
        ? 60_000
        : match[2] === "小时"
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
      serviceRecoveryAt = new Date(detectedAt.getTime() + Number(match[1]) * multiplier);
      sourcePattern = "relative-duration";
    }
  }

  if (!serviceRecoveryAt) {
    match = notice.match(/(?:预计)[^\d]{0,16}(\d{1,2})\s*[:：]\s*(\d{2})[^\n]{0,20}恢复/u);
    if (match) {
      serviceRecoveryAt = clockOnRelativeDay(detectedAt, 0, Number(match[1]), Number(match[2]));
      sourcePattern = "estimated-clock";
    }
  }

  const interactionResumeAt = serviceRecoveryAt
    ? new Date(serviceRecoveryAt.getTime() + graceMs)
    : null;
  const waitMs = interactionResumeAt
    ? Math.max(0, interactionResumeAt.getTime() - detectedAt.getTime())
    : null;
  const mode = waitMs != null && waitMs <= maxAutomaticWaitMs ? "automatic" : "manual";
  return {
    detectedAt: detectedAt.toISOString(),
    graceMs,
    interactionResumeAt: interactionResumeAt?.toISOString() ?? "",
    maxAutomaticWaitMs,
    mode,
    notice,
    parseStatus: serviceRecoveryAt ? "parsed" : "unparsed",
    serviceRecoveryAt: serviceRecoveryAt?.toISOString() ?? "",
    sourcePattern,
    waitMs,
  };
}

export class InteractionQuotaSuspendedError extends Error {
  constructor(quotaPause) {
    super(quotaPause?.mode === "manual"
      ? "Doubao quota recovery requires a wait longer than one day or has no parseable recovery time."
      : "Doubao interactions are paused until the quota recovery time.");
    this.name = "InteractionQuotaSuspendedError";
    this.code = INTERACTION_QUOTA_SUSPENDED;
    this.quotaPause = structuredClone(quotaPause ?? null);
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

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export class InteractionQuotaGate {
  constructor({
    delayImpl = abortableDelay,
    maxAutomaticWaitMs = MAX_AUTOMATIC_QUOTA_WAIT_MS,
    nowImpl = () => new Date(),
    queueRoot = "",
  } = {}) {
    this.delayImpl = delayImpl;
    this.maxAutomaticWaitMs = maxAutomaticWaitMs;
    this.nowImpl = nowImpl;
    this.pause = null;
    this.receiptPath = queueRoot ? path.join(path.resolve(queueRoot), "quota-pause.json") : "";
  }

  async initialize() {
    if (!this.receiptPath) return this;
    const saved = await readJsonIfPresent(this.receiptPath);
    if (saved?.status === "waiting") this.pause = saved;
    return this;
  }

  snapshot() {
    return this.pause ? structuredClone(this.pause) : null;
  }

  async persist(receipt) {
    if (this.receiptPath) await writeJsonAtomic(this.receiptPath, receipt);
  }

  async triggerFromNotice({ jobId = "", notice, targetId = "" } = {}) {
    const parsed = parseDoubaoQuotaRecovery(notice, {
      maxAutomaticWaitMs: this.maxAutomaticWaitMs,
      now: this.nowImpl(),
    });
    if (!parsed) return null;
    const candidate = {
      ...parsed,
      jobId: String(jobId),
      status: "waiting",
      targetId: String(targetId),
      triggerCount: 1,
    };
    const current = this.pause;
    if (current?.status === "waiting") {
      const currentResume = Date.parse(current.interactionResumeAt || "");
      const candidateResume = Date.parse(candidate.interactionResumeAt || "");
      const candidateIsStricter = candidate.mode === "manual"
        || (current.mode !== "manual" && Number.isFinite(candidateResume)
          && (!Number.isFinite(currentResume) || candidateResume > currentResume));
      this.pause = candidateIsStricter
        ? { ...candidate, triggerCount: Number(current.triggerCount ?? 1) + 1 }
        : { ...current, triggerCount: Number(current.triggerCount ?? 1) + 1 };
    } else {
      this.pause = candidate;
    }
    await this.persist(this.pause);
    return this.snapshot();
  }

  async waitIfPaused({ signal } = {}) {
    while (this.pause?.status === "waiting") {
      const current = this.pause;
      if (current.mode === "manual") throw new InteractionQuotaSuspendedError(current);
      const resumeAtMs = Date.parse(current.interactionResumeAt);
      if (!Number.isFinite(resumeAtMs)) {
        current.mode = "manual";
        current.parseStatus = "invalid-persisted-time";
        await this.persist(current);
        throw new InteractionQuotaSuspendedError(current);
      }
      const remainingMs = resumeAtMs - this.nowImpl().getTime();
      if (remainingMs <= 0) {
        const released = {
          ...current,
          releasedAt: this.nowImpl().toISOString(),
          status: "released",
        };
        this.pause = null;
        await this.persist(released);
        return released;
      }
      await this.delayImpl(Math.min(remainingMs, 30_000), signal);
    }
    return null;
  }
}

export async function createInteractionQuotaGate(options = {}) {
  return new InteractionQuotaGate(options).initialize();
}

export async function releaseInteractionQuotaPause({ queueRoot, releasedBy = "operator" } = {}) {
  const receiptPath = path.join(path.resolve(queueRoot), "quota-pause.json");
  const saved = await readJsonIfPresent(receiptPath);
  if (!saved || saved.status !== "waiting") {
    return { released: false, receipt: saved };
  }
  const receipt = {
    ...saved,
    releasedAt: new Date().toISOString(),
    releasedBy: String(releasedBy),
    status: "released-manually",
  };
  await writeJsonAtomic(receiptPath, receipt);
  return { released: true, receipt };
}
