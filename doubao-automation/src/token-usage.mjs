const TOKEN_FIELDS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "visibleOutputTokens",
  "totalTokens",
]);

function tokenNumber(usage, camelName, snakeName = "") {
  const value = usage?.[camelName] ?? (snakeName ? usage?.[snakeName] : undefined);
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function normalizeTokenUsageRecord(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = tokenNumber(usage, "inputTokens", "input_tokens");
  const outputTokens = tokenNumber(usage, "outputTokens", "output_tokens");
  const cachedInputTokens = tokenNumber(
    usage,
    "cachedInputTokens",
  ) || tokenNumber(usage?.input_tokens_details, "cached_tokens");
  const reasoningTokens = tokenNumber(
    usage,
    "reasoningTokens",
  ) || tokenNumber(usage?.output_tokens_details, "reasoning_tokens");
  const hasOfficialCounters = Number.isFinite(Number(usage.inputTokens ?? usage.input_tokens))
    && Number.isFinite(Number(usage.outputTokens ?? usage.output_tokens));
  const metered = usage.metered === false ? false : (usage.metered === true || hasOfficialCounters);
  return {
    metered,
    source: String(usage.source ?? ""),
    requestCount: Math.max(1, tokenNumber(usage, "requestCount") || 1),
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, cachedInputTokens),
    uncachedInputTokens: tokenNumber(usage, "uncachedInputTokens")
      || Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, reasoningTokens),
    visibleOutputTokens: tokenNumber(usage, "visibleOutputTokens")
      || Math.max(0, outputTokens - reasoningTokens),
    totalTokens: tokenNumber(usage, "totalTokens", "total_tokens") || inputTokens + outputTokens,
  };
}

export function aggregateTokenUsage(usages = []) {
  const records = usages.map(normalizeTokenUsageRecord).filter(Boolean);
  const meteredRecords = records.filter((item) => item.metered);
  const result = {
    metered: records.length > 0 && meteredRecords.length === records.length,
    source: "responses-api-aggregate",
    requestCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    visibleOutputTokens: 0,
    totalTokens: 0,
  };
  for (const record of meteredRecords) {
    result.requestCount += record.requestCount;
    for (const field of TOKEN_FIELDS) result[field] += record[field];
  }
  return result;
}

export function summarizeUsageEntries(entries = []) {
  const normalizedEntries = entries.map((entry) => ({
    ...entry,
    usage: normalizeTokenUsageRecord(entry?.usage),
  }));
  const metered = normalizedEntries.filter((entry) => entry.usage?.metered);
  const unmetered = normalizedEntries.filter((entry) => !entry.usage?.metered);
  return {
    schemaVersion: 1,
    kind: "codex-token-usage-summary",
    completeMetering: normalizedEntries.length > 0 && unmetered.length === 0,
    recordCount: normalizedEntries.length,
    meteredRecordCount: metered.length,
    unmeteredRecordCount: unmetered.length,
    totals: aggregateTokenUsage(metered.map((entry) => entry.usage)),
    entries: normalizedEntries,
  };
}
