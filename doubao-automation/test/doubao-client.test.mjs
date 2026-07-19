import test from "node:test";
import assert from "node:assert/strict";

import {
  conversationIdFromUrl,
  deriveLocalComputerState,
  dismissVisibleQuotaManagementDialog,
  isNewResponseSnapshot,
  isBlankOfficeTaskState,
  responseWaitDeadline,
  selectChatPage,
  selectDoubaoPageInfo,
} from "../src/doubao-client.mjs";

function page(url) {
  return { url: () => url };
}

test("selects the exact Playwright chat page", () => {
  const selected = selectChatPage([
    page("chrome://doubao-launcher/chat?viewId=101"),
    page("chrome://doubao-chat/chat"),
  ]);
  assert.equal(selected.url(), "chrome://doubao-chat/chat");
});

test("fails closed when no chat page exists", () => {
  assert.throws(() => selectChatPage([page("chrome://doubao-background/")]), /found 0/u);
});

test("isolates concurrent windows by target ID", () => {
  const pages = [
    { targetId: "target-a", url: "chrome://doubao-chat/chat/1001" },
    { targetId: "target-b", url: "chrome://doubao-chat/chat/1002" },
  ];
  assert.equal(selectDoubaoPageInfo(pages, { targetId: "target-b" }).url.endsWith("1002"), true);
  assert.equal(selectDoubaoPageInfo(pages, { conversationId: "1001" }).targetId, "target-a");
  assert.throws(() => selectDoubaoPageInfo(pages), /select one with targetId/u);
});

test("extracts the conversation ID from a chat URL", () => {
  assert.equal(
    conversationIdFromUrl("chrome://doubao-chat/chat/38435142692195586"),
    "38435142692195586",
  );
  assert.equal(conversationIdFromUrl("chrome://doubao-chat/chat"), "");
});

test("recognizes an in-place response placeholder becoming real content", () => {
  assert.equal(isNewResponseSnapshot({
    count: 1,
    identity: "block-1",
    previousCount: 1,
    previousIdentity: "block-1",
    previousText: "",
    text: "完整回复",
  }), true);
  assert.equal(isNewResponseSnapshot({
    count: 1,
    identity: "block-1",
    previousCount: 1,
    previousIdentity: "block-1",
    previousText: "完整回复",
    text: "完整回复",
  }), false);
});

test("treats only an empty root Office Task as safe for a fresh interaction", () => {
  const blank = { officeModeActive: true, sentMessageCount: 0, receivedMessageCount: 0 };
  assert.equal(isBlankOfficeTaskState("chrome://doubao-chat/chat", blank), true);
  assert.equal(isBlankOfficeTaskState("chrome://doubao-chat/chat/123", blank), false);
  assert.equal(isBlankOfficeTaskState("chrome://doubao-chat/chat", { ...blank, sentMessageCount: 1 }), false);
});

test("live response waiting has no absolute deadline unless a test explicitly supplies one", () => {
  assert.equal(responseWaitDeadline(0, 1_000), Number.POSITIVE_INFINITY);
  assert.equal(responseWaitDeadline(undefined, 1_000), Number.POSITIVE_INFINITY);
  assert.equal(responseWaitDeadline(250, 1_000), 1_250);
});

test("dismisses a visible quota-management dialog before message actions", async () => {
  let open = true;
  const keyPresses = [];
  const filtered = { count: async () => open ? 1 : 0 };
  const page = {
    keyboard: {
      press: async (key) => {
        keyPresses.push(key);
        open = false;
      },
    },
    locator: () => ({ filter: () => filtered }),
    waitForTimeout: async () => {},
  };

  assert.deepEqual(await dismissVisibleQuotaManagementDialog(page), {
    dismissed: true,
    dismissedCount: 1,
  });
  assert.deepEqual(keyPresses, ["Escape"]);
});

test("recognizes the closed Local Computer dialog trigger as disabled", () => {
  assert.deepEqual(deriveLocalComputerState([{
    ariaExpanded: "false",
    ariaHasPopup: "dialog",
    className: "flex bg-transparent text-dbx-text-primary",
    dataState: "closed",
  }]), {
    active: false,
    buttonCount: 1,
    stateKnown: true,
  });
});

test("fails closed when Local Computer is active, missing, or ambiguous", () => {
  assert.equal(deriveLocalComputerState([{ dataChecked: "true" }]).active, true);
  assert.equal(deriveLocalComputerState([{
    ariaExpanded: "false",
    ariaHasPopup: "dialog",
    className: "bg-transparent",
    dataState: "closed",
    hasCloseControl: true,
  }]).active, true);
  assert.deepEqual(deriveLocalComputerState([]), {
    active: null,
    buttonCount: 0,
    stateKnown: false,
  });
  assert.deepEqual(deriveLocalComputerState([{ ariaHasPopup: "dialog" }]), {
    active: null,
    buttonCount: 1,
    stateKnown: false,
  });
});
