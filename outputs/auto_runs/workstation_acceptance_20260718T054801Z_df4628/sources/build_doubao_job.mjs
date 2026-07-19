import fs from "node:fs/promises";
import path from "node:path";

const runDir = path.resolve("outputs/auto_runs/workstation_acceptance_20260718T054801Z_df4628");
const trace = JSON.parse(await fs.readFile(path.join(runDir, "qa", "production_trace.json"), "utf8"));
const record = trace.questions[0].finalRecord;
const attachmentNames = trace.questions[0].attachmentBuild.attachments.map((item) => item.name);
const job = {
  jobId: "workstation-preacceptance-20260718-01",
  attachmentRoot: path.join(runDir, "attachments", "01"),
  initialAttachmentNames: attachmentNames,
  productionEvidence: {
    recordUid: trace.questions[0].recordUid,
    productionTracePath: path.join(runDir, "qa", "production_trace.json"),
    productionTraceGateReceiptPath: path.join(runDir, "feishu", "production_trace_gate_receipt.json"),
    releaseGateReceiptPath: path.join(runDir, "feishu", "release_gate_receipt.json"),
    downloadManifestPath: path.join(runDir, "sources", "download_manifest.json"),
  },
  maxRounds: 6,
  mode: "openai-compatible",
  taskGoal: "完成一份可下载的图形工作站到货预验收Excel核对表，供设备运维和项目交付同事现场逐台回填并形成差异处置清单。",
  successCriteria: [
    "五份真实附件在首轮一次上传并由豆包读回全部文件名。",
    "表格区分公开材料可证事实、金额折算线索和现场待核项。",
    "两个包组的单价、数量和金额复核过程完整，820元只登记为报价明细核对线索。",
    "实际到货数量、序列号、配置读数和验收结果保留空白现场回填。",
    "表格包含型号级核对、差异等级、30天运行节点、付款条件、保修条件和来源索引。",
    "第六轮提供真实可访问的Excel文件或等价在线表格产物节点。",
  ],
  initialPrompt: record.题目,
  responseTimeoutMs: 600000,
  interactionRewrite: {
    type: "openai-compatible",
    baseUrl: "https://api.mugua.link/v1",
    model: "gemini-3.1-pro-preview",
    apiKeyEnv: "DE_AI_REWRITE_API_KEY",
    temperature: 0.55,
    timeoutMs: 180000,
  },
  promptPreflight: {
    type: "local-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    timeoutMs: 360000,
  },
  policy: {
    type: "local-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    timeoutMs: 360000,
  },
  productRequirement: {
    requestedFormats: ["excel"],
    required: true,
    allowEquivalentOnline: true,
    allowUnavailableBestEffort: true,
  },
};
const outPath = path.join(runDir, "doubao", "job.json");
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outPath, initialAttachmentNames: job.initialAttachmentNames, initialPrompt: job.initialPrompt }, null, 2));
