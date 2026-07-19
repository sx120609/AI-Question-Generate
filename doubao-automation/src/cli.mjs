import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";

import { parseArgs, integerOption } from "./args.mjs";
import {
  cdpEndpoint,
  listDoubaoChatTargets,
  listTargets,
  selectDoubaoChatTarget,
  waitForCdp,
} from "./cdp.mjs";
import {
  clearComposer,
  completeOpenFeedback,
  connectDoubao,
  copyOpenShareLink,
  copyLatestLogInfo,
  createDoubaoWindow,
  evaluateLatestResponse,
  fillComposer,
  inspectChat,
  inspectExecutionConfirmations,
  inspectOpenFeedback,
  inspectLatestResponse,
  listDoubaoWindows,
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
import {
  enqueueInteractionJob,
  interactionQueueStatus,
  resumeAllQuotaPausedInteractionJobs,
  resumeFailedInteractionJob,
  resumePausedInteractionJob,
  retryFailedInteractionJob,
} from "./task-queue.mjs";
import { releaseInteractionQuotaPause } from "./quota-pause.mjs";
import {
  runInteractionQueuePool,
  runInteractionQueueWorker,
} from "./queue-worker.mjs";

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function endpointFrom(options) {
  return cdpEndpoint({
    host: String(options.host ?? "127.0.0.1"),
    port: integerOption(options, "port", 9229),
  });
}

function selectorFrom(options) {
  return {
    conversationId: String(options["conversation-id"] ?? ""),
    targetId: String(options["target-id"] ?? ""),
  };
}

async function connectForOptions(endpoint, options) {
  return await connectDoubao(endpoint, selectorFrom(options));
}

async function probe(options) {
  const endpoint = endpointFrom(options);
  const version = await waitForCdp(endpoint);
  const targets = await listTargets(endpoint);
  const chatTargets = listDoubaoChatTargets(targets);
  const selector = selectorFrom(options);
  const chatTarget = selector.targetId || selector.conversationId || chatTargets.length === 1
    ? selectDoubaoChatTarget(targets, selector)
    : null;
  print({
    chatTarget: chatTarget ? {
      id: chatTarget.id,
      title: chatTarget.title,
      type: chatTarget.type,
      url: chatTarget.url,
    } : null,
    chatTargets: chatTargets.map(({ id, title, type, url }) => ({ id, title, type, url })),
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
  const { page } = await connectForOptions(endpoint, options);
  print(await inspectChat(page));
}

async function inspectConfirmations(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await inspectExecutionConfirmations(page));
}

async function fill(options) {
  const endpoint = endpointFrom(options);
  const text = String(options.text ?? "");
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
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
  const { page } = await connectForOptions(endpoint, options);
  print(await openNewOfficeTask(page));
}

async function sendPilot(options) {
  const endpoint = endpointFrom(options);
  const text = String(options.text ?? "");
  const settleMs = integerOption(options, "settle-ms", 2_000);
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await sendComposer(page, text, { settleMs }));
}

async function runOnce(options) {
  const endpoint = endpointFrom(options);
  const text = String(options.text ?? "");
  const timeoutMs = integerOption(options, "timeout-ms", 180_000, {
    max: 900_000,
  });
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await sendAndWait(page, text, { timeoutMs }));
}

async function inspectLatest(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await inspectLatestResponse(page));
}

async function openFeedback(options) {
  const endpoint = endpointFrom(options);
  const vote = String(options.vote ?? "");
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await openLatestFeedback(page, vote));
}

async function inspectFeedback(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await inspectOpenFeedback(page));
}

async function selectFeedback(options) {
  const endpoint = endpointFrom(options);
  const label = String(options.label ?? "");
  if (!label) throw new Error("select-feedback requires --label.");
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await selectFeedbackOption(page, label));
}

async function completeFeedback(options) {
  const endpoint = endpointFrom(options);
  const note = String(options.note ?? "");
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
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
  const { page } = await connectForOptions(endpoint, options);
  print(await evaluateLatestResponse(page, { labels, note, vote }));
}

async function openShare(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await openLatestShare(page));
}

async function copyShare(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  if (await page.locator('[data-testid="thread_share_title"]:visible').count() !== 1) {
    await openLatestShare(page);
  }
  print(await copyOpenShareLink(page, { selectAll: !options["keep-selection"] }));
}

async function openMore(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await openLatestMoreMenu(page));
}

async function copyLog(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  const { page } = await connectForOptions(endpoint, options);
  print(await copyLatestLogInfo(page));
}

async function listWindows(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  print({ endpoint, windows: await listDoubaoWindows(endpoint) });
}

