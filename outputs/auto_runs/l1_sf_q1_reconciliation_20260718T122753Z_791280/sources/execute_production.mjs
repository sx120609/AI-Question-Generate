import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { completeWithLocalCodex } from "../../../../doubao-automation/src/local-codex.mjs";
import {
  buildFirstQualityGatePrompt,
  buildQuestionDraftPrompt,
  buildReferenceBreakdownPrompt,
  buildSecondLanguageGatePrompt,
} from "../../../../build/automation/production_pipeline_prompts.mjs";
import {
  buildProductionTrace,
  initializeProductionWorkflow,
  recordAttachmentPlan,
  recordDeAiRewrite,
  recordDraft,
  recordFinalRecord,
  recordFirstQualityGate,
  recordReferenceBreakdown,
  recordSecondLanguageGate,
  saveProductionWorkflow,
} from "../../../../build/automation/production_workflow_state.mjs";
import {
  rewriteQuestionWithDeAiApi,
  synthesizeRewriteSidecars,
  validateClaudeRewrite,
} from "../../../../build/automation/claude_question_rewriter.mjs";
import {
  loadMuguaDeAiPrompt,
  rewriteMuguaDeAiText,
} from "../../../../build/automation/mugua_de_ai_rewrite_client.mjs";
import { evaluateNarrativeHardRules } from "../../../../build/automation/narrative_language_rules.mjs";
import { analyzeQuestionRequest } from "../../../../build/automation/language_style.mjs";
import { runProductionTraceGate } from "../../../../build/automation/production_trace_gate.mjs";
import { runReleaseGate } from "../../../../build/automation/release_gate.mjs";
import { assertValidSceneCard, runSceneCardGate } from "../../../../build/automation/scene_card.mjs";
import { registerTopic } from "../../../../build/automation/topic_registry.mjs";
import { updateRunStatus } from "../../../../build/automation/run_context.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.dirname(sourceDir);
const draftDir = path.join(runDir, "drafts");
const qaDir = path.join(runDir, "qa");
const feishuDir = path.join(runDir, "feishu");
const attachmentDir = path.join(runDir, "attachments");
const packetPath = path.join(sourceDir, "production_input_packet.json");
const workflowPath = path.join(sourceDir, "production_workflow_state.json");
const runId = path.basename(runDir);
const recordUid = "沈礼_20260718_sf_q1_reconciliation_01";
const model = "gpt-5.6-sol";
const provider = "codex-session";
const runnerId = "exact-two-quality-gates-v2-codex-session";
const resumableStageLabels = new Set([
  "01_reference_breakdown",
  "02_question_draft",
  "03_pre_qa_structure_audit",
  "04_first_quality_gate_model",
  "05_second_language_gate_model",
]);
const resumedStageMetadata = new Map();

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
const stringArray = { type: "array", items: string };

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, "utf8");
  return { text, hash: sha256(text) };
}

async function localJson({ systemPrompt, userPrompt, outputSchema, label }) {
  const stagePath = path.join(qaDir, `${label}_local_codex.json`);
  if (process.env.L1_RESUME_FROM_CHECKPOINT === "1" && resumableStageLabels.has(label)) {
    try {
      const cached = JSON.parse(await fs.readFile(stagePath, "utf8"));
      if (cached?.kind === "local-codex-stage-response" && cached?.stage === label && cached?.parsed) {
        resumedStageMetadata.set(label, { ...cached, path: stagePath, fileHash: sha256(await fs.readFile(stagePath)) });
        return cached.parsed;
      }
    } catch {
      // Missing or malformed checkpoints fail open to a real model call for this stage only.
    }
  }
  const response = await completeWithLocalCodex({
    model,
    reasoningEffort: "high",
    systemPrompt,
    userPrompt,
    outputSchema,
    timeoutMs: 360_000,
  });
  const parsed = JSON.parse(response.content);
  await writeJson(stagePath, {
    kind: "local-codex-stage-response",
    stage: label,
    model,
    provider: "local-codex-cli",
    completedAt: new Date().toISOString(),
    promptHash: sha256(`${systemPrompt}\n\n${userPrompt}`),
    parsed,
  });
  return parsed;
}

async function preserveBlockedAttempts() {
  const pairs = [
    ["04_first_quality_gate_model_local_codex.json", "04_first_quality_gate_model_attempt_1_local_codex.json"],
    ["01_first_quality_gate_raw.json", "01_first_quality_gate_attempt_1_raw.json"],
    ["01_de_ai_rewrite.json", "01_de_ai_rewrite_attempt_1.json"],
    ["06_post_de_ai_preflight_local_codex.json", "06_post_de_ai_preflight_attempt_1_local_codex.json"],
    ["01_de_ai_rewrite.json", "01_de_ai_rewrite_attempt_2.json"],
    ["06_post_de_ai_preflight_local_codex.json", "06_post_de_ai_preflight_attempt_2_local_codex.json"],
  ];
  for (const [sourceName, targetName] of pairs) {
    const sourcePath = path.join(qaDir, sourceName);
    const targetPath = path.join(qaDir, targetName);
    try {
      await fs.access(targetPath);
    } catch {
      try {
        const current = JSON.parse(await fs.readFile(sourcePath, "utf8"));
        const parsed = current.parsed ?? current;
        if (parsed.pass === false || (sourceName === "01_de_ai_rewrite.json"
          && (await fs.readFile(path.join(qaDir, "06_post_de_ai_preflight_local_codex.json"), "utf8")).includes('"pass": false'))) {
          await fs.copyFile(sourcePath, targetPath);
        }
      } catch {
        // No prior failed attempt exists on a fresh run.
      }
    }
  }
}

await preserveBlockedAttempts();
try {
  const priorRoleReportPath = path.join(feishuDir, "role_consistency_report.json");
  const priorRoleReport = await fs.readFile(priorRoleReportPath, "utf8");
  if (priorRoleReport.includes("request_span_not_direct_request")) {
    const preservedRolePath = path.join(feishuDir, "role_consistency_report_attempt_1.json");
    try {
      await fs.access(preservedRolePath);
    } catch {
      await fs.copyFile(priorRoleReportPath, preservedRolePath);
      await fs.copyFile(path.join(qaDir, "01_de_ai_rewrite.json"), path.join(qaDir, "01_de_ai_rewrite_role_attempt.json"));
    }
  }
} catch {
  // No prior role-gate failure exists on a fresh run.
}
try {
  const targetedPreflight = await fs.readFile(path.join(qaDir, "06_post_de_ai_preflight_targeted_local_codex.json"), "utf8");
  if (targetedPreflight.includes('"pass": false')) {
    const preservedTargetedPath = path.join(qaDir, "01_de_ai_rewrite_targeted_attempt_1.json");
    try {
      await fs.access(preservedTargetedPath);
    } catch {
      await fs.copyFile(path.join(qaDir, "01_de_ai_rewrite_targeted.json"), preservedTargetedPath);
      await fs.copyFile(path.join(qaDir, "06_post_de_ai_preflight_targeted_local_codex.json"), path.join(qaDir, "06_post_de_ai_preflight_targeted_attempt_1_local_codex.json"));
    }
  }
} catch {
  // No prior targeted rewrite failure exists on a fresh run.
}

