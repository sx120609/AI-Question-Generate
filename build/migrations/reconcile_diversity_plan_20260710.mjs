import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  evaluateDiversity,
  fingerprintRow,
  loadStructuralDiversityPolicy,
  parseTsvRows,
} from "../automation/structure_fingerprint.mjs";
import { readJson, writeJsonAtomic } from "../automation/run_context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const REGISTRY_PATH = path.join(ROOT, "outputs", "auto_runs", "_structure_registry.json");

const RUN_IDS = [
  "rewrite_shenli_all_20260709T215202Z_63bf72",
  "rewrite_peiying_all_20260709T215207Z_75bdf9",
];

function productTopologyId(fingerprint) {
  return `${fingerprint.artifactTopology.document}__${fingerprint.artifactTopology.workbook}`;
}

function comparableProfile(profile) {
  return {
    lengthBand: profile.lengthBand,
    openingMode: profile.openingMode,
    informationOrder: profile.informationOrder,
    decisionForm: profile.decisionForm,
    evidenceTopology: profile.evidenceTopology,
    flowTopology: profile.flowTopology,
    productTopology: profile.productTopology,
  };
}

async function reconcileRun(runId, policy, history) {
  const runDir = path.join(ROOT, "outputs", "auto_runs", runId);
  const sourceDir = path.join(runDir, "sources");
  const planPath = path.join(sourceDir, "diversity_plan.json");
  const allocatedPath = path.join(sourceDir, "diversity_plan_allocated.json");
  const reportPath = path.join(sourceDir, "diversity_plan_reconciliation.json");
  const tsvPath = path.join(runDir, "drafts", "l2_questions_rewritten.tsv");

  const currentPlan = await readJson(planPath);
  let allocatedPlan = await readJson(allocatedPath, null);
  if (!allocatedPlan) {
    allocatedPlan = currentPlan;
    await writeJsonAtomic(allocatedPath, allocatedPlan);
  }

  const rows = parseTsvRows(await fs.readFile(tsvPath, "utf8"));
  if (rows.length !== allocatedPlan.profiles.length) {
    throw new Error(`${runId} profile count ${allocatedPlan.profiles.length} does not match ${rows.length} rows.`);
  }

  const freeEvaluation = evaluateDiversity(rows, { policy, history, assignments: [] });
  if (!freeEvaluation.ok) {
    throw new Error(`${runId} cannot reconcile a colliding batch: ${freeEvaluation.findings.map((item) => item.rule).join(", ")}`);
  }

  const reconciledAt = new Date().toISOString();
  const changes = [];
  const profiles = rows.map((row, index) => {
    const fingerprint = fingerprintRow(row, policy);
    const allocated = allocatedPlan.profiles[index];
    const finalProfile = {
      ...allocated,
      uid: row.UID,
      lengthBand: fingerprint.length.band,
      openingMode: fingerprint.openingMode,
      informationOrder: fingerprint.informationOrder,
      decisionForm: fingerprint.decisionForm,
      evidenceTopology: fingerprint.evidenceTopology,
      flowTopology: fingerprint.flowTopology,
      productTopology: productTopologyId(fingerprint),
      reconciledAt,
    };
    changes.push({
      slot: allocated.slot,
      uid: row.UID,
      allocated: comparableProfile(allocated),
      final: comparableProfile(finalProfile),
    });
    return finalProfile;
  });

  const reconciledPlan = {
    ...allocatedPlan,
    generatedAt: allocatedPlan.generatedAt,
    reconciledAt,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    profiles,
    note: "Original automatic allocation is preserved in diversity_plan_allocated.json. This frozen passport records the topic-fit candidate selected after verifying minimum length, information coverage, batch diversity, and history distance; subsequent changes must continue to match it.",
    reconciliation: {
      kind: "topic-fit-candidate-selection",
      allocatedPlanPath: allocatedPath,
      candidatePath: tsvPath,
      freeGateStatus: freeEvaluation.status,
      freeGateFindingCount: freeEvaluation.findings.length,
    },
  };

  const assignedEvaluation = evaluateDiversity(rows, { policy, history, assignments: profiles });
  if (!assignedEvaluation.ok) {
    throw new Error(`${runId} reconciled passport still fails: ${assignedEvaluation.findings.map((item) => item.rule).join(", ")}`);
  }

  await writeJsonAtomic(planPath, reconciledPlan);
  await writeJsonAtomic(reportPath, {
    schemaVersion: 1,
    runId,
    reconciledAt,
    policyId: policy.policyId,
    status: "PASS",
    candidateCount: rows.length,
    batchAndHistoryGate: freeEvaluation.status,
    assignedGate: assignedEvaluation.status,
    changes,
  });
  return { runId, rows: rows.length, status: assignedEvaluation.status, planPath, allocatedPath, reportPath };
}

async function main() {
  const policy = await loadStructuralDiversityPolicy();
  const registry = await readJson(REGISTRY_PATH, { entries: [] });
  const history = (registry.entries ?? []).filter((entry) => entry.fingerprint);
  const results = [];
  for (const runId of RUN_IDS) results.push(await reconcileRun(runId, policy, history));
  return { ok: true, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
