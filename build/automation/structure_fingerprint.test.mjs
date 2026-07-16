import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateProfiles,
  buildReceipt,
  compareFingerprints,
  coreSceneText,
  evaluateDiversity,
  fingerprintRow,
  hashPlanRows,
  loadStructuralDiversityPolicy,
  verifyReceiptRows,
  visibleCharacterCount,
} from "./structure_fingerprint.mjs";

const policy = await loadStructuralDiversityPolicy();

function row({ uid = "沈礼_test_01", question, product, steps }) {
  return {
    UID: uid,
    题目: question,
    任务类型: "L2 流程型",
    一级目录: "投资战略、专业服务与企业经营",
    二级目录: "经营分析",
    三级目录: "专项决策复核",
    任务概括: "围绕具体业务证据形成可追溯决策。",
    相关附件: "附件一_业务数据.xlsx；附件二_规则文件.pdf",
    标注专家工作年限: "6年",
    人类完成时间: "14h",
    附件格式: "xlsx, pdf",
    附件内容: "附件一提供业务事实，附件二提供规则边界。来源：https://example.com/a 来源：https://example.com/b",
    产物格式: "docx, xlsx",
    产物内容: product,
    做题关键步骤: steps,
    标注专家姓名: "沈礼",
  };
}

const baseQuestion =
  "明天下午的经营评审会要决定华东仓这批恒温试剂是整批接收、折价接收还是退回供应商。仓库今天到货120箱，抽检记录显示其中18箱最高温度达到11.6℃，运输合同约定2—8℃，承运商却认为卸货等待造成了短时升温；采购、质量和仓储目前各拿着一版时间记录，三个时间戳相差最多47分钟。附件里有温控仪原始导出、签收单、运输合同、承运商说明和供应商稳定性资料，但缺少月台监控、温控仪校准证书以及异常箱逐箱照片。会上需要判断现有证据能否支持拒收，若证据不够，应明确哪些箱先隔离、哪些测试先补、谁负责向承运商追证，以及在什么条件下可以改为折价接收。质量负责人会用结果签字，采购还要据此决定是否暂停付款，所以结论要区分合同事实、检测事实和仍待确认的推断。承运商要求今晚确认是否安排返程车辆，仓储最多还能提供48小时隔离库位；如果逾期没有答复，供应商会按已经签收继续结算。稳定性资料只覆盖连续超温不超过30分钟的情形，温控仪设备时间也尚未与仓库服务器时间校准，因此18箱是否仍合格不能从最高温度一个数字直接推出。评审时还要把补证顺序、临时保管责任、付款冻结范围和结论失效条件说清楚，确保采购、质量和仓储拿到的是同一套执行口径。隔离期间若出现新的温度波动，仓储要保留设备原始导出，不能只在群里报一个最高值；供应商补交的材料也要标明对应箱号和形成时间。评审秘书还要登记每份材料的版本号、形成时间和提供人，后续补件不得覆盖旧证据，任何处置变化都要说明触发条件。请把对各方主张的判断写成可编辑Word决策备忘录，另做一张Excel证据台账，把箱号、温度区间、时间线、证据来源、责任人、处理路径和解锁条件逐项关联；关键结论要能回到原始记录，不能把缺失的监控或校准证书写成已经存在。";

const baseProduct =
  "Word采用决策备忘录，按争议、证据、结论与授权边界组织；Excel采用证据台账，让每项主张对应来源、箱号、责任人和处理条件。";

const baseSteps =
  "1. 核验温控导出、合同、签收单和说明文件的来源与时间。\n2. 盘点120箱货物并拆出18箱异常范围。\n3. 提取各文件中的时间戳、温度和责任主张。\n4. 统一时间、单位与箱号口径。\n5. 对比三条时间线并标出47分钟差异。\n6. 判断温度偏离与合同条款的关系。\n7. 将箱件分成接收、隔离、补测和退回路径。\n8. 整理监控、校准证书和照片缺口。\n9. 给出付款与放行建议。\n10. 写Word决策备忘录。\n11. 做Excel证据台账。\n12. 复查结论、来源和缺口是否一致。";

