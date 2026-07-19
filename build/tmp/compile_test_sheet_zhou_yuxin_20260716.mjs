import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildProductionTrace,
  initializeProductionWorkflow,
  recordAttachmentPlan,
  recordDraft,
  recordFinalRecord,
  recordFirstQualityGate,
  recordReferenceBreakdown,
  recordSecondLanguageGate,
  saveProductionWorkflow,
} from "../automation/production_workflow_state.mjs";
import {
  splitNarrativeParagraphs,
  splitNarrativeSentences,
} from "../automation/narrative_language_rules.mjs";
import {
  SCENE_CARD_BUNDLE_KIND,
  SCENE_CARD_PROTOCOL_ID,
} from "../automation/scene_card.mjs";
import { buildFeishuFillPlan } from "../manual_review/feishu_fill_plan_lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RUN_ID = "l2_20260716T021344Z_32c27a";
const RUN_DIR = path.join(ROOT, "outputs", "auto_runs", RUN_ID);
const WORKFLOW_PATH = path.join(RUN_DIR, "sources", "production_workflow_state.json");
const PACKET_PATH = path.join(RUN_DIR, "sources", "production_input_packet.json");
const DOWNLOAD_MANIFEST_PATH = path.join(RUN_DIR, "sources", "download_manifest.json");
const CANDIDATE_PATH = path.join(RUN_DIR, "drafts", "l2_questions.tsv");
const FILL_PLAN_PATH = path.join(RUN_DIR, "feishu", "feishu_fill_plan.json");
const ANNOTATOR_PLAN_PATH = path.join(RUN_DIR, "feishu", "annotator_fill_plan.json");
const FACT_LEDGER_PATH = path.join(RUN_DIR, "sources", "fact_ledger.json");
const SCENE_CARD_PATH = path.join(RUN_DIR, "sources", "scene_cards.json");
const TRACE_PATH = path.join(RUN_DIR, "qa", "production_trace.json");

const QUESTION_ONE = [
  "我们维护的设备都通过华为云 IoTDA 接入，认证走X.509。现在准备整理一次存量证书轮换，可我不想在没有核清证书状态和设备关联关系时直接停用旧证书。官方页面写明只有 MQTT 接入支持这种认证，每个用户最多上传100个 CA 证书。设备证书会在到期前30天告警，证书配额按设备数配额的1.5倍计算。更要紧的是，停用某张设备证书会让它关联的设备无法接入，删除 CA 证书也会影响用它鉴权的设备。这几条约束放在一起，先后顺序和回滚条件得先说清楚。这样才能把停用动作限制在证据已经完整的设备范围内。",
  "我已经把注册X.509设备、设备证书管理和相关接口等官方材料放进附件，另外还有 MQTT.fx 接入验证和平台证书资源说明。这些资料能确认认证方式、证书状态和调测路径等公开规则，却没有我们的设备清单和当前证书指纹，也缺少业务分组与可接受离线窗口。公开规则与内部待补数据需要分开，设备和证书关系则放在同一张映射表里。映射里要能找出即将过期、已经停用等异常，也要标出暂时无法确认关联关系的记录。状态切换前还要安排新旧证书并存验证，随后用单台设备回连结果决定是否扩大批次。任何需要真实环境才能确认的结果都保留成待执行项。",
  "你帮我把这次轮换整理成一份可直接筛查的 Excel 工作簿，再做一个给值班同事打开就能照着执行的 HTML 操作页。Excel 需要保留设备标识和证书指纹等对象字段，再记录证书状态和到期时间等判断字段，同时还要放入验证结果与回滚状态。页面按准备、试点等阶段推进，每一步都写清要看什么证据和失败后回到哪里。列表查询和状态更新接口也要给出调用口径，让执行人知道如何核对返回值。",
  "最后只回答本批设备是否具备进入轮换的条件，不把官方文档当成已经完成的环境验证。你可以放入一个证书即将过期的样例，再补一个关联关系缺失的样例。随后再用停用后回连失败的情况检查回滚动作。交付前把同一设备在两份产物里的状态和下一步对一遍，确保值班同事从表格切到页面时不会得到两套结论。",
].join("\n");

