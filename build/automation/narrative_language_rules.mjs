export const NARRATIVE_LANGUAGE_POLICY_ID = "connected-plain-narrative-v1";
export const MIN_ENUMERATION_DENG = 3;
export const MAX_ENUMERATION_COMMAS_PER_SENTENCE = 1;

const ALLOWED_RELATIONS = new Set([
  "因果", "解释", "递进", "转折", "条件", "时间推进", "对象延续", "任务收束",
]);

const NON_ENUMERATION_DENG = /等待|等于|等级|等同|等额|等候|等价|等身|等分|等号|等温|等比|等效|等式|平等|相等|同等|高等|初等|优等|次等|劣等|均等|不等/gu;
const CLAUSE_SIGNAL = /(?:是|有|会|要|需|应|把|让|将|能|可|由|在|向|给|用|看|做|写|整理|分析|判断|核对|形成|说明|记录|检查|确认|发现|出现|已经|仍然|继续|需要|负责|影响|决定|提供|包含|暴露|导致|进入|回到|保留|缺少|拿到|完成|交付|使用|比较|还原|解释|列为)/u;
const LOGIC_SIGNAL = /(?:因此|所以|但|不过|同时|随后|这样|其中|如果|为了|由于|而且|还要|再|先|当|只有|并且|也要|则|从而|于是|这就|这会|这类|上述|前面|接下来|最后)/u;

export function splitNarrativeSentences(value = "") {
  return String(value)
    .split(/(?<=[。！？!?])/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitNarrativeParagraphs(value = "") {
  return String(value).split(/\n+/u).map((item) => item.trim()).filter(Boolean);
}

export function countEnumerationDeng(value = "") {
  const withoutLexicalWords = String(value).replace(NON_ENUMERATION_DENG, "").replace(/等等/gu, "等");
  return (withoutLexicalWords.match(/等/gu) ?? []).length;
}

function visibleLength(value = "") {
  return [...String(value).replace(/[\s，。！？!?、“”‘’（）()]/gu, "")].length;
}

function listLikeFragment(value = "") {
  const text = String(value).replace(/^[（(][^）)]*[）)]/u, "").trim();
  return visibleLength(text) >= 2 && visibleLength(text) <= 14
    && !CLAUSE_SIGNAL.test(text)
    && !LOGIC_SIGNAL.test(text);
}

export function findDisguisedCommaLists(value = "") {
  const findings = [];
  for (const [sentenceIndex, sentence] of splitNarrativeSentences(value).entries()) {
    const fragments = sentence.replace(/[。！？!?]$/u, "").split("，").map((item) => item.trim()).filter(Boolean);
    if (fragments.length < 3) continue;
    let run = 0;
    let maximumRun = 0;
    for (const fragment of fragments) {
      run = listLikeFragment(fragment) ? run + 1 : 0;
      maximumRun = Math.max(maximumRun, run);
    }
    const startsAsThreeItemList = fragments.length >= 3
      && listLikeFragment(fragments[0])
      && listLikeFragment(fragments[1])
      && visibleLength(fragments[2]) <= 20
      && !LOGIC_SIGNAL.test(fragments[2]);
    if (maximumRun >= 3 || startsAsThreeItemList) {
      findings.push({ sentenceIndex: sentenceIndex + 1, sentence, fragments });
    }
  }
  return findings;
}

export function evaluateNarrativeHardRules(value = "") {
  const question = String(value);
  const findings = [];
  if (/[；;]/u.test(question)) findings.push({ rule: "semicolon-forbidden" });
  if (/\n\s*\n/u.test(question)) findings.push({ rule: "blank-line-forbidden" });
  const dengCount = countEnumerationDeng(question);
  if (dengCount < MIN_ENUMERATION_DENG) {
    findings.push({ rule: "enumeration-deng-below-minimum", expected: MIN_ENUMERATION_DENG, actual: dengCount });
  }
  for (const [sentenceIndex, sentence] of splitNarrativeSentences(question).entries()) {
    const count = (sentence.match(/、/gu) ?? []).length;
    if (count > MAX_ENUMERATION_COMMAS_PER_SENTENCE) {
      findings.push({
        rule: "enumeration-comma-over-limit",
        sentenceIndex: sentenceIndex + 1,
        expectedMaximum: MAX_ENUMERATION_COMMAS_PER_SENTENCE,
        actual: count,
        sentence,
      });
    }
  }
  for (const disguised of findDisguisedCommaLists(question)) {
    findings.push({ rule: "comma-disguised-list", ...disguised });
  }
  return findings;
}

function validateLinkSequence(links, expectedCount, label, findings) {
  if (!Array.isArray(links)) {
    findings.push({ rule: `${label}-links-missing` });
    return;
  }
  if (links.length !== expectedCount) {
    findings.push({ rule: `${label}-link-count`, expected: expectedCount, actual: links.length });
  }
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index] ?? {};
    if (Number(link.from) !== index + 1 || Number(link.to) !== index + 2) {
      findings.push({ rule: `${label}-link-sequence`, index: index + 1, from: link.from, to: link.to });
    }
    if (!ALLOWED_RELATIONS.has(String(link.relation ?? ""))) {
      findings.push({ rule: `${label}-link-relation`, index: index + 1, relation: link.relation ?? "" });
    }
    if (visibleLength(link.reason) < 8) {
      findings.push({ rule: `${label}-link-reason-too-short`, index: index + 1 });
    }
  }
}

export function validateContinuityAudit(question, audit) {
  const findings = [];
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    return [{ rule: "continuity-audit-missing" }];
  }
  const sentences = splitNarrativeSentences(question);
  const paragraphs = splitNarrativeParagraphs(question);
  validateLinkSequence(audit.sentenceLinks, Math.max(0, sentences.length - 1), "sentence", findings);
  validateLinkSequence(audit.paragraphLinks, Math.max(0, paragraphs.length - 1), "paragraph", findings);
  if (audit.commaListFree !== true) findings.push({ rule: "continuity-audit-comma-list-not-clear" });
  if (audit.outsiderReadable !== true) findings.push({ rule: "continuity-audit-not-outsider-readable" });
  if (audit.narrativeFlow !== true) findings.push({ rule: "continuity-audit-not-narrative-flow" });
  if (!Array.isArray(audit.unexplainedProfessionalTerms)) {
    findings.push({ rule: "continuity-audit-jargon-list-missing" });
  } else if (audit.unexplainedProfessionalTerms.length) {
    findings.push({ rule: "unexplained-professional-terms", terms: audit.unexplainedProfessionalTerms });
  }
  return findings;
}
