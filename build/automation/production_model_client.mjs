import { createChatCompletion } from "./openai_compatible_chat.mjs";
import { createResponsesCompletion, OPENAI_RESPONSES_DEFAULTS } from "./openai_responses.mjs";

export const CODEX_MODEL_PROVIDER = "codex-model";
export const THIRD_PARTY_MODEL_PROVIDER = "third-party-openai-compatible";

function required(value, label) {
  if (value == null || (typeof value === "string" && !value.trim())) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

export function normalizeProductionModelProvider(value = process.env.PRODUCTION_MODEL_PROVIDER || CODEX_MODEL_PROVIDER) {
  const normalized = String(value).trim().toLowerCase().replace(/[_\s]+/gu, "-");
  if (["codex", "codex-model", "openai", "openai-responses", "responses"].includes(normalized)) {
    return CODEX_MODEL_PROVIDER;
  }
  if (["third-party", "third-party-openai-compatible", "openai-compatible", "compatible"].includes(normalized)) {
    return THIRD_PARTY_MODEL_PROVIDER;
  }
  throw new TypeError(`Unsupported production model provider: ${value}`);
}

export function resolveProductionModelConfig({ provider, apiKey, baseUrl, model, reasoningEffort } = {}) {
  const providerId = normalizeProductionModelProvider(provider);
  if (providerId === CODEX_MODEL_PROVIDER) {
    return {
      provider: providerId,
      apiKey: required(
        apiKey || process.env.CODEX_RESPONSES_API_KEY || process.env.CODEX_MODEL_API_KEY || process.env.OPENAI_API_KEY,
        "CODEX_RESPONSES_API_KEY",
      ),
      baseUrl: baseUrl
        || process.env.CODEX_RESPONSES_BASE_URL
        || process.env.CODEX_MODEL_BASE_URL
        || process.env.OPENAI_BASE_URL
        || OPENAI_RESPONSES_DEFAULTS.baseUrl,
      model: model
        || process.env.CODEX_RESPONSES_MODEL
        || process.env.CODEX_MODEL
        || process.env.OPENAI_MODEL
        || OPENAI_RESPONSES_DEFAULTS.model,
      reasoningEffort: reasoningEffort
        || process.env.CODEX_RESPONSES_REASONING_EFFORT
        || process.env.CODEX_REASONING_EFFORT
        || OPENAI_RESPONSES_DEFAULTS.reasoningEffort,
    };
  }
  return {
    provider: providerId,
    apiKey: required(apiKey || process.env.THIRD_PARTY_MODEL_API_KEY, "THIRD_PARTY_MODEL_API_KEY"),
    baseUrl: required(baseUrl || process.env.THIRD_PARTY_MODEL_BASE_URL, "THIRD_PARTY_MODEL_BASE_URL"),
    model: required(model || process.env.THIRD_PARTY_MODEL, "THIRD_PARTY_MODEL"),
    reasoningEffort: "",
  };
}

export async function completeProductionPrompt({
  provider,
  apiKey,
  baseUrl,
  model,
  reasoningEffort,
  systemPrompt,
  userPrompt,
  temperature = 0.2,
  maxTokens = 6_000,
  timeoutMs = 360_000,
  retries = 1,
  stream = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  required(systemPrompt, "systemPrompt");
  required(userPrompt, "userPrompt");
  const config = resolveProductionModelConfig({ provider, apiKey, baseUrl, model, reasoningEffort });
  const completion = config.provider === CODEX_MODEL_PROVIDER
    ? await createResponsesCompletion({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      instructions: systemPrompt,
      input: userPrompt,
      maxOutputTokens: maxTokens,
      reasoningEffort: config.reasoningEffort,
      timeoutMs,
      retries,
      fetchImpl,
    })
    : await createChatCompletion({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature,
      maxTokens,
      timeoutMs,
      retries,
      stream,
      fetchImpl,
    });
  return {
    ...completion,
    provider: config.provider,
  };
}

export const PRODUCTION_MODEL_DEFAULTS = Object.freeze({
  provider: CODEX_MODEL_PROVIDER,
  model: OPENAI_RESPONSES_DEFAULTS.model,
  baseUrl: OPENAI_RESPONSES_DEFAULTS.baseUrl,
  reasoningEffort: OPENAI_RESPONSES_DEFAULTS.reasoningEffort,
});
