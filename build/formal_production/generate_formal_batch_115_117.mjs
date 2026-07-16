import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildFeishuFillPlan } from "../manual_review/feishu_fill_plan_lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const runId = "formal_20260709_115_117";
const runRoot = path.join(root, "outputs", "formal_runs", runId);
const attachmentRoot = path.join(root, "outputs", "attachments", runId);
const tsvPath = path.join(runRoot, "l2_formal_115_117.tsv");
const planPath = path.join(runRoot, "feishu_fill_plan_115_117.json");
const manifestPath = path.join(runRoot, "attachment_manifest.json");

const headers = [
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

const columnMap = [
  ["UID", "A"],
  ["题目", "B"],
  ["任务类型", "C"],
  ["一级目录", "D"],
  ["二级目录", "E"],
  ["三级目录", "F"],
  ["任务概括", "G"],
  ["标注专家工作年限", "H"],
  ["人类完成时间", "I"],
  ["相关附件", "J"],
  ["附件格式", "K"],
  ["附件内容", "L"],
  ["产物格式", "M"],
  ["产物内容", "N"],
  ["做题关键步骤", "O"],
  ["标注专家姓名", "P"],
].map(([field, column]) => ({ field, column }));

const rows = [
  {
    uid: "沈礼_7.9_01",
    title: "老板昨晚问我，那个准备给外部客户开的 AI 客服助手，能不能下周先灰度给两家付费客户试。产品说只是接企业知识库、工单和FAQ，不训练新模型；但客服会话里可能有联系人、订单号和投诉内容，也会自动生成回复和摘要，法务担心备案、公示、个人信息和违规内容处置没有说清。\n我手头先按网信办生成式AI办法、深度合成规定、个人信息保护法、TC260生成式AI安全基本要求和已备案信息公告来做一版上线前闸门。结果给产品和法务会上用：哪些可以作为灰度前必补，哪些放到客户合同、告知书或后台开关，哪些需要等模型服务商或公司内部材料确认。最后交付一份可编辑的Word灰度前合规说明和一张Excel风险补件表；模型底层备案号、客户真实授权、日志留存实现、人工审核人力这些公开资料看不到的，放进待确认栏。",
    taskType: "L2 流程型",
    primary: "科技软件与 AI 工作流",
    secondary: "AI 产品安全与合规上线",
    tertiary: "生成式客服助手对外灰度前安全评估",
    summary: "帮助SaaS产品团队在生成式客服助手灰度前梳理备案、安全评估、个人信息和内容处置缺口。",
    experience: "5年",
    time: "12h",
    productFormat: "docx, xlsx",
    productContent:
      "最终产物为两个可编辑文件：一份Word文档（docx），给产品负责人和法务会前看，内容包括是否建议进入客户灰度、上线前必补材料、客户告知和合同补充点、内容处置和投诉入口要求；一份Excel表格（xlsx），字段包括功能场景、涉及数据、对应附件依据、风险等级、灰度前处理方式、责任人、需内部确认材料、是否阻断灰度。",
    steps: [
      "1. 先把AI客服助手拆成知识库检索、会话生成、工单摘要、人工转接、日志留存、客户后台开关六个场景。",
      "2. 核验每份附件的发布主体、发布时间和适用范围，区分法律法规、推荐性标准和备案公告的不同用途。",
      "3. 读取生成式人工智能服务管理暂行办法，提取训练数据来源、投诉举报、违法内容处置、生成内容标识和备案相关要求。",
      "4. 读取深度合成管理规定，核对深度合成标识、真实身份认证、管理规则、投诉申诉和安全评估触发条件。",
      "5. 读取个人信息保护法，梳理客服会话里联系人、订单号、投诉内容、敏感个人信息和授权告知的处理边界。",
      "6. 读取生成式AI安全基本要求，建立语料安全、模型安全、安全措施和评估证据清单。",
      "7. 读取已备案信息公告，确认公开备案信息能证明什么，不能替代公司自有模型或供应商模型的备案核验。",
      "8. 把当前灰度方案按可先配置、灰度前必补、需法务确认、需供应商确认四类整理，所有判断回指附件依据。",
      "9. 列出公开资料无法确认的内部材料，例如客户授权文本、供应商模型备案号、日志留存实现、人工复核排班和应急处置流程。",
      "10. 生成Word说明和Excel补件表，检查是否把推荐性标准误写成强制法律、是否编造备案结论或客户授权状态。",
    ],
    attachments: [
      {
        fileName: "附件一_生成式人工智能服务管理暂行办法.html",
        title: "生成式人工智能服务管理暂行办法",
        url: "https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm",
        format: "html",
        purpose: "用于核对生成式AI服务的训练数据、内容处置、投诉举报、生成内容标识和备案要求。",
      },
      {
        fileName: "附件二_互联网信息服务深度合成管理规定.html",
        title: "互联网信息服务深度合成管理规定",
        url: "https://www.cac.gov.cn/2022-12/11/c_1672221949354811.htm",
        format: "html",
        purpose: "用于确认深度合成服务的标识、真实身份认证、管理规则、公示和安全评估边界。",
      },
      {
        fileName: "附件三_中华人民共和国个人信息保护法.html",
        title: "中华人民共和国个人信息保护法",
        url: "https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm",
        format: "html",
        purpose: "用于核对客服会话中个人信息处理、敏感个人信息、告知同意和个人权利响应要求。",
      },
      {
        fileName: "附件四_生成式人工智能服务安全基本要求_GBT45654_2025.pdf",
        title: "GB/T 45654-2025 网络安全技术 生成式人工智能服务安全基本要求",
        url: "https://www.tc260.org.cn/upload/2025-06-30/1751257342816036759.pdf",
        format: "pdf",
        purpose: "用于整理语料安全、模型安全、安全措施和安全评估证据清单。",
      },
      {
        fileName: "附件五_生成式人工智能服务已备案信息公告.html",
        title: "生成式人工智能服务已备案信息公告",
        url: "https://www.cac.gov.cn/2024-04/02/c_1713729983803145.htm",
        format: "html",
        purpose: "用于确认已上线生成式AI服务备案信息公示和模型备案信息核验口径。",
      },
    ],
    boundary:
      "以上资料只能支撑生成式客服助手灰度前的公开规则核对和补件清单，不能证明本公司或供应商模型已经完成备案、客户授权真实有效、日志留存和人工复核已经上线。",
  },
  {
    uid: "沈礼_7.9_02",
    title:
      "小区夜间巡查时，物业又拍到几处电动自行车停在一楼门厅和楼梯口，业委会这周要讨论是不是立刻扩建集中充电区，还是先把架空层、地下非机动车库和旧车置换引导一起放进整改方案。现有问题不只是贴通知：居民嫌集中点远，有人担心旧车换新补贴说不清，消防通道和门厅又不能占，物业还要解释为什么有些车位能留、有些位置要清。请按现行高层民用建筑消防管理规定、消防部门解读、2025年电动自行车以旧换新通知及政策解读，整理一份会前整改材料。公开资料看不出的小区图纸、设备报价、消防验收意见和居民投票结果，列成待物业、街道或消防确认项；最后给业委会一份Word整改建议和居民沟通稿，再给物业一张Excel点位排查与整改跟踪表。",
    taskType: "L2 流程型",
    primary: "法律、政务与公共服务",
    secondary: "社区治理与消防安全",
    tertiary: "老旧小区电动自行车充停整改与以旧换新沟通评估",
    summary: "帮助物业在业主大会前整理电动自行车停放充电整改清单、旧车置换沟通口径和居民反馈材料。",
    experience: "5年",
    time: "12h",
    productFormat: "docx, xlsx",
    productContent:
      "最终产物为两个可编辑文件：一份Word文档（docx），供业委会会前讨论使用，包含问题分级、禁止停放充电位置、集中充电区改造边界、旧车置换沟通口径、待街道或消防确认事项；一份Excel表格（xlsx），字段包括点位位置、现状问题、涉及规则依据、整改动作、责任方、优先级、预计成本、待确认材料、是否影响业主大会表决。",
    steps: [
      "1. 先把小区现状拆成门厅楼梯口违规停放、集中充电区不足、架空层和地下库改造、旧车置换咨询、居民沟通五类问题。",
      "2. 核验高层民用建筑消防安全管理规定PDF和网页的发布主体、条款一致性、实施时间和适用对象。",
      "3. 读取规定中关于公共门厅、疏散走道、楼梯间、安全出口停放和充电的禁止性要求。",
      "4. 读取消防部门政策解读，提取集中存放充电场所独立设置、防火分隔、消防器材和自动断电等解释口径。",
      "5. 读取2025年电动自行车以旧换新通知，整理活动时间、补贴衔接、旧车回收和安全治理相关内容。",
      "6. 读取商务部以旧换新政策解读，区分居民换新引导与小区充停设施整改之间能关联和不能直接替代的内容。",
      "7. 将现场点位按立即清理、临时管控、可改造评估、需街道或消防确认四类分组。",
      "8. 对集中充电、地下库、架空层和旧车置换引导分别列出适用条件、主要风险、居民体验影响和待确认成本。",
      "9. 整理居民沟通话术，说明哪些位置不能继续停放，哪些需要等图纸、报价、消防意见和业主表决后再定。",
      "10. 生成Word会前建议和Excel整改跟踪表，最后自检是否编造小区验收结论、设备报价、居民投票结果或消防书面意见。",
    ],
    attachments: [
      {
        fileName: "附件一_高层民用建筑消防安全管理规定.pdf",
        title: "高层民用建筑消防安全管理规定",
        url: "https://www.mem.gov.cn/gk/zfxxgkpt/fdzdgknr/202106/P020210625560426813285.pdf",
        format: "pdf",
        purpose: "用于核对高层住宅公共门厅、疏散走道、楼梯间、安全出口停放和充电禁止要求。",
      },
      {
        fileName: "附件二_高层民用建筑消防安全管理规定页面.html",
        title: "高层民用建筑消防安全管理规定网页",
        url: "https://www.mem.gov.cn/gk/zfxxgkpt/fdzdgknr/202106/t20210625_389980.shtml",
        format: "html",
        purpose: "用于确认规定发布主体、实施时间和条款文字，便于与PDF交叉核对。",
      },
      {
        fileName: "附件三_高层民用建筑消防安全管理规定政策解读.html",
        title: "高层民用建筑消防安全管理规定政策解读",
        url: "https://www.mem.gov.cn/gk/zcjd/202107/t20210716_392214.shtml",
        format: "html",
        purpose: "用于整理集中存放充电场所、防火分隔、消防器材和自动断电要求的解释口径。",
      },
      {
        fileName: "附件四_2025年度电动自行车以旧换新工作通知.html",
        title: "2025年度电动自行车以旧换新工作通知",
        url: "https://www.ndrc.gov.cn/xwdt/ztzl/tddgmsbgxhxfpyjhx/gzdt/202501/t20250124_1395896.html",
        format: "html",
        purpose: "用于核对以旧换新的活动时间、补贴衔接、旧车回收和安全治理要求。",
      },
      {
        fileName: "附件五_电动自行车以旧换新政策解读.html",
        title: "电动自行车以旧换新政策解读",
        url: "https://www.mofcom.gov.cn/zcjd/gnmy/art/2024/art_0949b90254084c3ab67ac0f33a1062c5.html",
        format: "html",
        purpose: "用于确认居民换新引导和安全治理之间的政策背景，避免把换新补贴误当成小区整改依据。",
      },
    ],
    boundary:
      "以上资料只能支撑小区充停整改、旧车置换沟通和居民会前说明的规则核对，不能证明具体小区图纸条件、消防验收结论、设备报价、回收商资质或业主大会表决结果。",
  },
  {
    uid: "沈礼_7.9_03",
    title:
      "运营同事把下个月直播间的低糖高蛋白代餐粉脚本发过来，说主播想主打“控糖、饱腹、饭前一杯少吃主食”，包装背面还有营养成分表和过敏原提示。品牌这边还没决定能不能把短视频种草、达人口播和详情页一起投出去，最怕的是普通食品被说得像保健食品，或者广告标识、标签信息、网络食品销售资料缺一块。\n这次先用互联网广告管理办法、广告可识别性执法指南、预包装食品标签通则、特殊食品广告审查办法、网络食品查处办法和食品安全法做一轮素材风险审查。结果要给运营、法务和店铺负责人直接改稿用：哪些话术可保留，哪些要降级成客观描述，哪些需要营养检测报告、标签原件或广告审查材料补证。产品真实配方、检测报告、销售页面截图和达人合作关系公开资料看不到，放到待确认栏。",
    taskType: "L2 流程型",
    primary: "品牌市场与电商零售",
    secondary: "电商经营与广告合规",
    tertiary: "低糖高蛋白代餐食品直播素材与标签合规审查",
    summary: "帮助食品品牌在直播投放前核对代餐食品标签、功效话术、广告可识别性和平台销售资料缺口。",
    experience: "5年",
    time: "14h",
    productFormat: "docx, xlsx",
    productContent:
      "最终产物为两个可编辑文件：一份Word文档（docx），给运营、法务和店铺负责人看，包含能否进入投放、风险话术清单、普通食品和特殊食品边界、广告可识别性提示、标签和资质补证要求；一份Excel表格（xlsx），字段包括素材位置、原话术、涉及规则、风险类型、建议改法、需补证明、负责人、是否阻断上线。",
    steps: [
      "1. 先把素材拆成直播口播、短视频种草、详情页卖点、包装标签、营养成分表、达人合作披露六类。",
      "2. 核验每份附件的发布主体、适用对象、发布时间和文件格式，确认广告、标签、网络销售和特殊食品规则的边界。",
      "3. 读取互联网广告管理办法，提取互联网广告、广告发布者责任、广告标识和直播带货相关管理要求。",
      "4. 读取广告可识别性执法指南，判断短视频种草、达人推荐和详情页软性展示是否需要更清楚的广告识别提示。",
      "5. 读取预包装食品标签通则，核对配料、净含量、生产者、日期、贮存条件、营养信息和过敏原提示相关要求。",
      "6. 读取特殊食品广告审查办法，判断控糖、减脂、代餐、改善身体状态等话术是否容易越界到疾病预防治疗或保健功能。",
      "7. 读取网络食品安全违法行为查处办法，整理网络销售食品资质展示、特殊食品公示和平台页面信息要求。",
      "8. 读取食品安全法，补充食品广告、标签说明书、虚假宣传和食品经营责任的上位法依据。",
      "9. 将原始话术按可保留、需改客观描述、需补证明、暂缓上线四类分组，并给出替代表达。",
      "10. 列出需要内部补充的配方、检测报告、包装标签原件、店铺页面截图、达人合作关系和广告审查材料。",
      "11. 生成Word审查意见和Excel改稿表，最后自检是否编造检测结论、批准文号、营养数据或达人真实体验。",
    ],
    attachments: [
      {
        fileName: "附件一_互联网广告管理办法.html",
        title: "互联网广告管理办法",
        url: "https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=97881",
        format: "html",
        purpose: "用于核对互联网广告、直播带货、广告发布责任和广告标识相关要求；页面载明发布部门为国家市场监督管理总局。",
      },
      {
        fileName: "附件二_互联网广告可识别性执法指南.html",
        title: "互联网广告可识别性执法指南",
        url: "https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/ggjgs/art/2024/art_89824524f2804c5594e95408fbdf8602.html",
        format: "html",
        purpose: "用于判断短视频种草、达人口播和详情页软性推广是否需要显著广告识别提示。",
      },
      {
        fileName: "附件三_预包装食品标签通则_GB7718_2011.pdf",
        title: "食品安全国家标准 预包装食品标签通则 GB 7718-2011",
        url: "https://www.nhc.gov.cn/zwgk/cybz/201106/53c53d99b71940c7a74830f86b46f8db/files/e84256474d1445919246b4a41a87f172.pdf",
        format: "pdf",
        purpose: "用于核对预包装食品标签的基本标示项目、日期、配料、净含量和过敏原提示。",
      },
      {
        fileName: "附件四_特殊食品广告审查管理暂行办法.pdf",
        title: "医疗器械、保健食品、特殊医学用途配方食品广告审查管理暂行办法",
        url: "https://sjfg.samr.gov.cn/law/file//pdf/3235243/1663660163213.pdf",
        format: "pdf",
        purpose: "用于核对保健食品和特殊医学用途配方食品广告审查、声明和功效表述边界。",
      },
      {
        fileName: "附件五_网络食品安全违法行为查处办法.pdf",
        title: "网络食品安全违法行为查处办法",
        url: "https://sjfg.samr.gov.cn/law/file//pdf/3235243/1663580550475.pdf",
        format: "pdf",
        purpose: "用于整理网络食品销售页面资质公示、特殊食品信息展示和平台责任相关要求。",
      },
      {
        fileName: "附件六_中华人民共和国食品安全法.pdf",
        title: "中华人民共和国食品安全法",
        url: "https://czt.ln.gov.cn/eportal/fileDir/data/lnsczt/W020190422606335384777.pdf",
        format: "pdf",
        purpose: "用于补充食品标签、说明书、广告、食品经营责任和虚假宣传的上位法依据；该PDF来自辽宁财政厅转载页，页面标注信息来源为国家法规数据库。",
      },
    ],
    boundary:
      "以上资料只能支撑代餐食品直播素材、标签和网络销售资料的规则初筛，不能证明产品配方真实、检测报告有效、广告审查已经通过、达人合作关系已披露或平台一定允许上线。",
  },
];

function encodeSteps(steps) {
  return steps.join("\\n");
}

function attachmentFormat(row) {
  return [...new Set(row.attachments.map((item) => item.format))].join(", ");
}

function relatedAttachments(row) {
  return row.attachments.map((item) => item.fileName).join("；");
}

function attachmentContent(row) {
  return [
    ...row.attachments.flatMap((item, index) => [
      `附件${["一", "二", "三", "四", "五", "六", "七", "八"][index]}：《${item.title}》，${item.purpose}`,
      `来源：${item.url}`,
    ]),
    `边界：${row.boundary}`,
  ].join("\\n");
}

function escapeTsvCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, " ");
}

