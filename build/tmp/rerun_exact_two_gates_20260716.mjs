import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { synthesizeRewriteSidecars } from "../automation/claude_question_rewriter.mjs";
import { buildProductionTrace } from "../automation/production_workflow_state.mjs";
import {
  repairCandidateAfterFirstQualityGate,
  runContinuityAuditWithModel,
  runFirstQualityGateWithModel,
  runSecondLanguageGateWithModel,
} from "../automation/two_quality_gate_runner.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { buildFeishuFillPlan, DEFAULT_FEISHU_COLUMN_MAP } from "../manual_review/feishu_fill_plan_lib.mjs";

const ROOT = path.resolve("outputs", "auto_runs", "l2_20260716T021344Z_32c27a");
const PACKET_PATH = path.join(ROOT, "sources", "production_input_packet.json");
const WORKFLOW_PATH = path.join(ROOT, "sources", "production_workflow_state.json");
const SCENE_CARDS_PATH = path.join(ROOT, "sources", "scene_cards.json");
const CANDIDATE_PATH = path.join(ROOT, "drafts", "l2_questions.tsv");
const TRACE_PATH = path.join(ROOT, "qa", "production_trace.json");
const FILL_PLAN_PATH = path.join(ROOT, "feishu", "feishu_fill_plan.json");
const B_ONLY_PLAN_PATH = path.join(ROOT, "feishu", "exact_two_gates_b_only_fill_plan.json");
const ACCEPTED_PATH = path.join(ROOT, "qa", "exact_two_quality_gates_accepted.json");
const FIRST_RAW_DIR = path.join(ROOT, "qa", "quality_gates");
const PRIOR_SECOND_DIR = path.join(ROOT, "qa", "quality_gates_final");
const PRIOR_ACCEPTED_DIR = path.join(ROOT, "qa", "quality_gates_accepted");
const PRIOR_COMPLETED_DIR = path.join(ROOT, "qa", "quality_gates_completed");
const RAW_DIR = path.join(ROOT, "qa", "quality_gates_verified");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function priorFirstPass(packet, questionIndex) {
  const filePath = path.join(FIRST_RAW_DIR, `${questionIndex}_first_quality_gate_attempt_1.json`);
  try {
    const text = await fs.readFile(filePath, "utf8");
    const raw = JSON.parse(text);
    if (raw.parsed?.pass !== true || raw.parsed?.issues?.length) return null;
    const stat = await fs.stat(filePath);
    return {
      ...raw.parsed,
      execution: {
        runnerId: "exact-two-quality-gates-v1",
        provider: "openai-compatible",
        model: raw.response.model,
        sourcePromptPath: packet.inputs.firstQaPrompt.path,
        sourcePromptHash: packet.inputs.firstQaPrompt.sha256,
        renderedPromptHash: raw.renderedPromptHash,
        rawResponsePath: filePath,
        rawResponseHash: sha256(text),
        completedAt: stat.mtime.toISOString(),
        usage: raw.response.usage,
        resumedFromPreservedRawResponse: true,
      },
    };
  } catch {
    return null;
  }
}

async function priorSecondCandidate(questionIndex, fallback) {
  for (const dir of [PRIOR_COMPLETED_DIR, PRIOR_ACCEPTED_DIR, PRIOR_SECOND_DIR]) {
    for (const attempt of [5, 4, 3, 2, 1]) {
      const filePath = path.join(dir, `${questionIndex}_second_language_attempt_${attempt}.json`);
      try {
        const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
        const question = String(raw.parsed?.modifiedQuestion ?? "").trim();
        if (question) return question;
      } catch {
        // Continue to an earlier preserved attempt.
      }
    }
  }
  return fallback;
}

async function priorCompletedSecondAttempt(questionIndex) {
  for (const dir of [PRIOR_COMPLETED_DIR, PRIOR_ACCEPTED_DIR, PRIOR_SECOND_DIR]) {
    for (const attempt of [5, 4, 3, 2, 1]) {
      const filePath = path.join(dir, `${questionIndex}_second_language_attempt_${attempt}.json`);
      try {
        const text = await fs.readFile(filePath, "utf8");
        const raw = JSON.parse(text);
        if (["通过", "需语言小修"].includes(raw.parsed?.conclusion)
          && /可进入最终出题表/u.test(String(raw.parsed?.remainingNote ?? ""))) {
          return { filePath, text, raw };
        }
      } catch {
        // Continue searching preserved attempts.
      }
    }
  }
  return null;
}

