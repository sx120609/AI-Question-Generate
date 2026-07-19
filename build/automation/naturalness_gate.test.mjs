import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  calibrateNaturalnessBaseline,
  evaluateNaturalnessRows,
  measureNaturalnessRow,
  resolveNaturalnessBaseline,
  runNaturalnessGate,
  validateNaturalnessBaseline,
  verifyNaturalnessReviewRequest,
  verifyNaturalnessReviewSignoff,
} from "./naturalness_gate.mjs";

function referenceRows(count = 20) {
  const endings = [
    "门店先处理差异记录，负责人再按批次排好顺序，财务随后核销差额，处理日期留在原始流水里。",
    "仓库先隔离争议箱号，采购拿到检测结果后判断是否退货，供应商同步接收结论，旧签收记录继续保留。",
    "客服把三类来电分流给对应坐席，产品经理据此调整下个版本，门店同步新的答复口径，历史工单仍可回查。",
    "运营逐个频道改投放口径，设计保留原图供周复盘使用，渠道负责人记录改稿原因，旧素材不覆盖删除。",
    "工程师按设备编号安排停机窗口，班组长负责现场交接，维修记录跟随设备编号保存，复机时间另行登记。",
  ];
  const requestPhrases = [
    "你帮我把原始流水、箱号、责任人和处理结果整理成一份Word说明，再做一张Excel工作簿，店长和财务看完就能直接分工。",
    "你给我做一份Word核对说明，把签收差异、责任归属和处理条件写清楚，另外做一张Excel工作簿，逐箱保留证据和状态。",
    "需要你把门店反馈、客服分流、版本影响和后续动作梳理成一份Word说明，再做一张Excel工作簿，方便产品经理逐项跟进。",
    "我想要一份Word投放判断说明，把频道差异、素材问题和调整理由连起来，再配一张Excel工作簿，供运营和设计一起复盘。",
    "麻烦你把设备编号、停机窗口、现场交接和责任人整理成一份Word说明，再做一张Excel工作簿，班组长可以沿同一条记录推进。",
  ];
  return Array.from({ length: count }, (_, index) => {
    const day = (index % 20) + 1;
    const quantity = 3 + index;
    const variant = index % 5;
    const paragraphs = [
      `2026年6月${day}日，华东${quantity}家门店回传了A${120 + index}批次的盘点结果，其中${quantity + 8}条记录标成“待核”。`,
      variant % 2 === 0
        ? `店长已经指出冷柜、收银台和退货区三处差异，编号V2.${index}.1的记录保留了操作人和具体时刻。`
        : `仓库扫描记录显示${quantity}箱在14:30后入库，采购单号PO-${8800 + index}对应两次签收。`,
      variant === 1
        ? "财务关心账面差额，门店更在意当天能否恢复销售，两边要先统一批次口径。"
        : variant === 2
          ? "现场照片能定位货架和箱号，扫描记录则用来还原交接先后，两类线索分开核对。"
          : variant === 3
            ? "这次先处理会影响结账的记录，普通备注留给门店在下一轮盘点时补充。"
            : "团队按原始流水逐条还原动作，再把同一箱号的两次扫描并到一条时间线。",
      requestPhrases[variant],
      endings[variant],
    ];
    if (variant === 4) paragraphs.splice(2, 0, `当天17:20前先解决${quantity}条金额差异，其余记录留到次日上午。`);
    const stepCount = 5 + (index % 6);
    const steps = Array.from({ length: stepCount }, (_, step) => `${step + 1}. ${step === stepCount - 1 ? "按责任人和批次启动后续处理。" : `处理第${step + 1}组门店流水和箱号。`}`).join("\\n");
    return { UID: `真人_${index + 1}`, 题目: paragraphs.join("\n\n"), 产物格式: "docx, xlsx", 做题关键步骤: steps };
  });
}

