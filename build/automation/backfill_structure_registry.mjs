import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  compareFingerprints,
  fingerprintRow,
  hashNarrativeRow,
  loadStructuralDiversityPolicy,
} from "./structure_fingerprint.mjs";
import { parseLastJsonObject, runLarkCli } from "./feishu_lark_cli_client.mjs";
import { loadGeneratedIdentities, matchGeneratedIdentity } from "./generated_identities.mjs";
import {
  REPO_ROOT,
  ensureDir,
  readJson,
  withLock,
  writeJsonAtomic,
} from "./run_context.mjs";
import { STRUCTURE_REGISTRY_PATH } from "./structure_gate.mjs";

export const COLUMN_FIELDS = [
  "UID",
  "题目",
  "任务类型",
  "一级目录",
  "二级目录",
  "三级目录",
  "任务概括",
  "标注专家工作年限",
  "人类完成时间",
  "相关附件",
  "附件格式",
  "附件内容",
  "产物格式",
  "产物内容",
  "做题关键步骤",
  "标注专家姓名",
];

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

export function cellText(value) {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) {
    const attachmentNames = value
      .filter((part) => part?.type === "attachment" || part?.fileToken || part?.attachment_token)
      .map((part) => part.text ?? part.attachment_name ?? part.file_name ?? "");
    if (attachmentNames.length) return attachmentNames.join("；");
    return value.map(cellText).join("");
  }
  if (typeof value === "object") {
    return cellText(value.text ?? value.value ?? value.rich_text ?? value.link ?? value.url ?? "");
  }
  return "";
}

function parseCli(result) {
  const parsed = parseLastJsonObject([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (result.code !== 0 || parsed?.ok === false) {
    throw new Error(`Feishu read failed: ${JSON.stringify(parsed).slice(0, 1600)}`);
  }
  return parsed;
}

export async function readSheetRows({ spreadsheetToken, sheetId, startRow, endRow }) {
  const a1Range = `${sheetId}!A${startRow}:P${endRow}`;
  const result = await runLarkCli([
    "api",
    "GET",
    `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(a1Range)}`,
    "--as",
    "user",
    "--format",
    "json",
  ], { timeoutMs: 180_000 });
  const parsed = parseCli(result);
  const values = parsed?.data?.valueRange?.values ?? parsed?.data?.data?.valueRange?.values ?? [];
  return values.map((cells, index) => ({
    sheetRow: startRow + index,
    ...Object.fromEntries(COLUMN_FIELDS.map((field, column) => [field, cellText(cells?.[column]).trim()])),
  }));
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index];
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const spreadsheetToken = args["spreadsheet-token"];
  const sheetId = args["sheet-id"];
  if (!spreadsheetToken || !sheetId) throw new Error("--spreadsheet-token and --sheet-id are required.");
  const startRow = Number(args["start-row"] || 2);
  const endRow = Number(args["end-row"] || 500);
  const registryPath = resolveFromRoot(args.registry || STRUCTURE_REGISTRY_PATH);
  const reportPath = resolveFromRoot(args.report || "outputs/analysis/structure_audit_legacy.json");
  const [policy, identities, sheetRows] = await Promise.all([
    loadStructuralDiversityPolicy(),
    loadGeneratedIdentities(),
    readSheetRows({ spreadsheetToken, sheetId, startRow, endRow }),
  ]);

  const managed = sheetRows.filter((row) => {
    const identity = matchGeneratedIdentity({ name: row.标注专家姓名, uid: row.UID }, identities);
    return identity && row.UID.startsWith(identity.uidPrefix) && row.标注专家姓名 === identity.name && row.题目;
  });
  const latestByUid = new Map();
  for (const row of managed) {
    const current = latestByUid.get(row.UID);
    if (!current || row.sheetRow > current.sheetRow) latestByUid.set(row.UID, row);
  }
  const rows = [...latestByUid.values()].sort((a, b) => a.sheetRow - b.sheetRow);
  const fingerprints = rows.map((row) => fingerprintRow(row, policy));
  const pairs = [];
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      pairs.push({
        leftUid: rows[left].UID,
        rightUid: rows[right].UID,
        similarity: compareFingerprints(fingerprints[left], fingerprints[right], policy),
      });
    }
  }
  pairs.sort((a, b) => b.similarity.score - a.similarity.score);
  const lengths = fingerprints.map((item) => item.length.visible).sort((a, b) => a - b);
  const stepLcsValues = pairs.map((item) => item.similarity.dimensions.stepActions).sort((a, b) => a - b);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: { spreadsheetToken, sheetId, startRow, endRow },
    managedRowsRead: managed.length,
    uniqueRecords: rows.length,
    duplicateRowsDiscarded: managed.length - rows.length,
    length: {
      min: lengths[0] ?? 0,
      median: percentile(lengths, 0.5),
      p75: percentile(lengths, 0.75),
      max: lengths.at(-1) ?? 0,
      belowHardMinimum: lengths.filter((value) => value < policy.questionLength.hardMinimumVisibleCharacters).length,
    },
    stepActionSimilarity: {
      medianLcs: percentile(stepLcsValues, 0.5),
      pairsAtLeast080: stepLcsValues.filter((value) => value >= 0.8).length,
      pairsAtLeast090: stepLcsValues.filter((value) => value >= 0.9).length,
      exactPairs: stepLcsValues.filter((value) => value === 1).length,
      totalPairs: stepLcsValues.length,
    },
    topStructuralNeighbors: pairs.slice(0, 20),
    records: rows.map((row, index) => ({
      uid: row.UID,
      annotator: row.标注专家姓名,
      sheetRow: row.sheetRow,
      question: row.题目,
      fingerprint: fingerprints[index],
    })),
  };

  await withLock("structure_registry", { owner: "legacy_backfill", metadata: { count: rows.length } }, async () => {
    const registry = (await readJson(registryPath, null)) ?? {
      version: 1,
      policyId: policy.policyId,
      policyVersion: policy.version,
      entries: [],
      reservations: [],
    };
    const nonLegacy = (registry.entries ?? []).filter((entry) => !entry.legacy);
    const legacyEntries = rows.map((row, index) => ({
      uid: row.UID,
      runId: "legacy_feishu_backfill",
      sheetRow: row.sheetRow,
      annotator: row.标注专家姓名,
      status: "legacy",
      legacy: true,
      profile: null,
      fingerprint: fingerprints[index],
      rowHash: hashNarrativeRow(row),
      source: "feishu_A_P_readback",
      updatedAt: report.generatedAt,
    }));
    registry.entries = [...nonLegacy, ...legacyEntries];
    registry.policyId = policy.policyId;
    registry.policyVersion = policy.version;
    registry.updatedAt = report.generatedAt;
    await writeJsonAtomic(registryPath, registry);
  });
  await ensureDir(path.dirname(reportPath));
  await writeJsonAtomic(reportPath, report);
  return { ok: true, registryPath, reportPath, uniqueRecords: rows.length, summary: { length: report.length, stepActionSimilarity: report.stepActionSimilarity } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