async function createWindow(options) {
  const endpoint = endpointFrom(options);
  await waitForCdp(endpoint);
  print(await createDoubaoWindow(endpoint));
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
    const { page, pageInfo } = await connectForOptions(endpoint, options);
    print(await runDoubaoJob({
      config,
      executionSlot: {
        browserContextId: pageInfo.browserContextId,
        endpoint,
        targetId: pageInfo.targetId,
        workerId: `direct-${process.pid}`,
      },
      outputPath,
      page,
      resume: options.resume === true,
      runId,
      signal: controller.signal,
    }));
  } finally {
    monitor.stop();
    process.removeListener("SIGINT", pause);
    process.removeListener("SIGTERM", pause);
  }
}

async function enqueueJob(options) {
  if (!options.config || !options.queue) throw new Error("enqueue-job requires --config and --queue.");
  print(await enqueueInteractionJob({
    configPath: path.resolve(String(options.config)),
    queueRoot: path.resolve(String(options.queue)),
  }));
}

async function queueStatus(options) {
  if (!options.queue) throw new Error("queue-status requires --queue.");
  print(await interactionQueueStatus(path.resolve(String(options.queue))));
}

async function retryJob(options) {
  if (!options.queue || !options["job-id"]) {
    throw new Error("retry-job requires --queue and --job-id.");
  }
  print(await retryFailedInteractionJob({
    jobId: String(options["job-id"]),
    queueRoot: path.resolve(String(options.queue)),
  }));
}

async function resumeJob(options) {
  if (!options.queue || !options["job-id"]) {
    throw new Error("resume-job requires --queue and --job-id.");
  }
  const request = {
    jobId: String(options["job-id"]),
    queueRoot: path.resolve(String(options.queue)),
  };
  try {
    print(await resumePausedInteractionJob(request));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    print(await resumeFailedInteractionJob(request));
  }
}

async function resumeQuota(options) {
  if (!options.queue) throw new Error("resume-quota requires --queue.");
  const queueRoot = path.resolve(String(options.queue));
  const release = await releaseInteractionQuotaPause({ queueRoot });
  const resumed = await resumeAllQuotaPausedInteractionJobs({ queueRoot });
  print({
    queueRoot,
    quotaPauseReleased: release.released,
    resumedJobIds: resumed.map((item) => item.jobId),
  });
}

async function runQueueWorker(options) {
  if (!options.queue || !options["target-id"]) {
    throw new Error("queue-worker requires --queue and --target-id.");
  }
  const endpoint = endpointFrom(options);
  const controller = new AbortController();
  const stop = () => controller.abort(new JobPauseRequestedError());
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await waitForCdp(endpoint);
    print(await runInteractionQueueWorker({
      endpoint,
      maxJobs: options.once === true ? 1 : 0,
      queueRoot: path.resolve(String(options.queue)),
      signal: controller.signal,
      targetId: String(options["target-id"]),
    }));
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function runQueuePool(options) {
  if (!options.queue || !options["target-ids"]) {
    throw new Error("queue-pool requires --queue and --target-ids.");
  }
  const targetIds = String(options["target-ids"]).split(",").map((item) => item.trim()).filter(Boolean);
  const endpoint = endpointFrom(options);
  const controller = new AbortController();
  const stop = () => controller.abort(new JobPauseRequestedError());
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await waitForCdp(endpoint);
    print(await runInteractionQueuePool({
      endpoint,
      maxJobsPerWorker: options.once === true ? 1 : 0,
      queueRoot: path.resolve(String(options.queue)),
      signal: controller.signal,
      targetIds,
    }));
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
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
  process.stdout.write(`  probe   --port N [--target-id ID]\n`);
  process.stdout.write(`  list-windows --port N\n`);
  process.stdout.write(`  create-window --port N\n`);
  process.stdout.write(`  inspect --port N [--target-id ID]\n`);
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
  process.stdout.write(`  run-job --port N --target-id ID --config <job.json> --output <result.json> [--resume]\n`);
  process.stdout.write(`  enqueue-job --queue <dir> --config <job.json>\n`);
  process.stdout.write(`  retry-job --queue <dir> --job-id ID\n`);
  process.stdout.write(`  resume-job --queue <dir> --job-id ID\n`);
  process.stdout.write(`  resume-quota --queue <dir>\n`);
  process.stdout.write(`  queue-status --queue <dir>\n`);
  process.stdout.write(`  queue-worker --port N --queue <dir> --target-id ID [--once]\n`);
  process.stdout.write(`  queue-pool --port N --queue <dir> --target-ids ID1,ID2 [--once]\n`);
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
  else if (command === "list-windows") await listWindows(options);
  else if (command === "create-window") await createWindow(options);
  else if (command === "run-job") await runJob(options);
  else if (command === "enqueue-job") await enqueueJob(options);
  else if (command === "retry-job") await retryJob(options);
  else if (command === "resume-job") await resumeJob(options);
  else if (command === "resume-quota") await resumeQuota(options);
  else if (command === "queue-status") await queueStatus(options);
  else if (command === "queue-worker") await runQueueWorker(options);
  else if (command === "queue-pool") await runQueuePool(options);
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
