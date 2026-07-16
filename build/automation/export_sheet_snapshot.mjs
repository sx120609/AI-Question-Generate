import path from "node:path";
import { pathToFileURL } from "node:url";

import { createFeishuClient } from "./feishu_openapi_client.mjs";
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

export async function exportSheetSnapshot({
  spreadsheetToken,
  sheetId,
  range,
  rows = [],
  outPath,
  transport = "lark-cli",
} = {}) {
  if (!spreadsheetToken || !sheetId || !range || !outPath) {
    throw new Error("spreadsheetToken, sheetId, range and outPath are required.");
  }
  const qualifiedRange = range.includes("!") ? range : `${sheetId}!${range}`;
  const client = await createFeishuClient({ transport });
  const valueRange = await client.readRange({ spreadsheetToken, range: qualifiedRange });
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    spreadsheetToken,
    sheetId,
    requestedRange: qualifiedRange,
    targetRows: rows.map(Number).filter(Boolean),
    returnedRange: valueRange?.range ?? "",
    revision: valueRange?.revision ?? null,
    values: valueRange?.values ?? [],
  };
  await writeJsonAtomic(outPath, snapshot);
  return {
    ok: true,
    outPath: path.resolve(outPath),
    returnedRange: snapshot.returnedRange,
    revision: snapshot.revision,
    returnedRows: snapshot.values.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = await exportSheetSnapshot({
    spreadsheetToken: args["spreadsheet-token"],
    sheetId: args["sheet-id"],
    range: args.range,
    rows: String(args.rows ?? "").split(","),
    outPath: resolveFromRoot(args.out),
    transport: args.transport || "lark-cli",
  });
  console.log(JSON.stringify(result, null, 2));
}
