import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildFeishuFillPlan } from "../../../../build/manual_review/feishu_fill_plan_lib.mjs";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../../..");
const runId = "l2_20260709T172539Z_b3f5d2";
const runRoot = path.join(root, "outputs", "auto_runs", runId);
const attachmentRoot = path.join(runRoot, "attachments");
const sourceRoot = path.join(runRoot, "sources");
const tsvPath = path.join(runRoot, "drafts", "l2_questions_172_174_shenli_710.tsv");
const planPath = path.join(runRoot, "feishu", "feishu_fill_plan_172_174.json");
const manifestPath = path.join(runRoot, "attachment_manifest.json");
const sourceCardsPath = path.join(sourceRoot, "source_cards_167_169.json");

const startRow = 172;

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
    uid: "沈礼_7.10_01",
    question:
      "会员运营刚把2026年7月新品会员日的规则截图发来，说今晚就想进小程序测试：9.9元券包、积分抽奖、生日月加赠和“连喝7天抽免单”都放在同一个弹窗里，后台还准备用手机号、生日月份、近30天下单次数和门店城市做分层推送。麻烦先替法务过一遍，哪些文案和规则可以保留，哪些需要补中奖概率、奖品数量、退券路径或会员授权；真实活动预算、中奖名单、弹窗截图、券核销日志和用户授权记录现在都没给，统一放进补件栏。Word写成今晚评审能看的审改意见，Excel做规则/数据字段台账，别替运营拍上线结论。",
    taskType: "L2 流程型",
    primary: "品牌市场与电商零售",
    secondary: "会员营销与促销合规",
    tertiary: "茶饮小程序积分抽奖与优惠券规则复核",
    summary:
      "复核茶饮会员日小程序抽奖、券包和分层推送规则，拆清促销公示、广告表达、个人信息和补件项。",
    experience: "5年",
    time: "12h",
    productFormat: "docx, xlsx",
    productContent:
      "给会员运营和法务看的可编辑Word文档（docx）要按弹窗文案、积分抽奖、券包售后、生日月权益、分层推送五块写审改意见，标出可保留表述、需改文案、需补公示和暂缓上线项。Excel表格（xlsx）做成活动规则/数据字段台账，列活动点位、原规则、涉及字段、附件依据、风险原因、建议动作、需补材料、责任人和复核状态。验收时要能看出公开法规只能支撑规则边界，不能证明中奖名单、预算、授权记录或核销数据已经存在。",
    steps: [
      "1. 把会员日活动拆成9.9元券包、积分抽奖、生日月加赠、连喝7天抽免单和分层推送五个模块。",
      "2. 核对每份附件的发布主体、施行时间和适用范围，标出促销、广告、网络交易和个人信息的不同依据。",
      "3. 用规范促销行为暂行规定检查有奖销售、奖品数量、中奖概率、附加条件、公示义务和虚假促销风险。",
      "4. 用消费者权益保护法实施条例核对格式条款、退券路径、会员权益变更、自动勾选和消费者知情权。",
      "5. 用互联网广告管理办法判断弹窗、首页banner和购买引导是否需要广告标识或更清楚的限制条件。",
      "6. 用网络交易监督管理办法整理小程序销售、交易信息公示、评价和售后规则。",
      "7. 用个人信息保护法核对手机号、生日月份、下单次数、门店城市用于分层推送的告知同意和最小必要。",
      "8. 将每条规则分成可保留、改文案后可用、补材料后复核、暂缓上线四类。",
      "9. 把活动预算、中奖名单、券核销日志、弹窗截图和会员授权记录列入补件台账。",
      "10. 写Word审改意见，给今晚评审会直接讨论的上线边界和追问清单。",
      "11. 做Excel规则/字段台账，逐行保留原文案、依据、处理动作、责任人和复核状态。",
    ],
    attachments: [
      {
        fileName: "附件一_茶饮促销行为暂行规定.html",
        title: "规范促销行为暂行规定",
        url: "https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202101/t20210104_146553.html",
        format: "html",
        purpose:
          "用于核对有奖销售、积分抽奖、奖品数量、中奖概率、附加条件、公示义务和虚假促销边界。",
        excerpt:
          "经营者通过有奖销售、价格、免费试用等方式开展促销，应当遵守公平、诚实信用和信息公示要求。",
      },
      {
        fileName: "附件二_茶饮消费者权益保护法实施条例.html",
        title: "中华人民共和国消费者权益保护法实施条例",
        url: "https://www.mee.gov.cn/zcwj/gwywj/202403/t20240320_1068830.shtml",
        format: "html",
        purpose:
          "用于核对格式条款、会员权益、退券退费、知情权和经营者网络消费责任。",
        excerpt:
          "条例自2024年7月1日起施行，细化经营者义务、网络消费、预付式消费和格式条款等要求。",
      },
      {
        fileName: "附件三_茶饮互联网广告管理办法.html",
        title: "互联网广告管理办法",
        url: "https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202306/t20230620_481045.html",
        format: "html",
        purpose:
          "用于判断小程序弹窗、首页banner、购买链接和活动话术是否属于互联网广告及是否需显著标识。",
        excerpt:
          "互联网广告应当具有可识别性，使消费者能够辨明其为广告。",
      },
      {
        fileName: "附件四_茶饮网络交易监督管理办法.html",
        title: "网络交易监督管理办法",
        url: "https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202104/t20210423_357848.html",
        format: "html",
        purpose:
          "用于整理小程序交易、经营者信息公示、交易规则、售后和消费者评价相关要求。",
        excerpt:
          "办法适用于通过互联网等信息网络销售商品或者提供服务的经营活动及监督管理。",
      },
      {
        fileName: "附件五_茶饮会员个人信息保护法.html",
        title: "中华人民共和国个人信息保护法",
        url: "https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm",
        format: "html",
        purpose:
          "用于核对手机号、生日月份、消费频次、城市门店等会员字段的告知同意、最小必要和自动化推送边界。",
        excerpt:
          "处理个人信息应当有明确、合理的目的，并限于实现处理目的的最小范围。",
      },
    ],
    boundary:
      "以上附件只能支持会员抽奖、券包售后、活动弹窗和分层推送的规则初筛；不能证明真实预算、中奖名单、券核销日志、弹窗截图、用户授权记录已经齐备。",
  },
  {
    uid: "沈礼_7.10_02",
    question:
      "园长今天早会说，9月新学期前想在两个班试用儿童智能手表：进出园自动打卡、离园围栏提醒、SOS一键录音、家长端查看位置，顺手还想把迟到次数同步给班主任。家委会肯定会问孩子定位和录音到底谁能看、保存多久、不同意戴表怎么办。现在供应商只给了功能白皮书和演示账号，监护人授权文本、数据字段表、录音留存配置、后台权限、设备安全测评都没有。请先按公开法规帮园方做一版Word试点隐私复核意见，Excel列功能/数据/授权核对表；没有证据的地方写待供应商和家长确认，别写成已经可以全园铺开。",
    taskType: "L2 流程型",
    primary: "科技软件与 AI 工作流",
    secondary: "智能硬件与数据合规",
    tertiary: "儿童智能终端定位与监护人授权复核",
    summary:
      "为幼儿园儿童智能手表试点复核定位、录音、打卡和家长端数据处理边界，整理授权和补件清单。",
    experience: "6年",
    time: "13h",
    productFormat: "docx, xlsx",
    productContent:
      "Word文档（docx）面向园长、家委会和供应商沟通，写清试点范围、儿童个人信息处理规则、监护人授权、录音和定位可见范围、不同意参与的替代安排、上线前阻断项。配套Excel表格（xlsx）按功能列数据项、儿童个人信息属性、处理目的、当前证据、授权方式、保存期限、访问角色、供应商补件和试点建议。验收时不得把供应商白皮书当作监护人授权、后台权限证明或安全测评结果。",
    steps: [
      "1. 将试点功能拆成进出园打卡、离园围栏、SOS录音、家长端定位、迟到统计和班主任查看。",
      "2. 核验未成年人网络保护、儿童个人信息、个人信息保护、网络数据安全和App收集行为认定五类附件。",
      "3. 用儿童个人信息网络保护规定确认不满十四周岁儿童信息处理、专门规则、监护人同意和安全保障要求。",
      "4. 用未成年人网络保护条例核对智能终端、未成年人个人信息、监护人履职和最有利于未成年人原则。",
      "5. 用个人信息保护法判断定位、录音、出入园记录、迟到统计的处理目的、必要性、敏感信息和单独同意。",
      "6. 用网络数据安全管理条例整理数据处理安全、个人信息保护、委托处理和风险评估留痕。",
      "7. 用App违法违规收集使用个人信息认定方法检查权限弹窗、默认同意、超范围收集和撤回同意路径。",
      "8. 将功能分为可小范围试点、补授权后试点、需改配置、暂缓四类。",
      "9. 把监护人授权文本、字段表、录音留存、后台权限和安全测评列成供应商补件。",
      "10. 写Word复核意见，准备给家委会解释的口径和园方不能承诺的边界。",
      "11. 做Excel核对表，逐项对应功能、数据、依据、缺口、责任人和上线建议。",
    ],
    attachments: [
      {
        fileName: "附件一_儿童手表儿童个人信息网络保护规定.html",
        title: "儿童个人信息网络保护规定",
        url: "https://www.cac.gov.cn/2019-08/23/c_1124913903.htm",
        format: "html",
        purpose:
          "用于核对不满十四周岁儿童个人信息处理、专门规则、监护人同意、内部权限和安全保障要求。",
        excerpt:
          "规定所称儿童是指不满十四周岁的未成年人，在境内通过网络收集、存储、使用、转移、披露儿童个人信息适用本规定。",
      },
      {
        fileName: "附件二_儿童手表未成年人网络保护条例.html",
        title: "未成年人网络保护条例",
        url: "https://www.cac.gov.cn/2023-10/24/c_1699806932316206.htm",
        format: "html",
        purpose:
          "用于确认未成年人网络保护、智能终端产品、个人信息权益和监护人履职相关要求。",
        excerpt:
          "条例自2024年1月1日起施行，坚持最有利于未成年人的原则，要求营造有利于未成年人身心健康的网络环境。",
      },
      {
        fileName: "附件三_儿童手表个人信息保护法.html",
        title: "中华人民共和国个人信息保护法",
        url: "https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm",
        format: "html",
        purpose:
          "用于判断定位、录音、出入园记录和家长联系方式的合法性基础、敏感个人信息、单独同意和撤回权利。",
        excerpt:
          "处理敏感个人信息应当有特定目的和充分必要性，并采取严格保护措施。",
      },
      {
        fileName: "附件四_儿童手表网络数据安全管理条例.html",
        title: "网络数据安全管理条例",
        url: "https://www.cac.gov.cn/2024-09/30/c_1729384452307680.htm",
        format: "html",
        purpose:
          "用于整理网络数据处理安全、个人信息保护、委托处理、日志留存和风险评估留痕。",
        excerpt:
          "条例自2025年1月1日起施行，规范网络数据处理活动，保障网络数据安全，保护个人、组织合法权益。",
      },
      {
        fileName: "附件五_儿童手表App违法违规收集个人信息认定方法.html",
        title: "App违法违规收集使用个人信息行为认定方法",
        url: "https://www.cac.gov.cn/2019-12/27/c_1578986455686625.htm",
        format: "html",
        purpose:
          "用于检查演示App权限申请、默认勾选、超范围收集、撤回同意和投诉举报路径。",
        excerpt:
          "方法列举未公开规则、未明示目的方式范围、未经同意收集、超范围收集和未提供删除更正功能等认定情形。",
      },
    ],
    boundary:
      "以上资料只能支撑儿童智能手表试点的公开规则复核；不能证明供应商后台权限、监护人授权、录音保存配置、设备安全测评或园方实际管理流程已经完成。",
  },
  {
    uid: "沈礼_7.10_03",
    question:
      "票务产品经理把2026年8月体育场演唱会的新版购票规则丢给我，想周一前给主办方确认：每个身份证限购一张、实名入场、开票后48小时内免费退、临演前按梯次收手续费，电子票不支持转赠。客服担心用户会骂“不能转赠”和“退票费太高”，风控又想把异常账号、同手机号多设备、频繁退票的人先拦下来。现在只有规则草案和几张流程图，演出批准文件、公安安全许可、主办方票务协议、退票成本测算、异常账号规则和隐私告知都没给。帮我做Word规则改版复核意见，Excel列票务规则/证据缺口表，能上线公示的和必须让主办方、文旅或公安确认的分开。",
    taskType: "L2 流程型",
    primary: "互联网与平台业务",
    secondary: "票务平台规则与消费者保护",
    tertiary: "大型营业性演出票务实名退票与规则公示复核",
    summary:
      "复核演唱会票务平台实名购票、退票梯次、转赠限制和异常账号拦截规则，形成上线前补件清单。",
    experience: "6年",
    time: "14h",
    productFormat: "docx, xlsx",
    productContent:
      "可编辑Word文档（docx）给票务产品、客服、风控和主办方沟通，内容包括实名购票和入场规则、退票机制、转赠限制、异常账号拦截、用户告知、需主管部门或主办方确认事项。Excel表格（xlsx）作为规则/证据缺口表，列规则条款、用户影响、附件依据、当前材料、需确认主体、客服话术、上线状态和复核时间。验收时不能把流程图写成演出批准、安全许可、主办方授权或退票成本已核验。",
    steps: [
      "1. 将规则草案拆成实名购票、实名入场、限购、退票梯次、电子票转赠、异常账号拦截和隐私告知。",
      "2. 核验文旅公安通知、营业性演出条例、实施细则、大型群众活动安全、平台规则、个人信息和消保附件。",
      "3. 用大型营业性演出规范管理通知确认实名购票实名入场、退票机制、公开销售比例和票务信息管理口径。",
      "4. 用营业性演出管理条例和实施细则核对演出举办、审批、经营主体和票务相关责任。",
      "5. 用大型群众性活动安全管理条例整理体育场大型活动安全许可、承办者责任和现场安全边界。",
      "6. 用网络交易平台规则监督管理办法检查平台规则公示、修改、申诉、消费者权益和规则限制边界。",
      "7. 用个人信息保护法判断身份证号、手机号、设备信息、异常账号标签的处理目的、必要性和告知同意。",
      "8. 用消费者权益保护法实施条例核对退票费用、格式条款、限制转赠和消费者知情权。",
      "9. 将规则分为可公示、改文案后公示、主办方确认、文旅公安确认、暂缓上线五类。",
      "10. 把批准文件、安全许可、主办方协议、退票成本、异常账号规则和隐私告知列为补件。",
      "11. 写Word复核意见并制作Excel缺口表，最后检查是否把没有附件的审批、成本和授权写成已确认事实。",
    ],
    attachments: [
      {
        fileName: "附件一_票务大型营业性演出规范管理通知.html",
        title: "文化和旅游部公安部关于进一步加强大型营业性演出活动规范管理促进演出市场健康有序发展的通知",
        url: "https://zwgk.mct.gov.cn/zfxxgkml/scgl/202309/t20230912_947197.html",
        format: "html",
        purpose:
          "用于核对大型演出风险评估、实名购票实名入场、梯次退票、公开销售比例和票务信息管理要求。",
        excerpt:
          "通知要求大型演出活动实行实名购票和实名入场制度，并建立大型演出活动退票机制。",
      },
      {
        fileName: "附件二_票务营业性演出管理条例.pdf",
        title: "营业性演出管理条例",
        url: "https://xzfg.moj.gov.cn/law/download?LawID=1032&type=pdf",
        format: "pdf",
        purpose:
          "用于确认营业性演出的审批、举办、经营主体、监督管理和法律责任边界。",
        excerpt:
          "条例规定营业性演出是以营利为目的为公众举办的现场文艺表演活动，并由文化主管部门监督管理。",
      },
      {
        fileName: "附件三_票务营业性演出管理条例实施细则.pdf",
        title: "营业性演出管理条例实施细则",
        url: "https://zwgk.mct.gov.cn/zfxxgkml/zcfg/bmgz/202012/P020220218664646505947.pdf",
        format: "pdf",
        purpose:
          "用于补充演出经营主体、演出组织、营销、演出经纪和活动管理的操作口径。",
        excerpt:
          "实施细则根据营业性演出管理条例制定，细化营业性演出的经营主体和活动管理要求。",
      },
      {
        fileName: "附件四_票务大型群众性活动安全管理条例.html",
        title: "大型群众性活动安全管理条例",
        url: "https://www.moj.gov.cn/pub/sfbgw/zcjd/200709/t20070922_389861.html",
        format: "html",
        purpose:
          "用于整理体育场演唱会的安全许可、承办者安全责任、现场管理和公安机关确认边界。",
        excerpt:
          "条例适用于预计参加人数达到一定规模的演唱会、音乐会等大型群众性活动，强调承办者负责和政府监管。",
      },
      {
        fileName: "附件五_票务网络交易平台规则监督管理办法.html",
        title: "网络交易平台规则监督管理办法",
        url: "https://www.cac.gov.cn/2026-01/07/c_1769515215345420.htm",
        format: "html",
        purpose:
          "用于核对票务平台规则制定、修改、公示、申诉渠道、消费者权益和平台规则限制。",
        excerpt:
          "办法自2026年2月1日起施行，规范网络交易平台规则的制定、修改和执行活动。",
      },
      {
        fileName: "附件六_票务个人信息保护法.html",
        title: "中华人民共和国个人信息保护法",
        url: "https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm",
        format: "html",
        purpose:
          "用于判断实名购票身份证号、手机号、设备信息、异常账号标签和风控拦截的处理边界。",
        excerpt:
          "处理个人信息应当遵循合法、正当、必要和诚信原则，不得通过误导、欺诈、胁迫等方式处理个人信息。",
      },
      {
        fileName: "附件七_票务消费者权益保护法实施条例.html",
        title: "中华人民共和国消费者权益保护法实施条例",
        url: "https://www.mee.gov.cn/zcwj/gwywj/202403/t20240320_1068830.shtml",
        format: "html",
        purpose:
          "用于核对退票费用、格式条款、用户知情权、投诉处理和网络消费中的经营者责任。",
        excerpt:
          "条例自2024年7月1日起施行，进一步细化经营者义务、网络消费和格式条款相关要求。",
      },
    ],
    boundary:
      "以上资料只能支持大型演出实名购票、退票机制、平台规则和个人信息处理的规则复核；不能证明演出批准文件、安全许可、主办方协议、退票成本测算或异常账号模型已经核验。",
  },
];

function escapeTsvCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, " ");
}

function relatedAttachments(row) {
  return row.attachments.map((item) => item.fileName).join("；");
}

function attachmentFormat(row) {
  return [...new Set(row.attachments.map((item) => item.format))].join(", ");
}

function attachmentContent(row) {
  const items = row.attachments.map((item, index) => {
    const label = ["一", "二", "三", "四", "五", "六", "七", "八"][index];
    return `- 附件${label}：《${item.title}》。来源：${item.url}。用途：${item.purpose} 正文口径：${item.excerpt}`;
  });
  return `${row.attachmentIntro ?? "附件用途和边界如下："}\n${items.join("\n")}\n缺口边界：${row.boundary}`;
}

function rowToTsv(row) {
  return [
    row.uid,
    row.question,
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
    row.steps.join("\n"),
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
      if (attempt < 4) await sleep(attempt * 1000);
    }
  }

  const tempName = `download_${crypto.createHash("sha1").update(url).digest("hex").slice(0, 12)}`;
  const tempPath = path.join(runRoot, "tmp", tempName);
  await fs.mkdir(path.dirname(tempPath), { recursive: true });
  try {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "& { param($u,$o); $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $u -Headers @{ 'User-Agent'='Mozilla/5.0' } -OutFile $o }",
        url,
        tempPath,
      ],
      { timeout: 90_000, maxBuffer: 1024 * 1024 }
    );
    const buffer = await fs.readFile(tempPath);
    await fs.rm(tempPath, { force: true });
    return buffer;
  } catch (fallbackError) {
    await fs.rm(tempPath, { force: true });
    throw new Error(
      `download failed for ${url}: fetch=${lastError?.message ?? lastError}; powershell=${fallbackError?.message ?? fallbackError}`
    );
  }
}

