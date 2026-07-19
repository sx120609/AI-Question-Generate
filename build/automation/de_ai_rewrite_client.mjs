const DEFAULT_ENDPOINT = "http://114.28.145.95:3001/api/rewrite";
const DEFAULT_BASE_URL = "https://api.mugua.link/v1";
const DEFAULT_MODEL = "gemini-3.1-pro-preview";

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return number;
}

function normalizeEndpoint(value) {
  const endpoint = new URL(requiredText(value, "endpoint"));
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new TypeError("endpoint must use HTTP or HTTPS.");
  }
  return endpoint.toString();
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function buildDeAiRewriteRequest({ text, apiKey, baseUrl, model } = {}) {
  return {
    text: requiredText(text, "text"),
    apiKey: requiredText(apiKey, "DE_AI_REWRITE_API_KEY"),
    baseUrl: requiredText(baseUrl, "baseUrl"),
    model: requiredText(model, "model"),
  };
}

export async function rewriteDeAiText({
  text,
  apiKey = process.env.DE_AI_REWRITE_API_KEY,
  endpoint = process.env.DE_AI_REWRITE_ENDPOINT || DEFAULT_ENDPOINT,
  baseUrl = process.env.DE_AI_REWRITE_BASE_URL || DEFAULT_BASE_URL,
  model = process.env.DE_AI_REWRITE_MODEL || DEFAULT_MODEL,
  timeoutMs = 300_000,
  retries = 1,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const requestEndpoint = normalizeEndpoint(endpoint);
  const requestBody = buildDeAiRewriteRequest({ text, apiKey, baseUrl, model });
  const maximumRetries = nonNegativeInteger(retries, "retries");
  const requestTimeout = positiveInteger(timeoutMs, "timeoutMs");
  let lastError;

  for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const response = await fetchImpl(requestEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const responseText = await response.text();
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        const error = new Error(`De-AI rewrite API returned non-JSON content with HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`De-AI rewrite API request failed with HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      const rewrittenText = String(payload?.text ?? "").trim();
      if (!rewrittenText) throw new Error("De-AI rewrite API returned an empty text field.");
      return {
        text: rewrittenText,
        endpoint: requestEndpoint,
        baseUrl: requestBody.baseUrl,
        model: requestBody.model,
      };
    } catch (error) {
      const safeError = error?.name === "AbortError"
        ? new Error(`De-AI rewrite API request timed out after ${requestTimeout}ms.`)
        : error;
      const status = Number(error?.status ?? 0);
      const canRetry = attempt < maximumRetries
        && error?.name !== "AbortError"
        && (!status || retryableStatus(status));
      if (!canRetry) throw safeError;
      lastError = safeError;
      await wait(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("De-AI rewrite API request failed.");
}

export const DE_AI_REWRITE_DEFAULTS = Object.freeze({
  endpoint: DEFAULT_ENDPOINT,
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
});
