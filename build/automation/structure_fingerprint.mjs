import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STRUCTURAL_DIVERSITY_POLICY_PATH = path.resolve(
  __dirname,
  "../../config/structural_diversity.json",
);

const INFORMATION_ORDER_PATTERNS = [
  ["trigger", /截至|今天|明天|本周|下周|会前|刚收到|被退回|投诉|异常|事故|抽检|催/],
  ["actor", /我|我们|老板|客户|用户|项目组|委员会|运营|产品|法务|财务|研发|供应商|负责人|经办人|药师|物业|学校|园方|平台/],
  ["facts", /\d|金额|数量|占比|批次|型号|版本|报表|台账|样机|合同|订单|记录/],
  ["conflict", /但|却|争议|分歧|担心|质疑|不同意|卡住|不一致|异常|各执一词/],
  ["evidence", /附件|资料|数据|报告|合同|流水|日志|截图|公示|规则|记录|底表/],
  ["gap", /缺少|缺失|未提供|没拿到|没有|不足|待补|待确认|无法确认|不能证明/],
  ["decision", /决定|判断|是否|能否|要不要|选择|放行|排序|分流|分档|建议|结论/],
  ["deliverable", /Word|Excel|PPT|docx|xlsx|pptx|文档|工作簿|表格|简报|备忘录|台账/iu],
  ["audience", /给.{0,20}(看|用|过会|拍板|回复)|供.{0,20}(讨论|决策|复核)|会上|客户回复|投委会|评审会/],
  ["acceptance", /验收|可追溯|保留公式|逐项对应|能回到|不得外推|不替代|边界|复核通过/],
];

const INFORMATION_UNIT_PATTERNS = {
  actor: /我|我们|老板|客户|用户|家长|项目组|委员会|运营|产品|法务|财务|研发|供应商|负责人|经办人|管理员|经理|主任|药师|物业|学校|园方|平台/,
  audience: /给.{0,24}(看|用|过会|拍板|回复)|供.{0,24}(讨论|决策|复核)|投委会|评审会|协调会|管理层|客户回复/,
  time: /截至\d{4}|\d{4}年|今天|明天|次日|今晚|本周|下周|月底|会前|周[一二三四五六日天]|小时内/,
  trigger: /刚收到|被退回|投诉|异常|事故|抽检|催|争议|到货|上线|续签|改版|试点|灰度|大修|审计|检查发现/,
  facts: /\d|金额|数量|占比|批次|型号|版本|营收|利润|现金流|箱|台|份|条|万元|亿元|Wh|%/i,
  conflict: /但|却|争议|分歧|担心|质疑|不同意|卡住|不一致|异常|各执一词|认为.{0,24}(可以|不能|应该)/,
  gap: /缺少|缺失|未提供|没拿到|没有|不足|待补|待确认|无法确认|不能证明|尚未|只收到|只有/,
  evidence: /附件|资料|数据|报告|合同|流水|日志|截图|公示|规则|记录|底表|年报|清单|报价/,
  decision: /决定|判断|是否|能否|要不要|选择|放行|排序|分流|分档|建议|结论|推进|暂缓|验收合格/,
  deliverable: /Word|Excel|PPT|docx|xlsx|pptx|文档|工作簿|表格|简报|备忘录|台账|看板/iu,
  acceptance: /验收|可追溯|保留公式|逐项对应|能回到|不得外推|不替代|边界|复核通过|原始数据|来源页码/,
};

const INFORMATION_ORDERS = [
  ["trigger", "facts", "conflict", "evidence", "gap", "decision", "audience", "deliverable", "acceptance"],
  ["evidence", "facts", "gap", "conflict", "decision", "deliverable", "audience", "acceptance"],
  ["conflict", "actor", "facts", "evidence", "decision", "gap", "deliverable", "acceptance"],
  ["facts", "conflict", "trigger", "decision", "evidence", "gap", "deliverable", "audience"],
  ["actor", "trigger", "decision", "facts", "evidence", "conflict", "deliverable", "gap"],
  ["gap", "trigger", "evidence", "facts", "decision", "deliverable", "acceptance", "audience"],
  ["decision", "conflict", "facts", "evidence", "gap", "audience", "deliverable", "acceptance"],
  ["audience", "facts", "trigger", "conflict", "evidence", "decision", "deliverable", "gap"],
];

