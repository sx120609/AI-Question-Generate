import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { auditFactAnchors } from "./fact_guard.mjs";
import {
  analyzeQuestionRequest,
  missingQuestionDeliverableFormats,
} from "./language_style.mjs";
import { analyzeProductFormat } from "./product_format.mjs";
import { resolveProductionProfile } from "./production_profile.mjs";
import { parseTsvRows } from "./structure_fingerprint.mjs";

export const SCENE_CARD_PROTOCOL_ID = "situated-requester-v1";
export const SCENE_CARD_SCHEMA_VERSION = 1;
export const SCENE_CARD_GATE_ID = "scene-card-role-consistency-v1";
export const SCENE_CARD_REPORT_KIND = "scene-card-gate-report";
export const SCENE_CARD_BUNDLE_KIND = "scene-card-bundle";
export const SCENE_CARD_BUNDLE_VERSION = 1;

export const SCENE_CARD_BATCH_THRESHOLDS = Object.freeze({
  highMaskedTrigramSimilarity: 0.72,
  sharedMaskedFragmentLength: 18,
});

const IDENTIFIER_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{1,119}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const BOUNDARY_PATTERN = /只|仅|不|无权|不能|不得|未知|待确认|留空|以.+为准|由.+决定/u;
const INTERNAL_ROLE_MARKER_PATTERN = /persona[_ -]?id|scene[_ -]?card|requestContract|roleTrace|knownFactIds|角色卡|人物设定|世界观|行为准则|生产规则|系统提示/iu;
// Natural requesters do sometimes say "我们是一家……" or "我在……负责……".
// Only catch prompt-like role exposition here; ungrounded copied role/org terms
// are checked separately by exactHiddenLeaks.
const SELF_IDENTIFICATION_PATTERN = /作为(?:一名|一个)[^，。！？!?]{0,40}|我的(?:身份|角色|人设)是|我现在扮演|(?:根据|按照?|依照)(?:角色卡|人物设定)/u;
const DRAMATIC_FIELD_NAME_PATTERN = /backstory|biography|personality|emotion|boss.?pressure|urgency|deadline|plot|story|conflict|背景故事|人物小传|性格|情绪|领导压力|戏剧|剧情/iu;
const UNIVERSAL_MASK_TERMS = [
  "Word", "Excel", "PPT", "PDF", "HTML", "文档", "文稿", "工作簿", "演示文稿", "网页",
];

const DRAMATIC_CLAIM_PATTERNS = Object.freeze([
  ["boss-pressure", /(?:老板|领导|上级).{0,10}(?:催|施压|追问|盯着)|催得(?:很|特别)?急|领导催办/u],
  ["artificial-urgency", /十万火急|火烧眉毛|(?:紧急|加急)(?:任务|通知|要求|处理)?|(?:马上|立刻|今晚|明早|下班前|会前).{0,8}(?:交|给|完成|提交|要)/u],
  ["invented-conflict", /(?:客户|同事|老板|领导).{0,10}(?:发火|震怒|吵|闹)|甩锅|冲突升级|部门争执|追责/u],
  ["plot-device", /突然|临时(?:通知|要求|加塞|开会)|意外发现|恰好/u],
]);

const SCENE_CARD_FIELDS = [
  "schemaVersion",
  "policyId",
  "topicId",
  "personaId",
  "requester",
  "scene",
  "informationBoundary",
  "voice",
  "maskTerms",
  "evidenceBindings",
];

const CARD_ENVELOPE_FIELDS = [
  "recordUid",
  "sceneCard",
  "requestContract",
  "roleTrace",
  "usedFactIds",
  "deliberatelyOmitted",
];

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  if (typeof value === "string") return value.normalize("NFC").replace(/\r\n?/gu, "\n");
  return value;
}

function stableHash(value) {
  const serialized = JSON.stringify(stableValue(value));
  if (serialized === undefined) throw new TypeError("Cannot hash an undefined scene-card value.");
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sceneCardHash(sceneCard) {
  return stableHash(sceneCard);
}

export const hashSceneCard = sceneCardHash;

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\\n/gu, "\n")
    .replace(/[／⁄]/gu, "/")
    .replace(/(?<=\d)[,，](?=\d)/gu, "")
    .replace(/\s+/gu, "")
    .trim();
}

function issue(code, pathName, message, details = undefined) {
  return {
    code,
    path: pathName,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function checkExactObject(value, pathName, allowedFields, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue("invalid_object", pathName, `${pathName} must be a plain object.`));
    return false;
  }
  for (const field of allowedFields) {
    if (!Object.hasOwn(value, field)) {
      errors.push(issue("missing_field", `${pathName}.${field}`, `${pathName}.${field} is required.`));
    }
  }
  for (const field of Object.keys(value)) {
    if (allowedFields.includes(field)) continue;
    errors.push(issue(
      DRAMATIC_FIELD_NAME_PATTERN.test(field) ? "unsupported_dramatic_field" : "unknown_field",
      `${pathName}.${field}`,
      `${pathName}.${field} is not part of the scene-card protocol; put factual context in an evidence-bound claim.`,
    ));
  }
  return true;
}

function checkString(value, pathName, errors, {
  allowBlank = false,
  maxLength = 320,
  identifier = false,
} = {}) {
  if (typeof value !== "string") {
    errors.push(issue("invalid_string", pathName, `${pathName} must be a string.`));
    return "";
  }
  const normalized = value.trim();
  if (!allowBlank && !normalized) {
    errors.push(issue("blank_string", pathName, `${pathName} cannot be blank.`));
  }
  if ([...normalized].length > maxLength) {
    errors.push(issue("string_too_long", pathName, `${pathName} exceeds ${maxLength} characters.`));
  }
  if (identifier && normalized && !IDENTIFIER_PATTERN.test(normalized)) {
    errors.push(issue("invalid_identifier", pathName, `${pathName} must be a stable identifier without spaces.`));
  }
  return normalized;
}

function checkStringArray(value, pathName, errors, {
  min = 0,
  max = 30,
  itemMaxLength = 240,
  identifiers = false,
} = {}) {
  if (!Array.isArray(value)) {
    errors.push(issue("invalid_array", pathName, `${pathName} must be an array.`));
    return [];
  }
  if (value.length < min || value.length > max) {
    errors.push(issue("invalid_array_length", pathName, `${pathName} must contain ${min}-${max} items.`));
  }
  const items = value.map((item, index) => checkString(item, `${pathName}[${index}]`, errors, {
    maxLength: itemMaxLength,
    identifier: identifiers,
  }));
  const duplicates = items.filter((item, index) => item && items.indexOf(item) !== index);
  for (const duplicate of new Set(duplicates)) {
    errors.push(issue("duplicate_value", pathName, `${pathName} contains duplicate value: ${duplicate}`));
  }
  return items;
}

