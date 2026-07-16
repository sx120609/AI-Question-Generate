import fs from "node:fs/promises";
import path from "node:path";
import {
  assertClearQuestionRequest,
  assertNaturalQuestionPresentation,
} from "../automation/language_style.mjs";
import { verifyReleaseReceiptUpdates } from "../automation/release_gate.mjs";

const DEFAULT_ADDRESS_BOX = { x: 23, y: 231 };
const RELEASE_VERIFIED = Symbol("release-verified");
const RELEASE_BOUND_FIELDS = new Map([
  ["B", "题目"],
  ["G", "任务概括"],
  ["L", "附件内容"],
  ["N", "产物内容"],
  ["O", "做题关键步骤"],
]);

function releaseBoundUpdate(address, value, field = "") {
  const match = String(address ?? "").toUpperCase().match(/(?:^|!)\$?([A-Z]+)\$?([1-9]\d*)$/u);
  const column = match?.[1] ?? "";
  const expectedField = RELEASE_BOUND_FIELDS.get(column);
  if (!expectedField) return null;
  if (field && field !== expectedField) {
    throw new Error(`Narrative field/address mismatch at ${address}: ${field} != ${expectedField}`);
  }
  return {
    address: `${column}${match[2]}`,
    column,
    field: expectedField,
    value,
  };
}

async function verifyBrowserNarrativeUpdates(updates, options = {}) {
  if (!updates.length || options[RELEASE_VERIFIED]) return null;
  if (!options.releaseReceiptPath) {
    throw new Error("A v2 release-gate receipt is required at the physical browser boundary for B/G/L/N/O writes.");
  }
  const verification = await verifyReleaseReceiptUpdates({
    receiptPath: options.releaseReceiptPath,
    updates,
    policyPath: options.releasePolicyPath,
  });
  if (!verification.ok) {
    throw new Error(`Physical browser release verification failed: ${verification.errors.join("; ")}`);
  }
  return verification;
}

function waitMsForValue(value) {
  return Math.round(Math.min(1400, Math.max(350, String(value ?? "").length * 1.8)));
}

export async function loadFillPlan(planPath) {
  return JSON.parse(await fs.readFile(planPath, "utf8"));
}

export function flattenPlanUpdates(plan, filters = {}) {
  const onlyRows = filters.onlyRows ? new Set(filters.onlyRows.map(Number)) : null;
  const onlyFields = filters.onlyFields ? new Set(filters.onlyFields) : null;
  const onlyAddresses = filters.onlyAddresses ? new Set(filters.onlyAddresses) : null;

  return plan.rows.flatMap((row) => {
    if (onlyRows && !onlyRows.has(Number(row.sheetRow))) return [];
    return row.updates.filter((item) => {
      if (onlyFields && !onlyFields.has(item.field)) return false;
      if (onlyAddresses && !onlyAddresses.has(item.address)) return false;
      return true;
    });
  });
}

export async function gotoFeishuCell(tab, address, options = {}) {
  const addressBox = options.addressBox ?? DEFAULT_ADDRESS_BOX;
  await tab.cua.click({ x: addressBox.x, y: addressBox.y, button: 1 });
  await tab.playwright.waitForTimeout(options.focusMs ?? 120);
  await tab.cua.keypress({ keys: ["Control", "A"] });
  await tab.cua.type({ text: address });
  await tab.cua.keypress({ keys: ["Enter"] });
  await tab.playwright.waitForTimeout(options.settleMs ?? 650);
}