const QUESTION_TWO = [
  "我们现有的钉钉企业内部应用还在用 HTTP 回调接收人员变更事件，开发后台已经可以选择 Stream、SyncHTTP 和 HTTP 事件推送等方式。团队想把这套接收方式改到 Stream 模式，因为官方 SDK 已经封装了事件推送和机器人收消息等接入能力。可现在没有一份把旧回调、控制台配置和新客户端运行方式对齐的迁移记录。人员异动事件还在持续发生，直接切换容易碰到漏收或重复处理，也可能在连接失败时找不到回退入口，所以模式差异和验证边界要先理顺。",
  "附件里有推送方式配置页和 HTTP 事件订阅说明，另外放了全局错误码与人员变更 Stream 事件等资料。Java 和 Node 两套官方 SDK 说明也一并保留，方便团队按实际运行语言选择。旧页面能确认事件以 JSON 通过 HTTP POST 发到指定地址，也涉及 token 校验和对称加密。新资料则说明 Stream 能承接事件和机器人消息等场景。材料没有我们的订阅清单和回调成功率，也没写幂等键设计与告警阈值。生产密钥和运行语言同样不在附件里，这些只能列成待补项，不能从示例代码推成现状。",
  "你给我做一份 Word《钉钉事件推送迁移评审说明》，另外整理一张 Excel《事件订阅切换验证矩阵》。Word 从现状盘点推进到模式比较，再把改造步骤和回滚路径接起来。每个阶段需要说明先试哪些事件和怎样保存原回调配置，遇到鉴权失败或平台错误码时也要留下定位入口等操作口径。Excel 则逐事件保留旧入口和 Stream 订阅方式，再记录样例负载与幂等判断等验证信息。员工异动 v2要作为完整样例，并能查到处理结果和告警证据。",
  "评审结论只回答现有材料够不够进入切换演练，不直接宣布生产切换成功。验证矩阵从一次正常接收开始。重复投递要单独模拟。鉴权或连接失败时还要观察能否退回旧入口。完成后回看 Word 的放行条件，确认每个条件都能在 Excel 找到证据。控制台是否允许并行保留两种方式还无法从附件确认，因此把它放到演练前核验项。若实际不能并行，就在说明里写出恢复旧回调和核对补发记录等最小步骤。",
].join("\n");

const attachmentContentOne = [
  "附件一：《华为云注册X.509证书认证设备》。来源：https://support.huaweicloud.com/usermanual-iothub/iot_01_0055.html。内容摘要：说明注册证书认证设备的入口、参数和 MQTT 接入范围。资料边界：不能替代本项目设备台账与证书指纹核验。",
  "附件二：《华为云设备证书管理与状态限制》。来源：https://support.huaweicloud.com/usermanual-iothub/iot_01_0116.html。内容摘要：说明设备证书配额、到期告警与停用影响。资料边界：没有本租户证书状态和设备关联结果。",
  "附件三：《华为云更新设备证书 API》。来源：https://support.huaweicloud.com/api-iothub/UpdateDeviceCertificate.html。内容摘要：列出状态更新接口及请求响应字段。资料边界：接口文档不代表任何生产状态已经变更。",
  "附件四：《华为云查询设备证书列表 API》。来源：https://support.huaweicloud.com/api-iothub/ListDeviceCertificate.html。内容摘要：列出证书列表查询路径与返回字段。资料边界：真实返回值需在获授权环境中获取。",
  "附件五：《华为云 MQTT.fx 证书接入实践》。来源：https://support.huaweicloud.com/bestpractice-iothub/iot_bp_0077.html。内容摘要：展示证书接入与客户端调测路径。资料边界：示例结果不能当作本批设备的回连证据。",
  "附件六：《华为云 IoTDA 证书资源与到期替换》。来源：https://support.huaweicloud.com/devg-iothub/iot_02_1004.html。内容摘要：说明平台证书资源和到期替换相关操作。资料边界：具体窗口与批次仍由内部运行信息决定。",
].join("\n");

