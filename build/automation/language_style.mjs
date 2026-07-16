const POLITE_LEXICAL_USE_PATTERN = /申请|邀请|请示|请求|提请|报请|聘请|宴请|请(?:过|了)?假|请款|请柬|请客|请安/gu;

const DIRECT_REQUEST_FRAMES = Object.freeze([
  ["polite-request", /请(?:先|再|只)?(?:基于|结合|把|将|做|整理|生成|写|输出|准备|制作|汇总|梳理|核对|分析|测算|评估|搭建)/u],
  ["help-me", /(?:你|你们)?帮(?:我|我们)(?:忙)?(?:把|将|做|整理|生成|写|出|准备|制作|汇总|梳理|核对|分析|测算|评估|搭建)/u],
  ["give-me", /(?:你|你们)?给(?:我|我们)(?:做|整理|生成|写|出|准备|制作|汇总|梳理|核对|分析|测算|评估|搭建)/u],
  ["need-you", /(?:(?:我|我们)(?:现在)?)?需要(?:你|你们)(?:帮(?:我|我们)?|来)?(?:把|将|做|整理|生成|写|出|准备|制作|汇总|梳理|核对|分析|测算|评估|搭建)/u],
  ["want-you", /(?:我|我们)(?:想|希望)让(?:你|你们)(?:帮(?:我|我们)?|来)?(?:把|将|做|整理|生成|写|出|准备|制作|汇总|梳理|核对|分析|测算|评估|搭建)/u],
  ["want-artifact", /(?:我|我们)(?:想要|需要)(?:一份|一张|一套|一个|一版)/u],
  ["trouble-you", /麻烦(?:你|你们)?(?:帮(?:我|我们)?|把|将|做|整理|生成|写|出|准备|制作|汇总|梳理|核对|分析|测算|评估|搭建)/u],
  ["for-me", /(?:你|你们)?替(?:我|我们)(?:把|将|做|整理|生成|写|出|准备|制作|汇总|梳理|核对|分析|测算|评估|搭建)/u],
  ["can-you", /(?:能不能|能否|可不可以|可以不可以|看能不能)(?:先|再|也)?(?:帮(?:我|我们)?(?:把|将)?|把|将|做|整理|生成|写|出|准备|制作|汇总|梳理|核对|分析|测算|评估|搭建)/u],
  ["you-take-it", /(?:这块|这件事|这部分|后面的|剩下的)?(?:就|先|再)?(?:交给你|你(?:来|先|再|也|就)?)(?:帮忙)?(?:把|将|做|整理|生成|写|出|准备|制作|汇总|梳理|核对|分析|测算|评估|搭建|处理)/u],
  ["need-one", /(?:我|我们)(?:这边)?(?:现在|这次|还|最终)?(?:得有|还缺|想做|想整理|想出|要做|要整理|要出)(?:一份|一张|一套|一个|一版)/u],
  ["take-a-look", /(?:你|你们)(?:先|再|也|就)?(?:看一下|看下|过一下|帮忙看|处理一下)(?:[^。！？!?]{0,48})(?:整理|做|出|写|生成)(?:成)?(?:一份|一张|一套|一个|一版)/u],
]);

const DELIVERABLE_PATTERN = /\b(?:Word|Excel|PPT|PDF)\b|文档|表格|工作簿|清单|报告|说明|方案|台账|底稿|简报|网页|邮件|脚本|模型|图表|话术|模板|手册|备忘录|材料|交付物/iu;
const HUMAN_FORMAT_PATTERN = /\b(?:Word|Excel|PPT|PDF)\b|网页/iu;
const WORK_ORDER_ACTION_PATTERN = /(?:整理成|整理为|形成|输出|交付|制作|准备|完成|做成|工作成果为|工作成果由|材料由|成果由|需要(?=Word|Excel|PPT|网页|一份|一张|一套|一个|一版)|使用(?=Word|Excel|PPT|网页|一份|一张|一套|一个|一版)|以(?=Word|Excel|PPT|网页))/u;

const PRODUCT_FORMAT_MENTIONS = Object.freeze({
  docx: /\b(?:Word|DOCX)\b|\.docx\b|文档|文稿/iu,
  xlsx: /\b(?:Excel|XLSX)\b|\.xlsx\b|工作簿/iu,
  pptx: /\b(?:PPT|PPTX)\b|\.pptx\b|演示文稿/iu,
  pdf: /\bPDF\b/iu,
  html: /\bHTML\b|网页|页面/iu,
});

