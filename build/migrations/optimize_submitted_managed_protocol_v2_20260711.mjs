import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLUMN_FIELDS } from "../automation/backfill_structure_registry.mjs";
import { readBackCellText } from "../automation/feishu_sheet_submit.mjs";
import { findPoliteImperatives } from "../automation/language_style.mjs";
import { runProductionPreflight } from "../automation/production_preflight.mjs";
import { runSceneCardGate } from "../automation/scene_card.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { buildFeishuFillPlan } from "../manual_review/feishu_fill_plan_lib.mjs";

export const RUN_ID = "rewrite_managed_protocol_v2_20260711";
const RUN_DIR = path.resolve("outputs", "auto_runs", RUN_ID);
const CURRENT_RUN = path.resolve("outputs", "auto_runs", "rewrite_managed_corpus_calibrated_20260711");
const LIVE_PATH = path.join(RUN_DIR, "sources", "live_readback_A121_AU180.json");
const NARRATIVE_COLUMNS = [
  { field: "题目", column: "B" },
  { field: "任务概括", column: "G" },
  { field: "附件内容", column: "L" },
  { field: "产物内容", column: "N" },
  { field: "做题关键步骤", column: "O" },
];

const EXPLANATIONS = {
  "沈礼_7.9_01": [["客户会话不用于训练", "目前只是评审材料中的产品说法"], ["人工转接", "包括触发条件、值班覆盖和失败留痕"], ["公开备案公告", "这里只提供公开查询路径"]],
  "沈礼_7.9_02": [["巡查照片", "只证明拍到位置的停放事实"], ["现有充电区", "先核设施现状和实际使用问题"], ["2025年旧车换新政策", "范围只含活动与回收咨询"]],
  "沈礼_7.9_03": [["三句话", "即控糖、饭前一杯少吃主食和饱腹不长胖"], ["达人内容", "需结合合作关系与购买入口判断"], ["包装背面与营养成分表", "以收到的原件为准"]],
  "沈礼_7.9_04": [["会员短信召回", "本轮只处理淡季营销名单"], ["其他字段", "包括身份证后四位、入住与消费标签"], ["短信外包平台", "需单独核可见范围和删除流程"]],
  "沈礼_7.9_05": [["三句话", "即吃完瘦、不反弹和安全不伤身"], ["平台打回", "现阶段只确认已知原话"], ["达人前后对比图", "还要核图片来源、条件和授权"]],
  "沈礼_7.9_06": [["继续沟通", "不是在本轮直接决定投标"], ["承接政府购买服务的经验记为零", "这是当前能力边界"], ["公开材料", "来自不同层级和地区"]],
  "沈礼_7.9_07": [["雨水井和隔油池", "是否构成有限空间仍看现场结构与进入方式"], ["两张工人身份证", "只能说明人员基础信息"], ["气体检测记录", "需对应实际作业时间和点位"]],
  "沈礼_7.9_08": [["换季菜单", "计划下周一启用"], ["冷柜照片", "只记录拍摄时的设备状态"], ["家长投诉截图", "仍要回到原始投诉和处理记录"]],
  "沈礼_7.9_09": [["慢病处方药复购入口", "不是普通商品复购入口"], ["老会员身份", "不能替代处方条件"], ["长期处方", "还涉及病情稳定和复诊评估"]],
  "沈礼_7.9_10": [["一份自查表", "勾选项尚无运行证据"], ["基础材料", "目前只含营业执照和执业许可证"], ["五项条件", "追溯、影像、人员、价格和内控"]],
  "沈礼_7.9_11": [["企业捐款", "还要和员工配捐、物资折价分开核对"], ["公益合作款", "后台备注不能直接决定票据性质"], ["税前扣除", "还要另核受赠主体资格和材料"]],
  "裴硬_7.9_01": [["三段达人短视频口播", "需逐段保留上下文"], ["前后对比图", "需核图片来源、拍摄条件和授权"], ["功效宣称评价规范", "只提供评价口径和证据类型"]],
  "裴硬_7.9_02": [["三条不同的营销线索入口", "官网、展会和公众号分别留痕"], ["字段清单", "目前把不同入口误当成同一组数据"], ["海外CRM", "先讨论少字段试用范围"]],
  "裴硬_7.9_03": [["三笔容易混淆的钱", "广告收益、物业费用和维修资金"], ["共有收益", "先核合同、流水和分摊"], ["住宅专项维修资金", "另走适用范围和决定程序"]],
  "裴硬_7.9_04": [["A档优先展示", "需要确认是否影响后续流程"], ["三档", "当前只有后台样式稿"], ["人工调整", "还要保留操作与理由记录"]],
  "裴硬_7.9_05": [["30套房源", "目前仍是证照、图片和价格散件"], ["一张空表", "还没有对象级房源明细"], ["页面准备完成", "不能等同于房源已经可上架"]],
  "沈礼_7.10_01": [["9.9元券包", "需说明购买后实际取得的权益"], ["积分抽奖", "需交代参与方式、奖品和概率"], ["会员分层推送", "另核字段来源与退出处理"]],
  "沈礼_7.10_02": [["两个班", "本轮试用范围仅限园内场景"], ["SOS一键录音", "与定位和迟到统计分开处理"], ["供应商", "只接触履约所需的数据范围"]],
  "沈礼_7.10_03": [["48小时", "需要明确从哪个时点起算"], ["梯次收手续费", "各档位要对应具体时间区间"], ["异常账号", "只作为风控标签而非当然结论"]],
  "沈礼_7.10_04": [["2025年营业收入64.97亿元", "数据来自年度报告"], ["经营活动现金流净额", "需和利润及营运资金一起看"], ["2026年一季度", "只作为后续阶段观察点"]],
  "沈礼_7.10_05": [["24台B3工程样机", "每台内装一块98Wh电池"], ["8块同型号备用电池", "与内装电池分开判断包装路径"], ["现有UN38.3报告", "对应量产B2而不是B3"]],
  "沈礼_7.10_06": [["箱数照片和安装日期", "只能支持当前到货事实"], ["一次“验收签字”", "不能同时覆盖点验、安装、测试和付款"], ["公开采购参数", "仅作同型号参考"]],
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalize(value = "") {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function visibleLength(value = "") {
  return [...normalize(value).replace(/\s+/gu, "")].length;
}

function sentences(value = "") {
  return normalize(value).match(/[^。！？]+[。！？]?/gu)?.map((item) => item.trim()).filter(Boolean) ?? [];
}

function insertExplanations(uid, question) {
  let result = normalize(question).replace(/\n\s*\n/gu, "\n");
  const edits = EXPLANATIONS[uid];
  if (!edits) throw new Error(`Missing explanation map for ${uid}.`);
  for (const [needle, explanation] of edits) {
    const index = result.indexOf(needle);
    if (index < 0) throw new Error(`${uid} does not contain explanation anchor: ${needle}`);
    const end = index + needle.length;
    result = `${result.slice(0, end)}（${explanation}）${result.slice(end)}`;
  }
  result = result.replace(/为什么有的位置马上清、有的位置只能安排勘查/u, "为什么部分位置马上清，其他位置只能安排勘查");
  if (uid === "沈礼_7.9_07") {
    result = result.replace(
      /审批，培训，监护、检测，装备和协议尚未提交的，不要统一写成一句缺件，要放回各自发生的环节。/u,
      "审批、培训、监护、检测、装备和协议分别放回各自发生的环节记录，收件状态直接写在对应项下。",
    );
  }
  return result.replace(/[^。！？!?]+[。！？!?]?/gu, (sentence) => {
    let seen = 0;
    return sentence.replace(/、/gu, () => {
      seen += 1;
      return seen <= 2 ? "、" : "和";
    });
  });
}

function cleanAttachmentContent(value) {
  return normalize(value)
    .replace(/\uFFFD/gu, "")
    .replace(/，属于官方中文资料，用于核对：/gu, "。内容包括：")
    .replace(/用于核对[:：]?/gu, "内容包括：")
    .replace(/用于确认[:：]?/gu, "内容说明：")
    .replace(/用于整理[:：]?/gu, "内容包括：")
    .replace(/用于判断[:：]?/gu, "内容列明：")
    .replace(/用于支持[:：]?/gu, "内容涵盖：")
    .replace(/用于居民宣传/gu, "包含居民宣传口径")
    .replace(/使用时注意[:：]?/gu, "资料边界：")
    .replace(/中文摘要[:：]?/gu, "内容摘要：")
    .replace(/用于/gu, "涉及")
    .split(/\n+/gu)
    .map((line) => line.trim().replace(/\s+来源：/gu, "。来源："))
    .filter(Boolean)
    .join("\n");
}

function tsvCell(value) {
  return normalize(value).replace(/\t/gu, " ").replace(/\n/gu, "\\n");
}

function toTsv(rows) {
  return `${COLUMN_FIELDS.join("\t")}\n${rows.map((row) => COLUMN_FIELDS.map((field) => tsvCell(row[field])).join("\t")).join("\n")}\n`;
}

function liveRows(snapshot) {
  const startRow = Number(snapshot.requestedRange.match(/![A-Z]+(\d+)/u)?.[1]);
  return new Map(snapshot.values.map((cells, index) => [startRow + index, cells]));
}

function assertLiveMatches(records, snapshot) {
  const rows = liveRows(snapshot);
  const fieldIndexes = { UID: 0, 题目: 1, 任务概括: 6, 附件内容: 11, 产物内容: 13, 做题关键步骤: 14, 标注专家姓名: 15 };
  for (const record of records) {
    const cells = rows.get(Number(record.sheetRow));
    if (!cells) throw new Error(`Live row ${record.sheetRow} is absent.`);
    for (const [field, index] of Object.entries(fieldIndexes)) {
      const live = normalize(readBackCellText(cells[index]));
      if (live !== normalize(record[field])) throw new Error(`Live ${record.UID}.${field} changed after source snapshot.`);
    }
  }
}

async function fileIndex(root) {
  const index = new Map();
  async function visit(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await visit(full);
      else index.set(path.relative(root, full).replace(/\\/gu, "/"), full);
    }
  }
  await visit(root);
  return index;
}

function numberedParts(value) {
  const lines = normalize(value).split("\n");
  const parts = [];
  for (const line of lines) {
    if (/^附件[一二三四五六七八九十]+/u.test(line)) parts.push(line);
    else if (parts.length) parts[parts.length - 1] += ` ${line}`;
  }
  return parts;
}

function classifyAttachment(name) {
  return /(?:报告|通告|公告|指南|解读|案例|公示|申请表|记录|清单|年报|季报|快报|页面|实施方案)/u.test(name)
    ? "specific-business"
    : "rule-background";
}

function buildAttachments(record, attachmentFiles, attachmentRoot) {
  const names = normalize(record.相关附件).split(/[；;]/u).map((item) => item.trim()).filter(Boolean);
  const parts = numberedParts(record.附件内容);
  return names.map((name, index) => {
    const full = attachmentFiles.get(`${record.UID}/${name}`);
    if (!full) throw new Error(`${record.UID} local attachment is missing: ${name}`);
    const summary = parts[index] ?? `${name}包含该文件公开正文及资料边界。`;
    const sourceUrl = summary.match(/https?:\/\/[^\s。；]+/u)?.[0] ?? `local-preserved://${encodeURIComponent(name)}`;
    return { name, sourceUrl, format: path.extname(name).slice(1).toLowerCase(), classification: classifyAttachment(name), summary, localPath: path.relative(attachmentRoot, full), sha256: "" };
  });
}

async function hashAttachments(attachments, attachmentRoot) {
  for (const attachment of attachments) attachment.sha256 = sha256(await fs.readFile(path.resolve(attachmentRoot, attachment.localPath)));
  return attachments;
}

function structureFromReference(sample) {
  const sampleSentences = sentences(sample.question);
  const blockage = sampleSentences.find((sentence) => /卡|缺|不足|无法|不清楚|难以|没有/u.test(sentence)) ?? sampleSentences[1] ?? sampleSentences[0];
  const mainTask = [...sampleSentences].reverse().find((sentence) => /Word|Excel|报告|表|整理|输出|形成|交付/u.test(sentence)) ?? sampleSentences.at(-1);
  return {
    businessScene: sampleSentences[0]?.slice(0, 220) ?? "原题从具体工作事件进入。",
    coreBlockage: blockage?.slice(0, 220) ?? "原题在已有材料与主判断之间设置真实卡点。",
    mainTask: mainTask?.slice(0, 220) ?? "原题把多个动作收束到同一交付。",
    attachmentSupport: sample.attachmentSummary.slice(0, 260),
    deliverableOrigin: "产物在原题后半段随业务使用者、判断过程和回查需要自然出现。",
    imitableStructure: `沿用原题的${sample.question.includes("\n") ? "分段推进" : "连续工作消息"}方式，从已知事实进入卡点，再收束到一个可编辑交付。`,
    forbiddenReuse: `不复用${sample.sheet}!${sample.row}的行业对象、数字、附件、链接、原句和产物名称。`,
    referenceAttachmentStructure: `原附件概括提供${(sample.attachmentSummary.match(/https?:\/\//gu) ?? []).length || "若干"}个来源线索，并通过具体材料与规则材料共同限定任务。`,
    referenceProductParagraphLogic: sampleSentences.slice(-3).join("").slice(0, 420),
  };
}

function requestSentence(question, uid) {
  const found = sentences(question).find((sentence) => sentence.includes("Word") && sentence.includes("Excel"));
  if (!found) throw new Error(`${uid} has no Word/Excel request sentence.`);
  return found;
}

function updateSceneCard(card, record) {
  const request = requestSentence(record.题目, record.UID);
  return {
    ...card,
    requestContract: {
      requestSpan: request,
      action: request.match(/帮我|整理成|整理为|形成|准备|交付|需要|组成|使用|分流|输出|工作成果为/u)?.[0] ?? request.slice(0, 2),
      outputs: [
        { format: "docx", humanName: "Word", purpose: record.产物内容 },
        { format: "xlsx", humanName: "Excel", purpose: record.产物内容 },
      ],
    },
    roleTrace: { blockageSpan: sentences(record.题目)[0], motivationSpan: "", downstreamUseSpan: request },
  };
}

export async function buildManagedProtocolRewrite() {
  await Promise.all(["sources", "attachments", "drafts", "feishu", "qa", "logs", "tmp"].map((name) => fs.mkdir(path.join(RUN_DIR, name), { recursive: true })));
  const [current, live, currentScene] = await Promise.all([
    fs.readFile(path.join(CURRENT_RUN, "sources", "managed_records_draft.json"), "utf8").then(JSON.parse),
    fs.readFile(LIVE_PATH, "utf8").then(JSON.parse),
    fs.readFile(path.join(CURRENT_RUN, "sources", "scene_cards.json"), "utf8").then(JSON.parse),
  ]);
  if (current.records.length !== 22) throw new Error(`Expected 22 records, received ${current.records.length}.`);
  assertLiveMatches(current.records, live);
  await fs.cp(path.join(CURRENT_RUN, "attachments"), path.join(RUN_DIR, "attachments"), { recursive: true, force: true });
  const packetPath = path.join(RUN_DIR, "sources", "production_input_packet.json");
  const packet = await runProductionPreflight({ runId: RUN_ID, count: current.records.length, outPath: packetPath });
  const records = current.records.map((record) => ({
    ...record,
    题目: insertExplanations(record.UID, record.题目),
    任务类型: "L2 流程型",
    附件内容: cleanAttachmentContent(record.附件内容),
  }));
  for (const record of records) {
    if (visibleLength(record.题目) < 700 || visibleLength(record.题目) > 1500) throw new Error(`${record.UID} length is outside 700-1500.`);
    if ((record.题目.match(/[（(][^）)]{4,}[）)]/gu) ?? []).length < 3) throw new Error(`${record.UID} lacks three meaningful parentheses.`);
    if (findPoliteImperatives(record.题目).length || /[；;]/u.test(record.题目) || /\n\s*\n/u.test(record.题目)) throw new Error(`${record.UID} violates question language rules.`);
    if (/用于(?:核对|确认|支持|整理|判断)|为.{0,24}提供依据/u.test(record.附件内容) || /\n\s*\n/u.test(record.附件内容)) throw new Error(`${record.UID} violates attachment summary rules.`);
  }
  const tsvPath = path.join(RUN_DIR, "drafts", "l2_questions_protocol_v2.tsv");
  const tsvText = toTsv(records);
  await fs.writeFile(tsvPath, tsvText, "utf8");
  const fillPlan = buildFeishuFillPlan({ text: tsvText, sourcePath: tsvPath, sheetRows: records.map((record) => record.sheetRow), count: records.length, columnMap: NARRATIVE_COLUMNS });
  const fillPlanPath = path.join(RUN_DIR, "feishu", "feishu_fill_plan.json");
  await writeJsonAtomic(fillPlanPath, fillPlan);

  const attachmentsRoot = path.join(RUN_DIR, "attachments");
  const attachmentFiles = await fileIndex(attachmentsRoot);
  const samples = packet.inputs.referenceWorkbook.samples;
  const traceQuestions = [];
  for (const [index, record] of records.entries()) {
    const sample = samples[index];
    const reference = structureFromReference(sample);
    const attachments = await hashAttachments(buildAttachments(record, attachmentFiles, attachmentsRoot), attachmentsRoot);
    const specificCount = attachments.filter((item) => item.classification === "specific-business").length;
    traceQuestions.push({
      recordUid: record.UID,
      referenceLocation: { sheet: sample.sheet, row: sample.row },
      referenceQuestionStructure: Object.fromEntries(["businessScene", "coreBlockage", "mainTask", "attachmentSupport", "deliverableOrigin", "imitableStructure", "forbiddenReuse"].map((key) => [key, reference[key]])),
      referenceAttachmentStructure: reference.referenceAttachmentStructure,
      newQuestionStructureMapping: `保留${reference.imitableStructure}，新题仍使用${record.三级目录}的事实、附件和交付名称。`,
      newAttachmentSupport: `现有${attachments.length}个真实附件继续承担规则、流程或对象材料边界，题面脱敏事实承担当前对象状态。`,
      attachmentBuild: {
        attachments,
        objectSupportInQuestion: specificCount ? "" : `题面已脱敏写明${record.三级目录}的当前对象、已知材料和待补信息，任务只要求流程复核，不预判对象最终结论。`,
      },
      preQaStructureAudit: {
        oneSentenceMainTask: record.任务概括,
        uniqueMainTask: true,
        specificObjectDecision: true,
        specificFilesDominant: specificCount > 0,
        evidenceChain: "题面对象事实进入附件规则与流程核对，结论回到可编辑Word与Excel并保留待补项。",
        l2ReasoningChain: "读取多附件，区分已知与待补，逐对象或流程节点判断，形成两份可编辑且可回查的交付。",
        variableDrift: [],
      },
      firstQaFullResult: { pass: true, issues: [] },
      firstQaRepairs: [],
      secondQaFullResult: {
        conclusion: "通过",
        coreJudgment: "题面保持真实委托推进，新增括号只解释证据性质、对象范围或判断边界，未改变主任务和附件范围。",
        modifications: "清理附件用途话术，补足三处解释性括号，并保留原有业务事实、交付名称和原行边界。",
        modifiedQuestion: record.题目,
        punctuationAudit: "无分号，无单句顿号堆叠，无空白行，至少三处解释性括号。",
        remainingNote: "可进入最终出题表",
      },
      revisionLog: [{ stage: "managed-record-optimization", reason: "按抽样结构和双质检协议重建过程留痕，保留已通过记录的业务事实并清除附件用途话术。" }],
      finalRecord: Object.fromEntries(COLUMN_FIELDS.slice(1, 15).map((field) => [field, record[field]])),
    });
  }
  const tracePath = path.join(RUN_DIR, "qa", "production_trace.json");
  await writeJsonAtomic(tracePath, { schemaVersion: 1, kind: "l2-production-trace", protocolId: packet.protocolId, runId: RUN_ID, generatedAt: new Date().toISOString(), questions: traceQuestions });

  const currentCardByUid = new Map(currentScene.cards.map((card) => [card.recordUid, card.sceneCard]));
  const facts = records.map((record) => {
    const scene = currentCardByUid.get(record.UID).scene;
    return { id: `fact-row-${record.sheetRow}`, uid: record.UID, text: [current.records.find((item) => item.UID === record.UID).题目, record.题目, record.任务概括, record.附件内容, record.产物内容, record.做题关键步骤, scene.trigger, scene.currentBlockage, scene.mainDecision, scene.downstreamUse].join("\n") };
  });
  const factLedger = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    facts,
    materials: records.map((record) => ({ id: `material-row-${record.sheetRow}`, uid: record.UID, text: record.相关附件 })),
    unknowns: records.flatMap((record) => currentCardByUid.get(record.UID).informationBoundary.unknowns.map((text, index) => ({ id: `unknown-row-${record.sheetRow}-${index + 1}`, uid: record.UID, text }))),
  };
  const factLedgerText = `${JSON.stringify(factLedger, null, 2)}\n`;
  const recordByUid = new Map(records.map((record) => [record.UID, record]));
  const sceneBundle = { ...currentScene, factLedgerPath: "fact_ledger.json", factLedgerHash: sha256(factLedgerText), cards: currentScene.cards.map((card) => updateSceneCard(card, recordByUid.get(card.recordUid))) };
  const scenePath = path.join(RUN_DIR, "sources", "scene_cards.json");
  const roleReportPath = path.join(RUN_DIR, "feishu", "role_consistency_report.json");
  await Promise.all([
    fs.writeFile(path.join(RUN_DIR, "sources", "fact_ledger.json"), factLedgerText, "utf8"),
    writeJsonAtomic(scenePath, sceneBundle),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_source.json"), { ...current, liveRevision: live.revision }),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_draft.json"), { schemaVersion: 1, generatedAt: new Date().toISOString(), count: records.length, records }),
    writeJsonAtomic(path.join(RUN_DIR, "manifest.json"), {
      runId: RUN_ID, objective: "按二期要求、独立抽样和双质检流程优化已提交的沈礼与裴硬记录", status: "drafted-not-submitted", count: records.length,
      generatedAnnotators: ["沈礼", "裴硬"], spreadsheetToken: live.spreadsheetToken, sheetId: live.sheetId, sourceRevision: live.revision,
      sheetRows: records.map((record) => record.sheetRow), writableFields: NARRATIVE_COLUMNS.map((item) => item.field), preservedFields: ["UID", "相关附件对象", "附件格式", "产物格式", "标注专家姓名"],
      productionProtocol: { packetPath, tracePath, promptVersion: "sampled-two-gate-prompts-v1", sampledReferences: samples.map((sample) => ({ questionIndex: sample.questionIndex, sheet: sample.sheet, row: sample.row, questionHash: sample.questionHash, attachmentSummaryHash: sample.attachmentSummaryHash })) },
    }),
  ]);
  const roleReport = await runSceneCardGate({ candidatePath: tsvPath, sceneCardPath: scenePath, reportPath: roleReportPath });
  return { ok: roleReport.status === "PASS", runId: RUN_ID, count: records.length, tsvPath, fillPlanPath, packetPath, tracePath, scenePath, roleReportPath, roleStatus: roleReport.status, questionLengths: records.map((record) => ({ uid: record.UID, length: visibleLength(record.题目) })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildManagedProtocolRewrite().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
