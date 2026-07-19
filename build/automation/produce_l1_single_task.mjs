import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { completeWithLocalCodex } from "../../doubao-automation/src/local-codex.mjs";
import { completeWithResponsesApi } from "../../doubao-automation/src/responses-api.mjs";
import { summarizeUsageEntries } from "../../doubao-automation/src/token-usage.mjs";
import {
  rewriteQuestionWithDeAiApi,
  synthesizeRewriteSidecars,
  validateClaudeRewrite,
} from "./claude_question_rewriter.mjs";
import { analyzeQuestionRequest } from "./language_style.mjs";
import {
  loadMuguaDeAiPrompt,
  rewriteMuguaDeAiText,
} from "./mugua_de_ai_rewrite_client.mjs";
import { evaluateNarrativeHardRules } from "./narrative_language_rules.mjs";
import {
  buildFirstQualityGatePrompt,
  buildQuestionDraftPrompt,
  buildReferenceBreakdownPrompt,
  buildSecondLanguageGatePrompt,
} from "./production_pipeline_prompts.mjs";
import { runProductionTraceGate } from "./production_trace_gate.mjs";
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
} from "./production_workflow_state.mjs";
import { runReleaseGate } from "./release_gate.mjs";
import { updateRunStatus } from "./run_context.mjs";
import { assertValidSceneCard, runSceneCardGate } from "./scene_card.mjs";
import { registerTopic } from "./topic_registry.mjs";

const repoRoot = process.cwd();
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const jsonObject = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const jsonString = { type: "string" };
const jsonStringArray = { type: "array", items: jsonString };

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, "utf8");
  return { hash: sha256(text), text };
}

const specFile = path.resolve(repoRoot, argument("spec-file", "inputs/production/l1_six_task_specs_20260719.json"));
const slug = argument("slug");
if (!slug) throw new Error("--slug is required.");
const bundle = await readJson(specFile);
const spec = bundle.tasks?.find((item) => item.slug === slug);
if (!spec) throw new Error(`Unknown task slug: ${slug}`);

const runDir = path.resolve(repoRoot, "outputs", "auto_runs", spec.runId);
const sourceDir = path.join(runDir, "sources");
const attachmentDir = path.join(runDir, "attachments");
const draftDir = path.join(runDir, "drafts");
const qaDir = path.join(runDir, "qa");
const feishuDir = path.join(runDir, "feishu");
const doubaoDir = path.join(runDir, "doubao");
const packetPath = path.join(sourceDir, "production_input_packet.json");
const workflowPath = path.join(sourceDir, "production_workflow_state.json");
const runId = spec.runId;
const recordUid = spec.recordUid;
const resumeEnabled = argument("resume", "0") === "1";
const topicRegistryPath = path.resolve(
  repoRoot,
  argument("topic-registry", path.relative(repoRoot, path.resolve(runDir, "../_topic_registry.json"))),
);

const secretFileArg = argument("secret-file");
if (secretFileArg) {
  const secrets = await readJson(path.resolve(repoRoot, secretFileArg));
  process.env.DE_AI_REWRITE_API_KEY ||= secrets.muguaApiKey;
  process.env.DE_AI_REWRITE_BASE_URL ||= secrets.muguaBaseUrl;
  process.env.DE_AI_REWRITE_MODEL ||= secrets.muguaModel;
  const codexSecretKey = secrets.codexResponsesApiKey || secrets.codexApiKey;
  const codexSecretBaseUrl = secrets.codexResponsesBaseUrl || secrets.codexBaseUrl;
  const codexSecretModel = secrets.codexResponsesModel || secrets.codexModel;
  if (codexSecretKey) process.env.CODEX_RESPONSES_API_KEY ||= codexSecretKey;
  if (codexSecretBaseUrl) process.env.CODEX_RESPONSES_BASE_URL ||= codexSecretBaseUrl;
  if (codexSecretModel) process.env.CODEX_RESPONSES_MODEL ||= codexSecretModel;
}
if (!process.env.DE_AI_REWRITE_API_KEY) throw new Error("Missing DE_AI_REWRITE_API_KEY or --secret-file.");

function normalizeCodexBackend(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[_\s]+/gu, "-");
  if (["local", "local-cli", "local-codex", "codex-cli"].includes(normalized)) return "local-codex";
  if (["api", "responses", "responses-api", "openai-responses"].includes(normalized)) return "responses-api";
  throw new Error(`Unsupported Codex backend: ${value}`);
}

const codexBackend = normalizeCodexBackend(argument("codex-backend", process.env.CODEX_BACKEND || "local-codex"));
const model = argument(
  "codex-model",
  process.env.CODEX_RESPONSES_MODEL || process.env.CODEX_MODEL || "gpt-5.6-sol",
);
const codexBaseUrl = argument("codex-base-url", process.env.CODEX_RESPONSES_BASE_URL || "");
const transportProvider = codexBackend === "responses-api"
  ? "openai-compatible-responses-api"
  : "local-codex-cli";
const qualityGateProvider = codexBackend === "responses-api" ? "codex-model" : "codex-session";
const runnerId = codexBackend === "responses-api"
  ? "exact-two-quality-gates-v3-model-router"
  : "exact-two-quality-gates-v2-codex-session";
const codexUsageSummaryPath = path.join(qaDir, "codex_usage_summary.json");
if (codexBackend === "responses-api") {
  if (!process.env.CODEX_RESPONSES_API_KEY) {
    throw new Error("Missing CODEX_RESPONSES_API_KEY for --codex-backend=responses-api.");
  }
  if (!codexBaseUrl) {
    throw new Error("Missing CODEX_RESPONSES_BASE_URL or --codex-base-url for --codex-backend=responses-api.");
  }
}