function getAtPath(record, fieldPath) {
  if (!record || !fieldPath) return undefined;
  if (Object.hasOwn(record, fieldPath)) return record[fieldPath];
  return String(fieldPath).split(".").reduce((current, part) => current?.[part], record);
}

function ledgerItems(ledger, names) {
  for (const name of names) {
    const value = getAtPath(ledger, name);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function itemId(item) {
  if (typeof item === "string") return item.trim();
  return String(item?.id ?? item?.factId ?? item?.materialId ?? item?.unknownId ?? item?.sourceId ?? "").trim();
}

function itemText(item) {
  if (typeof item === "string") return item;
  return String(
    item?.text
    ?? item?.statement
    ?? item?.claim
    ?? item?.description
    ?? item?.content
    ?? item?.question
    ?? "",
  );
}

function ledgerIndex(factLedger) {
  const facts = ledgerItems(factLedger, ["facts", "knownFacts", "entries.facts"]);
  const materials = ledgerItems(factLedger, [
    "materials", "availableMaterials", "sourceMaterials", "attachments", "sources",
  ]);
  const unknowns = ledgerItems(factLedger, ["unknowns", "informationBoundary.unknowns"]);
  return {
    facts: new Map(facts.map((item) => [itemId(item), item]).filter(([id]) => id)),
    materials: new Map(materials.map((item) => [itemId(item), item]).filter(([id]) => id)),
    unknowns: new Map(unknowns.map((item) => [itemId(item), item]).filter(([id]) => id)),
    unknownItems: unknowns,
  };
}

function auditAnchorsAgainstText(candidateText, sourceText) {
  return auditFactAnchors({
    source: { bound: sourceText },
    candidate: { candidate: candidateText },
    sourceFields: ["bound"],
    candidateFields: ["candidate"],
  });
}

function dramaticFindings(value, pathName) {
  const text = String(value ?? "");
  return DRAMATIC_CLAIM_PATTERNS.flatMap(([category, pattern]) => {
    const match = text.match(pattern);
    return match ? [{ category, marker: match[0], path: pathName }] : [];
  });
}

function evidenceSupportsDramaticCategory(bindings, category, factIds = null) {
  const categoryPattern = DRAMATIC_CLAIM_PATTERNS.find(([name]) => name === category)?.[1];
  if (!categoryPattern) return false;
  return bindings.some((binding) => {
    if (factIds && !binding.factIds.some((id) => factIds.has(id))) return false;
    return categoryPattern.test(binding.claim);
  });
}

function validateEvidenceBindings(sceneCard, errors, factLedger) {
  const knownFactIds = new Set(sceneCard?.informationBoundary?.knownFactIds ?? []);
  const bindings = Array.isArray(sceneCard?.evidenceBindings) ? sceneCard.evidenceBindings : [];
  const ledger = factLedger ? ledgerIndex(factLedger) : null;

  bindings.forEach((binding, index) => {
    const bindingPath = `sceneCard.evidenceBindings[${index}]`;
    if (!checkExactObject(binding, bindingPath, ["claim", "factIds"], errors)) return;
    const claim = checkString(binding.claim, `${bindingPath}.claim`, errors, { maxLength: 320 });
    const factIds = checkStringArray(binding.factIds, `${bindingPath}.factIds`, errors, {
      min: 1,
      max: 12,
      identifiers: true,
    });
    for (const factId of factIds) {
      if (!knownFactIds.has(factId)) {
        errors.push(issue(
          "evidence_uses_unknown_fact",
          `${bindingPath}.factIds`,
          `${factId} is not declared in informationBoundary.knownFactIds.`,
        ));
      }
      if (ledger && !ledger.facts.has(factId)) {
        errors.push(issue(
          "missing_fact_ledger_entry",
          `${bindingPath}.factIds`,
          `${factId} does not exist in the bound fact ledger.`,
        ));
      }
    }
    if (ledger && claim && factIds.length) {
      const sourceText = factIds.map((id) => itemText(ledger.facts.get(id))).join("\n");
      const anchorReport = auditAnchorsAgainstText(claim, sourceText);
      for (const anchor of anchorReport.errors) {
        errors.push(issue(
          "evidence_claim_has_unbound_anchor",
          `${bindingPath}.claim`,
          `Evidence claim contains an anchor absent from its factIds: ${anchor.type}:${anchor.value}`,
        ));
      }
    }
  });

  const requiredClaims = [
    ["sceneCard.scene.trigger", sceneCard?.scene?.trigger],
    ["sceneCard.scene.currentBlockage", sceneCard?.scene?.currentBlockage],
    ["sceneCard.scene.mainDecision", sceneCard?.scene?.mainDecision],
  ];
  if (sceneCard?.requester?.department?.trim()) {
    requiredClaims.push(["sceneCard.requester.department", sceneCard.requester.department]);
  }
  for (const [pathName, value] of requiredClaims) {
    if (!value || bindings.some((binding) => normalizeText(binding?.claim) === normalizeText(value))) continue;
    errors.push(issue(
      "missing_evidence_binding",
      pathName,
      `${pathName} must appear verbatim as an evidenceBindings.claim.`,
    ));
  }

  const assertedFields = [
    ["sceneCard.requester.responsibility", sceneCard?.requester?.responsibility],
    ["sceneCard.requester.recipientRelation", sceneCard?.requester?.recipientRelation],
    ["sceneCard.scene.trigger", sceneCard?.scene?.trigger],
    ["sceneCard.scene.currentBlockage", sceneCard?.scene?.currentBlockage],
    ["sceneCard.scene.mainDecision", sceneCard?.scene?.mainDecision],
    ["sceneCard.scene.downstreamUse", sceneCard?.scene?.downstreamUse],
  ];
  for (const [pathName, value] of assertedFields) {
    for (const finding of dramaticFindings(value, pathName)) {
      if (evidenceSupportsDramaticCategory(bindings, finding.category)) continue;
      errors.push(issue(
        "unsupported_dramatic_claim",
        pathName,
        `Dramatic context '${finding.marker}' has no evidence binding of the same kind.`,
        finding,
      ));
    }
  }
}

export function validateSceneCard(sceneCard, { factLedger = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!checkExactObject(sceneCard, "sceneCard", SCENE_CARD_FIELDS, errors)) {
    return {
      ok: false,
      errors,
      warnings,
      checks: {},
      sceneCardHash: isPlainObject(sceneCard) ? sceneCardHash(sceneCard) : "",
    };
  }

  if (sceneCard.schemaVersion !== SCENE_CARD_SCHEMA_VERSION) {
    errors.push(issue(
      "schema_version_mismatch",
      "sceneCard.schemaVersion",
      `sceneCard.schemaVersion must be ${SCENE_CARD_SCHEMA_VERSION}.`,
    ));
  }
  if (sceneCard.policyId !== SCENE_CARD_PROTOCOL_ID) {
    errors.push(issue(
      "policy_id_mismatch",
      "sceneCard.policyId",
      `sceneCard.policyId must be ${SCENE_CARD_PROTOCOL_ID}.`,
    ));
  }
  checkString(sceneCard.topicId, "sceneCard.topicId", errors, { identifier: true });
  checkString(sceneCard.personaId, "sceneCard.personaId", errors, { identifier: true });

  if (checkExactObject(sceneCard.requester, "sceneCard.requester", [
    "functionalRole",
    "organizationType",
    "department",
    "responsibility",
    "authorityBoundary",
    "recipientRelation",
  ], errors)) {
    checkString(sceneCard.requester.functionalRole, "sceneCard.requester.functionalRole", errors, { maxLength: 80 });
    checkString(sceneCard.requester.organizationType, "sceneCard.requester.organizationType", errors, { maxLength: 100 });
    checkString(sceneCard.requester.department, "sceneCard.requester.department", errors, { allowBlank: true, maxLength: 100 });
    checkString(sceneCard.requester.responsibility, "sceneCard.requester.responsibility", errors, { maxLength: 220 });
    const authority = checkString(sceneCard.requester.authorityBoundary, "sceneCard.requester.authorityBoundary", errors, { maxLength: 220 });
    checkString(sceneCard.requester.recipientRelation, "sceneCard.requester.recipientRelation", errors, { maxLength: 220 });
    if (authority && !BOUNDARY_PATTERN.test(authority)) {
      errors.push(issue(
        "missing_authority_boundary",
        "sceneCard.requester.authorityBoundary",
        "authorityBoundary must state an actual limit, not only a responsibility.",
      ));
    }
  }

  if (checkExactObject(sceneCard.scene, "sceneCard.scene", [
    "workflowStage",
    "trigger",
    "currentBlockage",
    "mainDecision",
    "downstreamUse",
  ], errors)) {
    for (const field of ["workflowStage", "trigger", "currentBlockage", "mainDecision", "downstreamUse"]) {
      checkString(sceneCard.scene[field], `sceneCard.scene.${field}`, errors, { maxLength: 260 });
    }
  }

  let knownFactIds = [];
  let availableMaterialIds = [];
  let declaredUnknowns = [];
  if (checkExactObject(sceneCard.informationBoundary, "sceneCard.informationBoundary", [
    "knownFactIds",
    "availableMaterialIds",
    "unknowns",
    "forbiddenInferences",
  ], errors)) {
    knownFactIds = checkStringArray(
      sceneCard.informationBoundary.knownFactIds,
      "sceneCard.informationBoundary.knownFactIds",
      errors,
      { min: 1, max: 30, identifiers: true },
    );
    availableMaterialIds = checkStringArray(
      sceneCard.informationBoundary.availableMaterialIds,
      "sceneCard.informationBoundary.availableMaterialIds",
      errors,
      { min: 0, max: 30, identifiers: true },
    );
    declaredUnknowns = checkStringArray(
      sceneCard.informationBoundary.unknowns,
      "sceneCard.informationBoundary.unknowns",
      errors,
      { min: 1, max: 20, itemMaxLength: 220 },
    );
    const forbidden = checkStringArray(
      sceneCard.informationBoundary.forbiddenInferences,
      "sceneCard.informationBoundary.forbiddenInferences",
      errors,
      { min: 1, max: 20, itemMaxLength: 220 },
    );
    if (!forbidden.some((value) => BOUNDARY_PATTERN.test(value))) {
      errors.push(issue(
        "missing_knowledge_boundary",
        "sceneCard.informationBoundary.forbiddenInferences",
        "forbiddenInferences must explicitly state at least one knowledge or authority limit.",
      ));
    }
  }

  if (checkExactObject(sceneCard.voice, "sceneCard.voice", [
    "channel",
    "formality",
    "domainVocabulary",
    "avoidVocabulary",
  ], errors)) {
    checkString(sceneCard.voice.channel, "sceneCard.voice.channel", errors, { maxLength: 80 });
    checkString(sceneCard.voice.formality, "sceneCard.voice.formality", errors, { maxLength: 160 });
    checkStringArray(sceneCard.voice.domainVocabulary, "sceneCard.voice.domainVocabulary", errors, {
      min: 1,
      max: 12,
      itemMaxLength: 40,
    });
    checkStringArray(sceneCard.voice.avoidVocabulary, "sceneCard.voice.avoidVocabulary", errors, {
      min: 1,
      max: 20,
      itemMaxLength: 60,
    });
  }

  const maskTerms = checkStringArray(sceneCard.maskTerms, "sceneCard.maskTerms", errors, {
    min: 0,
    max: 30,
    itemMaxLength: 80,
  });
  if (!maskTerms.length) {
    warnings.push(issue(
      "empty_mask_terms",
      "sceneCard.maskTerms",
      "maskTerms is empty; batch author-voice masking will rely only on requester and output terms.",
    ));
  }

  if (!Array.isArray(sceneCard.evidenceBindings)) {
    errors.push(issue("invalid_array", "sceneCard.evidenceBindings", "sceneCard.evidenceBindings must be an array."));
  } else if (!sceneCard.evidenceBindings.length) {
    errors.push(issue("invalid_array_length", "sceneCard.evidenceBindings", "sceneCard.evidenceBindings cannot be empty."));
  }
  validateEvidenceBindings(sceneCard, errors, factLedger);

  if (factLedger) {
    const ledger = ledgerIndex(factLedger);
    for (const factId of knownFactIds) {
      if (!ledger.facts.has(factId)) {
        errors.push(issue(
          "missing_fact_ledger_entry",
          "sceneCard.informationBoundary.knownFactIds",
          `${factId} does not exist in the bound fact ledger.`,
        ));
      }
    }
    for (const materialId of availableMaterialIds) {
      if (!ledger.materials.has(materialId)) {
        errors.push(issue(
          "missing_material_ledger_entry",
          "sceneCard.informationBoundary.availableMaterialIds",
          `${materialId} does not exist in the bound fact ledger.`,
        ));
      }
    }
    for (const unknown of declaredUnknowns) {
      const target = normalizeText(unknown);
      const matched = ledger.unknownItems.some((item) => {
        const id = normalizeText(itemId(item));
        const text = normalizeText(itemText(item));
        return target === id || target === text || (target.length >= 4 && (text.includes(target) || target.includes(text)));
      });
      if (!matched) {
        errors.push(issue(
          "unknown_not_in_fact_ledger",
          "sceneCard.informationBoundary.unknowns",
          `Declared unknown is absent from the fact ledger: ${unknown}`,
        ));
      }
    }
  }

  const knownText = factLedger
    ? knownFactIds.map((id) => itemText(ledgerIndex(factLedger).facts.get(id))).join("\n")
    : sceneCard.evidenceBindings.map((binding) => binding?.claim ?? "").join("\n");
  const unknownOverlap = declaredUnknowns.filter((unknown) => {
    const value = normalizeText(unknown);
    return value.length >= 4 && normalizeText(knownText).includes(value);
  });
  for (const overlap of unknownOverlap) {
    errors.push(issue(
      "known_unknown_overlap",
      "sceneCard.informationBoundary.unknowns",
      `The same information is declared both known and unknown: ${overlap}`,
    ));
  }

  const result = {
    ok: errors.length === 0,
    errors,
    warnings,
    checks: {
      knownFactCount: knownFactIds.length,
      materialCount: availableMaterialIds.length,
      unknownCount: declaredUnknowns.length,
      evidenceBindingCount: Array.isArray(sceneCard.evidenceBindings) ? sceneCard.evidenceBindings.length : 0,
      factLedgerVerified: Boolean(factLedger),
    },
    sceneCardHash: sceneCardHash(sceneCard),
  };
  return { ...result, validationHash: stableHash(result) };
}

export function assertValidSceneCard(sceneCard, options = {}) {
  const report = validateSceneCard(sceneCard, options);
  if (!report.ok) {
    const details = report.errors.map((entry) => `${entry.code}@${entry.path}`).join(", ");
    const error = new Error(`Invalid scene card: ${details}`);
    error.report = report;
    throw error;
  }
  return report;
}

function validateRequestContract(requestContract, errors, { allowEmptyOutputs = false } = {}) {
  const outputs = [];
  if (!checkExactObject(requestContract, "requestContract", ["requestSpan", "action", "outputs"], errors)) {
    return outputs;
  }
  checkString(requestContract.requestSpan, "requestContract.requestSpan", errors, { maxLength: 600 });
  checkString(requestContract.action, "requestContract.action", errors, { maxLength: 80 });
  if (!Array.isArray(requestContract.outputs)) {
    errors.push(issue("invalid_array", "requestContract.outputs", "requestContract.outputs must be an array."));
    return outputs;
  }
  if (!requestContract.outputs.length && !allowEmptyOutputs) {
    errors.push(issue("invalid_array_length", "requestContract.outputs", "requestContract.outputs cannot be empty."));
  }
  requestContract.outputs.forEach((output, index) => {
    const outputPath = `requestContract.outputs[${index}]`;
    if (!checkExactObject(output, outputPath, ["format", "humanName", "purpose"], errors)) return;
    const format = checkString(output.format, `${outputPath}.format`, errors, { maxLength: 20 });
    const humanName = checkString(output.humanName, `${outputPath}.humanName`, errors, { maxLength: 80 });
    checkString(output.purpose, `${outputPath}.purpose`, errors, { maxLength: 220 });
    const analyzed = analyzeProductFormat(format);
    if (!analyzed.isCanonical || analyzed.formats.length !== 1) {
      errors.push(issue(
        "invalid_output_format",
        `${outputPath}.format`,
        `${format} must be one canonical product-format extension.`,
      ));
    }
    if (format && humanName && missingQuestionDeliverableFormats(humanName, format).length) {
      errors.push(issue(
        "output_human_name_mismatch",
        `${outputPath}.humanName`,
        `${humanName} does not name ${format} in human terms.`,
      ));
    }
    outputs.push({ format, humanName, purpose: output?.purpose ?? "" });
  });
  const duplicateFormats = outputs
    .map((output) => output.format)
    .filter((format, index, values) => format && values.indexOf(format) !== index);
  for (const format of new Set(duplicateFormats)) {
    errors.push(issue("duplicate_output_format", "requestContract.outputs", `Duplicate output format: ${format}`));
  }
  return outputs;
}

function validateRoleTrace(roleTrace, errors) {
  if (!checkExactObject(roleTrace, "roleTrace", [
    "blockageSpan",
    "motivationSpan",
    "downstreamUseSpan",
  ], errors)) return;
  checkString(roleTrace.blockageSpan, "roleTrace.blockageSpan", errors, { maxLength: 400 });
  checkString(roleTrace.motivationSpan, "roleTrace.motivationSpan", errors, { allowBlank: true, maxLength: 400 });
  checkString(roleTrace.downstreamUseSpan, "roleTrace.downstreamUseSpan", errors, { maxLength: 400 });
}

function validateCardEnvelope(envelope, { factLedger = null, allowEmptyOutputs = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!checkExactObject(envelope, "card", CARD_ENVELOPE_FIELDS, errors)) {
    return { ok: false, errors, warnings, checks: {}, cardHash: isPlainObject(envelope) ? stableHash(envelope) : "" };
  }
  const recordUid = checkString(envelope.recordUid, "card.recordUid", errors, { identifier: true });
  const sceneValidation = validateSceneCard(envelope.sceneCard, { factLedger });
  errors.push(...sceneValidation.errors);
  warnings.push(...sceneValidation.warnings);
  const outputs = validateRequestContract(envelope.requestContract, errors, { allowEmptyOutputs });
  validateRoleTrace(envelope.roleTrace, errors);
  const usedFactIds = checkStringArray(envelope.usedFactIds, "card.usedFactIds", errors, {
    min: 1,
    max: 30,
    identifiers: true,
  });
  const deliberatelyOmitted = checkStringArray(
    envelope.deliberatelyOmitted,
    "card.deliberatelyOmitted",
    errors,
    { min: 0, max: 30, identifiers: true },
  );
  const knownFactIds = envelope.sceneCard?.informationBoundary?.knownFactIds ?? [];
  const knownSet = new Set(knownFactIds);
  const usedSet = new Set(usedFactIds);
  const omittedSet = new Set(deliberatelyOmitted);
  for (const factId of usedSet) {
    if (!knownSet.has(factId)) {
      errors.push(issue("used_fact_outside_role_knowledge", "card.usedFactIds", `${factId} is not known to this requester.`));
    }
    if (omittedSet.has(factId)) {
      errors.push(issue("fact_both_used_and_omitted", "card.deliberatelyOmitted", `${factId} cannot be both used and omitted.`));
    }
  }
  for (const factId of omittedSet) {
    if (!knownSet.has(factId)) {
      errors.push(issue("omitted_fact_outside_role_knowledge", "card.deliberatelyOmitted", `${factId} is not known to this requester.`));
    }
  }
  for (const factId of knownSet) {
    if (!usedSet.has(factId) && !omittedSet.has(factId)) {
      errors.push(issue(
        "known_fact_not_accounted_for",
        "card.usedFactIds",
        `${factId} must be listed as used or deliberately omitted.`,
      ));
    }
  }
  const result = {
    ok: errors.length === 0,
    errors,
    warnings,
    recordUid,
    outputs,
    checks: {
      sceneCardHash: sceneValidation.sceneCardHash,
      knownFactCount: knownFactIds.length,
      usedFactCount: usedFactIds.length,
      omittedFactCount: deliberatelyOmitted.length,
    },
    cardHash: stableHash(envelope),
  };
  return { ...result, validationHash: stableHash(result) };
}

function occurrences(text, fragment) {
  if (!fragment) return 0;
  let count = 0;
  let position = 0;
  while (position <= text.length - fragment.length) {
    const index = text.indexOf(fragment, position);
    if (index < 0) break;
    count += 1;
    position = index + Math.max(1, fragment.length);
  }
  return count;
}

function escapedPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function exactHiddenLeaks(question, sceneCard, boundFactText) {
  const leaks = [];
  if (sceneCard?.personaId && question.includes(sceneCard.personaId)) {
    leaks.push({ type: "persona-id", value: sceneCard.personaId });
  }
  const internal = question.match(INTERNAL_ROLE_MARKER_PATTERN);
  if (internal) leaks.push({ type: "internal-role-marker", value: internal[0] });
  const candidates = [
    ["organization-type", sceneCard?.requester?.organizationType],
    ["department", sceneCard?.requester?.department],
    ["functional-role", sceneCard?.requester?.functionalRole],
  ];
  for (const [type, value] of candidates) {
    if (!value || [...String(value)].length < 3 || !question.includes(value)) continue;
    if (normalizeText(boundFactText).includes(normalizeText(value))) continue;
    leaks.push({ type, value });
  }
  for (const [type, value] of [
    ["authority-boundary", sceneCard?.requester?.authorityBoundary],
    ["forbidden-inference", sceneCard?.informationBoundary?.forbiddenInferences?.find((item) => question.includes(item))],
  ]) {
    if (value && [...String(value)].length >= 8 && question.includes(value)) leaks.push({ type, value });
  }
  return leaks;
}

function outputFormatSet(outputs) {
  return [...new Set(outputs.map((output) => output.format).filter(Boolean))].sort();
}

function formatSetFromM(productFormats) {
  const analysis = analyzeProductFormat(productFormats);
  return { analysis, formats: [...analysis.formats].sort() };
}

function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function boundTextForUsedFacts(envelope, factLedger) {
  const used = new Set(envelope?.usedFactIds ?? []);
  if (factLedger) {
    const facts = ledgerIndex(factLedger).facts;
    return [...used].map((id) => itemText(facts.get(id))).join("\n");
  }
  return (envelope?.sceneCard?.evidenceBindings ?? [])
    .filter((binding) => binding.factIds?.some((id) => used.has(id)))
    .map((binding) => binding.claim)
    .join("\n");
}

export function auditRoleConsistency({
  sceneCard,
  envelope = null,
  requestContract = envelope?.requestContract,
  roleTrace = envelope?.roleTrace,
  usedFactIds = envelope?.usedFactIds ?? [],
  deliberatelyOmitted = envelope?.deliberatelyOmitted ?? [],
  question,
  productFormats,
  record = null,
  factLedger = null,
  productionProfile = "",
} = {}) {
  let profile;
  try {
    profile = resolveProductionProfile(productionProfile || record || "l2");
  } catch {
    profile = resolveProductionProfile("l2");
  }
  const effectiveQuestion = String(question ?? record?.题目 ?? record?.question ?? "");
  const effectiveFormats = String(productFormats ?? record?.产物格式 ?? record?.productFormats ?? "");
  const effectiveEnvelope = envelope ?? {
    recordUid: record?.UID ?? record?.uid ?? "ad-hoc",
    sceneCard,
    requestContract,
    roleTrace,
    usedFactIds,
    deliberatelyOmitted,
  };
  const errors = [];
  const warnings = [];
  const envelopeValidation = validateCardEnvelope(effectiveEnvelope, {
    factLedger,
    allowEmptyOutputs: profile.productFormat.optional,
  });
  errors.push(...envelopeValidation.errors);
  warnings.push(...envelopeValidation.warnings);

  if (!effectiveQuestion.trim()) {
    errors.push(issue("missing_question", "question", "A nonblank question is required."));
  }
  const requestSpan = String(requestContract?.requestSpan ?? "");
  const action = String(requestContract?.action ?? "");
  const outputs = Array.isArray(requestContract?.outputs) ? requestContract.outputs : [];
  const requestSpanOccurrences = occurrences(effectiveQuestion, requestSpan);
  if (requestSpan && requestSpanOccurrences !== 1) {
    errors.push(issue(
      "request_span_not_exact",
      "requestContract.requestSpan",
      `requestSpan must occur exactly once in the question; found ${requestSpanOccurrences}.`,
    ));
  }
  const requestAnalysis = analyzeQuestionRequest(requestSpan);
  if (requestSpan && !requestAnalysis.clear) {
    errors.push(issue(
      "request_span_not_direct_request",
      "requestContract.requestSpan",
      "requestSpan must contain a recognizable requester, action, and concrete deliverable.",
    ));
  }
  if (action && !requestSpan.includes(action)) {
    errors.push(issue(
      "request_action_not_in_span",
      "requestContract.action",
      "requestContract.action must be copied from requestSpan, not supplied as a semantic label.",
    ));
  }
  for (const [index, output] of outputs.entries()) {
    if (output?.humanName && !requestSpan.includes(output.humanName)) {
      errors.push(issue(
        "output_name_not_in_request_span",
        `requestContract.outputs[${index}].humanName`,
        `${output.humanName} must occur in requestSpan.`,
      ));
    }
  }

  const mFormats = formatSetFromM(effectiveFormats);
  const emptyMFormatsAllowed = profile.productFormat.optional && !mFormats.analysis.source;
  if (!emptyMFormatsAllowed && (!mFormats.analysis.canonical || mFormats.analysis.unknown.length)) {
    errors.push(issue(
      "invalid_m_product_formats",
      "productFormats",
      profile.productFormat.optional
        ? "When present, the M-column product formats must use canonical extensions."
        : "The M-column product formats must be nonblank canonical extensions.",
      mFormats.analysis,
    ));
  }
  const contractFormats = outputFormatSet(outputs);
  if (!sameStringArray(contractFormats, mFormats.formats)) {
    errors.push(issue(
      "request_outputs_mismatch_m",
      "requestContract.outputs",
      `Request output formats (${contractFormats.join(", ")}) do not equal M formats (${mFormats.formats.join(", ")}).`,
    ));
  }
  const missingFormats = missingQuestionDeliverableFormats(effectiveQuestion, effectiveFormats);
  if (missingFormats.length) {
    errors.push(issue(
      "question_missing_m_format",
      "question",
      `The question does not name these M formats in human terms: ${missingFormats.join(", ")}.`,
    ));
  }

  const spanChecks = {};
  for (const field of ["blockageSpan", "motivationSpan", "downstreamUseSpan"]) {
    const span = String(roleTrace?.[field] ?? "");
    const count = span ? occurrences(effectiveQuestion, span) : 0;
    spanChecks[field] = { span, occurrences: count };
    if (field === "motivationSpan" && !span) continue;
    if (!span || count !== 1) {
      errors.push(issue(
        "role_trace_span_not_exact",
        `roleTrace.${field}`,
        `${field} must be a nonblank exact question span occurring once${field === "motivationSpan" ? " when supplied" : ""}.`,
      ));
    }
  }

  const selfIdentification = effectiveQuestion.match(SELF_IDENTIFICATION_PATTERN);
  if (selfIdentification) {
    errors.push(issue(
      "requester_self_identification",
      "question",
      `The requester explicitly introduces a role or affiliation: ${selfIdentification[0]}`,
      { marker: selfIdentification[0], index: selfIdentification.index ?? -1 },
    ));
  }

  const boundFactText = boundTextForUsedFacts(effectiveEnvelope, factLedger);
  const roleLeaks = exactHiddenLeaks(effectiveQuestion, sceneCard, boundFactText);
  for (const leak of roleLeaks) {
    errors.push(issue(
      "hidden_role_leak",
      "question",
      `Hidden scene-card content leaked into the question: ${leak.type}:${leak.value}`,
      leak,
    ));
  }

  const anchorAudit = auditAnchorsAgainstText(effectiveQuestion, boundFactText);
  for (const anchor of anchorAudit.errors) {
    errors.push(issue(
      "unbound_question_anchor",
      "question",
      `Question contains an anchor not bound through usedFactIds: ${anchor.type}:${anchor.value}`,
      anchor,
    ));
  }

  const usedSet = new Set(effectiveEnvelope.usedFactIds ?? []);
  const evidenceBindings = sceneCard?.evidenceBindings ?? [];
  const dramaticClaims = dramaticFindings(effectiveQuestion, "question");
  for (const finding of dramaticClaims) {
    if (evidenceSupportsDramaticCategory(evidenceBindings, finding.category, usedSet)) continue;
    errors.push(issue(
      "unbound_dramatic_question_claim",
      "question",
      `Question adds unsupported dramatic context: ${finding.marker}`,
      finding,
    ));
  }

  const base = {
    kind: "role-consistency-evaluation",
    gateId: SCENE_CARD_GATE_ID,
    protocolId: SCENE_CARD_PROTOCOL_ID,
    status: errors.length ? "FAIL" : "PASS",
    ok: errors.length === 0,
    recordUid: effectiveEnvelope.recordUid,
    sceneCardHash: isPlainObject(sceneCard) ? sceneCardHash(sceneCard) : "",
    cardHash: isPlainObject(effectiveEnvelope) ? stableHash(effectiveEnvelope) : "",
    errors,
    warnings,
    checks: {
      requestSpanOccurrences,
      requestFrame: requestAnalysis.frame,
      requestActionInSpan: Boolean(action && requestSpan.includes(action)),
      requestOutputFormats: contractFormats,
      mFormats: mFormats.formats,
      missingQuestionFormats: missingFormats,
      roleTrace: spanChecks,
      selfIdentification: selfIdentification?.[0] ?? "",
      roleLeaks,
      factAnchors: anchorAudit.candidateAnchors,
      unboundFactAnchors: anchorAudit.unsupported,
      dramaticClaims,
      envelopeValidationHash: envelopeValidation.validationHash,
    },
  };
  return { ...base, roleConsistencyHash: stableHash(base) };
}

export const createRoleConsistencyReport = auditRoleConsistency;

export function assertRoleConsistency(input) {
  const report = auditRoleConsistency(input);
  if (!report.ok) {
    const details = report.errors.map((entry) => `${entry.code}@${entry.path}`).join(", ");
    const error = new Error(`Role consistency check failed: ${details}`);
    error.report = report;
    throw error;
  }
  return report;
}

function validateSceneCardBundle(bundle) {
  const errors = [];
  if (!checkExactObject(bundle, "bundle", [
    "kind",
    "protocolId",
    "schemaVersion",
    "factLedgerPath",
    "factLedgerHash",
    "cards",
  ], errors)) return { ok: false, errors, cards: [] };
  if (bundle.kind !== SCENE_CARD_BUNDLE_KIND) {
    errors.push(issue("bundle_kind_mismatch", "bundle.kind", `bundle.kind must be ${SCENE_CARD_BUNDLE_KIND}.`));
  }
  if (bundle.protocolId !== SCENE_CARD_PROTOCOL_ID) {
    errors.push(issue("bundle_protocol_mismatch", "bundle.protocolId", `bundle.protocolId must be ${SCENE_CARD_PROTOCOL_ID}.`));
  }
  if (bundle.schemaVersion !== SCENE_CARD_BUNDLE_VERSION) {
    errors.push(issue("bundle_version_mismatch", "bundle.schemaVersion", `bundle.schemaVersion must be ${SCENE_CARD_BUNDLE_VERSION}.`));
  }
  checkString(bundle.factLedgerPath, "bundle.factLedgerPath", errors, { maxLength: 1000 });
  const ledgerHash = checkString(bundle.factLedgerHash, "bundle.factLedgerHash", errors, { maxLength: 64 });
  if (ledgerHash && !HASH_PATTERN.test(ledgerHash)) {
    errors.push(issue("invalid_fact_ledger_hash", "bundle.factLedgerHash", "factLedgerHash must be a lowercase SHA-256 hex digest."));
  }
  if (!Array.isArray(bundle.cards)) {
    errors.push(issue("invalid_array", "bundle.cards", "bundle.cards must be an array."));
  } else if (!bundle.cards.length) {
    errors.push(issue("invalid_array_length", "bundle.cards", "bundle.cards cannot be empty."));
  }
  const cards = Array.isArray(bundle.cards) ? bundle.cards : [];
  const uids = cards.map((card) => String(card?.recordUid ?? ""));
  for (const uid of new Set(uids.filter((value, index) => value && uids.indexOf(value) !== index))) {
    errors.push(issue("duplicate_card_uid", "bundle.cards", `Duplicate recordUid: ${uid}`));
  }
  return { ok: errors.length === 0, errors, cards };
}

function maskTermsForEnvelope(envelope) {
  const sceneCard = envelope?.sceneCard ?? {};
  return [...new Set([
    ...(sceneCard.maskTerms ?? []),
    sceneCard.requester?.functionalRole,
    sceneCard.requester?.organizationType,
    sceneCard.requester?.department,
    ...(envelope.requestContract?.outputs ?? []).map((output) => output.humanName),
    ...UNIVERSAL_MASK_TERMS,
  ].map((item) => String(item ?? "").trim()).filter((item) => [...item].length >= 2))]
    .sort((a, b) => [...b].length - [...a].length);
}

function maskedQuestion(question, envelope) {
  let text = String(question ?? "");
  for (const term of maskTermsForEnvelope(envelope)) {
    text = text.replace(new RegExp(escapedPattern(term), "giu"), "");
  }
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, "")
    .trim();
}

function ngrams(value, size = 3) {
  const characters = [...String(value ?? "")];
  const result = new Set();
  for (let index = 0; index <= characters.length - size; index += 1) {
    result.add(characters.slice(index, index + size).join(""));
  }
  return result;
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function longestCommonSubstring(left, right) {
  const a = [...String(left ?? "")];
  const b = [...String(right ?? "")];
  let previous = new Uint16Array(b.length + 1);
  let bestLength = 0;
  let bestEnd = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > bestLength) {
        bestLength = current[j];
        bestEnd = i;
      }
    }
    previous = current;
  }
  return { length: bestLength, value: a.slice(bestEnd - bestLength, bestEnd).join("") };
}

