import { abortableDelay, throwIfJobPauseRequested } from "./job-control.mjs";
import { auditDomesticWorkScope } from "./domestic-work-scope.mjs";
import { completeWithLocalCodex } from "./local-codex.mjs";
import { resolveProductRequirement, validateProductAssessment } from "./product-requirement.mjs";

const LIKE_LABELS = new Set(["内容准确", "易于理解", "内容完善", "其他"]);

const PREFLIGHT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["pass", "issues"],
  properties: {
    pass: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
  },
});

const PLANNER_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["evaluation", "nextPrompt", "nextAttachmentNames", "productAssessment"],
  properties: {
    evaluation: {
      type: "object",
      additionalProperties: false,
      required: ["score", "vote", "labels", "note", "evidenceQuote"],
      properties: {
        score: { type: "integer", minimum: 0, maximum: 4 },
        vote: { type: "string", enum: ["like", "dislike"] },
        labels: { type: "array", minItems: 1, items: { type: "string" } },
        note: { type: "string" },
        evidenceQuote: { type: "string" },
      },
    },
    nextPrompt: { type: "string" },
    nextAttachmentNames: { type: "array", items: { type: "string" } },
    productAssessment: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "requestedFormat",
                  "deliveredFormat",
                  "status",
                  "evidenceQuote",
                  "bestEffortProvided",
                  "bestEffortEvidenceQuote",
                ],
                properties: {
                  requestedFormat: { type: "string" },
                  deliveredFormat: { type: "string" },
                  status: { type: "string", enum: ["exact", "equivalent", "unavailable", "missing"] },
                  evidenceQuote: { type: "string" },
                  bestEffortProvided: { type: "boolean" },
                  bestEffortEvidenceQuote: { type: "string" },
                },
              },
            },
          },
        },
      ],
    },
  },
});

const PRESERVED_DOMESTIC_ANCHORS = Object.freeze([
  "腾讯会议",
  "企业微信",
  "阿里云",
  "腾讯云",
  "华为云",
  "钉钉",
  "飞书",
  "微信",
  "豆包",
  "WPS",
  "QQ",
]);

