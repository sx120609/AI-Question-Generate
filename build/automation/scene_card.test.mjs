import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SCENE_CARD_BUNDLE_KIND,
  SCENE_CARD_GATE_ID,
  SCENE_CARD_PROTOCOL_ID,
  auditRoleConsistency,
  evaluateSceneCardRows,
  runSceneCardGate,
  sceneCardHash,
  validateSceneCard,
  verifySceneCardGateReport,
} from "./scene_card.mjs";

const factLedger = {
  facts: [
    { id: "fact-arrival", text: "设备在2026年7月10日到货，共3台，台账状态为“待核”。" },
    { id: "fact-data", text: "原始测试数据尚未取得。" },
    { id: "fact-decision", text: "主任需要判断当前能否进入技术验收。" },
  ],
  materials: [
    { id: "material-register", text: "到货台账" },
  ],
  unknowns: [
    { id: "unknown-data-date", text: "原始测试数据何时提供" },
  ],
};

const sceneCard = {
  schemaVersion: 1,
  policyId: SCENE_CARD_PROTOCOL_ID,
  topicId: "topic-device-acceptance",
  personaId: "persona-device-1",
  requester: {
    functionalRole: "采购经办人",
    organizationType: "制造企业",
    department: "",
    responsibility: "核对到货材料并准备验收判断所需的底稿",
    authorityBoundary: "只能整理已有材料，不能替主任确认最终验收结论",
    recipientRelation: "把材料交给能整理文档和表格的同事",
  },
  scene: {
    workflowStage: "设备到货后的验收准备",
    trigger: "设备已经到货",
    currentBlockage: "原始测试数据尚未取得",
    mainDecision: "当前能否进入技术验收",
    downstreamUse: "给主任判断现在能签到哪一步",
  },
  informationBoundary: {
    knownFactIds: ["fact-arrival", "fact-data", "fact-decision"],
    availableMaterialIds: ["material-register"],
    unknowns: ["原始测试数据何时提供"],
    forbiddenInferences: ["不能补出验收已经通过或虚构测试结果"],
  },
  voice: {
    channel: "飞书私聊",
    formality: "熟悉同事之间的简短工作交代",
    domainVocabulary: ["到货", "测试数据", "验收"],
    avoidVocabulary: ["证据闭环", "落到台账"],
  },
  maskTerms: ["设备验收", "采购经办人", "主任"],
  evidenceBindings: [
    { claim: "设备已经到货", factIds: ["fact-arrival"] },
    { claim: "原始测试数据尚未取得", factIds: ["fact-data"] },
    { claim: "当前能否进入技术验收", factIds: ["fact-decision"] },
  ],
};

const question = "设备已经到了，原始测试数据还没拿到，你帮我整理一份Word说明和一张Excel工作簿，给主任判断现在能签到哪一步。";

function envelopeFor(recordUid = "沈礼_scene_001", overrides = {}) {
  return {
    recordUid,
    sceneCard: {
      ...structuredClone(sceneCard),
      personaId: `persona-${recordUid}`,
      topicId: `topic-${recordUid}`,
    },
    requestContract: {
      requestSpan: "你帮我整理一份Word说明和一张Excel工作簿",
      action: "整理",
      outputs: [
        { format: "docx", humanName: "Word", purpose: "说明当前可签范围" },
        { format: "xlsx", humanName: "Excel", purpose: "记录核对结果" },
      ],
    },
    roleTrace: {
      blockageSpan: "原始测试数据还没拿到",
      motivationSpan: "设备已经到了",
      downstreamUseSpan: "给主任判断现在能签到哪一步",
    },
    usedFactIds: ["fact-arrival", "fact-data", "fact-decision"],
    deliberatelyOmitted: [],
    ...overrides,
  };
}

function bundleFor(cards, factLedgerPath = "fact_ledger.json", factLedgerHash = "0".repeat(64)) {
  return {
    kind: SCENE_CARD_BUNDLE_KIND,
    protocolId: SCENE_CARD_PROTOCOL_ID,
    schemaVersion: 1,
    factLedgerPath,
    factLedgerHash,
    cards,
  };
}

