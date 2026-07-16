import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLUMN_FIELDS } from "../automation/backfill_structure_registry.mjs";
import {
  SCENE_CARD_BUNDLE_KIND,
  SCENE_CARD_PROTOCOL_ID,
} from "../automation/scene_card.mjs";
import {
  assertClearQuestionRequest,
  assertNaturalQuestionPresentation,
  assertNoPoliteImperative,
} from "../automation/language_style.mjs";
import { assertNoUnsupportedFactAnchors } from "../automation/fact_guard.mjs";
import { writeJsonAtomic } from "../automation/run_context.mjs";
import { buildFeishuFillPlan } from "../manual_review/feishu_fill_plan_lib.mjs";
import { SITUATED_REWRITES_121_136 } from "./situated_rewrites_121_136.mjs";
import { SITUATED_REWRITES_140_144 } from "./situated_rewrites_140_144.mjs";
import { SITUATED_REWRITES_145_149 } from "./situated_rewrites_145_149.mjs";
import { SITUATED_REWRITES_172_180 } from "./situated_rewrites_172_180.mjs";

const SOURCE_RUN = path.resolve(
  "outputs",
  "auto_runs",
  "rewrite_managed_human_voice_20260710",
);
export const RUN_ID = "rewrite_managed_situated_requester_20260710";
const RUN_DIR = path.resolve("outputs", "auto_runs", RUN_ID);

const NARRATIVE_COLUMN_MAP = [
  { field: "题目", column: "B" },
  { field: "任务概括", column: "G" },
  { field: "附件内容", column: "L" },
  { field: "产物内容", column: "N" },
  { field: "做题关键步骤", column: "O" },
];

const REWRITES = {
  ...SITUATED_REWRITES_121_136,
  ...SITUATED_REWRITES_140_144,
  ...SITUATED_REWRITES_145_149,
  ...SITUATED_REWRITES_172_180,
};