const STEP_ACTION_RULES = [
  ["compose-document", /写(?:入|成)?\s*(?:Word|文档|备忘录|意见|报告|问答)|起草|撰写|形成.{0,16}(?:文档|报告|意见|简报)/i],
  ["compose-workbook", /做(?:成)?\s*(?:Excel|工作簿|表格|台账|矩阵|模型)|建立.{0,16}(?:工作簿|表格|台账|矩阵|模型)/i],
  ["validate", /复查|自检|校验|验收|交叉检查|回看|复测|确认.{0,12}(?:一致|完整|无误)/],
  ["calculate", /计算|测算|公式|建模|敏感性|周转率|占比|增速|桥接|量化/],
  ["reconcile", /勾稽|对账|差异|一致性|衔接|对比|比较|核对.{0,16}(?:口径|数值|版本|期初|期末)/],
  ["normalize", /统一|标准化|口径|单位换算|映射|字段对应|归一/],
  ["extract", /提取|读取|摘录|抓取|导入|汇总.{0,12}(?:数据|字段|条款|指标)/],
  ["source-verify", /核验.{0,16}(?:附件|来源|发布|文件|链接)|验证.{0,16}(?:文件|来源|哈希)|确认发布主体|检查文件头/],
  ["inventory", /盘点|梳理|还原|固化|拆分|拆成|列出|建立索引|整理清单/],
  ["branch", /分类|分档|分流|情景|场景|阈值|分支|四档|三档|路径/],
  ["gap-manage", /缺口|补件|待确认|追问|索取|责任人|截止时间|未提供/],
  ["decide", /给出.{0,12}(?:建议|结论)|选择|决定|判定|放行|暂缓|推荐|优先级/],
  ["communicate", /汇报|沟通|回复|问答|会上|交付|给.{0,16}(?:看|用|讨论)/],
  ["analyze", /判断|分析|评估|识别|归因|审查|复核|检查|推导/],
];

const STEP_ROLE_MAP = {
  "source-verify": "evidence",
  inventory: "evidence",
  extract: "evidence",
  normalize: "transform",
  reconcile: "transform",
  calculate: "transform",
  analyze: "reason",
  branch: "route",
  "gap-manage": "gap",
  decide: "decide",
  "compose-document": "produce",
  "compose-workbook": "produce",
  communicate: "communicate",
  validate: "validate",
};

function normalizedText(value = "") {
  return String(value ?? "").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
}

function compactText(value = "") {
  return normalizedText(value).replace(/\s+/g, "");
}

function valueFromRow(row, name, fallback = "") {
  if (row && typeof row === "object" && !Array.isArray(row)) {
    if (name in row) return row[name] ?? fallback;
    if (Array.isArray(row.updates)) {
      return row.updates.find((item) => item.field === name)?.value ?? fallback;
    }
  }
  return fallback;
}

export async function loadStructuralDiversityPolicy(
  filePath = DEFAULT_STRUCTURAL_DIVERSITY_POLICY_PATH,
) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export function parseTsvRows(text) {
  const lines = String(text ?? "").trimEnd().split(/\r?\n/);
  if (!lines.length || !lines[0]) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).filter(Boolean).map((line, index) => {
    const cells = line.split("\t");
    const row = Object.fromEntries(headers.map((header, column) => [header, normalizedText(cells[column] ?? "")]));
    row.__dataRow = index + 2;
    return row;
  });
}

export function visibleCharacterCount(value) {
  return compactText(value).length;
}

