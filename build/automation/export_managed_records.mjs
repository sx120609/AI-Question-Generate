import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLUMN_FIELDS, readSheetRows } from "./backfill_structure_registry.mjs";
import { loadGeneratedIdentities, matchGeneratedIdentity } from "./generated_identities.mjs";
import { REPO_ROOT, writeJsonAtomic } from "./run_context.mjs";

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

function latestManagedRows(rows, identities) {
  const latest = new Map();
  for (const row of rows) {
    const identity = matchGeneratedIdentity({ name: row.标注专家姓名, uid: row.UID }, identities);
    if (!identity || !row.题目 || !row.UID.startsWith(identity.uidPrefix) || row.标注专家姓名 !== identity.name) continue;
    const current = latest.get(row.UID);
    if (!current || row.sheetRow > current.sheetRow) latest.set(row.UID, row);
  }
  return [...latest.values()].sort((left, right) => left.sheetRow - right.sheetRow);
}

function snapshot(records, source) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source,
    fields: ["sheetRow", ...COLUMN_FIELDS],
    count: records.length,
    records,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const spreadsheetToken = args["spreadsheet-token"];
  const sheetId = args["sheet-id"];
  if (!spreadsheetToken || !sheetId || !args.out) {
    throw new Error("--spreadsheet-token, --sheet-id and --out are required.");
  }
  const startRow = Number(args["start-row"] || 2);
  const endRow = Number(args["end-row"] || 500);
  const identities = await loadGeneratedIdentities();
  const rows = await readSheetRows({ spreadsheetToken, sheetId, startRow, endRow });
  const records = latestManagedRows(rows, identities);
  const source = { spreadsheetToken, sheetId, startRow, endRow };
  await writeJsonAtomic(resolveFromRoot(args.out), snapshot(records, source));

  const outputs = { all: records.length };
  for (const [name, argName, key] of [
    ["沈礼", "shenli-out", "shenli"],
    ["裴硬", "peiying-out", "peiying"],
  ]) {
    if (!args[argName]) continue;
    const selected = records.filter((row) => row.标注专家姓名 === name);
    await writeJsonAtomic(resolveFromRoot(args[argName]), snapshot(selected, source));
    outputs[key] = selected.length;
  }
  return { ok: true, outputs, rows: records.map((row) => ({ sheetRow: row.sheetRow, uid: row.UID, annotator: row.标注专家姓名 })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
