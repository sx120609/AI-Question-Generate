import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { completeWithLocalCodex } from "../../../../doubao-automation/src/local-codex.mjs";
import { rewriteQuestionWithDeAiApi } from "../../../../build/automation/claude_question_rewriter.mjs";
import {
  buildProductionTrace,
  loadProductionWorkflow,
  recordDeAiRewrite,
  recordFinalRecord,
  saveProductionWorkflow,
} from "../../../../build/automation/production_workflow_state.mjs";

const runDir = path.resolve("outputs/auto_runs/workstation_acceptance_20260718T054801Z_df4628");
const sourceDir = path.join(runDir, "sources");
const qaDir = path.join(runDir, "qa");
const draftDir = path.join(runDir, "drafts");
const workflowPath = path.join(sourceDir, "production_workflow_state.json");
const recordUid = "沈礼_20260718_workstation_preacceptance_01";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const workflow = await loadProductionWorkflow(workflowPath);
const question = workflow.questions[0];
if (question.state !== "SECOND_QA_PASS") throw new Error(`Expected SECOND_QA_PASS, received ${question.state}.`);
const packet = JSON.parse(await fs.readFile(path.join(sourceDir, "production_input_packet.json"), "utf8"));
const sceneSeed = JSON.parse(await fs.readFile(path.join(sourceDir, "scene_card_seed.json"), "utf8"));
const attachmentPlan = question.attachmentPlan;
const sourceRecord = {
  UID: recordUid,
  题目: question.secondQaFullResult.modifiedQuestion,
  任务类型: "L1 探索型",
  一级目录: "科技软件与 AI 工作流",
  二级目录: "企业软件与技术方案",
  三级目录: "设备采购到货预验收",
  任务概括: "依据真实采购材料建立图形工作站到货预验收核对表",
  标注专家工作年限: "5年",
  人类完成时间: "6H",
  相关附件: attachmentPlan.attachments.map((item) => item.name).join("、"),
  附件格式: "html, pdf",
  附件内容: attachmentPlan.attachments.map((item) => `${item.name}：${item.summary}`).join("\n"),
  产物格式: "xlsx",
  产物内容: "一份可下载的图形工作站到货预验收 Excel 核对表，包含项目口径、预计数量与金额复核、空白到货台账、型号级配置核对、差异清单、30天运行记录、付款与保修条件和来源索引。",
  做题关键步骤: [
    "1. 核验五份附件的项目编号、包组、型号和来源边界。",
    "2. 对照招标预计数量与中标公告总量及单价，复核两个包组金额差额。",
    "3. 把820元差额标成报价明细待核线索，并设置正式报价回填字段。",
    "4. 依据三份型号手册建立接口与功能核对项，保留实际配置读数空白。",
    "5. 建立逐台到货台账、差异分级和30天运行记录，缺少证据时自动显示待核。",
    "6. 汇总付款与保修触发条件，生成启动拦截结论和来源索引。",
  ].join("\n"),
  标注专家姓名: "沈礼",
};

const deAi = await rewriteQuestionWithDeAiApi({
  input: {
    uid: recordUid,
    record: sourceRecord,
    sceneCard: sceneSeed.sceneCard,
    knownFactIds: sceneSeed.sceneCard.informationBoundary.knownFactIds,
    avoidQuestions: [packet.inputs.referenceWorkbook.samples[0].question, sourceRecord.题目],
  },
  apiKey: process.env.DE_AI_REWRITE_API_KEY,
  baseUrl: process.env.DE_AI_REWRITE_BASE_URL || "https://api.mugua.link/v1",
  model: process.env.DE_AI_REWRITE_MODEL || "gemini-3.1-pro-preview",
  timeoutMs: 120_000,
  retries: 3,
  contentAttempts: 3,
});
await writeJson(path.join(qaDir, "01_de_ai_rewrite.json"), deAi);
if (!deAi.validation.pass) throw new Error(`De-AI rewrite failed validation: ${JSON.stringify(deAi.validation.findings)}`);

const outputSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: { rule: { type: "string" }, evidence: { type: "string" }, repair: { type: "string" } },
        required: ["rule", "evidence", "repair"],
        additionalProperties: false,
      },
    },
    factsPreserved: { type: "boolean" },
    attachmentsPreserved: { type: "boolean" },
    visibleTextClean: { type: "boolean" },
  },
  required: ["pass", "issues", "factsPreserved", "attachmentsPreserved", "visibleTextClean"],
  additionalProperties: false,
};
const postflight = await completeWithLocalCodex({
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  outputSchema,
  timeoutMs: 360_000,
  systemPrompt: [
    "你是发送给豆包之前的独立可见文本审查员。只审查，不改写，不回答题目。",
    "核对事实与数字、五份附件、Excel 核对表、现场待核状态和多口径计算复杂度。",
    "拦截麻烦、劳烦、烦请、辛苦。拦截不要、不能、不得、不作为、切勿、严禁和不是而是。",
    "拦截分号、每句超过一个顿号、第一步等机械顺序壳、内部错误信息、工具痕迹与异常标点。",
    "任何问题都返回 pass=false，不得兜底放行。",
  ].join("\n"),
  userPrompt: JSON.stringify({ sourceQuestion: sourceRecord.题目, outboundQuestion: deAi.rewrite.question, attachmentNames: attachmentPlan.attachments.map((item) => item.name) }, null, 2),
});
const postflightParsed = JSON.parse(postflight.content);
await writeJson(path.join(qaDir, "06_post_de_ai_preflight_local_codex.json"), {
  kind: "post-de-ai-independent-preflight",
  provider: postflight.provider,
  model: postflight.model,
  completedAt: new Date().toISOString(),
  outboundQuestionHash: sha256(deAi.rewrite.question),
  parsed: postflightParsed,
});
if (!postflightParsed.pass || postflightParsed.issues.length || !postflightParsed.factsPreserved
  || !postflightParsed.attachmentsPreserved || !postflightParsed.visibleTextClean) {
  throw new Error(`Post-de-AI preflight blocked the question: ${JSON.stringify(postflightParsed)}`);
}

recordDeAiRewrite(workflow, 1, deAi);
const finalRecord = { ...sourceRecord, 题目: deAi.rewrite.question };
recordFinalRecord(workflow, 1, { recordUid, finalRecord });
await saveProductionWorkflow(workflowPath, workflow);
await writeJson(path.join(qaDir, "production_trace.json"), buildProductionTrace(workflow));
await writeJson(path.join(draftDir, "01_final_record.json"), finalRecord);
console.log(JSON.stringify({
  state: workflow.questions[0].state,
  deAiPass: deAi.validation.pass,
  selectedAttempt: deAi.selectedAttempt,
  similarity: deAi.validation.similarity,
  postflight: postflightParsed,
  finalQuestion: finalRecord.题目,
}, null, 2));
