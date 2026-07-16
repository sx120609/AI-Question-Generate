import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLUMN_FIELDS } from "../automation/backfill_structure_registry.mjs";
import { assertClearQuestionRequest, assertNaturalQuestionPresentation } from "../automation/language_style.mjs";
import { runSceneCardGate } from "../automation/scene_card.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { buildFeishuFillPlan } from "../manual_review/feishu_fill_plan_lib.mjs";

export const RUN_ID = "rewrite_managed_suzizhan_method_20260711";
const RUN_DIR = path.resolve("outputs", "auto_runs", RUN_ID);
const LIVE_SNAPSHOT = path.resolve("outputs", "audits", "managed_before_suzizhan_rewrite_20260711", "all.json");
const PRIOR_RUN = path.resolve("outputs", "auto_runs", "rewrite_managed_situated_requester_20260710");

const NARRATIVE_COLUMN_MAP = [
  { field: "题目", column: "B" },
  { field: "任务概括", column: "G" },
  { field: "产物内容", column: "N" },
  { field: "做题关键步骤", column: "O" },
];

const CLOSING_CHECKS = {
  "沈礼_7.9_01": "交稿前拿一次包含投诉内容并最终转人工的会话做回查，从Word里的追问能落到Excel对应环节，也能反向找到产品说法、现有材料和仍待确认的配置。",
  "沈礼_7.9_02": "最后抽一个立即清理点位、一个现有充电区和一个拟改造空间对照，两份文件对同一照片事实、当前动作、所缺图纸或意见不能出现不同说法。",
  "沈礼_7.9_03": "完成后各抽一处直播口播、达人内容和包装展示回查，Word的处理意见必须能在Excel找到原文位置、证据状态和下一动作。",
  "沈礼_7.9_04": "收尾时沿一条会员记录走完导出、外包发送、退订和注销，两份文件对字段用途、授权依据与停止处理节点要能相互追溯。",
  "沈礼_7.9_05": "交付前用三句已知话术和一处尚未收到原文的素材分别试跑，确保已知风险有明确处理，未知素材只留下收件和复核位置。",
  "沈礼_7.9_06": "最后选堂食、送餐和补贴结算各一项回看，政策出处、组织现状、街道缺件和理事会要作的判断在Word与Excel中应当一致。",
  "沈礼_7.9_07": "完成后拿雨水井和隔油池各走一遍准入流程，书面材料、现场检测、监护动作和最终进场状态必须能在两份文件之间逐项对回。",
  "沈礼_7.9_08": "交稿前用一道换季菜品从供货商、进货查验走到留样、陪餐和投诉处理，校方与承包商责任在Word和Excel里不能错位。",
  "沈礼_7.9_09": "最后用一笔老会员处方药复购从上传处方走到配送和复购提醒，页面处理、药师动作、材料缺口与灰度意见要前后一致。",
  "沈礼_7.9_10": "收尾时各抽一项人员资质、追溯码和基金内控制度，从预审意见回到补件表中的原件位置、责任人和复核条件。",
  "沈礼_7.9_11": "完成后各抽一笔企业捐款、员工配捐、物资折价和公益合作款，票据动作、扣除提示与待核材料不能被同一个状态笼统带过。",
  "裴硬_7.9_01": "交稿前分别拿一段达人口播、一张对比图和详情页首屏试跑，Word里的审改方向要能回到Excel的原句、材料和复核状态。",
  "裴硬_7.9_02": "最后从三个获客渠道各抽一个字段，确认少字段试点说明与初筛表对取得方式、使用目的、境外接收和待补材料的说法一致。",
  "裴硬_7.9_03": "收尾时把广告合同流水、物业支出说明和一台电梯大修分别走一遍，三条资金线及各自程序在两份文件中分别呈现。",
  "裴硬_7.9_04": "完成后用一份被分到C档的简历回查，从候选人投递告知、系统分档到HR查看和人工调整，每个节点都要有对应记录。",
  "裴硬_7.9_05": "交付前拿一套材料较全的房源和一套材料无法对应的房源试填，专题页准备、逐房源上架与暂缓状态必须清楚分开。",
  "沈礼_7.10_01": "最后用券包退款、积分抽奖和分层推送各跑一个场景，页面意见、后台字段、客服口径与台账状态不能互相打架。",
  "沈礼_7.10_02": "完成后分别模拟家长同意、撤回同意和不同意戴表三种情况，功能开关、可见角色、保存处理与替代安排要能从两份文件中连续读下来。",
  "沈礼_7.10_03": "交稿前用一次正常退票和一次异常账号拦截回查，用户页面、客服答复、申诉入口及待主办方确认事项必须落在同一条规则线上。",
  "沈礼_7.10_04": "最后随机抽一项利润数据、一项营运资金指标和一项集中度判断，从Word结论回到Excel公式、披露页码与口径说明，回不到来源的只能降为观察项。",
  "沈礼_7.10_05": "完成后拿一台内装电池样机和一块备用电池分别走完型号、测试、包装、标记和承运确认，两份文件对当前状态不能给出冲突答案。",
  "沈礼_7.10_06": "交稿前分别抽一个开箱项目、一个安装条件和一个性能指标，从预审意见回到台账的基线、原始记录、实测值和签字阶段，不能用公开参考填补本项目空白。",
};

