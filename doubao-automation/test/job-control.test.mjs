import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  matchesRunJobCommandLine,
  startStopRequestMonitor,
  stopRequestPath,
} from "../src/job-control.mjs";

test("forced-stop identity matching requires both the worker command and exact output path", () => {
  const outputPath = path.resolve("results", "job-001.json");
  const command = `node doubao-automation/src/cli.mjs run-job --port 9229 --output ${outputPath}`;
  assert.equal(matchesRunJobCommandLine(command, outputPath), true);
  assert.equal(matchesRunJobCommandLine("node unrelated-worker.mjs", outputPath), false);
  assert.equal(matchesRunJobCommandLine(command, path.resolve("results", "job-002.json")), false);
});

test("a matching stop request aborts only its own run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "doubao-stop-monitor-"));
  const outputPath = path.join(directory, "result.json");
  const controller = new AbortController();
  const monitor = startStopRequestMonitor({
    controller,
    outputPath,
    pollMs: 10,
    runId: "current-run",
  });
  try {
    await writeFile(stopRequestPath(outputPath), JSON.stringify({ runId: "stale-run" }), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(controller.signal.aborted, false);

    await writeFile(stopRequestPath(outputPath), JSON.stringify({ runId: "current-run" }), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(controller.signal.aborted, true);
    assert.equal(controller.signal.reason.code, "JOB_PAUSE_REQUESTED");
  } finally {
    monitor.stop();
    await rm(directory, { force: true, recursive: true });
  }
});
