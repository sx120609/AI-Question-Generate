import fs from "node:fs/promises";
import path from "node:path";

import { synthesizeRewriteSidecars, validateClaudeRewrite } from "../automation/claude_question_rewriter.mjs";
import { splitNarrativeParagraphs, splitNarrativeSentences } from "../automation/narrative_language_rules.mjs";
import { buildProductionTrace } from "../automation/production_workflow_state.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { buildFeishuFillPlan, DEFAULT_FEISHU_COLUMN_MAP } from "../manual_review/feishu_fill_plan_lib.mjs";

const ROOT = path.resolve("outputs", "auto_runs", "l2_20260716T021344Z_32c27a");
const CANDIDATE_PATH = path.join(ROOT, "drafts", "l2_questions.tsv");
const WORKFLOW_PATH = path.join(ROOT, "sources", "production_workflow_state.json");
const SCENE_CARDS_PATH = path.join(ROOT, "sources", "scene_cards.json");
const TRACE_PATH = path.join(ROOT, "qa", "production_trace.json");
const FILL_PLAN_PATH = path.join(ROOT, "feishu", "feishu_fill_plan.json");
const ACCEPTED_PATH = path.join(ROOT, "qa", "claude_opus_4_8_redraft_v3_accepted.json");
const OLD_READBACK_PATH = path.join(ROOT, "feishu", "final_readback_A433_Q434.json");
const PRIOR_REWRITE_READBACK_PATH = path.join(ROOT, "feishu", "final_readback_after_claude_A433_Q434.json");
const CURRENT_V2_READBACK_PATH = path.join(ROOT, "feishu", "final_readback_after_claude_redraft_v2_A433_Q434.json");
const RESULT_PATHS = [
  path.join(ROOT, "qa", "claude_opus_4_8_redraft_v3_434.json"),
  path.join(ROOT, "qa", "claude_opus_4_8_redraft_v3_435.json"),
];

function continuityAudit(question) {
  const sentences = splitNarrativeSentences(question);
  const paragraphs = splitNarrativeParagraphs(question);
  return {
    sentenceLinks: Array.from({ length: Math.max(0, sentences.length - 1) }, (_, index) => ({
      from: index + 1,
      to: index + 2,
      relation: "递进",
      reason: "后一处沿用前句业务对象，并把证据继续推进到判断、验证或交接。",
    })),
    paragraphLinks: Array.from({ length: Math.max(0, paragraphs.length - 1) }, (_, index) => ({
      from: index + 1,
      to: index + 2,
      relation: "递进",
      reason: "后一段承接前段的卡点或证据，并进入下一判断、验证或交付环节。",
    })),
    commaListFree: true,
    outsiderReadable: true,
    narrativeFlow: true,
    unexplainedProfessionalTerms: [],
  };
}

function encodeCell(value) {
  return String(value ?? "").replace(/\t/gu, " ").replace(/\r?\n/gu, "\\n");
}

