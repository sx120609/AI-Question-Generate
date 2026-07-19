import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPacketForProfile, resolveProductionProfile } from "./production_profile.mjs";
import { LEVEL1_CATEGORY_OPTIONS } from "./production_taxonomy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export const PRODUCTION_PIPELINE_PROMPT_VERSION = "profiled-sampled-two-gate-prompts-v4-source-first-taxonomy";
export const PRODUCTION_PIPELINE_STAGES = Object.freeze([
  "reference-breakdown",
  "attachment-plan",
  "question-draft",
  "first-quality-gate",
  "second-language-gate",
  "final-compiler",
]);

function required(value, label) {
  if (value == null || (typeof value === "string" && !value.trim())) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function block(value) {
  return JSON.stringify(value, null, 2);
}

function envelope(profile, stage, prompt, bindings = {}) {
  return {
    kind: profile.promptKind,
    productionProfile: profile.id,
    promptVersion: PRODUCTION_PIPELINE_PROMPT_VERSION,
    stage,
    bindings,
    prompt,
  };
}

const DOMESTIC_WORK_SCOPE_RULE = `默认用户为国内用户。选题、平台、资料、业务对象和交付内容不得涉及国外平台，也不得涉及国内敏感议题。所有可见内容必须属于真实工作场景并推进证据核对、产物制作、验证或业务判断，不能转成闲聊。若任务包含计算、测算、核算、估算、建模或预测，必须至少同时具备多变量或多维数据、时间序列、约束或情景、数据清洗、口径复核中的两类复杂度；禁止单步四则运算和直接代数代入。命中任一禁区时返回 blocked，不得换题措辞后兜底放行。`;
const SOURCE_FIRST_RULE = `必须先读取并核验真实附件，再从附件正文中抽取具体对象、事件、指标、记录或规则冲突，最后据此生成题目。题目的业务对象、主要任务和事实锚点都要能回到附件正文或明确输入。只有行业相同、标题相关或关键词相近不构成支撑。附件没有出现的公司计划、岗位压力、内部缺口、预算、时限、试点安排和业务状态不得补造。材料无法形成一个真实可解决的工作问题时，直接放弃该候选并重新选材。`;
const LEVEL1_CATEGORY_RULE = `一级目录不是自由生成字段，只能根据附件实际内容从以下飞书下拉选项中原样选择一个：${LEVEL1_CATEGORY_OPTIONS.join("、")}。没有语义匹配项时放弃该题，禁止创造新类目或填写近义词。`;

function referenceFrom(packet, questionIndex) {
  required(packet, "packet");
  const profile = resolveProductionProfile(packet);
  if (!isPacketForProfile(packet, profile)) {
    throw new Error(`A READY ${profile.packetKind} is required.`);
  }
  const reference = packet.inputs?.referenceWorkbook?.samples?.find(
    (item) => Number(item.questionIndex) === Number(questionIndex),
  );
  if (!reference) throw new Error(`No sampled reference for question ${questionIndex}.`);
  return reference;
}

export function buildReferenceBreakdownPrompt({ packet, questionIndex } = {}) {
  const profile = resolveProductionProfile(packet);
  const reference = referenceFrom(packet, questionIndex);
  return envelope(profile, "reference-breakdown", `你是${profile.label}题面结构拆解员。这里只能读取抽样样例的“题面”和“附件内容（总结概括）”，不得调用或猜测其他字段。你的任务是提取可迁移的任务结构，不是复述原题，也不是生成新题。

逐项判断真实业务场景、核心卡点、唯一主任务、附件与判断的配合关系、产物为什么会从工作流里自然出现。明确哪些推进方式可以模仿，以及哪些领域、对象、附件、数字、措辞和产物组合不得复用。

只输出严格JSON：
{
  "businessScene": "",
  "coreBlockage": "",
  "mainTask": "",
  "attachmentSupport": "",
  "deliverableOrigin": "",
  "imitableStructure": "",
  "forbiddenReuse": "",
  "referenceAttachmentStructure": "",
  "referenceProductParagraphLogic": "说明原题后半段如何引出使用者、格式、交付边界和验收，不复制原句"
}

抽样位置：${reference.sheet}!${reference.row}
抽样题面：
${reference.question}

抽样附件内容概括：
${reference.attachmentSummary}`, {
    questionIndex: Number(questionIndex),
    sheet: reference.sheet,
    row: reference.row,
    questionHash: reference.questionHash,
    attachmentSummaryHash: reference.attachmentSummaryHash,
  });
}

export function buildAttachmentPlanPrompt({ packet, questionIndex, referenceBreakdown, topic, researchedAttachments } = {}) {
  const profile = resolveProductionProfile(packet);
  const reference = referenceFrom(packet, questionIndex);
  required(referenceBreakdown, "referenceBreakdown");
  required(topic, "topic");
  required(researchedAttachments, "researchedAttachments");
  const attachmentPolicy = profile.id === "l1"
    ? "本题需要1—3个真实附件，推荐只选1—2个完成当前判断所必需的核心文件。L1硬上限为3个，更多材料应拆成另一道题或等真实缺口出现后再作为后续任务处理。具体业务文件必须占整组附件至少80%，并且至少有一份提供对象级证据。附件标准看真实性、可读性、可追溯性和证据质量，不靠数量制造难度。"
    : "本题至少需要1个真实附件，不设数量上限。具体业务文件必须占整组附件至少80%，政策、法规、解释或行业背景最多占20%，只承担规则和外部约束。具体业务文件不能靠标签自证，必须同时写出明确对象、时间或事件，以及只有这份文件才能提供的具体内容。仅有公开网页或通用规则材料时不得成题，必须补齐真实对象级业务附件或重新选题。";
  return envelope(profile, "attachment-plan", `你是${profile.label}证据与附件规划员。依据选题和已经完成的结构拆解，从已检索且可核验的候选材料中规划新的证据来源。不得复用抽样题面的附件、链接或具体内容，也不得把未核验的链接写成事实。

${DOMESTIC_WORK_SCOPE_RULE}

${SOURCE_FIRST_RULE}
${LEVEL1_CATEGORY_RULE}

${attachmentPolicy} 政策页面、管理规定、指南和解读不得标为具体业务文件。若任务涉及趋势、波动、阶段复盘或预警，应优先选择连续时间序列，确实不需要时写清理由。附件内容概括只陈述文件提供了什么信息，禁用“用于支持”“为……提供依据”等用途话术。

只输出严格JSON：
{
  "mainDecision": "本题唯一主决策",
  "attachments": [{
    "name": "真实文件名",
    "sourceUrl": "已核验来源",
    "format": "pdf/xlsx/html/docx等",
    "classification": "specific-business或rule-background",
    "objectLevel": true,
    "timeAnchor": "",
    "specificityEvidence": {
      "object": "明确机构、公司、项目、资产、产品或其他具体对象",
      "periodOrEvent": "明确年份、月份、季度、批次或具体事件",
      "uniqueContent": "这份文件独有的经营数据、执行记录、审批结果或对象事实"
    },
    "summary": "仅写文件含有什么信息",
    "localPath": "下载到本run附件目录后的相对路径",
    "sha256": "下载文件的SHA-256"
  }],
  "specificBusinessShareRationale": "",
  "timeSeriesRationale": "",
  "objectSupportInQuestion": "若对象级事实由题面脱敏信息提供，写明具体范围；否则留空",
  "newAttachmentSupport": "每份附件分别进入哪个判断环节",
  "newQuestionStructureMapping": "如何借用推进结构而不复制原题"
}

选题：
${block(topic)}

原题结构拆解：
${block(referenceBreakdown)}

已检索候选附件：
${block(researchedAttachments)}

禁止复用的抽样附件概括：
${reference.attachmentSummary}`, {
    questionIndex: Number(questionIndex),
    sheet: reference.sheet,
    row: reference.row,
  });
}

export function buildQuestionDraftPrompt({ packet, questionIndex, referenceBreakdown, attachmentPlan, factLedger, sceneCard, formatRequirement = "" } = {}) {
  const profile = resolveProductionProfile(packet);
  const reference = referenceFrom(packet, questionIndex);
  for (const [value, label] of [[referenceBreakdown, "referenceBreakdown"], [attachmentPlan, "attachmentPlan"], [factLedger, "factLedger"], [sceneCard, "sceneCard"]]) required(value, label);
  const levelRules = profile.id === "l1"
    ? `这是L1探索型题目。可见字符硬范围为${profile.question.hardMinimumVisibleCharacters}—${profile.question.hardMaximumVisibleCharacters}，通常写在${profile.question.recommendedMinimumVisibleCharacters}—${profile.question.recommendedMaximumVisibleCharacters}之间。完成路径应能拆成${profile.keySteps.minimum}—${profile.keySteps.maximum}个关键步骤。附件沿用L2的真实性、可读性、可追溯性和对象级证据标准，数量限定为1—3个并推荐1—2个核心文件，具体业务文件占比至少80%。附件多于3个时拆题或留作后续任务，不能把材料数量当作难度。L2标准不提高L1题面的篇幅、事实密度、流程密度或边界数量。题面不能退化为单一搜索、简单摘抄、文件搬运或只代入数字的计算题。题面主体必须要求核对来源、解释差异、处理证据冲突、复核口径或作出业务判断。导出、下载、改格式、增删列、重命名和检查文件能否打开只能作为附带交付动作。题面只保留理解当前任务所需的少量事实锚点，完整数字明细、公式、字段清单和来源位置留在附件与事实账本中。必须区分可证事实、合理推断和待确认项。多轮交互的第一轮围绕一个当前判断展开，多个核验维度可以共同服务它。未来轮次根据实际回复继续收窄。产物格式可留空，但最终产物内容必须清楚。`
    : "这是L2流程型题目，必须保留完整流程链、对象级证据和既有格式约束。";
  return envelope(profile, "question-draft", `你是角色卡中的真实工作委托人。根据事实账本和新证据规划写一条完整${profile.label}题面。只模仿抽样题面的推进方式、任务收束和产物出现逻辑，不复制它的领域、对象、附件、数字、句子或固定产物组合。

${levelRules}

${DOMESTIC_WORK_SCOPE_RULE}
${SOURCE_FIRST_RULE}
${LEVEL1_CATEGORY_RULE}

题面必须围绕一个主要判断或一条主流程展开。多个核验维度可以共同服务同一个判断，例如一张对比表同时核对功能、权限、留存和证据来源。只有彼此无关的决策目标、独立交付物、未来轮次清单、所有可能风险、完整回滚树和验收规则全集才留在规划侧。已有基础、真实卡点、附件和当前交付进入同一判断链即可。题面优先只选择最能定位任务的事实锚点，数字不逐包、逐行或逐公式抄写，附件数量也不能成为扩写题面的理由。

语言采用克制、准确、普通的内部任务说明风格。委托必须直观，可以根据上下文使用“请整理”“帮我整理”“麻烦你整理”或明确工作指令，不统一套一种请求框架。顿号数量只作可读性建议，不按固定个数退回。“等”只在确实存在未穷举对象时使用，不设最低次数。允许1—3个自然段和段落间空行，不用短句和口头禅表演熟人聊天。使用或省略“你”“我”都不作为自然度指标。与证据边界直接相关的“不要自行推测”“不作为最终决策”等自然表达可以保留。删除“刚传了”“我刚上传了”“这里上传了”“随本消息上传了”及同类上传元话语，也不要换成“这是……材料”“材料包括……”等独立介绍句。附件身份直接嵌入核验、比较、判断或整理任务句，让第一句本身推进工作。题面若说明附件交互，模型侧负责读取、核验和使用，不能把用户写成附件接收方。豆包可见题面不出现运行状态、接口信息、工具痕迹或乱码，业务问题使用差异、疑点、缺失、超限或具体记录状态。

产物不能默认写成Word加Excel。先判断谁会使用交付物、在哪个工作环节使用，再选择真正合适的格式。汇报和演示优先考虑PPT，数据跟踪或测算考虑Excel，需要在线查看或交互时考虑网页，需要签发、打印或归档时可以增加PDF，长篇说明才使用Word。CSV、JSON和Markdown只在数据交换、系统接口或开发文档等真实场景中使用。不得为了批次覆盖硬塞无用途的文件。产物格式只写docx、xlsx、pptx、pdf、html等标签，不写“Word文档（docx）”一类重复说明。

不要为了自然感编造老板催办、临时会议、截止日期、金额、部门冲突、人物对白或情绪。题面中的事实只能来自输入。只输出严格JSON：
{
  "question": "完整题面",
  "mainTask": "一句话主任务",
  "mainRequest": "本轮主要判断或交付目标",
  "subRequest": "共同服务主要判断的核验维度概括，没有则为空字符串",
  "usedFactIds": [],
  "deferredFactIds": ["留给附件分析或后续交互的事实ID"],
  "deferredToLaterRounds": ["本轮不展开的后续方向"],
  "usedAttachmentNames": [],
  "productFormats": "小写扩展名，用英文逗号加空格分隔；L1没有必要指定格式时可为空字符串",
  "deliverableRationale": [{"format": "pptx", "user": "真实使用者", "purpose": "进入哪个工作环节", "whyThisFormat": "为什么该格式比Word或Excel更合适"}],
  "structureMapping": "本题怎样沿用抽样结构但不复用内容",
  "productParagraphMapping": "本题后半段怎样沿用抽样题的收束逻辑"
}

角色卡：
${block(sceneCard)}

本题批次覆盖要求：${formatRequirement || "无指定格式，完全按工作流选择"}

事实账本：
${block(factLedger)}

结构拆解：
${block(referenceBreakdown)}

新附件方案：
${block(attachmentPlan)}

生成节点不得再读取抽样题面原文，只能使用上面的结构拆解，避免无意识复制原题句法。`, {
    questionIndex: Number(questionIndex),
    sheet: reference.sheet,
    row: reference.row,
  });
}

export function buildFirstQualityGatePrompt({ packet, questionIndex, candidate, attachmentPlan, referenceBreakdown } = {}) {
  const profile = resolveProductionProfile(packet);
  referenceFrom(packet, questionIndex);
  for (const [value, label] of [[candidate, "candidate"], [attachmentPlan, "attachmentPlan"], [referenceBreakdown, "referenceBreakdown"]]) required(value, label);
  const exactQaPrompt = required(packet.inputs?.firstQaPrompt?.text, "packet.inputs.firstQaPrompt.text");
  const result = envelope(profile, "first-quality-gate", `【生产范围硬门禁】
${DOMESTIC_WORK_SCOPE_RULE}

【原版第一道质检提示词开始】
${exactQaPrompt}
【原版第一道质检提示词结束】

【待质检题目与附件】
${block({ question: candidate.question, attachments: attachmentPlan.attachments })}

现在严格按照原版提示词规定的格式输出，只返回包含pass和issues的JSON，不附加结构审计或语言意见。`, {
    questionIndex: Number(questionIndex),
    qaPromptHash: packet.inputs.firstQaPrompt.sha256,
  });
  result.preQaPrompt = `你是第一道质检前的结构审计员。该审计只做过程留痕，不决定原版第一道质检的pass。逐项检查主要判断是否清楚、具体对象、证据链、${profile.label}推理链和变量漂移。题目必须先从真实附件正文抽取对象、事件和可解决问题，禁止先编工作场景再找同领域附件。一级目录必须原样选自飞书配置项，并与附件正文的业务对象一致。L1与L2都必须检查至少一个真实附件、具体业务材料占比不低于80%，以及对象级证据是否完整。L1还要检查附件是否控制在1—3个且优先使用1—2个核心文件，多个核验维度是否共同服务一个主要判断，主体是否推进来源、差异、冲突、计算口径或业务判断，以及是否把数字清单或未来流程倾倒进题面。导出、改格式、增删列和检查文件状态只能是附带交付动作。只输出严格JSON：
{
  "oneSentenceMainTask": "",
  "uniqueMainTask": true,
  "mainRequest": "",
  "subRequest": "没有则为空字符串",
  "requestCount": 1,
  "futureScopeDump": false,
  "numericInventoryDump": false,
  "specificObjectDecision": true,
  "specificFilesDominant": true,
  "evidenceChain": "",
  "l2ReasoningChain": "",
  "variableDrift": []
}

输入：
${block({ candidate, referenceBreakdown, attachmentPlan })}`;
  return result;
}

export function buildSecondLanguageGatePrompt({ packet, questionIndex, firstQaResult, candidate, referenceBreakdown } = {}) {
  const profile = resolveProductionProfile(packet);
  referenceFrom(packet, questionIndex);
  if (firstQaResult?.pass !== true || !Array.isArray(firstQaResult?.issues) || firstQaResult.issues.length) {
    throw new Error("Second language gate is blocked until the first quality gate returns pass=true and issues=[].");
  }
  required(candidate?.question, "candidate.question");
  required(referenceBreakdown?.referenceProductParagraphLogic, "referenceBreakdown.referenceProductParagraphLogic");
  const exactQaPrompt = required(packet.inputs?.secondQaPrompt?.text, "packet.inputs.secondQaPrompt.text");
  return envelope(profile, "second-language-gate", `【生产范围硬门禁】
${DOMESTIC_WORK_SCOPE_RULE}

【原版第二道质检提示词开始】
${exactQaPrompt}
【原版第二道质检提示词结束】

【本次执行边界】
第一道质检已经通过。必须完整执行上面的原版第二道质检提示词，不得用其他标点配额、语言规则或本地模板覆盖它。不得新增事实、附件、主任务或产物。

【抽样题后半段的结构逻辑】
${referenceBreakdown.referenceProductParagraphLogic}

【第一道质检后的完整题面】
${candidate.question}`, {
    questionIndex: Number(questionIndex),
    qaPromptHash: packet.inputs.secondQaPrompt.sha256,
  });
}

export function buildFinalCompilerPrompt({ packet, questionIndex, secondQaResult, attachmentPlan, metadata } = {}) {
  const profile = resolveProductionProfile(packet);
  referenceFrom(packet, questionIndex);
  if (!secondQaResult || !["通过", "需语言小修"].includes(secondQaResult.conclusion)) {
    throw new Error("Final compiler is blocked until the second language gate passes.");
  }
  required(secondQaResult.modifiedQuestion, "secondQaResult.modifiedQuestion");
  required(attachmentPlan, "attachmentPlan");
  required(metadata, "metadata");
  return envelope(profile, "final-compiler", `你是最终字段编译员。题面已经通过两道质检，必须逐字冻结，不得润色、补写、缩写或改标点。根据输入编译正式表14个字段。附件内容逐个说明文件包含什么信息，不写用途话术，不插入空行；相关附件、附件格式和附件内容都不得为空或写“无”。产物格式只写小写扩展名标签（例如docx, xlsx），不写“Word文档（docx）”。${profile.productFormat.optional ? "L1没有必要指定格式时，产物格式可以留空，但产物内容不得为空。" : "产物格式不得为空。"}

${SOURCE_FIRST_RULE}
${LEVEL1_CATEGORY_RULE}

${DOMESTIC_WORK_SCOPE_RULE}

只输出严格JSON：
{
  "finalRecord": {
    "题目": "与修改后题面逐字一致",
    "任务类型": "${profile.taskType}",
    "一级目录": "",
    "二级目录": "",
    "三级目录": "",
    "任务概括": "",
    "标注专家工作年限": "",
    "人类完成时间": "",
    "相关附件": "",
    "附件格式": "",
    "附件内容": "",
    "产物格式": "",
    "产物内容": "",
    "做题关键步骤": ""
  }
}

冻结题面：
${secondQaResult.modifiedQuestion}

附件方案：
${block(attachmentPlan)}

题目元数据与产物边界：
${block(metadata)}`, {
    questionIndex: Number(questionIndex),
  });
}

export function buildProductionPipelinePrompt(stage, input) {
  if (!PRODUCTION_PIPELINE_STAGES.includes(stage)) throw new TypeError(`Unsupported production pipeline stage: ${stage}`);
  const builders = {
    "reference-breakdown": buildReferenceBreakdownPrompt,
    "attachment-plan": buildAttachmentPlanPrompt,
    "question-draft": buildQuestionDraftPrompt,
    "first-quality-gate": buildFirstQualityGatePrompt,
    "second-language-gate": buildSecondLanguageGatePrompt,
    "final-compiler": buildFinalCompilerPrompt,
  };
  return builders[stage](input);
}

function removeCodeFence(text) {
  return String(text ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
}

export function parseFirstQualityGateResponse(text) {
  const source = removeCodeFence(text);
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  const json = firstBrace >= 0 && lastBrace > firstBrace ? source.slice(firstBrace, lastBrace + 1) : source;
  const value = JSON.parse(json);
  if (typeof value?.pass !== "boolean" || !Array.isArray(value?.issues)) {
    throw new Error("First quality gate response must be the original {pass, issues} JSON.");
  }
  return { pass: value.pass, issues: value.issues };
}

export function parseSecondLanguageGateResponse(text) {
  const source = String(text ?? "").trim();
  const section = (name, next) => {
    const boundary = next.length ? next.map((item) => `【${item}】`).join("|") : "$";
    const pattern = new RegExp(`【${name}】\\s*([\\s\\S]*?)(?=${boundary})`, "u");
    return source.match(pattern)?.[1]?.trim() ?? "";
  };
  const names = ["第二道质检结论", "核心判断", "主要修改点", "修改后题面", "标点与括号自检", "仍需注意"];
  const conclusion = section(names[0], names.slice(1)).split(/\s/u)[0];
  const modifiedQuestion = section(names[3], names.slice(4));
  if (!["通过", "需语言小修", "需重写题面", "退回第一道质检"].includes(conclusion) || !modifiedQuestion) {
    throw new Error("Second language gate response does not match the required headed format.");
  }
  return {
    conclusion,
    coreJudgment: section(names[1], names.slice(2)),
    modifications: section(names[2], names.slice(3)),
    modifiedQuestion,
    punctuationAudit: section(names[4], names.slice(5)),
    remainingNote: section(names[5], []),
    raw: source,
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    return match ? [match[1], match[2]] : [arg.replace(/^--/u, ""), true];
  }));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.stage || !args.input || !args.out) {
    throw new Error(`Usage: node production_pipeline_prompts.mjs --stage=<${PRODUCTION_PIPELINE_STAGES.join("|")}> --input=<json> --out=<json>`);
  }
  const inputPath = path.isAbsolute(args.input) ? args.input : path.resolve(REPO_ROOT, args.input);
  const outPath = path.isAbsolute(args.out) ? args.out : path.resolve(REPO_ROOT, args.out);
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const result = buildProductionPipelinePrompt(args.stage, input);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
