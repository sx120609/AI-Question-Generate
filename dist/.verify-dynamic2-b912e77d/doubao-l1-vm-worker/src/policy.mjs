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
  required: ["evaluation", "nextPrompt", "nextAttachmentNames", "productAssessment", "taskOutcome", "unresolvedIssues"],
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
    taskOutcome: { type: "string", enum: ["continue", "complete", "doubao-unable"] },
    unresolvedIssues: { type: "array", items: { type: "string" } },
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
  { rule: "unnatural-excel-wording", pattern: /Excel\s*(?:形式的\s*)?工作簿|Excel形式的/iu },
  { rule: "semicolon", pattern: /[；;]/u },
  { rule: "odd-bracket", pattern: /[{}\[\]<>|\\]/u },
  { rule: "repeated-punctuation", pattern: /([!?！？。；;，,、~～])\1+|…{3,}/u },
  { rule: "emoji-or-symbol", pattern: /\p{Extended_Pictographic}/u },
  { rule: "replacement-character", pattern: /\uFFFD/u },
  { rule: "control-character", pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u },
]);

const REQUEST_OPENER_PATTERN = /(?:^|[\n，。！？；：,!?;:]\s*)(麻烦(?:你|您)?|劳烦(?:你|您)?|烦请|辛苦(?:你|您)?|请(?:你|您)?|帮我|帮忙)(?=\s*[^\s，。！？；：,!?;:])/gu;
const MANUFACTURED_COURTESY_OPENERS = new Set(["麻烦", "劳烦", "烦请", "辛苦"]);
const REPEATABLE_REQUEST_OPENERS = new Set(["请", "帮"]);
const DIRECTIVE_STYLE_PATTERNS = Object.freeze([
  {
    rule: "negative-directive",
    pattern: /(?:^|[\n，。！？；：,!?;:]\s*)(?:不要|不必|无需|不得|禁止|严禁|切勿|不能|不可)(?=\s*[^\s，。！？；：,!?;:])/u,
  },
  {
    rule: "contrastive-instruction",
    pattern: /(?:不要|不是)[^。！？\n]{0,80}(?:而要|而是)/u,
  },
  {
    rule: "negative-decision-boundary",
    pattern: /不作为(?:最终)?(?:采购|合规|决策|判断|结论|依据)/u,
  },
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

function valueCountDiff(expected, actual) {
  const expectedCounts = new Map();
  const actualCounts = new Map();
  for (const value of expected) expectedCounts.set(value, (expectedCounts.get(value) ?? 0) + 1);
  for (const value of actual) actualCounts.set(value, (actualCounts.get(value) ?? 0) + 1);
  const missing = [];
  const added = [];
  for (const [value, count] of expectedCounts) {
    for (let index = actualCounts.get(value) ?? 0; index < count; index += 1) missing.push(value);
  }
  for (const [value, count] of actualCounts) {
    for (let index = expectedCounts.get(value) ?? 0; index < count; index += 1) added.push(value);
  }
  return { added: added.sort(), missing: missing.sort() };
}

function normalizeRequestOpener(value) {
  if (/^麻烦/u.test(value)) return "麻烦";
  if (/^劳烦/u.test(value)) return "劳烦";
  if (/^烦请/u.test(value)) return "烦请";
  if (/^辛苦/u.test(value)) return "辛苦";
  if (/^请/u.test(value)) return "请";
  if (/^帮/u.test(value)) return "帮";
  return String(value);
}

function requestOpeners(value) {
  return [...String(value ?? "").matchAll(REQUEST_OPENER_PATTERN)]
    .map((match) => normalizeRequestOpener(match[1]));
}

function auditInteractionTone(value, { recentPrompts = [] } = {}) {
  const prompt = String(value ?? "");
  const currentOpeners = requestOpeners(prompt);
  const issues = DIRECTIVE_STYLE_PATTERNS
    .filter(({ pattern }) => pattern.test(prompt))
    .map(({ rule }) => rule);
  issues.push(...currentOpeners
    .filter((opener) => MANUFACTURED_COURTESY_OPENERS.has(opener))
    .map((opener) => `manufactured-courtesy:${opener}`));
  const recentOpeners = new Set(
    (Array.isArray(recentPrompts) ? recentPrompts : [])
      .slice(-3)
      .flatMap((item) => requestOpeners(item)),
  );
  for (const opener of currentOpeners) {
    if (REPEATABLE_REQUEST_OPENERS.has(opener) && recentOpeners.has(opener)) {
      issues.push(`repeated-request-opener:${opener}`);
    }
  }
  return [...new Set(issues)];
}

function hasExcessiveEnumerationPunctuation(value) {
  return String(value ?? "")
    .split(/[。！？!?\n]+/u)
    .some((sentence) => (sentence.match(/、/gu) ?? []).length > 1);
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
  const sourceLatin = [...new Set(sortedMatches(source, /\b[A-Za-z][A-Za-z0-9_.+-]*\b/gu))];
  const rewrittenLatin = [...new Set(sortedMatches(rewritten, /\b[A-Za-z][A-Za-z0-9_.+-]*\b/gu))];
  const numberDiff = valueCountDiff(sourceNumbers, rewrittenNumbers);
  const urlDiff = valueCountDiff(sourceUrls, rewrittenUrls);
  const latinDiff = valueCountDiff(sourceLatin, rewrittenLatin);

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
    anchorDiff: {
      numbers: numberDiff,
      urls: urlDiff,
      latin: latinDiff,
    },
    pass: issues.length === 0,
    rewrittenLength: [...rewritten].length,
    sourceLength: [...source].length,
  };
}

export function auditOutboundPrompt(value, {
  recentPrompts = [],
  requirePersonalPronoun = false,
  scopeContext = "",
  textPurpose = "chat-prompt",
} = {}) {
  const prompt = nonEmpty(value, "Outbound prompt");
  const issues = OUTBOUND_BLOCK_PATTERNS
    .filter(({ pattern }) => pattern.test(prompt))
    .map(({ rule }) => rule);
  issues.push(...auditInteractionTone(prompt, { recentPrompts }));
  if (hasExcessiveEnumerationPunctuation(prompt)) issues.push("excessive-enumeration-punctuation");
  if (requirePersonalPronoun && !/[你我]/u.test(prompt)) issues.push("missing-personal-pronoun");
  const scopeIssues = auditDomesticWorkScope(prompt, { context: scopeContext }).issues;
  issues.push(...(textPurpose === "feedback-note"
    ? scopeIssues.filter((issue) => issue === "foreign-platform" || issue === "domestic-sensitive-topic")
    : scopeIssues));
  if (/\n\s*\n\s*\n/u.test(prompt)) issues.push("excessive-blank-lines");
  return { pass: issues.length === 0, issues: [...new Set(issues)], prompt };
}

export function validateOutboundPrompt(value, options = {}) {
  const audit = auditOutboundPrompt(value, options);
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
  validateOutboundPrompt(note, { textPurpose: "feedback-note" });
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
  minimumRounds = 6,
  productRequirement = resolveProductRequirement({}),
  roundNumber = 1,
} = {}) {
  const evaluation = validateEvaluation(value?.evaluation ?? value, {
    artifacts: latestArtifacts,
    requireExperienceEvidence: true,
    responseText: latestResponse,
  });
  const inferredOutcome = finalRound
    ? (value?.productAssessment == null ? "doubao-unable" : "complete")
    : "continue";
  const taskOutcome = String(value?.taskOutcome ?? inferredOutcome).trim();
  if (!["continue", "complete", "doubao-unable"].includes(taskOutcome)) {
    throw new Error("taskOutcome must be continue, complete, or doubao-unable.");
  }
  if (roundNumber < minimumRounds && taskOutcome !== "continue") {
    throw new Error(`taskOutcome must remain continue before round ${minimumRounds}.`);
  }
  if (finalRound && taskOutcome === "continue") {
    throw new Error("taskOutcome must be complete or doubao-unable at the hard round limit.");
  }
  const terminal = taskOutcome !== "continue" || finalRound;
  const nextPrompt = String(value?.nextPrompt ?? "").trim();
  if (!terminal && !nextPrompt) throw new Error("Evaluator must provide nextPrompt while the task should continue.");
  if (terminal && nextPrompt) throw new Error("Evaluator must not provide nextPrompt after a terminal outcome.");
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
  if (terminal && nextAttachmentNames.length) {
    throw new Error("Evaluator must not select attachments after a terminal outcome.");
  }
  const unresolvedIssues = Array.isArray(value?.unresolvedIssues)
    ? value.unresolvedIssues.map((item) => nonEmpty(item, "unresolvedIssues item"))
    : [];
  if (taskOutcome === "complete" && unresolvedIssues.length) {
    throw new Error("A complete taskOutcome must not retain unresolvedIssues.");
  }
  if (taskOutcome === "doubao-unable" && unresolvedIssues.length === 0) {
    throw new Error("A doubao-unable taskOutcome must identify at least one unresolved issue.");
  }
  const productAssessment = terminal
    ? validateProductAssessment(value?.productAssessment, {
      artifacts: latestArtifacts,
      requirement: productRequirement,
      responseText: latestResponse,
    })
    : null;
  if (taskOutcome === "complete"
    && (productAssessment?.accepted !== true || evaluation.score < 3 || evaluation.vote !== "like")) {
    throw new Error("A complete taskOutcome requires accepted product evidence and a like experience score of at least 3.");
  }
  return { evaluation, nextAttachmentNames, nextPrompt, productAssessment, taskOutcome, unresolvedIssues };
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

function interactionRewriteMessages({ job, prompt, recentPrompts, roundNumber, textPurpose, validationFeedback }) {
  const purposeRule = textPurpose === "feedback-note"
    ? "这段文本是赞踩反馈说明。只把评价写得像真实使用者针对本轮回复的具体反馈，不得改成追问或任务指令；不得引入原文未出现的后续目标、下一轮动作、最终交付物或选型结论。"
    : "这段文本是发给豆包的工作消息。把它改成自然、克制的真实工作委托或追问，不回答其中任务。";
  const interactionVoiceRule = textPurpose === "chat-prompt"
    ? "每轮任务消息至少自然出现一次“你”或“我”，两者有一个即可。"
    : "评价说明只回顾本轮已经呈现的优点、缺口和实际影响。用“本轮”“该结果”“这处口径”陈述观察，省去“还得调整”“需要补充”“接下来”“请”“把”等任务推进表达。";
  const firstRoundAttachmentRule = textPurpose === "chat-prompt" && Number(roundNumber) === 1
    && Array.isArray(job.initialAttachmentNames) && job.initialAttachmentNames.length > 1
    ? `这条消息会由用户侧同时上传全部 ${job.initialAttachmentNames.length} 份附件，豆包负责读取和核验。改写后保留“全部材料随当前消息一次上传”的自然语义。原文出现首轮或一次性时保留这一含义。原文把用户写成附件接收方时，按真实交互角色改为用户上传、豆包核验，这一处属于操作角色纠正。`
    : "";
  const taskGoalPreservationRule = textPurpose === "chat-prompt" && Number(roundNumber) === 1
    ? "job.taskGoal 只用于核对本题的最终工作方向。sourcePrompt 是完整可见事实源。改写后保留执行对象、实际使用者和最终结果，保持主任务唯一；taskGoal 中未出现在 sourcePrompt 的编号、数字或细节不得补进可见文本。"
    : "";
  const minimalEditRule = textPurpose === "chat-prompt" && Number(roundNumber) === 1
    && [...String(prompt)].length >= 700
    ? "首轮长题面已经完成题面级去AI。采用轻量自然化，只修复本地可见文本门禁指出的词语和标点。其余句子允许原样保留，数字与英文锚点的种类和出现次数保持一致。"
    : "";
  const system = `你是豆包工作交互的去 AI 改写员，只负责重组语言，不负责重新设计内容。\n`
    + `${purposeRule}\n`
    + `必须完整保留原文中的人物、组织、产品、平台、数字、日期、链接、文件名、交付物、事实边界、任务目的和轮次边界，不得增加新事实、新判断或新要求。\n`
    + `人物、组织范围、产品名、附件编号、日期和交付格式属于不可改写锚点，必须按原文逐字保留；只能调整这些锚点前后的句式。\n`
    + `${taskGoalPreservationRule}\n`
    + `${firstRoundAttachmentRule}\n`
    + `${minimalEditRule}\n`
    + `默认用户为国内用户，不得引入国外平台或国内敏感议题。计算任务不得降低原有复杂度。\n`
    + `表达要像同事之间自然明确的工作沟通，不写成模型提示词、审核规则、宣传文案或机械清单。避免“首先、其次、再次、最后、综上所述、核心在于、本质上、全链路、闭环、多维度、赋能”等机器表达。\n`
    + `不要靠增加礼貌词制造真人感。“麻烦”“劳烦”“烦请”“辛苦”不得用作请求开场或任务推进语；原文已有这类客套请求时，也要在不改变任务含义的前提下改为直接表达。\n`
    + `“请”和“帮我”可以偶尔保留，但不得与 recentPrompts 中最近三轮重复使用同一种请求开头。后续追问优先写成“指出上一轮具体问题或结论，再直接说明下一步动作”，不要每轮套同一个礼貌句式。\n`
    + `每轮只保留一个主诉求，并可带一个直接服务主诉求的子诉求。不得增加第三个任务、未来轮次计划、风险全集、回滚树或限制清单。看到豆包真实回复后再决定下一轮。\n`
    + `豆包可见文本统一使用正向动作句，直接写清对象、动作、输出和验收状态。把“不要……而要……”“不是……而是……”“不能仅凭……”“不能直接……”“不作为最终……”一类否定式边界提醒改成正向标准，例如写成“已确认项附直接证据，其余项记为待确认”。“匿名编号不映射供应商”写成“匿名编号独立记录，供应商映射字段留空”。“建议不形成验收或履约结论”写成“建议栏只记录补证顺序，验收与履约结论栏留空”。\n`
    + `电子表格交付在豆包可见文本里写成“Excel 表格”或“Excel 核对表”，避免使用“Excel 工作簿”和“Excel形式的”这类系统化说法。\n`
    + `${interactionVoiceRule}\n`
    + `全文不使用分号。每句话最多使用一个顿号，较长的并列内容拆成短句。\n`
    + `如果原文已经自然、完整且没有机器表达，可以原样返回，不要为了制造改写痕迹而改写。\n`
    + `不得输出运行状态、工具名称、接口信息、报错、异常、代码围栏、Markdown 标题或列表、乱码、表情和怪异标点。\n`
    + `“报错”和“异常”不属于逐字事实锚点。sourcePrompt 含这两个词时必须改为失败记录、差异、疑点、缺失、超限或更具体的业务状态，数字和事实含义保持不变。\n`
    + `只输出 JSON：{"prompt":"完整改写后的可见文本"}`;
  const userPayload = {
    requiredLatinTokens: [...new Set(sortedMatches(prompt, /\b[A-Za-z][A-Za-z0-9_.+-]*\b/gu))],
    requiredNumberTokens: sortedMatches(prompt, /\d+(?:\.\d+)?(?:%|％)?/gu),
    roundNumber,
    recentPrompts: Array.isArray(recentPrompts) ? recentPrompts.slice(-3) : [],
    textPurpose,
    sourcePrompt: String(prompt),
    sourceVisibleIssues: auditOutboundPrompt(prompt, {
      recentPrompts,
      requirePersonalPronoun: textPurpose === "chat-prompt",
      scopeContext: { sourcePrompt: prompt },
      textPurpose,
    }).issues,
  };
  if (textPurpose === "chat-prompt" && Number(roundNumber) === 1) {
    userPayload.taskGoal = String(job.taskGoal ?? "");
    userPayload.initialAttachmentNames = job.initialAttachmentNames ?? [];
  }
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify(userPayload),
    },
  ];
  if (String(validationFeedback ?? "").trim()) {
    const repairInstruction = textPurpose === "feedback-note"
      ? "上一版已通过去 AI 基础校验，但本机质量检查发现了具体问题。按质检意见重新改写 sourcePrompt，保留原始评价事实和数字，不得把反馈说明改成追问或任务指令。"
      : "上一版已通过去 AI 基础校验，但本机质量检查发现了具体问题。按质检意见局部修复 sourcePrompt。完整保留人物、对象、任务目标、交付物、事实边界、证据分类、附件动作和轮次边界。用户负责上传附件，豆包负责读取和核验。不得互换主客体动作，不得新增后续流程、结论或要求。否定式业务边界改成等价字段状态，例如匿名编号独立记录且供应商映射字段留空，建议栏只记录补证顺序且验收与履约结论栏留空。taskGoal 仅核对工作方向，不补入 sourcePrompt 没有的编号或细节。";
    messages.push({
      role: "user",
      content: JSON.stringify({
        instruction: repairInstruction,
        qualityGateFeedback: String(validationFeedback),
      }),
    });
  }
  return messages;
}

