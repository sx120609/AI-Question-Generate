import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProductionTraceGate, verifyProductionTraceReceipt } from "./production_trace_gate.mjs";

const fields = [
  "UID", "题目", "任务类型", "一级目录", "二级目录", "三级目录", "任务概括",
  "标注专家工作年限", "人类完成时间", "相关附件", "附件格式", "附件内容",
  "产物格式", "产物内容", "做题关键步骤", "标注专家姓名",
];

function fixtureRecord() {
  return {
    UID: "测试_01",
    题目: "运营团队正在复核本季度的合同、回单等项目记录。现有数据口径不一样，所以异常订单、退款等情况还要单独标明。帮我把核对结果整理成Word说明和Excel工作簿，让结论能回到金额、时间等原始记录。",
    任务类型: "L2流程型",
    一级目录: "互联网与平台业务",
    二级目录: "运营复盘与增长归因",
    三级目录: "项目复核",
    任务概括: "复核项目记录并形成决策材料",
    标注专家工作年限: "3年",
    人类完成时间: "8小时",
    相关附件: "项目季度记录.xlsx；项目异常记录.pdf",
    附件格式: "xlsx, pdf",
    附件内容: "项目季度记录包含订单与履约字段。\n项目异常记录包含异常时间和处理状态。",
    产物格式: "docx, xlsx",
    产物内容: "Word说明判断过程，Excel保存记录与状态。",
    做题关键步骤: "1. 核对项目记录。\n2. 形成判断材料。",
    标注专家姓名: "测试",
  };
}