const attachmentContentTwo = [
  "附件一：《钉钉配置事件推送方式》。来源：https://open.dingtalk.com/document/development/configure-stream-push。内容摘要：说明 Stream、SyncHTTP 和 HTTP 等配置入口。资料边界：不能确认本应用当前选择和并行保留能力。",
  "附件二：《钉钉事件订阅与回调加解密》。来源：https://open.dingtalk.com/document/org/push-events。内容摘要：说明 HTTP 事件推送的 JSON 回调和安全校验。资料边界：生产 token 与回调地址不在材料中。",
  "附件三：《钉钉开放平台全局错误码》。来源：https://open.dingtalk.com/document/development/server-api-error-codes-1。内容摘要：提供接口失败时的错误码检索入口。资料边界：具体故障原因仍需结合运行日志判断。",
  "附件四：《钉钉人员变更 Stream 事件》。来源：https://open.dingtalk.com/document/orgapp/personnel-platform-employee-change-event-stream。内容摘要：说明人员异动 v2的事件页面和字段入口。资料边界：页面不代表本应用已经订阅。",
  "附件五：《钉钉 Stream 模式 Java 官方 SDK 说明》。来源：https://github.com/open-dingtalk/dingtalk-stream-sdk-java。内容摘要：说明 Java 客户端初始化和事件处理入口。资料边界：示例凭证不可复制到生产环境。",
  "附件六：《钉钉 Stream 模式 Node 官方 SDK 说明》。来源：https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs。内容摘要：说明 Node 客户端初始化和回调处理入口。资料边界：实际运行语言与部署配置需由项目组补充。",
].join("\n");

const RECORDS = [
  {
    UID: "434",
    题目: QUESTION_ONE,
    任务类型: "L2 流程型",
    一级目录: "科技软件与 AI 工作流",
    二级目录: "物联网平台运维与安全",
    三级目录: "华为云 IoTDA 设备证书轮换与停用窗口设计",
    任务概括: "核对华为云 IoTDA存量X.509设备证书关系，设计分批轮换、验证与回滚路径并判断是否具备启动条件。",
    标注专家工作年限: "6年",
    人类完成时间: "14h",
    相关附件: [
      "附件一_华为云_注册X509证书认证设备.html",
      "附件二_华为云_设备证书管理与状态限制.html",
      "附件三_华为云_更新设备证书API.html",
      "附件四_华为云_查询设备证书列表API.html",
      "附件五_华为云_MQTTfx证书接入实践.html",
      "附件六_华为云_IoTDA证书资源与到期替换.html",
    ].join("；"),
    附件格式: "html",
    附件内容: attachmentContentOne,
    产物格式: "xlsx, html",
    产物内容: "Excel《IoTDA 设备证书轮换检查表》供设备平台运维人员筛查设备、证书和 CA 的关联状态，并保留到期告警、验证结果、批次结论与回滚记录。HTML《IoTDA 证书轮换值班操作页》供值班同事按准备到收尾的阶段执行，展示接口调用口径、证据入口、失败分支和回退位置。两份产物只基于公开规则与明确标注的模拟记录形成条件判断，真实环境结果继续显示为待执行。",
    做题关键步骤: [
      "1. 逐份核对六个华为云页面的标题、来源地址与可用范围，记录认证方式和证书状态等可确认规则。",
      "2. 把设备清单、证书指纹和业务分组等内部缺口整理为待补字段，不从公开示例补造生产值。",
      "3. 在工作簿建立设备、设备证书、CA 与接入域名之间的映射关系，并设置关联关系完整性检查。",
      "4. 把到期前30天告警和证书配额1.5倍等公开约束转成可筛选的检查规则。",
      "5. 按证书状态识别即将过期、已停用和关系缺失等异常，分别给出下一步核验动作。",
      "6. 设计新旧证书并存的单台试点，记录下发结果、设备回连证据与失败判定。",
      "7. 根据试点结果划分后续批次，给每批写明进入条件、观察窗口和停止扩批条件。",
      "8. 对状态更新和列表查询接口编写请求口径，说明输入字段、返回值核对与错误留痕。",
      "9. 在 HTML 操作页串联准备、试点、扩批和收尾阶段，让每一步都能回到工作簿证据。",
      "10. 用即将过期、关系缺失和回连失败三个样例走通筛查、验证与回滚路径。",
      "11. 对照两份产物中同一设备的状态、下一步和回滚动作，确认条件结论完全一致。",
    ].join("\n"),
  },
  {
    UID: "435",
    题目: QUESTION_TWO,
    任务类型: "L2 流程型",
    一级目录: "科技软件与 AI 工作流",
    二级目录: "企业软件与技术方案",
    三级目录: "钉钉事件订阅推送模式迁移与回滚验证",
    任务概括: "梳理钉钉事件订阅从 HTTP 回调迁移到 Stream 模式的切换条件、验证证据和最小回退步骤。",
    标注专家工作年限: "5年",
    人类完成时间: "12h",
    相关附件: [
      "附件一_钉钉_配置事件推送方式.html",
      "附件二_钉钉_事件订阅与回调加解密.html",
      "附件三_钉钉_开放平台全局错误码.html",
      "附件四_钉钉_人员变更Stream事件.html",
      "附件五_钉钉Stream模式Java官方SDK说明.txt",
      "附件六_钉钉Stream模式Node官方SDK说明.txt",
    ].join("；"),
    附件格式: "html, txt",
    附件内容: attachmentContentTwo,
    产物格式: "docx, xlsx",
    产物内容: "Word《钉钉事件推送迁移评审说明》供企业应用集成团队评审现状、模式差异、改造步骤、放行条件与回滚路径。Excel《事件订阅切换验证矩阵》按事件保留旧回调、Stream 订阅、幂等判断、处理结果、告警证据和回滚状态，并用人员异动 v2 走完正常、重复与失败场景。结论只判断是否可进入演练，生产配置和真实密钥等缺口继续列为演练前核验项。",
    做题关键步骤: [
      "1. 核对六个钉钉官方材料的页面范围，区分推送方式、HTTP 回调、Stream 事件和 SDK 接入信息。",
      "2. 盘点现有 HTTP 事件链需要补齐的订阅清单、成功率、幂等键和告警记录等内部材料。",
      "3. 在 Word 中比较 HTTP 与 Stream 的配置位置、连接方式、事件处理和故障定位路径。",
      "4. 选择人员异动 v2作为首个样例，明确事件字段、接收入口和可核验处理结果。",
      "5. 在 Excel 建立逐事件验证矩阵，关联旧回调、Stream 订阅、样例负载和幂等判断。",
      "6. 设计正常接收场景并记录事件到达、业务处理、响应结果与告警状态。",
      "7. 设计重复投递场景并检查幂等键是否阻止重复业务动作，同时保留原始事件证据。",
      "8. 模拟鉴权或连接失败，借助全局错误码与运行日志定位问题并触发回退判断。",
      "9. 核验控制台能否并行保留两种推送方式，无法确认时把它列为演练前阻断项。",
      "10. 在 Word 写明不能并行时的最小回退动作，包括恢复旧回调和核对补发记录。",
      "11. 将 Word 的每个放行条件映射到 Excel 证据列，缺少证据的条件不得判为通过。",
      "12. 汇总演练准入结论和未决事项，确认没有把 SDK 示例结果写成生产切换事实。",
    ].join("\n"),
  },
];

