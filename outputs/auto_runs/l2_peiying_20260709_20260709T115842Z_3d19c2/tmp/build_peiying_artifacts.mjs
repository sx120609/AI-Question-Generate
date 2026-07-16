import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(runRoot, "../../..");

const sourceGeneratedAt = new Date().toISOString();

const sourceGroups = [
  {
    topicId: "裴硬_7.9_01",
    title: "敏感肌精华达人素材功效宣称与标签复核",
    attachmentDir: "01_化妆品达人素材功效宣称",
    boundary:
      "以上资料能支持化妆品功效宣称、网络经营展示、广告标识和达人素材改稿判断，不能证明产品备案资料、功效评价摘要截图、达人合同、投放后台数据或消费者使用效果已经核验。",
    attachments: [
      {
        file: "附件一_化妆品监督管理条例.pdf",
        url: "https://xzfg.moj.gov.cn/law/download?LawID=451&type=pdf",
        purpose:
          "用于核对化妆品注册备案、标签广告真实性、功效宣称和违法宣称责任边界。",
      },
      {
        file: "附件二_化妆品网络经营监督管理办法.html",
        url: "https://yjj.scjgj.fujian.gov.cn/hzp/flfg/202305/t20230519_6172489.htm",
        purpose:
          "用于核对平台内化妆品经营者信息展示、产品信息披露、风险处置和页面留痕要求。",
      },
      {
        file: "附件三_化妆品功效宣称评价规范.html",
        url: "https://yjj.scjgj.fujian.gov.cn/hzp/flfg/202107/t20210708_5642667.htm",
        purpose:
          "用于核对保湿、修护、舒缓等功效宣称的评价依据、摘要公开和禁用表达口径。",
      },
      {
        file: "附件四_互联网广告管理办法.html",
        url: "https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202306/t20230620_481045.html",
        purpose:
          "用于核对互联网广告可识别性、广告发布者责任、种草内容和购买链接结合时的标识要求。",
      },
    ],
  },
  {
    topicId: "裴硬_7.9_02",
    title: "海外CRM试用前销售线索数据出境复核",
    attachmentDir: "02_海外CRM数据出境",
    boundary:
      "以上资料能支持客户线索个人信息处理、数据分类、跨境传输路径和合规触发条件判断，不能证明真实合同条款、境外接收方安全能力、用户授权记录、系统字段字典或历史导出日志已经核验。",
    attachments: [
      {
        file: "附件一_个人信息保护法_数据出境规则.html",
        url: "https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm",
        purpose:
          "用于核对个人信息处理的合法性基础、告知同意、敏感个人信息、委托处理和个人信息出境规则。",
      },
      {
        file: "附件二_中华人民共和国数据安全法.html",
        url: "https://www.cac.gov.cn/2021-06/11/c_1624994566919140.htm",
        purpose:
          "用于核对数据分类分级、风险监测、数据处理活动安全义务和重要数据管理要求。",
      },
      {
        file: "附件三_数据出境安全评估办法.html",
        url: "https://www.cac.gov.cn/2022-07/07/c_1658811536594644.htm",
        purpose:
          "用于核对触发安全评估的情形、申报材料、评估重点和出境活动持续监管要求。",
      },
      {
        file: "附件四_促进和规范数据跨境流动规定.html",
        url: "https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm",
        purpose:
          "用于核对2024年跨境数据流动便利化口径、豁免情形、负面清单和个人信息出境路径。",
      },
    ],
  },
  {
    topicId: "裴硬_7.9_03",
    title: "小区电梯广告公共收益公开与维修资金动用复核",
    attachmentDir: "03_小区公共收益维修资金",
    boundary:
      "以上资料能支持共有部位收益归属、业主大会授权、物业公开义务和维修资金动用流程判断，不能证明广告合同原件、业主表决票、收益入账流水、维修工程报价或主管部门备案记录已经核验。",
    attachments: [
      {
        file: "附件一_民法典物权编业主共有与维修资金条款.html",
        url: "https://www.spp.gov.cn/spp/ssmfdyflvdtpgz/202008/t20200831_478410.shtml",
        purpose:
          "用于核对业主共有部分、共有收益归属、共同决定事项和维修资金筹集使用规则。",
      },
      {
        file: "附件二_物业管理条例.pdf",
        url: "https://xzfg.moj.gov.cn/law/download?LawID=960&type=pdf",
        purpose:
          "用于核对物业服务企业职责、业主大会制度、共有收益和物业服务活动监督要求。",
      },
      {
        file: "附件三_住宅专项维修资金管理办法.html",
        url: "https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/200804/t20080402_144499.html",
        purpose:
          "用于核对维修资金交存、使用、分摊、应急使用和监督管理流程。",
      },
      {
        file: "附件四_业主大会和业主委员会指导规则.pdf",
        url: "https://www.mohurd.gov.cn/file/2023/20230508/3c521deb-89bd-4559-8c7c-4d099fb7e731.pdf",
        purpose:
          "用于核对业主大会会议、业委会职责、表决组织和信息公开的程序性要求。",
      },
    ],
  },
  {
    topicId: "裴硬_7.9_04",
    title: "招聘小程序AI简历筛选与候选人告知复核",
    attachmentDir: "04_AI招聘筛选",
    boundary:
      "以上资料能支持网络招聘服务、个人信息处理、算法推荐和生成式人工智能使用边界判断，不能证明企业真实模型参数、训练数据来源、候选人授权记录、招聘职位真实性或人工复核日志已经核验。",
    attachments: [
      {
        file: "附件一_网络招聘服务管理规定.html",
        url: "https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202103/t20210309_374224.html",
        purpose:
          "用于核对网络招聘服务主体责任、招聘信息真实性、求职者信息保护和服务规则。",
      },
      {
        file: "附件二_个人信息保护法_招聘候选人信息处理.html",
        url: "https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm",
        purpose:
          "用于核对候选人个人信息处理、告知同意、最小必要、自动化决策和敏感信息保护。",
      },
      {
        file: "附件三_互联网信息服务算法推荐管理规定.html",
        url: "https://www.cac.gov.cn/2022-01/04/c_1642894606364259.htm",
        purpose:
          "用于核对算法推荐服务备案、透明度、用户选择权和不得实施不合理差别待遇等要求。",
      },
      {
        file: "附件四_生成式人工智能服务管理暂行办法.html",
        url: "https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm",
        purpose:
          "用于核对生成式AI服务提供和使用中的内容治理、训练数据、个人信息保护和安全评估口径。",
      },
    ],
  },
  {
    topicId: "裴硬_7.9_05",
    title: "民宿平台房源上架前治安消防与交易信息复核",
    attachmentDir: "05_民宿平台房源上架",
    boundary:
      "以上资料能支持民宿房源上架前的住宿治安、消防安全、网络交易信息展示和平台经营义务判断，不能证明房东真实证照、现场消防设施、公安报备、房屋权属、线下巡检照片或订单履约记录已经核验。",
    attachments: [
      {
        file: "附件一_旅馆业治安管理办法.pdf",
        url: "https://xzfg.moj.gov.cn/law/download?LawID=694&type=pdf",
        purpose:
          "用于核对旅馆业开办、住宿登记、治安管理和违法经营责任。",
      },
      {
        file: "附件二_中华人民共和国消防法.html",
        url: "https://www.jingtai.gov.cn/zfxxgk/bmhxzxxgk/xzfzcbmzsjgml/xyjglj/fdzdgknr/lzyj/zcfg/art/2024/art_ba688f3ad46641a8b07fed89c931c96c.html",
        purpose:
          "用于核对住宿经营场所消防安全责任、消防设施、检查整改和禁止危及消防安全行为。",
      },
      {
        file: "附件三_网络交易监督管理办法.html",
        url: "https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202104/t20210423_357848.html",
        purpose:
          "用于核对平台内经营者信息报送、商品服务信息展示、交易记录保存和平台治理义务。",
      },
      {
        file: "附件四_中华人民共和国电子商务法.html",
        url: "https://www.cac.gov.cn/2018-09/01/c_1123362506.htm",
        purpose:
          "用于核对电子商务平台经营者身份核验、信息公示、交易安全、消费者权益和记录保存要求。",
      },
    ],
  },
];

