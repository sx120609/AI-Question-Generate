import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  registerStructureReceipt,
  reserveProfilesForRun,
  runStructureGate,
} from "./structure_gate.mjs";
import {
  loadStructuralDiversityPolicy,
  verifyReceiptRows,
  visibleCharacterCount,
} from "./structure_fingerprint.mjs";

const policy = await loadStructuralDiversityPolicy();

const headers = [
  "UID",
  "题目",
  "任务类型",
  "一级目录",
  "二级目录",
  "三级目录",
  "任务概括",
  "标注专家工作年限",
  "人类完成时间",
  "相关附件",
  "附件格式",
  "附件内容",
  "产物格式",
  "产物内容",
  "做题关键步骤",
  "标注专家姓名",
];

const columns = "ABCDEFGHIJKLMNOP".split("");

function candidateRow(question) {
  return {
    UID: "沈礼_gate_test_01",
    题目: question,
    任务类型: "L2 流程型",
    一级目录: "投资战略、专业服务与企业经营",
    二级目录: "经营分析",
    三级目录: "异常批次决策复核",
    任务概括: "为到货异常批次建立可追溯的处置和付款判断。",
    标注专家工作年限: "6年",
    人类完成时间: "14h",
    相关附件: "附件一_温控原始记录.xlsx；附件二_运输合同.pdf；附件三_签收记录.pdf",
    附件格式: "xlsx, pdf",
    附件内容: "附件一给出逐箱温度和设备时间，附件二给出2—8℃条款，附件三记录卸货签收时间；缺少月台监控和校准证书。",
    产物格式: "docx, xlsx",
    产物内容: "Word采用决策备忘录，区分合同事实、检测事实和待确认推断；Excel采用证据台账，将箱号、主张、来源、缺口、责任人和解锁条件关联。",
    做题关键步骤: "1. 核验三份附件的来源与版本。\n2. 盘点120箱货物和18箱异常范围。\n3. 提取时间戳、温度与合同条款。\n4. 统一箱号、时间和温度单位。\n5. 对比三方时间线。\n6. 判断各处置路径的证据门槛。\n7. 将箱件分流到接收、隔离、补测和退回路径。\n8. 登记监控、校准证书与照片缺口。\n9. 给出付款与放行建议。\n10. 起草Word决策备忘录。\n11. 建立Excel证据台账。\n12. 复查每项结论能否回到来源。",
    标注专家姓名: "沈礼",
  };
}

const passingQuestion =
  "明天下午的经营评审会要决定华东仓这批恒温试剂是整批接收、折价接收还是退回供应商。仓库今天到货120箱，抽检记录显示其中18箱最高温度达到11.6℃，运输合同约定2—8℃，承运商却认为卸货等待造成了短时升温；采购、质量和仓储目前各拿着一版时间记录，三个时间戳相差最多47分钟。附件里有温控仪原始导出、签收单、运输合同、承运商说明和供应商稳定性资料，但缺少月台监控、温控仪校准证书以及异常箱逐箱照片。会上需要判断现有证据能否支持拒收，若证据不够，应明确哪些箱先隔离、哪些测试先补、谁负责向承运商追证，以及在什么条件下可以改为折价接收。质量负责人会用结果签字，采购还要据此决定是否暂停付款，所以结论要区分合同事实、检测事实和仍待确认的推断。承运商要求今晚确认是否安排返程车辆，仓储则只能再提供48小时隔离库位；如果逾期不答复，供应商会把该批次按已签收处理。现有稳定性资料只覆盖连续超温不超过30分钟的情形，不能直接证明这18箱仍然合格；温控仪导出的设备时间也尚未与仓库服务器时间校准。评审会上除了给出处置结论，还要把补证先后、临时保管责任、付款冻结范围和结论失效条件说清楚，让采购、质量和仓储能按同一套条件执行。隔离期间若出现新的温度波动，仓储需要保留设备原始导出和操作记录；供应商后来补交的每份材料也要标明对应箱号、形成时间和提供人，避免覆盖此前版本。评审秘书还要登记每份材料的版本号、形成时间和提供人，后续补件不得覆盖旧证据，任何处置变化都要说明触发条件。业务团队也要能够从结论反查使用了哪一版记录、哪项合同条款和哪位责任人的确认。请把对各方主张的判断写成可编辑Word决策备忘录，另做一张Excel证据台账，把箱号、温度区间、时间线、证据来源、责任人、处理路径和解锁条件逐项关联；关键结论要能回到原始记录，不能把缺失的监控或校准证书写成已经存在。";