function evaluateMaskedBatch(rows, cardsByUid) {
  const comparisons = [];
  const errors = [];
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const left = rows[leftIndex];
      const right = rows[rightIndex];
      const leftEnvelope = cardsByUid.get(left.UID ?? left.uid);
      const rightEnvelope = cardsByUid.get(right.UID ?? right.uid);
      if (!leftEnvelope || !rightEnvelope) continue;
      // Use the union so a term declared by only one card cannot survive on the other side.
      const unionEnvelope = {
        sceneCard: {
          requester: {},
          maskTerms: [...new Set([
            ...maskTermsForEnvelope(leftEnvelope),
            ...maskTermsForEnvelope(rightEnvelope),
          ])],
        },
        requestContract: { outputs: [] },
      };
      const leftMasked = maskedQuestion(left.题目 ?? left.question, unionEnvelope);
      const rightMasked = maskedQuestion(right.题目 ?? right.question, unionEnvelope);
      const trigramSimilarity = Number(jaccard(ngrams(leftMasked), ngrams(rightMasked)).toFixed(4));
      const common = longestCommonSubstring(leftMasked, rightMasked);
      const highSimilarity = trigramSimilarity >= SCENE_CARD_BATCH_THRESHOLDS.highMaskedTrigramSimilarity;
      const sharedLongFragment = common.length >= SCENE_CARD_BATCH_THRESHOLDS.sharedMaskedFragmentLength;
      const comparison = {
        leftUid: left.UID ?? left.uid,
        rightUid: right.UID ?? right.uid,
        leftMaskedHash: sha256(leftMasked),
        rightMaskedHash: sha256(rightMasked),
        trigramSimilarity,
        longestSharedFragmentLength: common.length,
        longestSharedFragment: common.value,
        highSimilarity,
        sharedLongFragment,
      };
      comparisons.push(comparison);
      if (highSimilarity || sharedLongFragment) {
        errors.push(issue(
          "masked_author_voice_collision",
          "batch",
          `${comparison.leftUid} and ${comparison.rightUid} remain structurally similar after role/industry/output masking.`,
          comparison,
        ));
      }
    }
  }
  return {
    ok: errors.length === 0,
    status: errors.length ? "FAIL" : "PASS",
    thresholds: SCENE_CARD_BATCH_THRESHOLDS,
    comparisons,
    errors,
  };
}