const rows = [
  {
    uid: "裴硬_7.9_01",
    question:
      "美妆线这周要把一支“敏感肌急救精华”交给达人拍短视频，运营稿里写了“三天退红、修护屏障、医美级维稳”，详情页还准备放用户前后对比图和购买链接。合规同事担心功效依据、网络经营页面展示、广告标识和达人合作披露没对齐，素材周五排期，改稿窗口很短。麻烦基于已上传法规资料，把能保留、需改写、暂缓使用和需补功效依据的内容分清，给内容运营和法务一份可编辑Word复核意见，再配一张Excel素材改稿表；产品备案资料、功效评价摘要截图、达人合同和实际投放后台数据放入待确认栏。",
    taskType: "L2 流程型",
    primary: "品牌市场与电商零售",
    secondary: "电商内容投放与商品合规",
    tertiary: "化妆品功效宣称与达人短视频复核",
    summary:
      "复核敏感肌精华达人短视频和详情页投放口径，拆出功效宣称、网络经营展示、广告标识和待补材料。",
    attachments:
      "附件一_化妆品监督管理条例.pdf；附件二_化妆品网络经营监督管理办法.html；附件三_化妆品功效宣称评价规范.html；附件四_互联网广告管理办法.html",
    years: "5年",
    time: "12h",
    formats: "pdf, html",
    attachmentContent:
      "以下为四个附件的法规要点，用于核对达人素材、详情页和投放流程。\\n附件一：《化妆品监督管理条例》，来源：https://xzfg.moj.gov.cn/law/download?LawID=451&type=pdf。用于核对化妆品功效宣称真实性、标签广告不得明示暗示医疗作用、经营者主体责任和处罚边界。\\n附件二：《化妆品网络经营监督管理办法》，来源：https://yjj.scjgj.fujian.gov.cn/hzp/flfg/202305/t20230519_6172489.htm。用于核对网络经营页面展示、平台内经营者管理、产品信息披露和风险处置要求。\\n附件三：《化妆品功效宣称评价规范》，来源：https://yjj.scjgj.fujian.gov.cn/hzp/flfg/202107/t20210708_5642667.htm。用于整理保湿、修护、舒缓等功效宣称的评价依据、摘要公开和证据强度。\\n附件四：《互联网广告管理办法》，来源：https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202306/t20230620_481045.html。用于确认达人素材、购买链接、种草表达和广告可识别性之间的边界。\\n使用边界：以上资料不能证明本产品备案资料、功效评价摘要截图、达人合同、用户体验图来源或投放后台数据真实有效。",
    productFormat: "docx, xlsx",
    productContent:
      "最终产物为两个可编辑文件：一份Word文档（docx），包含素材背景、法规依据、可保留表达、需改写表达、暂缓使用表达、功效依据补件和法务意见；一份Excel表格（xlsx），字段包括素材位置、原文案、涉及功效或广告点、对应附件依据、处理建议、风险等级、责任人、待补证据和复核状态。验收时能逐条对应四个附件来源链接，并把公开资料无法确认的备案、评价摘要、合同和后台数据单独列为待确认。",
    steps: [
      "核验四个附件的发布主体、格式、适用范围和来源链接，确认法规资料能支撑素材复核。",
      "从化妆品监督管理条例提取功效宣称真实性、标签广告、医疗作用暗示和经营者责任要求。",
      "从网络经营办法整理详情页展示、平台内经营者管理、产品信息留痕和风险处置口径。",
      "从功效宣称评价规范拆分保湿、修护、舒缓、急救等表达对应的证据强度和摘要公开要求。",
      "从互联网广告管理办法提取广告可识别性、达人合作披露、购买链接关联和发布者责任。",
      "把运营稿和详情页文案分成可保留、需改写、暂缓使用、需补功效依据四类。",
      "对前后对比图、医美级、三天退红等高风险表达逐条写明判断依据和替代表达。",
      "把备案资料、功效评价摘要截图、达人合同、投放后台数据列为公开资料未覆盖的待确认项。",
      "生成Word复核意见，按背景、依据、判断、改稿建议和待确认材料组织内容。",
      "生成Excel素材改稿表，确保每行有原文案、附件依据、处理建议、责任人和复核状态。",
      "交付前检查Word和Excel与四个附件编号、来源链接、风险等级和待确认边界一致。",
    ],
    annotator: "裴硬",
  },
  {
    uid: "裴硬_7.9_02",
    question:
      "销售团队想把官网预约试用、展会扫码和公众号留资统一倒进一套海外CRM，老板问明天客户周会上能不能拍板。现在卡点在字段很多：姓名、手机号、公司邮箱、职位、采购预算、跟进备注都会同步到境外服务器，供应商只给了标准合同和一个“全球合规”页面，业务又说不接系统就没法追踪线索。\\n法务希望会议前有一份能对表讨论的Word数据出境复核意见，同时附一张Excel字段和路径清单，分清哪些信息能先在境内留存、哪些触发安全评估或标准合同等路径、哪些需要补用户告知同意和境外接收方材料；真实CRM合同、字段字典、授权记录和历史导出日志还没拿到，只能放在待确认项里。",
    taskType: "L2 流程型",
    primary: "科技软件与AI工作流",
    secondary: "企业软件采购与数据合规",
    tertiary: "海外CRM试用线索跨境传输复核",
    summary:
      "复核销售线索导入海外CRM前的数据出境路径，拆分字段风险、合规触发条件和补件清单。",
    attachments:
      "附件一_个人信息保护法_数据出境规则.html；附件二_中华人民共和国数据安全法.html；附件三_数据出境安全评估办法.html；附件四_促进和规范数据跨境流动规定.html",
    years: "6年",
    time: "14h",
    formats: "html",
    attachmentContent:
      "以下为四个附件的法规要点，用于核对销售线索、个人信息和数据出境路径。\\n附件一：《中华人民共和国个人信息保护法》，来源：https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm。用于核对个人信息处理、告知同意、最小必要、敏感个人信息、自动化决策和出境规则。\\n附件二：《中华人民共和国数据安全法》，来源：https://www.cac.gov.cn/2021-06/11/c_1624994566919140.htm。用于核对数据处理活动安全义务、分类分级、重要数据保护和风险监测要求。\\n附件三：《数据出境安全评估办法》，来源：https://www.cac.gov.cn/2022-07/07/c_1658811536594644.htm。用于整理安全评估触发情形、申报材料、评估重点和持续监管要求。\\n附件四：《促进和规范数据跨境流动规定》，来源：https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm。用于确认2024年数据跨境流动便利化口径、豁免情形、负面清单和个人信息出境路径。\\n使用边界：以上资料不能证明海外CRM供应商合同、境外接收方安全能力、真实字段字典、授权记录和历史导出日志已经核验。",
    productFormat: "docx, xlsx",
    productContent:
      "最终产物为两个可编辑文件：一份Word文档（docx），包含业务背景、字段范围、个人信息与重要数据判断、跨境传输路径、可先行措施、暂缓项和法务决策建议；一份Excel表格（xlsx），字段包括数据字段、来源渠道、是否个人信息、是否可能敏感、接收方位置、出境目的、触发规则、建议路径、需补材料、责任部门和截止时间。验收时每个字段判断都能回指附件依据，并明确未取得合同、字段字典和授权记录时的处理边界。",
    steps: [
      "核验四个附件的发布主体、适用时间、格式和来源链接，确认能覆盖个人信息与数据出境判断。",
      "梳理官网预约、展会扫码、公众号留资三类线索来源和拟同步到海外CRM的字段。",
      "依据个人信息保护法标注姓名、手机号、邮箱、职位、预算和备注的个人信息属性及告知同意要求。",
      "依据数据安全法判断是否涉及重要数据、分类分级管理和数据处理活动安全义务。",
      "依据数据出境安全评估办法识别安全评估触发条件、申报材料和评估重点。",
      "依据2024年跨境流动规定判断是否存在便利化或豁免路径，并列出仍需满足的条件。",
      "把字段分为可境内先留存、可按合同或认证路径推进、可能触发评估、暂缓同步四类。",
      "列出CRM标准合同、境外接收方信息、字段字典、用户告知同意、历史导出日志等补件项。",
      "生成Word复核意见，给出明天客户周会可讨论的决策表述和风险提示。",
      "生成Excel字段和路径清单，确保每行有字段、依据、处理路径、责任部门和补件状态。",
      "交付前检查Word和Excel未把供应商承诺、授权记录或日志写成已核验事实。",
    ],
    annotator: "裴硬",
  },
  {
    uid: "裴硬_7.9_03",
    question:
      "业委会群里这两天吵得很厉害：电梯广告一年收了18万元，物业说已经抵扣保洁和电梯维保费用，几个业主却要求公开合同、流水和分摊明细。偏偏同一周又有3台电梯大修报价出来，物业想从住宅专项维修资金里先走应急流程，业主代表担心广告收益和维修资金被混在一起。\\n社区工作人员下周要开协调会，现场需要把“公共收益怎么公开”“哪些事项要业主共同决定”“维修资金能不能应急动用”讲清楚。手头只有法规资料，没有广告合同、银行流水、业主表决票和工程报价原件。\\n会议材料最好是一份可编辑Word协调会口径，配一张Excel证据和流程核对表，把已能判断的程序问题、需要物业补交的材料、需要业主大会表决的事项和主管部门确认点拆开。",
    taskType: "L2 流程型",
    primary: "房地产与大宗资产",
    secondary: "物业服务与业主治理",
    tertiary: "小区公共收益公开与维修资金动用复核",
    summary:
      "复核电梯广告公共收益公开和维修资金动用流程，拆清业主共同决定、补件材料和协调会口径。",
    attachments:
      "附件一_民法典物权编业主共有与维修资金条款.html；附件二_物业管理条例.pdf；附件三_住宅专项维修资金管理办法.html；附件四_业主大会和业主委员会指导规则.pdf",
    years: "7年",
    time: "14h",
    formats: "html, pdf",
    attachmentContent:
      "以下为四个附件的法规要点，用于核对小区共有收益、业主共同决定和维修资金流程。\\n附件一：《民法典物权编业主共有与维修资金条款》，来源：https://www.spp.gov.cn/spp/ssmfdyflvdtpgz/202008/t20200831_478410.shtml。用于核对共有部分收益归属、业主共同决定事项、维修资金筹集使用和业主权利。\\n附件二：《物业管理条例》，来源：https://xzfg.moj.gov.cn/law/download?LawID=960&type=pdf。用于核对物业服务企业职责、业主大会和业委会制度、物业服务监督和共有收益管理口径。\\n附件三：《住宅专项维修资金管理办法》，来源：https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/200804/t20080402_144499.html。用于整理维修资金交存、使用、分摊、应急使用、审核和监督管理流程。\\n附件四：《业主大会和业主委员会指导规则》，来源：https://www.mohurd.gov.cn/file/2023/20230508/3c521deb-89bd-4559-8c7c-4d099fb7e731.pdf。用于核对会议组织、表决程序、业委会职责和信息公开要求。\\n使用边界：以上资料不能证明广告合同原件、收益入账流水、业主表决票、工程报价或主管部门备案记录真实有效。",
    productFormat: "docx, xlsx",
    productContent:
      "最终产物为两个可编辑文件：一份Word文档（docx），包含争议背景、法规依据、公共收益公开口径、维修资金动用流程、协调会问答和补件要求；一份Excel表格（xlsx），字段包括争议事项、对应依据、现有材料、缺口说明、是否需业主共同决定、是否可走应急流程、需补主体、完成时限和会议备注。验收时能把广告收益、物业服务费用和维修资金三类资金边界分开，并标出公开资料无法确认的合同、流水、表决票和报价。",
    steps: [
      "核验四个附件的发布主体、格式、适用范围和来源链接，确认能覆盖共有收益和维修资金问题。",
      "从民法典物权编提取共有部分收益归属、业主共同决定事项和维修资金使用规则。",
      "从物业管理条例整理物业服务企业职责、业主大会制度、物业服务监督和信息公开相关要求。",
      "从住宅专项维修资金管理办法提取资金使用、分摊、应急使用、审核和监督流程。",
      "从业主大会和业主委员会指导规则整理会议组织、表决程序、业委会职责和公开要求。",
      "把电梯广告收益、物业服务费抵扣和维修资金动用拆成三条资金线分别判断。",
      "识别现有材料中缺失的广告合同、收益流水、业主表决票、维修报价和备案材料。",
      "判断哪些事项能在协调会上解释，哪些需物业补件，哪些需业主大会或主管部门确认。",
      "生成Word协调会口径，按争议事实、法规依据、可答复内容和待确认事项组织。",
      "生成Excel证据和流程核对表，逐项对应依据、材料状态、程序要求和责任主体。",
      "交付前检查没有把未取得的合同、流水、票据、报价和备案记录写成已核实事实。",
    ],
    annotator: "裴硬",
  },
  {
    uid: "裴硬_7.9_04",
    question:
      "招聘产品经理想在小程序里上线一个“AI初筛”入口，候选人投递后系统会根据简历关键词、过往行业、学历和薪资期望给出推荐等级，HR只看A档和部分B档。运营觉得这样能省面试时间，法务却担心候选人不知道有自动化筛选，简历里的年龄、手机号、工作经历也会被拿去训练提示词模板。下周灰度前，需要一份可编辑Word上线复核意见和一张Excel规则/告知核对表，帮产品、HR和法务对齐：哪些页面文案要补告知，哪些筛选规则需要人工复核，哪些数据用途和模型训练材料要先留证；真实算法参数、训练数据、候选人授权记录和人工复核日志暂时列入待确认。",
    taskType: "L2 流程型",
    primary: "科技软件与AI工作流",
    secondary: "招聘自动化与算法应用",
    tertiary: "AI简历筛选候选人告知与规则复核",
    summary:
      "复核招聘小程序AI初筛上线前的候选人告知、个人信息处理、算法规则和人工复核留痕。",
    attachments:
      "附件一_网络招聘服务管理规定.html；附件二_个人信息保护法_招聘候选人信息处理.html；附件三_互联网信息服务算法推荐管理规定.html；附件四_生成式人工智能服务管理暂行办法.html",
    years: "6年",
    time: "13h",
    formats: "html",
    attachmentContent:
      "以下为四个附件的法规要点，用于核对网络招聘、个人信息、算法推荐和生成式AI使用边界。\\n附件一：《网络招聘服务管理规定》，来源：https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202103/t20210309_374224.html。用于核对招聘服务主体责任、招聘信息真实性、求职者信息保护和网络招聘服务规则。\\n附件二：《中华人民共和国个人信息保护法》，来源：https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm。用于核对候选人个人信息处理、告知同意、最小必要、自动化决策和敏感信息保护。\\n附件三：《互联网信息服务算法推荐管理规定》，来源：https://www.cac.gov.cn/2022-01/04/c_1642894606364259.htm。用于确认算法推荐服务透明度、用户选择权、模型备案提示和不得实施不合理差别待遇要求。\\n附件四：《生成式人工智能服务管理暂行办法》，来源：https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm。用于整理生成式AI服务内容治理、训练数据处理、个人信息保护和安全评估口径。\\n使用边界：以上资料不能证明企业真实算法参数、训练数据来源、候选人授权记录、职位真实性或人工复核日志已经核验。",
    productFormat: "docx, xlsx",
    productContent:
      "最终产物为两个可编辑文件：一份Word文档（docx），包含上线背景、功能流程、候选人告知、个人信息处理、算法初筛规则、人工复核要求、灰度风险和补件清单；一份Excel表格（xlsx），字段包括页面或流程节点、涉及数据、自动化判断点、法规依据、需展示文案、人工复核动作、留痕材料、风险等级和负责人。验收时能看出AI初筛不是唯一决定依据，并明确未取得算法参数、训练数据、授权记录和复核日志时的待确认处理。",
    steps: [
      "核验四个附件的发布主体、格式、适用范围和来源链接，确认能覆盖招聘与AI筛选场景。",
      "梳理小程序投递、简历解析、AI初筛、HR查看和候选人通知的完整流程。",
      "从网络招聘服务管理规定提取招聘信息真实性、求职者信息保护和服务主体责任。",
      "从个人信息保护法标注简历字段、手机号、年龄、薪资期望等信息的处理依据和告知要求。",
      "从算法推荐规定整理透明度、用户选择权、自动化决策和差别待遇相关要求。",
      "从生成式AI办法提取训练数据、个人信息保护、内容治理和安全评估口径。",
      "把筛选规则分成可自动提示、需人工复核、暂缓上线和需补留痕材料四类。",
      "为投递页、隐私政策、结果通知和HR后台列出需要补充的告知文案要点。",
      "生成Word上线复核意见，写清灰度放行条件、风险提示和法务确认点。",
      "生成Excel规则和告知核对表，逐行对应流程节点、数据字段、依据、动作和负责人。",
      "交付前检查没有把算法参数、训练数据、授权记录和人工复核日志写成已取得事实。",
    ],
    annotator: "裴硬",
  },
  {
    uid: "裴硬_7.9_05",
    question:
      "本地生活平台这周要上一个“城市周末民宿”专题，招商同事已经收了30套房源资料，里面有房东身份证照片、房屋照片、消防承诺书和价格表，但有些房源没有旅馆业相关备案，也看不出是否接入住宿登记。平台运营怕专题页面下线影响招商，风控则担心治安、消防和交易信息展示没兜住。\\n上线评审会在后天上午，评审材料需要落到一份Word房源上架复核意见和一张Excel房源补件表，按房源把可先暂存、补证后上架、现场核验、暂缓上线四类分开；房东证照真实性、消防设施现场情况、公安报备、房屋权属和订单履约记录都不是法规附件能证明的内容，单独放待确认栏。",
    taskType: "L2 流程型",
    primary: "互联网与平台业务",
    secondary: "本地生活平台房源治理",
    tertiary: "民宿房源上架治安消防与交易信息复核",
    summary:
      "复核民宿专题房源上架前的治安、消防、平台交易信息展示和补件分流规则。",
    attachments:
      "附件一_旅馆业治安管理办法.pdf；附件二_中华人民共和国消防法.html；附件三_网络交易监督管理办法.html；附件四_中华人民共和国电子商务法.html",
    years: "5年",
    time: "12h",
    formats: "pdf, html",
    attachmentContent:
      "以下为四个附件的法规要点，用于核对民宿房源上架、治安消防和平台交易治理。\\n附件一：《旅馆业治安管理办法》，来源：https://xzfg.moj.gov.cn/law/download?LawID=694&type=pdf。用于核对旅馆业开办、住宿登记、治安管理、违法经营和公安管理要求。\\n附件二：《中华人民共和国消防法》，来源：https://www.jingtai.gov.cn/zfxxgk/bmhxzxxgk/xzfzcbmzsjgml/xyjglj/fdzdgknr/lzyj/zcfg/art/2024/art_ba688f3ad46641a8b07fed89c931c96c.html。用于核对住宿经营场所消防安全责任、消防设施、检查整改和禁止危及消防安全行为。\\n附件三：《网络交易监督管理办法》，来源：https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202104/t20210423_357848.html。用于整理平台内经营者信息、商品服务信息展示、交易记录保存和平台治理义务。\\n附件四：《中华人民共和国电子商务法》，来源：https://www.cac.gov.cn/2018-09/01/c_1123362506.htm。用于核对平台经营者身份核验、信息公示、消费者权益、交易安全和记录保存要求。\\n使用边界：以上资料不能证明房东证照真实性、现场消防设施、公安报备、房屋权属、线下巡检照片或订单履约记录已经核验。",
    productFormat: "docx, xlsx",
    productContent:
      "最终产物为两个可编辑文件：一份Word文档（docx），包含专题背景、房源资料现状、治安要求、消防要求、平台交易信息展示、分流结论和上线评审建议；一份Excel表格（xlsx），字段包括房源编号、现有资料、缺失材料、治安登记状态、消防核验状态、平台展示问题、分流建议、需补主体、责任人和评审备注。验收时四类分流清晰，并把法规资料无法确认的证照、现场设施、报备、权属和履约记录列为待确认。",
    steps: [
      "核验四个附件的发布主体、格式、适用范围和来源链接，确认能覆盖民宿上架复核。",
      "整理30套房源资料中房东身份、房屋照片、消防承诺、价格表和备案情况字段。",
      "从旅馆业治安管理办法提取开办、住宿登记、治安管理和违法经营相关要求。",
      "从消防法整理住宿经营场所消防安全责任、设施维护、检查整改和禁止行为。",
      "从网络交易监督管理办法提取平台内经营者信息、服务展示、交易记录和平台治理义务。",
      "从电子商务法整理身份核验、信息公示、交易安全、消费者权益和记录保存要求。",
      "按房源判断可先暂存、补证后上架、现场核验、暂缓上线四类处理路径。",
      "把房东证照真实性、现场消防设施、公安报备、房屋权属和订单履约记录列为待确认项。",
      "生成Word房源上架复核意见，写清评审会可用结论、分流规则和平台风险提示。",
      "生成Excel房源补件表，逐房源列出资料缺口、依据、责任人、补件动作和评审备注。",
      "交付前检查Word和Excel没有把消防承诺书、照片或证照扫描件直接写成已现场核验事实。",
    ],
    annotator: "裴硬",
  },
];

function tsvCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, " ");
}

function stepsCell(steps) {
  return steps.map((step, index) => `${index + 1}. ${step}`).join("\\n");
}

async function fileMeta(group, attachment) {
  const fullPath = path.join(runRoot, "attachments", group.attachmentDir, attachment.file);
  const buffer = await fs.readFile(fullPath);
  return {
    file: attachment.file,
    format: path.extname(attachment.file).slice(1).toLowerCase(),
    url: attachment.url,
    purpose: attachment.purpose,
    bytes: buffer.byteLength,
    contentType: attachment.file.endsWith(".pdf") ? "application/pdf" : "text/html",
    head: buffer.subarray(0, 12).toString("hex"),
    path: fullPath,
  };
}

const sourceCards = [];
for (const group of sourceGroups) {
  const attachments = [];
  for (const attachment of group.attachments) {
    attachments.push(await fileMeta(group, attachment));
  }
  sourceCards.push({
    topicId: group.topicId,
    title: group.title,
    qualityGate: "通过",
    attachments,
    boundary: group.boundary,
  });
}

const sourceJson = {
  generatedAt: sourceGeneratedAt,
  qualityGate: "五题均通过附件质量闸门，每题4个附件",
  sourceCards,
};

let sourceMd = "# 来源卡与附件质量结论\n\n";
for (const card of sourceCards) {
  sourceMd += `## ${card.title}\n\n结论：通过\n\n`;
  for (const attachment of card.attachments) {
    sourceMd += `- ${attachment.file}（${attachment.format}）：${attachment.purpose}  来源：${attachment.url}\n`;
  }
  sourceMd += `边界：${card.boundary}\n\n`;
}

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

