const DEFAULT_CANDIDATE_FIELDS = ["题目", "任务概括", "产物内容"];
const DEFAULT_SOURCE_FIELDS = ["题目", "任务概括", "附件内容", "产物内容", "相关附件"];

const TIME_MARKERS = [
  "今天", "明天", "次日", "今晚", "本周", "下周", "月底", "月末",
  "周一", "周二", "周三", "周四", "周五", "周六", "周日", "周天",
  "上午", "下午", "晚上", "早会", "会前",
];

function normalize(value = "") {
  return String(value ?? "")
    .replace(/\\n/g, "\n")
    .replace(/[／⁄]/g, "/")
    .replace(/(?<=\d)[,，](?=\d)/g, "")
    .replace(/\s+/g, "");
}

function fieldText(record, fields) {
  return fields.map((field) => record?.[field] ?? "").join("\n");
}

function uniqueMatches(text, pattern, mapper = (match) => match[0]) {
  return [...new Set([...String(text ?? "").matchAll(pattern)].map(mapper).filter(Boolean))];
}

export function extractFactAnchors(record, {
  fields = DEFAULT_CANDIDATE_FIELDS,
} = {}) {
  const text = normalize(fieldText(record, fields));
  const numbers = uniqueMatches(
    text,
    /(?:\d{4}年\d{1,2}月\d{1,2}日|(?:亏损|为负)?-?\d+(?:\.\d+)?(?:%|万元|亿元|元|Wh|kWh|TB|GB|TPS|小时|天|周|月|年|台|块|箱|份|条|家|人|类|个|次|页)?)/giu,
  );
  const quotedClaims = uniqueMatches(
    text,
    /[“"]([^”"\n]{2,48})[”"]/gu,
    (match) => normalize(match[1]),
  );
  const timeMarkers = TIME_MARKERS.filter((marker) => text.includes(marker));
  return { numbers, quotedClaims, timeMarkers };
}

function parseCurrencyAnchor(value) {
  const normalized = normalize(value);
  const semanticNegative = /^(?:亏损|为负)/u.test(normalized);
  const match = normalized.replace(/^(?:亏损|为负)/u, "").match(/^(-?\d+(?:\.\d+)?)(亿元|万元|元)$/u);
  if (!match) return null;
  const scale = match[2] === "亿元" ? 100_000_000 : match[2] === "万元" ? 10_000 : 1;
  const decimals = (match[1].split(".")[1] ?? "").length;
  const signedValue = semanticNegative ? -Math.abs(Number(match[1])) : Number(match[1]);
  return {
    yuan: signedValue * scale,
    // A displayed rounded amount is source-supported when an exact source
    // amount falls inside its ordinary half-unit rounding interval.
    tolerance: 0.5 * (10 ** -decimals) * scale + 1e-6,
  };
}

function sourceCurrencyValues(sourceText) {
  return uniqueMatches(
    normalize(sourceText),
    /-?\d+(?:\.\d+)?(?:亿元|万元|元)/gu,
  ).map(parseCurrencyAnchor).filter(Boolean);
}

function hasEquivalentRoundedCurrency(sourceCurrencies, candidateValue) {
  const candidate = parseCurrencyAnchor(candidateValue);
  if (!candidate) return false;
  return sourceCurrencies.some((source) => Math.abs(source.yuan - candidate.yuan) <= candidate.tolerance);
}

function unsupportedAnchors(sourceText, anchors) {
  const source = normalize(sourceText);
  const sourceCurrencies = sourceCurrencyValues(sourceText);
  return {
    numbers: anchors.numbers.filter((value) => (
      !source.includes(normalize(value))
      && !hasEquivalentRoundedCurrency(sourceCurrencies, value)
    )),
    quotedClaims: anchors.quotedClaims.filter((value) => !source.includes(normalize(value))),
    timeMarkers: anchors.timeMarkers.filter((value) => !source.includes(value)),
  };
}

function applyAllowlist(unsupported, allowed = {}) {
  return Object.fromEntries(Object.entries(unsupported).map(([type, values]) => {
    const accepted = new Set((allowed[type] ?? []).map(normalize));
    return [type, values.filter((value) => !accepted.has(normalize(value)))];
  }));
}

export function auditFactAnchors({
  source,
  candidate,
  sourceFields = DEFAULT_SOURCE_FIELDS,
  candidateFields = DEFAULT_CANDIDATE_FIELDS,
  allowed = {},
} = {}) {
  if (!source || !candidate) throw new Error("auditFactAnchors requires source and candidate records.");
  const sourceText = fieldText(source, sourceFields);
  const candidateAnchors = extractFactAnchors(candidate, { fields: candidateFields });
  const unsupported = applyAllowlist(unsupportedAnchors(sourceText, candidateAnchors), allowed);
  const errors = [
    ...unsupported.numbers.map((value) => ({ type: "number", value })),
    ...unsupported.quotedClaims.map((value) => ({ type: "quoted-claim", value })),
    ...unsupported.timeMarkers.map((value) => ({ type: "time-marker", value })),
  ];
  return {
    ok: errors.length === 0,
    candidateAnchors,
    unsupported,
    errors,
  };
}

export function assertNoUnsupportedFactAnchors({
  source,
  candidate,
  allowed = {},
  uid = candidate?.UID || source?.UID || "record",
} = {}) {
  const report = auditFactAnchors({ source, candidate, allowed });
  if (!report.ok) {
    const details = report.errors.map((item) => `${item.type}:${item.value}`).join(", ");
    throw new Error(`${uid} introduces factual anchors not present in its source record: ${details}`);
  }
  return report;
}
