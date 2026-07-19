import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { runProductionTraceGate } from "../../../../build/automation/production_trace_gate.mjs";
import { runReleaseGate } from "../../../../build/automation/release_gate.mjs";
import { runSceneCardGate } from "../../../../build/automation/scene_card.mjs";

const runDir = path.resolve("outputs/auto_runs/desktop_batch_review_20260718T084338Z_184184");
const sourceDir = path.join(runDir, "sources");
const draftDir = path.join(runDir, "drafts");
const qaDir = path.join(runDir, "qa");
const feishuDir = path.join(runDir, "feishu");
const workflow = JSON.parse(await fs.readFile(path.join(sourceDir, "production_workflow_state.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(runDir, "manifest.json"), "utf8"));
const deAi = JSON.parse(await fs.readFile(path.join(qaDir, "01_de_ai_rewrite_final.json"), "utf8"));
const sceneSeed = JSON.parse(await fs.readFile(path.join(sourceDir, "scene_card_seed.json"), "utf8"));
const tracePath = path.join(qaDir, "production_trace.json");
const trace = JSON.parse(await fs.readFile(tracePath, "utf8"));
const finalRecord = trace.questions[0].finalRecord;
const factLedgerPath = path.join(sourceDir, "fact_ledger.json");
const factLedgerBytes = await fs.readFile(factLedgerPath);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (workflow.questions[0].state !== "COMPLETE") throw new Error("Production workflow is not complete.");
const sceneBundle = {
  kind: "scene-card-bundle",
  protocolId: "situated-requester-v1",
  schemaVersion: 1,
  factLedgerPath,
  factLedgerHash: sha256(factLedgerBytes),
  cards: [{
    recordUid: finalRecord.UID,
    sceneCard: sceneSeed.sceneCard,
    requestContract: deAi.rewrite.requestContract,
    roleTrace: deAi.rewrite.roleTrace,
    usedFactIds: deAi.rewrite.usedFactIds,
    deliberatelyOmitted: deAi.rewrite.deliberatelyOmitted,
  }],
};
const sceneCardPath = path.join(sourceDir, "scene_cards.json");
await writeJson(sceneCardPath, sceneBundle);

const fields = [
  "UID", "题目", "任务类型", "一级目录", "二级目录", "三级目录", "任务概括",
  "标注专家工作年限", "人类完成时间", "相关附件", "附件格式", "附件内容",
  "产物格式", "产物内容", "做题关键步骤", "标注专家姓名",
];
const tsvValue = (value) => String(value ?? "").replace(/\r?\n/gu, "\\n").replace(/\t/gu, " ");
const candidatePath = path.join(draftDir, "l1_questions.tsv");
await fs.writeFile(candidatePath, `${fields.join("\t")}\n${fields.map((field) => tsvValue(finalRecord[field])).join("\t")}\n`, "utf8");

const sheetRow = 999999;
const columnMap = [
  ["UID", "A"], ["题目", "B"], ["任务类型", "C"], ["一级目录", "D"],
  ["二级目录", "E"], ["三级目录", "F"], ["任务概括", "G"],
  ["标注专家工作年限", "H"], ["人类完成时间", "I"], ["相关附件", "J"],
  ["附件格式", "K"], ["附件内容", "L"], ["产物格式", "M"],
  ["产物内容", "N"], ["做题关键步骤", "O"],
];
const fillPlan = {
  version: 1,
  status: "DRY_RUN_ONLY_NO_RESERVED_FEISHU_ROW",
  questionPresentation: "natural-paragraphs-no-blank-lines-v4",
  generatedAt: new Date().toISOString(),
  sourcePath: candidatePath,
  startRow: sheetRow,
  sheetRows: [sheetRow],
  count: 1,
  note: "No Feishu row is reserved. Row 999999 is a non-production dry-run placeholder. Formal submission must reserve a real row and regenerate this plan plus all receipts.",
  columnMap: columnMap.map(([field, column]) => ({ field, column })),
  rows: [{
    dataRow: 2,
    sheetRow,
    title: finalRecord.任务概括,
    updates: columnMap.map(([field, column]) => {
      const value = finalRecord[field];
      return {
        address: `${column}${sheetRow}`,
        column,
        field,
        value,
        chars: [...String(value ?? "")].length,
        hasNewlines: /\n/u.test(String(value ?? "")),
        preview: [...String(value ?? "")].slice(0, 80).join(""),
      };
    }),
  }],
};
const fillPlanPath = path.join(feishuDir, "feishu_fill_plan.json");
await writeJson(fillPlanPath, fillPlan);

const roleReportPath = path.join(feishuDir, "role_consistency_report.json");
const roleReport = await runSceneCardGate({ candidatePath, sceneCardPath, reportPath: roleReportPath });
const processResult = await runProductionTraceGate({
  packetPath: path.join(sourceDir, "production_input_packet.json"),
  tracePath,
  candidatePath,
  fillPlanPath,
  reportPath: path.join(feishuDir, "production_trace_gate_report.json"),
  receiptPath: path.join(feishuDir, "production_trace_gate_receipt.json"),
  attachmentRoot: path.join(runDir, "attachments"),
});
const releaseResult = await runReleaseGate({
  candidatePath,
  baselinePath: manifest.naturalnessBaselinePath,
  naturalnessReportPath: path.join(feishuDir, "naturalness_gate_report.json"),
  sceneCardPath,
  roleConsistencyReportPath: roleReportPath,
  fillPlanPath,
  structureReportPath: path.join(feishuDir, "structure_gate_report.json"),
  structureReceiptPath: path.join(feishuDir, "structure_gate_receipt.json"),
  releaseReceiptPath: path.join(feishuDir, "release_gate_receipt.json"),
  registryPath: manifest.structureRegistryPath,
  policyPath: manifest.structuralDiversityPolicyPath,
});
await writeJson(path.join(feishuDir, "stage3_summary.json"), {
  kind: "l1-stage3-gate-summary",
  generatedAt: new Date().toISOString(),
  workflowState: workflow.questions[0].state,
  finalRecordUid: finalRecord.UID,
  roleConsistency: roleReport.status,
  productionTrace: processResult.report.status,
  release: { ok: releaseResult.ok, phase: releaseResult.phase, status: releaseResult.status },
  feishuWriteAttempted: false,
});
console.log(JSON.stringify({
  roleConsistency: roleReport.status,
  roleErrors: roleReport.errors?.map((item) => item.code) ?? [],
  productionTrace: processResult.report.status,
  processFindings: processResult.report.findings,
  release: { ok: releaseResult.ok, phase: releaseResult.phase, status: releaseResult.status },
  naturalnessFindings: releaseResult.naturalnessReport?.findings ?? [],
  structureFindings: releaseResult.structureReport?.findings ?? [],
}, null, 2));
if (roleReport.status !== "PASS" || processResult.report.status !== "PASS" || !releaseResult.ok) process.exitCode = 1;
