import { analyzeProductFormat } from "./product_format.mjs";

export const PRODUCT_FORMAT_DIVERSITY_POLICY_ID = "office-deliverable-diversity-v1";
export const CORE_OFFICE_FORMATS = Object.freeze(["docx", "xlsx", "pptx", "html", "pdf"]);

const PURPOSE_PATTERNS = Object.freeze({
  docx: /(?:Word|报告|说明稿|文稿|方案|备忘录|制度|合同|工作函|文档)/iu,
  xlsx: /(?:Excel|工作簿|表格|台账|测算|清单|明细|统计|跟踪表|数据表)/iu,
  pptx: /(?:PPT|演示文稿|幻灯片|汇报|路演|答辩|会议展示|领导审阅|评审会)/iu,
  html: /(?:HTML|网页|页面|看板|仪表盘|交互|浏览器|门户|在线展示)/iu,
  pdf: /(?:PDF|定稿|签发|归档|打印|对外发布|盖章|留档|发布版|正式版)/iu,
  csv: /(?:CSV|数据交换|批量导入|批量导出|原始数据|系统导入)/iu,
  json: /(?:JSON|接口|API|配置|机器读取|结构化数据)/iu,
  yaml: /(?:YAML|配置|部署|流水线)/iu,
  md: /(?:Markdown|README|开发文档|知识库|Issue)/iu,
  txt: /(?:TXT|纯文本|日志|逐行导入)/iu,
  zip: /(?:ZIP|压缩包|归档包|交付包)/iu,
  png: /(?:PNG|图片|海报|长图|截图)/iu,
  jpg: /(?:JPG|图片|海报|照片)/iu,
  jpeg: /(?:JPEG|图片|海报|照片)/iu,
});

function value(row, key) {
  return String(row?.[key] ?? "").trim();
}

function hashSeed(seed = "") {
  let hash = 0;
  for (const character of String(seed)) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return hash;
}

export function buildFormatCoverageAssignments(count, { seed = "" } = {}) {
  const total = Number(count);
  if (!Number.isInteger(total) || total < 1) throw new Error("Format coverage planning requires a positive integer count.");
  const assignments = Array.from({ length: total }, () => null);
  if (total < CORE_OFFICE_FORMATS.length) return assignments;
  const offset = hashSeed(seed) % CORE_OFFICE_FORMATS.length;
  for (let index = 0; index < CORE_OFFICE_FORMATS.length; index += 1) {
    assignments[index] = CORE_OFFICE_FORMATS[(index + offset) % CORE_OFFICE_FORMATS.length];
  }
  return assignments;
}

export function evaluateProductFormatPurpose(row) {
  const analysis = analyzeProductFormat(value(row, "产物格式"));
  const narrative = `${value(row, "题目")}\n${value(row, "产物内容")}`;
  const findings = [];
  if (!analysis.canonical || analysis.unknown.length || !analysis.isCanonical) {
    findings.push({ rule: "product-format-not-canonical", source: analysis.source, unknown: analysis.unknown });
  }
  for (const format of analysis.formats) {
    const pattern = PURPOSE_PATTERNS[format];
    if (pattern && !pattern.test(narrative)) findings.push({ rule: "product-format-purpose-missing", format });
  }
  return { analysis, findings };
}

export function evaluateProductFormatBatch(rows = []) {
  const findings = [];
  const combinations = new Map();
  const prevalence = new Map();
  const rowResults = rows.map((row, index) => {
    const result = evaluateProductFormatPurpose(row);
    const uid = value(row, "UID") || `row-${index + 1}`;
    for (const finding of result.findings) findings.push({ uid, ...finding });
    const combination = result.analysis.canonical;
    if (combination) combinations.set(combination, (combinations.get(combination) ?? 0) + 1);
    for (const format of result.analysis.formats) prevalence.set(format, (prevalence.get(format) ?? 0) + 1);
    return { uid, ...result };
  });
  const count = rows.length;
  if (count >= CORE_OFFICE_FORMATS.length) {
    for (const format of CORE_OFFICE_FORMATS) {
      if (!prevalence.get(format)) findings.push({ rule: "batch-core-office-format-missing", format });
    }
  }
  if (count >= 10) {
    const minimumUniqueCombinations = Math.min(5, Math.ceil(Math.sqrt(count)));
    if (combinations.size < minimumUniqueCombinations) {
      findings.push({ rule: "batch-product-combination-variety-low", expectedMinimum: minimumUniqueCombinations, actual: combinations.size });
    }
    for (const [combination, frequency] of combinations) {
      const share = frequency / count;
      if (share > 0.4) findings.push({ rule: "batch-product-combination-dominant", combination, frequency, share: Number(share.toFixed(4)) });
    }
    for (const [format, frequency] of prevalence) {
      const share = frequency / count;
      if (share > 0.75) findings.push({ rule: "batch-product-format-overused", format, frequency, share: Number(share.toFixed(4)) });
    }
  }
  return {
    policyId: PRODUCT_FORMAT_DIVERSITY_POLICY_ID,
    status: findings.length ? "FAIL" : "PASS",
    rowCount: count,
    combinations: Object.fromEntries(combinations),
    prevalence: Object.fromEntries(prevalence),
    rowResults,
    findings,
  };
}