const OUTBOUND_BLOCK_PATTERNS = Object.freeze([
  { rule: "runtime-error-word", pattern: /报错|异常/iu },
  { rule: "debug-trace", pattern: /(?:错误|调试)(?:信息|提示)|堆栈|stack\s*trace|exception\b|debug\b/iu },
  { rule: "automation-internal", pattern: /\b(?:CDP|Playwright|Codex)\b|Computer\s+Use|选择器|工具调用失败|接口超时/iu },
  { rule: "code-fence", pattern: /```/u },
  { rule: "markdown-heading", pattern: /(?:^|\n)\s*#{1,6}\s+/u },
  { rule: "markdown-list", pattern: /(?:^|\n)\s*(?:[-*•]|\d+[.)、])\s+/u },
  { rule: "odd-bracket", pattern: /[{}\[\]<>|\\]/u },
  { rule: "repeated-punctuation", pattern: /([!?！？。；;，,、~～…])\1+/u },
  { rule: "emoji-or-symbol", pattern: /\p{Extended_Pictographic}/u },
  { rule: "replacement-character", pattern: /\uFFFD/u },
  { rule: "control-character", pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u },
]);

const VISIBLE_RESPONSE_OBSERVATION_PATTERNS = Object.freeze([
  {
    rule: "doubao-quota-unavailable",
    pattern: /专业版功能的免费额度用完|预计.{0,32}恢复为你服务|开通豆包专业版|升级到标准套餐/iu,
  },
  {
    rule: "doubao-service-unavailable",
    pattern: /(?:服务繁忙|请求过多|暂时无法.{0,12}服务|请稍后再试)/iu,
  },
  { rule: "runtime-error-word", pattern: /报错|异常/iu },
  { rule: "tool-progress-trace", pattern: /工具执行完成|已执行代码|已查找文件(?:内容)?|已写入文件/iu },
  { rule: "sandbox-or-command-trace", pattern: /沙箱问题|文件系统工具|确认执行\s*(?:Python|Bash|PowerShell)?\s*命令/iu },
  { rule: "user-rejection-trace", pattern: /用户拒绝执行|用户拒绝了/iu },
  { rule: "internal-tool-name", pattern: /\b(?:Bash|Glob|Grep|Write|NotifyHuman|app_builder_agent|ppt_write)\b/iu },
  { rule: "fallback-disclosure", pattern: /因(?:环境|工具|权限).{0,24}(?:无法|不能).{0,16}(?:生成|创建|完成)/iu },
  { rule: "replacement-character", pattern: /\uFFFD/u },
  { rule: "control-character", pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u },
]);

function nonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} must not be empty.`);
  return text;
}

function sortedMatches(value, pattern) {
  return [...String(value).matchAll(pattern)].map((match) => match[0]).sort();
}

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function quotedAnchors(value) {
  const anchors = [];
  const pattern = /“([^”\n]{1,120})”|「([^」\n]{1,120})」|《([^》\n]{1,120})》/gu;
  for (const match of String(value).matchAll(pattern)) {
    anchors.push(match[1] || match[2] || match[3]);
  }
  return [...new Set(anchors)].sort();
}

export function auditInteractionRewrite(sourceValue, rewrittenValue) {
  const source = nonEmpty(sourceValue, "Interaction rewrite source");
  const rewritten = nonEmpty(rewrittenValue, "Interaction rewrite output");
  const issues = [];
  const sourceNumbers = sortedMatches(source, /\d+(?:\.\d+)?(?:%|％)?/gu);
  const rewrittenNumbers = sortedMatches(rewritten, /\d+(?:\.\d+)?(?:%|％)?/gu);
  const sourceUrls = sortedMatches(source, /https?:\/\/[^\s，。！？；、]+/giu);
  const rewrittenUrls = sortedMatches(rewritten, /https?:\/\/[^\s，。！？；、]+/giu);
  const sourceLatin = sortedMatches(source, /\b[A-Za-z][A-Za-z0-9_.+-]*\b/gu);
  const rewrittenLatin = sortedMatches(rewritten, /\b[A-Za-z][A-Za-z0-9_.+-]*\b/gu);

  if (!sameValues(sourceNumbers, rewrittenNumbers)) issues.push("numbers-changed");
  if (!sameValues(sourceUrls, rewrittenUrls)) issues.push("urls-changed");
  if (!sameValues(sourceLatin, rewrittenLatin)) issues.push("latin-anchors-changed");

  for (const anchor of quotedAnchors(source)) {
    if (!rewritten.includes(anchor)) issues.push(`quoted-anchor-missing:${anchor}`);
  }
  for (const anchor of PRESERVED_DOMESTIC_ANCHORS) {
    if (source.includes(anchor) !== rewritten.includes(anchor)) {
      issues.push(`named-anchor-changed:${anchor}`);
    }
  }

  return {
    issues: [...new Set(issues)],
    pass: issues.length === 0,
    rewrittenLength: [...rewritten].length,
    sourceLength: [...source].length,
  };
}

export function auditOutboundPrompt(value) {
  const prompt = nonEmpty(value, "Outbound prompt");
  const issues = OUTBOUND_BLOCK_PATTERNS
    .filter(({ pattern }) => pattern.test(prompt))
    .map(({ rule }) => rule);
  issues.push(...auditDomesticWorkScope(prompt).issues);
  if (/\n\s*\n\s*\n/u.test(prompt)) issues.push("excessive-blank-lines");
  return { pass: issues.length === 0, issues: [...new Set(issues)], prompt };
}

export function validateOutboundPrompt(value) {
  const audit = auditOutboundPrompt(value);
  if (!audit.pass) {
    throw new Error(`Outbound prompt failed the visible-text gate: ${audit.issues.join(", ")}.`);
  }
  return audit.prompt;
}

export function auditVisibleResponse(value) {
  const response = nonEmpty(value, "Visible response");
  const observations = VISIBLE_RESPONSE_OBSERVATION_PATTERNS
    .filter(({ pattern }) => pattern.test(response))
    .map(({ rule }) => rule);
  observations.push(...auditDomesticWorkScope(response).issues.filter((issue) =>
    issue === "foreign-platform" || issue === "domestic-sensitive-topic"));
  return {
    issues: [],
    observations: [...new Set(observations)],
    pass: true,
  };
}

function responseEvidenceText(responseText, artifacts = []) {
  return [
    String(responseText ?? ""),
    ...artifacts.flatMap((artifact) => [artifact?.text, artifact?.label, artifact?.href]),
  ].map((item) => String(item ?? "").trim()).filter(Boolean).join("\n");
}

export function validateEvaluation(value, {
  artifacts = [],
  minimumNoteLength = 12,
  requireExperienceEvidence = false,
  responseText = "",
} = {}) {
  const vote = String(value?.vote ?? "");
  if (vote !== "like" && vote !== "dislike") {
    throw new Error('Evaluation vote must be either "like" or "dislike".');
  }
  if (!Array.isArray(value?.labels) || value.labels.length === 0) {
    throw new Error("Evaluation labels must be a non-empty array.");
  }
  const labels = [...new Set(value.labels.map((label) => nonEmpty(label, "Evaluation label")))];
  if (!labels.includes("其他")) throw new Error('Evaluation labels must include "其他".');
  if (vote === "like") {
    const unknown = labels.filter((label) => !LIKE_LABELS.has(label));
    if (unknown.length) throw new Error(`Unknown like labels: ${unknown.join(", ")}.`);
  }
  const note = nonEmpty(value.note, "Evaluation note");
  if ([...note].length < minimumNoteLength) {
    throw new Error(`Evaluation note must contain at least ${minimumNoteLength} characters.`);
  }
  if (!requireExperienceEvidence) return { labels, note, vote };
  const score = Number(value?.score);
  if (!Number.isInteger(score) || score < 0 || score > 4) {
    throw new Error("Experience score must be an integer from 0 to 4.");
  }
  const expectedVote = score >= 3 ? "like" : "dislike";
  if (vote !== expectedVote) {
    throw new Error(`Experience score ${score} must map to vote ${expectedVote}.`);
  }
  const evidenceQuote = nonEmpty(value?.evidenceQuote, "Evaluation evidenceQuote");
  if ([...evidenceQuote].length < 2) {
    throw new Error("Evaluation evidenceQuote must contain at least two characters.");
  }
  const actualEvidence = responseEvidenceText(responseText, artifacts);
  if (!actualEvidence.includes(evidenceQuote)) {
    throw new Error("Evaluation evidenceQuote was not found in the actual Doubao response or artifact evidence.");
  }
  return { evidenceQuote, labels, note, score, vote };
}

export function parseDecisionJson(text) {
  const value = String(text ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Evaluator did not return a JSON object.");
  return JSON.parse(value.slice(start, end + 1));
}

export function validatePolicyDecision(value, {
  availableAttachmentNames = [],
  finalRound = false,
  latestArtifacts = [],
  latestResponse = "",
  productRequirement = resolveProductRequirement({}),
} = {}) {
  const evaluation = validateEvaluation(value?.evaluation ?? value, {
    artifacts: latestArtifacts,
    requireExperienceEvidence: true,
    responseText: latestResponse,
  });
  const nextPrompt = String(value?.nextPrompt ?? "").trim();
  if (!finalRound && !nextPrompt) throw new Error("Evaluator must provide nextPrompt before the final round.");
  if (finalRound && nextPrompt) throw new Error("Evaluator must not provide nextPrompt after the final round.");
  if (value?.nextAttachmentNames != null && !Array.isArray(value.nextAttachmentNames)) {
    throw new Error("nextAttachmentNames must be an array when provided.");
  }
  const nextAttachmentNames = (value?.nextAttachmentNames ?? [])
    .map((name) => nonEmpty(name, "nextAttachmentNames item"));
  if (new Set(nextAttachmentNames).size !== nextAttachmentNames.length) {
    throw new Error("nextAttachmentNames must not contain duplicates.");
  }
  const unknownAttachmentNames = nextAttachmentNames.filter((name) => !availableAttachmentNames.includes(name));
  if (unknownAttachmentNames.length) {
    throw new Error(`Evaluator selected unavailable attachments: ${unknownAttachmentNames.join(", ")}.`);
  }
  if (finalRound && nextAttachmentNames.length) {
    throw new Error("Evaluator must not select attachments after the final round.");
  }
  const productAssessment = finalRound
    ? validateProductAssessment(value?.productAssessment, {
      artifacts: latestArtifacts,
      requirement: productRequirement,
      responseText: latestResponse,
    })
    : null;
  return { evaluation, nextAttachmentNames, nextPrompt, productAssessment };
}

function policyEndpoint(baseUrl) {
  const url = new URL(nonEmpty(baseUrl, "Policy baseUrl"));
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (!url.pathname.endsWith("/chat/completions")) {
    if (!url.pathname.endsWith("/v1")) url.pathname += "/v1";
    url.pathname += "/chat/completions";
  }
  return url.toString();
}

function policyCredential(policy) {
  const apiKeyEnv = String(policy?.apiKeyEnv ?? "").trim();
  const apiKey = apiKeyEnv ? String(process.env[apiKeyEnv] ?? "") : "";
  if (apiKeyEnv && !apiKey) {
    throw new ModelInvocationFailedError(`Policy credential environment variable ${apiKeyEnv} is not set.`);
  }
  return apiKey;
}

function requestTimeout(policy) {
  const timeoutMs = Number(policy?.timeoutMs ?? 120_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new ModelInvocationFailedError("Policy timeoutMs must be at least 1000.");
  }
  return timeoutMs;
}

export const MODEL_RETRY_SCHEDULE = Object.freeze({
  quickRetryDelaysMs: Object.freeze([20_000, 20_000, 20_000]),
  slowRetryDelaysMs: Object.freeze([360_000, 360_000, 360_000]),
});

export class ModelInvocationExhaustedError extends Error {
  constructor(message, { attempts = [], cause } = {}) {
    super(message, { cause });
    this.name = "ModelInvocationExhaustedError";
    this.code = "MODEL_INVOCATION_EXHAUSTED";
    this.attempts = attempts;
  }
}

export class ModelInvocationFailedError extends Error {
  constructor(message, { cause, status = null } = {}) {
    super(message, { cause });
    this.name = "ModelInvocationFailedError";
    this.code = "MODEL_INVOCATION_FAILED";
    this.status = status;
  }
}

class RetryableModelInvocationError extends Error {
  constructor(message, { cause, status = null } = {}) {
    super(message, { cause });
    this.name = "RetryableModelInvocationError";
    this.retryable = true;
    this.status = status;
  }
}

function isRetryableHttpStatus(status) {
  return [408, 425, 429].includes(Number(status)) || Number(status) >= 500;
}

async function requestModelPayload({ apiKey, body, fetchImpl, label, policy, signal }) {
  throwIfJobPauseRequested(signal);
  const timeoutMs = requestTimeout(policy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromJob = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abortFromJob, { once: true });
  try {
    const response = await fetchImpl(policyEndpoint(policy.baseUrl), {
      method: "POST",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (isRetryableHttpStatus(response.status)) {
        throw new RetryableModelInvocationError(`${label} returned HTTP ${response.status} without JSON.`, {
          cause: error,
          status: response.status,
        });
      }
      throw new ModelInvocationFailedError(`${label} returned an invalid JSON response.`, {
        cause: error,
        status: response.status,
      });
    }
    if (!response.ok) {
      const message = `${label} failed with HTTP ${response.status}: ${payload?.error?.message ?? payload?.message ?? "unknown error"}`;
      if (isRetryableHttpStatus(response.status)) {
        throw new RetryableModelInvocationError(message, { status: response.status });
      }
      throw new ModelInvocationFailedError(message, { status: response.status });
    }
    return payload;
  } catch (error) {
    if (error instanceof RetryableModelInvocationError) throw error;
    if (error instanceof ModelInvocationFailedError) throw error;
    if (signal?.aborted) throwIfJobPauseRequested(signal);
    if (error?.name === "AbortError") {
      throw new RetryableModelInvocationError(`${label} timed out after ${timeoutMs}ms.`, { cause: error });
    }
    if (error instanceof TypeError) {
      throw new RetryableModelInvocationError(`${label} network request failed: ${error.message}`, { cause: error });
    }
    throw new ModelInvocationFailedError(`${label} failed: ${error.message}`, { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromJob);
  }
}

async function runModelWithRetry(operation, {
  label,
  onRetryState = async () => {},
  retrySchedule = MODEL_RETRY_SCHEDULE,
  signal,
  sleepImpl = abortableDelay,
} = {}) {
  const delays = [
    ...retrySchedule.quickRetryDelaysMs.map((delayMs, index) => ({ delayMs, phase: "quick", retry: index + 1 })),
    ...retrySchedule.slowRetryDelaysMs.map((delayMs, index) => ({ delayMs, phase: "slow", retry: index + 1 })),
  ];
  const attempts = [];
  for (let index = 0; index <= delays.length; index += 1) {
    throwIfJobPauseRequested(signal);
    const descriptor = index === 0 ? { phase: "initial", retry: 0 } : delays[index - 1];
    try {
      const value = await operation();
      attempts.push({ attempt: index + 1, phase: descriptor.phase, retry: descriptor.retry, status: "success" });
      await onRetryState({ attempts: [...attempts], status: "complete" });
      return { retryTrace: attempts, value };
    } catch (error) {
      attempts.push({
        attempt: index + 1,
        message: error.message,
        phase: descriptor.phase,
        retry: descriptor.retry,
        status: "failed",
      });
      if (error?.retryable !== true) {
        await onRetryState({ attempts: [...attempts], status: "non_retryable_failure" });
        throw error;
      }
      if (index === delays.length) {
        await onRetryState({ attempts: [...attempts], status: "exhausted" });
        throw new ModelInvocationExhaustedError(
          `${label} remained unavailable after one initial attempt, three quick retries, and three six-minute retries.`,
          { attempts, cause: error },
        );
      }
      const next = delays[index];
      await onRetryState({
        attempts: [...attempts],
        nextDelayMs: next.delayMs,
        nextPhase: next.phase,
        nextRetry: next.retry,
        status: "waiting",
      });
      await sleepImpl(next.delayMs, signal);
      throwIfJobPauseRequested(signal);
    }
  }
  throw new Error("Unreachable model retry state.");
}

function interactionRewriteMessages({ job, prompt, roundNumber, textPurpose }) {
  const purposeRule = textPurpose === "feedback-note"
    ? "这段文本是赞踩反馈说明。只把评价写得像真实使用者针对本轮回复的具体反馈，不得改成追问或任务指令；不得引入原文未出现的后续目标、下一轮动作、最终交付物或选型结论。"
    : "这段文本是发给豆包的工作消息。把它改成自然、克制的真实工作委托或追问，不回答其中任务。";
  const system = `你是豆包工作交互的去 AI 改写员，只负责重组语言，不负责重新设计内容。\n`
    + `${purposeRule}\n`
    + `必须完整保留原文中的人物、组织、产品、平台、数字、日期、链接、文件名、交付物、事实边界、任务目的和轮次边界，不得增加新事实、新判断或新要求。\n`
    + `人物、组织范围、产品名、附件编号、日期和交付格式属于不可改写锚点，必须按原文逐字保留；只能调整这些锚点前后的句式。\n`
    + `默认用户为国内用户，不得引入国外平台或国内敏感议题。计算任务不得降低原有复杂度。\n`
    + `表达要像同事之间自然明确的工作沟通，不写成模型提示词、审核规则、宣传文案或机械清单。避免“首先、其次、再次、最后、综上所述、核心在于、本质上、全链路、闭环、多维度、赋能”等机器表达。\n`
    + `如果原文已经自然、完整且没有机器表达，可以原样返回，不要为了制造改写痕迹而改写。\n`
    + `不得输出运行状态、工具名称、接口信息、报错、异常、代码围栏、Markdown 标题或列表、乱码、表情和怪异标点。\n`
    + `只输出 JSON：{"prompt":"完整改写后的可见文本"}`;
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify({
        roundNumber,
        textPurpose,
        sourcePrompt: String(prompt),
      }),
    },
  ];
}

export async function requestInteractionRewrite({
  fetchImpl = globalThis.fetch,
  job,
  onRetryState,
  policy,
  prompt,
  retrySchedule,
  roundNumber,
  signal,
  sleepImpl,
  textPurpose = "chat-prompt",
} = {}) {
  if (policy?.type !== "openai-compatible") {
    throw new Error('Interaction rewrite type must be "openai-compatible".');
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const sourcePrompt = nonEmpty(prompt, "Interaction rewrite source");
  const apiKey = policyCredential(policy);
  const completion = await runModelWithRetry(
    () => requestModelPayload({
      apiKey,
      fetchImpl,
      label: "Interaction de-AI rewrite",
      policy,
      signal,
      body: {
        model: nonEmpty(policy.model, "Interaction rewrite model"),
        messages: interactionRewriteMessages({ job, prompt: sourcePrompt, roundNumber, textPurpose }),
        response_format: { type: "json_object" },
        stream: false,
        temperature: Number(policy.temperature ?? 0.55),
      },
    }),
    { label: "Interaction de-AI rewrite", onRetryState, retrySchedule, signal, sleepImpl },
  );
  const payload = completion.value;
  let rewrittenPrompt;
  let preservation;
  try {
    const parsed = parseDecisionJson(messageText(payload?.choices?.[0]?.message));
    rewrittenPrompt = validateOutboundPrompt(parsed?.prompt);
    preservation = auditInteractionRewrite(sourcePrompt, rewrittenPrompt);
    if (!preservation.pass) {
      throw new Error(`fact anchors changed: ${preservation.issues.join(", ")}`);
    }
  } catch (error) {
    throw new ModelInvocationFailedError(`Interaction de-AI rewrite returned an unusable result: ${error.message}`, {
      cause: error,
    });
  }
  return {
    changed: rewrittenPrompt !== sourcePrompt,
    model: payload?.model ?? policy.model,
    pass: true,
    preservation,
    prompt: rewrittenPrompt,
    retryTrace: completion.retryTrace,
    textPurpose,
    usage: payload?.usage ?? {},
  };
}

function promptPreflightMessages({ conversationContext, job, prompt, roundNumber, sourcePrompt, textPurpose }) {
  const purposeRule = textPurpose === "feedback-note"
    ? "这段文本是赞踩反馈说明，必须保留对本轮回答的具体评价，不能变成追问、任务指令或客服话术。"
    : "这段文本是发给豆包的工作消息，必须保留本轮工作推进目的，不能回答任务或解释审校过程。";
  const experienceRule = textPurpose === "feedback-note"
    ? "必须对照 conversationContext 中本轮真实问题、回复、产物证据、0到4分和赞踩判断：评价说明应准确反映实际可用性，引用证据必须确实存在，3/4分只能对应like，0/1/2分只能对应dislike；不得随机、轮换、预填或为了显得友好而固定点赞。"
    : "如果是后续追问，必须根据上一轮真实回复中的具体结论、证据缺口、口径冲突或未完成产物继续推进，每轮只把问题收窄一层；不能重新复述整道题、机械换词、突然跳题或写成预设脚本。表达应像真人看完回复后自然追问。";
  const system = `你是发送给甲方可见豆包对话前的独立质检员。你只做检查和放行，不改写文本。\n`
    + `聊天记录会被甲方完整查看。candidatePrompt 已经由另一个模型去 AI 改写，你必须逐项对照 sourcePrompt 检查。\n`
    + `${purposeRule}\n`
    + `检查人物、组织、产品、平台、数字、日期、链接、文件名、事实边界、交付物、任务目的和轮次边界是否完整且没有新增。\n`
    + `检查文本是否自然、克制、符合真实工作场景，是否存在机器套话、国外平台、国内敏感议题、简单化计算、运行状态、工具名称、接口失败、代码围栏、Markdown、乱码、表情或怪异标点。\n`
    + `${experienceRule}\n`
    + `任何一项不满足都输出 pass=false；不得自行修复后放行。全部满足才输出 pass=true。\n`
    + `只输出 JSON：{"pass":true,"issues":[]}`;
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify({
        roundNumber,
        textPurpose,
        taskGoal: job.taskGoal ?? "",
        conversationContext: conversationContext ?? null,
        sourcePrompt: String(sourcePrompt),
        candidatePrompt: String(prompt),
      }),
    },
  ];
}

function parsePromptPreflight(text, prompt) {
  const parsed = parseDecisionJson(text);
  const checkedPrompt = validateOutboundPrompt(prompt);
  const pass = parsed?.pass === true;
  const issues = Array.isArray(parsed?.issues)
    ? parsed.issues.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!pass) {
    throw new Error(`Prompt quality gate rejected the de-AI text${issues.length ? `: ${issues.join(", ")}` : "."}`);
  }
  return { issues, pass, prompt: checkedPrompt };
}

