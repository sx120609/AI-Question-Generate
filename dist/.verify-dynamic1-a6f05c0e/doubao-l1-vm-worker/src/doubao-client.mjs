import { chromium } from "playwright-core";

import { JOB_PAUSE_REQUESTED, throwIfJobPauseRequested } from "./job-control.mjs";

export const CHAT_URLS = new Set([
  "doubao://doubao-chat/chat",
  "chrome://doubao-chat/chat",
]);

export const SELECTORS = Object.freeze({
  breakButton: '[data-testid="chat_input_local_break_button"]',
  officeComposer: '[contenteditable="true"][role="textbox"]',
  standardComposer: 'textarea[placeholder="发消息..."]',
  fileInput: 'input[type="file"]',
  loginButton: 'button:has-text("登录")',
  newOfficeTaskButton: '[data-testid="create_office_task_button"]',
  sendButton: '[data-testid="chat_input_send_button"]',
  receivedMessage: '[data-testid="receive_message"]',
  messageText: '[data-testid="message_text_content"]',
  messageLike: '[data-testid="message_action_like"]',
  messageDislike: '[data-testid="message_action_dislike"]',
  messageShare: '[data-testid="message_action_share"]',
  messageMore: '[data-testid="message_action_more"]',
});

const UPLOAD_NODE_SELECTOR = [
  '[data-testid*="upload"]',
  '[data-testid*="attachment"]',
  '[data-testid*="file"]',
  '[class*="upload"]',
  '[class*="attachment"]',
  '[class*="file-card"]',
].join(", ");
const UPLOAD_BUSY_RE = /(?:正在上传|上传中|正在解析|解析中|正在处理|处理中)/u;
const UPLOAD_FAILURE_RE = /(?:上传失败|解析失败|文件失败|重新上传|点击重试|重试上传)/u;

