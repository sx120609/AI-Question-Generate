import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadGeneratedIdentities, matchGeneratedIdentity } from "./generated_identities.mjs";
import { runProductionPreflight } from "./production_preflight.mjs";
import { initializeProductionWorkflowFile } from "./production_workflow_state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const AUTO_RUNS_ROOT = path.join(REPO_ROOT, "outputs", "auto_runs");
export const LOCKS_ROOT = path.join(REPO_ROOT, "outputs", "locks");
export const RESERVATIONS_ROOT = path.join(AUTO_RUNS_ROOT, "_reservations");

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;

function timestampId(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export function sanitizeId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^\w\u4e00-\u9fff.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function createRunId(prefix = "l2") {
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${sanitizeId(prefix) || "l2"}_${timestampId()}_${suffix}`;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function appendJsonl(filePath, event) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, "utf8");
}

export function assertInsideDir(targetPath, parentDir) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes allowed boundary: ${targetPath}`);
  }
}

export async function createAutoRun({
  objective,
  operator = "codex",
  count = 2,
  spreadsheetToken = "",
  sheetId = "",
  annotator = "",
  prefix = "l2",
  runId = createRunId(prefix),
  autoRunsRoot = AUTO_RUNS_ROOT,
  structureRegistryPath,
  structuralDiversityPolicyPath,
} = {}) {
  const identityConfig = await loadGeneratedIdentities();
  const generatedIdentity = matchGeneratedIdentity({ name: annotator }, identityConfig);
  if (!generatedIdentity) {
    throw new Error("createAutoRun requires --annotator from config/generated_identities.json (currently 沈礼 or 裴硬).");
  }
  const runDir = path.join(autoRunsRoot, sanitizeId(runId));
  const dirs = {
    root: runDir,
    sources: path.join(runDir, "sources"),
    attachments: path.join(runDir, "attachments"),
    drafts: path.join(runDir, "drafts"),
    feishu: path.join(runDir, "feishu"),
    qa: path.join(runDir, "qa"),
    logs: path.join(runDir, "logs"),
    tmp: path.join(runDir, "tmp"),
  };

  for (const dir of Object.values(dirs)) await ensureDir(dir);

  const productionInputPacketPath = path.join(dirs.sources, "production_input_packet.json");
  const productionInputPacket = await runProductionPreflight({
    runId: path.basename(runDir),
    count,
    outPath: productionInputPacketPath,
  });
  const productionWorkflowStatePath = path.join(dirs.sources, "production_workflow_state.json");
  const productionTracePath = path.join(dirs.qa, "production_trace.json");
  await initializeProductionWorkflowFile({
    packet: productionInputPacket,
    outPath: productionWorkflowStatePath,
    runId: path.basename(runDir),
  });
  const diversityPlanPath = path.join(dirs.sources, "diversity_plan.json");
  const factLedgerPath = path.join(dirs.sources, "fact_ledger.json");
  const sceneCardPath = path.join(dirs.sources, "scene_cards.json");
  const roleConsistencyReportPath = path.join(dirs.feishu, "role_consistency_report.json");
  const { reserveProfilesForRun } = await import("./structure_gate.mjs");
  const diversityPlan = await reserveProfilesForRun({
    runId: path.basename(runDir),
    count,
    outPath: diversityPlanPath,
    registryPath: structureRegistryPath,
    policyPath: structuralDiversityPolicyPath,
    owner: path.basename(runDir),
  });

  const manifest = {
    runId: path.basename(runDir),
    objective: objective || "L2 auto production",
    operator,
    generatedAnnotator: generatedIdentity.name,
    uidPrefix: generatedIdentity.uidPrefix,
    count,
    status: "created",
    createdAt: new Date().toISOString(),
    spreadsheetToken,
    sheetId,
    dirs,
    diversityPlanPath,
    diversityPolicyId: diversityPlan.policyId,
    diversityPolicyVersion: diversityPlan.policyVersion,
    productionProtocol: {
      protocolId: productionInputPacket.protocolId,
      inputPacketPath: productionInputPacketPath,
      workflowStatePath: productionWorkflowStatePath,
      productionTracePath,
      inputStatus: productionInputPacket.status,
      sampledReferences: productionInputPacket.inputs.referenceWorkbook.samples.map((item) => ({
        questionIndex: item.questionIndex,
        sheet: item.sheet,
        row: item.row,
        questionHash: item.questionHash,
        attachmentSummaryHash: item.attachmentSummaryHash,
      })),
      promptVersion: "sampled-two-gate-prompts-v1",
      stages: ["reference-sample", "reference-breakdown", "attachment-plan", "question-draft", "first-quality-gate", "second-language-gate", "final-compiler"],
    },
    situatedGeneration: {
      policyId: "situated-requester-v1",
      promptVersion: "situated-requester-prompts-v1",
      factLedgerPath,
      sceneCardPath,
      roleConsistencyReportPath,
      stages: ["scene-card", "requester", "field-compiler", "audit"],
      candidateCountPerScene: 3,
      note: "The scene card is a hidden generation artifact. It must never be copied into the Feishu question cell.",
    },
    boundaries: {
      writableRoots: [runDir],
      sharedWritesRequireLocks: [
        "outputs/l2_questions.tsv",
        "outputs/feishu_fill_plan_*.json",
        "outputs/auto_runs/_structure_registry.json",
        "Feishu sheet rows",
      ],
      noTouch: [
        "Rows not reserved by this run",
        "Other runs under outputs/auto_runs",
        "Existing attachments outside this run unless explicitly imported",
      ],
    },
  };

  await writeJsonAtomic(path.join(runDir, "manifest.json"), manifest);
  await appendJsonl(path.join(dirs.logs, "events.jsonl"), {
    type: "run.created",
    runId: manifest.runId,
    objective: manifest.objective,
    diversityPlanPath,
    factLedgerPath,
    sceneCardPath,
  });
  return manifest;
}

