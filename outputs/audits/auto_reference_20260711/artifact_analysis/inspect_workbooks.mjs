import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const files = process.argv.slice(2);
for (const file of files) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(file));
  const sheets = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 4000 });
  const overview = await workbook.inspect({
    kind: "workbook,sheet,table",
    maxChars: 14000,
    tableMaxRows: 8,
    tableMaxCols: 20,
    tableMaxCellChars: 180,
  });
  console.log(JSON.stringify({ file, sheets: sheets.ndjson, overview: overview.ndjson }));
}
