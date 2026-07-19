import path from "node:path";

import { releaseInteractionQuotaPause } from "../src/quota-pause.mjs";
import { resumeAllQuotaPausedInteractionJobs } from "../src/task-queue.mjs";

function option(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const queueOption = String(option("queue", "")).trim();
if (!queueOption) {
  throw new Error("recover-quota-round now requires --queue. It no longer scores quota replies or calls any model.");
}

const queueRoot = path.resolve(queueOption);
const release = await releaseInteractionQuotaPause({
  queueRoot,
  releasedBy: "recover-quota-round-compatibility-script",
});
const resumed = await resumeAllQuotaPausedInteractionJobs({ queueRoot });

process.stdout.write(`${JSON.stringify({
  queueRoot,
  quotaPauseReleased: release.released,
  resumedJobIds: resumed.map((item) => item.jobId),
}, null, 2)}\n`);
