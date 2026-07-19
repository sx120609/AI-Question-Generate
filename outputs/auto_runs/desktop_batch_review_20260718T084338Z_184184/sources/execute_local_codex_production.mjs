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

const runDir = path.resolve("outputs/auto_runs/desktop_batch_review_20260718T084338Z_184184");
const sourceDir = path.join(runDir, "sources");
const draftDir = path.join(runDir, "drafts");
const qaDir = path.join(runDir, "qa");
const packetPath = path.join(sourceDir, "production_input_packet.json");
const workflowPath = path.join(sourceDir, "production_workflow_state.json");
const recordUid = "裴硬_20260718_desktop_batch_review_01";
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
  id: "desktop-batch-award-reconciliation-gc-hcd260444",
  title: "中央国家机关2026年6月台式计算机批量集中采购成交口径复核",
  organization: "采购结算支持组",
  projectNumber: "GC-HCD260444",
  currentStage: "公开成交数据复核与首轮人工抽检准备",
  uniqueDecision: "对齐六包数量、金额和规格证据后挑选两包进入人工抽检",
};

const referencePrompt = buildReferenceBreakdownPrompt({ packet, questionIndex: 1 });
const referenceBreakdown = await localJson({
  label: "01_reference_breakdown",
  systemPrompt: "严格执行输入中的结构拆解任务。只提取可迁移结构，不复用样例对象、平台、数字、附件和原句。返回符合schema的中文JSON。",
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
const sourceByName = new Map(sourceCards.sources.map((item) => [path.basename(item.path), item]));
const definitions = {
  "成交结果公告.html": { format: "html", object: "GC-HCD260444成交结果", uniqueContent: "六包成交金额、数量、质保比例与公告概要总金额字段" },
  "台式机202606计划公示.xls": { format: "xls", object: "GC-HCD260444配送计划", uniqueContent: "535条配送计划与5889台配置、系统和地址字段" },
  "中央国家机关2026年台式计算机批量集中采购项目-6月采购文件.pdf": { format: "pdf", object: "GC-HCD260444采购规则", uniqueContent: "六包预算、技术要求、交付条件与质保计价公式" },
  "投标人得分排序表_官方导出.html": { format: "html", object: "GC-HCD260444评分排序", uniqueContent: "六包匿名投标人得分与名次" },
  "技术规范偏离表-1-软通.pdf": { format: "pdf", object: "GC-HCD260444配置1", uniqueContent: "4950元响应值与龙芯3A6000技术响应" },
  "技术规范偏离表-2-软通.pdf": { format: "pdf", object: "GC-HCD260444配置2", uniqueContent: "4950元响应值与飞腾腾锐D3000技术响应" },
  "技术规范偏离表-3-联想.pdf": { format: "pdf", object: "GC-HCD260444配置3", uniqueContent: "4950元响应值、4个内存接口与2TB机械硬盘" },
  "技术规范偏离表-4-华为.pdf": { format: "pdf", object: "GC-HCD260444配置4", uniqueContent: "4950元响应值、麒麟9000X与板载内存" },
  "技术规范偏离表-5-安领信.pdf": { format: "pdf", object: "GC-HCD260444配置5", uniqueContent: "4950元响应值、海光C86-3G与4GB独显" },
  "技术规范偏离表-6-天津光电.pdf": { format: "pdf", object: "GC-HCD260444配置6", uniqueContent: "4978元响应值、申威SW-WY831与GDDR6独显" },
};
const attachmentPlan = {
  mainDecision: "建立六包公开成交口径复核表并挑选两包进入人工抽检准备",
  attachments: manifest.items.map((item) => {
    const material = materialByName.get(item.name);
    const source = sourceByName.get(item.name);
    const meta = definitions[item.name];
    if (!material || !source || !meta) throw new Error(`Missing evidence binding for ${item.name}.`);
    return {
      name: item.name,
      sourceUrl: item.url,
      format: meta.format,
      classification: "specific-business",
      objectLevel: true,
      timeAnchor: source.publishedAt,
      specificityEvidence: {
        object: meta.object,
        periodOrEvent: source.publishedAt,
        uniqueContent: meta.uniqueContent,
      },
      summary: material.text,
      localPath: item.name,
      sha256: item.sha256,
      bytes: item.size,
      sizeBytes: item.size,
      introductionHint: "首轮随任务一次上传，文件名与哈希校验通过后再进入金额和规格复核。",
    };
  }),
  specificBusinessShareRationale: "十份材料全部绑定项目编号GC-HCD260444或该项目成交公告附件，具体业务材料占比为100%。",
  timeSeriesRationale: "本题围绕同一采购事件的采购文件、配送计划、响应文件和成交结果建立证据层次，关键维度为包号、配置、数量、价格版本、质保期限和字段异常。",
  objectSupportInQuestion: "题面明确项目编号、六个包、公开金额冲突和首轮人工抽检用途。",
  newAttachmentSupport: "成交公告确认最终结果，采购文件确认规则，配送计划提供逐行数量与字段，得分表提供竞争排序，六份偏离表提供响应价格和技术参数。十份材料在首轮一次上传。",
  newQuestionStructureMapping: "沿用样例的真实工作卡点、公开证据核验、初步比较和下游交付逻辑，切换到批量采购成交口径复核与人工抽检场景。",
};
recordAttachmentPlan(workflow, 1, attachmentPlan);

const fact = (id) => factLedger.facts.find((item) => item.id === id)?.text;
const sceneCard = {
  schemaVersion: 1,
  policyId: "situated-requester-v1",
  topicId: topic.id,
  personaId: "procurement-reconciliation-coordinator-01",
  requester: {
    functionalRole: "采购结算支持人员",
    organizationType: "国内单位采购支持团队",
    department: "",
    responsibility: "整理公开成交数据并给设备抽检同事准备可回填的核对口径",
    authorityBoundary: "权限只包括公开材料复核和首轮抽检安排，实际验收与付款结论由订单、实物和签章记录确认",
    recipientRelation: "把核对表交给采购结算与设备抽检同事继续补证",
  },
  scene: {
    workflowStage: "公开成交数据复核与首轮人工抽检准备",
    trigger: fact("fact-award-total-conflict"),
    currentBlockage: `${fact("fact-response-price-revisions")} ${fact("fact-plan-data-quality")}`,
    mainDecision: "先对齐六包数量、金额和规格证据，再从六包中挑选两包进入人工抽检",
    downstreamUse: "供采购结算同事核对公开口径，并让设备抽检同事按包补充订单和实物证据",
  },
  informationBoundary: {
    knownFactIds: factLedger.facts.map((item) => item.id),
    availableMaterialIds: factLedger.materials.map((item) => item.id),
    unknowns: factLedger.unknowns.map((item) => item.text),
    forbiddenInferences: [
      "公开配送计划不代表实际下单和收货结果",
      "技术偏离表不代表最终成交单价或实物配置已经验收",
      "匿名得分表无法直接映射供应商名称",
    ],
  },
  voice: {
    channel: "内部采购项目群消息",
    formality: "直接、克制、面向实际复核",
    domainVocabulary: ["成交口径", "包号", "计划数量", "响应价格", "成交单价", "抽检"],
    avoidVocabulary: ["全链路", "闭环", "赋能", "深度洞察", "麻烦", "劳烦", "烦请", "辛苦"],
  },
  maskTerms: ["GC-HCD260444", "台式计算机", "成交复核", "配置1", "配置6", "采购结算"],
  evidenceBindings: [
    { claim: fact("fact-award-total-conflict"), factIds: ["fact-award-total-conflict"] },
    { claim: fact("fact-response-price-revisions"), factIds: ["fact-response-price-revisions"] },
    { claim: fact("fact-plan-data-quality"), factIds: ["fact-plan-data-quality"] },
    { claim: `${fact("fact-response-price-revisions")} ${fact("fact-plan-data-quality")}`, factIds: ["fact-response-price-revisions", "fact-plan-data-quality"] },
    { claim: "先对齐六包数量、金额和规格证据，再从六包中挑选两包进入人工抽检", factIds: ["fact-plan-volume", "fact-award-lines", "fact-evidence-boundary"] },
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
    "你是采购结算支持组的真实任务发起人。严格依据输入事实和十份附件写一条完整L1工作委托。",
    "唯一主任务是生成一份可下载的Excel成交复核表，并据公开证据挑选两包进入人工抽检准备。xlsx只写进结构化产物字段，正文使用Excel核对表。首轮一次接收全部十份附件。",
    "正文长度控制在750至1100个可见字符，保持4至8个自然衔接的工作环节。用自然段写完整工作委托，正文不使用编号清单和项目符号。",
    "公开金额冲突、六包成交价、偏离表响应价、配置数量、操作系统汇总和字段异常都要进入任务。计算包含六包金额重算、预算差额、价格版本差额和质保期限情景。",
    "表格需要原始明细、清洗映射、六包复核、规格对照、待核清单、抽检建议和来源索引。每个判断带文件名、页码或行号。",
    "实际订单、到货、兼容性、验收、付款和售后记录保持待补。首轮抽检建议只用于安排补证顺序。",
    "语言直接自然。每句话最多一个顿号，正文不使用分号。避免客套请求和机械顺序壳。每句话都说清动作、状态或结果去向。正文自然出现一次我或你。",
    "正文避开边界式教唆表达，直接写待核字段、证据状态和执行动作。",
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
  systemPrompt: "独立检查输入中的结构、附件和证据链。只返回schema指定的JSON，不改写题面。",
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
  systemPrompt: "你是独立L1质量质检员。严格执行输入中的原版第一道质检提示词。通过时返回pass=true和空issues。发现任一问题时如实返回修复建议，不提供兜底放行。",
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
  renderedPromptHash: sha256(firstGatePrompt.prompt),
  completedAt: new Date().toISOString(),
  parsed: firstQaParsed,
};
const firstWritten = await writeJson(firstRawPath, firstRaw);
recordFirstQualityGate(workflow, 1, {
  preQaStructureAudit,
  firstQaResult: {
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
  },
});
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
    "你是独立L1语言质检员。严格执行输入中的第二道质检，只改善语言，不新增事实。",
    "返回JSON。modifiedQuestion必须是完整题面。",
    "保持十份附件、全部关键数字、四类计算和公开证据边界。每句话最多一个顿号，正文不使用分号、客套请求和机械顺序壳。",
    "正文直接说明动作和字段状态，保留你或我。正文使用Excel核对表，不使用Excel工作簿。",
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
    systemPrompt: [
      "你是第二道语言质检的修订轮。只修复本地文本门禁指出的问题，不新增或删减事实。",
      "返回完整JSON。modifiedQuestion保留全部对象、数字、附件、证据边界和Excel核对表要求。",
      "每句话最多一个顿号。正文不使用分号、客套请求和机械顺序壳。直接写动作和字段状态。",
    ].join("\n"),
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
  renderedPromptHash: sha256(secondGatePrompt.prompt),
  acceptedRound: 1,
  completedAt: new Date().toISOString(),
  attempts: [{ round: 1, parsed: secondParsed }],
};
const secondWritten = await writeJson(secondRawPath, secondRaw);
recordSecondLanguageGate(workflow, 1, {
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
});
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
  三级目录: "IT设备采购成交复核",
  任务概括: "复核六包台式计算机公开成交口径并安排首轮人工抽检",
  标注专家工作年限: "5年",
  人类完成时间: "6H",
  相关附件: attachmentPlan.attachments.map((item) => item.name).join("、"),
  附件格式: "html, xls, pdf",
  附件内容: attachmentPlan.attachments.map((item) => `${item.name}：${item.summary}`).join("\n"),
  产物格式: "xlsx",
  产物内容: "一份可下载的台式计算机成交复核Excel核对表，包含配送计划清洗、操作系统归一、六包金额与价格版本复核、质保期限情景、配置对照、待核清单、两包抽检建议和来源索引。",
  做题关键步骤: [
    "1. 校验十份附件的项目编号、文件格式、页码和哈希。",
    "2. 清洗535条配送计划，复核5889台总量并标记PR单号、系统名称和地址异常。",
    "3. 按六包重算成交金额、预算差额和公告概要总金额冲突。",
    "4. 对照六份技术偏离表与最终成交价，计算价格版本差额和质保期限情景。",
    "5. 汇总六种配置的处理器、内存、存储和显卡证据，区分公开事实与待补记录。",
    "6. 结合金额规模、数量覆盖、价格变动和证据缺口挑选两包进入人工抽检，并建立来源索引。",
  ].join("\n"),
  标注专家姓名: "裴硬",
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
    "逐项核对项目编号、十份附件、535条记录、5889台、六包价格和数量、金额冲突、质保比例、字段异常、待补边界以及两包人工抽检请求。",
    "拦截客套请求、边界式教唆表达、分号、每句超过一个顿号、内部错误信息、工具痕迹和奇怪标点。",
    "任何问题都返回pass=false。没有fallback，也不忽略小问题。",
  ].join("\n"),
  userPrompt: JSON.stringify({
    sourceQuestion: secondParsed.modifiedQuestion,
    outboundQuestion: deAi.rewrite.question,
    attachmentNames: attachmentPlan.attachments.map((item) => item.name),
    requiredProduct: "可下载的Excel成交复核表",
  }, null, 2),
  outputSchema: object({
    pass: { type: "boolean" },
    issues: { type: "array", items: object({ rule: string, evidence: string, repair: string }) },
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
await writeJson(path.join(qaDir, "production_trace.json"), buildProductionTrace(workflow));
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
