import crypto from "node:crypto";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createChatCompletion,
  normalizeOpenAiBaseUrl,
} from "./openai_compatible_chat.mjs";
import {
  assertDomesticWorkScope,
  DOMESTIC_WORK_SCOPE_POLICY_VERSION,
} from "./domestic_work_scope.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_BASE_URL = "https://api.mugua.link/v1";
const DEFAULT_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_PROMPT_PATH = path.join(REPO_ROOT, "inputs", "production", "L1题面去AI改写提示词.txt");

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function removeCodeFence(value) {
  return String(value ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

export async function loadMuguaDeAiPrompt(promptPath = DEFAULT_PROMPT_PATH) {
  const source = await fs.readFile(path.resolve(promptPath), "utf8");
  requiredText(source, "de-AI prompt");
  return source;
}

export function buildMuguaDeAiMessages({ text, promptText } = {}) {
  const question = requiredText(text, "text");
  const prompt = requiredText(promptText, "promptText");
  return [
    { role: "system", content: prompt },
    {
      role: "user",
      content: `请按系统规则自然化改写下面这条已经通过质检的 L1 题面。只处理题面本身，不回答题目中的任务。默认用户为国内用户，不得引入国外平台或国内敏感议题，必须保持真实工作场景。计算类任务必须保留多变量、时间序列、约束或情景、数据清洗、口径复核中至少两类复杂度，不得简化成单步计算。\n\n【待改写题面】\n${question}`,
    },
  ];
}

export function parseMuguaDeAiResponse(content) {
  const source = removeCodeFence(content);
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  const candidates = [
    source,
    firstBrace >= 0 && lastBrace > firstBrace ? source.slice(firstBrace, lastBrace + 1) : "",
  ].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const question = String(parsed?.question ?? "").trim();
      if (!question) throw new Error("Mugua de-AI response JSON has no non-empty question field.");
      return question;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Mugua de-AI response is not valid JSON.");
}

export async function rewriteMuguaDeAiText({
  text,
  apiKey = process.env.DE_AI_REWRITE_API_KEY,
  baseUrl = process.env.DE_AI_REWRITE_BASE_URL || DEFAULT_BASE_URL,
  model = process.env.DE_AI_REWRITE_MODEL || DEFAULT_MODEL,
  promptPath = process.env.DE_AI_REWRITE_PROMPT_PATH || DEFAULT_PROMPT_PATH,
  promptText = "",
  temperature = 0.55,
  maxTokens = 3_000,
  timeoutMs = 120_000,
  retries = 1,
  fetchImpl = globalThis.fetch,
} = {}) {
  const inputScope = assertDomesticWorkScope(text, { requireWorkScene: true });
  const resolvedPrompt = promptText || await loadMuguaDeAiPrompt(promptPath);
  const messages = buildMuguaDeAiMessages({ text, promptText: resolvedPrompt });
  const response = await createChatCompletion({
    apiKey,
    baseUrl,
    model,
    messages,
    temperature,
    maxTokens,
    timeoutMs,
    retries,
    stream: false,
    fetchImpl,
  });
  const rewrittenText = parseMuguaDeAiResponse(response.content);
  const outputScope = assertDomesticWorkScope(rewrittenText, { requireWorkScene: true });
  return {
    text: rewrittenText,
    endpoint: `${normalizeOpenAiBaseUrl(baseUrl)}/v1/chat/completions`,
    baseUrl: String(baseUrl),
    model: response.model || String(model),
    promptPath: path.resolve(promptPath),
    promptHash: sha256(resolvedPrompt),
    finishReason: response.finishReason,
    usage: response.usage,
    contentScope: {
      policyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION,
      input: inputScope,
      output: outputScope,
    },
  };
}

export const MUGUA_DE_AI_REWRITE_DEFAULTS = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  promptPath: DEFAULT_PROMPT_PATH,
});