const SUMMARY_PREFIXES = ["围绕当前卡点，", "按实际办理顺序，", "从现有材料出发，", "为下一轮内部判断，", "沿具体业务对象，"];
const EVIDENCE_BOUNDARIES = {
  "沈礼_7.9_01": "法规和备案公告只能帮助追问，客户授权、供应商备案材料、日志配置、人工排班和应急流程仍要产品逐项交回。",
  "沈礼_7.9_02": "消防规则能支持先处理已拍到的违停，架空层和地下库能否改造仍取决于图纸、勘查、居民程序及书面意见。",
  "沈礼_7.9_03": "广告与食品规则用于判断表达风险，配方检测、标签原件、店铺页面和达人合作材料不到，就不替具体素材作使用结论。",
  "沈礼_7.9_04": "通用规则说明应当核什么，酒店实际取得的授权、外包权限、发送日志、退订回执和注销结果只能由后台记录证明。",
  "沈礼_7.9_05": "三句现有原话可以先处理，其他口播、图片、页面和客服承诺没有原文及批准材料时，只登记收件，不预写替换文案。",
  "沈礼_7.9_06": "国家和异地政策用来搭问题框架，本街道的服务对象、补贴结算、采购条件和厨房要求仍以街道文件及组织实有材料为准。",
  "沈礼_7.9_07": "安全生产法及有限空间要求不能替外包队补出审批、培训、监护和检测记录，这次是否进场要回到人员、装备及现场签认。",
  "沈礼_7.9_08": "制度文件只给校方核查尺度，菜单、供货、健康证明、留样陪餐、承包履约和投诉处理仍按本校及承包商原件判断。",
  "沈礼_7.9_09": "药品网络销售办法用于排功能节点，处方管理和长期处方规范用于对照药师及复购环节，禁止清单用于核对品种范围。",
  "沈礼_7.9_10": "定点办法网页与PDF交叉核对办理环节，加强管理文件用于服务、价格和追溯要求，基金监管细则用于检查内部管理。",
  "沈礼_7.9_11": "公益规则不能把后台备注自动变成捐赠事实，收款、协议、物资清单、评估和受赠主体资格要逐笔找到原件。",
  "裴硬_7.9_01": "化妆品与广告规则只提供审改尺度，功效评价、产品页面、达人合作和图片来源不到，卖点就停在待证或待改状态。",
  "裴硬_7.9_02": "字段按官网预约、展会扫码和公众号留资分别记录。姓名、手机号、公司邮箱、职位、采购预算与跟进备注逐项对应业务用途。供应商标准合同单独登记接收方信息。渠道留资材料分别对应原始告知文本。个人信息保护法和数据安全法用来梳理字段路径，评估办法与跨境流动规定用来区分少字段试点和正式评审材料。",
  "裴硬_7.9_03": "共有收益和维修资金规则只能划账目及程序边界，18万元的去向、物业支出和三台电梯报价都要靠本小区材料落账。",
  "裴硬_7.9_04": "招聘和算法规则无法替产品证明三档可见范围、人工复核及候选人告知已经落地，后台页面和操作日志仍是上线前缺件。",
  "裴硬_7.9_05": "治安、消防和交易规则用于设计逐套收件目录，30套房源是否真实具备上架条件仍要按房号核对证照、权属与现场材料。",
  "沈礼_7.10_01": "活动规则可以指出券包、抽奖和退款应说清什么，奖品数量、概率配置、页面截图、核销日志及会员授权不能由附件代填。",
  "沈礼_7.10_02": "儿童信息规则用于检查监护人选择和权限设置，供应商数据流、录音期限、后台截图、撤回处理及替代安排仍需真实配置证明。",
  "沈礼_7.10_03": "演出与交易规则给出实名、退票和公示边界，具体场次审批、费率档位、风控阈值、申诉时限和日志保存要主办方及平台确认。",
  "沈礼_7.10_04": "正式年报、一季报、业绩快报和XBRL数据各有口径，公开披露没有给出的逐户回款和经营原因只列待验证解释。",
  "沈礼_7.10_05": "铁路与国际联运资料只能提供申报和原型路径线索，B2报告不能证明B3完成测试，具体包件及路线接受仍等承运人书面回复。",
  "沈礼_7.10_06": "同型号参数和外校模板只适合搭预检框架，本项目合同、装箱清单、现场测试和签章记录不到，就不能提前进入技术验收或尾款判断。",
};

