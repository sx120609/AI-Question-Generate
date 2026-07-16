import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createFeishuClient } from "./feishu_openapi_client.mjs";
import { activeGeneratedAnnotators, loadGeneratedIdentities, matchGeneratedIdentity } from "./generated_identities.mjs";
import { analyzeQuestionPunctuation, analyzeQuestionRequest } from "./language_style.mjs";
import { REPO_ROOT, writeJsonAtomic } from "./run_context.mjs";

export const BENCHMARK_ID = "naturalness-benchmark-v2";
export const SELECTION_ALGORITHM = "strict-pass-natural-diversity-v2";
export const DEFAULT_SPREADSHEET_TOKEN = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
export const DEFAULT_SHEET_ID = "49e351";
export const DEFAULT_POSITIVE_TARGET = 30;
export const DEFAULT_EXPECTED_NEGATIVES = 22;
export const DEFAULT_MINIMUM_POSITIVES = 10;

const COLUMN = Object.freeze({
  uid: 0,
  question: 1,
  taskType: 2,
  categoryL1: 3,
  categoryL2: 4,
  categoryL3: 5,
  summary: 6,
  attachments: 9,
  deliverableContent: 13,
  keySteps: 14,
  annotator: 15,
  qaStatus: 45,
  qaNote: 46,
});

const REQUIRED_TEXT_FIELDS = Object.freeze([
  ["question", "B 题目"],
  ["summary", "G 任务概括"],
  ["deliverableContent", "N 产物内容"],
  ["keySteps", "O 做题关键步骤"],
]);

const DISCOURSE_ACTION_RULES = Object.freeze([
  ["scene_setup", /(?:周[一二三四五六日天]|今天|昨天|明天|本周|下周|月底|月初|上午|下午|晚上|刚刚|临时|突然|会上|会前|老板|客户|同事|老师|负责人|部门|门店|公司)/u],
  ["problem_report", /(?:发现|遇到|出了?问题|卡在|打回|驳回|投诉|反馈|争议|混乱|对不上|说不清|不一致|异常|担心|着急|被问|追问)/u],
  ["evidence_inventory", /(?:我手头|手头|已有|现有|拿到|收到|材料包括|附件(?:里|中|提供)|台账|记录|合同|截图|清单|凭证)/u],
  ["uncertainty_gap", /(?:缺少|缺失|没给|没有提供|尚未|还没|未能|待确认|待补|无法判断|不能确认|资料不全|材料不足|对不上)/u],
  ["analysis_request", /(?:核对|梳理|分析|复核|测算|比较|评估|盘点|拆解|校验|检查|归类|识别|排查)/u],
  ["decision_request", /(?:判断|决定|取舍|是否|能不能|要不要|优先|建议|结论|分级|分层|保留|暂停|上线|下架)/u],
  ["deliverable_request", /(?:交付|提交|输出|形成|整理成|产物|Word|Excel|PPT|PDF|txt|表格|文稿|说明|底稿|报告|清单)/iu],
  ["audience_context", /(?:给.{0,12}(?:看|用)|拿给|会上|汇报|会签|评审|家长会|管理层|领导|业务条线|法务|客户|店长|老板)/u],
  ["boundary_constraint", /(?:不能|不得|不允许|不应|不要|不可|不外推|不编造|不得假定|只针对|仅依据|以附件为准|材料不足)/u],
  ["coordination_followup", /(?:负责人|责任人|跟进|补充|补齐|对接|分工|交接|整改|复核人|截止时间|完成时间|升级处理)/u],
  ["self_check", /(?:自检|复查|交叉检查|最后检查|一致性检查|演练|验收)/u],
]);

const BOUNDARY_MARKERS = Object.freeze([
  "不能",
  "不得",
  "不允许",
  "不应",
  "不要",
  "不可",
  "无法",
  "尚未",
  "还没",
  "未提供",
  "待确认",
  "待补",
  "不外推",
  "不编造",
  "不作判断",
  "不做判断",
  "不纳入",
  "材料不足",
  "资料不足",
  "缺少",
  "缺失",
  "不足以",
  "暂不",
  "只能",
  "只针对",
  "仅依据",
]);

