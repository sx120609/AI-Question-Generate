import assert from "node:assert/strict";
import test from "node:test";

import { createUtf8Accumulator } from "./feishu_lark_cli_client.mjs";

test("preserves UTF-8 characters split across arbitrary process chunks", () => {
  const expected = "资料来源：官网；票据复核。";
  const bytes = Buffer.from(expected, "utf8");
  const accumulator = createUtf8Accumulator();
  for (const byte of bytes) accumulator.write(Buffer.from([byte]));
  assert.equal(accumulator.end(), expected);
  assert.equal(accumulator.value(), expected);
});

test("end is idempotent", () => {
  const accumulator = createUtf8Accumulator();
  accumulator.write(Buffer.from("完成", "utf8"));
  assert.equal(accumulator.end(), "完成");
  assert.equal(accumulator.end(), "完成");
});