function normalize(value = "") {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function visibleLength(value = "") {
  return [...normalize(value).replace(/\s+/gu, "")].length;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tsvCell(value) {
  return normalize(value).replace(/\t/gu, " ").replace(/\n/gu, "\\n");
}

function toTsv(rows) {
  return `${COLUMN_FIELDS.join("\t")}\n${rows.map((row) => COLUMN_FIELDS.map((field) => tsvCell(row[field])).join("\t")).join("\n")}\n`;
}

function sentenceList(value) {
  return normalize(value).match(/[^。！？]+[。！？]?/gu)?.map((item) => item.trim()).filter(Boolean) ?? [];
}

function purposeFragments(attachmentContent) {
  return normalize(attachmentContent)
    .split(/\n\s*\n/gu)
    .map((block) => {
      const name = block.match(/附件[一二三四五六七八九十]+[：:]《?([^》（\n]+)[》]?（/u)?.[1]
        ?? block.match(/文件：([^）]+)）/u)?.[1]
        ?? "";
      const purpose = block.match(/用于核对[：:]([^。]+)[。]/u)?.[1] ?? "";
      if (!name || !purpose) return null;
      return { name: name.replace(/^附件[一二三四五六七八九十]+_/u, ""), purpose: [...purpose].slice(0, 54).join("") };
    })
    .filter(Boolean);
}

function evidenceParagraph(record, index) {
  const fragments = purposeFragments(record.附件内容);
  const wanted = index % 3 === 0 ? 4 : 3;
  const selected = fragments.slice(0, wanted);
  const body = selected.map((item) => `《${item.name}》核对${item.purpose}`).join("。");
  const boundary = EVIDENCE_BOUNDARIES[record.UID];
  if (!boundary) throw new Error(`Missing evidence boundary for ${record.UID}.`);
  return body ? `${body}。${boundary}` : boundary;
}

function paragraphize(question, evidence, closing, index) {
  const sentences = sentenceList(question);
  const layouts = [
    [2, 5],
    [1, 4, 7],
    [3, 6],
    [2, 4, 7],
    [1, 3, 6],
  ];
  const cuts = layouts[index % layouts.length].filter((cut) => cut < sentences.length);
  const groups = [];
  let start = 0;
  for (const cut of cuts) {
    groups.push(sentences.slice(start, cut).join(""));
    start = cut;
  }
  groups.push(sentences.slice(start).join(""));
  const insertAt = index % 2 === 0 ? Math.min(2, groups.length) : 1;
  groups.splice(insertAt, 0, evidence);
  if (index % 3 === 0) groups.push(closing);
  else groups[groups.length - 1] = `${groups[groups.length - 1]}${closing}`;
  return groups.filter(Boolean).join("\n\n");
}

function rewriteProducts(record, index) {
  const parts = sentenceList(record.产物内容);
  const ordered = index % 2 === 0 ? parts : [...parts].reverse();
  const bridge = index % 3 === 0
    ? "两份文件共用同一套事实状态和材料编号，正文判断可以回到台账逐项核验。"
    : index % 3 === 1
      ? "正文负责给出当前判断，台账保留依据、缺口、责任人和后续更新位置。"
      : "交付时保持结论、明细和来源互相可追溯，材料到件后直接在原记录续审。";
  return `${ordered.join("")}${bridge}`;
}

function expandSteps(record, index) {
  const steps = normalize(record.做题关键步骤).split("\n").filter(Boolean).map((line) => line.replace(/^\d+\.\s*/u, ""));
  const additions = [
    "核对相关附件的资料名称、来源链接、适用范围和本题使用边界，把规则、公开参考与项目事实分开标记",
    "将仍缺少的内部原件、系统配置、现场记录或有权主体回复挂到对应判断，不用公开材料代填",
    "统一Word与Excel中的对象名称、材料编号、状态用语和责任人，避免正文与台账出现两套口径",
    CLOSING_CHECKS[record.UID].replace(/[。！？]$/u, ""),
  ];
  const target = 13 + (index % 3);
  for (const addition of additions) {
    if (steps.length >= target) break;
    steps.push(addition);
  }
  while (steps.length < target) {
    steps.push("把新收到的材料写回原判断和原台账行，保留修改依据、经办人与复核时间");
  }
  return steps.slice(0, 15).map((step, stepIndex) => `${stepIndex + 1}. ${step.replace(/[。！？]$/u, "")}。`).join("\n");
}

function rewriteRecord(record, index) {
  const evidence = evidenceParagraph(record, index);
  let sourceQuestion = record.UID === "沈礼_7.9_01"
    ? record.题目.replace(
        "客户成功刚把我拉进明天下午的灰度会，生成式客服助手下周想先给两家付费客户开",
        "客户成功把我拉进生成式客服助手的灰度评审，产品想先给两家付费客户开",
      ).replace("明天会上要能一眼看出", "评审时要能一眼看出")
    : record.题目;
  if (record.UID === "沈礼_7.9_07") sourceQuestion = sourceQuestion.replaceAll("周五", "这次");
  let question = paragraphize(sourceQuestion, evidence, CLOSING_CHECKS[record.UID], index);
  if (visibleLength(question) < 700) {
    question = `${question}\n\n这次最重要的是${record.任务概括}`;
  }
  if (record.UID === "裴硬_7.9_01") {
    question = question.replaceAll("周五", "本轮").replaceAll("今天", "").replace("就要定稿投放", "正在做投放前定稿");
  }
  assertNaturalQuestionPresentation(question, { label: record.UID });
  assertClearQuestionRequest(question, { label: record.UID, productFormats: record.产物格式 });
  const length = visibleLength(question);
  if (length < 700 || length > 1500) throw new Error(`${record.UID} question length ${length} is outside 700-1500.`);
  return {
    ...record,
    题目: question,
    任务概括: `${SUMMARY_PREFIXES[index % SUMMARY_PREFIXES.length]}${record.任务概括}`,
    产物内容: rewriteProducts(record, index),
    做题关键步骤: expandSteps(record, index),
  };
}

function refreshCard(card, source, candidate) {
  const question = candidate.题目;
  const roleTrace = { ...(card.roleTrace ?? {}) };
  for (const [field, value] of Object.entries(roleTrace)) {
    if (!value || question.includes(value)) continue;
    if (field === "motivationSpan") roleTrace[field] = "";
    else if (field === "downstreamUseSpan") roleTrace[field] = CLOSING_CHECKS[source.UID];
    else throw new Error(`${source.UID}.${field} was lost during rewrite.`);
  }
  const requestContract = { ...card.requestContract };
  if (!question.includes(requestContract.requestSpan)) {
    const requestSpan = sentenceList(question).find((sentence) => sentence.includes("Word") && sentence.includes("Excel"));
    if (!requestSpan) throw new Error(`${source.UID}.requestSpan was lost during rewrite.`);
    const action = requestSpan.match(/帮我做|帮我整理|整理成|做一份|做成|给我做|替我整理|需要你整理/u)?.[0];
    if (!action) throw new Error(`${source.UID}.request action could not be recovered.`);
    requestContract.requestSpan = requestSpan;
    requestContract.action = action;
  }
  return {
    ...card,
    roleTrace,
    requestContract: {
      ...requestContract,
      outputs: (requestContract.outputs ?? []).map((output) => ({ ...output, purpose: candidate.产物内容 })),
    },
  };
}

export async function buildManagedSuzizhanRewrite() {
  const [snapshot, priorSceneBundle] = await Promise.all([
    fs.readFile(LIVE_SNAPSHOT, "utf8").then(JSON.parse),
    fs.readFile(path.join(PRIOR_RUN, "sources", "scene_cards.json"), "utf8").then(JSON.parse),
  ]);
  const sourceRecords = snapshot.records.sort((left, right) => Number(left.sheetRow) - Number(right.sheetRow));
  if (sourceRecords.length !== 22) throw new Error(`Expected 22 managed records, received ${sourceRecords.length}.`);
  const records = sourceRecords.map(rewriteRecord);
  const sourceByUid = new Map(sourceRecords.map((record) => [record.UID, record]));
  const candidateByUid = new Map(records.map((record) => [record.UID, record]));
  const facts = sourceRecords.map((record) => ({
    id: `fact-row-${record.sheetRow}`,
    uid: record.UID,
    text: [record.题目, record.任务概括, record.附件内容, record.产物内容, record.做题关键步骤].join("\n"),
  }));
  const materials = sourceRecords.map((record) => ({ id: `material-row-${record.sheetRow}`, uid: record.UID, text: record.相关附件 }));
  const unknowns = sourceRecords.map((record) => ({
    id: `unknown-row-${record.sheetRow}`,
    uid: record.UID,
    text: `第${record.sheetRow}行事项最后由有权人员作出的结论`,
  }));
  const factLedger = { schemaVersion: 1, generatedAt: new Date().toISOString(), facts, materials, unknowns };
  const factLedgerText = `${JSON.stringify(factLedger, null, 2)}\n`;
  const cards = priorSceneBundle.cards.map((card) => {
    const source = sourceByUid.get(card.recordUid);
    return refreshCard(card, source, candidateByUid.get(card.recordUid));
  });
  const sceneBundle = {
    ...priorSceneBundle,
    factLedgerPath: "fact_ledger.json",
    factLedgerHash: sha256(factLedgerText),
    cards,
  };

  await Promise.all(["sources", "attachments", "drafts", "feishu", "qa", "logs", "tmp"].map((dir) => fs.mkdir(path.join(RUN_DIR, dir), { recursive: true })));
  await fs.cp(path.join(PRIOR_RUN, "attachments"), path.join(RUN_DIR, "attachments"), { recursive: true, force: true });
  const tsvPath = path.join(RUN_DIR, "drafts", "l2_questions_suzizhan_method.tsv");
  const tsvText = toTsv(records);
  await fs.writeFile(tsvPath, tsvText, "utf8");
  const fillPlan = buildFeishuFillPlan({
    text: tsvText,
    sourcePath: tsvPath,
    sheetRows: records.map((record) => Number(record.sheetRow)),
    count: records.length,
    columnMap: NARRATIVE_COLUMN_MAP,
  });
  const fillPlanPath = path.join(RUN_DIR, "feishu", "feishu_fill_plan_suzizhan_method.json");
  const sceneCardPath = path.join(RUN_DIR, "sources", "scene_cards.json");
  const roleReportPath = path.join(RUN_DIR, "feishu", "role_consistency_report.json");
  await Promise.all([
    fs.writeFile(path.join(RUN_DIR, "sources", "fact_ledger.json"), factLedgerText, "utf8"),
    writeJsonAtomic(sceneCardPath, sceneBundle),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_source.json"), snapshot),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_draft.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      count: records.length,
      records,
    }),
    writeJsonAtomic(fillPlanPath, fillPlan),
    writeJsonAtomic(path.join(RUN_DIR, "manifest.json"), {
      runId: RUN_ID,
      generatedAt: new Date().toISOString(),
      objective: "按7.08作业表苏子瞻人工直通方法全面重写沈礼17条与裴硬5条系统记录",
      status: "drafted-not-submitted",
      count: records.length,
      generatedAnnotators: ["沈礼", "裴硬"],
      sourceSnapshot: LIVE_SNAPSHOT,
      spreadsheetToken: "ByAysb2Cdh9V2wtISbJc6Z01nwc",
      sheetId: "49e351",
      sheetRows: records.map((record) => Number(record.sheetRow)),
      writableFields: NARRATIVE_COLUMN_MAP.map((item) => item.field),
      preservedFields: ["相关附件", "附件格式", "附件内容", "产物格式", "UID", "标注专家姓名"],
      questionPresentation: "human-approved-natural-paragraphs-v3",
    }),
  ]);
  const roleReport = await runSceneCardGate({ candidatePath: tsvPath, sceneCardPath, reportPath: roleReportPath });
  return {
    ok: roleReport.status === "PASS",
    runId: RUN_ID,
    count: records.length,
    tsvPath,
    fillPlanPath,
    sceneCardPath,
    roleReportPath,
    roleStatus: roleReport.status,
    questionLengths: records.map((record) => ({ uid: record.UID, row: record.sheetRow, length: visibleLength(record.题目) })),
    paragraphCounts: records.map((record) => ({ uid: record.UID, count: record.题目.split(/\n\s*\n/gu).length })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildManagedSuzizhanRewrite()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
