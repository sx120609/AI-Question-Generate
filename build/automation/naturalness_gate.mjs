import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseTsvRows } from "./structure_fingerprint.mjs";
import {
  analyzeQuestionPunctuation,
  analyzeQuestionRequest,
  missingQuestionDeliverableFormats,
} from "./language_style.mjs";
import { REPO_ROOT, writeJsonAtomic } from "./run_context.mjs";

export const NATURALNESS_METRICS_VERSION = "naturalness-metrics-v6";
export const NATURALNESS_GATE_ID = "naturalness-gate-v6";
export const QUESTION_LANGUAGE_POLICY_ID = "corpus-calibrated-intent-punctuation-v4";

// These are calibration instructions, not hidden pass/fail thresholds. A generated
// baseline materializes every effective threshold and its provenance.
export const DEFAULT_NATURALNESS_CALIBRATION_PROFILE = Object.freeze({
  profileId: "approved-corpus-plus-human-review-v2",
  rowQuantiles: {
    upperReview: 0.9,
    upperFail: 0.98,
    lowerReview: 0.1,
  },
  rowPolicy: {
    minimumDisclaimerSentencesForFail: 2,
    requireDirectRequest: false,
    shortOpeningMaxCharacters: 30,
    structuralPunctuationReviewCount: 4,
    maximumTerminalSentenceCharacters: 240,
  },
  batchUpperBounds: {
    reviewZ: 1.645,
    failZ: 2.326,
  },
  batchPolicy: {
    minimumRows: 8,
    reviewLevelTemplateSignalsForFail: 2,
    requestFrameDominantShareReview: 0.8,
    requestFrameDominantShareFail: 0.95,
    shortOpeningShareReview: 0.25,
    shortOpeningShareFail: 0.5,
    firstPunctuationTerminalShareReview: 0.25,
    firstPunctuationTerminalShareFail: 0.5,
    firstSentenceCommaShareReview: 0.6,
    firstSentenceCommaShareFail: 0.4,
    commaToPeriodRatioReview: 1.1,
    commaToPeriodRatioFail: 0.8,
    enumerationCommasPer100CharsReview: 2.8,
    enumerationCommasPer100CharsFail: 4,
    earlyStructuralPunctuationShareReview: 0.2,
    earlyStructuralPunctuationShareFail: 0.4,
    semicolonRowShareReview: 0.6,
    semicolonRowShareFail: 0.8,
    longSentenceShareReview: 0.1,
    longSentenceShareFail: 0.25,
  },
});

const MISSING_MATERIAL_PATTERNS = [
  /(?:尚未|还没|没有|未能|未曾|缺少|缺失|尚缺|待补|没拿到|未拿到|未提供|未提交|未交|未到齐|不齐).{0,22}(?:材料|资料|附件|原件|记录|数据|证明|配置|合同|原稿|底稿|报告|文件|信息|证据|参数|样本|版本|许可|批文|备案|图纸)/u,
  /(?:材料|资料|附件|原件|记录|数据|证明|配置|合同|原稿|底稿|报告|文件|信息|证据|参数|样本|版本|许可|批文|备案|图纸).{0,18}(?:尚未|还没|没有|缺少|缺失|尚缺|待补|未提供|未提交|未交|未到齐|不齐)/u,
  /(?:只收到|目前只有|现有材料只有|手头只有|当前仅有)/u,
];

const EVIDENCE_BOUNDARY_PATTERNS = [
  /(?:不能|无法|不得|不应|不要|不可).{0,32}(?:判断|确认|推定|外推|代替|替代|证明|视为|写成|认定|下结论|补写|编造)/u,
  /(?:不把|不可把|避免把).{0,32}(?:当成|视为|写成|替代|推定)/u,
  /(?:只|仅).{0,18}(?:基于|针对|限于|能说明|用于核对|用于判断)/u,
  /(?:待|等).{0,22}(?:补齐|拿到|收到|确认|提供).{0,18}(?:后|再)/u,
  /(?:不外推|不预填|不预设|不虚构|不假定|不延伸)/u,
];

const ACTION_RULES = [
  ["deliverable", /\b(?:Word|Excel|PPT)\b|(?:文档|说明|报告|意见|发言稿).{0,24}(?:表格|台账|工作簿)|(?:形成|交付|输出|整理).{0,20}(?:文档|说明|报告|表格|台账|工作簿)/iu, 5],
  ["boundary", /尚未|还没|缺少|缺失|尚缺|待补|未提供|未提交|未到齐|不能|无法|不得|不外推|不推定|不替代|不预填|材料状态/u, 3],
  ["decision", /决定|判断|取舍|是否|优先|保留|改写|暂缓|放行|分流|处理结论|开放条件|怎么处理/u, 2],
  ["evidence", /附件|依据|记录|数据|合同|日志|照片|原稿|底表|报告|证明|规则|来源|流水/u, 2],
  ["quality", /复核|核对|检查|验收|自检|走查|回看|一致|遗漏/u, 2],
  ["scene", /今天|明天|本周|下周|周[一二三四五六日天]|月末|年底|刚|收到|出现|发生|负责|团队|客户|运营|法务|项目/u, 1],
  ["instruction", /需要|要做|围绕|写明|列出|建立|给出|说明|梳理|准备/u, 1],
];

// Diagnostic only. Exclude common institutional compounds such as “我国”; do
// not turn first-person presence or absence into an eligibility requirement.
const FIRST_PERSON_PATTERN = /我们|咱们|我方|我(?!(?:国|军|党|校|院))/u;
const ABSOLUTE_TIME_PATTERN = /(?:20\d{2}[年\-/]\d{1,2}(?:[月\-/]\d{1,2}日?)?|\d{1,2}月\d{1,2}日|\d{1,2}[：:]\d{2})/u;
const RELATIVE_TIME_PATTERN = /今天|明天|后天|本周|下周|周[一二三四五六日天]|月底|月末|年底|会前|会上|当天下午|当晚/u;
const MEETING_PATTERN = /会议|开会|会上|会前|碰头|评审会|汇报会|改稿会|讨论会|例会|当场确认/u;
const DEADLINE_PATTERN = /(?:前|之前|截至|赶在|当天|尽快).{0,12}(?:完成|定稿|交付|提交|给出|确认)|(?:今天|明天|本周|下周|周[一二三四五六日天]|月底|月末|年底).{0,18}(?:完成|定稿|交付|提交|给出|确认|要用)/u;
const FINAL_SELF_CHECK_PATTERN = /复查|自检|校验|验收|交叉检查|走查|回看|复测|演练|确认.{0,24}(?:一致|完整|无误|遗漏|对应|可追溯)|检查.{0,24}(?:一致|完整|遗漏|对应)/u;