function templateRows(count = 8) {
  return Array.from({ length: count }, (_, index) => ({
    UID: `模板_${index + 1}`,
    题目: [
      `我们负责第${index + 1}组门店的改版，明天下午开会确认3家试点能否开放，系统编号A${210 + index}已有12条工单。`,
      "附件记录了当前流程和各方说法，会上需要说明哪些信息能够采用。",
      "团队要判断哪些功能保留、哪些功能暂缓，并给各责任人安排后续动作。",
      "你帮我把这些内容做成一份Word说明用于统一口径，另做一张Excel工作簿记录问题、负责人和状态。",
    ].join("\n\n"),
    产物格式: "docx, xlsx",
    做题关键步骤: Array.from({ length: 10 }, (_, step) => `${step + 1}. ${step === 9 ? "做一次完整自检，确认Word和Excel逐项一致。" : `整理第${step + 1}类业务信息。`}`).join("\\n"),
  }));
}

function heavyDisclaimerRow() {
  return {
    UID: "免责声明过载",
    题目: [
      "团队正在讨论一个业务安排。现有材料尚未提供完整原稿。合同记录也还没交来。",
      "这些内容不能用于判断真实结果。公开说明不得替代项目证明。现有描述无法推定实际配置。",
      "等资料补齐后再确认结论。当前只能针对题面内容，不能外推其他事实。",
      "麻烦你把当前判断和各方后续动作整理成一份Word说明，再做一张Excel工作簿。",
    ].join("\n\n"),
    产物格式: "docx, xlsx",
    做题关键步骤: "1. 整理现状。\\n2. 分配动作。\\n3. 推进后续工作。",
  };
}

function vagueRow() {
  return {
    UID: "事实不足",
    题目: "团队最近遇到一些业务问题，大家的看法并不完全一致，需要梳理事情的来龙去脉，分清主要矛盾和次要矛盾。麻烦你把现状整理成一份Word说明，再做一张Excel工作簿，后续由相关人员结合实际情况推进。",
    产物格式: "docx, xlsx",
    做题关键步骤: "1. 梳理背景。\\n2. 分析分歧。\\n3. 安排后续动作。",
  };
}

function toTsv(rows) {
  const headers = ["UID", "题目", "做题关键步骤"];
  const cell = (value) => String(value ?? "").replace(/\t/g, " ").replace(/\r?\n/g, "\\n");
  return `${headers.join("\t")}\n${rows.map((row) => headers.map((name) => cell(row[name])).join("\t")).join("\n")}\n`;
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "naturalness-gate-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("calibrates every effective threshold from benchmark quantiles or explicit batch caps", () => {
  const baseline = calibrateNaturalnessBaseline(referenceRows(), {
    baselineId: "approved-human-sample",
    generatedAt: "2026-07-10T00:00:00.000Z",
  });
  assert.equal(validateNaturalnessBaseline(baseline), baseline);
  assert.equal(baseline.sampleCount, 20);
  assert.equal(baseline.thresholds.row.disclaimerSentenceDensity.source.type, "benchmark-quantile");
  assert.equal(baseline.thresholds.batch.finalStepSelfCheckShare.source.type, "benchmark-rate-upper-bound");
  assert.equal(baseline.thresholds.batch.reviewLevelTemplateSignalsForFail.source.type, "batch-policy-cap");
  assert.ok(Number.isFinite(baseline.thresholds.row.concreteFactsPer100Chars.review));
});

test("accepts a varied batch with direct requests and natural punctuation", () => {
  const rows = referenceRows();
  const baseline = calibrateNaturalnessBaseline(rows, { baselineId: "approved-human-sample" });
  baseline.thresholds.row.concreteFactsPer100Chars.review = 0;
  const result = evaluateNaturalnessRows(rows, baseline);
  assert.equal(result.status, "PASS", JSON.stringify({ summary: result.summary, batch: result.batch }, null, 2));
  assert.equal(result.batch.metrics.explicitRequestShare, 1);
  assert.ok(result.batch.metrics.requestFrameDominantShare <= 0.3);
  assert.ok(result.batch.metrics.commaToPeriodRatio >= 1.8);
});

