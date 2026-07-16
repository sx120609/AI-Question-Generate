import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COLUMN_FIELDS } from "../automation/backfill_structure_registry.mjs";
import { parseTsvRows } from "../automation/structure_fingerprint.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const BEFORE_PATH = path.join(
  ROOT,
  "outputs",
  "auto_runs",
  "rewrite_shenli_all_20260709T215202Z_63bf72",
  "sources",
  "managed_records_all_before.json",
);
const TARGET_TSV_PATHS = [
  path.join(ROOT, "outputs", "auto_runs", "rewrite_shenli_all_20260709T215202Z_63bf72", "drafts", "l2_questions_rewritten.tsv"),
  path.join(ROOT, "outputs", "auto_runs", "rewrite_peiying_all_20260709T215207Z_75bdf9", "drafts", "l2_questions_rewritten.tsv"),
];
const NARRATIVE_FIELDS = new Set(["题目", "任务概括", "附件内容", "产物内容", "做题关键步骤"]);
const IMMUTABLE_FIELDS = COLUMN_FIELDS.filter((field) => !NARRATIVE_FIELDS.has(field));

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

function text(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function mapUnique(records, label) {
  const map = new Map();
  for (const row of records) {
    if (!row.UID || map.has(row.UID)) throw new Error(`${label} has missing or duplicate UID: ${row.UID}`);
    map.set(row.UID, row);
  }
  return map;
}

async function loadTargets(targetPaths = TARGET_TSV_PATHS) {
  const rows = [];
  for (const filePath of targetPaths) rows.push(...parseTsvRows(await fs.readFile(filePath, "utf8")));
  return rows;
}

function compareField(uid, field, expected, actual, mismatches) {
  if (text(expected) === text(actual)) return;
  mismatches.push({ uid, field, expectedLength: text(expected).length, actualLength: text(actual).length });
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const mode = args.mode;
  if (!new Set(["pre", "post"]).has(mode) || !args.snapshot || !args.report) {
    throw new Error("--mode=pre|post, --snapshot and --report are required.");
  }
  const baselinePath = args.baseline ? resolveFromRoot(args.baseline) : BEFORE_PATH;
  const targetPaths = args.targets
    ? args.targets.split(",").map((item) => resolveFromRoot(item.trim())).filter(Boolean)
    : TARGET_TSV_PATHS;

  const [before, current, targets] = await Promise.all([
    fs.readFile(baselinePath, "utf8").then(JSON.parse),
    fs.readFile(resolveFromRoot(args.snapshot), "utf8").then(JSON.parse),
    loadTargets(targetPaths),
  ]);
  const annotator = args.annotator || "";
  const select = (records) => annotator ? records.filter((row) => row.标注专家姓名 === annotator) : records;
  const beforeByUid = mapUnique(select(before.records), "before snapshot");
  const currentByUid = mapUnique(select(current.records), "current snapshot");
  const targetByUid = mapUnique(select(targets), "target TSVs");
  const expectedUids = [...beforeByUid.keys()].sort();
  const actualUids = [...currentByUid.keys()].sort();
  const targetUids = [...targetByUid.keys()].sort();
  if (JSON.stringify(expectedUids) !== JSON.stringify(actualUids) || JSON.stringify(expectedUids) !== JSON.stringify(targetUids)) {
    throw new Error(`UID coverage mismatch: before=${expectedUids.length}, current=${actualUids.length}, targets=${targetUids.length}`);
  }

  const mismatches = [];
  for (const uid of expectedUids) {
    const beforeRow = beforeByUid.get(uid);
    const currentRow = currentByUid.get(uid);
    const targetRow = targetByUid.get(uid);
    if (beforeRow.sheetRow !== currentRow.sheetRow) {
      mismatches.push({ uid, field: "sheetRow", expected: beforeRow.sheetRow, actual: currentRow.sheetRow });
    }
    const fields = mode === "pre" ? COLUMN_FIELDS : IMMUTABLE_FIELDS;
    for (const field of fields) compareField(uid, field, beforeRow[field], currentRow[field], mismatches);
    if (mode === "post") {
      for (const field of NARRATIVE_FIELDS) compareField(uid, field, targetRow[field], currentRow[field], mismatches);
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    annotator,
    baselinePath,
    targetPaths,
    status: mismatches.length ? "FAIL" : "PASS",
    count: expectedUids.length,
    immutableFields: IMMUTABLE_FIELDS,
    narrativeFields: [...NARRATIVE_FIELDS],
    mismatches,
  };
  await writeJsonAtomic(resolveFromRoot(args.report), report);
  if (mismatches.length) throw new Error(`${mode} verification found ${mismatches.length} mismatches.`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
