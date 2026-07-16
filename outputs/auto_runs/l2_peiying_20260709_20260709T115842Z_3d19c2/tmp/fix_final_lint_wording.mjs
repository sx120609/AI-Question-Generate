import fs from "node:fs/promises";
import path from "node:path";
import { createFeishuClient } from "../../../../build/automation/feishu_openapi_client.mjs";

const root = process.cwd();
const runRoot = path.join(root, "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2");
const planPath = path.join(runRoot, "feishu/feishu_fill_plan_145_149.json");
const logPath = path.join(runRoot, "qa/final_lint_wording_fix.json");
const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";

const replacements = {
  146: [
    [
      "请基于四个法规附件，整理一份会议用Word初筛意见和Excel补件清单：先说明核心风险、可先行的境内暂存/脱敏/少字段试点措施、必须补齐后才能判断的材料，再给每个字段的初步处理建议；不得把缺失的合同、授权和导出记录写成已核验事实。",
      "请基于四个法规附件，整理一份会议用Word初筛意见和Excel补件清单，内容包括核心风险、可先行的境内暂存/脱敏/少字段试点措施、需补齐后再判断的材料、每个字段的初步处理建议；缺失的合同、授权和导出记录作为待确认边界处理。",
    ],
  ],
  149: [
    [
      "要求模板能把后续房源分为可暂存、补证后上架、现场核验、暂缓上线四类；房东证照真实性、现场设施、公安报备、权属和履约记录不得写成已核验事实。",
      "要求模板能把后续房源分为可暂存、补证后上架、现场核验、暂缓上线四类；房东证照真实性、现场设施、公安报备、权属和履约记录作为待确认边界处理。",
    ],
  ],
};

const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
const changes = [];
for (const planRow of plan.rows) {
  const rowReplacements = replacements[planRow.sheetRow];
  if (!rowReplacements) continue;
  const update = planRow.updates.find((item) => item.field === "题目" || item.column === "B");
  let value = update.value;
  for (const [from, to] of rowReplacements) value = value.replace(from, to);
  changes.push({ row: planRow.sheetRow, before: update.value, after: value });
  update.value = value;
  update.chars = value.length;
  update.hasNewlines = value.includes("\n");
  update.preview = value.replace(/\n/g, "\\n").slice(0, 120);
}
await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

const client = await createFeishuClient({ transport: "lark-cli" });
const valueRanges = changes.map((change) => ({ range: `${sheetId}!B${change.row}:B${change.row}`, values: [[change.after]] }));
const result = await client.batchUpdateValues({ spreadsheetToken, valueRanges });
await fs.writeFile(logPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), changes, result }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ updatedRows: changes.map((item) => item.row) }, null, 2));
