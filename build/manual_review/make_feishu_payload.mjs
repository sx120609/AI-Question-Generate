import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFillArtifacts } from "./feishu_fill_plan_lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function readOption(name, fallback) {
  const eqPrefix = `--${name}=`;
  const eq = process.argv.find((arg) => arg.startsWith(eqPrefix));
  if (eq) return eq.slice(eqPrefix.length);

  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function readIntOption(name, fallback) {
  const value = readOption(name, undefined);
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return number;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

const startRow = readIntOption("start-row", 376);
const count = readIntOption("count", 2);
const sheetRows = String(readOption("sheet-rows", ""))
  .split(",")
  .map((item) => Number(item.trim()))
  .filter(Boolean);
const endRow = sheetRows.at(-1) ?? startRow + count - 1;

const tsvPath = resolveFromRoot(readOption("tsv", "outputs/l2_questions.tsv"));
const jsonOutPath = resolveFromRoot(
  readOption("json-out", `outputs/feishu_fill_plan_${startRow}_${endRow}.json`)
);
const payloadOutPath = resolveFromRoot(
  readOption("payload-out", `outputs/feishu_H${startRow}_O${endRow}_payload.tsv`)
);

const plan = await writeFillArtifacts({
  tsvPath,
  jsonOutPath,
  payloadOutPath,
  startRow,
  sheetRows,
  count,
});

console.log(`Feishu fill plan: ${jsonOutPath}`);
console.log(`Legacy H:O payload: ${payloadOutPath}`);
console.log(
  `Rows: ${plan.rows.map((row) => row.sheetRow).join(", ")}; cells: ${plan.rows.reduce(
    (sum, row) => sum + row.updates.length,
    0
  )}`
);
