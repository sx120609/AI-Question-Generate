import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFeishuClient, rangeForCell } from "./feishu_openapi_client.mjs";
import {
  activeGeneratedAnnotators,
  loadGeneratedIdentities,
  matchGeneratedIdentity,
} from "./generated_identities.mjs";
import { canonicalizeProductFormat } from "./product_format.mjs";
import { withLock, writeJsonAtomic } from "./run_context.mjs";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
    else if (arg.startsWith("--")) out[arg.slice(2)] = true;
  }
  return out;
}

function firstRowFromRange(range) {
  const match = String(range).match(/![A-Z]+([1-9]\d*):/i);
  if (!match) throw new Error(`Unable to determine first row from range: ${range}`);
  return Number(match[1]);
}

function discoverUpdates(valueRange, config, sheetId) {
  const values = valueRange?.values ?? [];
  const firstRow = firstRowFromRange(valueRange?.range ?? `${sheetId}!A1:P1`);
  const managedRecords = [];
  const updates = [];
  for (let index = 0; index < values.length; index += 1) {
    const row = values[index] ?? [];
    const sheetRow = firstRow + index;
    const uid = String(row[0] ?? "").trim();
    const current = String(row[12] ?? "").trim();
    const name = String(row[15] ?? "").trim();
    const identity = matchGeneratedIdentity({ name, uid }, config);
    if (!identity) continue;
    if (!current) throw new Error(`Managed record ${uid || name} at row ${sheetRow} has an empty product format.`);
    const canonical = canonicalizeProductFormat(current);
    managedRecords.push({ row: sheetRow, uid, name: identity.name, current, canonical });
    if (current !== canonical) {
      updates.push({
        row: sheetRow,
        uid,
        name: identity.name,
        current,
        canonical,
        range: rangeForCell(sheetId, `M${sheetRow}`),
      });
    }
  }
  return { managedRecords, updates };
}

export async function migrateProductFormats({
  spreadsheetToken,
  sheetId,
  scanRange = `${sheetId}!A1:P500`,
  transport = "lark-cli",
  apply = false,
  reportPath = "",
  owner = `product_format_migration_${process.pid}`,
} = {}) {
  if (!spreadsheetToken || !sheetId) throw new Error("spreadsheetToken and sheetId are required.");
  const config = await loadGeneratedIdentities();
  const client = await createFeishuClient({ transport });

  const execute = async () => {
    const before = await client.readRange({ spreadsheetToken, range: scanRange });
    const discovery = discoverUpdates(before, config, sheetId);
    let apiResult = null;
    if (apply && discovery.updates.length) {
      apiResult = await client.batchUpdateValues({
        spreadsheetToken,
        valueRanges: discovery.updates.map((item) => ({ range: item.range, values: [[item.canonical]] })),
      });
    }

    const after = apply
      ? await client.readRange({ spreadsheetToken, range: scanRange })
      : before;
    const verified = discoverUpdates(after, config, sheetId);
    const expected = new Map(discovery.managedRecords.map((item) => [item.row, item.canonical]));
    const verification = verified.managedRecords.map((item) => ({
      row: item.row,
      uid: item.uid,
      name: item.name,
      value: item.current,
      expected: expected.get(item.row),
      ok: item.current === expected.get(item.row),
    }));
    const expectedIdentities = activeGeneratedAnnotators(config).map((item) => item.name);
    const seenIdentities = [...new Set(discovery.managedRecords.map((item) => item.name))];
    const missingIdentities = expectedIdentities.filter((name) => !seenIdentities.includes(name));
    const ok = discovery.managedRecords.length > 0
      && missingIdentities.length === 0
      && verification.length === discovery.managedRecords.length
      && verification.every((item) => item.ok);
    const result = {
      ok,
      apply,
      spreadsheetToken,
      sheetId,
      scanRange,
      managedRecordCount: discovery.managedRecords.length,
      updateCount: discovery.updates.length,
      identities: seenIdentities,
      missingIdentities,
      updates: discovery.updates,
      verification,
      apiResult,
      generatedAt: new Date().toISOString(),
    };
    if (reportPath) await writeJsonAtomic(path.resolve(reportPath), result);
    if (apply && !ok) throw new Error("Product format migration readback verification failed.");
    return result;
  };

  return apply
    ? withLock(`sheet_${spreadsheetToken}_${sheetId}`, { owner, metadata: { operation: "product-format-migration" } }, execute)
    : execute();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = await migrateProductFormats({
    spreadsheetToken: args["spreadsheet-token"],
    sheetId: args["sheet-id"],
    scanRange: args.range || `${args["sheet-id"]}!A1:P500`,
    transport: args.transport || "lark-cli",
    apply: args.apply === true,
    reportPath: args.report || "",
    owner: args.owner || `product_format_migration_${process.pid}`,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
}
