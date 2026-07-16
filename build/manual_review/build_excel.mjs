import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const inputPath = path.join(root, "outputs", "l2_questions.tsv");
const outputDir = path.join(root, "outputs", "manual_review");
const previewDir = path.join(outputDir, "xlsx_previews");

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function splitTsv(text) {
  return text
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function shortQuestion(text) {
  if (text.includes("睡眠打卡 App") || text.includes("睡眠健康")) return "睡眠健康App上架预审";
  if (text.includes("丹佛") || text.includes("EV 充电桩")) return "酒店EV充电桩预审";
  return text.slice(0, 18);
}

function urls(text) {
  return [...text.matchAll(/https?:\/\/[^，；\s]+/g)].map((m) => m[0]);
}

function attachmentRows(headers, rows) {
  const qIdx = headers.indexOf("题目");
  const namesIdx = headers.indexOf("相关附件");
  const fmtIdx = headers.indexOf("附件格式");
  const contentIdx = headers.indexOf("附件内容");
  const attachmentFiles = {
    "睡眠健康App上架预审": [
      "Apple_App_Store审核指南_应用安全隐私与法律要求.html",
      "Apple_App_Store产品页元数据创建说明.html",
      "Apple_App隐私详情与数据类型说明.html",
      "Google_Play数据安全表单填写说明.html",
      "Google_Play健康应用类别与声明要求.html",
      "FTC_背书与推荐广告指南_2023.pdf",
    ],
    "酒店EV充电桩预审": [
      "AFDC_替代燃料站数据下载说明.html",
      "AFDC_替代燃料站API说明_All_Stations.html",
      "AFDC_科罗拉多EV充电站数据_2026-07-08.csv",
      "Joint_Office_公共EV充电站选址检查清单.pdf",
      "IRS_Form8911说明_替代燃料车辆加注设施抵免_2025版.pdf",
      "IRS_企业替代燃料车辆加注设施抵免说明_2026-06.pdf",
    ],
  };
  const folderByQuestion = {
    "睡眠健康App上架预审": "睡眠健康App上架前数据安全与素材合规预审",
    "酒店EV充电桩预审": "科罗拉多酒店停车场EV充电桩选址与税务预审",
  };
  const out = [["题目", "附件序号", "附件名称", "附件格式", "URL", "本地附件文件", "用途与边界说明"]];
  for (const row of rows) {
    const q = shortQuestion(row[qIdx] || "");
    const names = (row[namesIdx] || "").split("；").filter(Boolean);
    const contents = (row[contentIdx] || "").split("；").filter(Boolean);
    names.forEach((name, idx) => {
      const content = contents[idx] || contents.find((c) => c.includes(name.replace(/[《》]/g, ""))) || "";
      out.push([
        q,
        idx + 1,
        name,
        row[fmtIdx] || "",
        urls(content).join("\n"),
        path.join(root, "outputs", "attachments", folderByQuestion[q], attachmentFiles[q][idx]),
        content,
      ]);
    });
  }
  return out;
}

function gateRows() {
  return [
    ["校验项", "睡眠健康App上架预审", "酒店EV充电桩预审"],
    ["飞书列完整性", "通过：15列，UID留空", "通过：15列，UID留空"],
    ["L2难度", "通过：6个附件，12h，10步", "通过：6个附件，14h，11步"],
    ["主决策", "通过：是否进入提审前改稿", "通过：是否进入承包商现场踏勘"],
    ["附件质量", "通过：Apple、Google Play、FTC 官方资料组合", "通过：AFDC CSV、Joint Office 和 IRS 资料组合"],
    ["产物真实性", "通过：Word/飞书文档 + Excel/飞书表格 + 改稿清单", "通过：Excel/飞书表格 + Word/飞书文档 + 踏勘邮件"],
    ["去AI风格", "通过：真实产品/投放/法务协同场景", "通过：真实酒店业主/承包商/会计师协同场景"],
    ["证据边界", "通过：医生背书、临床效果、审核结论写为需确认", "通过：报价、电价、抵免金额、实时状态写为待确认"],
    ["最终结论", "放行", "放行"],
  ];
}

function setColWidths(sheet, widths) {
  widths.forEach((w, i) => {
    sheet.getRange(`${colLetter(i + 1)}:${colLetter(i + 1)}`).format.columnWidth = w;
  });
}

function styleSheet(sheet, rows, cols, opts = {}) {
  const lastCol = colLetter(cols);
  const all = sheet.getRange(`A1:${lastCol}${rows}`);
  all.format = {
    font: { name: "Microsoft YaHei", size: 10, color: "#111827" },
    wrapText: true,
    verticalAlignment: "top",
  };
  all.format.borders = { preset: "all", style: "thin", color: "#E5E7EB" };
  const header = sheet.getRange(`A1:${lastCol}1`);
  header.format = {
    fill: opts.headerFill || "#1F4D78",
    font: { name: "Microsoft YaHei", size: 10, bold: true, color: "#FFFFFF" },
    wrapText: true,
    horizontalAlignment: "center",
    verticalAlignment: "middle",
  };
  sheet.getRange("1:1").format.rowHeight = 30;
  for (let r = 2; r <= rows; r++) sheet.getRange(`${r}:${r}`).format.rowHeight = opts.rowHeight || 96;
  sheet.freezePanes.freezeRows(1);
  sheet.showGridLines = false;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });

  const matrix = splitTsv(await fs.readFile(inputPath, "utf8"));
  const headers = matrix[0];
  const dataRows = matrix.slice(1);

  const workbook = Workbook.create();

  const fields = workbook.worksheets.add("飞书字段");
  fields.getRangeByIndexes(0, 0, matrix.length, headers.length).values = matrix;
  styleSheet(fields, matrix.length, headers.length, { rowHeight: 170 });
  setColWidths(fields, [7, 54, 12, 20, 24, 28, 36, 42, 12, 12, 24, 72, 26, 58, 70]);

  const sources = workbook.worksheets.add("附件来源");
  const sourceRows = attachmentRows(headers, dataRows);
  sources.getRangeByIndexes(0, 0, sourceRows.length, sourceRows[0].length).values = sourceRows;
  styleSheet(sources, sourceRows.length, sourceRows[0].length, { rowHeight: 118, headerFill: "#0F766E" });
  setColWidths(sources, [24, 10, 36, 22, 54, 60, 78]);

  const gates = workbook.worksheets.add("放行校验");
  const checks = gateRows();
  gates.getRangeByIndexes(0, 0, checks.length, checks[0].length).values = checks;
  styleSheet(gates, checks.length, checks[0].length, { rowHeight: 48, headerFill: "#7C3AED" });
  setColWidths(gates, [24, 54, 54]);

  const overview = await workbook.inspect({
    kind: "sheet,region",
    maxChars: 3000,
    tableMaxRows: 4,
    tableMaxCols: 6,
  });
  console.log(overview.ndjson);

  const errors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 100 },
    summary: "final formula error scan",
  });
  console.log(errors.ndjson);

  for (const sheetName of ["飞书字段", "附件来源", "放行校验"]) {
    const preview = await workbook.render({ sheetName, autoCrop: "all", scale: 1, format: "png" });
    await fs.writeFile(
      path.join(previewDir, `${sheetName}.png`),
      new Uint8Array(await preview.arrayBuffer()),
    );
  }

  const xlsx = await SpreadsheetFile.exportXlsx(workbook);
  const outPath = path.join(outputDir, "L2题目人工审阅表.xlsx");
  await xlsx.save(outPath);
  console.log(`SAVED ${outPath}`);
}

await main();