export function evaluateSceneCardRows(rows, bundle, { factLedger = null } = {}) {
  const bundleValidation = validateSceneCardBundle(bundle);
  const effectiveRows = Array.isArray(rows) ? rows : [];
  const cards = bundleValidation.cards;
  const cardsByUid = new Map(cards.map((card) => [String(card?.recordUid ?? ""), card]));
  const rowUids = effectiveRows.map((row) => String(row?.UID ?? row?.uid ?? ""));
  const globalErrors = [...bundleValidation.errors];
  for (const uid of new Set(rowUids.filter((value, index) => value && rowUids.indexOf(value) !== index))) {
    globalErrors.push(issue("duplicate_candidate_uid", "candidate", `Duplicate candidate UID: ${uid}`));
  }
  const results = effectiveRows.map((row, index) => {
    const uid = String(row?.UID ?? row?.uid ?? "");
    const envelope = cardsByUid.get(uid);
    if (!uid) {
      const errors = [issue("missing_candidate_uid", `rows[${index}]`, "Candidate row has no UID.")];
      return { uid, status: "FAIL", ok: false, sceneCardHash: "", cardHash: "", errors, warnings: [], checks: {} };
    }
    if (!envelope) {
      const errors = [issue("missing_scene_card", `rows[${index}]`, `No scene card is bound to ${uid}.`)];
      return { uid, status: "FAIL", ok: false, sceneCardHash: "", cardHash: "", errors, warnings: [], checks: {} };
    }
    const audit = auditRoleConsistency({
      sceneCard: envelope.sceneCard,
      envelope,
      record: row,
      factLedger,
    });
    return {
      uid,
      status: audit.status,
      ok: audit.ok,
      sceneCardHash: audit.sceneCardHash,
      cardHash: audit.cardHash,
      roleConsistencyHash: audit.roleConsistencyHash,
      errors: audit.errors,
      warnings: audit.warnings,
      checks: audit.checks,
    };
  });
  const rowUidSet = new Set(rowUids);
  for (const card of cards) {
    if (!rowUidSet.has(String(card?.recordUid ?? ""))) {
      globalErrors.push(issue("orphan_scene_card", "bundle.cards", `Scene card has no candidate row: ${card?.recordUid ?? ""}`));
    }
  }
  const batch = evaluateMaskedBatch(effectiveRows, cardsByUid);
  const failedRows = results.filter((row) => !row.ok).length;
  const ok = globalErrors.length === 0 && failedRows === 0 && batch.ok;
  const summary = {
    candidateRowCount: effectiveRows.length,
    sceneCardCount: cards.length,
    passedRowCount: results.length - failedRows,
    failedRowCount: failedRows,
    globalErrorCount: globalErrors.length,
    batchCollisionCount: batch.errors.length,
  };
  const evaluation = {
    status: ok ? "PASS" : "FAIL",
    ok,
    summary,
    rows: results,
    batch,
    errors: globalErrors,
  };
  return { ...evaluation, evaluationHash: stableHash(evaluation) };
}

