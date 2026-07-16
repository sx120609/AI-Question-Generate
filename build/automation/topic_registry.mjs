import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AUTO_RUNS_ROOT,
  readJson,
  writeJsonAtomic,
  withLock,
  sanitizeId,
} from "./run_context.mjs";

export const TOPIC_REGISTRY_PATH = path.join(AUTO_RUNS_ROOT, "_topic_registry.json");

const DEFAULT_THRESHOLD = 0.46;
const TOPIC_FINGERPRINT_VERSION = 2;

const REQUIRED_TOPIC_FIELDS = [
  "title",
  "primaryCategory",
  "secondaryCategory",
  "tertiaryCategory",
  "businessScenario",
  "mainDecision",
  "role",
];

const SIMILARITY_WEIGHTS = Object.freeze({
  words: 0.34,
  grams: 0.31,
  categories: 0.17,
  exactTertiary: 0.10,
  exactDecision: 0.08,
});

const CORRUPTED_TEXT_PATTERN = /[?？]{3,}|\uFFFD/u;

const stopWords = new Set([
  "一个",
  "一份",
  "进行",
  "形成",
  "整理",
  "分析",
  "判断",
  "预审",
  "资料",
  "清单",
  "报告",
  "建议",
  "核对",
  "项目",
  "相关",
  "需要",
  "可以",
  "是否",
]);

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateTopicStructure(topic) {
  if (!topic || typeof topic !== "object" || Array.isArray(topic)) {
    throw new TypeError("Invalid topic structure: topic must be an object.");
  }

  const missingFields = REQUIRED_TOPIC_FIELDS.filter((field) =>
    typeof topic[field] !== "string" || !topic[field].trim()
  );
  if (missingFields.length) {
    throw new TypeError(
      `Invalid topic structure: missing or blank required fields: ${missingFields.join(", ")}.`
    );
  }

  const corruptedFields = Object.entries(topic)
    .filter(([, value]) => {
      if (typeof value === "string") return CORRUPTED_TEXT_PATTERN.test(value);
      if (Array.isArray(value)) {
        return value.some((item) =>
          typeof item === "string" && CORRUPTED_TEXT_PATTERN.test(item)
        );
      }
      return false;
    })
    .map(([field]) => field);
  if (corruptedFields.length) {
    throw new TypeError(
      `Invalid topic structure: corrupted text detected in fields: ${corruptedFields.join(", ")}.`
    );
  }

  return topic;
}

function words(value) {
  return normalize(value)
    .split(/\s+/)
    .filter((item) => item.length >= 2 && !stopWords.has(item));
}

function cjkBigrams(value) {
  const compact = String(value ?? "")
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "")
    .toLowerCase();
  const grams = [];
  for (let i = 0; i < compact.length - 1; i += 1) {
    grams.push(compact.slice(i, i + 2));
  }
  return grams;
}

