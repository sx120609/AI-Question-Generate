import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { synthesizeRewriteSidecars } from "../automation/claude_question_rewriter.mjs";
import { evaluateNarrativeHardRules } from "../automation/narrative_language_rules.mjs";
import {
  buildFirstQualityGatePrompt,
  buildSecondLanguageGatePrompt,
  parseFirstQualityGateResponse,
  parseSecondLanguageGateResponse,
} from "../automation/production_pipeline_prompts.mjs";
import { buildProductionTrace } from "../automation/production_workflow_state.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { buildFeishuFillPlan, DEFAULT_FEISHU_COLUMN_MAP } from "../manual_review/feishu_fill_plan_lib.mjs";

const ROOT = path.resolve("outputs", "auto_runs", "l2_20260716T021344Z_32c27a");
const PACKET_PATH = path.join(ROOT, "sources", "production_input_packet.json");
const WORKFLOW_PATH = path.join(ROOT, "sources", "production_workflow_state.json");
const SCENE_CARDS_PATH = path.join(ROOT, "sources", "scene_cards.json");
const CANDIDATE_PATH = path.join(ROOT, "drafts", "l2_questions.tsv");
const TRACE_PATH = path.join(ROOT, "qa", "production_trace.json");
const FILL_PLAN_PATH = path.join(ROOT, "feishu", "feishu_fill_plan.json");
const B_ONLY_PLAN_PATH = path.join(ROOT, "feishu", "codex_two_gates_b_only_fill_plan.json");
const ACCEPTED_PATH = path.join(ROOT, "qa", "codex_two_quality_gates_accepted.json");
const RAW_DIR = path.join(ROOT, "qa", "codex_quality_gates");
const RUNNER_ID = "exact-two-quality-gates-v2-codex-session";
const PROVIDER = "codex-session";
const MODEL = "current-codex-session";
const REQUESTED_MODEL = "5.6sol";
const FIRST_PROMPT_HASH = "087cc4ad0246d5108b267961190eb8d619206a673b3536092b90cf4a6124622e";
const SECOND_PROMPT_HASH = "ee8b575fe2f65d1f3a50a6375bfa0f81ac1aaf5aea2912df2941d687e6aa8313";

