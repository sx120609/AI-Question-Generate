import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, writeJsonAtomic } from "../automation/run_context.mjs";

const EXPECTED_ROWS = [121, 122, 123, 134, 135, 136, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 172, 173, 174, 178, 179, 180];
const QA_ROOTS = [
  "outputs/auto_runs/rewrite_shenli_natural_reset_20260710/qa/natural_reset_round1",
  "outputs/auto_runs/rewrite_peiying_natural_reset_20260710/qa/natural_reset_round1",
  "outputs/analysis/qa_natural_reset_round2",
  "outputs/analysis/qa_natural_reset_round3",
];

function absolute(relativePath) {
  return path.resolve(REPO_ROOT, relativePath);
}

async function findQaRounds(directory) {
  const files = [];
  async function visit(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (/^qa_round_\d+\.json$/.test(entry.name)) files.push(fullPath);
    }
  }
  await visit(directory);
  return files;
}

function isPassed(item) {
  if (typeof item.passed === "boolean") return item.passed;
  const status = String(item.status ?? "");
  return status.includes("通过") && !status.includes("不通过");
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

async function main() {
  const roundFiles = (await Promise.all(QA_ROOTS.map((root) => findQaRounds(absolute(root))))).flat().sort();
  const expected = new Set(EXPECTED_ROWS);
  const historyByRow = new Map(EXPECTED_ROWS.map((row) => [row, []]));

  for (const filePath of roundFiles) {
    const items = JSON.parse(await fs.readFile(filePath, "utf8"));
    for (const item of items) {
      if (!expected.has(Number(item.row))) continue;
      historyByRow.get(Number(item.row)).push({
        checkedAt: item.checkedAt,
        status: item.status,
        passed: isPassed(item),
        note: item.note,
        categories: item.categories ?? [],
        source: path.relative(REPO_ROOT, filePath).replace(/\\/g, "/"),
      });
    }
  }

  const [live, audit, verification] = await Promise.all([
    fs.readFile(absolute("outputs/analysis/natural_reset_live_after_final_qa.json"), "utf8").then(JSON.parse),
    fs.readFile(absolute("outputs/analysis/natural_reset_batch_audit_20260710.json"), "utf8").then(JSON.parse),
    fs.readFile(absolute("outputs/analysis/natural_reset_post_apply_final_verification.json"), "utf8").then(JSON.parse),
  ]);
  const uidByRow = new Map(live.records.map((item) => [Number(item.sheetRow), item.UID]));

  const rows = EXPECTED_ROWS.map((row) => {
    const history = historyByRow.get(row).sort((left, right) => String(left.checkedAt).localeCompare(String(right.checkedAt)));
    if (!history.length) throw new Error(`No QA result found for row ${row}.`);
    return {
      row,
      uid: uidByRow.get(row) ?? "",
      attempts: history.length,
      first: history[0],
      latest: history.at(-1),
      history,
    };
  });
  const passed = rows.filter((item) => item.latest.passed).length;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: passed === rows.length && audit.status === "PASS" && verification.status === "PASS" ? "PASS" : "FAIL",
    scope: { rows: EXPECTED_ROWS, count: rows.length, annotators: ["沈礼", "裴硬"] },
    qa: { passed, failed: rows.length - passed, passRate: passed / rows.length, attempts: rows.reduce((sum, item) => sum + item.attempts, 0) },
    localAudit: { status: audit.status, report: "outputs/analysis/natural_reset_batch_audit_20260710.json" },
    liveVerification: {
      status: verification.status,
      mismatchCount: verification.mismatches.length,
      report: "outputs/analysis/natural_reset_post_apply_final_verification.json",
    },
    roundSources: roundFiles.map((filePath) => path.relative(REPO_ROOT, filePath).replace(/\\/g, "/")),
    rows,
  };

  const jsonPath = absolute("outputs/analysis/natural_reset_final_qa_20260710.json");
  const markdownPath = absolute("outputs/analysis/natural_reset_final_qa_20260710.md");
  await writeJsonAtomic(jsonPath, report);

  const lines = [
    "# 沈礼、裴硬自然化重写最终质检",
    "",
    `- 最终状态：${report.status}`,
    `- 最新质检：${passed}/${rows.length} 通过`,
    `- 累计质检请求：${report.qa.attempts}`,
    `- 本地批次审计：${audit.status}`,
    `- 飞书回读一致性：${verification.status}，差异 ${verification.mismatches.length} 项`,
    "",
    "| 飞书行 | UID | 首轮 | 最新 | 次数 | 最新意见 |",
    "| ---: | --- | --- | --- | ---: | --- |",
    ...rows.map((item) => `| ${item.row} | ${escapeCell(item.uid)} | ${escapeCell(item.first.status)} | ${escapeCell(item.latest.status)} | ${item.attempts} | ${escapeCell(item.latest.note)} |`),
    "",
    "最终结果以每行最新一次质检为准；本地审计和飞书回读一致性同时通过后，整批状态才记为 PASS。",
    "",
  ];
  await fs.writeFile(markdownPath, lines.join("\n"), "utf8");
  return { status: report.status, passed, total: rows.length, attempts: report.qa.attempts, jsonPath, markdownPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
