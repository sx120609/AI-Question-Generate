import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLUMN_FIELDS } from "../automation/backfill_structure_registry.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { buildFeishuFillPlan } from "../manual_review/feishu_fill_plan_lib.mjs";
import { buildManagedRewriteRun } from "./rewrite_managed_natural_reset_20260710.mjs";
import { HUMAN_VOICE_REWRITES_121_136 } from "./human_voice_rewrites_121_136.mjs";
import { HUMAN_VOICE_REWRITES_140_149 } from "./human_voice_rewrites_140_149.mjs";
import { HUMAN_VOICE_REWRITES_172_180 } from "./human_voice_rewrites_172_180.mjs";

const RUNS = {
  shenli: {
    runId: "rewrite_shenli_human_voice_20260710",
    sourceRunId: "rewrite_shenli_all_20260709T215202Z_63bf72",
    annotator: "沈礼",
    orderedUids: [
      "沈礼_7.9_01",
      "沈礼_7.9_02",
      "沈礼_7.9_03",
      "沈礼_7.9_04",
      "沈礼_7.9_05",
      "沈礼_7.9_06",
      "沈礼_7.9_07",
      "沈礼_7.9_08",
      "沈礼_7.9_09",
      "沈礼_7.9_10",
      "沈礼_7.9_11",
      "沈礼_7.10_01",
      "沈礼_7.10_02",
      "沈礼_7.10_03",
      "沈礼_7.10_04",
      "沈礼_7.10_05",
      "沈礼_7.10_06",
    ],
  },
  peiying: {
    runId: "rewrite_peiying_human_voice_20260710",
    sourceRunId: "rewrite_peiying_all_20260709T215207Z_75bdf9",
    annotator: "裴硬",
    orderedUids: [
      "裴硬_7.9_01",
      "裴硬_7.9_02",
      "裴硬_7.9_03",
      "裴硬_7.9_04",
      "裴硬_7.9_05",
    ],
  },
};

const REWRITES = {
  ...HUMAN_VOICE_REWRITES_121_136,
  ...HUMAN_VOICE_REWRITES_140_149,
  ...HUMAN_VOICE_REWRITES_172_180,
};

const QUESTION_LENGTH_POLICY = {
  hardMinimum: 560,
  recommendedRange: [650, 1200],
  warningMaximum: 1250,
  hardMaximum: 1500,
};

const NARRATIVE_COLUMN_MAP = [
  { field: "题目", column: "B" },
  { field: "任务概括", column: "G" },
  { field: "附件内容", column: "L" },
  { field: "产物内容", column: "N" },
  { field: "做题关键步骤", column: "O" },
];

function normalize(value = "") {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function tsvCell(value) {
  return normalize(value).replace(/\t/g, " ").replace(/\n/g, "\\n");
}

function toTsv(rows) {
  return `${COLUMN_FIELDS.join("\t")}\n${rows.map((row) => COLUMN_FIELDS.map((field) => tsvCell(row[field])).join("\t")).join("\n")}\n`;
}

async function buildCombinedRun(results) {
  const combinedRunId = "rewrite_managed_human_voice_20260710";
  const runDir = path.resolve("outputs", "auto_runs", combinedRunId);
  const drafts = [];
  const sourceSnapshots = [];
  const attachmentManifests = [];
  for (const result of results) {
    const sourceDir = path.dirname(path.dirname(result.tsvPath));
    drafts.push(...JSON.parse(await fs.readFile(path.join(sourceDir, "sources", "managed_records_draft.json"), "utf8")).records);
    sourceSnapshots.push(...JSON.parse(await fs.readFile(path.join(sourceDir, "sources", "managed_records_source.json"), "utf8")).records);
    attachmentManifests.push(...JSON.parse(await fs.readFile(path.join(sourceDir, "sources", "attachment_manifest.json"), "utf8")).attachments);
  }
  drafts.sort((left, right) => Number(left.sheetRow) - Number(right.sheetRow));
  sourceSnapshots.sort((left, right) => Number(left.sheetRow) - Number(right.sheetRow));
  await Promise.all(["sources", "attachments", "drafts", "feishu", "qa", "logs", "tmp"].map((dir) => fs.mkdir(path.join(runDir, dir), { recursive: true })));
  const combinedAttachments = [];
  for (const item of attachmentManifests) {
    const targetDir = path.join(runDir, "attachments", item.uid);
    const targetPath = path.join(targetDir, item.fileName);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(item.targetPath, targetPath);
    combinedAttachments.push({ ...item, targetPath });
  }
  const tsvPath = path.join(runDir, "drafts", "l2_questions_human_voice.tsv");
  await fs.writeFile(tsvPath, toTsv(drafts), "utf8");
  const plan = buildFeishuFillPlan({
    text: await fs.readFile(tsvPath, "utf8"),
    sourcePath: tsvPath,
    sheetRows: drafts.map((row) => Number(row.sheetRow)),
    count: drafts.length,
    columnMap: NARRATIVE_COLUMN_MAP,
  });
  const planPath = path.join(runDir, "feishu", "feishu_fill_plan_human_voice.json");
  await writeJsonAtomic(planPath, plan);
  await writeJsonAtomic(path.join(runDir, "sources", "managed_records_source.json"), {
    schemaVersion: 1,
    count: sourceSnapshots.length,
    records: sourceSnapshots,
  });
  await writeJsonAtomic(path.join(runDir, "sources", "managed_records_draft.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    count: drafts.length,
    records: drafts,
  });
  await writeJsonAtomic(path.join(runDir, "sources", "attachment_manifest.json"), {
    count: combinedAttachments.length,
    attachments: combinedAttachments,
  });
  await writeJsonAtomic(path.join(runDir, "manifest.json"), {
    runId: combinedRunId,
    generatedAt: new Date().toISOString(),
    objective: "沈礼17条与裴硬5条的事实保真、低模板整批重写及统一提交",
    count: drafts.length,
    generatedAnnotators: ["沈礼", "裴硬"],
    status: "drafted-not-submitted",
    spreadsheetToken: "ByAysb2Cdh9V2wtISbJc6Z01nwc",
    sheetId: "49e351",
    writableFields: NARRATIVE_COLUMN_MAP.map((item) => item.field),
    questionPresentation: "single-paragraph-clear-request-v1",
    componentRuns: results.map((result) => result.runId),
  });
  return {
    runId: combinedRunId,
    rows: drafts.length,
    tsvPath,
    planPath,
    attachments: combinedAttachments.length,
  };
}

function assertExactCoverage() {
  const expected = Object.values(RUNS).flatMap((run) => run.orderedUids).sort();
  const actual = Object.keys(REWRITES).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((uid) => !actualSet.has(uid));
    const extra = actual.filter((uid) => !expectedSet.has(uid));
    throw new Error(`Human-voice rewrite coverage mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}`);
  }
}

export async function buildHumanVoiceRuns() {
  assertExactCoverage();
  const results = [];
  for (const config of Object.values(RUNS)) {
    results.push(await buildManagedRewriteRun(config, {
      rewrites: REWRITES,
      fileStem: "human_voice",
      questionLength: QUESTION_LENGTH_POLICY,
      enforceFactGuard: true,
      objective: `基于原始记录事实重写${config.annotator}全部系统生成题，去除批量模板与补写情节`,
    }));
  }
  const combined = await buildCombinedRun(results);
  return { ok: true, results, combined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildHumanVoiceRuns()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
