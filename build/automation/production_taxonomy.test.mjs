import assert from "node:assert/strict";
import test from "node:test";

import {
  LEVEL1_CATEGORY_OPTIONS,
  assertAllowedLevel1Category,
  isAllowedLevel1Category,
} from "./production_taxonomy.mjs";

test("level-one categories exactly mirror the Feishu dropdown options", () => {
  assert.equal(LEVEL1_CATEGORY_OPTIONS.length, 15);
  assert.equal(isAllowedLevel1Category("法律、政务与公共服务"), true);
  assert.equal(isAllowedLevel1Category("投资战略、专业服务与企业经营"), true);
});

test("invented level-one categories fail before Feishu submission", () => {
  assert.throws(
    () => assertAllowedLevel1Category("汽车销售与售后服务"),
    /must be selected from the configured Feishu options/i,
  );
});