export async function setFeishuCell(tab, address, value, options = {}) {
  if (/^(?:[^!]+!)?\$?B\$?[1-9]\d*$/iu.test(String(address ?? ""))) {
    assertNaturalQuestionPresentation(value, { label: address });
    assertClearQuestionRequest(value, { label: address });
  }
  const releaseUpdate = releaseBoundUpdate(address, value, options.field ?? "");
  await verifyBrowserNarrativeUpdates(releaseUpdate ? [releaseUpdate] : [], options);
  await gotoFeishuCell(tab, address, options);
  await tab.cua.keypress({ keys: ["F2"] });
  await tab.playwright.waitForTimeout(options.editMs ?? 220);
  await tab.cua.keypress({ keys: ["Control", "A"] });
  await tab.playwright.waitForTimeout(options.selectMs ?? 80);
  await tab.clipboard.writeText(String(value ?? ""));
  await tab.cua.keypress({ keys: ["Control", "V"] });
  await tab.playwright.waitForTimeout(options.pasteMs ?? waitMsForValue(value));
  await tab.cua.keypress({ keys: ["Enter"] });
  await tab.playwright.waitForTimeout(options.afterEnterMs ?? 700);
}

export async function clearFeishuCell(tab, address, options = {}) {
  const releaseUpdate = releaseBoundUpdate(address, "", options.field ?? "");
  await verifyBrowserNarrativeUpdates(releaseUpdate ? [releaseUpdate] : [], options);
  await gotoFeishuCell(tab, address, options);
  await tab.cua.keypress({ keys: ["Delete"] });
  await tab.playwright.waitForTimeout(options.afterDeleteMs ?? 700);
}

async function assertFilesExist(filePaths) {
  for (const filePath of filePaths) {
    await fs.access(filePath);
  }
}

async function openAttachmentChooser(tab, options = {}) {
  await tab.playwright.getByText("插入", { exact: true }).click({
    timeoutMs: options.insertClickTimeoutMs ?? 5000,
  });
  await tab.playwright.waitForTimeout(options.menuMs ?? 500);

  const chooserPromise = tab.playwright.waitForEvent("filechooser", {
    timeoutMs: options.fileChooserTimeoutMs ?? 15000,
  });
  await tab.playwright.getByText("附件", { exact: true }).click({
    timeoutMs: options.attachmentClickTimeoutMs ?? 5000,
  });
  return chooserPromise;
}

export async function uploadFeishuCellAttachments(tab, address, filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error("uploadFeishuCellAttachments requires at least one file path.");
  }

  await assertFilesExist(filePaths);
  await gotoFeishuCell(tab, address, options);
  if (options.clear !== false) {
    await tab.cua.keypress({ keys: ["Delete"] });
    await tab.playwright.waitForTimeout(options.afterDeleteMs ?? 700);
  }

  const uploaded = [];
  const firstChooser = await openAttachmentChooser(tab, options);
  if (firstChooser.isMultiple()) {
    await firstChooser.setFiles(filePaths, { timeoutMs: options.setFilesTimeoutMs ?? 60000 });
    uploaded.push(...filePaths);
  } else {
    await firstChooser.setFiles(filePaths[0], { timeoutMs: options.setFilesTimeoutMs ?? 60000 });
    uploaded.push(filePaths[0]);

    for (const filePath of filePaths.slice(1)) {
      await tab.playwright.waitForTimeout(options.betweenUploadsMs ?? 1200);
      const chooser = await openAttachmentChooser(tab, options);
      await chooser.setFiles(filePath, { timeoutMs: options.setFilesTimeoutMs ?? 60000 });
      uploaded.push(filePath);
    }
  }

  await tab.playwright.waitForTimeout(options.afterUploadMs ?? 10000);
  return {
    address,
    uploadedCount: uploaded.length,
    fileNames: uploaded.map((filePath) => path.basename(filePath)),
  };
}

export async function verifyVisibleAttachmentNames(tab, filePaths, options = {}) {
  if (options.address) {
    await gotoFeishuCell(tab, options.address, options);
  }
  await tab.playwright.waitForTimeout(options.beforeReadMs ?? 800);
  const bodyText = await tab.playwright.evaluate(() => document.body.innerText);
  const fileNames = filePaths.map((filePath) => path.basename(filePath));
  const found = fileNames.filter((name) => bodyText.includes(name) || bodyText.includes(name.replace(/\.[^.]+$/, "")));
  const missing = fileNames.filter((name) => !found.includes(name));
  return {
    ok: missing.length === 0,
    found,
    missing,
  };
}

