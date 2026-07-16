import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const runRoot = path.join(root, "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2");
const queuePath = path.join(runRoot, "feishu/feishu_attachment_upload_queue_145_146_147_148_149.json");
const outPath = path.join(runRoot, "feishu/attachment_upload_results_145_149.json");
const cellsPath = path.join(runRoot, "feishu/feishu_j_rich_text_cells_145_149.json");
const readbackPath = path.join(runRoot, "feishu/feishu_j_readback_145_149.json");

const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";

const nodeExe = "C:/Users/Carbene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe";
const pnpmMjs =
  "C:/Users/Carbene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs";
const runtimePath =
  "C:/Users/Carbene/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin;" +
  "C:/Users/Carbene/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin;";

function mimeFor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

function collectProcess(args, { inputStream = null, inputText = "", timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(nodeExe, [pnpmMjs, "--silent", "dlx", "@larksuite/cli@latest", ...args], {
      cwd: root,
      env: { ...process.env, PATH: runtimePath + (process.env.PATH || "") },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (inputStream) inputStream.pipe(child.stdin);
    else child.stdin.end(inputText);
  });
}

function parseLastJsonObject(text) {
  const source = String(text || "").trim();
  try {
    return JSON.parse(source);
  } catch {
    // Keep scanning.
  }
  for (let start = source.lastIndexOf("{"); start >= 0; start = source.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(source.slice(start));
    } catch {
      // Keep scanning.
    }
  }
  throw new Error(`Unable to parse JSON output: ${source.slice(0, 800)}`);
}

async function uploadFile(file) {
  const stat = await fsp.stat(file.path);
  const data = {
    file_name: file.fileName,
    parent_type: "sheet_file",
    parent_node: spreadsheetToken,
    size: String(stat.size),
  };
  const result = await collectProcess(
    [
      "api",
      "POST",
      "/open-apis/drive/v1/medias/upload_all",
      "--as",
      "user",
      "--format",
      "json",
      "--data",
      JSON.stringify(data),
      "--file",
      "file=-",
    ],
    { inputStream: fs.createReadStream(file.path) }
  );
  const parsed = parseLastJsonObject([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (result.code !== 0 || parsed.ok === false) {
    throw new Error(`Upload failed for ${file.fileName}: ${JSON.stringify(parsed).slice(0, 1000)}`);
  }
  const payload = parsed.data?.data ?? parsed.data ?? parsed;
  const token = payload.file_token || payload.fileToken || payload.token;
  if (!token) throw new Error(`Upload response missing file token for ${file.fileName}: ${JSON.stringify(parsed)}`);
  return {
    fileName: file.fileName,
    path: file.path,
    size: stat.size,
    mimeType: mimeFor(file.fileName),
    fileToken: token,
    version: payload.version || "",
  };
}

async function setCells(cells) {
  const result = await collectProcess(
    [
      "sheets",
      "+cells-set",
      "--as",
      "user",
      "--format",
      "json",
      "--spreadsheet-token",
      spreadsheetToken,
      "--sheet-id",
      sheetId,
      "--range",
      "J145:J149",
      "--cells",
      "-",
    ],
    { inputText: JSON.stringify(cells) }
  );
  const parsed = parseLastJsonObject([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (result.code !== 0 || parsed.ok === false || parsed.code) {
    throw new Error(`cells-set failed: ${JSON.stringify(parsed).slice(0, 1200)}`);
  }
  return parsed;
}

async function readJRange() {
  const result = await collectProcess([
    "api",
    "GET",
    `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(`${sheetId}!J145:J149`)}`,
    "--as",
    "user",
    "--format",
    "json",
  ]);
  const parsed = parseLastJsonObject([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (result.code !== 0 || parsed.ok === false) {
    throw new Error(`readback failed: ${JSON.stringify(parsed).slice(0, 1200)}`);
  }
  return parsed;
}

const queue = JSON.parse(await fsp.readFile(queuePath, "utf8"));
const uploadResults = [];
const cells = [];

for (const item of queue.queue) {
  const uploaded = [];
  for (const file of item.files) {
    uploaded.push(await uploadFile(file));
  }
  uploadResults.push({ row: item.row, address: item.address, fileCount: uploaded.length, files: uploaded });

  const richText = [];
  for (const [index, file] of uploaded.entries()) {
    if (index > 0) richText.push({ type: "text", text: "\n" });
    richText.push({
      type: "attachment",
      text: file.fileName,
      attachment_name: file.fileName,
      attachment_token: file.fileToken,
      file_size: file.size,
      mime_type: file.mimeType,
    });
  }
  cells.push([{ rich_text: richText }]);
}

await fsp.writeFile(cellsPath, `${JSON.stringify(cells, null, 2)}\n`, "utf8");
const setResult = await setCells(cells);
const readback = await readJRange();
await fsp.writeFile(
  outPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), uploadResults, setResult }, null, 2)}\n`,
  "utf8"
);
await fsp.writeFile(readbackPath, `${JSON.stringify(readback, null, 2)}\n`, "utf8");

const values = readback.data?.valueRange?.values || readback.data?.valueRange?.values || [];
const attachmentCounts = values.map((row) => {
  const cell = row?.[0];
  if (!Array.isArray(cell)) return 0;
  return cell.filter((part) => part?.type === "attachment" || part?.fileToken || part?.attachment_token).length;
});
console.log(JSON.stringify({ uploaded: uploadResults.reduce((sum, row) => sum + row.fileCount, 0), attachmentCounts }, null, 2));
