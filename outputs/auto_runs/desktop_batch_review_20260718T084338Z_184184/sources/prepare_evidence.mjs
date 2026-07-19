import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const runId = "desktop_batch_review_20260718T084338Z_184184";
const recordUid = "裴硬_20260718_desktop_batch_review_01";
const runDir = path.resolve("outputs/auto_runs", runId);
const attachmentDir = path.join(runDir, "attachments");
const sourceDir = path.join(runDir, "sources");
const sourcePageUrl = "https://www.ccgp.gov.cn/cggg/zygg/zbgg/202606/t20260610_26722581.htm";
const downloadedAt = new Date().toISOString();

const definitions = [
  {
    id: "material-award-announcement",
    name: "成交结果公告.html",
    title: "中央国家机关2026年台式计算机批量集中采购项目-6月中标公告",
    publisher: "中国政府采购网",
    publishedAt: "2026-06-10",
    url: sourcePageUrl,
    contentType: "text/html",
    format: "html",
    supports: "项目身份、预算、六包成交供应商、成交单价、数量、质保比例、初审结果和公告页总金额字段",
    boundary: "公告页总金额字段与六包逐项金额合计不一致，实际合同与履约结果未提供",
    summary: "中国政府采购网成交结果公告，包含项目编号、预算、六包成交明细、质保比例、初审结果和附件入口。",
    object: "中央国家机关2026年台式计算机批量集中采购项目-6月（GC-HCD260444）",
    uniqueContent: "公告概要总金额字段、六包成交单价与数量、质保比例和初审拒绝原因",
  },
  {
    id: "material-delivery-plan",
    name: "台式机202606计划公示.xls",
    title: "中央国家机关批量集中采购实施计划配送信息表",
    publisher: "中央国家机关政府采购中心公告附件",
    publishedAt: "2026-06-10",
    url: "https://download.ccgp.gov.cn/oss/download?uuid=1448ee61-d44c-4d08-989f-d185db",
    contentType: "application/vnd.ms-excel",
    format: "xls",
    supports: "535条配送明细、六种配置数量、操作系统口径和配送地址字段",
    boundary: "计划数据不等于实际送达记录，部分PR单号和地址字段缺失或异常",
    summary: "官方配送计划表，含535条计划记录、配置类型、操作系统、数量和配送地址。",
    object: "GC-HCD260444项目2026年6月台式机配送计划",
    uniqueContent: "六种配置共5889台的逐行配送计划及字段异常",
  },
  {
    id: "material-procurement-file",
    name: "中央国家机关2026年台式计算机批量集中采购项目-6月采购文件.pdf",
    title: "中央国家机关2026年台式计算机批量集中采购项目-6月竞争性磋商文件",
    publisher: "中央国家机关政府采购中心公告附件",
    publishedAt: "2026-05",
    url: "https://download.ccgp.gov.cn/oss/download?uuid=4fc72384-e7e3-474f-9e91-0683d0",
    contentType: "application/pdf",
    format: "pdf",
    supports: "六包预算、交付期限、技术要求、质保价格填报与响应总价公式",
    boundary: "采购要求和参考合同不证明最终交付已经完成",
    summary: "官方竞争性磋商文件，包含预算、配置数量、技术标准、交付和质保价格公式。",
    object: "GC-HCD260444竞争性磋商项目",
    uniqueContent: "六包预算与配置要求、20个工作日交付、平均质保比例计价公式",
  },
  {
    id: "material-score-ranking",
    name: "投标人得分排序表_官方导出.html",
    title: "投标人得分排序表",
    publisher: "中央国家机关政府采购中心公告附件",
    publishedAt: "2026-06-10",
    url: "https://download.ccgp.gov.cn/oss/download?uuid=ccd8d1ba-85a6-4864-8308-8279c2",
    contentType: "text/html",
    format: "html",
    supports: "六包投标人编号、得分和名次",
    boundary: "只给出匿名投标人编号，未提供各评分项分解",
    summary: "官方得分排序表下载内容，实际文件签名为HTML，列出六包得分和名次。",
    object: "GC-HCD260444六包评审得分排序",
    uniqueContent: "各包匿名投标人编号、得分及名次",
  },
  {
    id: "material-deviation-1",
    name: "技术规范偏离表-1-软通.pdf",
    title: "配置1响应产品技术规范偏离表",
    publisher: "软通计算机有限公司电子签章响应文件（公告附件）",
    publishedAt: "2026-06",
    url: "https://download.ccgp.gov.cn/oss/download?uuid=5f65b831-efeb-44f7-b75e-1610ed",
    contentType: "application/pdf",
    format: "pdf",
    supports: "配置1响应价格、龙芯3A6000、显示屏、内存、存储与显卡响应",
    boundary: "响应表不等于最终成交报价或实物验收结果",
    summary: "配置1技术偏离表，响应价格4950元，列出龙芯3A6000及关键配置。",
    object: "GC-HCD260444第一包配置1",
    uniqueContent: "4950元响应价和配置1逐项技术响应",
  },
  {
    id: "material-deviation-2",
    name: "技术规范偏离表-2-软通.pdf",
    title: "配置2响应产品技术规范偏离表",
    publisher: "软通计算机有限公司电子签章响应文件（公告附件）",
    publishedAt: "2026-06",
    url: "https://download.ccgp.gov.cn/oss/download?uuid=ec6a7f3d-e2f5-41b0-854e-4267b5",
    contentType: "application/pdf",
    format: "pdf",
    supports: "配置2响应价格、飞腾腾锐D3000、显示屏、内存、存储与显卡响应",
    boundary: "响应表不等于最终成交报价或实物验收结果",
    summary: "配置2技术偏离表，响应价格4950元，列出飞腾腾锐D3000及关键配置。",
    object: "GC-HCD260444第二包配置2",
    uniqueContent: "4950元响应价和配置2逐项技术响应",
  },
  {
    id: "material-deviation-3",
    name: "技术规范偏离表-3-联想.pdf",
    title: "配置3响应产品技术规范偏离表",
    publisher: "联想开天科技有限公司电子签章响应文件（公告附件）",
    publishedAt: "2026-06",
    url: "https://download.ccgp.gov.cn/oss/download?uuid=6d0a8b93-dbaa-4290-b547-2188f2",
    contentType: "application/pdf",
    format: "pdf",
    supports: "配置3响应价格、兆芯KX-7000、四个内存接口和2TB机械硬盘响应",
    boundary: "响应表不等于最终成交报价或实物验收结果",
    summary: "配置3技术偏离表，响应价格4950元，列出兆芯KX-7000与正偏离项。",
    object: "GC-HCD260444第三包配置3",
    uniqueContent: "4950元响应价、四个内存接口和2TB机械硬盘",
  },
  {
    id: "material-deviation-4",
    name: "技术规范偏离表-4-华为.pdf",
    title: "配置4响应产品技术规范偏离表",
    publisher: "华为终端有限公司电子签章响应文件（公告附件）",
    publishedAt: "2026-06",
    url: "https://download.ccgp.gov.cn/oss/download?uuid=ad85cc56-24e3-4b9b-8ac4-ad8ea6",
    contentType: "application/pdf",
    format: "pdf",
    supports: "配置4响应价格、麒麟9000X、6400MT/s板载内存和集成显卡响应",
    boundary: "响应表不等于最终成交报价或实物验收结果",
    summary: "配置4技术偏离表，响应价格4950元，列出麒麟9000X和板载内存等配置。",
    object: "GC-HCD260444第四包配置4",
    uniqueContent: "4950元响应价、麒麟9000X、6400MT/s板载内存",
  },
  {
    id: "material-deviation-5",
    name: "技术规范偏离表-5-安领信.pdf",
    title: "配置5响应产品技术规范偏离表",
    publisher: "安领信（北京）科技有限公司电子签章响应文件（公告附件）",
    publishedAt: "2026-06",
    url: "https://download.ccgp.gov.cn/oss/download?uuid=f87e2f8d-0a73-40aa-9485-461563",
    contentType: "application/pdf",
    format: "pdf",
    supports: "配置5响应价格、海光C86-3G和4GB独立显卡响应",
    boundary: "响应表不等于最终成交报价或实物验收结果",
    summary: "配置5技术偏离表，响应价格4950元，列出海光C86-3G和4GB独显。",
    object: "GC-HCD260444第五包配置5",
    uniqueContent: "4950元响应价、3.0GHz主频和4GB独显",
  },
  {
    id: "material-deviation-6",
    name: "技术规范偏离表-6-天津光电.pdf",
    title: "配置6响应产品技术规范偏离表",
    publisher: "天津光电集团信安先进技术（江苏）有限公司电子签章响应文件（公告附件）",
    publishedAt: "2026-06",
    url: "https://download.ccgp.gov.cn/oss/download?uuid=c2c7017d-503f-426f-82ff-6ae93b",
    contentType: "application/pdf",
    format: "pdf",
    supports: "配置6响应价格、申威SW-WY831和GDDR6独立显卡响应",
    boundary: "响应表不等于最终成交报价或实物验收结果",
    summary: "配置6技术偏离表，响应价格4978元，列出申威SW-WY831和GDDR6独显。",
    object: "GC-HCD260444第六包配置6",
    uniqueContent: "4978元响应价、申威SW-WY831和GDDR6显存",
  },
];

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const items = [];
for (const definition of definitions) {
  const localPath = path.join(attachmentDir, definition.name);
  const bytes = await fs.readFile(localPath);
  items.push({
    name: definition.name,
    url: definition.url,
    sourcePageUrl,
    path: localPath,
    size: bytes.length,
    sha256: sha256(bytes),
    contentType: definition.contentType,
    finalUrl: definition.url,
    downloadedAt,
  });
}

