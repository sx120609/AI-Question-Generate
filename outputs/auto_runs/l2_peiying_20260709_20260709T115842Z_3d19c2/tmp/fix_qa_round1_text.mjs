import fs from "node:fs/promises";
import path from "node:path";
import { createFeishuClient } from "../../../../build/automation/feishu_openapi_client.mjs";

const root = process.cwd();
const runRoot = path.join(root, "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2");
const tsvPath = path.join(runRoot, "drafts/l2_questions_5.tsv");
const planPath = path.join(runRoot, "feishu/feishu_fill_plan_145_149.json");
const payloadPath = path.join(runRoot, "feishu/feishu_A_P_payload_145_149.tsv");
const changeLogPath = path.join(runRoot, "qa/qa_round1_text_fixes.json");

const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";

const fixes = {
  146: {
    "题目":
      "销售团队要在明天客户周会前判断三类线索能否同步到海外CRM：官网预约试用、展会扫码、公众号留资。待同步字段有姓名、手机号、公司邮箱、职位、采购预算和跟进备注，供应商目前只给标准合同和“全球合规”页面。请基于四个法规附件，给法务一份Word数据出境复核意见和一张Excel字段路径清单，区分境内暂存、可走标准合同或安全评估等路径、需补用户告知同意和境外接收方材料的字段；CRM合同、字段字典、授权记录、历史导出日志未拿到的，列为待确认。",
  },
  148: {
    "题目":
      "招聘小程序计划在2026年7月灰度上线“AI初筛”入口，候选人投递后系统按简历关键词、过往行业、学历和薪资期望给推荐等级，HR只看A档和部分B档。产品想尽快上线，法务担心候选人告知、个人信息处理依据、自动化决策边界、算法推荐提示和人工复核入口没有补齐。请基于四个法规附件，输出Word上线前复核意见和Excel规则/告知核对表，标明哪些页面文案可直接上线、哪些要补告知或授权、哪些必须保留人工复核；算法参数、训练数据来源、授权记录和复核日志未取得的，放入待确认。",
    "任务概括": "复核招聘小程序2026年7月AI初筛灰度上线前的候选人告知、个人信息处理、算法规则和人工复核留痕。",
  },
  149: {
    "题目":
      "本地生活平台准备上线“城市周末民宿”专题，招商已收集30套房源的证照照片、房屋照片、消防承诺书和价格表，但房源明细表还在汇总，部分房源是否完成旅馆业备案、住宿登记接入和现场消防核验尚不清楚。请先基于四个法规附件，给运营和风控一份Word上架前复核规则，并做一张Excel房源补件模板，字段包括现有资料、缺失材料、备案/登记/消防/平台展示核验项、分流建议、责任人和待确认备注。要求模板能把后续房源分为可暂存、补证后上架、现场核验、暂缓上线四类；房东证照真实性、现场设施、公安报备、权属和履约记录不得写成已核验事实。",
    "任务概括": "设计民宿专题房源上架前的治安、消防、平台交易信息展示规则和Excel补件模板，明确后续逐房源分流口径。",
    "产物内容":
      "最终产物为两个可编辑文件：一份Word文档（docx），包含专题背景、资料现状、治安要求、消防要求、平台交易信息展示、分流规则、待确认边界和上线评审建议；一份Excel表格（xlsx），作为房源补件模板，字段包括房源编号、现有资料、缺失材料、治安备案状态、住宿登记接入口径、消防核验状态、平台展示问题、分流建议、需补主体、责任人和评审备注。验收时模板能支持后续逐房源分流，并把法规资料无法确认的证照、现场设施、报备、权属和履约记录列为待确认。",
    "做题关键步骤":
      "1. 核验四个附件的发布主体、格式、适用范围和来源链接，确认能够覆盖民宿上架复核。\n2. 整理后续房源补件模板需要收集的字段，包括房东证照、房屋照片、消防承诺、价格表、备案状态和住宿登记接入口径。\n3. 从旅馆业治安管理办法提取开办、住宿登记、治安管理和违法经营相关要求。\n4. 从消防法整理住宿经营场所消防安全责任、设施维护、检查整改和禁止行为。\n5. 从网络交易监督管理办法提取平台内经营者信息、服务展示、交易记录和平台治理义务。\n6. 从电子商务法整理身份核验、信息公示、交易安全、消费者权益和记录保存要求。\n7. 设计可暂存、补证后上架、现场核验、暂缓上线四类分流路径，并写明触发条件。\n8. 把房东证照真实性、现场消防设施、公安报备、房屋权属和订单履约记录列为待确认项。\n9. 生成Word房源上架复核规则，写清评审会可用结论、分流规则和平台风险提示。\n10. 生成Excel房源补件模板，按字段列出资料缺口、依据、责任人、补件动作和评审备注。\n11. 交付前检查Word和Excel没有把消防承诺书、照片或证照扫描件直接写成已现场核验事实。",
  },
};

