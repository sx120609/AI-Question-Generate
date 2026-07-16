import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const outRoot = path.join(root, "outputs", "attachments");

const expected = [
  ["睡眠健康App上架前数据安全与素材合规预审", "01", "Apple App 审核指南", "HTML", "https://developer.apple.com/cn/app-store/review/guidelines/", "附件一_Apple_App审核指南_官方中文页面.html", ["App 审核指南"]],
  ["睡眠健康App上架前数据安全与素材合规预审", "02", "Apple App 产品页创建说明", "HTML", "https://developer.apple.com/cn/app-store/product-page/", "附件二_Apple_App产品页创建说明_官方中文页面.html", ["创建你的产品页"]],
  ["睡眠健康App上架前数据安全与素材合规预审", "03", "Apple App 隐私详情与数据类型说明", "HTML", "https://developer.apple.com/cn/app-store/app-privacy-details/", "附件三_Apple_App隐私详情与数据类型说明_官方中文页面.html", ["App 隐私保护"]],
  ["睡眠健康App上架前数据安全与素材合规预审", "04", "Google Play 数据安全表单帮助", "HTML", "https://support.google.com/googleplay/android-developer/answer/10787469?hl=zh-Hans", "附件四_Google_Play数据安全表单帮助_官方中文页面.html", ["数据安全"]],
  ["睡眠健康App上架前数据安全与素材合规预审", "05", "Google Play 健康类应用声明表单帮助", "HTML", "https://support.google.com/googleplay/android-developer/answer/13996367?hl=zh-Hans", "附件五_Google_Play健康类应用声明表单帮助_官方中文页面.html", ["健康类应用声明"]],
  ["睡眠健康App上架前数据安全与素材合规预审", "06", "Google Play 健康类内容与服务政策", "HTML", "https://support.google.com/googleplay/android-developer/topic/9877466?hl=zh-Hans", "附件六_Google_Play健康类内容与服务政策_官方中文页面.html", ["健康类内容和服务"]],
  ["睡眠健康App上架前数据安全与素材合规预审", "07", "FTC 背书与推荐广告指南（2023）", "PDF", "https://www.ftc.gov/system/files/ftc_gov/pdf/p204500_endorsement_guides_in_2023.pdf", "附件七_FTC_背书与推荐广告指南_2023.pdf", []],
  ["学校食堂托管续签前食品安全与合同整改审查", "01", "学校食品安全与营养健康管理规定", "PDF", "https://www.moe.gov.cn/jyb_xxgk/xxgk/zhengce/guizhang/202112/P020211208552028545827.pdf", "附件一_教育部学校食品安全与营养健康管理规定.pdf", []],
  ["学校食堂托管续签前食品安全与合同整改审查", "02", "学校食堂委托管理服务合同示范文本", "HTML", "https://htsfwb.samr.gov.cn/View?id=96bca357-fa35-4893-b225-ebd7e356621d", "附件二_市场监管总局学校食堂委托管理服务合同示范文本.html", ["学校食堂委托管理服务合同", "食品安全"]],
  ["学校食堂托管续签前食品安全与合同整改审查", "03", "食品生产经营企业落实食品安全主体责任规定", "DOCX", "https://sjfg.samr.gov.cn/law/file//docx/3235243/1664267667505.docx", "附件三_市场监管总局食品生产经营企业落实食品安全主体责任规定.docx", []],
  ["学校食堂托管续签前食品安全与合同整改审查", "04", "餐饮服务食品安全操作规范", "HTML", "https://scjgj.cq.gov.cn/zz/hcq/zwgk/fdzdgknr_146781/jdjc_146793/spyp/jczdbz/202112/t20211214_10167366.html", "附件四_重庆市市场监管局餐饮服务食品安全操作规范页面.html", ["餐饮服务食品安全操作规范", "市场监管总局"]],
  ["学校食堂托管续签前食品安全与合同整改审查", "05", "食品经营许可和备案管理办法", "HTML", "https://www.gov.cn/gongbao/2023/issue_10606/202307/content_6894763.html", "附件五_中国政府网食品经营许可和备案管理办法.html", ["食品经营许可和备案管理办法", "国家市场监督管理总局令"]],
];

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

async function sha256(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
}