test("requires the sampled reference, two gates, attachment trace and final record binding", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "production-trace-gate-"));
  const record = fixtureRecord();
  const attachmentRoot = path.join(dir, "attachments");
  const attachmentPath = path.join(attachmentRoot, "项目季度记录.xlsx");
  const attachmentBytes = Buffer.from("real attachment fixture");
  const attachmentHash = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const packet = {
    kind: "l2-production-input-packet",
    protocolId: "l2-sample-attachments-two-gates-trace-v1",
    status: "READY",
    questionCount: 1,
    inputs: { referenceWorkbook: { samples: [{ questionIndex: 1, sheet: "Sheet1", row: 18, attachmentSummary: "来源：https://reference.example/a" }] } },
  };
  const trace = {
    protocolId: packet.protocolId,
    questions: [{
      recordUid: record.UID,
      referenceLocation: { sheet: "Sheet1", row: 18 },
      referenceQuestionStructure: Object.fromEntries([
        "businessScene", "coreBlockage", "mainTask", "attachmentSupport",
        "deliverableOrigin", "imitableStructure", "forbiddenReuse",
      ].map((key) => [key, `${key}说明`])),
      referenceAttachmentStructure: "对象材料与规则材料配合",
      newQuestionStructureMapping: "只借推进方式，不复用领域与文本",
      newAttachmentSupport: "季度记录支撑复盘，异常记录支撑分流",
      attachmentBuild: { attachments: [{
        name: "项目季度记录.xlsx",
        sourceUrl: "https://new.example/a",
        classification: "specific-business",
        objectLevel: true,
        timeAnchor: "本季度",
        specificityEvidence: {
          object: "测试项目",
          periodOrEvent: "本季度复核",
          uniqueContent: "项目订单与履约字段及实际状态",
        },
        summary: "包含本季度订单与履约字段。",
        localPath: "项目季度记录.xlsx",
        sha256: attachmentHash(attachmentBytes),
      }] },
      formatRequirement: null,
      draftedProductFormats: record.产物格式,
      deliverableRationale: [
        { format: "docx", user: "运营负责人", purpose: "说明复核结论", whyThisFormat: "适合承载连续判断" },
        { format: "xlsx", user: "运营同事", purpose: "保存项目记录", whyThisFormat: "适合筛选和持续更新" },
      ],
      firstQaFullResult: { pass: true, issues: [] },
      firstQaRepairs: [],
      secondQaFullResult: {
        conclusion: "通过",
        modifiedQuestion: record.题目,
        continuityAudit: {
          sentenceLinks: [
            { from: 1, to: 2, relation: "因果", reason: "第二句说明项目记录为什么还需要继续区分异常情况" },
            { from: 2, to: 3, relation: "任务收束", reason: "第三句把前面的核对问题收束为两份工作交付" },
          ],
          paragraphLinks: [],
          commaListFree: true,
          outsiderReadable: true,
          narrativeFlow: true,
          unexplainedProfessionalTerms: [],
        },
      },
      revisionLog: [],
      finalRecord: record,
    }],
  };
  const paths = Object.fromEntries(["packet", "trace", "fillPlan"].map((name) => [name, path.join(dir, `${name}.json`)]));
  const candidatePath = path.join(dir, "candidate.tsv");
  const fillPlan = {
    rows: [{
      sheetRow: 18,
      updates: [
        { field: "UID", column: "A", value: record.UID },
        ...fields.filter((field) => field !== "UID" && field !== "标注专家姓名")
          .map((field) => ({ field, value: record[field] })),
      ],
    }],
  };
  await fs.mkdir(attachmentRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(attachmentPath, attachmentBytes),
    fs.writeFile(paths.packet, JSON.stringify(packet), "utf8"),
    fs.writeFile(paths.trace, JSON.stringify(trace), "utf8"),
    fs.writeFile(paths.fillPlan, JSON.stringify(fillPlan), "utf8"),
    fs.writeFile(candidatePath, `${fields.join("\t")}\n${fields.map((field) => String(record[field] ?? "").replace(/\n/gu, "\\n")).join("\t")}\n`, "utf8"),
  ]);
  const result = await runProductionTraceGate({
    packetPath: paths.packet,
    tracePath: paths.trace,
    candidatePath,
    fillPlanPath: paths.fillPlan,
    reportPath: path.join(dir, "report.json"),
    receiptPath: path.join(dir, "receipt.json"),
    attachmentRoot,
  });
  assert.equal(result.report.status, "PASS");
  assert.equal(result.receipt.status, "PASS");
  const verified = await verifyProductionTraceReceipt({
    receiptPath: path.join(dir, "receipt.json"),
    fillPlanPath: paths.fillPlan,
  });
  assert.equal(verified.ok, true);
  await fs.writeFile(attachmentPath, "tampered attachment");
  await assert.rejects(
    verifyProductionTraceReceipt({ receiptPath: path.join(dir, "receipt.json"), fillPlanPath: paths.fillPlan }),
    /attachment changed/u,
  );
  await fs.writeFile(attachmentPath, attachmentBytes);

  fillPlan.rows.push({ sheetRow: 19, updates: [{ field: "UID", value: "未留痕_02" }] });
  await fs.writeFile(paths.fillPlan, JSON.stringify(fillPlan), "utf8");
  const extraRow = await runProductionTraceGate({
    packetPath: paths.packet, tracePath: paths.trace, candidatePath, fillPlanPath: paths.fillPlan,
    reportPath: path.join(dir, "report.json"), receiptPath: path.join(dir, "receipt.json"), attachmentRoot,
  });
  assert.ok(extraRow.report.findings.some((finding) => finding.rule === "fill-plan-question-count"));
  assert.ok(extraRow.report.findings.some((finding) => finding.rule === "fill-plan-row-not-traced"));
  fillPlan.rows.pop();

  const productUpdate = fillPlan.rows[0].updates.find((update) => update.field === "产物内容");
  const originalProduct = productUpdate.value;
  productUpdate.value = "门禁前偷偷替换的产物内容";
  await fs.writeFile(paths.fillPlan, JSON.stringify(fillPlan), "utf8");
  const mismatchedPlan = await runProductionTraceGate({
    packetPath: paths.packet, tracePath: paths.trace, candidatePath, fillPlanPath: paths.fillPlan,
    reportPath: path.join(dir, "report.json"), receiptPath: path.join(dir, "receipt.json"), attachmentRoot,
  });
  assert.ok(mismatchedPlan.report.findings.some((finding) => finding.rule === "fill-plan-final-record-mismatch" && finding.field === "产物内容"));
  productUpdate.value = originalProduct;
  await fs.writeFile(paths.fillPlan, JSON.stringify(fillPlan), "utf8");

  trace.questions[0].firstQaFullResult = { pass: false, issues: [{ rule: "附件支撑不足" }] };
  await fs.writeFile(paths.trace, JSON.stringify(trace), "utf8");
  const failed = await runProductionTraceGate({
    packetPath: paths.packet,
    tracePath: paths.trace,
    candidatePath,
    fillPlanPath: paths.fillPlan,
    reportPath: path.join(dir, "report.json"),
    receiptPath: path.join(dir, "receipt.json"),
    attachmentRoot,
  });
  assert.equal(failed.report.status, "FAIL");
  assert.equal(failed.receipt, null);
  assert.ok(failed.report.findings.some((finding) => finding.rule === "first-quality-gate-not-pass"));
});
