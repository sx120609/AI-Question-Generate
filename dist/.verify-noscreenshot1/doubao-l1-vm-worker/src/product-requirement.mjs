const FORMAT_ALIASES = Object.freeze({
  doc: "word",
  docx: "word",
  excel: "excel",
  html: "html",
  "online-document": "online-document",
  "online-page": "online-page",
  "online-presentation": "online-presentation",
  "online-spreadsheet": "online-spreadsheet",
  pdf: "pdf",
  ppt: "ppt",
  pptx: "ppt",
  word: "word",
  xls: "excel",
  xlsx: "excel",
});

const EQUIVALENT_FORMATS = Object.freeze({
  excel: new Set(["online-spreadsheet"]),
  html: new Set(["online-page"]),
  ppt: new Set(["online-presentation"]),
  word: new Set(["online-document"]),
});

const INFERRED_FORMATS = Object.freeze([
  { format: "excel", pattern: /Excel|XLSX|\.xlsx\b|工作簿/iu },
  { format: "html", pattern: /HTML\s*(?:格式|文件|操作页|页面)|\.html\b/iu },
  { format: "word", pattern: /Word\s*(?:格式|文件|文档)|DOCX|\.docx\b/iu },
  { format: "ppt", pattern: /PPTX?|PowerPoint|演示文稿/iu },
  { format: "pdf", pattern: /(?:输出|生成|制作|交付|提供).{0,20}PDF|PDF\s*格式/iu },
]);

function normalizeFormat(value, label = "product format") {
  const raw = String(value ?? "").trim().toLowerCase();
  const format = FORMAT_ALIASES[raw];
  if (!format) throw new Error(`Unsupported ${label}: ${String(value)}.`);
  return format;
}

function unique(values) {
  return [...new Set(values)];
}

export function resolveProductRequirement(job = {}) {
  const explicit = job.productRequirement;
  if (explicit != null && (typeof explicit !== "object" || Array.isArray(explicit))) {
    throw new Error("productRequirement must be an object when provided.");
  }
  if (explicit?.requestedFormats != null && !Array.isArray(explicit.requestedFormats)) {
    throw new Error("productRequirement.requestedFormats must be an array when provided.");
  }
  const combinedText = [
    job.initialPrompt,
    job.taskGoal,
    ...(Array.isArray(job.successCriteria) ? job.successCriteria : []),
  ].map((value) => String(value ?? "")).join("\n");
  const requestedFormats = explicit?.requestedFormats == null
    ? INFERRED_FORMATS.filter(({ pattern }) => pattern.test(combinedText)).map(({ format }) => format)
    : explicit.requestedFormats.map((format) => normalizeFormat(format, "requested product format"));
  const normalizedFormats = unique(requestedFormats);
  const requirement = {
    allowEquivalentOnline: explicit?.allowEquivalentOnline !== false,
    allowUnavailableBestEffort: explicit?.allowUnavailableBestEffort !== false,
    required: explicit?.required == null ? normalizedFormats.length > 0 : explicit.required === true,
    requestedFormats: normalizedFormats,
  };
  if (requirement.required && requirement.requestedFormats.length === 0) {
    throw new Error("A required productRequirement must list or imply at least one requested format.");
  }
  return requirement;
}

function evidenceText(responseText, artifacts = []) {
  return [
    String(responseText ?? ""),
    ...artifacts.flatMap((artifact) => [artifact?.text, artifact?.label, artifact?.href]),
  ].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
}

function validateEvidenceQuote(value, haystack, label) {
  const quote = String(value ?? "").trim();
  if ([...quote].length < 2) throw new Error(`${label} must contain a concrete response excerpt.`);
  if (!haystack.includes(quote)) throw new Error(`${label} was not found in the actual Doubao response or artifact evidence.`);
  return quote;
}

export function validateProductAssessment(value, {
  artifacts = [],
  requirement,
  responseText,
} = {}) {
  const resolvedRequirement = requirement ?? resolveProductRequirement({});
  if (!resolvedRequirement.required || resolvedRequirement.requestedFormats.length === 0) {
    return { accepted: true, items: [], overall: "not-required", requirement: resolvedRequirement };
  }
  const items = Array.isArray(value?.items) ? value.items : [];
  const byRequestedFormat = new Map();
  for (const item of items) {
    const requestedFormat = normalizeFormat(item?.requestedFormat, "assessed requested format");
    if (byRequestedFormat.has(requestedFormat)) {
      throw new Error(`Product assessment contains duplicate entries for ${requestedFormat}.`);
    }
    byRequestedFormat.set(requestedFormat, item);
  }
  const haystack = evidenceText(responseText, artifacts);
  const artifactHaystack = evidenceText("", artifacts);
  const normalizedItems = resolvedRequirement.requestedFormats.map((requestedFormat) => {
    const item = byRequestedFormat.get(requestedFormat);
    if (!item) {
      return { accepted: false, requestedFormat, status: "missing" };
    }
    const status = String(item.status ?? "").trim();
    if (!new Set(["exact", "equivalent", "unavailable", "missing"]).has(status)) {
      throw new Error(`Unsupported product assessment status: ${status}.`);
    }
    if (status === "missing") return { accepted: false, requestedFormat, status };
    const quote = validateEvidenceQuote(item.evidenceQuote, haystack, `Evidence for ${requestedFormat}`);
    if (status === "unavailable") {
      const bestEffortProvided = item.bestEffortProvided === true;
      const bestEffortEvidenceQuote = bestEffortProvided
        ? validateEvidenceQuote(item.bestEffortEvidenceQuote, haystack, `Best-effort evidence for ${requestedFormat}`)
        : "";
      const explicitlyUnavailable = /无法|不能|未能|暂不支持|不支持|没法/iu.test(quote)
        || /无法|不能|未能|暂不支持|不支持|没法/iu.test(haystack);
      const accepted = resolvedRequirement.allowUnavailableBestEffort
        && bestEffortProvided
        && explicitlyUnavailable;
      return {
        accepted,
        bestEffortEvidenceQuote,
        bestEffortProvided,
        evidenceQuote: quote,
        requestedFormat,
        status,
      };
    }
    const deliveredFormat = normalizeFormat(item.deliveredFormat, "delivered product format");
    const artifactBacked = artifactHaystack.includes(quote)
      || artifacts.some((artifact) => /^https?:\/\//iu.test(String(artifact?.href ?? "")));
    const exact = status === "exact" && deliveredFormat === requestedFormat;
    const equivalent = status === "equivalent"
      && resolvedRequirement.allowEquivalentOnline
      && EQUIVALENT_FORMATS[requestedFormat]?.has(deliveredFormat) === true;
    return {
      accepted: artifactBacked && (exact || equivalent),
      artifactBacked,
      deliveredFormat,
      evidenceQuote: quote,
      requestedFormat,
      status,
    };
  });
  return {
    accepted: normalizedItems.every((item) => item.accepted),
    items: normalizedItems,
    overall: normalizedItems.every((item) => item.accepted) ? "accepted" : "missing-or-unacceptable",
    requirement: resolvedRequirement,
  };
}