function detectFormat(data, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const head4 = data.subarray(0, 4).toString("latin1");
  const head8 = data.subarray(0, 8);
  if (head4 === "%PDF") return "PDF";
  if (head4 === "PK\u0003\u0004") {
    if (ext === ".docx") return "DOCX";
    if (ext === ".xlsx") return "XLSX";
    if (ext === ".pptx") return "PPTX";
    return "ZIP";
  }
  if (head8[0] === 0xd0 && head8[1] === 0xcf && head8[2] === 0x11 && head8[3] === 0xe0) return "OLE_OFFICE";
  if (head8[0] === 0x89 && head8[1] === 0x50 && head8[2] === 0x4e && head8[3] === 0x47) return "PNG";
  if (head8[0] === 0xff && head8[1] === 0xd8) return "JPEG";
  if (head4 === "GIF8") return "GIF";
  const sample = data.subarray(0, Math.min(data.length, 4096)).toString("utf8").trimStart();
  if (/^<!doctype html/i.test(sample) || /^<html/i.test(sample)) return "HTML";
  if (sample.startsWith("{") || sample.startsWith("[")) return "JSON";
  if (ext === ".csv") return "CSV";
  if (ext === ".txt") return "TXT";
  return ext ? ext.slice(1).toUpperCase() : "UNKNOWN";
}

async function validateFile(format, filePath, keywords) {
  const data = await fs.readFile(filePath);
  const detected = detectFormat(data, filePath);
  const expected = format.toUpperCase();
  if (["PDF", "DOCX", "XLSX", "PPTX", "ZIP", "PNG", "JPEG", "GIF", "JSON", "CSV", "TXT", "OLE_OFFICE"].includes(expected)) {
    return detected === expected || (expected === "XLSX" && detected === "ZIP") || (expected === "DOCX" && detected === "ZIP")
      ? `PASS: ${detected} signature OK`
      : `FAIL: expected ${expected}, detected ${detected}`;
  }
  if (expected !== "HTML") return `WARN: detected ${detected}, no specialized validator for ${expected}`;
  const text = data.toString("utf8");
  const missing = keywords.filter((keyword) => !text.includes(keyword));
  if (missing.length) return `WARN: missing keyword(s): ${missing.join(" | ")}`;
  if (/browser and\/or version is not supported/i.test(text)) return "FAIL: unsupported-browser placeholder";
  if (/HTTP Status 404|404 Not Found|404/.test(text) && text.length < 10000) return "FAIL: likely error page";
  return "PASS: keyword check OK";
}

const rows = [];
for (const [question, seq, name, format, url, file, keywords] of expected) {
  const localPath = path.join(outRoot, question, file);
  let row = {
    Question: question,
    Seq: seq,
    Name: name,
    Format: format,
    Url: url,
    LocalPath: localPath,
    Bytes: 0,
    SHA256: "",
    Validation: "FAIL: missing file",
  };
  try {
    const stat = await fs.stat(localPath);
    row.Bytes = stat.size;
    row.SHA256 = await sha256(localPath);
    row.Validation = await validateFile(format, localPath, keywords);
  } catch (err) {
    row.Validation = `FAIL: ${err?.message || String(err)}`;
  }
  rows.push(row);
}

const headers = Object.keys(rows[0]);
const csv = [
  headers.join(","),
  ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(",")),
].join("\r\n");
await fs.writeFile(path.join(outRoot, "attachments_manifest.csv"), "\uFEFF" + csv, "utf8");

const readme = [
  "# 附件下载清单",
  "",
  "生成日期：2026-07-09",
  "",
  "说明：附件均已保存到本地目录，并按飞书样例使用“附件一_”这类前缀命名。下载器支持 HTML、PDF、DOCX、XLSX、CSV、JSON、TXT、PNG/JPEG/GIF、ZIP 等常见附件；能下载原文件时保留原格式。",
  "",
  ...rows.flatMap((row) => [
    `## ${row.Question} / ${row.Seq} ${row.Name}`,
    "",
    `- 格式：${row.Format}`,
    `- 本地文件：${row.LocalPath}`,
    `- 大小：${row.Bytes} bytes`,
    `- 校验：${row.Validation}`,
    `- 来源：${row.Url}`,
    "",
  ]),
].join("\n");
await fs.writeFile(path.join(outRoot, "ATTACHMENTS_README.md"), readme, "utf8");

console.table(rows.map(({ Question, Seq, Format, Bytes, Validation }) => ({ Question, Seq, Format, Bytes, Validation })));
