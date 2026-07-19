import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, writeJsonAtomic } from "./run_context.mjs";
import { resolveProductionProfile } from "./production_profile.mjs";

export const SITUATED_GENERATION_PROMPT_VERSION = "situated-requester-prompts-v1";

const STAGES = new Set(["scene-card", "requester", "field-compiler", "audit"]);

function required(value, label) {
  if (value == null || (typeof value === "string" && !value.trim())) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function jsonBlock(value) {
  return JSON.stringify(value, null, 2);
}

function promptEnvelope(stage, prompt) {
  return {
    kind: "situated-generation-prompt",
    promptVersion: SITUATED_GENERATION_PROMPT_VERSION,
    stage,
    prompt,
  };
}

export function buildSceneCardPrompt({ topic, factLedger, sourceCards = [], recentBatchVoiceSignals = [] } = {}) {
  required(topic, "topic");
  required(factLedger, "factLedger");
  return promptEnvelope("scene-card", `你是“工作现场选角 agent”，不是故事编写者，也不负责写最终题面。根据选题、事实账本和来源卡，建立一个隐藏的请求者角色卡与微型工作现场。

角色卡只决定说话视角、职责、信息权限、真实卡点和交付物用途，不能创造事实。不得补写无来源的公司名、老板催办、会议、截止日期、金额、部门冲突、人物对白或戏剧性经历。年龄、外貌、爱好、成长经历等与任务无关的信息一律不写。沈礼和裴硬是系统标注身份，不是题中人物。

先判断谁最可能实际发起这项工作、他为什么会找一个能干活的助手、他已经知道什么、哪些事超出其权限或知识范围。身份应内化到后续表达中，最终题面不得出现“作为一名……”或人物小传。

输出严格 JSON，结构如下：
{
  "schemaVersion": 1,
  "policyId": "situated-requester-v1",
  "topicId": "与选题一致的稳定ID",
  "personaId": "本题独立且稳定的请求者ID",
  "requester": {
    "functionalRole": "职能岗位",
    "organizationType": "组织类型；无来源时保持泛化",
    "department": "部门；无来源时留空",
    "responsibility": "这件事中实际负责的部分",
    "authorityBoundary": "能决定什么、不能决定什么",
    "recipientRelation": "为何把任务交给当前助手"
  },
  "scene": {
    "workflowStage": "当前工作阶段",
    "trigger": "有事实支撑的触发",
    "currentBlockage": "真正卡住的事情",
    "mainDecision": "唯一主决策",
    "downstreamUse": "结果交给谁、拿去做什么"
  },
  "informationBoundary": {
    "knownFactIds": ["事实账本ID"],
    "availableMaterialIds": ["资料或附件ID"],
    "unknowns": ["角色确实不知道且影响任务的事项"],
    "forbiddenInferences": ["不得由角色补出的内容"]
  },
  "voice": {
    "channel": "飞书私聊、群消息或其他真实渠道",
    "formality": "简洁描述正式程度",
    "domainVocabulary": ["该岗位自然会使用的少量词"],
    "avoidVocabulary": ["超出该岗位或近期整批过度使用的词"]
  },
  "maskTerms": ["用于同作者遮罩检测的行业、组织、产品和角色专名"],
  "evidenceBindings": [{"claim": "角色卡中的事实性描述", "factIds": ["事实ID"]}]
}

选题：
${jsonBlock(topic)}

事实账本：
${jsonBlock(factLedger)}

来源卡：
${jsonBlock(sourceCards)}

同批近期过度使用的声音信号，只用于避开统一作者口吻，不能机械选择相反风格：
${jsonBlock(recentBatchVoiceSignals)}`);
}

export function buildRequesterPrompt({ sceneCard, factLedger, productFormats = "", productionProfile = "l1", candidateCount = 3, recentBatchVoiceSignals = [] } = {}) {
  required(sceneCard, "sceneCard");
  required(factLedger, "factLedger");
  const profile = resolveProductionProfile(productionProfile);
  if (!profile.productFormat.optional) required(productFormats, "productFormats");
  if (!Number.isInteger(candidateCount) || candidateCount < 2 || candidateCount > 6) {
    throw new TypeError("candidateCount must be an integer between 2 and 6.");
  }
  const formatInstruction = String(productFormats).trim()
    ? `用人类名称提出 ${productFormats} 对应的全部交付物。`
    : "不强行指定文件格式；把当前轮次要解决的问题和最终期望内容说清楚即可。";
  return promptEnvelope("requester", `你现在就是角色卡中的实际需求方，不是出题员、审稿人、故事作者或全知叙述者。你正在真实工作渠道里给一个能完成任务的助手发消息。这是一条${profile.label}任务。

只使用事实账本中该角色有权知道的信息。先从角色眼下真正关心或卡住的事情说起，再自然提出委托；不介绍角色卡，不解释世界观，不复述生产规则，不为了“真人感”制造情绪、老板、会议、日期、金额或冲突。未知内容保持未知，但用这个岗位会说的话表达，不写模型免责声明。

分别生成 ${candidateCount} 条完整候选。候选之间应来自不同的注意焦点或信息进入顺序，而不是替换同义词、轮换固定开头或强制套用风格标签。参考正式表人工直通稿的组织方式：让具体岗位说明正在处理的对象和资料链，交代附件或公开来源能证明什么、哪些内部事实仍待补，再落到当前轮次目的和后续用途。采用克制、准确的内部任务说明风格，不通过“咱们、说死、谁也不敢、卡得动不了”等表演型口语制造真人感。题面可以连写，也可以按业务意群自然分段；段间只能使用一个换行符，禁止连续换行形成空白行，不得写成项目符号或编号规格单。必须保留明确委托，不能退化成无主语文件规格；可以根据语境使用“请”“帮我”或工作指令，但任何请求句式都不能成为固定开头。${formatInstruction}

每个候选同时输出不可见的校验 sidecar：
{
  "candidateId": "同一角色卡内稳定且唯一的候选ID",
  "question": "完整原始工作消息，可使用自然段落但不使用项目符号",
  "requestContract": {
    "requestSpan": "从question逐字复制且只出现一次的完整委托片段",
    "action": "从requestSpan逐字复制的请求动作短语，不写语义标签",
    "outputs": [{"format": "docx/xlsx/pptx/html/pdf", "humanName": "题面原词", "purpose": "实际用途"}]
  },
  "roleTrace": {
    "blockageSpan": "从question逐字复制且只出现一次、体现当前卡点的片段",
    "motivationSpan": "从question逐字复制且只出现一次、体现为什么现在处理的片段；无可靠触发时可为空",
    "downstreamUseSpan": "从question逐字复制且只出现一次、体现结果去向的片段"
  },
  "usedFactIds": ["实际落入题面的事实ID"],
  "deliberatelyOmitted": ["角色知道但聊天中无需解释的事实ID"]
}

角色卡：
${jsonBlock(sceneCard)}

事实账本：
${jsonBlock(factLedger)}

同批声音信号：
${jsonBlock(recentBatchVoiceSignals)}`);
}

export function buildFieldCompilerPrompt({ selectedCandidate, sceneCard, factLedger, sourcePackage, productionProfile = "l1", outputColumns = [] } = {}) {
  required(selectedCandidate, "selectedCandidate");
  required(sceneCard, "sceneCard");
  required(factLedger, "factLedger");
  const profile = resolveProductionProfile(productionProfile);
  return promptEnvelope("field-compiler", `你是“${profile.label}字段编译 agent”。输入中的 question 已由真实请求者视角选定并冻结。你只能把它原样放入B列，禁止润色、扩写、缩写、换标点、补请求句或把其他字段的规格说明倒灌回题面。

根据事实账本、来源资料和冻结题面生成其余结构化字段。G/N/O 可以结构化，但不得制造题面中不存在的新事实；关键步骤按真实动作排列。若发现题面与资料矛盾，输出 blocked 和原因，不能自行重写B列。

输出严格 JSON：
{
  "question": "必须与输入question逐字一致",
  "questionHashPreserved": true,
  "blocked": false,
  "blockReasons": [],
  "fields": {"任务概括": "", "产物内容": "", "做题关键步骤": ""}
}

需要编译的列：${jsonBlock(outputColumns)}

冻结候选：
${jsonBlock(selectedCandidate)}

角色卡：
${jsonBlock(sceneCard)}

事实账本：
${jsonBlock(factLedger)}

资料包：
${jsonBlock(sourcePackage ?? {})}`);
}

export function buildOutOfCharacterAuditPrompt({ candidate, sceneCard, factLedger, productFormats = "", productionProfile = "l1", siblingCandidates = [] } = {}) {
  required(candidate, "candidate");
  required(sceneCard, "sceneCard");
  required(factLedger, "factLedger");
  const profile = resolveProductionProfile(productionProfile);
  if (!profile.productFormat.optional) required(productFormats, "productFormats");
  return promptEnvelope("audit", `你是独立的“出戏审核 agent”，不能替作者润色。审核候选是否真的由角色卡中的人说出，而不是统一出题模型的声音。

逐项判定：
1. requestContract 与 roleTrace 中每个非空 span 是否都能在 question 中逐字找到。
2. 请求动作${String(productFormats).trim() ? `和 ${productFormats} 全部交付物` : "、当前轮次目标与最终期望内容"}是否清楚，指定的交付物是否有真实用途。
3. 角色是否说出了超出职责或 knownFactIds 的法规体系、证据分类、数字、日期、引语或内部事实。
4. 是否用“作为一名”自报身份，或把隐藏人物设定、世界观和生产规则写进题面。
5. 是否凭空增加老板催办、临时会议、截止时间、金额、部门争执或戏剧化对白。
6. 删除行业、组织、产品和角色专名后，是否仍与同批候选共享明显的统一作者骨架。
7. 把请求者换成另一个岗位后，正文几乎无需改动是否仍成立；若成立，角色只是贴纸。
8. 某段背景删除后是否完全不影响卡点、请求或结果用途；若是，标为无效世界观。

只输出结构化审核结果，不提供替换文案。任何事实越权、span伪造、角色贴纸或戏剧化添写均为FAIL；同作者风险为REVIEW或FAIL。

候选：
${jsonBlock(candidate)}

角色卡：
${jsonBlock(sceneCard)}

事实账本：
${jsonBlock(factLedger)}

同批其他候选：
${jsonBlock(siblingCandidates)}`);
}

export function buildSituatedPrompt(stage, input) {
  if (!STAGES.has(stage)) throw new TypeError(`Unsupported situated generation stage: ${stage}`);
  if (stage === "scene-card") return buildSceneCardPrompt(input);
  if (stage === "requester") return buildRequesterPrompt(input);
  if (stage === "field-compiler") return buildFieldCompilerPrompt(input);
  return buildOutOfCharacterAuditPrompt(input);
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    return match ? [match[1], match[2]] : [arg.replace(/^--/u, ""), true];
  }));
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.stage || !args.input || !args.out) {
    throw new Error("Usage: node situated_generation.mjs --stage=<scene-card|requester|field-compiler|audit> --input=<json> --out=<json>");
  }
  const input = JSON.parse(await fs.readFile(resolveFromRoot(args.input), "utf8"));
  const result = buildSituatedPrompt(args.stage, input);
  await writeJsonAtomic(resolveFromRoot(args.out), result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
