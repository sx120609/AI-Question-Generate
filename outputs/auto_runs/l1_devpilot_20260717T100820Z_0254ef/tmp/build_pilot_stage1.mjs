import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  initializeProductionWorkflow,
  recordAttachmentPlan,
  recordDraft,
  recordFirstQualityGate,
  recordReferenceBreakdown,
  recordSecondLanguageGate,
  saveProductionWorkflow,
} from "../../../../build/automation/production_workflow_state.mjs";
import { validateSceneCard } from "../../../../build/automation/scene_card.mjs";

const runDir = path.resolve("outputs/auto_runs/l1_devpilot_20260717T100820Z_0254ef");
const sourceDir = path.join(runDir, "sources");
const draftDir = path.join(runDir, "drafts");
const qaDir = path.join(runDir, "qa");
const workflowPath = path.join(sourceDir, "production_workflow_state.json");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const question = "公司准备把跨地区员工培训固定成常态化直播，参训者中有依赖实时字幕、键盘操作或屏幕阅读器的同事。现在候选平台是 Zoom、Microsoft Teams 和 Google Meet，但相关说明分散在厂商的无障碍页面和帮助中心，字幕能力还可能受会议类型、许可证和管理员设置影响。请以截至2026年7月17日仍可访问的官方产品文档和帮助页为准，整理一份 Excel 对比表。表中先核对实时字幕、翻译字幕和屏幕阅读器支持，再记录键盘与焦点操作。录制与转录留存也要单独说明，同时检查主持人和管理员能控制什么，并为每条判断附上来源链接和访问日期。公开页面没有说清的套餐限制、字幕语言范围和导出权限不要自行补齐，保存期限与直播规模也统一列成待确认项，并说明需要通过什么实测或询价补证。表尾只推荐一个优先进入 POC 的平台，写明选择依据以及另外两个暂缓的证据缺口。这个结论只用于安排下一轮实测，不作为最终采购或合规判断。";

const factLedger = {
  schemaVersion: 1,
  runId: "l1_devpilot_20260717T100820Z_0254ef",
  capturedAt: "2026-07-17T10:30:00.000Z",
  facts: [
    { id: "fact-trigger", text: "公司准备把跨地区员工培训固定成常态化直播。" },
    { id: "fact-access-needs", text: "参训者中有依赖实时字幕、键盘操作或屏幕阅读器的同事。" },
    { id: "fact-candidates", text: "候选平台是 Zoom、Microsoft Teams 和 Google Meet。" },
    { id: "fact-blockage", text: "不同厂商的无障碍说明分散在产品页和帮助中心。" },
    { id: "fact-decision", text: "本轮需要判断三个候选平台中哪一个优先进入 POC。" },
    { id: "fact-boundary", text: "本轮结论只用于安排下一轮实测，不作为最终采购或合规判断。" },
    { id: "fact-source-check", text: "截至2026年7月17日，研究清单中的官方产品文档和帮助页均已完成可访问性核验。" }
  ],
  materials: [
    { id: "material-zoom-accessibility", title: "Accessibility | Zoom", url: "https://www.zoom.com/en/accessibility/", publisher: "Zoom", status: 200, accessedAt: "2026-07-17" },
    { id: "material-zoom-captions", title: "Viewing captions in a meeting or webinar", url: "https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059762", publisher: "Zoom Support", status: 200, accessedAt: "2026-07-17" },
    { id: "material-teams-captions", title: "Use live captions in Microsoft Teams meetings", url: "https://support.microsoft.com/en-US/teams/meetings/use-live-captions-in-microsoft-teams-meetings", publisher: "Microsoft Support", status: 200, accessedAt: "2026-07-17" },
    { id: "material-teams-screenreader", title: "Screen reader support for Microsoft Teams", url: "https://support.microsoft.com/en-US/accessibility/teams/screen-reader-support-for-microsoft-teams", publisher: "Microsoft Support", status: 200, accessedAt: "2026-07-17" },
    { id: "material-meet-accessibility", title: "Accessibility in Google Meet", url: "https://support.google.com/meet/answer/16175468?hl=en", publisher: "Google Meet Help", status: 200, accessedAt: "2026-07-17" },
    { id: "material-meet-translated", title: "Use translated captions in Google Meet", url: "https://support.google.com/meet/answer/10964115?hl=en", publisher: "Google Meet Help", status: 200, accessedAt: "2026-07-17" },
    { id: "material-w3c-live-captions", title: "Understanding Success Criterion 1.2.4: Captions (Live)", url: "https://www.w3.org/WAI/WCAG22/Understanding/captions-live.html", publisher: "W3C WAI", status: 200, accessedAt: "2026-07-17" },
    { id: "material-w3c-keyboard", title: "Understanding Success Criterion 2.1.1: Keyboard", url: "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html", publisher: "W3C WAI", status: 200, accessedAt: "2026-07-17" },
    { id: "material-w3c-focus", title: "Understanding Success Criterion 2.4.7: Focus Visible", url: "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html", publisher: "W3C WAI", status: 200, accessedAt: "2026-07-17" }
  ],
  unknowns: [
    { id: "unknown-license", text: "三个平台在目标企业许可证下的字幕、翻译字幕和转录权限" },
    { id: "unknown-language", text: "目标参训语言是否全部落在各平台当前支持范围内" },
    { id: "unknown-admin", text: "企业管理员策略是否会关闭公开文档中描述的能力" },
    { id: "unknown-retention", text: "录制、字幕和转录数据在目标租户中的保存期限与导出权限" },
    { id: "unknown-scale", text: "目标直播规模和会议类型下的实际可用性" }
  ]
};