function rowToTsv(row) {
  return [
    row.uid,
    row.title,
    row.taskType,
    row.primary,
    row.secondary,
    row.tertiary,
    row.summary,
    relatedAttachments(row),
    row.experience,
    row.time,
    attachmentFormat(row),
    attachmentContent(row),
    row.productFormat,
    row.productContent,
    encodeSteps(row.steps),
    "沈礼",
  ].map(escapeTsvCell);
}

function detectFormat(buffer, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const head4 = buffer.subarray(0, 4).toString("latin1");
  if (head4 === "%PDF") return "pdf";
  if (head4 === "PK\u0003\u0004") {
    if (ext === ".docx") return "docx";
    if (ext === ".xlsx") return "xlsx";
    if (ext === ".pptx") return "pptx";
    return "zip";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8").trimStart();
  if (/^<!doctype html/i.test(sample) || /^<html/i.test(sample) || sample.includes("<title")) return "html";
  if (sample.startsWith("{") || sample.startsWith("[")) return "json";
  if (ext === ".csv") return "csv";
  return ext ? ext.slice(1) : "unknown";
}

async function sha256(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAttachmentBuffer(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(attempt * 1200);
    }
  }
  throw new Error(`download failed for ${url}: ${lastError?.message ?? lastError}`);
}

