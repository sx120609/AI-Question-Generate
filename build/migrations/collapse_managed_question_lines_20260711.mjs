import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLUMN_FIELDS } from "../automation/backfill_structure_registry.mjs";
import { assertClearQuestionRequest, assertNaturalQuestionPresentation } from "../automation/language_style.mjs";
import { runSceneCardGate } from "../automation/scene_card.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { buildFeishuFillPlan } from "../manual_review/feishu_fill_plan_lib.mjs";

export const RUN_ID = "rewrite_managed_no_blank_lines_fix_20260711";
const SOURCE_RUN = path.resolve("outputs", "auto_runs", "rewrite_managed_suzizhan_method_20260711");
const RUN_DIR = path.resolve("outputs", "auto_runs", RUN_ID);

function normalize(value = "") {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function tsvCell(value) {
  return normalize(value).replace(/\t/gu, " ").replace(/\n/gu, "\\n");
}

function toTsv(rows) {
  return `${COLUMN_FIELDS.join("\t")}\n${rows.map((row) => COLUMN_FIELDS.map((field) => tsvCell(row[field])).join("\t")).join("\n")}\n`;
}

export async function buildSingleParagraphFix() {
  const source = JSON.parse(await fs.readFile(path.join(SOURCE_RUN, "sources", "managed_records_draft.json"), "utf8"));
  const records = source.records.map((record) => {
    const sourceParagraphs = normalize(record.题目).split(/\n+/gu).map((item) => item.trim()).filter(Boolean);
    const question = sourceParagraphs.join("\n");
    if (/\n\s*\n/u.test(question)) throw new Error(`${record.UID} contains a blank line.`);
    assertNaturalQuestionPresentation(question, { label: record.UID, maximumParagraphs: 8 });
    assertClearQuestionRequest(question, { label: record.UID, productFormats: record.产物格式 });
    return { ...record, 题目: question };
  });
  await Promise.all(["sources", "drafts", "feishu", "qa", "logs", "tmp"].map((dir) => fs.mkdir(path.join(RUN_DIR, dir), { recursive: true })));
  await Promise.all([
    fs.copyFile(path.join(SOURCE_RUN, "sources", "fact_ledger.json"), path.join(RUN_DIR, "sources", "fact_ledger.json")),
    fs.copyFile(path.join(SOURCE_RUN, "sources", "scene_cards.json"), path.join(RUN_DIR, "sources", "scene_cards.json")),
  ]);
  const tsvPath = path.join(RUN_DIR, "drafts", "l2_questions_single_paragraph.tsv");
  const text = toTsv(records);
  await fs.writeFile(tsvPath, text, "utf8");
  const fillPlan = buildFeishuFillPlan({
    text,
    sourcePath: tsvPath,
    sheetRows: records.map((record) => Number(record.sheetRow)),
    count: records.length,
    columnMap: [{ field: "题目", column: "B" }],
  });
  const fillPlanPath = path.join(RUN_DIR, "feishu", "feishu_fill_plan_single_paragraph.json");
  const roleReportPath = path.join(RUN_DIR, "feishu", "role_consistency_report.json");
  await Promise.all([
    writeJsonAtomic(fillPlanPath, fillPlan),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_source.json"), source),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_draft.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      count: records.length,
      records,
    }),
    writeJsonAtomic(path.join(RUN_DIR, "manifest.json"), {
      runId: RUN_ID,
      generatedAt: new Date().toISOString(),
      objective: "修复沈礼与裴硬22条题目连续空行，保留自然分段并将段间双换行改为单换行",
      status: "drafted-not-submitted",
      count: records.length,
      generatedAnnotators: ["沈礼", "裴硬"],
      spreadsheetToken: "ByAysb2Cdh9V2wtISbJc6Z01nwc",
      sheetId: "49e351",
      sheetRows: records.map((record) => Number(record.sheetRow)),
      writableFields: ["题目"],
      questionPresentation: "natural-paragraphs-no-blank-lines-v4",
      sourceRunId: "rewrite_managed_suzizhan_method_20260711",
    }),
  ]);
  const roleReport = await runSceneCardGate({
    candidatePath: tsvPath,
    sceneCardPath: path.join(RUN_DIR, "sources", "scene_cards.json"),
    reportPath: roleReportPath,
  });
  return {
    ok: roleReport.status === "PASS",
    roleStatus: roleReport.status,
    count: records.length,
    tsvPath,
    fillPlanPath,
    newlineCounts: records.map((record) => ({ uid: record.UID, count: (record.题目.match(/\n/gu) ?? []).length })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSingleParagraphFix()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
