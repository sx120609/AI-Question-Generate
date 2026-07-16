import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { calibrateNaturalnessBaseline, measureNaturalnessRow } from "./naturalness_gate.mjs";
import {
  RELEASE_GATE_ID,
  RELEASE_SCHEMA_VERSION,
  runReleaseGate,
  verifyReleaseReceipt,
  verifyReleaseReceiptUpdates,
} from "./release_gate.mjs";
import {
  SCENE_CARD_BUNDLE_KIND,
  SCENE_CARD_GATE_ID,
  SCENE_CARD_PROTOCOL_ID,
} from "./scene_card.mjs";
import { loadStructuralDiversityPolicy } from "./structure_fingerprint.mjs";
import { registerStructureReceipt } from "./structure_gate.mjs";

const defaultPolicy = await loadStructuralDiversityPolicy();

function candidateRow() {
  return {
    UID: "release_gate_test_01",
    题目: "2025年12月，公司正在核对订单A-102，收入100万元，成本60万元，毛利40万元，财务负责人要比较原始台账和银行流水。你帮我整理成一份Word复核说明和一张Excel工作簿，把差异来源、计算过程和订单结论对应起来。",
    产物格式: "docx, xlsx",
    做题关键步骤: "1. 核对订单A-102的台账与流水。\n2. 复算收入、成本和毛利。\n3. 记录差异来源并形成结论。",
  };
}

function toTsv(rows) {
  const headers = Object.keys(rows[0]);
  const encode = (value) => String(value ?? "").replace(/\t/g, " ").replace(/\r?\n/g, "\\n");
  return `${headers.join("\t")}\n${rows.map((row) => headers.map((header) => encode(row[header])).join("\t")).join("\n")}\n`;
}

function toPlanRow(row) {
  return {
    dataRow: 2,
    sheetRow: 901,
    updates: [
      { address: "A901", column: "A", field: "UID", value: row.UID },
      { address: "B901", column: "B", field: "题目", value: row.题目 },
      { address: "O901", column: "O", field: "做题关键步骤", value: row.做题关键步骤 },
    ],
  };
}