export async function requestInteractionRewrite({
  fetchImpl = globalThis.fetch,
  job,
  onRetryState = async () => {},
  policy,
  prompt,
  recentPrompts = [],
  retrySchedule,
  roundNumber,
  signal,
  sleepImpl,
  textPurpose = "chat-prompt",
  validationFeedback = "",
} = {}) {
  if (policy?.type !== "openai-compatible") {
    throw new Error('Interaction rewrite type must be "openai-compatible".');
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const sourcePrompt = nonEmpty(prompt, "Interaction rewrite source");
  const apiKey = policyCredential(policy);
  const messages = interactionRewriteMessages({
    job,
    prompt: sourcePrompt,
    recentPrompts,
    roundNumber,
    textPurpose,
    validationFeedback,
  });
  const contentValidationAttempts = Math.max(1, Math.min(3, Number(policy.contentValidationAttempts ?? 3)));
  const contentValidationTrace = [];
  const retryTrace = [];
  let lastValidationError;
  for (let contentAttempt = 1; contentAttempt <= contentValidationAttempts; contentAttempt += 1) {
    const completion = await runModelWithRetry(
      () => requestModelPayload({
        apiKey,
        fetchImpl,
        label: "Interaction de-AI rewrite",
        policy,
        signal,
        body: {
          model: nonEmpty(policy.model, "Interaction rewrite model"),
          messages,
          response_format: { type: "json_object" },
          stream: false,
          temperature: Number(policy.temperature ?? 0.55),
        },
      }),
      { label: "Interaction de-AI rewrite", onRetryState, retrySchedule, signal, sleepImpl },
    );
    retryTrace.push(...completion.retryTrace.map((item) => ({ ...item, contentAttempt })));
    const payload = completion.value;
    const rawText = messageText(payload?.choices?.[0]?.message);
    try {
      const parsed = parseDecisionJson(rawText);
      const rewrittenPrompt = validateOutboundPrompt(parsed?.prompt, {
        recentPrompts,
        requirePersonalPronoun: textPurpose === "chat-prompt",
        scopeContext: { sourcePrompt },
        textPurpose,
      });
      const preservation = auditInteractionRewrite(sourcePrompt, rewrittenPrompt);
      if (!preservation.pass) {
        const diff = preservation.anchorDiff;
        const detail = [
          diff.numbers.missing.length ? `missing numbers=${diff.numbers.missing.join("|")}` : "",
          diff.numbers.added.length ? `added numbers=${diff.numbers.added.join("|")}` : "",
          diff.latin.missing.length ? `missing latin=${diff.latin.missing.join("|")}` : "",
          diff.latin.added.length ? `added latin=${diff.latin.added.join("|")}` : "",
        ].filter(Boolean).join("; ");
        throw new Error(`fact anchors changed: ${preservation.issues.join(", ")}${detail ? `; ${detail}` : ""}`);
      }
      contentValidationTrace.push({ attempt: contentAttempt, status: "accepted" });
      return {
        changed: rewrittenPrompt !== sourcePrompt,
        contentValidationTrace,
        model: payload?.model ?? policy.model,
        pass: true,
        preservation,
        prompt: rewrittenPrompt,
        retryTrace,
        textPurpose,
        usage: payload?.usage ?? {},
      };
    } catch (error) {
      lastValidationError = error;
      contentValidationTrace.push({
        attempt: contentAttempt,
        issue: error.message,
        status: "rejected",
      });
      if (contentAttempt < contentValidationAttempts) {
        const visibleTermRepair = error.message.includes("runtime-error-word")
          ? "validationIssue 命中 runtime-error-word。下一版不得出现‘报错’或‘异常’，把对应位置改成失败记录、差异、疑点、缺失、超限或更具体的业务状态。这两个词不属于必须逐字保留的事实锚点。"
          : "依据 validationIssue 做最小范围修复。";
        messages.push(
          { role: "assistant", content: rawText },
          {
            role: "user",
            content: JSON.stringify({
              instruction: `上一版未通过可见文本与事实保真校验。${visibleTermRepair}保留 sourcePrompt 的全部数字、英文锚点、任务层次和计算复杂度。只输出规定 JSON。`,
              validationIssue: error.message,
            }),
          },
        );
      }
    }
  }
  const failure = new ModelInvocationFailedError(
    `Interaction de-AI rewrite returned an unusable result after ${contentValidationAttempts} content attempts: ${lastValidationError?.message ?? "unknown validation failure"}`,
    { cause: lastValidationError },
  );
  failure.issues = contentValidationTrace;
  throw failure;
}

function promptPreflightMessages({ conversationContext, job, prompt, roundNumber, sourcePrompt, textPurpose }) {
  const purposeRule = textPurpose === "feedback-note"
    ? "这段文本是赞踩反馈说明，必须保留对本轮回答的具体评价，不能变成追问、任务指令或客服话术。"
    : "这段文本是发给豆包的工作消息，必须保留本轮工作推进目的，不能回答任务或解释审校过程。";
  const interactionVoiceRule = textPurpose === "chat-prompt"
    ? "任务消息至少自然出现一次“你”或“我”，两者有一个即可。"
    : "评价说明只描述本轮已经呈现的优点、缺口和影响。“还得调整”“需要补充”“接下来”“请”“把”等任务推进表达视为追问或任务指令。";
  const experienceRule = textPurpose === "feedback-note"
    ? "必须对照 conversationContext 中本轮真实问题、回复、产物证据、0到4分和赞踩判断：评价说明应准确反映实际可用性，引用证据必须确实存在，3/4分只能对应like，0/1/2分只能对应dislike；不得随机、轮换、预填或为了显得友好而固定点赞。"
    : "如果是后续追问，必须根据上一轮真实回复中的具体结论、证据缺口、口径冲突或未完成产物继续推进，每轮只把问题收窄一层；不能重新复述整道题、机械换词、突然跳题或写成预设脚本。表达应像真人看完回复后自然追问。";
  const firstRoundAttachmentRoleRule = textPurpose === "chat-prompt" && Number(roundNumber) === 1
    && Array.isArray(job.initialAttachmentNames) && job.initialAttachmentNames.length > 0
    ? `本轮会由用户侧上传 ${job.initialAttachmentNames.length} 份附件，豆包负责读取和核验。sourcePrompt 若把用户写成附件接收方，允许 candidatePrompt 纠正为用户上传、豆包核验；这一处不视为事实漂移。`
    : "";
  const system = `你是发送给甲方可见豆包对话前的独立质检员。你只做检查和放行，不改写文本。\n`
    + `聊天记录会被甲方完整查看。candidatePrompt 已经由另一个模型去 AI 改写，你必须逐项对照 sourcePrompt 检查。\n`
    + `job.taskGoal 只用于核对工作方向。sourcePrompt 是完整可见事实源，不得因为 taskGoal 含有额外编号、数字或细节而要求 candidatePrompt 新增这些内容。\n`
    + `${purposeRule}\n`
    + `检查人物、组织、产品、平台、数字、日期、链接、文件名、事实边界、交付物、任务目的和轮次边界是否完整且没有新增。\n`
    + `${firstRoundAttachmentRoleRule}\n`
    + `检查文本是否自然、克制、符合真实工作场景，是否存在机器套话、国外平台、国内敏感议题、简单化计算、运行状态、工具名称、接口失败、代码围栏、Markdown、乱码、表情或怪异标点。\n`
    + `“麻烦”“劳烦”“烦请”“辛苦”作为请求开场或任务推进语一律不放行；不得靠客套词制造真人感。对照 conversationContext.recentPrompts 检查最近三轮，“请”或“帮我”不能连续复用同一种请求开头。\n`
    + `每轮只能有一个主诉求，最多附带一个直接服务它的子诉求。出现第三个并列任务、未来轮次清单、风险全集、回滚树或限制清单时不放行。\n`
    + `可见文本只写目标、动作、输出和验收状态。“不要……而要……”“不是……而是……”“不能仅凭……”“不能直接……”“不作为最终……”等否定式边界提醒或对立句式一律不放行。等价字段状态可以放行，例如“匿名编号独立记录，供应商映射字段留空”和“建议栏只记录补证顺序，验收与履约结论栏留空”。\n`
    + `${interactionVoiceRule}\n`
    + `全文出现分号时不放行。逐句统计顿号，每句话最多一个。\n`
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

function parsePromptPreflight(text, prompt, {
  recentPrompts = [],
  requirePersonalPronoun = false,
  textPurpose = "chat-prompt",
} = {}) {
  const parsed = parseDecisionJson(text);
  const checkedPrompt = validateOutboundPrompt(prompt, {
    recentPrompts,
    requirePersonalPronoun,
    textPurpose,
  });
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
  const recentPrompts = Array.isArray(conversationContext?.recentPrompts)
    ? conversationContext.recentPrompts.slice(-3)
    : [conversationContext?.previousPrompt].filter((item) => String(item ?? "").trim());
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
    checked = parsePromptPreflight(payload?.content, originalPrompt, {
      recentPrompts,
      requirePersonalPronoun: textPurpose === "chat-prompt",
      textPurpose,
    });
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
  minimumRounds = 6,
  productRequirement = resolveProductRequirement(job),
  roundNumber,
  transcript,
}) {
  const system = `你是独立的豆包办公任务轨迹评审与追问规划器。\n`
    + `你必须只输出 JSON 对象，不要输出 Markdown。\n`
    + `评价必须模拟真人用户看完本轮实际回复后的真实体验，绝对不能随机、轮流、预填或为了通过而固定点赞。先按0到4分判断可用性：4分完全满足，3分基本可用但有小缺口，2分只有部分可用，1分帮助很少，0分不可用；3或4分投like，0到2分投dislike。\n`
    + `evaluation.evidenceQuote 必须逐字摘录本轮豆包回复或本轮产物卡片中的一小段可核对内容。note 必须围绕这段实际内容说明满意点或缺口，不能写空泛套话。每轮 labels 必须包含“其他”；like 还可使用“内容准确”“易于理解”“内容完善”，dislike 为避免选择不存在的选项只使用“其他”。\n`
    + `taskOutcome 必须按实际完成度判断。任务目标或最终产物仍有可修复缺口时返回 continue，并用 nextPrompt 继续追问。达到第 ${minimumRounds} 轮不构成结束理由。只有任务目标和最终产物都已满足时返回 complete。豆包明确表示无法完成，或至少两次针对同一关键缺口追问后仍没有实质进展时，才返回 doubao-unable，并在 unresolvedIssues 中写明具体缺口。第 ${maxRounds} 轮是安全上限，到达上限仍未完成时返回 doubao-unable。\n`
    + `taskOutcome 为 continue 时，nextPrompt 必须像真人解决问题：先承接本轮一个具体结论、数字、引用、口径、遗漏或产物状态，再只向下一层收窄。每次只给一个主诉求，并可带一个直接支撑它的子诉求。优先顺序是核对事实与来源、拆分关键口径、处理冲突和缺失、补齐计算或操作细节、最后形成并验收产物。不能重复整道题、机械说“继续完善”、一次塞入多个方向，也不能提前穷举未来风险、回滚分支和限制清单。不能提到轮次、评审器、模型或自动化。\n`
    + `nextPrompt 使用正向动作句，直接说明本次要核对、拆分、补齐或生成的内容和验收状态。省去否定式边界提醒、对立句式和教唆式口吻。\n`
    + `nextPrompt 至少自然出现一次“你”或“我”。全文禁用分号，每句话最多一个顿号。\n`
    + `可在自然需要补证据时，从 availableAttachments 选择尚未上传的文件放入 nextAttachmentNames；选择后 nextPrompt 必须像真人一样自然说明为什么请它结合这些新文件继续核对。没有必要时返回空数组，不得虚构文件名。taskOutcome 为 complete 或 doubao-unable 时，nextPrompt 和 nextAttachmentNames 都必须为空。\n`
    + `默认用户为国内用户。nextPrompt 不得涉及国外平台或国内敏感议题，必须继续同一工作场景并推进证据、产物、验证或决策，不能闲聊。计算类追问必须保留至少两类真实复杂度，禁止单步四则运算或直接代数代入。\n`
    + `taskOutcome 为 complete 或 doubao-unable 时必须逐项判断 productRequirement。exact 表示返回了要求的实际格式；equivalent 只用于Excel转在线表格、Word转在线文档、PPT转在线演示或HTML转在线页面；unavailable 只在豆包明确表示无法提供原格式且已经给出可用替代内容时使用，并同时提供限制原文 evidenceQuote 和替代内容原文 bestEffortEvidenceQuote；否则为missing。\n`
    + `输出结构：{"evaluation":{"score":0,"vote":"like或dislike","labels":["其他"],"note":"基于实际体验的详细理由","evidenceQuote":"本轮回复原文片段"},"nextPrompt":"下一轮追问或空字符串","nextAttachmentNames":[],"taskOutcome":"continue或complete或doubao-unable","unresolvedIssues":[],"productAssessment":{"items":[{"requestedFormat":"excel","deliveredFormat":"online-spreadsheet","status":"equivalent","evidenceQuote":"产物原文片段","bestEffortProvided":false,"bestEffortEvidenceQuote":""}]}}`;
  const user = JSON.stringify({
    roundNumber,
    minimumRounds,
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
  decisionValidator,
  job,
  localCodexImpl,
  maxRounds,
  minimumRounds = 6,
  onRetryState = async () => {},
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
    minimumRounds,
    productRequirement,
    roundNumber,
    transcript,
  });
  let currentMessages = messages;
  const validationFailures = [];
  const retryTrace = [];
  for (let validationAttempt = 1; validationAttempt <= 3; validationAttempt += 1) {
    const completion = await runModelWithRetry(
      () => requestCodexModelCompletion({
        label: "Codex evaluator and follow-up planner",
        localCodexImpl,
        messages: currentMessages,
        outputSchema: PLANNER_OUTPUT_SCHEMA,
        policy,
        signal,
      }),
      { label: "Codex evaluator and follow-up planner", onRetryState, retrySchedule, signal, sleepImpl },
    );
    retryTrace.push(...completion.retryTrace.map((item) => ({ ...item, validationAttempt })));
    const payload = completion.value;
    const content = payload?.content;
    try {
      const latest = transcript.at(-1) ?? {};
      const decision = validatePolicyDecision(parseDecisionJson(content), {
        availableAttachmentNames: availableAttachments.map((attachment) => attachment.name),
        finalRound: roundNumber === maxRounds,
        latestArtifacts: latest.artifacts ?? [],
        latestResponse: latest.response ?? "",
        minimumRounds,
        productRequirement,
        roundNumber,
      });
      if (typeof decisionValidator === "function") decisionValidator(decision);
      return {
        ...decision,
        evaluator: {
          id: payload?.id ?? "",
          model: payload?.model ?? policy.model,
          provider: payload?.provider ?? "local-codex-cli",
          retryTrace,
          usage: payload?.usage ?? {},
          validationFailures,
        },
      };
    } catch (error) {
      validationFailures.push({ attempt: validationAttempt, message: error.message });
      if (validationAttempt === 3) {
        throw new ModelInvocationFailedError(`Evaluator returned an unusable decision: ${error.message}`, {
          cause: error,
        });
      }
      await onRetryState({
        attempts: [...retryTrace],
        status: "validation_retry",
        validationFailures: [...validationFailures],
      });
      currentMessages = [
        messages[0],
        {
          role: "user",
          content: `${messages[1].content}\n\n上一次模型输出：${String(content ?? "")}\n\n上一次 JSON 未通过本地硬校验：${error.message}\n请重新输出完整 JSON。不得放宽任务要求；evaluation.evidenceQuote 必须从本轮实际回复逐字复制，不能改写、补字或拼接。`,
        },
      ];
    }
  }
  throw new Error("Unreachable evaluator validation retry state.");
}
