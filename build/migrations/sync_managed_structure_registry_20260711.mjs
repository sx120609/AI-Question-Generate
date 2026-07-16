import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { registerStructureReceipt } from "../automation/structure_gate.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";

const RUN_DIR = path.resolve("outputs", "auto_runs", "rewrite_managed_no_blank_lines_fix_20260711");
const GLOBAL_REGISTRY = path.resolve("outputs", "auto_runs", "_structure_registry.json");
const STAGED_REGISTRY = path.join(RUN_DIR, "qa", "structure_registry_staged.json");
const BACKUP_REGISTRY = path.join(RUN_DIR, "qa", "structure_registry_before_replacement.json");
const RECEIPT = path.join(RUN_DIR, "feishu", "release_gate_receipt.json");

export async function syncManagedStructureRegistry() {
  const registry = JSON.parse(await fs.readFile(GLOBAL_REGISTRY, "utf8"));
  await fs.copyFile(GLOBAL_REGISTRY, BACKUP_REGISTRY);
  for (const entry of registry.entries ?? []) {
    if (entry.uid?.startsWith("沈礼_") || entry.uid?.startsWith("裴硬_")) entry.status = "superseded";
  }
  await writeJsonAtomic(STAGED_REGISTRY, registry);
  const registration = await registerStructureReceipt({
    receiptPath: RECEIPT,
    status: "submitted",
    registryPath: STAGED_REGISTRY,
    owner: "rewrite_managed_no_blank_lines_fix_20260711",
  });
  const next = JSON.parse(await fs.readFile(STAGED_REGISTRY, "utf8"));
  await writeJsonAtomic(GLOBAL_REGISTRY, next);
  return {
    ok: true,
    registration,
    backupPath: BACKUP_REGISTRY,
    registryPath: GLOBAL_REGISTRY,
    activeManagedEntries: (next.entries ?? []).filter((entry) =>
      (entry.uid?.startsWith("沈礼_") || entry.uid?.startsWith("裴硬_")) && entry.status === "submitted"
    ).length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncManagedStructureRegistry()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
