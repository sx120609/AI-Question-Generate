import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const runRoot = path.join(root, "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2");
const planPath = path.join(runRoot, "feishu/feishu_fill_plan_145_149.json");
const valueRangesPath = path.join(runRoot, "feishu/antitemplate_rewrite_value_ranges_145_149.json");
const logPath = path.join(runRoot, "qa/antitemplate_rewrite_fields_145_149.json");
const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";
const rowNumbers = [145, 146, 147, 148, 149];

const COLUMNS = {
  question: 0,
  summary: 5,
  attachmentContent: 10,
  productContent: 12,
  steps: 13,
};

const rewrites = [
  {
    question:
      "周五前要定达人脚本，运营把“敏感肌急救精华”的三段短视频口播、详情页首屏文案和前后对比图都放进排期表，投放链接已经约好达人账号。现在最难定的是“三天退红”“医美级维稳”“修护屏障”哪些还能留，哪些要换成更稳的表达；产品备案页、功效评价摘要截图、达人合同和后台投放数据暂时都不在附件里，只能作为补证栏。请把这批素材改成一份给内容运营看的Word复核意见，再配一张Excel改稿表，能直接标出保留、改写、暂缓和补依据四种处理。",
    summary:
      "围绕敏感肌精华达人投放素材，给出功效宣称、广告可识别性、页面展示和补证栏的改稿判断。",
    attachmentContent:
      "这组材料只解决“法规口径”，不替代产品自身备案、功效摘要或达人合作材料。\n- 《化妆品监督管理条例》。来源：https://xzfg.moj.gov.cn/law/download?LawID=451&type=pdf。用于核对功效宣称真实性、标签广告医疗暗示、经营者责任和处罚边界；对“三天退红”“医美级”等高风险词给出上限。\n- 《化妆品网络经营监督管理办法》。来源：https://yjj.scjgj.fujian.gov.cn/hzp/flfg/202305/t20230519_6172489.htm。用于确认详情页、网络销售页面、平台内经营者信息展示和风险处置留痕。\n- 《化妆品功效宣称评价规范》。来源：https://yjj.scjgj.fujian.gov.cn/hzp/flfg/202107/t20210708_5642667.htm。用于整理保湿、修护、舒缓等功效证据强度、摘要公开和评价资料口径。\n- 《互联网广告管理办法》。来源：https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202306/t20230620_481045.html。用于核对达人发布、购买链接、种草表达和广告可识别性。\n缺口：产品备案截图、功效评价摘要、达人合同、用户对比图来源、后台数据均未随附件提供，交付物只把它们列入补证项。",
    productContent:
      "交付物分两块：Word（docx）写给内容运营和法务同看，先按素材位置列出口播、详情页、对比图、购买链路的风险判断，再给可保留句、替代表达、暂缓原因和补证项。Excel（xlsx）做成改稿台账，列素材位置、原句/图片说明、触发的法规点、处理动作、风险等级、负责人、待补截图或合同、复核状态。验收重点是每条改稿意见都能回到附件依据，同时不把未取得的备案、摘要、合同和后台数据写成事实。",
    steps:
      "1. 把口播脚本、详情页首屏、对比图说明和购买链路拆成素材点位。\n2. 先给“三天退红”“医美级维稳”“急救”等词做功效/医疗暗示风险标记。\n3. 用化妆品条例核对真实性、医疗作用暗示和经营者责任。\n4. 用网络经营办法检查页面展示、主体信息和平台留痕要求。\n5. 用功效宣称评价规范判断修护、舒缓、保湿等表达需要哪类评价材料。\n6. 用互联网广告办法确认达人合作披露、广告标识和购买链接关联。\n7. 把每个素材点位落到保留、改写、暂缓、补功效依据四个处理动作之一。\n8. 对能改写的句子给出贴近原卖点的低风险替代表达。\n9. 在Word里写清运营可直接采纳的口径、法务仍需确认的边界和补证清单。\n10. 在Excel里保留原文案、附件依据、责任人、完成时限和复核状态。\n11. 复查所有“已证实”措辞，凡无备案、摘要、合同或后台数据支撑的都回到待补栏。",
  },
  {
    question:
      "明天客户周会要给销售一个能上桌的口径：官网预约试用、展会扫码、公众号留资这三路线索，是否能先接入海外CRM，哪些字段先留在境内。现有材料只有字段清单、供应商标准合同和一页“全球合规”说明，真实CRM合同、境外接收方安全材料、用户授权记录、历史导出日志都没拿到。法务要的不是最终出境审批，而是一份Word初筛意见和一张Excel补件/字段清单，能把可低风险试点、需脱敏、先暂缓、待补材料后再判断的事项分开。",
    summary:
      "把海外CRM线索同步改成周会可用的初筛口径，区分低风险试点、字段暂缓和合同授权补件。",
    attachmentContent:
      "附件只提供数据出境的法律路径，业务证据仍需销售和供应商补齐。\n- 《中华人民共和国个人信息保护法》。来源：https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm。用于核对告知同意、最小必要、敏感个人信息、自动化决策和个人信息出境条件。\n- 《中华人民共和国数据安全法》。来源：https://www.cac.gov.cn/2021-06/11/c_1624994566919140.htm。用于整理数据分类分级、安全保护义务、重要数据和风险监测要求。\n- 《数据出境安全评估办法》。来源：https://www.cac.gov.cn/2022-07/07/c_1658811536594644.htm。用于确认哪些情形可能走安全评估、申报材料和评估关注点。\n- 《促进和规范数据跨境流动规定》。来源：https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm。用于核对2024年跨境流动便利化、豁免、负面清单和标准合同等路径。\n资料缺口：CRM正式合同、字段字典、境外接收方说明、授权记录、导出日志都不在附件里，Excel只做补件状态和初步处理建议。",
    productContent:
      "Word（docx）按“周会能怎么说”组织：给销售的结论口径、哪些字段先不进海外CRM、低风险试点条件、需要供应商补的材料、后续审批路线。Excel（xlsx）按字段逐行记录：姓名、手机号、公司邮箱、职位、采购预算、跟进备注，对应个人信息属性、当前证据、建议动作、引用附件、补件责任人和能否进入少字段试点。验收时应能看出这是一份初筛材料，不替代最终出境审批。",
    steps:
      "1. 先确认三类线索来源、六个拟同步字段和客户周会的决策口径。\n2. 把手机号、姓名、邮箱、职位、预算、备注分别标出个人信息属性和业务必要性。\n3. 用个人信息保护法检查告知同意、最小必要和出境前置条件。\n4. 用数据安全法判断是否需要分类分级、重要数据识别或额外安全管理。\n5. 用安全评估办法列出可能触发评估的门槛和申报材料缺口。\n6. 用跨境流动规定补充豁免、标准合同、负面清单和便利化判断。\n7. 将字段分成境内暂存、脱敏少字段试点、暂缓同步、补材料后再议四类。\n8. 把CRM合同、境外接收方安全能力、用户授权、导出日志列为证据缺口。\n9. 写Word周会口径，突出销售可以先承诺的边界和不能当场拍板的原因。\n10. 做Excel字段补件表，给每个字段安排材料来源、责任人和复核状态。\n11. 检查表格中没有把供应商宣传页写成正式合同或安全能力证明。",
  },
  {
    question:
      "业委会群里已经吵了两晚：电梯广告一年18万元到底进了哪里，物业说抵了保洁和维保，业主代表要求看合同、入账流水和分摊明细。偏偏三台电梯大修报价也同时出来，物业想先动住宅专项维修资金，社区下周要把双方叫到一起。附件能回答共有收益、业主共同决定和维修资金流程，但广告合同、银行流水、表决票、工程报价原件都还没交。需要一份Word协调会问答口径和Excel证据/流程核对表，帮现场把能解释的、需补件的、要表决的分开。",
    summary:
      "为小区公共收益和维修资金争议准备协调会口径，拆分收益公开、资金动用程序和证据缺口。",
    attachmentContent:
      "这四份制度资料可以回答程序边界，不能替代小区自己的合同、流水、票据。\n- 《民法典物权编业主共有与维修资金条款》。来源：https://www.spp.gov.cn/spp/ssmfdyflvdtpgz/202008/t20200831_478410.shtml。用于核对共有部分收益归属、业主共同决定事项、维修资金筹集和使用规则。\n- 《物业管理条例》。来源：https://xzfg.moj.gov.cn/law/download?LawID=960&type=pdf。用于确认物业服务企业职责、业主大会制度、物业服务监督和共有收益管理框架。\n- 《住宅专项维修资金管理办法》。来源：https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/200804/t20080402_144499.html。用于整理维修资金交存、使用、分摊、应急使用、审核和监督口径。\n- 《业主大会和业主委员会指导规则》。来源：https://www.mohurd.gov.cn/file/2023/20230508/3c521deb-89bd-4559-8c7c-4d099fb7e731.pdf。用于核对会议组织、表决程序、业委会职责和信息公开。\n未随附件提供的材料：广告合同、收益入账流水、业主表决票、工程报价、主管部门备案记录。Word和Excel只把这些作为补件项处理。",
    productContent:
      "给社区协调会的Word（docx）采用问答式：业主能要求公开什么、广告收益与物业费抵扣如何分开、维修资金动用需走哪类程序、哪些话现场还不能下结论。Excel（xlsx）做证据和流程核对表，列争议事项、现有材料、缺口、对应附件依据、共同决定要求、是否可能走应急流程、补件主体和会后跟进时间。验收时广告收益、物业服务费用和维修资金三条线不能混在一起。",
    steps:
      "1. 还原三条线：电梯广告收入、物业服务费抵扣、住宅专项维修资金。\n2. 从民法典条款确认共有部分收益归属和业主共同决定事项。\n3. 从物业管理条例查物业服务企业、业主大会和业委会的职责边界。\n4. 从维修资金办法整理普通使用、应急使用、审核、分摊和监督环节。\n5. 从业主大会指导规则补齐会议召集、表决、公开和记录要求。\n6. 将广告合同、流水、表决票、报价、备案记录列入证据核对表。\n7. 判断哪些问题协调会可直接解释，哪些需物业补件后再答复。\n8. 标出可能需要业主大会表决或主管部门确认的节点。\n9. 写Word问答口径，避免把未见合同和流水的事项说成事实。\n10. 做Excel流程表，把每个争议事项对应到附件依据、责任主体和下一步。\n11. 复查是否把三类资金混用；若混用，回到资金线重新拆分。",
  },
  {
    question:
      "招聘小程序的“AI初筛”计划在2026年7月灰度，现在产品已经把A档优先展示、B档抽看、C档沉底的后台样式画好了。麻烦在上线评审前把候选人会看到什么、HR后台能做什么、哪些自动判断还要人工复核说清楚。附件能支撑招聘服务、个人信息、算法推荐和生成式AI的规则判断；算法参数、训练数据来源、候选人授权记录、人工复核日志目前没有附件，只能列成上线前补件。交付一份Word复核意见和一张Excel规则/告知核对表，给产品、HR和法务一起过会。",
    summary:
      "围绕2026年7月招聘AI初筛灰度，梳理候选人告知、个人信息处理、算法提示和人工复核补件。",
    attachmentContent:
      "附件提供上线前规则依据；企业内部算法材料仍需产品和HR补交。\n- 《网络招聘服务管理规定》。来源：https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202103/t20210309_374224.html。用于核对招聘服务主体责任、招聘信息真实性、求职者信息保护和网络招聘服务规则。\n- 《中华人民共和国个人信息保护法》。来源：https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm。用于确认简历字段处理、告知同意、最小必要、自动化决策和敏感信息保护。\n- 《互联网信息服务算法推荐管理规定》。来源：https://www.cac.gov.cn/2022-01/04/c_1642894606364259.htm。用于整理算法透明度、用户选择权、模型提示和不合理差别待遇风险。\n- 《生成式人工智能服务管理暂行办法》。来源：https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm。用于核对训练数据处理、个人信息保护、安全评估和内容治理口径。\n缺口：算法参数、训练数据来源、候选人授权记录、岗位真实性证明、人工复核日志不在附件中，复核意见只给上线条件和补件清单。",
    productContent:
      "上线评审用的Word（docx）围绕投递页、隐私政策、结果通知、HR后台四个触点说明可上线文案、需补告知、需人工复核和暂缓点。Excel（xlsx）做规则/告知核对表，列流程节点、涉及数据、自动化判断、候选人可见提示、人工复核动作、留痕材料、风险等级和负责人。验收时能看出AI初筛只是辅助排序，算法参数和训练数据未取得时不会被写成已核验。",
    steps:
      "1. 画出候选人投递、简历解析、AI分档、HR查看、通知候选人的流程。\n2. 在每个节点标出会处理的简历字段、手机号、学历、行业和薪资期望。\n3. 用网络招聘规定核对招聘信息真实性、求职者信息保护和服务主体责任。\n4. 用个人信息保护法检查告知同意、最小必要、自动化决策说明和敏感信息。\n5. 用算法推荐规定判断透明度、选择权、差别待遇和算法提示要求。\n6. 用生成式AI办法补充训练数据、个人信息、安全评估和内容治理口径。\n7. 将页面文案分成可上线、补告知、补授权、保留人工复核、暂缓五类。\n8. 对A档/B档/C档展示规则写出人工复核和留痕动作。\n9. 写Word评审意见，给产品、HR、法务分别列出会前确认点。\n10. 做Excel核对表，把每个节点对应到法规依据、文案位置、负责人和证据状态。\n11. 复查输出中是否暗示算法参数或训练数据已取得；没有材料的统一回到补件栏。",
  },
  {
    question:
      "本地生活平台想把“城市周末民宿”专题排进下周首页，但招商给来的30套房源还只是散资料：证照照片、房屋图、消防承诺书、价格表各有一些，完整房源明细表还在补。运营关心专题能不能先搭页面，风控更关心旅馆业备案、住宿登记接入、消防现场情况和平台展示信息。附件能支撑规则和模板设计，不能替30套房源做逐套结论。先交一份Word上架前复核规则和Excel房源补件模板，把后续房源分成可暂存、补证后上架、现场核验、暂缓上线四种路径；证照真实性、现场设施、公安报备、权属和履约记录都放在待确认边界。",
    summary:
      "为民宿专题先搭建上架复核规则和房源补件模板，避免在明细缺失时替30套房源下结论。",
    attachmentContent:
      "这组附件只支撑规则和补件模板，不支撑30套房源逐套放行。\n- 《旅馆业治安管理办法》。来源：https://xzfg.moj.gov.cn/law/download?LawID=694&type=pdf。用于确认住宿经营场所开办、安全防范、旅客住宿登记、可疑情况报告等治安管理口径。模板中对应治安备案、住宿登记接入、公安报备材料、待核验人。\n- 《中华人民共和国消防法》。来源：https://www.mem.gov.cn/fw/flfgbz/fg/fl_6143/。该来源页面由应急管理部维护并列示《中华人民共和国消防法》。用于核对消防安全责任、消防设施维护、疏散通道和安全出口、公众聚集场所投入使用前管理；消防承诺书只作为待核验资料。\n- 《网络交易监督管理办法》。来源：https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202104/t20210423_357848.html。用于核对平台内经营者身份核验、服务信息真实准确、交易信息保存和平台治理义务。\n- 《中华人民共和国电子商务法》。来源：https://www.cac.gov.cn/2018-09/01/c_1123362506.htm。用于确认平台经营者身份核验、信息公示、消费者权益、交易安全和记录保存。\n缺口：房东证照真实性、现场消防设施、公安报备、权属、住宿登记系统接入、订单履约记录都没有成套附件，Excel模板只设置字段和分流规则。",
    productContent:
      "交付给运营评审会的Word（docx）说明专题可先做哪些资料暂存、哪些房源信息不能展示、治安/消防/交易信息各自的补件边界和风险提示。Excel（xlsx）是一张房源补件模板，不预填结论；字段包括房源编号、现有资料、缺失资料、治安备案、住宿登记接入、消防核验、平台展示、分流建议、责任人、待确认备注。验收时能让业务拿模板继续收30套明细，而不是让模型凭法规附件替房源放行。",
    steps:
      "1. 先把专题上线需求和30套房源明细缺口分开，规则先行、逐套结论后置。\n2. 用旅馆业治安管理办法设定备案、住宿登记、治安报告和经营安全字段。\n3. 用消防法设置消防承诺、现场照片、检查材料、整改责任和现场核验字段。\n4. 用网络交易监督管理办法补上经营者信息、服务展示、交易记录和平台治理字段。\n5. 用电子商务法补充身份核验、信息公示、消费者权益、交易安全和记录保存口径。\n6. 设计四种分流标签：可暂存、补证后上架、现场核验、暂缓上线。\n7. 将证照真实性、权属、公安报备、现场消防、住宿登记接入、履约记录列入待确认。\n8. 写Word复核规则，让运营知道专题页哪些信息可先准备、哪些要等补证。\n9. 做Excel补件模板，字段留给后续逐房源填报，不预设30套房源结论。\n10. 在模板备注中写清每类分流触发条件和责任人。\n11. 回看产物是否把承诺书、照片、证照扫描件当成现场核验结果；发现就改回待核验。",
  },
];

