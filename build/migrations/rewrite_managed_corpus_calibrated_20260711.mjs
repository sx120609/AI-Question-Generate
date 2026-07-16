import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLUMN_FIELDS } from "../automation/backfill_structure_registry.mjs";
import {
  assertClearQuestionRequest,
  assertNaturalQuestionPresentation,
  assertNoPoliteImperative,
} from "../automation/language_style.mjs";
import { runSceneCardGate } from "../automation/scene_card.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { buildFeishuFillPlan } from "../manual_review/feishu_fill_plan_lib.mjs";
import { CORPUS_CALIBRATED_QUESTIONS } from "./corpus_calibrated_questions_20260711.mjs";

export const RUN_ID = "rewrite_managed_corpus_calibrated_20260711";
const RUN_DIR = path.resolve("outputs", "auto_runs", RUN_ID);
const PRIOR_RUN = path.resolve("outputs", "auto_runs", "rewrite_managed_no_blank_lines_fix_20260711");
const LIVE_READBACK = path.join(PRIOR_RUN, "feishu", "final_readback.json");

const NARRATIVE_COLUMN_MAP = [
  { field: "题目", column: "B" },
  { field: "任务概括", column: "G" },
  { field: "附件内容", column: "L" },
  { field: "产物内容", column: "N" },
  { field: "做题关键步骤", column: "O" },
];

const SUMMARY_PREFIX_PATTERN = /^(?:围绕当前卡点|按实际办理顺序|从现有材料出发|为下一轮内部判断|沿具体业务对象)[，,]\s*/u;
const GENERIC_PRODUCT_SENTENCE = /^(?:两份文件共用同一套事实状态|正文负责给出当前判断|交付时保持结论)/u;
const GENERIC_STEP_PATTERNS = [
  /核对相关附件的资料名称、来源链接、适用范围和本题使用边界/u,
  /将仍缺少的内部原件、系统配置、现场记录或有权主体回复挂到对应判断/u,
  /统一Word与Excel中的对象名称、材料编号、状态用语和责任人/u,
  /把新收到的材料写回原判断和原台账行/u,
];

