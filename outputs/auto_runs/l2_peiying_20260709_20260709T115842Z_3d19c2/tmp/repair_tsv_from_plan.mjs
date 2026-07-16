import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const runRoot = path.join(root, "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2");
const planPath = path.join(runRoot, "feishu/feishu_fill_plan_145_149.json");
const tsvPath = path.join(runRoot, "drafts/l2_questions_5.tsv");
const payloadPath = path.join(runRoot, "feishu/feishu_A_P_payload_145_149.tsv");

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

function tsvCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, " ");
}

const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
const rows = plan.rows.map((row, index) => {
  const byField = Object.fromEntries(row.updates.map((item) => [item.field, item.value]));
  return {
    UID: `裴硬_7.9_${String(index + 1).padStart(2, "0")}`,
    ...byField,
    标注专家姓名: "裴硬",
  };
});

const tsv = [headers.join("\t"), ...rows.map((row) => headers.map((field) => tsvCell(row[field])).join("\t"))].join("\n") + "\n";
await fs.writeFile(tsvPath, tsv, "utf8");
await fs.writeFile(payloadPath, tsv, "utf8");

const lineCount = tsv.trimEnd().split(/\r?\n/).length;
const columnCounts = tsv.trimEnd().split(/\r?\n/).map((line) => line.split("\t").length);
console.log(JSON.stringify({ lineCount, columnCounts }, null, 2));
