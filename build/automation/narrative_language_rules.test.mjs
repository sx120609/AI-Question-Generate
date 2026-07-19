import assert from "node:assert/strict";
import test from "node:test";

import {
  collectNarrativeLanguageAdvisories,
  countEnumerationDeng,
  evaluateNarrativeHardRules,
  findDisguisedCommaLists,
  validateContinuityAudit,
} from "./narrative_language_rules.mjs";

const flowingQuestion = "先把合同、发票等材料放在一起（包括补充协议）。这样才能核对金额、日期等信息（以原始回单为准）。最后把缺件等情况写进交接表（注明责任人与节点）。";

test("hard punctuation policy allows natural enumeration deng without imposing a quota", () => {
  assert.equal(countEnumerationDeng(flowingQuestion), 3);
  assert.deepEqual(evaluateNarrativeHardRules(flowingQuestion), []);
  const failed = evaluateNarrativeHardRules("核对合同、发票、回单、流水（包括补充协议）。再看金额，日期，主体，状态（以原始回单为准）。结果写入交接表（注明责任人与节点）。");
  assert.ok(!failed.some((item) => item.rule === "enumeration-comma-over-limit"));
  assert.ok(collectNarrativeLanguageAdvisories("核对合同、发票、回单、流水（包括补充协议）。")
    .some((item) => item.rule === "enumeration-comma-density-advisory"));
  assert.ok(!failed.some((item) => item.rule === "enumeration-deng-below-minimum"));
  assert.ok(failed.some((item) => item.rule === "comma-disguised-list"));
});

test("enumeration deng does not count lexical words such as waiting or equality", () => {
  assert.equal(countEnumerationDeng("等待结果时需要检查等级是否相等，材料等信息另行登记。"), 1);
});

test("comma list detector distinguishes noun piles from connected clauses", () => {
  assert.equal(findDisguisedCommaLists("合同，发票，回单，付款记录都要核对。").length, 1);
  assert.equal(findDisguisedCommaLists("材料已经到齐，但金额仍有差异，所以财务还在复核。").length, 0);
});

test("continuity audit must cover every adjacent sentence and paragraph pair", () => {
  const audit = {
    sentenceLinks: [
      { from: 1, to: 2, relation: "因果", reason: "第二句说明整理材料之后为什么要继续核对" },
      { from: 2, to: 3, relation: "任务收束", reason: "第三句把核对结果收束到最终交接表" },
    ],
    paragraphLinks: [],
    commaListFree: true,
    outsiderReadable: true,
    narrativeFlow: true,
    unexplainedProfessionalTerms: [],
  };
  assert.deepEqual(validateContinuityAudit(flowingQuestion, audit), []);
  assert.ok(validateContinuityAudit(flowingQuestion, { ...audit, sentenceLinks: audit.sentenceLinks.slice(0, 1) })
    .some((item) => item.rule === "sentence-link-count"));
});
