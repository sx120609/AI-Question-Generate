import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { submitFeishuSheetPlan } from "./feishu_sheet_submit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      out[match[1]] = match[2];
    } else if (arg.startsWith("--")) {
      out[arg.slice(2)] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function splitRows(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
}

export async function reserveUidPlaceholders({
  planPath,
  wikiUrl = "",
  spreadsheetToken = "",
  sheetId = "",
  sheetTitle = "",
  rows = [],
  outDir = path.join(root, "outputs"),
  apply = false,
  verify = true,
  transport = "",
  logPath = "",
  owner = `uid_reserve_${process.pid}`,
} = {}) {
  if (!planPath) throw new Error("reserveUidPlaceholders requires planPath.");
  if (!rows.length) {
    throw new Error("reserveUidPlaceholders requires explicit --rows. Do not reserve by implicit plan range.");
  }

  const result = await submitFeishuSheetPlan({
    planPath,
    wikiUrl,
    spreadsheetToken,
    sheetId,
    sheetTitle,
    rows,
    columns: ["A"],
    excludeColumns: [],
    outDir,
    apply,
    verify: apply && verify,
    transport,
    buildAttachments: false,
    logPath,
    lockOwner: owner,
  });
  if (result.valueRangeCount !== rows.length) {
    throw new Error(
      `UID reservation expected ${rows.length} A-column updates, got ${result.valueRangeCount}. Check that the fill plan contains UID updates for every requested row.`
    );
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const rows = splitRows(args.rows);
  const result = await reserveUidPlaceholders({
    planPath: resolveFromRoot(args.plan || "outputs/feishu_fill_plan.json"),
    wikiUrl: args["wiki-url"] || args.url || "",
    spreadsheetToken: args["spreadsheet-token"] || "",
    sheetId: args["sheet-id"] || "",
    sheetTitle: args["sheet-title"] || "",
    rows,
    outDir: resolveFromRoot(args["out-dir"] || "outputs"),
    apply: args.apply === true,
    verify: args.verify !== false,
    transport: args.transport || "",
    logPath: args.log ? resolveFromRoot(args.log) : "",
    owner: args.owner || `uid_reserve_${process.pid}`,
  });
  console.log(JSON.stringify(result, null, 2));
}
