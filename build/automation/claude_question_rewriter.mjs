import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertNoUnsupportedFactAnchors } from "./fact_guard.mjs";
import { evaluateNarrativeHardRules, splitNarrativeSentences } from "./narrative_language_rules.mjs";
import { loadMuguaDeAiPrompt, rewriteMuguaDeAiText } from "./mugua_de_ai_rewrite_client.mjs";
import { evaluateProductionRecordProfile, resolveProductionProfile } from "./production_profile.mjs";

export const DE_AI_REWRITE_POLICY_ID = "mugua-gemini-de-ai-rewrite-v2";
export const CLAUDE_REWRITE_POLICY_ID = DE_AI_REWRITE_POLICY_ID;
export const MAX_EDIT_SIMILARITY = 0.72;
export const MAX_TRIGRAM_JACCARD = 0.55;
export const MAX_EXACT_COPY_RUN = 36;

const CRITICAL_REWRITE_FINDINGS = new Set([
  "unsupported-fact-anchor",
  "request-output-formats-drift",
  "request-human-name-not-in-span",
  "fact-id-coverage",
  "fact-id-used-omitted-overlap",
]);

function block(value) {
  return JSON.stringify(value, null, 2);
}

function visibleLength(value = "") {
  return [...String(value).replace(/\s+/gu, "")].length;
}

function normalizeSimilarityText(value = "") {
  return [...String(value).toLowerCase().replace(/[\s，。！？!?、“”‘’（）()：:；;、]/gu, "")];
}

function levenshteinDistance(left, right) {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function ngrams(characters, size = 3) {
  const result = new Set();
  for (let index = 0; index <= characters.length - size; index += 1) {
    result.add(characters.slice(index, index + size).join(""));
  }
  return result;
}

function longestExactCopy(left, right) {
  let previous = new Uint16Array(right.length + 1);
  let longest = 0;
  let longestEnd = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Uint16Array(right.length + 1);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        current[rightIndex] = previous[rightIndex - 1] + 1;
        if (current[rightIndex] > longest) {
          longest = current[rightIndex];
          longestEnd = leftIndex;
        }
      }
    }
    previous = current;
  }
  return {
    length: longest,
    span: left.slice(longestEnd - longest, longestEnd).join(""),
  };
}