export const GENERATED_NARRATIVE_FIELDS = ["题目", "任务概括", "产物内容", "做题关键步骤"];

export function formatQuestionAsSingleParagraph(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

export function assertSingleParagraphQuestion(value, { label = "record" } = {}) {
  if (/\r|\n/u.test(String(value ?? ""))) {
    throw new Error(`${label} 题目 must be a single paragraph without line breaks.`);
  }
}

export function assertNaturalQuestionPresentation(value, { label = "record", maximumParagraphs = 8 } = {}) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!text) throw new Error(`${label} 题目 must not be empty.`);
  if (/\n\s*\n/u.test(text)) {
    throw new Error(`${label} 题目 must not contain blank lines; use one line break between compact paragraphs.`);
  }
  const paragraphs = text.split(/\n+/u).map((item) => item.trim()).filter(Boolean);
  if (paragraphs.length > maximumParagraphs) {
    throw new Error(`${label} 题目 has ${paragraphs.length} paragraphs; use at most ${maximumParagraphs} natural paragraphs.`);
  }
  const listLine = text
    .split("\n")
    .find((line) => /^\s*(?:[-*•]|(?:\d+|[一二三四五六七八九十]+)[.、)])\s*/u.test(line));
  if (listLine) {
    throw new Error(`${label} 题目 must use prose paragraphs, not a bullet or numbered specification list.`);
  }
  return { paragraphCount: paragraphs.length };
}

export function analyzeQuestionRequest(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  let matchedFrame = DIRECT_REQUEST_FRAMES
    .map(([frame, pattern]) => ({ frame, match: text.match(pattern) }))
    .find((item) => item.match);
  if (!matchedFrame) {
    const workOrderMatches = [...text.matchAll(new RegExp(WORK_ORDER_ACTION_PATTERN.source, "gu"))];
    const workOrderMatch = workOrderMatches
      .map((match) => {
        const actionIndex = match.index ?? 0;
        const sentenceStart = Math.max(
          text.lastIndexOf("。", actionIndex - 1),
          text.lastIndexOf("！", actionIndex - 1),
          text.lastIndexOf("？", actionIndex - 1),
          text.lastIndexOf("!", actionIndex - 1),
          text.lastIndexOf("?", actionIndex - 1),
        ) + 1;
        const sentencePrefix = text.slice(sentenceStart, actionIndex).trim();
        const window = text.slice(actionIndex, actionIndex + 140);
        const formatOffset = window.search(HUMAN_FORMAT_PATTERN);
        const formatAlreadyNamed = HUMAN_FORMAT_PATTERN.test(sentencePrefix);
        const needsSituatedOwner = /^(?:需要|使用|以)$/u.test(match[0]);
        const situatedOwnerPresent = !needsSituatedOwner || [...sentencePrefix.replace(/\s+/gu, "")].length >= 2;
        return { match, formatOffset, formatAlreadyNamed, situatedOwnerPresent };
      })
      .filter((item) => item.formatOffset >= 0 && !item.formatAlreadyNamed && item.situatedOwnerPresent)
      .sort((left, right) => left.formatOffset - right.formatOffset)[0]?.match;
    if (workOrderMatch) matchedFrame = { frame: `work-order-${workOrderMatch[0]}`, match: workOrderMatch };
  }
  const requestIndex = matchedFrame?.match?.index ?? -1;
  const requestSentenceIndex = requestIndex < 0
    ? -1
    : (text.slice(0, requestIndex).match(/[。！？!?]/gu) ?? []).length;
  // Human-approved formal-sheet requests often establish the work first and
  // name the exact files in the following paragraph. Keep the action binding,
  // but let the deliverable appear later in the same requester message.
  const requestWindow = requestIndex < 0 ? "" : text.slice(requestIndex);
  const deliverableMatch = requestWindow.match(DELIVERABLE_PATTERN);
  const globalDeliverableIndex = deliverableMatch && requestIndex >= 0
    ? text.indexOf(deliverableMatch[0], requestIndex)
    : -1;
  return {
    clear: Boolean(matchedFrame && deliverableMatch),
    frame: matchedFrame?.frame ?? "",
    requestMarker: matchedFrame?.match?.[0] ?? "",
    requestIndex,
    requestSentenceIndex,
    deliverableMarker: deliverableMatch?.[0] ?? "",
    deliverableIndex: globalDeliverableIndex,
  };
}