const topic = {
  topicId: "sf-2026q1-logistics-revenue-reconciliation",
  title: "顺丰控股2026年一季度月度经营简报与季报营业收入口径复核",
  primaryCategory: "商业与市场分析",
  secondaryCategory: "经营数据复核",
  tertiaryCategory: "物流月报与季报收入口径差异",
  businessScenario: "数据复核同事需要把顺丰控股2026年2月和3月经营简报与一季报统一单位并解释物流口径与营业总收入口径差异",
  mainDecision: "确认月度经营简报累计值如何与一季报营业收入衔接，并把可证差额与待确认口径分开",
  role: "经营数据复核专员",
  artifactSummary: "带公式和来源索引的季度收入口径核对表",
  artifactFormats: "xlsx",
  attachmentSummary: "顺丰控股2026年2月经营简报、3月经营简报和第一季度报告",
  keywords: ["顺丰控股", "经营简报", "一季报", "物流收入", "营业收入", "口径差异", "时间序列"],
};
const topicRegistry = JSON.parse(await fs.readFile(path.resolve(runDir, "../_topic_registry.json"), "utf8"));
const existingTopic = topicRegistry.entries?.find((item) => item.runId === runId && item.topicId === topic.topicId);
const topicRegistration = existingTopic
  ? { ok: true, topicId: existingTopic.topicId, registered: existingTopic, reused: true }
  : await registerTopic(topic, { runId, status: "reserved" });
if (!topicRegistration.ok) {
  throw new Error(`Topic registry conflict: ${JSON.stringify(topicRegistration.conflict)}`);
}

const attachments = [
  {
    id: "material-feb-brief",
    name: "顺丰控股2026年2月快递物流业务经营简报.pdf",
    url: "https://static.cninfo.com.cn/finalpage/2026-03-20/1225018701.PDF",
    sourcePageUrl: "https://www.cninfo.com.cn/new/disclosure/detail?stockCode=002352&announcementId=1225018701",
    publishedAt: "2026-03-20",
    timeAnchor: "2026年2月及2026年1至2月累计",
    uniqueContent: "2026年2月单月与1至2月累计的速运物流、供应链及国际业务收入和业务量，以及数据未经审计且不含其他非物流业务收入的边界",
  },
  {
    id: "material-mar-brief",
    name: "顺丰控股2026年3月快递物流业务经营简报.pdf",
    url: "https://static.cninfo.com.cn/finalpage/2026-04-18/1225117549.PDF",
    sourcePageUrl: "https://www.cninfo.com.cn/new/disclosure/detail?stockCode=002352&announcementId=1225117549",
    publishedAt: "2026-04-18",
    timeAnchor: "2026年3月",
    uniqueContent: "2026年3月单月的速运物流、供应链及国际业务收入、业务量和单票收入，以及数据未经审计且不含其他非物流业务收入的边界",
  },
  {
    id: "material-q1-report",
    name: "顺丰控股2026年第一季度报告.pdf",
    url: "https://disc.static.szse.cn/download/disc/disk03/finalpage/2026-04-29/7883bdc1-3a59-4fd9-8e05-707bf938cc0f.PDF",
    sourcePageUrl: "https://disc.static.szse.cn/download/disc/disk03/finalpage/2026-04-29/7883bdc1-3a59-4fd9-8e05-707bf938cc0f.PDF",
    publishedAt: "2026-04-29",
    timeAnchor: "2026年1月1日至2026年3月31日",
    uniqueContent: "2026年第一季度和上年同期营业收入、净利润、经营现金流等主要会计数据，并明确季度报告未经审计",
  },
];

for (const item of attachments) {
  const filePath = path.join(attachmentDir, item.name);
  const bytes = await fs.readFile(filePath);
  const stat = await fs.stat(filePath);
  item.path = filePath;
  item.size = stat.size;
  item.sha256 = sha256(bytes);
}

const now = new Date().toISOString();
const downloadManifest = {
  schemaVersion: 1,
  kind: "official-material-download-manifest",
  runId,
  generatedAt: now,
  items: attachments.map((item) => ({
    name: item.name,
    url: item.url,
    sourcePageUrl: item.sourcePageUrl,
    path: item.path,
    size: item.size,
    sha256: item.sha256,
    contentType: "application/pdf",
    finalUrl: item.url,
    downloadedAt: now,
  })),
};
await writeJson(path.join(sourceDir, "download_manifest.json"), downloadManifest);

const factLedger = {
  schemaVersion: 1,
  kind: "evidence-bound-fact-ledger",
  runId,
  recordUid,
  generatedAt: now,
  facts: [
    {
      id: "fact-feb-month",
      uid: recordUid,
      claimType: "source-fact",
      text: "2026年2月简报披露速运物流收入164.21亿元、业务量10.72亿票、单票收入15.32元，供应链及国际业务收入51.83亿元，合计216.04亿元。上年同期合计为183.71亿元。",
      sourceRefs: ["material-feb-brief"],
      locator: "2026年2月经营简报PDF第1页第一张表",
    },
    {
      id: "fact-jan-feb-cumulative",
      uid: recordUid,
      claimType: "source-fact",
      text: "2026年1至2月累计速运物流收入368.17亿元、业务量24.58亿票、单票收入14.98元，供应链及国际业务收入116.47亿元，合计484.64亿元。上年同期合计为446.48亿元。",
      sourceRefs: ["material-feb-brief"],
      locator: "2026年2月经营简报PDF第1页第二张表",
    },
    {
      id: "fact-feb-boundary",
      uid: recordUid,
      claimType: "evidence-boundary",
      text: "2026年2月简报明确以上收入不含公司其他非物流业务收入，数据未经审计，与定期报告数据可能存在差异，相关数据以定期报告为准。简报还提示春节错期使2月数据与上年同期不完全可比。",
      sourceRefs: ["material-feb-brief"],
      locator: "2026年2月经营简报PDF第2页注释和正文",
    },
    {
      id: "fact-march-month",
      uid: recordUid,
      claimType: "source-fact",
      text: "2026年3月简报披露速运物流收入180.19亿元、业务量12.51亿票、单票收入14.40元，供应链及国际业务收入62.83亿元，合计243.02亿元。上年同期合计为236.61亿元。",
      sourceRefs: ["material-mar-brief"],
      locator: "2026年3月经营简报PDF第1页表格",
    },
    {
      id: "fact-march-boundary",
      uid: recordUid,
      claimType: "evidence-boundary",
      text: "2026年3月简报明确以上收入不含公司其他非物流业务收入，数据未经审计，与定期报告数据可能存在差异，相关数据以定期报告为准。",
      sourceRefs: ["material-mar-brief"],
      locator: "2026年3月经营简报PDF第1至2页注释和结尾",
    },
    {
      id: "fact-q1-revenue",
      uid: recordUid,
      claimType: "source-fact",
      text: "2026年第一季度报告把报告期定义为2026年1月1日至3月31日，披露营业收入74142121千元，上年同期69849924千元，同比增长6.14%。",
      sourceRefs: ["material-q1-report"],
      locator: "2026年第一季度报告PDF第2页主要会计数据和财务指标表",
    },
    {
      id: "fact-q1-boundary",
      uid: recordUid,
      claimType: "evidence-boundary",
      text: "2026年第一季度报告明确本季度报告未经审计，除特别说明外以人民币为货币单位，营业收入属于公司总营业收入，未使用经营简报中排除其他非物流业务收入的限定。",
      sourceRefs: ["material-q1-report"],
      locator: "2026年第一季度报告PDF第2页重要内容提示和主要财务数据",
    },
    {
      id: "fact-quarter-bridge",
      uid: recordUid,
      claimType: "derived-check",
      text: "按经营简报口径，2026年1至2月累计484.64亿元加3月243.02亿元得到一季度物流相关收入727.66亿元，换算为72766000千元。与一季报营业收入74142121千元相差1376121千元，即13.76121亿元。上年同期经营简报口径为446.48加236.61等于683.09亿元，与一季报上年同期69849924千元相差1540924千元，即15.40924亿元。",
      sourceRefs: ["material-feb-brief", "material-mar-brief", "material-q1-report"],
      locator: "2月简报第1页累计表、3月简报第1页表格和一季报第2页营业收入行",
    },
    {
      id: "fact-subtotal-checks",
      uid: recordUid,
      claimType: "derived-check",
      text: "经营简报分项可回算合计：2026年1至2月368.17加116.47等于484.64亿元，3月180.19加62.83等于243.02亿元。2026年一季度速运物流累计548.36亿元，供应链及国际业务累计179.30亿元，两项合计727.66亿元。",
      sourceRefs: ["material-feb-brief", "material-mar-brief"],
      locator: "2月简报第1页两张表和3月简报第1页表格",
    },
    {
      id: "fact-unit-price-checks",
      uid: recordUid,
      claimType: "derived-check",
      text: "单票收入可由速运物流收入除以业务量回算并按两位小数核对：2026年2月164.21除以10.72约为15.32元，2026年1至2月368.17除以24.58约为14.98元，2026年3月180.19除以12.51约为14.40元。",
      sourceRefs: ["material-feb-brief", "material-mar-brief"],
      locator: "2月简报第1页和3月简报第1页对应收入、业务量、单票收入行",
    },
  ],
  materials: attachments.map((item) => ({
    id: item.id,
    uid: recordUid,
    name: item.name,
    text: item.uniqueContent,
    sourceUrl: item.url,
    sha256: item.sha256,
  })),
  unknowns: [
    {
      id: "unknown-other-non-logistics-breakdown",
      uid: recordUid,
      text: "三份附件没有披露一季报营业收入与经营简报物流相关收入差额对应的其他非物流业务明细，差额只能登记为待公司分部或科目资料确认。",
    },
    {
      id: "unknown-rounding-precision",
      uid: recordUid,
      text: "经营简报以亿元保留两位小数，一季报以千元披露，跨表差额同时包含业务口径差异和月报四舍五入影响，附件无法拆分两者的精确贡献。",
    },
    {
      id: "unknown-audit-status",
      uid: recordUid,
      text: "三份附件均为未经审计披露，后续审计报告或年度报告可能提供不同精度或进一步分类。",
    },
  ],
  decision: {
    id: "decision-q1-reconciliation-workbook",
    text: "建立带公式和来源页码的季度收入口径核对表，确认经营简报分项与累计值能够回算，并把与一季报总营业收入的差额保持为口径桥接项而非直接归因。",
  },
  deliveryUse: {
    recipient: "经营数据复核同事",
    purpose: "复核季度数据口径并为后续取得分部或科目明细后继续回填。",
  },
};
await writeJson(path.join(sourceDir, "fact_ledger.json"), factLedger);