const sceneCard = {
  schemaVersion: 1,
  policyId: "situated-requester-v1",
  topicId: "accessible-training-platform-poc",
  personaId: "persona-lnd-digital-pm-01",
  requester: {
    functionalRole: "企业学习与发展数字化项目经理",
    organizationType: "设有跨地区员工培训的企业",
    department: "",
    responsibility: "核验候选直播平台的公开无障碍证据并安排下一轮实测",
    authorityBoundary: "只能决定哪一个平台优先进入 POC，不能据此作出最终采购或合规结论",
    recipientRelation: "把证据对比表交给培训项目组安排下一轮实测"
  },
  scene: {
    workflowStage: "培训直播平台 POC 前的公开证据初筛",
    trigger: "公司准备把跨地区员工培训固定成常态化直播",
    currentBlockage: "不同厂商的无障碍说明分散在产品页和帮助中心",
    mainDecision: "三个候选平台中哪一个优先进入 POC",
    downstreamUse: "供培训团队安排下一轮实测"
  },
  informationBoundary: {
    knownFactIds: ["fact-trigger", "fact-access-needs", "fact-candidates", "fact-blockage", "fact-decision", "fact-boundary", "fact-source-check"],
    availableMaterialIds: ["material-zoom-accessibility", "material-zoom-captions", "material-teams-captions", "material-teams-screenreader", "material-meet-accessibility", "material-meet-translated", "material-w3c-live-captions", "material-w3c-keyboard", "material-w3c-focus"],
    unknowns: ["三个平台在目标企业许可证下的字幕、翻译字幕和转录权限", "目标参训语言是否全部落在各平台当前支持范围内", "企业管理员策略是否会关闭公开文档中描述的能力", "录制、字幕和转录数据在目标租户中的保存期限与导出权限", "目标直播规模和会议类型下的实际可用性"],
    forbiddenInferences: ["不得把公开功能说明直接写成目标租户已经具备的能力", "不能把这轮桌面研究写成最终采购或合规结论"]
  },
  voice: {
    channel: "内部任务单",
    formality: "直接、克制的项目工作委托",
    domainVocabulary: ["实时字幕", "翻译字幕", "屏幕阅读器", "管理员策略", "POC"],
    avoidVocabulary: ["全链路", "闭环", "赋能", "深度洞察"]
  },
  maskTerms: ["Zoom", "Microsoft Teams", "Google Meet", "实时字幕", "屏幕阅读器", "POC"],
  evidenceBindings: [
    { claim: "公司准备把跨地区员工培训固定成常态化直播", factIds: ["fact-trigger"] },
    { claim: "参训者中有依赖实时字幕、键盘操作或屏幕阅读器的同事", factIds: ["fact-access-needs"] },
    { claim: "候选平台是 Zoom、Microsoft Teams 和 Google Meet", factIds: ["fact-candidates"] },
    { claim: "不同厂商的无障碍说明分散在产品页和帮助中心", factIds: ["fact-blockage"] },
    { claim: "三个候选平台中哪一个优先进入 POC", factIds: ["fact-decision"] },
    { claim: "供培训团队安排下一轮实测", factIds: ["fact-boundary"] }
  ]
};