test("accepts a five-row human-review reference batch with polite requests and scenario self-checks", () => {
  const baselineRows = referenceRows();
  const baseline = calibrateNaturalnessBaseline(baselineRows, { baselineId: "approved-human-sample" });
  baseline.thresholds.row.concreteFactsPer100Chars.review = 0;
  const rows = referenceRows(5).map((row, index) => ({
    ...row,
    题目: row.题目
      .split("\n\n")
      .map((paragraph) => /Word.*Excel/iu.test(paragraph)
        ? "请基于前面的记录生成一份Word说明和一张Excel工作簿，相关负责人可以沿同一份材料推进。"
        : paragraph)
      .join("\n\n"),
    做题关键步骤: `${row.做题关键步骤}\n${10 + index}. 用一条真实边界场景回查两份产物并核对来源。`,
  }));
  const result = evaluateNaturalnessRows(rows, baseline);
  assert.equal(result.status, "PASS", JSON.stringify({ summary: result.summary, batch: result.batch }, null, 2));
  assert.equal(result.batch.metrics.requestFrameDominant, "polite-request");
  assert.equal(result.batch.findings.length, 0);
});

test("accepts the project's positive-corpus benchmark JSON directly", () => {
  const positives = referenceRows(10).map((row, index) => ({
    source: { uid: row.UID, sheetRow: index + 2 },
    fields: { B_question: row.题目, O_keySteps: row.做题关键步骤 },
  }));
  const resolved = resolveNaturalnessBaseline({
    benchmarkId: "project-benchmark",
    generatedAt: "2026-07-10T00:00:00.000Z",
    positives,
  });
  assert.equal(resolved.kind, "naturalness-benchmark-baseline");
  assert.equal(resolved.baselineId, "project-benchmark");
  assert.equal(resolved.sampleCount, 10);
});

test("uses density and sentence count together instead of failing on a forbidden word", () => {
  const baseline = calibrateNaturalnessBaseline(referenceRows(), { baselineId: "approved-human-sample" });
  const oneMention = {
    ...referenceRows(1)[0],
    UID: "单次边界",
    题目: `${referenceRows(1)[0].题目}\n\n其中一项材料尚未提供，负责人随后补交。`,
  };
  const oneResult = evaluateNaturalnessRows([oneMention], baseline);
  assert.equal(oneResult.rows[0].findings.some((item) => item.rule === "disclaimer_missing_material_density" && item.severity === "FAIL"), false);

  const overloaded = evaluateNaturalnessRows([heavyDisclaimerRow()], baseline);
  assert.equal(overloaded.status, "FAIL");
  const finding = overloaded.rows[0].findings.find((item) => item.rule === "disclaimer_missing_material_density");
  assert.equal(finding.severity, "FAIL");
  assert.ok(finding.evidence.taggedSentenceCount >= 5);
  assert.match(finding.threshold.combination, /Both density and sentence count/);
});

test("diagnoses first person without requiring it and reviews low concrete-fact density", () => {
  const baseline = calibrateNaturalnessBaseline(referenceRows(), { baselineId: "approved-human-sample" });
  const withoutFirstPerson = measureNaturalnessRow(vagueRow());
  const withFirstPerson = measureNaturalnessRow({ ...vagueRow(), 题目: `我在负责这件事。${vagueRow().题目}` });
  assert.equal(withoutFirstPerson.firstPersonPresent, false);
  assert.equal(withFirstPerson.firstPersonPresent, true);

  const result = evaluateNaturalnessRows([vagueRow()], baseline);
  assert.equal(result.status, "REVIEW");
  assert.ok(result.rows[0].findings.some((item) => item.rule === "low_concrete_fact_density"));
  assert.equal(result.rows[0].findings.some((item) => item.rule.includes("first_person")), false);
});

test("counts explicitly named products as concrete scene anchors", () => {
  const measured = measureNaturalnessRow({
    UID: "产品对象",
    题目: "团队需要比较 Zoom、Microsoft Teams 和 Google Meet 的无障碍支持。请整理一份 Excel 对比表，供下一轮实测使用。",
    产物格式: "xlsx",
    做题关键步骤: "1. 核验来源。\n2. 比较产品。\n3. 安排实测。",
  });
  assert.deepEqual(
    measured.evidence.concreteFactAnchors.filter((item) => item.kind === "named-product").map((item) => item.value),
    ["Zoom", "Microsoft Teams", "Google Meet"],
  );
});