function resolveFactLedgerPath(sceneCardPath, declaredPath) {
  return path.resolve(path.isAbsolute(declaredPath) ? declaredPath : path.join(path.dirname(sceneCardPath), declaredPath));
}

async function readGateInputs({ candidatePath, sceneCardPath }) {
  if (!candidatePath || !sceneCardPath) {
    throw new Error("Scene-card gate requires candidatePath and sceneCardPath.");
  }
  const [candidateBuffer, sceneCardBuffer] = await Promise.all([
    fs.readFile(candidatePath),
    fs.readFile(sceneCardPath),
  ]);
  const bundle = JSON.parse(sceneCardBuffer.toString("utf8"));
  const bundleValidation = validateSceneCardBundle(bundle);
  const factLedgerPath = resolveFactLedgerPath(sceneCardPath, String(bundle?.factLedgerPath ?? ""));
  let factLedgerBuffer = Buffer.from("");
  let factLedger = null;
  const inputErrors = [...bundleValidation.errors];
  if (bundle?.factLedgerPath) {
    try {
      factLedgerBuffer = await fs.readFile(factLedgerPath);
      factLedger = JSON.parse(factLedgerBuffer.toString("utf8"));
      const actualHash = sha256(factLedgerBuffer);
      if (actualHash !== bundle.factLedgerHash) {
        inputErrors.push(issue(
          "fact_ledger_hash_mismatch",
          "bundle.factLedgerHash",
          `Declared factLedgerHash ${bundle.factLedgerHash} does not match ${actualHash}.`,
        ));
      }
    } catch (error) {
      inputErrors.push(issue(
        "fact_ledger_unreadable",
        "bundle.factLedgerPath",
        `Cannot read the bound fact ledger: ${error?.message || String(error)}`,
      ));
    }
  }
  return {
    candidateBuffer,
    sceneCardBuffer,
    bundle,
    factLedger,
    factLedgerBuffer,
    factLedgerPath,
    inputErrors,
  };
}

