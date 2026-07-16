import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLUMN_FIELDS, cellText } from "../automation/backfill_structure_registry.mjs";
import { findPoliteImperatives } from "../automation/language_style.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";

const RUN_DIR = path.resolve("outputs", "auto_runs", "rewrite_managed_corpus_calibrated_20260711");
const TARGET_ROWS = [121, 122, 123, 134, 135, 136, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 172, 173, 174, 178, 179, 180];
const WRITTEN_FIELDS = new Set(["题目", "任务概括", "附件内容", "产物内容", "做题关键步骤"]);

function normalize(value = "") {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function attachmentParts(value) {
  const parts = Array.isArray(value) ? value : [value];
  return parts.filter((part) => part && typeof part === "object" && (
    part.fileToken || part.attachment_token || part.type === "attachment"
  ));
}

export async function auditCorpusCalibratedSubmission() {
  const [snapshot, draftBundle, sourceBundle] = await Promise.all([
    fs.readFile(path.join(RUN_DIR, "feishu", "raw_readback_A121_P180.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(RUN_DIR, "sources", "managed_records_draft.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(RUN_DIR, "sources", "managed_records_source.json"), "utf8").then(JSON.parse),
  ]);
  const rangeStart = Number(snapshot.requestedRange.match(/A(\d+):/u)?.[1]);
  if (!rangeStart) throw new Error(`Cannot parse snapshot start row: ${snapshot.requestedRange}`);
  const draftByRow = new Map(draftBundle.records.map((record) => [Number(record.sheetRow), record]));
  const sourceByRow = new Map(sourceBundle.records.map((record) => [Number(record.sheetRow), record]));
  const records = [];
  const failures = [];
  let attachmentCount = 0;

  for (const sheetRow of TARGET_ROWS) {
    const cells = snapshot.values[sheetRow - rangeStart] ?? [];
    const current = Object.fromEntries(COLUMN_FIELDS.map((field, column) => [field, normalize(cellText(cells[column]))]));
    const draft = draftByRow.get(sheetRow);
    const source = sourceByRow.get(sheetRow);
    if (!draft || !source) throw new Error(`Missing local source or draft for row ${sheetRow}.`);
    for (const field of WRITTEN_FIELDS) {
      if (current[field] !== normalize(draft[field])) failures.push({ sheetRow, field, rule: "written-value-mismatch" });
    }
    for (const field of COLUMN_FIELDS.filter((field) => !WRITTEN_FIELDS.has(field))) {
      if (current[field] !== normalize(source[field])) failures.push({ sheetRow, field, rule: "preserved-value-changed" });
    }
    if (/\n\s*\n/u.test(current.题目)) failures.push({ sheetRow, field: "题目", rule: "blank-line" });
    if (/\n\s*\n/u.test(current.附件内容)) failures.push({ sheetRow, field: "附件内容", rule: "blank-line" });
    if (findPoliteImperatives(current.题目).length) failures.push({ sheetRow, field: "题目", rule: "polite-imperative" });
    if (current.产物格式 !== "docx, xlsx") failures.push({ sheetRow, field: "产物格式", rule: "noncanonical-format" });
    const attachments = attachmentParts(cells[9]);
    if (!attachments.length) failures.push({ sheetRow, field: "相关附件", rule: "attachment-cell-empty" });
    for (const attachment of attachments) {
      const token = attachment.fileToken || attachment.attachment_token;
      const mimeType = attachment.mimeType || attachment.mime_type;
      const size = attachment.size || attachment.file_size;
      if (!token || !mimeType || !size || !attachment.text) {
        failures.push({ sheetRow, field: "相关附件", rule: "attachment-object-incomplete", attachment: attachment.text || "" });
      }
    }
    attachmentCount += attachments.length;
    records.push({ sheetRow, ...current, rawAttachments: attachments });
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: failures.length ? "FAIL" : "PASS",
    source: {
      spreadsheetToken: snapshot.spreadsheetToken,
      sheetId: snapshot.sheetId,
      requestedRange: snapshot.requestedRange,
      revision: snapshot.revision,
    },
    targetRows: TARGET_ROWS,
    rowCount: records.length,
    writtenFields: [...WRITTEN_FIELDS],
    preservedFields: COLUMN_FIELDS.filter((field) => !WRITTEN_FIELDS.has(field)),
    attachmentObjectCount: attachmentCount,
    failures,
  };
  await Promise.all([
    writeJsonAtomic(path.join(RUN_DIR, "feishu", "final_readback.json"), {
      schemaVersion: 1,
      generatedAt: report.generatedAt,
      source: report.source,
      fields: ["sheetRow", ...COLUMN_FIELDS, "rawAttachments"],
      count: records.length,
      records,
    }),
    writeJsonAtomic(path.join(RUN_DIR, "feishu", "submission_audit_report.json"), report),
  ]);
  if (failures.length) throw new Error(`Submission audit failed with ${failures.length} finding(s).`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  auditCorpusCalibratedSubmission()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
