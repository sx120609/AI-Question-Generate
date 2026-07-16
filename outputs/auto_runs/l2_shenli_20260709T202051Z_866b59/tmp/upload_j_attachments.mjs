import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLastJsonObject, runLarkCli } from "../../../../build/automation/feishu_lark_cli_client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../../..");
const runRoot = path.join(root, "outputs", "auto_runs", "l2_shenli_20260709T202051Z_866b59");
const queuePath = path.join(runRoot, "feishu", "feishu_attachment_upload_queue_178_179_180.json");
const uploadManifestPath = path.join(runRoot, "feishu", "feishu_attachment_sheet_media_uploads_178_180.json");
const cellsPath = path.join(runRoot, "feishu", "feishu_attachment_cells_j178_j180.json");
const setResultPath = path.join(runRoot, "feishu", "feishu_attachment_cells_set_result_178_180.json");
const readbackPath = path.join(runRoot, "feishu", "feishu_attachment_readback_j178_j180.json");
const verificationPath = path.join(runRoot, "feishu", "feishu_attachment_verification_178_180.json");

const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".json") return "application/json";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}

function parseCli(result, label) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const parsed = parseLastJsonObject(output);
  if (result.code !== 0 || parsed?.ok === false) {
    throw new Error(`${label} failed: ${JSON.stringify(parsed).slice(0, 1500)}`);
  }
  return parsed;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function uploadFile(file) {
  const stats = await fs.stat(file.path);
  const relativePath = path.relative(root, file.path).replace(/\\/g, "/");
  const result = await runLarkCli(
    [
      "api",
      "POST",
      "/open-apis/drive/v1/medias/upload_all",
      "--as",
      "user",
      "--format",
      "json",
      "--data",
      JSON.stringify({
        file_name: file.fileName,
        parent_type: "sheet_file",
        parent_node: spreadsheetToken,
        size: String(stats.size),
      }),
      "--file",
      `file=${relativePath}`,
    ],
    { timeoutMs: 240_000 },
  );
  const parsed = parseCli(result, `upload ${file.fileName}`);
  const payload = parsed?.data?.data ?? parsed?.data ?? parsed;
  const token = payload?.file_token ?? payload?.fileToken ?? payload?.token;
  if (!token) throw new Error(`Upload response missing token for ${file.fileName}`);
  return {
    fileName: file.fileName,
    path: file.path,
    size: Number(payload?.size ?? stats.size),
    mimeType: mimeType(file.path),
    attachmentToken: token,
  };
}

function richTextFor(files) {
  const parts = [];
  files.forEach((file, index) => {
    if (index) parts.push({ type: "text", text: "\n" });
    parts.push({
      type: "attachment",
      text: file.fileName,
      attachment_name: file.fileName,
      attachment_token: file.attachmentToken,
      file_size: file.size,
      mime_type: file.mimeType,
    });
  });
  return parts;
}

function attachmentParts(rowValue) {
  const cell = rowValue?.[0];
  if (!Array.isArray(cell)) return [];
  return cell.filter(
    (part) => part?.type === "attachment" || part?.fileToken || part?.attachment_token,
  );
}

async function main() {
  const queueDoc = JSON.parse(await fs.readFile(queuePath, "utf8"));
  if (queueDoc.missing?.length) throw new Error(`Queue has missing attachments: ${JSON.stringify(queueDoc.missing)}`);
  if (JSON.stringify(queueDoc.queue.map((item) => [item.row, item.address])) !== JSON.stringify([[178, "J178"], [179, "J179"], [180, "J180"]])) {
    throw new Error("Attachment queue does not target J178:J180 exactly.");
  }

  const previous = await readJsonIfExists(uploadManifestPath, { uploads: [], rows: [] });
  const byKey = new Map(
    (previous.uploads ?? []).map((item) => [`${item.path}\u0000${item.fileName}`, item]),
  );
  const rows = [];

  for (const item of queueDoc.queue) {
    const uploads = [];
    for (const file of item.files) {
      const key = `${file.path}\u0000${file.fileName}`;
      let upload = byKey.get(key);
      if (!upload?.attachmentToken) {
        upload = await uploadFile(file);
        byKey.set(key, upload);
      }
      uploads.push(upload);
      await fs.writeFile(
        uploadManifestPath,
        `${JSON.stringify({ generatedAt: new Date().toISOString(), uploads: [...byKey.values()], rows }, null, 2)}\n`,
        "utf8",
      );
    }
    rows.push({ row: item.row, address: item.address, uploads });
    await fs.writeFile(
      uploadManifestPath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), uploads: [...byKey.values()], rows }, null, 2)}\n`,
      "utf8",
    );
  }

  const cells = rows.map((row) => [{ rich_text: richTextFor(row.uploads) }]);
  await fs.writeFile(cellsPath, `${JSON.stringify(cells, null, 2)}\n`, "utf8");

  const setResult = await runLarkCli(
    [
      "sheets",
      "+cells-set",
      "--as",
      "user",
      "--spreadsheet-token",
      spreadsheetToken,
      "--sheet-id",
      sheetId,
      "--range",
      "J178:J180",
      "--cells",
      `@${path.relative(root, cellsPath).replace(/\\/g, "/")}`,
      "--format",
      "json",
    ],
    { timeoutMs: 180_000 },
  );
  const parsedSet = parseCli(setResult, "cells-set J178:J180");
  await fs.writeFile(setResultPath, `${JSON.stringify(parsedSet, null, 2)}\n`, "utf8");

  const readbackResult = await runLarkCli(
    [
      "api",
      "GET",
      `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(`${sheetId}!J178:J180`)}`,
      "--as",
      "user",
      "--format",
      "json",
    ],
    { timeoutMs: 180_000 },
  );
  const readback = parseCli(readbackResult, "readback J178:J180");
  await fs.writeFile(readbackPath, `${JSON.stringify(readback, null, 2)}\n`, "utf8");

  const values = readback?.data?.valueRange?.values ?? readback?.data?.data?.valueRange?.values ?? [];
  const verification = rows.map((row, index) => {
    const parts = attachmentParts(values[index]);
    const expectedNames = row.uploads.map((file) => file.fileName);
    const actualNames = parts.map(
      (part) => part.text ?? part.attachment_name ?? part.file_name ?? part.name ?? "",
    );
    return {
      row: row.row,
      address: row.address,
      expectedCount: expectedNames.length,
      actualCount: parts.length,
      expectedNames,
      actualNames,
      ok: JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    };
  });
  const summary = {
    ok: verification.every((item) => item.ok),
    uploaded: rows.reduce((sum, row) => sum + row.uploads.length, 0),
    setResult: parsedSet,
    verification,
  };
  await fs.writeFile(verificationPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (!summary.ok) throw new Error(`Attachment readback mismatch: ${JSON.stringify(verification)}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
