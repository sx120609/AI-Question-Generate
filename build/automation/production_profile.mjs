import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PROFILES = Object.freeze({
  l1: Object.freeze({
    id: "l1",
    label: "L1 探索型",
    taskType: "L1 探索型",
    packetKind: "l1-production-input-packet",
    workflowKind: "l1-production-workflow-state",
    traceKind: "l1-production-trace",
    promptKind: "l1-production-pipeline-prompt",
    configPath: path.join(REPO_ROOT, "config", "l1_production_protocol.json"),
    structuralDiversityPolicyPath: path.join(REPO_ROOT, "config", "structural_diversity_l1.json"),
    defaultPrefix: "l1",
    defaultObjective: "L1 exploratory question auto production",
    question: Object.freeze({
      hardMinimumVisibleCharacters: 120,
      recommendedMinimumVisibleCharacters: 220,
      recommendedMaximumVisibleCharacters: 520,
      hardMaximumVisibleCharacters: 700,
    }),
    attachments: Object.freeze({
      minimum: 1,
      recommendedMaximum: 2,
      maximum: 3,
      minimumSpecificBusinessShare: 0.8,
      requireSpecificObjectEvidence: true,
    }),
    keySteps: Object.freeze({ minimum: 4, maximum: 8 }),
    humanHours: Object.freeze({ hardMinimum: 3, recommendedMinimum: 4 }),
    productFormat: Object.freeze({ optional: true, requireBatchCoverage: false }),
    language: Object.freeze({ minimumExplanatoryParentheses: 0, requireContinuityAudit: false, forbidSemicolon: false }),
  }),
  l2: Object.freeze({
    id: "l2",
    label: "L2 流程型",
    taskType: "L2 流程型",
    packetKind: "l2-production-input-packet",
    workflowKind: "l2-production-workflow-state",
    traceKind: "l2-production-trace",
    promptKind: "l2-production-pipeline-prompt",
    configPath: path.join(REPO_ROOT, "config", "l2_production_protocol.json"),
    structuralDiversityPolicyPath: path.join(REPO_ROOT, "config", "structural_diversity.json"),
    defaultPrefix: "l2",
    defaultObjective: "L2 auto production",
    question: Object.freeze({
      hardMinimumVisibleCharacters: 700,
      recommendedMinimumVisibleCharacters: 800,
      recommendedMaximumVisibleCharacters: 1400,
      hardMaximumVisibleCharacters: 1500,
    }),
    attachments: Object.freeze({
      minimum: 1,
      maximum: null,
      minimumSpecificBusinessShare: 0.8,
      requireSpecificObjectEvidence: true,
    }),
    keySteps: Object.freeze({ minimum: 8, maximum: 15 }),
    humanHours: Object.freeze({ hardMinimum: 8, recommendedMinimum: 8 }),
    productFormat: Object.freeze({ optional: false, requireBatchCoverage: true }),
    language: Object.freeze({ minimumExplanatoryParentheses: 3, requireContinuityAudit: true, forbidSemicolon: true }),
  }),
});

function normalizeProfileId(value = "") {
  const normalized = String(value).trim().toLowerCase().replace(/[_\s-]+/gu, "");
  if (!normalized) return "";
  if (normalized.startsWith("l1")) return "l1";
  if (normalized.startsWith("l2")) return "l2";
  return "";
}

export function resolveProductionProfile(value = "l1") {
  if (value && typeof value === "object") {
    const candidates = [value.id, value.productionProfile, value.profileId, value.profile, value.kind, value.taskType, value.任务类型];
    for (const candidate of candidates) {
      const id = normalizeProfileId(candidate);
      if (id) return PROFILES[id];
    }
    throw new TypeError("Production profile cannot be inferred from the supplied object.");
  }
  const id = normalizeProfileId(value) || (String(value).trim() ? "" : "l1");
  if (!id) throw new TypeError(`Unsupported production profile: ${String(value)}`);
  return PROFILES[id];
}

export function isPacketForProfile(packet, profile = resolveProductionProfile(packet)) {
  return packet?.kind === profile.packetKind && packet?.status === "READY";
}

export function visibleQuestionLength(value = "") {
  return [...String(value).replace(/\s+/gu, "")].length;
}

export function countKeySteps(value = "") {
  return (String(value).match(/(?:^|[\n。；;])\s*\d{1,2}\s*[.．、)）]/gu) ?? []).length;
}

export function parseHumanHours(value = "") {
  const match = String(value).match(/(\d+(?:\.\d+)?)\s*(?:h|小时)/iu);
  return match ? Number(match[1]) : null;
}

