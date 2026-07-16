import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateReservationStatus, updateRunStatus } from "../../../../build/automation/run_context.mjs";
import { updateTopicStatus } from "../../../../build/automation/topic_registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../../..");
const runId = "l2_shenli_20260709T202051Z_866b59";
const runRoot = path.join(root, "outputs", "auto_runs", runId);
const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";
const reservationId = `${runId}_178_180`;
const rows = [178, 179, 180];
const uids = ["沈礼_7.10_04", "沈礼_7.10_05", "沈礼_7.10_06"];
const attachmentCounts = [5, 6, 6];

async function main() {
  const [verification, topics, attachmentManifest] = await Promise.all([
    fs.readFile(path.join(runRoot, "feishu", "final_remote_verification_178_180.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(runRoot, "sources", "topics_178_180.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(runRoot, "attachment_manifest.json"), "utf8").then(JSON.parse),
  ]);
  if (!verification.ok || !verification.qa?.every((item) => item.ok)) {
    throw new Error("Final remote verification or QA is not fully passing.");
  }
  if (attachmentManifest.attachmentCount !== 17) {
    throw new Error(`Expected 17 attachments, got ${attachmentManifest.attachmentCount}`);
  }
  if (JSON.stringify(topics.map((topic) => topic.topicId)) !== JSON.stringify(uids)) {
    throw new Error("Topic IDs do not match canonical Shen Li UIDs.");
  }

  const completedAt = new Date().toISOString();
  const topicUpdates = [];
  for (let index = 0; index < topics.length; index += 1) {
    const topic = topics[index];
    topicUpdates.push(
      await updateTopicStatus(topic.topicId, "accepted", {
        runId,
        owner: runId,
        patch: {
          ...topic,
          uid: uids[index],
          sheetRow: rows[index],
          qaStatus: "passed",
          attachmentObjects: attachmentCounts[index],
          productFormat: "docx, xlsx",
          completedAt,
        },
      }),
    );
  }

  const reservation = await updateReservationStatus({
    spreadsheetToken,
    sheetId,
    reservationId,
    status: "accepted",
    owner: runId,
    patch: {
      rows,
      uids,
      completedUids: uids,
      generatedAnnotator: "沈礼",
      managedBySystem: true,
      qa: {
        resultColumn: "AT",
        noteColumn: "AU",
        status: "passed",
        rows,
      },
      attachmentCounts,
      completedAt,
    },
  });
  await fs.writeFile(
    path.join(runRoot, "feishu", "reservation_178_180.json"),
    `${JSON.stringify(reservation, null, 2)}\n`,
    "utf8",
  );

  const runManifest = await updateRunStatus(runRoot, "accepted", {
    rows,
    reservedRows: rows,
    uids,
    completedRows: rows,
    completedUids: uids,
    generatedAnnotator: "沈礼",
    managedBySystem: true,
    topicIds: uids,
    qaStatus: "passed",
    qaColumns: { result: "AT", note: "AU" },
    attachmentCounts,
    attachmentCount: attachmentCounts.reduce((sum, value) => sum + value, 0),
    productFormats: ["docx, xlsx"],
    completedAt,
  });

  const summary = {
    ok: true,
    runId,
    completedAt,
    spreadsheetToken,
    sheetId,
    rows: topics.map((topic, index) => ({
      row: rows[index],
      uid: uids[index],
      title: topic.title,
      attachmentCount: attachmentCounts[index],
      productFormat: "docx, xlsx",
      qa: "✅通过",
    })),
    totalAttachments: attachmentCounts.reduce((sum, value) => sum + value, 0),
    verificationPath: path.join(runRoot, "feishu", "final_remote_verification_178_180.json"),
    draftPath: path.join(runRoot, "drafts", "l2_questions_178_180_shenli_710.tsv"),
    manifestStatus: runManifest.status,
    reservationStatus: reservation.status,
    topicStatuses: topicUpdates.map((topic) => ({ topicId: topic.topicId, status: topic.status })),
  };
  await fs.writeFile(
    path.join(runRoot, "final_summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  const markdown = [
    `# ${runId}`,
    "",
    "沈礼新增三条 L2 记录已完成并提交飞书。",
    "",
    "| 行 | UID | 主题 | 附件 | 产物格式 | QA |",
    "|---:|---|---|---:|---|---|",
    ...summary.rows.map(
      (item) => `| ${item.row} | ${item.uid} | ${item.title} | ${item.attachmentCount} | ${item.productFormat} | ${item.qa} |`,
    ),
    "",
    `合计附件：${summary.totalAttachments}。远端正文、附件名与数量、身份、产物格式、AT/AU 质检结果均已回读通过。`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(runRoot, "final_summary.md"), markdown, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