const downloadManifest = {
  schemaVersion: 1,
  kind: "official-material-download-manifest",
  runId,
  generatedAt: downloadedAt,
  items,
};

const facts = [
  {
    id: "fact-project-identity",
    text: "中国政府采购网于2026年6月10日发布中央国家机关2026年台式计算机批量集中采购项目-6月中标公告，项目编号GC-HCD260444，采购方式为竞争性磋商，项目预算2944.5万元。",
    sourceRefs: ["material-award-announcement", "material-procurement-file"],
    locator: "成交结果公告第一项；采购文件PDF第2页采购邀请",
  },
  {
    id: "fact-plan-volume",
    text: "配送计划表有535条有效明细，数量列合计5889台，与表尾合计一致。按配置汇总为配置1 195台、配置2 463台、配置3 899台、配置4 1663台、配置5 2638台、配置6 31台。",
    sourceRefs: ["material-delivery-plan"],
    locator: "配送计划表台式机工作表第3至537行及第538行合计",
  },
  {
    id: "fact-plan-os-mix",
    text: "按原始操作系统字段汇总为麒麟3072台、统信UOS 2620台、中科方德9台、其他符合安全可靠测评要求187台，另有1台写成截断文本“其他符合安全可靠测评要求的操作系”。复核表可把后两项合并展示为其他口径188台，同时把其中1台保持为截断文本待核。",
    sourceRefs: ["material-delivery-plan"],
    locator: "配送计划表操作系统列和数量列分组汇总",
  },
  {
    id: "fact-plan-data-quality",
    text: "配送计划535条明细中有506条PR单号为空。详细配送地址列有5条纯数字值，其中2条表现为11位电话号码，3条为数值1。上述行只能作为字段异常进入待核清单。",
    sourceRefs: ["material-delivery-plan"],
    locator: "配送计划表PR单号列与详细配送地址列的数据清洗结果",
  },
  {
    id: "fact-award-lines",
    text: "六包最终成交单价和数量依次为4900元×195台、4585元×463台、4939元×899台、4940元×1663台、4950元×2638台、4960元×31台。逐包金额依次为955500元、2122855元、4440161元、8215220元、13058100元和153760元。",
    sourceRefs: ["material-award-announcement", "material-delivery-plan"],
    locator: "成交结果公告第三项主要标的信息；配送计划表配置数量汇总",
  },
  {
    id: "fact-award-total-conflict",
    text: "六包逐项金额合计28945596元，即2894.5596万元。公告概要的总中标金额字段显示212.2855万元，与第二包金额一致，和六包合计相差2682.2741万元。该字段冲突需要在核对表中单独展示。",
    sourceRefs: ["material-award-announcement"],
    locator: "成交结果公告公告概要与第二项、第三项六包明细",
  },
  {
    id: "fact-budget-variance",
    text: "项目预算29445000元，六包逐项成交金额合计28945596元，差额499404元。按预算为分母计算，成交金额比预算低约1.696%。",
    sourceRefs: ["material-award-announcement", "material-procurement-file"],
    locator: "项目预算与六包成交金额的派生复核",
  },
  {
    id: "fact-response-price-revisions",
    text: "六份技术偏离表的预算响应值依次为4950元、4950元、4950元、4950元、4950元和4978元。与最终成交单价相比，配置1至配置6每台分别下降50元、365元、11元、10元、0元和18元。按计划数量计算的总降幅依次为9750元、168995元、9889元、16630元、0元和558元。",
    sourceRefs: ["material-deviation-1", "material-deviation-2", "material-deviation-3", "material-deviation-4", "material-deviation-5", "material-deviation-6", "material-award-announcement", "material-delivery-plan"],
    locator: "六份偏离表第1页预算响应值；公告最终成交单价；配送计划数量",
  },
  {
    id: "fact-warranty-formula",
    text: "采购文件要求分别填报三年、五年和六年原厂质保服务价格占裸机价格比例，并按三者平均比例计入每包响应总价。成交公告中配置1至配置5的比例均为0%、1%、2%，配置6为0%、0%、0%。",
    sourceRefs: ["material-procurement-file", "material-award-announcement"],
    locator: "采购文件PDF第9页响应人须知前附表第22项；公告第三项质保比例",
  },
  {
    id: "fact-config-1-2",
    text: "配置1响应为龙芯3A6000、2.5GHz、4核、8GB内存、1TB机械硬盘加256GB固态硬盘和2GB独显。配置2响应为飞腾腾锐D3000、2.5GHz、8核，其余核心存储与显卡口径和配置1相近。两包显示屏响应时间5ms，可视角度178°/178°。",
    sourceRefs: ["material-deviation-1", "material-deviation-2"],
    locator: "配置1和配置2技术偏离表第1至4页",
  },
  {
    id: "fact-config-3-4",
    text: "配置3响应为兆芯KX-7000、3.6GHz、8核、4个内存扩展接口、2TB机械硬盘和2GB独显。配置4响应为华为鲲鹏麒麟9000X、2.4GHz、8核、6400MT/s板载内存、1TB机械硬盘加256GB固态硬盘和集成显卡。",
    sourceRefs: ["material-deviation-3", "material-deviation-4"],
    locator: "配置3和配置4技术偏离表第1至3页",
  },
  {
    id: "fact-config-5-6",
    text: "配置5响应为海光C86-3G、3.0GHz、8核和4GB独显。配置6响应为申威SW-WY831、2.5GHz、8核和2GB GDDR6独显。两包都列有1TB机械硬盘加256GB固态硬盘。",
    sourceRefs: ["material-deviation-5", "material-deviation-6"],
    locator: "配置5和配置6技术偏离表第1至3页",
  },
  {
    id: "fact-ranking",
    text: "得分排序表中第一、二、三、五包各有多名投标人排序，第四包和第六包各只列一名投标人。表内使用匿名投标人编号，无法直接从该表把编号映射到供应商名称。",
    sourceRefs: ["material-score-ranking"],
    locator: "投标人得分排序表六包明细",
  },
  {
    id: "fact-initial-review",
    text: "成交公告显示第二包有一家投标人因未在规定时间提交最后报价而退出磋商，第六包有一家投标人因未提供有效节能产品认证证书而未通过符合性审查。",
    sourceRefs: ["material-award-announcement"],
    locator: "成交结果公告第二项初审情况",
  },
  {
    id: "fact-delivery-service",
    text: "采购文件约定成交公告发布之日起20个工作日内供货，免费服务周期不少于3年，并要求同城4小时、异地12小时技术响应和2个工作日解决问题。实际交货、验收和服务响应记录尚未提供。",
    sourceRefs: ["material-procurement-file"],
    locator: "采购文件PDF第2页交付时间及各包服务要求和实施方案",
  },
  {
    id: "fact-evidence-boundary",
    text: "公告和附件能够复核公开采购口径、计划数量、响应参数与最终成交结果。它们无法证明每个采购单位的实际下单量、实际到货数量、实物配置、操作系统兼容性、验收结论、付款状态或售后履约表现。",
    sourceRefs: definitions.map((item) => item.id),
    locator: "十份公开材料的证据范围与缺失项综合判断",
  },
].map((fact) => ({
  uid: recordUid,
  claimType: fact.id.includes("conflict") || fact.id.includes("variance") || fact.id.includes("revisions") ? "derived-check" : fact.id === "fact-evidence-boundary" ? "evidence-boundary" : "source-fact",
  ...fact,
}));

