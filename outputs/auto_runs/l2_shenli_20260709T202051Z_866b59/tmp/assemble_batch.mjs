import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeishuFillPlan } from "../../../../build/manual_review/feishu_fill_plan_lib.mjs";
import { canonicalizeProductFormat } from "../../../../build/automation/product_format.mjs";
import { updateRunStatus } from "../../../../build/automation/run_context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../../..");
const runId = "l2_shenli_20260709T202051Z_866b59";
const runRoot = path.join(root, "outputs", "auto_runs", runId);
const startRow = 178;

const inputs = [
  { proposal: "01_finance_proposal.json", attachmentDir: "01_finance" },
  { proposal: "02_logistics_proposal.json", attachmentDir: "02_logistics" },
  { proposal: "03_lab_proposal.json", attachmentDir: "03_lab" },
];

const headers = [
  "UID",
  "题目",
  "任务类型",
  "一级目录",
  "二级目录",
  "三级目录",
  "任务概括",
  "相关附件",
  "标注专家工作年限",
  "人类完成时间",
  "附件格式",
  "附件内容",
  "产物格式",
  "产物内容",
  "做题关键步骤",
  "标注专家姓名",
];

const columnMap = [
  ["UID", "A"],
  ["题目", "B"],
  ["任务类型", "C"],
  ["一级目录", "D"],
  ["二级目录", "E"],
  ["三级目录", "F"],
  ["任务概括", "G"],
  ["标注专家工作年限", "H"],
  ["人类完成时间", "I"],
  ["相关附件", "J"],
  ["附件格式", "K"],
  ["附件内容", "L"],
  ["产物格式", "M"],
  ["产物内容", "N"],
  ["做题关键步骤", "O"],
  ["标注专家姓名", "P"],
].map(([field, column]) => ({ field, column }));

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing ${label}`);
  return text;
}

function buildAttachmentContent(proposal) {
  const sourceItems = proposal.逐项来源与摘录边界 ?? proposal.附件 ?? proposal.attachments;
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) return String(proposal.附件内容 ?? "").trim();
  const numerals = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const items = sourceItems.map((item, index) => {
    const fileName = item.文件名 ?? item.附件文件名 ?? `附件${numerals[index]}`;
    const title = item.标题 ?? item.文件信息 ?? fileName;
    const source = item.来源URL ?? item.url ?? "";
    const publisher = item.官方机构 ?? item.发布主体 ?? "";
    const purpose = item.用途 ?? "";
    const excerptValue = item.摘录口径 ?? item.可验证摘录 ?? "";
    const excerpt = Array.isArray(excerptValue)
      ? excerptValue.map((entry) => entry.原文 ?? entry).join("；")
      : excerptValue;
    const boundary = item.边界 ?? "";
    return `附件${numerals[index]}：《${title}》（文件：${fileName}），属于官方中文资料，用于核对：${purpose} 来源：${source}。中文摘要：${excerpt} 证据边界：${boundary}`;
  });
  const totalBoundary = proposal.证据总边界
    ? `\n总边界：${proposal.证据总边界}`
    : proposal.附件内容
      ? `\n总边界：${proposal.附件内容}`
      : "";
  return `${items.join("\n")}${totalBoundary}`;
}

function normalizeProposal(proposal) {
  const uid = requireText(proposal.UID, "UID");
  const sheetRow = Number(proposal.sheetRow ?? proposal.拟写飞书行);
  const category = proposal.分类 ?? {};
  const annotator = proposal.标注专家 ?? {};
  const steps = Array.isArray(proposal.做题关键步骤)
    ? proposal.做题关键步骤
        .map((step, index) => (/^\s*\d+\.\s+/.test(String(step)) ? String(step).trim() : `${index + 1}. ${String(step).trim()}`))
        .join("\n")
    : requireText(proposal.做题关键步骤, `${uid} 做题关键步骤`);

  const row = {
    UID: uid,
    题目: requireText(proposal.题目, `${uid} 题目`),
    任务类型: requireText(proposal.任务类型, `${uid} 任务类型`),
    一级目录: requireText(proposal.一级目录 ?? category.一级目录, `${uid} 一级目录`),
    二级目录: requireText(proposal.二级目录 ?? category.二级目录, `${uid} 二级目录`),
    三级目录: requireText(proposal.三级目录 ?? category.三级目录, `${uid} 三级目录`),
    任务概括: requireText(proposal.任务概括 ?? proposal.概括, `${uid} 任务概括`),
    相关附件: requireText(proposal.相关附件, `${uid} 相关附件`),
    标注专家工作年限: requireText(
      proposal.标注专家工作年限 ?? annotator.工作年限,
      `${uid} 标注专家工作年限`,
    ),
    人类完成时间: requireText(
      proposal.人类完成时间 ?? annotator.人类完成时间,
      `${uid} 人类完成时间`,
    ),
    附件格式: requireText(proposal.附件格式, `${uid} 附件格式`),
    附件内容: requireText(buildAttachmentContent(proposal), `${uid} 附件内容`),
    产物格式: canonicalizeProductFormat(requireText(proposal.产物格式, `${uid} 产物格式`)),
    产物内容: requireText(proposal.产物内容, `${uid} 产物内容`),
    做题关键步骤: steps,
    标注专家姓名: requireText(proposal.标注专家姓名 ?? annotator.姓名, `${uid} 标注专家姓名`),
    sheetRow,
  };

  if (!Number.isInteger(sheetRow)) throw new Error(`Invalid sheet row for ${uid}: ${sheetRow}`);
  if (row.产物格式 !== "docx, xlsx") throw new Error(`Unexpected product format for ${uid}: ${row.产物格式}`);
  if (row.标注专家姓名 !== "沈礼") throw new Error(`Unexpected annotator for ${uid}: ${row.标注专家姓名}`);
  return row;
}

function splitAttachmentNames(value) {
  return String(value)
    .split(/[；;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function detectFormat(buffer, fileName) {
  const ext = path.extname(fileName).toLowerCase().slice(1);
  if (buffer.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return ["docx", "xlsx", "pptx"].includes(ext) ? ext : "zip";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192)).toString("utf8").trimStart();
  if (/^<!doctype html/i.test(sample) || /^<html/i.test(sample) || /<title[\s>]/i.test(sample)) return "html";
  if ((sample.startsWith("{") || sample.startsWith("[")) && ["json", "geojson"].includes(ext)) return "json";
  return ext || "unknown";
}

function escapeTsvCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, " ");
}

function normalizeTopic(proposal, row) {
  const source = proposal.topic ?? {};
  const categories = Array.isArray(source.categories) ? source.categories : [];
  const productSummary = row.产物内容.replace(/\s+/g, " ");
  const attachmentSummary = row.附件内容.replace(/\s+/g, " ");
  return {
    topicId: row.UID,
    title: source.title ?? row.三级目录,
    primaryCategory: source.primaryCategory ?? categories[0] ?? row.一级目录,
    secondaryCategory: source.secondaryCategory ?? categories[1] ?? row.二级目录,
    tertiaryCategory: source.tertiaryCategory ?? categories[2] ?? row.三级目录,
    businessScenario:
      source.businessScenario ??
      (row.UID.endsWith("_06")
        ? "分析测试中心收到LC-20A液相色谱系统，但项目合同、装箱、安装调试和性能测试证据尚未归档，需要在开箱、验收及尾款前做技术预审。"
        : row.题目.slice(0, 180)),
    mainDecision: requireText(source.mainDecision, `${row.UID} topic.mainDecision`),
    role: source.role ?? (row.UID.endsWith("_06") ? "科研仪器采购与技术验收专员" : "专业分析人员"),
    artifactFormats: "docx, xlsx",
    artifactSummary: source.artifactSummary ?? productSummary.slice(0, 260),
    attachmentSummary: source.attachmentSummary ?? attachmentSummary.slice(0, 260),
    keywords: Array.isArray(source.keywords) ? source.keywords : [],
    runId,
    status: "proposed",
    generatedAnnotator: "沈礼",
    managedBySystem: true,
  };
}

function sourcesForProposal(proposal) {
  return proposal.逐项来源与摘录边界 ?? proposal.附件 ?? proposal.attachments ?? [];
}

async function main() {
  const proposals = await Promise.all(
    inputs.map(async (input) => ({
      ...input,
      data: JSON.parse(
        await fs.readFile(path.join(runRoot, "sources", input.proposal), "utf8"),
      ),
    })),
  );
  const rows = proposals.map((item) => normalizeProposal(item.data));

  for (let index = 0; index < rows.length; index += 1) {
    const expectedRow = startRow + index;
    const expectedUid = `沈礼_7.10_0${index + 4}`;
    if (rows[index].sheetRow !== expectedRow) {
      throw new Error(`Row mismatch for ${rows[index].UID}: expected ${expectedRow}, got ${rows[index].sheetRow}`);
    }
    if (rows[index].UID !== expectedUid) {
      throw new Error(`UID mismatch at row ${expectedRow}: expected ${expectedUid}, got ${rows[index].UID}`);
    }
  }

  const attachmentManifest = [];
  for (let index = 0; index < proposals.length; index += 1) {
    const row = rows[index];
    const attachmentDir = path.join(runRoot, "attachments", proposals[index].attachmentDir);
    const names = splitAttachmentNames(row.相关附件);
    if (names.length < 4 || names.length > 7) {
      throw new Error(`Unexpected attachment count for ${row.UID}: ${names.length}`);
    }
    for (const fileName of names) {
      const filePath = path.join(attachmentDir, fileName);
      const buffer = await fs.readFile(filePath);
      const detectedFormat = detectFormat(buffer, fileName);
      const expectedFormat = path.extname(fileName).toLowerCase().slice(1);
      if (buffer.length < 1000) throw new Error(`Attachment too small: ${filePath}`);
      if (detectedFormat !== expectedFormat) {
        throw new Error(`Format mismatch for ${fileName}: expected ${expectedFormat}, detected ${detectedFormat}`);
      }
      attachmentManifest.push({
        uid: row.UID,
        sheetRow: row.sheetRow,
        fileName,
        path: filePath,
        relativePath: path.relative(runRoot, filePath).replace(/\\/g, "/"),
        bytes: buffer.length,
        expectedFormat,
        detectedFormat,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
        validation: "PASS",
      });
    }
  }

  const tsvRows = rows.map((row) => headers.map((field) => escapeTsvCell(row[field])).join("\t"));
  const tsv = `${[headers.join("\t"), ...tsvRows].join("\n")}\n`;
  const tsvPath = path.join(runRoot, "drafts", "l2_questions_178_180_shenli_710.tsv");
  const planPath = path.join(runRoot, "feishu", "feishu_fill_plan_178_180.json");
  const manifestPath = path.join(runRoot, "attachment_manifest.json");
  const sourceCardsPath = path.join(runRoot, "sources", "source_cards_178_180.json");
  const topicsPath = path.join(runRoot, "sources", "topics_178_180.json");

  await Promise.all([
    fs.mkdir(path.dirname(tsvPath), { recursive: true }),
    fs.mkdir(path.dirname(planPath), { recursive: true }),
  ]);
  await fs.writeFile(tsvPath, tsv, "utf8");
  const plan = buildFeishuFillPlan({
    text: tsv,
    sourcePath: tsvPath,
    startRow,
    count: rows.length,
    columnMap,
  });
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({ runId, startRow, endRow: 180, rowCount: rows.length, attachmentCount: attachmentManifest.length, attachmentManifest }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    sourceCardsPath,
    `${JSON.stringify({ runId, generatedAt: new Date().toISOString(), cards: proposals.map((item, index) => ({ uid: rows[index].UID, sheetRow: rows[index].sheetRow, sources: sourcesForProposal(item.data) })) }, null, 2)}\n`,
    "utf8",
  );
  const topics = proposals.map((item, index) => normalizeTopic(item.data, rows[index]));
  await fs.writeFile(topicsPath, `${JSON.stringify(topics, null, 2)}\n`, "utf8");

  await updateRunStatus(runRoot, "drafting", {
    rows: rows.map((row) => row.sheetRow),
    uids: rows.map((row) => row.UID),
    completedUids: rows.map((row) => row.UID),
    attachmentCount: attachmentManifest.length,
    draftPath: tsvPath,
    fillPlanPath: planPath,
    topicsPath,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        rows: rows.map((row) => ({ sheetRow: row.sheetRow, uid: row.UID, productFormat: row.产物格式 })),
        attachmentCount: attachmentManifest.length,
        tsvPath,
        planPath,
        manifestPath,
        sourceCardsPath,
        topicsPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