function toTsv(row) {
  return toTsvRows([row]);
}

function toTsvRows(rows) {
  const encode = (value) => String(value ?? "").replace(/\t/g, " ").replace(/\r?\n/g, "\\n");
  return `${headers.join("\t")}\n${rows.map((row) => headers.map((name) => encode(row[name])).join("\t")).join("\n")}\n`;
}

function toPlanRow(row, sheetRow = 901) {
  return {
    dataRow: 2,
    sheetRow,
    updates: headers.map((field, index) => ({
      address: `${columns[index]}${sheetRow}`,
      column: columns[index],
      field,
      value: row[field],
    })),
  };
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "structure-gate-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function createReviewFixture(dir, { requestedBy = "writer-agent" } = {}) {
  const reviewPolicy = structuredClone(policy);
  reviewPolicy.policyId = `${policy.policyId}-review-lock-test`;
  reviewPolicy.lexicalDuplication = {
    ...reviewPolicy.lexicalDuplication,
    questionHardThreshold: 2,
    narrativeHardThreshold: 2,
    stepContextQuestionThreshold: 2,
    stepContextNarrativeThreshold: 2,
    sharedPhraseReviewMinimumCharacters: 10000,
    sharedPhraseHardMinimumCharacters: 10000,
  };
  const first = candidateRow(passingQuestion);
  const second = {
    ...candidateRow(passingQuestion),
    UID: "second_reviewer_lock_row",
  };
  const candidatePath = path.join(dir, "review-candidate.tsv");
  const fillPlanPath = path.join(dir, "review-fill-plan.json");
  const policyPath = path.join(dir, "review-policy.json");
  const reportPath = path.join(dir, "review-report.json");
  const receiptPath = path.join(dir, "review-receipt.json");
  const reviewRequestPath = path.join(dir, "review-request.json");
  const reviewSignoffPath = path.join(dir, "review-signoff.json");
  const registryPath = path.join(dir, "review-registry.json");
  await Promise.all([
    fs.writeFile(candidatePath, toTsvRows([first, second]), "utf8"),
    fs.writeFile(fillPlanPath, JSON.stringify({ rows: [toPlanRow(first, 930), toPlanRow(second, 931)] }), "utf8"),
    fs.writeFile(policyPath, JSON.stringify(reviewPolicy), "utf8"),
  ]);
  return {
    rows: [first, second],
    planRows: [toPlanRow(first, 930), toPlanRow(second, 931)],
    candidatePath,
    fillPlanPath,
    policyPath,
    reportPath,
    receiptPath,
    reviewRequestPath,
    reviewSignoffPath,
    registryPath,
    requestedBy,
  };
}

async function runReviewFixture(fixture, { withSignoff = false } = {}) {
  return runStructureGate({
    candidatePath: fixture.candidatePath,
    fillPlanPath: fixture.fillPlanPath,
    policyPath: fixture.policyPath,
    reportPath: fixture.reportPath,
    receiptPath: fixture.receiptPath,
    reviewRequestPath: fixture.reviewRequestPath,
    reviewSignoffPath: withSignoff ? fixture.reviewSignoffPath : "",
    reviewRequester: fixture.requestedBy,
    registryPath: fixture.registryPath,
  });
}

async function writeReviewSignoff(fixture, overrides = {}) {
  const request = JSON.parse(await fs.readFile(fixture.reviewRequestPath, "utf8"));
  const requestHash = await sha256File(fixture.reviewRequestPath);
  const signoff = {
    kind: "structure-review-signoff",
    requestId: request.requestId,
    bindingHash: request.bindingHash,
    requestHash,
    decision: "APPROVE",
    reviewer: "independent-reviewer",
    rationale: "The matching classifier labels come from distinct reviewed business facts, not copied prose.",
    reviewedAt: new Date().toISOString(),
    ...overrides,
  };
  await fs.writeFile(fixture.reviewSignoffPath, JSON.stringify(signoff), "utf8");
  return { request, requestHash, signoff };
}

