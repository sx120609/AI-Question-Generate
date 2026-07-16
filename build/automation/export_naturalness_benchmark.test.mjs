import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_ID,
  evaluatePositiveCandidate,
  extractNaturalnessFeatures,
  findPoliteImperatives,
  selectPositiveBenchmark,
  validateBenchmark,
} from "./export_naturalness_benchmark.mjs";

const identities = {
  managedGeneratedAnnotators: [
    { name: "沈礼", uidPrefix: "沈礼_", active: true },
    { name: "裴硬", uidPrefix: "裴硬_", active: true },
  ],
};

function record(overrides = {}) {
  return {
    sheetRow: 10,
    uid: "真人-1",
    annotator: "测试标注人",
    qaStatus: "✅通过",
    qaNote: "已完成大模型质检，未发现问题",
    taskType: "L2 流程型",
    categories: { level1: "企业经营", level2: "运营", level3: "门店" },
    fields: {
      question: "周一早上，店长把三家门店近6个月的退款记录发给我，下午开会要决定先改哪一段流程。\n记录里有32笔超时退款和7笔重复退款，但两家门店还没补齐骑手交接时间。我需要先把问题落到具体订单，再判断哪些当天处理、哪些等材料补齐。\n你帮我把结果整理成一份Word分工说明和一张Excel问题表，店长和财务会拿它安排后续处理。",
      summary: "核对三家门店退款问题并安排处理顺序。",
      deliverableContent: "问题表记录订单、原因、负责人和处理时间；分工说明交代会上的判断。",
      keySteps: "1. 对齐订单。\n2. 核对退款。\n3. 标记缺口。\n4. 排出顺序。",
    },
    attachmentAudit: { attachmentCount: 2, tokenCount: 2, nonEmptyFileCount: 2, names: ["退款记录.xlsx", "交接说明.pdf"] },
    ...overrides,
  };
}

test("extracts concrete detail, first person, boundary density, paragraphs and discourse actions", () => {
  const features = extractNaturalnessFeatures(record());
  assert.equal(features.paragraphs.count, 3);
  assert.equal(features.firstPerson.present, true);
  assert.ok(features.concreteNumbers.count >= 4);
  assert.ok(features.boundaryDensity.boundarySentenceCount >= 1);
  assert.ok(features.discourseActions.unique.includes("scene_setup"));
  assert.ok(features.discourseActions.unique.includes("decision_request"));
  assert.ok(features.discourseActions.unique.includes("deliverable_request"));
  assert.equal(features.request.clear, true);
  assert.ok(features.punctuation.firstSentenceCommaCount > 0);
});

test("polite imperative filter keeps lexical uses but rejects task commands", () => {
  assert.equal(findPoliteImperatives("学校发来申请，团队邀请法务参会，并提请负责人复核；孩子年前请过假。" ).length, 0);
  assert.equal(findPoliteImperatives("最终请输出一份表格。" ).length, 1);
});

test("positive eligibility preserves approved request language and excludes managed identities", () => {
  assert.equal(evaluatePositiveCandidate(record(), identities).eligible, true);
  const polite = record({
    fields: { ...record().fields, question: `${record().fields.question}\n最终请输出表格。` },
  });
  assert.equal(evaluatePositiveCandidate(polite, identities).eligible, true);
  assert.equal(evaluatePositiveCandidate(polite, identities).features.politeImperatives.length, 1);
  assert.ok(evaluatePositiveCandidate(record({ annotator: "沈礼", uid: "沈礼_7.10_01" }), identities).exclusions.includes("managed_system_annotator"));
});

test("deterministic selector caps annotator concentration before fallback", () => {
  const candidates = [];
  for (let index = 0; index < 8; index += 1) {
    const candidateRecord = record({ sheetRow: 20 + index, uid: `u-${index}`, annotator: index < 5 ? "甲" : `标注人${index}` });
    candidates.push({ record: candidateRecord, evaluation: evaluatePositiveCandidate(candidateRecord, identities) });
  }
  const selected = selectPositiveBenchmark(candidates, 5);
  assert.equal(selected.length, 5);
  assert.ok(selected.filter((item) => item.record.annotator === "甲").length <= 2);
});

test("benchmark validator checks corpus separation and full fields", () => {
  const sourceRecord = record();
  const feature = extractNaturalnessFeatures(sourceRecord);
  const base = {
    benchmarkId: BENCHMARK_ID,
    positives: Array.from({ length: 24 }, (_, index) => ({
      source: { sheetRow: 100 + index, qaStatus: "✅通过" },
      fields: {
        B_question: "题目",
        G_summary: "概括",
        N_deliverableContent: "产物",
        O_keySteps: "步骤",
      },
      features: feature,
    })),
    negatives: Array.from({ length: 2 }, (_, index) => ({
      source: { sheetRow: 200 + index },
      fields: {
        B_question: "题目",
        G_summary: "概括",
        N_deliverableContent: "产物",
        O_keySteps: "步骤",
      },
      features: feature,
    })),
  };
  assert.deepEqual(validateBenchmark(base, { expectedNegatives: 2, minimumPositives: 10 }), { ok: true, positiveCount: 24, negativeCount: 2 });
});
