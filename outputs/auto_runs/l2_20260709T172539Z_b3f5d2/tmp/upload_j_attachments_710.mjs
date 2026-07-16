import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const depRoot = path.resolve(path.dirname(process.execPath), "..", "..");
const pnpmMjs = path.join(depRoot, "node", "node_modules", "pnpm", "bin", "pnpm.mjs");
const nodeBin = path.dirname(process.execPath);
const toolsBin = path.join(depRoot, "bin");
const pathDelimiter = process.platform === "win32" ? ";" : ":";

const queuePath = path.resolve(root, "outputs/auto_runs/l2_20260709T172539Z_b3f5d2/feishu/feishu_attachment_upload_queue_172_173_174.json");
const outDir = path.resolve(root, "outputs/auto_runs/l2_20260709T172539Z_b3f5d2/feishu");
const uploadManifestPath = path.join(outDir, "feishu_attachment_sheet_media_uploads_172_173_174.json");
const cellsPath = path.join(outDir, "feishu_attachment_cells_j172_j174.json");
const setResultPath = path.join(outDir, "feishu_attachment_cells_set_result_172_174.json");

const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";

function cliEnv() {
  return {
    ...process.env,
    PATH: [nodeBin, toolsBin, process.env.PATH || ""].filter(Boolean).join(pathDelimiter),
  };
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("lark-cli returned empty stdout.");
  return JSON.parse(text);
}

function runLarkCli(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpmMjs, "--silent", "dlx", "@larksuite/cli@latest", ...args], {
      cwd: root,
      env: cliEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`lark-cli timed out after ${timeoutMs} ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`lark-cli exited ${code}: ${stderr || stdout}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function uploadFile(file) {
  const stats = await fs.stat(file.path);
  const relativeFilePath = path.relative(root, file.path).replace(/\\/g, "/");
  const result = await runLarkCli([
    "api",
    "POST",
    "/open-apis/drive/v1/medias/upload_all",
    "--as",
    "user",
    "--data",
    JSON.stringify({
      file_name: file.fileName,
      parent_type: "sheet_file",
      parent_node: spreadsheetToken,
      size: String(stats.size),
    }),
    "--file",
    `file=${relativeFilePath}`,
    "--format",
    "json",
  ]);
  const parsed = parseJsonFromStdout(result.stdout);
  const payload = parsed.ok === true ? parsed.data : parsed;
  const token = payload?.file_token || payload?.data?.file_token;
  if (!token) {
    throw new Error(`Upload failed for ${file.fileName}: ${result.stdout}`);
  }
  return {
    fileName: file.fileName,
    path: file.path,
    size: payload?.size ?? stats.size,
    mimeType: mimeType(file.path),
    attachmentToken: token,
    driveUrl: payload?.url || "",
  };
}

function toRichText(files) {
  const segments = [];
  for (const file of files) {
    if (segments.length) segments.push({ type: "text", text: "\n" });
    segments.push({
      type: "attachment",
      text: file.fileName,
      attachment_token: file.attachmentToken,
      file_size: file.size,
      mime_type: file.mimeType,
    });
  }
  return segments;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const queue = JSON.parse(await fs.readFile(queuePath, "utf8")).queue;
  const previous = await readJsonIfExists(uploadManifestPath, { uploads: [] });
  const byKey = new Map(previous.uploads.map((item) => [`${item.path}\u0000${item.fileName}`, item]));

  const rows = [];
  for (const row of queue) {
    const uploads = [];
    for (const file of row.files) {
      const key = `${file.path}\u0000${file.fileName}`;
      let upload = byKey.get(key);
      if (!upload?.attachmentToken) {
        upload = await uploadFile(file);
        byKey.set(key, upload);
      }
      uploads.push(upload);
    }
    rows.push({ row: row.row, address: row.address, uploads });
    await fs.writeFile(
      uploadManifestPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), uploads: [...byKey.values()], rows }, null, 2),
      "utf8"
    );
  }

  const cells = rows.map((row) => [{ rich_text: toRichText(row.uploads) }]);
  await fs.writeFile(cellsPath, JSON.stringify(cells, null, 2), "utf8");

  const setResult = await runLarkCli([
    "sheets",
    "+cells-set",
    "--as",
    "user",
    "--spreadsheet-token",
    spreadsheetToken,
    "--sheet-id",
    sheetId,
    "--range",
    "J172:J174",
    "--cells",
    `@${path.relative(root, cellsPath).replace(/\\/g, "/")}`,
    "--format",
    "json",
  ]);
  await fs.writeFile(setResultPath, setResult.stdout, "utf8");

  const parsedSet = parseJsonFromStdout(setResult.stdout);
  console.log(JSON.stringify({ ok: parsedSet.ok === true, rows: rows.map((row) => ({ row: row.row, count: row.uploads.length })), setResultPath, uploadManifestPath, cellsPath }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
