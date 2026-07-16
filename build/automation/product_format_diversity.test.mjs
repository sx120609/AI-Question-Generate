import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFormatCoverageAssignments,
  evaluateProductFormatBatch,
  evaluateProductFormatPurpose,
} from "./product_format_diversity.mjs";

test("coverage planner reserves each common office format once in batches of five or more", () => {
  const assignments = buildFormatCoverageAssignments(8, { seed: "run-a" });
  assert.equal(new Set(assignments.filter(Boolean)).size, 5);
  assert.equal(assignments.slice(5).every((item) => item === null), true);
  assert.deepEqual(buildFormatCoverageAssignments(3), [null, null, null]);
});

test("format purpose must be visible in the question or product description", () => {
  const valid = evaluateProductFormatPurpose({
    产物格式: "pptx, pdf",
    题目: "这份材料要在评审会上汇报，定稿还要留档。",
    产物内容: "PPT用于现场讲解，PDF作为发布版。",
  });
  assert.deepEqual(valid.findings, []);
  const invalid = evaluateProductFormatPurpose({ 产物格式: "pptx", 题目: "整理结果。", 产物内容: "形成文件。" });
  assert.ok(invalid.findings.some((item) => item.rule === "product-format-purpose-missing"));
});

test("large batches must cover office formats without one dominant combination", () => {
  const repeated = Array.from({ length: 12 }, (_, index) => ({
    UID: `重复_${index}`,
    题目: "帮我整理一份Word报告和Excel台账。",
    产物格式: "docx, xlsx",
    产物内容: "报告说明结论，台账记录数据。",
  }));
  const result = evaluateProductFormatBatch(repeated);
  assert.equal(result.status, "FAIL");
  assert.ok(result.findings.some((item) => item.rule === "batch-core-office-format-missing" && item.format === "pptx"));
  assert.ok(result.findings.some((item) => item.rule === "batch-product-combination-dominant"));
});