export function evaluateProductionRecordProfile(record = {}, profileValue = record) {
  const profile = resolveProductionProfile(profileValue);
  const findings = [];
  const question = String(record.题目 ?? record.question ?? "").trim();
  const length = visibleQuestionLength(question);
  if (length < profile.question.hardMinimumVisibleCharacters || length > profile.question.hardMaximumVisibleCharacters) {
    findings.push({
      rule: "question-visible-length",
      actual: length,
      min: profile.question.hardMinimumVisibleCharacters,
      max: profile.question.hardMaximumVisibleCharacters,
    });
  }
  const taskType = String(record.任务类型 ?? record.taskType ?? "").replace(/\s+/gu, "");
  if (taskType && taskType !== profile.taskType.replace(/\s+/gu, "")) {
    findings.push({ rule: "task-type-profile-mismatch", expected: profile.taskType, actual: record.任务类型 ?? record.taskType });
  }
  const stepSource = record.做题关键步骤 ?? record.keySteps;
  if (String(stepSource ?? "").trim()) {
    const stepCount = countKeySteps(stepSource);
    if (stepCount < profile.keySteps.minimum || stepCount > profile.keySteps.maximum) {
      findings.push({ rule: "key-step-count", actual: stepCount, min: profile.keySteps.minimum, max: profile.keySteps.maximum });
    }
  }
  const hourSource = record.人类完成时间 ?? record.人类所需完成时间 ?? record.humanTime;
  if (String(hourSource ?? "").trim()) {
    const hours = parseHumanHours(hourSource);
    if (hours == null || hours < profile.humanHours.hardMinimum) {
      findings.push({ rule: "human-hours-below-minimum", actual: hours, min: profile.humanHours.hardMinimum });
    }
  }
  if (profile.id === "l1") {
    const numericTokenCount = question.match(/\d+(?:\.\d+)?(?:%|％)?/gu)?.length ?? 0;
    const sentenceCount = question.split(/[。！？!?\n]+/gu).map((item) => item.trim()).filter(Boolean).length;
    if (numericTokenCount > 24) {
      findings.push({ rule: "l1-numeric-inventory", actual: numericTokenCount, maximum: 24 });
    }
    if (sentenceCount > 18) {
      findings.push({ rule: "l1-sentence-overload", actual: sentenceCount, maximum: 18 });
    }
    const mechanicalSignalCount = [
      /导出|下载|另存|重命名|改名/iu,
      /(?:新增|增加|补充|补齐|保留|删除|调整|拆分|合并)(?:现有)?(?:工作表|分页|列|字段|格式|标题|表头)/iu,
      /正常打开|保持可编辑|可编辑状态|文件能打开/iu,
    ].filter((pattern) => pattern.test(question)).length;
    const reasoningSignalCount = [
      /核对(?!表)|复核|验证|判断|分析|比较|解释|重算|测算|推导|取舍/iu,
      /来源|证据|口径|冲突|差异|原因|假设|边界|待确认|疑点/iu,
      /一致性|完整性|合理性|优先级|结论|影响|风险/iu,
    ].filter((pattern) => pattern.test(question)).length;
    if ((mechanicalSignalCount > 0 && reasoningSignalCount === 0)
      || (mechanicalSignalCount >= 2 && reasoningSignalCount < 2)) {
      findings.push({
        rule: "l1-mechanical-task-dominant",
        mechanicalSignalCount,
        reasoningSignalCount,
      });
    }
    const looksPersonalArithmetic = /(?:上班族|通勤|家庭现金流|旅行费用|购物预算)/u.test(question)
      && /(?:计算|成本|费用|合计|差额|每月|单程)/u.test(question)
      && !/(?:附件|联网|公开资料|官方|核验|来源|证据|口径|待确认|无法确认|不确定|数据缺口)/u.test(question);
    const looksLikeShortLookup = length < 180
      && /(?:查一下|搜索一下|告诉我|算一下|计算)/u.test(question)
      && !/(?:比较|判断|验证|核验|证据|来源|风险|边界|待确认)/u.test(question);
    if (looksPersonalArithmetic || looksLikeShortLookup) {
      findings.push({ rule: "l1-task-too-simple", subtype: looksPersonalArithmetic ? "personal-arithmetic" : "short-lookup" });
    }
  }
  return { profileId: profile.id, status: findings.length ? "FAIL" : "PASS", findings };
}

export const PRODUCTION_PROFILES = PROFILES;