export async function loadAttachmentQueue(queuePath) {
  const data = JSON.parse(await fs.readFile(queuePath, "utf8"));
  if (!Array.isArray(data.queue)) {
    throw new Error(`Attachment queue missing queue array: ${queuePath}`);
  }
  return data.queue;
}

export async function uploadFeishuAttachmentQueue(tab, queue, options = {}) {
  const results = [];
  for (const item of queue) {
    if (!/^J[1-9]\d*$/.test(item.address)) {
      throw new Error(`Attachment queue can only target J-column cells: ${item.address}`);
    }
    const filePaths = item.files.map((file) => file.path);
    const upload = await uploadFeishuCellAttachments(tab, item.address, filePaths, options);
    const visible = await verifyVisibleAttachmentNames(tab, filePaths, {
      ...options,
      address: item.address,
    });
    results.push({
      row: item.row,
      address: item.address,
      uploaded: upload,
      visible,
    });
  }
  return results;
}

export async function applyFeishuFillPlan(tab, plan, options = {}) {
  const updates = flattenPlanUpdates(plan, options);
  for (const item of updates.filter((update) => update.column === "B" || update.field === "题目")) {
    assertNaturalQuestionPresentation(item.value, { label: item.address });
    assertClearQuestionRequest(item.value, { label: item.address });
  }
  const releaseUpdates = updates
    .map((item) => releaseBoundUpdate(item.address, item.value, item.field))
    .filter(Boolean);
  if (!options.dryRun) await verifyBrowserNarrativeUpdates(releaseUpdates, options);
  const writeOptions = releaseUpdates.length && !options.dryRun
    ? { ...options, [RELEASE_VERIFIED]: true }
    : options;
  const results = [];
  for (const item of updates) {
    if (options.dryRun) {
      results.push({ address: item.address, field: item.field, chars: item.value.length, skipped: true });
      continue;
    }
    await setFeishuCell(tab, item.address, item.value, { ...writeOptions, field: item.field });
    results.push({ address: item.address, field: item.field, chars: item.value.length });
  }
  return results;
}

export function buildQaUrl({
  spreadsheetToken,
  sheetId,
  row,
  qaResultCol = "AC",
  qaNoteCol = "AD",
  qaRowId,
}) {
  const url = new URL("https://qa.251104.xyz/check/sheet");
  url.searchParams.set("spreadsheet_token", spreadsheetToken);
  url.searchParams.set("sheet_id", sheetId);
  url.searchParams.set("row", String(row));
  url.searchParams.set("qa_result_col", qaResultCol);
  url.searchParams.set("qa_note_col", qaNoteCol);
  url.searchParams.set("action", "recheck_row");
  if (qaRowId) url.searchParams.set("qa_row_id", qaRowId);
  return url.toString();
}

export async function runQaChecks(qaItems, fetchImpl = globalThis.fetch) {
  if (!fetchImpl) throw new Error("fetch is not available in this runtime.");

  const results = [];
  for (const item of qaItems) {
    const url = item.url ?? buildQaUrl(item);
    const response = await fetchImpl(url, { redirect: "follow" });
    const html = await response.text();
    const qaStatus = html.includes("✅通过")
      ? "通过"
      : html.includes("❌不通过")
        ? "不通过"
        : "未知";
    const title = html.match(/<p><b>题目：<\/b>(.*?)<\/p>/)?.[1] ?? "";
    const note = html.match(/<div class="box"><b>质检意见：<\/b><br>(.*?)<\/div>/)?.[1] ?? "";
    results.push({ row: item.row, httpStatus: response.status, qaStatus, title, note, url });
  }
  return results;
}