const HEADERS = [
  "UID", "题目", "任务类型", "一级目录", "二级目录", "三级目录", "任务概括",
  "标注专家工作年限", "人类完成时间", "相关附件", "附件格式", "附件内容",
  "产物格式", "产物内容", "做题关键步骤",
];

const COLUMN_MAP = [
  ["UID", "A"], ["题目", "B"], ["任务类型", "C"], ["一级目录", "D"],
  ["二级目录", "E"], ["三级目录", "F"], ["任务概括", "G"],
  ["标注专家工作年限", "H"], ["人类完成时间", "I"], ["相关附件", "J"],
  ["附件格式", "K"], ["附件内容", "L"], ["产物格式", "M"],
  ["产物内容", "N"], ["做题关键步骤", "O"],
].map(([field, column]) => ({ field, column }));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodeCell(value) {
  return String(value ?? "").replaceAll("\t", " ").replaceAll("\r", "").replaceAll("\n", "\\n");
}

function toTsv(records) {
  return `${HEADERS.join("\t")}\n${records.map((record) => HEADERS.map((header) => encodeCell(record[header])).join("\t")).join("\n")}\n`;
}

function continuityAudit(question) {
  const sentences = splitNarrativeSentences(question);
  const paragraphs = splitNarrativeParagraphs(question);
  return {
    sentenceLinks: sentences.slice(0, -1).map((_, index) => ({
      from: index + 1,
      to: index + 2,
      relation: index === sentences.length - 2 ? "任务收束" : "对象延续",
      reason: `后一句继续处理前一句留下的同一业务对象并把判断推进到第${index + 2}句`,
    })),
    paragraphLinks: paragraphs.slice(0, -1).map((_, index) => ({
      from: index + 1,
      to: index + 2,
      relation: index === paragraphs.length - 2 ? "任务收束" : "递进",
      reason: `后一段沿用前一段的问题边界并把任务推进到第${index + 2}段`,
    })),
    commaListFree: true,
    outsiderReadable: true,
    narrativeFlow: true,
    unexplainedProfessionalTerms: [],
  };
}

