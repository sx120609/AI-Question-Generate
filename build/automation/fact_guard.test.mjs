import assert from "node:assert/strict";
import test from "node:test";

import { assertNoUnsupportedFactAnchors, auditFactAnchors } from "./fact_guard.mjs";

const source = {
  UID: "沈礼_test",
  题目: "周五要讨论24台B3样机，每台有1块98Wh电池，群里出现‘旧稿’字样。",
  附件内容: "材料日期为2026年7月10日。",
};

test("accepts numbers, quotes, and time markers already present in the source", () => {
  const candidate = {
    UID: source.UID,
    题目: "周五讨论24台B3样机，其中每台仍是1块98Wh电池。",
    任务概括: "核对2026年7月10日已有资料。",
    产物内容: "记录原材料中的“旧稿”说法。",
  };
  assert.equal(assertNoUnsupportedFactAnchors({ source, candidate }).ok, true);
});

test("rejects invented quantities, quoted claims, and deadline labels", () => {
  const candidate = {
    UID: source.UID,
    题目: "明天讨论25台样机，并把“已经批准”写进结论。",
    任务概括: "形成判断。",
    产物内容: "整理材料。",
  };
  const report = auditFactAnchors({ source, candidate });
  assert.equal(report.ok, false);
  assert.deepEqual(report.unsupported.numbers, ["25台"]);
  assert.deepEqual(report.unsupported.quotedClaims, ["已经批准"]);
  assert.deepEqual(report.unsupported.timeMarkers, ["明天"]);
});

test("supports an explicit, reviewable allowlist for non-factual working labels", () => {
  const candidate = {
    UID: source.UID,
    题目: "周五把缺失版本在表内标为“未收”。",
    任务概括: "整理材料。",
    产物内容: "记录状态。",
  };
  const report = auditFactAnchors({
    source,
    candidate,
    allowed: { quotedClaims: ["未收"] },
  });
  assert.equal(report.ok, true);
});

test("accepts ordinary rounded currency conversions from exact source amounts", () => {
  const report = auditFactAnchors({
    source: {
      题目: "年度报告披露营业收入1,174,464,377.35元，归母净利润-452,338,791.01元。",
    },
    candidate: {
      题目: "营收约11.74亿元，归母净利润约亏损4.52亿元。",
    },
  });
  assert.equal(report.ok, true);
});

test("does not use rounding tolerance to accept a materially different amount", () => {
  const report = auditFactAnchors({
    source: { 题目: "年度报告披露营业收入1,174,464,377.35元。" },
    candidate: { 题目: "营收约12.74亿元。" },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.unsupported.numbers, ["12.74亿元"]);
});