test("validates the finite-view scene protocol and hashes it independent of object key order", () => {
  const report = validateSceneCard(sceneCard, { factLedger });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.equal(report.checks.factLedgerVerified, true);
  assert.equal(report.checks.unknownCount, 1);

  const reordered = Object.fromEntries(Object.entries(sceneCard).reverse());
  assert.equal(sceneCardHash(sceneCard), sceneCardHash(reordered));
});

test("rejects unbound evidence, known/unknown drift, and story-only fields", () => {
  const invalid = structuredClone(sceneCard);
  invalid.backstory = "老板临时施压后，他连夜来找助手";
  invalid.scene.trigger = "设备在2026年7月11日突然到货";
  invalid.requester.recipientRelation = "领导催得很急，所以临时把任务塞给助手";
  invalid.informationBoundary.unknowns = ["负责人是否已经批准"];
  invalid.evidenceBindings[0].claim = invalid.scene.trigger;

  const report = validateSceneCard(invalid, { factLedger });
  assert.equal(report.ok, false);
  const codes = new Set(report.errors.map((entry) => entry.code));
  assert.equal(codes.has("unsupported_dramatic_field"), true);
  assert.equal(codes.has("evidence_claim_has_unbound_anchor"), true);
  assert.equal(codes.has("unknown_not_in_fact_ledger"), true);
  assert.equal(codes.has("unsupported_dramatic_claim"), true);
});

test("accepts a natural first-person affiliation but rejects prompt-like role exposition", () => {
  const envelope = envelopeFor();
  const natural = auditRoleConsistency({
    sceneCard: envelope.sceneCard,
    envelope,
    question: `我们是一家制造企业，${question}`,
    productFormats: "docx, xlsx",
    factLedger,
  });
  assert.equal(natural.errors.some((entry) => entry.code === "requester_self_identification"), false);

  const leaked = auditRoleConsistency({
    sceneCard: envelope.sceneCard,
    envelope,
    question: `作为一名采购经办人，${question}`,
    productFormats: "docx, xlsx",
    factLedger,
  });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.errors.some((entry) => entry.code === "requester_self_identification"), true);
  assert.equal(leaked.errors.some((entry) => entry.code === "hidden_role_leak"), true);
});

