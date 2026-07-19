import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildL1NaturalnessBaseline } from "./l1_naturalness_baseline.mjs";

test("builds an L1 naturalness baseline from the five retained phase-three examples", async () => {
  const outPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "l1-baseline-")), "baseline.json");
  const baseline = await buildL1NaturalnessBaseline({
    referenceDatasetPath: path.resolve("inputs/production/l1_phase3_reference_examples.json"),
    outPath,
  });
  assert.equal(baseline.kind, "naturalness-benchmark-baseline");
  assert.equal(baseline.baselineId, "l1-phase3-reference-v1");
  assert.equal(baseline.sampleCount, 5);
  assert.equal(JSON.parse(await fs.readFile(outPath, "utf8")).sampleCount, 5);
});