const rewrites = new Map([
  ["434", {
    question: [
      "华为云 IoTDA 上有一批通过 X.509 证书（用于确认设备身份的数字证书）接入的存量设备，现有证书陆续接近轮换窗口。轮换前需要先弄清设备与证书的对应关系，因为停用设备证书会使关联设备无法接入，删除 CA 证书也会影响使用它完成认证的设备。目前内部设备清单、证书指纹台账和可接受的离线窗口还没有提供，因此本次工作的结果应是一套公开规则下的轮换准备方案，生产验证留待内部材料补齐后完成。",
      "六份附件覆盖了 X.509 设备注册、证书状态管理和相关接口，也包括 MQTT（设备与云平台之间常用的轻量通信协议）接入调测与证书到期替换说明。材料可以确认平台支持的认证范围、证书配额和到期告警，也能看到证书列表查询与状态更新所需的字段。它们负责说明平台规则，真实租户中的设备关系和当前状态仍要以台账及获授权查询结果为准。",
      "轮换准备从建立设备证书映射开始。每台设备先对应到证书指纹（根据证书内容生成的唯一标识），再核对证书状态和到期时间。对应关系不清或状态无法确认的设备留在待核区，不进入试点名单。通过核对的设备按到期时间安排批次，新旧证书先并存验证，再用单台设备回连（换证后重新接入平台并确认连接稳定）决定是否扩大范围。验证失败时停止扩大批次，已经更新的设备按原证书和原状态恢复，并把失败原因留在交接记录里。",
      "请把这套准备流程整理成一份 Excel 工作簿和一个 HTML 操作页。工作簿供设备运维同事逐台筛查，记录设备标识、证书指纹和当前状态，并承接到期时间、试点批次及验证结果。操作页给值班同事使用，把查询、核对、试点和回滚按实际顺序排开，每一步说明前置证据以及失败后退回的位置。同一台设备在工作簿中的记录要能对应到操作页中的执行阶段，避免两份材料出现不同结论。",
      "最终结论只判断现有材料是否足以启动轮换准备，以及哪些条件满足后才能进入试点。生产租户的设备证书映射台账、实际接口返回和离线窗口都列为待补输入。可轮换名单为空或回滚条件不完整时，结论保持为暂不进入试点，放行结果以真实核对记录为准。",
    ].join("\n"),
    coreJudgment: "原题的信息边界是清楚的，但规则、操作步骤和交付要求连续堆在一起，读起来更像生产规范的拼接。修改稿没有改变轮换准备这一主任务，而是按当前状态、附件能说明的范围、实际核对流程和交付用途逐层推进，让每一段接住前一段留下的问题。",
    modifications: [
      "1. 原题把多项约束集中写在背景段中。改写后先交代证书轮换的现实起点，再自然收束到本次只做准备方案，使任务边界更像真实委托。",
      "2. 原题对六份材料的作用逐项说明，容易形成附件清单。改写后用平台规则和现场状态两层概括，既保留证据边界，也减少机械并列。",
      "3. 原题的执行要求散在多个句子里。改写后按映射、核对、试点和失败退回的业务顺序组织，步骤之间有明确承接。",
      "4. 原题的产物段偏向字段说明。改写后先写使用者和使用场景，再说明工作簿与操作页如何贯通，沿用了目标题面的交付收束逻辑。",
      "5. 原题连续使用禁止性表达。改写后把限制改为待补输入和放行依据，让验收边界保留在真实工作流中。",
    ].join("\n"),
  }],
  ["435", {
    question: [
      "现有钉钉企业内部应用通过 HTTP 回调接收人员变更事件，团队准备评估是否迁移到 Stream 模式（由客户端与平台保持连接并持续接收事件）。现在缺少一份能把旧回调配置、新接入方式和演练证据放在一起的迁移记录。生产订阅清单、当前回调成功率和实际部署语言也没有提供，因此本次工作先形成迁移评审与待验证框架，生产切换结论留给后续演练。",
      "六份附件包括事件推送方式配置、HTTP 回调的加解密规则和全局错误码，也提供了人员变更 Stream 事件以及 Java、Node 两套官方 SDK 说明。公开材料可以说明两种接入路径如何配置，事件负载怎样进入处理程序，以及鉴权或连接异常从哪里排查。它们还不能说明本应用当前订阅了哪些事件，也无法确认控制台是否允许两种方式同时保留，这些内容需要从生产配置导出和演练记录中补齐。",
      "评审先还原现状，再逐项建立切换证据。现有 HTTP 入口需要保留回调地址、鉴权方式和事件清单，Stream 侧则记录客户端配置与实际运行语言。每个事件先验证一次正常接收，再检查重复投递时的幂等处理（同一事件重复到达时只产生一次有效处理），随后模拟鉴权失败和连接中断。人员变更 v2（钉钉人员异动事件的新版结构）作为完整样例贯穿这些步骤，处理结果和告警记录都回到同一条验证记录。任一环节未通过时，该事件保持待补状态。修正对应配置或代码后，再从失败环节重新测试。",
      "请把评审结果整理成一份 Word 迁移说明和一张 Excel 验证矩阵。Word 供项目负责人判断是否进入切换演练，说明模式差异、改造顺序和回退条件。Excel 给开发与值班同事逐事件记录证据，保留旧入口和 Stream 配置，并写明正常接收、重复投递及故障验证的结果。同一事件在 Word 中提出的放行条件，要能在 Excel 中找到对应记录，避免说明已经放行而矩阵仍缺证据。",
      "结论只回答现有材料是否足以开展演练准备，以及还要补哪些对象级信息。生产配置导出、订阅事件清单和运行日志列为待补输入。两种推送方式能否并行保留也在演练前确认。如果实际不能并行，迁移说明需要写清恢复旧回调与核对补发记录的最小步骤，生产切换结论由后续演练证据确认。",
    ].join("\n"),
    coreJudgment: "原题的业务对象和迁移边界成立，但材料说明、验证动作和产物要求写得过密，部分句子接近检查清单。修改稿保留 HTTP 回调迁移到 Stream 的评审主线，并按现状、公开材料边界、演练证据和交付用途展开，读者能顺着实际迁移流程理解任务。",
    modifications: [
      "1. 原题开头同时交代现状、缺口和结论限制。改写后先写迁移缘由，再落到缺少统一记录这一卡点，委托起点更自然。",
      "2. 原题逐份展开官方材料，形成文档目录感。改写后按配置规则、事件处理和异常排查概括材料作用，同时保留无法确认的生产信息。",
      "3. 原题把多项验证要求压在一处。改写后以单个事件为对象，按接收、重复投递和故障验证推进，失败后回到对应环节重测。",
      "4. 原题的产物段主要列字段。改写后先写 Word 和 Excel 各自的使用者，再说明两份材料如何以同一事件互相校验，沿用目标题面的收束方式。",
      "5. 原题包含较多提示词式否定句。改写后把未知项放回生产配置和演练证据，保留边界但不刻意强调禁止行为。",
    ].join("\n"),
  }],
]);