test("reserves source-driven slots without assigning a synthetic style passport", async () => {
  await withTempDir(async (dir) => {
    const registryPath = path.join(dir, "registry.json");
    const first = await reserveProfilesForRun({
      runId: "gate-test-a",
      count: 2,
      outPath: path.join(dir, "plan-a.json"),
      registryPath,
    });
    const second = await reserveProfilesForRun({
      runId: "gate-test-b",
      count: 2,
      outPath: path.join(dir, "plan-b.json"),
      registryPath,
    });
    for (const profile of [...first.profiles, ...second.profiles]) {
      assert.equal(profile.sourceDriven, true);
      assert.equal("openingMode" in profile, false);
      assert.equal("decisionForm" in profile, false);
      assert.equal("productTopology" in profile, false);
    }
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    assert.equal(registry.reservations.length, 2);
  });
});

test("writes a hash-bound receipt only after a full PASS", async () => {
  await withTempDir(async (dir) => {
    assert.ok(visibleCharacterCount(passingQuestion) >= policy.questionLength.hardMinimumVisibleCharacters);
    const row = candidateRow(passingQuestion);
    const planRow = toPlanRow(row);
    const candidatePath = path.join(dir, "candidate.tsv");
    const fillPlanPath = path.join(dir, "fill-plan.json");
    const reportPath = path.join(dir, "report.json");
    const receiptPath = path.join(dir, "receipt.json");
    await fs.writeFile(candidatePath, toTsv(row), "utf8");
    await fs.writeFile(fillPlanPath, JSON.stringify({ rows: [planRow] }), "utf8");

    const result = await runStructureGate({
      candidatePath,
      fillPlanPath,
      reportPath,
      receiptPath,
      registryPath: path.join(dir, "empty-registry.json"),
    });

    assert.equal(result.report.status, "PASS");
    assert.equal(result.receipt.status, "PASS");
    assert.equal(verifyReceiptRows(result.receipt, [planRow], policy).ok, true);
    await fs.access(receiptPath);
  });
});

test("blocks REVIEW, emits a pending request, and removes a stale receipt", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createReviewFixture(dir);
    await fs.writeFile(fixture.receiptPath, "stale receipt", "utf8");

    const result = await runReviewFixture(fixture);

    assert.equal(result.report.status, "REVIEW");
    assert.equal(result.report.ok, false);
    assert.equal(result.receipt, null);
    assert.equal(result.reviewRequest.status, "PENDING_REVIEW");
    assert.equal(result.report.reviewAuthorization.status, "PENDING_REVIEW");
    assert.equal(result.report.reviewAuthorization.requestHash, await sha256File(fixture.reviewRequestPath));
    await assert.rejects(fs.access(fixture.receiptPath), /ENOENT/);

    const reportWithComment = JSON.parse(await fs.readFile(fixture.reportPath, "utf8"));
    reportWithComment.manualComment = "APPROVE - ordinary report comments are not signoffs";
    await fs.writeFile(fixture.reportPath, JSON.stringify(reportWithComment), "utf8");
    const rerun = await runReviewFixture(fixture);
    assert.equal(rerun.receipt, null);
    await assert.rejects(fs.access(fixture.receiptPath), /ENOENT/);
  });
});

test("rejects a signoff with the wrong request hash and leaves no receipt", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createReviewFixture(dir);
    await runReviewFixture(fixture);
    await writeReviewSignoff(fixture, { requestHash: "0".repeat(64) });
    await fs.writeFile(fixture.receiptPath, "stale receipt", "utf8");

    await assert.rejects(
      runReviewFixture(fixture, { withSignoff: true }),
      /requestHash mismatch/i,
    );
    await assert.rejects(fs.access(fixture.receiptPath), /ENOENT/);
  });
});

test("rejects self-signoff even when all hashes match", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createReviewFixture(dir, { requestedBy: "same-agent" });
    await runReviewFixture(fixture);
    await writeReviewSignoff(fixture, { reviewer: "same-agent" });

    await assert.rejects(
      runReviewFixture(fixture, { withSignoff: true }),
      /self-signoff|independent from requester/i,
    );
    await assert.rejects(fs.access(fixture.receiptPath), /ENOENT/);
  });
});