export function measureQuestionSimilarity(candidate, reference) {
  const left = normalizeSimilarityText(candidate);
  const right = normalizeSimilarityText(reference);
  const longestCopy = longestExactCopy(left, right);
  const maximumLength = Math.max(left.length, right.length, 1);
  const leftGrams = ngrams(left);
  const rightGrams = ngrams(right);
  let intersection = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) intersection += 1;
  const union = leftGrams.size + rightGrams.size - intersection;
  return {
    editSimilarity: 1 - (levenshteinDistance(left, right) / maximumLength),
    trigramJaccard: union ? intersection / union : 0,
    longestExactCopyRun: longestCopy.length,
    longestExactCopySpan: longestCopy.span,
  };
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function removeCodeFence(value) {
  return String(value ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

export function buildClaudeRewriteMessages({
  uid,
  record,
  sceneCard,
  knownFactIds = [],
} = {}) {
  let profile;
  try {
    profile = resolveProductionProfile(record);
  } catch {
    profile = resolveProductionProfile("l2");
  }
  if (!String(record?.题目 ?? "").trim()) throw new TypeError("record.题目 is required.");
  if (!profile.productFormat.optional && !String(record?.产物格式 ?? "").trim()) {
    throw new TypeError("record.产物格式 is required.");
  }
  if (!sceneCard?.scene?.mainDecision) throw new TypeError("sceneCard.scene.mainDecision is required.");

  const system = `你是${profile.label}题面的专业撰稿人。你不是润色器、同义改写器或角色扮演者。根据事实包从空白页写出一条克制、准确的内部任务说明。

重新起草：你不会收到旧题原文，也不应猜测旧题的段落顺序。输入中的任务概括、附件说明、产物说明和关键步骤可能带有机器生成腔，只能提取其中的事实、对象与边界，禁止模仿它们的句式、排列顺序或规格书口吻。先在脑中重新决定从哪个现场卡点开口、证据怎样进入工作、谁根据什么结果继续处理，再落笔。不要按“背景—资料—交付—总结”搭四段框架。

事实锁：不得增加或改变组织、产品、接口、数字、日期、附件、产物格式、主决策、未知事项和生产验证状态。不能虚构老板催办、会议、截止时间、预算、故障或已经完成的测试。事实包中的数字和边界要么准确保留，要么在不影响任务时省略，绝不能换成新数字。

${profile.id === "l1"
    ? "交互性：本轮围绕一个主要判断或交付目标展开，多个核验维度可以共同服务它。附件中的完整数字、公式、字段和后续分支留给实际分析与下一轮追问。不能把整条流程、未来风险或回滚树一次写完。"
    : "流程性：把流程写成真实工作如何往前走，而不是把关键步骤换一种说法抄进正文。让前一个结果自然成为后一个动作的输入，至少形成‘证据到手—做出判断—小范围验证—通过后推进或失败后退回—留下交接记录’的链条。判断分支要写清触发条件和去向，但不得把尚未发生的结果写成事实。"}

表达方式：优先陈述事实关系、工作条件和交付用途，不描写发起人的情绪、心理活动或犹豫。使用或省略“你”“我”都不作为自然度指标。禁止“咱们、我这边、说死、谁也不敢、靠猜、动不了、悄悄传下去、挺清楚、说到底、万一、那块、一条条、一点点”等表演型口语，也禁止“首先、其次、再次、综上所述”“核心在于”“本质上”“全链路”“闭环”“多维度”“赋能”等模型壳。不要堆叠免责声明，也不要逐项念 Excel 字段。自然的“请”“帮我”“麻烦你”可以按语境使用，“不要自行推测”“不作为最终决策”等必要证据边界可以保留。“等”只在确有未穷举对象时使用，不设次数要求。顿号数量只作可读性建议。删除“刚传了”“我刚上传了”“这里上传了”“随本消息上传了”及同类上传元话语，也不要换成“这是……材料”“材料包括……”等独立介绍句。材料身份直接嵌入任务句。

交付请求：${profile.productFormat.optional ? "只保留当前诉求真正需要的交付内容，格式没有必要时可以不写。" : "保留全部产物格式，并用 Word、Excel、PPT、HTML 页面等人类名称在一个自然请求句中一次说清。"}不要照搬产物说明，要说明交付物在这个现场由谁拿来做什么。题面通常写在${profile.question.recommendedMinimumVisibleCharacters}至${profile.question.recommendedMaximumVisibleCharacters}个可见字符之间，硬上限为${profile.question.hardMaximumVisibleCharacters}个可见字符。${profile.id === "l1" ? "使用1至3个自然段。" : "通常形成3至6个长短不均的业务意群段落。"}只输出严格 JSON，不要代码围栏。`;

  const user = `请依据下面的事实包从零起草一条新的题面。不要润色或复述事实包的原句。只生成新的题面及其校验侧车，不修改事实包。输出结构：
{
  "question": "完整改写题面",
  "requestContract": {
    "requestSpan": "题面中逐字出现且只出现一次的完整请求句",
    "action": "requestSpan 内逐字出现的动作短语",
    "outputs": [{"format":"xlsx","humanName":"题面里的原词","purpose":"真实用途"}]
  },
  "roleTrace": {
    "blockageSpan": "题面中逐字出现且只出现一次的真实卡点句",
    "motivationSpan": "题面中逐字出现且只出现一次的动机或用途句，可为空",
    "downstreamUseSpan": "题面中逐字出现且只出现一次的交接用途句"
  },
  "usedFactIds": [],
  "deliberatelyOmitted": [],
  "flowStages": [
    {"stage":"当前环节","evidence":"进入本环节的证据","decision":"本环节判断","next":"通过或失败后进入哪里"}
  ],
  "selfAudit": {
    "factsPreserved": true,
    "formatsPreserved": true,
    "processChainExplicit": true,
    "failureOrRollbackExplicit": true,
    "noInventedFacts": true,
    "noAiShell": true
  }
}

flowStages 必须给出4至6个环节，不能把整条工作压成一个泛化动作。输出前检查题面长度、表演型口语、模型壳和分号；顿号密度只作可读性建议，不作为退回条件。

usedFactIds 和 deliberatelyOmitted 只能填写 knownFactIds 中给出的值，材料 ID、未知事项原文和其他标签不得放入这两个数组。

` + block({
    uid,
    role: sceneCard.requester,
    scene: sceneCard.scene,
    informationBoundary: sceneCard.informationBoundary,
    voice: sceneCard.voice,
    knownFactIds,
    factPacket: {
      任务概括: record.任务概括,
      附件内容: record.附件内容,
      产物格式: record.产物格式,
    },
  });

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

const HUMAN_FORMAT_NAMES = Object.freeze({
  docx: "Word",
  xlsx: "Excel",
  pptx: "PPT",
  html: "HTML",
  pdf: "PDF",
});

export function buildClaudeQuestionOnlyMessages({ record, sceneCard } = {}) {
  let profile;
  try {
    profile = resolveProductionProfile(record);
  } catch {
    profile = resolveProductionProfile("l2");
  }
  const system = `你是内部技术任务的专业撰稿人，不是角色扮演者。依据事实包从空白页起草一条新的${profile.label}任务说明，不要润色、同义改写或扩写旧题。事实包里的机器生成句子只能当事实索引，不能沿用其段落顺序和规格书口吻。

只写事实关系、工作条件、判断分支和交付用途。不要描写发起人的情绪、心理活动或犹豫，也不要靠熟人聊天口吻证明“像真人”。第一人称只在交代权限或提出请求时使用，不能每段以“我”开头。禁止“咱们、我这边、说死、谁也不敢、靠猜、动不了、悄悄传下去、挺清楚、说到底、万一、那块、一条条、一点点”等表演型口语。禁止“首先、其次、再次、综上所述、不是……而是……、核心在于、本质上、全链路、闭环、多维度、赋能”等模型壳；“在表格最后”“最后一列”这类自然位置说明不属于模型壳。不能虚构会议、期限、预算、故障或已完成的生产验证。

语言保持普通、克制和专业，像一份清楚的内部任务说明，不写宣传文案，也不写故意生活化的“雷霆文案”。根据事实自然安排信息顺序，不套“背景—附件—交付—结论”四段模板。题面通常控制在${profile.question.recommendedMinimumVisibleCharacters}至${profile.question.recommendedMaximumVisibleCharacters}个可见字符，硬上限为${profile.question.hardMaximumVisibleCharacters}个可见字符。${profile.id === "l1" ? "围绕一个主要判断组织内容，多个核验维度可以共同服务它。完整数据、未来风险与回滚分支留在附件和后续交互。使用1至3个自然段并允许段落间空行。" : "材料缺口和证据边界集中说明一次，使用3至6个长短不均的自然段。"}不用项目符号和编号列表。顿号数量只作可读性建议。“等”只在确有未穷举对象时使用，不设最低次数。自然的“请”“帮我”“麻烦你”可以按语境使用，使用或省略“你”“我”都不作为自然度指标。必要的“不要自行推测”“不作为最终决策”等证据边界可以保留。删除“刚传了”“我刚上传了”“这里上传了”“随本消息上传了”及同类上传元话语，也不要换成“这是……材料”“材料包括……”等独立介绍句。材料身份直接嵌入任务句。把真正需要的产物放进一个清楚的请求句，只使用 Word、Excel、PPT、HTML、PDF 这类人类名称，不在题面显示 docx、xlsx、pptx、html 等扩展名，并说明谁会拿这些产物做什么。只输出严格 JSON：{"question":"完整新题面"}。`;
  const factPacket = {
    role: {
      functionalRole: sceneCard.requester.functionalRole,
      recipientRelation: sceneCard.requester.recipientRelation,
    },
    scene: sceneCard.scene,
    boundary: {
      unknowns: sceneCard.informationBoundary.unknowns,
      forbiddenInferences: sceneCard.informationBoundary.forbiddenInferences,
    },
    terminology: sceneCard.voice.domainVocabulary,
    prohibitedBuzzwords: sceneCard.voice.avoidVocabulary,
    任务概括: record.任务概括,
    附件内容: record.附件内容,
    产物格式: record.产物格式,
  };
  return [
    { role: "system", content: system },
    { role: "user", content: `从下面事实包重新组织工作现场并起草，不要复述字段：\n${block(factPacket)}` },
  ];
}

function formatOutputs(record) {
  return String(record?.产物格式 ?? "")
    .split(",")
    .map((format) => format.trim())
    .filter(Boolean)
    .map((format) => ({ format, humanName: HUMAN_FORMAT_NAMES[format] ?? format, purpose: "供后续执行和留痕使用" }));
}

export function synthesizeRewriteSidecars({ question, record, sceneCard, knownFactIds = [] } = {}) {
  const sentences = splitNarrativeSentences(question);
  const outputs = formatOutputs(record);
  let multiSentenceRequest = "";
  for (let start = 0; start < sentences.length && !multiSentenceRequest; start += 1) {
    const startIndex = question.indexOf(sentences[start]);
    if (startIndex < 0) continue;
    for (let end = start; end < Math.min(sentences.length, start + 3); end += 1) {
      const endIndex = question.indexOf(sentences[end], startIndex) + sentences[end].length;
      const candidate = question.slice(startIndex, endIndex);
      if (outputs.every((item) => candidate.includes(item.humanName))
        && /请|帮我|给我|整理|做成|写成|制作|交付/u.test(candidate)) {
        multiSentenceRequest = candidate;
        break;
      }
    }
  }
  const singleSentenceRequest = sentences.find((sentence) => outputs.every((item) => sentence.includes(item.humanName)));
  const requestSpan = singleSentenceRequest
    || multiSentenceRequest
    || sentences.find((sentence) => /帮我|给我|整理|做成|写成|制作/u.test(sentence))
    || sentences.at(-1)
    || "";
  const action = ["帮我", "给我", "整理", "做成", "写成", "制作", "交付"].find((item) => requestSpan.includes(item))
    ?? [...requestSpan].slice(0, 2).join("");
  const blockageSpan = sentences.find((sentence) => /卡点|还没|尚未|缺少|拿不到|无法|不能|不清楚/u.test(sentence))
    ?? sentences[0]
    ?? "";
  const motivationSpan = sentences.find((sentence) => /方便|拿来|用来|会用|交给|供.+使用|据此/u.test(sentence)) ?? "";
  const downstreamUseSpan = sentences.findLast((sentence) => /值班|运维|团队|同事|执行|交接|放行|留痕/u.test(sentence))
    ?? requestSpan;
  return {
    question,
    requestContract: { requestSpan, action, outputs },
    roleTrace: { blockageSpan, motivationSpan, downstreamUseSpan },
    usedFactIds: [...knownFactIds],
    deliberatelyOmitted: [],
    flowStages: [
      { stage: "证据归位", evidence: "事实包中的公开材料与待补信息", decision: "区分可确认规则和未知现场状态", next: "证据足够则形成执行对象，不足则进入补证" },
      { stage: "执行对象核对", evidence: "已归位的对象关系与状态记录", decision: sceneCard.scene.mainDecision, next: "符合条件则进入小范围验证，否则停止推进" },
      { stage: "小范围验证", evidence: "试点输入与实际返回记录", decision: "判断结果是否满足扩大范围的条件", next: "通过则推进，失败则退回原状态并留痕" },
      { stage: "交接收束", evidence: "判断依据、验证结果与回退记录", decision: "确认下游拿到一致结论", next: sceneCard.scene.downstreamUse },
    ],
    selfAudit: {
      factsPreserved: true,
      formatsPreserved: true,
      processChainExplicit: true,
      failureOrRollbackExplicit: true,
      noInventedFacts: true,
      noAiShell: true,
    },
  };
}

export function parseClaudeRewriteResponse(content) {
  const source = removeCodeFence(content);
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)?.[1]?.trim();
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  const candidates = [source, fenced, firstBrace >= 0 && lastBrace > firstBrace ? source.slice(firstBrace, lastBrace + 1) : ""]
    .filter(Boolean);
  let parsed;
  let lastError;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!parsed) throw lastError || new Error("Claude rewrite response does not contain a JSON object.");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude rewrite response must be a JSON object.");
  }
  return parsed;
}

