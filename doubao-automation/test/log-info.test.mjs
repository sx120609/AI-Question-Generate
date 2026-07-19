import assert from "node:assert/strict";
import test from "node:test";

import { parseCopiedLogInfo } from "../src/doubao-client.mjs";

test("parses copied Doubao feedback information", () => {
  assert.deepEqual(
    parseCopiedLogInfo(
      "反馈内容: https://www.doubao.com/thread/xabc123\n日志ID: 20260709145627AC37CA3BAAD14E998453",
    ),
    {
      feedbackUrl: "https://www.doubao.com/thread/xabc123",
      logId: "20260709145627AC37CA3BAAD14E998453",
      raw: "反馈内容: https://www.doubao.com/thread/xabc123\n日志ID: 20260709145627AC37CA3BAAD14E998453",
    },
  );
});
