import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const outRoot = path.join(root, "outputs", "attachments");

const items = [
  {
    question: "睡眠健康App上架前数据安全与素材合规预审",
    seq: "01",
    name: "Apple App 审核指南",
    url: "https://developer.apple.com/cn/app-store/review/guidelines/",
    file: "附件一_Apple_App审核指南_官方中文页面.html",
    format: "HTML",
  },
  {
    question: "睡眠健康App上架前数据安全与素材合规预审",
    seq: "02",
    name: "Apple App 产品页创建说明",
    url: "https://developer.apple.com/cn/app-store/product-page/",
    file: "附件二_Apple_App产品页创建说明_官方中文页面.html",
    format: "HTML",
  },
  {
    question: "睡眠健康App上架前数据安全与素材合规预审",
    seq: "03",
    name: "Apple App 隐私详情与数据类型说明",
    url: "https://developer.apple.com/cn/app-store/app-privacy-details/",
    file: "附件三_Apple_App隐私详情与数据类型说明_官方中文页面.html",
    format: "HTML",
  },
  {
    question: "睡眠健康App上架前数据安全与素材合规预审",
    seq: "04",
    name: "Google Play 数据安全表单帮助",
    url: "https://support.google.com/googleplay/android-developer/answer/10787469?hl=zh-Hans",
    file: "附件四_Google_Play数据安全表单帮助_官方中文页面.html",
    format: "HTML",
  },
  {
    question: "睡眠健康App上架前数据安全与素材合规预审",
    seq: "05",
    name: "Google Play 健康类应用声明表单帮助",
    url: "https://support.google.com/googleplay/android-developer/answer/13996367?hl=zh-Hans",
    file: "附件五_Google_Play健康类应用声明表单帮助_官方中文页面.html",
    format: "HTML",
  },
  {
    question: "睡眠健康App上架前数据安全与素材合规预审",
    seq: "06",
    name: "Google Play 健康类内容与服务政策",
    url: "https://support.google.com/googleplay/android-developer/topic/9877466?hl=zh-Hans",
    file: "附件六_Google_Play健康类内容与服务政策_官方中文页面.html",
    format: "HTML",
  },
  {
    question: "睡眠健康App上架前数据安全与素材合规预审",
    seq: "07",
    name: "FTC 背书与推荐广告指南（2023）",
    url: "https://www.ftc.gov/system/files/ftc_gov/pdf/p204500_endorsement_guides_in_2023.pdf",
    file: "附件七_FTC_背书与推荐广告指南_2023.pdf",
    format: "PDF",
  },
  {
    question: "学校食堂托管续签前食品安全与合同整改审查",
    seq: "01",
    name: "学校食品安全与营养健康管理规定",
    url: "https://www.moe.gov.cn/jyb_xxgk/xxgk/zhengce/guizhang/202112/P020211208552028545827.pdf",
    file: "附件一_教育部学校食品安全与营养健康管理规定.pdf",
    format: "PDF",
  },
  {
    question: "学校食堂托管续签前食品安全与合同整改审查",
    seq: "02",
    name: "学校食堂委托管理服务合同示范文本",
    url: "https://htsfwb.samr.gov.cn/View?id=96bca357-fa35-4893-b225-ebd7e356621d",
    file: "附件二_市场监管总局学校食堂委托管理服务合同示范文本.html",
    format: "HTML",
  },
  {
    question: "学校食堂托管续签前食品安全与合同整改审查",
    seq: "03",
    name: "食品生产经营企业落实食品安全主体责任规定",
    url: "https://sjfg.samr.gov.cn/law/file//docx/3235243/1664267667505.docx",
    file: "附件三_市场监管总局食品生产经营企业落实食品安全主体责任规定.docx",
    format: "DOCX",
  },
  {
    question: "学校食堂托管续签前食品安全与合同整改审查",
    seq: "04",
    name: "餐饮服务食品安全操作规范",
    url: "https://scjgj.cq.gov.cn/zz/hcq/zwgk/fdzdgknr_146781/jdjc_146793/spyp/jczdbz/202112/t20211214_10167366.html",
    file: "附件四_重庆市市场监管局餐饮服务食品安全操作规范页面.html",
    format: "HTML",
  },
  {
    question: "学校食堂托管续签前食品安全与合同整改审查",
    seq: "05",
    name: "食品经营许可和备案管理办法",
    url: "https://www.gov.cn/gongbao/2023/issue_10606/202307/content_6894763.html",
    file: "附件五_中国政府网食品经营许可和备案管理办法.html",
    format: "HTML",
  },
];