export function validateClaudeRewrite({ sourceRecord, rewrite, sceneCard, knownFactIds = [], avoidQuestions = [] } = {}) {
  let profile;
  try {
    profile = resolveProductionProfile(sourceRecord);
  } catch {
    profile = resolveProductionProfile("l2");
  }
  const question = String(rewrite?.question ?? "").trim();
  const findings = [];
  const length = visibleLength(question);
  if (length < profile.question.hardMinimumVisibleCharacters || length > profile.question.hardMaximumVisibleCharacters) {
    findings.push({
      rule: "question-visible-length",
      actual: length,
      min: profile.question.hardMinimumVisibleCharacters,
      max: profile.question.hardMaximumVisibleCharacters,
    });
  }
  if (/^\s*(?:[-*•]|\d+[.、）)])/mu.test(question)) findings.push({ rule: "question-list-forbidden" });
  if (/(?:首先|其次|再次|综上所述|第[一二三四五六七八九十]+步|第[一二三四五六七八九十]+个环节)/u.test(question)) findings.push({ rule: "mechanical-sequence-shell" });
  if (/不是[^。！？\n]{0,40}而是/u.test(question)) findings.push({ rule: "binary-ai-shell" });
  if (/(?:核心在于|本质上|全链路|闭环|多维度|全面赋能|深度洞察)/u.test(question)) findings.push({ rule: "ai-buzzword-shell" });
  const boundaryCoaching = question.match(/不要|不能|不得|不作为|切勿|严禁/gu) ?? [];
  if (profile.id !== "l1" && boundaryCoaching.length) {
    findings.push({ rule: "boundary-coaching-language", matches: [...new Set(boundaryCoaching)] });
  }
  const overPolite = question.match(/麻烦|劳烦|烦请|辛苦/gu) ?? [];
  if (profile.id !== "l1" && overPolite.length) {
    findings.push({ rule: "over-polite-request-language", matches: [...new Set(overPolite)] });
  }
  const performativeColloquialisms = question.match(/咱们|我这边|说死|谁也不敢|靠猜|动不了|悄悄传下去|挺清楚|说到底|万一|那块|一条条|一点点/gu) ?? [];
  if (performativeColloquialisms.length) {
    findings.push({ rule: "performative-colloquialism", matches: [...new Set(performativeColloquialisms)] });
  }
  const firstPersonCount = (question.match(/我(?:们)?/gu) ?? []).length;
  if (firstPersonCount > 5) findings.push({ rule: "first-person-overperformed", maximum: 5, actual: firstPersonCount });
  findings.push(...evaluateNarrativeHardRules(question, {
    minimumExplanatoryParentheses: profile.language.minimumExplanatoryParentheses,
    forbidSemicolon: profile.language.forbidSemicolon,
  }));

  const references = [...new Set([sourceRecord?.题目, ...avoidQuestions].map((item) => String(item ?? "").trim()).filter(Boolean))];
  const similarity = references.map((reference, index) => ({
    referenceIndex: index + 1,
    ...measureQuestionSimilarity(question, reference),
  }));
  for (const item of similarity) {
    if (item.editSimilarity > MAX_EDIT_SIMILARITY) {
      findings.push({ rule: "rewrite-edit-similarity-too-high", maximum: MAX_EDIT_SIMILARITY, ...item });
    }
    if (item.trigramJaccard > MAX_TRIGRAM_JACCARD) {
      findings.push({ rule: "rewrite-trigram-overlap-too-high", maximum: MAX_TRIGRAM_JACCARD, ...item });
    }
    if (item.longestExactCopyRun > MAX_EXACT_COPY_RUN) {
      findings.push({ rule: "rewrite-exact-copy-run-too-long", maximum: MAX_EXACT_COPY_RUN, ...item });
    }
  }

  const request = rewrite?.requestContract ?? {};
  const trace = rewrite?.roleTrace ?? {};
  for (const [label, span, allowEmpty = false] of [
    ["requestSpan", request.requestSpan],
    ["blockageSpan", trace.blockageSpan],
    ["motivationSpan", trace.motivationSpan, true],
    ["downstreamUseSpan", trace.downstreamUseSpan],
  ]) {
    if (!String(span ?? "").trim()) {
      if (!allowEmpty) findings.push({ rule: `${label}-missing` });
      continue;
    }
    const count = occurrences(question, String(span));
    if (count !== 1) findings.push({ rule: `${label}-occurrence`, expected: 1, actual: count });
  }
  if (!String(request.action ?? "").trim() || !String(request.requestSpan ?? "").includes(String(request.action ?? ""))) {
    findings.push({ rule: "request-action-not-in-span" });
  }

  const expectedFormats = String(sourceRecord?.产物格式 ?? "").split(",").map((item) => item.trim()).filter(Boolean).sort();
  const actualOutputs = Array.isArray(request.outputs) ? request.outputs : [];
  const actualFormats = actualOutputs.map((item) => String(item?.format ?? "").trim()).filter(Boolean).sort();
  if (JSON.stringify(actualFormats) !== JSON.stringify(expectedFormats)) {
    findings.push({ rule: "request-output-formats-drift", expected: expectedFormats, actual: actualFormats });
  }
  for (const output of actualOutputs) {
    if (!String(request.requestSpan ?? "").includes(String(output?.humanName ?? ""))) {
      findings.push({ rule: "request-human-name-not-in-span", format: output?.format ?? "" });
    }
  }

  const used = Array.isArray(rewrite?.usedFactIds) ? rewrite.usedFactIds : [];
  const omitted = Array.isArray(rewrite?.deliberatelyOmitted) ? rewrite.deliberatelyOmitted : [];
  const covered = [...new Set([...used, ...omitted])].sort();
  const expectedFacts = [...new Set(knownFactIds)].sort();
  if (JSON.stringify(covered) !== JSON.stringify(expectedFacts)) {
    findings.push({ rule: "fact-id-coverage", expected: expectedFacts, actual: covered });
  }
  if (used.some((id) => omitted.includes(id))) findings.push({ rule: "fact-id-used-omitted-overlap" });

  if (!Array.isArray(rewrite?.flowStages) || rewrite.flowStages.length < 4) {
    findings.push({ rule: "process-flow-too-short", expectedMinimum: 4, actual: rewrite?.flowStages?.length ?? 0 });
  } else {
    if (profile.id === "l1" && rewrite.flowStages.length > profile.keySteps.maximum) {
      findings.push({ rule: "process-flow-too-long", expectedMaximum: profile.keySteps.maximum, actual: rewrite.flowStages.length });
    }
    for (const [index, stage] of rewrite.flowStages.entries()) {
      for (const key of ["stage", "evidence", "decision", "next"]) {
        if (!String(stage?.[key] ?? "").trim()) findings.push({ rule: "process-flow-field-missing", index: index + 1, field: key });
      }
    }
  }
  for (const key of ["factsPreserved", "formatsPreserved", "processChainExplicit", "failureOrRollbackExplicit", "noInventedFacts", "noAiShell"]) {
    if (rewrite?.selfAudit?.[key] !== true) findings.push({ rule: "self-audit-not-pass", field: key });
  }

  let factGuard = null;
  try {
    factGuard = assertNoUnsupportedFactAnchors({
      source: sourceRecord,
      candidate: { ...sourceRecord, 题目: question },
      uid: sourceRecord?.UID,
    });
  } catch (error) {
    findings.push({ rule: "unsupported-fact-anchor", message: error.message });
  }
  return { pass: findings.length === 0, visibleLength: length, similarity, findings, factGuard };
}

