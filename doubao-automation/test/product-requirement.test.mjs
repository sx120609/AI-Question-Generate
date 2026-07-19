import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProductRequirement,
  validateProductAssessment,
} from "../src/product-requirement.mjs";

test("infers multiple requested product formats from a work prompt", () => {
  const requirement = resolveProductRequirement({
    initialPrompt: "请生成一份Excel工作簿和一份HTML格式的执行操作页。",
  });
  assert.equal(requirement.required, true);
  assert.deepEqual(requirement.requestedFormats, ["excel", "html"]);
});

test("accepts an online spreadsheet as an explicit Excel equivalent", () => {
  const requirement = resolveProductRequirement({
    productRequirement: { requestedFormats: ["xlsx"] },
  });
  const assessment = validateProductAssessment({
    items: [{
      requestedFormat: "excel",
      deliveredFormat: "online-spreadsheet",
      status: "equivalent",
      evidenceQuote: "飞书在线表格",
    }],
  }, {
    artifacts: [{ text: "飞书在线表格", href: "https://example.test/sheet/1" }],
    requirement,
    responseText: "已经生成飞书在线表格，可以直接打开继续调整。",
  });
  assert.equal(assessment.accepted, true);
  assert.equal(assessment.items[0].status, "equivalent");
  const unbacked = validateProductAssessment({
    items: [{
      requestedFormat: "excel",
      deliveredFormat: "online-spreadsheet",
      status: "equivalent",
      evidenceQuote: "飞书在线表格",
    }],
  }, {
    requirement,
    responseText: "已经生成飞书在线表格，可以直接打开继续调整。",
  });
  assert.equal(unbacked.accepted, false);
});

test("accepts unavailable only with an explicit limitation and usable best effort", () => {
  const requirement = resolveProductRequirement({
    productRequirement: { requestedFormats: ["html"] },
  });
  const accepted = validateProductAssessment({
    items: [{
      requestedFormat: "html",
      status: "unavailable",
      evidenceQuote: "暂不支持直接返回HTML附件",
      bestEffortProvided: true,
      bestEffortEvidenceQuote: "完整页面代码和执行说明整理在下方",
    }],
  }, {
    requirement,
    responseText: "暂不支持直接返回HTML附件，我已经把完整页面代码和执行说明整理在下方。",
  });
  assert.equal(accepted.accepted, true);

  const rejected = validateProductAssessment({
    items: [{
      requestedFormat: "html",
      status: "unavailable",
      evidenceQuote: "暂不支持直接返回HTML附件",
      bestEffortProvided: false,
    }],
  }, {
    requirement,
    responseText: "暂不支持直接返回HTML附件。",
  });
  assert.equal(rejected.accepted, false);
});

test("rejects silent product omission", () => {
  const requirement = resolveProductRequirement({
    productRequirement: { requestedFormats: ["excel"] },
  });
  const assessment = validateProductAssessment({ items: [] }, {
    requirement,
    responseText: "下面是分析结论。",
  });
  assert.equal(assessment.accepted, false);
  assert.equal(assessment.items[0].status, "missing");
});
