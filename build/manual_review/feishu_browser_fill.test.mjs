import assert from "node:assert/strict";
import test from "node:test";

import { applyFeishuFillPlan, setFeishuCell } from "./feishu_browser_fill.mjs";

test("allows natural paragraphs but rejects list-style B values before browser interaction", async () => {
  await assert.rejects(
    setFeishuCell({}, "B121", "现有材料有些乱。\n请整理成一份Word说明。"),
    /release-gate receipt is required/i,
  );
  await assert.rejects(
    applyFeishuFillPlan({}, {
      rows: [{
        sheetRow: 121,
        updates: [{ address: "B121", column: "B", field: "题目", value: "现有材料有些乱。\n1. 请整理成一份Word说明。" }],
      }],
    }),
    /bullet or numbered specification list/i,
  );
});

test("rejects a B value with no direct user request before browser interaction", async () => {
  await assert.rejects(
    setFeishuCell({}, "B121", "Word需要写处理结论，Excel按业务类型分项。"),
    /direct user request/i,
  );
});

test("requires a release receipt for valid narrative browser writes but not for dry runs", async () => {
  const value = "材料已经齐了，你帮我整理成一份Word说明。";
  await assert.rejects(
    setFeishuCell({}, "B121", value),
    /release-gate receipt is required/i,
  );

  const result = await applyFeishuFillPlan({}, {
    rows: [{
      sheetRow: 121,
      updates: [{ address: "B121", column: "B", field: "题目", value }],
    }],
  }, { dryRun: true });
  assert.equal(result[0].skipped, true);
});