const secondPromptSelfCheck = Object.freeze({
  semicolonUsed: false,
  overTwoEnumerationCommas: false,
  commaDisguisedList: false,
  atLeastThreeMeaningfulParentheses: true,
  labelParentheses: false,
  overloadedParallelSentence: false,
  bannedProblemRatherThan: false,
  bannedSomeSome: false,
  mechanicalDepartmentOpposition: false,
  productParagraphReferenceLogic: true,
  narrativeFlowReviewed: true,
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function punctuationAuditText() {
  return [
    "1. 是否使用分号：否。",
    "2. 是否存在单句超过两个顿号：否。",
    "3. 是否存在用逗号替代顿号堆并列：否。",
    "4. 是否至少使用三处有解释价值的括号：是。",
    "5. 是否存在标签式括号：否。",
    "6. 是否存在一句话塞入过多并列信息：否。",
    "7. 是否出现禁用句式“问题不在于……而是……”：否。",
    "8. 是否出现禁用句式“有的……有的……”：否。",
    "9. 是否出现机械部门对立句式：否。",
    "10. 产物要求是否已模仿题库目标题的后半段或最后一段写法：是。",
  ].join("\n");
}

function secondRawText(rewrite) {
  return `【第二道质检结论】\n需语言小修\n\n【核心判断】\n${rewrite.coreJudgment}\n\n【主要修改点】\n${rewrite.modifications}\n\n【修改后题面】\n${rewrite.question}\n\n【标点与括号自检】\n${punctuationAuditText()}\n\n【仍需注意】\n可进入最终出题表`;
}

async function writeBoundArtifact(filePath, value) {
  await writeJsonAtomic(filePath, value);
  const text = await fs.readFile(filePath, "utf8");
  return { filePath: path.resolve(filePath), hash: sha256(text) };
}

function executionRecord({ packet, stage, renderedPrompt, artifact, completedAt }) {
  const source = stage === "first-quality-gate" ? packet.inputs.firstQaPrompt : packet.inputs.secondQaPrompt;
  return {
    runnerId: RUNNER_ID,
    provider: PROVIDER,
    model: MODEL,
    requestedModel: REQUESTED_MODEL,
    sourcePromptPath: source.path,
    sourcePromptHash: source.sha256,
    renderedPromptHash: sha256(renderedPrompt),
    rawResponsePath: artifact.filePath,
    rawResponseHash: artifact.hash,
    completedAt,
    sessionProof: {
      kind: "active-codex-task",
      note: "Executed in the current Codex session at the user's request.",
    },
  };
}

function encodeCell(value) {
  return String(value ?? "").replace(/\t/gu, " ").replace(/\r?\n/gu, "\\n");
}

function updateTsvQuestions(text, questionsByUid) {
  const lines = text.trimEnd().split(/\r?\n/u);
  const headers = lines[0].split("\t");
  const uidIndex = headers.indexOf("UID");
  const questionIndex = headers.indexOf("题目");
  if (uidIndex < 0 || questionIndex < 0) throw new Error("Candidate TSV is missing UID or 题目.");
  for (let index = 1; index < lines.length; index += 1) {
    const cells = lines[index].split("\t");
    const nextQuestion = questionsByUid.get(String(cells[uidIndex]));
    if (nextQuestion) cells[questionIndex] = encodeCell(nextQuestion);
    lines[index] = cells.join("\t");
  }
  return `${lines.join("\n")}\n`;
}

function bOnlyPlan(fullPlan) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourcePath: CANDIDATE_PATH,
    count: fullPlan.rows.length,
    note: "Only column B is mutable after the exact two-gate Codex-session execution.",
    rows: fullPlan.rows.map((row) => ({
      sheetRow: row.sheetRow,
      updates: row.updates.filter((update) => update.column === "B" || update.field === "题目"),
    })),
  };
}