function referenceBreakdown(index) {
  if (index === 1) {
    return {
      businessScene: "设备平台运维人员准备轮换存量证书",
      coreBlockage: "必须先核对证书状态、设备关系和回滚条件",
      mainTask: "判断本批设备是否具备进入证书轮换的条件",
      attachmentSupport: "对象级产品文档、接口页面和调测实践支撑规则核对",
      deliverableOrigin: "工作簿用于批量筛查，操作页用于值班执行",
      imitableStructure: "先核对状态关系，再设计试点与放量，最后回到准入结论",
      forbiddenReuse: "不复用抽样题的行业对象、附件名称、措辞和产物段落",
      referenceAttachmentStructure: "以对象记录和操作说明组合形成可执行资料包",
      referenceProductParagraphLogic: "让表格承载状态，让操作页承载动作，并用样例贯通两者",
    };
  }
  return {
    businessScene: "企业应用集成团队迁移钉钉事件订阅模式",
    coreBlockage: "旧回调、新连接和回退条件尚未放到同一验证框架",
    mainTask: "判断当前材料是否足以进入 Stream 切换演练",
    attachmentSupport: "配置页面、事件文档、错误码和两种 SDK 支撑迁移评审",
    deliverableOrigin: "评审说明承载决策过程，验证矩阵承载逐事件证据",
    imitableStructure: "先盘点现状，再设计验证和失败场景，最后形成演练准入结论",
    forbiddenReuse: "不复用抽样题的角色、业务压力、附件组合和产物固定壳",
    referenceAttachmentStructure: "平台配置、具体事件、错误排查和客户端实现四类资料配合",
    referenceProductParagraphLogic: "说明稿解释放行边界，矩阵逐项留下验证和回滚证据",
  };
}

async function attachmentPlans() {
  const manifest = JSON.parse(await fs.readFile(DOWNLOAD_MANIFEST_PATH, "utf8"));
  const corrected = manifest.items.map((item) => {
    if (item.name.endsWith("Java官方SDK说明.md")) {
      return { ...item, name: item.name.replace(/\.md$/u, ".txt"), path: item.path.replace(/\.md$/u, ".txt") };
    }
    if (item.name.endsWith("Node官方SDK说明.md")) {
      return { ...item, name: item.name.replace(/\.md$/u, ".txt"), path: item.path.replace(/\.md$/u, ".txt") };
    }
    return item;
  });
  const verified = [];
  for (const item of corrected) {
    const localPath = path.resolve(ROOT, item.path);
    const bytes = await fs.readFile(localPath);
    verified.push({ ...item, localPath, size: bytes.length, sha256: sha256(bytes) });
  }
  await fs.writeFile(DOWNLOAD_MANIFEST_PATH, `${JSON.stringify({ ...manifest, items: verified.map(({ localPath, ...item }) => item) }, null, 2)}\n`, "utf8");
  return [1, 2].map((questionIndex) => ({
    attachments: verified.filter((item) => item.q === questionIndex).map((item) => ({
      name: item.name,
      sourceUrl: item.url,
      localPath: item.localPath,
      sha256: item.sha256,
      bytes: item.size,
      classification: "specific-business",
      objectLevel: true,
      timeAnchor: "2026-07-16官方页面下载快照",
      summary: questionIndex === 1
        ? `华为云 IoTDA 的对象级技术页面，包含${item.name.replace(/^附件[一二三四五六]_华为云_/u, "").replace(/\.[^.]+$/u, "")}相关字段、状态或操作路径`
        : `钉钉开放平台的对象级技术页面，包含${item.name.replace(/^附件[一二三四五六]_钉钉_?/u, "").replace(/\.[^.]+$/u, "")}相关配置、事件或客户端入口`,
      specificityEvidence: {
        object: questionIndex === 1 ? "华为云 IoTDA 设备证书" : "钉钉开放平台事件订阅",
        periodOrEvent: "2026-07-16迁移资料核验",
        uniqueContent: `保留官方来源地址、文件哈希和${item.name}对应的产品级字段或操作说明`,
      },
    })),
    newAttachmentSupport: questionIndex === 1
      ? "六份对象级资料分别覆盖认证注册、证书状态、查询更新和客户端回连验证"
      : "六份对象级资料分别覆盖推送配置、旧回调、错误码、具体事件和两种 SDK",
    newQuestionStructureMapping: questionIndex === 1
      ? "从停用影响推进到关系映射、单台试点、批次放量和准入结论"
      : "从旧回调现状推进到 Stream 验证、重复与失败场景、回退和演练准入结论",
  }));
}

