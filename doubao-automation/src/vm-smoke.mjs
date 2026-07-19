import { readFile } from "node:fs/promises";
import path from "node:path";

import { cdpEndpoint, listTargets, selectDoubaoChatTarget } from "./cdp.mjs";
import { requestInteractionRewrite, requestPromptPreflight } from "./policy.mjs";

function option(name, fallback = "") {
  const prefix = `--${name}=`;
  const direct = process.argv.slice(2).find((item) => item.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const secretsOption = String(option("secrets", "")).trim();
const port = Number(option("port", "9229"));
const secrets = secretsOption
  ? JSON.parse((await readFile(path.resolve(secretsOption), "utf8")).replace(/^\uFEFF/u, ""))
  : {};
const rewriteApiKey = String(secrets.muguaApiKey ?? process.env.DE_AI_REWRITE_API_KEY ?? "").trim();
const rewriteBaseUrl = String(secrets.muguaBaseUrl ?? process.env.DE_AI_REWRITE_BASE_URL ?? "").trim();
const rewriteModel = String(secrets.muguaModel ?? process.env.DE_AI_REWRITE_MODEL ?? "").trim();
if (!rewriteApiKey) throw new Error("DE_AI_REWRITE_API_KEY is missing; development packages do not bundle it.");
if (!rewriteBaseUrl) throw new Error("DE_AI_REWRITE_BASE_URL is missing; development packages do not bundle it.");
if (!rewriteModel) throw new Error("DE_AI_REWRITE_MODEL is missing; development packages do not bundle it.");
process.env.DE_AI_REWRITE_API_KEY = rewriteApiKey;

const previousPrompt = "我先整理现有培训排期，标出时间冲突和缺失记录。";
const source = "我看到上一版已经发现两场培训重叠，你接着核对冲突时段和原始排期记录。";

const mugua = await requestInteractionRewrite({
  job: { taskGoal: "核对公司内部培训排期与来源记录" },
  policy: {
    type: "openai-compatible",
    apiKeyEnv: "DE_AI_REWRITE_API_KEY",
    baseUrl: rewriteBaseUrl,
    model: rewriteModel,
    temperature: 0.55,
    timeoutMs: 180_000,
  },
  prompt: source,
  recentPrompts: [previousPrompt],
  roundNumber: 2,
  retrySchedule: { quickRetryDelaysMs: [1_000], slowRetryDelaysMs: [] },
});

const codex = await requestPromptPreflight({
  conversationContext: {
    previousPrompt,
    previousResponse: "初步发现两场培训时间重叠，但还缺原始排期记录。",
    recentPrompts: [previousPrompt],
  },
  job: { taskGoal: "核对公司内部培训排期与来源记录" },
  policy: {
    type: "local-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    timeoutMs: 180_000,
  },
  prompt: mugua.prompt,
  sourcePrompt: source,
  roundNumber: 2,
  retrySchedule: { quickRetryDelaysMs: [1_000], slowRetryDelaysMs: [] },
});

let doubao = { connected: false, reason: "CDP_NOT_RUNNING" };
try {
  const endpoint = cdpEndpoint({ port });
  const targets = await listTargets(endpoint);
  const target = selectDoubaoChatTarget(targets);
  doubao = {
    connected: true,
    target: { id: target.id, title: target.title, type: target.type, url: target.url },
  };
} catch (error) {
  doubao = { connected: false, reason: String(error.message ?? error).slice(0, 300) };
}

process.stdout.write(`${JSON.stringify({
  localCodex: {
    model: codex.model,
    pass: codex.pass,
    provider: codex.provider,
  },
  mugua: {
    changed: mugua.changed,
    model: mugua.model,
    pass: mugua.pass,
    preservationPass: mugua.preservation.pass,
  },
  doubao,
  pass: codex.pass && mugua.pass,
}, null, 2)}\n`);
