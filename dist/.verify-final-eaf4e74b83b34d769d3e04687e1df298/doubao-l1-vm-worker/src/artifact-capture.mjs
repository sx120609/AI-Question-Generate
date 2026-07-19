import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { throwIfJobPauseRequested } from "./job-control.mjs";

const PNG_SIGNATURE = "89504e470d0a1a0a";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngSignature(bytes) {
  return bytes.subarray(0, 8).toString("hex");
}

async function responseIdentity(container, { timeoutMs = 3_000 } = {}) {
  try {
    const row = container.locator('xpath=ancestor-or-self::*[@data-observe-row][1]');
    if (await row.count() !== 1) return "";
    return await row.getAttribute("data-observe-row", { timeout: timeoutMs }) || "";
  } catch {
    return "";
  }
}

async function responseText(container) {
  const blocks = container.locator('[data-testid="message_text_content"]');
  if (await blocks.count()) {
    const parts = (await blocks.allInnerTexts()).map((part) => part.trim()).filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return (await container.innerText()).trim();
}

export function artifactRootForResult(resultPath) {
  const resolved = path.resolve(resultPath);
  const extension = path.extname(resolved);
  const base = extension ? resolved.slice(0, -extension.length) : resolved;
  return `${base}.artifacts`;
}

export function responseScreenshotPath(resultPath, roundNumber) {
  if (!Number.isInteger(Number(roundNumber)) || Number(roundNumber) < 1) {
    throw new Error("roundNumber must be a positive integer.");
  }
  return path.join(artifactRootForResult(resultPath), `round-${String(roundNumber).padStart(2, "0")}-response.png`);
}

export async function captureLatestResponseScreenshot(page, {
  expectedIdentity,
  expectedText,
  outputPath,
  signal,
} = {}) {
  if (!path.isAbsolute(String(outputPath ?? "")) || path.extname(outputPath).toLowerCase() !== ".png") {
    throw new Error("Screenshot outputPath must be an absolute .png path.");
  }
  throwIfJobPauseRequested(signal);
  const responses = page.locator('[data-testid="receive_message"]');
  const responseCount = await responses.count();
  if (responseCount < 1) throw new Error("No received message is available for screenshot capture.");
  const container = responses.nth(responseCount - 1);
  const identityBefore = await responseIdentity(container) || `response-${responseCount}`;
  const textBefore = await responseText(container);
  if (!identityBefore || identityBefore !== String(expectedIdentity ?? "")) {
    throw new Error("Latest response identity changed before screenshot capture.");
  }
  if (textBefore !== String(expectedText ?? "")) {
    throw new Error("Latest response text changed before screenshot capture.");
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.png`;
  try {
    throwIfJobPauseRequested(signal);
    const capturedBytes = await container.screenshot({
      animations: "disabled",
      caret: "hide",
      path: temporaryPath,
      type: "png",
    });
    if (!capturedBytes.length || pngSignature(capturedBytes) !== PNG_SIGNATURE) {
      throw new Error("Captured response screenshot is not a valid PNG.");
    }
    const diskBytes = await readFile(temporaryPath);
    if (digest(diskBytes) !== digest(capturedBytes)) {
      throw new Error("Screenshot file readback did not match captured bytes.");
    }
    await rename(temporaryPath, outputPath);
    const finalBytes = await readFile(outputPath);
    const responseCountAfter = await responses.count();
    const identityAfter = await responseIdentity(container) || `response-${responseCountAfter}`;
    const textAfter = await responseText(container);
    if (responseCountAfter !== responseCount || identityAfter !== identityBefore || textAfter !== textBefore) {
      throw new Error("Latest response changed during screenshot capture.");
    }
    return {
      capturedAt: new Date().toISOString(),
      pass: true,
      responseCount,
      responseIdentity: identityBefore,
      sha256: digest(finalBytes),
      sizeBytes: finalBytes.length,
    };
  } catch (error) {
    error.code ||= "PRODUCT_SCREENSHOT_CAPTURE_FAILED";
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function isPngBytes(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 8 && pngSignature(bytes) === PNG_SIGNATURE;
}