const TEMPLATE_SIGNALS = Object.freeze([
  ["formulaic_final_output", /(?:最终|最后)(?:需要|形成|交付|输出|提交)/u],
  ["editable_artifact_bundle", /(?:两|三|四|2|3|4)份可编辑(?:材料|产物)|可编辑产物/u],
  ["generic_no_fabrication", /(?:不能|不得)编造/u],
  ["generic_source_boundary", /没有材料支撑的.{0,30}(?:待确认|不能|不得)|附件里判断不了/u],
  ["mechanical_self_check", /(?:做产物自检|做一次自检|最后自检|最后检查三份|一致性自检)/u],
  ["artifact_format_repetition", /(?:Word|Excel|PPT|PDF|txt).{0,80}(?:Word|Excel|PPT|PDF|txt).{0,80}(?:Word|Excel|PPT|PDF|txt)/iu],
  ["mechanical_evidence_classes", /(?:可直接支撑|需要补充).{0,80}(?:只能作为辅助|不能支撑)/u],
  ["generic_scope_disclaimer", /(?:材料不足|资料不足).{0,40}(?:保留|写成|标为|不得|不能).{0,30}(?:待确认|待补|风险|结论)/u],
]);

const ATTACHMENT_FAILURE_PATTERN = /(?:附件|文件|链接).{0,16}(?:无法读取|不能读取|未能读取|读取失败|打不开|空白|损坏|缺失|失效|过期|限流)|(?:rate\s*limit|too\s*many\s*requests)/iu;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

export function cellText(value) {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map(cellText).join("");
  if (typeof value === "object") {
    return cellText(value.text ?? value.value ?? value.rich_text ?? value.link ?? value.url ?? "");
  }
  return "";
}

