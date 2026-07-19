import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function createScriptedJob(root, jobId) {
  const attachmentRoot = path.join(root, `${jobId}-source`);
  await mkdir(attachmentRoot, { recursive: true });
  const attachmentBytes = Buffer.from(`real attachment for ${jobId}`);
  await writeFile(path.join(attachmentRoot, "附件一.txt"), attachmentBytes);
  const config = {
    jobId,
    attachmentRoot,
    attachments: [{
      name: "附件一.txt",
      relativePath: "附件一.txt",
      sha256: hash(attachmentBytes),
      sourceUrl: "https://example.test/source",
      summary: "记录内部项目2026年7月的对象、时间和实际复核状态。",
      classification: "specific-business",
      objectLevel: true,
      timeAnchor: "2026年7月复核",
      specificityEvidence: {
        object: "内部项目运营记录",
        periodOrEvent: "2026年7月复核",
        uniqueContent: "包含该项目逐项记录和实际复核状态",
      },
    }],
    developmentOnlyScripted: true,
    maxRounds: 6,
    mode: "scripted",
    taskGoal: "核对公司运营记录并形成内部复核结论。",
    interactionRewrite: {
      type: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      model: "rewrite-model",
    },
    promptPreflight: { type: "local-codex", model: "review-model" },
    rounds: Array.from({ length: 6 }, (_, index) => ({
      prompt: `核对公司运营记录并形成第${index + 1}批复核结论。`,
      evaluation: {
        vote: "like",
        labels: ["内容准确", "其他"],
        note: "回复满足本轮要求，内容准确并且可以继续使用。",
      },
    })),
  };
  const configPath = path.join(root, `${jobId}.json`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { attachmentRoot, configPath };
}
