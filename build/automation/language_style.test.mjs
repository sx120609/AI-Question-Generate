import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeQuestionPunctuation,
  analyzeQuestionRequest,
  assertClearQuestionRequest,
  assertNaturalQuestionPresentation,
  assertNoPoliteImperative,
  assertSingleParagraphQuestion,
  findPoliteImperative,
  formatQuestionAsSingleParagraph,
  missingQuestionDeliverableFormats,
} from "./language_style.mjs";

test("keeps the legacy single-paragraph helper and accepts natural prose paragraphs", () => {
  assert.equal(
    formatQuestionAsSingleParagraph("第一段。\n\n第二段。\r\n第三段。"),
    "第一段。第二段。第三段。",
  );
  assert.doesNotThrow(() => assertSingleParagraphQuestion("第一段。 第二段。"));
  assert.throws(
    () => assertSingleParagraphQuestion("第一段。\n第二段。", { label: "沈礼_future_01" }),
    /沈礼_future_01 题目 must be a single paragraph/,
  );
  assert.deepEqual(
    assertNaturalQuestionPresentation("我在项目组负责整理材料。\n请基于附件生成一份Word说明。"),
    { paragraphCount: 2 },
  );
  assert.throws(
    () => assertNaturalQuestionPresentation("我在项目组负责整理材料。\n\n请基于附件生成一份Word说明。"),
    /must not contain blank lines/i,
  );
  assert.throws(
    () => assertNaturalQuestionPresentation("我在项目组负责整理材料。\n1. 请生成一份Word说明。"),
    /bullet or numbered specification list/i,
  );
});

test("detects polite imperative markers", () => {
  assert.deepEqual(findPoliteImperative("现有资料不全。请把缺口列出来。"), { index: 7, marker: "请" });
  assert.deepEqual(findPoliteImperative("docx 请做成会前要点。"), { index: 5, marker: "请" });
  assert.deepEqual(findPoliteImperative("敬请全面分析附件。"), { index: 1, marker: "请" });
  assert.deepEqual(findPoliteImperative("恳请按模板输出。"), { index: 1, marker: "请" });
});

test("does not reject ordinary words containing 请", () => {
  for (const value of ["本月递交申请", "用户发起请求", "邀请物业到场", "已提请负责人复核", "孩子年前请过假", "本周申请请款"]) {
    assert.equal(findPoliteImperative(value), null);
  }
});

test("requires a natural user request instead of a deliverable specification sentence", () => {
  for (const value of [
    "现有材料有些乱，帮我整理成一份Word说明和一张Excel补件表。",
    "现有材料有些乱，你给我做一张Excel补件表，再写一份Word说明。",
    "现有材料有些乱，我想要一份Word判断说明和一张Excel台账。",
    "现有材料有些乱，需要你核对后做成Word说明和Excel台账。",
    "我在项目组负责整理材料。请只基于附件完成一套报送材料，最后形成一份Word说明和一张Excel工作簿。",
  ]) {
    assert.equal(analyzeQuestionRequest(value).clear, true);
    assert.doesNotThrow(() => assertClearQuestionRequest(value));
  }
  assert.deepEqual(
    missingQuestionDeliverableFormats("你帮我整理一份Word说明。", "docx, xlsx"),
    ["xlsx"],
  );
  assert.doesNotThrow(() => assertClearQuestionRequest(
    "你帮我整理一份Word说明，再做一张Excel工作簿。",
    { productFormats: "docx, xlsx" },
  ));
  assert.throws(
    () => assertClearQuestionRequest("你帮我整理一份Word说明。", { productFormats: "docx, xlsx" }),
    /name every requested output format/i,
  );
  for (const value of [
    "Word需要包含处理结论，Excel按业务类型分项。",
    "物业给出一个解释，材料需要继续补齐。",
    "现有材料有些乱，需要进一步分析。",
  ]) {
    assert.equal(analyzeQuestionRequest(value).clear, false);
    assert.throws(() => assertClearQuestionRequest(value), /direct user request/i);
  }
});

test("accepts conversational requests beyond the original five example frames", () => {
  const values = [
    "这些记录的口径还没对齐，能不能先把差异捋清楚，做成一份Word说明和一张Excel工作簿？",
    "这部分你先过一下，最后整理成一份Word意见和一张Excel工作簿，我拿去和财务对口径。",
    "我这边还缺一份Word说明，也得有一张Excel工作簿，后面核价时要直接用。",
    "材料都在附件里，你先看一下哪里互相打架，再写成一份Word说明和一张Excel工作簿。",
  ];
  for (const value of values) {
    assert.equal(analyzeQuestionRequest(value).clear, true, value);
    assert.doesNotThrow(() => assertClearQuestionRequest(value, { productFormats: "docx, xlsx" }));
  }
});

test("measures abrupt openings and punctuation placement without treating semicolons as sentences", () => {
  const abrupt = analyzeQuestionPunctuation("今天要过投放素材。帮我整理一份Word说明；再做一张Excel表。你给我标出缺件。 ");
  assert.equal(abrupt.firstSentenceLength, 8);
  assert.equal(abrupt.firstSentenceCommaCount, 0);
  assert.equal(abrupt.firstPunctuation, "。");
  assert.equal(abrupt.firstPunctuationIsTerminal, true);
  assert.equal(abrupt.semicolonCount, 1);
  assert.equal(abrupt.earlyStructuralPunctuation, true);

  const natural = analyzeQuestionPunctuation("今天要过投放素材，运营只交来半套原文，帮我先整理成一份Word说明，再做一张Excel表。 ");
  assert.equal(natural.firstSentenceCommaCount, 3);
  assert.equal(natural.firstPunctuation, "，");
  assert.equal(natural.firstPunctuationIsTerminal, false);
});

test("assertion covers generated narrative fields but not source attachment excerpts", () => {
  assert.doesNotThrow(() =>
    assertNoPoliteImperative({
      题目: "老板周五要看补件结果。",
      任务概括: "核对材料缺口。",
      附件内容: "原文摘录：请各单位按期报送。",
      产物内容: "docx 供会前讨论。",
      做题关键步骤: "1. 核对材料。",
    }),
  );
  assert.throws(
    () => assertNoPoliteImperative({ 题目: "请核对材料。" }, { label: "沈礼_7.9_01" }),
    /沈礼_7\.9_01 题目 contains a polite imperative marker/,
  );
});
