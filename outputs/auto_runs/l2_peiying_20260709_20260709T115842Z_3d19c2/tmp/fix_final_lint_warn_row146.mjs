import fs from "node:fs/promises";
import path from "node:path";
import { createFeishuClient } from "../../../../build/automation/feishu_openapi_client.mjs";

const root = process.cwd();
const runRoot = path.join(root, "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2");
const planPath = path.join(runRoot, "feishu/feishu_fill_plan_145_149.json");
const logPath = path.join(runRoot, "qa/final_lint_warn_row146_fix.json");
const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";

const from =
  "请基于四个法规附件，整理一份会议用Word初筛意见和Excel补件清单，内容包括核心风险、可先行的境内暂存/脱敏/少字段试点措施、需补齐后再判断的材料、每个字段的初步处理建议；缺失的合同、授权和导出记录作为待确认边界处理。";
const to =
  "请基于四个法规附件，帮法务准备周会口径：哪些风险会挡住直接拍板，哪些字段只适合境内暂存或脱敏少字段试点，还差哪些合同、授权和境外接收方材料；交付时做成一份Word初筛意见和一张Excel补件清单，缺失的合同、授权和导出记录作为待确认边界处理。";

const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
const planRow = plan.rows.find((item) => item.sheetRow === 146);
const update = planRow.updates.find((item) => item.field === "题目" || item.column === "B");
const before = update.value;
update.value = update.value.replace(from, to);
update.chars = update.value.length;
update.hasNewlines = update.value.includes("\n");
update.preview = update.value.replace(/\n/g, "\\n").slice(0, 120);
await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
const client = await createFeishuClient({ transport: "lark-cli" });
const result = await client.batchUpdateValues({
  spreadsheetToken,
  valueRanges: [{ range: `${sheetId}!B146:B146`, values: [[update.value]] }],
});
await fs.writeFile(logPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), before, after: update.value, result }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ row: 146, chars: update.value.length }, null, 2));