function setFrom(items) {
  return new Set(items.filter(Boolean));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

function fieldText(topic) {
  return [
    topic.title,
    topic.primaryCategory,
    topic.secondaryCategory,
    topic.tertiaryCategory,
    topic.businessScenario,
    topic.mainDecision,
    topic.role,
    topic.artifactSummary,
    topic.attachmentSummary,
    ...(topic.keywords ?? []),
  ].join(" ");
}

export function topicFingerprint(topic) {
  const text = fieldText(topic);
  return {
    version: TOPIC_FINGERPRINT_VERSION,
    words: [...setFrom(words(text))],
    grams: [...setFrom(cjkBigrams(text))],
    categories: [
      topic.primaryCategory,
      topic.secondaryCategory,
      topic.tertiaryCategory,
    ].filter(Boolean),
    artifactFormats: String(topic.artifactFormats ?? "")
      .split(/[,\s，、]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    mainDecision: normalize(topic.mainDecision ?? topic.title ?? ""),
  };
}

export function topicSimilarity(a, b) {
  // Stored v1 fingerprints included artifactFormats in their lexical text.
  // Recompute them so legacy registry entries cannot reintroduce that bias.
  const fa = a.fingerprint?.version === TOPIC_FINGERPRINT_VERSION
    ? a.fingerprint
    : topicFingerprint(a);
  const fb = b.fingerprint?.version === TOPIC_FINGERPRINT_VERSION
    ? b.fingerprint
    : topicFingerprint(b);
  const wordScore = jaccard(setFrom(fa.words), setFrom(fb.words));
  const gramScore = jaccard(setFrom(fa.grams), setFrom(fb.grams));
  const categoryScore = jaccard(setFrom(fa.categories), setFrom(fb.categories));
  const artifactScore = jaccard(setFrom(fa.artifactFormats), setFrom(fb.artifactFormats));
  const exactTertiary =
    a.tertiaryCategory && b.tertiaryCategory && a.tertiaryCategory === b.tertiaryCategory ? 1 : 0;
  const exactDecision =
    fa.mainDecision && fb.mainDecision && fa.mainDecision === fb.mainDecision ? 1 : 0;

  const score =
    wordScore * SIMILARITY_WEIGHTS.words +
    gramScore * SIMILARITY_WEIGHTS.grams +
    categoryScore * SIMILARITY_WEIGHTS.categories +
    exactTertiary * SIMILARITY_WEIGHTS.exactTertiary +
    exactDecision * SIMILARITY_WEIGHTS.exactDecision;

  return {
    score: Number(score.toFixed(4)),
    wordScore: Number(wordScore.toFixed(4)),
    gramScore: Number(gramScore.toFixed(4)),
    categoryScore: Number(categoryScore.toFixed(4)),
    artifactScore: Number(artifactScore.toFixed(4)),
    exactTertiary,
    exactDecision,
  };
}

function activeEntries(registry) {
  return (registry.entries ?? []).filter((entry) =>
    ["reserved", "drafting", "submitted", "qa_loop", "accepted"].includes(entry.status)
  );
}

function shouldIgnoreEntry(entry, { ignoreRunId = "", ignoreTopicId = "" } = {}) {
  // Backward compatibility: ignoreRunId alone retains the historical
  // "ignore this entire run" behavior. Supplying both IDs narrows the ignore
  // to one exact registry entry; ignoreTopicId alone ignores that topic ID.
  if (ignoreRunId && ignoreTopicId) {
    return entry.runId === ignoreRunId && entry.topicId === ignoreTopicId;
  }
  if (ignoreTopicId) return entry.topicId === ignoreTopicId;
  if (ignoreRunId) return entry.runId === ignoreRunId;
  return false;
}

function lockNameForRegistry(registryPath) {
  if (path.resolve(registryPath) === path.resolve(TOPIC_REGISTRY_PATH)) return "topic_registry";
  return `topic_registry_${sanitizeId(path.dirname(registryPath))}`;
}

export async function checkTopicConflict(topic, {
  threshold = DEFAULT_THRESHOLD,
  ignoreRunId = "",
  ignoreTopicId = "",
  registryPath = TOPIC_REGISTRY_PATH,
} = {}) {
  const registry = (await readJson(registryPath, null)) ?? { entries: [] };
  const candidate = { ...topic, fingerprint: topicFingerprint(topic) };
  const comparisons = activeEntries(registry)
    .filter((entry) => !shouldIgnoreEntry(entry, { ignoreRunId, ignoreTopicId }))
    .map((entry) => ({
      entry,
      similarity: topicSimilarity(candidate, entry),
    }))
    .sort((a, b) => b.similarity.score - a.similarity.score);

  const conflict = comparisons.find((item) => item.similarity.score >= threshold);
  return {
    ok: !conflict,
    threshold,
    conflict: conflict
      ? {
          runId: conflict.entry.runId,
          topicId: conflict.entry.topicId,
          title: conflict.entry.title,
          status: conflict.entry.status,
          similarity: conflict.similarity,
        }
      : null,
    nearest: comparisons.slice(0, 5).map((item) => ({
      runId: item.entry.runId,
      topicId: item.entry.topicId,
      title: item.entry.title,
      status: item.entry.status,
      similarity: item.similarity,
    })),
  };
}

export async function registerTopic(topic, {
  runId,
  threshold = DEFAULT_THRESHOLD,
  owner = runId || "codex",
  status = "reserved",
  registryPath = TOPIC_REGISTRY_PATH,
} = {}) {
  if (!runId) throw new Error("registerTopic requires runId.");
  validateTopicStructure(topic);
  const topicId = topic.topicId || `${sanitizeId(runId)}_${Date.now()}`;

  return withLock(lockNameForRegistry(registryPath), { owner, metadata: { runId, topicId } }, async () => {
    const registry = (await readJson(registryPath, null)) ?? {
      version: 1,
      entries: [],
    };
    const runManifest = await readJson(path.join(AUTO_RUNS_ROOT, sanitizeId(runId), "manifest.json"), null);
    const candidate = {
      ...topic,
      topicId,
      runId,
      ...(runManifest?.generatedAnnotator
        ? { generatedAnnotator: runManifest.generatedAnnotator, managedBySystem: true }
        : {}),
      status,
      fingerprint: topicFingerprint(topic),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const comparisons = activeEntries(registry)
      .filter((entry) => !(entry.runId === runId && entry.topicId === topicId))
      .map((entry) => ({
        entry,
        similarity: topicSimilarity(candidate, entry),
      }))
      .sort((a, b) => b.similarity.score - a.similarity.score);

    const conflict = comparisons.find((item) => item.similarity.score >= threshold);
    if (conflict) {
      return {
        ok: false,
        threshold,
        topicId,
        conflict: {
          runId: conflict.entry.runId,
          topicId: conflict.entry.topicId,
          title: conflict.entry.title,
          status: conflict.entry.status,
          similarity: conflict.similarity,
        },
        nearest: comparisons.slice(0, 5).map((item) => ({
          runId: item.entry.runId,
          topicId: item.entry.topicId,
          title: item.entry.title,
          status: item.entry.status,
          similarity: item.similarity,
        })),
      };
    }

    registry.entries.push(candidate);
    registry.updatedAt = new Date().toISOString();
    await writeJsonAtomic(registryPath, registry);
    return {
      ok: true,
      topicId,
      threshold,
      registered: candidate,
      nearest: comparisons.slice(0, 5).map((item) => ({
        runId: item.entry.runId,
        topicId: item.entry.topicId,
        title: item.entry.title,
        status: item.entry.status,
        similarity: item.similarity,
      })),
    };
  });
}

export async function updateTopicStatus(topicId, status, { runId = "", owner = runId || "codex", patch = {} } = {}) {
  return withLock("topic_registry", { owner, metadata: { runId, topicId } }, async () => {
    const registry = await readJson(TOPIC_REGISTRY_PATH);
    if (!registry) throw new Error("Topic registry does not exist.");
    const entry = registry.entries.find((item) => item.topicId === topicId && (!runId || item.runId === runId));
    if (!entry) throw new Error(`Topic entry not found: ${topicId}`);
    Object.assign(entry, patch, { status, updatedAt: new Date().toISOString() });
    registry.updatedAt = new Date().toISOString();
    await writeJsonAtomic(TOPIC_REGISTRY_PATH, registry);
    return entry;
  });
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const topic = args.topicJson
    ? JSON.parse(args.topicJson)
    : {
        title: args.title,
        primaryCategory: args.primary,
        secondaryCategory: args.secondary,
        tertiaryCategory: args.tertiary,
        businessScenario: args.businessScenario ?? args.scenario,
        mainDecision: args.mainDecision,
        role: args.role,
        artifactFormats: args.artifactFormats,
        keywords: args.keywords ? args.keywords.split(",") : [],
      };
  const result = await registerTopic(topic, {
    runId: args.runId,
    threshold: args.threshold ? Number(args.threshold) : DEFAULT_THRESHOLD,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
}
