export const ATTACHMENT_SEMANTIC_POLICY_ID = "specific-evidence-dominant-v1";
export const MIN_SPECIFIC_BUSINESS_SHARE = 0.8;

const RULE_ONLY_MARKER = /(?:法律|法规|条例|规定|办法|指南|指引|政策解读|实施方案|管理要求|国家标准|行业标准|暂行办法|工作通知|意见稿|答记者问)/u;
const CONCRETE_DOCUMENT_MARKER = /(?:年报|季报|月报|周报|日报|财务报表|业绩快报|运行记录|业务记录|检查通报|抽检通告|统计表|审批结果|验收记录|检测报告|采购参数|合同|台账|名单|批次|考核结果|许可材料|招标公告|项目页面|产品资料|订单|流水|日志)/u;

function text(value = "") {
  return String(value).trim();
}

export function evaluateAttachmentSemantics(plan = {}, {
  allowPreservedLegacy = false,
  allowEmpty = false,
  maximumAttachments = null,
  minimumSpecificBusinessShare = MIN_SPECIFIC_BUSINESS_SHARE,
} = {}) {
  const attachments = Array.isArray(plan?.attachments) ? plan.attachments : [];
  const findings = [];
  if (plan?.mode === "preserved-existing-verified") {
    if (!allowPreservedLegacy) return { findings: [{ rule: "preserved-legacy-attachments-not-authorized" }], specificShare: 0, validSpecificCount: 0, attachmentCount: attachments.length };
    const evidence = plan?.preservationEvidence;
    if (!Number.isInteger(Number(evidence?.sourceRevision))) findings.push({ rule: "legacy-source-revision-missing" });
    if (!Number.isInteger(Number(evidence?.sheetRow))) findings.push({ rule: "legacy-sheet-row-missing" });
    if (Number(evidence?.attachmentObjectCount) !== attachments.length) {
      findings.push({ rule: "legacy-attachment-count-mismatch", expected: evidence?.attachmentObjectCount, actual: attachments.length });
    }
    if (!text(evidence?.sourceSnapshotHash)) findings.push({ rule: "legacy-source-snapshot-hash-missing" });
    if (evidence?.currentQaPass !== true) findings.push({ rule: "legacy-current-qa-pass-missing" });
    return { findings, specificShare: null, validSpecificCount: null, attachmentCount: attachments.length, preservationMode: true };
  }
  const validSpecific = [];
  if (maximumAttachments != null && attachments.length > Number(maximumAttachments)) {
    findings.push({ rule: "attachment-count-above-maximum", expectedMaximum: Number(maximumAttachments), actual: attachments.length });
  }
  for (const [index, attachment] of attachments.entries()) {
    const position = index + 1;
    const classification = text(attachment?.classification);
    if (!["specific-business", "rule-background"].includes(classification)) {
      findings.push({ rule: "attachment-classification-invalid", position, name: attachment?.name ?? "" });
      continue;
    }
    if (classification !== "specific-business") continue;
    const evidence = attachment?.specificityEvidence;
    const descriptor = `${text(attachment?.name)} ${text(attachment?.summary)}`;
    let valid = true;
    if (attachment?.objectLevel !== true) {
      findings.push({ rule: "specific-attachment-not-object-level", position, name: attachment?.name ?? "" });
      valid = false;
    }
    if (!text(attachment?.timeAnchor)) {
      findings.push({ rule: "specific-attachment-time-anchor-missing", position, name: attachment?.name ?? "" });
      valid = false;
    }
    for (const key of ["object", "periodOrEvent", "uniqueContent"]) {
      if (!text(evidence?.[key])) {
        findings.push({ rule: `specificity-evidence-${key}-missing`, position, name: attachment?.name ?? "" });
        valid = false;
      }
    }
    if (RULE_ONLY_MARKER.test(descriptor) && !CONCRETE_DOCUMENT_MARKER.test(descriptor)) {
      findings.push({ rule: "rule-document-misclassified-as-specific", position, name: attachment?.name ?? "" });
      valid = false;
    }
    if (valid) validSpecific.push(attachment);
  }
  const specificShare = attachments.length ? validSpecific.length / attachments.length : 0;
  if (!attachments.length && !allowEmpty) findings.push({ rule: "attachment-set-empty" });
  if (specificShare < Number(minimumSpecificBusinessShare)) {
    findings.push({
      rule: "specific-business-share-below-minimum",
      expectedMinimum: Number(minimumSpecificBusinessShare),
      actual: Number(specificShare.toFixed(4)),
      validSpecificCount: validSpecific.length,
      attachmentCount: attachments.length,
    });
  }
  return { findings, specificShare, validSpecificCount: validSpecific.length, attachmentCount: attachments.length };
}
