import assert from "node:assert/strict";
import test from "node:test";

import {
  countKeySteps,
  evaluateProductionRecordProfile,
  parseHumanHours,
  resolveProductionProfile,
} from "./production_profile.mjs";

test("L1 is the default production profile while L2 remains explicit", () => {
  assert.equal(resolveProductionProfile().id, "l1");
  assert.equal(resolveProductionProfile({ kind: "l1-production-input-packet" }).taskType, "L1 探索型");
  assert.equal(resolveProductionProfile("l2").packetKind, "l2-production-input-packet");
  assert.equal(resolveProductionProfile("l1").attachments.recommendedMaximum, 2);
  assert.equal(resolveProductionProfile("l1").attachments.maximum, 3);
  assert.equal(resolveProductionProfile("l2").attachments.maximum, null);
});

test("L1 accepts the phase-three hard envelope", () => {
  const result = evaluateProductionRecordProfile({
    题目: `我在项目团队负责方案评估。${"现有资料口径需要核验，公开信息与内部判断要分开。".repeat(8)}请比较三个入口并给出唯一建议，无法确认的信息列为待确认。`,
    任务类型: "L1探索型",
    人类完成时间: "3H",
    做题关键步骤: "1、核验资料。2、统一口径。3、比较方案。4、形成建议。",
  }, "l1");
  assert.equal(result.status, "PASS");
});

test("L1 rejects a simple personal arithmetic task and out-of-range steps", () => {
  const result = evaluateProductionRecordProfile({
    题目: "某上班族比较三种通勤方式，请计算每月成本和时间差额并推荐最省钱的方式。",
    任务类型: "L1 探索型",
    人类完成时间: "2H",
    做题关键步骤: "1、计算费用。2、比较结果。",
  }, "l1");
  assert.ok(result.findings.some((item) => item.rule === "l1-task-too-simple"));
  assert.ok(result.findings.some((item) => item.rule === "key-step-count"));
  assert.ok(result.findings.some((item) => item.rule === "human-hours-below-minimum"));
});

test("L1 rejects an L2-style numeric inventory dumped into the visible question", () => {
  const result = evaluateProductionRecordProfile({
    题目: `采购同事需要一张核对表。${Array.from({ length: 28 }, (_, index) => `配置${index + 1}为${index + 101}台。`).join("")}还要逐项列出全部公式、风险、回滚路径和未来验收限制。`,
    任务类型: "L1 探索型",
  }, "l1");
  assert.ok(result.findings.some((item) => item.rule === "l1-numeric-inventory"));
  assert.ok(result.findings.some((item) => item.rule === "l1-sentence-overload"));
});

test("L1 rejects a task dominated by export and formatting operations", () => {
  const result = evaluateProductionRecordProfile({
    题目: "采购同事需要把现有核对表导出为 Excel 文件。导出时完整保留现有工作表以及来源索引和待核清单，确保文件能正常打开。现场回填列保持可编辑状态。另外在规格证据中标明配置2两个单价的来源口径。",
    任务类型: "L1 探索型",
  }, "l1");
  assert.ok(result.findings.some((item) => item.rule === "l1-mechanical-task-dominant"));
});

test("step and hour parsers cover phase-three sheet notation", () => {
  assert.equal(countKeySteps("1、读取。2、核对。3、比较。4、结论。"), 4);
  assert.equal(parseHumanHours("5h"), 5);
  assert.equal(parseHumanHours("4小时"), 4);
});
