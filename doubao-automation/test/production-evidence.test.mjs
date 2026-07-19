import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareJobAttachments, validateAttachmentConfig } from "../src/attachment-files.mjs";
import { hydrateJobAttachmentsFromProductionTrace } from "../src/production-evidence.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(filePath, bytes);
  return { hash: digest(bytes), path: filePath };
}

async function productionFixture(root) {
  const attachmentRoot = path.join(root, "attachments", "01");
  const sourceRoot = path.join(root, "sources");
  const qaRoot = path.join(root, "qa");
  const feishuRoot = path.join(root, "feishu");
  await Promise.all([
    mkdir(attachmentRoot, { recursive: true }),
    mkdir(sourceRoot, { recursive: true }),
    mkdir(qaRoot, { recursive: true }),
    mkdir(feishuRoot, { recursive: true }),
  ]);
  const bytes = Buffer.from("downloaded official business record fixture");
  const name = "附件一_公开采购项目成交记录.html";
  const sourceUrl = "https://www.ccgp.gov.cn/cggg/dfgg/cjgg/202607/t20260718_000001.htm";
  const attachmentPath = path.join(attachmentRoot, name);
  const attachmentHash = digest(bytes);
  await writeFile(attachmentPath, bytes);
  const attachment = {
    name,
    relativePath: name,
    sha256: attachmentHash,
    sizeBytes: bytes.length,
    sourceUrl,
    summary: "记录公开采购项目、成交时间、采购对象和成交结果。",
    classification: "specific-business",
    objectLevel: true,
    timeAnchor: "2026年7月公开成交事件",
    specificityEvidence: {
      object: "公开采购项目",
      periodOrEvent: "2026年7月成交公告",
      uniqueContent: "包含该项目采购对象、成交供应商和成交结果",
    },
  };
  const recordUid = "测试_7.18_L1_01";
  const traceFile = await writeJson(path.join(qaRoot, "production_trace.json"), {
    schemaVersion: 3,
    kind: "l1-production-trace",
    productionProfile: "l1",
    runId: "l1-production-fixture",
    questions: [{
      recordUid,
      attachmentBuild: {
        attachments: [{
          ...attachment,
          localPath: attachmentPath,
          bytes: bytes.length,
        }],
      },
    }],
  });
  const candidateHash = "a".repeat(64);
  const traceReceiptFile = await writeJson(path.join(feishuRoot, "production_trace_gate_receipt.json"), {
    schemaVersion: 1,
    kind: "l1-production-trace-gate-receipt",
    productionProfile: "l1",
    status: "PASS",
    traceHash: traceFile.hash,
    candidateHash,
  });
  const releaseReceiptFile = await writeJson(path.join(feishuRoot, "release_gate_receipt.json"), {
    schemaVersion: 2,
    kind: "release-gate-receipt",
    ok: true,
    status: "PASS",
    rowHashes: [{ uid: recordUid, hash: "b".repeat(64) }],
    naturalness: { candidateHash },
  });
  const downloadManifestFile = await writeJson(path.join(sourceRoot, "download_manifest.json"), {
    generatedAt: "2026-07-18T00:00:00.000Z",
    items: [{
      name,
      url: sourceUrl,
      path: attachmentPath,
      size: bytes.length,
      sha256: attachmentHash,
      contentType: "text/html; charset=utf-8",
      finalUrl: sourceUrl,
    }],
  });
  return {
    attachmentRoot,
    attachments: [attachment],
    initialAttachmentNames: [name],
    productionEvidence: {
      recordUid,
      productionTracePath: traceFile.path,
      productionTraceGateReceiptPath: traceReceiptFile.path,
      releaseGateReceiptPath: releaseReceiptFile.path,
      downloadManifestPath: downloadManifestFile.path,
    },
  };
}

test("accepts only attachments signed by the shared L1/L2 production path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-production-evidence-"));
  try {
    const config = await productionFixture(root);
    const rawJob = structuredClone(config);
    delete rawJob.attachments;
    const hydrated = await hydrateJobAttachmentsFromProductionTrace(rawJob);
    assert.equal(hydrated._attachmentsHydratedFromProductionEvidence, true);
    assert.deepEqual(hydrated.attachments.map((item) => item.name), config.attachments.map((item) => item.name));
    const prepared = await prepareJobAttachments(config);
    assert.equal(prepared.receipt.productionEvidence.pass, true);
    assert.equal(prepared.receipt.productionEvidence.policyId, "reuse-l2-source-acquisition-path-v1");
    assert.equal(prepared.receipt.productionEvidence.recordUid, "测试_7.18_L1_01");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("blocks placeholder sources and hand-written attachment lists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-production-evidence-invalid-"));
  try {
    const config = await productionFixture(root);
    await assert.rejects(hydrateJobAttachmentsFromProductionTrace(config), /hand-written attachment arrays are forbidden/u);
    const placeholder = structuredClone(config);
    placeholder.attachments[0].sourceUrl = "https://ops.example.cn/export/1";
    assert.throws(() => validateAttachmentConfig(placeholder), /placeholder or reserved/u);

    const unsigned = structuredClone(config);
    delete unsigned.productionEvidence;
    await assert.rejects(prepareJobAttachments(unsigned), /productionEvidence is required/u);

    const changed = structuredClone(config);
    changed.attachments[0].summary = "手工改写后的摘要";
    await assert.rejects(prepareJobAttachments(changed), /does not match production trace field summary/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
