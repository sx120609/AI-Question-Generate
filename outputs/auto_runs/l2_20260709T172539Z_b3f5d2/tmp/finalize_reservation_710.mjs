import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateReservationStatus, updateRunStatus } from "../../../../build/automation/run_context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.resolve(__dirname, "..");

const reservation = await updateReservationStatus({
  spreadsheetToken: "ByAysb2Cdh9V2wtISbJc6Z01nwc",
  sheetId: "49e351",
  reservationId: "l2_20260709T172539Z_b3f5d2_172_174",
  status: "accepted",
  owner: "codex_finalize_shenli_710",
  patch: {
    rows: [172, 173, 174],
    uids: ["沈礼_7.10_01", "沈礼_7.10_02", "沈礼_7.10_03"],
    qa: {
      resultColumn: "AT",
      noteColumn: "AU",
      status: "passed",
      rows: [172, 173, 174],
    },
    completedAt: new Date().toISOString(),
  },
});

const manifest = await updateRunStatus(runDir, "accepted", {
  completedRows: [172, 173, 174],
  completedUids: ["沈礼_7.10_01", "沈礼_7.10_02", "沈礼_7.10_03"],
  qaStatus: "passed",
});

console.log(JSON.stringify({ reservation, manifestStatus: manifest.status }, null, 2));