const unrelatedQuestion =
  "品牌团队下周三要决定一组线下快闪活动是按原计划进商场、缩成两座城市，还是把场地档期让给秋季新品。三家商场目前给出的进场时间、搭建时段和消防报审要求不同，广州场要求提前七天锁定施工人员，南京场只允许闭店后六小时施工，成都场则把临时用电图纸列为签约前条件。市场同事已经整理了客流估算、两版预算、供应商报价和去年活动复盘，财务发现差旅与夜间施工费没有进入第一版预算，采购也尚未拿到三地统一的撤场赔偿条款。负责人需要看清每个城市继续推进的真实成本、最晚确认时间和退出损失，不能因为总预算还在上限内就忽略单场条件。现有资料能够支持内部比较，但无法替代商场盖章的进场确认、当地消防材料和供应商最终合同；这些缺口要落到对应提供人和截止日。若某地在最晚确认日前仍拿不到用电图或施工名单，该场进入暂缓路径，释放的预算再评估是否转给其余城市。活动经理还要用结果安排设计稿、物料运输和人员行程，因此城市选择一旦变化，需要同步标出受影响的制作批次、取消费用和重新下单时间。集团批复的现金支出上限是85万元，任一方案超过这个数字都要重新走预算审批；设计供应商又要求确认后才保留制作档期，晚于周五取消会产生已经发生的打样费用。三地可以分别退出，但不能在没有书面确认时把预计客流当成商场承诺。版本管理员还要保留商场条件、报价和预算的旧版本，后续任何城市选择变化都要能够回查触发它的材料，并记录确认人。Word整理成内部判断说明，写清三地差异、建议选择和改变建议的条件；Excel记录每座城市的场地要求、预算版本、报价、缺少材料、责任人、最晚确认日和当前处理路径。两份文件只服务于本轮排期，商场或供应商后续更新条件时保留旧版本并重新核对。";

const unrelatedProduct =
  "Word整理三地活动的内部判断说明，说明差异、建议与变化条件；Excel做城市条件跟踪表，记录预算版本、报价、材料状态、责任人和排期结果。";

const unrelatedSteps =
  "1. 汇总三家商场的进场条件和最晚确认日。\n2. 提取两版预算与三份供应商报价。\n3. 补入差旅、夜间施工和撤场费用。\n4. 比较三地客流、成本和档期影响。\n5. 标出消防、用电图和施工名单的材料状态。\n6. 登记每项缺口的提供人与截止日。\n7. 判断原计划、缩减城市或延期三种安排。\n8. 计算方案变化对物料和人员行程的影响。\n9. 给出本轮城市选择和暂缓路径。\n10. 整理Word内部判断说明。\n11. 建立Excel城市排期记录。\n12. 检查预算版本、日期和责任人是否一致。";

test("hard-fails a short L2 question", () => {
  const evaluation = evaluateDiversity([
    row({ question: "明天开会，帮我核对附件并做Word和Excel。", product: baseProduct, steps: baseSteps }),
  ], { policy });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.findings.some((item) => item.rule === "question-too-short"));
});

test("uses the calibrated non-rotating length policy", () => {
  assert.deepEqual(policy.questionLength, {
    hardMinimumVisibleCharacters: 700,
    minimumCoreSceneCharacters: 300,
    recommendedMinimumVisibleCharacters: 800,
    recommendedMaximumVisibleCharacters: 1400,
    warningMaximumVisibleCharacters: 1450,
    hardMaximumVisibleCharacters: 1500,
    planningBands: [],
  });
});

test("warns above 1450 characters and hard-fails above 1500", () => {
  const filler = "补充记录说明了对应负责人、形成日期和旧版本位置，后续变化仍回到原始材料核对。";
  const warningQuestion = `${baseQuestion}${filler.repeat(20)}`;
  assert.ok(visibleCharacterCount(warningQuestion) > 1450);
  assert.ok(visibleCharacterCount(warningQuestion) <= 1500);
  const warningEvaluation = evaluateDiversity([
    row({ question: warningQuestion, product: baseProduct, steps: baseSteps }),
  ], { policy });
  assert.equal(warningEvaluation.ok, true);
  assert.ok(warningEvaluation.findings.some((item) => item.rule === "question-long-warning" && item.level === "WARN"));

  const tooLongQuestion = `${warningQuestion}${filler.repeat(12)}`;
  assert.ok(visibleCharacterCount(tooLongQuestion) > 1500);
  const tooLongEvaluation = evaluateDiversity([
    row({ question: tooLongQuestion, product: baseProduct, steps: baseSteps }),
  ], { policy });
  assert.equal(tooLongEvaluation.ok, false);
  assert.ok(tooLongEvaluation.findings.some((item) => item.rule === "question-too-long"));
});

test("hard-fails padded text with insufficient information coverage", () => {
  const padded = "请全面深入分析并形成专业意见。".repeat(45);
  const evaluation = evaluateDiversity([
    row({ question: padded, product: baseProduct, steps: baseSteps }),
  ], { policy });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.findings.some((item) => item.rule === "information-coverage-insufficient"));
});

