import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { artifactRootForResult } from "../src/artifact-root.mjs";
import { cdpEndpoint, waitForCdp } from "../src/cdp.mjs";
import {
  connectDoubao,
  copyLatestLogInfo,
  copyOpenShareLink,
  openLatestShare,
} from "../src/doubao-client.mjs";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function option(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function atomicWrite(filePath, bytes) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, bytes);
  await rename(temporaryPath, filePath);
}

const resultPath = path.resolve(option("output"));
const port = Number(option("port", "9229"));
if (!option("output") || !Number.isInteger(port)) {
  throw new Error("package-incomplete-run requires --output and an integer --port.");
}
const state = JSON.parse(await readFile(resultPath, "utf8"));
const minimumRounds = Number(state.minimumRounds ?? 6);
if (!Array.isArray(state.rounds) || state.rounds.length < minimumRounds
  || state.rounds.length > Number(state.maxRounds)
  || state.rounds.some((round) => round?.status !== "complete")) {
  throw new Error("Doubao-gap packaging requires a completed interaction count inside the configured range.");
}
if (state.finalProductAcceptance?.accepted !== false) {
  throw new Error("Incomplete packaging is only for a verified rejected final product.");
}

const endpoint = cdpEndpoint({ port });
await waitForCdp(endpoint);
const { page } = await connectDoubao(endpoint);
await openLatestShare(page);
const share = await copyOpenShareLink(page, { selectAll: true });
if (!/^https:\/\/www\.doubao\.com\/thread\/x[0-9a-f]+$/iu.test(share.clipboardText)) {
  throw new Error("The copied share link did not match the expected Doubao thread format.");
}
const log = await copyLatestLogInfo(page);
const allMessagesSelected = share.checkedAfter.length === share.checkboxCount
  && share.checkedAfter.every(Boolean);
if (!allMessagesSelected || !log.feedbackUrl || !log.logId) {
  throw new Error("Share selection or log information was not fully verified.");
}

state.feedbackUrl = log.feedbackUrl;
state.logId = log.logId;
state.shareLink = share.clipboardText;
state.shareReceipt = {
  allSelected: true,
  checkboxCount: share.checkboxCount,
  copied: share.copied,
  pass: true,
  selectedCount: share.checkedAfter.filter(Boolean).length,
  shareLink: share.clipboardText,
  verifiedAt: new Date().toISOString(),
};
state.logReceipt = {
  feedbackUrl: log.feedbackUrl,
  logId: log.logId,
  pass: true,
  responseCount: log.responseCount,
  verifiedAt: new Date().toISOString(),
};

state.completionOutcome ||= "doubao-unable";
state.unresolvedIssues = Array.isArray(state.unresolvedIssues) && state.unresolvedIssues.length
  ? state.unresolvedIssues
  : [state.rounds.at(-1)?.evaluation?.note].filter((item) => String(item ?? "").trim());
if (state.unresolvedIssues.length === 0) {
  throw new Error("Doubao-gap packaging requires at least one evidence-based unresolved issue.");
}

const packageValue = {
  schemaVersion: 3,
  kind: "doubao-feishu-submission-package",
  status: "READY_WITH_DOUBAO_GAP",
  generatedAt: new Date().toISOString(),
  jobId: state.jobId,
  configHash: state.configHash,
  blockingReason: "doubao-task-unfinished",
  completionOutcome: state.completionOutcome,
  unresolvedIssues: state.unresolvedIssues,
  productAcceptance: state.finalProductAcceptance,
  roundCount: state.rounds.length,
  conversation: {
    conversationId: state.conversationId,
    feedbackUrl: state.feedbackUrl,
    logId: state.logId,
    shareLink: state.shareLink,
    allMessagesSelected: true,
    selectedMessageCount: state.shareReceipt.selectedCount,
  },
  rows: state.rounds.map((round) => ({
    roundNumber: round.index,
    prompt: round.prompt,
    response: round.response.response,
    responseIdentity: round.response.responseIdentity,
    humanEvaluation: {
      evidenceQuote: round.evaluation.evidenceQuote,
      labels: round.evaluation.labels,
      note: round.evaluation.note,
      score: round.evaluation.score,
      vote: round.evaluation.vote,
    },
  })),
  target: null,
  writeback: {
    applied: false,
    policy: "submittable-with-documented-doubao-product-gap",
    readbackVerified: false,
  },
};

const packagePath = path.join(artifactRootForResult(resultPath), "feishu-submission-package.incomplete.json");
await mkdir(path.dirname(packagePath), { recursive: true });
const packageBytes = Buffer.from(`${JSON.stringify(packageValue, null, 2)}\n`, "utf8");
await atomicWrite(packagePath, packageBytes);
const packageReadback = await readFile(packagePath);
if (digest(packageReadback) !== digest(packageBytes)) {
  throw new Error("Incomplete package readback hash mismatch.");
}
state.submissionPackage = {
  artifactPath: path.relative(path.dirname(resultPath), packagePath).replace(/\\/gu, "/"),
  pass: true,
  roundCount: state.rounds.length,
  sha256: digest(packageReadback),
  sizeBytes: packageReadback.length,
  status: packageValue.status,
  writeApplied: false,
  writtenAt: new Date().toISOString(),
};
state.updatedAt = new Date().toISOString();
await atomicWrite(resultPath, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"));
process.stdout.write(`${JSON.stringify({
  feedbackUrl: state.feedbackUrl,
  submissionPackage: state.submissionPackage,
  logId: state.logId,
  shareLink: state.shareLink,
}, null, 2)}\n`);
process.exit(0);
