import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GENERATED_IDENTITIES_PATH = path.resolve(__dirname, "../../config/generated_identities.json");

export async function loadGeneratedIdentities(filePath = GENERATED_IDENTITIES_PATH) {
  const config = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!Array.isArray(config.managedGeneratedAnnotators) || !config.managedGeneratedAnnotators.length) {
    throw new Error(`No managed generated annotators in ${filePath}`);
  }
  return config;
}

export function activeGeneratedAnnotators(config) {
  return config.managedGeneratedAnnotators.filter((item) => item.active !== false);
}

export function matchGeneratedIdentity({ name = "", uid = "", runId = "" } = {}, config) {
  const normalizedName = String(name).trim();
  const normalizedUid = String(uid).trim();
  const normalizedRunId = String(runId).trim();
  return activeGeneratedAnnotators(config).find(
    (item) => normalizedName === item.name
      || (item.uidPrefix && normalizedUid.startsWith(item.uidPrefix))
      || (normalizedRunId && item.knownRunIds?.includes(normalizedRunId)),
  ) ?? null;
}
