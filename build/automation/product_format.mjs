export const PRODUCT_FORMAT_ORDER = [
  "docx",
  "xlsx",
  "pptx",
  "html",
  "pdf",
  "csv",
  "json",
  "yaml",
  "md",
  "txt",
  "zip",
  "png",
  "jpg",
  "jpeg",
];

export const ALLOWED_PRODUCT_FORMATS = new Set(PRODUCT_FORMAT_ORDER);

function splitRawTags(value) {
  const source = String(value ?? "").trim();
  if (!source) return [];
  const separated = source.split(/[,，;；、/+]+/).map((item) => item.trim()).filter(Boolean);
  if (separated.length === 1 && /^(?:[a-z0-9]+\s+)+[a-z0-9]+$/i.test(source)) {
    return source.split(/\s+/).filter(Boolean);
  }
  return separated;
}

function aliasToExtension(value) {
  const compact = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（）()]/g, "");
  if (!compact) return "";
  if (compact === "word" || compact.includes("docx") || compact.includes("word文档")) return "docx";
  if (compact === "excel" || compact.includes("xlsx") || compact.includes("excel表格") || compact.includes("工作簿")) return "xlsx";
  if (compact === "ppt" || compact.includes("pptx") || compact.includes("演示文稿") || compact.includes("幻灯片")) return "pptx";
  if (compact.includes("html") || compact === "网页" || compact.includes("html页面")) return "html";
  if (compact.includes("pdf")) return "pdf";
  if (compact.includes("csv")) return "csv";
  if (compact.includes("json")) return "json";
  if (compact.includes("yaml") || compact.includes("yml")) return "yaml";
  if (compact === "markdown" || compact === "md" || compact.includes("markdown文档")) return "md";
  if (ALLOWED_PRODUCT_FORMATS.has(compact)) return compact;
  return "";
}

export function analyzeProductFormat(value) {
  const source = String(value ?? "").trim();
  const rawTags = splitRawTags(source);
  const unknown = [];
  const formats = [];
  for (const rawTag of rawTags) {
    const extension = aliasToExtension(rawTag);
    if (!extension) {
      unknown.push(rawTag);
      continue;
    }
    if (!formats.includes(extension)) formats.push(extension);
  }
  formats.sort((a, b) => PRODUCT_FORMAT_ORDER.indexOf(a) - PRODUCT_FORMAT_ORDER.indexOf(b));
  const canonical = formats.join(", ");
  return {
    source,
    rawTags,
    formats,
    unknown,
    canonical,
    isCanonical: unknown.length === 0 && Boolean(canonical) && source === canonical,
  };
}

export function canonicalizeProductFormat(value, { strict = true } = {}) {
  const result = analyzeProductFormat(value);
  if (strict && (!result.canonical || result.unknown.length)) {
    const details = result.unknown.length ? ` Unknown tags: ${result.unknown.join(", ")}.` : "";
    throw new Error(`Invalid product format: ${String(value ?? "")}.${details}`);
  }
  return result.canonical;
}
