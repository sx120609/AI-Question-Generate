import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFeishuClient, findFilesByName, parseA1Span, rangeForCell } from "./feishu_openapi_client.mjs";
import { assertClearQuestionRequest, assertNaturalQuestionPresentation } from "./language_style.mjs";
import { appendJsonl, ensureDir, withLock, writeJsonAtomic } from "./run_context.mjs";
import { verifyReleaseReceipt } from "./release_gate.mjs";
import { verifyProductionTraceReceipt } from "./production_trace_gate.mjs";
import { registerStructureReceipt } from "./structure_gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

const DEFAULT_EXCLUDE_COLUMNS = new Set(["J"]);

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

function splitCsv(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitAttachmentNames(value) {
  return String(value ?? "")
    .split(/[；;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function readBackCellText(value) {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map(readBackCellText).join("");
  if (typeof value === "object") {
    return readBackCellText(value.text ?? value.value ?? value.rich_text ?? value.link ?? value.url ?? "");
  }
  return "";
}

function sheetIdFromRange(range) {
  const text = String(range ?? "");
  return text.includes("!") ? text.split("!", 1)[0] : "";
}

function spanContainsCell(span, cell) {
  if (!span || !cell?.startRow || !cell?.endRow) return false;
  return (
    cell.startColumn === cell.endColumn &&
    cell.startRow === cell.endRow &&
    cell.startColumn >= span.startColumn &&
    cell.startColumn <= span.endColumn &&
    (span.startRow === null || cell.startRow >= span.startRow) &&
    (span.endRow === null || cell.startRow <= span.endRow)
  );
}

function selectedDropdownValues(raw, multipleValues) {
  if (raw === null || raw === undefined || raw === "") return [];
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  const text = String(raw).trim();
  if (!multipleValues) return [text];
  return text.split(/[,，\n]+/u).map((item) => item.trim()).filter(Boolean);
}

export function validateDropdownValueRanges({ valueRanges = [], dataValidations = [], sheetId = "" } = {}) {
  const checks = [];
  const errors = [];

  for (const valueRange of valueRanges) {
    const cellRange = valueRange.range || (valueRange.address ? rangeForCell(sheetId, valueRange.address) : "");
    const cellSheetId = sheetIdFromRange(cellRange) || sheetId;
    const cell = parseA1Span(cellRange);
    if (!cell || cell.startColumn !== cell.endColumn || cell.startRow !== cell.endRow) continue;

    for (const validation of dataValidations) {
      if (validation?.dataValidationType !== "list") continue;
      const applies = (validation.ranges || []).some((validationRange) => {
        const validationSheetId = sheetIdFromRange(validationRange);
        if (validationSheetId && cellSheetId && validationSheetId !== cellSheetId) return false;
        return spanContainsCell(parseA1Span(validationRange), cell);
      });
      if (!applies) continue;

      const allowed = (validation.conditionValues || []).map((item) => String(item));
      const selected = selectedDropdownValues(
        valueRange.values?.[0]?.[0],
        validation.options?.multipleValues === true,
      );
      const invalid = selected.filter((item) => !allowed.includes(item));
      const address = valueRange.address || cellRange.split("!").at(-1)?.split(":")[0] || cellRange;
      checks.push({ address, selected, allowedCount: allowed.length, ok: invalid.length === 0 });
      if (invalid.length) {
        errors.push(`${address} contains values outside the configured dropdown: ${invalid.join(", ")}`);
      }
      break;
    }
  }

  if (errors.length) {
    throw new Error(`Feishu dropdown validation failed: ${errors.join("; ")}`);
  }
  return {
    required: checks.length > 0,
    verified: true,
    checkedCells: checks.length,
    checks,
  };
}

function planRowsInRange(plan, rows) {
  const allowed = rows?.length ? new Set(rows.map(Number)) : null;
  return plan.rows.filter((row) => !allowed || allowed.has(Number(row.sheetRow)));
}

export async function verifyReleaseGateForSubmission({
  plan,
  rows = [],
  valueRanges = [],
  receiptPath = "",
  planPath = "",
  policyPath,
} = {}) {
  const writesNarrativeFields = valueRanges.some((item) =>
    ["B", "G", "L", "N", "O"].includes(item.address?.[0]?.toUpperCase())
  );
  if (!writesNarrativeFields) return { required: false, verified: false, receiptPath: "" };
  const resolvedReceiptPath = receiptPath || path.join(path.dirname(planPath), "release_gate_receipt.json");
  if (!(await fs.access(resolvedReceiptPath).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  }))) {
    throw new Error(`Release-gate receipt is required before writing narrative fields: ${resolvedReceiptPath}`);
  }
  const selectedPlanRows = planRowsInRange(plan, rows);
  const receiptCheck = await verifyReleaseReceipt({ receiptPath: resolvedReceiptPath, rows: selectedPlanRows, policyPath });
  if (!receiptCheck.ok) {
    throw new Error(`Release-gate receipt validation failed: ${receiptCheck.errors.join("; ")}`);
  }
  return {
    required: true,
    verified: true,
    receiptPath: path.resolve(resolvedReceiptPath),
    releaseGateId: receiptCheck.receipt.releaseGateId,
    policyId: receiptCheck.receipt.policyId,
    policyVersion: receiptCheck.receipt.policyVersion,
    naturalnessStatus: receiptCheck.receipt.naturalness.status,
    roleConsistencyStatus: receiptCheck.receipt.roleConsistency?.status,
    sceneCardGateId: receiptCheck.receipt.roleConsistency?.gateId,
    structureStatus: receiptCheck.receipt.structure.gateStatus,
  };
}

// Compatibility export for callers that still use the old function name. The
// implementation now requires a combined release receipt, never a bare
// structure receipt.
export const verifyStructureGateForSubmission = verifyReleaseGateForSubmission;

export function buildValueRangesFromPlan(plan, { sheetId, rows = [], columns = [], excludeColumns = [] } = {}) {
  const includeColumns = columns.length ? new Set(columns.map((item) => item.toUpperCase())) : null;
  const excluded = new Set([...DEFAULT_EXCLUDE_COLUMNS, ...excludeColumns.map((item) => item.toUpperCase())]);
  const valueRanges = [];
  const skipped = [];

  for (const row of planRowsInRange(plan, rows)) {
    for (const update of row.updates) {
      const column = update.column.toUpperCase();
      if (includeColumns && !includeColumns.has(column)) {
        skipped.push({ address: update.address, reason: "not-included" });
        continue;
      }
      if (excluded.has(column)) {
        skipped.push({ address: update.address, reason: "excluded" });
        continue;
      }
      valueRanges.push({
        range: rangeForCell(sheetId, update.address),
        values: [[update.value]],
        address: update.address,
        field: update.field,
        chars: String(update.value ?? "").length,
      });
    }
  }

  return { valueRanges, skipped };
}

export function verifyQuestionPresentationForSubmission({
  valueRanges = [],
} = {}) {
  const questionRanges = valueRanges.filter((item) => item.address?.[0]?.toUpperCase() === "B");
  const attachmentContentRanges = valueRanges.filter((item) => item.address?.[0]?.toUpperCase() === "L");
  if (!questionRanges.length && !attachmentContentRanges.length) {
    return {
      required: false,
      verified: false,
      mode: "not-applicable",
      paragraphCounts: {},
      attachmentContentLineCounts: {},
    };
  }
  const paragraphCounts = {};
  for (const item of questionRanges) {
    const presentation = assertNaturalQuestionPresentation(item.values?.[0]?.[0], { label: item.address });
    assertClearQuestionRequest(item.values?.[0]?.[0], { label: item.address });
    paragraphCounts[item.address] = presentation.paragraphCount;
  }
  const attachmentContentLineCounts = {};
  for (const item of attachmentContentRanges) {
    const value = String(item.values?.[0]?.[0] ?? "").replace(/\r\n?/gu, "\n").trim();
    if (/\n\s*\n/u.test(value)) {
      throw new Error(`${item.address} 附件内容 must not contain blank lines; separate entries with one line break.`);
    }
    attachmentContentLineCounts[item.address] = value ? value.split("\n").length : 0;
  }
  return {
    required: true,
    verified: true,
    mode: "narrative-no-blank-lines-v5",
    paragraphCounts,
    attachmentContentLineCounts,
  };
}

export async function buildAttachmentQueueFromPlan(plan, { rows = [], attachmentRoot = path.join(root, "outputs", "attachments") } = {}) {
  const index = await findFilesByName(attachmentRoot);
  const queue = [];
  const missing = [];

  for (const row of planRowsInRange(plan, rows)) {
    const attachmentCell = row.updates.find((item) => item.column.toUpperCase() === "J");
    if (!attachmentCell?.value) continue;

    const fileNames = splitAttachmentNames(attachmentCell.value);
    const files = [];
    for (const fileName of fileNames) {
      const matches = index.get(fileName) || [];
      if (matches.length === 1) {
        files.push({ fileName, path: matches[0] });
      } else if (matches.length > 1) {
        missing.push({ row: row.sheetRow, address: attachmentCell.address, fileName, reason: "duplicate-file-name", matches });
      } else {
        missing.push({ row: row.sheetRow, address: attachmentCell.address, fileName, reason: "not-found" });
      }
    }

    queue.push({
      row: row.sheetRow,
      address: attachmentCell.address,
      fileCount: files.length,
      files,
    });
  }

  return { queue, missing };
}

async function loadPlan(planPath) {
  return JSON.parse(await fs.readFile(planPath, "utf8"));
}

async function writeDryRun({ outPath, payload }) {
  await writeJsonAtomic(outPath, payload);
  return outPath;
}

export async function submitFeishuSheetPlan({
  planPath,
  wikiUrl = "",
  spreadsheetToken = "",
  sheetId = "",
  sheetTitle = "",
  rows = [],
  columns = [],
  excludeColumns = [],
  attachmentRoot = path.join(root, "outputs", "attachments"),
  outDir = path.join(root, "outputs"),
  apply = false,
  verify = false,
  transport = "",
  buildAttachments = true,
  allowMissingAttachments = false,
  releaseReceiptPath = "",
  structureReceiptPath = "",
  processReceiptPath = "",
  testOnlyBypassProductionProtocol = false,
  structureRegistryPath,
  policyPath,
  logPath = "",
  lockOwner = `feishu_submit_${process.pid}`,
} = {}) {
  const plan = await loadPlan(planPath);
  await ensureDir(outDir);

  const dryTarget = {
    spreadsheetToken: spreadsheetToken || "",
    sheetId: sheetId || "",
    wikiUrl,
    sheetTitle,
  };

  let target = dryTarget;
  if (apply || verify || (!sheetId && (wikiUrl || spreadsheetToken))) {
    const client = await createFeishuClient({ transport });
    target = await client.resolveSpreadsheetTarget({ url: wikiUrl, spreadsheetToken, sheetId, sheetTitle });
  }

  if (!target.sheetId) {
    throw new Error("Missing sheetId. Provide --sheet-id for dry-run, or provide auth + --wiki-url/--spreadsheet-token to resolve it.");
  }

  const { valueRanges, skipped } = buildValueRangesFromPlan(plan, {
    sheetId: target.sheetId,
    rows,
    columns,
    excludeColumns,
  });
  const suppliedReleaseReceiptPath = releaseReceiptPath || structureReceiptPath;
  const releaseGate = (apply || Boolean(suppliedReleaseReceiptPath))
    ? await verifyReleaseGateForSubmission({
        plan,
        rows,
        valueRanges,
        receiptPath: suppliedReleaseReceiptPath,
        planPath,
        policyPath,
      })
    : { required: false, verified: false, receiptPath: "" };
  const narrativeWrite = valueRanges.some((item) =>
    ["B", "G", "L", "N", "O"].includes(item.address?.[0]?.toUpperCase())
  );
  if (testOnlyBypassProductionProtocol && !process.env.NODE_TEST_CONTEXT) {
    throw new Error("Production protocol bypass is restricted to the Node test runner.");
  }
  let productionProcess = {
    required: narrativeWrite && !testOnlyBypassProductionProtocol,
    verified: false,
    receiptPath: "",
    ...(testOnlyBypassProductionProtocol ? { testOnlyBypass: true } : {}),
  };
  if (productionProcess.required) {
    const resolvedProcessReceiptPath = path.resolve(
      processReceiptPath || path.join(path.dirname(planPath), "production_trace_gate_receipt.json"),
    );
    const checked = await verifyProductionTraceReceipt({
      receiptPath: resolvedProcessReceiptPath,
      fillPlanPath: planPath,
    });
    productionProcess = {
      required: true,
      verified: true,
      receiptPath: checked.receiptPath,
      gateId: checked.receipt.gateId,
      status: checked.receipt.status,
    };
  }
  const questionPresentation = verifyQuestionPresentationForSubmission({
    valueRanges,
  });
  const attachmentQueue = buildAttachments
    ? await buildAttachmentQueueFromPlan(plan, { rows, attachmentRoot })
    : { queue: [], missing: [] };
  if (attachmentQueue.missing.length && !allowMissingAttachments) {
    throw new Error(`Missing attachment files: ${attachmentQueue.missing.map((item) => item.fileName).join(", ")}`);
  }

  let structureRegistration = { required: false, registered: false, status: "" };
  if (apply && releaseGate.required) {
    const registration = await registerStructureReceipt({
      receiptPath: releaseGate.receiptPath,
      status: "reserved",
      registryPath: structureRegistryPath,
      policyPath,
      owner: lockOwner,
    });
    structureRegistration = {
      required: true,
      registered: true,
      status: "reserved",
      count: registration.registered,
      registryPath: registration.registryPath,
    };
  }

  const rowLabel = rows.length ? rows.join("_") : `${plan.startRow}_${plan.startRow + plan.count - 1}`;
  const dryRunPath = path.join(outDir, `feishu_api_value_ranges_${rowLabel}.json`);
  const queuePath = buildAttachments ? path.join(outDir, `feishu_attachment_upload_queue_${rowLabel}.json`) : "";
  const dryRunPayload = {
    generatedAt: new Date().toISOString(),
    apply,
    transport: transport || "auto",
    target,
    planPath: path.resolve(planPath),
    rows: rows.length ? rows : plan.rows.map((row) => row.sheetRow),
    questionPresentation,
    releaseGate,
    productionProcess,
    valueRangeCount: valueRanges.length,
    skipped,
    valueRanges,
  };

  await writeDryRun({ outPath: dryRunPath, payload: dryRunPayload });
  if (buildAttachments) {
    await writeJsonAtomic(queuePath, {
      generatedAt: new Date().toISOString(),
      attachmentRoot: path.resolve(attachmentRoot),
      note: "Upload these real files into the matching J-column cells. Do not write this manifest into Feishu.",
      ...attachmentQueue,
    });
  }

  let apiResult = null;
  let verification = [];
  let dropdownValidation = {
    required: false,
    verified: false,
    checkedCells: 0,
    checks: [],
  };
  if (apply) {
    const validationClient = await createFeishuClient({ transport });
    const validationRules = await validationClient.getDataValidations({
      spreadsheetToken: target.spreadsheetToken,
      range: target.sheetId,
    });
    dropdownValidation = validateDropdownValueRanges({
      valueRanges,
      dataValidations: validationRules.dataValidations,
      sheetId: target.sheetId,
    });
    const lockName = `feishu_sheet_${target.spreadsheetToken}_${target.sheetId}`;
    await withLock(lockName, { owner: lockOwner, metadata: { rows, valueRangeCount: valueRanges.length } }, async () => {
      if (releaseGate.required) {
        // Re-verify after acquiring the sheet lock so a scene card, fact ledger,
        // gate report, candidate, or fill plan cannot change between preflight
        // and the physical API call.
        await verifyReleaseGateForSubmission({
          plan,
          rows,
          valueRanges,
          receiptPath: releaseGate.receiptPath,
          planPath,
          policyPath,
        });
      }
      if (productionProcess.required) {
        await verifyProductionTraceReceipt({
          receiptPath: productionProcess.receiptPath,
          fillPlanPath: planPath,
        });
      }
      const client = await createFeishuClient({ transport });
      apiResult = await client.batchUpdateValues({
        spreadsheetToken: target.spreadsheetToken,
        valueRanges: valueRanges.map(({ range, values }) => ({ range, values })),
        releaseReceiptPath: releaseGate.receiptPath,
      });
      if (verify) {
        for (const valueRange of valueRanges) {
          const readBack = await client.readRange({
            spreadsheetToken: target.spreadsheetToken,
            range: valueRange.range,
          });
          const actual = readBackCellText(readBack?.values?.[0]?.[0]);
          const expected = String(valueRange.values[0][0] ?? "");
          verification.push({
            address: valueRange.address,
            ok: actual === expected,
            ...(actual === expected ? {} : { actualChars: actual.length, expectedChars: expected.length }),
          });
        }
      }
    });
    const submissionVerified = !verify || verification.every((item) => item.ok);
    if (structureRegistration.registered && submissionVerified) {
      const registration = await registerStructureReceipt({
        receiptPath: releaseGate.receiptPath,
        status: "submitted",
        registryPath: structureRegistryPath,
        policyPath,
        owner: lockOwner,
      });
      structureRegistration = {
        ...structureRegistration,
        status: "submitted",
        count: registration.registered,
      };
    }
  }

  const result = {
    ok: true,
    dryRunPath,
    queuePath,
    apply,
    transport: transport || "auto",
    valueRangeCount: valueRanges.length,
    attachmentQueueCount: attachmentQueue.queue.length,
    missingAttachmentCount: attachmentQueue.missing.length,
    questionPresentation,
    releaseGate,
    productionProcess,
    dropdownValidation,
    structureRegistration,
    apiResult,
    verification,
  };

  if (logPath) {
    await appendJsonl(logPath, { type: "feishu.sheet.submit", ...result });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const planPath = resolveFromRoot(args.plan || "outputs/feishu_fill_plan_376_377.json");
  const rows = splitCsv(args.rows).map(Number).filter(Boolean);
  const columns = splitCsv(args.columns);
  const excludeColumns = splitCsv(args["exclude-columns"]);
  const result = await submitFeishuSheetPlan({
    planPath,
    wikiUrl: args["wiki-url"] || args.url || "",
    spreadsheetToken: args["spreadsheet-token"] || "",
    sheetId: args["sheet-id"] || "",
    sheetTitle: args["sheet-title"] || "",
    rows,
    columns,
    excludeColumns,
    attachmentRoot: resolveFromRoot(args["attachment-root"] || "outputs/attachments"),
    outDir: resolveFromRoot(args["out-dir"] || "outputs"),
    apply: args.apply === true,
    verify: args.verify === true,
    transport: args.transport || "",
    allowMissingAttachments: args["allow-missing-attachments"] === true,
    releaseReceiptPath: args["release-receipt"] ? resolveFromRoot(args["release-receipt"]) : "",
    structureReceiptPath: args["structure-receipt"] ? resolveFromRoot(args["structure-receipt"]) : "",
    processReceiptPath: args["process-receipt"] ? resolveFromRoot(args["process-receipt"]) : "",
    structureRegistryPath: args["structure-registry"] ? resolveFromRoot(args["structure-registry"]) : undefined,
    policyPath: args.policy ? resolveFromRoot(args.policy) : undefined,
    buildAttachments: args["skip-attachments"] !== true,
    logPath: args.log ? resolveFromRoot(args.log) : "",
    lockOwner: args.owner || `feishu_submit_${process.pid}`,
  });
  console.log(JSON.stringify(result, null, 2));
}
