import fs from "node:fs/promises";
import path from "node:path";
import { createFeishuClient } from "../../../../build/automation/feishu_openapi_client.mjs";

const root = process.cwd();
const runRoot = path.join(root, "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2");
const tsvPath = path.join(runRoot, "drafts/l2_questions_5.tsv");
const planPath = path.join(runRoot, "feishu/feishu_fill_plan_145_149.json");
const payloadPath = path.join(runRoot, "feishu/feishu_A_P_payload_145_149.tsv");
const changeLogPath = path.join(runRoot, "qa/qa_round4_row146_scope_fix.json");

const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";
const sheetRow = 146;

const fixes = {
  "题目":
    "明天客户周会前，销售团队想让法务给一个“海外CRM能否先接、哪些字段先别同步”的会议口径。拟接入线索来自官网预约试用、展会扫码和公众号留资，字段只有姓名、手机号、公司邮箱、职位、采购预算、跟进备注；目前没有真实CRM合同、字段字典、用户授权记录和历史导出日志，只有供应商标准合同与“全球合规”页面。请基于四个法规附件，整理一份会议用Word初筛意见和Excel补件清单：先说明核心风险、可先行的境内暂存/脱敏/少字段试点措施、必须补齐后才能判断的材料，再给每个字段的初步处理建议；不得把缺失的合同、授权和导出记录写成已核验事实。",
  "任务概括": "为销售客户周会准备海外CRM线索同步的初筛会议口径，区分可先行措施、字段初步处理建议和待补业务材料。",
  "产物内容":
    "最终产物为两个可编辑文件：一份Word文档（docx），作为客户周会用的法务初筛意见，包含会议口径、核心风险、可先行措施、暂缓同步字段、待补材料和后续审批路径；一份Excel表格（xlsx），作为字段与补件清单，字段包括线索字段、是否个人信息或敏感信息、当前材料状态、初步处理建议、法规依据、需补材料、责任人、能否进入少字段试点和备注。验收时能让法务说明本次不是最终出境审批，只给低风险试点边界和补件路径，并把CRM合同、字段字典、授权记录、历史导出日志列为待确认。",
  "做题关键步骤":
    "1. 核验四个附件的发布主体、格式、适用范围和来源链接，确认法规资料能支撑出境初筛和补件路径。\n2. 梳理会议目标：回答销售能否先试点接入海外CRM、哪些字段先不同步、哪些材料必须补齐后再审批。\n3. 从个人信息保护法提取个人信息处理、告知同意、最小必要、敏感个人信息、自动化决策和出境规则。\n4. 从数据安全法整理数据处理活动安全义务、分类分级、重要数据保护和风险监测要求。\n5. 从数据出境安全评估办法整理安全评估触发情形、申报材料、评估重点和持续监管要求。\n6. 从促进和规范数据跨境流动规定确认2024年便利化口径、豁免情形、负面清单和个人信息出境路径。\n7. 把姓名、手机号、公司邮箱、职位、采购预算、跟进备注逐项标为境内暂存、脱敏后试点、暂缓同步或待补材料后判断。\n8. 单列CRM合同、字段字典、用户授权记录、境外接收方信息、历史导出日志为待确认，不把它们写成已取得事实。\n9. 生成Word会议初筛意见，先给销售可讲的风险口径、低风险试点边界、不能拍板的原因和下一步材料清单。\n10. 生成Excel字段与补件清单，逐行写字段性质、法规依据、当前证据、建议动作、责任人和是否可进少字段试点。\n11. 交付前检查Word和Excel没有把法规附件替代真实CRM合同、授权记录或导出日志，也没有给出最终出境审批结论。",
};

function rebuildPayload(rows, header) {
  return [header.join("\t"), ...rows.map((row) => header.map((name) => row[name] ?? "").join("\t"))].join("\n") + "\n";
}

const tsv = await fs.readFile(tsvPath, "utf8");
const lines = tsv.trimEnd().split(/\r?\n/);
const header = lines[0].split("\t");
const rows = lines.slice(1).map((line) => Object.fromEntries(line.split("\t").map((cell, index) => [header[index], cell])));
const dataRow = rows[sheetRow - 145];
if (!dataRow) throw new Error(`Missing TSV row for sheet row ${sheetRow}`);
const changes = [];
for (const [field, value] of Object.entries(fixes)) {
  changes.push({ row: sheetRow, field, before: dataRow[field], after: value });
  dataRow[field] = value;
}
await fs.writeFile(tsvPath, rebuildPayload(rows, header), "utf8");
await fs.writeFile(payloadPath, rebuildPayload(rows, header), "utf8");

const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
const planRow = plan.rows.find((item) => item.sheetRow === sheetRow);
if (!planRow) throw new Error("Missing row in fill plan.");
const fieldToColumn = { "题目": "B", "任务概括": "G", "产物内容": "N", "做题关键步骤": "O" };
for (const [field, value] of Object.entries(fixes)) {
  const update = planRow.updates.find((item) => item.field === field || item.column === fieldToColumn[field]);
  if (!update) throw new Error(`Missing plan update for ${field}`);
  update.value = value;
  update.chars = value.length;
  update.hasNewlines = value.includes("\n");
  update.preview = value.replace(/\n/g, "\\n").slice(0, 120);
}
planRow.title = fixes["任务概括"];
await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

const valueRanges = Object.entries(fixes).map(([field, value]) => ({
  range: `${sheetId}!${fieldToColumn[field]}${sheetRow}:${fieldToColumn[field]}${sheetRow}`,
  values: [[value]],
}));
const client = await createFeishuClient({ transport: "lark-cli" });
const result = await client.batchUpdateValues({ spreadsheetToken, valueRanges });
await fs.writeFile(changeLogPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), changes, result }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ row: sheetRow, updatedCells: valueRanges.length }, null, 2));