test("normalizes synonymous step verbs into the same action sequence", () => {
  const first = fingerprintRow(row({ question: baseQuestion, product: baseProduct, steps: baseSteps }), policy);
  const secondSteps = baseSteps
    .replace("核验", "验证")
    .replace("盘点", "梳理")
    .replace("复查", "交叉检查");
  const second = fingerprintRow(row({ uid: "裴硬_test_02", question: baseQuestion, product: baseProduct, steps: secondSteps }), policy);
  assert.deepEqual(first.compressedStepActions, second.compressedStepActions);
});

test("does not let semicolons manufacture extra sentence-rhythm units", () => {
  const fingerprint = fingerprintRow(row({
    question: "仓库记录有两处差异；采购还在等供应商回函。你帮我整理成一份Word说明和一张Excel工作簿。",
    product: baseProduct,
    steps: baseSteps,
  }), policy);
  assert.equal(fingerprint.sentenceRhythm.sentenceCount, 2);
});

test("keeps scene facts that appear after an early situated deliverable request", () => {
  const situated =
    "你帮我做一份Word验收说明和一张Excel核对表，我要拿给主任判断当前能签到哪一步。设备已经到货，箱数照片和安装日期在手里，但合同正文、技术附件、装箱单、序列号清单和质量证明书都还没有归档。开箱时可以记录包装、外观、箱数和随机资料，配置是否符合采购要求要等合同基线回来再核，安装完成以后才能进入性能测试，技术验收和尾款也要分别对应实际证据。安装前还要核场地、电源、温湿度和人员条件，测试阶段则保留原始记录、实测值、签字主体和异常处理结果，每一阶段能签的范围都不同。厂商公开安装条件只能作为现场准备参考，不能替代本项目合同或测试结果。";
  const core = coreSceneText(situated);
  assert.ok(core.includes("设备已经到货"));
  assert.ok(core.includes("技术验收和尾款"));
  assert.equal(/Word|Excel/iu.test(core), false);
  assert.ok(visibleCharacterCount(core) >= 240);
});

test("rejects a batch that only swaps the industry nouns", () => {
  const swappedQuestion = baseQuestion
    .replaceAll("恒温试剂", "冷冻海鲜")
    .replaceAll("箱", "托")
    .replaceAll("质量负责人", "生鲜负责人")
    .replaceAll("供应商", "供货商");
  const swappedSteps = baseSteps.replaceAll("箱", "托").replaceAll("温控", "冷链");
  const evaluation = evaluateDiversity([
    row({ question: baseQuestion, product: baseProduct, steps: baseSteps }),
    row({ uid: "裴硬_test_02", question: swappedQuestion, product: baseProduct, steps: swappedSteps }),
  ], { policy });
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.status, "FAIL");
  assert.ok(evaluation.findings.some((item) => item.rule === "batch-lexical-duplicate" && item.level === "FAIL"));
  assert.ok(evaluation.findings.some((item) => item.rule === "batch-step-action-isomorphism" && item.level === "FAIL"));
});

test("same structure classification is review-only when the business text differs", () => {
  const evaluation = evaluateDiversity([
    row({ question: baseQuestion, product: baseProduct, steps: baseSteps }),
    row({ uid: "裴硬_test_02", question: unrelatedQuestion, product: unrelatedProduct, steps: unrelatedSteps }),
  ], { policy });
  const exact = evaluation.findings.find((item) => item.rule === "batch-exact-structure-signature");
  assert.equal(exact?.level, "REVIEW");
  assert.equal(evaluation.findings.some((item) => item.rule === "batch-lexical-duplicate"), false);
  assert.equal(evaluation.status, "REVIEW");
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.reviewRequired, true);
  assert.ok(evaluation.reviewCount >= 1);
});

test("same step actions without similar business text are review-only", () => {
  const evaluation = evaluateDiversity([
    row({ question: baseQuestion, product: baseProduct, steps: baseSteps }),
    row({ uid: "裴硬_test_02", question: unrelatedQuestion, product: unrelatedProduct, steps: baseSteps }),
  ], { policy });
  const finding = evaluation.findings.find((item) => item.rule === "batch-step-action-isomorphism");
  assert.equal(finding?.level, "REVIEW");
  assert.equal(evaluation.status, "REVIEW");
  assert.equal(evaluation.ok, false);
});

test("shared long question prose is a hard duplicate even across different topics", () => {
  const shared = "本轮结论只供内部排期使用，后续材料变化时回到原始记录重新确认。";
  const evaluation = evaluateDiversity([
    row({ question: `${baseQuestion}${shared}`, product: baseProduct, steps: baseSteps }),
    row({ uid: "裴硬_test_02", question: `${unrelatedQuestion}${shared}`, product: unrelatedProduct, steps: unrelatedSteps }),
  ], { policy });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.findings.some((item) => item.rule === "batch-lexical-duplicate" && item.level === "FAIL"));
});