async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeSceneCardFixture({ row, factLedgerPath, sceneCardPath }) {
  const question = row["题目"];
  const requestStart = question.indexOf("你帮我");
  assert.notEqual(requestStart, -1, "release fixture must contain a direct request span");
  const requestSpan = question.slice(requestStart);
  const factLedger = {
    facts: [{ id: "fact-order-01", text: question }],
    unknowns: [{ id: "unknown-approval", text: "订单差异最终是否被负责人接受" }],
  };
  const factLedgerText = `${JSON.stringify(factLedger, null, 2)}\n`;
  await fs.writeFile(factLedgerPath, factLedgerText, "utf8");
  const bundle = {
    kind: SCENE_CARD_BUNDLE_KIND,
    protocolId: SCENE_CARD_PROTOCOL_ID,
    schemaVersion: 1,
    factLedgerPath,
    factLedgerHash: sha256Text(factLedgerText),
    cards: [{
      recordUid: row.UID,
      sceneCard: {
        schemaVersion: 1,
        policyId: SCENE_CARD_PROTOCOL_ID,
        topicId: "topic-release-01",
        personaId: "persona-release-01",
        requester: {
          functionalRole: "复核经办人",
          organizationType: "业务团队",
          department: "",
          responsibility: "核对现有订单台账和流水",
          authorityBoundary: "只能整理差异，不能替代负责人作出最终结论",
          recipientRelation: "把材料交给能整理文档和工作簿的助手",
        },
        scene: {
          workflowStage: "订单复核",
          trigger: "开始核对订单A-102",
          currentBlockage: "台账和银行流水需要逐项比较",
          mainDecision: "明确订单差异及复核结论",
          downstreamUse: "供财务负责人复核",
        },
        informationBoundary: {
          knownFactIds: ["fact-order-01"],
          availableMaterialIds: [],
          unknowns: ["订单差异最终是否被负责人接受"],
          forbiddenInferences: ["不得推断负责人尚未确认的结论"],
        },
        voice: {
          channel: "工作消息",
          formality: "简洁直接",
          domainVocabulary: ["台账", "流水"],
          avoidVocabulary: ["闭环", "赋能"],
        },
        maskTerms: ["订单A-102", "银行流水"],
        evidenceBindings: [
          { claim: "开始核对订单A-102", factIds: ["fact-order-01"] },
          { claim: "台账和银行流水需要逐项比较", factIds: ["fact-order-01"] },
          { claim: "明确订单差异及复核结论", factIds: ["fact-order-01"] },
        ],
      },
      requestContract: {
        requestSpan,
        action: "帮我整理成",
        outputs: [
          { format: "docx", humanName: "Word复核说明", purpose: "说明差异和复核结论" },
          { format: "xlsx", humanName: "Excel工作簿", purpose: "记录计算过程和订单结论" },
        ],
      },
      roleTrace: {
        blockageSpan: "公司正在核对订单A-102",
        motivationSpan: "",
        downstreamUseSpan: "财务负责人要比较原始台账和银行流水",
      },
      usedFactIds: ["fact-order-01"],
      deliberatelyOmitted: [],
    }],
  };
  await fs.writeFile(sceneCardPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { bundle, factLedger };
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-gate-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function testPolicy() {
  const policy = structuredClone(defaultPolicy);
  policy.policyId = `${defaultPolicy.policyId}-release-gate-test`;
  policy.questionLength.hardMinimumVisibleCharacters = 1;
  policy.questionLength.minimumCoreSceneCharacters = 1;
  policy.questionLength.recommendedMinimumVisibleCharacters = 1;
  policy.informationCoverage.minimumDetectedUnits = 0;
  policy.informationCoverage.requiredGroups = [];
  return policy;
}

async function createFixture(dir, { baselineMode = "PASS", suffix = "" } = {}) {
  const root = path.join(dir, suffix || "fixture");
  await fs.mkdir(root, { recursive: true });
  const row = candidateRow();
  const planRow = toPlanRow(row);
  const baseline = calibrateNaturalnessBaseline(
    Array.from({ length: 5 }, (_, index) => ({ ...row, UID: `reference_${index + 1}` })),
    { baselineId: `release-test-${baselineMode.toLowerCase()}` },
  );
  if (baselineMode === "REVIEW") {
    baseline.thresholds.row.concreteFactsPer100Chars.review = measureNaturalnessRow(row).concreteFactsPer100Chars + 1;
  } else if (baselineMode === "FAIL") {
    baseline.thresholds.row.disclaimerSentenceDensity.review = -2;
    baseline.thresholds.row.disclaimerSentenceDensity.fail = -1;
    baseline.thresholds.row.disclaimerSentenceCount.review = -2;
    baseline.thresholds.row.disclaimerSentenceCount.fail = -1;
    baseline.thresholds.row.minimumDisclaimerSentencesForFail.value = 0;
  }
  const policy = testPolicy();
  const paths = {
    candidatePath: path.join(root, "candidate.tsv"),
    baselinePath: path.join(root, "baseline.json"),
    naturalnessReportPath: path.join(root, "naturalness-report.json"),
    naturalnessReviewRequestPath: path.join(root, "naturalness-request.json"),
    naturalnessReviewSignoffPath: path.join(root, "naturalness-signoff.json"),
    factLedgerPath: path.join(root, "fact-ledger.json"),
    sceneCardPath: path.join(root, "scene-cards.json"),
    roleConsistencyReportPath: path.join(root, "role-consistency-report.json"),
    fillPlanPath: path.join(root, "fill-plan.json"),
    structureReportPath: path.join(root, "structure-report.json"),
    structureReceiptPath: path.join(root, "structure-receipt.json"),
    releaseReceiptPath: path.join(root, "release-receipt.json"),
    registryPath: path.join(root, "registry.json"),
    policyPath: path.join(root, "policy.json"),
  };
  await Promise.all([
    fs.writeFile(paths.candidatePath, toTsv([row]), "utf8"),
    fs.writeFile(paths.baselinePath, JSON.stringify(baseline), "utf8"),
    fs.writeFile(paths.fillPlanPath, JSON.stringify({ rows: [planRow] }), "utf8"),
    fs.writeFile(paths.policyPath, JSON.stringify(policy), "utf8"),
  ]);
  await writeSceneCardFixture({
    row,
    factLedgerPath: paths.factLedgerPath,
    sceneCardPath: paths.sceneCardPath,
  });
  return { ...paths, row, planRow, baselineMode };
}

function gateOptions(fixture, { withNaturalnessSignoff = false } = {}) {
  return {
    candidatePath: fixture.candidatePath,
    baselinePath: fixture.baselinePath,
    naturalnessReportPath: fixture.naturalnessReportPath,
    naturalnessReviewRequestPath: fixture.naturalnessReviewRequestPath,
    naturalnessReviewSignoffPath: withNaturalnessSignoff ? fixture.naturalnessReviewSignoffPath : "",
    naturalnessReviewRequester: "writer-agent",
    sceneCardPath: fixture.sceneCardPath,
    roleConsistencyReportPath: fixture.roleConsistencyReportPath,
    fillPlanPath: fixture.fillPlanPath,
    structureReportPath: fixture.structureReportPath,
    structureReceiptPath: fixture.structureReceiptPath,
    releaseReceiptPath: fixture.releaseReceiptPath,
    registryPath: fixture.registryPath,
    policyPath: fixture.policyPath,
  };
}

async function writeNaturalnessSignoff(fixture, overrides = {}) {
  const request = JSON.parse(await fs.readFile(fixture.naturalnessReviewRequestPath, "utf8"));
  const signoff = {
    kind: "naturalness-review-signoff",
    requestId: request.requestId,
    bindingHash: request.bindingHash,
    requestHash: await sha256File(fixture.naturalnessReviewRequestPath),
    decision: "APPROVE",
    reviewer: "independent-reviewer",
    rationale: "Concrete facts and sentence rhythm were independently compared with the approved baseline.",
    reviewedAt: new Date().toISOString(),
    ...overrides,
  };
  await fs.writeFile(fixture.naturalnessReviewSignoffPath, JSON.stringify(signoff), "utf8");
  return signoff;
}

test("PASS naturalness plus a structure receipt produces a verifiable release receipt", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createFixture(dir);
    const result = await runReleaseGate(gateOptions(fixture));
    assert.equal(result.ok, true);
    assert.equal(result.receipt.kind, "release-gate-receipt");
    assert.equal(result.receipt.releaseGateId, RELEASE_GATE_ID);
    assert.equal(result.receipt.releaseSchemaVersion, RELEASE_SCHEMA_VERSION);
    assert.equal(result.receipt.naturalness.status, "PASS");
    assert.equal(result.receipt.naturalness.authorizationMode, "DIRECT_PASS");
    assert.equal(result.receipt.roleConsistency.status, "PASS");
    assert.equal(result.receipt.roleConsistency.gateId, SCENE_CARD_GATE_ID);
    assert.equal(result.receipt.roleConsistency.protocolId, SCENE_CARD_PROTOCOL_ID);
    assert.deepEqual(result.receipt.rowHashes, result.structureReceipt.rowHashes);

    const verification = await verifyReleaseReceipt({
      receiptPath: fixture.releaseReceiptPath,
      rows: [fixture.planRow],
      policyPath: fixture.policyPath,
    });
    assert.equal(verification.ok, true, verification.errors?.join("; "));
    assert.equal(verification.roleConsistencyReport.status, "PASS");
    const registration = await registerStructureReceipt({
      receiptPath: fixture.releaseReceiptPath,
      status: "reserved",
      registryPath: fixture.registryPath,
      policyPath: fixture.policyPath,
    });
    assert.equal(registration.registered, 1);
    await fs.appendFile(fixture.structureReceiptPath, " ", "utf8");
    const changedStructureReceipt = await verifyReleaseReceipt({
      receiptPath: fixture.releaseReceiptPath,
      rows: [fixture.planRow],
      policyPath: fixture.policyPath,
    });
    assert.equal(changedStructureReceipt.ok, false);
    assert.match(changedStructureReceipt.errors.join("; "), /structure receipt hash mismatch/i);
  });
});

