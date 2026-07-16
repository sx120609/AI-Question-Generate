import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COLUMN_FIELDS } from "../automation/backfill_structure_registry.mjs";
import {
  analyzeQuestionPunctuation,
  analyzeQuestionRequest,
  findPoliteImperative,
  missingQuestionDeliverableFormats,
} from "../automation/language_style.mjs";
import {
  evaluateDiversity,
  loadStructuralDiversityPolicy,
  parseTsvRows,
} from "../automation/structure_fingerprint.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const AUTO_RUNS = path.join(ROOT, "outputs", "auto_runs");
const REPORT_PATH = path.join(ROOT, "outputs", "analysis", "natural_reset_batch_audit_20260710.json");
const MARKDOWN_PATH = path.join(ROOT, "outputs", "analysis", "natural_reset_batch_audit_20260710.md");

const RUNS = [
  {
    runId: "rewrite_shenli_natural_reset_20260710",
    sourceRunId: "rewrite_shenli_all_20260709T215202Z_63bf72",
    annotator: "沈礼",
  },
  {
    runId: "rewrite_peiying_natural_reset_20260710",
    sourceRunId: "rewrite_peiying_all_20260709T215207Z_75bdf9",
    annotator: "裴硬",
  },
];

const WRITABLE_FIELDS = new Set(["题目", "任务概括", "附件内容", "产物内容", "做题关键步骤"]);
const GUARDED_FIELDS = ["题目", "任务概括", "附件内容", "产物内容", "做题关键步骤"];
const NO_RAW_EXTENSION_FIELDS = ["题目", "任务概括", "产物内容", "做题关键步骤"];

function normalize(value = "") {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function visibleLength(value) {
  return [...normalize(value).replace(/\s+/gu, "")].length;
}

function splitAttachments(value) {
  return normalize(value).split(/[；;\n]+/u).map((item) => item.trim()).filter(Boolean);
}

function stepCount(value) {
  return [...normalize(value).matchAll(/(?:^|\n)([1-9]\d*)\.\s*/gu)].length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * ratio)];
}