function validateBuffer(buffer, filePath, expectedFormat) {
  const detected = detectFormat(buffer, filePath);
  const htmlText = detected === "html" ? buffer.toString("utf8") : "";
  const validation =
    detected === expectedFormat ||
    (expectedFormat === "html" && htmlText.length > 2000) ||
    (expectedFormat === "pdf" && detected === "pdf")
      ? "PASS"
      : `WARN: expected ${expectedFormat}, detected ${detected}`;
  return { detected, validation };
}

async function downloadAttachment(topicDir, attachment) {
  const filePath = path.join(topicDir, attachment.fileName);
  let buffer;
  try {
    buffer = await fs.readFile(filePath);
    const existing = validateBuffer(buffer, filePath, attachment.format);
    if (existing.validation !== "PASS" || buffer.length < 2000) {
      buffer = await fetchAttachmentBuffer(attachment.url);
    }
  } catch {
    buffer = await fetchAttachmentBuffer(attachment.url);
  }
  await fs.writeFile(filePath, buffer);
  const stat = await fs.stat(filePath);
  const { detected, validation } = validateBuffer(buffer, filePath, attachment.format);
  return {
    fileName: attachment.fileName,
    url: attachment.url,
    expectedFormat: attachment.format,
    detectedFormat: detected,
    bytes: stat.size,
    sha256: await sha256(filePath),
    path: filePath,
    validation,
  };
}

async function main() {
  await fs.mkdir(runRoot, { recursive: true });
  await fs.mkdir(attachmentRoot, { recursive: true });

  const attachmentManifest = [];
  for (const row of rows) {
    const topicDir = path.join(attachmentRoot, row.tertiary);
    await fs.mkdir(topicDir, { recursive: true });
    for (const attachment of row.attachments) {
      attachmentManifest.push({
        uid: row.uid,
        topic: row.tertiary,
        ...(await downloadAttachment(topicDir, attachment)),
      });
    }
  }

  const tsv = [headers.join("\t"), ...rows.map((row) => rowToTsv(row).join("\t"))].join("\n");
  await fs.writeFile(tsvPath, `${tsv}\n`, "utf8");

  const plan = buildFeishuFillPlan({
    text: `${tsv}\n`,
    sourcePath: tsvPath,
    startRow: 115,
    count: rows.length,
    columnMap,
  });
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await fs.writeFile(manifestPath, `${JSON.stringify({ runId, rows: rows.length, attachmentManifest }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ runId, tsvPath, planPath, manifestPath, attachments: attachmentManifest.length }, null, 2));
}

await main();
