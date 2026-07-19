import fs from "node:fs/promises";
import path from "node:path";

const runDir = path.resolve("outputs/auto_runs/desktop_batch_review_20260718T084338Z_184184");
const trace = JSON.parse(await fs.readFile(path.join(runDir, "qa", "production_trace.json"), "utf8"));
const record = trace.questions[0].finalRecord;
const attachmentNames = trace.questions[0].attachmentBuild.attachments.map((item) => item.name);

const job = {
  jobId: "desktop-batch-award-review-20260718-01",
  attachmentRoot: path.join(runDir, "attachments"),
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
  taskGoal: "完成一份可下载的台式计算机成交复核Excel核对表，复核GC-HCD260444六包数量、金额、价格版本和质保情景，并从六包中挑选两包进入首轮人工抽检准备。",
  successCriteria: [
    "十份真实官方附件在首轮一次上传，并由豆包端精确读回全部文件名和数量。",
    "清洗535条配送明细，复核5889台总量，并把506条PR空值、5条纯数字地址和1台截断系统文本列入待核清单。",
    "逐包复核六个成交单价、六个成交金额、28945596元合计、29445000元预算和公告概要212.2855万元冲突。",
    "对齐六份偏离表响应值与最终成交价，复核六包总差额并按采购文件测算三年、五年和六年质保情景。",
    "整理六种配置的处理器、内存、硬盘和显卡证据，匿名编号保持原样且不映射供应商。",
    "结合金额规模、价格版本差异、规格特征和证据缺口挑选两包进入首轮人工抽检，结论只安排补证顺序。",
    "最终提供真实可访问的Excel文件或等价在线表格节点，包含原始明细、清洗映射、六包复核、规格对照、待核清单、抽检建议和来源索引七个分页。",
    "每个数值和判断注明文件名及页码、行号或网页区段，实际订单、到货、兼容性、验收、付款和售后记录保持待补。",
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
console.log(JSON.stringify({ outPath, attachmentCount: attachmentNames.length, initialPrompt: job.initialPrompt }, null, 2));