async function bindPreservedSecondAttempt({ packet, questionState, preserved, audit }) {
  const attempt = {
    round: 1,
    sourcePromptHash: packet.inputs.secondQaPrompt.sha256,
    renderedPromptHash: preserved.raw.renderedPromptHash,
    response: preserved.raw.response,
    parsed: preserved.raw.parsed,
    preservedAttemptPath: preserved.filePath,
    preservedAttemptHash: sha256(preserved.text),
  };
  const aggregate = {
    schemaVersion: 1,
    kind: "l2-second-language-gate-raw-response",
    runnerId: "exact-two-quality-gates-v1",
    questionIndex: Number(questionState.questionIndex),
    sourcePromptHash: packet.inputs.secondQaPrompt.sha256,
    attempts: [attempt],
    acceptedRound: 1,
    continuityAudit: {
      renderedPromptHash: audit.renderedPromptHash,
      response: audit.response,
      parsed: audit.parsed,
      preservedAuditPath: audit.rawResponsePath,
      preservedAuditHash: audit.rawResponseHash,
    },
  };
  const aggregatePath = path.join(RAW_DIR, `${questionState.questionIndex}_second_language_gate.json`);
  await writeJsonAtomic(aggregatePath, aggregate);
  const aggregateText = await fs.readFile(aggregatePath, "utf8");
  const combinedUsage = [preserved.raw.response.usage, audit.response.usage].reduce((total, usage) => ({
    inputTokens: total.inputTokens + Number(usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + Number(usage?.outputTokens ?? 0),
    totalTokens: total.totalTokens + Number(usage?.totalTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return {
    ...preserved.raw.parsed,
    continuityAudit: audit.parsed,
    execution: {
      runnerId: "exact-two-quality-gates-v1",
      provider: "openai-compatible",
      model: preserved.raw.response.model,
      sourcePromptPath: packet.inputs.secondQaPrompt.path,
      sourcePromptHash: packet.inputs.secondQaPrompt.sha256,
      renderedPromptHash: preserved.raw.renderedPromptHash,
      rawResponsePath: aggregatePath,
      rawResponseHash: sha256(aggregateText),
      completedAt: new Date().toISOString(),
      usage: combinedUsage,
      languageAttempts: 1,
      continuityResponseHash: sha256(audit.response.content),
      resumedFromPreservedRawResponse: true,
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
    note: "Only B is mutable after both exact quality gates; all other columns stay frozen.",
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
  if (packet.inputs.firstQaPrompt.sha256 !== "087cc4ad0246d5108b267961190eb8d619206a673b3536092b90cf4a6124622e") {
    throw new Error("First quality prompt hash does not match the user-supplied file.");
  }
  if (packet.inputs.secondQaPrompt.sha256 !== "ee8b575fe2f65d1f3a50a6375bfa0f81ac1aaf5aea2912df2941d687e6aa8313") {
    throw new Error("Second quality prompt hash does not match the user-supplied file.");
  }
  await fs.rm(RAW_DIR, { recursive: true, force: true });

  const firstResults = [];
  for (const questionState of workflow.questions) {
    const startingQuestion = await priorSecondCandidate(questionState.questionIndex, questionState.finalRecord.题目);
    let candidate = { ...questionState.finalRecord, 题目: startingQuestion, question: startingQuestion };
    const attempts = [];
    const repairs = [];
    let result = await priorFirstPass(packet, questionState.questionIndex);
    if (result) attempts.push(result);
    for (let attempt = result ? 3 : 1; !(result?.pass === true && result.issues.length === 0) && attempt <= 2; attempt += 1) {
      result = await runFirstQualityGateWithModel({
        packet,
        questionIndex: questionState.questionIndex,
        candidate,
        attachmentPlan: questionState.attachmentPlan,
        referenceBreakdown: questionState.referenceBreakdown,
        outDir: RAW_DIR,
        model: "claude-opus-4-8",
        attempt,
      });
      attempts.push(result);
      if (result.pass === true && result.issues.length === 0) break;
      if (attempt === 2) {
        throw new Error(`UID ${questionState.recordUid} failed two first quality gate rounds: ${JSON.stringify(result.issues)}`);
      }
      const repair = await repairCandidateAfterFirstQualityGate({
        questionIndex: questionState.questionIndex,
        candidate,
        attachmentPlan: questionState.attachmentPlan,
        firstQaResult: result,
        outDir: RAW_DIR,
        model: "claude-opus-4-8",
        attempt,
      });
      repairs.push(repair);
      candidate = { ...candidate, 题目: repair.question, question: repair.question };
    }
    firstResults.push({ questionState, result, candidate, attempts, repairs });
  }

  const secondResults = [];
  for (const { questionState, result: firstQaResult, candidate, attempts, repairs } of firstResults) {
    const preserved = await priorCompletedSecondAttempt(questionState.questionIndex);
    let secondQaResult;
    if (preserved) {
      const audit = await runContinuityAuditWithModel({
        questionIndex: questionState.questionIndex,
        question: preserved.raw.parsed.modifiedQuestion,
        outDir: RAW_DIR,
        model: "claude-opus-4-8",
        attempt: "preserved",
      });
      if (!audit.findings.length) {
        secondQaResult = await bindPreservedSecondAttempt({ packet, questionState, preserved, audit });
      }
    }
    secondQaResult ??= await runSecondLanguageGateWithModel({
      packet,
      questionIndex: questionState.questionIndex,
      firstQaResult,
      candidate,
      referenceBreakdown: questionState.referenceBreakdown,
      outDir: RAW_DIR,
      model: "claude-opus-4-8",
    });
    secondResults.push({
      questionState,
      firstQaResult,
      firstQaAttempts: attempts,
      firstQaRepairs: repairs,
      secondQaResult,
    });
  }

  const questionsByUid = new Map();
  const accepted = [];
  workflow.schemaVersion = 4;
  workflow.qualityGatePromptHashes = {
    "first-quality-gate": packet.inputs.firstQaPrompt.sha256,
    "second-language-gate": packet.inputs.secondQaPrompt.sha256,
  };
  for (const { questionState, firstQaResult, firstQaAttempts, firstQaRepairs, secondQaResult } of secondResults) {
    const uid = String(questionState.recordUid);
    const bundle = sceneCards.cards.find((item) => String(item.recordUid) === uid);
    if (!bundle) throw new Error(`Scene card missing for UID ${uid}.`);
    questionState.preQaStructureAudit = { source: "existing-structure-audit", informationalOnly: true };
    questionState.firstQaFullResult = firstQaResult;
    questionState.firstQaAttempts ??= [];
    questionState.firstQaAttempts.push(...firstQaAttempts.map((result) => ({ at: new Date().toISOString(), result })));
    questionState.secondQaFullResult = secondQaResult;
    questionState.secondQaAttempts ??= [];
    questionState.secondQaAttempts.push({ at: new Date().toISOString(), result: secondQaResult });
    questionState.draft.question = secondQaResult.modifiedQuestion;
    questionState.finalRecord.题目 = secondQaResult.modifiedQuestion;
    questionState.state = "COMPLETE";
    questionState.revisionLog.push({
      at: new Date().toISOString(),
      stage: "exact-two-quality-gates",
      firstModel: firstQaResult.execution.model,
      secondModel: secondQaResult.execution.model,
      firstPromptHash: firstQaResult.execution.sourcePromptHash,
      secondPromptHash: secondQaResult.execution.sourcePromptHash,
      firstQaAttemptCount: firstQaAttempts.length,
      firstQaRepairCount: firstQaRepairs.length,
      secondLanguageAttempts: secondQaResult.execution.languageAttempts,
    });
    questionState.events.push({
      at: new Date().toISOString(),
      type: "two-quality-gates.real-pass",
      runnerId: "exact-two-quality-gates-v1",
    });
    questionState.updatedAt = new Date().toISOString();

    const sidecars = synthesizeRewriteSidecars({
      question: secondQaResult.modifiedQuestion,
      record: questionState.finalRecord,
      sceneCard: bundle.sceneCard,
      knownFactIds: bundle.sceneCard.informationBoundary.knownFactIds,
    });
    bundle.requestContract = sidecars.requestContract;
    bundle.roleTrace = sidecars.roleTrace;
    bundle.usedFactIds = sidecars.usedFactIds;
    bundle.deliberatelyOmitted = sidecars.deliberatelyOmitted;
    questionsByUid.set(uid, secondQaResult.modifiedQuestion);
    accepted.push({ uid, firstQaResult, firstQaAttempts, firstQaRepairs, secondQaResult });
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
    kind: "exact-two-quality-gates-accepted-batch",
    generatedAt: new Date().toISOString(),
    runId: workflow.runId,
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
    acceptedPath: ACCEPTED_PATH,
    bOnlyPlanPath: B_ONLY_PLAN_PATH,
    rows: accepted.map((item) => ({
      uid: item.uid,
      firstPass: item.firstQaResult.pass,
      firstAttempts: item.firstQaAttempts.length,
      firstRepairs: item.firstQaRepairs.length,
      secondConclusion: item.secondQaResult.conclusion,
      languageAttempts: item.secondQaResult.execution.languageAttempts,
      questionLength: [...item.secondQaResult.modifiedQuestion.replace(/\s+/gu, "")].length,
      usage: {
        first: item.firstQaResult.execution.usage,
        second: item.secondQaResult.execution.usage,
      },
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
