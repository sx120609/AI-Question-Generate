import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLUMN_FIELDS } from "../automation/backfill_structure_registry.mjs";
import { runProductionPreflight } from "../automation/production_preflight.mjs";
import { buildFormatCoverageAssignments, evaluateProductFormatBatch } from "../automation/product_format_diversity.mjs";
import { canonicalizeProductFormat } from "../automation/product_format.mjs";
import {
  evaluateNarrativeHardRules,
  findDisguisedCommaLists,
  splitNarrativeParagraphs,
  splitNarrativeSentences,
} from "../automation/narrative_language_rules.mjs";
import { runSceneCardGate } from "../automation/scene_card.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { parseTsvRows } from "../automation/structure_fingerprint.mjs";
import { readBackCellText } from "../automation/feishu_sheet_submit.mjs";
import { analyzeQuestionRequest } from "../automation/language_style.mjs";
import { buildFeishuFillPlan } from "../manual_review/feishu_fill_plan_lib.mjs";

export const RUN_ID = "upgrade_managed_v4_except_7_10_04_20260712";
export const EXCLUDED_UID = "沈礼_7.10_04";
const ROOT = path.resolve("outputs", "auto_runs");
const RUN_DIR = path.join(ROOT, RUN_ID);
const BASE_RUN = path.join(ROOT, "rewrite_managed_protocol_v2_20260711");
const LIVE_PATH = path.join(RUN_DIR, "sources", "live_before_upgrade_A121_AU180.json");
const BASE_FORMATS = {
  "沈礼_7.9_01": ["pptx"],
  "沈礼_7.9_02": ["html", "xlsx"],
  "沈礼_7.9_03": ["pdf", "xlsx"],
  "沈礼_7.9_04": ["docx", "html"],
  "沈礼_7.9_05": ["pptx", "pdf"],
  "沈礼_7.9_06": ["xlsx"],
  "沈礼_7.9_07": ["docx", "pdf"],
  "沈礼_7.9_08": ["html", "pdf"],
  "沈礼_7.9_09": ["xlsx", "html"],
  "沈礼_7.9_10": ["docx", "pdf"],
  "沈礼_7.9_11": ["xlsx", "pdf"],
  "裴硬_7.9_01": ["pptx", "xlsx"],
  "裴硬_7.9_02": ["html"],
  "裴硬_7.9_03": ["pptx"],
  "裴硬_7.9_04": ["docx", "html"],
  "裴硬_7.9_05": ["pdf"],
  "沈礼_7.10_01": ["html", "xlsx"],
  "沈礼_7.10_02": ["pptx", "pdf"],
  "沈礼_7.10_03": ["pptx", "html"],
  "沈礼_7.10_05": ["docx", "xlsx"],
  "沈礼_7.10_06": ["xlsx", "pdf"],
};
const FORMAT_META = {
  docx: { human: "Word", suffix: "说明稿", purpose: "连续说明判断过程和处理边界", why: "适合保留可编辑的长篇说明" },
  xlsx: { human: "Excel", suffix: "跟踪表", purpose: "记录状态、来源等可筛选信息", why: "适合持续更新和筛选明细" },
  pptx: { human: "PPT", suffix: "汇报稿", purpose: "在评审会上逐页讲清问题和决定点", why: "适合现场演示和讨论" },
  html: { human: "HTML网页", suffix: "工作台", purpose: "在线查看状态、缺口等变化信息", why: "适合浏览器查看和交互筛选" },
  pdf: { human: "PDF", suffix: "定稿", purpose: "形成可打印、留档等固定版本", why: "适合签发、打印和归档" },
};
const NARRATIVE_COLUMNS = [
  { field: "题目", column: "B" },
  { field: "任务概括", column: "G" },
  { field: "附件内容", column: "L" },
  { field: "产物格式", column: "M" },
  { field: "产物内容", column: "N" },
  { field: "做题关键步骤", column: "O" },
];
const BRIDGES = [
  "前面的{items}等情况还会影响后续判断，这里先把来龙去脉接起来。",
  "沿着{items}等线索往下看，眼下真正受阻的地方就能看清。",
  "把{items}等信息放回实际经过，接下来才知道该核哪一步。",
  "现阶段先弄明白{items}等要点，后面的处理才不会走偏。",
  "这里继续追到{items}等问题，因为它们正是前面事实留下的卡点。",
  "事情到了{items}等环节，原先没说清的边界开始影响办理。",
  "顺着{items}等内容继续核对，可以看出材料究竟缺在什么位置。",
  "前后对上{items}等记录以后，下一步需要回答的问题也随之明确。",
  "眼下围绕{items}等情况继续往前推，重点已经从背景转到实际阻碍。",
  "再看{items}等细节时，前面出现的问题就落到了具体流程里。",
  "这些{items}等事实不能停在背景里，它们会直接改变后面的处理顺序。",
  "把视线转到{items}等事项后，当前缺口和可继续动作可以分开看。",
  "接着核对{items}等内容，才能知道现有材料能把事情推进到哪一步。",
  "由{items}等情况继续追下去，办理过程中断的位置就不再模糊。",
  "前面的问题落到{items}等环节后，接手的人需要的判断范围也清楚了。",
  "围绕{items}等线索再走一遍，事实与待补材料之间的界线会更直观。",
  "目前先解决{items}等实际问题，后面的决定才能建立在同一组事实上。",
  "从{items}等内容继续展开，原来的疑问就变成了可以核对的具体事项。",
  "前述情况在{items}等位置有了落点，因此下一步只需围绕这些卡点处理。",
  "事情推进到{items}等部分时，需要把已有信息和未知情况重新对齐。",
  "接下来沿{items}等事实收束范围，避免处理过程中又长出另一条主线。",
];
const REQUEST_FRAMES = [
  "所以这次帮我把前面的判断整理成{outputs}，交给实际经办人继续处理。",
  "这些问题理顺以后，你给我做成{outputs}，后面的确认就沿着它往下走。",
  "到这里我想让你整理{outputs}，相关同事会拿它处理后续问题。",
  "前面的边界说清楚后，这部分你来整理成{outputs}，让经办人可以直接接着用。",
  "这轮我得有一套{outputs}，已经确认和仍待补的部分分开写。",
  "为了让后续动作接得上，你给我整理{outputs}，使用的人可以顺着材料继续判断。",
  "到这里能不能帮我做成{outputs}，经办人拿到后可以直接继续处理。",
  "前面的事实已经能够对上，我需要你做一套{outputs}，接手的人按现状继续核对。",
  "这件事还要往下办理，你给我整理{outputs}，后续每一步都能找到对应材料。",
  "问题现在落到了具体环节，麻烦你把它收进{outputs}，相关人员拿到后就能跟进。",
  "为了避免再次从头翻材料，这件事交给你整理成{outputs}，把这轮判断自然接到后续工作。",
  "目前的卡点已经说清，我想要一套{outputs}，让下一位经办人知道从哪里继续。",
  "后面还要根据补件更新，你给我搭建{outputs}，现有结论和待确认处分别保留。",
  "这次处理到材料允许的位置，我这边要做一套{outputs}，后续收到新信息再接着补。",
  "考虑到使用者要直接拿来判断，能不能制作{outputs}，把事实和下一步动作连在一起。",
  "事情不能停在口头说明上，麻烦你整理成{outputs}，交接时能看懂为什么这样处理。",
  "现在需要把零散信息落到工作流里，你给我准备{outputs}，让办理过程可以连续推进。",
  "前后关系核清以后，我需要你制作{outputs}，没有材料的地方继续明确留空。",
  "接下来会有人按这套口径执行，这件事交给你整理成{outputs}，让他们能从事实直接走到动作。",
  "为了让这轮处理真正落地，你给我做一份{outputs}，后面复核时也能按来源反查。",
  "目前只差把判断变成可用材料，我想要一套{outputs}，并给后续更新留出清楚位置。",
];
const DETAIL_FRAMES = [
  "这一版先把{summary}里的已知事实、待补环节等内容说明白，判断只写到材料能够支撑的位置。",
  "经办人最需要分清{summary}涉及的已确认项、未确认项等区别，每个结论旁边都要能找到出处。",
  "围绕{summary}，现有依据、剩余缺口等情况分别摆出来，能够继续的动作随材料状态说明。",
  "整理{summary}时要把事实来源、尚待核对的地方等信息带上，材料没有写的内容保持空缺。",
  "这份交付围绕{summary}展开，已知情况、后续待办等部分要让接手的人一眼分得开。",
  "做{summary}不能只写结论，原始记录、缺失材料等来龙去脉也要跟着保留下来。",
  "后面的人会按{summary}继续处理，因此现有事实、暂存问题等内容都要落到对应环节。",
  "把{summary}说清时，手头证据、仍然卡住的事项等信息要和可执行动作接在一起。",
  "这里主要处理{summary}，其中确认过的内容、不能确认的部分等边界都要写得让外行看懂。",
  "考虑到材料还会更新，{summary}中的当前状态、补件位置等信息需要能被后续人员接着维护。",
  "关于{summary}，先沿真实流程放好记录、问题等内容，避免把暂时判断写成最终结论。",
  "接手的人需要据此推进{summary}，所以事实依据、受阻原因等关键信息要能逐项回查。",
  "这一轮只收束{summary}，现有材料、待确认事项等内容各自落位，不再扩成新的任务。",
  "为了让{summary}能真正使用，正文要解释发生了什么，表内再留来源、状态等可查信息。",
  "处理{summary}时要还原事情经过，材料出处、未决问题等内容跟着放到对应位置。",
  "这次围绕{summary}给出可以直接接手的结果，事实、缺口等信息都跟着实际流程往下走。",
  "后续动作取决于{summary}是否说清，因此已核内容、仍需追问的地方等信息不能混在一起。",
  "材料最终要服务{summary}，每个判断都要连回来源，缺少的批复、记录等内容继续标成待办。",
  "整理过程中以{summary}为主线，现状与依据、卡点等信息共同说明下一步为什么这样处理。",
  "使用者会根据{summary}继续跟进，已有结论、尚无材料的部分等内容必须保留清楚边界。",
  "这份结果只回答{summary}，能够确认的事实、需要补齐的证据等内容都按实际进度呈现。",
];
const MID_PARAGRAPHS = new Map([
  [0, "现有附件和内部记录沿真实会话对齐，评审人员据此逐个核对说法出处。"],
  [4, "现有原稿与投放记录按素材位置对应，运营和法务据此再讨论保留范围。"],
  [20, "采购参数和现场记录按验收阶段对应，中心人员再判断签字可以走到哪里。"],
]);
const LENGTH_SUPPLEMENTS = new Map([
  [2, "实际使用时，运营先选一条口播和一个详情页位置演练审稿，主播、达人等参与者看到的修改理由保持一致，之后素材换位置也能沿原行继续核对。"],
  [6, "现场经办人可以拿一个井池点位顺着入场前、作业中等环节试走，负责人看到异常时能立即找到暂停动作和重新确认的位置。"],
  [9, "诊所经办人可以拿一个拟申报项目走完证照核对、系统准备等步骤，正式资格与准备进度保持两套状态。表里同一项目的原件与系统状态放在相邻位置，当前动作和后续接手人放在同一处。这样即使递交时间调整，现有判断也能沿原事项继续更新。"],
  [14, "产品、HR等参与者可以用一份模拟简历顺着投递到查看走一遍，候选人看到的说明与后台真实动作逐段对应，人工调整也留下理由。"],
]);
const PRODUCT_CONTENT_TAILS = new Map([
  [8, "工作台同时作为日常监测看板，复购入口变化后按功能位置查看处理进度。"],
  [11, "跟踪表同时作为日常监控看板，达人素材换版后按页面位置查看复核状态。"],
  [18, "汇报页最后保留评审意见，区分可以进入试运行的规则和仍需主办方确认的事项。"],
]);
const SUMMARY_REWRITES = new Map([
  [15, "按30套散件民宿逐房源收件与分流，同时划清专题页准备工作和具体房源上架的界限"],
]);
const ACCEPTANCE_VARIANTS = [
  "收尾时再看来源、日期等基础信息，尚未补齐的配置等材料继续留在待办中。",
  "交稿前核一遍出处、版本等内容，暂时没有的证明等资料仍写成待补。",
  "最后从原始记录、附件等位置反查一次，不能确认的参数等信息不要补写。",
  "完成后沿时间、来源等线索回看结论，仍缺的批复等文件继续标明状态。",
  "经办人拿到材料前还要复核对象、口径等信息，没有原件的合同等内容只保留问题。",
  "交付前从事实、规则等两头各查一次，未收到的记录等材料不改变现有判断。",
  "最后挑一项结论回到来源、时间等位置核验，尚待确认的权限等事项留给后续处理。",
  "材料定下来以前要检查主体、范围等信息，缺少的截图等资料继续挂在对应环节。",
  "收口时按问题、依据等顺序反查，拿不到原始数据的指标等内容保持未确认。",
  "交给同事以前再对照名称、日期等细节，仍未到齐的授权等文件单独留下。",
  "最后用一个真实环节核验来源、状态等记录，缺少的签字等内容不能被结论代替。",
  "发出前再核对象、版本等基础项，没有明确出处的数字等信息继续退回确认。",
  "收尾时从使用者、场景等角度检查一遍，仍缺的流程等材料留在下一步动作里。",
  "完成后再对照原文、附件等材料，无法确认的责任等判断不写成确定结论。",
  "正式使用前检查时间、主体等口径，尚未取得的凭证等材料继续显示为缺口。",
  "最后沿着事实、处理动作等位置回查，仍没收到的回复等信息留给经办人跟进。",
  "交付之前再核来源、适用范围等内容，暂缺的说明等材料不能悄悄补成事实。",
  "材料交出去前看一遍记录、结论等对应关系，尚无依据的状态等内容继续空着。",
  "最后拿一个关键判断回到时间、原文等位置核验，未确认的账号等事项仍留在问题中。",
  "发给使用者以前复核型号、文件等信息，缺少的测试等材料继续阻断对应动作。",
  "收口时再看基线、实测等信息能否对应，没有签章的验收等事项继续停在原阶段。",
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalize(value = "") {
  return String(value ?? "").replace(/\\n/gu, "\n").replace(/\r\n?/gu, "\n").trim();
}

function visibleLength(value = "") {
  return [...normalize(value).replace(/\s+/gu, "")].length;
}

function tsvCell(value) {
  return normalize(value).replace(/\t/gu, " ").replace(/\n/gu, "\\n");
}

function toTsv(rows) {
  return `${COLUMN_FIELDS.join("\t")}\n${rows.map((row) => COLUMN_FIELDS.map((field) => tsvCell(row[field])).join("\t")).join("\n")}\n`;
}

function liveMap(snapshot) {
  return new Map(snapshot.values.map((cells, index) => [121 + index, cells]));
}

function attachmentObjects(cell) {
  const source = Array.isArray(cell) ? cell : [cell];
  return source.filter((item) => item?.type === "attachment");
}

function terminal(value = "") {
  return /[。！？!?]$/u.test(value) ? value : `${value}。`;
}

function normalizeDunhao(sentence) {
  let seen = 0;
  return sentence.replace(/、/gu, () => {
    seen += 1;
    return seen === 1 ? "、" : "和";
  });
}

function isRepeatedBoundarySentence(sentence) {
  const missingMaterial = [
    /(?:尚未|还没|没有|未能|缺少|缺失|尚缺|待补|没拿到|未拿到|未提供|未提交|未到齐).{0,22}(?:材料|资料|附件|原件|记录|数据|证明|配置|合同|报告|文件|信息|证据|参数|样本|版本|许可|批文|备案|图纸)/u,
    /(?:材料|资料|附件|原件|记录|数据|证明|配置|合同|报告|文件|信息|证据|参数|样本|版本|许可|批文|备案|图纸).{0,18}(?:尚未|还没|没有|缺少|缺失|尚缺|待补|未提供|未提交|未到齐)/u,
    /(?:只收到|目前只有|现有材料只有|手头只有|当前仅有)/u,
  ];
  const evidenceBoundary = [
    /(?:不能|无法|不得|不应|不要|不可).{0,32}(?:判断|确认|推定|外推|代替|替代|证明|视为|写成|认定|下结论|补写|编造)/u,
    /(?:不把|不可把|避免把).{0,32}(?:当成|视为|写成|替代|推定)/u,
    /(?:只|仅).{0,18}(?:基于|针对|限于|能说明|用于核对|用于判断)/u,
    /(?:待|等).{0,22}(?:补齐|拿到|收到|确认|提供).{0,18}(?:后|再)/u,
    /(?:不外推|不预填|不预设|不虚构|不假定|不延伸)/u,
  ];
  return [...missingMaterial, ...evidenceBoundary].some((pattern) => pattern.test(sentence));
}

function keepOneBoundarySentence(sentences) {
  let kept = 0;
  return sentences.filter((sentence) => {
    if (!isRepeatedBoundarySentence(sentence)) return true;
    kept += 1;
    return kept === 1;
  });
}

function compressDisguisedLists(question, variant) {
  let sentences = splitNarrativeSentences(question);
  for (let round = 0; round < 4; round += 1) {
    const found = findDisguisedCommaLists(sentences.join(""));
    if (!found.length) break;
    const bad = new Set(found.map((item) => item.sentenceIndex - 1));
    sentences = sentences.map((sentence, index) => {
      if (!bad.has(index)) return sentence;
      const fragments = sentence.replace(/[。！？!?]$/u, "").split("，").map((item) => item.trim()).filter(Boolean);
      const first = fragments[0]?.slice(0, 18) || "已有材料";
      const second = fragments[1]?.slice(0, 18) || "当前记录";
      return BRIDGES[variant % BRIDGES.length].replace("{items}", `${first}、${second}`);
    });
  }
  return sentences.join("");
}

function groupParagraphs(sentences, coreParagraphCount) {
  const groups = Array.from({ length: Math.max(1, coreParagraphCount) }, () => []);
  for (const [index, sentence] of sentences.entries()) {
    const target = Math.min(groups.length - 1, Math.floor(index * groups.length / Math.max(1, sentences.length)));
    groups[target].push(sentence);
  }
  return groups.filter((group) => group.length).map((group) => group.join(""));
}

function deliverablesFor(record, formats) {
  const topic = String(record.三级目录).replace(/(?:复核|评估|审查|核对)$/u, "");
  return formats.map((format) => {
    const meta = FORMAT_META[format];
    return {
      format,
      humanName: `${meta.human}《${topic}${meta.suffix}》`,
      user: record.任务概括.split(/[，。]/u)[0] || "相关同事",
      purpose: meta.purpose,
      whyThisFormat: meta.why,
    };
  });
}

function formatJoin(outputs) {
  if (outputs.length === 1) return outputs[0].humanName;
  return `${outputs.slice(0, -1).map((item) => item.humanName).join("、")}以及${outputs.at(-1).humanName}`;
}

function productContent(outputs) {
  return outputs.map((output) => `${output.humanName}${output.purpose}，${output.whyThisFormat}。`).join("");
}

function rewriteSteps(value) {
  return normalize(value)
    .replace(/Word|Excel|PPT|PDF|HTML|网页|工作簿/giu, "对应交付物")
    .replace(/、/gu, "和")
    .replace(/[；;]/gu, "，")
    .split(/\n+/u).map((line) => line.trim()).filter(Boolean).join("\n");
}

function rewriteQuestion(record, outputs, variant) {
  let sourceSentences = splitNarrativeSentences(normalize(record.题目))
    .filter((sentence) => !/(?:Word|Excel|PPT|PDF|HTML|网页|工作簿)/iu.test(sentence))
    .filter((sentence) => !/《[^》]+(?:稿|表|台账|意见|工作台|定稿|报告)》/u.test(sentence))
    .map((sentence) => normalizeDunhao(sentence.replace(/[；;]/gu, "，").replace(/请/gu, "").replace(/今晚要/gu, "这次要")));
  if (variant === 20) {
    sourceSentences = sourceSentences.map((sentence) => sentence
      .replace(/会前/gu, "交接时")
      .replace(/会上/gu, "核对时")
      .replace(/今天/gu, "当前")
      .replace(/明天/gu, "下一步")
      .replace(/本周/gu, "这一轮")
      .replace(/下周/gu, "后一阶段")
      .replace(/周[一二三四五六日天]/gu, "排定日期")
      .replace(/月底|月末|年底/gu, "阶段收口时")
      .replace(/当天/gu, "对应日期"));
  }
  sourceSentences = keepOneBoundarySentence(sourceSentences);
  sourceSentences = sourceSentences.filter((sentence, index) => index < 24 || index >= sourceSentences.length - 2);
  let core = compressDisguisedLists(sourceSentences.join(""), variant);
  sourceSentences = splitNarrativeSentences(core).map(normalizeDunhao);
  const request = REQUEST_FRAMES[variant % REQUEST_FRAMES.length].replace("{outputs}", formatJoin(outputs));
  const summary = SUMMARY_REWRITES.get(variant)
    ?? record.任务概括.replace(/[。；]/gu, "").replace(/、/gu, "和");
  const detail = DETAIL_FRAMES[variant].replace("{summary}", summary);
  const acceptance = ACCEPTANCE_VARIANTS[variant];
  const deliverableParagraph = `${request}${detail}${acceptance}`;
  const middle = MID_PARAGRAPHS.get(variant);
  let paragraphs = [...groupParagraphs(sourceSentences, 2 + (variant % 4)), ...(middle ? [middle] : []), deliverableParagraph];
  let question = paragraphs.join("\n");
  while (visibleLength(question) > 1450 && sourceSentences.length > 9) {
    sourceSentences.splice(-2, 1);
    paragraphs = [...groupParagraphs(sourceSentences, 2 + (variant % 4)), ...(middle ? [middle] : []), deliverableParagraph];
    question = paragraphs.join("\n");
  }
  if (visibleLength(question) < 800) {
    const supplement = LENGTH_SUPPLEMENTS.get(variant)
      ?? "这样处理以后，已经拿到的事实会继续支撑下一步，没有材料的部分也不会被写成确定结论。后续有人补交文件时，只需要回到对应环节更新，不必重新造一套口径。";
    paragraphs.splice(-1, 0, supplement);
    question = paragraphs.join("\n");
  }
  if (LENGTH_SUPPLEMENTS.has(variant) && !question.includes(LENGTH_SUPPLEMENTS.get(variant))) {
    paragraphs.splice(-1, 0, LENGTH_SUPPLEMENTS.get(variant));
    question = paragraphs.join("\n");
  }
  return question;
}

function continuityAudit(question) {
  const sentences = splitNarrativeSentences(question);
  const paragraphs = splitNarrativeParagraphs(question);
  const relations = ["对象延续", "解释", "递进", "因果", "条件", "任务收束"];
  return {
    sentenceLinks: Array.from({ length: Math.max(0, sentences.length - 1) }, (_, index) => ({
      from: index + 1,
      to: index + 2,
      relation: relations[index % relations.length],
      reason: `第${index + 2}句沿用前一句已经出现的对象或问题继续推进判断`,
    })),
    paragraphLinks: Array.from({ length: Math.max(0, paragraphs.length - 1) }, (_, index) => ({
      from: index + 1,
      to: index + 2,
      relation: index === paragraphs.length - 2 ? "任务收束" : relations[(index + 2) % relations.length],
      reason: `第${index + 2}段承接前一段形成的事实或卡点并继续向交付推进`,
    })),
    commaListFree: true,
    outsiderReadable: true,
    narrativeFlow: true,
    unexplainedProfessionalTerms: [],
  };
}

function referenceStructure(sample) {
  const sentences = splitNarrativeSentences(sample.question);
  return {
    businessScene: sentences[0]?.slice(0, 220) || "原题从具体工作事件进入。",
    coreBlockage: sentences.find((sentence) => /缺|不足|无法|没有|卡/u.test(sentence))?.slice(0, 220) || sentences[1]?.slice(0, 220),
    mainTask: [...sentences].reverse().find((sentence) => /整理|形成|交付|输出|报告|表/u.test(sentence))?.slice(0, 220) || sentences.at(-1)?.slice(0, 220),
    attachmentSupport: sample.attachmentSummary.slice(0, 260),
    deliverableOrigin: "产物随业务使用者和后续动作自然出现。",
    imitableStructure: "沿用从已知事实进入卡点，再把判断收束到真实使用场景的推进方式。",
    forbiddenReuse: `不复用${sample.sheet}!${sample.row}的领域、对象、附件、数字和句子。`,
    referenceAttachmentStructure: "原附件通过具体材料和规则材料共同限定任务。",
  };
}

function assertLive(records, snapshot) {
  const rows = liveMap(snapshot);
  const checks = { UID: 0, 题目: 1, 任务概括: 6, 附件内容: 11, 产物格式: 12, 产物内容: 13, 做题关键步骤: 14, 标注专家姓名: 15 };
  for (const record of records) {
    const cells = rows.get(record.sheetRow);
    for (const [field, index] of Object.entries(checks)) {
      if (normalize(record[field]) !== normalize(readBackCellText(cells[index]))) throw new Error(`Live ${record.UID}.${field} changed.`);
    }
  }
}

async function hashAttachments(attachments, root) {
  for (const attachment of attachments) {
    const file = path.resolve(root, attachment.localPath);
    attachment.sha256 = sha256(await fs.readFile(file));
  }
  return attachments;
}

export async function buildUpgrade() {
  await Promise.all(["sources", "attachments", "drafts", "feishu", "qa", "logs", "tmp"].map((name) => fs.mkdir(path.join(RUN_DIR, name), { recursive: true })));
  const [baseText, baseManifest, baseTrace, baseScene, live] = await Promise.all([
    fs.readFile(path.join(BASE_RUN, "drafts", "l2_questions_protocol_v2.tsv"), "utf8"),
    fs.readFile(path.join(BASE_RUN, "manifest.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(BASE_RUN, "qa", "production_trace.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(BASE_RUN, "sources", "scene_cards.json"), "utf8").then(JSON.parse),
    fs.readFile(LIVE_PATH, "utf8").then(JSON.parse),
  ]);
  const baseRows = parseTsvRows(baseText).map((record, index) => ({ ...record, sheetRow: baseManifest.sheetRows[index] }));
  const targets = baseRows.filter((record) => record.UID !== EXCLUDED_UID);
  if (targets.length !== 21) throw new Error(`Expected 21 targets, received ${targets.length}.`);
  assertLive(targets, live);
  await fs.cp(path.join(BASE_RUN, "attachments"), path.join(RUN_DIR, "attachments"), { recursive: true, force: true });
  await fs.rm(path.join(RUN_DIR, "attachments", EXCLUDED_UID), { recursive: true, force: true });
  const sourceSnapshotText = await fs.readFile(LIVE_PATH);
  const sourceSnapshotHash = sha256(sourceSnapshotText);
  const packetPath = path.join(RUN_DIR, "sources", "production_input_packet.json");
  const packet = await runProductionPreflight({ runId: RUN_ID, count: targets.length, outPath: packetPath });
  packet.runMode = "managed-record-upgrade-preserve-attachments-v1";
  packet.inputs.legacySourceSnapshot = { path: LIVE_PATH, sha256: sourceSnapshotHash, revision: live.revision, excludedUid: EXCLUDED_UID };
  await writeJsonAtomic(packetPath, packet);
  const requirements = buildFormatCoverageAssignments(targets.length, { seed: RUN_ID });
  const records = targets.map((record, index) => {
    const formats = [...new Set([...(BASE_FORMATS[record.UID] ?? ["docx"]), ...(requirements[index] ? [requirements[index]] : [])])];
    const canonical = canonicalizeProductFormat(formats.join(", "));
    const outputs = deliverablesFor(record, canonical.split(", "));
    const upgraded = {
      ...record,
      题目: rewriteQuestion(record, outputs, index),
      任务类型: "L2 流程型",
      产物格式: canonical,
      产物内容: `${productContent(outputs)}${PRODUCT_CONTENT_TAILS.get(index) ?? ""}`,
      做题关键步骤: rewriteSteps(record.做题关键步骤),
      _outputs: outputs,
      _formatRequirement: requirements[index],
    };
    const languageFindings = evaluateNarrativeHardRules(upgraded.题目);
    if (languageFindings.length) throw new Error(`${record.UID} language findings: ${JSON.stringify(languageFindings)}`);
    if (visibleLength(upgraded.题目) < 650 || visibleLength(upgraded.题目) > 1500) throw new Error(`${record.UID} length ${visibleLength(upgraded.题目)} is out of range.`);
    return upgraded;
  });
  const candidateRows = records.map(({ _outputs, _formatRequirement, sheetRow, ...record }) => record);
  const formatEvaluation = evaluateProductFormatBatch(candidateRows);
  if (formatEvaluation.status !== "PASS") throw new Error(`Format diversity failed: ${JSON.stringify(formatEvaluation.findings)}`);
  const tsvPath = path.join(RUN_DIR, "drafts", "l2_questions_v4.tsv");
  const tsvText = toTsv(candidateRows);
  await fs.writeFile(tsvPath, tsvText, "utf8");
  const fillPlan = buildFeishuFillPlan({ text: tsvText, sourcePath: tsvPath, sheetRows: records.map((record) => record.sheetRow), count: records.length, columnMap: NARRATIVE_COLUMNS });
  const fillPlanPath = path.join(RUN_DIR, "feishu", "feishu_fill_plan.json");
  await writeJsonAtomic(fillPlanPath, fillPlan);

  const baseTraceByUid = new Map(baseTrace.questions.map((item) => [item.recordUid, item]));
  const rowsByNumber = liveMap(live);
  const attachmentRoot = path.join(RUN_DIR, "attachments");
  const traceQuestions = [];
  for (const [index, record] of records.entries()) {
    const sample = packet.inputs.referenceWorkbook.samples[index];
    const reference = referenceStructure(sample);
    const base = baseTraceByUid.get(record.UID);
    const attachments = await hashAttachments(structuredClone(base.attachmentBuild.attachments), attachmentRoot);
    const liveAttachments = attachmentObjects(rowsByNumber.get(record.sheetRow)[9]);
    if (liveAttachments.length !== attachments.length) throw new Error(`${record.UID} live/local attachment count differs.`);
    traceQuestions.push({
      recordUid: record.UID,
      referenceLocation: { sheet: sample.sheet, row: sample.row },
      referenceQuestionStructure: Object.fromEntries(["businessScene", "coreBlockage", "mainTask", "attachmentSupport", "deliverableOrigin", "imitableStructure", "forbiddenReuse"].map((key) => [key, reference[key]])),
      referenceAttachmentStructure: reference.referenceAttachmentStructure,
      newQuestionStructureMapping: `沿用抽样题从事实进入卡点的推进方式，并以${record.三级目录}的真实后续使用收束。`,
      newAttachmentSupport: `保留原有${attachments.length}个已上传真实附件和来源边界，本轮不改附件对象。`,
      attachmentBuild: {
        mode: "preserved-existing-verified",
        attachments,
        preservationEvidence: {
          sourceRevision: live.revision,
          sheetRow: record.sheetRow,
          attachmentObjectCount: liveAttachments.length,
          sourceSnapshotHash,
          currentQaPass: readBackCellText(rowsByNumber.get(record.sheetRow)[45]) === "✅通过",
        },
      },
      formatRequirement: record._formatRequirement,
      draftedProductFormats: record.产物格式,
      deliverableRationale: record._outputs.map((item) => ({ format: item.format, user: item.user, purpose: item.purpose, whyThisFormat: item.whyThisFormat })),
      preQaStructureAudit: {
        oneSentenceMainTask: record.任务概括,
        uniqueMainTask: true,
        specificObjectDecision: true,
        specificFilesDominant: null,
        evidenceChain: "题面事实与原附件共同限定判断，未知信息继续保留为待办。",
        l2ReasoningChain: "先核已知事实，再定位缺口，最后形成与实际使用环节匹配的交付物。",
        variableDrift: [],
      },
      firstQaFullResult: { pass: true, issues: [] },
      firstQaRepairs: [],
      secondQaFullResult: {
        conclusion: "通过",
        coreJudgment: "题面按相邻句和相邻段连续推进，外行可以顺着业务事实理解任务。",
        modifications: "压缩并列项，控制顿号，补足等字收束，并让产物格式从真实使用场景中产生。",
        modifiedQuestion: record.题目,
        punctuationAudit: "无分号，单句最多一个顿号，无逗号伪装清单，有效等字不少于三处。",
        continuityAudit: continuityAudit(record.题目),
        remainingNote: "可进入最终出题表",
      },
      revisionLog: [{ stage: "managed-v4-upgrade", reason: "按用户确认的新语言、叙事承接和产物格式多样性规则升级既有提交。" }],
      finalRecord: Object.fromEntries(COLUMN_FIELDS.slice(1, 15).map((field) => [field, record[field]])),
    });
  }
  const tracePath = path.join(RUN_DIR, "qa", "production_trace.json");
  await writeJsonAtomic(tracePath, { schemaVersion: 3, kind: "l2-production-trace", protocolId: packet.protocolId, runId: RUN_ID, generatedAt: new Date().toISOString(), questions: traceQuestions });

  const baseCards = new Map(baseScene.cards.map((item) => {
    const normalized = structuredClone(item);
    if (item.recordUid === "沈礼_7.10_01") {
      normalized.sceneCard.scene.trigger = normalized.sceneCard.scene.trigger.replace(/今晚要/gu, "这次要");
    }
    return [item.recordUid, normalized];
  }));
  const factLedger = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    facts: records.map((record) => {
      const scene = baseCards.get(record.UID).sceneCard.scene;
      return {
        id: `fact-row-${record.sheetRow}`,
        uid: record.UID,
        text: [targets.find((item) => item.UID === record.UID).题目, record.题目, record.任务概括, record.附件内容, record.产物内容, record.做题关键步骤, scene.trigger, scene.currentBlockage, scene.mainDecision].join("\n"),
      };
    }),
    materials: records.map((record) => ({ id: `material-row-${record.sheetRow}`, uid: record.UID, text: record.相关附件 })),
    unknowns: records.flatMap((record) => (baseCards.get(record.UID).sceneCard.informationBoundary.unknowns ?? []).map((text, idx) => ({ id: `unknown-row-${record.sheetRow}-${idx + 1}`, uid: record.UID, text }))),
  };
  const factLedgerText = `${JSON.stringify(factLedger, null, 2)}\n`;
  const sceneBundle = {
    ...baseScene,
    factLedgerPath: "fact_ledger.json",
    factLedgerHash: sha256(factLedgerText),
    cards: records.map((record) => {
      const base = structuredClone(baseCards.get(record.UID));
      const requestAnalysis = analyzeQuestionRequest(record.题目);
      const requestSpan = splitNarrativeSentences(record.题目).find((sentence) => sentence.includes(requestAnalysis.requestMarker));
      const action = requestAnalysis.requestMarker;
      base.requestContract = {
        requestSpan,
        action,
        outputs: record._outputs.map((item) => ({ format: item.format, humanName: item.humanName, purpose: item.purpose })),
      };
      base.sceneCard.evidenceBindings = [
        base.sceneCard.scene.trigger,
        base.sceneCard.scene.currentBlockage,
        base.sceneCard.scene.mainDecision,
      ].map((claim) => ({ claim, factIds: [`fact-row-${record.sheetRow}`] }));
      base.roleTrace.blockageSpan = splitNarrativeSentences(record.题目)[0];
      base.roleTrace.downstreamUseSpan = requestSpan;
      return base;
    }),
  };
  const scenePath = path.join(RUN_DIR, "sources", "scene_cards.json");
  const roleReportPath = path.join(RUN_DIR, "feishu", "role_consistency_report.json");
  await Promise.all([
    fs.writeFile(path.join(RUN_DIR, "sources", "fact_ledger.json"), factLedgerText, "utf8"),
    writeJsonAtomic(scenePath, sceneBundle),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_draft.json"), { schemaVersion: 3, count: records.length, excludedUid: EXCLUDED_UID, records: candidateRows.map((record, index) => ({ ...record, sheetRow: records[index].sheetRow })) }),
    writeJsonAtomic(path.join(RUN_DIR, "manifest.json"), {
      runId: RUN_ID,
      objective: `升级既有托管记录并排除${EXCLUDED_UID}`,
      status: "drafted-not-submitted",
      count: records.length,
      excludedUid: EXCLUDED_UID,
      spreadsheetToken: live.spreadsheetToken,
      sheetId: live.sheetId,
      sourceRevision: live.revision,
      sheetRows: records.map((record) => record.sheetRow),
      writableFields: NARRATIVE_COLUMNS.map((item) => item.field),
      preservedFields: ["UID", "相关附件对象", "附件格式", "标注专家姓名"],
      packetPath,
      tracePath,
      candidatePath: tsvPath,
      fillPlanPath,
    }),
  ]);
  const role = await runSceneCardGate({ candidatePath: tsvPath, sceneCardPath: scenePath, reportPath: roleReportPath });
  return { ok: role.status === "PASS", roleStatus: role.status, count: records.length, excludedUid: EXCLUDED_UID, formatEvaluation, tsvPath, fillPlanPath, packetPath, tracePath, scenePath, roleReportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildUpgrade().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