async function requestCodexModelCompletion({
  label,
  localCodexImpl = completeWithLocalCodex,
  messages,
  outputSchema,
  policy,
  signal,
}) {
  throwIfJobPauseRequested(signal);
  try {
    return await localCodexImpl({
      executablePath: policy.executablePath,
      model: nonEmpty(policy.model, `${label} model`),
      outputSchema,
      reasoningEffort: String(policy.reasoningEffort ?? "high"),
      signal,
      systemPrompt: messages[0].content,
      timeoutMs: requestTimeout(policy),
      userPrompt: messages[1].content,
    });
  } catch (error) {
    if (signal?.aborted) throwIfJobPauseRequested(signal);
    if (error?.retryable === true) throw error;
    if (error instanceof ModelInvocationFailedError) throw error;
    const status = Number(error?.status ?? 0);
    const retryable = isRetryableHttpStatus(status)
      || /timed out|network|fetch failed|socket|ECONNRESET|ETIMEDOUT/iu.test(String(error?.message ?? ""));
    if (retryable) {
      throw new RetryableModelInvocationError(`${label} failed: ${error.message}`, {
        cause: error,
        status: status || null,
      });
    }
    throw new ModelInvocationFailedError(`${label} failed: ${error.message}`, {
      cause: error,
      status: status || null,
    });
  }
}

