import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { completeWithLocalCodex } from "../../../../doubao-automation/src/local-codex.mjs";
import { rewriteQuestionWithDeAiApi } from "../../../../build/automation/claude_question_rewriter.mjs";
import {
  buildProductionTrace,
  recordDeAiRewrite,
  recordFinalRecord,
  saveProductionWorkflow,
} from "../../../../build/automation/production_workflow_state.mjs";

const runDir = path.resolve("outputs/auto_runs/desktop_batch_review_20260718T084338Z_184184");
const sourceDir = path.join(runDir, "sources");
const draftDir = path.join(runDir, "drafts");
const qaDir = path.join(runDir, "qa");
const workflowPath = path.join(sourceDir, "production_workflow_state.json");
const recordUid = "裴硬_20260718_desktop_batch_review_01";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
async function localJson({ systemPrompt, userPrompt, outputSchema, label }) {
  const response = await completeWithLocalCodex({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    systemPrompt,
    userPrompt,
    outputSchema,
    timeoutMs: 360_000,
  });
  const parsed = JSON.parse(response.content);
  await writeJson(path.join(qaDir, `${label}_local_codex.json`), {
    kind: "local-codex-stage-response",
    stage: label,
    model: "gpt-5.6-sol",
    provider: "local-codex-cli",
    completedAt: new Date().toISOString(),
    promptHash: sha256(`${systemPrompt}\n\n${userPrompt}`),
    parsed,
  });
  return parsed;
}

const packet = JSON.parse(await fs.readFile(path.join(sourceDir, "production_input_packet.json"), "utf8"));
const factLedger = JSON.parse(await fs.readFile(path.join(sourceDir, "fact_ledger.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "download_manifest.json"), "utf8"));
const sceneSeed = JSON.parse(await fs.readFile(path.join(sourceDir, "scene_card_seed.json"), "utf8"));
const secondGate = JSON.parse(await fs.readFile(path.join(qaDir, "05_second_language_gate_repair_1_local_codex.json"), "utf8"));
const sourceQuestion = secondGate.parsed.modifiedQuestion;
const sceneCard = sceneSeed.sceneCard;

const sourceRecord = {
  UID: recordUid,
  题目: sourceQuestion,
  任务类型: "L1 探索型",
  一级目录: "科技软件与 AI 工作流",
  二级目录: "企业软件与技术方案",
  三级目录: "IT设备采购成交复核",
  任务概括: "复核六包台式计算机公开成交口径并安排首轮人工抽检",
  标注专家工作年限: "5年",
  人类完成时间: "6H",
  相关附件: manifest.items.map((item) => item.name).join("、"),
  附件格式: "html, xls, pdf",
  附件内容: factLedger.materials.map((item) => `${item.name}：${item.text}`).join("\n"),
  产物格式: "xlsx",
  产物内容: "一份可下载的台式计算机成交复核Excel核对表，包含配送计划清洗、操作系统归一、六包金额与价格版本复核、质保期限情景、配置对照、待核清单、两包抽检建议和来源索引。",
  做题关键步骤: [
    "1. 校验十份附件的项目编号、文件格式、页码和哈希。",
    "2. 清洗535条配送计划，复核5889台总量并标记PR单号、系统名称和地址异常。",
    "3. 按六包重算成交金额、预算差额和公告概要总金额冲突。",
    "4. 对照六份技术偏离表与最终成交价，计算价格版本差额和质保期限情景。",
    "5. 汇总六种配置的处理器、内存、存储和显卡证据，区分公开事实与待补记录。",
    "6. 结合金额规模、数量覆盖、价格变动和证据缺口挑选两包进入人工抽检，并建立来源索引。",
  ].join("\n"),
  标注专家姓名: "裴硬",
};

const deAi = await rewriteQuestionWithDeAiApi({
  input: {
    uid: recordUid,
    record: sourceRecord,
    sceneCard,
    knownFactIds: sceneCard.informationBoundary.knownFactIds,
    avoidQuestions: [packet.inputs.referenceWorkbook.samples[0].question, sourceQuestion],
  },
  apiKey: process.env.DE_AI_REWRITE_API_KEY,
  baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
  model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
  timeoutMs: 120_000,
  retries: 3,
  contentAttempts: 3,
});
await writeJson(path.join(qaDir, "01_de_ai_rewrite_retry.json"), deAi);
if (!deAi.validation.pass) throw new Error(`De-AI retry failed validation: ${JSON.stringify(deAi.validation.findings)}`);

const postDeAiGate = await localJson({
  label: "06_post_de_ai_preflight_retry",
  systemPrompt: [
    "你是发送给豆包之前的独立可见文本审查员。只审查，不改写，不回答题目。",
    "核对项目编号、十份附件、535条记录、5889台、六包数量与价格、金额冲突、质保比例、字段异常、待补边界、七个表页和两包人工抽检请求。",
    "逐项确认数字保持。拦截客套请求、边界式教唆表达、分号、每句超过一个顿号、内部错误信息、工具痕迹和奇怪标点。",
    "发现任何问题都返回pass=false。",
  ].join("\n"),
  userPrompt: JSON.stringify({
    sourceQuestion,
    outboundQuestion: deAi.rewrite.question,
    attachmentNames: manifest.items.map((item) => item.name),
    requiredProduct: "可下载的Excel成交复核表",
  }, null, 2),
  outputSchema: object({
    pass: { type: "boolean" },
    issues: { type: "array", items: object({ rule: string, evidence: string, repair: string }) },
    factsPreserved: { type: "boolean" },
    attachmentsPreserved: { type: "boolean" },
    visibleTextClean: { type: "boolean" },
  }),
});
if (!postDeAiGate.pass || postDeAiGate.issues.length || !postDeAiGate.factsPreserved
  || !postDeAiGate.attachmentsPreserved || !postDeAiGate.visibleTextClean) {
  throw new Error(`Post-de-AI preflight blocked retry: ${JSON.stringify(postDeAiGate)}`);
}

let workflow = JSON.parse(await fs.readFile(workflowPath, "utf8"));
recordDeAiRewrite(workflow, 1, deAi);
const finalRecord = { ...sourceRecord, 题目: deAi.rewrite.question };
recordFinalRecord(workflow, 1, { recordUid, finalRecord });
await saveProductionWorkflow(workflowPath, workflow);
await writeJson(path.join(qaDir, "production_trace.json"), buildProductionTrace(workflow));
await writeJson(path.join(draftDir, "01_final_record.json"), finalRecord);

console.log(JSON.stringify({
  state: workflow.questions[0].state,
  deAiPass: deAi.validation.pass,
  model: deAi.model,
  selectedAttempt: deAi.selectedAttempt,
  visibleLength: deAi.validation.visibleLength,
  finalQuestion: finalRecord.题目,
}, null, 2));