function splitTsvLine(line) {
  return line.split("\t");
}

function serializePreview(value) {
  return String(value ?? "").replace(/\n/g, "\\n").slice(0, 120);
}

function rebuildPayload(rows) {
  const header = [
    "UID",
    "题目",
    "任务类型",
    "一级目录",
    "二级目录",
    "三级目录",
    "任务概括",
    "相关附件",
    "标注专家工作年限",
    "人类完成时间",
    "附件格式",
    "附件内容",
    "产物格式",
    "产物内容",
    "做题关键步骤",
    "标注专家姓名",
  ];
  return [header.join("\t"), ...rows.map((row) => header.map((field) => row[field] ?? "").join("\t"))].join("\n") + "\n";
}

const tsv = await fs.readFile(tsvPath, "utf8");
const lines = tsv.trimEnd().split(/\r?\n/);
const header = splitTsvLine(lines[0]);
const rows = lines.slice(1).map((line) => Object.fromEntries(splitTsvLine(line).map((value, index) => [header[index], value])));

const changes = [];
for (const [rowNumberText, rowFixes] of Object.entries(fixes)) {
  const rowNumber = Number(rowNumberText);
  const dataRow = rows[rowNumber - 145];
  if (!dataRow) throw new Error(`Missing TSV row for sheet row ${rowNumber}`);
  for (const [field, value] of Object.entries(rowFixes)) {
    changes.push({ row: rowNumber, field, before: dataRow[field], after: value });
    dataRow[field] = value;
  }
}

await fs.writeFile(tsvPath, rebuildPayload(rows), "utf8");
await fs.writeFile(payloadPath, rebuildPayload(rows), "utf8");

const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
const columnByField = new Map(plan.columnMap.map((item) => [item.field, item.column]));
for (const planRow of plan.rows) {
  const rowFixes = fixes[planRow.sheetRow];
  if (!rowFixes) continue;
  for (const [field, value] of Object.entries(rowFixes)) {
    const column = columnByField.get(field);
    const update = planRow.updates.find((item) => item.field === field || item.column === column);
    if (!update) throw new Error(`Missing plan update for ${field} at row ${planRow.sheetRow}`);
    update.value = value;
    update.chars = value.length;
    update.hasNewlines = value.includes("\n");
    update.preview = serializePreview(value);
  }
  if (rowFixes["任务概括"]) planRow.title = rowFixes["任务概括"];
}
await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

const fieldToColumn = {
  "题目": "B",
  "任务概括": "G",
  "产物内容": "N",
  "做题关键步骤": "O",
};
const valueRanges = [];
for (const [rowNumberText, rowFixes] of Object.entries(fixes)) {
  for (const [field, value] of Object.entries(rowFixes)) {
    const column = fieldToColumn[field];
    if (!column) continue;
    valueRanges.push({ range: `${sheetId}!${column}${rowNumberText}:${column}${rowNumberText}`, values: [[value]] });
  }
}
const client = await createFeishuClient({ transport: "lark-cli" });
const result = await client.batchUpdateValues({ spreadsheetToken, valueRanges });
await fs.writeFile(changeLogPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), changes, result }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ updatedCells: valueRanges.length, rows: Object.keys(fixes).map(Number) }, null, 2));