export async function requestPromptPreflight({
  conversationContext,
  job,
  localCodexImpl,
  onRetryState,
  policy,
  prompt,
  retrySchedule,
  roundNumber,
  signal,
  sleepImpl,
  sourcePrompt,
  textPurpose = "chat-prompt",
} = {}) {
  if (policy?.type !== "local-codex") {
    throw new Error('Prompt preflight type must be "local-codex".');
  }
  const originalPrompt = nonEmpty(prompt, "Candidate outbound prompt");
  const originalSourcePrompt = nonEmpty(sourcePrompt ?? prompt, "Source outbound prompt");
  const messages = promptPreflightMessages({
    conversationContext,
    job,
    prompt: originalPrompt,
    roundNumber,
    sourcePrompt: originalSourcePrompt,
    textPurpose,
  });
  const completion = await runModelWithRetry(
    () => requestCodexModelCompletion({
      label: "Codex prompt quality gate",
      localCodexImpl,
      messages,
      outputSchema: PREFLIGHT_OUTPUT_SCHEMA,
      policy,
      signal,
    }),
    { label: "Codex prompt quality gate", onRetryState, retrySchedule, signal, sleepImpl },
  );
  const payload = completion.value;
  let checked;
  try {
    checked = parsePromptPreflight(payload?.content, originalPrompt);
  } catch (error) {
    throw new ModelInvocationFailedError(`Codex prompt quality gate returned an unusable decision: ${error.message}`, {
      cause: error,
    });
  }
  return {
    ...checked,
    changed: checked.prompt !== originalPrompt,
    model: payload?.model ?? policy.model,
    provider: payload?.provider ?? "local-codex-cli",
    retryTrace: completion.retryTrace,
    textPurpose,
    usage: payload?.usage ?? {},
  };
}