test("a bare structure receipt cannot masquerade as a release receipt", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createFixture(dir);
    await runReleaseGate(gateOptions(fixture));
    const verification = await verifyReleaseReceipt({
      receiptPath: fixture.structureReceiptPath,
      rows: [fixture.planRow],
      policyPath: fixture.policyPath,
    });
    assert.equal(verification.ok, false);
    assert.match(verification.errors.join("; "), /not a combined release-gate receipt/i);
  });
});

test("naturalness FAIL and unsigned REVIEW both delete a stale release receipt", async () => {
  await withTempDir(async (dir) => {
    for (const mode of ["FAIL", "REVIEW"]) {
      const fixture = await createFixture(dir, { baselineMode: mode, suffix: mode.toLowerCase() });
      await fs.writeFile(fixture.releaseReceiptPath, "stale", "utf8");
      const result = await runReleaseGate(gateOptions(fixture));
      assert.equal(result.ok, false);
      assert.equal(result.phase, "naturalness");
      assert.equal(result.status, mode);
      await assert.rejects(fs.access(fixture.releaseReceiptPath), /ENOENT/);
      if (mode === "REVIEW") await fs.access(fixture.naturalnessReviewRequestPath);
      await assert.rejects(fs.access(fixture.structureReportPath), /ENOENT/);
    }
  });
});