test("a valid independent APPROVE signoff authorizes a hash-bound REVIEW receipt", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createReviewFixture(dir);
    await runReviewFixture(fixture);
    const { signoff } = await writeReviewSignoff(fixture);

    const result = await runReviewFixture(fixture, { withSignoff: true });
    const reviewPolicy = await loadStructuralDiversityPolicy(fixture.policyPath);
    assert.equal(result.report.status, "REVIEW");
    assert.equal(result.report.ok, false);
    assert.equal(result.receipt.status, "PASS");
    assert.equal(result.receipt.gateStatus, "REVIEW");
    assert.equal(result.receipt.authorizationMode, "INDEPENDENT_REVIEW");
    assert.equal(result.receipt.reviewAuthorization.status, "APPROVED");
    assert.equal(result.receipt.reviewAuthorization.reviewer, "independent-reviewer");
    assert.equal(result.receipt.reviewAuthorization.requestHash, await sha256File(fixture.reviewRequestPath));
    assert.equal(result.receipt.reviewAuthorization.signoffHash, await sha256File(fixture.reviewSignoffPath));
    assert.deepEqual(result.receipt.reviewAuthorization, result.report.reviewAuthorization);
    assert.equal(verifyReceiptRows(result.receipt, fixture.planRows, reviewPolicy).ok, true);

    const originalSignoffText = JSON.stringify(signoff);
    await fs.writeFile(
      fixture.reviewSignoffPath,
      JSON.stringify({ ...signoff, rationale: `${signoff.rationale} tampered` }),
      "utf8",
    );
    await assert.rejects(
      registerStructureReceipt({
        receiptPath: fixture.receiptPath,
        status: "reserved",
        registryPath: fixture.registryPath,
        policyPath: fixture.policyPath,
      }),
      /signoff hash mismatch/i,
    );

    await fs.writeFile(fixture.reviewSignoffPath, originalSignoffText, "utf8");
    const registered = await registerStructureReceipt({
      receiptPath: fixture.receiptPath,
      status: "reserved",
      registryPath: fixture.registryPath,
      policyPath: fixture.policyPath,
    });
    assert.equal(registered.registered, 2);
  });
});

test("a reviewed multi-row receipt can advance from reserved to submitted", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createReviewFixture(dir);
    await runReviewFixture(fixture);
    await writeReviewSignoff(fixture);
    await runReviewFixture(fixture, { withSignoff: true });

    await registerStructureReceipt({
      receiptPath: fixture.receiptPath,
      status: "reserved",
      registryPath: fixture.registryPath,
      policyPath: fixture.policyPath,
    });
    await registerStructureReceipt({
      receiptPath: fixture.receiptPath,
      status: "submitted",
      registryPath: fixture.registryPath,
      policyPath: fixture.policyPath,
    });

    const registry = JSON.parse(await fs.readFile(fixture.registryPath, "utf8"));
    assert.equal(registry.entries.length, 2);
    assert.ok(registry.entries.every((entry) => entry.status === "submitted"));
  });
});

test("a valid REJECT signoff remains blocked", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createReviewFixture(dir);
    await runReviewFixture(fixture);
    await writeReviewSignoff(fixture, { decision: "REJECT", rationale: "The two rows are not sufficiently distinct." });

    const result = await runReviewFixture(fixture, { withSignoff: true });
    assert.equal(result.report.status, "REVIEW");
    assert.equal(result.report.reviewAuthorization.status, "REJECTED");
    assert.equal(result.receipt, null);
    await assert.rejects(fs.access(fixture.receiptPath), /ENOENT/);
  });
});

test("accepts a fill plan that intentionally writes only narrative columns", async () => {
  await withTempDir(async (dir) => {
    const row = candidateRow(passingQuestion);
    const planRow = toPlanRow(row);
    const writable = new Set(["题目", "任务概括", "附件内容", "产物内容", "做题关键步骤"]);
    planRow.updates = planRow.updates.filter((item) => writable.has(item.field));
    const candidatePath = path.join(dir, "candidate.tsv");
    const fillPlanPath = path.join(dir, "fill-plan.json");
    const reportPath = path.join(dir, "report.json");
    const receiptPath = path.join(dir, "receipt.json");
    await fs.writeFile(candidatePath, toTsv(row), "utf8");
    await fs.writeFile(fillPlanPath, JSON.stringify({ rows: [planRow] }), "utf8");

    const result = await runStructureGate({
      candidatePath,
      fillPlanPath,
      reportPath,
      receiptPath,
      registryPath: path.join(dir, "empty-registry.json"),
    });

    assert.equal(result.report.status, "PASS");
    assert.equal(result.receipt.status, "PASS");
    assert.equal(verifyReceiptRows(result.receipt, [planRow], policy).ok, true);
  });
});