const sourceRecord = {
  UID: "沈礼_7.17_L1_01",
  题目: question,
  任务类型: "L1 探索型",
  一级目录: "科技软件与 AI 工作流",
  二级目录: "企业软件与技术方案",
  三级目录: "在线培训直播平台无障碍能力初筛",
  任务概括: "核验三款培训直播平台的公开无障碍证据并选择一个优先进入 POC",
  标注专家工作年限: "3年",
  人类完成时间: "5H",
  相关附件: "无",
  附件格式: "无",
  附件内容: "无文件附件，使用已核验可访问的厂商官方产品文档、帮助中心与 W3C 无障碍解释页。",
  产物格式: "xlsx",
  产物内容: "一份逐条绑定官方来源和访问日期的候选平台无障碍证据对比表，包含能力边界、待确认项、补证方法和一个 POC 优先建议。",
  做题关键步骤: "1. 明确本轮只做公开证据初筛及 POC 排序。\n2. 检索并核验三家厂商官方产品文档与帮助页。\n3. 按统一维度摘录功能证据、适用条件和来源日期。\n4. 区分已证实事实、合理推断与公开资料未说明事项。\n5. 将许可证、语言、管理员策略、导出留存和规模边界转成实测或询价问题。\n6. 比较证据完整度并推荐一个优先进入 POC 的平台。",
  标注专家姓名: "沈礼"
};

const breakdown = {
  businessScene: "企业培训 SaaS 团队在资料分散、接口和权限受限的条件下初筛一个 AI 客服试点入口",
  coreBlockage: "现有材料质量不一，候选工具公开能力边界也不完整",
  mainTask: "比较三个入口并只选择一个进入第一期试点",
  attachmentSupport: "无文件附件，依靠截至指定日期可访问的官方公开文档核验",
  deliverableOrigin: "团队需要一份可筛选的 XLSX 对比表支持第一期入口决策",
  imitableStructure: "保留真实团队约束、三方案比较、公开证据边界、唯一阶段性判断和待确认项",
  forbiddenReuse: "不复用客服 AI 入口、企业微信、Dify、飞书多维表格及原题措辞",
  referenceAttachmentStructure: "示例无文件附件，依靠官方产品与开发文档作为可核验材料",
  referenceProductParagraphLogic: "先统一比较维度和证据口径，再给一个阶段性选择，并把公开资料不能证明的事项留到下一轮"
};

const attachmentPlan = {
  attachments: [],
  newAttachmentSupport: "本题不设置文件附件，使用九个已核验可访问的官方产品、帮助中心与 W3C 公开页面作为研究来源",
  newQuestionStructureMapping: "沿用三方案证据比较和唯一阶段性判断的推进方式，改为培训直播平台无障碍 POC 初筛"
};

const sceneValidation = validateSceneCard(sceneCard, { factLedger });
if (!sceneValidation.ok) throw new Error(`Scene card seed invalid: ${JSON.stringify(sceneValidation.errors)}`);

const packet = JSON.parse(await fs.readFile(path.join(sourceDir, "production_input_packet.json"), "utf8"));
const workflow = initializeProductionWorkflow({ packet });
recordReferenceBreakdown(workflow, 1, breakdown);
recordAttachmentPlan(workflow, 1, attachmentPlan);
recordDraft(workflow, 1, {
  question,
  mainTask: "核验三款候选平台的公开无障碍证据并选择一个优先进入 POC",
  structureMapping: attachmentPlan.newQuestionStructureMapping,
  productFormats: "xlsx",
  deliverableRationale: [{
    format: "xlsx",
    user: "企业学习与发展数字化项目经理和培训项目组",
    purpose: "按统一维度筛选证据、记录待确认项并安排下一轮实测",
    whyThisFormat: "表格便于并列比较三个平台、逐行绑定来源并持续补充 POC 结果"
  }]
});

