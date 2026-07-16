import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

for (const file of process.argv.slice(2)) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(file));
  const sheet = workbook.worksheets.getItemAt(0);
  const values = sheet.getUsedRange(true).values;
  const rows = values.slice(1).map((row, index) => ({
    sheetRow: index + 2,
    uid: String(row[0] ?? "").trim(),
    question: String(row[1] ?? "").trim(),
    summary: String(row[6] ?? "").trim(),
    attachments: String(row[9] ?? "").trim(),
    attachmentSummary: String(row[11] ?? "").trim(),
    formats: String(row[12] ?? "").trim(),
    products: String(row[13] ?? "").trim(),
    steps: String(row[14] ?? "").trim(),
    annotator: String(row[16] ?? "").trim(),
    status: String(row[18] ?? "").trim(),
    feedback: String(row[19] ?? "").trim(),
  })).filter((row) => row.uid || row.question);
  const enriched = rows.map((row) => ({
    ...row,
    questionLength: [...row.question.replace(/\s+/gu, "")].length,
    paragraphCount: row.question ? row.question.split(/\n+/gu).filter(Boolean).length : 0,
    sentenceCount: (row.question.match(/[。！？!?]/gu) ?? []).length,
    commaCount: (row.question.match(/[，,]/gu) ?? []).length,
    colonCount: (row.question.match(/[：:]/gu) ?? []).length,
    semicolonCount: (row.question.match(/[；;]/gu) ?? []).length,
    firstPerson: /(?:^|[，。！？\s])(?:我|我们|咱们|这边)/u.test(row.question),
    directRequest: /请|帮我|给我|需要你|麻烦你|你来|你先|你再|能不能|能否/u.test(row.question),
    stepCount: (row.steps.match(/(?:^|\n)(?:第?\d+步|\d+[.、])/gu) ?? []).length,
  }));
  const statusCounts = Object.fromEntries(Object.entries(enriched.reduce((acc, row) => {
    const key = row.status || "空";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]));
  const approved = enriched.filter((row) => /通过/u.test(row.status) && !/不通过/u.test(row.status));
  const out = {
    source: path.resolve(file),
    rowCount: enriched.length,
    statusCounts,
    approvedCount: approved.length,
    approved,
  };
  const stem = path.basename(file, path.extname(file));
  await fs.writeFile(`${stem}_approved.json`, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ file, rowCount: enriched.length, statusCounts, approvedCount: approved.length }));
}
