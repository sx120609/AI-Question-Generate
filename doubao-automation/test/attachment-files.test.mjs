import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareJobAttachments,
  selectPreparedAttachments,
  validateAttachmentConfig,
  verifyPreparedAttachments,
} from "../src/attachment-files.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function config(root, bytes) {
  return {
    mode: "scripted",
    developmentOnlyScripted: true,
    attachmentRoot: root,
    attachments: [{
      name: "附件一_设备巡检记录.xlsx",
      relativePath: "附件一_设备巡检记录.xlsx",
      sha256: digest(bytes),
      sourceUrl: "https://www.ccgp.gov.cn/cggg/dfgg/cjgg/202607/t20260718_000001.htm",
      summary: "记录试点设备2026年7月的逐台巡检结果和状态。",
      classification: "specific-business",
      objectLevel: true,
      timeAnchor: "2026年7月试点巡检",
      specificityEvidence: {
        object: "试点设备清单",
        periodOrEvent: "2026年7月巡检",
        uniqueContent: "包含逐台设备指纹、实际状态和核对结果",
      },
    }],
  };
}

test("prepares and reverifies a hash-bound L2-grade attachment manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-attachments-"));
  const bytes = Buffer.from("real attachment fixture");
  const filePath = path.join(root, "附件一_设备巡检记录.xlsx");
  try {
    await writeFile(filePath, bytes);
    const manifest = await prepareJobAttachments(config(root, bytes));
    assert.equal(manifest.receipt.pass, true);
    assert.equal(manifest.receipt.specificBusinessShare, 1);
    assert.deepEqual(manifest.receipt.initialAttachmentNames, ["附件一_设备巡检记录.xlsx"]);
    assert.equal(manifest.attachments[0].absolutePath, filePath);
    assert.equal((await verifyPreparedAttachments(manifest)).pass, true);
    assert.deepEqual(
      selectPreparedAttachments(manifest, ["附件一_设备巡检记录.xlsx"]).map((item) => item.name),
      ["附件一_设备巡检记录.xlsx"],
    );
    assert.equal((await verifyPreparedAttachments(manifest, {
      names: ["附件一_设备巡检记录.xlsx"],
    })).attachmentCount, 1);
    await writeFile(filePath, "tampered");
    await assert.rejects(verifyPreparedAttachments(manifest), /SHA-256 mismatch/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects empty, public-only and path-escaping attachment configs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-attachments-invalid-"));
  try {
    assert.throws(() => validateAttachmentConfig({ attachmentRoot: root, attachments: [] }), /at least one/u);
    const publicOnly = config(root, Buffer.from("x"));
    publicOnly.attachments[0] = {
      ...publicOnly.attachments[0],
      classification: "rule-background",
      objectLevel: false,
    };
    assert.throws(() => validateAttachmentConfig(publicOnly), /specific-business-share-below-minimum/u);
    const escaped = config(root, Buffer.from("x"));
    escaped.attachments[0].relativePath = `..${path.sep}${escaped.attachments[0].name}`;
    assert.throws(() => validateAttachmentConfig(escaped), /stay inside/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("allows a verified attachment pool to be introduced over multiple rounds", () => {
  const root = path.resolve(os.tmpdir(), "doubao-attachment-plan");
  const bytes = Buffer.from("planned attachment");
  const value = config(root, bytes);
  value.attachments.push({
    ...structuredClone(value.attachments[0]),
    name: "附件二_补充核对截图.png",
    relativePath: "附件二_补充核对截图.png",
    sourceUrl: "https://www.ccgp.gov.cn/cggg/dfgg/cjgg/202607/t20260718_000002.htm",
  });
  value.initialAttachmentNames = [value.attachments[0].name];
  const validated = validateAttachmentConfig(value);
  assert.deepEqual(validated.initialAttachmentNames, [value.attachments[0].name]);
  assert.equal(validated.attachments.length, 2);
  assert.throws(() => validateAttachmentConfig({
    ...value,
    initialAttachmentNames: ["不存在的附件.png"],
  }), /unknown files/u);
});