const materials = definitions.map((definition) => {
  const manifestItem = items.find((item) => item.name === definition.name);
  return {
    id: definition.id,
    uid: recordUid,
    name: definition.name,
    text: definition.summary,
    sourceUrl: definition.url,
    sha256: manifestItem.sha256,
  };
});

const factLedger = {
  schemaVersion: 1,
  kind: "evidence-bound-fact-ledger",
  runId,
  recordUid,
  generatedAt: downloadedAt,
  facts,
  materials,
  unknowns: [
    { id: "unknown-order-ledger", uid: recordUid, text: "各采购单位实际下单数量、订单编号、合同编号和最终收货数量尚未提供。" },
    { id: "unknown-delivery-validation", uid: recordUid, text: "设备序列号、实物配置、操作系统版本、外设清单和开机测试记录尚未提供。" },
    { id: "unknown-compatibility", uid: recordUid, text: "真实业务软件清单、驱动兼容性测试、性能测试和用户试用反馈尚未提供。" },
    { id: "unknown-payment-service", uid: recordUid, text: "合同、验收单、付款记录、故障工单和售后响应时长尚未提供。" },
    { id: "unknown-total-field-explanation", uid: recordUid, text: "公告概要总中标金额只显示第二包金额的原因未在公开页面说明。" },
  ],
  decision: {
    id: "decision-public-reconciliation-and-sampling",
    text: "建立公开采购口径复核表，先对齐数量、金额和规格证据，再从六包中挑选两包进入人工抽检准备。",
  },
  deliveryUse: {
    recipient: "采购结算与设备抽检同事",
    purpose: "复核公开采购口径并安排首轮人工抽检，实际验收结论由订单、实物和签章记录补齐。",
  },
};

const sourceCards = {
  schemaVersion: 1,
  kind: "source-card-bundle",
  runId,
  recordUid,
  sources: definitions.map((definition) => ({
    materialId: definition.id,
    title: definition.title,
    publisher: definition.publisher,
    publishedAt: definition.publishedAt,
    accessedAt: "2026-07-18",
    path: `attachments/${definition.name}`,
    supports: definition.supports,
    boundary: definition.boundary,
  })),
};

await writeJson(path.join(sourceDir, "download_manifest.json"), downloadManifest);
await writeJson(path.join(sourceDir, "fact_ledger.json"), factLedger);
await writeJson(path.join(sourceDir, "source_cards.json"), sourceCards);

console.log(JSON.stringify({
  runId,
  recordUid,
  attachmentCount: items.length,
  totalBytes: items.reduce((sum, item) => sum + item.size, 0),
  facts: facts.length,
  materials: materials.length,
}, null, 2));