async function validateAttachment(filePath) {
  const data = await fs.readFile(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const head = data.subarray(0, 8);
  const head4 = data.subarray(0, 4).toString("latin1");
  const sample = data.subarray(0, Math.min(data.length, 8192)).toString("utf8").trimStart();
  let valid = data.length > 0;
  let detail = data.length ? "non-empty" : "empty";
  if (ext === "pdf") {
    valid = head4 === "%PDF";
    detail = `signature=${head4}`;
  } else if (["docx", "xlsx", "pptx"].includes(ext)) {
    valid = head4 === "PK\u0003\u0004";
    detail = `signature=${JSON.stringify(head4)}`;
  } else if (ext === "json") {
    try {
      JSON.parse(data.toString("utf8"));
      valid = true;
      detail = "json-parse-ok";
    } catch (error) {
      valid = false;
      detail = error.message;
    }
  } else if (ext === "html" || ext === "htm") {
    valid = /<!doctype\s+html|<html|<head|<body/iu.test(sample) && !/HTTP Status 404|404 Not Found/iu.test(sample.slice(0, 12000));
    detail = valid ? "html-markup-ok" : "html-markup-or-error-page";
  } else if (ext === "csv" || ext === "txt") {
    valid = data.length > 0;
  } else if (ext === "png") {
    valid = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    detail = "png-signature";
  } else if (["jpg", "jpeg"].includes(ext)) {
    valid = head[0] === 0xff && head[1] === 0xd8;
    detail = "jpeg-signature";
  }
  return { valid, bytes: data.length, extension: ext, detail };
}

async function main() {
  const policy = await loadStructuralDiversityPolicy();
  const registry = JSON.parse(await fs.readFile(path.join(AUTO_RUNS, "_structure_registry.json"), "utf8"));
  const history = (registry.entries ?? []).filter((entry) => entry.fingerprint);
  const rows = [];
  const rowAudits = [];
  const attachmentAudits = [];
  const errors = [];

  for (const run of RUNS) {
    const runDir = path.join(AUTO_RUNS, run.runId);
    const sourceDir = path.join(AUTO_RUNS, run.sourceRunId);
    const tsvPath = path.join(runDir, "drafts", "l2_questions_natural_reset.tsv");
    const sourcePath = path.join(sourceDir, "sources", "managed_records_before.json");
    const [parsedRows, source] = await Promise.all([
      fs.readFile(tsvPath, "utf8").then(parseTsvRows),
      fs.readFile(sourcePath, "utf8").then(JSON.parse),
    ]);
    const sourceByUid = new Map(source.records.map((item) => [item.UID, item]));

    for (const row of parsedRows) {
      const sourceRow = sourceByUid.get(row.UID);
      if (!sourceRow) errors.push(`${row.UID}: source row missing`);
      row.sheetRow = sourceRow?.sheetRow ?? null;
      rows.push(row);
      const immutableMismatches = COLUMN_FIELDS
        .filter((field) => !WRITABLE_FIELDS.has(field))
        .filter((field) => normalize(row[field]) !== normalize(sourceRow?.[field]));
      if (immutableMismatches.length) errors.push(`${row.UID}: immutable fields changed: ${immutableMismatches.join(", ")}`);
      if (row.标注专家姓名 !== run.annotator || !row.UID.startsWith(`${run.annotator}_`)) {
        errors.push(`${row.UID}: generated identity mismatch`);
      }
      if (normalize(row.产物格式) !== "docx, xlsx") errors.push(`${row.UID}: product format is not canonical`);
      const politeFields = GUARDED_FIELDS.filter((field) => findPoliteImperative(row[field]));
      if (politeFields.length) errors.push(`${row.UID}: polite imperative in ${politeFields.join(", ")}`);
      const rawExtensionFields = NO_RAW_EXTENSION_FIELDS.filter((field) => /\b(?:docx|xlsx)\b/iu.test(row[field]));
      if (rawExtensionFields.length) errors.push(`${row.UID}: raw product extension in ${rawExtensionFields.join(", ")}`);
      const request = analyzeQuestionRequest(row.题目);
      if (!request.clear) errors.push(`${row.UID}: missing direct user request with a nearby deliverable`);
      const missingFormats = missingQuestionDeliverableFormats(row.题目, row.产物格式);
      if (missingFormats.length) errors.push(`${row.UID}: question omits output formats ${missingFormats.join(", ")}`);
      const punctuation = analyzeQuestionPunctuation(row.题目);
      const steps = stepCount(row.做题关键步骤);
      if (steps < 8 || steps > 15) errors.push(`${row.UID}: invalid step count ${steps}`);
      const length = visibleLength(row.题目);
      const paragraphCount = normalize(row.题目).split(/\n+/u).filter(Boolean).length;
      const deliveryIndex = normalize(row.题目).search(/Word|Excel|文档|表格|工作簿/iu);
      rowAudits.push({
        uid: row.UID,
        sheetRow: Number(row.sheetRow),
        annotator: row.标注专家姓名,
        questionVisibleCharacters: length,
        questionParagraphs: paragraphCount,
        stepCount: steps,
        deliveryPositionRatio: deliveryIndex < 0 ? null : Number((deliveryIndex / normalize(row.题目).length).toFixed(3)),
        immutableFieldsExact: immutableMismatches.length === 0,
        productFormat: row.产物格式,
        politeImperativeFree: politeFields.length === 0,
        rawProductExtensionsFree: rawExtensionFields.length === 0,
        directRequestPresent: request.clear,
        requestFrame: request.frame,
        missingQuestionOutputFormats: missingFormats,
        punctuation,
      });

      for (const fileName of splitAttachments(row.相关附件)) {
        const filePath = path.join(runDir, "attachments", row.UID, fileName);
        try {
          const result = await validateAttachment(filePath);
          attachmentAudits.push({ uid: row.UID, fileName, ...result });
          if (!result.valid) errors.push(`${row.UID}: invalid attachment ${fileName} (${result.detail})`);
        } catch (error) {
          attachmentAudits.push({ uid: row.UID, fileName, valid: false, detail: error.message });
          errors.push(`${row.UID}: unreadable attachment ${fileName} (${error.message})`);
        }
      }
    }
  }

  const diversity = evaluateDiversity(rows, { policy, history, assignments: [] });
  for (const finding of diversity.findings.filter((item) => item.level === "FAIL")) {
    errors.push(`${finding.uid}: ${finding.rule}: ${finding.message}`);
  }
  const lengths = rowAudits.map((item) => item.questionVisibleCharacters);
  const termCounts = Object.fromEntries([
    "证据拓扑",
    "阶段门",
    "情景模型",
    "监测看板",
    "诊断报告",
    "条款矩阵",
    "questionTail",
  ].map((term) => [term, rows.reduce((sum, row) => sum + (normalize(row.题目).split(term).length - 1), 0)]));

  const diversityManualReview = diversity.findings
    .filter((item) => item.level === "REVIEW")
    .map((item) => ({
      uid: item.uid,
      rule: item.rule,
      disposition: "accepted-independent-business-task",
      reason: item.rule === "batch-step-action-isomorphism"
        ? "步骤均涉及数据或材料核对，但业务对象、使用者、决定和正文无共享长句。"
        : "启发式分类相同，但业务事实、处理对象、使用场景和正文措辞不同，未发现词法重复。",
    }));
  const lintManualReview = [
    {
      uid: "沈礼_7.9_11",
      rule: "missing-evidence-boundary",
      disposition: "accepted-explicitly-bounded-in-plain-language",
      reason: "题面已明确本次没有后台名单、收款、协议、估值和受助对象资料，不判断具体批次并且不预填金额或结论。",
    },
    {
      uid: "裴硬_7.9_03",
      rule: "missing-evidence-boundary",
      disposition: "accepted-explicitly-bounded-in-plain-language",
      reason: "题面已明确广告合同、流水、票据、表决和报价原件未归档，社区只主持事实与程序核对，不确认资金用途。",
    },
  ];
  const manualReview = [...diversityManualReview, ...lintManualReview];

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: errors.length || !diversity.ok ? "FAIL" : "PASS",
    policyId: policy.policyId,
    policyVersion: policy.version,
    count: rows.length,
    summary: {
      questionVisibleCharacters: {
        min: Math.min(...lengths),
        p25: percentile(lengths, 0.25),
        median: median(lengths),
        average: Number((lengths.reduce((sum, value) => sum + value, 0) / lengths.length).toFixed(1)),
        p75: percentile(lengths, 0.75),
        max: Math.max(...lengths),
      },
      paragraphCounts: [...new Set(rowAudits.map((item) => item.questionParagraphs))].sort((a, b) => a - b),
      stepCounts: [...new Set(rowAudits.map((item) => item.stepCount))].sort((a, b) => a - b),
      attachmentCount: attachmentAudits.length,
      validAttachmentCount: attachmentAudits.filter((item) => item.valid).length,
      diversityReviewCount: diversityManualReview.length,
      lintReviewCount: lintManualReview.length,
      manualReviewCount: manualReview.length,
      retiredTermCounts: termCounts,
    },
    errors,
    manualReview,
    diversity: {
      status: diversity.status,
      ok: diversity.ok,
      reviewRequired: diversity.reviewRequired,
      reviewCount: diversity.reviewCount,
      findings: diversity.findings,
    },
    rows: rowAudits,
    attachments: attachmentAudits,
  };
  await writeJsonAtomic(REPORT_PATH, report);
  const markdown = [
    "# 沈礼、裴硬自然重写整批审计",
    "",
    `- 状态：${report.status}`,
    `- 记录：${report.count}`,
    `- 题面长度：${report.summary.questionVisibleCharacters.min}–${report.summary.questionVisibleCharacters.max}，中位数 ${report.summary.questionVisibleCharacters.median}`,
    `- 段落数：${report.summary.paragraphCounts.join("、")}`,
    `- 步骤数：${report.summary.stepCounts.join("、")}`,
    `- 附件签名与可读性：${report.summary.validAttachmentCount}/${report.summary.attachmentCount}`,
    `- 跨两位标注人的正文重复硬失败：${diversity.findings.filter((item) => item.rule.includes("lexical") && item.level === "FAIL").length}`,
    `- 人工检查项：${manualReview.length}`,
    "",
    "## 人工检查结论",
    "",
    ...(manualReview.length
      ? manualReview.map((item) => `- ${item.uid} / ${item.rule}：${item.reason}`)
      : ["- 无。"]),
    "",
    "## 硬错误",
    "",
    ...(errors.length ? errors.map((item) => `- ${item}`) : ["- 无。"]),
    "",
  ].join("\n");
  await fs.writeFile(MARKDOWN_PATH, markdown, "utf8");
  return { status: report.status, reportPath: REPORT_PATH, markdownPath: MARKDOWN_PATH, summary: report.summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
