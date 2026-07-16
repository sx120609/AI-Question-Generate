import fs from "node:fs/promises";
import path from "node:path";
import {
  assertClearQuestionRequest,
  assertNaturalQuestionPresentation,
} from "../automation/language_style.mjs";
import { canonicalizeProductFormat } from "../automation/product_format.mjs";

export const DEFAULT_FEISHU_COLUMN_MAP = [
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
].map(([field, column]) => ({ field, column }));

export const LEGACY_PAYLOAD_FIELDS = [
  "标注专家工作年限",
  "人类完成时间",
  "相关附件",
  "附件格式",
  "附件内容",
  "产物格式",
  "产物内容",
  "做题关键步骤",
];

export function parseTsv(text) {
  const rows = text.trimEnd().split(/\r?\n/).map((line) => line.split("\t"));
  const header = rows[0] ?? [];
  if (!header.length) throw new Error("TSV is empty.");
  return { header, rows: rows.slice(1) };
}

export function decodeFeishuCell(value) {
  return String(value ?? "").replace(/\\n/g, "\n");
}

export function clipboardCell(value) {
  const decoded = decodeFeishuCell(value);
  if (!/[\t\r\n"]/.test(decoded)) return decoded;
  return `"${decoded.replace(/"/g, '""')}"`;
}

export function buildFeishuFillPlan({
  text,
  sourcePath,
  startRow,
  sheetRows = [],
  count,
  columnMap = DEFAULT_FEISHU_COLUMN_MAP,
  includeEmpty = false,
}) {
  if ((!Array.isArray(sheetRows) || !sheetRows.length) && (!Number.isInteger(startRow) || startRow < 1)) {
    throw new Error(`Invalid --start-row: ${startRow}`);
  }
  if (sheetRows.length && sheetRows.some((row) => !Number.isInteger(row) || row < 1)) {
    throw new Error("sheetRows must contain positive integers.");
  }

  const { header, rows } = parseTsv(text);
  const col = Object.fromEntries(header.map((name, idx) => [name, idx]));
  const missing = columnMap.map((item) => item.field).filter((field) => !(field in col));
  if (missing.length) {
    throw new Error(`TSV missing required columns for Feishu fill: ${missing.join(", ")}`);
  }

  const selectedRows = rows.slice(0, count ?? rows.length);
  if (sheetRows.length && sheetRows.length !== selectedRows.length) {
    throw new Error(`sheetRows length ${sheetRows.length} does not match selected TSV rows ${selectedRows.length}.`);
  }
  const planRows = selectedRows.map((row, index) => {
    const sheetRow = sheetRows[index] ?? startRow + index;
    const updates = columnMap
      .map(({ field, column }) => {
        const decodedValue = decodeFeishuCell(row[col[field]]);
        const value = field === "产物格式"
          ? canonicalizeProductFormat(decodedValue)
          : decodedValue;
        if (field === "题目") {
          assertNaturalQuestionPresentation(value, { label: `sheet row ${sheetRow}` });
        }
        return {
          address: `${column}${sheetRow}`,
          column,
          field,
          value,
          chars: value.length,
          hasNewlines: value.includes("\n"),
          preview: value.replace(/\s+/g, " ").slice(0, 80),
        };
      })
      .filter((item) => includeEmpty || item.value !== "");

    const questionValue = updates.find((item) => item.field === "题目")?.value ?? "";
    if (questionValue) {
      const rawProductFormats = "产物格式" in col ? decodeFeishuCell(row[col["产物格式"]]) : "";
      assertClearQuestionRequest(questionValue, {
        label: `sheet row ${sheetRow}`,
        productFormats: rawProductFormats ? canonicalizeProductFormat(rawProductFormats) : "",
      });
    }

    return {
      dataRow: index + 2,
      sheetRow,
      title: row[col["任务概括"]] || row[col["题目"]] || "",
      updates,
    };
  });

  return {
    version: 1,
    questionPresentation: "natural-paragraphs-no-blank-lines-v4",
    generatedAt: new Date().toISOString(),
    sourcePath,
    startRow: sheetRows[0] ?? startRow,
    sheetRows: sheetRows.length ? [...sheetRows] : undefined,
    count: selectedRows.length,
    note:
      "Use address-box + F2 + clipboard paste for each cell. Do not paste this plan as one block into Feishu.",
    columnMap,
    rows: planRows,
  };
}

export function buildLegacyPayload(plan, fields = LEGACY_PAYLOAD_FIELDS) {
  return plan.rows
    .map((row) => {
      const byField = Object.fromEntries(row.updates.map((item) => [item.field, item.value]));
      return fields.map((field) => clipboardCell(byField[field] ?? "")).join("\t");
    })
    .join("\n");
}

export async function writeFillArtifacts({
  tsvPath,
  jsonOutPath,
  payloadOutPath,
  startRow,
  sheetRows = [],
  count,
}) {
  const text = await fs.readFile(tsvPath, "utf8");
  const plan = buildFeishuFillPlan({
    text,
    sourcePath: path.resolve(tsvPath),
    startRow,
    sheetRows,
    count,
  });

  await fs.mkdir(path.dirname(jsonOutPath), { recursive: true });
  await fs.writeFile(jsonOutPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  if (payloadOutPath) {
    const payload = buildLegacyPayload(plan);
    await fs.mkdir(path.dirname(payloadOutPath), { recursive: true });
    await fs.writeFile(payloadOutPath, `${payload}\n`, "utf8");
  }

  return plan;
}
