import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNaturalQuestionValueRanges,
  assertSingleParagraphQuestionValueRanges,
  releaseBoundUpdatesFromValueRanges,
  verifyReleaseReceiptForValueRanges,
} from "./feishu_openapi_client.mjs";

test("keeps the legacy strict single-paragraph helper", () => {
  assert.throws(
    () => assertSingleParagraphQuestionValueRanges([
      { range: "sheet!B121:B121", values: [["第一段。\n第二段。"]] },
    ]),
    /B121.*single paragraph without line breaks/i,
  );

  assert.throws(
    () => assertSingleParagraphQuestionValueRanges([
      { range: "sheet!A130:O130", values: [["uid", "第一段。\n第二段。", "L2"]] },
    ]),
    /B130.*single paragraph without line breaks/i,
  );
});

test("allows human-approved natural paragraphs at the physical OpenAPI boundary", () => {
  assert.doesNotThrow(() => assertNaturalQuestionValueRanges([
    { range: "sheet!B121:B121", values: [["我在项目组负责整理材料。\n请基于现有附件生成一份Word说明。"]] },
  ]));
  assert.throws(
    () => assertNaturalQuestionValueRanges([
      { range: "sheet!B121:B121", values: [["我在项目组负责整理材料。\n1. 请生成一份Word说明。"]] },
    ]),
    /bullet or numbered specification list/i,
  );
});

test("rejects specification prose that never asks the model for a deliverable", () => {
  assert.throws(
    () => assertSingleParagraphQuestionValueRanges([
      { range: "sheet!B121:B121", values: [["Word需要写处理结论，Excel按业务类型分项。"]] },
    ]),
    /direct user request/i,
  );
});

test("allows single-paragraph B values and multiline O steps", () => {
  assert.doesNotThrow(() => assertSingleParagraphQuestionValueRanges([
    { range: "sheet!B121:B121", values: [["现有材料有些乱，你帮我整理成一份Word说明和一张Excel工作簿。"]] },
    { range: "sheet!O121:O121", values: [["1. 第一步。\n2. 第二步。"]] },
  ]));
});

test("extracts release-bound narrative cells from single-cell and rectangular ranges", () => {
  assert.deepEqual(releaseBoundUpdatesFromValueRanges([
    { range: "sheet!B121:B121", values: [["题面"]] },
    { range: "sheet!A130:O130", values: [[
      "uid", "题面2", "L2", "一级", "二级", "三级", "概括", "3年", "10h", "附件", "pdf", "附件内容", "docx", "产物", "步骤",
    ]] },
  ]), [
    { address: "B121", column: "B", field: "题目", value: "题面" },
    { address: "B130", column: "B", field: "题目", value: "题面2" },
    { address: "G130", column: "G", field: "任务概括", value: "概括" },
    { address: "L130", column: "L", field: "附件内容", value: "附件内容" },
    { address: "N130", column: "N", field: "产物内容", value: "产物" },
    { address: "O130", column: "O", field: "做题关键步骤", value: "步骤" },
  ]);
});

test("requires a release receipt only when the physical OpenAPI write touches narrative columns", async () => {
  const formatOnly = await verifyReleaseReceiptForValueRanges({
    valueRanges: [{ range: "sheet!M121:M121", values: [["docx, xlsx"]] }],
  });
  assert.equal(formatOnly.required, false);
  await assert.rejects(
    verifyReleaseReceiptForValueRanges({
      valueRanges: [{ range: "sheet!B121:B121", values: [["现有材料有些乱，你帮我整理成一份Word说明。"]] }],
    }),
    /release-gate receipt is required/i,
  );
});