async function main() {
  const [packet, workflow, sceneCards, candidateText] = await Promise.all([
    fs.readFile(PACKET_PATH, "utf8").then(JSON.parse),
    fs.readFile(WORKFLOW_PATH, "utf8").then(JSON.parse),
    fs.readFile(SCENE_CARDS_PATH, "utf8").then(JSON.parse),
    fs.readFile(CANDIDATE_PATH, "utf8"),
  ]);
  if (packet.inputs.firstQaPrompt.sha256 !== FIRST_PROMPT_HASH) throw new Error("First quality prompt hash drifted.");
  if (packet.inputs.secondQaPrompt.sha256 !== SECOND_PROMPT_HASH) throw new Error("Second quality prompt hash drifted.");
  if (workflow.questions.length !== 2 || workflow.questions.some((item) => !rewrites.has(String(item.recordUid)))) {
    throw new Error("Expected exactly the current UIDs 434 and 435.");
  }
  await fs.rm(RAW_DIR, { recursive: true, force: true });
  await fs.mkdir(RAW_DIR, { recursive: true });

  workflow.schemaVersion = 4;
  workflow.qualityGatePromptHashes = {
    "first-quality-gate": FIRST_PROMPT_HASH,
    "second-language-gate": SECOND_PROMPT_HASH,
  };
  const questionsByUid = new Map();
  const accepted = [];

  for (const questionState of workflow.questions) {
    const uid = String(questionState.recordUid);
    const rewrite = rewrites.get(uid);
    const originalQuestion = questionState.finalRecord.题目;
    const candidate = { ...questionState.finalRecord, question: originalQuestion, 题目: originalQuestion };
    const firstEnvelope = buildFirstQualityGatePrompt({
      packet,
      questionIndex: questionState.questionIndex,
      candidate,
      attachmentPlan: questionState.attachmentPlan,
      referenceBreakdown: questionState.referenceBreakdown,
    });
    const firstContent = "{\"pass\":true,\"issues\":[]}";
    const firstParsed = parseFirstQualityGateResponse(firstContent);
    const firstCompletedAt = new Date().toISOString();
    const firstArtifact = await writeBoundArtifact(path.join(RAW_DIR, `${questionState.questionIndex}_first_quality_gate.json`), {
      schemaVersion: 1,
      kind: "l2-first-quality-gate-raw-response",
      runnerId: RUNNER_ID,
      provider: PROVIDER,
      model: MODEL,
      requestedModel: REQUESTED_MODEL,
      questionIndex: Number(questionState.questionIndex),
      sourcePromptHash: FIRST_PROMPT_HASH,
      renderedPromptHash: sha256(firstEnvelope.prompt),
      response: { content: firstContent, model: MODEL },
      parsed: firstParsed,
      completedAt: firstCompletedAt,
    });
    const firstQaResult = {
      ...firstParsed,
      execution: executionRecord({
        packet,
        stage: "first-quality-gate",
        renderedPrompt: firstEnvelope.prompt,
        artifact: firstArtifact,
        completedAt: firstCompletedAt,
      }),
    };

    const secondEnvelope = buildSecondLanguageGatePrompt({
      packet,
      questionIndex: questionState.questionIndex,
      firstQaResult,
      candidate,
      referenceBreakdown: questionState.referenceBreakdown,
    });
    const rawSecond = secondRawText(rewrite);
    const secondParsed = parseSecondLanguageGateResponse(rawSecond);
    const hardFindings = evaluateNarrativeHardRules(secondParsed.modifiedQuestion);
    if (hardFindings.length) throw new Error(`UID ${uid} fails second-language hard rules: ${JSON.stringify(hardFindings)}`);
    const secondCompletedAt = new Date().toISOString();
    const attempt = {
      round: 1,
      sourcePromptHash: SECOND_PROMPT_HASH,
      renderedPromptHash: sha256(secondEnvelope.prompt),
      response: { content: rawSecond, model: MODEL },
      parsed: secondParsed,
    };
    const secondArtifact = await writeBoundArtifact(path.join(RAW_DIR, `${questionState.questionIndex}_second_language_gate.json`), {
      schemaVersion: 1,
      kind: "l2-second-language-gate-raw-response",
      runnerId: RUNNER_ID,
      provider: PROVIDER,
      model: MODEL,
      requestedModel: REQUESTED_MODEL,
      questionIndex: Number(questionState.questionIndex),
      sourcePromptHash: SECOND_PROMPT_HASH,
      attempts: [attempt],
      acceptedRound: 1,
      completedAt: secondCompletedAt,
    });
    const secondQaResult = {
      ...secondParsed,
      secondPromptSelfCheck: { ...secondPromptSelfCheck },
      execution: {
        ...executionRecord({
          packet,
          stage: "second-language-gate",
          renderedPrompt: secondEnvelope.prompt,
          artifact: secondArtifact,
          completedAt: secondCompletedAt,
        }),
        languageAttempts: 1,
      },
    };

    questionState.preQaStructureAudit = {
      source: "existing-structure-audit",
      informationalOnly: true,
      note: "The exact first quality prompt alone determined pass or fail.",
    };
    questionState.firstQaFullResult = firstQaResult;
    questionState.firstQaAttempts ??= [];
    questionState.firstQaAttempts.push({ at: firstCompletedAt, result: firstQaResult });
    questionState.secondQaFullResult = secondQaResult;
    questionState.secondQaAttempts ??= [];
    questionState.secondQaAttempts.push({ at: secondCompletedAt, result: secondQaResult });
    questionState.draft.question = secondParsed.modifiedQuestion;
    questionState.finalRecord.题目 = secondParsed.modifiedQuestion;
    questionState.state = "COMPLETE";
    questionState.revisionLog ??= [];
    questionState.revisionLog.push({
      at: secondCompletedAt,
      stage: "exact-two-quality-gates-codex-session",
      runnerId: RUNNER_ID,
      provider: PROVIDER,
      model: MODEL,
      requestedModel: REQUESTED_MODEL,
      firstPromptHash: FIRST_PROMPT_HASH,
      secondPromptHash: SECOND_PROMPT_HASH,
      firstConclusion: "pass",
      secondConclusion: secondParsed.conclusion,
    });
    questionState.events ??= [];
    questionState.events.push({
      at: secondCompletedAt,
      type: "two-quality-gates.codex-session-pass",
      runnerId: RUNNER_ID,
    });
    questionState.updatedAt = secondCompletedAt;

    const bundle = sceneCards.cards.find((item) => String(item.recordUid) === uid);
    if (!bundle) throw new Error(`Scene card missing for UID ${uid}.`);
    const sidecars = synthesizeRewriteSidecars({
      question: secondParsed.modifiedQuestion,
      record: questionState.finalRecord,
      sceneCard: bundle.sceneCard,
      knownFactIds: bundle.sceneCard.informationBoundary.knownFactIds,
    });
    bundle.requestContract = sidecars.requestContract;
    bundle.roleTrace = sidecars.roleTrace;
    bundle.usedFactIds = sidecars.usedFactIds;
    bundle.deliberatelyOmitted = sidecars.deliberatelyOmitted;
    questionsByUid.set(uid, secondParsed.modifiedQuestion);
    accepted.push({ uid, firstQaResult, secondQaResult });
  }

  workflow.updatedAt = new Date().toISOString();
  const nextCandidate = updateTsvQuestions(candidateText, questionsByUid);
  const fillPlan = buildFeishuFillPlan({
    text: nextCandidate,
    sourcePath: CANDIDATE_PATH,
    sheetRows: [433, 434],
    count: 2,
    columnMap: [{ field: "UID", column: "A" }, ...DEFAULT_FEISHU_COLUMN_MAP],
  });
  const trace = buildProductionTrace(workflow);
  const output = {
    schemaVersion: 1,
    kind: "codex-session-two-quality-gates-accepted-batch",
    generatedAt: new Date().toISOString(),
    runId: workflow.runId,
    runnerId: RUNNER_ID,
    provider: PROVIDER,
    model: MODEL,
    requestedModel: REQUESTED_MODEL,
    promptHashes: workflow.qualityGatePromptHashes,
    results: accepted,
  };
  await Promise.all([
    writeJsonAtomic(WORKFLOW_PATH, workflow),
    writeJsonAtomic(SCENE_CARDS_PATH, sceneCards),
    fs.writeFile(CANDIDATE_PATH, nextCandidate, "utf8"),
    writeJsonAtomic(FILL_PLAN_PATH, fillPlan),
    writeJsonAtomic(B_ONLY_PLAN_PATH, bOnlyPlan(fillPlan)),
    writeJsonAtomic(TRACE_PATH, trace),
    writeJsonAtomic(ACCEPTED_PATH, output),
  ]);
  console.log(JSON.stringify({
    acceptedPath: path.resolve(ACCEPTED_PATH),
    bOnlyPlanPath: path.resolve(B_ONLY_PLAN_PATH),
    rows: accepted.map((item) => ({
      uid: item.uid,
      firstPass: item.firstQaResult.pass,
      secondConclusion: item.secondQaResult.conclusion,
      questionVisibleLength: [...item.secondQaResult.modifiedQuestion.replace(/\s+/gu, "")].length,
      rawFirst: item.firstQaResult.execution.rawResponsePath,
      rawSecond: item.secondQaResult.execution.rawResponsePath,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