export function buildEvaluatorMessages({
  availableAttachments = [],
  job,
  maxRounds,
  productRequirement = resolveProductRequirement(job),
  roundNumber,
  transcript,
}) {
  const system = `你是独立的豆包办公任务轨迹评审与追问规划器。\n`
    + `你必须只输出 JSON 对象，不要输出 Markdown。\n`
    + `评价必须模拟真人用户看完本轮实际回复后的真实体验，绝对不能随机、轮流、预填或为了通过而固定点赞。先按0到4分判断可用性：4分完全满足，3分基本可用但有小缺口，2分只有部分可用，1分帮助很少，0分不可用；3或4分投like，0到2分投dislike。\n`
    + `evaluation.evidenceQuote 必须逐字摘录本轮豆包回复或本轮产物卡片中的一小段可核对内容。note 必须围绕这段实际内容说明满意点或缺口，不能写空泛套话。每轮 labels 必须包含“其他”；like 还可使用“内容准确”“易于理解”“内容完善”，dislike 为避免选择不存在的选项只使用“其他”。\n`
    + `在第 ${maxRounds} 轮之前，nextPrompt 必须像真人解决问题：先承接本轮一个具体结论、数字、引用、口径、遗漏或产物状态，再只向下一层收窄。优先顺序是核对事实与来源、拆分关键口径、处理冲突和缺失、补齐计算或操作细节、最后形成并验收产物。不能重复整道题、机械说“继续完善”、一次塞入多个无关方向，也不能提到轮次、评审器、模型或自动化。\n`
    + `可在自然需要补证据时，从 availableAttachments 选择尚未上传的文件放入 nextAttachmentNames；选择后 nextPrompt 必须像真人一样自然说明为什么请它结合这些新文件继续核对。没有必要时返回空数组，不得虚构文件名。最后一轮 nextPrompt 和 nextAttachmentNames 都必须为空。\n`
    + `默认用户为国内用户。nextPrompt 不得涉及国外平台或国内敏感议题，必须继续同一工作场景并推进证据、产物、验证或决策，不能闲聊。计算类追问必须保留至少两类真实复杂度，禁止单步四则运算或直接代数代入。\n`
    + `最后一轮必须逐项判断 productRequirement。exact 表示返回了要求的实际格式；equivalent 只用于Excel转在线表格、Word转在线文档、PPT转在线演示或HTML转在线页面；unavailable 只在豆包明确表示无法提供原格式且已经给出可用替代内容时使用，并同时提供限制原文 evidenceQuote 和替代内容原文 bestEffortEvidenceQuote；否则为missing。\n`
    + `输出结构：{"evaluation":{"score":0,"vote":"like或dislike","labels":["其他"],"note":"基于实际体验的详细理由","evidenceQuote":"本轮回复原文片段"},"nextPrompt":"下一轮追问或空字符串","nextAttachmentNames":[],"productAssessment":{"items":[{"requestedFormat":"excel","deliveredFormat":"online-spreadsheet","status":"equivalent","evidenceQuote":"产物原文片段","bestEffortProvided":false,"bestEffortEvidenceQuote":""}]}}`;
  const user = JSON.stringify({
    roundNumber,
    maxRounds,
    taskGoal: job.taskGoal,
    successCriteria: job.successCriteria ?? [],
    productRequirement,
    availableAttachments,
    transcript,
  });
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => part?.text ?? "").join("");
  }
  return "";
}

