import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLastJsonObject, runLarkCli } from "../../../../build/automation/feishu_lark_cli_client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../../..");
const runRoot = path.join(root, "outputs", "auto_runs", "l2_shenli_20260709T202051Z_866b59");
const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";

function parseCli(result, label) {
  const parsed = parseLastJsonObject([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (result.code !== 0 || parsed?.ok === false) {
    throw new Error(`${label} failed: ${JSON.stringify(parsed).slice(0, 1600)}`);
  }
  return parsed;
}

async function readRange(a1Range) {
  const result = await runLarkCli(
    [
      "api",
      "GET",
      `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(`${sheetId}!${a1Range}`)}`,
      "--as",
      "user",
      "--format",
      "json",
    ],
    { timeoutMs: 180_000 },
  );
  return parseCli(result, `read ${a1Range}`);
}

function valuesOf(response) {
  return response?.data?.valueRange?.values ?? response?.data?.data?.valueRange?.values ?? [];
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(cellText).join("");
  if (typeof value === "object") {
    if (value.text !== undefined) return cellText(value.text);
    if (value.value !== undefined) return cellText(value.value);
    if (value.rich_text !== undefined) return cellText(value.rich_text);
    if (value.link !== undefined) return cellText(value.link);
    if (value.url !== undefined) return cellText(value.url);
  }
  return "";
}

function attachmentParts(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (part) => part?.type === "attachment" || part?.fileToken || part?.attachment_token,
  );
}

async function main() {
  const [plan, queueDoc, bodyReadback, qaReadback] = await Promise.all([
    fs.readFile(path.join(runRoot, "feishu", "feishu_fill_plan_178_180.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(runRoot, "feishu", "feishu_attachment_upload_queue_178_179_180.json"), "utf8").then(JSON.parse),
    readRange("A178:P180"),
    readRange("AT178:AU180"),
  ]);
  await fs.writeFile(
    path.join(runRoot, "feishu", "final_readback_a178_p180.json"),
    `${JSON.stringify(bodyReadback, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(runRoot, "feishu", "final_readback_at178_au180.json"),
    `${JSON.stringify(qaReadback, null, 2)}\n`,
    "utf8",
  );

  const bodyValues = valuesOf(bodyReadback);
  const qaValues = valuesOf(qaReadback);
  const bodyChecks = [];
  const attachmentChecks = [];
  const qaChecks = [];

  for (let rowIndex = 0; rowIndex < plan.rows.length; rowIndex += 1) {
    const planRow = plan.rows[rowIndex];
    const remoteRow = bodyValues[rowIndex] ?? [];
    for (const update of planRow.updates) {
      if (update.column === "J") continue;
      const columnIndex = update.column.charCodeAt(0) - "A".charCodeAt(0);
      const actual = cellText(remoteRow[columnIndex]);
      bodyChecks.push({
        row: planRow.sheetRow,
        address: update.address,
        field: update.field,
        expected: update.value,
        actual,
        ok: actual === update.value,
      });
    }

    const queueRow = queueDoc.queue.find((item) => Number(item.row) === Number(planRow.sheetRow));
    const expectedNames = (queueRow?.files ?? []).map((file) => file.fileName);
    const parts = attachmentParts(remoteRow[9]);
    const actualNames = parts.map(
      (part) => part.text ?? part.attachment_name ?? part.file_name ?? part.name ?? "",
    );
    attachmentChecks.push({
      row: planRow.sheetRow,
      address: `J${planRow.sheetRow}`,
      expectedCount: expectedNames.length,
      actualCount: actualNames.length,
      expectedNames,
      actualNames,
      ok: JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    });

    const qaStatus = cellText(qaValues[rowIndex]?.[0]).trim();
    const qaNote = cellText(qaValues[rowIndex]?.[1]).trim();
    qaChecks.push({
      row: planRow.sheetRow,
      status: qaStatus,
      note: qaNote,
      ok: qaStatus.includes("通过") && !qaStatus.includes("不通过"),
    });
  }

  const strictProductFormats = bodyChecks
    .filter((item) => item.field === "产物格式")
    .map((item) => ({ row: item.row, value: item.actual, ok: item.actual === "docx, xlsx" }));
  const identities = bodyChecks
    .filter((item) => item.field === "UID" || item.field === "标注专家姓名")
    .map((item) => ({ row: item.row, field: item.field, value: item.actual, ok: item.ok }));
  const nonEmptyRequired = bodyChecks
    .filter((item) => !["UID", "标注专家姓名"].includes(item.field))
    .map((item) => ({ row: item.row, field: item.field, ok: item.actual.trim().length > 0 }));

  const summary = {
    ok:
      bodyChecks.every((item) => item.ok) &&
      attachmentChecks.every((item) => item.ok) &&
      qaChecks.every((item) => item.ok) &&
      strictProductFormats.every((item) => item.ok) &&
      identities.every((item) => item.ok) &&
      nonEmptyRequired.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    body: {
      checked: bodyChecks.length,
      passed: bodyChecks.filter((item) => item.ok).length,
      failed: bodyChecks.filter((item) => !item.ok),
    },
    attachments: attachmentChecks,
    qa: qaChecks,
    productFormats: strictProductFormats,
    identities,
    nonEmptyRequiredFailed: nonEmptyRequired.filter((item) => !item.ok),
  };
  await fs.writeFile(
    path.join(runRoot, "feishu", "final_remote_verification_178_180.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  if (!summary.ok) throw new Error(`Final remote verification failed: ${JSON.stringify(summary)}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