export function coreSceneText(question) {
  const text = normalizedText(question)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/附件(?:[一二三四五六七八九十]+|\d+)[_：:]?[^，。；\n]{0,80}/g, "");
  // A situated requester can ask for the deliverable at the beginning, in the
  // middle, or at the end of a message. Truncating at the first file-format
  // token therefore discards legitimate scene facts whenever the request is
  // not a legacy tail paragraph. Remove only the artifact labels/titles and
  // keep factual prose on both sides of the request.
  return text
    .replace(
      /(?:一份|一张|一套|一个|一版)?\s*(?:可编辑)?\s*(?:Word|Excel|PPT|docx|xlsx|pptx)(?:《[^》\n]{1,80}》)?/giu,
      "",
    )
    .replace(/(?:一份|一张|一套|一个|一版)?\s*(?:可编辑文档|工作簿)(?:《[^》\n]{1,80}》)?/gu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function informationCoverage(question) {
  const detected = Object.entries(INFORMATION_UNIT_PATTERNS)
    .filter(([, pattern]) => pattern.test(question))
    .map(([name]) => name);
  return { detected, count: detected.length };
}

function classifyOpeningMode(question) {
  const opening = normalizedText(question).trim().slice(0, 120);
  const positions = {
    clock: opening.search(/截至|今天|明天|次日|今晚|本周|下周|会前|月底|周[一二三四五六日天]/),
    incident: opening.search(/被退回|投诉|异常|事故|抽检|失败|出错|漏了|卡住|大修|整改/),
    conflict: opening.search(/争议|分歧|质疑|不同意|各执一词|吵|认为.{0,20}(?:可以|不能)/),
    decision: opening.search(/是否|能否|要不要|决定|选择|放行|排序|分流/),
    evidence: opening.search(/附件|资料|报表|数据|报告|合同|流水|这份|这批/),
    handoff: opening.search(/刚收到|转给|交接|接手|发来|丢给|手头|群里/),
    user: opening.search(/客户|用户|业主|消费者|候选人|家长|患者/),
    metric: opening.search(/\d+(?:\.\d+)?%|同比|环比|营收|利润|现金流|余额|件数|金额/),
  };
  const present = Object.entries(positions).filter(([, position]) => position >= 0).sort((a, b) => a[1] - b[1]);
  const first = present[0]?.[0];
  return {
    clock: "clock-pressure",
    incident: "incident-led",
    conflict: "conflict-first",
    decision: "decision-fork",
    evidence: "evidence-discovery",
    handoff: "handoff-led",
    user: "user-impact",
    metric: "metric-anomaly",
  }[first] ?? "handoff-led";
}

function classifyDecisionForm(text) {
  if (/阈值|超过|低于|达到.{0,12}(?:则|后)|触发条件|红线/.test(text)) return "threshold-gate";
  if (/排序|优先级|优先展示|重点研究池|排名|先后顺序/.test(text)) return "ranked-priority";
  if (/例外|异常队列|分流|路径|转交|升级处理/.test(text)) return "exception-routing";
  if (/情景|场景|敏感性|假设|预测|方案A|方案B|不同情况下/.test(text)) return "scenario-choice";
  if (/三档|四档|分成|分类|多方案|逐项判断|保留、|暂缓、/.test(text)) return "multi-option";
  if (/前提|条件|补件后|满足.{0,12}(?:才|后)|如果|若/.test(text)) return "conditional-recommendation";
  return "binary-gate";
}

function classifyInformationOrder(question) {
  return INFORMATION_ORDER_PATTERNS
    .map(([name, pattern]) => ({ name, index: question.search(pattern) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index || a.name.localeCompare(b.name))
    .map((item) => item.name);
}

function classifyDocumentTopology(text) {
  if (/谈判|条款|协商|立场/.test(text)) return "negotiation-brief";
  if (/问答|协调会|会前|会议简报|沟通口径/.test(text)) return "meeting-brief";
  if (/操作指引|手册|流程说明|运行规则/.test(text)) return "operating-playbook";
  if (/审计|核查报告|复盘报告|稽核/.test(text)) return "audit-report";
  if (/诊断|归因|原因分析|监测/.test(text)) return "diagnostic-report";
  if (/审批|验收|付款|准入/.test(text)) return "approval-note";
  if (/复核意见|审查意见|改稿意见|评审意见/.test(text)) return "review-opinion";
  return "decision-memo";
}

function classifyWorkbookTopology(text) {
  if (/条款矩阵|合同矩阵|条款对照/.test(text)) return "clause-matrix";
  if (/情景模型|敏感性|场景模型/.test(text)) return "scenario-model";
  if (/公式|测算|计算模型|勾稽|现金流桥|周转/.test(text)) return "calculation-model";
  if (/看板|监控|监测|阈值跟踪/.test(text)) return "monitoring-board";
  if (/整改|问题闭环|跟踪表|责任人/.test(text)) return "remediation-tracker";
  if (/阶段|门禁|放行矩阵|验收阶段/.test(text)) return "stage-gate-matrix";
  if (/异常|例外|问题清单|待处理队列/.test(text)) return "exception-log";
  return "evidence-ledger";
}

function classifyAttachmentMode(text) {
  const itemCount = (text.match(/附件(?:[一二三四五六七八九十]+|\d+)[：:《_]/g) ?? []).length;
  const boundaryCount = (text.match(/边界[：:]|不能证明|不替代/g) ?? []).length;
  if (itemCount >= 3 && boundaryCount >= itemCount) return "per-item-boundary";
  if (itemCount >= 3 && /总边界|缺口[：:]|资料边界/.test(text)) return "catalog-then-boundary";
  if (/第一组|第二组|规则组|数据组|业务记录组/.test(text)) return "evidence-clusters";
  return "narrative-evidence";
}

function classifyArtifactTopology(row) {
  const question = valueFromRow(row, "题目");
  const product = valueFromRow(row, "产物内容");
  const attachments = valueFromRow(row, "附件内容");
  const combined = `${question}\n${product}`;
  const wordPosition = combined.search(/Word|docx/iu);
  const excelPosition = combined.search(/Excel|xlsx/iu);
  const order = wordPosition < 0 || excelPosition < 0
    ? "single-or-implicit"
    : wordPosition < excelPosition
      ? "document-first"
      : "workbook-first";
  const boundaryIndex = combined.search(/验收时|边界|不替代|不得外推|不能证明|待确认/);
  return {
    document: classifyDocumentTopology(product),
    workbook: classifyWorkbookTopology(product),
    order,
    attachmentMode: classifyAttachmentMode(attachments),
    boundaryPosition: boundaryIndex < 0 ? "none" : boundaryIndex / Math.max(combined.length, 1) > 0.72 ? "tail" : "embedded",
  };
}

function classifyEvidenceTopology(row) {
  const question = valueFromRow(row, "题目");
  const attachmentContent = valueFromRow(row, "附件内容");
  const attachmentFormats = valueFromRow(row, "附件格式");
  const text = `${question}\n${attachmentContent}`;
  if (/年报|季报|半年度|多期|同比|环比|时间序列|经营现金流/.test(text)) return "multi-period-numeric";
  if (/版本|草案|正式稿|修订稿|口径差异|相互冲突|不一致/.test(text)) return "conflicting-versions";
  if (/境内|境外|跨境|国际联运|过境国|不同法域|国内段|国际段/.test(text)) return "cross-jurisdiction";
  if (/安装|调试|性能测试|验收|技术参数|规格|实测|样机/.test(text)) return "technical-acceptance";
  if (/模板|空白表|流程图|申请表|记录表|合同模板/.test(text)) return "records-and-templates";
  if (/缺少|缺失|未提供|没拿到|待补|待确认/.test(text) && /合同|日志|截图|记录|报告|证书/.test(text)) {
    return "incomplete-evidence-pack";
  }
  if (/法规|规定|办法|条例|规则/.test(text) && /底表|业务数据|台账|清单|json|csv|xlsx/i.test(`${text}\n${attachmentFormats}`)) {
    return "rules-plus-case-data";
  }
  return "mixed-primary-sources";
}

function parseSteps(value) {
  const normalized = normalizedText(value).trim();
  const matches = [...normalized.matchAll(/(?:^|\n)\s*\d+\.\s*([\s\S]*?)(?=(?:\n\s*\d+\.)|$)/g)];
  return matches.length ? matches.map((match) => match[1].trim()) : normalized.split(/\n+/).filter(Boolean);
}

function classifyStepAction(step) {
  for (const [action, pattern] of STEP_ACTION_RULES) {
    if (pattern.test(step)) return action;
  }
  return "analyze";
}

function compressSequence(values) {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function classifyFlowTopology(question, steps, actions) {
  const text = `${question}\n${steps.join("\n")}`;
  if (/复测|迭代|重新|回到|循环|再次验证/.test(text)) return "iterative-loop";
  if (/并行|分别推进|双轨|两条线|同步开展|各自完成/.test(text)) return "parallel-workstreams";
  if (/阶段门|门禁|前置条件|通过后|满足.{0,12}才|解锁条件/.test(text)) return "stage-gated";
  if (/例外|异常队列|分流|升级处理|转交/.test(text) || actions.includes("gap-manage")) return "exception-routing";
  if (/情景|场景|分支|路径A|路径B/.test(text) || actions.filter((item) => item === "branch").length >= 2) return "branching";
  return "evidence-trace";
}

function sentenceRhythm(question) {
  const paragraphs = normalizedText(question).split(/\n+/).map((item) => item.trim()).filter(Boolean);
  const sentences = normalizedText(question).split(/[。！？!?\n]+/).map((item) => compactText(item)).filter(Boolean);
  const bucket = (length) => (length < 28 ? "short" : length < 56 ? "medium" : length < 90 ? "long" : "extended");
  return {
    paragraphCount: paragraphs.length,
    paragraphBuckets: paragraphs.map((item) => bucket(compactText(item).length)),
    sentenceCount: sentences.length,
    sentenceBuckets: sentences.map((item) => bucket(item.length)),
  };
}

function normalizedQuestionSkeleton(question) {
  return compactText(question)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[“”"'][^“”"']{1,40}[“”"']/g, "<quote>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/word|excel|ppt|docx|xlsx|pptx/giu, "<file>")
    .replace(/附件(?:[一二三四五六七八九十]+|\d+)/g, "<attachment>");
}

function normalizedLexicalText(value) {
  return compactText(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/word|excel|ppt|docx|xlsx|pptx/giu, "<file>")
    .replace(/附件(?:[一二三四五六七八九十]+|\d+)/g, "<attachment>");
}

function normalizedNarrativeText(row) {
  return ["题目", "任务概括", "产物内容", "做题关键步骤"]
    .map((field) => normalizedLexicalText(valueFromRow(row, field)))
    .filter(Boolean)
    .join("。 ");
}

function ngrams(value, size = 3) {
  const result = new Set();
  for (let index = 0; index <= value.length - size; index += 1) result.add(value.slice(index, index + size));
  return [...result];
}

function lengthBandFor(length, policy) {
  const bands = policy.questionLength.planningBands ?? [];
  if (!bands.length) return "unbanded";
  return bands.find((band) => length >= band.min && length <= band.max)?.id ?? "outside-plan";
}

export function fingerprintRow(row, policy) {
  if (!policy) throw new Error("fingerprintRow requires a structural diversity policy.");
  const question = normalizedText(valueFromRow(row, "题目"));
  const stepsValue = valueFromRow(row, "做题关键步骤");
  const steps = parseSteps(stepsValue);
  const stepActions = steps.map(classifyStepAction);
  const stepRoles = stepActions.map((action) => STEP_ROLE_MAP[action] ?? "reason");
  const coverage = informationCoverage(question);
  const visible = visibleCharacterCount(question);
  const coreVisible = visibleCharacterCount(coreSceneText(question));
  const questionLexicalText = normalizedLexicalText(question);
  const narrativeLexicalText = normalizedNarrativeText(row);
  return {
    version: 1,
    uid: valueFromRow(row, "UID") || valueFromRow(row, "uid") || "",
    length: {
      visible,
      coreVisible,
      band: lengthBandFor(visible, policy),
    },
    coverage,
    openingMode: classifyOpeningMode(question),
    informationOrder: classifyInformationOrder(question),
    decisionForm: classifyDecisionForm(`${question}\n${valueFromRow(row, "产物内容")}`),
    evidenceTopology: classifyEvidenceTopology(row),
    artifactTopology: classifyArtifactTopology(row),
    stepActions,
    compressedStepActions: compressSequence(stepActions),
    stepRoles,
    compressedStepRoles: compressSequence(stepRoles),
    flowTopology: classifyFlowTopology(question, steps, stepActions),
    sentenceRhythm: sentenceRhythm(question),
    questionSkeletonNgrams: ngrams(normalizedQuestionSkeleton(question), 3),
    questionLexicalText,
    questionLexicalNgrams: ngrams(questionLexicalText, 3),
    narrativeLexicalText,
    narrativeLexicalNgrams: ngrams(narrativeLexicalText, 3),
  };
}

function lcsSimilarity(a = [], b = []) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (const left of a) {
    const current = new Array(b.length + 1).fill(0);
    for (let index = 1; index <= b.length; index += 1) {
      current[index] = left === b[index - 1]
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function jaccard(a = [], b = []) {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function artifactSimilarity(a, b) {
  return jaccard(
    [a.document, a.workbook, a.order, a.attachmentMode, a.boundaryPosition],
    [b.document, b.workbook, b.order, b.attachmentMode, b.boundaryPosition],
  );
}

function rhythmSimilarity(a, b) {
  const paragraph = lcsSimilarity(a.paragraphBuckets, b.paragraphBuckets);
  const sentence = lcsSimilarity(a.sentenceBuckets, b.sentenceBuckets);
  return paragraph * 0.35 + sentence * 0.65;
}

function hasSharedSubstring(a = "", b = "", minimumLength = 0) {
  if (!minimumLength || a.length < minimumLength || b.length < minimumLength) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const candidates = new Set();
  for (let index = 0; index <= shorter.length - minimumLength; index += 1) {
    candidates.add(shorter.slice(index, index + minimumLength));
  }
  for (let index = 0; index <= longer.length - minimumLength; index += 1) {
    if (candidates.has(longer.slice(index, index + minimumLength))) return true;
  }
  return false;
}

export function compareFingerprints(a, b, policy) {
  const lexicalPolicy = policy.lexicalDuplication ?? {};
  const dimensions = {
    openingMode: a.openingMode === b.openingMode ? 1 : 0,
    informationOrder: lcsSimilarity(a.informationOrder, b.informationOrder),
    decisionForm: a.decisionForm === b.decisionForm ? 1 : 0,
    evidenceTopology: a.evidenceTopology === b.evidenceTopology ? 1 : 0,
    artifactTopology: artifactSimilarity(a.artifactTopology, b.artifactTopology),
    stepActions: lcsSimilarity(a.stepRoles ?? a.compressedStepActions, b.stepRoles ?? b.compressedStepActions),
    flowTopology: a.flowTopology === b.flowTopology ? 1 : 0,
    sentenceRhythm: rhythmSimilarity(a.sentenceRhythm, b.sentenceRhythm),
    lexicalSkeleton: jaccard(
      a.questionLexicalNgrams ?? a.questionSkeletonNgrams,
      b.questionLexicalNgrams ?? b.questionSkeletonNgrams,
    ),
    narrativeLexical: jaccard(a.narrativeLexicalNgrams, b.narrativeLexicalNgrams),
  };
  const weights = policy.similarity.weights;
  const score = Object.entries(weights).reduce(
    (sum, [name, weight]) => sum + (dimensions[name] ?? 0) * weight,
    0,
  );
  const highDimensions = Object.entries(dimensions)
    .filter(([name, value]) => name !== "lexicalSkeleton" && value >= policy.similarity.highDimensionThreshold)
    .map(([name]) => name);
  const coreHighDimensions = highDimensions.filter((name) => policy.similarity.coreDimensions.includes(name));
  const sharedPhraseHard = hasSharedSubstring(
    a.questionLexicalText,
    b.questionLexicalText,
    lexicalPolicy.sharedPhraseHardMinimumCharacters ?? 24,
  );
  const sharedPhraseReview = sharedPhraseHard || hasSharedSubstring(
    a.questionLexicalText,
    b.questionLexicalText,
    lexicalPolicy.sharedPhraseReviewMinimumCharacters ?? 16,
  );
  const lexicalDuplicate =
    dimensions.lexicalSkeleton >= (lexicalPolicy.questionHardThreshold ?? 0.68) ||
    dimensions.narrativeLexical >= (lexicalPolicy.narrativeHardThreshold ?? 0.76) ||
    sharedPhraseHard;
  return {
    score: Number(score.toFixed(4)),
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([name, value]) => [name, Number(value.toFixed(4))])),
    highDimensions,
    coreHighDimensions,
    sharedPhraseHard,
    sharedPhraseReview,
    lexicalDuplicate,
    exactStructureSignature:
      a.decisionForm === b.decisionForm &&
      a.flowTopology === b.flowTopology &&
      a.artifactTopology.document === b.artifactTopology.document &&
      a.artifactTopology.workbook === b.artifactTopology.workbook,
  };
}

function missingRequiredCoverageGroups(coverage, policy) {
  const detected = new Set(coverage.detected);
  return policy.informationCoverage.requiredGroups
    .filter((group) => !group.some((name) => detected.has(name)))
    .map((group) => group.join("|"));
}

export function evaluateDiversity(rows, {
  policy,
  history = [],
  assignments = [],
} = {}) {
  if (!policy) throw new Error("evaluateDiversity requires a structural diversity policy.");
  const fingerprints = rows.map((row) => fingerprintRow(row, policy));
  const findings = [];
  const nearest = [];
  const add = (level, rule, index, message, details = {}) => findings.push({
    level,
    rule,
    index,
    uid: fingerprints[index]?.uid || "",
    message,
    ...details,
  });

  fingerprints.forEach((fingerprint, index) => {
    if (fingerprint.length.visible < policy.questionLength.hardMinimumVisibleCharacters) {
      add("FAIL", "question-too-short", index, `题面只有 ${fingerprint.length.visible} 个可见字符，硬下限为 ${policy.questionLength.hardMinimumVisibleCharacters}。`);
    } else if (
      policy.questionLength.recommendedMinimumVisibleCharacters &&
      fingerprint.length.visible < policy.questionLength.recommendedMinimumVisibleCharacters
    ) {
      add("WARN", "question-below-recommended", index, `题面有 ${fingerprint.length.visible} 个可见字符，低于非强制建议值 ${policy.questionLength.recommendedMinimumVisibleCharacters}。`);
    }
    if (
      policy.questionLength.hardMaximumVisibleCharacters &&
      fingerprint.length.visible > policy.questionLength.hardMaximumVisibleCharacters
    ) {
      add("FAIL", "question-too-long", index, `题面有 ${fingerprint.length.visible} 个可见字符，硬上限为 ${policy.questionLength.hardMaximumVisibleCharacters}。`);
    } else if (
      policy.questionLength.warningMaximumVisibleCharacters &&
      fingerprint.length.visible > policy.questionLength.warningMaximumVisibleCharacters
    ) {
      add("WARN", "question-long-warning", index, `题面有 ${fingerprint.length.visible} 个可见字符，超过 ${policy.questionLength.warningMaximumVisibleCharacters} 后应人工确认是否存在复述或堆砌。`);
    }
    if (fingerprint.length.coreVisible < policy.questionLength.minimumCoreSceneCharacters) {
      add("FAIL", "core-scene-too-short", index, `去掉交付格式套话后的核心场景只有 ${fingerprint.length.coreVisible} 个字符。`);
    }
    const missingGroups = missingRequiredCoverageGroups(fingerprint.coverage, policy);
    if (fingerprint.coverage.count < policy.informationCoverage.minimumDetectedUnits || missingGroups.length) {
      add("FAIL", "information-coverage-insufficient", index, "题面有效信息单元不足，不能靠空话或边界句凑长度。", {
        detectedUnits: fingerprint.coverage.detected,
        missingGroups,
      });
    }

    // Structure passports are advisory generation hints only. A natural task must
    // not be rejected because a heuristic classifier reads its opening, order,
    // decision, evidence, flow, or deliverable differently from an assignment.

    const comparisons = history
      .filter((entry) => (entry.uid || entry.fingerprint?.uid) !== fingerprint.uid)
      .map((entry) => ({
        uid: entry.uid || entry.fingerprint?.uid || "",
        runId: entry.runId || "",
        similarity: compareFingerprints(fingerprint, entry.fingerprint ?? entry, policy),
      }))
      .sort((a, b) => b.similarity.score - a.similarity.score);
    nearest.push({ index, uid: fingerprint.uid, items: comparisons.slice(0, 5) });
    const lexicalCollision = comparisons.find(({ similarity }) => similarity.lexicalDuplicate);
    if (lexicalCollision) {
      add("FAIL", "history-lexical-duplicate", index, `与历史记录 ${lexicalCollision.uid || "(无UID)"} 存在共享长句或正文高度重复。`, lexicalCollision);
    }
    const collision = comparisons.find(({ similarity }) =>
      similarity.score >= policy.similarity.historyThreshold &&
      similarity.highDimensions.length >= policy.similarity.minimumHighDimensions &&
      similarity.coreHighDimensions.length >= policy.similarity.minimumCoreHighDimensions
    );
    if (!lexicalCollision && collision) {
      add("FAIL", "history-structure-collision", index, `与历史记录 ${collision.uid || "(无UID)"} 的结构相似度为 ${collision.similarity.score}。`, collision);
    } else if (!lexicalCollision && comparisons[0]?.similarity.score >= policy.similarity.batchThreshold) {
      add("REVIEW", "history-structure-near", index, `最接近历史记录 ${comparisons[0].uid || "(无UID)"}，结构相似度 ${comparisons[0].similarity.score}，需人工复核。`, comparisons[0]);
    }
  });

  for (let left = 0; left < fingerprints.length; left += 1) {
    for (let right = left + 1; right < fingerprints.length; right += 1) {
      const similarity = compareFingerprints(fingerprints[left], fingerprints[right], policy);
      const lexicalPolicy = policy.lexicalDuplication ?? {};
      const stepContextSimilar =
        similarity.dimensions.lexicalSkeleton >= (lexicalPolicy.stepContextQuestionThreshold ?? 0.42) ||
        similarity.dimensions.narrativeLexical >= (lexicalPolicy.stepContextNarrativeThreshold ?? 0.55) ||
        similarity.sharedPhraseReview;
      if (similarity.lexicalDuplicate) {
        add("FAIL", "batch-lexical-duplicate", right, `与同批第 ${left + 1} 条存在共享长句或正文高度重复。`, { otherIndex: left, similarity });
      }
      if (similarity.exactStructureSignature) {
        add("REVIEW", "batch-exact-structure-signature", right, `与同批第 ${left + 1} 条具有相同的决策、产物和流程分类；分类相同不再直接判失败，但需人工确认场景是否真实独立。`, { otherIndex: left, similarity });
      }
      if (similarity.dimensions.stepActions >= 0.9) {
        add(
          stepContextSimilar ? "FAIL" : "REVIEW",
          "batch-step-action-isomorphism",
          right,
          stepContextSimilar
            ? `与同批第 ${left + 1} 条的步骤动作及业务正文都高度相似。`
            : `与同批第 ${left + 1} 条的步骤动作相近，但业务正文差异较大，需人工复核。`,
          { otherIndex: left, similarity },
        );
      } else if (similarity.score >= policy.similarity.batchThreshold) {
        add("REVIEW", "batch-structure-collision", right, `与同批第 ${left + 1} 条综合结构相似度 ${similarity.score}，结构接近不再单独判失败。`, { otherIndex: left, similarity });
      }
    }
  }

  const hasFailure = findings.some((item) => item.level === "FAIL");
  const reviewCount = findings.filter((item) => item.level === "REVIEW").length;
  // REVIEW is a blocking state. It may be authorized later by a separately
  // hash-bound independent signoff, but the evaluator itself never upgrades a
  // REVIEW result to PASS and never reports ok=true for it.
  const status = hasFailure ? "FAIL" : reviewCount > 0 ? "REVIEW" : "PASS";
  return {
    status,
    ok: status === "PASS",
    reviewRequired: status === "REVIEW",
    blocked: status !== "PASS",
    reviewCount,
    fingerprints,
    findings,
    nearest,
  };
}

function usageCount(history, selector, value) {
  const key = (item) => Array.isArray(item) ? item.join("\u0000") : item;
  return history.filter((entry) => key(selector(entry.profile ?? entry.fingerprint ?? entry)) === key(value)).length;
}

function rotateLeastUsed(values, history, selector, offset = 0) {
  return [...values]
    .map((value, index) => ({
      value,
      index,
      count: usageCount(history, selector, typeof value === "string" || Array.isArray(value) ? value : value.id),
    }))
    .sort((a, b) => a.count - b.count || ((a.index + offset) % values.length) - ((b.index + offset) % values.length))
    .map((item) => item.value);
}

export function allocateProfiles({ count, history = [], runId = "run" }, policy) {
  if (!Number.isInteger(count) || count < 1) throw new Error("allocateProfiles requires a positive count.");
  if (policy?.passport?.assignmentMode === "disabled-source-derived") {
    return Array.from({ length: count }, (_, index) => ({
      slot: index + 1,
      index,
      profileId: `${runId}_source_${String(index + 1).padStart(2, "0")}`,
      sourceDriven: true,
    }));
  }
  const offset = Number.parseInt(crypto.createHash("sha256").update(runId).digest("hex").slice(0, 8), 16);
  const openings = rotateLeastUsed(policy.passport.openingModes, history, (item) => item.openingMode, offset + 1);
  const informationOrders = rotateLeastUsed(INFORMATION_ORDERS, history, (item) => item.informationOrder, offset + 2);
  const decisions = rotateLeastUsed(policy.passport.decisionForms, history, (item) => item.decisionForm, offset + 3);
  const evidence = rotateLeastUsed(policy.passport.evidenceTopologies, history, (item) => item.evidenceTopology, offset + 4);
  const flows = rotateLeastUsed(policy.passport.flowTopologies, history, (item) => item.flowTopology, offset + 5);
  const products = rotateLeastUsed(
    policy.passport.productTopologies,
    history,
    (item) => item.productTopology ?? (
      item.artifactTopology?.document && item.artifactTopology?.workbook
        ? `${item.artifactTopology.document}__${item.artifactTopology.workbook}`
        : undefined
    ),
    offset + 6,
  );
  return Array.from({ length: count }, (_, index) => ({
    slot: index + 1,
    index,
    profileId: `${runId}_structure_${String(index + 1).padStart(2, "0")}`,
    lengthBand: null,
    openingMode: openings[index % openings.length],
    informationOrder: informationOrders[index % informationOrders.length],
    decisionForm: decisions[index % decisions.length],
    evidenceTopology: evidence[index % evidence.length],
    flowTopology: flows[index % flows.length],
    productTopology: products[index % products.length].id,
  }));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function rowHashPayload(row) {
  if (Array.isArray(row?.updates)) {
    return Object.fromEntries(
      row.updates
        .filter((item) => item.column !== "J")
        .map((item) => [item.field, normalizedText(item.value)]),
    );
  }
  const excluded = new Set(["__dataRow", "相关附件"]);
  return Object.fromEntries(
    Object.entries(row ?? {})
      .filter(([key]) => !excluded.has(key) && !key.startsWith("__"))
      .map(([key, value]) => [key, normalizedText(value)]),
  );
}

export function hashNarrativeRow(row) {
  return crypto.createHash("sha256").update(stableStringify(rowHashPayload(row))).digest("hex");
}

export function hashPlanRows(rows) {
  const hashes = rows.map((row, index) => ({
    index,
    uid: valueFromRow(row, "UID") || valueFromRow(row, "uid") || "",
    sheetRow: row.sheetRow ?? null,
    hash: hashNarrativeRow(row),
  }));
  const batchHash = crypto.createHash("sha256").update(stableStringify(hashes)).digest("hex");
  return { hashes, batchHash };
}

function reviewAuthorizationErrors(authorization, { reportPath = "", reportHash = "" } = {}) {
  const errors = [];
  const sha256 = /^[a-f0-9]{64}$/i;
  if (authorization?.status !== "APPROVED" || authorization?.decision !== "APPROVE") {
    errors.push("review receipt is not independently approved");
  }
  if (authorization?.verified !== true) errors.push("review approval is not marked verified");
  if (!authorization?.requestId || !sha256.test(String(authorization?.bindingHash ?? ""))) {
    errors.push("review approval binding is missing or invalid");
  }
  if (!sha256.test(String(authorization?.requestHash ?? ""))) errors.push("review request hash is invalid");
  if (!sha256.test(String(authorization?.signoffHash ?? ""))) errors.push("review signoff hash is invalid");
  if (!sha256.test(String(authorization?.evaluationHash ?? ""))) errors.push("review evaluation hash is invalid");
  if (!sha256.test(String(authorization?.rationaleHash ?? ""))) errors.push("review rationale hash is invalid");
  const requestPath = String(authorization?.requestPath ?? "").trim();
  const signoffPath = String(authorization?.signoffPath ?? "").trim();
  if (!requestPath) errors.push("review request path is missing");
  if (!signoffPath) errors.push("review signoff path is missing");
  if (requestPath && signoffPath && requestPath === signoffPath) errors.push("review request and signoff paths must differ");
  const reviewer = String(authorization?.reviewer ?? "").trim();
  const requestedBy = String(authorization?.requestedBy ?? "").trim();
  if (!reviewer) errors.push("reviewer is missing");
  if (!requestedBy) errors.push("review requester is missing");
  if (reviewer && requestedBy && reviewer.toLocaleLowerCase() === requestedBy.toLocaleLowerCase()) {
    errors.push("reviewer must be independent from requester");
  }
  if (!authorization?.reviewedAt || Number.isNaN(Date.parse(authorization.reviewedAt))) {
    errors.push("reviewedAt is invalid");
  }
  if (!String(reportPath).trim() || !sha256.test(String(reportHash))) {
    errors.push("review receipt must bind a gate report hash");
  }
  return errors;
}

export function verifyReceiptRows(receipt, rows, policy) {
  const current = hashPlanRows(rows);
  const errors = [];
  if (!receipt || receipt.status !== "PASS" || receipt.ok !== true) errors.push("receipt is not PASS");
  if (receipt?.policyId !== policy.policyId || receipt?.policyVersion !== policy.version) errors.push("policy version mismatch");
  const gateStatus = receipt?.gateStatus ?? "PASS";
  if (!['PASS', 'REVIEW'].includes(gateStatus)) errors.push("receipt gateStatus is invalid");
  if (gateStatus === "REVIEW") {
    errors.push(...reviewAuthorizationErrors(receipt?.reviewAuthorization, {
      reportPath: receipt?.reportPath,
      reportHash: receipt?.reportHash,
    }));
  } else if (receipt?.reviewAuthorization != null) {
    errors.push("PASS receipt must not carry a review override");
  }
  const fullBatch = (receipt?.rowHashes ?? []).length === current.hashes.length;
  if (fullBatch && receipt?.batchHash !== current.batchHash) errors.push("batch hash mismatch");
  const rowKey = (item) => item.uid
    ? `uid:${item.uid}\u0000row:${item.sheetRow ?? ""}`
    : item.sheetRow !== null && item.sheetRow !== undefined
      ? `row:${item.sheetRow}`
      : `index:${item.index}`;
  const expected = new Map((receipt?.rowHashes ?? []).map((item) => [rowKey(item), item.hash]));
  for (const item of current.hashes) {
    const key = rowKey(item);
    if (expected.get(key) !== item.hash) errors.push(`row hash mismatch: ${item.uid || item.index}`);
  }
  return { ok: errors.length === 0, errors, current };
}

export function buildReceipt({
  evaluation,
  rows,
  policy,
  reportPath = "",
  reportHash = "",
  reviewAuthorization = null,
}) {
  const directPass = evaluation?.ok === true && evaluation?.status === "PASS";
  const independentlyApprovedReview =
    evaluation?.ok === false &&
    evaluation?.status === "REVIEW" &&
    reviewAuthorizationErrors(reviewAuthorization, { reportPath, reportHash }).length === 0;
  if (!directPass && !independentlyApprovedReview) {
    throw new Error("Cannot build a structural diversity receipt without PASS or a verified independent REVIEW approval.");
  }
  const { hashes, batchHash } = hashPlanRows(rows);
  return {
    schemaVersion: policy.receipt.schemaVersion,
    ok: true,
    status: "PASS",
    generatedAt: new Date().toISOString(),
    policyId: policy.policyId,
    policyVersion: policy.version,
    gateStatus: evaluation.status,
    authorizationMode: directPass ? "DIRECT_PASS" : "INDEPENDENT_REVIEW",
    reviewAuthorization: independentlyApprovedReview ? reviewAuthorization : null,
    reportPath,
    reportHash,
    batchHash,
    rowHashes: hashes,
  };
}
