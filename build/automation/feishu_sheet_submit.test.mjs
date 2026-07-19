import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readBackCellText,
  submitFeishuSheetPlan,
  validateDropdownValueRanges,
  verifyQuestionPresentationForSubmission,
  verifyReleaseGateForSubmission,
  verifyStructureGateForSubmission,
} from "./feishu_sheet_submit.mjs";
import { calibrateNaturalnessBaseline } from "./naturalness_gate.mjs";
import { runReleaseGate } from "./release_gate.mjs";
import { SCENE_CARD_BUNDLE_KIND, SCENE_CARD_PROTOCOL_ID } from "./scene_card.mjs";

const passingQuestion =
  "2025年12月18日，华东仓库收到供应商发来的120箱恒温试剂，其中18箱的设备记录显示最高温度达到11.6℃，运输合同约定区间为2—8℃。采购、质量和仓储三方掌握的时间记录并不一致：签收单、温控仪导出和承运商说明之间最大相差47分钟，承运商认为升温发生在卸货等待阶段，仓库则认为车辆到场前已经异常。下午的经营评审需要据此决定整批接收、折价接收、隔离复测还是退回供应商，这个决定还会影响本期付款和后续补货。附件包括温控仪原始导出、签收单、运输合同、承运商说明和供应商稳定性资料。稳定性资料只覆盖连续超温不超过30分钟的情形，现有记录缺少月台监控、设备校准证书和异常箱逐箱照片；因此，18箱是否仍然合格不能只看一个最高温度。质量负责人需要把合同事实、检测事实和仍待补证的事项分开，采购还要知道哪些条件成立时可以冻结付款，仓储则需要明确隔离范围、临时保管责任和补证期间的新记录怎么留存。供应商要求当天确认是否安排返程车辆，仓库最多只能再提供48小时隔离库位；如果材料逾期，团队仍需保留旧版本并记录结论为何变化。评审结果还要列清每一种处置路径所需的证据门槛、对应责任人、最后确认时间、解锁条件和失效条件，并让每个箱号都能回查到原始温控数据和签收记录。评审秘书还要求记录每份材料的版本号、形成时间和提供人，后续补件不得覆盖旧证据，任何处置变化都要说明触发条件。业务团队也要能够从结论反查使用了哪一版记录、哪项合同条款和哪位责任人的确认。你帮我把评审材料整理成一份可编辑的Word决策备忘录和一张Excel证据台账，备忘录说明各方主张、处置建议和授权边界，台账逐箱关联温度区间、时间线、证据来源、缺口、责任人和处理结果。";

function planRow(question = "合格题面") {
  return {
    sheetRow: 178,
    updates: [
      { address: "A178", column: "A", field: "UID", value: "沈礼_test_01" },
      { address: "B178", column: "B", field: "题目", value: question },
      { address: "G178", column: "G", field: "任务概括", value: "概括" },
      { address: "L178", column: "L", field: "附件内容", value: "附件内容" },
      { address: "M178", column: "M", field: "产物格式", value: "docx, xlsx" },
      { address: "N178", column: "N", field: "产物内容", value: "产物内容" },
      { address: "O178", column: "O", field: "做题关键步骤", value: "1. 步骤\n2. 步骤" },
    ],
  };
}

function candidateFromPlanRow(row) {
  return Object.fromEntries(row.updates.map((item) => [item.field, item.value]));
}

function toTsv(row) {
  const headers = Object.keys(row);
  const encode = (value) => String(value ?? "").replace(/\t/g, " ").replace(/\r?\n/g, "\\n");
  return `${headers.join("\t")}\n${headers.map((header) => encode(row[header])).join("\t")}\n`;
}