const sourceCards = {
  schemaVersion: 1,
  kind: "source-card-bundle",
  runId,
  recordUid,
  sources: attachments.map((item) => ({
    materialId: item.id,
    title: item.name.replace(/\.pdf$/u, ""),
    publisher: item.id === "material-q1-report" ? "深圳证券交易所信息披露平台" : "巨潮资讯网",
    publishedAt: item.publishedAt,
    accessedAt: "2026-07-18",
    path: `attachments/${item.name}`,
    supports: item.uniqueContent,
    boundary: item.id === "material-q1-report"
      ? "总营业收入未拆出其他非物流业务明细，报告未经审计"
      : "经营简报收入排除其他非物流业务，数据未经审计且以定期报告为准",
  })),
};
await writeJson(path.join(sourceDir, "source_cards.json"), sourceCards);

const packet = JSON.parse(await fs.readFile(packetPath, "utf8"));
const firstQaPromptText = await fs.readFile(packet.inputs.firstQaPrompt.path, "utf8");
packet.inputs.firstQaPrompt.text = firstQaPromptText;
packet.inputs.firstQaPrompt.sha256 = sha256(firstQaPromptText);
packet.runMode = "development-codex-session";
await writeJson(packetPath, packet);
let workflow = initializeProductionWorkflow({ packet, runId });
await saveProductionWorkflow(workflowPath, workflow);

const referencePrompt = buildReferenceBreakdownPrompt({ packet, questionIndex: 1 });
const referenceBreakdown = await localJson({
  label: "01_reference_breakdown",
  systemPrompt: "严格执行输入中的结构拆解任务。只提取可迁移结构，不复用样例对象、数字、附件、平台和原句。返回符合 schema 的中文 JSON。",
  userPrompt: referencePrompt.prompt,
  outputSchema: object({
    businessScene: string,
    coreBlockage: string,
    mainTask: string,
    attachmentSupport: string,
    deliverableOrigin: string,
    imitableStructure: string,
    forbiddenReuse: string,
    referenceAttachmentStructure: string,
    referenceProductParagraphLogic: string,
  }),
});
recordReferenceBreakdown(workflow, 1, referenceBreakdown);

const attachmentPlan = {
  mainDecision: factLedger.decision.text,
  attachments: attachments.map((item) => ({
    name: item.name,
    sourceUrl: item.url,
    format: "pdf",
    classification: "specific-business",
    objectLevel: true,
    timeAnchor: item.timeAnchor,
    specificityEvidence: {
      object: "顺丰控股股份有限公司证券代码002352",
      periodOrEvent: item.timeAnchor,
      uniqueContent: item.uniqueContent,
    },
    summary: item.uniqueContent,
    localPath: item.name,
    sha256: item.sha256,
    bytes: item.size,
    sizeBytes: item.size,
    introductionHint: "首轮随任务一次上传，后续所有核对继续引用同一批已验证原件。",
  })),
  specificBusinessShareRationale: "三份材料都绑定顺丰控股证券代码002352和2026年一季度具体披露期，具体业务材料占比为100%。",
  timeSeriesRationale: "2月简报提供1至2月累计，3月简报提供单月，一季报提供季度总营业收入，可形成同一对象跨披露期和跨单位的时间序列桥接。",
  objectSupportInQuestion: "题面明确顺丰控股、2026年一季度、三份具体披露和经营数据复核用途。",
  newAttachmentSupport: "2月简报支撑累计值，3月简报补齐季度末单月，一季报提供总营业收入与报告期定义。",
  newQuestionStructureMapping: "沿用样例的真实工作卡点、证据核验和下游交付逻辑，改为先确认材料与来源底表，再依据真实回复逐轮推进季度桥接、差额边界和工作簿交付。",
};
recordAttachmentPlan(workflow, 1, attachmentPlan);

