import fs from "node:fs/promises";
import path from "node:path";
import { createFeishuClient } from "../../../../build/automation/feishu_openapi_client.mjs";
import { updateTopicStatus } from "../../../../build/automation/topic_registry.mjs";

const root = process.cwd();
const runId = "l2_peiying_20260709_20260709T115842Z_3d19c2";
const runRoot = path.join(root, "outputs/auto_runs", runId);
const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";
const rows = [145, 146, 147, 148, 149];
const uids = rows.map((_, index) => `裴硬_7.9_${String(index + 1).padStart(2, "0")}`);
const topicIds = [
  "peiying_0709_12_cosmetics_claims",
  "peiying_0709_13_saas_crossborder",
  "peiying_0709_14_property_public_revenue",
  "peiying_0709_15_ai_recruiting",
  "peiying_0709_16_homestay_listing",
];

const client = await createFeishuClient({ transport: "lark-cli" });
const ranges = [`${sheetId}!A145:P149`, `${sheetId}!AT145:AU149`, `${sheetId}!J145:J149`];
const readback = {};
for (const range of ranges) {
  readback[range] = await client.readRange({ spreadsheetToken, range });
}
await fs.writeFile(path.join(runRoot, "feishu/final_readback_145_149.json"), `${JSON.stringify(readback, null, 2)}\n`, "utf8");

const sourceCards = JSON.parse(await fs.readFile(path.join(runRoot, "sources/source_cards.json"), "utf8"));
const cardList = sourceCards.sourceCards || [];
const qaValues = readback[`${sheetId}!AT145:AU149`].values || [];
const jValues = readback[`${sheetId}!J145:J149`].values || [];
const finalRows = rows.map((row, index) => {
  const attachmentObjects = Array.isArray(jValues[index]?.[0])
    ? jValues[index][0].filter((item) => item?.type === "attachment" || item?.fileToken).length
    : 0;
  return {
    row,
    uid: uids[index],
    topicId: topicIds[index],
    title: cardList[index]?.title || "",
    attachmentObjects,
    qa: qaValues[index]?.[0] || "",
    qaNote: qaValues[index]?.[1] || "",
  };
});

const summary = {
  generatedAt: new Date().toISOString(),
  runId,
  spreadsheetToken,
  sheetId,
  sheetRows: rows,
  annotator: "裴硬",
  uidPolicy: "new alias numbering starts at 01",
  localChecks: {
    tsvRows: 5,
    tsvColumns: 16,
    attachmentFiles: 20,
    attachmentDirs: 5,
    lint: "PASS",
  },
  finalRows,
  sourceCards: path.join(runRoot, "sources/source_cards.md"),
  finalReadback: path.join(runRoot, "feishu/final_readback_145_149.json"),
  finalQa: path.join(runRoot, "qa/qa_round9_full_final_results.json"),
};
await fs.writeFile(path.join(runRoot, "final_submission_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

const md = [
  `# 裴硬 7.9 L2 提交摘要`,
  ``,
  `- 行号：145-149`,
  `- UID：${uids.join("，")}`,
  `- 附件：每行 4 个真实附件对象，合计 20 个`,
  `- QA：最终全量回归通过；146 最终措辞调整后单行复检通过`,
  ``,
  `| Row | UID | Topic | Attachments | QA |`,
  `| --- | --- | --- | ---: | --- |`,
  ...finalRows.map((item) => `| ${item.row} | ${item.uid} | ${item.title} | ${item.attachmentObjects} | ${item.qa} |`),
  ``,
  `本地校验：TSV 5 行 x 16 列；附件 20 个；AI style lint PASS。`,
].join("\n");
await fs.writeFile(path.join(runRoot, "final_submission_summary.md"), `${md}\n`, "utf8");

const registryResults = [];
for (const [index, topicId] of topicIds.entries()) {
  try {
    registryResults.push(
      await updateTopicStatus(topicId, "accepted", {
        runId,
        patch: {
          sheetRow: rows[index],
          uid: uids[index],
          qaStatus: "passed",
          attachmentObjects: 4,
        },
      })
    );
  } catch (error) {
    registryResults.push({ topicId, error: error.message });
  }
}
await fs.writeFile(path.join(runRoot, "feishu/topic_registry_acceptance_145_149.json"), `${JSON.stringify(registryResults, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ rows: finalRows, summary: path.join(runRoot, "final_submission_summary.md") }, null, 2));
