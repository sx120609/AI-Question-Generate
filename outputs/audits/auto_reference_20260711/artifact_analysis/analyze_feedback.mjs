import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(path.dirname(here), '反馈表_backup.xlsx');
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(source));
const rows = workbook.worksheets.getItemAt(0).getUsedRange(true).values.slice(1)
  .map((row, i) => ({
    sheetRow: i + 2,
    uid: String(row[0] ?? '').trim(),
    question: String(row[1] ?? '').trim(),
    status: String(row[18] ?? '').trim(),
    feedback: String(row[19] ?? '').trim(),
  }))
  .filter((r) => r.uid && r.question);

const rejected = rows.filter((r) => /需要修改|废弃/u.test(r.status));
const themes = {
  '信息不足或附件不支撑': /信息不足|缺少|附件.*(?:无法|不足|缺)|支撑|数据不足|材料不足/u,
  '真实自然或AI感': /真实|自然|AI|人工智能生成|人机|生硬|刻意|不符合.*表达/u,
  '背景或题面过长': /背景.*(?:长|冗)|题目.*(?:长|冗)|过长|冗余|啰嗦/u,
  '身份或视角问题': /身份|角色|上帝视角|主体不明|个人具体/u,
  'L2推理或复杂度不足': /L2|推理|因果|复杂度|简单罗列|难度/u,
  '产物要求问题': /产物|输出|交付/u,
  '附件描述过细': /附件.*(?:详细|精简|逐个|用途|格式)/u,
};

const counts = {};
for (const [name, rx] of Object.entries(themes)) counts[name] = rejected.filter((r) => rx.test(r.feedback)).length;
console.log(JSON.stringify({ totalRows: rows.length, rejected: rejected.length, themeCounts: counts }, null, 2));

const natural = rejected.filter((r) => themes['真实自然或AI感'].test(r.feedback));
console.log(`\nNATURALNESS_REJECTIONS ${natural.length}`);
for (const r of natural.slice(0, 20)) {
  console.log(`\n[${r.sheetRow}] ${r.uid}`);
  console.log(`反馈: ${r.feedback}`);
  console.log(`题面: ${r.question.slice(0, 420).replace(/\s+/g, ' ')}`);
}