test("hard-fails a detached Word and Excel specification with no user request", () => {
  const baseline = calibrateNaturalnessBaseline(referenceRows(), { baselineId: "approved-human-sample" });
  const row = referenceRows(1)[0];
  const start = row.题目.indexOf("你帮我");
  const end = row.题目.indexOf("。", start) + 1;
  const detached = {
    ...row,
    题目: `${row.题目.slice(0, start)}Word需要写明核对结论，Excel工作簿按箱号记录证据和状态。${row.题目.slice(end)}`,
  };
  const result = evaluateNaturalnessRows([detached], baseline);
  assert.equal(result.status, "FAIL");
  assert.ok(result.rows[0].findings.some((item) => item.rule === "missing_direct_user_request"));
});

test("blocks a batch that repeatedly opens with a short standalone sentence", () => {
  const baseline = calibrateNaturalnessBaseline(referenceRows(), { baselineId: "approved-human-sample" });
  const rows = referenceRows(10).map((row, index) => ({
    ...row,
    题目: `今天先核第${index + 1}组材料。${row.题目}`,
  }));
  const result = evaluateNaturalnessRows(rows, baseline);
  assert.equal(result.status, "FAIL");
  assert.ok(result.batch.findings.some((item) => item.rule === "short_opening_concentration"));
  assert.ok(result.batch.findings.some((item) => item.rule === "opening_hard_stop_concentration"));
});

test("does not count semicolons as complete sentences", () => {
  const measured = measureNaturalnessRow({
    UID: "分号不是句号",
    题目: "门店有三类差异；仓库还有两项记录没对齐。麻烦你整理成一份Word说明和一张Excel工作簿。",
    产物格式: "docx, xlsx",
    做题关键步骤: "1. 核对。\\n2. 整理。",
  });
  assert.equal(measured.sentenceCount, 2);
  assert.equal(measured.semicolonCount, 1);
});

test("uses sentence groups for single-paragraph questions without losing factual anchors", () => {
  const source = referenceRows(1)[0];
  const flattened = {
    ...source,
    题目: source.题目.replace(/\n+/gu, " "),
  };
  const measured = measureNaturalnessRow(flattened);
  assert.equal(measured.paragraphCount, 1);
  assert.ok(measured.paragraphActions.length > 1);
  assert.ok(measured.concreteFactAnchorCount > 0);
  assert.ok(measured.compressedDiscourseSkeleton.includes(">"));
});

test("does not treat an early situated request as a fixed Word-Excel tail", () => {
  const measured = measureNaturalnessRow({
    UID: "请求在前",
    题目: "你帮我做一份Word验收说明和一张Excel核对表，我拿给主任判断当前能签到哪一步。设备已经到货，箱数照片和安装日期在手里，合同正文、技术附件和装箱单还没有归档。开箱时先记录包装、外观、序列号和随机资料，配置等合同基线回来再核。安装完成后才进入性能测试，技术验收和尾款分别对应实际证据。",
    产物格式: "docx, xlsx",
    做题关键步骤: "1. 核对到货材料。\n2. 记录阶段状态。",
  });
  assert.equal(measured.paragraphCount, 1);
  assert.equal(measured.fixedWordExcelTail, false);
  assert.ok(measured.paragraphActions.length >= 4);
});

test("fails a batch on repeated discourse evidence rather than step-count or self-check quotas", () => {
  const baseline = calibrateNaturalnessBaseline(referenceRows(), { baselineId: "approved-human-sample" });
  const result = evaluateNaturalnessRows(templateRows(), baseline);
  assert.equal(result.status, "FAIL");
  assert.equal(result.batch.status, "FAIL");
  assert.equal(result.batch.metrics.fixedWordExcelTailShare, 1);
  assert.equal(result.batch.metrics.finalStepSelfCheckShare, 1);
  assert.equal(result.batch.metrics.stepCountModeShare, 1);
  assert.equal(result.batch.metrics.weakScheduleDominantTag, "relative-meeting");
  assert.ok(result.batch.findings.some((item) => item.rule === "paragraph_discourse_skeleton_concentration"));
  assert.ok(result.batch.findings.some((item) => item.rule === "fixed_word_excel_tail_concentration"));
  assert.equal(result.batch.findings.some((item) => item.rule === "final_step_self_check_concentration"), false);
  assert.equal(result.batch.findings.some((item) => item.rule === "step_count_mode_concentration"), false);
  assert.ok(result.batch.findings.some((item) => item.rule === "request_frame_concentration"));
  assert.ok(result.batch.findings.some((item) => item.rule === "time_meeting_authenticity_tag_concentration"));
  assert.ok(result.batch.findings.some((item) => item.rule === "batch_template_concentration"));
});

