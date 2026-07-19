import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDomesticWorkScope,
  auditDomesticWorkScope,
} from "./domestic_work_scope.mjs";

test("accepts a domestic work task that advances a concrete deliverable", () => {
  const result = auditDomesticWorkScope(
    "根据各门店近12个月的销量、退货率和库存记录，清洗异常值后比较不同补货方案，测算资金占用并复核口径，形成给运营团队使用的Excel工作簿。",
    { requireWorkScene: true },
  );
  assert.equal(result.pass, true);
  assert.ok(result.calculationComplexityCount >= 2);
});

test("blocks foreign platforms and domestic sensitive topics", () => {
  assert.deepEqual(auditDomesticWorkScope("比较 Zoom 和 Google Meet 的功能。\n").issues, ["foreign-platform"]);
  assert.deepEqual(auditDomesticWorkScope("来源链接是 https://github.com/example/project。\n").issues, ["foreign-platform"]);
  assert.deepEqual(auditDomesticWorkScope("整理涉及军事行动和军队部署的内部材料。\n").issues, ["domestic-sensitive-topic"]);
});

test("blocks casual follow-ups and single-step arithmetic", () => {
  assert.deepEqual(
    auditDomesticWorkScope("给我算一下23+47", { context: "这是公司财务工作。", requireWorkScene: true }).issues,
    ["calculation-too-simple"],
  );
  assert.throws(
    () => assertDomesticWorkScope("讲个笑话", { context: "继续库存分析项目", requireInteractionAdvance: true, requireWorkScene: true }),
    (error) => error.code === "CONTENT_SCOPE_BLOCKED"
      && error.issues.includes("non-work-interaction")
      && error.issues.includes("interaction-does-not-advance-work"),
  );
});