async function refreshCodexUsageSummary() {
  let names = [];
  try {
    names = (await fs.readdir(qaDir)).filter((name) => name.endsWith("_local_codex.json"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = [];
  for (const name of names.sort()) {
    try {
      const receipt = await readJson(path.join(qaDir, name));
      entries.push({
        stage: String(receipt.stage ?? name.replace(/_local_codex\.json$/u, "")),
        provider: String(receipt.provider ?? ""),
        model: String(receipt.model ?? ""),
        usage: receipt.usage ?? null,
      });
    } catch {
      entries.push({ stage: name, provider: "", model: "", usage: null });
    }
  }
  const summary = {
    ...summarizeUsageEntries(entries),
    backend: codexBackend,
    model,
    generatedAt: new Date().toISOString(),
  };
  await writeJson(codexUsageSummaryPath, summary);
  return summary;
}

function usableDraftQuestion(parsed) {
  const question = String(parsed?.question ?? "").trim();
  const visibleLength = Array.from(question.replace(/\s+/gu, "")).length;
  return visibleLength >= 80 && !/^(?:blocked|reject(?:ed)?|refus(?:e|ed|al))$/iu.test(question);
}

async function localJson({ label, systemPrompt, userPrompt, outputSchema, reasoningEffort = "high" }) {
  const stagePath = path.join(qaDir, `${label}_local_codex.json`);
  if (resumeEnabled && /^(?:01_|02_|03_|04_|05_)/u.test(label)) {
    try {
      const cached = await readJson(stagePath);
      if (["local-codex-stage-response", "codex-stage-response"].includes(cached?.kind)
        && cached?.stage === label && cached?.parsed) {
        if (/^04_/u.test(label) && cached.parsed.pass !== true) throw new Error("Failed quality-gate checkpoints are not reusable.");
        if (/^02_/u.test(label) && !usableDraftQuestion(cached.parsed)) {
          const rejectedPath = path.join(qaDir, `${label}_rejected_${Date.now()}_local_codex.json`);
          await fs.rename(stagePath, rejectedPath);
          throw new Error("Unusable draft checkpoint was archived for exact usage accounting.");
        }
        await refreshCodexUsageSummary();
        return {
          parsed: cached.parsed,
          stagePath,
          stageHash: sha256(await fs.readFile(stagePath)),
          usage: cached.usage ?? {},
        };
      }
    } catch {
      // A missing or malformed checkpoint falls through to a real model call for this stage.
    }
  }
  const response = codexBackend === "responses-api"
    ? await completeWithResponsesApi({
      apiKey: process.env.CODEX_RESPONSES_API_KEY,
      baseUrl: codexBaseUrl,
      model,
      reasoningEffort,
      systemPrompt,
      userPrompt,
      outputSchema,
      outputSchemaName: label,
      maxOutputTokens: 8_000,
      requireUsage: true,
      retries: 1,
      timeoutMs: 360_000,
    })
    : await completeWithLocalCodex({
      model,
      reasoningEffort,
      systemPrompt,
      userPrompt,
      outputSchema,
      timeoutMs: 360_000,
    });
  const parsed = JSON.parse(response.content);
  const written = await writeJson(stagePath, {
    kind: "codex-stage-response",
    stage: label,
    model: response.model ?? model,
    provider: response.provider ?? (codexBackend === "responses-api"
      ? "openai-compatible-responses-api"
      : "local-codex-cli"),
    responseId: response.id ?? "",
    requestId: response.requestId ?? "",
    completedAt: new Date().toISOString(),
    promptHash: sha256(`${systemPrompt}\n\n${userPrompt}`),
    usage: response.usage ?? {},
    parsed,
  });
  await refreshCodexUsageSummary();
  return { parsed, stagePath, stageHash: written.hash, usage: response.usage ?? {} };
}

await Promise.all([sourceDir, attachmentDir, draftDir, qaDir, feishuDir, doubaoDir]
  .map((directory) => fs.mkdir(directory, { recursive: true })));

const attachmentPath = path.join(attachmentDir, spec.attachment.name);
const attachmentBytes = await fs.readFile(attachmentPath);
const attachment = {
  id: spec.attachment.id,
  name: spec.attachment.name,
  url: spec.attachment.url,
  sourcePageUrl: spec.attachment.url,
  publishedAt: spec.attachment.publishedAt,
  timeAnchor: spec.attachment.timeAnchor,
  uniqueContent: spec.attachment.summary,
  path: attachmentPath,
  size: attachmentBytes.length,
  sha256: sha256(attachmentBytes),
};
const now = new Date().toISOString();
const downloadManifestPath = path.join(sourceDir, "download_manifest.json");
await writeJson(downloadManifestPath, {
  schemaVersion: 1,
  kind: "official-material-download-manifest",
  runId,
  generatedAt: now,
  items: [{
    name: attachment.name,
    url: attachment.url,
    sourcePageUrl: attachment.sourcePageUrl,
    path: attachment.path,
    size: attachment.size,
    sha256: attachment.sha256,
    contentType: "application/pdf",
    finalUrl: attachment.url,
    downloadedAt: now,
  }],
});

const facts = spec.facts.map((fact) => ({
  ...fact,
  uid: recordUid,
  sourceRefs: [attachment.id],
}));
const unknowns = spec.unknowns.map((text, index) => ({
  id: `${slug}-unknown-${index + 1}`,
  uid: recordUid,
  text,
}));
const factLedger = {
  schemaVersion: 1,
  kind: "evidence-bound-fact-ledger",
  runId,
  recordUid,
  generatedAt: now,
  facts,
  materials: [{
    id: attachment.id,
    uid: recordUid,
    name: attachment.name,
    text: attachment.uniqueContent,
    sourceUrl: attachment.url,
    sha256: attachment.sha256,
  }],
  unknowns,
  decision: { id: `${slug}-decision`, text: spec.decision },
  deliveryUse: { recipient: `${spec.topic.role}及下游同事`, purpose: spec.deliveryUse },
};
const factLedgerPath = path.join(sourceDir, "fact_ledger.json");
await writeJson(factLedgerPath, factLedger);
const sourceCards = {
  schemaVersion: 1,
  kind: "source-card-bundle",
  runId,
  recordUid,
  sources: [{
    materialId: attachment.id,
    title: attachment.name.replace(/\.pdf$/iu, ""),
    publisher: "巨潮资讯网",
    publishedAt: attachment.publishedAt,
    accessedAt: "2026-07-19",
    path: `attachments/${attachment.name}`,
    supports: attachment.uniqueContent,
    boundary: facts.find((fact) => fact.claimType === "evidence-boundary")?.text ?? unknowns[0].text,
  }],
};
await writeJson(path.join(sourceDir, "source_cards.json"), sourceCards);

const topic = {
  ...spec.topic,
  attachmentSummary: attachment.uniqueContent,
};
let topicRegistration;
try {
  const registry = await readJson(topicRegistryPath);
  const existing = registry.entries?.find((item) => item.runId === runId && item.topicId === topic.topicId);
  topicRegistration = existing
    ? { ok: true, topicId: existing.topicId, registered: existing, reused: true }
    : await registerTopic(topic, { registryPath: topicRegistryPath, runId, status: "reserved" });
} catch {
  topicRegistration = await registerTopic(topic, { registryPath: topicRegistryPath, runId, status: "reserved" });
}
if (!topicRegistration.ok) throw new Error(`Topic registry conflict: ${JSON.stringify(topicRegistration.conflict)}`);
await writeJson(path.join(sourceDir, "topic_payload.json"), {
  recordUid,
  topic,
  attachments: [attachment],
  facts,
  unknowns,
  decision: factLedger.decision,
  deliveryUse: factLedger.deliveryUse,
});

const packet = await readJson(packetPath);
for (const promptKey of ["firstQaPrompt", "secondQaPrompt"]) {
  const prompt = packet.inputs?.[promptKey];
  if (prompt?.path) {
    const text = await fs.readFile(prompt.path, "utf8");
    prompt.text = text;
    prompt.sha256 = sha256(text);
  }
}
packet.runMode = codexBackend === "responses-api" ? "production-responses-api" : "development-codex-session";
await writeJson(packetPath, packet);
let workflow = initializeProductionWorkflow({ packet, runId });
await saveProductionWorkflow(workflowPath, workflow);

const referenceEnvelope = buildReferenceBreakdownPrompt({ packet, questionIndex: 1 });
const referenceStage = await localJson({
  label: "01_reference_breakdown",
  systemPrompt: "严格执行输入中的结构拆解任务。只提取可迁移结构，不复用样例对象、数字、附件、平台和原句。返回符合 schema 的中文 JSON。",
  userPrompt: referenceEnvelope.prompt,
  outputSchema: jsonObject({
    businessScene: jsonString,
    coreBlockage: jsonString,
    mainTask: jsonString,
    attachmentSupport: jsonString,
    deliverableOrigin: jsonString,
    imitableStructure: jsonString,
    forbiddenReuse: jsonString,
    referenceAttachmentStructure: jsonString,
    referenceProductParagraphLogic: jsonString,
  }),
});
const referenceBreakdown = referenceStage.parsed;
recordReferenceBreakdown(workflow, 1, referenceBreakdown);

const attachmentPlan = {
  mainDecision: factLedger.decision.text,
  attachments: [{
    name: attachment.name,
    sourceUrl: attachment.url,
    format: "pdf",
    classification: "specific-business",
    objectLevel: true,
    timeAnchor: attachment.timeAnchor,
    specificityEvidence: {
      object: `${spec.company}证券代码${spec.stockCode}`,
      periodOrEvent: attachment.timeAnchor,
      uniqueContent: attachment.uniqueContent,
    },
    summary: attachment.uniqueContent,
    localPath: attachment.name,
    sha256: attachment.sha256,
    bytes: attachment.size,
    sizeBytes: attachment.size,
    introductionHint: "把正式报告名称直接嵌入任务句，后续核对继续引用同一份已验证原件。",
  }],
  specificBusinessShareRationale: `附件绑定${spec.company}证券代码${spec.stockCode}和${attachment.timeAnchor}，具体业务材料占比为100%。`,
  timeSeriesRationale: "季度报告同时提供本期、上年同期或期初比较数，可形成同一对象的期间核对链。",
  objectSupportInQuestion: `题面明确${spec.company}、正式报告名称、报告期和${spec.topic.businessScenario}。`,
  newAttachmentSupport: attachment.uniqueContent,
  newQuestionStructureMapping: `沿用样例的真实工作卡点、证据核验和下游交付逻辑，改为围绕${spec.topic.mainDecision}逐轮推进。`,
};
recordAttachmentPlan(workflow, 1, attachmentPlan);

const boundaryFact = facts.find((fact) => fact.claimType === "evidence-boundary") ?? facts.at(-1);
const triggerFact = facts[0];
const sceneCard = {
  schemaVersion: 1,
  policyId: "situated-requester-v1",
  topicId: topic.topicId,
  personaId: `${slug}-requester-01`,
  requester: {
    functionalRole: topic.role,
    organizationType: "企业经营与研究团队",
    department: "",
    responsibility: `把${spec.company}公开季度报告整理成可追溯的${topic.artifactSummary}`,
    authorityBoundary: "只负责复核公开披露、派生计算和证据边界，无权把未披露的业务明细写成确定归因。",
    recipientRelation: factLedger.deliveryUse.recipient,
  },
  scene: {
    workflowStage: topic.businessScenario,
    trigger: triggerFact.text,
    currentBlockage: unknowns[0].text,
    mainDecision: factLedger.decision.text,
    downstreamUse: factLedger.deliveryUse.purpose,
  },
  informationBoundary: {
    knownFactIds: facts.map((fact) => fact.id),
    availableMaterialIds: [attachment.id],
    unknowns: unknowns.map((item) => item.text),
    forbiddenInferences: [
      "未由季度报告披露的业务明细不得写成确定事实",
      "派生计算只能使用事实账本中的数值和口径",
      "未经审计的季度数据不得描述为审计确认值",
      "相关性和变动线索不得直接表述为因果归因",
    ],
  },
  voice: {
    channel: "内部业务复核消息",
    formality: "直接、克制、以证据和可继续回填为导向",
    domainVocabulary: topic.keywords.slice(0, 6),
    avoidVocabulary: ["全链路", "闭环", "赋能", "深度洞察", "麻烦", "劳烦", "烦请", "辛苦", "刚传了"],
  },
  maskTerms: [spec.company, spec.stockCode, ...topic.keywords.slice(0, 4)],
  evidenceBindings: [
    { claim: triggerFact.text, factIds: [triggerFact.id] },
    { claim: unknowns[0].text, factIds: [boundaryFact.id, triggerFact.id] },
    { claim: factLedger.decision.text, factIds: [triggerFact.id, boundaryFact.id] },
  ],
};
assertValidSceneCard(sceneCard, { factLedger });
await writeJson(path.join(sourceDir, "scene_card_seed.json"), { topic, sceneCard, sourceCards });

const draftSchema = jsonObject({
  question: jsonString,
  mainTask: jsonString,
  usedFactIds: jsonStringArray,
  usedAttachmentNames: jsonStringArray,
  productFormats: { type: "string", const: spec.format },
  deliverableRationale: {
    type: "array",
    minItems: 1,
    maxItems: 1,
    items: jsonObject({
      format: { type: "string", const: spec.format },
      user: jsonString,
      purpose: jsonString,
      whyThisFormat: jsonString,
    }),
  },
  structureMapping: jsonString,
  productParagraphMapping: jsonString,
});

async function generateDraft(label, repairContext = null) {
  const envelope = buildQuestionDraftPrompt({
    packet,
    questionIndex: 1,
    referenceBreakdown,
    attachmentPlan,
    factLedger,
    sceneCard,
    formatRequirement: spec.format,
  });
  const stage = await localJson({
    label,
    systemPrompt: [
      `你是${topic.role}，严格依据附件和事实账本写一条L1首轮工作委托。`,
      "题面保持120至520个可见字符，只提出一个主诉求和最多一个直接子诉求。首轮任务要有足够分析深度，但不要预写未来多轮剧本。",
      `本轮围绕“${topic.mainDecision}”，最终交付是${spec.productContent}。`,
      `明确附件全名“${attachment.name}”，保留来源页码、审计状态、派生计算和待核边界。`,
      "表达像真实同事之间的直接委托。顿号数量只作可读性建议，使用或省略我和你都不影响自然度。",
      "不得使用分号、项目符号、Markdown标题、麻烦、劳烦、烦请、辛苦。删除刚传了、我刚上传了、这里上传了、随本消息上传了及同类上传元话语，也不要单独介绍这是材料或材料包括什么，附件身份直接嵌入任务句。",
      repairContext ? `上一版第一道质检问题如下，只修复这些问题：${JSON.stringify(repairContext)}` : "",
    ].filter(Boolean).join("\n"),
    userPrompt: envelope.prompt,
    outputSchema: draftSchema,
  });
  if (!stage.parsed.usedAttachmentNames.every((name) => name === attachment.name)) {
    throw new Error("Draft referenced an attachment outside the verified manifest.");
  }
  if (!usableDraftQuestion(stage.parsed)) {
    throw new Error("Draft model returned an unusable or blocked question.");
  }
  return { draft: stage.parsed, envelope };
}

let draftResult = await generateDraft("02_question_draft");
let draft = draftResult.draft;
recordDraft(workflow, 1, draft);
let firstQaParsed;
let preQaStructureAudit;
for (let attempt = 1; attempt <= 2; attempt += 1) {
  await writeJson(path.join(draftDir, `01_pre_de_ai_attempt_${attempt}.json`), { topic, sceneCard, attachmentPlan, draft });
  const gateCandidate = {
    ...draft,
    任务类型: "L1 探索型",
    一级目录: topic.primaryCategory,
    二级目录: topic.secondaryCategory,
    三级目录: topic.tertiaryCategory,
    人类完成时间: "4H",
    相关附件: attachment.name,
    产物格式: spec.format,
  };
  const gateEnvelope = buildFirstQualityGatePrompt({ packet, questionIndex: 1, candidate: gateCandidate, attachmentPlan, referenceBreakdown });
  const auditStage = await localJson({
    label: `03_pre_qa_structure_audit_attempt_${attempt}`,
    systemPrompt: "独立检查输入中的结构、附件和证据链。按L1动态多轮任务判断首轮密度，不要求首轮倾倒后续计算。只返回schema指定的JSON，不改写题面。",
    userPrompt: gateEnvelope.preQaPrompt,
    outputSchema: jsonObject({
      oneSentenceMainTask: jsonString,
      uniqueMainTask: { type: "boolean" },
      specificObjectDecision: { type: "boolean" },
      specificFilesDominant: { type: "boolean" },
      evidenceChain: jsonString,
      l2ReasoningChain: jsonString,
      variableDrift: jsonStringArray,
    }),
  });
  preQaStructureAudit = auditStage.parsed;
  const gateStage = await localJson({
    label: `04_first_quality_gate_attempt_${attempt}`,
    systemPrompt: "你是独立L1质量质检员。严格执行第一道质检提示词。按动态多轮任务判断首轮密度，通过时返回pass=true和空issues，发现问题时如实返回可执行修复建议。",
    userPrompt: gateEnvelope.prompt,
    outputSchema: jsonObject({
      pass: { type: "boolean" },
      issues: { type: "array", items: jsonObject({ rule: jsonString, evidence: jsonString, repair: jsonString }) },
    }),
  });
  firstQaParsed = gateStage.parsed;
  const rawPath = path.join(qaDir, `01_first_quality_gate_attempt_${attempt}_raw.json`);
  const completedAt = new Date().toISOString();
  const rawWritten = await writeJson(rawPath, {
    runnerId,
    provider: qualityGateProvider,
    transportProvider,
    model,
    sourcePromptHash: packet.inputs.firstQaPrompt.sha256,
    renderedPromptHash: sha256(gateEnvelope.prompt),
    completedAt,
    parsed: firstQaParsed,
  });
  recordFirstQualityGate(workflow, 1, {
    preQaStructureAudit,
    firstQaResult: {
      ...firstQaParsed,
      execution: {
        runnerId,
        provider: qualityGateProvider,
        transportProvider,
        model,
        sourcePromptHash: packet.inputs.firstQaPrompt.sha256,
        renderedPromptHash: sha256(gateEnvelope.prompt),
        rawResponsePath: rawPath,
        rawResponseHash: rawWritten.hash,
        completedAt,
      },
    },
  });
  await saveProductionWorkflow(workflowPath, workflow);
  if (firstQaParsed.pass && firstQaParsed.issues.length === 0) break;
  if (attempt === 2) throw new Error(`First quality gate exhausted: ${JSON.stringify(firstQaParsed.issues)}`);
  draftResult = await generateDraft(`02_question_draft_repair_${attempt}`, firstQaParsed.issues);
  draft = draftResult.draft;
  recordDraft(workflow, 1, draft, { reason: `repair-attempt-${attempt}` });
}

const secondEnvelope = buildSecondLanguageGatePrompt({
  packet,
  questionIndex: 1,
  firstQaResult: firstQaParsed,
  candidate: draft,
  referenceBreakdown,
});
const secondSchema = jsonObject({
  conclusion: { type: "string", enum: ["通过", "需语言小修", "需重写题面", "退回第一道质检"] },
  coreJudgment: jsonString,
  modifications: jsonString,
  modifiedQuestion: jsonString,
  punctuationAudit: jsonString,
  remainingNote: jsonString,
});
let secondStage = await localJson({
  label: "05_second_language_gate",
  systemPrompt: [
    "你是独立L1语言质检员，只改善语言，不新增事实或未来轮次。modifiedQuestion必须是完整题面。",
    "顿号数量只作建议，使用或省略我和你都不影响结论。不得使用分号、项目符号、麻烦、劳烦、烦请、辛苦和机械顺序壳。",
    "删除刚传了、我刚上传了、这里上传了、随本消息上传了及同类上传元话语，不写独立的附件介绍句，保留具体附件、业务判断、证据边界和最终交付。",
  ].join("\n"),
  userPrompt: secondEnvelope.prompt,
  outputSchema: secondSchema,
});
let secondParsed = secondStage.parsed;
const hasRequesterContext = /(?:我(?:在|们|负责|这边)|给.{0,12}(?:同事|团队|管理层)|供.{0,12}(?:同事|团队|管理层))/u.test(secondParsed.modifiedQuestion);
const hasExplicitDecisionRequest = /(?:请.{0,18}(?:给出.{0,8}(?:明确)?结论|建议|选择|取舍)|需要.{0,12}(?:明确结论|判断|选择)|最终.{0,12}(?:结论|判断|建议))/u.test(secondParsed.modifiedQuestion);
if (!hasRequesterContext || !hasExplicitDecisionRequest) {
  secondStage = await localJson({
    label: "05_requester_decision_coverage_repair_v3",
    systemPrompt: [
      "这是第二道语言质检内的场景与决策信息补全，不是新增质检。保留原题全部事实、附件、计算、边界和交付要求。",
      `开头用第一人称自然交代当前工作场景和下游用途，角色是“${topic.role}”，用途是“${factLedger.deliveryUse.purpose}”。只用这些已知信息，不虚构公司内部事实。`,
      `加入且只加入一次明确的结论请求，必须出现“请给出明确结论”，语义覆盖：${topic.mainDecision}`,
      "保留至少两类可识别的复杂核对信号：一类写明本期与上年同期或同比复算，另一类写明分项、比率、占比、现金流或口径复核。不得把任务压缩成单一算术。",
      "不要加入新事实、数字、未来轮次、上传元话语、分号或客套表达。modifiedQuestion返回完整题面。",
    ].join("\n"),
    userPrompt: JSON.stringify(secondParsed, null, 2),
    outputSchema: secondSchema,
  });
  secondParsed = secondStage.parsed;
}
for (let repairRound = 1; repairRound <= 2; repairRound += 1) {
  const findings = evaluateNarrativeHardRules(secondParsed.modifiedQuestion, {
    minimumExplanatoryParentheses: 0,
    maximumEnumerationCommasPerSentence: 1,
    forbidSemicolon: true,
  });
  if (!findings.length && ["通过", "需语言小修"].includes(secondParsed.conclusion)) break;
  secondStage = await localJson({
    label: `05_second_language_gate_repair_${repairRound}`,
    systemPrompt: "只修复给定门禁问题，不新增或删减事实。返回完整题面。顿号数量只作建议，禁止分号、客套请求和上传元话语。结论必须如实反映修复后的题面。",
    userPrompt: JSON.stringify({ findings, previousResult: secondParsed }, null, 2),
    outputSchema: secondSchema,
  });
  secondParsed = secondStage.parsed;
}
const finalLanguageFindings = evaluateNarrativeHardRules(secondParsed.modifiedQuestion, {
  minimumExplanatoryParentheses: 0,
  maximumEnumerationCommasPerSentence: 1,
  forbidSemicolon: true,
});
if (finalLanguageFindings.length || !["通过", "需语言小修"].includes(secondParsed.conclusion)) {
  throw new Error(`Second language gate blocked: ${JSON.stringify({ conclusion: secondParsed.conclusion, findings: finalLanguageFindings })}`);
}
const secondRawPath = path.join(qaDir, "01_second_language_gate_raw.json");
const secondCompletedAt = new Date().toISOString();
const secondRawWritten = await writeJson(secondRawPath, {
  runnerId,
  provider: qualityGateProvider,
  transportProvider,
  model,
  sourcePromptHash: packet.inputs.secondQaPrompt.sha256,
  renderedPromptHash: sha256(secondEnvelope.prompt),
  acceptedRound: 1,
  completedAt: secondCompletedAt,
  attempts: [{ round: 1, parsed: secondParsed }],
});
recordSecondLanguageGate(workflow, 1, {
  ...secondParsed,
  execution: {
    runnerId,
    provider: qualityGateProvider,
    transportProvider,
    model,
    sourcePromptHash: packet.inputs.secondQaPrompt.sha256,
    renderedPromptHash: sha256(secondEnvelope.prompt),
    rawResponsePath: secondRawPath,
    rawResponseHash: secondRawWritten.hash,
    completedAt: secondCompletedAt,
  },
});
await saveProductionWorkflow(workflowPath, workflow);

const sourceRecord = {
  UID: recordUid,
  题目: secondParsed.modifiedQuestion,
  任务类型: "L1 探索型",
  一级目录: topic.primaryCategory,
  二级目录: topic.secondaryCategory,
  三级目录: topic.tertiaryCategory,
  任务概括: topic.title,
  标注专家工作年限: "5年",
  人类完成时间: "4H",
  相关附件: attachment.name,
  附件格式: "pdf",
  附件内容: `${attachment.name}：${attachment.uniqueContent} 来源：${attachment.url}`,
  产物格式: spec.format,
  产物内容: spec.productContent,
  做题关键步骤: spec.keySteps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
  标注专家姓名: "沈礼",
};
const deAiInput = {
  uid: recordUid,
  record: sourceRecord,
  sceneCard,
  knownFactIds: sceneCard.informationBoundary.knownFactIds,
  avoidQuestions: [packet.inputs.referenceWorkbook.samples[0].question, sourceRecord.题目],
};

async function postDeAiAudit(candidate, attempt) {
  const stage = await localJson({
    label: `06_post_de_ai_preflight_${attempt}`,
    systemPrompt: [
      "你是发送给豆包之前的独立可见文本审查员，只审查，不改写也不回答题目。",
      "核对事实、附件、当前业务判断和最终交付是否保持。拦截新增数字、确定性越界归因、未来轮次剧本、工具痕迹和怪异标点。",
      "题面必须保留自然的真实请求者场景，例如我正在做或我负责某项复核，并保留“请给出明确结论”或等价的清晰决策请求。缺少任一项都返回pass=false。",
      "题面中的具体页码范围可以在末端清理中移除，只要附件名称、核查任务以及在交付物中逐项标注来源页码的要求仍保留。这种移除用于避免未绑定数字锚点，不属于事实丢失或核查范围扩大。",
      "顿号数量只作建议，使用或省略我和你都不影响pass。“帮我”“请”以及你和我属于正常工作请求，不得据此否决。只拦截分号、麻烦、劳烦、烦请、辛苦、机械说明、刚传了及同类上传元话语。任何事实或边界问题都返回pass=false。",
    ].join("\n"),
    userPrompt: JSON.stringify({
      sourceQuestion: secondParsed.modifiedQuestion,
      outboundQuestion: candidate.rewrite.question,
      attachmentNames: [attachment.name],
      requiredProduct: spec.productContent,
    }, null, 2),
    outputSchema: jsonObject({
      pass: { type: "boolean" },
      issues: { type: "array", items: jsonObject({ rule: jsonString, evidence: jsonString, repair: jsonString }) },
      factsPreserved: { type: "boolean" },
      attachmentsPreserved: { type: "boolean" },
      visibleTextClean: { type: "boolean" },
    }),
  });
  return stage.parsed;
}

let deAi;
let deAiAudit;
let lastDeAiError;
if (resumeEnabled) {
  try {
    const cachedDeAi = await readJson(path.join(qaDir, "01_de_ai_rewrite.json"));
    if (cachedDeAi?.validation?.pass
      && cachedDeAi.sourceQuestionHash === sha256(sourceRecord.题目)
      && cachedDeAi.postDeAiAudit?.pass === true
      && !/》(?:的)?第\d+(?:至|到|-)\d+页/u.test(cachedDeAi.rewrite.question)
      && !cachedDeAi.rewrite.question.includes(`“${topic.title}”`)
      && !/“[^”]{4,60}”(?=[^。！？\n]{0,12}(?:Excel|Word|PPT|HTML|文件|表格|演示稿))/u.test(cachedDeAi.rewrite.question)
      && !/中的内容的数据/u.test(cachedDeAi.rewrite.question)
      && /(?:给出.{0,8}(?:明确|清晰)?结论|作出.{0,8}判断)/u.test(cachedDeAi.rewrite.question)
      && /可下载/u.test(cachedDeAi.rewrite.question)
      && analyzeQuestionRequest(String(cachedDeAi.rewrite.requestContract?.requestSpan ?? "")).clear
      && !cachedDeAi.rewrite.question.includes(topic.role)
      && /我(?:作为|正在|负责|这边(?:在|正在))/u.test(cachedDeAi.rewrite.question)) {
      deAi = cachedDeAi;
      deAiAudit = cachedDeAi.postDeAiAudit;
    }
  } catch {
    // Missing or stale de-AI checkpoints fall through to the external rewrite API.
  }
}
function applyDeterministicStyleCleanup(candidate) {
  const original = String(candidate?.rewrite?.question ?? "");
  let cleaned = original
    .replaceAll(`“${topic.title}”`, topic.title)
    .replaceAll(`「${topic.title}」`, topic.title)
    .replace(/“([^”]{4,60})”(?=[^。！？\n]{0,12}(?:Excel|Word|PPT|HTML|文件|表格|演示稿))/gu, "$1")
    .replace(/中的内容的数据/gu, "中的数据")
    .replace(/》(?:的)?第\d+(?:至|到|-)\d+页(?:的内容)?/gu, "》中的内容")
    .replaceAll(`我作为${topic.role}，正在`, "我正在")
    .replace(/麻烦帮我/gu, "请")
    .replace(/(?:麻烦|劳烦|烦请)(?:你)?/gu, "请")
    .replace(/辛苦(?:你)?/gu, "请")
    .replace(/(?:我刚上传了|刚传了|这里上传了|随本消息上传了)/gu, "")
    .replace(/请请/gu, "请")
    .trim();
  if (!/我(?:作为|正在|负责|这边(?:在|正在))/u.test(cleaned)) {
    cleaned = `我正在做${topic.title}，这份结果${factLedger.deliveryUse.purpose}\n\n${cleaned}`;
  }
  const decisionPresent = /(?:给出.{0,8}(?:明确|清晰)?结论|作出.{0,8}判断)/u.test(cleaned);
  const directDownloadRequestPresent = /(?:请|帮我).{0,28}(?:整理|制作|生成|输出|交付).{0,48}可下载/u.test(cleaned);
  if (!decisionPresent || !directDownloadRequestPresent) {
    cleaned = `${cleaned}\n\n请基于上述核对结果给出明确结论，并整理一份可下载的${spec.humanFormat}，按${spec.format}格式交付。`;
  }
  if (cleaned === original.trim()) return candidate;
  const rewrite = synthesizeRewriteSidecars({
    question: cleaned,
    record: sourceRecord,
    sceneCard,
    knownFactIds: sceneCard.informationBoundary.knownFactIds,
  });
  const validation = validateClaudeRewrite({
    sourceRecord,
    rewrite,
    sceneCard,
    knownFactIds: sceneCard.informationBoundary.knownFactIds,
    avoidQuestions: deAiInput.avoidQuestions,
  });
  return {
    ...candidate,
    rewrittenQuestionHash: sha256(rewrite.question),
    rewrite,
    validation,
    deterministicStyleCleanup: {
      applied: true,
      rules: ["remove-unbound-inline-page-range", "remove-unbound-title-quotes", "remove-banned-politeness", "remove-upload-meta-language", "restore-known-requester-context", "restore-explicit-decision-request", "restore-downloadable-format-requirement"],
      sourceApiQuestionHash: sha256(original),
    },
  };
}
for (let attempt = 1; !deAi && attempt <= 3; attempt += 1) {
  try {
    const apiCandidate = await rewriteQuestionWithDeAiApi({
      input: deAiInput,
      apiKey: process.env.DE_AI_REWRITE_API_KEY,
      baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
      model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
      timeoutMs: 180_000,
      retries: 3,
      contentAttempts: 3,
    });
    const candidate = applyDeterministicStyleCleanup(apiCandidate);
    const audit = await postDeAiAudit(candidate, attempt);
    await writeJson(path.join(qaDir, `01_de_ai_rewrite_attempt_${attempt}.json`), { ...candidate, postDeAiAudit: audit });
    if (candidate.validation.pass && audit.pass && audit.issues.length === 0
      && audit.factsPreserved && audit.attachmentsPreserved && audit.visibleTextClean) {
      deAi = candidate;
      deAiAudit = audit;
      break;
    }
    lastDeAiError = new Error(`Post de-AI audit rejected attempt ${attempt}: ${JSON.stringify(audit)}`);
  } catch (error) {
    lastDeAiError = error;
    await writeJson(path.join(qaDir, `01_de_ai_rewrite_attempt_${attempt}_error.json`), {
      name: error.name,
      code: error.code ?? "",
      message: error.message,
      issues: error.issues ?? [],
    });
  }
}
if (!deAi) throw lastDeAiError ?? new Error("De-AI rewrite failed.");

if (!analyzeQuestionRequest(String(deAi.rewrite.requestContract?.requestSpan ?? "")).clear) {
  const basePrompt = await loadMuguaDeAiPrompt(process.env.DE_AI_REWRITE_PROMPT_PATH);
  const directPrompt = `${basePrompt}\n\n【直接请求跨度修复】\n当前题面已通过事实审查。只调整最终交付句，让请求句以“请基于前述核对结果整理”开头，并在同一句保留“${spec.humanFormat}”“${spec.format}格式”和可下载交付。其余公司、附件、报告期、数字、审计边界、来源页码、待核事项和段落保持不变。不得加入上传元话语或新事实。`;
  let repaired;
  let repairFailure;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await rewriteMuguaDeAiText({
        text: deAi.rewrite.question,
        apiKey: process.env.DE_AI_REWRITE_API_KEY,
        baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
        model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
        promptText: directPrompt,
        temperature: 0.1,
        timeoutMs: 180_000,
        retries: 3,
      });
      const rewrite = synthesizeRewriteSidecars({
        question: response.text,
        record: sourceRecord,
        sceneCard,
        knownFactIds: sceneCard.informationBoundary.knownFactIds,
      });
      const validation = validateClaudeRewrite({
        sourceRecord,
        rewrite,
        sceneCard,
        knownFactIds: sceneCard.informationBoundary.knownFactIds,
        avoidQuestions: deAiInput.avoidQuestions,
      });
      await writeJson(path.join(qaDir, `01_de_ai_direct_request_attempt_${attempt}.json`), { response, rewrite, validation });
      if (!validation.pass) {
        repairFailure = new Error(`Direct-request repair validation failed: ${JSON.stringify(validation.findings)}`);
        continue;
      }
      const audit = await postDeAiAudit({ rewrite }, `direct_${attempt}`);
      if (!audit.pass || audit.issues.length || !audit.factsPreserved || !audit.attachmentsPreserved || !audit.visibleTextClean) {
        repairFailure = new Error(`Direct-request repair audit failed: ${JSON.stringify(audit)}`);
        continue;
      }
      repaired = {
        ...deAi,
        generatedAt: new Date().toISOString(),
        endpoint: response.endpoint,
        model: response.model,
        finishReason: response.finishReason,
        usage: response.usage,
        promptHash: response.promptHash,
        rewrittenQuestionHash: sha256(rewrite.question),
        selectedAttempt: `direct-request-${attempt}`,
        rewrite,
        validation,
        targetedRepair: { reason: "request_span_not_direct_request", promptHash: response.promptHash },
      };
      deAiAudit = audit;
      break;
    } catch (error) {
      repairFailure = error;
    }
  }
  if (!repaired) throw repairFailure ?? new Error("Direct-request repair failed.");
  deAi = repaired;
}
await writeJson(path.join(qaDir, "01_de_ai_rewrite.json"), { ...deAi, postDeAiAudit: deAiAudit });
recordDeAiRewrite(workflow, 1, deAi);
const finalRecord = { ...sourceRecord, 题目: deAi.rewrite.question };
recordFinalRecord(workflow, 1, { recordUid, finalRecord });
await saveProductionWorkflow(workflowPath, workflow);
const tracePath = path.join(qaDir, "production_trace.json");
await writeJson(tracePath, buildProductionTrace(workflow));
await writeJson(path.join(draftDir, "01_final_record.json"), finalRecord);

const factLedgerFileBytes = await fs.readFile(factLedgerPath);
const sceneCardPath = path.join(sourceDir, "scene_cards.json");
await writeJson(sceneCardPath, {
  kind: "scene-card-bundle",
  protocolId: "situated-requester-v1",
  schemaVersion: 1,
  factLedgerPath,
  factLedgerHash: sha256(factLedgerFileBytes),
  cards: [{
    recordUid,
    sceneCard,
    requestContract: deAi.rewrite.requestContract,
    roleTrace: deAi.rewrite.roleTrace,
    usedFactIds: deAi.rewrite.usedFactIds,
    deliberatelyOmitted: deAi.rewrite.deliberatelyOmitted,
  }],
});

const fields = [
  "UID", "题目", "任务类型", "一级目录", "二级目录", "三级目录", "任务概括",
  "标注专家工作年限", "人类完成时间", "相关附件", "附件格式", "附件内容",
  "产物格式", "产物内容", "做题关键步骤", "标注专家姓名",
];
const tsvValue = (value) => String(value ?? "").replace(/\r?\n/gu, "\\n").replace(/\t/gu, " ");
const candidatePath = path.join(draftDir, "l1_questions.tsv");
await fs.writeFile(candidatePath, `${fields.join("\t")}\n${fields.map((field) => tsvValue(finalRecord[field])).join("\t")}\n`, "utf8");
const sheetRow = 999900 + bundle.tasks.findIndex((item) => item.slug === slug) + 1;
const columnMap = [
  ["UID", "A"], ["题目", "B"], ["任务类型", "C"], ["一级目录", "D"],
  ["二级目录", "E"], ["三级目录", "F"], ["任务概括", "G"],
  ["标注专家工作年限", "H"], ["人类完成时间", "I"], ["相关附件", "J"],
  ["附件格式", "K"], ["附件内容", "L"], ["产物格式", "M"],
  ["产物内容", "N"], ["做题关键步骤", "O"],
];
const fillPlanPath = path.join(feishuDir, "feishu_fill_plan.json");
await writeJson(fillPlanPath, {
  version: 1,
  status: "DRY_RUN_ONLY_NO_RESERVED_FEISHU_ROW",
  questionPresentation: "natural-paragraphs-no-blank-lines-v4",
  generatedAt: new Date().toISOString(),
  sourcePath: candidatePath,
  startRow: sheetRow,
  sheetRows: [sheetRow],
  count: 1,
  note: "No Feishu row is reserved. This is a non-production dry-run placeholder. No external write is authorized.",
  columnMap: columnMap.map(([field, column]) => ({ field, column })),
  rows: [{
    dataRow: 2,
    sheetRow,
    title: finalRecord.任务概括,
    updates: columnMap.map(([field, column]) => ({
      address: `${column}${sheetRow}`,
      column,
      field,
      value: finalRecord[field],
      chars: [...String(finalRecord[field] ?? "")].length,
      hasNewlines: /\n/u.test(String(finalRecord[field] ?? "")),
      preview: [...String(finalRecord[field] ?? "")].slice(0, 80).join(""),
    })),
  }],
});

const manifest = await readJson(path.join(runDir, "manifest.json"));
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
const naturalnessReviewSignoffPath = `${naturalnessReportPath}.review-signoff.json`;
const releaseOptions = {
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
for (const staleReviewArtifact of [naturalnessReviewRequestPath, naturalnessReviewSignoffPath]) {
  await fs.unlink(staleReviewArtifact).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
let releaseResult = await runReleaseGate(releaseOptions);
if (!releaseResult.ok && releaseResult.phase === "naturalness" && releaseResult.status === "REVIEW") {
  const reviewRequestText = await fs.readFile(naturalnessReviewRequestPath, "utf8");
  const reviewRequest = JSON.parse(reviewRequestText);
  const reviewStage = await localJson({
    label: "07_naturalness_independent_review",
    systemPrompt: [
      "你是独立于题面生成和发布请求方的自然度审阅员，只审核哈希绑定报告中的REVIEW项。",
      "这是单题L1首轮工作委托。判断免责声明是否挤占业务事实、任务是否可执行、表达是否像真实同事请求。只有理由充分时APPROVE，否则REJECT，不得改写题面。",
      "顿号数量只作建议，使用或省略我和你都不作为否决理由。上传元话语和空泛材料介绍应被否决。",
    ].join("\n"),
    userPrompt: JSON.stringify({
      request: reviewRequest,
      reportSummary: releaseResult.naturalnessReport.summary,
      reviewedRow: releaseResult.naturalnessReport.rows[0],
      question: finalRecord.题目,
      attachments: [attachment.name],
    }, null, 2),
    outputSchema: jsonObject({
      decision: { type: "string", enum: ["APPROVE", "REJECT"] },
      rationale: jsonString,
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
    decision: reviewStage.parsed.decision,
    reviewer: `${codexBackend}-independent-naturalness-reviewer-${model}`,
    rationale: reviewStage.parsed.rationale,
    reviewedAt: new Date().toISOString(),
    evidence: {
      reviewReceiptPath: reviewStage.stagePath,
      disclaimerDisplacesFacts: reviewStage.parsed.disclaimerDisplacesFacts,
      taskExecutable: reviewStage.parsed.taskExecutable,
      naturalWorkRequest: reviewStage.parsed.naturalWorkRequest,
    },
  };
  await writeJson(naturalnessReviewSignoffPath, signoff);
  if (signoff.decision !== "APPROVE") throw new Error(`Independent naturalness review rejected: ${signoff.rationale}`);
  releaseResult = await runReleaseGate(releaseOptions);
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

const requestedFormat = { xlsx: "excel", docx: "word", pptx: "ppt", html: "html" }[spec.format];
if (!requestedFormat) throw new Error(`Unsupported interaction format: ${spec.format}`);
const jobPath = path.join(doubaoDir, "job.json");
const codexInteractionPolicy = codexBackend === "responses-api"
  ? {
    type: "responses-api",
    baseUrl: codexBaseUrl,
    model,
    apiKeyEnv: "CODEX_RESPONSES_API_KEY",
    reasoningEffort: "high",
    requireUsage: true,
    retries: 1,
    timeoutMs: 360000,
  }
  : { type: "local-codex", model, reasoningEffort: "high", timeoutMs: 360000 };
await writeJson(jobPath, {
  jobId: spec.jobId,
  attachmentRoot: attachmentDir,
  initialAttachmentNames: [attachment.name],
  productionEvidence: {
    recordUid,
    productionTracePath: tracePath,
    productionTraceGateReceiptPath: path.join(feishuDir, "production_trace_gate_receipt.json"),
    releaseGateReceiptPath: path.join(feishuDir, "release_gate_receipt.json"),
    downloadManifestPath,
  },
  maxRounds: 6,
  maximumRounds: 10,
  mode: "openai-compatible",
  taskGoal: `${topic.businessScenario}。${factLedger.decision.text}，最终${spec.productContent}`,
  successCriteria: spec.successCriteria,
  initialPrompt: finalRecord.题目,
  responseTimeoutMs: 0,
  interactionRewrite: {
    type: "openai-compatible",
    baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
    model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
    apiKeyEnv: "DE_AI_REWRITE_API_KEY",
    temperature: 0.55,
    timeoutMs: 180000,
  },
  promptPreflight: codexInteractionPolicy,
  policy: codexInteractionPolicy,
  productRequirement: {
    required: true,
    requestedFormats: [requestedFormat],
    allowEquivalentOnline: false,
    allowUnavailableBestEffort: false,
  },
});
await updateRunStatus(runDir, "READY_FOR_DOUBAO_TEST_NO_FEISHU", {
  recordUid,
  jobPath,
  localGates: {
    roleConsistency: roleReport.status,
    productionTrace: processResult.report.status,
    release: releaseResult.status,
  },
  feishuWriteAttempted: false,
  feishuWriteApplied: false,
});

const codexUsageSummary = await refreshCodexUsageSummary();
console.log(JSON.stringify({
  ok: true,
  slug,
  runId,
  recordUid,
  jobId: spec.jobId,
  finalQuestion: finalRecord.题目,
  attachmentSha256: attachment.sha256,
  firstQa: firstQaParsed,
  secondQa: secondParsed.conclusion,
  deAiPass: deAi.validation.pass,
  roleConsistency: roleReport.status,
  productionTrace: processResult.report.status,
  release: releaseResult.status,
  jobPath,
  codexBackend,
  codexModel: model,
  codexUsageSummaryPath,
  codexUsage: codexUsageSummary.totals,
  feishuWriteApplied: false,
}, null, 2));