function setUpdate(row, index, value) {
  if (!row.updates[index]) throw new Error(`Missing update index ${index}`);
  row.updates[index].value = value;
}

const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
if (plan.rows.length !== rewrites.length) {
  throw new Error(`Expected ${rewrites.length} rows, got ${plan.rows.length}`);
}

for (const [index, rewrite] of rewrites.entries()) {
  const row = plan.rows[index];
  setUpdate(row, COLUMNS.question, rewrite.question);
  setUpdate(row, COLUMNS.summary, rewrite.summary);
  setUpdate(row, COLUMNS.attachmentContent, rewrite.attachmentContent);
  setUpdate(row, COLUMNS.productContent, rewrite.productContent);
  setUpdate(row, COLUMNS.steps, rewrite.steps);
}

await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

const valueRanges = [];
for (const [index, rowNo] of rowNumbers.entries()) {
  const rewrite = rewrites[index];
  valueRanges.push(
    { range: `${sheetId}!B${rowNo}:B${rowNo}`, values: [[rewrite.question]] },
    { range: `${sheetId}!G${rowNo}:G${rowNo}`, values: [[rewrite.summary]] },
    { range: `${sheetId}!L${rowNo}:L${rowNo}`, values: [[rewrite.attachmentContent]] },
    { range: `${sheetId}!N${rowNo}:N${rowNo}`, values: [[rewrite.productContent]] },
    { range: `${sheetId}!O${rowNo}:O${rowNo}`, values: [[rewrite.steps]] },
  );
}

await fs.writeFile(valueRangesPath, `${JSON.stringify({ spreadsheetToken, valueRanges }, null, 2)}\n`, "utf8");

let feishuResult = null;
if (!process.argv.includes("--skip-feishu")) {
  const clientModule = await import(pathToFileURL(path.join(root, "build/automation/feishu_openapi_client.mjs")));
  const client = await clientModule.createFeishuClient({ transport: "lark-cli" });
  feishuResult = await client.batchUpdateValues({ spreadsheetToken, valueRanges });
}

const report = {
  rewrittenAt: new Date().toISOString(),
  rows: rowNumbers,
  updatedColumns: ["B", "G", "L", "N", "O"],
  preservedColumns: ["A", "C", "D", "E", "F", "H", "I", "J", "K", "M", "P"],
  valueRanges: valueRanges.length,
  feishuResult,
};
await fs.writeFile(logPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