function normalizedText(value = "") {
  return String(value ?? "").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function visibleLength(value = "") {
  return normalizedText(value).replace(/\s+/g, "").length;
}

function round(value, places = 4) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function splitParagraphs(value) {
  const text = normalizedText(value);
  if (!text) return [];
  const blankLineParts = text.split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean);
  if (blankLineParts.length > 1) return blankLineParts;
  return text.split(/\n+/).map((item) => item.trim()).filter(Boolean);
}

function splitSentences(value) {
  return normalizedText(value)
    .split(/(?<=[。！？!?])|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function discourseUnits(paragraphs, sentences) {
  if (paragraphs.length !== 1 || sentences.length < 2) return paragraphs;
  // A single-paragraph requester message still has discourse turns. Grouping
  // four sentences at a time makes any one Word/Excel sentence dominate an
  // entire half of the message, so genuine scene/evidence sentences disappear
  // from the skeleton. Use sentence-level turns for this presentation mode.
  return sentences;
}

function splitSteps(value) {
  const text = normalizedText(value);
  if (!text) return [];
  const numbered = text
    .split(/\n(?=\s*(?:\d{1,2}[.、)]|[-•]))/u)
    .map((item) => item.replace(/^\s*(?:\d{1,2}[.、)]|[-•])\s*/u, "").trim())
    .filter(Boolean);
  if (numbered.length > 1) return numbered;
  const lines = text.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return text.split(/(?<=。)\s*(?=\d{1,2}[.、)])/u).map((item) => item.trim()).filter(Boolean);
}