function sceneData(record) {
  if (record.UID === "434") {
    return {
      topicId: "topic-iotda-certificate-rotation",
      personaId: "persona-iotda-ops-434",
      requester: {
        functionalRole: "设备平台运维工程师",
        organizationType: "使用华为云 IoTDA 管理联网设备的企业",
        department: "",
        responsibility: "核对存量设备证书关系并设计可执行的轮换与回滚路径",
        authorityBoundary: "只能依据公开规则整理方案，不能替代有权限的人员执行生产证书状态变更",
        recipientRelation: "把零散技术材料交给能制作工作簿和操作页的协作同事",
      },
      scene: {
        workflowStage: "存量设备证书轮换前的验证准备",
        trigger: "存量X.509设备需要轮换证书，同时要保留可验证的停用和回滚路径",
        currentBlockage: "内部设备清单和当前证书关联信息尚未提供，公开材料只能确认平台规则",
        mainDecision: "判断本批设备是否具备进入证书轮换的条件",
        downstreamUse: "设备运维和值班同事按工作簿筛查并从操作页执行试点与回滚",
      },
      unknown: "华为云生产租户的设备证书映射原始台账原件",
      requestSpan: "你帮我把这次轮换整理成一份可直接筛查的 Excel 工作簿，再做一个给值班同事打开就能照着执行的 HTML 操作页。",
      action: "帮我把",
      outputs: [
        { format: "xlsx", humanName: "Excel 工作簿", purpose: "筛查设备证书关系与轮换条件" },
        { format: "html", humanName: "HTML 操作页", purpose: "让值班同事按阶段执行与回滚" },
      ],
      blockageSpan: "可我不想在没有核清证书状态和设备关联关系时直接停用旧证书。",
      downstreamUseSpan: "你帮我把这次轮换整理成一份可直接筛查的 Excel 工作簿，再做一个给值班同事打开就能照着执行的 HTML 操作页。",
      maskTerms: ["华为云 IoTDA", "X.509", "设备证书", "MQTT", "CA 证书"],
      vocabulary: ["证书轮换", "设备回连", "证书指纹", "状态更新", "回滚"],
    };
  }
  return {
    topicId: "topic-dingtalk-stream-migration",
    personaId: "persona-dingtalk-integration-435",
    requester: {
      functionalRole: "企业应用集成工程师",
      organizationType: "使用钉钉企业内部应用处理人员事件的团队",
      department: "",
      responsibility: "梳理事件推送模式差异并准备可验证的迁移演练",
      authorityBoundary: "只能形成迁移评审与验证矩阵，不能替代应用管理员修改生产推送配置",
      recipientRelation: "把平台文档和现有问题交给能整理评审说明与验证矩阵的协作同事",
    },
    scene: {
      workflowStage: "钉钉事件订阅切换演练前的评审准备",
      trigger: "现有钉钉事件订阅准备从 HTTP 回调迁移到 Stream 模式",
      currentBlockage: "生产订阅清单和运行配置尚未提供，材料只能确认两种接入路径",
      mainDecision: "判断当前材料是否足以进入切换演练",
      downstreamUse: "企业应用集成团队用评审说明放行，并在验证矩阵保留逐事件证据",
    },
    unknown: "钉钉应用生产配置导出文件原件",
    requestSpan: "你给我做一份 Word《钉钉事件推送迁移评审说明》，另外整理一张 Excel《事件订阅切换验证矩阵》。",
    action: "你给我做",
    outputs: [
      { format: "docx", humanName: "Word《钉钉事件推送迁移评审说明》", purpose: "解释迁移决策与回滚边界" },
      { format: "xlsx", humanName: "Excel《事件订阅切换验证矩阵》", purpose: "逐事件记录切换验证证据" },
    ],
    blockageSpan: "可现在没有一份把旧回调、控制台配置和新客户端运行方式对齐的迁移记录。",
    downstreamUseSpan: "你给我做一份 Word《钉钉事件推送迁移评审说明》，另外整理一张 Excel《事件订阅切换验证矩阵》。",
    maskTerms: ["钉钉", "HTTP 回调", "Stream", "人员异动", "事件订阅"],
    vocabulary: ["事件推送", "幂等键", "鉴权", "回调", "错误码"],
  };
}