export function conversationIdFromUrl(url) {
  return String(url).match(/\/chat\/(\d+)(?:[/?#]|$)/u)?.[1] ?? "";
}

export function deriveLocalComputerState(buttons = []) {
  if (!Array.isArray(buttons) || buttons.length !== 1) {
    return {
      active: null,
      buttonCount: Array.isArray(buttons) ? buttons.length : 0,
      stateKnown: false,
    };
  }
  const attributes = buttons[0] && typeof buttons[0] === "object" ? buttons[0] : {};
  const className = String(attributes.className ?? attributes.class ?? "");
  const checked = String(attributes.dataChecked ?? attributes["data-checked"] ?? "").toLowerCase();
  const pressed = String(attributes.ariaPressed ?? attributes["aria-pressed"] ?? "").toLowerCase();
  const selected = String(attributes.ariaSelected ?? attributes["aria-selected"] ?? "").toLowerCase();
  const expanded = String(attributes.ariaExpanded ?? attributes["aria-expanded"] ?? "").toLowerCase();
  const state = String(attributes.dataState ?? attributes["data-state"] ?? "").toLowerCase();
  const hasPopup = String(attributes.ariaHasPopup ?? attributes["aria-haspopup"] ?? "").toLowerCase();
  const hasCloseControl = attributes.hasCloseControl === true;
  const explicitActive = hasCloseControl
    || checked === "true"
    || pressed === "true"
    || selected === "true"
    || expanded === "true"
    || state === "open";
  if (explicitActive) return { active: true, buttonCount: 1, stateKnown: true };

  const explicitInactive = checked === "false" || pressed === "false" || selected === "false";
  const closedInactiveTrigger = hasPopup === "dialog"
    && expanded === "false"
    && state === "closed"
    && /(?:^|\s)bg-transparent(?:\s|$)/u.test(className);
  if (explicitInactive || closedInactiveTrigger) {
    return { active: false, buttonCount: 1, stateKnown: true };
  }
  return { active: null, buttonCount: 1, stateKnown: false };
}

async function inspectLocalComputerState(page) {
  const buttons = page.getByRole("button", { name: "本地电脑", exact: true });
  const snapshots = await buttons.evaluateAll((elements) => elements.map((element) => ({
    ariaExpanded: element.getAttribute("aria-expanded"),
    ariaHasPopup: element.getAttribute("aria-haspopup"),
    ariaPressed: element.getAttribute("aria-pressed"),
    ariaSelected: element.getAttribute("aria-selected"),
    className: element.getAttribute("class"),
    dataChecked: element.getAttribute("data-checked"),
    dataState: element.getAttribute("data-state"),
    hasCloseControl: element.querySelectorAll('span[class*="exit-skill-close"]').length === 1,
  })));
  return deriveLocalComputerState(snapshots);
}

export async function ensureLocalComputerDisabled(page) {
  let state = await inspectLocalComputerState(page);
  if (state.stateKnown && state.active === false) return state;
  if (!state.stateKnown || state.active !== true) {
    throw new Error("Local Computer state could not be verified before disabling it.");
  }
  const button = page.getByRole("button", { name: "本地电脑", exact: true });
  if (await button.count() !== 1) {
    throw new Error("Active Local Computer button was not unique.");
  }
  const close = button.locator('span[class*="exit-skill-close"]');
  if (await close.count() !== 1) {
    throw new Error("Active Local Computer close control was not unique.");
  }
  await close.click();
  await page.waitForTimeout(500);
  state = await inspectLocalComputerState(page);
  if (!state.stateKnown || state.active !== false) {
    throw new Error("Local Computer remained active after its close control was used.");
  }
  return state;
}

async function locateComposer(page) {
  const standard = page.locator(SELECTORS.standardComposer);
  const office = page.locator(SELECTORS.officeComposer);
  const standardCount = await standard.count();
  const officeCount = await office.count();
  if (standardCount + officeCount !== 1) {
    throw new Error(
      `Expected exactly one composer, found standard=${standardCount}, office=${officeCount}.`,
    );
  }
  return standardCount === 1
    ? { kind: "standard", locator: standard }
    : { kind: "office", locator: office };
}

async function readComposer({ kind, locator }) {
  if (kind === "standard") {
    return await locator.evaluate((element) => element.value);
  }
  return await locator.evaluate((element) => {
    const children = Array.from(element.children);
    if (children.length && children.every((child) => child.tagName === "P")) {
      return children
        .map((child) => (child.innerText || child.textContent || "").replace(/\n$/u, ""))
        .join("\n")
        .replace(/\n$/u, "");
    }
    return element.innerText.replace(/\n$/u, "");
  });
}

export function selectChatPage(pages) {
  const exact = pages.filter((page) => CHAT_URLS.has(page.url()));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Multiple exact Doubao chat pages were found: ${exact.length}.`);
  }

  const candidates = pages.filter((page) => /doubao-chat\/chat/i.test(page.url()));
  if (candidates.length !== 1) {
    throw new Error(`Expected one Doubao chat page, found ${candidates.length}.`);
  }
  return candidates[0];
}

export async function connectDoubao(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = selectChatPage(pages);
  return { browser, page };
}

export async function inspectChat(page) {
  const standardComposer = page.locator(SELECTORS.standardComposer);
  const officeComposer = page.locator(SELECTORS.officeComposer);
  const standardComposerCount = await standardComposer.count();
  const officeComposerCount = await officeComposer.count();
  const composerCount = standardComposerCount + officeComposerCount;
  const officeTaskButtonCount = await page.locator(SELECTORS.newOfficeTaskButton).count();
  const localComputer = await inspectLocalComputerState(page);
  const bodyText = await page.locator("body").innerText();
  const sendButton = page.locator(SELECTORS.sendButton);
  const sendButtonCount = await sendButton.count();
  const sendButtonState = sendButtonCount === 1
    ? await sendButton.evaluate((element) => ({
      ariaDisabled: element.getAttribute("aria-disabled"),
      className: element.getAttribute("class"),
      disabled: "disabled" in element ? Boolean(element.disabled) : null,
      tagName: element.tagName,
      text: (element.innerText || element.textContent || "").trim(),
    }))
    : null;
  const composerText = composerCount === 1
    ? await readComposer(standardComposerCount === 1
      ? { kind: "standard", locator: standardComposer }
      : { kind: "office", locator: officeComposer })
    : null;
  return {
    bodyText: bodyText.slice(0, 4_000),
    composerCount,
    composerKind: standardComposerCount === 1
      ? "standard"
      : officeComposerCount === 1 ? "office" : null,
    composerTextLength: composerText === null ? null : composerText.length,
    composerPlaceholder: standardComposerCount === 1
      ? await standardComposer.getAttribute("placeholder")
      : officeComposerCount === 1
        ? await officeComposer.evaluate((element) => (
          element.getAttribute("data-placeholder")
          || element.querySelector("[data-placeholder]")?.getAttribute("data-placeholder")
          || null
        ))
        : null,
    loginRequired: bodyText.split(/\r?\n/u).some((line) => line.trim() === "登录"),
    localComputerActive: localComputer.active,
    localComputerButtonCount: localComputer.buttonCount,
    localComputerStateKnown: localComputer.stateKnown,
    officeModeActive: bodyText.split(/\r?\n/u).some((line) => line.trim() === "办公任务 Turbo"),
    officeTaskButtonCount,
    receivedMessageCount: await page.locator(SELECTORS.receivedMessage).count(),
    sendButtonCount,
    sendButtonState,
    sentMessageCount: await page.locator('[data-testid="send_message"]').count(),
    title: await page.title(),
    url: page.url(),
  };
}

export async function inspectExecutionConfirmations(page) {
  const bodyText = await page.locator("body").innerText();
  const candidates = await page.locator('button:visible, [role="button"]:visible').evaluateAll((elements) =>
    elements.map((element) => ({
      ariaLabel: element.getAttribute("aria-label") ?? "",
      dataTestId: element.getAttribute("data-testid") ?? "",
      text: (element.innerText || element.textContent || "").trim().slice(0, 1_000),
    })).filter((item) => /确认|执行|允许|拒绝|取消|继续|命令|代码|Python|PowerShell|Bash/iu.test(
      `${item.text}\n${item.ariaLabel}\n${item.dataTestId}`,
    )),
  );
  return {
    bodyTail: bodyText.slice(-8_000),
    candidates,
    confirmationLikely: /确认.{0,12}(?:执行|运行)|(?:执行|运行).{0,12}确认|允许.{0,12}(?:命令|代码)/iu.test(bodyText),
    url: page.url(),
  };
}

export async function openNewOfficeTask(page) {
  const button = page.locator(SELECTORS.newOfficeTaskButton);
  const count = await button.count();
  if (count !== 1) {
    throw new Error(`Expected exactly one new-office-task button, found ${count}.`);
  }
  await button.click();
  await page.waitForTimeout(500);
  await ensureLocalComputerDisabled(page);
  return await inspectChat(page);
}

export async function fillComposer(page, text) {
  if (!String(text).trim()) {
    throw new Error("Composer text must not be empty.");
  }
  const composer = await locateComposer(page);
  await composer.locator.fill(text);
  const actual = await readComposer(composer);
  if (actual !== text) {
    throw new Error("Composer readback did not match the requested text.");
  }
  return actual;
}

export async function clearComposer(page) {
  const composer = await locateComposer(page);
  await composer.locator.fill("");
  const actual = await readComposer(composer);
  if (actual !== "") {
    throw new Error("Composer was not empty after clearing.");
  }
}

export async function inspectComposerAttachments(page, expectedNames = []) {
  const expected = [...new Set(expectedNames.map((name) => String(name).trim()).filter(Boolean))];
  const input = page.locator(SELECTORS.fileInput);
  const inputCount = await input.count();
  const inputState = inputCount === 1
    ? await input.evaluate((element) => ({
      accept: element.getAttribute("accept") || "",
      multiple: Boolean(element.multiple),
      selectedNames: Array.from(element.files || [], (file) => file.name),
    }))
    : { accept: "", multiple: false, selectedNames: [] };
  const candidates = await page.locator(UPLOAD_NODE_SELECTOR).evaluateAll((elements) => elements
    .map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        ariaLabel: element.getAttribute("aria-label") || "",
        dataTestId: element.getAttribute("data-testid") || "",
        text: (element.innerText || element.textContent || "").trim().slice(0, 2_000),
        title: element.getAttribute("title") || "",
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      };
    })
    .filter((item) => item.visible)
    .slice(0, 200));
  const searchable = candidates.map((candidate) => [
    candidate.text,
    candidate.title,
    candidate.ariaLabel,
    candidate.dataTestId,
  ].join("\n"));
  const visibleNames = expected.filter((name) => searchable.some((value) => value.includes(name)));
  const surfaceText = searchable.join("\n");
  return {
    accept: inputState.accept,
    busy: UPLOAD_BUSY_RE.test(surfaceText),
    candidates,
    expectedNames: expected,
    failure: UPLOAD_FAILURE_RE.test(surfaceText),
    fileInputCount: inputCount,
    fileInputMultiple: inputState.multiple,
    selectedNames: inputState.selectedNames,
    visibleNames,
  };
}

export async function uploadComposerAttachments(page, attachments, {
  pollMs = 500,
  signal,
  stableSamples = 2,
  timeoutMs = 180_000,
} = {}) {
  if (!Array.isArray(attachments) || attachments.length < 1) {
    throw new Error("At least one prepared attachment is required for upload.");
  }
  const expectedNames = attachments.map((attachment) => String(attachment.name ?? "").trim());
  const absolutePaths = attachments.map((attachment) => String(attachment.absolutePath ?? "").trim());
  if (expectedNames.some((name) => !name) || absolutePaths.some((filePath) => !filePath)) {
    throw new Error("Every upload attachment must include name and absolutePath.");
  }
  if (new Set(expectedNames).size !== expectedNames.length) {
    throw new Error("Upload attachment names must be unique.");
  }
  const input = page.locator(SELECTORS.fileInput);
  if (await input.count() !== 1) throw new Error("A unique file input was not available.");
  const multiple = await input.evaluate((element) => Boolean(element.multiple));
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  const selectedNames = [];
  const setLocalInputFiles = async (filePaths) => {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("DOM.enable");
      const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
      const { nodeId } = await session.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: SELECTORS.fileInput,
      });
      if (!nodeId) throw new Error("The Doubao file input was not available through CDP.");
      await session.send("DOM.setFileInputFiles", {
        files: Array.isArray(filePaths) ? filePaths : [filePaths],
        nodeId,
      });
    } finally {
      await session.detach().catch(() => {});
    }
  };
  throwIfJobPauseRequested(signal);
  if (multiple) {
    await setLocalInputFiles(absolutePaths);
    const selected = await inspectComposerAttachments(page, expectedNames);
    selectedNames.push(...selected.selectedNames);
  } else {
    for (let index = 0; index < absolutePaths.length; index += 1) {
      throwIfJobPauseRequested(signal);
      await setLocalInputFiles(absolutePaths[index]);
      let selected = await inspectComposerAttachments(page, expectedNames);
      selectedNames.push(...selected.selectedNames);
      while (Date.now() < deadline && !selected.visibleNames.includes(expectedNames[index])) {
        if (selected.failure) {
          const error = new Error(`Doubao reported an attachment upload failure for ${expectedNames[index]}.`);
          error.code = "ATTACHMENT_UPLOAD_FAILED";
          error.uploadState = selected;
          throw error;
        }
        await page.waitForTimeout(pollMs);
        throwIfJobPauseRequested(signal);
        selected = await inspectComposerAttachments(page, expectedNames);
      }
      if (!selected.visibleNames.includes(expectedNames[index])) {
        const error = new Error(`Timed out waiting for attachment ${expectedNames[index]} to appear in the composer.`);
        error.code = "ATTACHMENT_UPLOAD_TIMEOUT";
        error.uploadState = selected;
        throw error;
      }
    }
  }

  let stable = 0;
  let latest = await inspectComposerAttachments(page, expectedNames);
  while (Date.now() < deadline) {
    throwIfJobPauseRequested(signal);
    latest = await inspectComposerAttachments(page, expectedNames);
    if (latest.failure) {
      const error = new Error("Doubao reported an attachment upload failure.");
      error.code = "ATTACHMENT_UPLOAD_FAILED";
      error.uploadState = latest;
      throw error;
    }
    const allVisible = latest.visibleNames.length === expectedNames.length;
    const sendButton = page.locator(SELECTORS.sendButton);
    const sendReady = await sendButton.count() === 1 && await sendButton.isEnabled();
    if (allVisible && !latest.busy && sendReady) stable += 1;
    else stable = 0;
    if (stable >= stableSamples) {
      return {
        completedAt: new Date().toISOString(),
        expectedCount: expectedNames.length,
        expectedNames,
        fileInputMultiple: multiple,
        pass: true,
        selectedNames,
        startedAt,
        visibleCount: latest.visibleNames.length,
        visibleNames: latest.visibleNames,
      };
    }
    await page.waitForTimeout(pollMs);
  }
  const error = new Error(`Timed out after ${timeoutMs}ms waiting for attachment upload readback.`);
  error.code = "ATTACHMENT_UPLOAD_TIMEOUT";
  error.uploadState = latest;
  throw error;
}

async function assertComposerAttachmentsReady(page, expectedNames) {
  const state = await inspectComposerAttachments(page, expectedNames);
  const exact = state.visibleNames.length === expectedNames.length
    && expectedNames.every((name) => state.visibleNames.includes(name));
  if (!exact || state.busy || state.failure) {
    throw new Error("Attachment names/count or upload state changed before send.");
  }
  return state;
}

export async function sendComposer(page, text, { settleMs = 2_000 } = {}) {
  await ensureLocalComputerDisabled(page);
  const workMode = await inspectChat(page);
  if (workMode.loginRequired) throw new Error("Doubao login is required before sending.");
  if (!workMode.officeModeActive || workMode.composerKind !== "office") {
    throw new Error("Office Task mode is not active.");
  }
  if (!workMode.localComputerStateKnown || workMode.localComputerActive !== false) {
    throw new Error("Local Computer must be verifiably disabled before sending.");
  }
  const beforeBody = await page.locator("body").innerText();
  await fillComposer(page, text);
  const sendButton = page.locator(SELECTORS.sendButton);
  const sendButtonCount = await sendButton.count();
  if (sendButtonCount !== 1) {
    throw new Error(`Expected exactly one send button, found ${sendButtonCount}.`);
  }
  if (!await sendButton.isEnabled()) {
    throw new Error("Send button was not enabled after filling the composer.");
  }
  await sendButton.click();
  await page.waitForTimeout(settleMs);

  const afterBody = await page.locator("body").innerText();
  let composerValue = null;
  try {
    composerValue = await readComposer(await locateComposer(page));
  } catch {
    // A login gate or navigation may intentionally replace the composer.
  }
  return {
    bodyChanged: afterBody !== beforeBody,
    bodyTail: afterBody.slice(-4_000),
    composerCleared: composerValue === "",
    composerValue,
    loginRequired: afterBody.split(/\r?\n/u).some((line) => line.trim() === "登录"),
    officeModeActive: afterBody.split(/\r?\n/u).some((line) => line.trim() === "办公任务 Turbo"),
    sendButtonClicked: true,
    url: page.url(),
  };
}

async function responseTextFromContainer(container) {
  const textBlocks = container.locator(SELECTORS.messageText);
  const blockCount = await textBlocks.count();
  if (blockCount > 0) {
    const parts = (await textBlocks.allInnerTexts())
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return (await container.innerText()).trim();
}

async function responseArtifactEvidenceFromContainer(container) {
  return await container.evaluate((element) => {
    const selectors = [
      '[data-testid="sheet-product-card"]',
      '[data-testid*="asset"]',
      '[data-testid*="artifact"]',
      '[data-testid*="file"]',
      '[class*="asset-card"]',
      '[class*="file-card"]',
      'a[download]',
      'img[alt="Asset cover"]',
    ].join(",");
    const seen = new Set();
    const result = [];
    for (const candidate of element.querySelectorAll(selectors)) {
      const surface = candidate.matches('img[alt="Asset cover"]')
        ? candidate.closest('a, button, [role="button"], [data-testid*="asset"], [class*="asset"]')
          || candidate.parentElement
        : candidate;
      const text = (surface?.innerText || surface?.textContent || candidate.getAttribute("alt") || "")
        .trim()
        .slice(0, 1_000);
      const href = surface?.closest("a")?.href || surface?.getAttribute?.("href") || "";
      const label = candidate.getAttribute("aria-label") || candidate.getAttribute("alt") || "";
      const dataTestId = candidate.getAttribute("data-testid") || surface?.getAttribute?.("data-testid") || "";
      const cardStatus = surface?.getAttribute?.("data-card-status") || "";
      const cardUnsupported = surface?.getAttribute?.("data-card-unsupported") || "";
      const sheetCanvasOpen = dataTestId === "sheet-product-card"
        && location.href.includes("pluginId=ai-sheet-canvas")
        && location.href.includes("docToken");
      const resolvedHref = href || (sheetCanvasOpen ? location.href : "");
      const key = JSON.stringify([text, resolvedHref, label, dataTestId, cardStatus, cardUnsupported]);
      if (!text && !href && !label) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        accessState: sheetCanvasOpen ? "opened-in-doubao-sheet-canvas" : "",
        cardStatus,
        cardUnsupported,
        dataTestId,
        href: resolvedHref,
        label,
        text,
      });
      if (result.length >= 50) break;
    }
    return result;
  });
}

async function responseIdentityFromContainer(container, { timeoutMs = 1_500 } = {}) {
  try {
    const row = container.locator('xpath=ancestor-or-self::*[@data-observe-row][1]');
    if (await row.count() !== 1) return "";
    return await row.getAttribute("data-observe-row", { timeout: timeoutMs }) || "";
  } catch {
    return "";
  }
}

export async function inspectLatestResponse(page) {
  const responses = page.locator(SELECTORS.receivedMessage);
  const responseCount = await responses.count();
  if (responseCount === 0) {
    throw new Error("No received message is available to inspect.");
  }

  const container = responses.nth(responseCount - 1);
  await container.hover({ force: true });
  const identity = await responseIdentityFromContainer(container, { timeoutMs: 3_000 })
    || `response-${responseCount}`;
  const ancestry = await container.evaluate((element) => {
    const result = [];
    let current = element;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      result.push({
        attributes: Object.fromEntries(Array.from(current.attributes, (attribute) => [attribute.name, attribute.value])),
        depth,
        tag: current.tagName.toLowerCase(),
      });
    }
    return result;
  });
  const actions = await container.locator('[data-testid^="message_action_"]').evaluateAll(
    (elements) => elements.map((element) => ({
      ariaLabel: element.getAttribute("aria-label"),
      testId: element.getAttribute("data-testid"),
      title: element.getAttribute("title"),
    })),
  );

  return {
    actions,
    ancestry,
    identity,
    responseCount,
    text: await responseTextFromContainer(container),
  };
}

async function inspectFeedbackSurface(page) {
  const dialogs = page.locator('[role="dialog"]');
  const dialogCount = await dialogs.count();
  const submit = page.locator('[data-testid="message_feedback_submit_button"]');
  const submitCount = await submit.count();
  const ancestorSummary = submitCount === 1
    ? await submit.evaluate((element) => {
      const result = [];
      let current = element;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        result.push({
          className: current.className || null,
          dataTestId: current.getAttribute("data-testid"),
          depth,
          tag: current.tagName.toLowerCase(),
          text: (current.innerText || "").trim().slice(0, 1_000),
          textLength: (current.innerText || "").trim().length,
        });
      }
      return result;
    })
    : [];
  const surface = dialogCount > 0
    ? dialogs.nth(dialogCount - 1)
    : submitCount === 1
      ? submit.locator("xpath=../../..")
      : page.locator("body");
  const controls = await surface.locator(
    'button, input, textarea, [contenteditable="true"], [role="button"], [role="radio"], [role="checkbox"]',
  ).evaluateAll((elements) => elements.map((element) => ({
    ariaLabel: element.getAttribute("aria-label"),
    checked: "checked" in element ? element.checked : null,
    dataTestId: element.getAttribute("data-testid"),
    disabled: "disabled" in element ? element.disabled : null,
    placeholder: element.getAttribute("placeholder"),
    role: element.getAttribute("role"),
    tag: element.tagName.toLowerCase(),
    text: (element.innerText || element.value || "").trim().slice(0, 500),
    title: element.getAttribute("title"),
    type: element.getAttribute("type"),
  })));
  const nodes = await surface.locator("*").evaluateAll((elements) => elements
    .map((element) => ({
      className: typeof element.className === "string" ? element.className : null,
      dataState: element.getAttribute("data-state"),
      dataTestId: element.getAttribute("data-testid"),
      ownText: Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join("")
        .trim(),
      role: element.getAttribute("role"),
      tag: element.tagName.toLowerCase(),
    }))
    .filter((node) => node.dataTestId || node.ownText || node.role)
    .slice(0, 100));

  return {
    ancestorSummary,
    controls,
    dialogCount,
    nodes,
    submitCount,
    text: (await surface.innerText()).trim().slice(0, 4_000),
  };
}

export async function inspectOpenFeedback(page) {
  return await inspectFeedbackSurface(page);
}

export async function selectFeedbackOption(page, label, { signal } = {}) {
  throwIfJobPauseRequested(signal);
  const panel = page.locator('[data-testid="message_feedback_post_panel"]');
  if (await panel.count() !== 1) throw new Error("A unique feedback panel is not open.");
  const options = panel.locator('[data-testid="message_feedback_option_item"]');
  const optionCount = await options.count();
  const matchingIndexes = [];
  for (let index = 0; index < optionCount; index += 1) {
    if ((await options.nth(index).innerText()).trim() === label) matchingIndexes.push(index);
  }
  if (matchingIndexes.length !== 1) {
    throw new Error(`Expected one feedback option labelled ${JSON.stringify(label)}, found ${matchingIndexes.length}.`);
  }
  throwIfJobPauseRequested(signal);
  await options.nth(matchingIndexes[0]).click();
  await page.waitForTimeout(500);
  return await inspectFeedbackSurface(page);
}

export async function completeOpenFeedback(page, { note = "", signal } = {}) {
  throwIfJobPauseRequested(signal);
  const panel = page.locator('[data-testid="message_feedback_post_panel"]');
  if (await panel.count() !== 1) throw new Error("A unique feedback panel is not open.");

  const input = panel.locator('[data-testid="message_feedback_input"]');
  if (note) {
    if (await input.count() !== 1) {
      throw new Error('A feedback note requires selecting the "其他" option first.');
    }
    await input.fill(note);
    if (await input.inputValue() !== note) throw new Error("Feedback note readback did not match.");
  }

  const submit = panel.locator('[data-testid="message_feedback_submit_button"]');
  if (await submit.count() !== 1 || !await submit.isEnabled()) {
    throw new Error("A unique enabled feedback submit button was not available.");
  }
  throwIfJobPauseRequested(signal);
  await submit.click();
  await panel.waitFor({ state: "detached", timeout: 10_000 });
  return {
    note,
    panelClosed: await panel.count() === 0,
    submitted: true,
  };
}

export async function evaluateLatestResponse(page, {
  labels = [],
  note = "",
  signal,
  vote,
} = {}) {
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error("At least one feedback label is required.");
  }
  throwIfJobPauseRequested(signal);
  const opened = await openLatestFeedback(page, vote, { signal });
  for (const label of labels) await selectFeedbackOption(page, label, { signal });
  const completed = await completeOpenFeedback(page, { note, signal });
  return {
    ...completed,
    labels,
    responseCount: opened.responseCount,
    vote,
  };
}

export async function openLatestShare(page, { signal } = {}) {
  throwIfJobPauseRequested(signal);
  const responses = page.locator(SELECTORS.receivedMessage);
  const responseCount = await responses.count();
  if (responseCount === 0) throw new Error("No received message is available to share.");
  const container = responses.nth(responseCount - 1);
  await container.hover({ force: true });
  const share = container.locator(SELECTORS.messageShare);
  if (await share.count() !== 1) throw new Error("A unique share action was not available.");
  throwIfJobPauseRequested(signal);
  await share.click();
  await page.waitForTimeout(1_000);

  const dialogs = page.locator('[role="dialog"]');
  const dialogCount = await dialogs.count();
  const dialogTexts = [];
  for (let index = 0; index < dialogCount; index += 1) {
    if (await dialogs.nth(index).isVisible()) dialogTexts.push((await dialogs.nth(index).innerText()).trim());
  }
  const relevantNodes = await page.locator(
    '[data-testid*="share"], [data-testid*="modal"], [data-testid*="dialog"], input, textarea',
  ).evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      dataTestId: element.getAttribute("data-testid"),
      placeholder: element.getAttribute("placeholder"),
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.value || "").trim().slice(0, 1_000),
      type: element.getAttribute("type"),
      visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
    };
  }).filter((node) => node.visible));

  return {
    bodyTail: (await page.locator("body").innerText()).slice(-3_000),
    dialogCount,
    dialogTexts,
    relevantNodes,
    responseCount,
    url: page.url(),
  };
}

export async function copyOpenShareLink(page, { selectAll = true, signal } = {}) {
  throwIfJobPauseRequested(signal);
  const title = page.locator('[data-testid="thread_share_title"]:visible');
  const copyButton = page.locator('[data-testid="thread_share_copy_btn"]:visible');
  if (await title.count() !== 1 || await copyButton.count() !== 1) {
    throw new Error("A unique share selection panel is not open.");
  }

  const checkboxes = page.locator('input[type="checkbox"]:visible');
  const checkboxCount = await checkboxes.count();
  const selectAllControl = page.locator('[data-testid="thread_share_select_all"]:visible');
  if (await selectAllControl.count() !== 1) throw new Error("Select-all control was not available.");
  const selectAllCheckbox = selectAllControl.locator('input[type="checkbox"]');
  if (await selectAllCheckbox.count() !== 1) throw new Error("Select-all checkbox was not unique.");
  const readChecks = async () => {
    const values = [];
    for (let index = 0; index < checkboxCount; index += 1) {
      values.push(await checkboxes.nth(index).isChecked());
    }
    return values;
  };
  const checkedBefore = await readChecks();
  const selectAllCheckedBefore = await selectAllCheckbox.isChecked();
  if (selectAll && !selectAllCheckedBefore) {
    throwIfJobPauseRequested(signal);
    await selectAllControl.click();
    await page.waitForTimeout(300);
  }
  const checkedAfter = await readChecks();
  const selectAllCheckedAfter = await selectAllCheckbox.isChecked();
  if (selectAll && !selectAllCheckedAfter) throw new Error("Global select-all state was not selected.");

  let clipboardPermissionError = "";
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  } catch (error) {
    clipboardPermissionError = error.message;
  }
  throwIfJobPauseRequested(signal);
  await copyButton.click();
  await page.waitForTimeout(800);

  let clipboardText = "";
  let clipboardReadError = "";
  try {
    clipboardText = await page.evaluate(async () => await navigator.clipboard.readText());
  } catch (error) {
    clipboardReadError = error.message;
  }
  return {
    checkedAfter,
    checkedBefore,
    checkboxCount,
    clipboardPermissionError,
    clipboardReadError,
    clipboardText,
    copied: true,
    selectAll,
    selectAllCheckedAfter,
    selectAllCheckedBefore,
  };
}

export async function openLatestMoreMenu(page) {
  const responses = page.locator(SELECTORS.receivedMessage);
  const responseCount = await responses.count();
  if (responseCount === 0) throw new Error("No received message is available.");
  const container = responses.nth(responseCount - 1);
  await container.hover({ force: true });
  const more = container.locator(SELECTORS.messageMore);
  if (await more.count() !== 1) throw new Error("A unique more-menu action was not available.");
  await more.click();
  await page.waitForTimeout(500);

  const visibleMenus = page.locator('[role="menu"]:visible, [role="listbox"]:visible');
  const visibleMenuCount = await visibleMenus.count();
  const menus = [];
  for (let index = 0; index < visibleMenuCount; index += 1) {
    menus.push({
      text: (await visibleMenus.nth(index).innerText()).trim(),
      testId: await visibleMenus.nth(index).getAttribute("data-testid"),
    });
  }
  return {
    bodyTail: (await page.locator("body").innerText()).slice(-2_000),
    menus,
    responseCount,
    visibleMenuCount,
  };
}

export function parseCopiedLogInfo(text) {
  const value = String(text ?? "");
  return {
    feedbackUrl: value.match(/(?:反馈内容|Feedback)\s*[:：]\s*(https?:\/\/\S+)/iu)?.[1] ?? "",
    logId: value.match(/(?:日志\s*ID|Log\s*ID)\s*[:：]\s*([A-Za-z0-9_-]+)/iu)?.[1] ?? "",
    raw: value,
  };
}

export async function copyLatestLogInfo(page, { signal } = {}) {
  throwIfJobPauseRequested(signal);
  const responses = page.locator(SELECTORS.receivedMessage);
  const responseCount = await responses.count();
  if (responseCount === 0) throw new Error("No received message is available.");
  const container = responses.nth(responseCount - 1);
  await container.hover({ force: true });
  const more = container.locator(SELECTORS.messageMore);
  if (await more.count() !== 1) throw new Error("A unique more-menu action was not available.");
  throwIfJobPauseRequested(signal);
  await more.click();

  const menu = page.locator('[role="menu"]:visible');
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  if (await menu.count() !== 1) throw new Error("A unique visible message menu was not available.");
  const reportItem = menu.getByText("反馈与举报", { exact: true });
  if (await reportItem.count() !== 1) throw new Error("Feedback and report menu item was not available.");
  throwIfJobPauseRequested(signal);
  await reportItem.click({ force: true });

  const confirmation = page.getByText("确认反馈", { exact: true });
  await confirmation.waitFor({ state: "visible", timeout: 5_000 });
  const copyButton = page.getByRole("button", { name: "复制信息", exact: true });
  if (await copyButton.count() !== 1) throw new Error("A unique copy-info button was not available.");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  throwIfJobPauseRequested(signal);
  await copyButton.click();
  await page.waitForTimeout(500);
  const clipboardText = await page.evaluate(async () => await navigator.clipboard.readText());
  const parsed = parseCopiedLogInfo(clipboardText);
  if (!parsed.feedbackUrl || !parsed.logId) {
    throw new Error("Copied feedback information did not contain both a URL and log ID.");
  }
  await page.keyboard.press("Escape");

  return {
    ...parsed,
    responseCount,
  };
}

export async function openLatestFeedback(page, vote, { signal } = {}) {
  throwIfJobPauseRequested(signal);
  const voteSelector = vote === "like"
    ? SELECTORS.messageLike
    : vote === "dislike" ? SELECTORS.messageDislike : null;
  if (!voteSelector) throw new Error('vote must be either "like" or "dislike".');

  const responses = page.locator(SELECTORS.receivedMessage);
  const responseCount = await responses.count();
  if (responseCount === 0) throw new Error("No received message is available to evaluate.");
  const container = responses.nth(responseCount - 1);
  await container.hover({ force: true });
  const action = container.locator(voteSelector);
  const actionCount = await action.count();
  if (actionCount !== 1) {
    throw new Error(`Expected one ${vote} action on the latest response, found ${actionCount}.`);
  }
  throwIfJobPauseRequested(signal);
  await action.click();
  await page.waitForTimeout(800);

  return {
    responseCount,
    surface: await inspectFeedbackSurface(page),
    vote,
  };
}

export async function waitForResponse(page, {
  previousCount,
  previousIdentity = "",
  previousText = "",
  signal,
  timeoutMs = 180_000,
  pollMs = 500,
  stableSamples = 3,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const responses = page.locator(SELECTORS.receivedMessage);
  let lastText = "";
  let unchangedSamples = 0;

  while (Date.now() < deadline) {
    throwIfJobPauseRequested(signal);
    const count = await responses.count();
    if (count > 0) {
      const container = responses.nth(count - 1);
      const identity = await responseIdentityFromContainer(container);
      const text = await responseTextFromContainer(container);
      const isNewResponse = isNewResponseSnapshot({
        count,
        identity,
        previousCount,
        previousIdentity,
        previousText,
        text,
      });
      if (!isNewResponse) {
        await page.waitForTimeout(pollMs);
        continue;
      }
      const breakButton = page.locator(SELECTORS.breakButton);
      const breakVisible = await breakButton.count() === 1 && await breakButton.isVisible();

      if (text && text === lastText) unchangedSamples += 1;
      else unchangedSamples = 0;
      lastText = text;

      if (text && !breakVisible && unchangedSamples >= stableSamples) {
        const stableIdentity = await responseIdentityFromContainer(container, { timeoutMs: 3_000 })
          || identity
          || `response-${count}`;
        return {
          artifacts: await responseArtifactEvidenceFromContainer(container),
          count,
          identity: stableIdentity,
          text,
        };
      }
    }
    await page.waitForTimeout(pollMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for a complete response.`);
}

function comparableSentText(value) {
  return String(value ?? "").replace(/\s+/gu, "").trim();
}

export function isNewResponseSnapshot({
  count,
  identity = "",
  previousCount = 0,
  previousIdentity = "",
  previousText = "",
  text = "",
} = {}) {
  return count > previousCount
    || Boolean(identity && identity !== previousIdentity)
    || Boolean(text && comparableSentText(text) !== comparableSentText(previousText));
}

async function waitForSentPromptReadback(page, expectedText, before, {
  pollMs = 250,
  signal,
  timeoutMs = 15_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const expected = comparableSentText(expectedText);
  while (Date.now() < deadline) {
    throwIfJobPauseRequested(signal);
    const latest = await inspectLatestSentPrompt(page);
    const changed = latest.count > before.count
      || (latest.identity && latest.identity !== before.identity)
      || comparableSentText(latest.text) !== comparableSentText(before.text);
    if (changed && comparableSentText(latest.text) === expected) {
      return {
        countAfter: latest.count,
        countBefore: before.count,
        identity: latest.identity,
        pass: true,
        prompt: latest.text,
        verifiedAt: new Date().toISOString(),
      };
    }
    await page.waitForTimeout(pollMs);
  }
  return null;
}

export async function sendAndWait(page, text, options = {}) {
  const {
    attachments = [],
    attachmentUploadTimeoutMs = 180_000,
    signal,
    ...waitOptions
  } = options;
  throwIfJobPauseRequested(signal);
  await ensureLocalComputerDisabled(page);
  const state = await inspectChat(page);
  if (state.loginRequired) throw new Error("Doubao login is required before sending.");
  if (!state.officeModeActive || state.composerKind !== "office") {
    throw new Error("Office Task mode is not active.");
  }
  if (!state.localComputerStateKnown || state.localComputerActive !== false) {
    throw new Error("Local Computer must be verifiably disabled before sending.");
  }

  const responses = page.locator(SELECTORS.receivedMessage);
  const previousCount = await responses.count();
  const previousIdentity = previousCount > 0
    ? await responseIdentityFromContainer(responses.nth(previousCount - 1), { timeoutMs: 3_000 })
    : "";
  const previousText = previousCount > 0
    ? await responseTextFromContainer(responses.nth(previousCount - 1))
    : "";
  const sentBefore = await inspectLatestSentPrompt(page);
  const startedAt = new Date().toISOString();
  const startedTick = Date.now();
  await fillComposer(page, text);
  throwIfJobPauseRequested(signal);
  const attachmentUpload = attachments.length
    ? await uploadComposerAttachments(page, attachments, {
      signal,
      timeoutMs: attachmentUploadTimeoutMs,
    })
    : null;
  if (attachmentUpload) {
    await assertComposerAttachmentsReady(page, attachmentUpload.expectedNames);
  }

  const sendButton = page.locator(SELECTORS.sendButton);
  if (await sendButton.count() !== 1 || !await sendButton.isEnabled()) {
    throw new Error("A unique enabled send button was not available.");
  }
  throwIfJobPauseRequested(signal);
  await sendButton.click();
  let sendReceipt = await waitForSentPromptReadback(page, text, sentBefore, { signal });
  if (!sendReceipt && attachments.length === 0) {
    await fillComposer(page, text);
    const retryButton = page.locator(SELECTORS.sendButton);
    if (await retryButton.count() !== 1 || !await retryButton.isEnabled()) {
      throw new Error("The send button was not available for the single readback retry.");
    }
    throwIfJobPauseRequested(signal);
    await retryButton.click();
    sendReceipt = await waitForSentPromptReadback(page, text, sentBefore, { signal });
  }
  if (!sendReceipt) {
    const error = new Error("The sent prompt did not appear in Doubao after the allowed readback attempt.");
    error.code = "SEND_READBACK_FAILED";
    throw error;
  }
  let response;
  try {
    response = await waitForResponse(page, {
      previousCount,
      previousIdentity,
      previousText,
      signal,
      ...waitOptions,
    });
  } catch (error) {
    if (error?.code === JOB_PAUSE_REQUESTED) {
      const breakButton = page.locator(SELECTORS.breakButton);
      if (await breakButton.count() === 1 && await breakButton.isVisible()) {
        await breakButton.click({ force: true });
        await page.waitForTimeout(300);
      }
    }
    throw error;
  }
  const url = page.url();

  return {
    attachmentUpload,
    artifacts: response.artifacts,
    completedAt: new Date().toISOString(),
    conversationId: conversationIdFromUrl(url),
    durationMs: Date.now() - startedTick,
    prompt: text,
    response: response.text,
    responseIdentity: response.identity,
    responseCount: response.count,
    sendReceipt,
    startedAt,
    url,
  };
}

export async function recoverLatestSentExchange(page, text, {
  attachmentNames = [],
  pollMs = 500,
  signal,
  stableSamples = 3,
  timeoutMs = 20_000,
} = {}) {
  throwIfJobPauseRequested(signal);
  await ensureLocalComputerDisabled(page);
  const state = await inspectChat(page);
  if (state.loginRequired) throw new Error("Doubao login is required before recovery.");
  if (!state.officeModeActive || state.composerKind !== "office") {
    throw new Error("Office Task mode is not active for recovery.");
  }
  if (!state.localComputerStateKnown || state.localComputerActive !== false) {
    throw new Error("Local Computer must be verifiably disabled before recovery.");
  }

  const sent = await inspectLatestSentPrompt(page);
  if (!sent.text || comparableSentText(sent.text) !== comparableSentText(text)) {
    const error = new Error("The latest visible Doubao prompt does not match the resumable round.");
    error.code = "RECOVERY_PROMPT_MISMATCH";
    throw error;
  }

  const expectedNames = attachmentNames.map(String);
  const sentMessages = page.locator('[data-testid="send_message"]');
  const sentTexts = await sentMessages.allInnerTexts();
  const currentConversationSurface = [state.bodyText, ...sentTexts].join("\n");
  const directlyVisibleNames = expectedNames.filter((name) => currentConversationSurface.includes(name));
  const collapsedCounts = [...currentConversationSurface.matchAll(/^\+(\d+)$/gmu)]
    .map((match) => Number(match[1]))
    .filter((count) => Number.isInteger(count) && count > 0);
  const collapsedAttachmentCount = collapsedCounts.length ? Math.max(...collapsedCounts) : 0;
  const visibleAttachmentCount = directlyVisibleNames.length + collapsedAttachmentCount;
  if (visibleAttachmentCount !== expectedNames.length) {
    const error = new Error("The latest Doubao exchange does not show every expected attachment name.");
    error.code = "RECOVERY_ATTACHMENT_MISMATCH";
    throw error;
  }
  const visibleNames = directlyVisibleNames.length === expectedNames.length
    ? directlyVisibleNames
    : expectedNames;

  const deadline = Date.now() + timeoutMs;
  let lastIdentity = "";
  let lastText = "";
  let unchangedSamples = 0;
  while (Date.now() < deadline) {
    throwIfJobPauseRequested(signal);
    const responses = page.locator(SELECTORS.receivedMessage);
    const count = await responses.count();
    if (count > 0) {
      const container = responses.nth(count - 1);
      const identity = await responseIdentityFromContainer(container, { timeoutMs: 3_000 })
        || `response-${count}`;
      const responseText = await responseTextFromContainer(container);
      const breakButton = page.locator(SELECTORS.breakButton);
      const breakVisible = await breakButton.count() === 1 && await breakButton.isVisible();
      if (identity === lastIdentity && responseText && responseText === lastText) unchangedSamples += 1;
      else unchangedSamples = 0;
      lastIdentity = identity;
      lastText = responseText;
      if (responseText && !breakVisible && unchangedSamples >= stableSamples) {
        const recoveredAt = new Date().toISOString();
        return {
          attachmentUpload: expectedNames.length ? {
            completedAt: recoveredAt,
            expectedCount: expectedNames.length,
            expectedNames,
            fileInputMultiple: true,
            pass: true,
            collapsedAttachmentCount,
            directlyVisibleNames,
            recoveredFromVisibleReadback: true,
            selectedNames: expectedNames,
            startedAt: recoveredAt,
            visibleCount: visibleNames.length,
            visibleNames,
          } : null,
          artifacts: await responseArtifactEvidenceFromContainer(container),
          completedAt: recoveredAt,
          conversationId: conversationIdFromUrl(page.url()),
          durationMs: 0,
          prompt: text,
          recoveredFromVisibleReadback: true,
          response: responseText,
          responseCount: count,
          responseIdentity: identity,
          sendReceipt: {
            countAfter: sent.count,
            countBefore: Math.max(0, sent.count - 1),
            identity: sent.identity,
            pass: true,
            prompt: sent.text,
            recoveredFromVisibleReadback: true,
            verifiedAt: recoveredAt,
          },
          startedAt: recoveredAt,
          url: page.url(),
        };
      }
    }
    await page.waitForTimeout(pollMs);
  }
  const error = new Error(`Timed out after ${timeoutMs}ms recovering the visible Doubao response.`);
  error.code = "RECOVERY_RESPONSE_TIMEOUT";
  throw error;
}

export async function inspectLatestSentPrompt(page) {
  const sent = page.locator('[data-testid="send_message"]');
  const count = await sent.count();
  if (count === 0) return { count, identity: "", text: "" };
  const container = sent.nth(count - 1);
  return {
    count,
    identity: await responseIdentityFromContainer(container, { timeoutMs: 3_000 }),
    text: await responseTextFromContainer(container),
  };
}
