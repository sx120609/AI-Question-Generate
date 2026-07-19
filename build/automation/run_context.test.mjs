import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAutoRun } from "./run_context.mjs";

test("createAutoRun automatically writes and reserves a diversity plan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-run-diversity-test-"));
  try {
    const autoRunsRoot = path.join(root, "runs");
    const registryPath = path.join(root, "structure-registry.json");
    const manifest = await createAutoRun({
      objective: "test automatic structure reservation",
      annotator: "沈礼",
      count: 3,
      runId: "test_auto_run_diversity",
      autoRunsRoot,
      structureRegistryPath: registryPath,
    });

    const plan = JSON.parse(await fs.readFile(manifest.diversityPlanPath, "utf8"));
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    assert.equal(plan.runId, manifest.runId);
    assert.equal(plan.profiles.length, 3);
    assert.equal(new Set(plan.profiles.map((item) => item.profileId)).size, 3);
    assert.equal(registry.reservations.length, 1);
    assert.equal(registry.reservations[0].runId, manifest.runId);
    assert.equal(manifest.productionProfile, "l1");
    assert.equal(manifest.taskType, "L1 探索型");
    assert.equal(manifest.boundaries.sharedWritesRequireLocks.includes(path.resolve(registryPath)), true);
    assert.equal(manifest.situatedGeneration.policyId, "situated-requester-v1");
    assert.equal(manifest.situatedGeneration.candidateCountPerScene, 3);
    assert.equal(manifest.productionProtocol.promptVersion, "profiled-sampled-two-gate-prompts-v2-domestic-work-scope");
    assert.equal(manifest.productionProtocol.profileId, "l1");
    assert.equal(manifest.productionProtocol.stages.includes("attachment-plan"), true);
    assert.equal(manifest.modelRouting.generation.provider, "codex-model");
    assert.equal(manifest.modelRouting.generation.model, "gpt-5.6-sol");
    assert.equal(manifest.modelRouting.qualityGates.provider, "codex-model");
    assert.equal(manifest.modelRouting.deAiRewrite.provider, "mugua-openai-compatible");
    assert.equal(manifest.modelRouting.deAiRewrite.model, "gemini-3.1-pro-preview");
    assert.match(manifest.modelRouting.deAiRewrite.baseUrl, /api\.mugua\.link\/v1$/u);
    assert.match(manifest.modelRouting.deAiRewrite.promptPath, /L1题面去AI改写提示词\.txt$/u);
    assert.match(manifest.modelRouting.deAiRewrite.promptHash, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.parse(await fs.readFile(manifest.naturalnessBaselinePath, "utf8")).sampleCount, 5);
    assert.match(manifest.structuralDiversityPolicyPath, /structural_diversity_l1\.json$/u);
    const workflow = JSON.parse(await fs.readFile(manifest.productionProtocol.workflowStatePath, "utf8"));
    assert.equal(workflow.questions.length, 3);
    assert.ok(workflow.questions.every((item) => item.state === "REFERENCE_SAMPLED"));
    assert.equal(manifest.situatedGeneration.factLedgerPath, path.join(manifest.dirs.sources, "fact_ledger.json"));
    assert.equal(manifest.situatedGeneration.sceneCardPath, path.join(manifest.dirs.sources, "scene_cards.json"));
    assert.equal(
      manifest.situatedGeneration.roleConsistencyReportPath,
      path.join(manifest.dirs.feishu, "role_consistency_report.json"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