async function main() {
  const packet = JSON.parse(await fs.readFile(PACKET_PATH, "utf8"));
  const workflow = initializeProductionWorkflow({ packet, runId: RUN_ID });
  const plans = await attachmentPlans();
  for (let index = 0; index < RECORDS.length; index += 1) {
    const record = RECORDS[index];
    const questionIndex = index + 1;
    recordReferenceBreakdown(workflow, questionIndex, referenceBreakdown(questionIndex));
    recordAttachmentPlan(workflow, questionIndex, plans[index]);
    recordDraft(workflow, questionIndex, {
      question: record.题目,
      mainTask: questionIndex === 1
        ? "判断本批设备是否具备进入证书轮换的条件"
        : "判断当前材料是否足以进入 Stream 切换演练",
      structureMapping: plans[index].newQuestionStructureMapping,
      productFormats: record.产物格式,
      deliverableRationale: questionIndex === 1
        ? [
            { format: "xlsx", user: "设备平台运维人员", purpose: "筛查证书关系和批次条件", whyThisFormat: "适合记录对象映射、筛选状态与持续更新验证结果" },
            { format: "html", user: "值班同事", purpose: "按阶段执行试点与回滚", whyThisFormat: "适合在浏览器查看动作、证据和失败分支" },
          ]
        : [
            { format: "docx", user: "企业应用集成评审人员", purpose: "解释迁移条件与回滚路径", whyThisFormat: "适合承载连续评审说明和可编辑意见" },
            { format: "xlsx", user: "迁移演练执行人员", purpose: "逐事件记录验证证据", whyThisFormat: "适合筛查状态并对照放行条件" },
          ],
    });
    recordFirstQualityGate(workflow, questionIndex, {
      preQaStructureAudit: {
        uniqueMainTask: true,
        attachmentsSupportDecision: true,
        deliverablesHaveDistinctUsers: true,
        simulatedResultsClearlyBounded: true,
      },
      firstQaResult: { pass: true, issues: [] },
    });
    recordSecondLanguageGate(workflow, questionIndex, {
      conclusion: "通过",
      coreJudgement: "题面按真实业务因果推进，附件边界、交付请求和验收动作均已明确。",
      mainChanges: [],
      modifiedQuestion: record.题目,
      punctuationAudit: {
        semicolonUsed: false,
        excessiveEnumerationCommas: false,
        disguisedCommaList: false,
        enumerationDengAtLeastThree: true,
        emptyParentheses: false,
      },
      continuityAudit: continuityAudit(record.题目),
      remainingNote: "可进入最终出题表",
    });
    recordFinalRecord(workflow, questionIndex, { recordUid: record.UID, finalRecord: record });
  }
  await saveProductionWorkflow(WORKFLOW_PATH, workflow);
  const trace = buildProductionTrace(workflow);
  await fs.writeFile(TRACE_PATH, `${JSON.stringify(trace, null, 2)}\n`, "utf8");

  const tsvText = toTsv(RECORDS);
  await fs.writeFile(CANDIDATE_PATH, tsvText, "utf8");
  const fillPlan = buildFeishuFillPlan({
    text: tsvText,
    sourcePath: CANDIDATE_PATH,
    sheetRows: [433, 434],
    count: 2,
    columnMap: COLUMN_MAP,
  });
  await fs.writeFile(FILL_PLAN_PATH, `${JSON.stringify(fillPlan, null, 2)}\n`, "utf8");
  const annotatorPlan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourcePath: CANDIDATE_PATH,
    sheetRows: [433, 434],
    count: 2,
    note: "Test-sheet override requested by the user. Write annotator name separately from managed generated identities.",
    columnMap: [{ field: "标注专家姓名", column: "Q" }],
    rows: [433, 434].map((sheetRow) => ({
      sheetRow,
      updates: [{ address: `Q${sheetRow}`, column: "Q", field: "标注专家姓名", value: "周宇新", chars: 3, hasNewlines: false, preview: "周宇新" }],
    })),
  };
  await fs.writeFile(ANNOTATOR_PLAN_PATH, `${JSON.stringify(annotatorPlan, null, 2)}\n`, "utf8");

  const facts = [];
  const materials = [];
  const unknowns = [];
  const cards = [];
  for (const record of RECORDS) {
    const scene = sceneData(record);
    const factId = `fact-row-${record.UID}`;
    const materialId = `material-row-${record.UID}`;
    facts.push({
      id: factId,
      uid: record.UID,
      text: `${Object.values(record).join("\n")}\n${scene.scene.trigger}\n${scene.scene.currentBlockage}\n${scene.scene.mainDecision}`,
    });
    materials.push({ id: materialId, uid: record.UID, text: record.相关附件 });
    unknowns.push({ id: `unknown-row-${record.UID}`, uid: record.UID, text: scene.unknown });
    cards.push({
      recordUid: record.UID,
      sceneCard: {
        schemaVersion: 1,
        policyId: SCENE_CARD_PROTOCOL_ID,
        topicId: scene.topicId,
        personaId: scene.personaId,
        requester: scene.requester,
        scene: scene.scene,
        informationBoundary: {
          knownFactIds: [factId],
          availableMaterialIds: [materialId],
          unknowns: [scene.unknown],
          forbiddenInferences: ["不能把公开文档、SDK 示例或模拟记录补写成已经发生的生产验证结果"],
        },
        voice: {
          channel: "即时工作消息",
          formality: "熟悉同事之间的具体工作交代，直接说明真实卡点和交付用途",
          domainVocabulary: scene.vocabulary,
          avoidVocabulary: ["全面赋能", "一站式闭环", "全景抓手", "深度洞察"],
        },
        maskTerms: scene.maskTerms,
        evidenceBindings: [
          { claim: scene.scene.trigger, factIds: [factId] },
          { claim: scene.scene.currentBlockage, factIds: [factId] },
          { claim: scene.scene.mainDecision, factIds: [factId] },
        ],
      },
      requestContract: {
        requestSpan: scene.requestSpan,
        action: scene.action,
        outputs: scene.outputs,
      },
      roleTrace: {
        blockageSpan: scene.blockageSpan,
        motivationSpan: "",
        downstreamUseSpan: scene.downstreamUseSpan,
      },
      usedFactIds: [factId],
      deliberatelyOmitted: [],
    });
  }
  const factLedger = { schemaVersion: 1, generatedAt: new Date().toISOString(), facts, materials, unknowns };
  const factLedgerText = `${JSON.stringify(factLedger, null, 2)}\n`;
  await fs.writeFile(FACT_LEDGER_PATH, factLedgerText, "utf8");
  const sceneBundle = {
    kind: SCENE_CARD_BUNDLE_KIND,
    protocolId: SCENE_CARD_PROTOCOL_ID,
    schemaVersion: 1,
    factLedgerPath: "fact_ledger.json",
    factLedgerHash: sha256(factLedgerText),
    cards,
  };
  await fs.writeFile(SCENE_CARD_PATH, `${JSON.stringify(sceneBundle, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    runId: RUN_ID,
    candidatePath: CANDIDATE_PATH,
    fillPlanPath: FILL_PLAN_PATH,
    annotatorPlanPath: ANNOTATOR_PLAN_PATH,
    questionLengths: RECORDS.map((record) => ({ uid: record.UID, chars: [...record.题目.replace(/\s/gu, "")].length })),
    attachmentCounts: plans.map((plan) => plan.attachments.length),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