test("candidate, baseline, and naturalness-report tampering invalidate a release receipt", async () => {
  await withTempDir(async (dir) => {
    for (const target of ["candidate", "baseline", "report"]) {
      const fixture = await createFixture(dir, { suffix: target });
      await runReleaseGate(gateOptions(fixture));
      const targetPath = target === "candidate"
        ? fixture.candidatePath
        : target === "baseline"
          ? fixture.baselinePath
          : fixture.naturalnessReportPath;
      await fs.appendFile(targetPath, target === "report" ? " " : "\n", "utf8");
      const verification = await verifyReleaseReceipt({
        receiptPath: fixture.releaseReceiptPath,
        rows: [fixture.planRow],
        policyPath: fixture.policyPath,
      });
      assert.equal(verification.ok, false, target);
      assert.match(verification.errors.join("; "), /hash mismatch|Unexpected non-whitespace|JSON|evaluation/i);
    }
  });
});

test("naturalness self-signoff, wrong request hash, and REJECT decisions are rejected", async () => {
  await withTempDir(async (dir) => {
    for (const variant of ["self", "hash", "reject"]) {
      const fixture = await createFixture(dir, { baselineMode: "REVIEW", suffix: variant });
      await runReleaseGate(gateOptions(fixture));
      await writeNaturalnessSignoff(
        fixture,
        variant === "self"
          ? { reviewer: "writer-agent" }
          : variant === "hash"
            ? { requestHash: "0".repeat(64) }
            : { decision: "REJECT", rationale: "The batch still resembles the rejected template family." },
      );
      await fs.writeFile(fixture.releaseReceiptPath, "stale", "utf8");
      await assert.rejects(
        runReleaseGate(gateOptions(fixture, { withNaturalnessSignoff: true })),
        variant === "self"
          ? /self-signoff|independent from requester/i
          : variant === "hash"
            ? /requestHash mismatch/i
            : /decision is not APPROVE/i,
      );
      await assert.rejects(fs.access(fixture.releaseReceiptPath), /ENOENT/);
    }
  });
});

test("a valid independent naturalness signoff survives the second-stage run", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createFixture(dir, { baselineMode: "REVIEW" });
    const first = await runReleaseGate(gateOptions(fixture));
    assert.equal(first.status, "REVIEW");
    const originalReportHash = await sha256File(fixture.naturalnessReportPath);
    await writeNaturalnessSignoff(fixture);

    const second = await runReleaseGate(gateOptions(fixture, { withNaturalnessSignoff: true }));
    assert.equal(second.ok, true);
    assert.equal(second.receipt.naturalness.status, "REVIEW");
    assert.equal(second.receipt.naturalness.authorizationMode, "INDEPENDENT_REVIEW");
    assert.equal(second.receipt.naturalness.reviewAuthorization.reviewer, "independent-reviewer");
    assert.equal(await sha256File(fixture.naturalnessReportPath), originalReportHash);
    const verification = await verifyReleaseReceipt({
      receiptPath: fixture.releaseReceiptPath,
      rows: [fixture.planRow],
      policyPath: fixture.policyPath,
    });
    assert.equal(verification.ok, true, verification.errors?.join("; "));

    const signoff = JSON.parse(await fs.readFile(fixture.naturalnessReviewSignoffPath, "utf8"));
    await fs.writeFile(
      fixture.naturalnessReviewSignoffPath,
      JSON.stringify({ ...signoff, rationale: `${signoff.rationale} tampered` }),
      "utf8",
    );
    const tampered = await verifyReleaseReceipt({
      receiptPath: fixture.releaseReceiptPath,
      rows: [fixture.planRow],
      policyPath: fixture.policyPath,
    });
    assert.equal(tampered.ok, false);
    assert.match(tampered.errors.join("; "), /requestHash mismatch|authorization metadata mismatch/i);
  });
});

test("scene-card, fact-ledger, and role-report tampering invalidate a v2 release receipt", async () => {
  await withTempDir(async (dir) => {
    for (const target of ["scene-card", "fact-ledger", "role-report"]) {
      const fixture = await createFixture(dir, { suffix: `role-${target}` });
      const result = await runReleaseGate(gateOptions(fixture));
      assert.equal(result.ok, true);
      const targetPath = target === "scene-card"
        ? fixture.sceneCardPath
        : target === "fact-ledger"
          ? fixture.factLedgerPath
          : fixture.roleConsistencyReportPath;
      await fs.appendFile(targetPath, " ", "utf8");
      const verification = await verifyReleaseReceipt({
        receiptPath: fixture.releaseReceiptPath,
        rows: [fixture.planRow],
        policyPath: fixture.policyPath,
      });
      assert.equal(verification.ok, false, target);
      assert.match(
        verification.errors.join("; "),
        /role-consistency|scene-card|fact.ledger|report hash|current candidate/i,
      );
    }
  });
});

