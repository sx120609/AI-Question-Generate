import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";

import { parseArgs, integerOption } from "./args.mjs";
import { cdpEndpoint, listTargets, selectDoubaoChatTarget, waitForCdp } from "./cdp.mjs";
import {
  clearComposer,
  completeOpenFeedback,
  connectDoubao,
  copyOpenShareLink,
  copyLatestLogInfo,
  evaluateLatestResponse,
  fillComposer,
  inspectChat,
  inspectExecutionConfirmations,
  inspectOpenFeedback,
  inspectLatestResponse,
  openLatestFeedback,
  openLatestMoreMenu,
  openLatestShare,
  openNewOfficeTask,
  selectFeedbackOption,
  sendAndWait,
  sendComposer,
} from "./doubao-client.mjs";
import { launchDoubao } from "./launcher.mjs";
import { runDoubaoJob, verifyCompletedJobArtifacts } from "./job-runner.mjs";
import {
  JobPauseRequestedError,
  requestJobStop,
  startStopRequestMonitor,
  stopRequestPath,
} from "./job-control.mjs";

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function endpointFrom(options) {
  return cdpEndpoint({
    host: String(options.host ?? "127.0.0.1"),
    port: integerOption(options, "port", 9229),
  });
}

async function probe(options) {
  const endpoint = endpointFrom(options);
  const version = await waitForCdp(endpoint);
  const targets = await listTargets(endpoint);
  const chatTarget = selectDoubaoChatTarget(targets);
  print({
    chatTarget: {
      id: chatTarget.id,
      title: chatTarget.title,
      type: chatTarget.type,
      url: chatTarget.url,
    },
    endpoint,
    pageTargets: targets
      .filter((target) => target.type === "page")
      .map(({ id, title, type, url }) => ({ id, title, type, url })),
    version,
  });
}

async function inspect(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await inspectChat(page));
}

async function inspectConfirmations(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await inspectExecutionConfirmations(page));
}

async function fill(options) {
  const endpoint = endpointFrom(options);
  const text = String(options.text ?? "");
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  const actual = await fillComposer(page, text);
  const result = { filled: true, length: actual.length, readback: actual };
  if (options["clear-after"]) {
    await clearComposer(page);
    result.cleared = true;
  }
  print(result);
}

async function office(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await openNewOfficeTask(page));
}

async function sendPilot(options) {
  const endpoint = endpointFrom(options);
  const text = String(options.text ?? "");
  const settleMs = integerOption(options, "settle-ms", 2_000);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await sendComposer(page, text, { settleMs }));
}

async function runOnce(options) {
  const endpoint = endpointFrom(options);
  const text = String(options.text ?? "");
  const timeoutMs = integerOption(options, "timeout-ms", 180_000, {
    max: 900_000,
  });
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await sendAndWait(page, text, { timeoutMs }));
}

async function inspectLatest(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await inspectLatestResponse(page));
}

async function openFeedback(options) {
  const endpoint = endpointFrom(options);
  const vote = String(options.vote ?? "");
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await openLatestFeedback(page, vote));
}

async function inspectFeedback(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await inspectOpenFeedback(page));
}

async function selectFeedback(options) {
  const endpoint = endpointFrom(options);
  const label = String(options.label ?? "");
  if (!label) throw new Error("select-feedback requires --label.");
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await selectFeedbackOption(page, label));
}

async function completeFeedback(options) {
  const endpoint = endpointFrom(options);
  const note = String(options.note ?? "");
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await completeOpenFeedback(page, { note }));
}

async function evaluateLatest(options) {
  const endpoint = endpointFrom(options);
  const vote = String(options.vote ?? "");
  const labels = String(options.labels ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  const note = String(options.note ?? "");
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await evaluateLatestResponse(page, { labels, note, vote }));
}

async function openShare(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await openLatestShare(page));
}

async function copyShare(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  if (await page.locator('[data-testid="thread_share_title"]:visible').count() !== 1) {
    await openLatestShare(page);
  }
  print(await copyOpenShareLink(page, { selectAll: !options["keep-selection"] }));
}

async function openMore(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await openLatestMoreMenu(page));
}

async function copyLog(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectDoubao(endpoint);
  print(await copyLatestLogInfo(page));
}

async function launch(options) {
  const executablePath = path.resolve(String(options.exe ?? ""));
  const profileDir = path.resolve(String(options.profile ?? ""));
  if (!options.exe || !options.profile) {
    throw new Error("launch requires --exe and --profile.");
  }
  const port = options.port ? integerOption(options, "port", 0) : 0;
  print(await launchDoubao({ executablePath, profileDir, port }));
}