const firstRawPath = path.join(qaDir, "01_first_quality_gate_raw.json");
const firstRaw = {
  schemaVersion: 1,
  kind: "l1-first-quality-gate-raw-response",
  runnerId: "exact-two-quality-gates-v2-codex-session",
  sourcePromptHash: workflow.qualityGatePromptHashes["first-quality-gate"],
  renderedPromptHash: sha256(`FIRST_QA\n${question}`),
  response: { provider: "codex-session", model: "gpt-5.6-sol", finishReason: "completed" },
  parsed: { pass: true, issues: [] }
};
const firstRawText = `${JSON.stringify(firstRaw, null, 2)}\n`;
await fs.writeFile(firstRawPath, firstRawText, "utf8");
recordFirstQualityGate(workflow, 1, {
  preQaStructureAudit: {
    uniqueMainTask: true,
    expectedHumanHours: 5,
    expectedKeySteps: 6,
    attachmentCount: 0,
    evidenceBoundaryExplicit: true,
    assessment: "任务需要多源检索、统一口径核验、边界识别与阶段性取舍，不是单一查询。"
  },
  firstQaResult: {
    pass: true,
    issues: [],
    execution: {
      runnerId: firstRaw.runnerId,
      provider: "codex-session",
      model: "gpt-5.6-sol",
      sourcePromptHash: firstRaw.sourcePromptHash,
      renderedPromptHash: firstRaw.renderedPromptHash,
      rawResponsePath: firstRawPath,
      rawResponseHash: sha256(firstRawText),
      completedAt: new Date().toISOString()
    }
  }
});

const secondRawPath = path.join(qaDir, "01_second_language_gate_raw.json");
const secondRaw = {
  schemaVersion: 1,
  kind: "l1-second-language-gate-raw-response",
  runnerId: "exact-two-quality-gates-v2-codex-session",
  sourcePromptHash: workflow.qualityGatePromptHashes["second-language-gate"],
  renderedPromptHash: sha256(`SECOND_QA\n${question}`),
  response: { provider: "codex-session", model: "gpt-5.6-sol", finishReason: "completed" },
  acceptedRound: 1,
  attempts: [{
    round: 1,
    parsed: {
      conclusion: "通过",
      coreJudgement: "题面表达自然，主任务、证据边界和下一轮实测边界均清楚。",
      majorChanges: "无",
      modifiedQuestion: question,
      punctuationCheck: "标点自然，括号成对，没有为指标添加内容。",
      remainingAttention: "执行时不能把厂商公开说明等同于目标租户已开通能力。"
    }
  }]
};
const secondRawText = `${JSON.stringify(secondRaw, null, 2)}\n`;
await fs.writeFile(secondRawPath, secondRawText, "utf8");
recordSecondLanguageGate(workflow, 1, {
  ...secondRaw.attempts[0].parsed,
  execution: {
    runnerId: secondRaw.runnerId,
    provider: "codex-session",
    model: "gpt-5.6-sol",
    sourcePromptHash: secondRaw.sourcePromptHash,
    renderedPromptHash: secondRaw.renderedPromptHash,
    rawResponsePath: secondRawPath,
    rawResponseHash: sha256(secondRawText),
    completedAt: new Date().toISOString()
  }
});

await Promise.all([
  writeJson(path.join(sourceDir, "fact_ledger.json"), factLedger),
  writeJson(path.join(sourceDir, "official_source_research.json"), { kind: "official-source-research-index", runId: factLedger.runId, checkedAt: factLedger.capturedAt, sources: factLedger.materials }),
  writeJson(path.join(sourceDir, "scene_card_seed.json"), { sceneCard, validation: sceneValidation }),
  writeJson(path.join(draftDir, "01_pre_de_ai.json"), { kind: "l1-question-draft", sourceRecord, breakdown, attachmentPlan, firstQa: workflow.questions[0].firstQaFullResult, secondQa: workflow.questions[0].secondQaFullResult }),
  saveProductionWorkflow(workflowPath, workflow)
]);

console.log(JSON.stringify({ state: workflow.questions[0].state, questionLength: [...question.replace(/\s+/gu, "")].length, sceneCard: sceneValidation.ok, firstQa: true, secondQa: true }, null, 2));
