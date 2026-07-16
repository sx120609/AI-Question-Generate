import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_PATH = path.join(REPO_ROOT, "build", "automation", "l2_protocol_extract.py");

function pythonCandidates() {
  return [
    process.env.PYTHON_BIN,
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe"),
    "python",
  ].filter(Boolean);
}

async function runExtractor(args) {
  const errors = [];
  for (const python of pythonCandidates()) {
    try {
      return await execFileAsync(python, [SCRIPT_PATH, ...args], {
        cwd: REPO_ROOT,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        errors.push(`${python}: not found`);
        continue;
      }
      throw new Error(`L2 production preflight failed: ${error.stderr || error.stdout || error.message}`);
    }
  }
  throw new Error(`No usable Python runtime for L2 production preflight: ${errors.join("; ")}`);
}

export async function runProductionPreflight({ runId, count, outPath, seed = "" } = {}) {
  if (!runId || !Number.isInteger(Number(count)) || Number(count) < 1 || !outPath) {
    throw new Error("runProductionPreflight requires runId, positive integer count, and outPath.");
  }
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await runExtractor([
    "--root", REPO_ROOT,
    "--run-id", String(runId),
    "--count", String(count),
    "--out", path.resolve(outPath),
    ...(seed ? ["--seed", seed] : []),
  ]);
  const packet = JSON.parse(await fs.readFile(path.resolve(outPath), "utf8"));
  if (packet.status !== "READY") {
    throw new Error(`L2 production preflight is ${packet.status}: ${JSON.stringify(packet.blockers)}`);
  }
  return packet;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    return match ? [match[1], match[2]] : [arg, true];
  }));
  runProductionPreflight({
    runId: args["run-id"],
    count: Number(args.count || 1),
    outPath: path.resolve(args.out || "outputs/production_input_packet.json"),
    seed: args.seed || "",
  })
    .then((packet) => console.log(JSON.stringify({
      ok: true,
      status: packet.status,
      runId: packet.runId,
      eligibleRows: packet.inputs.referenceWorkbook.eligibleRows,
      sampledRows: packet.inputs.referenceWorkbook.samples.map((item) => ({ sheet: item.sheet, row: item.row })),
      warnings: packet.warnings,
    }, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
