import assert from "node:assert/strict";
import test from "node:test";

import { buildFeishuFillPlan } from "./feishu_fill_plan_lib.mjs";

const text = [
  ["题目", "任务类型", "一级目录", "二级目录", "三级目录", "任务概括", "相关附件", "标注专家工作年限", "人类完成时间", "附件格式", "附件内容", "产物格式", "产物内容", "做题关键步骤"].join("\t"),
  ["现有材料有些乱，你帮我整理成一份Word说明和一张Excel工作簿。", "L2 流程型", "一级", "二级", "三级", "概括一", "附件一_a.pdf", "5年", "10h", "pdf", "附件内容", "docx, xlsx", "产物", "1. 一\\n2. 二"].join("\t"),
  ["现有记录要在会前核清楚，你给我做一份Word说明和一张Excel工作簿。", "L2 流程型", "一级", "二级", "三级", "概括二", "附件一_b.pdf", "5年", "10h", "pdf", "附件内容", "docx, xlsx", "产物", "1. 一\\n2. 二"].join("\t"),
].join("\n");

test("maps TSV rows to explicit non-contiguous Feishu rows", () => {
  const plan = buildFeishuFillPlan({ text, sourcePath: "test.tsv", sheetRows: [121, 134], count: 2 });
  assert.deepEqual(plan.rows.map((row) => row.sheetRow), [121, 134]);
  assert.equal(plan.rows[1].updates.find((item) => item.field === "题目").address, "B134");
  assert.equal(plan.questionPresentation, "natural-paragraphs-no-blank-lines-v4");
  assert.equal(plan.rows[0].updates.find((item) => item.field === "题目").value, "现有材料有些乱，你帮我整理成一份Word说明和一张Excel工作簿。");
  assert.equal(plan.rows[0].updates.find((item) => item.field === "题目").hasNewlines, false);
});

test("preserves natural question paragraphs instead of silently changing the gated candidate", () => {
  const multiline = text.replace("现有材料有些乱，你帮我整理成一份Word说明和一张Excel工作簿。", "现有材料有些乱。\\n你帮我整理成一份Word说明和一张Excel工作簿。");
  const plan = buildFeishuFillPlan({ text: multiline, sourcePath: "test.tsv", sheetRows: [121, 134], count: 2 });
  assert.equal(
    plan.rows[0].updates.find((item) => item.field === "题目").value,
    "现有材料有些乱。\n你帮我整理成一份Word说明和一张Excel工作簿。",
  );
});

test("rejects blank lines in a question cell", () => {
  const blankLine = text.replace("现有材料有些乱，你帮我整理成一份Word说明和一张Excel工作簿。", "现有材料有些乱。\\n\\n你帮我整理成一份Word说明和一张Excel工作簿。");
  assert.throws(
    () => buildFeishuFillPlan({ text: blankLine, sourcePath: "test.tsv", sheetRows: [121, 134], count: 2 }),
    /must not contain blank lines/i,
  );
});

test("rejects a question that leaves one requested file type implicit", () => {
  const missingExcel = text.replace("一份Word说明和一张Excel工作簿", "一份Word说明和补件表");
  assert.throws(
    () => buildFeishuFillPlan({ text: missingExcel, sourcePath: "test.tsv", sheetRows: [121, 134], count: 2 }),
    /name every requested output format.*xlsx/i,
  );
});

test("rejects an explicit row list with the wrong length", () => {
  assert.throws(
    () => buildFeishuFillPlan({ text, sourcePath: "test.tsv", sheetRows: [121], count: 2 }),
    /does not match/i,
  );
});