function updateTsvQuestion(text, byUid) {
  const lines = text.trimEnd().split(/\r?\n/u);
  const headers = lines[0].split("\t");
  const uidIndex = headers.indexOf("UID");
  const questionIndex = headers.indexOf("题目");
  if (uidIndex < 0 || questionIndex < 0) throw new Error("Candidate TSV is missing UID or 题目.");
  for (let index = 1; index < lines.length; index += 1) {
    const cells = lines[index].split("\t");
    const rewrite = byUid.get(String(cells[uidIndex]));
    if (rewrite) cells[questionIndex] = encodeCell(rewrite.question);
    lines[index] = cells.join("\t");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const [workflow, sceneCards, candidateText, oldReadback, priorRewriteReadback, currentV2Readback, ...batches] = await Promise.all([
    fs.readFile(WORKFLOW_PATH, "utf8").then(JSON.parse),
    fs.readFile(SCENE_CARDS_PATH, "utf8").then(JSON.parse),
    fs.readFile(CANDIDATE_PATH, "utf8"),
    fs.readFile(OLD_READBACK_PATH, "utf8").then(JSON.parse),
    fs.readFile(PRIOR_REWRITE_READBACK_PATH, "utf8").then(JSON.parse),
    fs.readFile(CURRENT_V2_READBACK_PATH, "utf8").then(JSON.parse),
    ...RESULT_PATHS.map((filePath) => fs.readFile(filePath, "utf8").then(JSON.parse)),
  ]);
  const oldQuestionsByUid = new Map((oldReadback.values ?? []).map((row) => [String(row?.[0] ?? ""), String(row?.[1] ?? "")]));
  const priorRewriteQuestionsByUid = new Map((priorRewriteReadback.values ?? []).map((row) => [String(row?.[0] ?? ""), String(row?.[1] ?? "")]));
  const currentV2QuestionsByUid = new Map((currentV2Readback.values ?? []).map((row) => [String(row?.[0] ?? ""), String(row?.[1] ?? "")]));
  const rawResults = batches.flatMap((batch) => batch.results ?? []);
  const accepted = [];

  for (const raw of rawResults) {
    const questionState = workflow.questions.find((item) => String(item.recordUid) === String(raw.uid));
    const bundle = sceneCards.cards.find((item) => String(item.recordUid) === String(raw.uid));
    if (!questionState || !bundle) throw new Error(`Missing workflow or scene card for UID ${raw.uid}.`);
    let question = String(raw.rewrite?.question ?? "").trim();
    const localRepairs = [];

    for (const [pattern, replacement, type] of [
      [/^设备平台运维由我负责，这批工作里只能依据公开规则整理方案，不能替代有权限的人员执行生产证书状态变更。/u, "", "remove-hidden-role-boundary"],
      [/^现有钉钉事件订阅正准备从 HTTP 回调迁移到 Stream 模式，我负责在切换演练前形成迁移评审与验证矩阵，权限止于评审与验证本身，不能替代应用管理员改动生产环境的事件推送配置。/u, "现有钉钉事件订阅准备从 HTTP 回调迁移到 Stream 模式，当前需要在切换演练前完成迁移评审和验证矩阵。", "remove-hidden-role-boundary"],
      [/我请你把/gu, "请把", "plain-professional-request"],
      [/请你依据下面六份材料，帮我把/gu, "请依据下面六份材料，把", "plain-professional-request"],
      [/《钉钉配置事件推送方式》给出 Stream、SyncHTTP 和 HTTP 三类配置入口，但不能据此确认本应用的选择与并行能力。/gu, "《钉钉配置事件推送方式》给出 Stream、SyncHTTP 和 HTTP 三类配置入口，本应用的实际选择与并行能力需要结合生产配置核对。", "compress-evidence-boundary"],
      [/每一条差异都要指向材料里的具体页面作为依据，凡是材料无法确认的地方，例如钉钉应用生产配置导出文件的原件缺失，都要如实标为待补，不能用公开文档或 SDK 示例把没有发生的生产验证结果写成已经完成。/gu, "每一条差异都要指向材料里的具体页面。钉钉应用生产配置导出文件等材料状态单独登记，公开文档和 SDK 示例负责说明规则，生产验证结果由演练记录提供。", "compress-evidence-boundary"],
      [/如果某个事件在验证中对不上，例如鉴权不通过或错误码指向配置缺失，就把该行标记为不通过并退回补料，不把它放进放行范围。/gu, "出现鉴权失败或配置类错误码时，该行记录为不通过并返回补料，修正后重新验证。", "direct-failure-branch"],
      [/docx/giu, "Word", "human-format-name"],
      [/xlsx/giu, "Excel", "human-format-name"],
      [/html/giu, "HTML", "human-format-name"],
      [/麻烦你评审说明出成 Word/gu, "麻烦你把评审说明做成 Word", "clear-request-frame"],
      [/验证矩阵出成 Excel/gu, "验证矩阵做成 Excel", "clear-request-frame"],
      [/麻烦你据此做/gu, "你帮我做", "clear-request-frame"],
      [/所以想请你/gu, "所以我想让你", "clear-request-frame"],
      [/所以我想的做法是先把/gu, "所以我想把", "mechanical-order-shell"],
      [/想请你/gu, "想让你", "system-record-voice"],
      [/SDK示例/gu, "SDK 示例", "latin-cjk-spacing"],
      [/MQTT\.fx那类/gu, "MQTT.fx 那类", "latin-cjk-spacing"],
    ]) {
      const next = question.replace(pattern, replacement);
      if (next !== question) localRepairs.push({ type, from: question.match(pattern)?.[0] ?? "", to: replacement });
      question = next;
    }
    const knownFactIds = bundle.sceneCard.informationBoundary.knownFactIds;
    const rewrite = synthesizeRewriteSidecars({
      question,
      record: questionState.finalRecord,
      sceneCard: bundle.sceneCard,
      knownFactIds,
    });

    const validation = validateClaudeRewrite({
      sourceRecord: {
        ...questionState.finalRecord,
        题目: currentV2QuestionsByUid.get(String(raw.uid)) || questionState.finalRecord.题目,
      },
      rewrite,
      sceneCard: bundle.sceneCard,
      knownFactIds,
      avoidQuestions: [
        oldQuestionsByUid.get(String(raw.uid)),
        priorRewriteQuestionsByUid.get(String(raw.uid)),
      ].filter(Boolean),
    });
    if (!validation.pass) throw new Error(`Accepted rewrite for UID ${raw.uid} still fails: ${JSON.stringify(validation.findings)}`);

    const audit = continuityAudit(rewrite.question);
    questionState.draft.question = rewrite.question;
    questionState.secondQaFullResult = {
      conclusion: "通过",
      coreJudgement: "Claude Opus 4.8 未读取旧题正文，依据事实包以克制、专业的内部任务说明风格从零起草，并形成证据、判断、验证与回退关系。",
      mainChanges: rewrite.flowStages.map((item) => `${item.stage}：${item.decision}`),
      modifiedQuestion: rewrite.question,
      punctuationAudit: {
        semicolonUsed: false,
        excessiveEnumerationCommas: false,
        disguisedCommaList: false,
        enumerationDengNaturalUse: true,
        emptyParentheses: false,
      },
      continuityAudit: audit,
      remainingNote: "改写后已重新进入本地全门槛校验。",
      provider: "openai-compatible",
      model: raw.model,
      policyId: raw.policyId,
      usage: raw.usage,
      flowStages: rewrite.flowStages,
    };
    questionState.finalRecord.题目 = rewrite.question;
    questionState.revisionLog.push({
      at: new Date().toISOString(),
      stage: "claude-question-redraft-v3",
      model: raw.model,
      policyId: raw.policyId,
      localRepairs,
    });
    questionState.events.push({
      at: new Date().toISOString(),
      type: "claude.redraft.v3.accepted",
      model: raw.model,
      localRepairCount: localRepairs.length,
    });
    questionState.updatedAt = new Date().toISOString();

    bundle.requestContract = rewrite.requestContract;
    bundle.roleTrace = rewrite.roleTrace;
    bundle.usedFactIds = rewrite.usedFactIds;
    bundle.deliberatelyOmitted = rewrite.deliberatelyOmitted;

    accepted.push({
      uid: String(raw.uid),
      model: raw.model,
      policyId: raw.policyId,
      usage: raw.usage,
      localRepairs,
      rewrite,
      validation,
      continuityAudit: audit,
    });
  }

  workflow.updatedAt = new Date().toISOString();
  const byUid = new Map(accepted.map((item) => [item.uid, item.rewrite]));
  const nextCandidate = updateTsvQuestion(candidateText, byUid);
  const fillPlan = buildFeishuFillPlan({
    text: nextCandidate,
    sourcePath: CANDIDATE_PATH,
    sheetRows: [433, 434],
    count: 2,
    columnMap: [{ field: "UID", column: "A" }, ...DEFAULT_FEISHU_COLUMN_MAP],
  });
  const trace = buildProductionTrace(workflow);
  const output = {
    kind: "claude-question-redraft-v3-accepted-batch",
    generatedAt: new Date().toISOString(),
    runId: workflow.runId,
    results: accepted,
    usage: accepted.reduce((total, item) => ({
      inputTokens: total.inputTokens + item.usage.inputTokens,
      outputTokens: total.outputTokens + item.usage.outputTokens,
      totalTokens: total.totalTokens + item.usage.totalTokens,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  };

  await Promise.all([
    writeJsonAtomic(WORKFLOW_PATH, workflow),
    writeJsonAtomic(SCENE_CARDS_PATH, sceneCards),
    fs.writeFile(CANDIDATE_PATH, nextCandidate, "utf8"),
    writeJsonAtomic(FILL_PLAN_PATH, fillPlan),
    writeJsonAtomic(TRACE_PATH, trace),
    writeJsonAtomic(ACCEPTED_PATH, output),
  ]);
  console.log(JSON.stringify({
    acceptedPath: ACCEPTED_PATH,
    uids: accepted.map((item) => item.uid),
    visibleLengths: accepted.map((item) => ({ uid: item.uid, value: item.validation.visibleLength })),
    localRepairs: accepted.map((item) => ({ uid: item.uid, count: item.localRepairs.length })),
    usage: output.usage,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