test("writes a hash-bound pending review request and never signs it automatically", async () => {
  await withTempDir(async (dir) => {
    const baseline = calibrateNaturalnessBaseline(referenceRows(), {
      baselineId: "approved-human-sample",
      generatedAt: "2026-07-10T00:00:00.000Z",
    });
    const candidatePath = path.join(dir, "candidate.tsv");
    const baselinePath = path.join(dir, "baseline.json");
    const reportPath = path.join(dir, "report.json");
    const reviewRequestPath = path.join(dir, "review-request.json");
    await fs.writeFile(candidatePath, toTsv([vagueRow()]), "utf8");
    await fs.writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const result = await runNaturalnessGate({ candidatePath, baselinePath, reportPath, reviewRequestPath });
    assert.equal(result.report.status, "REVIEW");
    assert.equal(result.reviewRequest.status, "PENDING_REVIEW");
    assert.equal(result.reviewRequest.signoff, null);
    assert.equal((await verifyNaturalnessReviewRequest(result.reviewRequest)).ok, true);
    assert.equal(result.report.effectiveThresholds.row.concreteFactsPer100Chars.source.type, "benchmark-quantile");

    const requestHash = crypto.createHash("sha256").update(await fs.readFile(reviewRequestPath)).digest("hex");
    const validSignoff = {
      kind: "naturalness-review-signoff",
      requestId: result.reviewRequest.requestId,
      bindingHash: result.reviewRequest.bindingHash,
      requestHash,
      decision: "APPROVE",
      reviewer: "human-reviewer",
      rationale: "Reviewed against the cited human examples and accepted this one-off variation.",
      reviewedAt: "2026-07-10T01:00:00.000Z",
    };
    assert.equal(verifyNaturalnessReviewSignoff(result.reviewRequest, validSignoff, { requestHash }).approved, true);
    assert.equal(verifyNaturalnessReviewSignoff(result.reviewRequest, { ...validSignoff, bindingHash: "tampered" }, { requestHash }).ok, false);
    assert.equal(verifyNaturalnessReviewSignoff(result.reviewRequest, { ...validSignoff, requestHash: "0".repeat(64) }, { requestHash }).ok, false);
    assert.equal(verifyNaturalnessReviewSignoff(result.reviewRequest, { ...validSignoff, reviewer: result.reviewRequest.requestedBy }, { requestHash }).ok, false);

    await fs.writeFile(candidatePath, `${await fs.readFile(candidatePath, "utf8")} `, "utf8");
    const verification = await verifyNaturalnessReviewRequest(result.reviewRequest);
    assert.equal(verification.ok, false);
    assert.match(verification.errors.join(" "), /Candidate hash mismatch/);
  });
});

test("removes a stale review request when a later run is FAIL", async () => {
  await withTempDir(async (dir) => {
    const baseline = calibrateNaturalnessBaseline(referenceRows(), { baselineId: "approved-human-sample" });
    const candidatePath = path.join(dir, "candidate.tsv");
    const baselinePath = path.join(dir, "baseline.json");
    const reportPath = path.join(dir, "report.json");
    const reviewRequestPath = path.join(dir, "review-request.json");
    await fs.writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    await fs.writeFile(candidatePath, toTsv([vagueRow()]), "utf8");
    await runNaturalnessGate({ candidatePath, baselinePath, reportPath, reviewRequestPath });
    await fs.access(reviewRequestPath);

    await fs.writeFile(candidatePath, toTsv([heavyDisclaimerRow()]), "utf8");
    const failed = await runNaturalnessGate({ candidatePath, baselinePath, reportPath, reviewRequestPath });
    assert.equal(failed.report.status, "FAIL");
    await assert.rejects(fs.access(reviewRequestPath), /ENOENT/);
  });
});