function patternHitCount(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function tagDisclaimerSentence(sentence) {
  const missingHits = patternHitCount(sentence, MISSING_MATERIAL_PATTERNS);
  const boundaryHits = patternHitCount(sentence, EVIDENCE_BOUNDARY_PATTERNS);
  return {
    missingHits,
    boundaryHits,
    tagged: missingHits + boundaryHits > 0,
  };
}

function collectMatches(text, regex, kind, output) {
  for (const match of text.matchAll(regex)) {
    const value = String(match[0] ?? "").replace(/\s+/g, "").toLowerCase();
    if (value) output.set(`${kind}:${value}`, { kind, value: match[0] });
  }
}

const GENERIC_ASCII_TERMS = new Set([
  "ai", "api", "docx", "excel", "faq", "html", "pdf", "poc", "ppt", "pptx",
  "saas", "word", "xlsx",
]);

function collectNamedProductAnchors(text, output) {
  for (const match of String(text).matchAll(/[A-Z][A-Za-z0-9.+-]{2,}(?:\s+[A-Z][A-Za-z0-9.+-]{2,}){0,2}/gu)) {
    const value = String(match[0] ?? "").trim();
    const normalized = value.toLowerCase();
    if (!value || GENERIC_ASCII_TERMS.has(normalized)) continue;
    output.set(`named-product:${normalized}`, { kind: "named-product", value });
  }
}

function concreteFactAnchors(question, paragraphs) {
  const finalParagraph = paragraphs.at(-1) ?? "";
  const sceneText = paragraphs.length > 1 && hasFixedWordExcelTail(finalParagraph)
    ? paragraphs.slice(0, -1).join("\n")
    : normalizedText(question);
  const anchors = new Map();
  collectMatches(sceneText, /(?:20\d{2}[年\-/]\d{1,2}(?:[月\-/]\d{1,2}日?)?|\d{1,2}月\d{1,2}日|\d{1,2}[：:]\d{2})/gu, "date-time", anchors);
  collectMatches(sceneText, /\d+(?:\.\d+)?\s*(?:%|％|元|万元|亿元|家|名|人|条|份|批|次|天|日|小时|分钟|件|台|页|款|个|类|段|套|笔|公斤|kg|平方米|㎡|GB|MB|TB)/giu, "quantity", anchors);
  collectMatches(sceneText, /(?:v(?:ersion)?\s*)?\d+(?:\.\d+){1,3}|[A-Z]{1,10}[-_]?[A-Z0-9]*\d+[A-Z0-9_-]*/giu, "identifier", anchors);
  collectMatches(sceneText, /[“「『][^”」』\n]{2,48}[”」』]/gu, "quoted-detail", anchors);
  collectMatches(sceneText, /《[^》\n]{2,48}》/gu, "named-source", anchors);
  collectNamedProductAnchors(sceneText, anchors);
  return { sceneText, anchors: [...anchors.values()] };
}

function classifyParagraph(paragraph) {
  const scored = ACTION_RULES.map(([action, pattern, weight], priority) => ({
    action,
    score: pattern.test(paragraph) ? weight : 0,
    priority,
  }));
  const disclaimerTags = splitSentences(paragraph).map(tagDisclaimerSentence);
  const disclaimerCount = disclaimerTags.filter((item) => item.tagged).length;
  const boundary = scored.find((item) => item.action === "boundary");
  if (boundary) boundary.score += disclaimerCount;
  scored.sort((left, right) => right.score - left.score || left.priority - right.priority);
  return {
    action: scored[0]?.score > 0 ? scored[0].action : "detail",
    scores: Object.fromEntries(scored.map((item) => [item.action, item.score])),
  };
}

function compressed(values) {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function hasFixedWordExcelTail(paragraph) {
  const text = normalizedText(paragraph);
  if (!text) return false;
  const wordIndex = text.search(/\bWord\b|可编辑(?:文档|说明|报告)|(?:文档|说明|报告|意见|发言稿)/iu);
  const excelIndex = text.search(/\bExcel\b|工作簿|表格|台账/iu);
  const artifactFraming = /形成|交付|输出|整理|准备|要用|用于|一份|一张|另(?:外|外再|做)/u.test(text);
  return wordIndex >= 0 && excelIndex > wordIndex && artifactFraming;
}

function artifactTailText(paragraphs, sentences) {
  if (paragraphs.length > 1) return paragraphs.at(-1) ?? "";
  // With the mandated single-paragraph presentation the whole question is not
  // a "tail". Only the trailing two sentences can form a fixed artifact close.
  return sentences.slice(-2).join("");
}

function scheduleAuthenticityTag(text) {
  const absolute = ABSOLUTE_TIME_PATTERN.test(text);
  const relative = RELATIVE_TIME_PATTERN.test(text);
  const meeting = MEETING_PATTERN.test(text);
  const deadline = DEADLINE_PATTERN.test(text);
  if (absolute && meeting) return "anchored-meeting";
  if (absolute) return "anchored-time";
  if (relative && meeting) return "relative-meeting";
  if (relative && deadline) return "relative-deadline";
  if (meeting) return "meeting-without-date";
  if (relative) return "relative-time-only";
  return "no-schedule-device";
}

function distribution(values) {
  const counts = {};
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
  const entries = Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return { counts, mode: entries[0]?.[0] ?? "", modeCount: entries[0]?.[1] ?? 0 };
}

export function measureNaturalnessRow(row, index = 0) {
  const question = normalizedText(row?.题目 ?? row?.question ?? "");
  const stepsText = normalizedText(row?.做题关键步骤 ?? row?.steps ?? "");
  const paragraphs = splitParagraphs(question);
  const sentences = splitSentences(question);
  const units = discourseUnits(paragraphs, sentences);
  const sentenceTags = sentences.map((sentence) => ({ sentence, ...tagDisclaimerSentence(sentence) }));
  const disclaimerSentences = sentenceTags.filter((item) => item.tagged);
  const missingSentences = sentenceTags.filter((item) => item.missingHits > 0);
  const boundarySentences = sentenceTags.filter((item) => item.boundaryHits > 0);
  const paragraphActions = units.map(classifyParagraph);
  const actionNames = paragraphActions.map((item) => item.action);
  const factData = concreteFactAnchors(question, paragraphs);
  const sceneLength = Math.max(1, visibleLength(factData.sceneText));
  const steps = splitSteps(stepsText);
  const finalStep = steps.at(-1) ?? "";
  const finalParagraph = paragraphs.at(-1) ?? "";
  const fixedWordExcelTail = hasFixedWordExcelTail(artifactTailText(paragraphs, sentences));
  const finalStepSelfCheck = FINAL_SELF_CHECK_PATTERN.test(finalStep);
  const scheduleTag = scheduleAuthenticityTag(question);
  const request = analyzeQuestionRequest(question);
  const punctuation = analyzeQuestionPunctuation(question);
  const productFormats = String(row?.产物格式 ?? row?.productFormats ?? "");
  const missingDeliverableFormats = missingQuestionDeliverableFormats(question, productFormats);
  const terminalSentenceLengths = sentences.map((sentence) => visibleLength(sentence.replace(/[。！？!?]$/u, "")));
  const weakScheduleDevice = ["relative-meeting", "relative-deadline", "meeting-without-date"].includes(scheduleTag);
  const closesWithDeliverable = actionNames.at(-1) === "deliverable";
  const templateMarkers = [fixedWordExcelTail, finalStepSelfCheck, weakScheduleDevice, closesWithDeliverable]
    .filter(Boolean).length;

  return {
    uid: String(row?.UID ?? row?.uid ?? `data-row-${row?.__dataRow ?? index + 2}`),
    dataRow: Number(row?.__dataRow ?? index + 2),
    questionLength: visibleLength(question),
    paragraphCount: paragraphs.length,
    sentenceCount: sentences.length,
    disclaimerSentenceCount: disclaimerSentences.length,
    disclaimerSentenceDensity: round(disclaimerSentences.length / Math.max(1, sentences.length)),
    missingMaterialSentenceCount: missingSentences.length,
    evidenceBoundarySentenceCount: boundarySentences.length,
    disclaimerSignalCount: disclaimerSentences.reduce((sum, item) => sum + item.missingHits + item.boundaryHits, 0),
    concreteFactAnchorCount: factData.anchors.length,
    concreteFactsPer100Chars: round((factData.anchors.length / sceneLength) * 100),
    firstPersonPresent: FIRST_PERSON_PATTERN.test(question),
    firstPersonOpening: FIRST_PERSON_PATTERN.test(question.slice(0, 140)),
    paragraphActions: actionNames,
    paragraphActionScores: paragraphActions.map((item) => item.scores),
    discourseSkeleton: actionNames.join(">"),
    compressedDiscourseSkeleton: compressed(actionNames).join(">"),
    fixedWordExcelTail,
    stepCount: steps.length,
    finalStepSelfCheck,
    scheduleAuthenticityTag: scheduleTag,
    weakScheduleDevice,
    closesWithDeliverable,
    templateMarkerCount: templateMarkers,
    explicitRequestPresent: request.clear,
    requestFrame: request.frame,
    requestPositionRatio: request.requestIndex < 0 ? 0 : round(request.requestIndex / Math.max(1, question.length)),
    requestMarker: request.requestMarker,
    requestDeliverableMarker: request.deliverableMarker,
    missingDeliverableFormats,
    firstSentenceLength: punctuation.firstSentenceLength,
    firstSentenceCommaCount: punctuation.firstSentenceCommaCount,
    firstPunctuationIsTerminal: punctuation.firstPunctuationIsTerminal,
    commaCount: punctuation.commaCount,
    periodCount: punctuation.periodCount,
    colonCount: punctuation.colonCount,
    semicolonCount: punctuation.semicolonCount,
    enumerationCommaCount: punctuation.enumerationCommaCount,
    commaToPeriodRatio: punctuation.commaToPeriodRatio,
    enumerationCommasPer100Chars: punctuation.enumerationCommasPer100Chars,
    structuralPunctuationCount: punctuation.structuralPunctuationCount,
    structuralPunctuationPer100Chars: punctuation.structuralPunctuationPer100Chars,
    earlyStructuralPunctuation: punctuation.earlyStructuralPunctuation,
    containsSemicolon: punctuation.containsSemicolon,
    maximumTerminalSentenceLength: Math.max(0, ...terminalSentenceLengths),
    evidence: {
      disclaimerSentences: disclaimerSentences.map((item) => item.sentence),
      concreteFactAnchors: factData.anchors,
      finalParagraph,
      finalStep,
      request,
      punctuation,
    },
  };
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summaryStats(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: 0, p10: 0, p50: 0, p90: 0, p98: 0, max: 0, mean: 0 };
  return {
    min: round(Math.min(...finite)),
    p10: round(quantile(finite, 0.1)),
    p50: round(quantile(finite, 0.5)),
    p90: round(quantile(finite, 0.9)),
    p98: round(quantile(finite, 0.98)),
    max: round(Math.max(...finite)),
    mean: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
  };
}

function wilsonUpper(successes, total, z) {
  if (!total) return 1;
  const p = successes / total;
  const z2 = z ** 2;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.min(1, (center + margin) / denominator);
}

function threshold(sourceMetric, direction, review, fail, source) {
  return {
    metric: sourceMetric,
    direction,
    review: round(review),
    ...(Number.isFinite(fail) ? { fail: round(fail) } : {}),
    source,
  };
}

function batchReferenceMetrics(metrics) {
  const count = metrics.length;
  const skeletons = distribution(metrics.map((item) => item.compressedDiscourseSkeleton));
  const stepCounts = distribution(metrics.map((item) => item.stepCount));
  const weakScheduleTags = distribution(metrics.filter((item) => item.weakScheduleDevice).map((item) => item.scheduleAuthenticityTag));
  return {
    discourseSkeletonDominantShare: skeletons.modeCount / Math.max(1, count),
    fixedWordExcelTailShare: metrics.filter((item) => item.fixedWordExcelTail).length / Math.max(1, count),
    finalStepSelfCheckShare: metrics.filter((item) => item.finalStepSelfCheck).length / Math.max(1, count),
    stepCountModeShare: stepCounts.modeCount / Math.max(1, count),
    weakScheduleShare: metrics.filter((item) => item.weakScheduleDevice).length / Math.max(1, count),
    weakScheduleDominantShare: weakScheduleTags.modeCount / Math.max(1, count),
  };
}

function mergeCalibrationProfile(profile = {}) {
  return {
    ...DEFAULT_NATURALNESS_CALIBRATION_PROFILE,
    ...profile,
    rowQuantiles: {
      ...DEFAULT_NATURALNESS_CALIBRATION_PROFILE.rowQuantiles,
      ...(profile.rowQuantiles ?? {}),
    },
    rowPolicy: {
      ...DEFAULT_NATURALNESS_CALIBRATION_PROFILE.rowPolicy,
      ...(profile.rowPolicy ?? {}),
    },
    batchUpperBounds: {
      ...DEFAULT_NATURALNESS_CALIBRATION_PROFILE.batchUpperBounds,
      ...(profile.batchUpperBounds ?? {}),
    },
    batchPolicy: {
      ...DEFAULT_NATURALNESS_CALIBRATION_PROFILE.batchPolicy,
      ...(profile.batchPolicy ?? {}),
    },
  };
}

export function calibrateNaturalnessBaseline(referenceRows, {
  baselineId = "naturalness-benchmark",
  profile = DEFAULT_NATURALNESS_CALIBRATION_PROFILE,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(referenceRows) || referenceRows.length < 5) {
    throw new Error("Naturalness calibration requires at least 5 reference rows.");
  }
  const calibration = mergeCalibrationProfile(profile);
  const metrics = referenceRows.map(measureNaturalnessRow);
  const q = calibration.rowQuantiles;
  const rowMetric = (name, direction, reviewQuantile, failQuantile = null) => {
    const values = metrics.map((item) => Number(item[name]));
    const review = quantile(values, reviewQuantile);
    const fail = failQuantile == null ? undefined : quantile(values, failQuantile);
    return threshold(name, direction, review, fail, {
      type: "benchmark-quantile",
      baselineId,
      sampleCount: metrics.length,
      reviewQuantile,
      ...(failQuantile == null ? {} : { failQuantile }),
    });
  };

  const referenceBatch = batchReferenceMetrics(metrics);
  const batchThreshold = (name) => {
    const observed = referenceBatch[name];
    const successes = Math.round(observed * metrics.length);
    return threshold(
      name,
      "upper",
      wilsonUpper(successes, metrics.length, calibration.batchUpperBounds.reviewZ),
      wilsonUpper(successes, metrics.length, calibration.batchUpperBounds.failZ),
      {
        type: "benchmark-rate-upper-bound",
        baselineId,
        sampleCount: metrics.length,
        observedCount: successes,
        observedShare: round(observed),
        reviewZ: calibration.batchUpperBounds.reviewZ,
        failZ: calibration.batchUpperBounds.failZ,
      },
    );
  };

  const rowThresholds = {
    disclaimerSentenceDensity: rowMetric("disclaimerSentenceDensity", "upper", q.upperReview, q.upperFail),
    disclaimerSentenceCount: rowMetric("disclaimerSentenceCount", "upper", q.upperReview, q.upperFail),
    concreteFactsPer100Chars: rowMetric("concreteFactsPer100Chars", "lower", q.lowerReview),
    templateMarkerCount: rowMetric("templateMarkerCount", "upper", q.upperReview),
    minimumDisclaimerSentencesForFail: {
      value: calibration.rowPolicy.minimumDisclaimerSentencesForFail,
      source: {
        type: "row-policy-cap",
        profileId: calibration.profileId,
        parameter: "minimumDisclaimerSentencesForFail",
        rationale: "One matched sentence may be legitimate evidence hygiene and cannot cause a hard fail by itself.",
      },
    },
    requireDirectRequest: {
      value: calibration.rowPolicy.requireDirectRequest === true,
      source: {
        type: "row-policy-cap",
        profileId: calibration.profileId,
        parameter: "requireDirectRequest",
        rationale: "Direct second-person requests are a corpus feature, not a universal requirement; actionable work-order phrasing is also valid.",
      },
    },
    shortOpeningMaxCharacters: {
      value: calibration.rowPolicy.shortOpeningMaxCharacters,
      source: { type: "row-policy-cap", profileId: calibration.profileId, parameter: "shortOpeningMaxCharacters" },
    },
    structuralPunctuationReviewCount: {
      value: calibration.rowPolicy.structuralPunctuationReviewCount,
      source: { type: "row-policy-cap", profileId: calibration.profileId, parameter: "structuralPunctuationReviewCount" },
    },
    maximumTerminalSentenceCharacters: {
      value: calibration.rowPolicy.maximumTerminalSentenceCharacters,
      source: { type: "row-policy-cap", profileId: calibration.profileId, parameter: "maximumTerminalSentenceCharacters" },
    },
  };
  const batchThresholds = Object.fromEntries(
    Object.keys(referenceBatch).map((name) => [name, batchThreshold(name)]),
  );
  batchThresholds.minimumRows = {
    value: calibration.batchPolicy.minimumRows,
    source: { type: "batch-policy-cap", profileId: calibration.profileId, parameter: "minimumRows" },
  };
  batchThresholds.reviewLevelTemplateSignalsForFail = {
    value: calibration.batchPolicy.reviewLevelTemplateSignalsForFail,
    source: {
      type: "batch-policy-cap",
      profileId: calibration.profileId,
      parameter: "reviewLevelTemplateSignalsForFail",
      rationale: "Several moderate batch-level repetitions together constitute template concentration.",
    },
  };
  const policyThreshold = (name, direction, reviewParameter, failParameter) => threshold(
    name,
    direction,
    calibration.batchPolicy[reviewParameter],
    calibration.batchPolicy[failParameter],
    {
      type: "batch-policy-cap",
      profileId: calibration.profileId,
      reviewParameter,
      failParameter,
      rationale: "Explicit user-calibrated language contract; evaluated as a batch distribution to avoid punctuation-by-quota writing.",
    },
  );
  Object.assign(batchThresholds, {
    requestFrameDominantShare: policyThreshold("requestFrameDominantShare", "upper", "requestFrameDominantShareReview", "requestFrameDominantShareFail"),
    shortOpeningShare: policyThreshold("shortOpeningShare", "upper", "shortOpeningShareReview", "shortOpeningShareFail"),
    firstPunctuationTerminalShare: policyThreshold("firstPunctuationTerminalShare", "upper", "firstPunctuationTerminalShareReview", "firstPunctuationTerminalShareFail"),
    firstSentenceCommaShare: policyThreshold("firstSentenceCommaShare", "lower", "firstSentenceCommaShareReview", "firstSentenceCommaShareFail"),
    commaToPeriodRatio: policyThreshold("commaToPeriodRatio", "lower", "commaToPeriodRatioReview", "commaToPeriodRatioFail"),
    enumerationCommasPer100Chars: policyThreshold("enumerationCommasPer100Chars", "upper", "enumerationCommasPer100CharsReview", "enumerationCommasPer100CharsFail"),
    earlyStructuralPunctuationShare: policyThreshold("earlyStructuralPunctuationShare", "upper", "earlyStructuralPunctuationShareReview", "earlyStructuralPunctuationShareFail"),
    semicolonRowShare: policyThreshold("semicolonRowShare", "upper", "semicolonRowShareReview", "semicolonRowShareFail"),
    longSentenceShare: policyThreshold("longSentenceShare", "upper", "longSentenceShareReview", "longSentenceShareFail"),
  });

  const metricNames = [
    "disclaimerSentenceDensity",
    "disclaimerSentenceCount",
    "concreteFactsPer100Chars",
    "templateMarkerCount",
    "questionLength",
    "paragraphCount",
    "stepCount",
    "firstSentenceLength",
    "commaToPeriodRatio",
    "enumerationCommasPer100Chars",
    "structuralPunctuationPer100Chars",
    "maximumTerminalSentenceLength",
  ];
  return {
    schemaVersion: 1,
    kind: "naturalness-benchmark-baseline",
    metricsVersion: NATURALNESS_METRICS_VERSION,
    questionLanguagePolicyId: QUESTION_LANGUAGE_POLICY_ID,
    baselineId,
    generatedAt,
    sampleCount: metrics.length,
    calibrationProfile: calibration,
    thresholds: { row: rowThresholds, batch: batchThresholds },
    benchmark: {
      distributions: Object.fromEntries(metricNames.map((name) => [name, summaryStats(metrics.map((item) => item[name]))])),
      batchRates: Object.fromEntries(Object.entries(referenceBatch).map(([name, value]) => [name, round(value)])),
      firstPersonShare: round(metrics.filter((item) => item.firstPersonPresent).length / metrics.length),
      explicitRequestShare: round(metrics.filter((item) => item.explicitRequestPresent).length / metrics.length),
      requestFrameCounts: distribution(metrics.map((item) => item.requestFrame || "missing")).counts,
      scheduleTagCounts: distribution(metrics.map((item) => item.scheduleAuthenticityTag)).counts,
      discourseSkeletonCounts: distribution(metrics.map((item) => item.compressedDiscourseSkeleton)).counts,
      stepCountCounts: distribution(metrics.map((item) => item.stepCount)).counts,
    },
  };
}

function assertThreshold(item, name, { failRequired = false } = {}) {
  if (!item || !Number.isFinite(item.review) || (failRequired && !Number.isFinite(item.fail)) || !item.source) {
    throw new Error(`Baseline threshold is incomplete: ${name}`);
  }
}

export function validateNaturalnessBaseline(baseline) {
  if (!baseline || baseline.kind !== "naturalness-benchmark-baseline") {
    throw new Error("Baseline kind must be naturalness-benchmark-baseline.");
  }
  if (baseline.metricsVersion !== NATURALNESS_METRICS_VERSION) {
    throw new Error(`Baseline metricsVersion must be ${NATURALNESS_METRICS_VERSION}.`);
  }
  const row = baseline.thresholds?.row ?? {};
  assertThreshold(row.disclaimerSentenceDensity, "row.disclaimerSentenceDensity", { failRequired: true });
  assertThreshold(row.disclaimerSentenceCount, "row.disclaimerSentenceCount", { failRequired: true });
  assertThreshold(row.concreteFactsPer100Chars, "row.concreteFactsPer100Chars");
  assertThreshold(row.templateMarkerCount, "row.templateMarkerCount");
  if (!Number.isFinite(row.minimumDisclaimerSentencesForFail?.value)
    || !row.minimumDisclaimerSentencesForFail?.source) {
    throw new Error("Baseline threshold is incomplete: row.minimumDisclaimerSentencesForFail");
  }
  if (typeof row.requireDirectRequest?.value !== "boolean" || !row.requireDirectRequest?.source) {
    throw new Error("Baseline threshold is incomplete: row.requireDirectRequest");
  }
  for (const name of [
    "shortOpeningMaxCharacters",
    "structuralPunctuationReviewCount",
    "maximumTerminalSentenceCharacters",
  ]) {
    if (!Number.isFinite(row[name]?.value) || !row[name]?.source) {
      throw new Error(`Baseline threshold is incomplete: row.${name}`);
    }
  }
  const batch = baseline.thresholds?.batch ?? {};
  for (const name of [
    "discourseSkeletonDominantShare",
    "fixedWordExcelTailShare",
    "finalStepSelfCheckShare",
    "stepCountModeShare",
    "weakScheduleShare",
    "weakScheduleDominantShare",
    "requestFrameDominantShare",
    "shortOpeningShare",
    "firstPunctuationTerminalShare",
    "firstSentenceCommaShare",
    "commaToPeriodRatio",
    "enumerationCommasPer100Chars",
    "earlyStructuralPunctuationShare",
    "semicolonRowShare",
    "longSentenceShare",
  ]) assertThreshold(batch[name], `batch.${name}`, { failRequired: true });
  for (const name of ["minimumRows", "reviewLevelTemplateSignalsForFail"]) {
    if (!Number.isFinite(batch[name]?.value) || !batch[name]?.source) {
      throw new Error(`Baseline threshold is incomplete: batch.${name}`);
    }
  }
  return baseline;
}

export function resolveNaturalnessBaseline(source) {
  if (source?.kind === "naturalness-benchmark-baseline") {
    return validateNaturalnessBaseline(source);
  }
  if (Array.isArray(source?.positives)) {
    const rows = source.positives.map((entry, index) => ({
      UID: entry?.source?.uid || `benchmark-positive-${index + 1}`,
      题目: entry?.fields?.B_question ?? "",
      做题关键步骤: entry?.fields?.O_keySteps ?? "",
    }));
    return calibrateNaturalnessBaseline(rows, {
      baselineId: source.benchmarkId || source.baselineId || "naturalness-benchmark",
      profile: source.naturalnessGateCalibrationProfile,
      generatedAt: source.generatedAt || new Date().toISOString(),
    });
  }
  throw new Error("Baseline must be a calibrated naturalness baseline or a benchmark JSON with positives[].");
}

function finding(rule, severity, message, evidence, thresholdInfo) {
  return { rule, severity, message, evidence, threshold: thresholdInfo };
}

function compareUpper(value, item) {
  if (value > item.fail) return "FAIL";
  if (value > item.review) return "REVIEW";
  return "PASS";
}

function compareLower(value, item) {
  if (value < item.fail) return "FAIL";
  if (value < item.review) return "REVIEW";
  return "PASS";
}

function statusFromFindings(findings) {
  if (findings.some((item) => item.severity === "FAIL")) return "FAIL";
  if (findings.some((item) => item.severity === "REVIEW")) return "REVIEW";
  return "PASS";
}

function evaluateRowMetrics(metrics, baseline) {
  const thresholds = baseline.thresholds.row;
  const findings = [];
  const densityLevel = compareUpper(metrics.disclaimerSentenceDensity, thresholds.disclaimerSentenceDensity);
  const countLevel = compareUpper(metrics.disclaimerSentenceCount, thresholds.disclaimerSentenceCount);
  const disclaimerLevel = densityLevel === "FAIL" && countLevel === "FAIL"
    && metrics.disclaimerSentenceCount >= thresholds.minimumDisclaimerSentencesForFail.value
    ? "FAIL"
    : densityLevel !== "PASS" && countLevel !== "PASS" ? "REVIEW" : "PASS";
  if (disclaimerLevel !== "PASS") {
    findings.push(finding(
      "disclaimer_missing_material_density",
      disclaimerLevel,
      "Missing-material or evidence-boundary sentences occupy too much of the question relative to the approved benchmark.",
      {
        sentenceCount: metrics.sentenceCount,
        taggedSentenceCount: metrics.disclaimerSentenceCount,
        density: metrics.disclaimerSentenceDensity,
        signalCount: metrics.disclaimerSignalCount,
      },
      {
        density: thresholds.disclaimerSentenceDensity,
        count: thresholds.disclaimerSentenceCount,
        minimumSentencesForFail: thresholds.minimumDisclaimerSentencesForFail,
        combination: "Both density and sentence count must cross the same review/fail band; a single word cannot trigger this rule.",
      },
    ));
  }
  if (metrics.concreteFactsPer100Chars < thresholds.concreteFactsPer100Chars.review) {
    findings.push(finding(
      "low_concrete_fact_density",
      "REVIEW",
      "The scene contains fewer concrete anchors than the lower benchmark quantile; inspect whether disclaimers are replacing business facts.",
      { anchorCount: metrics.concreteFactAnchorCount, per100Chars: metrics.concreteFactsPer100Chars },
      thresholds.concreteFactsPer100Chars,
    ));
  }
  if (metrics.templateMarkerCount > thresholds.templateMarkerCount.review) {
    findings.push(finding(
      "row_template_marker_stack",
      "REVIEW",
      "Several independent template markers occur in the same row; review the whole discourse rather than deleting a keyword.",
      {
        markerCount: metrics.templateMarkerCount,
        fixedWordExcelTail: metrics.fixedWordExcelTail,
        finalStepSelfCheck: metrics.finalStepSelfCheck,
        weakScheduleDevice: metrics.weakScheduleDevice,
        closesWithDeliverable: metrics.closesWithDeliverable,
      },
      thresholds.templateMarkerCount,
    ));
  }
  if (!metrics.explicitRequestPresent) {
    findings.push(finding(
      "missing_direct_user_request",
      "FAIL",
      "The question describes work or file specifications but contains neither a direct user request nor an actionable situated work order.",
      {
        requestFrame: metrics.requestFrame,
        requestMarker: metrics.requestMarker,
        deliverableMarker: metrics.requestDeliverableMarker,
      },
      thresholds.requireDirectRequest,
    ));
  }
  if (metrics.missingDeliverableFormats.length) {
    findings.push(finding(
      "question_omits_requested_output_format",
      "FAIL",
      "The B question must name every M-column output type in human terms; M/N cannot carry the request by themselves.",
      { missingFormats: metrics.missingDeliverableFormats },
      { source: "M-column product format mapping" },
    ));
  }
  if (metrics.structuralPunctuationCount > thresholds.structuralPunctuationReviewCount.value) {
    findings.push(finding(
      "structural_punctuation_stack",
      "REVIEW",
      "The question stacks too many colons or semicolons; inspect whether a specification list has replaced natural connected prose.",
      {
        colonCount: metrics.colonCount,
        semicolonCount: metrics.semicolonCount,
        structuralPunctuationCount: metrics.structuralPunctuationCount,
        per100Chars: metrics.structuralPunctuationPer100Chars,
      },
      thresholds.structuralPunctuationReviewCount,
    ));
  }
  if (metrics.maximumTerminalSentenceLength > thresholds.maximumTerminalSentenceCharacters.value) {
    findings.push(finding(
      "overlong_comma_run",
      "REVIEW",
      "A terminal sentence is too long; do not solve early full stops by replacing every boundary with commas.",
      { maximumTerminalSentenceLength: metrics.maximumTerminalSentenceLength },
      thresholds.maximumTerminalSentenceCharacters,
    ));
  }
  return { ...metrics, status: statusFromFindings(findings), findings };
}

function batchMeasurements(rows, baseline) {
  const count = rows.length;
  const skeletonExact = distribution(rows.map((item) => item.discourseSkeleton));
  const skeletonCompressed = distribution(rows.map((item) => item.compressedDiscourseSkeleton));
  const skeletonDistribution = skeletonCompressed.modeCount >= skeletonExact.modeCount ? skeletonCompressed : skeletonExact;
  const stepCounts = distribution(rows.map((item) => item.stepCount));
  const weakTags = distribution(rows.filter((item) => item.weakScheduleDevice).map((item) => item.scheduleAuthenticityTag));
  const allScheduleTags = distribution(rows.map((item) => item.scheduleAuthenticityTag));
  const requestFrames = distribution(rows.map((item) => item.requestFrame || "missing"));
  const totalVisibleCharacters = rows.reduce((sum, item) => sum + item.questionLength, 0);
  const totalCommas = rows.reduce((sum, item) => sum + item.commaCount, 0);
  const totalPeriods = rows.reduce((sum, item) => sum + item.periodCount, 0);
  const totalEnumerationCommas = rows.reduce((sum, item) => sum + item.enumerationCommaCount, 0);
  const shortOpeningCap = baseline.thresholds.row.shortOpeningMaxCharacters.value;
  const longSentenceCap = baseline.thresholds.row.maximumTerminalSentenceCharacters.value;
  return {
    rowCount: count,
    firstPersonShare: round(rows.filter((item) => item.firstPersonPresent).length / Math.max(1, count)),
    firstPersonOpeningShare: round(rows.filter((item) => item.firstPersonOpening).length / Math.max(1, count)),
    discourseSkeletonDominantShare: round(skeletonDistribution.modeCount / Math.max(1, count)),
    discourseSkeletonDominant: skeletonDistribution.mode,
    discourseSkeletonCounts: skeletonDistribution.counts,
    fixedWordExcelTailShare: round(rows.filter((item) => item.fixedWordExcelTail).length / Math.max(1, count)),
    finalStepSelfCheckShare: round(rows.filter((item) => item.finalStepSelfCheck).length / Math.max(1, count)),
    stepCountModeShare: round(stepCounts.modeCount / Math.max(1, count)),
    stepCountMode: Number(stepCounts.mode || 0),
    stepCountCounts: stepCounts.counts,
    weakScheduleShare: round(rows.filter((item) => item.weakScheduleDevice).length / Math.max(1, count)),
    weakScheduleDominantShare: round(weakTags.modeCount / Math.max(1, count)),
    weakScheduleDominantTag: weakTags.mode,
    scheduleTagCounts: allScheduleTags.counts,
    disclaimerHeavyShare: round(rows.filter((item) => item.findings.some((findingItem) => findingItem.rule === "disclaimer_missing_material_density")).length / Math.max(1, count)),
    lowConcreteFactShare: round(rows.filter((item) => item.findings.some((findingItem) => findingItem.rule === "low_concrete_fact_density")).length / Math.max(1, count)),
    explicitRequestShare: round(rows.filter((item) => item.explicitRequestPresent).length / Math.max(1, count)),
    requestFrameDominantShare: round(requestFrames.modeCount / Math.max(1, count)),
    requestFrameDominant: requestFrames.mode,
    requestFrameCounts: requestFrames.counts,
    shortOpeningShare: round(rows.filter((item) => item.firstSentenceLength <= shortOpeningCap).length / Math.max(1, count)),
    firstPunctuationTerminalShare: round(rows.filter((item) => item.firstPunctuationIsTerminal).length / Math.max(1, count)),
    firstSentenceCommaShare: round(rows.filter((item) => item.firstSentenceCommaCount > 0).length / Math.max(1, count)),
    commaToPeriodRatio: round(totalCommas / Math.max(1, totalPeriods)),
    enumerationCommasPer100Chars: round((totalEnumerationCommas * 100) / Math.max(1, totalVisibleCharacters)),
    earlyStructuralPunctuationShare: round(rows.filter((item) => item.earlyStructuralPunctuation).length / Math.max(1, count)),
    semicolonRowShare: round(rows.filter((item) => item.containsSemicolon).length / Math.max(1, count)),
    longSentenceShare: round(rows.filter((item) => item.maximumTerminalSentenceLength > longSentenceCap).length / Math.max(1, count)),
  };
}

const TEMPLATE_BATCH_METRICS = [
  ["discourseSkeletonDominantShare", "paragraph_discourse_skeleton_concentration"],
  ["fixedWordExcelTailShare", "fixed_word_excel_tail_concentration"],
  ["weakScheduleShare", "weak_time_meeting_device_concentration"],
  ["weakScheduleDominantShare", "time_meeting_authenticity_tag_concentration"],
];

function evaluateBatch(rows, baseline) {
  const metrics = batchMeasurements(rows, baseline);
  const thresholds = baseline.thresholds.batch;
  const findings = [];
  const reviewLevelSignals = [];
  if (rows.length >= thresholds.minimumRows.value) {
    for (const [metricName, rule] of TEMPLATE_BATCH_METRICS) {
      const level = compareUpper(metrics[metricName], thresholds[metricName]);
      if (level !== "PASS") {
        reviewLevelSignals.push({ metricName, level, value: metrics[metricName] });
        findings.push(finding(
          rule,
          level,
          `Batch ${metricName} exceeds the approved-corpus concentration bound.`,
          {
            value: metrics[metricName],
            ...(metricName.includes("Skeleton") ? { dominant: metrics.discourseSkeletonDominant } : {}),
            ...(metricName.includes("stepCount") ? { mode: metrics.stepCountMode } : {}),
            ...(metricName.includes("Schedule") ? { dominantTag: metrics.weakScheduleDominantTag } : {}),
          },
          thresholds[metricName],
        ));
      }
    }
    if (reviewLevelSignals.length >= thresholds.reviewLevelTemplateSignalsForFail.value
      && !findings.some((item) => item.rule === "batch_template_concentration")) {
      findings.push(finding(
        "batch_template_concentration",
        "FAIL",
        "Multiple independent discourse features concentrate in the same batch; the batch is template-derived even if no single feature crosses its fail bound.",
        { signalCount: reviewLevelSignals.length, signals: reviewLevelSignals },
        thresholds.reviewLevelTemplateSignalsForFail,
      ));
    }
    const languageMetrics = [
      ["requestFrameDominantShare", "request_frame_concentration", "upper"],
      ["shortOpeningShare", "short_opening_concentration", "upper"],
      ["firstPunctuationTerminalShare", "opening_hard_stop_concentration", "upper"],
      ["firstSentenceCommaShare", "opening_comma_scarcity", "lower"],
      ["commaToPeriodRatio", "comma_to_period_ratio_low", "lower"],
      ["enumerationCommasPer100Chars", "enumeration_punctuation_density", "upper"],
      ["earlyStructuralPunctuationShare", "early_colon_semicolon_concentration", "upper"],
      ["semicolonRowShare", "semicolon_row_concentration", "upper"],
      ["longSentenceShare", "overlong_comma_run_concentration", "upper"],
    ];
    for (const [metricName, rule, direction] of languageMetrics) {
      const level = direction === "lower"
        ? compareLower(metrics[metricName], thresholds[metricName])
        : compareUpper(metrics[metricName], thresholds[metricName]);
      if (level === "PASS") continue;
      findings.push(finding(
        rule,
        level,
        `Batch ${metricName} violates the explicit request-and-punctuation language contract.`,
        {
          value: metrics[metricName],
          ...(metricName === "requestFrameDominantShare" ? { dominantFrame: metrics.requestFrameDominant } : {}),
        },
        thresholds[metricName],
      ));
    }
  }
  return { status: statusFromFindings(findings), metrics, findings };
}

export function evaluateNaturalnessRows(rows, baseline) {
  validateNaturalnessBaseline(baseline);
  if (!Array.isArray(rows) || !rows.length) throw new Error("Naturalness gate requires at least one candidate row.");
  const evaluatedRows = rows.map((row, index) => evaluateRowMetrics(measureNaturalnessRow(row, index), baseline));
  const batch = evaluateBatch(evaluatedRows, baseline);
  const allFindings = [...evaluatedRows.flatMap((row) => row.findings), ...batch.findings];
  const status = statusFromFindings(allFindings);
  return {
    status,
    ok: status === "PASS",
    reviewRequired: status === "REVIEW",
    blocked: status !== "PASS",
    summary: {
      rowCount: evaluatedRows.length,
      rowStatusCounts: distribution(evaluatedRows.map((row) => row.status)).counts,
      batchStatus: batch.status,
      findingCounts: distribution(allFindings.map((item) => `${item.severity}:${item.rule}`)).counts,
    },
    rows: evaluatedRows,
    batch,
  };
}

async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function reviewBindingHash({ candidateHash, baselineHash, reportHash, requestedBy }) {
  return crypto.createHash("sha256")
    .update(`${NATURALNESS_GATE_ID}\n${candidateHash}\n${baselineHash}\n${reportHash}\n${String(requestedBy ?? "").trim()}`)
    .digest("hex");
}

export function buildNaturalnessReviewRequest({
  report,
  reportPath,
  reportHash,
  candidatePath,
  candidateHash,
  baselinePath,
  baselineHash,
  requestedBy = "naturalness-gate-automation",
}) {
  if (report?.status !== "REVIEW") throw new Error("A review request can only be built for a REVIEW report.");
  if (!String(requestedBy).trim()) throw new Error("A naturalness review requester identity is required.");
  const bindingHash = reviewBindingHash({ candidateHash, baselineHash, reportHash, requestedBy });
  return {
    schemaVersion: 1,
    kind: "naturalness-review-request",
    status: "PENDING_REVIEW",
    requestId: `naturalness_${bindingHash.slice(0, 24)}`,
    generatedAt: new Date().toISOString(),
    gateId: NATURALNESS_GATE_ID,
    metricsVersion: NATURALNESS_METRICS_VERSION,
    questionLanguagePolicyId: QUESTION_LANGUAGE_POLICY_ID,
    reportPath: path.resolve(reportPath),
    reportHash,
    candidatePath: path.resolve(candidatePath),
    candidateHash,
    baselinePath: path.resolve(baselinePath),
    baselineHash,
    requestedBy: String(requestedBy).trim(),
    bindingHash,
    reviewFindings: [
      ...report.rows.flatMap((row) => row.findings.filter((item) => item.severity === "REVIEW").map((item) => ({ uid: row.uid, rule: item.rule }))),
      ...report.batch.findings.filter((item) => item.severity === "REVIEW").map((item) => ({ scope: "batch", rule: item.rule })),
    ],
    signoff: null,
    note: "This is a hash-bound review request, not an approval. A separate explicit signoff is required before downstream receipt generation.",
  };
}

export async function verifyNaturalnessReviewRequest(request, overrides = {}) {
  const errors = [];
  if (request?.kind !== "naturalness-review-request") errors.push("Unexpected request kind.");
  if (request?.status !== "PENDING_REVIEW") errors.push("Review request is not pending.");
  if (request?.signoff != null) errors.push("Base review request must not contain an automatic signoff.");
  if (!String(request?.requestedBy ?? "").trim()) errors.push("Review requester identity is missing.");
  const candidatePath = overrides.candidatePath ?? request?.candidatePath;
  const baselinePath = overrides.baselinePath ?? request?.baselinePath;
  const reportPath = overrides.reportPath ?? request?.reportPath;
  try {
    const [candidateHash, baselineHash, reportHash, report] = await Promise.all([
      sha256File(candidatePath),
      sha256File(baselinePath),
      sha256File(reportPath),
      fs.readFile(reportPath, "utf8").then(JSON.parse),
    ]);
    if (candidateHash !== request.candidateHash) errors.push("Candidate hash mismatch.");
    if (baselineHash !== request.baselineHash) errors.push("Baseline hash mismatch.");
    if (reportHash !== request.reportHash) errors.push("Report hash mismatch.");
    if (report.status !== "REVIEW") errors.push("Bound report is not REVIEW.");
    const expectedBinding = reviewBindingHash({
      candidateHash,
      baselineHash,
      reportHash,
      requestedBy: request.requestedBy,
    });
    if (expectedBinding !== request.bindingHash) errors.push("Binding hash mismatch.");
  } catch (error) {
    errors.push(error?.message || String(error));
  }
  return { ok: errors.length === 0, pending: errors.length === 0, errors };
}

// Signoffs are deliberately external. This verifier accepts a separately authored
// decision but never creates one and never converts REVIEW to PASS by itself.
export function verifyNaturalnessReviewSignoff(request, signoff, { requestHash = "" } = {}) {
  const errors = [];
  if (signoff?.kind !== "naturalness-review-signoff") errors.push("Unexpected signoff kind.");
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
  if (!signoff?.reviewedAt || Number.isNaN(Date.parse(signoff.reviewedAt))) errors.push("Valid signoff reviewedAt is required.");
  return {
    ok: errors.length === 0,
    approved: errors.length === 0 && signoff.decision === "APPROVE",
    rejected: errors.length === 0 && signoff.decision === "REJECT",
    errors,
  };
}

export async function runNaturalnessGate({
  candidatePath,
  baselinePath,
  reportPath,
  reviewRequestPath = "",
  reviewRequester = "naturalness-gate-automation",
} = {}) {
  if (!candidatePath || !baselinePath || !reportPath) {
    throw new Error("runNaturalnessGate requires candidatePath, baselinePath, and reportPath.");
  }
  const [candidateText, baselineText, candidateHash, baselineHash] = await Promise.all([
    fs.readFile(candidatePath, "utf8"),
    fs.readFile(baselinePath, "utf8"),
    sha256File(candidatePath),
    sha256File(baselinePath),
  ]);
  const rows = parseTsvRows(candidateText);
  const baseline = resolveNaturalnessBaseline(JSON.parse(baselineText));
  const evaluation = evaluateNaturalnessRows(rows, baseline);
  const report = {
    schemaVersion: 1,
    kind: "naturalness-gate-report",
    gateId: NATURALNESS_GATE_ID,
    metricsVersion: NATURALNESS_METRICS_VERSION,
    questionLanguagePolicyId: QUESTION_LANGUAGE_POLICY_ID,
    generatedAt: new Date().toISOString(),
    candidatePath: path.resolve(candidatePath),
    candidateHash,
    baselinePath: path.resolve(baselinePath),
    baselineHash,
    baselineId: baseline.baselineId,
    baselineSampleCount: baseline.sampleCount,
    effectiveThresholds: baseline.thresholds,
    ...evaluation,
  };
  await writeJsonAtomic(reportPath, report);

  let reviewRequest = null;
  if (reviewRequestPath && report.status === "REVIEW") {
    const reportHash = await sha256File(reportPath);
    reviewRequest = buildNaturalnessReviewRequest({
      report,
      reportPath,
      reportHash,
      candidatePath,
      candidateHash,
      baselinePath,
      baselineHash,
      requestedBy: reviewRequester,
    });
    await writeJsonAtomic(reviewRequestPath, reviewRequest);
  } else if (reviewRequestPath) {
    await fs.rm(reviewRequestPath, { force: true });
  }
  return { report, reviewRequest };
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
  if ((args.mode ?? "check") === "calibrate") {
    if (!args.reference || !args["baseline-out"]) {
      throw new Error("Calibration mode requires --reference and --baseline-out.");
    }
    const referencePath = resolveFromRoot(args.reference);
    const rows = parseTsvRows(await fs.readFile(referencePath, "utf8"));
    const profile = args.profile ? JSON.parse(await fs.readFile(resolveFromRoot(args.profile), "utf8")) : undefined;
    const baseline = calibrateNaturalnessBaseline(rows, {
      baselineId: args["baseline-id"] || path.basename(referencePath, path.extname(referencePath)),
      profile,
    });
    await writeJsonAtomic(resolveFromRoot(args["baseline-out"]), baseline);
    return baseline;
  }
  const result = await runNaturalnessGate({
    candidatePath: resolveFromRoot(args.candidate),
    baselinePath: resolveFromRoot(args.baseline),
    reportPath: resolveFromRoot(args.report),
    reviewRequestPath: args["review-request"] ? resolveFromRoot(args["review-request"]) : "",
  });
  process.exitCode = result.report.status === "PASS" ? 0 : result.report.status === "REVIEW" ? 2 : 1;
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
