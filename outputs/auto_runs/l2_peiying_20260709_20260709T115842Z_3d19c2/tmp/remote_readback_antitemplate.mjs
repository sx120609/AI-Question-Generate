import fs from "node:fs/promises";
import { createFeishuClient } from "../../../../build/automation/feishu_openapi_client.mjs";

const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";
const rows = [121, 122, 123, 134, 135, 136, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149];
const outPath =
  "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2/feishu/antitemplate_remote_readback_121_149.json";

function cellText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cellText).join("");
  if (typeof value === "object") return value.text ?? value.link ?? JSON.stringify(value);
  return String(value);
}

function countAttachments(value) {
  if (!Array.isArray(value)) return cellText(value).split(/\n|；/).filter(Boolean).length;
  return value.filter((item) => item && typeof item === "object" && item.type === "attachment").length;
}

const oldTemplatePattern = /以下为(四个|已上传)|最终产物为两个可编辑文件|核验四[个份]附件|部门A认为|部门B认为|请基于四个/;

const client = await createFeishuClient({ transport: "lark-cli" });
const out = [];
for (const row of rows) {
  const valueRange = await client.readRange({ spreadsheetToken, range: `${sheetId}!A${row}:P${row}` });
  const values = valueRange?.values?.[0] || [];
  const obj = {
    row,
    uid: cellText(values[0]),
    question: cellText(values[1]),
    summary: cellText(values[6]),
    attachmentCount: countAttachments(values[9]),
    attachmentText: cellText(values[9]),
    attachmentContent: cellText(values[11]),
    productContent: cellText(values[13]),
    steps: cellText(values[14]),
    annotator: cellText(values[15]),
  };
  obj.hasOldTemplate = oldTemplatePattern.test(
    [obj.question, obj.attachmentContent, obj.productContent, obj.steps].join("\n"),
  );
  out.push(obj);
}

await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    out.map((item) => ({
      row: item.row,
      uid: item.uid,
      attachmentCount: item.attachmentCount,
      annotator: item.annotator,
      hasOldTemplate: item.hasOldTemplate,
      question: item.question.slice(0, 32),
      product: item.productContent.slice(0, 32),
    })),
    null,
    2,
  ),
);
console.log(`saved ${outPath}`);
