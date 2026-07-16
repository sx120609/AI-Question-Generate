import fs from "node:fs/promises";
import { createFeishuClient } from "../../../../build/automation/feishu_openapi_client.mjs";

const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";
const rows = [121, 122, 123, 134, 135, 136, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149];
const outPath =
  "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2/qa/qa_full_recheck_final_summary_121_149.json";

function cellText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cellText).join("");
  if (typeof value === "object") return value.text ?? value.link ?? JSON.stringify(value);
  return String(value);
}

function countAttachments(value) {
  if (!Array.isArray(value)) return 0;
  return value.filter((item) => item && typeof item === "object" && item.type === "attachment").length;
}

const oldTemplatePattern =
  /以下为(四个|已上传)|最终产物为两个可编辑文件|核验四[个份]附件|部门A认为|部门B认为|请基于四个|这组资料用于判断|六份附件用于判断|附件提供上线前规则依据/;

const client = await createFeishuClient({ transport: "lark-cli" });
const out = [];
for (const row of rows) {
  const main = (await client.readRange({ spreadsheetToken, range: `${sheetId}!A${row}:P${row}` })).values?.[0] || [];
  const qa = (await client.readRange({ spreadsheetToken, range: `${sheetId}!AT${row}:AU${row}` })).values?.[0] || [];
  const joined = [cellText(main[1]), cellText(main[11]), cellText(main[13]), cellText(main[14])].join("\n");
  out.push({
    row,
    uid: cellText(main[0]),
    cat2: cellText(main[4]),
    attachmentCount: countAttachments(main[9]),
    annotator: cellText(main[15]),
    qa: cellText(qa[0]),
    qaNote: cellText(qa[1]),
    hasOldTemplate: oldTemplatePattern.test(joined),
  });
}

await fs.writeFile(outPath, `${JSON.stringify({ checkedAt: new Date().toISOString(), rows: out }, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    out.map((item) => ({
      row: item.row,
      uid: item.uid,
      att: item.attachmentCount,
      annotator: item.annotator,
      qa: item.qa,
      old: item.hasOldTemplate,
    })),
    null,
    2,
  ),
);
console.log(`saved ${outPath}`);