async function withReceipt(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-receipt-test-"));
  try {
    const row = planRow(passingQuestion);
    const candidate = candidateFromPlanRow(row);
    const baseline = calibrateNaturalnessBaseline(
      Array.from({ length: 5 }, (_, index) => ({ ...candidate, UID: `submit_reference_${index + 1}` })),
      { baselineId: "submit-release-test" },
    );
    const candidatePath = path.join(dir, "candidate.tsv");
    const baselinePath = path.join(dir, "baseline.json");
    const fillPlanPath = path.join(dir, "fill-plan.json");
    const receiptPath = path.join(dir, "release-receipt.json");
    const factLedgerPath = path.join(dir, "fact-ledger.json");
    const sceneCardPath = path.join(dir, "scene-cards.json");
    const roleConsistencyReportPath = path.join(dir, "role-consistency-report.json");
    const factLedger = {
      facts: [{ id: "fact-question", text: passingQuestion }],
      materials: [],
      unknowns: [{ id: "unknown-records", text: "月台监控、设备校准证书和异常箱逐箱照片尚未取得" }],
    };
    const factLedgerText = `${JSON.stringify(factLedger, null, 2)}\n`;
    const factLedgerHash = crypto.createHash("sha256").update(factLedgerText).digest("hex");
    const sceneBundle = {
      kind: SCENE_CARD_BUNDLE_KIND,
      protocolId: SCENE_CARD_PROTOCOL_ID,
      schemaVersion: 1,
      factLedgerPath: path.basename(factLedgerPath),
      factLedgerHash,
      cards: [{
        recordUid: candidate.UID,
        sceneCard: {
          schemaVersion: 1,
          policyId: SCENE_CARD_PROTOCOL_ID,
          topicId: "submit-temperature-review",
          personaId: "submit-temperature-requester",
          requester: {
            functionalRole: "质量负责人",
            organizationType: "企业",
            department: "",
            responsibility: "整理温控异常材料供经营评审判断",
            authorityBoundary: "只能整理现有记录，不能替经营评审作最终接收决定",
            recipientRelation: "把资料交给能整理决策文档和证据台账的助手",
          },
          scene: {
            workflowStage: "恒温试剂异常签收后的经营评审准备",
            trigger: "华东仓库收到供应商发来的120箱恒温试剂",
            currentBlockage: "现有记录缺少月台监控、设备校准证书和异常箱逐箱照片",
            mainDecision: "整批接收、折价接收、隔离复测还是退回供应商",
            downstreamUse: "给下午的经营评审判断处置路径",
          },
          informationBoundary: {
            knownFactIds: ["fact-question"],
            availableMaterialIds: [],
            unknowns: ["月台监控、设备校准证书和异常箱逐箱照片尚未取得"],
            forbiddenInferences: ["不能补出缺失记录或替评审确认最终处置"],
          },
          voice: {
            channel: "飞书工作消息",
            formality: "质量负责人向熟悉业务的助手交代评审准备",
            domainVocabulary: ["温控", "签收", "隔离复测"],
            avoidVocabulary: ["证据闭环", "赋能"],
          },
          maskTerms: ["恒温试剂", "华东仓库", "质量负责人", "供应商"],
          evidenceBindings: [
            { claim: "华东仓库收到供应商发来的120箱恒温试剂", factIds: ["fact-question"] },
            { claim: "现有记录缺少月台监控、设备校准证书和异常箱逐箱照片", factIds: ["fact-question"] },
            { claim: "整批接收、折价接收、隔离复测还是退回供应商", factIds: ["fact-question"] },
          ],
        },
        requestContract: {
          requestSpan: "你帮我把评审材料整理成一份可编辑的Word决策备忘录和一张Excel证据台账",
          action: "整理",
          outputs: [
            { format: "docx", humanName: "Word", purpose: "经营评审决策备忘录" },
            { format: "xlsx", humanName: "Excel", purpose: "逐箱证据台账" },
          ],
        },
        roleTrace: {
          blockageSpan: "现有记录缺少月台监控、设备校准证书和异常箱逐箱照片",
          motivationSpan: "下午的经营评审需要据此决定整批接收、折价接收、隔离复测还是退回供应商",
          downstreamUseSpan: "评审结果还要列清每一种处置路径所需的证据门槛、对应责任人、最后确认时间、解锁条件和失效条件",
        },
        usedFactIds: ["fact-question"],
        deliberatelyOmitted: [],
      }],
    };
    await Promise.all([
      fs.writeFile(candidatePath, toTsv(candidate), "utf8"),
      fs.writeFile(baselinePath, JSON.stringify(baseline), "utf8"),
      fs.writeFile(fillPlanPath, JSON.stringify({ rows: [row] }), "utf8"),
      fs.writeFile(factLedgerPath, factLedgerText, "utf8"),
      fs.writeFile(sceneCardPath, `${JSON.stringify(sceneBundle, null, 2)}\n`, "utf8"),
    ]);
    const gate = await runReleaseGate({
      candidatePath,
      baselinePath,
      naturalnessReportPath: path.join(dir, "naturalness-report.json"),
      sceneCardPath,
      roleConsistencyReportPath,
      fillPlanPath,
      structureReportPath: path.join(dir, "structure-report.json"),
      structureReceiptPath: path.join(dir, "structure-receipt.json"),
      releaseReceiptPath: receiptPath,
      registryPath: path.join(dir, "registry.json"),
    });
    assert.equal(gate.ok, true);
    return await fn({ dir, row, receiptPath, structureReceiptPath: path.join(dir, "structure-receipt.json") });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("accepts an unchanged narrative plan with a combined release receipt", async () => {
  await withReceipt(async ({ row, receiptPath }) => {
    const result = await verifyReleaseGateForSubmission({
      plan: { rows: [row] },
      rows: [178],
      valueRanges: [{ address: "B178" }],
      receiptPath,
      planPath: "plan.json",
    });
    assert.equal(result.required, true);
    assert.equal(result.verified, true);
    assert.equal(result.roleConsistencyStatus, "PASS");
  });
});

test("rejects a bare structure receipt at the submission boundary", async () => {
  await withReceipt(async ({ row, structureReceiptPath }) => {
    await assert.rejects(
      verifyStructureGateForSubmission({
        plan: { rows: [row] },
        rows: [178],
        valueRanges: [{ address: "B178" }],
        receiptPath: structureReceiptPath,
        planPath: "plan.json",
      }),
      /not a combined release-gate receipt/i,
    );
  });
});

test("rejects a narrative edit made after the gate", async () => {
  await withReceipt(async ({ row, receiptPath }) => {
    const edited = planRow(`${row.updates.find((item) => item.column === "B").value}，门禁后被修改`);
    await assert.rejects(
      verifyStructureGateForSubmission({
        plan: { rows: [edited] },
        rows: [178],
        valueRanges: [{ address: "B178" }],
        receiptPath,
        planPath: "plan.json",
      }),
      /receipt validation failed/i,
    );
  });
});

test("requires a receipt for narrative fields but not format-only maintenance", async () => {
  const row = planRow();
  await assert.rejects(
    verifyStructureGateForSubmission({
      plan: { rows: [row] },
      rows: [178],
      valueRanges: [{ address: "B178" }],
      receiptPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
      planPath: "plan.json",
    }),
    /receipt is required/i,
  );
  const maintenance = await verifyStructureGateForSubmission({
    plan: { rows: [row] },
    rows: [178],
    valueRanges: [{ address: "M178" }],
    planPath: "plan.json",
  });
  assert.equal(maintenance.required, false);
});

test("dry-run verifies a supplied receipt before producing value ranges", async () => {
  await withReceipt(async ({ dir, row, receiptPath }) => {
    const planPath = path.join(dir, "plan.json");
    const outDir = path.join(dir, "dry-run");
    await fs.writeFile(planPath, JSON.stringify({ rows: [row], startRow: 178, count: 1 }), "utf8");
    const result = await submitFeishuSheetPlan({
      planPath,
      spreadsheetToken: "test-token",
      sheetId: "sheet-id",
      rows: [178],
      columns: ["B", "G", "L", "N", "O"],
      outDir,
      apply: false,
      verify: false,
      buildAttachments: false,
      testOnlyBypassProductionProtocol: true,
      // Backward-compatible option name; the file itself must be a release receipt.
      structureReceiptPath: receiptPath,
    });
    assert.equal(result.releaseGate.required, true);
    assert.equal(result.releaseGate.verified, true);
    assert.equal(result.valueRangeCount, 5);
  });
});

test("normalizes Feishu rich-text fragments before verification", () => {
  assert.equal(
    readBackCellText([{ text: "资料" }, { value: "来源" }, [{ rich_text: "：" }, { text: "官网" }]]),
    "资料来源：官网",
  );
});

test("accepts natural paragraphs and still blocks specification prose", () => {
  assert.throws(
    () => verifyQuestionPresentationForSubmission({
      valueRanges: [{ address: "B122", values: [["Word需要写处理结论，Excel按业务类型分项。"]] }],
    }),
    /direct user request/i,
  );

  const future = verifyQuestionPresentationForSubmission({
    valueRanges: [{ address: "B122", values: [["我在项目组负责整理现有材料。\n请基于附件给我做一份Word说明和一张Excel工作簿。"]] }],
  });
  assert.equal(future.mode, "narrative-no-blank-lines-v5");
  assert.equal(future.paragraphCounts.B122, 2);
});

test("rejects blank lines in attachment content and accepts single line breaks", () => {
  assert.throws(
    () => verifyQuestionPresentationForSubmission({
      valueRanges: [{ address: "L141", values: [["附件一：材料说明。\n\n附件二：补充材料。"]] }],
    }),
    /附件内容 must not contain blank lines/i,
  );
  const result = verifyQuestionPresentationForSubmission({
    valueRanges: [{ address: "L141", values: [["附件一：材料说明。\n附件二：补充材料。"]] }],
  });
  assert.equal(result.mode, "narrative-no-blank-lines-v5");
  assert.equal(result.attachmentContentLineCounts.L141, 2);
});

test("accepts values that are real options in Feishu dropdown cells", () => {
  const result = validateDropdownValueRanges({
    sheetId: "sheet-id",
    valueRanges: [
      { address: "C15", range: "sheet-id!C15:C15", values: [["L1 探索型"]] },
      { address: "D15", range: "sheet-id!D15:D15", values: [["法律、政务与公共服务"]] },
    ],
    dataValidations: [
      {
        dataValidationType: "list",
        conditionValues: ["L1 探索型", "L2 流程型", "L3 系统型"],
        options: { multipleValues: false },
        ranges: ["sheet-id!C2:C20"],
      },
      {
        dataValidationType: "list",
        conditionValues: ["法律、政务与公共服务", "投资战略、专业服务与企业经营"],
        options: { multipleValues: false },
        ranges: ["sheet-id!D2:D20"],
      },
    ],
  });
  assert.equal(result.verified, true);
  assert.equal(result.checkedCells, 2);
});

test("rejects plain text that is not a configured Feishu dropdown option", () => {
  assert.throws(
    () => validateDropdownValueRanges({
      sheetId: "sheet-id",
      valueRanges: [
        { address: "D15", range: "sheet-id!D15:D15", values: [["汽车销售与售后服务"]] },
      ],
      dataValidations: [
        {
          dataValidationType: "list",
          conditionValues: ["法律、政务与公共服务", "投资战略、专业服务与企业经营"],
          options: { multipleValues: false },
          ranges: ["sheet-id!D2:D20"],
        },
      ],
    }),
    /D15 contains values outside the configured dropdown/i,
  );
});