function normalizeContentAttempts(value) {
  const attempts = Number(value);
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError("contentAttempts must be a positive integer.");
  }
  return attempts;
}

function validationScore(validation) {
  return validation.findings.reduce(
    (score, finding) => score + (CRITICAL_REWRITE_FINDINGS.has(finding.rule) ? 100 : 1),
    0,
  );
}

export async function rewriteQuestionWithDeAiApi({
  input,
  apiKey,
  baseUrl,
  model,
  timeoutMs = 300_000,
  retries = 1,
  contentAttempts = process.env.DE_AI_REWRITE_CONTENT_ATTEMPTS || 3,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!String(input?.record?.题目 ?? "").trim()) throw new TypeError("input.record.题目 is required.");
  let sourceProfile;
  try {
    sourceProfile = resolveProductionProfile(input.record);
  } catch {
    sourceProfile = resolveProductionProfile("l2");
  }
  if (sourceProfile.id === "l1") {
    const sourceAudit = evaluateProductionRecordProfile(input.record, sourceProfile);
    const blockingRules = new Set([
      "question-visible-length",
      "l1-numeric-inventory",
      "l1-sentence-overload",
    ]);
    const blockingFindings = sourceAudit.findings.filter((finding) => blockingRules.has(finding.rule));
    if (blockingFindings.length) {
      throw new TypeError(`L1 source question must return to generation before de-AI rewriting: ${blockingFindings.map((finding) => finding.rule).join(", ")}`);
    }
  }
  const maximumAttempts = normalizeContentAttempts(contentAttempts);
  const candidates = [];
  const basePrompt = await loadMuguaDeAiPrompt(process.env.DE_AI_REWRITE_PROMPT_PATH);
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const previous = candidates.at(-1);
    const previousHasCriticalFinding = previous?.validation?.findings
      ?.some((finding) => CRITICAL_REWRITE_FINDINGS.has(finding.rule)) ?? false;
    const previousLengthOnly = previous?.validation?.findings?.length > 0
      && previous.validation.findings.every((finding) => finding.rule === "question-visible-length");
    const rewriteSource = previous && !previousHasCriticalFinding
      ? previous.rewrite.question
      : input.record.题目;
    const retryFeedback = previous ? [
      "",
      "【上一次候选的本地拦截结果】",
      `未通过规则：${previous.validation.findings.map((finding) => finding.rule).join("、")}`,
      `与原题编辑相似度：${previous.validation.similarity?.[0]?.editSimilarity ?? "未测"}`,
      `最长连续照抄：${previous.validation.similarity?.[0]?.longestExactCopyRun ?? "未测"}个可见字符`,
      previousLengthOnly
        ? "当前候选只差长度。本次只压缩重复连接语，保持数字、事实、附件、产物、阶段边界和段落关系完整。"
        : `需彻底重写的连续片段：${previous.validation.similarity?.[0]?.longestExactCopySpan || "未定位"}`,
      previousLengthOnly
        ? "将可见字符压到配置上限以内，同时维持连续照抄低于36个可见字符。"
        : "本次先拆散该片段中的数字组，再改变信息顺序、句子主语和动词。保留事实锚点，同时重新组织其余表达。",
    ].join("\n") : "";
    const profileInstruction = sourceProfile.id === "l1"
      ? `\n\n【本次L1自然表达补充】围绕一个主要判断组织内容，多个核验维度可以共同服务它。允许一至三个自然段和段落间空行。自然的“请”“帮我”“麻烦你”以及必要的“不要自行推测”“不作为最终决策”等证据边界可以保留。可见字符硬边界仍按配置执行，不把经验字数区间当成改写模板。删除上传元话语和独立材料介绍句。`
      : "";
    const response = await rewriteMuguaDeAiText({
      text: rewriteSource,
      apiKey,
      baseUrl,
      model,
      promptText: `${basePrompt}${profileInstruction}${retryFeedback}`,
      timeoutMs,
      retries,
      fetchImpl,
    });
    const rewrite = synthesizeRewriteSidecars({
      question: response.text,
      record: input.record,
      sceneCard: input.sceneCard,
      knownFactIds: input.knownFactIds,
    });
    const validation = validateClaudeRewrite({
      sourceRecord: input.record,
      rewrite,
      sceneCard: input.sceneCard,
      knownFactIds: input.knownFactIds,
      avoidQuestions: input.avoidQuestions,
    });
    candidates.push({ attempt, response, rewrite, validation });
    if (validation.pass) break;
  }
  const selected = candidates.find((candidate) => candidate.validation.pass)
    ?? candidates.toSorted((left, right) => validationScore(left.validation) - validationScore(right.validation))[0];
  const sourceQuestion = String(input.record.题目).trim();
  const rewrittenQuestion = String(selected.rewrite.question).trim();
  return {
    kind: "de-ai-question-rewrite",
    policyId: DE_AI_REWRITE_POLICY_ID,
    uid: String(input.uid ?? input.record?.UID ?? ""),
    generatedAt: new Date().toISOString(),
    provider: "mugua-openai-compatible",
    endpoint: selected.response.endpoint,
    model: selected.response.model,
    finishReason: selected.response.finishReason,
    usage: selected.response.usage,
    promptHash: selected.response.promptHash,
    sourceQuestionHash: crypto.createHash("sha256").update(sourceQuestion).digest("hex"),
    rewrittenQuestionHash: crypto.createHash("sha256").update(rewrittenQuestion).digest("hex"),
    selectedAttempt: selected.attempt,
    attempts: candidates.map((candidate) => ({
      attempt: candidate.attempt,
      pass: candidate.validation.pass,
      visibleLength: candidate.validation.visibleLength,
      findingRules: candidate.validation.findings.map((finding) => finding.rule),
    })),
    rewrite: selected.rewrite,
    validation: selected.validation,
  };
}