test("registers a PASS receipt before submission and advances its history status", async () => {
  await withTempDir(async (dir) => {
    const row = candidateRow(passingQuestion);
    const candidatePath = path.join(dir, "candidate.tsv");
    const fillPlanPath = path.join(dir, "fill-plan.json");
    const reportPath = path.join(dir, "report.json");
    const receiptPath = path.join(dir, "receipt.json");
    const registryPath = path.join(dir, "registry.json");
    await fs.writeFile(candidatePath, toTsv(row), "utf8");
    await fs.writeFile(fillPlanPath, JSON.stringify({ rows: [toPlanRow(row)] }), "utf8");
    await runStructureGate({
      candidatePath,
      fillPlanPath,
      reportPath,
      receiptPath,
      registryPath,
    });

    const reserved = await registerStructureReceipt({ receiptPath, status: "reserved", registryPath });
    assert.equal(reserved.registered, 1);
    let registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    assert.equal(registry.entries[0].status, "reserved");

    await registerStructureReceipt({ receiptPath, status: "submitted", registryPath });
    registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    assert.equal(registry.entries[0].status, "submitted");
  });
});

test("serial registration rejects two stale PASS receipts with the same structure", async () => {
  await withTempDir(async (dir) => {
    const registryPath = path.join(dir, "registry.json");
    const receipts = [];
    for (const [index, uid] of ["沈礼_gate_race_01", "裴硬_gate_race_02"].entries()) {
      const row = { ...candidateRow(passingQuestion), UID: uid, 标注专家姓名: uid.startsWith("裴硬") ? "裴硬" : "沈礼" };
      const candidatePath = path.join(dir, `candidate-${index}.tsv`);
      const fillPlanPath = path.join(dir, `fill-plan-${index}.json`);
      const reportPath = path.join(dir, `report-${index}.json`);
      const receiptPath = path.join(dir, `receipt-${index}.json`);
      await fs.writeFile(candidatePath, toTsv(row), "utf8");
      await fs.writeFile(fillPlanPath, JSON.stringify({ rows: [toPlanRow(row, 910 + index)] }), "utf8");
      const gate = await runStructureGate({
        candidatePath,
        fillPlanPath,
        reportPath,
        receiptPath,
        registryPath,
      });
      assert.equal(gate.report.status, "PASS");
      receipts.push(receiptPath);
    }

    await registerStructureReceipt({ receiptPath: receipts[0], status: "reserved", registryPath });
    await assert.rejects(
      registerStructureReceipt({ receiptPath: receipts[1], status: "reserved", registryPath }),
      /changed or collided/i,
    );
  });
});

test("refuses registration when the gate report is edited after receipt issuance", async () => {
  await withTempDir(async (dir) => {
    const row = candidateRow(passingQuestion);
    const candidatePath = path.join(dir, "candidate.tsv");
    const fillPlanPath = path.join(dir, "fill-plan.json");
    const reportPath = path.join(dir, "report.json");
    const receiptPath = path.join(dir, "receipt.json");
    const registryPath = path.join(dir, "registry.json");
    await fs.writeFile(candidatePath, toTsv(row), "utf8");
    await fs.writeFile(fillPlanPath, JSON.stringify({ rows: [toPlanRow(row)] }), "utf8");
    await runStructureGate({ candidatePath, fillPlanPath, reportPath, receiptPath, registryPath });
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    report.status = "REVIEW";
    await fs.writeFile(reportPath, JSON.stringify(report), "utf8");
    await assert.rejects(
      registerStructureReceipt({ receiptPath, status: "reserved", registryPath }),
      /report hash does not match/i,
    );
  });
});

test("removes a stale receipt when a later candidate fails", async () => {
  await withTempDir(async (dir) => {
    const row = candidateRow("明天开会，请核对附件后给我Word和Excel。");
    const candidatePath = path.join(dir, "candidate.tsv");
    const fillPlanPath = path.join(dir, "fill-plan.json");
    const reportPath = path.join(dir, "report.json");
    const receiptPath = path.join(dir, "receipt.json");
    await fs.writeFile(candidatePath, toTsv(row), "utf8");
    await fs.writeFile(fillPlanPath, JSON.stringify({ rows: [toPlanRow(row)] }), "utf8");
    await fs.writeFile(receiptPath, "stale", "utf8");

    const result = await runStructureGate({
      candidatePath,
      fillPlanPath,
      reportPath,
      receiptPath,
      registryPath: path.join(dir, "empty-registry.json"),
    });

    assert.equal(result.report.status, "FAIL");
    await assert.rejects(fs.access(receiptPath), /ENOENT/);
  });
});
