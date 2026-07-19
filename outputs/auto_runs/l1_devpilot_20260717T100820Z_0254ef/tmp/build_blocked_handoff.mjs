import fs from "node:fs/promises";
import path from "node:path";

import { buildProductionTrace, loadProductionWorkflow } from "../../../../build/automation/production_workflow_state.mjs";
import { submitFeishuSheetPlan } from "../../../../build/automation/feishu_sheet_submit.mjs";

const runDir = path.resolve("outputs/auto_runs/l1_devpilot_20260717T100820Z_0254ef");
const sourceDir = path.join(runDir, "sources");
const qaDir = path.join(runDir, "qa");
const feishuDir = path.join(runDir, "feishu");
const draft = JSON.parse(await fs.readFile(path.join(runDir, "drafts", "01_pre_de_ai.json"), "utf8"));
const workflow = await loadProductionWorkflow(path.join(sourceDir, "production_workflow_state.json"));
const failure = JSON.parse(await fs.readFile(path.join(qaDir, "01_de_ai_failure.json"), "utf8"));

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

let traceBlock = null;
try {
  buildProductionTrace(workflow);
  traceBlock = { blocked: false, unexpected: true };
} catch (error) {
  traceBlock = { blocked: true, message: error.message };
}

const columnMap = [
  ["UID", "A"], ["题目", "B"], ["任务类型", "C"], ["一级目录", "D"],
  ["二级目录", "E"], ["三级目录", "F"], ["任务概括", "G"],
  ["标注专家工作年限", "H"], ["人类完成时间", "I"], ["相关附件", "J"],
  ["附件格式", "K"], ["附件内容", "L"], ["产物格式", "M"],
  ["产物内容", "N"], ["做题关键步骤", "O"],
];
const previewPlanPath = path.join(feishuDir, "blocked_submission_preview_plan.json");
const previewPlan = {
  version: 1,
  status: "UNAUTHORIZED_PREVIEW_ONLY",
  generatedAt: new Date().toISOString(),
  sourcePath: path.join(runDir, "drafts", "01_pre_de_ai.json"),
  startRow: 2,
  sheetRows: [2],
  count: 1,
  note: "This preview exists only to prove that submission rejects a workflow without a passing de-AI rewrite and production receipts. It is not authorized for Feishu writeback.",
  columnMap: columnMap.map(([field, column]) => ({ field, column })),
  rows: [{
    dataRow: 2,
    sheetRow: 2,
    title: draft.sourceRecord.任务概括,
    updates: columnMap.map(([field, column]) => ({
      address: `${column}2`,
      column,
      field,
      value: draft.sourceRecord[field],
    })),
  }],
};
await writeJson(previewPlanPath, previewPlan);

let dryRunBlock = null;
try {
  await submitFeishuSheetPlan({
    planPath: previewPlanPath,
    sheetId: "YhA0Ad",
    outDir: feishuDir,
    apply: false,
    verify: false,
    buildAttachments: false,
  });
  dryRunBlock = { blocked: false, unexpected: true };
} catch (error) {
  dryRunBlock = { blocked: true, message: error.message };
}

const handoff = {
  kind: "l1-development-pilot-handoff",
  runId: workflow.runId,
  generatedAt: new Date().toISOString(),
  overallStatus: "BLOCKED_EXTERNAL_DE_AI_API",
  userRequestedFeishuWrite: false,
  feishuWriteAttempted: false,
  stages: [
    { stage: "isolated-run-and-frozen-input", status: "PASS" },
    { stage: "topic-conflict-check", status: "PASS" },
    { stage: "official-public-source-research", status: "PASS", sourceCount: 9 },
    { stage: "development-codex-generation", status: "PASS" },
    { stage: "first-quality-gate", status: "PASS", provider: "codex-session", model: "gpt-5.6-sol" },
    { stage: "second-language-gate", status: "PASS", provider: "codex-session", model: "gpt-5.6-sol" },
    { stage: "de-ai-rewrite", status: "FAIL", provider: failure.provider, model: failure.model, error: failure.error.message },
    { stage: "final-record-compiler", status: "BLOCKED" },
    { stage: "production-trace-gate", status: traceBlock.blocked ? "BLOCKED_AS_EXPECTED" : "UNEXPECTED_PASS", detail: traceBlock.message ?? "" },
    { stage: "feishu-submit-dry-run", status: dryRunBlock.blocked ? "BLOCKED_AS_EXPECTED" : "UNEXPECTED_PASS", detail: dryRunBlock.message ?? "" },
    { stage: "feishu-apply", status: "NOT_RUN_BY_USER_REQUEST" },
  ],
  diagnostics: {
    rewriteEndpointTcpReachable: true,
    rewriteEndpointMinimalPost60s: "TIMEOUT",
    rewriteEndpointFullPost300s: "TIMEOUT",
    rewriteEndpointRetry60s: "TIMEOUT",
    upstreamModelsEndpoint: "PASS",
    upstreamRequestedModelListed: true,
    upstreamDirectCompletion: "PASS",
    diagnosis: "The dedicated /api/rewrite forwarding layer is the failing dependency; the API key and upstream model are reachable."
  },
  resumeFrom: "SECOND_QA_PASS",
  resumeActions: [
    "Run tmp/run_de_ai_stage2.mjs after the dedicated rewrite endpoint recovers.",
    "Record the passing de-AI result with recordDeAiRewrite, then compile the final record.",
    "Build candidate TSV, final scene-card bundle and production trace.",
    "Run scene-card, naturalness, structure, production-trace and release gates.",
    "Run feishu_sheet_submit.mjs without --apply for a no-write payload dry-run.",
    "Only after explicit approval, add --apply --verify with both release and process receipts."
  ],
  formalSubmissionCommandTemplate: "node build/automation/feishu_sheet_submit.mjs --plan=<run>/feishu/feishu_fill_plan.json --sheet-id=<sheet-id> --release-receipt=<run>/feishu/release_gate_receipt.json --process-receipt=<run>/feishu/production_trace_gate_receipt.json --transport=lark-cli --skip-attachments --apply --verify",
};

await writeJson(path.join(feishuDir, "pilot_handoff.json"), handoff);
console.log(JSON.stringify({ overallStatus: handoff.overallStatus, traceBlock, dryRunBlock, previewPlanPath }, null, 2));
if (!traceBlock.blocked || !dryRunBlock.blocked) process.exitCode = 1;