test("a role-consistency FAIL blocks release with no override and removes a stale receipt", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createFixture(dir, { suffix: "role-fail" });
    const bundle = JSON.parse(await fs.readFile(fixture.sceneCardPath, "utf8"));
    bundle.cards[0].requestContract.requestSpan = "Word复核说明";
    await fs.writeFile(fixture.sceneCardPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    await fs.writeFile(fixture.releaseReceiptPath, "stale", "utf8");

    const result = await runReleaseGate(gateOptions(fixture));
    assert.equal(result.ok, false);
    assert.equal(result.phase, "role-consistency");
    assert.equal(result.status, "FAIL");
    assert.equal(result.receipt, null);
    await assert.rejects(fs.access(fixture.releaseReceiptPath), /ENOENT/);
    await assert.rejects(fs.access(fixture.structureReportPath), /ENOENT/);
  });
});

test("legacy v1 release receipts remain historical-only", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createFixture(dir, { suffix: "legacy" });
    await runReleaseGate(gateOptions(fixture));
    const receipt = JSON.parse(await fs.readFile(fixture.releaseReceiptPath, "utf8"));
    receipt.releaseGateId = "combined-release-gate-v1";
    receipt.releaseSchemaVersion = 1;
    await fs.writeFile(fixture.releaseReceiptPath, JSON.stringify(receipt), "utf8");

    const verification = await verifyReleaseReceipt({
      receiptPath: fixture.releaseReceiptPath,
      rows: [fixture.planRow],
      policyPath: fixture.policyPath,
    });
    assert.equal(verification.ok, false);
    assert.match(verification.errors.join("; "), /stale and historical-only/i);
  });
});

test("missing situated-generation artifacts delete any stale release receipt", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createFixture(dir, { suffix: "missing-role-input" });
    await fs.writeFile(fixture.releaseReceiptPath, "stale", "utf8");
    await assert.rejects(
      runReleaseGate({ ...gateOptions(fixture), sceneCardPath: "" }),
      /sceneCardPath/i,
    );
    await assert.rejects(fs.access(fixture.releaseReceiptPath), /ENOENT/);
  });
});

test("release-bound narrative updates must match the gated fill plan exactly", async () => {
  await withTempDir(async (dir) => {
    const fixture = await createFixture(dir, { suffix: "updates" });
    await runReleaseGate(gateOptions(fixture));
    const questionUpdate = fixture.planRow.updates.find((update) => update.column === "B");

    const exact = await verifyReleaseReceiptUpdates({
      receiptPath: fixture.releaseReceiptPath,
      updates: [questionUpdate],
      policyPath: fixture.policyPath,
    });
    assert.equal(exact.ok, true, exact.errors?.join("; "));
    assert.equal(exact.matchedUpdates.length, 1);

    const changed = await verifyReleaseReceiptUpdates({
      receiptPath: fixture.releaseReceiptPath,
      updates: [{ ...questionUpdate, value: `${questionUpdate.value} changed` }],
      policyPath: fixture.policyPath,
    });
    assert.equal(changed.ok, false);
    assert.match(changed.errors.join("; "), /value mismatch/i);

    const wrongField = await verifyReleaseReceiptUpdates({
      receiptPath: fixture.releaseReceiptPath,
      updates: [{ ...questionUpdate, field: "not-the-question" }],
      policyPath: fixture.policyPath,
    });
    assert.equal(wrongField.ok, false);
    assert.match(wrongField.errors.join("; "), /field mismatch/i);

    const disguisedColumn = await verifyReleaseReceiptUpdates({
      receiptPath: fixture.releaseReceiptPath,
      updates: [{ ...questionUpdate, column: "M" }],
      policyPath: fixture.policyPath,
    });
    assert.equal(disguisedColumn.ok, false);
    assert.match(disguisedColumn.errors.join("; "), /column mismatch/i);

    const unbound = await verifyReleaseReceiptUpdates({
      receiptPath: fixture.releaseReceiptPath,
      updates: [{ ...questionUpdate, address: "B999" }],
      policyPath: fixture.policyPath,
    });
    assert.equal(unbound.ok, false);
    assert.match(unbound.errors.join("; "), /not bound/i);

    const formatOnly = await verifyReleaseReceiptUpdates({
      receiptPath: fixture.releaseReceiptPath,
      updates: [{ address: "M901", column: "M", field: "product-format", value: "docx, xlsx" }],
      policyPath: fixture.policyPath,
    });
    assert.equal(formatOnly.ok, true);
    assert.equal(formatOnly.matchedUpdates.length, 0);
  });
});
