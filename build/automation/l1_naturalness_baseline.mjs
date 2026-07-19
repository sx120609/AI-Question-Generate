import fs from "node:fs/promises";
import path from "node:path";

import { calibrateNaturalnessBaseline, validateNaturalnessBaseline } from "./naturalness_gate.mjs";

export async function buildL1NaturalnessBaseline({ referenceDatasetPath, outPath } = {}) {
  if (!referenceDatasetPath || !outPath) {
    throw new TypeError("buildL1NaturalnessBaseline requires referenceDatasetPath and outPath.");
  }
  const dataset = JSON.parse(await fs.readFile(path.resolve(referenceDatasetPath), "utf8"));
  const rows = (dataset.samples ?? []).map((sample, index) => ({
    UID: `L1_REFERENCE_${index + 1}`,
    题目: sample.question,
    做题关键步骤: sample.keySteps,
    产物格式: sample.productFormat,
  }));
  const baseline = calibrateNaturalnessBaseline(rows, {
    baselineId: "l1-phase3-reference-v1",
    generatedAt: dataset.source?.capturedAt
      ? `${dataset.source.capturedAt}T00:00:00.000Z`
      : new Date().toISOString(),
  });
  validateNaturalnessBaseline(baseline);
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return baseline;
}
