import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendJsonl, ensureDir, writeJsonAtomic } from "./run_context.mjs";

export function buildQaUrl({
  spreadsheetToken,
  sheetId,
  row,
  qaResultCol = "AC",
  qaNoteCol = "AD",
  action = "recheck_row",
  qaRowId = "",
}) {
  const url = new URL("https://qa.251104.xyz/check/sheet");
  url.searchParams.set("spreadsheet_token", spreadsheetToken);
  url.searchParams.set("sheet_id", sheetId);
  url.searchParams.set("row", String(row));
  url.searchParams.set("qa_result_col", qaResultCol);
  url.searchParams.set("qa_note_col", qaNoteCol);
  url.searchParams.set("action", action);
  if (qaRowId) url.searchParams.set("qa_row_id", qaRowId);
  url.searchParams.set("_", `${Date.now()}_${row}`);
  return url.toString();
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseQaHtml(html) {
  const status =
    html.match(/<p><b>质检状态：<\/b><span class="[^"]+">([^<]+)<\/span><\/p>/)?.[1] ??
    (html.includes("❌不通过") ? "❌不通过" : html.includes("✅通过") ? "✅通过" : "未知");
  const title = stripHtml(html.match(/<p><b>题目：<\/b>([\s\S]*?)<\/p>/)?.[1] ?? "");
  const note = stripHtml(html.match(/<div class="box"><b>质检意见：<\/b><br>([\s\S]*?)<\/div>/)?.[1] ?? "");
  return {
    status,
    passed: status.includes("通过") && !status.includes("不通过"),
    title,
    note,
    categories: classifyQaNote(note),
  };
}

export function classifyQaNote(note) {
  const categories = [];
  const text = String(note ?? "");
  const rules = [
    ["attachment_read_failed", /附件读取失败|来源链接读取失败|附件原文不可用|正文摘录\/数据口径|缺少真实材料/],
    ["attachment_english", /英文附件|英文为主|中文材料|中文摘要|中文译文/],
    ["attachment_count", /附件条数|附件数量|当前附件约|要求4-8条/],
    ["step_count", /关键步骤|步骤.*少于|8-15|当前为1条/],
    ["product_format", /产物格式|Markdown|Email|格式不明确/],
    ["scene_naturalness", /场景表达不自然|真实业务|真实用户|生硬/],
    ["prompt_style", /AI感|模板|泛泛|任务说明|报告式/],
    ["category_option", /选项|一级目录|二级目录|任务类型/],
    ["time_format", /人类完成时间|小时|h/],
  ];
  for (const [id, pattern] of rules) {
    if (pattern.test(text)) categories.push(id);
  }
  if (!categories.length && text) categories.push("other");
  return categories;
}

export async function runQaCheck(item, { outDir = "" } = {}) {
  const url = item.url ?? buildQaUrl(item);
  const response = await fetch(url, { redirect: "follow" });
  const html = await response.text();
  const parsed = parseQaHtml(html);
  const result = {
    row: item.row,
    httpStatus: response.status,
    url,
    checkedAt: new Date().toISOString(),
    ...parsed,
  };

  if (outDir) {
    await ensureDir(outDir);
    await fs.writeFile(path.join(outDir, `qa_row_${item.row}_${Date.now()}.html`), html, "utf8");
  }
  return result;
}

export async function runQaRound({ rows, spreadsheetToken, sheetId, qaResultCol = "AC", qaNoteCol = "AD", outDir = "" }) {
  const results = [];
  for (const row of rows) {
    results.push(
      await runQaCheck(
        { row, spreadsheetToken, sheetId, qaResultCol, qaNoteCol },
        { outDir }
      )
    );
  }
  if (outDir) {
    await writeJsonAtomic(path.join(outDir, `qa_round_${Date.now()}.json`), results);
  }
  return results;
}

export function summarizeQaHistory(rounds) {
  const byRow = new Map();
  for (const round of rounds) {
    for (const item of round.results ?? round) {
      const current = byRow.get(item.row) ?? [];
      current.push(item);
      byRow.set(item.row, current);
    }
  }
  return [...byRow.entries()].map(([row, items]) => {
    const latest = items.at(-1);
    const categoryCounts = new Map();
    for (const item of items) {
      for (const category of item.categories ?? []) {
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
    }
    return {
      row,
      latestStatus: latest?.status,
      latestNote: latest?.note,
      rounds: items.length,
      categoryCounts: Object.fromEntries(categoryCounts.entries()),
    };
  });
}

export function shouldStopForLikelyBug(rowHistory, localEvidence = {}) {
  if ((rowHistory.rounds ?? 0) < 3) return { stop: false, reason: "Need at least three QA rounds." };
  const counts = rowHistory.categoryCounts ?? {};
  const repeatedAttachmentBug =
    (counts.attachment_english ?? 0) >= 3 &&
    localEvidence.attachmentsUploaded === true &&
    localEvidence.attachmentsOpen === true &&
    localEvidence.attachmentContentHasChineseSummary === true;
  const repeatedStepBug =
    (counts.step_count ?? 0) >= 3 &&
    localEvidence.stepCountOk === true &&
    localEvidence.stepsUseAsciiNumbering === true;
  const repeatedCountBug =
    (counts.attachment_count ?? 0) >= 3 &&
    localEvidence.attachmentCountOk === true &&
    localEvidence.attachmentsUploaded === true;

  if (repeatedAttachmentBug || repeatedStepBug || repeatedCountBug) {
    return {
      stop: true,
      reason: "Same QA category repeated for at least three rounds while local evidence passes; treat as likely QA bug.",
      categories: Object.keys(counts).filter((key) => counts[key] >= 3),
    };
  }
  return { stop: false, reason: "Repeated issue is not locally cleared." };
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const rows = String(args.rows ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter(Boolean);
  if (!rows.length) throw new Error("--rows=376,377 is required.");
  const results = await runQaRound({
    rows,
    spreadsheetToken: args.spreadsheetToken,
    sheetId: args.sheetId,
    qaResultCol: args.qaResultCol || "AC",
    qaNoteCol: args.qaNoteCol || "AD",
    outDir: args.outDir,
  });
  if (args.log) {
    await appendJsonl(args.log, { type: "qa.round", results });
  }
  console.log(JSON.stringify(results, null, 2));
}