async function runJob(options) {
  const endpoint = endpointFrom(options);
  if (!options.config || !options.output) {
    throw new Error("run-job requires --config and --output.");
  }
  const configPath = path.resolve(String(options.config));
  const outputPath = path.resolve(String(options.output));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const runId = randomUUID();
  await rm(stopRequestPath(outputPath), { force: true });
  const controller = new AbortController();
  const pause = () => {
    if (!controller.signal.aborted) controller.abort(new JobPauseRequestedError());
  };
  process.once("SIGINT", pause);
  process.once("SIGTERM", pause);
  const monitor = startStopRequestMonitor({ controller, outputPath, runId });
  try {
    await waitForCdp(endpoint);
    const { page } = await connectDoubao(endpoint);
    print(await runDoubaoJob({ config, outputPath, page, runId, signal: controller.signal }));
  } finally {
    monitor.stop();
    process.removeListener("SIGINT", pause);
    process.removeListener("SIGTERM", pause);
  }
}

async function stopJob(options) {
  if (!options.file) throw new Error("stop-job requires --file.");
  const outputPath = path.resolve(String(options.file));
  const forceAfterMs = integerOption(options, "force-after-ms", 10_000, { max: 120_000 });
  print(await requestJobStop({ forceAfterMs, outputPath }));
}

async function verifyResult(options) {
  if (!options.file) throw new Error("verify-result requires --file.");
  const filePath = path.resolve(String(options.file));
  const result = JSON.parse(await readFile(filePath, "utf8"));
  print(await verifyCompletedJobArtifacts(result, { resultPath: filePath }));
}

function help() {
  process.stdout.write(`doubao-vm-worker\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  launch  --exe <absolute path> --profile <absolute path> [--port N]\n`);
  process.stdout.write(`  probe   --port N\n`);
  process.stdout.write(`  inspect --port N\n`);
  process.stdout.write(`  inspect-confirmations --port N\n`);
  process.stdout.write(`  office  --port N\n`);
  process.stdout.write(`  fill    --port N --text <text> [--clear-after]\n`);
  process.stdout.write(`  send-pilot --port N --text <text> [--settle-ms N]\n`);
  process.stdout.write(`  run-once --port N --text <text> [--timeout-ms N]\n`);
  process.stdout.write(`  inspect-latest --port N\n`);
  process.stdout.write(`  open-feedback --port N --vote <like|dislike>\n`);
  process.stdout.write(`  inspect-feedback --port N\n`);
  process.stdout.write(`  select-feedback --port N --label <text>\n`);
  process.stdout.write(`  complete-feedback --port N [--note <text>]\n`);
  process.stdout.write(`  evaluate-latest --port N --vote <like|dislike> --labels <a,b> [--note <text>]\n`);
  process.stdout.write(`  open-share --port N\n`);
  process.stdout.write(`  copy-share --port N [--keep-selection]\n`);
  process.stdout.write(`  open-more --port N\n`);
  process.stdout.write(`  copy-log --port N\n`);
  process.stdout.write(`  run-job --port N --config <job.json> --output <result.json>\n`);
  process.stdout.write(`  stop-job --file <result.json> [--force-after-ms N]\n`);
  process.stdout.write(`  verify-result --file <result.json>\n`);
}

const { command, options } = parseArgs(process.argv.slice(2));

let exitCode = 0;
try {
  if (command === "probe") await probe(options);
  else if (command === "inspect") await inspect(options);
  else if (command === "inspect-confirmations") await inspectConfirmations(options);
  else if (command === "office") await office(options);
  else if (command === "fill") await fill(options);
  else if (command === "send-pilot") await sendPilot(options);
  else if (command === "run-once") await runOnce(options);
  else if (command === "inspect-latest") await inspectLatest(options);
  else if (command === "open-feedback") await openFeedback(options);
  else if (command === "inspect-feedback") await inspectFeedback(options);
  else if (command === "select-feedback") await selectFeedback(options);
  else if (command === "complete-feedback") await completeFeedback(options);
  else if (command === "evaluate-latest") await evaluateLatest(options);
  else if (command === "open-share") await openShare(options);
  else if (command === "copy-share") await copyShare(options);
  else if (command === "open-more") await openMore(options);
  else if (command === "copy-log") await copyLog(options);
  else if (command === "run-job") await runJob(options);
  else if (command === "stop-job") await stopJob(options);
  else if (command === "verify-result") await verifyResult(options);
  else if (command === "launch") await launch(options);
  else help();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  exitCode = 1;
}

// Playwright intentionally keeps the CDP transport alive. This CLI is a
// one-shot client, so exit after flushing output. Exiting the local process
// detaches the transport without sending Browser.close to the Doubao client.
await Promise.all([
  new Promise((resolve) => process.stdout.write("", resolve)),
  new Promise((resolve) => process.stderr.write("", resolve)),
]);
process.exit(exitCode);