function normalizeText(value) {
  return cellText(value).replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function attachmentParts(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((part) => part && typeof part === "object" && (part.type === "attachment" || part.fileToken));
}

export function rowFromCells(cells, sheetRow) {
  const attachments = attachmentParts(cells?.[COLUMN.attachments]);
  return {
    sheetRow,
    uid: normalizeText(cells?.[COLUMN.uid]),
    annotator: normalizeText(cells?.[COLUMN.annotator]),
    qaStatus: normalizeText(cells?.[COLUMN.qaStatus]),
    qaNote: normalizeText(cells?.[COLUMN.qaNote]),
    taskType: normalizeText(cells?.[COLUMN.taskType]),
    categories: {
      level1: normalizeText(cells?.[COLUMN.categoryL1]),
      level2: normalizeText(cells?.[COLUMN.categoryL2]),
      level3: normalizeText(cells?.[COLUMN.categoryL3]),
    },
    fields: {
      question: normalizeText(cells?.[COLUMN.question]),
      summary: normalizeText(cells?.[COLUMN.summary]),
      deliverableContent: normalizeText(cells?.[COLUMN.deliverableContent]),
      keySteps: normalizeText(cells?.[COLUMN.keySteps]),
    },
    attachmentAudit: {
      attachmentCount: attachments.length,
      tokenCount: attachments.filter((part) => String(part.fileToken ?? "").trim()).length,
      nonEmptyFileCount: attachments.filter((part) => Number(part.size ?? 0) > 0).length,
      names: attachments.map((part) => normalizeText(part.text ?? part.fileName ?? "")).filter(Boolean),
    },
  };
}

function splitSentences(text) {
  return String(text ?? "")
    .split(/(?<=[。！？!?])|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitParagraphs(text) {
  return String(text ?? "")
    .split(/\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function countMatches(text, pattern) {
  return [...String(text ?? "").matchAll(pattern)].length;
}

export function findPoliteImperatives(text) {
  const source = String(text ?? "");
  const withoutLexicalUses = source.replace(/申请|邀请|请示|请求|提请|报请|聘请|宴请|请(?:过|了)?假|请款|请柬/g, "");
  const matches = [];
  for (const match of withoutLexicalUses.matchAll(/请/g)) matches.push({ marker: match[0], index: match.index ?? 0 });
  return matches;
}

function extractConcreteNumbers(text) {
  const source = String(text ?? "");
  const arabic = source.match(/(?:\d{4}[年./-]\d{1,2}(?:[月./-]\d{1,2}日?)?|\d+(?:\.\d+)?(?:%|％|万|亿|元|万元|亿元|名|人|家|个|笔|份|项|条|辆|页|天|周|月|年|小时|分钟|公里|米|岁|层|组|批|轮|次|套|种|点|时|h)?)/giu) ?? [];
  const chinese = source.match(/[一二三四五六七八九十百千万两半]+(?=名|人|家|个|笔|份|项|条|辆|页|天|周|月|年|小时|分钟|公里|米|岁|层|组|批|轮|次|套|种|点|时)/gu) ?? [];
  const tokens = [...arabic, ...chinese].map((item) => item.trim()).filter(Boolean);
  return {
    count: tokens.length,
    uniqueCount: new Set(tokens).size,
    examples: [...new Set(tokens)].slice(0, 12),
  };
}

function discourseActions(sentences) {
  const counts = Object.fromEntries(DISCOURSE_ACTION_RULES.map(([name]) => [name, 0]));
  const sequence = [];
  for (const sentence of sentences) {
    const actions = DISCOURSE_ACTION_RULES.filter(([, pattern]) => pattern.test(sentence)).map(([name]) => name);
    for (const action of actions) counts[action] += 1;
    if (actions.length) sequence.push({ sentence: sentence.slice(0, 72), actions });
  }
  const unique = Object.entries(counts).filter(([, count]) => count > 0).map(([name]) => name);
  return { unique, uniqueCount: unique.length, counts, sequence };
}

function openingType(question) {
  const first = splitSentences(question)[0] ?? "";
  if (/(?:^|[，,])我(?:在|们|手头|负责|刚|收到|发现|需要)/u.test(first)) return "first_person_role";
  if (/^(?:周[一二三四五六日天]|今天|昨天|明天|本周|下周|月底|月初|上午|下午|晚上|刚刚)/u.test(first)) return "time_or_event_led";
  if (/(?:电话|群里|会上|找到我|发来|说|问|追问|反馈)/u.test(first)) return "stakeholder_prompted";
  if (/(?:发现|问题|异常|争议|投诉|打回|混乱|对不上)/u.test(first)) return "problem_led";
  return "direct_context";
}

export function extractNaturalnessFeatures(record) {
  const question = record?.fields?.question ?? "";
  const narrative = REQUIRED_TEXT_FIELDS.map(([field]) => record?.fields?.[field] ?? "").join("\n");
  const sentences = splitSentences(question);
  const paragraphs = splitParagraphs(question);
  const boundarySentences = sentences.filter((sentence) => BOUNDARY_MARKERS.some((marker) => sentence.includes(marker)));
  const templateSignals = TEMPLATE_SIGNALS.filter(([, pattern]) => pattern.test(narrative)).map(([name]) => name);
  const firstPersonCount = countMatches(question, /(?:我们|咱们|我方|我)(?!国)/gu);
  const stepLines = splitParagraphs(record?.fields?.keySteps ?? "");
  const request = analyzeQuestionRequest(question);
  const punctuation = analyzeQuestionPunctuation(question);

  return {
    length: {
      questionCharacters: [...question].length,
      questionNonWhitespaceCharacters: [...question.replace(/\s/gu, "")].length,
      allNarrativeCharacters: [...narrative].length,
    },
    concreteNumbers: extractConcreteNumbers(question),
    firstPerson: {
      present: firstPersonCount > 0,
      count: firstPersonCount,
    },
    boundaryDensity: {
      sentenceCount: sentences.length,
      boundarySentenceCount: boundarySentences.length,
      ratio: sentences.length ? Number((boundarySentences.length / sentences.length).toFixed(4)) : 0,
      examples: boundarySentences.slice(0, 4).map((sentence) => sentence.slice(0, 100)),
    },
    paragraphs: {
      count: paragraphs.length,
      characterLengths: paragraphs.map((paragraph) => [...paragraph].length),
    },
    discourseActions: discourseActions(sentences),
    openingType: openingType(question),
    stepCount: stepLines.length,
    politeImperatives: findPoliteImperatives(narrative),
    request,
    punctuation,
    templateSignals,
  };
}

function missingFields(record) {
  return REQUIRED_TEXT_FIELDS.filter(([field]) => !record?.fields?.[field]).map(([, label]) => label);
}

function positiveQualityScore(features) {
  const concrete = Math.min(features.concreteNumbers.count, 10) * 2;
  const firstPerson = features.firstPerson.present ? 5 : 0;
  const actionVariety = Math.min(features.discourseActions.uniqueCount, 9) * 2;
  const paragraphShape = features.paragraphs.count >= 3 && features.paragraphs.count <= 8 ? 4 : 0;
  const directRequest = features.request.clear ? 5 : 0;
  const boundaryPenalty = Math.round(features.boundaryDensity.ratio * 20);
  const templatePenalty = features.templateSignals.length * 4;
  return concrete + firstPerson + actionVariety + paragraphShape + directRequest - boundaryPenalty - templatePenalty;
}

export function evaluatePositiveCandidate(record, identities) {
  const features = extractNaturalnessFeatures(record);
  const exclusions = [];
  if (record.qaStatus !== "✅通过") exclusions.push("qa_status_not_exact_pass");
  if (matchGeneratedIdentity({ name: record.annotator, uid: record.uid }, identities)) exclusions.push("managed_system_annotator");
  const missing = missingFields(record);
  if (missing.length) exclusions.push(`missing_required_fields:${missing.join(",")}`);
  if (record.attachmentAudit.tokenCount < 1) exclusions.push("no_tokenized_attachment");
  if (ATTACHMENT_FAILURE_PATTERN.test(record.qaNote)) exclusions.push("qa_note_attachment_failure");
  if (features.discourseActions.uniqueCount < 3) exclusions.push("too_few_discourse_actions");
  if (features.templateSignals.length >= 5 || (features.templateSignals.length >= 3 && features.boundaryDensity.ratio >= 0.34)) {
    exclusions.push("obvious_template_stack");
  }
  return {
    eligible: exclusions.length === 0,
    exclusions,
    score: positiveQualityScore(features),
    features,
  };
}

function deterministicSort(left, right) {
  return right.evaluation.score - left.evaluation.score
    || left.record.annotator.localeCompare(right.record.annotator, "zh-CN")
    || left.record.sheetRow - right.record.sheetRow;
}

export function selectPositiveBenchmark(candidates, target = DEFAULT_POSITIVE_TARGET) {
  const ranked = [...candidates].sort(deterministicSort);
  const selected = [];
  const selectedRows = new Set();
  const annotatorCounts = new Map();
  const openingCounts = new Map();

  function addWithCaps(annotatorCap, openingCap) {
    for (const item of ranked) {
      if (selected.length >= target) return;
      if (selectedRows.has(item.record.sheetRow)) continue;
      if ((annotatorCounts.get(item.record.annotator) ?? 0) >= annotatorCap) continue;
      const opening = item.evaluation.features.openingType;
      if ((openingCounts.get(opening) ?? 0) >= openingCap) continue;
      selected.push(item);
      selectedRows.add(item.record.sheetRow);
      annotatorCounts.set(item.record.annotator, (annotatorCounts.get(item.record.annotator) ?? 0) + 1);
      openingCounts.set(opening, (openingCounts.get(opening) ?? 0) + 1);
    }
  }

  addWithCaps(2, Math.max(6, Math.ceil(target * 0.4)));
  addWithCaps(3, Math.max(9, Math.ceil(target * 0.55)));
  addWithCaps(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  return selected;
}

function latestByUid(records) {
  const latest = new Map();
  for (const record of records) {
    if (!record.uid) continue;
    const current = latest.get(record.uid);
    if (!current || record.sheetRow > current.sheetRow) latest.set(record.uid, record);
  }
  return [...latest.values()].sort((left, right) => left.sheetRow - right.sheetRow);
}

function benchmarkEntry(record, label, features, selection) {
  return {
    label,
    source: {
      sheetRow: record.sheetRow,
      uid: record.uid,
      annotator: record.annotator,
      qaStatus: record.qaStatus,
      qaNote: record.qaNote,
    },
    context: {
      taskType: record.taskType,
      categories: record.categories,
      attachmentCount: record.attachmentAudit.attachmentCount,
      attachmentTokenCount: record.attachmentAudit.tokenCount,
    },
    fields: {
      B_question: record.fields.question,
      G_summary: record.fields.summary,
      N_deliverableContent: record.fields.deliverableContent,
      O_keySteps: record.fields.keySteps,
    },
    features,
    selection,
  };
}

function summarizeNumeric(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { min: 0, median: 0, mean: 0, max: 0 };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    min: sorted[0],
    median: Number(median.toFixed(2)),
    mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(2)),
    max: sorted.at(-1),
  };
}

function corpusStatistics(entries) {
  return {
    questionCharacters: summarizeNumeric(entries.map((entry) => entry.features.length.questionCharacters)),
    concreteNumberCount: summarizeNumeric(entries.map((entry) => entry.features.concreteNumbers.count)),
    firstPersonShare: entries.length
      ? Number((entries.filter((entry) => entry.features.firstPerson.present).length / entries.length).toFixed(4))
      : 0,
    directRequestShare: entries.length
      ? Number((entries.filter((entry) => entry.features.request?.clear).length / entries.length).toFixed(4))
      : 0,
    boundarySentenceRatio: summarizeNumeric(entries.map((entry) => entry.features.boundaryDensity.ratio)),
    paragraphCount: summarizeNumeric(entries.map((entry) => entry.features.paragraphs.count)),
    discourseActionVariety: summarizeNumeric(entries.map((entry) => entry.features.discourseActions.uniqueCount)),
    stepCount: summarizeNumeric(entries.map((entry) => entry.features.stepCount)),
    firstSentenceLength: summarizeNumeric(entries.map((entry) => entry.features.punctuation?.firstSentenceLength ?? 0)),
    commaToPeriodRatio: summarizeNumeric(entries.map((entry) => entry.features.punctuation?.commaToPeriodRatio ?? 0)),
    enumerationCommasPer100Chars: summarizeNumeric(entries.map((entry) => entry.features.punctuation?.enumerationCommasPer100Chars ?? 0)),
    requestFrames: Object.fromEntries(
      [...new Set(entries.map((entry) => entry.features.request?.frame || "missing"))]
        .sort()
        .map((frame) => [frame, entries.filter((entry) => (entry.features.request?.frame || "missing") === frame).length]),
    ),
    openingTypes: Object.fromEntries(
      [...new Set(entries.map((entry) => entry.features.openingType))]
        .sort()
        .map((type) => [type, entries.filter((entry) => entry.features.openingType === type).length]),
    ),
  };
}

function digestRows(records) {
  const canonical = records.map((record) => ({
    sheetRow: record.sheetRow,
    uid: record.uid,
    annotator: record.annotator,
    qaStatus: record.qaStatus,
    qaNote: record.qaNote,
    fields: record.fields,
    attachmentAudit: record.attachmentAudit,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function buildBenchmark({
  records,
  identities,
  source,
  positiveTarget = DEFAULT_POSITIVE_TARGET,
  expectedNegatives = DEFAULT_EXPECTED_NEGATIVES,
  minimumPositives = DEFAULT_MINIMUM_POSITIVES,
}) {
  const latestRecords = latestByUid(records.filter((record) => record.uid || Object.values(record.fields).some(Boolean)));
  const evaluated = latestRecords.map((record) => ({ record, evaluation: evaluatePositiveCandidate(record, identities) }));
  const strictPassOthers = evaluated.filter(({ record }) => record.qaStatus === "✅通过" && !matchGeneratedIdentity({ name: record.annotator, uid: record.uid }, identities));
  const strictPassWithoutPoliteImperative = strictPassOthers.filter((item) => item.evaluation.features.politeImperatives.length === 0);
  const strictPassWithDirectRequest = strictPassOthers.filter((item) => item.evaluation.features.request.clear);
  const eligible = strictPassOthers.filter((item) => item.evaluation.eligible);
  const selected = selectPositiveBenchmark(eligible, positiveTarget);
  const managed = latestRecords.filter((record) => matchGeneratedIdentity({ name: record.annotator, uid: record.uid }, identities));

  if (managed.length !== expectedNegatives) {
    throw new Error(`Expected ${expectedNegatives} current managed records, found ${managed.length}. Refusing to emit a partial negative corpus.`);
  }
  if (selected.length < Math.min(minimumPositives, positiveTarget)) {
    throw new Error(`Only ${selected.length} positive records survived strict filters; at least ${Math.min(minimumPositives, positiveTarget)} are required.`);
  }

  const positives = selected.map(({ record, evaluation }) => benchmarkEntry(record, "positive_human_approved", evaluation.features, {
    reason: "strict_qa_pass_other_annotator_and_naturalness_eligibility",
    qualityScore: evaluation.score,
    eligibilityChecks: [
      "AT exact ✅通过",
      "not a managed system annotator",
      "B/G/N/O complete",
      "polite imperative is measured for diagnosis but is not used to discard otherwise approved human references",
      "at least one tokenized attachment and no attachment-failure QA note",
      "at least three discourse-action classes; paragraph count is measured but deliberately not normalized",
      "no obvious template-signal stack",
    ],
  }));
  const negatives = managed.map((record) => benchmarkEntry(record, "negative_current_system_generated", extractNaturalnessFeatures(record), {
    reason: "current_record_owned_by_managed_generated_identity",
    managedIdentity: matchGeneratedIdentity({ name: record.annotator, uid: record.uid }, identities)?.name ?? record.annotator,
    note: "Negative label denotes the current deep-template/human-machine-style comparison set; it does not claim that external QA failed.",
  }));

  const exclusionCounts = {};
  for (const item of strictPassOthers.filter(({ evaluation }) => !evaluation.eligible)) {
    for (const reason of item.evaluation.exclusions) exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1;
  }

  const benchmark = {
    schemaVersion: 1,
    benchmarkId: BENCHMARK_ID,
    selectionAlgorithm: SELECTION_ALGORITHM,
    generatedAt: new Date().toISOString(),
    purpose: "Use approved human-authored records as naturalness references and the current Shen Li / Pei Ying system-owned records as contrastive negatives. This is a generation and review benchmark, not a QA-pass predictor.",
    source: {
      ...source,
      sourceRecordDigestSha256: digestRows(latestRecords),
      sourceUniqueRecordCount: latestRecords.length,
    },
    managedGeneratedIdentities: activeGeneratedAnnotators(identities).map((identity) => ({ name: identity.name, uidPrefix: identity.uidPrefix })),
    selectionPolicy: {
      positiveTarget,
      expectedNegativeCount: expectedNegatives,
      minimumPositiveCount: minimumPositives,
      positiveEligibility: [
        "AT must equal ✅通过 exactly; no inferred or historical pass is accepted.",
        "The annotator and UID must not match config/generated_identities.json.",
        "Full B/G/N/O text must be present.",
        "Polite imperative 请 is measured rather than used as a corpus exclusion, so approved human punctuation and request structure are not discarded; generated output still follows its own lexical rules.",
        "At least one Feishu attachment token must exist, and AU must not report attachment/link read failure.",
        "The question must contain at least three detected discourse-action classes. Single-block writing is allowed because slight structural messiness can be a useful human reference.",
        "A row is rejected as obvious template stacking when it has five or more template signals, or at least three signals plus boundary-sentence density of 0.34 or higher.",
      ],
      rankingAndDiversity: [
        "Length is measured but is not part of the quality score.",
        "Score rewards concrete quantities, first-person context, discourse-action variety and a non-flat paragraph shape.",
        "Score penalizes boundary-sentence density and template-signal stacking.",
        "Deterministic passes first cap each annotator at two, then three, and balance opening types before filling any remaining target slots.",
      ],
      featureDefinitions: {
        length: "Unicode character counts for B and all B/G/N/O narrative fields.",
        concreteNumbers: "Arabic quantities/dates and Chinese-number-plus-unit expressions found in B.",
        firstPerson: "Occurrences of 我、我们、咱们、我方 in B, excluding 我国.",
        boundaryDensity: "Share of B sentences containing absence, uncertainty, prohibition or non-extrapolation markers.",
        paragraphs: "Non-empty newline-delimited paragraphs in B.",
        discourseActions: "Rule-based sentence actions: scene, problem, evidence, gap, analysis, decision, deliverable, audience, boundary, coordination and self-check.",
        request: "Natural direct-request frame and its nearby deliverable; this is measured separately from approved status.",
        punctuation: "Terminal-sentence length, first punctuation, comma/period balance, enumeration commas, colons and semicolons.",
      },
    },
    summary: {
      sourceUniqueRecords: latestRecords.length,
      strictPassOtherAnnotatorRecords: strictPassOthers.length,
      strictPassWithoutPoliteImperativeRecords: strictPassWithoutPoliteImperative.length,
      strictPassWithDirectRequestRecords: strictPassWithDirectRequest.length,
      positiveEligibleRecords: eligible.length,
      positiveSelectedRecords: positives.length,
      positiveTargetShortfall: Math.max(0, positiveTarget - positives.length),
      negativeCurrentManagedRecords: negatives.length,
      excludedStrictPassRecordsByReason: Object.fromEntries(Object.entries(exclusionCounts).sort(([left], [right]) => left.localeCompare(right))),
      positive: corpusStatistics(positives),
      negative: corpusStatistics(negatives),
    },
    corpusLimitations: positives.length < positiveTarget
      ? [`Only ${positives.length} approved and otherwise eligible references were available for the target of ${positiveTarget}; the corpus is not padded with unapproved rows.`]
      : [],
    positives,
    negatives,
  };
  validateBenchmark(benchmark, { expectedNegatives, minimumPositives });
  return benchmark;
}

export function validateBenchmark(
  benchmark,
  { expectedNegatives = DEFAULT_EXPECTED_NEGATIVES, minimumPositives = DEFAULT_MINIMUM_POSITIVES } = {},
) {
  const errors = [];
  if (benchmark?.benchmarkId !== BENCHMARK_ID) errors.push("benchmarkId mismatch");
  if (!Array.isArray(benchmark?.positives) || benchmark.positives.length < minimumPositives) {
    errors.push(`fewer than ${minimumPositives} positive examples`);
  }
  if (!Array.isArray(benchmark?.negatives) || benchmark.negatives.length !== expectedNegatives) errors.push(`negative count is not ${expectedNegatives}`);
  const positiveRows = new Set();
  for (const entry of benchmark?.positives ?? []) {
    if (entry.source?.qaStatus !== "✅通过") errors.push(`positive row ${entry.source?.sheetRow} is not exact pass`);
    if (positiveRows.has(entry.source?.sheetRow)) errors.push(`duplicate positive row ${entry.source?.sheetRow}`);
    positiveRows.add(entry.source?.sheetRow);
    for (const field of ["B_question", "G_summary", "N_deliverableContent", "O_keySteps"]) {
      if (!entry.fields?.[field]) errors.push(`positive row ${entry.source?.sheetRow} missing ${field}`);
    }
  }
  const negativeRows = new Set();
  for (const entry of benchmark?.negatives ?? []) {
    if (negativeRows.has(entry.source?.sheetRow)) errors.push(`duplicate negative row ${entry.source?.sheetRow}`);
    negativeRows.add(entry.source?.sheetRow);
    for (const field of ["B_question", "G_summary", "N_deliverableContent", "O_keySteps"]) {
      if (!entry.fields?.[field]) errors.push(`negative row ${entry.source?.sheetRow} missing ${field}`);
    }
  }
  for (const row of positiveRows) if (negativeRows.has(row)) errors.push(`row ${row} appears in both corpora`);
  if (errors.length) throw new Error(`Naturalness benchmark validation failed:\n- ${errors.join("\n- ")}`);
  return { ok: true, positiveCount: positiveRows.size, negativeCount: negativeRows.size };
}

async function loadSourceValueRange({ sourceJson, spreadsheetToken, sheetId, endRow }) {
  if (sourceJson) {
    const parsed = JSON.parse(await fs.readFile(resolveFromRoot(sourceJson), "utf8"));
    const valueRange = parsed.valueRange ?? parsed.data?.valueRange ?? parsed;
    if (!Array.isArray(valueRange.values)) throw new Error(`Source JSON has no valueRange.values: ${sourceJson}`);
    return { valueRange, sourceKind: "json_snapshot" };
  }
  const client = await createFeishuClient();
  const requestedRange = `${sheetId}!A1:AU${endRow}`;
  const valueRange = await client.readRange({ spreadsheetToken, range: requestedRange });
  if (!Array.isArray(valueRange?.values)) throw new Error(`Feishu returned no values for ${requestedRange}`);
  return { valueRange, sourceKind: "feishu_live" };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const spreadsheetToken = args["spreadsheet-token"] || DEFAULT_SPREADSHEET_TOKEN;
  const sheetId = args["sheet-id"] || DEFAULT_SHEET_ID;
  const endRow = Number(args["end-row"] || 500);
  const positiveTarget = Number(args["positive-target"] || DEFAULT_POSITIVE_TARGET);
  const expectedNegatives = Number(args["expected-negatives"] || DEFAULT_EXPECTED_NEGATIVES);
  const minimumPositives = Number(args["minimum-positives"] || DEFAULT_MINIMUM_POSITIVES);
  const outPath = resolveFromRoot(args.out || "config/naturalness_benchmark_v2.json");
  const identities = await loadGeneratedIdentities();
  const { valueRange, sourceKind } = await loadSourceValueRange({
    sourceJson: args["source-json"],
    spreadsheetToken,
    sheetId,
    endRow,
  });
  const records = valueRange.values.slice(1).map((cells, index) => rowFromCells(cells, index + 2));
  const benchmark = buildBenchmark({
    records,
    identities,
    positiveTarget,
    expectedNegatives,
    minimumPositives,
    source: {
      kind: sourceKind,
      spreadsheetToken,
      sheetId,
      requestedRange: `${sheetId}!A1:AU${endRow}`,
      returnedRange: valueRange.range ?? "",
      revision: valueRange.revision ?? null,
    },
  });
  await writeJsonAtomic(outPath, benchmark);
  return {
    ok: true,
    outPath,
    revision: valueRange.revision ?? null,
    sourceUniqueRecords: benchmark.summary.sourceUniqueRecords,
    strictPassOtherAnnotatorRecords: benchmark.summary.strictPassOtherAnnotatorRecords,
    strictPassWithoutPoliteImperativeRecords: benchmark.summary.strictPassWithoutPoliteImperativeRecords,
    strictPassWithDirectRequestRecords: benchmark.summary.strictPassWithDirectRequestRecords,
    positiveEligibleRecords: benchmark.summary.positiveEligibleRecords,
    positiveSelectedRecords: benchmark.summary.positiveSelectedRecords,
    positiveTargetShortfall: benchmark.summary.positiveTargetShortfall,
    negativeCurrentManagedRecords: benchmark.summary.negativeCurrentManagedRecords,
    excludedStrictPassRecordsByReason: benchmark.summary.excludedStrictPassRecordsByReason,
    positiveStatistics: benchmark.summary.positive,
    negativeStatistics: benchmark.summary.negative,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