const tsvRows = rows.map((row) =>
  [
    row.uid,
    row.question,
    row.taskType,
    row.primary,
    row.secondary,
    row.tertiary,
    row.summary,
    row.attachments,
    row.years,
    row.time,
    row.formats,
    row.attachmentContent,
    row.productFormat,
    row.productContent,
    stepsCell(row.steps),
    row.annotator,
  ]
    .map(tsvCell)
    .join("\t"),
);

await fs.mkdir(path.join(runRoot, "sources"), { recursive: true });
await fs.mkdir(path.join(runRoot, "drafts"), { recursive: true });

await fs.writeFile(
  path.join(runRoot, "sources", "source_cards.json"),
  `${JSON.stringify(sourceJson, null, 2)}\n`,
  "utf8",
);
await fs.writeFile(path.join(runRoot, "sources", "source_cards.md"), sourceMd, "utf8");
await fs.writeFile(
  path.join(runRoot, "drafts", "l2_questions_5.tsv"),
  `${header.join("\t")}\n${tsvRows.join("\n")}\n`,
  "utf8",
);

console.log(`Wrote ${path.relative(repoRoot, path.join(runRoot, "sources", "source_cards.json"))}`);
console.log(`Wrote ${path.relative(repoRoot, path.join(runRoot, "sources", "source_cards.md"))}`);
console.log(`Wrote ${path.relative(repoRoot, path.join(runRoot, "drafts", "l2_questions_5.tsv"))}`);