test("same subject can have materially different structures", () => {
  const alternativeQuestion =
    "附件中的试剂到货数据出现了一个不好解释的断点：18箱在卸货后才记录到11.6℃，承运商、仓库和采购的时间戳又彼此错开。质量负责人不想先讨论拒收，而是希望从最终付款决定倒推必须成立的证据链。请先列出拒收、折价接收和继续观察各自所需的事实门槛，再说明现有五份材料分别填上了哪一段、哪些段仍为空。这个结果下周要用于和供应商谈判，谈判人员需要知道每个立场能引用哪条合同、哪项原始记录，以及对方补交监控、校准证书或逐箱照片后结论会怎样变化。当前批次共有120箱，18箱异常，约定温度2—8℃，最大时间差47分钟，这些数字都要保留来源，不能被改写成估计值。Word请做成谈判问答包，按供应商可能提出的问题组织我方回答、证据和让步边界；Excel先放证据缺口与主张的条款矩阵，再由矩阵推导三种处置情景，不沿用普通的顺序台账。会议使用者要能从任一谈判立场反查合同条款、温控记录和补证责任人，并能看到证据变化后该立场是否失效。";
  const alternativeProduct =
    "Word是谈判问答包，围绕对方问题和我方立场组织；Excel是条款矩阵与三种处置情景，先从立场反查证据，再计算条件变化。";
  const alternativeSteps =
    "1. 从三种付款和接收立场倒推必要证据。\n2. 将合同条款映射到每个立场。\n3. 标出温控记录能够支持的主张。\n4. 为缺失监控、校准和照片设置证据空位。\n5. 建立供应商可能提出的反问。\n6. 分别形成我方回答和让步边界。\n7. 构造证据补齐前后的三种情景。\n8. 检验各立场在情景变化后是否仍成立。\n9. 汇总谈判授权和升级条件。\n10. 起草Word问答包。\n11. 建立Excel条款矩阵和情景模型。\n12. 交叉检查每个立场能否反查来源。";
  const first = fingerprintRow(row({ question: baseQuestion, product: baseProduct, steps: baseSteps }), policy);
  const second = fingerprintRow(row({ uid: "沈礼_test_02", question: alternativeQuestion, product: alternativeProduct, steps: alternativeSteps }), policy);
  const comparison = compareFingerprints(first, second, policy);
  assert.ok(comparison.score < policy.similarity.historyThreshold);
  assert.equal(comparison.exactStructureSignature, false);
});

test("disables synthetic style passports and leaves only source-driven slots", () => {
  const profiles = allocateProfiles({ count: 4, history: [], runId: "test-run" }, policy);
  assert.equal(policy.passport.assignmentMode, "disabled-source-derived");
  assert.deepEqual(policy.questionLength.planningBands, []);
  assert.ok(profiles.every((item) => item.sourceDriven === true));
  assert.ok(profiles.every((item) => !("openingMode" in item) && !("productTopology" in item)));
});

test("treats structure passport assignments as advisory", () => {
  const candidate = row({ question: baseQuestion, product: baseProduct, steps: baseSteps });
  const fingerprint = fingerprintRow(candidate, policy);
  const evaluation = evaluateDiversity([candidate], {
    policy,
    assignments: [{ index: 0, informationOrder: [...fingerprint.informationOrder].reverse() }],
  });
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.status, "PASS");
  assert.equal(evaluation.findings.some((item) => item.rule.startsWith("passport-")), false);
});

test("receipt builder refuses an unverified REVIEW override", () => {
  const rows = [row({ question: baseQuestion, product: baseProduct, steps: baseSteps })];
  assert.throws(
    () => buildReceipt({ evaluation: { ok: false, status: "REVIEW" }, rows, policy }),
    /verified independent REVIEW approval/i,
  );
  assert.throws(
    () => buildReceipt({
      evaluation: { ok: false, status: "REVIEW" },
      rows,
      policy,
      reportPath: "report.json",
      reportHash: "0".repeat(64),
      reviewAuthorization: { status: "APPROVED", decision: "APPROVE", verified: true },
    }),
    /verified independent REVIEW approval/i,
  );
});

test("receipt validation detects a post-gate edit", () => {
  const rows = [row({ question: baseQuestion, product: baseProduct, steps: baseSteps })];
  const evaluation = { ok: true, status: "PASS" };
  const receipt = buildReceipt({ evaluation, rows, policy, reportPath: "report.json" });
  assert.equal(verifyReceiptRows(receipt, rows, policy).ok, true);

  const edited = [{ ...rows[0], 题目: `${rows[0].题目} 临时补一句。` }];
  assert.equal(verifyReceiptRows(receipt, edited, policy).ok, false);
  assert.notEqual(hashPlanRows(rows).batchHash, hashPlanRows(edited).batchHash);
});
