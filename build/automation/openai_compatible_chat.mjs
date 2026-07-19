const DEFAULT_BASE_URL = "";
const DEFAULT_MODEL = "";

function required(value, label) {
  if (value == null || (typeof value === "string" && !value.trim())) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

export function normalizeOpenAiBaseUrl(value = DEFAULT_BASE_URL) {
  const url = new URL(String(required(value, "baseUrl")).trim());
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (url.pathname.endsWith("/v1")) url.pathname = url.pathname.slice(0, -3);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

export function buildChatCompletionsRequest({
  model = DEFAULT_MODEL,
  messages,
  temperature = 0.35,
  maxTokens = 4_000,
  stream = false,
} = {}) {
  required(model, "model");
  if (!Array.isArray(messages) || !messages.length) {
    throw new TypeError("messages must be a non-empty array.");
  }
  for (const [index, message] of messages.entries()) {
    if (!["system", "user", "assistant"].includes(message?.role) || !String(message?.content ?? "").trim()) {
      throw new TypeError(`messages[${index}] must contain a supported role and non-empty content.`);
    }
  }
  if (!Number.isFinite(Number(temperature)) || Number(temperature) < 0 || Number(temperature) > 2) {
    throw new TypeError("temperature must be between 0 and 2.");
  }
  if (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) < 1) {
    throw new TypeError("maxTokens must be a positive integer.");
  }
  return {
    model: String(model),
    messages: messages.map(({ role, content }) => ({ role, content: String(content) })),
    temperature: Number(temperature),
    max_tokens: Number(maxTokens),
    stream: Boolean(stream),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part) => part?.type === "text" || typeof part?.text === "string")
      .map((part) => part.text ?? "")
      .join("");
  }
  return "";
}

export function parseChatCompletionStream(text) {
  let id = "";
  let model = "";
  let content = "";
  let finishReason = "";
  let usage = {};
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const match = line.match(/^data:\s*(.+)$/u);
    if (!match || match[1] === "[DONE]") continue;
    const chunk = JSON.parse(match[1]);
    id ||= String(chunk?.id ?? "");
    model ||= String(chunk?.model ?? "");
    const choice = chunk?.choices?.[0];
    content += messageText(choice?.delta) || messageText(choice?.message);
    finishReason ||= String(choice?.finish_reason ?? "");
    if (chunk?.usage) usage = chunk.usage;
  }
  if (!content.trim()) throw new Error("OpenAI-compatible streaming API returned no assistant text.");
  return { id, model, content, finishReason, usage };
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status === 499 || status >= 500;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function createChatCompletion({
  apiKey = process.env.THIRD_PARTY_MODEL_API_KEY,
  baseUrl = process.env.THIRD_PARTY_MODEL_BASE_URL || DEFAULT_BASE_URL,
  model = process.env.THIRD_PARTY_MODEL || DEFAULT_MODEL,
  messages,
  temperature = 0.35,
  maxTokens = 4_000,
  timeoutMs = 120_000,
  retries = 1,
  stream = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  required(apiKey, "THIRD_PARTY_MODEL_API_KEY");
  required(baseUrl, "THIRD_PARTY_MODEL_BASE_URL");
  required(model, "THIRD_PARTY_MODEL");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const endpoint = `${normalizeOpenAiBaseUrl(baseUrl)}/v1/chat/completions`;
  const body = buildChatCompletionsRequest({ model, messages, temperature, maxTokens, stream });
  let lastError;

  for (let attempt = 0; attempt <= Number(retries); attempt += 1) {
    const controller = new AbortController();
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
        if (response.ok && body.stream) {
          payload = parseChatCompletionStream(text);
        } else {
          const error = new Error(`OpenAI-compatible API returned non-JSON content with HTTP ${response.status}.`);
          error.status = response.status;
          throw error;
        }
      }
      if (!response.ok) {
        const message = String(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
        const error = new Error(`OpenAI-compatible API request failed: ${message}`);
        error.status = response.status;
        if (attempt < Number(retries) && retryableStatus(response.status)) {
          lastError = error;
          await wait(500 * (attempt + 1));
          continue;
        }
        throw error;
      }
      const choice = payload?.choices?.[0];
      const content = body.stream ? payload.content : messageText(choice?.message);
      if (!content.trim()) throw new Error("OpenAI-compatible API returned no assistant text.");
      return {
        id: payload.id ?? "",
        model: payload.model ?? body.model,
        content,
        finishReason: body.stream ? payload.finishReason : choice?.finish_reason ?? "",
        usage: {
          inputTokens: Number(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens ?? 0),
          outputTokens: Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens ?? 0),
          totalTokens: Number(payload?.usage?.total_tokens ?? 0),
        },
      };
    } catch (error) {
      const safeError = error?.name === "AbortError"
        ? new Error(`OpenAI-compatible API request timed out after ${timeoutMs}ms.`)
        : error;
      if (attempt < Number(retries) && error?.name !== "AbortError") {
        lastError = safeError;
        await wait(500 * (attempt + 1));
        continue;
      }
      throw safeError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("OpenAI-compatible API request failed.");
}

export const OPENAI_COMPATIBLE_DEFAULTS = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
});