const extByContentType = new Map([
  ["application/pdf", ".pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["application/msword", ".doc"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["text/csv", ".csv"],
  ["application/csv", ".csv"],
  ["application/json", ".json"],
  ["text/plain", ".txt"],
  ["text/html", ".html"],
  ["application/xhtml+xml", ".html"],
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["application/zip", ".zip"],
]);

function extFromUrl(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const ext = path.extname(pathname).toLowerCase();
    return ext.length <= 10 ? ext : "";
  } catch {
    return "";
  }
}

function filenameFromContentDisposition(value) {
  if (!value) return "";
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1].replace(/^"|"$/g, ""));
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : "";
}

function detectFormat(data, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const head4 = data.subarray(0, 4).toString("latin1");
  const head8 = data.subarray(0, 8);
  if (head4 === "%PDF") return { format: "PDF", ext: ".pdf" };
  if (head4 === "PK\u0003\u0004") {
    if (ext === ".docx") return { format: "DOCX", ext };
    if (ext === ".xlsx") return { format: "XLSX", ext };
    if (ext === ".pptx") return { format: "PPTX", ext };
    return { format: "ZIP", ext: ext || ".zip" };
  }
  if (head8[0] === 0xd0 && head8[1] === 0xcf && head8[2] === 0x11 && head8[3] === 0xe0) {
    return { format: "OLE_OFFICE", ext: ext || ".doc" };
  }
  if (head8[0] === 0x89 && head8[1] === 0x50 && head8[2] === 0x4e && head8[3] === 0x47) {
    return { format: "PNG", ext: ".png" };
  }
  if (head8[0] === 0xff && head8[1] === 0xd8) return { format: "JPEG", ext: ".jpg" };
  if (head4 === "GIF8") return { format: "GIF", ext: ".gif" };
  const sample = data.subarray(0, Math.min(data.length, 4096)).toString("utf8").trimStart();
  if (/^<!doctype html/i.test(sample) || /^<html/i.test(sample)) return { format: "HTML", ext: ".html" };
  if (sample.startsWith("{") || sample.startsWith("[")) return { format: "JSON", ext: ".json" };
  if (ext === ".csv") return { format: "CSV", ext };
  if (ext === ".txt") return { format: "TXT", ext };
  return { format: ext ? ext.slice(1).toUpperCase() : "UNKNOWN", ext };
}

function inferredName(item, response, buffer) {
  const declared = filenameFromContentDisposition(response.headers.get("content-disposition"));
  const fromHeader = declared ? path.extname(declared).toLowerCase() : "";
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const fromType = extByContentType.get(contentType) || "";
  const fromUrl = extFromUrl(item.url);
  const chosenExt = path.extname(item.file) || fromHeader || fromUrl || fromType || detectFormat(buffer, item.file).ext || "";
  const base = path.basename(item.file, path.extname(item.file));
  return `${base}${chosenExt}`;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

async function sha256(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
}

async function download(item) {
  const dir = path.join(outRoot, item.question);
  await fs.mkdir(dir, { recursive: true });
  const meta = {
    Question: item.question,
    Seq: item.seq,
    Name: item.name,
    ExpectedFormat: item.format,
    DetectedFormat: "",
    Url: item.url,
    LocalPath: "",
    Bytes: 0,
    Status: "",
    ContentType: "",
    SHA256: "",
    Error: "",
  };
  try {
    const response = await fetch(item.url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        Accept: [
          "text/html",
          "application/xhtml+xml",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "text/csv",
          "application/json",
          "image/avif",
          "image/webp",
          "image/png",
          "image/jpeg",
          "application/zip",
          "*/*",
        ].join(","),
      },
    });
    meta.Status = response.status;
    meta.ContentType = response.headers.get("content-type") || "";
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const finalTarget = path.join(dir, inferredName(item, response, buffer));
    const detected = detectFormat(buffer, finalTarget);
    meta.DetectedFormat = detected.format;
    await fs.writeFile(finalTarget, buffer);
    const stat = await fs.stat(finalTarget);
    meta.LocalPath = finalTarget;
    meta.Bytes = stat.size;
    meta.SHA256 = await sha256(finalTarget);
  } catch (err) {
    meta.Error = err?.message || String(err);
  }
  return meta;
}

await fs.mkdir(outRoot, { recursive: true });
const rows = [];
for (const item of items) {
  rows.push(await download(item));
}

const headers = Object.keys(rows[0]);
const csv = [
  headers.join(","),
  ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(",")),
].join("\r\n");
await fs.writeFile(path.join(outRoot, "attachments_manifest.csv"), "\uFEFF" + csv, "utf8");

console.table(rows.map(({ Question, Seq, ExpectedFormat, DetectedFormat, Bytes, Status, Error }) => ({ Question, Seq, ExpectedFormat, DetectedFormat, Bytes, Status, Error })));
console.log(`Manifest: ${path.join(outRoot, "attachments_manifest.csv")}`);
