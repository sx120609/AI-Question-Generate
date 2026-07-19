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
    题目: "运营团队正在复核本季度的合同和回单（包括补充协议）。现有数据口径不一样，所以异常订单和退款情况还要单独标明（以原始记录为准）。帮我把核对结果整理成Word说明和Excel工作簿，让结论能回到金额与时间记录（注明来源位置）。",
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
    inputs: {
      referenceWorkbook: { samples: [{ questionIndex: 1, sheet: "Sheet1", row: 18, attachmentSummary: "来源：https://reference.example/a" }] },
      firstQaPrompt: { sha256: "first-prompt" },
      secondQaPrompt: { sha256: "second-prompt" },
    },
  };
  const firstRawPath = path.join(dir, "first-quality-gate.json");
  const secondRawPath = path.join(dir, "second-language-gate.json");
  const firstRawText = JSON.stringify({
    runnerId: "exact-two-quality-gates-v1",
    sourcePromptHash: "first-prompt",
    parsed: { pass: true, issues: [] },
  });
  const secondRawText = JSON.stringify({
    runnerId: "exact-two-quality-gates-v1",
    sourcePromptHash: "second-prompt",
    acceptedRound: 1,
    attempts: [{ parsed: { conclusion: "通过", modifiedQuestion: record.题目 } }],
  });
  const execution = (stage, rawPath, rawText) => ({
    runnerId: "exact-two-quality-gates-v1",
    provider: "openai-compatible",
    model: "claude-opus-4-8",
    sourcePromptHash: stage === "first-quality-gate" ? "first-prompt" : "second-prompt",
    renderedPromptHash: `${stage}-rendered`,
    rawResponsePath: rawPath,
    rawResponseHash: attachmentHash(rawText),
    completedAt: new Date().toISOString(),
  });
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
      firstQaFullResult: { pass: true, issues: [], execution: execution("first-quality-gate", firstRawPath, firstRawText) },
      firstQaRepairs: [],
      secondQaFullResult: {
        conclusion: "通过",
        modifiedQuestion: record.题目,
        execution: execution("second-language-gate", secondRawPath, secondRawText),
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
    fs.writeFile(firstRawPath, firstRawText, "utf8"),
    fs.writeFile(secondRawPath, secondRawText, "utf8"),
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

test("L1 trace gate requires a real L2-grade attachment while allowing no product format", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-production-trace-gate-"));
  const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const attachmentRoot = path.join(dir, "attachments");
  const attachmentName = "附件一_客服试点需求复核记录.xlsx";
  const attachmentBytes = Buffer.from("l1 specific business attachment fixture");
  await fs.mkdir(attachmentRoot, { recursive: true });
  await fs.writeFile(path.join(attachmentRoot, attachmentName), attachmentBytes);
  const question = "我在企业服务团队负责客服AI试点入口评估。现有知识材料比较分散，三种候选工具对来源展示和权限边界的公开说明也不一致。请核验截至当前能够查到的官方资料，比较三个入口能承担的范围，并把已证实事实、合理推断和待确认项分开。这一轮先形成证据清单，不提前给最终上线结论。";
  const record = {
    UID: "测试_L1_01",
    题目: question,
    任务类型: "L1 探索型",
    一级目录: "科技软件与 AI 工作流",
    二级目录: "企业知识与流程自动化",
    三级目录: "客服AI试点入口初筛",
    任务概括: "核验三个客服AI入口的公开证据和能力边界",
    标注专家工作年限: "硕士",
    人类完成时间: "4H",
    相关附件: attachmentName,
    附件格式: "xlsx",
    附件内容: "附件一记录客服试点对象、2026年7月的需求复核结果和待确认权限项，来源：https://new.example/customer-service-poc",
    产物格式: "",
    产物内容: "一份来源、数据截止日、可回答问题、冲突和缺口组成的证据清单。",
    做题关键步骤: "1、检索官方资料。2、记录来源与数据时间。3、区分事实和推断。4、整理冲突与待确认项。",
    标注专家姓名: "测试",
  };
  const packet = {
    kind: "l1-production-input-packet",
    productionProfile: "l1",
    protocolId: "l1-phase3-samples-two-gates-trace-v1",
    runId: "l1-test",
    status: "READY",
    questionCount: 1,
    inputs: {
      referenceWorkbook: { samples: [{ questionIndex: 1, sheet: "三期示例数据", row: 2, attachmentSummary: "无" }] },
      firstQaPrompt: { sha256: "l1-first" },
      secondQaPrompt: { sha256: "l1-second" },
    },
  };
  const firstRawPath = path.join(dir, "first-quality-gate.json");
  const secondRawPath = path.join(dir, "second-language-gate.json");
  const firstRawText = JSON.stringify({
    runnerId: "exact-two-quality-gates-v3-model-router",
    sourcePromptHash: "l1-first",
    parsed: { pass: true, issues: [] },
  });
  const secondRawText = JSON.stringify({
    runnerId: "exact-two-quality-gates-v3-model-router",
    sourcePromptHash: "l1-second",
    acceptedRound: 1,
    attempts: [{ parsed: { conclusion: "通过", modifiedQuestion: question } }],
  });
  const execution = (stage, rawPath, rawText) => ({
    runnerId: "exact-two-quality-gates-v3-model-router",
    provider: "codex-model",
    model: "gpt-5.6-sol",
    sourcePromptHash: stage === "first-quality-gate" ? "l1-first" : "l1-second",
    renderedPromptHash: `${stage}-rendered`,
    rawResponsePath: rawPath,
    rawResponseHash: hash(rawText),
    completedAt: new Date().toISOString(),
  });
  const trace = {
    kind: "l1-production-trace",
    productionProfile: "l1",
    protocolId: packet.protocolId,
    questions: [{
      recordUid: record.UID,
      referenceLocation: { sheet: "三期示例数据", row: 2 },
      referenceQuestionStructure: Object.fromEntries([
        "businessScene", "coreBlockage", "mainTask", "attachmentSupport",
        "deliverableOrigin", "imitableStructure", "forbiddenReuse",
      ].map((key) => [key, `${key}说明`])),
      referenceAttachmentStructure: "对象记录与公开规则配合",
      newQuestionStructureMapping: "保留来源核验、证据分层和分阶段交互",
      newAttachmentSupport: "对象记录提供真实需求和权限缺口，官方来源只核对平台规则",
      attachmentBuild: {
        attachments: [{
          name: attachmentName,
          sourceUrl: "https://new.example/customer-service-poc",
          classification: "specific-business",
          objectLevel: true,
          timeAnchor: "2026年7月客服AI试点复核",
          specificityEvidence: {
            object: "客服AI试点入口",
            periodOrEvent: "2026年7月需求复核",
            uniqueContent: "记录该试点的实际需求、权限缺口和待确认项",
          },
          summary: "记录客服AI试点对象、需求复核结果和待确认权限项。",
          localPath: attachmentName,
          sha256: hash(attachmentBytes),
        }],
        newQuestionStructureMapping: "保留来源核验、证据分层和分阶段交互",
        newAttachmentSupport: "对象记录提供真实需求和权限缺口，官方来源只核对平台规则",
      },
      formatRequirement: null,
      draftedProductFormats: "",
      deliverableRationale: [],
      firstQaFullResult: { pass: true, issues: [], execution: execution("first-quality-gate", firstRawPath, firstRawText) },
      firstQaRepairs: [],
      secondQaFullResult: {
        conclusion: "通过",
        modifiedQuestion: question,
        execution: execution("second-language-gate", secondRawPath, secondRawText),
      },
      deAiRewrite: {
        kind: "de-ai-question-rewrite",
        policyId: "external-de-ai-rewrite-api-v1",
        provider: "external-rewrite-api",
        selectedAttempt: 1,
        sourceQuestionHash: hash(question),
        rewrittenQuestionHash: hash(question),
        rewrite: { question },
        validation: { pass: true, findings: [] },
      },
      revisionLog: [],
      finalRecord: record,
    }],
  };
  const packetPath = path.join(dir, "packet.json");
  const tracePath = path.join(dir, "trace.json");
  const fillPlanPath = path.join(dir, "fill-plan.json");
  const candidatePath = path.join(dir, "candidate.tsv");
  const fillPlan = {
    rows: [{
      sheetRow: 2,
      updates: fields.filter((field) => field !== "标注专家姓名").map((field) => ({ field, value: record[field] })),
    }],
  };
  await Promise.all([
    fs.writeFile(packetPath, JSON.stringify(packet), "utf8"),
    fs.writeFile(tracePath, JSON.stringify(trace), "utf8"),
    fs.writeFile(fillPlanPath, JSON.stringify(fillPlan), "utf8"),
    fs.writeFile(candidatePath, `${fields.join("\t")}\n${fields.map((field) => String(record[field] ?? "").replace(/\n/gu, "\\n")).join("\t")}\n`, "utf8"),
    fs.writeFile(firstRawPath, firstRawText, "utf8"),
    fs.writeFile(secondRawPath, secondRawText, "utf8"),
  ]);
  const receiptPath = path.join(dir, "receipt.json");
  const result = await runProductionTraceGate({
    packetPath,
    tracePath,
    candidatePath,
    fillPlanPath,
    reportPath: path.join(dir, "report.json"),
    receiptPath,
    attachmentRoot,
  });
  assert.equal(result.report.status, "PASS", JSON.stringify(result.report.findings, null, 2));
  assert.equal(result.report.productFormatDiversity.status, "SKIPPED");
  assert.equal(result.receipt.kind, "l1-production-trace-gate-receipt");
  assert.equal((await verifyProductionTraceReceipt({ receiptPath, fillPlanPath })).ok, true);
});