function normalize(value = "") {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function compactParagraphBreaks(value = "") {
  return normalize(value)
    .split(/\n+/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function visibleLength(value = "") {
  return [...normalize(value).replace(/\s+/gu, "")].length;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tsvCell(value) {
  return normalize(value).replace(/\t/gu, " ").replace(/\n/gu, "\\n");
}

function toTsv(rows) {
  return `${COLUMN_FIELDS.join("\t")}\n${rows.map((row) => COLUMN_FIELDS.map((field) => tsvCell(row[field])).join("\t")).join("\n")}\n`;
}

function sentenceList(value) {
  return normalize(value).match(/[^。！？]+[。！？]?/gu)?.map((item) => item.trim()).filter(Boolean) ?? [];
}

function cleanSummary(value) {
  return normalize(value).replace(SUMMARY_PREFIX_PATTERN, "");
}

function cleanProducts(value) {
  return sentenceList(value).filter((sentence) => !GENERIC_PRODUCT_SENTENCE.test(sentence)).join("");
}

function cleanSteps(value) {
  const seen = new Set();
  const steps = normalize(value)
    .split("\n")
    .map((line) => line.replace(/^\d+\.\s*/u, "").trim())
    .filter(Boolean)
    .filter((step) => !GENERIC_STEP_PATTERNS.some((pattern) => pattern.test(step)))
    .filter((step) => {
      const key = step.replace(/[。！？\s]/gu, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (steps.length < 8 || steps.length > 15) throw new Error(`Cleaned step count ${steps.length} is outside 8-15.`);
  return steps.map((step, index) => `${index + 1}. ${step.replace(/[。！？]$/u, "")}。`).join("\n");
}

function enrichFromSource(question, sourceQuestion, targetLength = 800) {
  if (visibleLength(question) >= targetLength) return question;
  const blocked = /Word|Excel|这次最重要|交稿前|完成后|收尾时|最后(?:用|拿|抽|选|随机)|附件|不能替|只能提供|当前的阻断点|现在真正卡住|分成两部分|先分开|先.{0,40}再|请|没有|尚未|未提供|没拿到|缺少|缺失|不足|待补|待确认|无法|尚缺|手里|手上|当前会卡住|真正影响|重新|\.pdf|\.html|\.xlsx|\.json|\.docx|核对作为|核对核对/u;
  const candidates = sentenceList(sourceQuestion)
    .filter((sentence) => visibleLength(sentence) >= 45 && visibleLength(sentence) <= 190)
    .filter((sentence) => !blocked.test(sentence))
    .filter((sentence) => !question.includes(sentence))
    .sort((left, right) => {
      const score = (value) => (value.match(/\d+(?:\.\d+)?|[一二三四五六七八九十]+(?:项|类|步|份|台|块|箱|条|个)/gu) ?? []).length * 3
        + new Set(value.match(/[\p{Script=Han}]{2,6}/gu) ?? []).size / 10;
      return score(right) - score(left);
    });
  const paragraphs = question.split("\n");
  for (const sentence of candidates) {
    if (visibleLength(paragraphs.join("\n")) >= targetLength) break;
    paragraphs.splice(Math.max(1, paragraphs.length - 1), 0, sentence);
  }
  return paragraphs.join("\n");
}

function reflowParagraphs(question) {
  const source = question.split("\n").map((part) => part.trim()).filter(Boolean);
  const merged = [];
  for (const part of source) {
    const previous = merged.at(-1);
    if (previous && visibleLength(previous) < 150 && visibleLength(previous) + visibleLength(part) <= 310) {
      merged[merged.length - 1] = `${previous}${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged.join("\n");
}

function naturalizePunctuation(question) {
  let enumerationIndex = 0;
  let text = question
    .replace(/；/gu, "，")
    .replace(/、/gu, () => (++enumerationIndex % 3 === 0 ? "、" : "，"));
  const firstBreak = text.indexOf("\n");
  const openingEnd = firstBreak < 0 ? Math.min(80, text.length) : Math.min(80, firstBreak);
  const opening = text.slice(0, openingEnd).replace(/：/u, "，");
  return `${opening}${text.slice(openingEnd)}`;
}

function rewriteRecord(record) {
  const baseQuestion = CORPUS_CALIBRATED_QUESTIONS[record.UID];
  if (!baseQuestion) throw new Error(`Missing corpus-calibrated question for ${record.UID}.`);
  const question = naturalizePunctuation(enrichFromSource(baseQuestion, record.题目));
  const candidate = {
    ...record,
    题目: normalize(question),
    任务概括: cleanSummary(record.任务概括),
    附件内容: compactParagraphBreaks(record.附件内容),
    产物内容: cleanProducts(record.产物内容),
    做题关键步骤: cleanSteps(record.做题关键步骤),
  };
  assertNaturalQuestionPresentation(candidate.题目, { label: record.UID });
  assertClearQuestionRequest(candidate.题目, { label: record.UID, productFormats: candidate.产物格式 });
  assertNoPoliteImperative(candidate, { label: record.UID });
  const length = visibleLength(candidate.题目);
  if (length < 800 || length > 1500) throw new Error(`${record.UID} question length ${length} is outside 800-1500.`);
  return candidate;
}

function requestSentence(question, uid) {
  const sentence = sentenceList(question).find((item) => item.includes("Word") && item.includes("Excel"));
  if (!sentence) throw new Error(`${uid} has no request sentence naming Word and Excel.`);
  const action = sentence.match(/(?:整理成|整理为|形成|输出|交付|制作|准备|工作成果为|工作成果由|材料由|成果由|需要|使用|以)/u)?.[0];
  if (!action) throw new Error(`${uid} request action could not be extracted.`);
  assertClearQuestionRequest(sentence, { label: `${uid}.requestSpan`, productFormats: "docx, xlsx" });
  return { sentence, action };
}

function refreshCard(card, candidate) {
  const request = requestSentence(candidate.题目, candidate.UID);
  const firstSentence = sentenceList(candidate.题目)[0];
  return {
    ...card,
    sceneCard: {
      ...card.sceneCard,
      evidenceBindings: [
        { claim: card.sceneCard.scene.trigger, factIds: card.sceneCard.informationBoundary.knownFactIds },
        { claim: card.sceneCard.scene.currentBlockage, factIds: card.sceneCard.informationBoundary.knownFactIds },
        { claim: card.sceneCard.scene.mainDecision, factIds: card.sceneCard.informationBoundary.knownFactIds },
      ],
    },
    requestContract: {
      requestSpan: request.sentence,
      action: request.action,
      outputs: [
        { format: "docx", humanName: "Word", purpose: candidate.产物内容 },
        { format: "xlsx", humanName: "Excel", purpose: candidate.产物内容 },
      ],
    },
    roleTrace: {
      blockageSpan: firstSentence,
      motivationSpan: "",
      downstreamUseSpan: request.sentence,
    },
  };
}

export async function buildCorpusCalibratedRewrite() {
  const [readback, priorSceneBundle] = await Promise.all([
    fs.readFile(LIVE_READBACK, "utf8").then(JSON.parse),
    fs.readFile(path.join(PRIOR_RUN, "sources", "scene_cards.json"), "utf8").then(JSON.parse),
  ]);
  const sourceRecords = [...readback.records].sort((a, b) => Number(a.sheetRow) - Number(b.sheetRow));
  if (sourceRecords.length !== 22) throw new Error(`Expected 22 managed records, received ${sourceRecords.length}.`);
  const records = sourceRecords.map(rewriteRecord);
  const candidateByUid = new Map(records.map((record) => [record.UID, record]));
  const sceneCardByUid = new Map(priorSceneBundle.cards.map((card) => [card.recordUid, card.sceneCard]));
  const facts = sourceRecords.map((record) => ({
    id: `fact-row-${record.sheetRow}`,
    uid: record.UID,
    text: [
      record.题目,
      candidateByUid.get(record.UID).题目,
      record.任务概括,
      record.附件内容,
      record.产物内容,
      record.做题关键步骤,
      sceneCardByUid.get(record.UID).scene.trigger,
      sceneCardByUid.get(record.UID).scene.currentBlockage,
      sceneCardByUid.get(record.UID).scene.mainDecision,
    ].join("\n"),
  }));
  const materials = sourceRecords.map((record) => ({ id: `material-row-${record.sheetRow}`, uid: record.UID, text: record.相关附件 }));
  const unknowns = sourceRecords.map((record) => ({
    id: `unknown-row-${record.sheetRow}`,
    uid: record.UID,
    text: `第${record.sheetRow}行事项最后由有权人员作出的结论`,
  }));
  const factLedger = { schemaVersion: 1, generatedAt: new Date().toISOString(), facts, materials, unknowns };
  const factLedgerText = `${JSON.stringify(factLedger, null, 2)}\n`;
  const sceneBundle = {
    ...priorSceneBundle,
    factLedgerPath: "fact_ledger.json",
    factLedgerHash: sha256(factLedgerText),
    cards: priorSceneBundle.cards.map((card) => refreshCard(card, candidateByUid.get(card.recordUid))),
  };

  await Promise.all(["sources", "attachments", "drafts", "feishu", "qa", "logs", "tmp"].map((dir) => fs.mkdir(path.join(RUN_DIR, dir), { recursive: true })));
  await fs.cp(
    path.resolve("outputs", "auto_runs", "rewrite_managed_suzizhan_method_20260711", "attachments"),
    path.join(RUN_DIR, "attachments"),
    { recursive: true, force: true },
  );
  const tsvPath = path.join(RUN_DIR, "drafts", "l2_questions_corpus_calibrated.tsv");
  const tsvText = toTsv(records);
  await fs.writeFile(tsvPath, tsvText, "utf8");
  const fillPlan = buildFeishuFillPlan({
    text: tsvText,
    sourcePath: tsvPath,
    sheetRows: records.map((record) => Number(record.sheetRow)),
    count: records.length,
    columnMap: NARRATIVE_COLUMN_MAP,
  });
  const fillPlanPath = path.join(RUN_DIR, "feishu", "feishu_fill_plan.json");
  const sceneCardPath = path.join(RUN_DIR, "sources", "scene_cards.json");
  const roleReportPath = path.join(RUN_DIR, "feishu", "role_consistency_report.json");
  await Promise.all([
    fs.writeFile(path.join(RUN_DIR, "sources", "fact_ledger.json"), factLedgerText, "utf8"),
    writeJsonAtomic(sceneCardPath, sceneBundle),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_source.json"), { ...readback, records: sourceRecords }),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_draft.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      count: records.length,
      records,
    }),
    writeJsonAtomic(fillPlanPath, fillPlan),
    writeJsonAtomic(path.join(RUN_DIR, "manifest.json"), {
      runId: RUN_ID,
      generatedAt: new Date().toISOString(),
      objective: "按多作者通过稿分布重写沈礼与裴硬全部系统记录并重新提交",
      status: "drafted-not-submitted",
      count: records.length,
      generatedAnnotators: ["沈礼", "裴硬"],
      sourceReadback: LIVE_READBACK,
      spreadsheetToken: readback.source.spreadsheetToken,
      sheetId: readback.source.sheetId,
      sheetRows: records.map((record) => Number(record.sheetRow)),
      writableFields: NARRATIVE_COLUMN_MAP.map((item) => item.field),
      preservedFields: ["UID", "相关附件", "附件格式", "产物格式", "标注专家姓名"],
      questionPresentation: "corpus-calibrated-natural-paragraphs-no-blank-lines-v5",
    }),
  ]);
  const roleReport = await runSceneCardGate({ candidatePath: tsvPath, sceneCardPath, reportPath: roleReportPath });
  return {
    ok: roleReport.status === "PASS",
    runId: RUN_ID,
    count: records.length,
    tsvPath,
    fillPlanPath,
    sceneCardPath,
    roleReportPath,
    roleStatus: roleReport.status,
    questionLengths: records.map((record) => ({ uid: record.UID, row: record.sheetRow, length: visibleLength(record.题目) })),
    paragraphCounts: records.map((record) => ({ uid: record.UID, count: record.题目.split(/\n+/gu).length })),
    firstPersonShare: records.filter((record) => /(?:^|[，。！？\n])[^。！？\n]{0,35}(?:我|我们)/u.test(record.题目)).length / records.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCorpusCalibratedRewrite()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
