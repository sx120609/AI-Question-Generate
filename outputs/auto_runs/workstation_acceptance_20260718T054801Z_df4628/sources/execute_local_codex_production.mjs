import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
import { rewriteQuestionWithDeAiApi } from "../../../../build/automation/claude_question_rewriter.mjs";
import { assertValidSceneCard } from "../../../../build/automation/scene_card.mjs";
import { evaluateNarrativeHardRules } from "../../../../build/automation/narrative_language_rules.mjs";

const runDir = path.resolve("outputs/auto_runs/workstation_acceptance_20260718T054801Z_df4628");
const sourceDir = path.join(runDir, "sources");
const draftDir = path.join(runDir, "drafts");
const qaDir = path.join(runDir, "qa");
const packetPath = path.join(sourceDir, "production_input_packet.json");
const workflowPath = path.join(sourceDir, "production_workflow_state.json");
const recordUid = "沈礼_20260718_workstation_preacceptance_01";
const model = "gpt-5.6-sol";
const runnerId = "exact-two-quality-gates-v2-codex-session";
const provider = "codex-session";

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
  const response = await completeWithLocalCodex({
    model,
    reasoningEffort: "high",
    systemPrompt,
    userPrompt,
    outputSchema,
    timeoutMs: 360_000,
  });
  const parsed = JSON.parse(response.content);
  await writeJson(path.join(qaDir, `${label}_local_codex.json`), {
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

const packet = JSON.parse(await fs.readFile(packetPath, "utf8"));
const firstQaPromptText = await fs.readFile(packet.inputs.firstQaPrompt.path, "utf8");
packet.inputs.firstQaPrompt.text = firstQaPromptText;
packet.inputs.firstQaPrompt.sha256 = sha256(firstQaPromptText);
packet.runMode = "development-codex-session";
await writeJson(packetPath, packet);
let workflow = initializeProductionWorkflow({ packet, runId: packet.runId });
await saveProductionWorkflow(workflowPath, workflow);

const factLedger = JSON.parse(await fs.readFile(path.join(sourceDir, "fact_ledger.json"), "utf8"));
const sourceCards = JSON.parse(await fs.readFile(path.join(sourceDir, "source_cards.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "download_manifest.json"), "utf8"));

const topic = {
  id: "workstation-preacceptance-0724-2611Z1612177",
  title: "中山大学肿瘤防治中心图形工作站采购项目到货预验收核对",
  organization: "中山大学肿瘤防治中心",
  projectNumber: "0724-2611Z1612177",
  currentStage: "公开材料口径核对与现场到货预验收工作簿准备",
  uniqueDecision: "建立可直接回填的预验收核对工作簿，并在实际台账缺位时拦截验收结论",
};

const referencePrompt = buildReferenceBreakdownPrompt({ packet, questionIndex: 1 });
const referenceBreakdown = await localJson({
  label: "01_reference_breakdown",
  systemPrompt: "严格执行输入中的结构拆解任务。只提取可迁移结构，不复用样例对象、平台、数字、附件和原句。返回符合 schema 的中文 JSON。",
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

const materialByName = new Map(factLedger.materials.map((item) => [item.name, item]));
const attachmentMeta = {
  "01_ccgp_award_result.html": {
    format: "html",
    timeAnchor: "2026年6月4日中标结果公告",
    object: "中山大学肿瘤防治中心图形工作站采购项目0724-2611Z1612177",
    uniqueContent: "中标供应商、两个包组金额、工作站型号、总数量和工作站单价",
  },
  "02_ccgp_tender_document.pdf": {
    format: "pdf",
    timeAnchor: "2026年项目招标与中标事件",
    object: "中山大学肿瘤防治中心图形工作站采购项目0724-2611Z1612177",
    uniqueContent: "包组预计数量组合、技术要求、交货期限、30天运行验收、付款与保修条件",
  },
  "03_lenovo_thinkstation_p3_tiny_gen2_user_guide.pdf": {
    format: "pdf",
    timeAnchor: "2026年2月27日版产品资料",
    object: "中标公告列明的ThinkStation P3 Tiny Gen 2型号系列",
    uniqueContent: "该型号系列后视图、接口位置、键盘开机接口和选配接口边界",
  },
  "04_lenovo_thinkstation_p368_c4_user_guide.pdf": {
    format: "pdf",
    timeAnchor: "2025年9月15日版产品资料",
    object: "中标公告列明的ThinkStation P368-C4型号系列",
    uniqueContent: "该型号系列后部接口、可选接口和特定型号限制",
  },
  "05_lenovo_thinkstation_p2_tower_user_guide.pdf": {
    format: "pdf",
    timeAnchor: "2025年10月9日版产品资料",
    object: "中标公告列明的ThinkStation P2 Tower型号系列",
    uniqueContent: "该型号系列后视图、USB与显示接口、网络接口和选配接口边界",
  },
};
const attachmentPlan = {
  mainDecision: "建立公开规则与现场回填分层的到货预验收工作簿",
  attachments: manifest.items.map((item) => {
    const ledger = materialByName.get(item.name);
    const meta = attachmentMeta[item.name];
    if (!ledger || !meta) throw new Error(`No bound ledger metadata for ${item.name}.`);
    return {
      name: item.name,
      sourceUrl: item.url,
      format: meta.format,
      classification: "specific-business",
      objectLevel: true,
      timeAnchor: meta.timeAnchor,
      specificityEvidence: {
        object: meta.object,
        periodOrEvent: meta.timeAnchor,
        uniqueContent: meta.uniqueContent,
      },
      summary: item.name.includes("lenovo_") ? `具体中标型号产品资料。${ledger.text}` : ledger.text,
      localPath: `01/${item.name}`,
      sha256: item.sha256,
      bytes: item.size,
      sizeBytes: item.size,
      introductionHint: "首轮随任务整包上传，只有文件上传校验失败时才重新核对该原件。",
    };
  }),
  specificBusinessShareRationale: "五份材料都绑定项目编号或中标型号，具体业务材料占比为100%。",
  timeSeriesRationale: "本题核对一个采购项目的到货预验收口径，关键维度是包组、型号、数量、金额、证据层级和30天运行节点，无需连续时间序列。",
  objectSupportInQuestion: "题面明确项目编号、采购单位、包组、型号和现场台账缺口。",
  newAttachmentSupport: "中标公告确认中标口径，招标文件确认预计数量与履约条件，三份型号手册建立现场接口核对项。五份材料首轮一次上传。",
  newQuestionStructureMapping: "沿用样例的真实工作卡点、证据核验、阶段性判断和下游交付逻辑，切换到采购到货预验收场景并以真实附件替代联网摸排。",
};
recordAttachmentPlan(workflow, 1, attachmentPlan);

const sceneCard = {
  schemaVersion: 1,
  policyId: "situated-requester-v1",
  topicId: topic.id,
  personaId: "workstation-delivery-acceptance-coordinator-01",
  requester: {
    functionalRole: "设备采购项目交付协调人",
    organizationType: "医疗机构",
    department: "",
    responsibility: "整理公开采购口径并准备现场逐台回填的到货预验收工作簿",
    authorityBoundary: "可建立预验收核对口径，正式验收结论需以实际到货台账、现场读数和签章记录为准",
    recipientRelation: "把工作簿交给设备运维与项目交付同事在现场核对和回填",
  },
  scene: {
    workflowStage: "图形工作站到货前的预验收准备",
    trigger: factLedger.facts.find((item) => item.id === "fact-project-identity").text,
    currentBlockage: factLedger.facts.find((item) => item.id === "fact-guide-evidence-boundary").text,
    mainDecision: "依据公开项目材料建立可执行的到货预验收工作簿，现场台账缺位时保持待核状态",
    downstreamUse: "供设备运维与项目交付同事逐台回填并形成差异处置清单",
  },
  informationBoundary: {
    knownFactIds: factLedger.facts.map((item) => item.id),
    availableMaterialIds: factLedger.materials.map((item) => item.id),
    unknowns: factLedger.unknowns.map((item) => item.text),
    forbiddenInferences: [
      "实际到货数量、序列号、配置读数和验收结果须以现场台账与实际返回为准",
      "公开材料中的金额差额只作为报价明细核对线索，未确认为显示器单价",
    ],
  },
  voice: {
    channel: "内部项目群消息",
    formality: "直接、克制、以现场执行为导向",
    domainVocabulary: ["预验收", "包组", "序列号", "配置读数", "差异清单", "30天运行"],
    avoidVocabulary: ["全链路", "闭环", "赋能", "深度洞察", "麻烦", "劳烦", "烦请", "辛苦"],
  },
  maskTerms: ["中山大学肿瘤防治中心", "图形工作站", "ThinkStation", "预验收", "设备采购"],
  evidenceBindings: [
    { claim: factLedger.facts.find((item) => item.id === "fact-project-identity").text, factIds: ["fact-project-identity"] },
    { claim: factLedger.facts.find((item) => item.id === "fact-guide-evidence-boundary").text, factIds: ["fact-guide-evidence-boundary"] },
    { claim: "依据公开项目材料建立可执行的到货预验收工作簿，现场台账缺位时保持待核状态", factIds: ["fact-delivery-acceptance", "fact-guide-evidence-boundary"] },
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
const draftSchema = object({
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
});
const draft = await localJson({
  label: "02_question_draft",
  systemPrompt: [
    "你是本题真实的设备采购项目交付协调人。严格依据输入事实和五份附件写一条完整 L1 工作委托。",
    "题面要求最终生成一份可下载的 Excel 到货预验收核对表。xlsx 只写入结构化产物字段，正文不出现扩展名，也不使用 Excel 工作簿。首轮一次接收全部五份附件。",
    "公开材料只写项目规则和型号级核对项。实际到货数量、序列号、配置读数和验收结果保留现场回填。",
    "表达直接自然，每句话包含的顿号不超过一个，不使用分号，不使用项目符号，不使用麻烦、劳烦、烦请、辛苦。",
    "正文不出现不要、不能、不得、不作为、切勿、严禁，也不使用不是而是等对照句。直接说明动作和字段状态。题面中至少自然出现一次你或我。",
    "保留多包组数量与金额口径复核。题面明确复核工作站单价、数量和包组金额，并保留算术差额线索、现场证据边界、30天运行和付款保修约束，形成4至8步工作量。",
    "题面不出现第一步、第二步或第一个环节等机械顺序壳，让核对结果自然承接下一项工作。",
  ].join("\n"),
  userPrompt: draftPrompt.prompt,
  outputSchema: draftSchema,
});
if (!draft.usedAttachmentNames.every((name) => manifest.items.some((item) => item.name === name))) {
  throw new Error("Draft referenced an attachment outside the verified manifest.");
}
recordDraft(workflow, 1, draft);
await writeJson(path.join(draftDir, "01_pre_de_ai.json"), { topic, sceneCard, attachmentPlan, draft });

const firstGatePrompt = buildFirstQualityGatePrompt({ packet, questionIndex: 1, candidate: draft, attachmentPlan, referenceBreakdown });
const preQaStructureAudit = await localJson({
  label: "03_pre_qa_structure_audit",
  systemPrompt: "独立检查输入中的结构、附件和证据链。只返回 schema 指定的 JSON，不改写题面。",
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
  systemPrompt: "你是独立 L1 质量质检员。严格执行输入中的原版第一道质检提示词。通过时必须返回 pass=true 和空 issues。发现任一问题时如实返回修复建议，不提供兜底放行。",
  userPrompt: firstGatePrompt.prompt,
  outputSchema: object({
    pass: { type: "boolean" },
    issues: {
      type: "array",
      items: object({ rule: string, evidence: string, repair: string }),
    },
  }),
});
const firstRawPath = path.join(qaDir, "01_first_quality_gate_raw.json");
const firstRaw = {
  runnerId,
  provider,
  model,
  sourcePromptHash: packet.inputs.firstQaPrompt.sha256,
  renderedPromptHash: sha256(firstGatePrompt.prompt),
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
    "你是独立 L1 语言质检员。严格执行输入中的第二道质检，只改善语言，不新增事实。",
    "返回 JSON。modifiedQuestion 必须是完整题面。",
    "自然工作委托中每句话的顿号不超过一个，不使用分号，不使用麻烦、劳烦、烦请、辛苦，也不出现第一步、第二步或第一个环节等机械顺序壳。",
    "正文不出现不要、不能、不得、不作为、切勿、严禁，也不使用不是而是等对照式教唆表达。保留你或我。",
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
  const languageFindings = evaluateNarrativeHardRules(secondParsed.modifiedQuestion, {
    minimumExplanatoryParentheses: 0,
    maximumEnumerationCommasPerSentence: 1,
    forbidSemicolon: true,
  });
  if (!languageFindings.length) break;
  secondParsed = await localJson({
    label: `05_second_language_gate_repair_${repairRound}`,
    systemPrompt: [
      "你是第二道语言质检的修订轮。只修复本地文本门禁指出的问题，不新增或删减事实。",
      "返回完整 JSON。modifiedQuestion 必须保留全部对象、数字、附件、证据边界和 xlsx 产物要求。",
      "每句话最多使用一个顿号。列举超过两项时拆成多个完整句子或改用和、以及、同时等自然连接。题面不出现第一步、第二步或第一个环节等机械顺序壳。",
      "禁止分号。避免麻烦、劳烦、烦请、辛苦。正文不出现不要、不能、不得、不作为、切勿、严禁，也不使用不是而是等对照式教唆表达。",
    ].join("\n"),
    userPrompt: JSON.stringify({
      gateFindings: languageFindings,
      previousResult: secondParsed,
    }, null, 2),
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
  renderedPromptHash: sha256(secondGatePrompt.prompt),
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
  await saveProductionWorkflow(workflowPath, workflow);
  throw new Error(`Second language gate blocked the task: ${secondParsed.conclusion}`);
}
await saveProductionWorkflow(workflowPath, workflow);

const sourceRecord = {
  UID: recordUid,
  题目: secondParsed.modifiedQuestion,
  任务类型: "L1 探索型",
  一级目录: "科技软件与 AI 工作流",
  二级目录: "企业软件与技术方案",
  三级目录: "设备采购到货预验收",
  任务概括: "依据真实采购材料建立图形工作站到货预验收核对工作簿",
  标注专家工作年限: "5年",
  人类完成时间: "6H",
  相关附件: attachmentPlan.attachments.map((item) => item.name).join("、"),
  附件格式: "html, pdf",
  附件内容: attachmentPlan.attachments.map((item) => `${item.name}：${item.summary}`).join("\n"),
  产物格式: "xlsx",
  产物内容: "一份可下载的图形工作站到货预验收 Excel 核对表，包含项目口径、预计数量与金额复核、空白到货台账、型号级配置核对、差异清单、30天运行记录、付款与保修条件和来源索引。",
  做题关键步骤: [
    "1. 核验五份附件的项目编号、包组、型号和来源边界。",
    "2. 对照招标预计数量与中标公告总量及单价，复核两个包组金额差额。",
    "3. 把820元差额标成报价明细待核线索，并设置正式报价回填字段。",
    "4. 依据三份型号手册建立接口与功能核对项，保留实际配置读数空白。",
    "5. 建立逐台到货台账、差异分级和30天运行记录，缺少证据时自动显示待核。",
    "6. 汇总付款与保修触发条件，生成启动拦截结论和来源索引。",
  ].join("\n"),
  标注专家姓名: "沈礼",
};

const deAi = await rewriteQuestionWithDeAiApi({
  input: {
    uid: recordUid,
    record: sourceRecord,
    sceneCard,
    knownFactIds: sceneCard.informationBoundary.knownFactIds,
    avoidQuestions: [packet.inputs.referenceWorkbook.samples[0].question, sourceRecord.题目],
  },
  apiKey: process.env.DE_AI_REWRITE_API_KEY,
  baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
  model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
  timeoutMs: 120_000,
  retries: 3,
  contentAttempts: 3,
});
await writeJson(path.join(qaDir, "01_de_ai_rewrite.json"), deAi);
if (!deAi.validation.pass) throw new Error(`De-AI rewrite failed validation: ${JSON.stringify(deAi.validation.findings)}`);
const postDeAiGate = await localJson({
  label: "06_post_de_ai_preflight",
  systemPrompt: [
    "你是发送给豆包之前的独立可见文本审查员。只做审查，不改写，不回答题目。",
    "逐项核对事实和数字是否保持，附件是否仍为五份，Excel 核对表是否清楚，现场未知状态是否保持待核。",
    "拦截麻烦、劳烦、烦请、辛苦。拦截不要、不能、不得、不作为、切勿、严禁和不是而是等边界式教唆表达。",
    "拦截分号、每句超过一个顿号、内部错误信息、工具痕迹、奇怪标点以及没有你或我的机器式说明。",
    "任何问题都返回 pass=false。没有 fallback，也不能把小问题忽略后放行。",
  ].join("\n"),
  userPrompt: JSON.stringify({
    sourceQuestion: secondParsed.modifiedQuestion,
    outboundQuestion: deAi.rewrite.question,
    attachmentNames: attachmentPlan.attachments.map((item) => item.name),
    requiredProduct: "可下载的 Excel 到货预验收核对表",
  }, null, 2),
  outputSchema: object({
    pass: { type: "boolean" },
    issues: {
      type: "array",
      items: object({ rule: string, evidence: string, repair: string }),
    },
    factsPreserved: { type: "boolean" },
    attachmentsPreserved: { type: "boolean" },
    visibleTextClean: { type: "boolean" },
  }),
});
if (!postDeAiGate.pass || postDeAiGate.issues.length || !postDeAiGate.factsPreserved
  || !postDeAiGate.attachmentsPreserved || !postDeAiGate.visibleTextClean) {
  throw new Error(`Post-de-AI preflight blocked the question: ${JSON.stringify(postDeAiGate)}`);
}
recordDeAiRewrite(workflow, 1, deAi);

const finalRecord = { ...sourceRecord, 题目: deAi.rewrite.question };
recordFinalRecord(workflow, 1, { recordUid, finalRecord });
await saveProductionWorkflow(workflowPath, workflow);
const trace = buildProductionTrace(workflow);
await writeJson(path.join(qaDir, "production_trace.json"), trace);

await writeJson(path.join(draftDir, "01_final_record.json"), finalRecord);
console.log(JSON.stringify({
  runId: packet.runId,
  recordUid,
  state: workflow.questions[0].state,
  firstQa: firstQaParsed,
  secondQa: secondParsed.conclusion,
  deAiPass: deAi.validation.pass,
  deAiModel: deAi.model,
  finalQuestion: finalRecord.题目,
  attachmentCount: attachmentPlan.attachments.length,
}, null, 2));
