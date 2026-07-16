import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAttachmentSemantics } from "./attachment_semantic_rules.mjs";

function specific(name, object, periodOrEvent) {
  return {
    name,
    classification: "specific-business",
    objectLevel: true,
    timeAnchor: periodOrEvent,
    summary: `${object}${periodOrEvent}的具体记录`,
    specificityEvidence: { object, periodOrEvent, uniqueContent: "包含对象级字段和实际结果" },
  };
}

test("requires at least eighty percent independently evidenced specific attachments", () => {
  const result = evaluateAttachmentSemantics({ attachments: [
    specific("甲公司2025年年度报告.pdf", "甲公司", "2025年"),
    specific("甲公司2026年一季度报告.pdf", "甲公司", "2026年一季度"),
    specific("甲项目2026年验收记录.xlsx", "甲项目", "2026年验收"),
    specific("甲项目2026年运行月报.xlsx", "甲项目", "2026年6月"),
    { name: "行业管理办法.pdf", classification: "rule-background" },
  ] });
  assert.equal(result.specificShare, 0.8);
  assert.deepEqual(result.findings, []);
});

test("rejects a policy page merely relabeled as specific business evidence", () => {
  const result = evaluateAttachmentSemantics({ attachments: [{
    name: "高层民用建筑消防安全管理规定.html",
    classification: "specific-business",
    objectLevel: true,
    timeAnchor: "2021年",
    summary: "规定公共区域的消防管理要求",
    specificityEvidence: { object: "高层建筑", periodOrEvent: "2021年施行", uniqueContent: "通用规则" },
  }] });
  assert.ok(result.findings.some((item) => item.rule === "rule-document-misclassified-as-specific"));
  assert.ok(result.findings.some((item) => item.rule === "specific-business-share-below-minimum"));
});

test("legacy preservation mode is explicit, source-bound, and unavailable to new production", () => {
  const plan = {
    mode: "preserved-existing-verified",
    attachments: [{ name: "原附件.pdf" }],
    preservationEvidence: {
      sourceRevision: 6124,
      sheetRow: 121,
      attachmentObjectCount: 1,
      sourceSnapshotHash: "abc",
      currentQaPass: true,
    },
  };
  assert.ok(evaluateAttachmentSemantics(plan).findings.some((item) => item.rule === "preserved-legacy-attachments-not-authorized"));
  assert.deepEqual(evaluateAttachmentSemantics(plan, { allowPreservedLegacy: true }).findings, []);
});