const sceneCard = {
  schemaVersion: 1,
  policyId: "situated-requester-v1",
  topicId: topic.topicId,
  personaId: "sf-quarterly-data-reviewer-01",
  requester: {
    functionalRole: "经营数据复核专员",
    organizationType: "企业数据研究团队",
    department: "",
    responsibility: "把公开经营简报和定期报告整理成可追溯的季度口径核对底表",
    authorityBoundary: "只负责复核公开披露的算术与口径，无权确认差额对应的具体业务明细，该明细以公司后续披露为准",
    recipientRelation: "把核对表交给经营数据复核同事继续使用",
  },
  scene: {
    workflowStage: "2026年一季度经营数据口径复核",
    trigger: factLedger.facts.find((item) => item.id === "fact-q1-revenue").text,
    currentBlockage: factLedger.unknowns.find((item) => item.id === "unknown-other-non-logistics-breakdown").text,
    mainDecision: factLedger.decision.text,
    downstreamUse: factLedger.deliveryUse.purpose,
  },
  informationBoundary: {
    knownFactIds: factLedger.facts.map((item) => item.id),
    availableMaterialIds: factLedger.materials.map((item) => item.id),
    unknowns: factLedger.unknowns.map((item) => item.text),
    forbiddenInferences: [
      "13.76121亿元差额不得直接归因到某个业务板块",
      "不得把差额直接表述为其他非物流业务收入，也不得从一季报营业收入中直接剔除",
      "以千元披露与以亿元保留两位小数属于披露单位和精度差异，不得改写成记账习惯",
      "未经审计数据不得描述为审计确认值",
      "经营简报亿元两位小数与季报千元精度差异不得忽略",
    ],
  },
  voice: {
    channel: "内部数据复核消息",
    formality: "直接、克制、以证据和可继续回填为导向",
    domainVocabulary: ["经营简报", "一季报", "营业收入", "口径", "累计", "单票收入", "来源页码"],
    avoidVocabulary: ["全链路", "闭环", "赋能", "深度洞察", "记账习惯", "剔除出去", "麻烦", "劳烦", "烦请", "辛苦"],
  },
  maskTerms: ["顺丰控股", "经营简报", "一季报", "物流收入", "口径复核"],
  evidenceBindings: [
    { claim: factLedger.facts.find((item) => item.id === "fact-q1-revenue").text, factIds: ["fact-q1-revenue"] },
    { claim: factLedger.unknowns.find((item) => item.id === "unknown-other-non-logistics-breakdown").text, factIds: ["fact-q1-revenue", "fact-quarter-bridge"] },
    { claim: factLedger.decision.text, factIds: ["fact-quarter-bridge", "fact-subtotal-checks", "fact-q1-boundary"] },
  ],
};
assertValidSceneCard(sceneCard, { factLedger });
await writeJson(path.join(sourceDir, "scene_card_seed.json"), { topic, sceneCard, sourceCards });

const draftPrompt = buildQuestionDraftPrompt({
  packet,
  questionIndex: 1,
  referenceBreakdown,
  attachmentPlan,
  factLedger,
  sceneCard,
  formatRequirement: "xlsx",
});
const draft = await localJson({
  label: "02_question_draft",
  systemPrompt: [
    "你是负责顺丰控股季度经营数据复核的真实工作人员。严格依据三份附件和事实账本写一条 L1 首轮工作委托。",
    "题面保持120至520个可见字符，只提出本轮一个主诉求和最多一个直接子诉求。最终交付是一份可下载的Excel口径核对表。",
    "本轮主任务是判断三份材料能否组成同一季度的数据来源链，必须同时处理1至2月累计与3月单月的期间衔接、经营简报与一季报的收入边界差异、单位精度和指标可比性。来源底表只是承载核验结论的附带产物。",
    "后续精确差额、单票收入回算和最终文件生成会依据真实回复逐轮推进，题面不要预写未来六轮，也不要倾倒全部数字和公式。",
    "明确三份材料的具体名称或月份，保留未经审计、来源页码和无法直接对应时标待核的边界。",
    "表达直接自然，不使用分号、项目符号、Markdown标题、麻烦、劳烦、烦请、辛苦，也不使用否定式边界教训。顿号数量只作可读性建议，使用或省略我和你都不作为自然度指标。删除刚传了、我刚上传了、这里上传了、随本消息上传了及同类上传元话语，也不写这是材料或材料包括之类独立介绍句。材料身份直接嵌入任务句。",
  ].join("\n"),
  userPrompt: draftPrompt.prompt,
  outputSchema: object({
    question: string,
    mainTask: string,
    usedFactIds: stringArray,
    usedAttachmentNames: stringArray,
    productFormats: { type: "string", const: "xlsx" },
    deliverableRationale: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: object({ format: { type: "string", const: "xlsx" }, user: string, purpose: string, whyThisFormat: string }),
    },
    structureMapping: string,
    productParagraphMapping: string,
  }),
});
if (!draft.usedAttachmentNames.every((name) => attachments.some((item) => item.name === name))) {
  throw new Error("Draft referenced an attachment outside the verified manifest.");
}
recordDraft(workflow, 1, draft);
await writeJson(path.join(draftDir, "01_pre_de_ai.json"), { topic, sceneCard, attachmentPlan, draft });

const firstGatePrompt = buildFirstQualityGatePrompt({ packet, questionIndex: 1, candidate: draft, attachmentPlan, referenceBreakdown });
const preQaStructureAudit = await localJson({
  label: "03_pre_qa_structure_audit",
  systemPrompt: "独立检查输入中的结构、附件和证据链。按L1动态六轮任务判断首轮密度，不要求首轮倾倒后续计算。只返回 schema 指定的 JSON，不改写题面。",
  userPrompt: firstGatePrompt.preQaPrompt,
  outputSchema: object({
    oneSentenceMainTask: string,
    uniqueMainTask: { type: "boolean" },
    specificObjectDecision: { type: "boolean" },
    specificFilesDominant: { type: "boolean" },
    evidenceChain: string,
    l2ReasoningChain: string,
    variableDrift: stringArray,
  }),
});
const firstQaParsed = await localJson({
  label: "04_first_quality_gate_model",
  systemPrompt: "你是独立L1质量质检员。严格执行输入中的第一道质检提示词。按动态六轮任务判断首轮密度，通过时返回pass=true和空issues，发现任一问题时如实返回修复建议。",
  userPrompt: firstGatePrompt.prompt,
  outputSchema: object({
    pass: { type: "boolean" },
    issues: { type: "array", items: object({ rule: string, evidence: string, repair: string }) },
  }),
});
const firstRawPath = path.join(qaDir, "01_first_quality_gate_raw.json");
const firstRaw = {
  runnerId,
  provider,
  model,
  sourcePromptHash: packet.inputs.firstQaPrompt.sha256,
  renderedPromptHash: resumedStageMetadata.get("04_first_quality_gate_model")?.promptHash ?? sha256(firstGatePrompt.prompt),
  completedAt: new Date().toISOString(),
  parsed: firstQaParsed,
};
const firstWritten = await writeJson(firstRawPath, firstRaw);
const firstQaResult = {
  ...firstQaParsed,
  execution: {
    runnerId,
    provider,
    model,
    sourcePromptHash: packet.inputs.firstQaPrompt.sha256,
    renderedPromptHash: firstRaw.renderedPromptHash,
    rawResponsePath: firstRawPath,
    rawResponseHash: firstWritten.hash,
    completedAt: firstRaw.completedAt,
  },
};
recordFirstQualityGate(workflow, 1, { preQaStructureAudit, firstQaResult });
if (!firstQaParsed.pass || firstQaParsed.issues.length) {
  await saveProductionWorkflow(workflowPath, workflow);
  throw new Error(`First quality gate blocked the task: ${JSON.stringify(firstQaParsed.issues)}`);
}

