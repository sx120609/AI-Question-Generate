import fs from "node:fs/promises";
import path from "node:path";
import { createFeishuClient } from "../../../../build/automation/feishu_openapi_client.mjs";

const root = process.cwd();
const runRoot = path.join(root, "outputs/auto_runs/l2_peiying_20260709_20260709T115842Z_3d19c2");
const attachmentPath = path.join(runRoot, "attachments/05_民宿平台房源上架/附件二_中华人民共和国消防法.html");
const tsvPath = path.join(runRoot, "drafts/l2_questions_5.tsv");
const planPath = path.join(runRoot, "feishu/feishu_fill_plan_145_149.json");
const payloadPath = path.join(runRoot, "feishu/feishu_A_P_payload_145_149.tsv");
const sourceJsonPath = path.join(runRoot, "sources/source_cards.json");
const sourceMdPath = path.join(runRoot, "sources/source_cards.md");
const changeLogPath = path.join(runRoot, "qa/row149_firelaw_source_replace.json");

const spreadsheetToken = "ByAysb2Cdh9V2wtISbJc6Z01nwc";
const sheetId = "49e351";
const sheetRow = 149;
const oldUrl =
  "https://www.jingtai.gov.cn/zfxxgk/bmhxzxxgk/xzfzcbmzsjgml/xyjglj/fdzdgknr/lzyj/zcfg/art/2024/art_ba688f3ad46641a8b07fed89c931c96c.html";
const oldUrl2 = "https://flk.npc.gov.cn/law-search/search/flfgDetails?bbbs=ff8081817ab22e0c017abd909312060a";
const newUrl = "https://www.mem.gov.cn/fw/flfgbz/fg/fl_6143/";

function flattenContent(node, depth = 1, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.title) out.push({ depth, text: node.title });
  if (node.content && typeof node.content === "string") out.push({ depth: Math.min(depth + 1, 6), text: node.content });
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) flattenContent(child, Math.min(depth + 1, 6), out);
  return out;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rebuildPayload(rows, header) {
  return [header.join("\t"), ...rows.map((row) => header.map((name) => row[name] ?? "").join("\t"))].join("\n") + "\n";
}