test("binds requestSpan/action/outputs and roleTrace exactly to the question and M formats", () => {
  const envelope = envelopeFor();
  const report = auditRoleConsistency({
    sceneCard: envelope.sceneCard,
    envelope,
    question,
    productFormats: "docx, xlsx",
    factLedger,
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.equal(report.status, "PASS");
  assert.equal(report.checks.requestActionInSpan, true);
  assert.deepEqual(report.checks.requestOutputFormats, ["docx", "xlsx"]);

  const broken = structuredClone(envelope);
  broken.requestContract.action = "制作";
  broken.roleTrace.blockageSpan = "题面中没有的卡点";
  const failed = auditRoleConsistency({
    sceneCard: broken.sceneCard,
    envelope: broken,
    question,
    productFormats: "docx",
    factLedger,
  });
  const codes = new Set(failed.errors.map((entry) => entry.code));
  assert.equal(codes.has("request_action_not_in_span"), true);
  assert.equal(codes.has("role_trace_span_not_exact"), true);
  assert.equal(codes.has("request_outputs_mismatch_m"), true);
});

test("L1 role audit permits a concrete deliverable without a file-format label", () => {
  const l1Question = "设备已经到了，原始测试数据还没拿到，你帮我整理一份证据清单，给主任判断现在能签到哪一步。";
  const envelope = envelopeFor("沈礼_L1_scene_001", {
    requestContract: {
      requestSpan: "你帮我整理一份证据清单",
      action: "整理",
      outputs: [],
    },
    roleTrace: {
      blockageSpan: "原始测试数据还没拿到",
      motivationSpan: "设备已经到了",
      downstreamUseSpan: "给主任判断现在能签到哪一步",
    },
  });
  const report = auditRoleConsistency({
    sceneCard: envelope.sceneCard,
    envelope,
    question: l1Question,
    productFormats: "",
    productionProfile: "l1",
    factLedger,
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.deepEqual(report.checks.requestOutputFormats, []);
  assert.deepEqual(report.checks.mFormats, []);
});

test("rejects role-card leakage and numbers, dates, quotations, or drama outside used fact bindings", () => {
  const envelope = envelopeFor();
  const unsafeQuestion = `${question.slice(0, -1)}，我的角色是${envelope.sceneCard.personaId}，领导催得很急，另写明2026年7月11日有4台设备并标成“已经批准”。`;
  const report = auditRoleConsistency({
    sceneCard: envelope.sceneCard,
    envelope,
    question: unsafeQuestion,
    productFormats: "docx, xlsx",
    factLedger,
  });
  const codes = new Set(report.errors.map((entry) => entry.code));
  assert.equal(codes.has("requester_self_identification"), true);
  assert.equal(codes.has("hidden_role_leak"), true);
  assert.equal(codes.has("unbound_question_anchor"), true);
  assert.equal(codes.has("unbound_dramatic_question_claim"), true);
  assert.deepEqual(report.checks.unboundFactAnchors.quotedClaims, ["已经批准"]);
});

test("fails a batch whose questions keep the same author skeleton after role and industry masking", () => {
  const first = envelopeFor("沈礼_scene_001");
  const second = envelopeFor("沈礼_scene_002");
  const rows = [
    { UID: first.recordUid, 题目: question, 产物格式: "docx, xlsx" },
    { UID: second.recordUid, 题目: question, 产物格式: "docx, xlsx" },
  ];
  const evaluation = evaluateSceneCardRows(rows, bundleFor([first, second]), { factLedger });
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.batch.status, "FAIL");
  assert.equal(evaluation.batch.errors[0].code, "masked_author_voice_collision");
  assert.equal(evaluation.batch.comparisons[0].highSimilarity, true);
});

test("run and verify bind candidate, bundle, fact ledger, and deterministic evaluation hashes", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "scene-card-gate-"));
  const candidatePath = path.join(temporaryDirectory, "candidate.tsv");
  const sceneCardPath = path.join(temporaryDirectory, "scene_cards.json");
  const factLedgerPath = path.join(temporaryDirectory, "fact_ledger.json");
  const reportPath = path.join(temporaryDirectory, "role_consistency_report.json");
  const ledgerText = `${JSON.stringify(factLedger, null, 2)}\n`;
  const ledgerHash = crypto.createHash("sha256").update(ledgerText).digest("hex");
  const envelope = envelopeFor();
  const candidateText = `UID\t题目\t产物格式\n${envelope.recordUid}\t${question}\tdocx, xlsx\n`;
  await fs.writeFile(factLedgerPath, ledgerText, "utf8");
  await fs.writeFile(candidatePath, candidateText, "utf8");
  await fs.writeFile(sceneCardPath, `${JSON.stringify(bundleFor([envelope], "fact_ledger.json", ledgerHash), null, 2)}\n`, "utf8");

  const report = await runSceneCardGate({ candidatePath, sceneCardPath, reportPath });
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.equal(report.status, "PASS");
  assert.equal(report.gateId, SCENE_CARD_GATE_ID);
  assert.equal(report.factLedgerHash, ledgerHash);

  const verification = await verifySceneCardGateReport({ candidatePath, sceneCardPath, reportPath });
  assert.equal(verification.ok, true, verification.errors?.join("; "));
  assert.match(verification.reportHash, /^[a-f0-9]{64}$/u);

  await fs.writeFile(candidatePath, candidateText.replace("设备已经到了", "设备刚到"), "utf8");
  const stale = await verifySceneCardGateReport({ candidatePath, sceneCardPath, reportPath });
  assert.equal(stale.ok, false);
  assert.match(stale.errors[0], /does not match/u);
});