function validateBuffer(buffer, filePath, expectedFormat) {
  const detected = detectFormat(buffer, filePath);
  const enough = buffer.length > 1200;
  const validation =
    enough &&
    (detected === expectedFormat ||
      (expectedFormat === "html" && ["html", "unknown"].includes(detected)) ||
      (expectedFormat === "pdf" && detected === "pdf"))
      ? "PASS"
      : `WARN: expected ${expectedFormat}, detected ${detected}, bytes ${buffer.length}`;
  return { detected, validation };
}

async function downloadAttachment(topicDir, attachment) {
  const filePath = path.join(topicDir, attachment.fileName);
  const buffer = await fetchAttachmentBuffer(attachment.url);
  await fs.writeFile(filePath, buffer);
  const stat = await fs.stat(filePath);
  const { detected, validation } = validateBuffer(buffer, filePath, attachment.format);
  return {
    fileName: attachment.fileName,
    title: attachment.title,
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
  await fs.mkdir(attachmentRoot, { recursive: true });
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(path.dirname(tsvPath), { recursive: true });
  await fs.mkdir(path.dirname(planPath), { recursive: true });

  const attachmentManifest = [];
  const sourceCards = [];
  for (const row of rows) {
    const topicDir = path.join(attachmentRoot, row.uid);
    await fs.mkdir(topicDir, { recursive: true });
    for (const attachment of row.attachments) {
      const item = await downloadAttachment(topicDir, attachment);
      attachmentManifest.push({ uid: row.uid, topic: row.tertiary, ...item });
      sourceCards.push({
        uid: row.uid,
        title: attachment.title,
        url: attachment.url,
        format: attachment.format,
        purpose: attachment.purpose,
        excerpt: attachment.excerpt,
        boundary: row.boundary,
        localFile: item.path,
        validation: item.validation,
      });
    }
  }

  const tsv = [headers.join("\t"), ...rows.map((row) => rowToTsv(row).join("\t"))].join("\n");
  await fs.writeFile(tsvPath, `${tsv}\n`, "utf8");

  const plan = buildFeishuFillPlan({
    text: `${tsv}\n`,
    sourcePath: tsvPath,
    startRow,
    count: rows.length,
    columnMap,
  });
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({ runId, startRow, rows: rows.length, attachmentManifest }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(sourceCardsPath, `${JSON.stringify(sourceCards, null, 2)}\n`, "utf8");

  const warnings = attachmentManifest.filter((item) => item.validation !== "PASS");
  console.log(
    JSON.stringify(
      {
        runId,
        startRow,
        endRow: startRow + rows.length - 1,
        tsvPath,
        planPath,
        manifestPath,
        sourceCardsPath,
        attachments: attachmentManifest.length,
        warnings,
      },
      null,
      2
    )
  );
}

await main();