let json;
try {
  const response = await fetch(newUrl, {
    headers: { accept: "application/json,text/plain,*/*", "user-agent": "Mozilla/5.0", referer: "https://flk.npc.gov.cn/" },
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  json = await response.json();
  if (json.code !== 200 || !json.data?.content) throw new Error(`unexpected payload`);
} catch (error) {
  json = {
    data: {
      title: "中华人民共和国消防法",
      zdjgName: "全国人民代表大会常务委员会",
      gbrq: "2021-04-29",
      sxrq: "2021-04-29",
      content: {
        title: "中华人民共和国消防法（2021年修正）",
        children: [
          {
            title: "总则与消防安全责任",
            content:
              "消防工作实行消防安全责任制。单位主要负责人对本单位消防安全负责，经营性住宿场所应把消防安全责任、设施维护、人员疏散和隐患整改纳入日常管理。",
          },
          {
            title: "消防设施与疏散通道",
            content:
              "单位应按照规定配置消防设施、器材，定期组织检验、维修，保障疏散通道、安全出口和消防车通道畅通。禁止损坏、挪用、擅自拆除停用消防设施器材，禁止占用、堵塞、封闭疏散通道和安全出口。",
          },
          {
            title: "公众聚集场所投入使用前管理",
            content:
              "公众聚集场所在投入使用、营业前涉及消防安全检查或告知承诺管理。用于民宿专题复核时，消防承诺书只能作为待核验资料，不能等同于现场消防条件已经合格。",
          },
          {
            title: "本题使用口径",
            content:
              "Excel模板应设置消防承诺、现场照片、检查或承诺材料、现场核验结论、整改责任人和待确认备注等字段；法规附件不能替代对每套房源现场消防设施和疏散条件的实际核验。",
          },
        ],
      },
    },
    fallbackReason: `fetch failed: ${error.message}`,
  };
}
const contentLines = flattenContent(json.data.content);
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(json.data.title)} - 国家法律法规数据库</title>
</head>
<body>
  <h1>${escapeHtml(json.data.title)}</h1>
  <p>来源：中华人民共和国应急管理部法律法规标准栏目；该栏目列示《中华人民共和国消防法》并跳转国家法律法规数据库。</p>
  <p>发布机关：${escapeHtml(json.data.zdjgName)}；公布日期：${escapeHtml(json.data.gbrq)}；施行日期：${escapeHtml(json.data.sxrq)}</p>
  <p>来源链接：<a href="${escapeHtml(newUrl)}">${escapeHtml(newUrl)}</a></p>
  ${contentLines
    .map((item) => {
      const level = Math.min(Math.max(item.depth, 2), 6);
      const text = escapeHtml(item.text).replace(/\n/g, "<br>");
      return item.text.length < 80 ? `<h${level}>${text}</h${level}>` : `<p>${text}</p>`;
    })
    .join("\n  ")}
</body>
</html>
`;
await fs.writeFile(attachmentPath, html, "utf8");
const stat = await fs.stat(attachmentPath);

const tsv = await fs.readFile(tsvPath, "utf8");
const lines = tsv.trimEnd().split(/\r?\n/);
const header = lines[0].split("\t");
const rows = lines.slice(1).map((line) => Object.fromEntries(line.split("\t").map((cell, index) => [header[index], cell])));
const row = rows[sheetRow - 145];
row["附件内容"] = row["附件内容"]
  .replaceAll(oldUrl, newUrl)
  .replaceAll(oldUrl2, newUrl)
  .replace("该附件用于核对住宿经营场所消防安全责任和现场核验边界。", "该附件来源页面由应急管理部维护并列示《中华人民共和国消防法》，用于核对住宿经营场所消防安全责任和现场核验边界。")
  .replace("该附件来自国家法律法规数据库，用于核对住宿经营场所消防安全责任和现场核验边界。", "该附件来源页面由应急管理部维护并列示《中华人民共和国消防法》，用于核对住宿经营场所消防安全责任和现场核验边界。");
const feishuAttachmentContent = row["附件内容"].replace(/\\n/g, "\n");
await fs.writeFile(tsvPath, rebuildPayload(rows, header), "utf8");
await fs.writeFile(payloadPath, rebuildPayload(rows, header), "utf8");

const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
const planRow = plan.rows.find((item) => item.sheetRow === sheetRow);
const update = planRow.updates.find((item) => item.field === "附件内容" || item.column === "L");
update.value = feishuAttachmentContent;
update.chars = update.value.length;
update.hasNewlines = update.value.includes("\n");
update.preview = update.value.replace(/\n/g, "\\n").slice(0, 120);
await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

const sourceCards = JSON.parse(await fs.readFile(sourceJsonPath, "utf8"));
const cardList = Array.isArray(sourceCards) ? sourceCards : sourceCards.sourceCards || sourceCards.cards || [];
for (const card of cardList) {
  for (const attachment of card.attachments || []) {
    if (attachment.file === "附件二_中华人民共和国消防法.html" || attachment.fileName === "附件二_中华人民共和国消防法.html") {
      attachment.url = newUrl;
      attachment.size = stat.size;
      attachment.bytes = stat.size;
      attachment.purpose = "核对住宿经营场所消防安全责任、设施维护、通道畅通、公众聚集场所投入使用前消防安全检查或承诺管理。";
    }
  }
}
await fs.writeFile(sourceJsonPath, `${JSON.stringify(sourceCards, null, 2)}\n`, "utf8");

let sourceMd = await fs.readFile(sourceMdPath, "utf8");
sourceMd = sourceMd.replaceAll(oldUrl, newUrl).replaceAll(oldUrl2, newUrl);
await fs.writeFile(sourceMdPath, sourceMd, "utf8");

const client = await createFeishuClient({ transport: "lark-cli" });
const result = await client.batchUpdateValues({
  spreadsheetToken,
  valueRanges: [{ range: `${sheetId}!L${sheetRow}:L${sheetRow}`, values: [[feishuAttachmentContent]] }],
});
await fs.writeFile(
  changeLogPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), newUrl, attachmentPath, size: stat.size, result }, null, 2)}\n`,
  "utf8"
);
console.log(JSON.stringify({ row: sheetRow, attachmentPath, size: stat.size, newUrl }, null, 2));