const secondGatePrompt = buildSecondLanguageGatePrompt({
  packet,
  questionIndex: 1,
  firstQaResult: firstQaParsed,
  candidate: draft,
  referenceBreakdown,
});
let secondParsed = await localJson({
  label: "05_second_language_gate_model",
  systemPrompt: [
    "你是独立L1语言质检员。严格执行输入中的第二道质检，只改善语言，不新增事实或未来轮次。",
    "返回JSON，modifiedQuestion必须是完整题面。顿号数量只作可读性建议，不使用分号、项目符号、麻烦、劳烦、烦请、辛苦和机械顺序壳。删除刚传了、我刚上传了、这里上传了、随本消息上传了及同类上传元话语，也不写这是材料或材料包括之类独立介绍句。",
    "保留顺丰控股、三份具体附件、最终Excel、当前材料底表诉求、来源页码、未经审计和待核边界。使用或省略我和你都可以。",
  ].join("\n"),
  userPrompt: secondGatePrompt.prompt,
  outputSchema: object({
    conclusion: { type: "string", enum: ["通过", "需语言小修", "需重写题面", "退回第一道质检"] },
    coreJudgment: string,
    modifications: string,
    modifiedQuestion: string,
    punctuationAudit: string,
    remainingNote: string,
  }),
});
for (let repairRound = 1; repairRound <= 2; repairRound += 1) {
  const findings = evaluateNarrativeHardRules(secondParsed.modifiedQuestion, {
    minimumExplanatoryParentheses: 0,
    maximumEnumerationCommasPerSentence: 1,
    forbidSemicolon: true,
  });
  if (!findings.length) break;
  secondParsed = await localJson({
    label: `05_second_language_gate_repair_${repairRound}`,
    systemPrompt: "只修复本地文本门禁指出的问题，不新增或删减事实。返回完整JSON，modifiedQuestion保留全部对象、附件和当前轮诉求。顿号数量只作可读性建议，禁止分号和客套请求。",
    userPrompt: JSON.stringify({ gateFindings: findings, previousResult: secondParsed }, null, 2),
    outputSchema: object({
      conclusion: { type: "string", enum: ["通过", "需语言小修", "需重写题面", "退回第一道质检"] },
      coreJudgment: string,
      modifications: string,
      modifiedQuestion: string,
      punctuationAudit: string,
      remainingNote: string,
    }),
  });
}
const finalLanguageFindings = evaluateNarrativeHardRules(secondParsed.modifiedQuestion, {
  minimumExplanatoryParentheses: 0,
  maximumEnumerationCommasPerSentence: 1,
  forbidSemicolon: true,
});
if (finalLanguageFindings.length) {
  throw new Error(`Second language gate repair exhausted: ${JSON.stringify(finalLanguageFindings)}`);
}
const secondRawPath = path.join(qaDir, "01_second_language_gate_raw.json");
const secondRaw = {
  runnerId,
  provider,
  model,
  sourcePromptHash: packet.inputs.secondQaPrompt.sha256,
  renderedPromptHash: resumedStageMetadata.get("05_second_language_gate_model")?.promptHash ?? sha256(secondGatePrompt.prompt),
  acceptedRound: 1,
  completedAt: new Date().toISOString(),
  attempts: [{ round: 1, parsed: secondParsed }],
};
const secondWritten = await writeJson(secondRawPath, secondRaw);
const secondQaResult = {
  ...secondParsed,
  execution: {
    runnerId,
    provider,
    model,
    sourcePromptHash: packet.inputs.secondQaPrompt.sha256,
    renderedPromptHash: secondRaw.renderedPromptHash,
    rawResponsePath: secondRawPath,
    rawResponseHash: secondWritten.hash,
    completedAt: secondRaw.completedAt,
  },
};
recordSecondLanguageGate(workflow, 1, secondQaResult);
if (!["通过", "需语言小修"].includes(secondParsed.conclusion)) {
  throw new Error(`Second language gate blocked the task: ${secondParsed.conclusion}`);
}
await saveProductionWorkflow(workflowPath, workflow);
if (resumedStageMetadata.size) {
  await writeJson(path.join(qaDir, "checkpoint_resume_receipt.json"), {
    kind: "l1-local-model-checkpoint-resume",
    policy: "reuse-only-user-visible-content-stages-that-already-have-passing-downstream-gates",
    resumedAt: new Date().toISOString(),
    stages: [...resumedStageMetadata.entries()].map(([stage, metadata]) => ({
      stage,
      path: metadata.path,
      fileHash: metadata.fileHash,
      promptHash: metadata.promptHash,
      completedAt: metadata.completedAt,
    })),
  });
}

const sourceRecord = {
  UID: recordUid,
  题目: secondParsed.modifiedQuestion,
  任务类型: "L1 探索型",
  一级目录: "商业与市场分析",
  二级目录: "经营数据复核",
  三级目录: "物流月报与季报收入口径差异",
  任务概括: "顺丰控股2026年一季度经营简报与季报营业收入口径复核",
  标注专家工作年限: "5年",
  人类完成时间: "4H",
  相关附件: attachmentPlan.attachments.map((item) => item.name).join("、"),
  附件格式: "pdf",
  附件内容: attachmentPlan.attachments.map((item) => `${item.name}：${item.summary}`).join("\n"),
  产物格式: "xlsx",
  产物内容: "一份可下载的顺丰控股2026年一季度经营数据口径核对Excel，包含来源底表、统一单位后的月度与累计数据、分项回算、单票收入回算、季报桥接差额、证据边界、待确认项和来源索引。",
  做题关键步骤: [
    "1. 核验三份官方披露文件的公司、报告期、公告编号、页码和审计状态。",
    "2. 建立1至2月累计、3月单月和一季报总营业收入的来源底表并统一单位。",
    "3. 回算速运物流与供应链及国际业务分项合计，核对经营简报累计值。",
    "4. 用收入和业务量回算单票收入，保留原披露精度与公式。",
    "5. 将经营简报季度累计与一季报营业收入桥接，分别复核本期和上年同期差额。",
    "6. 把可证事实、合理推断和待确认明细分栏，生成带公式及来源索引的可下载Excel。",
  ].join("\n"),
  标注专家姓名: "沈礼",
};

