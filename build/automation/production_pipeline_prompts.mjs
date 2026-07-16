import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export const PRODUCTION_PIPELINE_PROMPT_VERSION = "sampled-two-gate-prompts-v3-format-diverse-narrative";
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

function envelope(stage, prompt, bindings = {}) {
  return {
    kind: "l2-production-pipeline-prompt",
    promptVersion: PRODUCTION_PIPELINE_PROMPT_VERSION,
    stage,
    bindings,
    prompt,
  };
}

function referenceFrom(packet, questionIndex) {
  required(packet, "packet");
  if (packet.kind !== "l2-production-input-packet" || packet.status !== "READY") {
    throw new Error("A READY l2-production-input-packet is required.");
  }
  const reference = packet.inputs?.referenceWorkbook?.samples?.find(
    (item) => Number(item.questionIndex) === Number(questionIndex),
  );
  if (!reference) throw new Error(`No sampled reference for question ${questionIndex}.`);
  return reference;
}

export function buildReferenceBreakdownPrompt({ packet, questionIndex } = {}) {
  const reference = referenceFrom(packet, questionIndex);
  return envelope("reference-breakdown", `你是L2题面结构拆解员。这里只能读取抽样行的“题面”和“附件内容（总结概括）”，不得调用或猜测工作簿其他字段。你的任务是提取可迁移的工作流结构，不是复述原题，也不是生成新题。

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
  const reference = referenceFrom(packet, questionIndex);
  required(referenceBreakdown, "referenceBreakdown");
  required(topic, "topic");
  required(researchedAttachments, "researchedAttachments");
  return envelope("attachment-plan", `你是L2真实附件构建员。依据选题和已经完成的结构拆解，从已检索且可核验的候选材料中构建一组新的附件。不得复用抽样题面的附件、链接或具体内容，也不得把未核验的链接写成事实。

具体业务文件必须占整组附件至少80%，政策、法规、解释或行业背景最多占20%，只承担规则和外部约束。具体业务文件不能靠标签自证，必须同时写出明确对象、时间或事件，以及只有这份文件才能提供的具体内容。政策页面、管理规定、指南和解读不得标为具体业务文件。若任务涉及具体对象判断，必须有对象级材料。若任务涉及趋势、波动、阶段复盘或预警，应优先选择连续时间序列，确实不需要时写清理由。附件内容概括只陈述文件提供了什么信息，禁用“用于支持”“为……提供依据”等用途话术。

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
  const reference = referenceFrom(packet, questionIndex);
  for (const [value, label] of [[referenceBreakdown, "referenceBreakdown"], [attachmentPlan, "attachmentPlan"], [factLedger, "factLedger"], [sceneCard, "sceneCard"]]) required(value, label);
  return envelope("question-draft", `你是角色卡中的真实工作委托人。根据事实账本和新附件写一条完整L2题面。只模仿抽样题面的推进方式、任务收束和产物出现逻辑，不复制它的领域、对象、附件、数字、句子或固定产物组合。

题面必须围绕一个主决策或一条主流程展开。已有基础、暴露现象、真实卡点、附件分析和交付应自然递进，所有背景和限制都要进入判断链。每一句都要承接上一句，每一段都要承接上一段，整体读起来要有娓娓道来的推进感。题面要让外行也能听懂，专业词能换成日常说法时直接换，必须保留时随文解释。委托必须直观，使用“帮我”“你给我”“帮忙整理”等真人会说的表达，但系统生成记录不使用“请”。禁止分号和项目符号，一句话最多一个顿号，不能把本来应使用顿号的并列项改用逗号伪装。并列内容优先拆句、使用上位概念或以“等”收束，全文表示列举收束的“等”不少于三处。允许自然分段但不得出现空行。第一句不要总用短句句号截断，标点应服从自然口语和工作消息节奏。

产物不能默认写成Word加Excel。先判断谁会使用交付物、在哪个工作环节使用，再选择真正合适的格式。汇报和演示优先考虑PPT，数据跟踪或测算考虑Excel，需要在线查看或交互时考虑网页，需要签发、打印或归档时可以增加PDF，长篇说明才使用Word。CSV、JSON和Markdown只在数据交换、系统接口或开发文档等真实场景中使用。不得为了批次覆盖硬塞无用途的文件。产物格式只写docx、xlsx、pptx、pdf、html等标签，不写“Word文档（docx）”一类重复说明。

不要为了自然感编造老板催办、临时会议、截止日期、金额、部门冲突、人物对白或情绪。题面中的事实只能来自输入。只输出严格JSON：
{
  "question": "完整题面",
  "mainTask": "一句话主任务",
  "usedFactIds": [],
  "usedAttachmentNames": [],
  "productFormats": "小写扩展名，用英文逗号加空格分隔",
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
  referenceFrom(packet, questionIndex);
  for (const [value, label] of [[candidate, "candidate"], [attachmentPlan, "attachmentPlan"], [referenceBreakdown, "referenceBreakdown"]]) required(value, label);
  const exactQaPrompt = required(packet.inputs?.firstQaPrompt?.text, "packet.inputs.firstQaPrompt.text");
  const result = envelope("first-quality-gate", `【原版第一道质检提示词开始】
${exactQaPrompt}
【原版第一道质检提示词结束】

【待质检题目与附件】
${block({ question: candidate.question, attachments: attachmentPlan.attachments })}

现在严格按照原版提示词规定的格式输出，只返回包含pass和issues的JSON，不附加结构审计或语言意见。`, {
    questionIndex: Number(questionIndex),
    qaPromptHash: packet.inputs.firstQaPrompt.sha256,
  });
  result.preQaPrompt = `你是第一道质检前的结构审计员。该审计只做过程留痕，不决定原版第一道质检的pass。逐项检查唯一主任务、具体对象、具体文件是否占主体、证据链、L2推理链和变量漂移。只输出严格JSON：
{
  "oneSentenceMainTask": "",
  "uniqueMainTask": true,
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
  referenceFrom(packet, questionIndex);
  if (firstQaResult?.pass !== true || !Array.isArray(firstQaResult?.issues) || firstQaResult.issues.length) {
    throw new Error("Second language gate is blocked until the first quality gate returns pass=true and issues=[].");
  }
  required(candidate?.question, "candidate.question");
  required(referenceBreakdown?.referenceProductParagraphLogic, "referenceBreakdown.referenceProductParagraphLogic");
  const exactQaPrompt = required(packet.inputs?.secondQaPrompt?.text, "packet.inputs.secondQaPrompt.text");
  return envelope("second-language-gate", `${exactQaPrompt}

【本次不可改边界】
第一道质检已经通过。不得新增事实、附件、主任务或产物。系统生成记录仍不得使用“请”。题面可以自然分段，但任何两段之间不得出现空白行。一句话最多一个顿号，全文表示列举收束的“等”不少于三处，逗号不得伪装并列清单。每一对相邻句和相邻段都要留下承接审计，未解释的专业词必须清零，最终文字要让外行顺着读懂并保持娓娓道来的推进感。

【抽样题后半段的结构逻辑】
${referenceBreakdown.referenceProductParagraphLogic}

【第一道质检后的完整题面】
${candidate.question}`, {
    questionIndex: Number(questionIndex),
    qaPromptHash: packet.inputs.secondQaPrompt.sha256,
  });
}

export function buildFinalCompilerPrompt({ packet, questionIndex, secondQaResult, attachmentPlan, metadata } = {}) {
  referenceFrom(packet, questionIndex);
  if (!secondQaResult || !["通过", "需语言小修"].includes(secondQaResult.conclusion)) {
    throw new Error("Final compiler is blocked until the second language gate passes.");
  }
  required(secondQaResult.modifiedQuestion, "secondQaResult.modifiedQuestion");
  required(attachmentPlan, "attachmentPlan");
  required(metadata, "metadata");
  return envelope("final-compiler", `你是最终字段编译员。题面已经通过两道质检，必须逐字冻结，不得润色、补写、缩写或改标点。根据输入编译正式表14个字段。附件内容逐个说明文件包含什么信息，不写用途话术，不插入空行。产物格式只写小写扩展名标签（例如docx, xlsx），不写“Word文档（docx）”。

只输出严格JSON：
{
  "finalRecord": {
    "题目": "与修改后题面逐字一致",
    "任务类型": "L2 流程型",
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
  const value = JSON.parse(removeCodeFence(text));
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
  const names = ["第二道质检结论", "核心判断", "主要修改点", "修改后题面", "标点与括号自检", "叙事承接自检", "仍需注意"];
  const conclusion = section(names[0], names.slice(1)).split(/\s/u)[0];
  const modifiedQuestion = section(names[3], names.slice(4));
  const continuityAuditText = removeCodeFence(section(names[5], names.slice(6)));
  let continuityAudit;
  try {
    continuityAudit = JSON.parse(continuityAuditText);
  } catch {
    throw new Error("Second language gate response must include a valid JSON narrative continuity audit.");
  }
  if (!["通过", "需语言小修", "需重写题面", "退回第一道质检"].includes(conclusion) || !modifiedQuestion) {
    throw new Error("Second language gate response does not match the required headed format.");
  }
  return {
    conclusion,
    coreJudgment: section(names[1], names.slice(2)),
    modifications: section(names[2], names.slice(3)),
    modifiedQuestion,
    punctuationAudit: section(names[4], names.slice(5)),
    continuityAudit,
    remainingNote: section(names[6], []),
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