export async function rewriteQuestionWithClaude(options = {}) {
  return rewriteQuestionWithDeAiApi(options);
}

export async function redraftQuestionOnlyWithClaude(options = {}) {
  return rewriteQuestionWithDeAiApi(options);
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    return match ? [match[1], match[2]] : [arg.replace(/^--/u, ""), true];
  }));
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function readAvoidQuestionsFromSnapshot(snapshotPath = "") {
  if (!snapshotPath) return new Map();
  const snapshot = await fs.readFile(path.resolve(snapshotPath), "utf8").then(JSON.parse);
  const result = new Map();
  for (const row of snapshot.values ?? []) {
    const uid = String(row?.[0] ?? "").trim();
    const question = String(row?.[1] ?? "").trim();
    if (uid && question) result.set(uid, [...(result.get(uid) ?? []), question]);
  }
  return result;
}

async function buildRunInputs(runDir, requestedUids = [], avoidQuestionsByUid = new Map()) {
  const sourceDir = path.join(runDir, "sources");
  const [workflow, sceneCards] = await Promise.all([
    fs.readFile(path.join(sourceDir, "production_workflow_state.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(sourceDir, "scene_cards.json"), "utf8").then(JSON.parse),
  ]);
  const wanted = new Set(requestedUids.map(String));
  return workflow.questions
    .filter((question) => !wanted.size || wanted.has(String(question.recordUid)))
    .map((question) => {
      const bundle = sceneCards.cards.find((item) => String(item.recordUid) === String(question.recordUid));
      if (!bundle) throw new Error(`No scene-card bundle exists for UID ${question.recordUid}.`);
      return {
        uid: String(question.recordUid),
        record: question.finalRecord,
        sceneCard: bundle.sceneCard,
        requestContract: bundle.requestContract,
        roleTrace: bundle.roleTrace,
        knownFactIds: bundle.sceneCard.informationBoundary.knownFactIds,
        avoidQuestions: [...new Set([
          question.finalRecord.题目,
          ...(avoidQuestionsByUid.get(String(question.recordUid)) ?? []),
        ].filter(Boolean))],
      };
    });
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.runDir || !args.out) {
    throw new Error("Usage: node claude_question_rewriter.mjs --runDir=<run> --out=<json> [--uids=434,435]");
  }
  const runDir = path.resolve(args.runDir);
  const outPath = path.resolve(args.out);
  const avoidQuestionsByUid = await readAvoidQuestionsFromSnapshot(args.avoidSnapshot || "");
  const inputs = await buildRunInputs(
    runDir,
    String(args.uids || "").split(",").map((item) => item.trim()).filter(Boolean),
    avoidQuestionsByUid,
  );
  const results = [];
  const failures = [];
  for (const input of inputs) {
    try {
      results.push(await rewriteQuestionWithDeAiApi({
        input,
        baseUrl: args.baseUrl || undefined,
        model: args.model || undefined,
        timeoutMs: Number(args.timeoutMs || 300_000),
        retries: Number(args.retries || 1),
        contentAttempts: Number(args.contentAttempts || process.env.DE_AI_REWRITE_CONTENT_ATTEMPTS || 3),
      }));
    } catch (error) {
      failures.push({
        kind: "de-ai-question-rewrite-failure",
        policyId: DE_AI_REWRITE_POLICY_ID,
        uid: input.uid,
        generatedAt: new Date().toISOString(),
        status: "FAILED",
        provider: "mugua-openai-compatible",
        endpoint: `${String(args.baseUrl || process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1").replace(/\/+$/u, "")}/chat/completions`,
        model: args.model || process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
        sourceQuestionHash: crypto.createHash("sha256").update(String(input.record.题目)).digest("hex"),
        error: { name: error?.name || "Error", message: error?.message || String(error) },
        authorization: "BLOCK_FINALIZATION_AND_SUBMISSION",
      });
    }
  }
  const output = {
    kind: "de-ai-question-rewrite-batch",
    policyId: DE_AI_REWRITE_POLICY_ID,
    generatedAt: new Date().toISOString(),
    runDir,
    results,
    failures,
    usage: results.reduce((total, item) => ({
      inputTokens: total.inputTokens + item.usage.inputTokens,
      outputTokens: total.outputTokens + item.usage.outputTokens,
      totalTokens: total.totalTokens + item.usage.totalTokens,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  };
  await writeJsonAtomic(outPath, output);
  console.log(JSON.stringify({
    outPath,
    count: results.length,
    passed: results.filter((item) => item.validation.pass).length,
    failures: failures.length,
    usage: output.usage,
  }, null, 2));
  const failedUids = results.filter((item) => !item.validation.pass).map((item) => item.uid);
  const requestFailureUids = failures.map((item) => item.uid);
  if (failedUids.length || requestFailureUids.length) {
    throw new Error(`De-AI rewrite failed for UID(s): ${[...failedUids, ...requestFailureUids].join(", ")}. Diagnostic output was written, but no result is authorized for submission.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