function reportFromInputs({ candidatePath, sceneCardPath, inputs }) {
  const rows = parseTsvRows(inputs.candidateBuffer.toString("utf8"));
  const evaluation = evaluateSceneCardRows(rows, inputs.bundle, { factLedger: inputs.factLedger });
  if (inputs.inputErrors.length) {
    evaluation.errors.push(...inputs.inputErrors);
    evaluation.ok = false;
    evaluation.status = "FAIL";
    evaluation.summary.globalErrorCount = evaluation.errors.length;
    evaluation.evaluationHash = stableHash({
      status: evaluation.status,
      ok: evaluation.ok,
      summary: evaluation.summary,
      rows: evaluation.rows,
      batch: evaluation.batch,
      errors: evaluation.errors,
    });
  }
  const cards = Array.isArray(inputs.bundle?.cards) ? inputs.bundle.cards : [];
  const sceneCardSetHash = stableHash(cards
    .map((card) => ({ recordUid: card?.recordUid ?? "", cardHash: isPlainObject(card) ? stableHash(card) : "" }))
    .sort((left, right) => left.recordUid.localeCompare(right.recordUid, "zh-CN")));
  return {
    kind: SCENE_CARD_REPORT_KIND,
    gateId: SCENE_CARD_GATE_ID,
    protocolId: SCENE_CARD_PROTOCOL_ID,
    schemaVersion: 1,
    status: evaluation.status,
    ok: evaluation.ok,
    candidatePath: path.resolve(candidatePath),
    candidateHash: sha256(inputs.candidateBuffer),
    sceneCardPath: path.resolve(sceneCardPath),
    sceneCardFileHash: sha256(inputs.sceneCardBuffer),
    sceneCardBundleHash: isPlainObject(inputs.bundle) ? stableHash(inputs.bundle) : "",
    sceneCardSetHash,
    factLedgerPath: inputs.factLedgerPath,
    factLedgerHash: inputs.factLedgerBuffer.length ? sha256(inputs.factLedgerBuffer) : "",
    summary: evaluation.summary,
    rows: evaluation.rows,
    batch: evaluation.batch,
    errors: evaluation.errors,
    evaluationHash: evaluation.evaluationHash,
  };
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

export async function runSceneCardGate({ candidatePath, sceneCardPath, reportPath } = {}) {
  if (!reportPath) throw new Error("runSceneCardGate requires reportPath.");
  const inputs = await readGateInputs({ candidatePath, sceneCardPath });
  const report = reportFromInputs({ candidatePath, sceneCardPath, inputs });
  await writeJsonAtomic(reportPath, report);
  return report;
}

export async function verifySceneCardGateReport({ candidatePath, sceneCardPath, reportPath } = {}) {
  try {
    if (!reportPath) throw new Error("verifySceneCardGateReport requires reportPath.");
    const [reportBuffer, inputs] = await Promise.all([
      fs.readFile(reportPath),
      readGateInputs({ candidatePath, sceneCardPath }),
    ]);
    const report = JSON.parse(reportBuffer.toString("utf8"));
    if (report.kind !== SCENE_CARD_REPORT_KIND || report.gateId !== SCENE_CARD_GATE_ID) {
      throw new Error("Scene-card report kind or gateId is invalid.");
    }
    if (report.protocolId !== SCENE_CARD_PROTOCOL_ID || report.schemaVersion !== 1) {
      throw new Error("Scene-card report protocol or schema version is stale.");
    }
    const expected = reportFromInputs({ candidatePath, sceneCardPath, inputs });
    if (stableHash(report) !== stableHash(expected)) {
      throw new Error("Scene-card report does not match the current candidate, scene-card bundle, or fact ledger.");
    }
    return {
      ok: true,
      errors: [],
      report,
      reportHash: sha256(reportBuffer),
      rows: expected.rows,
      batch: expected.batch,
    };
  } catch (error) {
    return { ok: false, errors: [error?.message || String(error)] };
  }
}

export const verifySceneCardReport = verifySceneCardGateReport;
