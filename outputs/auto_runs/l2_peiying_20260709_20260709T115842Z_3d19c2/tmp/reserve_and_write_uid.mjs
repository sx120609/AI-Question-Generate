import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  reserveRows,
  updateReservationStatus,
} from "../../../../build/automation/run_context.mjs";
import { createFeishuClient } from "../../../../build/automation/feishu_openapi_client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runRoot = path.resolve(__dirname, "..");
const runId = path.basename(runRoot);
const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";
const startRow = 145;
const endRow = 149;
const uids = ["裴硬_7.9_01", "裴硬_7.9_02", "裴硬_7.9_03", "裴硬_7.9_04", "裴硬_7.9_05"];

const reservation = await reserveRows({
  runId,
  spreadsheetToken,
  sheetId,
  count: uids.length,
  firstCandidateRow: startRow,
});

if (reservation.startRow !== startRow || reservation.endRow !== endRow) {
  throw new Error(
    `Reserved unexpected rows ${reservation.startRow}-${reservation.endRow}; expected ${startRow}-${endRow}`,
  );
}

const client = await createFeishuClient({ transport: "lark-cli" });
const valueRanges = uids.map((uid, index) => ({
  range: `${sheetId}!A${startRow + index}:A${startRow + index}`,
  values: [[uid]],
}));

const writeResult = await client.batchUpdateValues({ spreadsheetToken, valueRanges });
const readback = await client.readRange({
  spreadsheetToken,
  range: `${sheetId}!A${startRow}:A${endRow}`,
});

const saved = {
  runId,
  spreadsheetToken,
  sheetId,
  reservation,
  uids,
  valueRanges,
  writeResult,
  readback,
  generatedAt: new Date().toISOString(),
};

await fs.mkdir(path.join(runRoot, "feishu"), { recursive: true });
await fs.writeFile(
  path.join(runRoot, "feishu", "reservation_and_uid_145_149.json"),
  `${JSON.stringify(saved, null, 2)}\n`,
  "utf8",
);

await updateReservationStatus({
  spreadsheetToken,
  sheetId,
  reservationId: reservation.id,
  status: "uid_written",
  owner: runId,
  patch: { rows: [145, 146, 147, 148, 149], uids },
});

console.log(JSON.stringify({ reservation, readback: readback?.values }, null, 2));