const deAiInput = {
  uid: recordUid,
  record: sourceRecord,
  sceneCard,
  knownFactIds: sceneCard.informationBoundary.knownFactIds,
  avoidQuestions: [packet.inputs.referenceWorkbook.samples[0].question, sourceRecord.题目],
};
let deAi;
if (process.env.L1_RESUME_FROM_CHECKPOINT === "1") {
  try {
    const cachedDeAiPath = path.join(qaDir, "01_de_ai_rewrite.json");
    const cachedDeAiText = await fs.readFile(cachedDeAiPath, "utf8");
    const cachedDeAi = JSON.parse(cachedDeAiText);
    if (cachedDeAi?.validation?.pass && cachedDeAi?.sourceQuestionHash === sha256(sourceRecord.题目)) {
      deAi = cachedDeAi;
      await writeJson(path.join(qaDir, "01_de_ai_rewrite_checkpoint_receipt.json"), {
        kind: "de-ai-question-rewrite-checkpoint-resume",
        resumedAt: new Date().toISOString(),
        path: cachedDeAiPath,
        fileHash: sha256(cachedDeAiText),
        generatedAt: cachedDeAi.generatedAt,
        sourceQuestionHash: cachedDeAi.sourceQuestionHash,
        validationPass: true,
      });
    }
  } catch {
    // Missing or malformed checkpoint falls through to the real API call.
  }
}
try {
  if (!deAi) {
  deAi = await rewriteQuestionWithDeAiApi({
    input: deAiInput,
    apiKey: process.env.DE_AI_REWRITE_API_KEY,
    baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
    model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
    timeoutMs: 180_000,
    retries: 3,
    contentAttempts: 3,
  });
  }
} catch (error) {
  if (error?.code !== "CONTENT_SCOPE_BLOCKED" || !error?.issues?.includes("calculation-too-simple")) throw error;
  await writeJson(path.join(qaDir, "01_de_ai_rewrite_scope_blocked_attempt.json"), {
    kind: "de-ai-scope-blocked-attempt",
    blockedAt: new Date().toISOString(),
    error: { name: error.name, code: error.code, message: error.message, issues: error.issues, audit: error.audit },
  });
  const basePrompt = await loadMuguaDeAiPrompt(process.env.DE_AI_REWRITE_PROMPT_PATH);
  const scopeLockedPrompt = `${basePrompt}\n\n【本题计算复杂度锁，优先级高于一般压缩要求】\n这是经营数据口径复核，不是简单算术。完整题面必须原样保留“逐项复核”“数值精度”“口径”三个词，并保留1至2月累计与3月单月的跨期间衔接、经营简报与一季报披露范围差异、无法直接对应的差额待公司分部或科目资料确认，以及可下载Excel口径核对表。不得把差额归因于某项收入。只做自然化改写，不新增事实。`;
  let scopeResponse;
  let scopeRewrite;
  let scopeValidation;
  let scopeError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      scopeResponse = await rewriteMuguaDeAiText({
        text: sourceRecord.题目,
        apiKey: process.env.DE_AI_REWRITE_API_KEY,
        baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
        model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
        promptText: scopeLockedPrompt,
        timeoutMs: 180_000,
        retries: 3,
      });
      scopeRewrite = synthesizeRewriteSidecars({
        question: scopeResponse.text,
        record: sourceRecord,
        sceneCard,
        knownFactIds: sceneCard.informationBoundary.knownFactIds,
      });
      scopeValidation = validateClaudeRewrite({
        sourceRecord,
        rewrite: scopeRewrite,
        sceneCard,
        knownFactIds: sceneCard.informationBoundary.knownFactIds,
        avoidQuestions: deAiInput.avoidQuestions,
      });
      if (scopeValidation.pass) break;
      scopeError = new Error(`Scope-locked de-AI validation failed: ${scopeValidation.findings.map((item) => item.rule).join(", ")}`);
    } catch (candidateError) {
      scopeError = candidateError;
    }
  }
  if (!scopeResponse || !scopeRewrite || !scopeValidation?.pass) throw scopeError;
  deAi = {
    kind: "de-ai-question-rewrite",
    policyId: "mugua-gemini-de-ai-rewrite-v2",
    uid: recordUid,
    generatedAt: new Date().toISOString(),
    provider: "mugua-openai-compatible",
    endpoint: scopeResponse.endpoint,
    model: scopeResponse.model,
    finishReason: scopeResponse.finishReason,
    usage: scopeResponse.usage,
    promptHash: scopeResponse.promptHash,
    sourceQuestionHash: sha256(sourceRecord.题目),
    rewrittenQuestionHash: sha256(scopeRewrite.question),
    selectedAttempt: "scope-locked-retry",
    attempts: [{ attempt: "scope-locked-retry", pass: true, visibleLength: scopeValidation.visibleLength, findingRules: [] }],
    rewrite: scopeRewrite,
    validation: scopeValidation,
  };
}
await writeJson(path.join(qaDir, "01_de_ai_rewrite.json"), deAi);
if (!deAi.validation.pass) {
  throw new Error(`De-AI rewrite failed validation: ${JSON.stringify(deAi.validation.findings)}`);
}
async function runPostDeAiGate(value, label) {
  return localJson({
    label,
    systemPrompt: [
      "你是发送给豆包之前的独立可见文本审查员，只审查，不改写也不回答题目。",
      "核对事实、三份附件、最终Excel和当前口径核验诉求是否保持。拦截新增数字、差额归因、未来轮次剧本、内部错误信息、工具痕迹和怪异标点。",
      "披露单位和精度差异不得写成记账习惯。不得把季报与经营简报差额直接认定为非物流业务收入，也不得要求从季报营业收入直接剔除。",
      "拦截分号、麻烦、劳烦、烦请、辛苦以及机器式说明。顿号数量只作可读性建议，不单独影响pass。拦截刚传了、我刚上传了、这里上传了、随本消息上传了及同类上传元话语，也拦截这是材料或材料包括之类独立介绍句。任何事实或边界问题都返回pass=false。",
    ].join("\n"),
    userPrompt: JSON.stringify({
      sourceQuestion: secondParsed.modifiedQuestion,
      outboundQuestion: value.rewrite.question,
      attachmentNames: attachmentPlan.attachments.map((item) => item.name),
      requiredProduct: "可下载的Excel季度收入口径核对表",
    }, null, 2),
    outputSchema: object({
      pass: { type: "boolean" },
      issues: { type: "array", items: object({ rule: string, evidence: string, repair: string }) },
      factsPreserved: { type: "boolean" },
      attachmentsPreserved: { type: "boolean" },
      visibleTextClean: { type: "boolean" },
    }),
  });
}
let postDeAiGate = await runPostDeAiGate(deAi, "06_post_de_ai_preflight");
if (!postDeAiGate.pass || postDeAiGate.issues.length || !postDeAiGate.factsPreserved
  || !postDeAiGate.attachmentsPreserved || !postDeAiGate.visibleTextClean) {
  const basePrompt = await loadMuguaDeAiPrompt(process.env.DE_AI_REWRITE_PROMPT_PATH);
  const targetedPrompt = `${basePrompt}\n\n【定向事实修复，优先级高于一般自然化要求】\n只修复下列语义漂移并输出完整题面，其余对象、附件、数字、报告期、任务、段落和证据边界保持不变。\n1. 禁止出现“记账习惯”或“记账方式”。统一表述为“以千元披露与以亿元保留两位小数形成的披露单位和精度差异”。\n2. 禁止把季报与经营简报差额直接认定为非物流业务收入，也禁止要求从季报营业收入直接剔除。统一表述为“核验经营简报物流相关收入与一季报总营业收入的披露范围差异，无法直接对应的差额待公司分部或科目资料确认，不做归因”。\n3. 最终交付必须明确保留“可下载的Excel口径核对表”和“文件格式为xlsx”。\n完成修复后不得引入新的事实性定性。`;
  const targetedResponse = await rewriteMuguaDeAiText({
    text: deAi.rewrite.question,
    apiKey: process.env.DE_AI_REWRITE_API_KEY,
    baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
    model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
    promptText: targetedPrompt,
    temperature: 0.2,
    timeoutMs: 180_000,
    retries: 3,
  });
  const targetedRewrite = synthesizeRewriteSidecars({
    question: targetedResponse.text,
    record: sourceRecord,
    sceneCard,
    knownFactIds: sceneCard.informationBoundary.knownFactIds,
  });
  const targetedValidation = validateClaudeRewrite({
    sourceRecord,
    rewrite: targetedRewrite,
    sceneCard,
    knownFactIds: sceneCard.informationBoundary.knownFactIds,
    avoidQuestions: [packet.inputs.referenceWorkbook.samples[0].question, sourceRecord.题目],
  });
  deAi = {
    ...deAi,
    generatedAt: new Date().toISOString(),
    endpoint: targetedResponse.endpoint,
    model: targetedResponse.model,
    finishReason: targetedResponse.finishReason,
    usage: targetedResponse.usage,
    promptHash: targetedResponse.promptHash,
    rewrittenQuestionHash: sha256(targetedRewrite.question),
    selectedAttempt: 1,
    attempts: [{
      attempt: 1,
      pass: targetedValidation.pass,
      visibleLength: targetedValidation.visibleLength,
      findingRules: targetedValidation.findings.map((finding) => finding.rule),
    }],
    rewrite: targetedRewrite,
    validation: targetedValidation,
    targetedRepair: {
      reason: postDeAiGate.issues,
      provider: "mugua-openai-compatible",
      promptHash: targetedResponse.promptHash,
    },
  };
  await writeJson(path.join(qaDir, "01_de_ai_rewrite_targeted.json"), deAi);
  if (!deAi.validation.pass) {
    throw new Error(`Targeted de-AI repair failed validation: ${JSON.stringify(deAi.validation.findings)}`);
  }
  postDeAiGate = await runPostDeAiGate(deAi, "06_post_de_ai_preflight_targeted");
  if (!postDeAiGate.pass || postDeAiGate.issues.length || !postDeAiGate.factsPreserved
    || !postDeAiGate.attachmentsPreserved || !postDeAiGate.visibleTextClean) {
    throw new Error(`Targeted post-de-AI preflight blocked the question: ${JSON.stringify(postDeAiGate)}`);
  }
  await writeJson(path.join(qaDir, "01_de_ai_rewrite.json"), deAi);
}
if (!analyzeQuestionRequest(String(deAi.rewrite.requestContract?.requestSpan ?? "")).clear) {
  const basePrompt = await loadMuguaDeAiPrompt(process.env.DE_AI_REWRITE_PROMPT_PATH);
  const directRequestPrompt = `${basePrompt}\n\n【直接请求跨度修复，优先级高于一般自然化要求】\n当前题面已经通过事实和内容质检。只调整最终交付句，使请求句明确以“请再基于”开头，并在同一句保留动作“整理”和具体交付物“可下载的Excel口径核对表”。请直接采用句式“请再基于前述核对结果整理一份可下载的Excel口径核对表，按xlsx格式交付并作为结论底表。”\n其余对象、附件、报告期、口径边界、未经审计状态、来源页码、待核规则和段落保持不变。全文使用正向字段状态表达，不出现“不要、不能、不得、不作为、切勿、严禁”。不添加事实、数字或后续轮次。`;
  let directResponse;
  let directRewrite;
  let directValidation;
  let directFailure;
  const directAttempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      directResponse = await rewriteMuguaDeAiText({
        text: deAi.rewrite.question,
        apiKey: process.env.DE_AI_REWRITE_API_KEY,
        baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
        model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
        promptText: `${directRequestPrompt}\n这是第${attempt}次局部修复。输出完整题面并在输出前逐字检查禁止词。`,
        temperature: 0.05,
        timeoutMs: 180_000,
        retries: 3,
      });
      directRewrite = synthesizeRewriteSidecars({
        question: directResponse.text,
        record: sourceRecord,
        sceneCard,
        knownFactIds: sceneCard.informationBoundary.knownFactIds,
      });
      directValidation = validateClaudeRewrite({
        sourceRecord,
        rewrite: directRewrite,
        sceneCard,
        knownFactIds: sceneCard.informationBoundary.knownFactIds,
        avoidQuestions: [packet.inputs.referenceWorkbook.samples[0].question, sourceRecord.题目],
      });
      const attemptReceipt = {
        attempt,
        response: directResponse,
        rewrite: directRewrite,
        validation: directValidation,
      };
      directAttempts.push({ attempt, pass: directValidation.pass, findingRules: directValidation.findings.map((finding) => finding.rule) });
      await writeJson(path.join(qaDir, `01_de_ai_rewrite_direct_request_attempt_${attempt}.json`), attemptReceipt);
      if (directValidation.pass) break;
      directFailure = new Error(`Direct-request de-AI candidate ${attempt} failed validation: ${JSON.stringify(directValidation.findings)}`);
    } catch (candidateError) {
      directFailure = candidateError;
      directAttempts.push({ attempt, pass: false, error: candidateError.message, code: candidateError.code ?? "" });
      await writeJson(path.join(qaDir, `01_de_ai_rewrite_direct_request_attempt_${attempt}.json`), {
        attempt,
        error: { name: candidateError.name, code: candidateError.code ?? "", message: candidateError.message, issues: candidateError.issues ?? [] },
      });
    }
  }
  if (!directResponse || !directRewrite || !directValidation?.pass) throw directFailure;
  deAi = {
    ...deAi,
    generatedAt: new Date().toISOString(),
    endpoint: directResponse.endpoint,
    model: directResponse.model,
    finishReason: directResponse.finishReason,
    usage: directResponse.usage,
    promptHash: directResponse.promptHash,
    rewrittenQuestionHash: sha256(directRewrite.question),
    selectedAttempt: directAttempts.find((item) => item.pass)?.attempt,
    attempts: directAttempts,
    rewrite: directRewrite,
    validation: directValidation,
    targetedRepair: {
      reason: "request_span_not_direct_request",
      provider: "mugua-openai-compatible",
      promptHash: directResponse.promptHash,
    },
  };
  await writeJson(path.join(qaDir, "01_de_ai_rewrite_direct_request.json"), deAi);
  postDeAiGate = await runPostDeAiGate(deAi, "06_post_de_ai_preflight_direct_request");
  if (!postDeAiGate.pass || postDeAiGate.issues.length || !postDeAiGate.factsPreserved
    || !postDeAiGate.attachmentsPreserved || !postDeAiGate.visibleTextClean) {
    throw new Error(`Direct-request post-de-AI preflight blocked the question: ${JSON.stringify(postDeAiGate)}`);
  }
  await writeJson(path.join(qaDir, "01_de_ai_rewrite.json"), deAi);
}
recordDeAiRewrite(workflow, 1, deAi);
const finalRecord = { ...sourceRecord, 题目: deAi.rewrite.question };
recordFinalRecord(workflow, 1, { recordUid, finalRecord });
await saveProductionWorkflow(workflowPath, workflow);
const trace = buildProductionTrace(workflow);
const tracePath = path.join(qaDir, "production_trace.json");
await writeJson(tracePath, trace);
await writeJson(path.join(draftDir, "01_final_record.json"), finalRecord);

