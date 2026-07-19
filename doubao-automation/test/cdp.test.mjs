import test from "node:test";
import assert from "node:assert/strict";

import { cdpEndpoint, listDoubaoChatTargets, selectDoubaoChatTarget } from "../src/cdp.mjs";

test("keeps CDP on loopback", () => {
  assert.equal(cdpEndpoint({ port: 9229 }), "http://127.0.0.1:9229");
  assert.throws(
    () => cdpEndpoint({ host: "0.0.0.0", port: 9229 }),
    /loopback/u,
  );
});

test("selects the exact Doubao chat target", () => {
  const selected = selectDoubaoChatTarget([
    { id: "one", type: "page", title: "豆包", url: "doubao://doubao-launcher/chat" },
    { id: "two", type: "page", title: "豆包", url: "doubao://doubao-chat/chat" },
  ]);
  assert.equal(selected.id, "two");
});

test("does not confuse the launcher chat shell with a conversation", () => {
  const selected = selectDoubaoChatTarget([
    { id: "launcher", type: "page", title: "豆包", url: "doubao://doubao-launcher/chat/?viewId=101" },
    { id: "chat", type: "page", title: "任务 - 豆包", url: "doubao://doubao-chat/chat/38434251747760642" },
    { id: "background", type: "page", title: "background", url: "doubao://doubao-background/" },
  ]);
  assert.equal(selected.id, "chat");
});

test("lists multiple windows and selects one by stable target ID", () => {
  const targets = [
    { id: "window-a", type: "page", title: "任务 A", url: "doubao://doubao-chat/chat/1001" },
    { id: "window-b", type: "page", title: "任务 B", url: "doubao://doubao-chat/chat/1002" },
    { id: "background", type: "page", url: "doubao://doubao-background/" },
  ];
  assert.deepEqual(listDoubaoChatTargets(targets).map((item) => item.id), ["window-a", "window-b"]);
  assert.equal(selectDoubaoChatTarget(targets, { targetId: "window-b" }).id, "window-b");
  assert.equal(selectDoubaoChatTarget(targets, { conversationId: "1001" }).id, "window-a");
  assert.throws(() => selectDoubaoChatTarget(targets), /select one with targetId/u);
});
