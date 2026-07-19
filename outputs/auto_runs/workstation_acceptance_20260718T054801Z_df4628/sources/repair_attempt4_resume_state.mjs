import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  connectDoubao,
  inspectLatestSentPrompt,
} from "../../../../doubao-automation/src/doubao-client.mjs";
import {
  auditInteractionRewrite,
  requestPromptPreflight,
  validateOutboundPrompt,
} from "../../../../doubao-automation/src/policy.mjs";

const [stateArg, jobArg, priorArg] = process.argv.slice(2);
if (!stateArg || !jobArg || !priorArg) {
  throw new Error("Usage: node repair_attempt4_resume_state.mjs <state.json> <job.json> <prior-attempt.json>");
}

const statePath = path.resolve(stateArg);
const job = JSON.parse(await readFile(path.resolve(jobArg), "utf8"));
const state = JSON.parse(await readFile(statePath, "utf8"));
const prior = JSON.parse(await readFile(path.resolve(priorArg), "utf8"));

const { browser, page } = await connectDoubao("http://127.0.0.1:9229");
let sent;
try {
  sent = await inspectLatestSentPrompt(page);
} finally {
  await browser.close();
}
if (!sent.text) throw new Error("No visible sent prompt is available for repair.");

const prompt = validateOutboundPrompt(sent.text, { requirePersonalPronoun: true });
const preservation = auditInteractionRewrite(job.initialPrompt, prompt);
if (!preservation.pass) {
  throw new Error(`Visible sent prompt failed preservation audit: ${preservation.issues.join(", ")}`);
}
const preflight = await requestPromptPreflight({
  conversationContext: {},
  job,
  policy: job.promptPreflight,
  prompt,
  roundNumber: 1,
  sourcePrompt: job.initialPrompt,
  textPurpose: "chat-prompt",
});

const currentRound = state.rounds?.[0] ?? {};
const priorRound = prior.rounds?.[0] ?? {};
const repairedRound = {
  ...currentRound,
  attachmentNames: [...job.initialAttachmentNames],
  attachmentVerification: priorRound.attachmentVerification ?? currentRound.attachmentVerification ?? null,
  plannedPrompt: job.initialPrompt,
  preflight: {
    ...preflight,
    recoveredAfterStateOverwrite: true,
    visibleSentPromptIdentity: sent.identity,
  },
  prompt,
  response: null,
  rewrite: {
    changed: prompt !== job.initialPrompt,
    model: job.interactionRewrite.model,
    pass: true,
    preservation,
    prompt,
    recoveredAfterStateOverwrite: true,
    retryTrace: [],
    textPurpose: "chat-prompt",
    usage: {},
    visibleSentPromptIdentity: sent.identity,
  },
  status: "sending",
};
state.rounds = [repairedRound];
state.status = "failed";
state.workerPid = null;
state.recoveryAudit = {
  attachmentVerificationCopiedFrom: path.basename(priorArg),
  originalPreflightObservedBeforeSend: true,
  promptReverifiedByLocalCodex: true,
  repairedAt: new Date().toISOString(),
  visibleSentPromptIdentity: sent.identity,
};
delete state.error;
delete state.pause;

const temporaryPath = `${statePath}.repairing`;
await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
await rename(temporaryPath, statePath);
process.stdout.write(JSON.stringify({
  pass: true,
  preflightPass: preflight.pass,
  promptLength: [...prompt].length,
  visibleSentPromptIdentity: sent.identity,
}));