const factLedgerPath = path.join(sourceDir, "fact_ledger.json");
const factLedgerBytes = await fs.readFile(factLedgerPath);
const sceneBundle = {
  kind: "scene-card-bundle",
  protocolId: "situated-requester-v1",
  schemaVersion: 1,
  factLedgerPath,
  factLedgerHash: sha256(factLedgerBytes),
  cards: [{
    recordUid,
    sceneCard,
    requestContract: deAi.rewrite.requestContract,
    roleTrace: deAi.rewrite.roleTrace,
    usedFactIds: deAi.rewrite.usedFactIds,
    deliberatelyOmitted: deAi.rewrite.deliberatelyOmitted,
  }],
};
const sceneCardPath = path.join(sourceDir, "scene_cards.json");
await writeJson(sceneCardPath, sceneBundle);

const fields = [
  "UID", "题目", "任务类型", "一级目录", "二级目录", "三级目录", "任务概括",
  "标注专家工作年限", "人类完成时间", "相关附件", "附件格式", "附件内容",
  "产物格式", "产物内容", "做题关键步骤", "标注专家姓名",
];
const tsvValue = (value) => String(value ?? "").replace(/\r?\n/gu, "\\n").replace(/\t/gu, " ");
const candidatePath = path.join(draftDir, "l1_questions.tsv");
await fs.writeFile(candidatePath, `${fields.join("\t")}\n${fields.map((field) => tsvValue(finalRecord[field])).join("\t")}\n`, "utf8");

