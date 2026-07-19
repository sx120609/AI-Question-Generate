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

const secretsPath = path.resolve(option("secrets", "runtime-secrets.json"));
const port = Number(option("port", "9229"));
const secrets = JSON.parse((await readFile(secretsPath, "utf8")).replace(/^\uFEFF/u, ""));
if (!String(secrets.muguaApiKey ?? "").trim()) throw new Error("Bundled Mugua API key is missing.");
if (!String(secrets.muguaBaseUrl ?? "").trim()) throw new Error("Bundled Mugua base URL is missing.");
if (!String(secrets.muguaModel ?? "").trim()) throw new Error("Bundled Mugua model is missing.");
process.env.DE_AI_REWRITE_API_KEY = String(secrets.muguaApiKey);

const source = "请继续核对公司内部培训排期中的时间冲突和来源记录。";
const codex = await requestPromptPreflight({
  conversationContext: {
    previousPrompt: "请先整理现有培训排期。",
    previousResponse: "初步发现两场培训时间重叠，但还缺原始排期记录。",
  },
  job: { taskGoal: "核对公司内部培训排期与来源记录" },
  policy: {
    type: "local-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    timeoutMs: 180_000,
  },
  prompt: source,
  sourcePrompt: source,
  roundNumber: 2,
  retrySchedule: { quickRetryDelaysMs: [1_000], slowRetryDelaysMs: [] },
});

const mugua = await requestInteractionRewrite({
  job: { taskGoal: "核对公司内部培训排期与来源记录" },
  policy: {
    type: "openai-compatible",
    apiKeyEnv: "DE_AI_REWRITE_API_KEY",
    baseUrl: secrets.muguaBaseUrl,
    model: secrets.muguaModel,
    temperature: 0.55,
    timeoutMs: 180_000,
  },
  prompt: source,
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