function normalize(value = "") {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function visibleLength(value = "") {
  return [...normalize(value).replace(/\s+/gu, "")].length;
}

function tsvCell(value) {
  return normalize(value).replace(/\t/gu, " ").replace(/\n/gu, "\\n");
}

function toTsv(rows) {
  const body = rows.map((row) => COLUMN_FIELDS.map((field) => tsvCell(row[field])).join("\t"));
  return `${COLUMN_FIELDS.join("\t")}\n${body.join("\n")}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const NATURAL_BOUNDARY_REWRITES = [
  ["Word不要写成一篇法规汇编，沿客户发起会话到转人工的顺序", "Word沿客户发起会话到转人工的顺序"],
  ["不要把后续勘查写成已经能施工", "后续勘查就保持为待图纸和现场条件确认"],
  ["不要把规则附件写成配方、检测或达人合作证明", "规则附件只作审查尺度，配方、检测和达人合作证明继续列为缺件"],
  ["退订回执和注销处理结果不要混成一个状态", "退订回执和注销处理结果分成两个状态"],
  ["哪些条件必须等街道文件确认", "哪些条件还要等街道文件确认"],
  ["必须到场再确认", "要到场再确认"],
  ["不要用一个统一状态带过", "两处促销各自保留处理状态"],
  ["开票动作与扣除提示不要混成一个结论", "开票动作与扣除提示分开落结论"],
  ["现阶段不要预填金额或批次结论", "现阶段金额和批次结论先留空"],
  ["不要把规则附件写成产品已经完成的功效证明", "规则附件只作为审改尺度，产品功效仍要等对应材料"],
  ["不要把一次留资推成对后续全部用途的授权", "一次留资只对应当时告知的用途，后续用途另看材料"],
  ["必须保留的人工动作", "需要保留的人工动作"],
  ["哪些信息必须等逐套核验", "哪些信息要等逐套核验"],
  ["这四项不要打包写一句同意就算了，逐个看", "这四项得逐个看"],
  ["试用能开到哪一步留给园长和家委会决定，不要替他们把同意范围写死", "试用能开到哪一步和同意范围都留给园长、家委会决定"],
  ["不要先替任何一方宣布规则已经可以上线", "规则能不能上线仍由各方确认"],
  ["当前缺B3对应测试材料和清楚的包件方案时不要替承运人放行", "当前缺B3对应测试材料和清楚的包件方案时就维持暂缓出运，放行结论仍由承运人作出"],
  ["不要因为供应商提到尾款就把后面的阶段提前", "供应商提到尾款也不改变后续阶段的证据要求"],
  ["最后让我能从任意一个点位追回照片事实、当下动作和下一步缺什么", "最后我要判断哪些位置先清、哪些只安排勘查，每个判断都能追回照片事实、当下动作和下一步缺什么"],
  ["拿不到的就在台账里留成明确的追问", "拿不到的就在台账里留成明确的追问，最后判断哪些活动规则和字段用法能进测试"],
  ["规则能不能上线仍由各方确认", "规则是否具备提交主办方确认的条件、最后能不能上线，都由各方确认"],
  ["我想用这两份文件守住签字边界", "我想用这两份文件判断这周能签到哪一步，也守住签字边界"],
  ["周五前这批达人素材就要定稿投放", "这批达人素材就要定稿投放"],
  ["销售明天要在客户周会上解释海外CRM试用", "销售明天要向客户解释海外CRM试用"],
  ["销售明天拿着它去开客户周会", "销售明天拿着它跟客户谈"],
  ["Word先给销售一段会上能直接用的范围说明", "Word先给销售一段能直接对客户说的范围说明"],
  ["理事会拿到后只判断要不要继续和街道沟通，不把它当成投标方案", "理事会拿到后用来判断要不要继续和街道沟通，它不是投标方案"],
  ["规则只能设计收件办法，不能替30套房源证明现状", "规则只用来设计收件办法，30套房源现状仍要逐套核证"],
];

const CHAT_COMMA_UIDS = new Set([
  "沈礼_7.9_05",
  "沈礼_7.10_02",
  "沈礼_7.10_03",
  "沈礼_7.10_06",
]);

const SCENE_FINAL_OVERRIDES = {
  "沈礼_7.9_06": {
    requestSpan: "前面的边界就按这些事实保留，能不能做一份Word《养老助餐机会讨论要点》和一张Excel《养老助餐能力与补件表》，理事会拿到后用来判断要不要继续和街道沟通，它不是投标方案。",
  },
  "裴硬_7.9_01": {
    motivationSpan: "这批达人素材就要定稿投放",
  },
  "裴硬_7.9_02": {
    downstreamUse: "销售向客户解释当前可讨论范围和正式评审前提",
    requestSpan: "这轮你替我整理一份Word《海外CRM少字段试点说明》和一张Excel《海外CRM线索字段初筛表》，销售明天拿着它跟客户谈。",
    motivationSpan: "销售明天要向客户解释海外CRM试用",
    downstreamUseSpan: "销售明天拿着它跟客户谈",
  },
};

function naturalizeBoundaryVoice(value, uid = "") {
  const rewritten = NATURAL_BOUNDARY_REWRITES.reduce(
    (question, [before, after]) => question.replaceAll(before, after),
    normalize(value),
  );
  // These four requester voices are intentionally conversational rather than
  // list-like: connected commas fit their chat message better than a run of
  // formal enumeration marks. Other roles retain their source-appropriate 、.
  return CHAT_COMMA_UIDS.has(uid) ? rewritten.replaceAll("、", "，") : rewritten;
}

function naturalizeScenePunctuation(scene, uid) {
  if (!CHAT_COMMA_UIDS.has(uid)) return { ...scene };
  return Object.fromEntries(Object.entries(scene).map(([key, value]) => {
    if (typeof value === "string") return [key, value.replaceAll("、", "，")];
    if (Array.isArray(value)) return [key, value.map((item) => (
      typeof item === "string" ? item.replaceAll("、", "，") : item
    ))];
    return [key, value];
  }));
}

function assertExactSpan(question, span, label, { optional = false } = {}) {
  if (optional && !span) return;
  if (!span) throw new Error(`${label} cannot be blank.`);
  const first = question.indexOf(span);
  if (first < 0 || question.indexOf(span, first + span.length) >= 0) {
    throw new Error(`${label} must occur exactly once in its question.`);
  }
}

function candidateVariants(question, requestSpan) {
  const alternatives = [
    "你帮我把这件事整理成一份Word和一张Excel",
    "这部分交给你处理，我要一份Word和一张Excel",
  ];
  return [
    { candidateId: "A", question, status: "selected", rationale: "角色因果、交付用途和事实边界最完整。" },
    ...alternatives.map((replacement, index) => ({
      candidateId: index === 0 ? "B" : "C",
      question: question.replace(requestSpan, replacement),
      status: "rejected",
      rationale: "通用委托句削弱了这个角色的具体工作关系，未选用。",
    })),
  ];
}

function createSceneEnvelope(record, rewrite, factId, materialId, unknownText) {
  const { scene, question } = rewrite;
  const sceneCard = {
    schemaVersion: 1,
    policyId: SCENE_CARD_PROTOCOL_ID,
    topicId: `topic-row-${record.sheetRow}`,
    personaId: `persona-row-${record.sheetRow}-${String(record.UID).replace(/[^\p{L}\p{N}._:-]+/gu, "-")}`,
    requester: {
      functionalRole: scene.functionalRole,
      organizationType: scene.organizationType,
      department: "",
      responsibility: scene.responsibility,
      authorityBoundary: scene.authorityBoundary,
      recipientRelation: scene.recipientRelation,
    },
    scene: {
      workflowStage: scene.workflowStage,
      trigger: scene.trigger,
      currentBlockage: scene.currentBlockage,
      mainDecision: scene.mainDecision,
      downstreamUse: scene.downstreamUse,
    },
    informationBoundary: {
      knownFactIds: [factId],
      availableMaterialIds: [materialId],
      unknowns: [unknownText],
      forbiddenInferences: ["不能补写现有材料没有给出的审批结果、检测结果或责任结论"],
    },
    voice: {
      channel: scene.channel || "即时工作消息",
      formality: scene.formality || "熟悉协作者之间的具体工作交代，保留岗位自己的说话重心",
      domainVocabulary: scene.domainVocabulary,
      avoidVocabulary: scene.avoidVocabulary,
    },
    maskTerms: scene.maskTerms,
    evidenceBindings: [
      { claim: scene.trigger, factIds: [factId] },
      { claim: scene.currentBlockage, factIds: [factId] },
      { claim: scene.mainDecision, factIds: [factId] },
    ],
  };
  return {
    recordUid: record.UID,
    sceneCard,
    requestContract: {
      requestSpan: scene.requestSpan,
      action: scene.action,
      outputs: [
        { format: "docx", humanName: "Word", purpose: record["产物内容"] },
        { format: "xlsx", humanName: "Excel", purpose: record["产物内容"] },
      ],
    },
    roleTrace: {
      blockageSpan: scene.blockageSpan,
      motivationSpan: scene.motivationSpan,
      downstreamUseSpan: scene.downstreamUseSpan,
    },
    usedFactIds: [factId],
    deliberatelyOmitted: [],
  };
}

function validateRewrite(source, rewrite) {
  if (!rewrite?.question || !rewrite?.scene) throw new Error(`${source.UID} has no situated rewrite.`);
  const question = naturalizeBoundaryVoice(rewrite.question, source.UID);
  assertNaturalQuestionPresentation(question, { label: source.UID });
  assertClearQuestionRequest(question, { label: source.UID, productFormats: source["产物格式"] });
  assertNoPoliteImperative({ 题目: question }, { fields: ["题目"], label: source.UID });
  const length = visibleLength(question);
  if (length < 700 || length > 1500) {
    throw new Error(`${source.UID} question length ${length} is outside 700-1500.`);
  }
  assertNoUnsupportedFactAnchors({
    source,
    candidate: { ...source, 题目: question },
    uid: source.UID,
  });
  for (const [field, options] of [
    ["requestSpan", {}],
    ["blockageSpan", {}],
    ["motivationSpan", { optional: true }],
    ["downstreamUseSpan", {}],
  ]) {
    assertExactSpan(question, rewrite.scene[field], `${source.UID}.${field}`, options);
  }
  if (!rewrite.scene.requestSpan.includes(rewrite.scene.action)) {
    throw new Error(`${source.UID}.action must be copied from requestSpan.`);
  }
  return question;
}

export async function buildSituatedManagedSubmission() {
  const sourceBundle = JSON.parse(await fs.readFile(path.join(SOURCE_RUN, "sources", "managed_records_draft.json"), "utf8"));
  const sourceAttachmentManifest = JSON.parse(await fs.readFile(
    path.join(SOURCE_RUN, "sources", "attachment_manifest.json"),
    "utf8",
  ));
  const sourceRecords = sourceBundle.records.sort((left, right) => Number(left.sheetRow) - Number(right.sheetRow));
  const expectedUids = sourceRecords.map((record) => record.UID).sort();
  const actualUids = Object.keys(REWRITES).sort();
  if (JSON.stringify(expectedUids) !== JSON.stringify(actualUids)) {
    throw new Error(`Situated rewrite coverage mismatch: expected=${expectedUids.join(",")}; actual=${actualUids.join(",")}`);
  }

  const facts = [];
  const materials = [];
  const unknowns = [];
  const cards = [];
  const candidates = [];
  const records = [];
  for (const source of sourceRecords) {
    const baseRewrite = REWRITES[source.UID];
    const rewrite = {
      ...baseRewrite,
      scene: {
        ...naturalizeScenePunctuation(baseRewrite.scene, source.UID),
        ...(SCENE_FINAL_OVERRIDES[source.UID] ?? {}),
      },
    };
    const question = validateRewrite(source, rewrite);
    const factId = `fact-row-${source.sheetRow}`;
    const materialId = `material-row-${source.sheetRow}`;
    const unknownId = `unknown-row-${source.sheetRow}`;
    const unknownText = `第${source.sheetRow}行事项最后由有权人员作出的结论`;
    facts.push({
      id: factId,
      uid: source.UID,
      text: [source["题目"], source["任务概括"], source["产物内容"], source["附件内容"]].join("\n"),
    });
    materials.push({ id: materialId, uid: source.UID, text: source["相关附件"] });
    unknowns.push({ id: unknownId, uid: source.UID, text: unknownText });
    cards.push(createSceneEnvelope(source, { ...rewrite, question }, factId, materialId, unknownText));
    candidates.push({
      recordUid: source.UID,
      personaId: `persona-row-${source.sheetRow}`,
      variants: candidateVariants(question, rewrite.scene.requestSpan),
    });
    records.push({ ...source, 题目: question });
  }

  await Promise.all(["sources", "attachments", "drafts", "feishu", "qa", "logs", "tmp"].map((dir) => (
    fs.mkdir(path.join(RUN_DIR, dir), { recursive: true })
  )));
  await fs.cp(path.join(SOURCE_RUN, "attachments"), path.join(RUN_DIR, "attachments"), {
    recursive: true,
    force: true,
  });
  const attachmentManifest = {
    ...sourceAttachmentManifest,
    attachments: (sourceAttachmentManifest.attachments ?? []).map((item) => ({
      ...item,
      targetPath: path.join(RUN_DIR, "attachments", item.uid, item.fileName),
    })),
  };
  const factLedger = { schemaVersion: 1, generatedAt: new Date().toISOString(), facts, materials, unknowns };
  const factLedgerText = `${JSON.stringify(factLedger, null, 2)}\n`;
  const factLedgerPath = path.join(RUN_DIR, "sources", "fact_ledger.json");
  await fs.writeFile(factLedgerPath, factLedgerText, "utf8");
  const sceneBundle = {
    kind: SCENE_CARD_BUNDLE_KIND,
    protocolId: SCENE_CARD_PROTOCOL_ID,
    schemaVersion: 1,
    factLedgerPath: "fact_ledger.json",
    factLedgerHash: sha256(factLedgerText),
    cards,
  };

  const tsvPath = path.join(RUN_DIR, "drafts", "l2_questions_situated.tsv");
  const tsvText = toTsv(records);
  await fs.writeFile(tsvPath, tsvText, "utf8");
  const plan = buildFeishuFillPlan({
    text: tsvText,
    sourcePath: tsvPath,
    sheetRows: records.map((record) => Number(record.sheetRow)),
    count: records.length,
    columnMap: NARRATIVE_COLUMN_MAP,
  });
  const fillPlanPath = path.join(RUN_DIR, "feishu", "feishu_fill_plan_situated.json");
  await Promise.all([
    writeJsonAtomic(path.join(RUN_DIR, "sources", "scene_cards.json"), sceneBundle),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "requester_candidates.json"), {
      schemaVersion: 1,
      policyId: SCENE_CARD_PROTOCOL_ID,
      candidateCountPerRecord: 3,
      records: candidates,
    }),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_source.json"), sourceBundle),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "attachment_manifest.json"), attachmentManifest),
    writeJsonAtomic(path.join(RUN_DIR, "sources", "managed_records_draft.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      count: records.length,
      records,
    }),
    writeJsonAtomic(fillPlanPath, plan),
    writeJsonAtomic(path.join(RUN_DIR, "manifest.json"), {
      runId: RUN_ID,
      generatedAt: new Date().toISOString(),
      objective: "将沈礼和裴硬的22条系统生成记录重写为角色有限视角的真实工作请求并提交复审",
      status: "drafted-not-submitted",
      count: records.length,
      generatedAnnotators: ["沈礼", "裴硬"],
      annotatorIdentityNote: "沈礼与裴硬仅为系统生成标注身份，每个主题使用独立personaId。",
      promptProtocol: SCENE_CARD_PROTOCOL_ID,
      candidateCountPerScene: 3,
      questionPresentation: "single-paragraph-clear-request-v2",
      spreadsheetToken: "ByAysb2Cdh9V2wtISbJc6Z01nwc",
      sheetId: "49e351",
      sheetRows: records.map((record) => Number(record.sheetRow)),
      writableFields: NARRATIVE_COLUMN_MAP.map((item) => item.field),
      sources: {
        factLedger: "sources/fact_ledger.json",
        sceneCards: "sources/scene_cards.json",
        requesterCandidates: "sources/requester_candidates.json",
      },
    }),
  ]);

  return {
    ok: true,
    runId: RUN_ID,
    rowCount: records.length,
    questionLengths: records.map((record) => ({ uid: record.UID, length: visibleLength(record.题目) })),
    tsvPath,
    factLedgerPath,
    sceneCardPath: path.join(RUN_DIR, "sources", "scene_cards.json"),
    fillPlanPath,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSituatedManagedSubmission()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
