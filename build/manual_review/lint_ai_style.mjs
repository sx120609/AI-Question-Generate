import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeGeneratedAnnotators,
  loadGeneratedIdentities,
  matchGeneratedIdentity,
} from "../automation/generated_identities.mjs";
import { analyzeProductFormat } from "../automation/product_format.mjs";
import {
  analyzeQuestionPunctuation,
  analyzeQuestionRequest,
  findPoliteImperatives,
  GENERATED_NARRATIVE_FIELDS,
  missingQuestionDeliverableFormats,
} from "../automation/language_style.mjs";
import {
  evaluateDiversity,
  loadStructuralDiversityPolicy,
  parseTsvRows as parseStructuralTsvRows,
} from "../automation/structure_fingerprint.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

const defaultTargets = [
  path.join(root, "outputs", "l2_questions.tsv"),
  path.join(root, "outputs", "l2_questions_review.md"),
];

const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => path.resolve(root, p))
  : defaultTargets;

const rules = [
  {
    id: "imperative-you-need",
    level: "FAIL",
    pattern: /(报告|表格|文档|材料|页面|简报|邮件)你要|你要(写清楚|能算|输出|整理|生成)/,
    message: "疑似无主语命令句，改成有角色、有对象、有交付物的真实工作表达。",
  },
  {
    id: "empty-template-phrase",
    level: "WARN",
    pattern: /全面深入|多维度分析|综合考虑多维因素|可落地闭环|赋能业务|深度洞察|全方位|价值沉淀|抓手|链路|打造|助力|深耕|亮眼成绩|蓬勃发展|未来可期/,
    message: "疑似模板化或夸张表达，建议替换成具体限制、判断依据和交付要求。",
  },
  {
    id: "misplaced-jargon",
    level: "WARN",
    pattern: /兜底|底稿|风险转嫁|职业gap|职业 Gap|职业 GAP/,
    message: "疑似错位行业黑话，普通业务场景建议降级为更朴实的表达。",
  },
  {
    id: "student-role",
    level: "WARN",
    pattern: /学生|论文投稿|实验汇报|课程作业|导师要求/,
    message: "疑似学生/校园身份表达；非科研、课程或实验室题应改成白领工作身份。",
  },
  {
    id: "markdown-default-output",
    level: "FAIL",
    pattern: /Markdown 报告|Markdown文档|md 文档|结构化 Markdown|输出 Markdown/,
    message: "题目产物不应默认要求 Markdown，除非真实场景就是开发者文档或 README。",
  },
];

const expectedTaskType = "L2 流程型";
const generatedIdentityConfig = await loadGeneratedIdentities();
const structuralDiversityPolicy = await loadStructuralDiversityPolicy();
const structureRegistryPath = path.join(root, "outputs", "auto_runs", "_structure_registry.json");
let structureRegistry = { entries: [] };
try {
  structureRegistry = JSON.parse(await fs.readFile(structureRegistryPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const configuredAnnotatorNames = activeGeneratedAnnotators(generatedIdentityConfig).map((item) => item.name);
const expectedAnnotatorNames = new Set(
  (process.env.L2_ANNOTATOR_NAME || configuredAnnotatorNames.join(","))
    .split(/[,\s，、]+/)
    .map((item) => item.trim())
    .filter(Boolean),
);
const allowedAttachmentFormats = new Set([
  "pdf",
  "html",
  "docx",
  "xlsx",
  "csv",
  "pptx",
  "json",
  "txt",
  "png",
  "jpg",
  "jpeg",
  "zip",
]);
const allowedAttachmentFileExtPattern =
  /\.(pdf|html|docx|xlsx|csv|pptx|json|txt|png|jpe?g|zip)$/i;
const attachmentRoot = process.env.L2_ATTACHMENT_ROOT
  ? path.resolve(root, process.env.L2_ATTACHMENT_ROOT)
  : path.join(root, "outputs", "attachments");

async function collectAttachmentFileNames(dir) {
  const names = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return names;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...(await collectAttachmentFileNames(fullPath)));
    } else if (entry.isFile()) {
      names.push(entry.name);
    }
  }
  return names;
}

function attachmentRootForTarget(file) {
  if (process.env.L2_ATTACHMENT_ROOT) return attachmentRoot;
  const targetDir = path.dirname(file);
  if (path.basename(targetDir).toLowerCase() === "drafts") {
    return path.resolve(targetDir, "..", "attachments");
  }
  return attachmentRoot;
}