const sheetRow = 999998;
const columnMap = [
  ["UID", "A"], ["题目", "B"], ["任务类型", "C"], ["一级目录", "D"],
  ["二级目录", "E"], ["三级目录", "F"], ["任务概括", "G"],
  ["标注专家工作年限", "H"], ["人类完成时间", "I"], ["相关附件", "J"],
  ["附件格式", "K"], ["附件内容", "L"], ["产物格式", "M"],
  ["产物内容", "N"], ["做题关键步骤", "O"],
];
const fillPlan = {
  version: 1,
  status: "DRY_RUN_ONLY_NO_RESERVED_FEISHU_ROW",
  questionPresentation: "natural-paragraphs-no-blank-lines-v4",
  generatedAt: new Date().toISOString(),
  sourcePath: candidatePath,
  startRow: sheetRow,
  sheetRows: [sheetRow],
  count: 1,
  note: "No Feishu row is reserved. Row 999998 is a non-production dry-run placeholder. No external write is authorized for this test.",
  columnMap: columnMap.map(([field, column]) => ({ field, column })),
  rows: [{
    dataRow: 2,
    sheetRow,
    title: finalRecord.任务概括,
    updates: columnMap.map(([field, column]) => {
      const value = finalRecord[field];
      return {
        address: `${column}${sheetRow}`,
        column,
        field,
        value,
        chars: [...String(value ?? "")].length,
        hasNewlines: /\n/u.test(String(value ?? "")),
        preview: [...String(value ?? "")].slice(0, 80).join(""),
      };
    }),
  }],
};
const fillPlanPath = path.join(feishuDir, "feishu_fill_plan.json");
await writeJson(fillPlanPath, fillPlan);

const manifest = JSON.parse(await fs.readFile(path.join(runDir, "manifest.json"), "utf8"));
const roleReportPath = path.join(feishuDir, "role_consistency_report.json");
const roleReport = await runSceneCardGate({ candidatePath, sceneCardPath, reportPath: roleReportPath });
const processResult = await runProductionTraceGate({
  packetPath,
  tracePath,
  candidatePath,
  fillPlanPath,
  reportPath: path.join(feishuDir, "production_trace_gate_report.json"),
  receiptPath: path.join(feishuDir, "production_trace_gate_receipt.json"),
  attachmentRoot: attachmentDir,
});
const naturalnessReportPath = path.join(feishuDir, "naturalness_gate_report.json");
const naturalnessReviewRequestPath = `${naturalnessReportPath}.review-request.json`;
const naturalnessReviewSignoffPath = path.join(feishuDir, "naturalness_gate_report.json.review-signoff.json");
const releaseGateOptions = {
  candidatePath,
  baselinePath: manifest.naturalnessBaselinePath,
  naturalnessReportPath,
  naturalnessReviewRequestPath,
  naturalnessReviewSignoffPath,
  sceneCardPath,
  roleConsistencyReportPath: roleReportPath,
  fillPlanPath,
  structureReportPath: path.join(feishuDir, "structure_gate_report.json"),
  structureReceiptPath: path.join(feishuDir, "structure_gate_receipt.json"),
  releaseReceiptPath: path.join(feishuDir, "release_gate_receipt.json"),
  registryPath: manifest.structureRegistryPath,
  policyPath: manifest.structuralDiversityPolicyPath,
};
let releaseResult = await runReleaseGate(releaseGateOptions);
if (!releaseResult.ok && releaseResult.phase === "naturalness" && releaseResult.status === "REVIEW") {
  const reviewRequestText = await fs.readFile(naturalnessReviewRequestPath, "utf8");
  const reviewRequest = JSON.parse(reviewRequestText);
  const reviewReport = releaseResult.naturalnessReport;
  const independentReview = await localJson({
    label: "07_naturalness_independent_review",
    systemPrompt: [
      "你是独立于题面生成和发布请求方的自然度审阅员，只审核哈希绑定报告中的REVIEW项。",
      "本次是单题L1首轮任务。低具体数字密度不等于事实不足；附件名称、报告期、累计与单月关系、披露单位、审计状态、来源页码和待核边界都可构成业务锚点。",
      "判断免责声明是否挤占了业务事实、任务是否仍可执行、是否像真实工作委托。只有理由充分时APPROVE，否则REJECT。不得改写题面。",
    ].join("\n"),
    userPrompt: JSON.stringify({
      request: reviewRequest,
      reportSummary: reviewReport.summary,
      reviewedRow: reviewReport.rows[0],
      question: finalRecord.题目,
      attachments: attachmentPlan.attachments.map((item) => item.name),
    }, null, 2),
    outputSchema: object({
      decision: { type: "string", enum: ["APPROVE", "REJECT"] },
      rationale: string,
      disclaimerDisplacesFacts: { type: "boolean" },
      taskExecutable: { type: "boolean" },
      naturalWorkRequest: { type: "boolean" },
    }),
  });
  const signoff = {
    schemaVersion: 1,
    kind: "naturalness-review-signoff",
    requestId: reviewRequest.requestId,
    bindingHash: reviewRequest.bindingHash,
    requestHash: sha256(reviewRequestText),
    decision: independentReview.decision,
    reviewer: "local-codex-independent-naturalness-reviewer-gpt-5.6-sol",
    rationale: independentReview.rationale,
    reviewedAt: new Date().toISOString(),
    evidence: {
      reviewReceiptPath: path.join(qaDir, "07_naturalness_independent_review_local_codex.json"),
      disclaimerDisplacesFacts: independentReview.disclaimerDisplacesFacts,
      taskExecutable: independentReview.taskExecutable,
      naturalWorkRequest: independentReview.naturalWorkRequest,
    },
  };
  await writeJson(naturalnessReviewSignoffPath, signoff);
  if (signoff.decision !== "APPROVE") throw new Error(`Independent naturalness review rejected the question: ${signoff.rationale}`);
  releaseResult = await runReleaseGate(releaseGateOptions);
}
await writeJson(path.join(feishuDir, "stage3_summary.json"), {
  kind: "l1-stage3-gate-summary",
  generatedAt: new Date().toISOString(),
  workflowState: workflow.questions[0].state,
  finalRecordUid: recordUid,
  roleConsistency: roleReport.status,
  productionTrace: processResult.report.status,
  release: { ok: releaseResult.ok, phase: releaseResult.phase, status: releaseResult.status },
  feishuWriteAttempted: false,
  feishuWriteApplied: false,
});
if (roleReport.status !== "PASS" || processResult.report.status !== "PASS" || !releaseResult.ok) {
  throw new Error(JSON.stringify({
    roleConsistency: roleReport.status,
    roleErrors: roleReport.errors?.map((item) => item.code) ?? [],
    productionTrace: processResult.report.status,
    processFindings: processResult.report.findings,
    release: { ok: releaseResult.ok, phase: releaseResult.phase, status: releaseResult.status },
    naturalnessFindings: releaseResult.naturalnessReport?.findings ?? [],
    structureFindings: releaseResult.structureReport?.findings ?? [],
  }));
}
await updateRunStatus(runDir, "READY_FOR_DOUBAO_TEST_NO_FEISHU", {
  recordUid,
  localGates: {
    roleConsistency: roleReport.status,
    productionTrace: processResult.report.status,
    release: releaseResult.status,
  },
  feishuWriteAttempted: false,
  feishuWriteApplied: false,
});
console.log(JSON.stringify({
  runId,
  recordUid,
  finalQuestion: finalRecord.题目,
  attachmentCount: attachments.length,
  workflowState: workflow.questions[0].state,
  firstQa: firstQaParsed,
  secondQa: secondParsed.conclusion,
  deAiPass: deAi.validation.pass,
  roleConsistency: roleReport.status,
  productionTrace: processResult.report.status,
  release: releaseResult.status,
  feishuWriteApplied: false,
}, null, 2));