export function missingQuestionDeliverableFormats(value, productFormats = "") {
  const text = String(value ?? "");
  const formats = String(productFormats ?? "")
    .toLowerCase()
    .split(/[,，]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return formats.filter((format) => PRODUCT_FORMAT_MENTIONS[format] && !PRODUCT_FORMAT_MENTIONS[format].test(text));
}

export function assertClearQuestionRequest(value, { label = "record", productFormats = "" } = {}) {
  const analysis = analyzeQuestionRequest(value);
  if (!analysis.clear) {
    throw new Error(
      `${label} 题目 must contain a direct user request or actionable work order with an organizing/production action and a concrete deliverable.`,
    );
  }
  const missingFormats = missingQuestionDeliverableFormats(value, productFormats);
  if (missingFormats.length) {
    throw new Error(`${label} 题目 must name every requested output format in human terms: ${missingFormats.join(", ")}.`);
  }
  return { ...analysis, missingFormats };
}

export function analyzeQuestionPunctuation(value) {
  const text = String(value ?? "").replace(/\s+/gu, "").trim();
  const punctuationText = text
    .replace(/https?:\/\/[^，。！？!?；;\s]+/giu, "")
    .replace(/(?<=\d):(?=\d)/gu, "");
  const firstTerminalIndex = text.search(/[。！？!?]/u);
  const firstSentence = firstTerminalIndex >= 0 ? text.slice(0, firstTerminalIndex + 1) : text;
  const firstPunctuationMatch = text.match(/[，。！？!?：:；;、]/u);
  const count = (pattern) => [...text.matchAll(pattern)].length;
  const commaCount = count(/，/gu);
  const periodCount = count(/。/gu);
  const colonCount = [...punctuationText.matchAll(/[：:]/gu)].length;
  const semicolonCount = count(/[；;]/gu);
  const enumerationCommaCount = count(/、/gu);
  const structuralPunctuationCount = colonCount + semicolonCount;
  const visibleCharacters = Math.max(1, [...text].length);
  const terminalSentenceLengths = text
    .split(/(?<=[。！？!?])/u)
    .filter(Boolean)
    .map((sentence) => [...sentence.replace(/[。！？!?]$/u, "")].length);
  return {
    visibleCharacters,
    firstSentence,
    firstSentenceLength: [...firstSentence.replace(/[。！？!?]$/u, "")].length,
    firstSentenceCommaCount: [...firstSentence.matchAll(/，/gu)].length,
    firstPunctuation: firstPunctuationMatch?.[0] ?? "",
    firstPunctuationIndex: firstPunctuationMatch?.index ?? -1,
    firstPunctuationIsTerminal: /[。！？!?]/u.test(firstPunctuationMatch?.[0] ?? ""),
    commaCount,
    periodCount,
    colonCount,
    semicolonCount,
    enumerationCommaCount,
    structuralPunctuationCount,
    commaToPeriodRatio: Number((commaCount / Math.max(1, periodCount)).toFixed(4)),
    enumerationCommasPer100Chars: Number(((enumerationCommaCount * 100) / visibleCharacters).toFixed(4)),
    structuralPunctuationPer100Chars: Number(((structuralPunctuationCount * 100) / visibleCharacters).toFixed(4)),
    earlyStructuralPunctuation: /[：:；;]/u.test(punctuationText.slice(0, 80)),
    containsSemicolon: semicolonCount > 0,
    maximumTerminalSentenceLength: Math.max(0, ...terminalSentenceLengths),
  };
}

export function findPoliteImperatives(value) {
  const text = String(value ?? "");
  const lexicalRanges = [...text.matchAll(POLITE_LEXICAL_USE_PATTERN)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const matches = [];
  for (const match of text.matchAll(/请/gu)) {
    const index = match.index ?? 0;
    if (lexicalRanges.some((range) => index >= range.start && index < range.end)) continue;
    matches.push({ index, marker: match[0] });
  }
  return matches;
}

export function findPoliteImperative(value) {
  return findPoliteImperatives(value)[0] ?? null;
}

export function assertNoPoliteImperative(record, { fields = GENERATED_NARRATIVE_FIELDS, label = "record" } = {}) {
  for (const field of fields) {
    const match = findPoliteImperative(record?.[field]);
    if (!match) continue;
    throw new Error(`${label} ${field} contains a polite imperative marker at character ${match.index + 1}.`);
  }
}