function splitRelatedAttachments(value) {
  return value
    .split(/[；;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function lineExcerpt(line, index, length = 110) {
  const start = Math.max(0, index - 30);
  const excerpt = line.slice(start, start + length).replace(/\t/g, " ");
  return excerpt.length < line.length ? `${excerpt}...` : excerpt;
}

function normalizeCellNewlines(value = "") {
  return value.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
}

function splitQuestionParagraphs(value = "") {
  return normalizeCellNewlines(value)
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactQuestionOpening(value = "") {
  return normalizeCellNewlines(value)
    .replace(/\s+/g, "")
    .slice(0, 16);
}

function compactFieldOpening(value = "") {
  return normalizeCellNewlines(value)
    .replace(/[-*•]\s*/g, "")
    .replace(/\s+/g, "")
    .slice(0, 18);
}

function collectQuestionTemplateSignals(value = "") {
  const normalized = normalizeCellNewlines(value);
  const signals = [];
  if (/附件里(?:放了|有)|附件中(?:放了|有)/.test(normalized)) signals.push("附件里放了");
  if (/手头(?:资料|附件)(?:就是|有|包括)/.test(normalized)) signals.push("手头资料就是");
  if (/最后(?:给我|整理|形成)|结果最好能直接/.test(normalized)) signals.push("最后给我");
  if (/公开资料(?:看不到|无法确认)/.test(normalized)) signals.push("公开资料看不到");
  if (/请按截至\d{4}年\d{1,2}月\d{1,2}日/.test(normalized)) signals.push("请按截至日期");
  if (/^我在.{0,28}(?:负责|帮忙|整理|处理)/.test(normalized)) signals.push("我在负责开头");
  return signals;
}

const findings = [];

function addFinding({ level = "FAIL", file, line, rule, message, excerpt = "" }) {
  findings.push({ level, file, line, rule, message, excerpt });
}

function splitFormatTags(value) {
  return value
    .split(/[,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function attachmentFormatTagsFromItems(items) {
  return new Set(
    items
      .map((item) => path.extname(item).slice(1).toLowerCase())
      .filter(Boolean),
  );
}

function hasChineseOrLongSeparators(value) {
  return /[；、+\/]/.test(value);
}

function countStepMarkers(value) {
  const normalized = value.replace(/\\n/g, "\n");
  return [...normalized.matchAll(/(?:^|[\n；;。]\s*)([1-9]\d*)\.\s*/g)].length;
}

function textBalance(value) {
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  return { latin, cjk };
}

const cjkNumberSpacePattern = /[\u4e00-\u9fff]\s+\d|(?<![A-Za-z])\d\s+[\u4e00-\u9fff]/;
const humanContextAnchorPattern =
  /我|我们|老板|客户|同事|项目组|委员会|家委会|投委会|主任|经理|园长|校方|物业|产品|运营|法务|供应链|业务|这周|本周|下周|月底|会前|今天|明天|次日|上午|下午|今晚|周[一二三四五六日天]|负责|收到|准备|担心|不想|需要在|现在/;
const promptLikeOpeningPattern =
  /^请?(?:你|根据|依据)?(?:为|对).{0,80}(?:进行|完成|生成|输出|形成|撰写|制作)/;
const stiffDeliverableLeadPattern =
  /请按.{0,24}(?:资料|附件|已上传).{0,30}(?:生成|整理|写|形成).{0,40}(?:Word|Excel|意见|检查表|清单|报告|说明)/;
const promptProhibitionPattern =
  /(?:不要|不得|严禁)(?:写成|编造|猜|直接|输出|使用|把|替|只|堆)|必须(?:问|列出|写|输出|生成|整理|找|说明)/;
const fixedThreeParagraphAttachmentPattern =
  /(?:附件里|附件中|资料里|手头资料|手头附件).{0,30}(?:放了|有|包括|整理了|列了)/;
const fixedThreeParagraphDeliverablePattern =
  /(?:最后|最终|结果最好|交付物|整理一份|给我一份).{0,70}(?:Word|Excel|PPT|清单|表|报告|说明|话术)/i;
const repeatedTransitionStackPattern =
  /附件里(?:放了|有)|附件中(?:放了|有)|最后(?:给我|整理|形成)|结果最好能直接|请按截至\d{4}年\d{1,2}月\d{1,2}日/g;
const questionAiShellRules = [
  {
    id: "binary-contrast-shell",
    pattern: /不是[^。；\n]{1,40}而是|不在于[^。；\n]{1,40}在于|与其说[^。；\n]{1,40}不如说/,
    message: "题面出现二分对照壳；改成真实处境中的具体取舍，不要用“不是...而是...”拔高。",
  },
  {
    id: "essence-claim-shell",
    pattern: /真正(重要|关键|决定|需要|要看)的是|本质上|核心在于|关键在于|底层逻辑/,
    message: "题面出现本质拔高壳；改成谁要判断什么、凭哪些资料判断、判断后怎么用。",
  },
  {
    id: "assistant-signpost-shell",
    pattern: /下面(我们|我)来|接下来(我|我们)会|我们可以看到|希望.{0,12}帮助|总的来说|值得注意的是|由此可见|不难看出|综上所述/,
    message: "题面出现助手/讲义路标词；改成真实工作交代里的对象、动作和结果。",
  },
  {
    id: "mechanical-order-shell",
    pattern: /先[^。；\n]{4,60}再[^。；\n]{4,80}|第一步[^。；\n]{1,80}第二步/,
    message: "题面出现机械顺序壳；题面里改成资料分工或业务路径，详细步骤放到做题关键步骤列。",
  },
  {
    id: "fake-engagement-ending",
    pattern: /你觉得呢|你有没有类似|你现在卡在哪|欢迎.{0,8}(留言|讨论)|希望以上/,
    message: "题面出现假互动/客服收尾；L2 题面应落到交付物和验收边界。",
  },
];

const narrativeTemplateFieldRules = [
  {
    field: "题目",
    id: "question-department-ab-shell",
    level: "FAIL",
    pattern: /部门[AB甲乙].{0,80}认为.{0,120}部门[AB甲乙].{0,80}认为/,
    message: "题面出现“部门A认为、部门B认为”式模板对照，改成真实会议、群聊、排期、评审或交接场景里的具体冲突。",
  },
  {
    field: "题目",
    id: "question-four-attachments-shell",
    level: "WARN",
    pattern: /请基于四个(?:法规)?附件|基于已上传法规资料|基于四个法规附件/,
    message: "题面不要把“基于四个附件”当成固定转场，先说业务要解决的事，再自然交代法规资料能支撑哪部分判断。",
  },
  {
    field: "附件内容",
    id: "attachment-content-template-lead",
    level: "FAIL",
    pattern: /^以下为四个附件/,
    message: "附件内容不能统一用“以下为四个附件……”开头；每行应按真实资料组说明用途、边界和缺口。",
  },
  {
    field: "产物内容",
    id: "product-content-template-lead",
    level: "FAIL",
    pattern: /^最终产物为两个可编辑文件/,
    message: "产物内容不能统一写“最终产物为两个可编辑文件”；应从使用对象、会议/评审场景和验收边界写出差异。",
  },
  {
    field: "做题关键步骤",
    id: "steps-fixed-production-shell",
    level: "WARN",
    pattern: /核验四个附件[\s\S]{0,500}(生成Word|写Word)[\s\S]{0,500}(生成Excel|做Excel)[\s\S]{0,500}交付前检查/,
    message: "关键步骤出现固定“核验附件-生成Word-生成Excel-交付前检查”骨架；按本题真实流程改写每一步的判断动作。",
  },
];

function validateTsvFormat(file, text, attachmentFileNames, targetAttachmentRoot) {
  if (!/^l2_questions(?:_[^/\\]+)?\.tsv$/i.test(path.basename(file))) return;

  const rows = text.trimEnd().split(/\r?\n/);
  if (rows.length < 2) return;

  const header = rows[0].split("\t");
  const col = Object.fromEntries(header.map((name, idx) => [name, idx]));
  const required = [
    "任务类型",
    "人类完成时间",
    "附件格式",
    "相关附件",
    "附件内容",
    "产物格式",
    "产物内容",
    "做题关键步骤",
  ];

  for (const name of required) {
    if (!(name in col)) {
      addFinding({
        file,
        line: 1,
        rule: "missing-required-column",
        message: `TSV 缺少必需字段：${name}`,
      });
    }
  }

  const questionStats = [];
  const fieldOpeningStats = [];

  rows.slice(1).forEach((line, idx) => {
    if (!line.trim()) return;
    const lineNo = idx + 2;
    const cells = line.split("\t");

    if (cells.length !== header.length) {
      addFinding({
        file,
        line: lineNo,
        rule: "tsv-column-count",
        message: `TSV 列数应为 ${header.length}，实际为 ${cells.length}。`,
        excerpt: lineExcerpt(line, 0),
      });
      return;
    }

    const getCell = (name) => cells[col[name]]?.trim() || "";

    for (const name of GENERATED_NARRATIVE_FIELDS) {
      if (!(name in col)) continue;
      const value = getCell(name);
      const matches = findPoliteImperatives(value);
      if (matches.length < 4) continue;
      addFinding({
        level: "WARN",
        file,
        line: lineNo,
        rule: "polite-imperative-stack",
        message: "同一字段连续堆叠多处“请……”容易像任务清单；正式表人审允许自然请求，但应避免把每段都写成礼貌祈使句。",
        excerpt: lineExcerpt(value, matches[0].index),
      });
    }

    for (const rule of narrativeTemplateFieldRules) {
      if (!(rule.field in col)) continue;
      const value = getCell(rule.field);
      const match = value.match(rule.pattern);
      if (!match) continue;
      addFinding({
        level: rule.level,
        file,
        line: lineNo,
        rule: rule.id,
        message: rule.message,
        excerpt: lineExcerpt(value, match.index ?? 0),
      });
    }

    // Attachment entries and numbered steps have legitimate standard leads
    // (for example, “附件一” and “1.”). Repeated-opening checks are useful
    // for authored prose, while long-shared-span checks cover copied detail.
    for (const name of ["题目", "任务概括", "产物内容"]) {
      if (!(name in col)) continue;
      const value = getCell(name);
      const opening = compactFieldOpening(value);
      if (opening.length >= 10) fieldOpeningStats.push({ name, lineNo, opening });
    }

    // Evidence sufficiency belongs to the fact/source audit. A style linter
    // must not reward candidates for adding repeated "不能证明 / 待确认 / 不外推"
    // prose simply because a contract, log, or data field is mentioned.

    const taskType = cells[col["任务类型"]]?.trim();
    if (taskType !== expectedTaskType) {
      addFinding({
        file,
        line: lineNo,
        rule: "task-type-option-label",
        message: `任务类型必须使用飞书选项值「${expectedTaskType}」。`,
        excerpt: taskType,
      });
    }

    for (const name of ["题目", "任务概括", "相关附件", "附件内容", "产物内容", "做题关键步骤"]) {
      const value = cells[col[name]]?.trim();
      if (value && cjkNumberSpacePattern.test(value)) {
        addFinding({
          file,
          line: lineNo,
          rule: "cjk-number-space",
          message: "汉字和数字之间不要留空格，例如写成“第2周”“3个样本”“2026年7月9日”。",
          excerpt: lineExcerpt(value, value.search(cjkNumberSpacePattern)),
        });
      }
    }

    const question = cells[col["题目"]]?.trim();
    const questionParagraphs = splitQuestionParagraphs(question || "");
    const requestAnalysis = analyzeQuestionRequest(question || "");
    const punctuationAnalysis = analyzeQuestionPunctuation(question || "");
    if (question) {
      questionStats.push({
        lineNo,
        paragraphCount: questionParagraphs.length,
        opening: compactQuestionOpening(question),
        signals: collectQuestionTemplateSignals(question),
        requestFrame: requestAnalysis.frame || "missing",
        punctuation: punctuationAnalysis,
      });
    }
    if (question && !requestAnalysis.clear) {
      addFinding({
        level: "FAIL",
        file,
        line: lineNo,
        rule: "missing-explicit-request",
        message: "题面必须直接说出要模型做什么并交付什么；不能只写“Word需要……、Excel按……”这类规格说明。",
        excerpt: lineExcerpt(question, 0),
      });
    }
    if (question && "产物格式" in col) {
      const missingFormats = missingQuestionDeliverableFormats(question, getCell("产物格式"));
      if (missingFormats.length) {
        addFinding({
          level: "FAIL",
          file,
          line: lineNo,
          rule: "question-missing-output-format",
          message: `题面没有用人类名称明确提出这些交付格式：${missingFormats.join(", ")}；M/N 列不能替代 B 列的请求。`,
          excerpt: lineExcerpt(question, 0),
        });
      }
    }
    if (question && punctuationAnalysis.structuralPunctuationCount > 4) {
      addFinding({
        level: "WARN",
        file,
        line: lineNo,
        rule: "structural-punctuation-stack",
        message: "题面冒号和分号合计超过 4 处，检查是否把自然请求写成了规格列表；不要机械全局替换标点。",
        excerpt: `colon=${punctuationAnalysis.colonCount}, semicolon=${punctuationAnalysis.semicolonCount}`,
      });
    }
    if (question && punctuationAnalysis.maximumTerminalSentenceLength > 240) {
      addFinding({
        level: "WARN",
        file,
        line: lineNo,
        rule: "overlong-comma-run",
        message: "题面出现超过 240 字的完整句，避免为减少句号而把所有意群硬接成一口气长句。",
        excerpt: `${punctuationAnalysis.maximumTerminalSentenceLength} chars`,
      });
    }
    if (question && !humanContextAnchorPattern.test(question)) {
      addFinding({
        file,
        line: lineNo,
        rule: "weak-human-context",
        message: "题面缺少真实需求方锚点；至少交代角色、时间压力、业务卡点或谁要用结果，避免像抽象任务说明。",
        excerpt: lineExcerpt(question, 0),
      });
    }
    if (question && promptLikeOpeningPattern.test(question)) {
      addFinding({
        file,
        line: lineNo,
        rule: "prompt-like-opening",
        message: "题面开头过像 prompt 或任务单；建议改成真实人遇到的问题，再自然引出附件和交付物。",
        excerpt: lineExcerpt(question, 0),
      });
    }
    const stiffDeliverableLeadMatch = question?.match(stiffDeliverableLeadPattern);
    if (stiffDeliverableLeadMatch) {
      addFinding({
        level: "WARN",
        file,
        line: lineNo,
        rule: "stiff-deliverable-lead",
        message:
          "题面疑似先抛交付物再补业务问题；先写具体争议点、会前用途和使用对象，再自然落到 Word/Excel/PPT。",
        excerpt: lineExcerpt(question, stiffDeliverableLeadMatch.index ?? 0),
      });
    }
    const promptProhibitionMatch = question?.match(promptProhibitionPattern);
    if (promptProhibitionMatch) {
      addFinding({
        file,
        line: lineNo,
        rule: "prompt-prohibition-style",
        message: "题面出现“不要/必须”式提示词约束；改成业务里的待确认项、交付范围、证据边界或沟通口径。",
        excerpt: lineExcerpt(question, promptProhibitionMatch.index ?? 0),
      });
    }
    for (const rule of questionAiShellRules) {
      const match = question?.match(rule.pattern);
      if (!match) continue;
      addFinding({
        level: "WARN",
        file,
        line: lineNo,
        rule: rule.id,
        message: rule.message,
        excerpt: lineExcerpt(question, match.index ?? 0),
      });
    }
    if (
      question &&
      questionParagraphs.length === 3 &&
      humanContextAnchorPattern.test(questionParagraphs[0] || "") &&
      fixedThreeParagraphAttachmentPattern.test(questionParagraphs[1] || "") &&
      fixedThreeParagraphDeliverablePattern.test(questionParagraphs[2] || "")
    ) {
      addFinding({
        level: "WARN",
        file,
        line: lineNo,
        rule: "fixed-three-paragraph-shell",
        message:
          "题面像固定三段模板：背景一段、附件一段、交付物一段。请改成更贴近真实发问的段落长度和信息顺序。",
        excerpt: lineExcerpt(question, 0),
      });
    }
    const transitionMatches = question?.match(repeatedTransitionStackPattern) || [];
    if (transitionMatches.length >= 3) {
      addFinding({
        level: "WARN",
        file,
        line: lineNo,
        rule: "template-transition-stack",
        message:
          "题面同时出现多处固定转场词，容易像同一模板生成；建议改掉“附件里放了/最后给我/请按截至日期”等机械提示词。",
        excerpt: transitionMatches.join(", "),
      });
    }

    if ("标注专家姓名" in col) {
      const annotatorName = cells[col["标注专家姓名"]]?.trim();
      if (!expectedAnnotatorNames.has(annotatorName)) {
        addFinding({
          file,
          line: lineNo,
          rule: "annotator-name",
          message: `标注专家姓名必须填写以下值之一：${[...expectedAnnotatorNames].map((name) => `「${name}」`).join("、")}。`,
          excerpt: annotatorName,
        });
      }
      if ("UID" in col) {
        const uid = cells[col["UID"]]?.trim() || "";
        if (uid) {
          const identity = matchGeneratedIdentity({ name: annotatorName, uid }, generatedIdentityConfig);
          if (!identity || identity.name !== annotatorName || !uid.startsWith(identity.uidPrefix)) {
            addFinding({
              file,
              line: lineNo,
              rule: "annotator-uid-mismatch",
              message: "标注专家姓名必须与系统生成身份注册表中的 UID 前缀一致。",
              excerpt: `${uid} / ${annotatorName}`,
            });
          }
        }
      }
    }

    const humanTime = cells[col["人类完成时间"]]?.trim();
    const timeMatch = humanTime.match(/^([1-9]\d*)h$/);
    if (!timeMatch) {
      addFinding({
        file,
        line: lineNo,
        rule: "human-time-format",
        message: "人类完成时间必须写成 10h、12h 这种短格式，不能写“10小时”。",
        excerpt: humanTime,
      });
    } else if (Number(timeMatch[1]) < 8) {
      addFinding({
        file,
        line: lineNo,
        rule: "human-time-minimum",
        message: "L2 人类完成时间不得低于 8h。",
        excerpt: humanTime,
      });
    }

    const attachmentFormat = cells[col["附件格式"]]?.trim();
    if (hasChineseOrLongSeparators(attachmentFormat)) {
      addFinding({
        file,
        line: lineNo,
        rule: "attachment-format-short-tags",
        message: "附件格式标签只能写短格式标签，如 pdf, html, csv；不要写中文说明或长描述。",
        excerpt: attachmentFormat,
      });
    }
    for (const tag of splitFormatTags(attachmentFormat)) {
      if (!allowedAttachmentFormats.has(tag.toLowerCase())) {
        addFinding({
          file,
          line: lineNo,
          rule: "attachment-format-unknown-tag",
          message: `附件格式标签不在允许集合内：${tag}`,
          excerpt: attachmentFormat,
        });
      }
    }

    const relatedAttachments = cells[col["相关附件"]]?.trim();
    if (/https?:\/\//i.test(relatedAttachments)) {
      addFinding({
        file,
        line: lineNo,
        rule: "related-attachments-url",
        message: "相关附件不得写 URL；本地 TSV 写真实附件文件名，正式填飞书时上传成文件对象。",
        excerpt: lineExcerpt(relatedAttachments, relatedAttachments.search(/https?:\/\//i)),
      });
    }
    if (/中文摘要|中文资料|中文译文|摘要名/.test(relatedAttachments)) {
      addFinding({
        file,
        line: lineNo,
        rule: "related-attachments-summary-placeholder",
        message: "相关附件必须对应真实已下载文件名并在飞书上传成文件对象，不能写“中文摘要”这类占位说明。",
        excerpt: lineExcerpt(relatedAttachments, 0),
      });
    }
    const relatedItems = splitRelatedAttachments(relatedAttachments);
    for (const item of relatedItems) {
      if (!allowedAttachmentFileExtPattern.test(item)) {
        addFinding({
          file,
          line: lineNo,
          rule: "related-attachments-not-file",
          message: "相关附件每一项都必须是带扩展名的真实文件名，例如 xxx.pdf、xxx.html、xxx.csv。",
          excerpt: item,
        });
      } else if (!attachmentFileNames.has(item)) {
        addFinding({
          file,
          line: lineNo,
          rule: "related-attachments-file-missing",
          message: `相关附件文件名必须能在 ${path.relative(root, targetAttachmentRoot)} 目录下找到；先下载并重命名真实附件，再写入飞书。`,
          excerpt: item,
        });
      }
      if (!/^附件(?:[一二三四五六七八九十]+|\d+)[_：:]/.test(item)) {
        addFinding({
          file,
          line: lineNo,
          rule: "related-attachments-numbered-prefix",
          message: "相关附件文件名必须以附件编号开头，例如 附件一_xxx.pdf、附件二_xxx.html，方便和附件内容逐条对应。",
          excerpt: item,
        });
      }
      if (!/[\u4e00-\u9fff]/.test(item)) {
        addFinding({
          file,
          line: lineNo,
          rule: "related-attachments-chinese-subject",
          message: "相关附件文件名必须有中文主体名称；如果资料包做不到中文附件或中文主体命名，应换选题，不要靠英文附件硬做。",
          excerpt: item,
        });
      }
    }
    const attachmentTags = new Set(splitFormatTags(attachmentFormat).map((tag) => tag.toLowerCase()));
    const actualAttachmentTags = attachmentFormatTagsFromItems(relatedItems);
    for (const actualTag of actualAttachmentTags) {
      if (!attachmentTags.has(actualTag)) {
        addFinding({
          file,
          line: lineNo,
          rule: "attachment-format-missing-actual-ext",
          message: "附件格式标签必须覆盖相关附件里的真实扩展名；例如有 PDF 附件时必须写 pdf。",
          excerpt: `missing ${actualTag} in ${attachmentFormat}`,
        });
      }
    }
    for (const tag of attachmentTags) {
      if (actualAttachmentTags.size && !actualAttachmentTags.has(tag)) {
        addFinding({
          file,
          line: lineNo,
          rule: "attachment-format-extra-tag",
          message: "附件格式标签不得多写真实附件中不存在的格式。",
          excerpt: `extra ${tag} in ${attachmentFormat}`,
        });
      }
    }
    const relatedLooksFileBased =
      relatedItems.length > 0 && relatedItems.every((item) => allowedAttachmentFileExtPattern.test(item));
    const relatedBalance = textBalance(relatedAttachments);
    if (!relatedLooksFileBased && relatedBalance.cjk > 0 && relatedBalance.latin > relatedBalance.cjk * 0.35) {
      addFinding({
        file,
        line: lineNo,
        rule: "related-attachments-english-heavy",
        message: "相关附件英文占比过高；只保留必要品牌名/缩写，主体应是可读的真实文件名。",
        excerpt: lineExcerpt(relatedAttachments, 0),
      });
    }

    const attachmentContent = cells[col["附件内容"]]?.trim();
    if (!/来源[：:]/.test(attachmentContent)) {
      addFinding({
        file,
        line: lineNo,
        rule: "attachment-content-source-missing",
        message: "附件内容必须按来源说明资料出处，建议写成“附件一：《资料名》，用于...。来源：https://...”。",
        excerpt: lineExcerpt(attachmentContent, 0),
      });
    }
    const attachmentSourceLinks = attachmentContent.match(/来源[：:]\s*https?:\/\//g) || [];
    if (relatedItems.length && attachmentSourceLinks.length < relatedItems.length) {
      addFinding({
        file,
        line: lineNo,
        rule: "attachment-content-source-link-missing",
        message: "附件内容必须逐条给出来源链接；每个相关附件至少对应一行“来源：https://...”。",
        excerpt: `${attachmentSourceLinks.length} source links for ${relatedItems.length} attachments`,
      });
    }
    if (!/(中文摘要|内容摘要|内容包括|内容说明|内容列明|内容涵盖|资料边界|中文资料|中文译文|中文版本|中文文档|官方中文|中文页面)/.test(attachmentContent)) {
      addFinding({
        file,
        line: lineNo,
        rule: "attachment-content-chinese-summary",
        message: "附件内容必须用中文说明文件实际包含的信息和资料边界；英文来源要补中文内容摘要，不写用途话术。",
        excerpt: lineExcerpt(attachmentContent, 0),
      });
    }
    const attachmentBalance = textBalance(attachmentContent.replace(/https?:\/\/\S+/g, ""));
    if (attachmentBalance.cjk > 0 && attachmentBalance.latin > attachmentBalance.cjk * 0.45) {
      addFinding({
        file,
        line: lineNo,
        rule: "attachment-content-english-heavy",
        message: "附件内容英文占比过高；只保留必要品牌名/缩写，其余写成中文摘要。",
        excerpt: lineExcerpt(attachmentContent, 0),
      });
    }

    const productFormat = cells[col["产物格式"]]?.trim();
    const productFormatAnalysis = analyzeProductFormat(productFormat);
    const normalizedProductFormats = productFormatAnalysis.formats;
    if (!productFormatAnalysis.canonical || productFormatAnalysis.unknown.length) {
      addFinding({
        file,
        line: lineNo,
        rule: "product-format-unknown-tag",
        message: `产物格式只能使用支持的小写扩展名；无法识别：${productFormatAnalysis.unknown.join(", ") || "空值"}。`,
        excerpt: productFormat,
      });
    } else if (!productFormatAnalysis.isCanonical) {
      addFinding({
        file,
        line: lineNo,
        rule: "product-format-extension-only",
        message: `产物格式只写小写扩展名并用英文逗号加空格分隔，应改为：${productFormatAnalysis.canonical}。`,
        excerpt: productFormat,
      });
    }

    const productContent = cells[col["产物内容"]]?.trim();
    const productMentionRules = new Map([
      ["docx", /\bWord\b|docx|文档/i],
      ["xlsx", /\bExcel\b|xlsx|工作簿|表格/i],
      ["pptx", /\bPPT\b|pptx|演示文稿|幻灯片/i],
      ["html", /\bHTML\b|html|网页/i],
      ["pdf", /\bPDF\b|pdf/i],
    ]);
    const missingProductMentions = normalizedProductFormats.filter((format) => {
      const pattern = productMentionRules.get(format);
      return pattern && !pattern.test(productContent);
    });
    if (missingProductMentions.length) {
      addFinding({
        file,
        line: lineNo,
        rule: "product-content-format-visible",
        message: `产物内容需要让人看出这些交付类型：${missingProductMentions.join(", ")}；可以自然写 Word、Excel、PPT、网页等，不必重复括号扩展名。`,
        excerpt: lineExcerpt(productContent, 0),
      });
    }
    // M and N already carry the machine-readable format and deliverable
    // description. Requiring B to repeat Word/Excel made every question end in
    // the same artifact paragraph, so B may omit those names when the work
    // scene does not naturally call them out.
    if (/\bemail\b/i.test(productFormat)) {
      addFinding({
        file,
        line: lineNo,
        rule: "product-format-email",
        message: "产物格式不要写 Email；如需邮件正文，放在产物内容中，产物格式写 Word 或其他可编辑交付格式。",
        excerpt: productFormat,
      });
    }
    if (/\bemail\b/i.test(productContent) && !/\bword\b/i.test(productFormat)) {
      addFinding({
        file,
        line: lineNo,
        rule: "email-deliverable-format",
        message: "产物内容包含邮件正文时，产物格式应给出 Word 等可编辑承载格式。",
        excerpt: productFormat,
      });
    }
    const scopeText = [
      question,
      cells[col["二级目录"]]?.trim(),
      cells[col["三级目录"]]?.trim(),
      attachmentContent,
      productContent,
    ].join("\n");
    if (
      /具体产品上架判断|产品批准文件|无法支撑具体产品上架|商品上架/.test(scopeText) &&
      /通用法规|法规风险提示|话术红线|改稿台账|补件表制作|只列|不涉及具体产品/.test(scopeText)
    ) {
      addFinding({
        file,
        line: lineNo,
        rule: "scope-confuses-generic-review-with-product-launch",
        message:
          "题目范围容易让质检误读成“具体产品上架判断”。如果任务只是法规/素材风险提示，分类和字段都要改成素材审查、话术红线、待收材料，不要写商品上架、产品批准文件或补件表制作。",
        excerpt: lineExcerpt(scopeText, scopeText.search(/具体产品上架判断|产品批准文件|商品上架/)),
      });
    }

    const steps = cells[col["做题关键步骤"]]?.trim();
    if (/[1-9]\d*）/.test(steps)) {
      addFinding({
        file,
        line: lineNo,
        rule: "step-marker-fullwidth",
        message: "做题关键步骤使用外部质检可识别的 ASCII 编号，如 1. 2. 3.；不要用 1）这种全角编号。",
        excerpt: lineExcerpt(steps, steps.search(/[1-9]\d*）/)),
      });
    }
    if (!/(?:^|\\n|\n)\s*2\.\s*/.test(steps)) {
      addFinding({
        file,
        line: lineNo,
        rule: "step-line-separator",
        message: "做题关键步骤必须按行分隔。TSV 中用字面量 \\n 保存，粘贴飞书时转换成单元格内真实换行。",
        excerpt: lineExcerpt(steps, 0),
      });
    }
    const stepCount = countStepMarkers(steps);
    if (stepCount < 8 || stepCount > 15) {
      addFinding({
        file,
        line: lineNo,
        rule: "step-count",
        message: "做题关键步骤必须能被解析为 8-15 步，建议写成 1. ...；2. ...；3. ...。",
        excerpt: `${stepCount} parsed steps`,
      });
    }
  });

  if (questionStats.length >= 2) {
    const signalCounts = new Map();
    for (const item of questionStats) {
      for (const signal of new Set(item.signals)) {
        signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1);
      }
    }
    for (const [signal, count] of signalCounts) {
      if (count !== questionStats.length) continue;
      addFinding({
        level: "WARN",
        file,
        line: questionStats[0].lineNo,
        rule: "batch-question-repeated-template-signal",
        message:
          "同批题重复使用同一个题面转场或开头信号，建议改掉其中一条，避免所有提示词像同一模板印出来。",
        excerpt: signal,
      });
    }

    const openingCounts = new Map();
    for (const item of questionStats) {
      if (item.opening.length < 8) continue;
      openingCounts.set(item.opening, (openingCounts.get(item.opening) || 0) + 1);
    }
    for (const [opening, count] of openingCounts) {
      if (count < 2) continue;
      addFinding({
        level: "WARN",
        file,
        line: questionStats[0].lineNo,
        rule: "batch-question-repeated-opening",
        message: "同批题开头高度重复，建议改成不同发起姿态。",
        excerpt: opening,
      });
    }

    if (questionStats.length >= 5) {
      const count = questionStats.length;
      const punctuation = questionStats.map((item) => item.punctuation);
      const frameCounts = new Map();
      for (const item of questionStats) {
        frameCounts.set(item.requestFrame, (frameCounts.get(item.requestFrame) || 0) + 1);
      }
      const dominantFrame = [...frameCounts.entries()].sort((left, right) => right[1] - left[1])[0] ?? ["", 0];
      const totalCharacters = punctuation.reduce((sum, item) => sum + item.visibleCharacters, 0);
      const totalCommas = punctuation.reduce((sum, item) => sum + item.commaCount, 0);
      const totalPeriods = punctuation.reduce((sum, item) => sum + item.periodCount, 0);
      const totalEnumerationCommas = punctuation.reduce((sum, item) => sum + item.enumerationCommaCount, 0);
      const batchChecks = [
        [dominantFrame[1] / count > 0.3, "batch-request-frame-concentration", `同一请求框架“${dominantFrame[0]}”占比超过 30%，不要把全部题统一补成“帮我生成”。`, `${dominantFrame[1]}/${count}`],
        [punctuation.filter((item) => item.firstSentenceLength <= 30).length / count > 0.1, "batch-short-opening-concentration", "短于或等于 30 字的开头句占比过高，检查是否反复用一个状态句立刻句号。", ""],
        [punctuation.filter((item) => item.firstPunctuationIsTerminal).length / count > 0.1, "batch-opening-hard-stop-concentration", "第一枚标点就是句末标点的题目占比过高；同一触发事件优先用逗号自然承接。", ""],
        [punctuation.filter((item) => item.firstSentenceCommaCount > 0).length / count < 0.85, "batch-opening-comma-scarcity", "少于 85% 的题目首句含逗号，整批开头过于短促。", ""],
        [totalCommas / Math.max(1, totalPeriods) < 1.8, "batch-comma-period-ratio-low", "整批逗号与句号之比低于 1.8，检查是否把一个意群切成过多短句。", ""],
        [(totalEnumerationCommas * 100) / Math.max(1, totalCharacters) > 2.4, "batch-enumeration-punctuation-density", "整批顿号密度偏高，检查是否把题面写成规格枚举。", ""],
        [punctuation.filter((item) => item.earlyStructuralPunctuation).length / count > 0.2, "batch-early-structural-punctuation", "超过 20% 的题目前 80 字就出现冒号或分号，列表腔出现得过早。", ""],
        [punctuation.filter((item) => item.containsSemicolon).length / count > 0.6, "batch-semicolon-concentration", "超过 60% 的题目使用分号，检查是否把并列规格当成默认写法。", ""],
      ];
      for (const [triggered, rule, message, excerpt] of batchChecks) {
        if (!triggered) continue;
        addFinding({
          level: "WARN",
          file,
          line: questionStats[0].lineNo,
          rule,
          message,
          excerpt,
        });
      }
    }
  }

  if (fieldOpeningStats.length >= 2) {
    const byField = new Map();
    for (const item of fieldOpeningStats) {
      if (!byField.has(item.name)) byField.set(item.name, new Map());
      const openings = byField.get(item.name);
      const current = openings.get(item.opening) || { count: 0, lineNo: item.lineNo };
      current.count += 1;
      openings.set(item.opening, current);
    }
    for (const [name, openings] of byField) {
      for (const [opening, meta] of openings) {
        if (meta.count < 2) continue;
        addFinding({
          level: "WARN",
          file,
          line: meta.lineNo,
          rule: "batch-field-repeated-opening",
          message:
            "同一批数据的题目、任务概括或产物内容开头高度重复，容易被判成模板化；改成贴合本题发起场景和使用对象的表达。",
          excerpt: `${name}: ${opening}`,
        });
      }
    }
  }
}

for (const file of targets) {
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    addFinding({
      file,
      line: 0,
      rule: "missing-file",
      message: err?.message || String(err),
    });
    continue;
  }

  const targetAttachmentRoot = attachmentRootForTarget(file);
  const targetAttachmentFileNames = new Set(await collectAttachmentFileNames(targetAttachmentRoot));
  validateTsvFormat(file, text, targetAttachmentFileNames, targetAttachmentRoot);

  if (/^l2_questions(?:_[^/\\]+)?\.tsv$/i.test(path.basename(file))) {
    const structuralRows = parseStructuralTsvRows(text);
    let assignments = [];
    const inferredPassportPath = path.resolve(path.dirname(file), "..", "sources", "diversity_plan.json");
    try {
      const passport = JSON.parse(await fs.readFile(inferredPassportPath, "utf8"));
      assignments = Array.isArray(passport) ? passport : passport.profiles ?? [];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const structuralEvaluation = evaluateDiversity(structuralRows, {
      policy: structuralDiversityPolicy,
      history: (structureRegistry.entries ?? []).filter((entry) => entry.fingerprint),
      assignments,
    });
    for (const finding of structuralEvaluation.findings) {
      addFinding({
        level: finding.level === "REVIEW" ? "WARN" : finding.level,
        file,
        line: structuralRows[finding.index]?.__dataRow ?? 0,
        rule: `structure-${finding.rule}`,
        message: finding.message,
        excerpt: finding.uid || JSON.stringify(finding.details ?? ""),
      });
    }
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const rule of rules) {
      const match = line.match(rule.pattern);
      if (!match) continue;
      addFinding({
        level: rule.level,
        file,
        line: idx + 1,
        rule: rule.id,
        message: rule.message,
        excerpt: lineExcerpt(line, match.index ?? 0),
      });
    }
  });
}

if (!findings.length) {
  console.log("AI style lint PASS: no configured issues found.");
  process.exit(0);
}

for (const item of findings) {
  console.log(`[${item.level}] ${path.relative(root, item.file)}:${item.line} ${item.rule}`);
  console.log(`  ${item.message}`);
  if (item.excerpt) console.log(`  ${item.excerpt}`);
}

const failCount = findings.filter((item) => item.level === "FAIL").length;
const warnCount = findings.filter((item) => item.level === "WARN").length;
console.log(`Summary: ${failCount} fail, ${warnCount} warn`);
process.exit(failCount ? 1 : 0);
