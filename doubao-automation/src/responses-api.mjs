const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_REASONING_EFFORT = "high";
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function required(value, label) {
  if (value == null || (typeof value === "string" && !value.trim())) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function finiteToken(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function normalizeResponsesBaseUrl(value = DEFAULT_BASE_URL) {
  const url = new URL(String(required(value, "baseUrl")).trim());
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (url.pathname.endsWith("/v1/responses")) {
    url.pathname = url.pathname.slice(0, -13);
  } else if (url.pathname.endsWith("/v1")) {
    url.pathname = url.pathname.slice(0, -3);
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

export function responsesEndpoint(baseUrl = DEFAULT_BASE_URL) {
  return `${normalizeResponsesBaseUrl(baseUrl)}/v1/responses`;
}

function safeSchemaName(value) {
  const normalized = String(value ?? "codex_json_response")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  return normalized || "codex_json_response";
}

export function buildResponsesRequest({
  model = DEFAULT_MODEL,
  instructions,
  input,
  maxOutputTokens = 6_000,
  outputSchema,
  outputSchemaName = "codex_json_response",
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  store = false,
} = {}) {
  required(model, "model");
  required(input, "input");
  if (!Number.isInteger(Number(maxOutputTokens)) || Number(maxOutputTokens) < 1) {
    throw new TypeError("maxOutputTokens must be a positive integer.");
  }
  const normalizedEffort = String(reasoningEffort ?? "").trim().toLowerCase();
  if (!REASONING_EFFORTS.has(normalizedEffort)) {
    throw new TypeError(`Unsupported reasoning effort: ${reasoningEffort}`);
  }
  if (outputSchema != null && (typeof outputSchema !== "object" || Array.isArray(outputSchema))) {
    throw new TypeError("outputSchema must be a JSON Schema object.");
  }
  return {
    model: String(model).trim(),
    ...(String(instructions ?? "").trim() ? { instructions: String(instructions).trim() } : {}),
    input: String(input),
    max_output_tokens: Number(maxOutputTokens),
    reasoning: { effort: normalizedEffort },
    ...(outputSchema ? {
      text: {
        format: {
          type: "json_schema",
          name: safeSchemaName(outputSchemaName),
          strict: true,
          schema: outputSchema,
        },
      },
    } : {}),
    store: Boolean(store),
  };
}

function outputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const parts = [];
  for (const item of payload?.output ?? []) {
    for (const part of item?.content ?? []) {
      if (typeof part?.text === "string" && ["output_text", "text"].includes(part.type ?? "output_text")) {
        parts.push(part.text);
      }
    }
  }
  return parts.join("");
}

function refusalText(payload) {
  const parts = [];
  for (const item of payload?.output ?? []) {
    for (const part of item?.content ?? []) {
      if (typeof part?.refusal === "string" && part.refusal.trim()) parts.push(part.refusal.trim());
    }
  }
  return parts.join(" ");
}

function attachResponseMetering(error, { body, payload, requestId, usage }) {
  error.usage = usage;
  error.provider = "openai-compatible-responses-api";
  error.model = String(payload?.model ?? body.model);
  error.responseId = String(payload?.id ?? "");
  error.requestId = String(requestId ?? "");
  return error;
}

export function normalizeResponsesUsage(rawUsage, { requireUsage = true } = {}) {
  if (!rawUsage || typeof rawUsage !== "object") {
    if (requireUsage) throw new Error("Responses API returned no usage object; exact token metering is unavailable.");
    return {
      metered: false,
      source: "responses-api",
      requestCount: 1,
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      visibleOutputTokens: 0,
      totalTokens: 0,
      providerUsage: null,
    };
  }
  const hasInput = Number.isFinite(Number(rawUsage.input_tokens));
  const hasOutput = Number.isFinite(Number(rawUsage.output_tokens));
  if (requireUsage && (!hasInput || !hasOutput)) {
    throw new Error("Responses API usage is missing input_tokens or output_tokens; exact token metering is unavailable.");
  }
  const inputTokens = finiteToken(rawUsage.input_tokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    finiteToken(rawUsage?.input_tokens_details?.cached_tokens),
  );
  const outputTokens = finiteToken(rawUsage.output_tokens);
  const reasoningTokens = Math.min(
    outputTokens,
    finiteToken(rawUsage?.output_tokens_details?.reasoning_tokens),
  );
  const rawTotal = finiteToken(rawUsage.total_tokens, inputTokens + outputTokens);
  return {
    metered: hasInput && hasOutput,
    source: "responses-api",
    requestCount: 1,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    reasoningTokens,
    visibleOutputTokens: Math.max(0, outputTokens - reasoningTokens),
    totalTokens: rawTotal,
    providerUsage: structuredClone(rawUsage),
  };
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status === 499 || status >= 500;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redactCredential(value, credential) {
  const text = String(value ?? "");
  return credential ? text.split(String(credential)).join("[REDACTED]") : text;
}

export async function completeWithResponsesApi({
  apiKey = process.env.CODEX_RESPONSES_API_KEY
    || process.env.CODEX_MODEL_API_KEY
    || process.env.OPENAI_API_KEY,
  baseUrl = process.env.CODEX_RESPONSES_BASE_URL
    || process.env.CODEX_MODEL_BASE_URL
    || process.env.OPENAI_BASE_URL
    || DEFAULT_BASE_URL,
  model = process.env.CODEX_RESPONSES_MODEL
    || process.env.CODEX_MODEL
    || process.env.OPENAI_MODEL
    || DEFAULT_MODEL,
  instructions,
  systemPrompt,
  input,
  userPrompt,
  maxOutputTokens = 6_000,
  outputSchema,
  outputSchemaName,
  reasoningEffort = process.env.CODEX_RESPONSES_REASONING_EFFORT
    || process.env.CODEX_REASONING_EFFORT
    || DEFAULT_REASONING_EFFORT,
  requireUsage = true,
  signal,
  store = false,
  timeoutMs = 360_000,
  retries = 1,
  fetchImpl = globalThis.fetch,
} = {}) {
  required(apiKey, "CODEX_RESPONSES_API_KEY");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const endpoint = responsesEndpoint(baseUrl);
  const body = buildResponsesRequest({
    model,
    instructions: instructions ?? systemPrompt,
    input: input ?? userPrompt,
    maxOutputTokens,
    outputSchema,
    outputSchemaName,
    reasoningEffort,
    store,
  });
  let lastError;

  for (let attempt = 0; attempt <= Number(retries); attempt += 1) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        const error = new Error(`Responses API returned non-JSON content with HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      if (!response.ok) {
        const message = redactCredential(
          payload?.error?.message || payload?.message || `HTTP ${response.status}`,
          apiKey,
        );
        const error = new Error(`Responses API request failed: ${message}`);
        error.status = response.status;
        if (attempt < Number(retries) && retryableStatus(response.status)) {
          lastError = error;
          await wait(500 * (attempt + 1));
          continue;
        }
        throw error;
      }
      const requestId = String(response.headers?.get?.("x-request-id") ?? "");
      const usage = normalizeResponsesUsage(payload.usage, { requireUsage });
      const content = outputText(payload);
      if (!content.trim()) {
        const refusal = refusalText(payload);
        throw attachResponseMetering(new Error(refusal
          ? `Responses API refused the request: ${refusal}`
          : "Responses API returned no output text."), { body, payload, requestId, usage });
      }
      if (outputSchema) {
        try {
          JSON.parse(content);
        } catch (cause) {
          throw attachResponseMetering(
            new Error("Responses API returned output that is not valid structured JSON.", { cause }),
            { body, payload, requestId, usage },
          );
        }
      }
      return {
        id: String(payload.id ?? ""),
        requestId,
        model: String(payload.model ?? body.model),
        provider: "openai-compatible-responses-api",
        content,
        finishReason: String(payload.status ?? ""),
        usage,
      };
    } catch (error) {
      const abortedByCaller = signal?.aborted === true;
      const safeError = error?.name === "AbortError"
        ? new Error(abortedByCaller
          ? "Responses API request was aborted."
          : `Responses API request timed out after ${timeoutMs}ms.`)
        : error;
      if (abortedByCaller) {
        safeError.code = "RESPONSES_API_ABORTED";
        throw safeError;
      }
      if (attempt < Number(retries) && error?.name !== "AbortError" && retryableStatus(Number(error?.status ?? 0))) {
        lastError = safeError;
        await wait(500 * (attempt + 1));
        continue;
      }
      throw safeError;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError || new Error("Responses API request failed.");
}

export const createResponsesCompletion = completeWithResponsesApi;

export const OPENAI_RESPONSES_DEFAULTS = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
});