export async function requestPolicyDecision({
  availableAttachments = [],
  job,
  localCodexImpl,
  maxRounds,
  onRetryState,
  policy,
  productRequirement = resolveProductRequirement(job),
  retrySchedule,
  roundNumber,
  signal,
  sleepImpl,
  transcript,
} = {}) {
  if (policy?.type !== "local-codex") {
    throw new Error('Policy type must be "local-codex".');
  }
  const messages = buildEvaluatorMessages({
    availableAttachments,
    job,
    maxRounds,
    productRequirement,
    roundNumber,
    transcript,
  });
  const completion = await runModelWithRetry(
    () => requestCodexModelCompletion({
      label: "Codex evaluator and follow-up planner",
      localCodexImpl,
      messages,
      outputSchema: PLANNER_OUTPUT_SCHEMA,
      policy,
      signal,
    }),
    { label: "Codex evaluator and follow-up planner", onRetryState, retrySchedule, signal, sleepImpl },
  );
  const payload = completion.value;
  const content = payload?.content;
  let decision;
  try {
    const latest = transcript.at(-1) ?? {};
    decision = validatePolicyDecision(parseDecisionJson(content), {
      availableAttachmentNames: availableAttachments.map((attachment) => attachment.name),
      finalRound: roundNumber === maxRounds,
      latestArtifacts: latest.artifacts ?? [],
      latestResponse: latest.response ?? "",
      productRequirement,
    });
  } catch (error) {
    throw new ModelInvocationFailedError(`Evaluator returned an unusable decision: ${error.message}`, {
      cause: error,
    });
  }
  return {
    ...decision,
    evaluator: {
      id: payload?.id ?? "",
      model: payload?.model ?? policy.model,
      provider: payload?.provider ?? "local-codex-cli",
      retryTrace: completion.retryTrace,
      usage: payload?.usage ?? {},
    },
  };
}