function lockDirFor(name) {
  return path.join(LOCKS_ROOT, `${sanitizeId(name)}.lock`);
}

export async function acquireLock(name, {
  owner = `${process.pid}`,
  ttlMs = DEFAULT_LOCK_TTL_MS,
  metadata = {},
  retryMs = 500,
  maxWaitMs = 30_000,
} = {}) {
  await ensureDir(LOCKS_ROOT);
  const dir = lockDirFor(name);
  const started = Date.now();

  while (true) {
    try {
      await fs.mkdir(dir);
      const lock = {
        name,
        owner,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        ttlMs,
        metadata,
      };
      await writeJsonAtomic(path.join(dir, "lock.json"), lock);
      return { ...lock, dir };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      const existing = await readJson(path.join(dir, "lock.json"), null);
      const expired = existing?.expiresAt && Date.parse(existing.expiresAt) < Date.now();
      if (expired) {
        await fs.rm(dir, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - started >= maxWaitMs) {
        throw new Error(`Lock busy: ${name}${existing?.owner ? ` owned by ${existing.owner}` : ""}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

export async function releaseLock(lock) {
  if (!lock?.dir) return;
  const existing = await readJson(path.join(lock.dir, "lock.json"), null);
  if (existing?.owner && existing.owner !== lock.owner) {
    throw new Error(`Refusing to release lock owned by ${existing.owner}: ${lock.name}`);
  }
  await fs.rm(lock.dir, { recursive: true, force: true });
}

export async function withLock(name, options, fn) {
  const lock = await acquireLock(name, options);
  try {
    return await fn(lock);
  } finally {
    await releaseLock(lock);
  }
}

export async function updateRunStatus(runDir, status, patch = {}) {
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = await readJson(manifestPath);
  if (!manifest) throw new Error(`Missing manifest: ${manifestPath}`);
  const next = {
    ...manifest,
    ...patch,
    status,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(manifestPath, next);
  await appendJsonl(path.join(runDir, "logs", "events.jsonl"), {
    type: "run.status",
    status,
    patch,
  });
  return next;
}

function reservationFile(spreadsheetToken, sheetId) {
  return path.join(
    RESERVATIONS_ROOT,
    `${sanitizeId(spreadsheetToken || "unknown")}_${sanitizeId(sheetId || "unknown")}.json`
  );
}

export async function reserveRows({
  runId,
  spreadsheetToken,
  sheetId,
  count,
  firstCandidateRow,
  minRow = 2,
  owner = runId,
}) {
  if (!runId) throw new Error("reserveRows requires runId.");
  if (!Number.isInteger(count) || count < 1) throw new Error("reserveRows requires positive count.");
  if (!Number.isInteger(firstCandidateRow) || firstCandidateRow < minRow) {
    throw new Error("reserveRows requires firstCandidateRow from the live sheet scan.");
  }

  const lockName = `sheet_${spreadsheetToken}_${sheetId}`;
  return withLock(lockName, { owner, metadata: { spreadsheetToken, sheetId, runId } }, async () => {
    const runManifest = await readJson(path.join(AUTO_RUNS_ROOT, sanitizeId(runId), "manifest.json"), null);
    const filePath = reservationFile(spreadsheetToken, sheetId);
    const state = (await readJson(filePath, null)) ?? {
      spreadsheetToken,
      sheetId,
      nextRow: firstCandidateRow,
      reservations: [],
    };

    const startRow = Math.max(Number(state.nextRow || minRow), firstCandidateRow, minRow);
    const endRow = startRow + count - 1;
    const reservation = {
      id: `${runId}_${startRow}_${endRow}`,
      runId,
      startRow,
      endRow,
      count,
      status: "reserved",
      ...(runManifest?.generatedAnnotator
        ? { generatedAnnotator: runManifest.generatedAnnotator, managedBySystem: true }
        : {}),
      createdAt: new Date().toISOString(),
    };

    state.nextRow = endRow + 1;
    state.updatedAt = new Date().toISOString();
    state.reservations.push(reservation);
    await writeJsonAtomic(filePath, state);
    return reservation;
  });
}

export async function updateReservationStatus({
  spreadsheetToken,
  sheetId,
  reservationId,
  status,
  owner = "codex",
  patch = {},
}) {
  const lockName = `sheet_${spreadsheetToken}_${sheetId}`;
  return withLock(lockName, { owner, metadata: { spreadsheetToken, sheetId, reservationId } }, async () => {
    const filePath = reservationFile(spreadsheetToken, sheetId);
    const state = await readJson(filePath);
    if (!state) throw new Error(`No reservation state for ${spreadsheetToken}/${sheetId}`);
    const reservation = state.reservations.find((item) => item.id === reservationId);
    if (!reservation) throw new Error(`Reservation not found: ${reservationId}`);
    Object.assign(reservation, patch, { status, updatedAt: new Date().toISOString() });
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(filePath, state);
    return reservation;
  });
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  return createAutoRun({
    objective: args.objective,
    operator: args.operator,
    annotator: args.annotator,
    count: args.count ? Number(args.count) : 2,
    spreadsheetToken: args.spreadsheetToken,
    sheetId: args.sheetId,
    prefix: args.prefix || "l2",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((manifest) => console.log(JSON.stringify(manifest, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
