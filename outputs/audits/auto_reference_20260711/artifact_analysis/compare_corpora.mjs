import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const currentPath = path.resolve(root, '..', '..', 'auto_runs', 'rewrite_managed_no_blank_lines_fix_20260711', 'feishu', 'final_readback.json');
const approvedPath = path.join(here, '反馈表_backup_approved.json');

const approved = JSON.parse(fs.readFileSync(approvedPath, 'utf8')).approved.map((r) => ({
  id: r.uid,
  author: r.annotator,
  text: r.question,
  sheetRow: r.sheetRow,
}));
const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')).records.map((r) => ({
  id: r.UID,
  author: r['标注专家姓名'],
  text: r['题目'],
  sheetRow: r.sheetRow,
}));

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const features = {
  firstPerson: /(?:^|[，。！？\n])[^。！？\n]{0,35}(?:我|我们|我这边|我们这边)/,
  directRequest: /(?:帮我|你给我|你帮我|麻烦|我想让你|我需要你|希望你|请你|请帮|请先|请根据|请结合|需要你)/,
  word: /(?:Word|word|docx|文档)/,
  excel: /(?:Excel|excel|xlsx|表格)/,
  bothWordExcel: /(?=.*(?:Word|word|docx|文档))(?=.*(?:Excel|excel|xlsx|表格))/s,
  attachmentMeta: /附件(?:只能|只拿来|只用来|可以|不能|可用于|用于|能支持|无法|不足以|仅)/,
  missingMaterials: /(?:没拿到|没有拿到|还没|尚未|仍缺|缺着|缺少|待补|补件|补齐|未提供|没交)/,
  selfCheck: /(?:交稿前|定稿前|完成后|最后.{0,18}(?:核对|检查|自检|回查)|文件生成后检查|确认.{0,18}(?:一致|打开|完整))/, 
  namedDeliverable: /[《》]/,
  roleOpening: /^(?:我|我们|客户|老板|领导|产品|周[一二三四五六日天]|某|下周|今天|明天|这周|最近|针对|公司|作为|身为)/,
};

function summarize(items) {
  const lengths = items.map((x) => x.text.length);
  const paragraphs = items.map((x) => x.text.split(/\n+/).filter(Boolean).length);
  const result = {
    count: items.length,
    length: { min: Math.min(...lengths), median: median(lengths), max: Math.max(...lengths) },
    paragraphs: { min: Math.min(...paragraphs), median: median(paragraphs), max: Math.max(...paragraphs) },
  };
  for (const [name, rx] of Object.entries(features)) {
    const count = items.filter((x) => rx.test(x.text)).length;
    result[name] = { count, pct: Number((count * 100 / items.length).toFixed(1)) };
  }
  const openings = new Map();
  for (const x of items) {
    const key = x.text.slice(0, 12).replace(/\s+/g, ' ');
    openings.set(key, (openings.get(key) || 0) + 1);
  }
  result.uniqueOpening12 = openings.size;
  return result;
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(path.join(root, '反馈表.xlsx')));
const rows = workbook.worksheets.getItemAt(0).getUsedRange(true).values;
const loaderBuckets = { goodNoOpinion: 0, badHasOpinion: 0, goodStatusCounts: {}, badStatusCounts: {} };
for (const row of rows.slice(1)) {
  const uid = String(row[0] || '').trim();
  const title = String(row[1] || '').trim();
  if (!uid || !title) continue;
  const status = String(row[18] || '').trim() || '空';
  const opinion = String(row[19] || '').trim();
  if (opinion) {
    loaderBuckets.badHasOpinion++;
    loaderBuckets.badStatusCounts[status] = (loaderBuckets.badStatusCounts[status] || 0) + 1;
  } else {
    loaderBuckets.goodNoOpinion++;
    loaderBuckets.goodStatusCounts[status] = (loaderBuckets.goodStatusCounts[status] || 0) + 1;
  }
}

const chosen = [];
const modes = [
  (x) => features.firstPerson.test(x.text) && features.directRequest.test(x.text),
  (x) => !features.firstPerson.test(x.text) && features.directRequest.test(x.text),
  (x) => features.firstPerson.test(x.text) && !features.directRequest.test(x.text),
  (x) => !features.firstPerson.test(x.text) && !features.directRequest.test(x.text),
];
for (const predicate of modes) {
  const candidates = approved.filter(predicate).sort((a, b) => Math.abs(a.text.length - 950) - Math.abs(b.text.length - 950));
  for (const c of candidates) {
    if (!chosen.some((x) => x.author === c.author) && chosen.length < 8) chosen.push(c);
    if (chosen.filter((x) => predicate(x)).length >= 2) break;
  }
}

const out = {
  autoApproved: summarize(approved),
  current22: summarize(current),
  autoLoaderActualBuckets: loaderBuckets,
  representativeApproved: chosen.map((x) => ({
    ...x,
    length: x.text.length,
    firstPerson: features.firstPerson.test(x.text),
    directRequest: features.directRequest.test(x.text),
    paragraphs: x.text.split(/\n+/).filter(Boolean).length,
  })),
};
fs.writeFileSync(path.join(here, 'corpus_comparison.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ autoApproved: out.autoApproved, current22: out.current22, autoLoaderActualBuckets: out.autoLoaderActualBuckets }, null, 2));
console.log('\nREPRESENTATIVES');
for (const x of out.representativeApproved) {
  console.log(`\n[${x.sheetRow}] ${x.id} | ${x.author} | len=${x.length} | fp=${x.firstPerson} | req=${x.directRequest} | p=${x.paragraphs}`);
  console.log(x.text);
}
