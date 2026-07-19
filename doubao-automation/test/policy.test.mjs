import assert from "node:assert/strict";
import test from "node:test";

import { JobPauseRequestedError } from "../src/job-control.mjs";
import { auditDomesticWorkScope } from "../src/domestic-work-scope.mjs";
import {
  auditInteractionRewrite,
  auditVisibleResponse,
  auditOutboundPrompt,
  parseDecisionJson,
  requestInteractionRewrite,
  requestPolicyDecision,
  requestPromptPreflight,
  validateEvaluation,
  validateOutboundPrompt,
  validatePolicyDecision,
} from "../src/policy.mjs";

test("validates a detailed like evaluation", () => {
  assert.deepEqual(validateEvaluation({
    vote: "like",
    labels: ["内容准确", "其他"],
    note: "回答严格遵守了格式要求，内容准确且可以直接使用。",
  }), {
    vote: "like",
    labels: ["内容准确", "其他"],
    note: "回答严格遵守了格式要求，内容准确且可以直接使用。",
  });
});

test("requires the other label and a detailed note", () => {
  assert.throws(() => validateEvaluation({ vote: "like", labels: ["内容准确"], note: "足够长的评价说明文字。" }), /其他/u);
  assert.throws(() => validateEvaluation({ vote: "like", labels: ["其他"], note: "太短" }), /at least/u);
});

test("allows a standard two-character Chinese ellipsis in evaluator notes", () => {
  assert.doesNotThrow(() => validateEvaluation({
    vote: "dislike",
    labels: ["其他"],
    note: "这轮结果写成配置2……单价4950元，无法直接用于后续核对。",
  }));
  assert.throws(() => validateEvaluation({
    vote: "dislike",
    labels: ["其他"],
    note: "这轮结果出现连续感叹号！！无法直接用于后续核对。",
  }), /visible-text gate.*repeated-punctuation/u);
});

test("grounds production ratings in the actual response instead of random votes", () => {
  const grounded = validateEvaluation({
    score: 1,
    vote: "dislike",
    labels: ["其他"],
    note: "回复只说已经完成，却没有给出可以核对的来源或产物。",
    evidenceQuote: "已完成初稿",
  }, {
    requireExperienceEvidence: true,
    responseText: "已完成初稿。",
  });
  assert.equal(grounded.score, 1);
  assert.equal(grounded.vote, "dislike");
  assert.throws(() => validateEvaluation({ ...grounded, vote: "like" }, {
    requireExperienceEvidence: true,
    responseText: "已完成初稿。",
  }), /must map/u);
  assert.throws(() => validateEvaluation({ ...grounded, evidenceQuote: "不存在的内容" }, {
    requireExperienceEvidence: true,
    responseText: "已完成初稿。",
  }), /not found/u);
});

test("parses fenced evaluator JSON and requires a next prompt", () => {
  const parsed = parseDecisionJson('```json\n{"evaluation":{"score":3,"vote":"like","labels":["其他"],"note":"回答满足当前要求，可以继续追问更深层细节。","evidenceQuote":"已完成初稿"},"nextPrompt":"请继续补充证据链。","nextAttachmentNames":[]}\n```');
  const options = { latestResponse: "已完成初稿，主要字段已经列出。" };
  assert.equal(validatePolicyDecision(parsed, options).nextPrompt, "请继续补充证据链。");
  assert.throws(() => validatePolicyDecision({ ...parsed, nextPrompt: "" }, options), /nextPrompt/u);
});

test("continues beyond round six until the task is complete or Doubao is demonstrably unable", () => {
  const evaluation = {
    score: 3,
    vote: "like",
    labels: ["其他"],
    note: "当前结果已经覆盖要求，产物内容可以继续使用。",
    evidenceQuote: "已完成初稿",
  };
  const common = {
    evaluation,
    nextAttachmentNames: [],
    productAssessment: null,
  };
  const options = {
    latestResponse: "已完成初稿，主要字段已经列出。",
    minimumRounds: 6,
    roundNumber: 6,
  };
  const continued = validatePolicyDecision({
    ...common,
    nextPrompt: "你把遗漏的前138行补回表里，再核对总行数。",
    taskOutcome: "continue",
    unresolvedIssues: ["前138行尚未纳入最终表"],
  }, options);
  assert.equal(continued.taskOutcome, "continue");

  const completed = validatePolicyDecision({
    ...common,
    nextPrompt: "",
    taskOutcome: "complete",
    unresolvedIssues: [],
  }, options);
  assert.equal(completed.taskOutcome, "complete");

  assert.throws(() => validatePolicyDecision({
    ...common,
    evaluation: { ...evaluation, score: 1, vote: "dislike" },
    nextPrompt: "",
    taskOutcome: "doubao-unable",
    unresolvedIssues: [],
  }, options), /unresolved issue/u);

  assert.throws(() => validatePolicyDecision({
    ...common,
    nextPrompt: "你继续补齐遗漏内容。",
    taskOutcome: "continue",
    unresolvedIssues: ["仍有遗漏"],
  }, { ...options, finalRound: true, roundNumber: 12 }), /hard round limit/u);
});

test("blocks visible runtime traces and odd punctuation before sending", () => {
  assert.equal(auditOutboundPrompt("请继续核对官方来源和访问日期。").pass, true);
  assert.deepEqual(auditOutboundPrompt("上一轮出现异常，请重试！！！").issues, [
    "runtime-error-word",
    "repeated-punctuation",
  ]);
  assert.throws(() => validateOutboundPrompt("```json\n{}\n```"), /visible-text gate/u);
  assert.deepEqual(auditOutboundPrompt("比较 Zoom 和 Google Meet 的采购方案。").issues, ["foreign-platform"]);
  assert.deepEqual(auditOutboundPrompt("给我做一份 Excel 工作簿。").issues, ["unnatural-excel-wording"]);
  assert.deepEqual(auditOutboundPrompt("给我做一份Excel形式的核对表。").issues, ["unnatural-excel-wording"]);
  assert.equal(auditOutboundPrompt("给我做一张 Excel 核对表。").pass, true);
});

test("allows natural courtesy and repeated request openers while keeping empty role fillers blocked", () => {
  assert.deepEqual(
    auditOutboundPrompt("我在这条消息里一次性上传十份材料。后面需要整理材料清单。").issues,
    ["forced-personal-opener"],
  );
  assert.deepEqual(
    auditOutboundPrompt("售后这边要核对北京奔驰这批召回车辆。").issues,
    ["role-filler-zhebian"],
  );
  assert.equal(
    auditOutboundPrompt("这次共有十份材料，包括成交公告和配送计划。后面需要整理材料清单。").pass,
    true,
  );
  assert.equal(auditOutboundPrompt("上一版混入了非官方来源，麻烦重新核验钉钉字幕。").pass, true);
  assert.equal(auditOutboundPrompt("这套审批手续太麻烦，需要缩短处理时间。").pass, true);
  assert.equal(
    auditOutboundPrompt("请把来源链接补齐。", { recentPrompts: ["请先核对官方原文。"] }).pass,
    true,
  );
  assert.equal(
    auditOutboundPrompt("把来源链接补齐。", { recentPrompts: ["请先核对官方原文。"] }).pass,
    true,
  );
});

test("allows natural evidence boundaries as well as direct positive instructions", () => {
  assert.equal(auditOutboundPrompt("不要复述整份材料，而要直接给出结论。").pass, true);
  assert.equal(auditOutboundPrompt("这个结论不作为最终采购决策。").pass, true);
  assert.equal(auditOutboundPrompt("不能直接证明的项目标为待确认。").pass, true);
  assert.equal(
    auditOutboundPrompt("已确认项附直接证据，其余项目记为待确认。").pass,
    true,
  );
  assert.equal(
    auditOutboundPrompt("当前页面无法访问，记录页面标题和访问日期。").pass,
    true,
  );
});

test("treats semicolons, dunhao density and personal pronouns as advice", () => {
  const semicolon = auditOutboundPrompt("你先核对排期；我再看结果。");
  assert.equal(semicolon.pass, true);
  assert.deepEqual(semicolon.advisories, ["semicolon-style-review"]);
  const denseEnumeration = auditOutboundPrompt("你先核对日期、场次、负责人，再给我结果。");
  assert.equal(denseEnumeration.pass, true);
  assert.deepEqual(denseEnumeration.advisories, ["dense-enumeration-punctuation"]);
  assert.equal(auditOutboundPrompt("你先核对日期、场次。结果发给我。").pass, true);
  const noPronoun = auditOutboundPrompt("先核对日期和场次。", { requirePersonalPronoun: true });
  assert.equal(noPronoun.pass, true);
  assert.deepEqual(noPronoun.advisories, ["personal-pronoun-optional"]);
  assert.equal(
    auditOutboundPrompt("我先看日期和场次。", { requirePersonalPronoun: true }).pass,
    true,
  );
  assert.deepEqual(auditOutboundPrompt("刚传了三份材料，先核对来源。").issues, ["generic-upload-meta-opener"]);
  assert.deepEqual(auditOutboundPrompt("随本消息上传了三份材料，先核对来源。").issues, ["generic-upload-meta-opener"]);
  assert.deepEqual(auditOutboundPrompt("这是三份季度报告和经营简报。请核对来源。").issues, ["standalone-material-intro-opener"]);
  assert.equal(auditOutboundPrompt("请核对三份季度报告和经营简报能否组成完整来源链。").pass, true);
});

test("accepts the 2026-07-17 naturalness baseline wording", () => {
  const prompt = `我们准备把跨地区员工培训改成常态化直播，考虑到部分同事需要用到实时字幕、屏幕阅读器或者键盘操作，得先摸底一下腾讯会议、钉钉和飞书这三个平台的无障碍支持情况。麻烦你根据截至2026年7月17日能访问的官方产品文档和帮助页面，整理一份Excel对比表。

表里需要详细核对这三家在实时字幕、翻译字幕、屏幕阅读器支持以及键盘与焦点操作兼容性上的表现。录制和转录的留存机制要单独说明，同时把主持人和管理员的具体控制权限理清楚。记得给表里的每一项判断都标上来源链接和具体的访问日期。如果官方公开页面没写清楚套餐限制、字幕支持的语言范围或者导出权限，直接留白就行，不要自己推测。至于保存期限和直播规模限制，统一列成待确认事项，并在旁边写明后续需要通过什么实测或询价方式来补充确认。

在表格最后，请根据对比结果推荐一个最适合优先进入POC阶段的平台并给出理由，顺便说明另外两家暂缓推进是因为存在哪些证据缺口。这次的评估结论只是用来安排下一阶段的实测，不作为最终的采购和合规决策。`;
  const audit = auditOutboundPrompt(prompt);
  assert.equal(audit.pass, true, audit.issues.join(", "));
  assert.equal(audit.issues.length, 0);
});

test("keeps task-complexity checks out of retrospective feedback notes", () => {
  const feedback = "本轮测算50%转化率对应10,960盒，结果表达清楚。";
  assert.equal(auditOutboundPrompt(feedback, { textPurpose: "feedback-note" }).pass, true);
  assert.equal(auditOutboundPrompt(feedback).issues.includes("calculation-too-simple"), true);
  assert.equal(auditDomesticWorkScope(feedback).issues.includes("calculation-too-simple"), true);
  assert.equal(auditDomesticWorkScope(feedback, { enforceCalculationComplexity: false }).pass, true);
});

test("evaluates a narrowed calculation follow-up against its preserved source context", () => {
  const rewritten = "我重新计算20.15L的结论。";
  const source = "你逐项复核多个数量差异，补齐单位换算和取整规则，再对照阈值更新结论。";
  assert.equal(auditOutboundPrompt(rewritten).issues.includes("calculation-too-simple"), true);
  assert.equal(auditOutboundPrompt(rewritten, { scopeContext: { sourcePrompt: source } }).pass, true);
});

test("counts an explicit two-period weighted precision check as real calculation complexity", () => {
  const prompt = "将单票收入复算中的方法偏差与披露舍入不确定性拆开核定。分别计算两期简单平均相对加权结果的方法偏差，并依据收入和业务量原披露精度推导季度单票收入的可能区间及最大舍入影响。";
  assert.equal(auditDomesticWorkScope(prompt).calculationComplexityCount >= 2, true);
  assert.equal(auditOutboundPrompt(prompt).pass, true);
});

test("recognizes concrete narrowing verbs as real work advancement", () => {
  for (const prompt of [
    "你把六包金额差异拆分到明细行。",
    "我想补齐来源页码和待核字段。",
    "你将响应价格与成交版本对齐。",
  ]) {
    assert.equal(auditDomesticWorkScope(prompt, {
      context: "采购团队正在复核项目台账。",
      requireInteractionAdvance: true,
      requireWorkScene: true,
    }).pass, true, prompt);
  }
});

test("rejects follow-ups dominated by mechanical file operations", () => {
  const context = "采购团队正在复核设备规格证据和价格口径。";
  const mechanical = "把现有核对表导出为 Excel 文件。完整保留工作表，确保文件能正常打开。现场回填列保持可编辑。另外标明配置2两个单价的来源口径。";
  assert.deepEqual(auditDomesticWorkScope(mechanical, {
    context,
    requireInteractionAdvance: true,
    requireWorkScene: true,
  }).issues, ["mechanical-dominant-follow-up"]);
  assert.deepEqual(auditOutboundPrompt(mechanical, {
    requireInteractionAdvance: true,
    scopeContext: context,
  }).issues, ["mechanical-dominant-follow-up"]);

  const substantive = "核对配置2两个单价分别来自哪份材料。解释两种口径产生差异的原因，判断核对表应采用哪一个并在导出文件中保留出处。";
  assert.equal(auditDomesticWorkScope(substantive, {
    context,
    requireInteractionAdvance: true,
    requireWorkScene: true,
  }).pass, true);
});

test("records Doubao execution traces as non-blocking response observations", () => {
  assert.equal(auditVisibleResponse("对比表已经生成，下面给出来源和阶段性建议。").pass, true);
  assert.deepEqual(
    auditVisibleResponse("工具执行完成。发现 Bash 工具存在沙箱问题，用户拒绝执行 Python 命令。").observations,
    ["tool-progress-trace", "sandbox-or-command-trace", "user-rejection-trace", "internal-tool-name"],
  );
  assert.deepEqual(auditVisibleResponse("建议改用 Zoom 继续完成平台比较。").observations, ["foreign-platform"]);
  assert.deepEqual(auditVisibleResponse("建议改用 Zoom 继续完成平台比较。").issues, []);
});

test("records Doubao quota and service responses for runner-level routing", () => {
  assert.deepEqual(
    auditVisibleResponse("近 7 天专业版功能的免费额度用完了，预计 7 月 24 日恢复为你服务。升级到标准套餐。")
      .observations,
    ["doubao-quota-unavailable"],
  );
  assert.deepEqual(
    auditVisibleResponse("当前服务繁忙，请稍后再试。")
      .observations,
    ["doubao-service-unavailable"],
  );
});

test("rewrites every outbound interaction with the external de-AI model and preserves anchors", async () => {
  const source = "我想根据截至2026年7月17日的资料核对腾讯会议，并整理Excel对比表。";
  const rewritten = "我想根据截至2026年7月17日能查到的资料，把腾讯会议的情况核对清楚并整理成Excel对比表。";
  let requestBody;
  const result = await requestInteractionRewrite({
    job: { taskGoal: "形成平台对比表" },
    policy: {
      type: "openai-compatible",
      baseUrl: "https://api.mugua.test/v1",
      model: "gemini-3.1-pro-preview",
      timeoutMs: 5_000,
    },
    prompt: source,
    recentPrompts: ["请先核对钉钉字幕的官方来源。"],
    roundNumber: 1,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: JSON.stringify({ prompt: rewritten }) } }],
        usage: { total_tokens: 30 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(result.pass, true);
  assert.equal(result.prompt, rewritten);
  assert.equal(result.model, "gemini-3.1-pro-preview");
  assert.equal(result.preservation.pass, true);
  assert.match(requestBody.messages[0].content, /“请”“帮我”“麻烦你”等自然请求语可以按语境使用/u);
  assert.match(requestBody.messages[0].content, /“不要自行推测”“不作为最终决策”/u);
  assert.match(requestBody.messages[0].content, /使用或省略“你”“我”都不作为自然度指标/u);
  assert.match(requestBody.messages[0].content, /删除“刚传了”“我刚上传了”“这里上传了”“随本消息上传了”/u);
  assert.match(requestBody.messages[0].content, /一个主要判断或交付目标/u);
  assert.deepEqual(JSON.parse(requestBody.messages.at(-1).content).recentPrompts, [
    "请先核对钉钉字幕的官方来源。",
  ]);
  assert.equal(auditInteractionRewrite(source, rewritten).pass, true);
  assert.deepEqual(
    auditInteractionRewrite(source, rewritten.replace("2026年", "2025年")).issues,
    ["numbers-changed"],
  );
  assert.deepEqual(
    auditInteractionRewrite(source, rewritten.replace("2026年", "2025年")).anchorDiff.numbers,
    { missing: ["2026"], added: ["2025"] },
  );
  assert.equal(
    auditInteractionRewrite("我要一张 Excel 核对表，最后交付 Excel 文件。", "我要一张 Excel 核对表，最后把文件交给我。").pass,
    true,
  );
  assert.deepEqual(
    auditInteractionRewrite("我要核对 CPU 配置。", "我要核对设备配置。").issues,
    ["latin-anchors-changed"],
  );
  assert.deepEqual(
    auditInteractionRewrite("我要核对 CPU 配置。", "我要核对设备配置。").anchorDiff.latin,
    { missing: ["CPU"], added: [] },
  );
});

test("marks long first-round prompts for minimal de-AI edits and exposes source gate issues", async () => {
  let requestBody;
  const source = `我会核对2026年资料和Excel数据。字段异常保持待核。${"这段业务说明保持原样。".repeat(80)}`;
  const rewritten = source.replaceAll("异常", "疑点");
  const result = await requestInteractionRewrite({
    job: { taskGoal: "形成Excel核对表", initialAttachmentNames: ["a.pdf", "b.pdf"] },
    policy: {
      type: "openai-compatible",
      baseUrl: "https://api.mugua.test/v1",
      model: "gemini-3.1-pro-preview",
      timeoutMs: 5_000,
    },
    prompt: source,
    roundNumber: 1,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: JSON.stringify({ prompt: rewritten }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(result.pass, true);
  assert.match(requestBody.messages[0].content, /采用轻量自然化/u);
  const payload = JSON.parse(requestBody.messages[1].content);
  assert.deepEqual(payload.sourceVisibleIssues, ["runtime-error-word"]);
  assert.deepEqual(payload.requiredLatinTokens, ["Excel"]);
  assert.deepEqual(payload.requiredNumberTokens, ["2026"]);
});

test("turns a runtime-word rejection into an explicit visible-term repair", async () => {
  const requestBodies = [];
  let calls = 0;
  const source = "我会核对2026年资料，把字段异常记入待核清单。";
  const result = await requestInteractionRewrite({
    job: { taskGoal: "形成核对清单", initialAttachmentNames: ["a.pdf"] },
    policy: {
      type: "openai-compatible",
      baseUrl: "https://api.mugua.test/v1",
      model: "gemini-3.1-pro-preview",
      timeoutMs: 5_000,
    },
    prompt: source,
    roundNumber: 1,
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      calls += 1;
      const prompt = calls === 1
        ? source
        : "我会核对2026年资料，把字段疑点记入待核清单。";
      return new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: JSON.stringify({ prompt }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(result.prompt, "我会核对2026年资料，把字段疑点记入待核清单。");
  assert.match(requestBodies[0].messages[0].content, /“报错”和“异常”不属于逐字事实锚点/u);
  const repair = JSON.parse(requestBodies[1].messages.at(-1).content);
  assert.match(repair.instruction, /下一版不得出现‘报错’或‘异常’/u);
});

test("feeds chat preflight findings back with attachment-role and fact-boundary repair rules", async () => {
  let requestBody;
  const source = "我会在当前消息上传2份附件，你读取后核对可证事实和待确认项。";
  const result = await requestInteractionRewrite({
    job: { taskGoal: "形成核对结论", initialAttachmentNames: ["a.pdf", "b.pdf"] },
    policy: {
      type: "openai-compatible",
      baseUrl: "https://api.mugua.test/v1",
      model: "gemini-3.1-pro-preview",
      timeoutMs: 5_000,
    },
    prompt: source,
    roundNumber: 1,
    validationFeedback: "上一版互换了附件上传与核验角色，并新增了后续流程。",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: JSON.stringify({ prompt: source }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(result.prompt, source);
  assert.match(requestBody.messages[0].content, /不能另写“这是……材料”/u);
  assert.match(requestBody.messages[0].content, /taskGoal 中未出现在 sourcePrompt 的编号/u);
  assert.match(requestBody.messages[0].content, /不因否定形式本身退回/u);
  const repair = JSON.parse(requestBody.messages.at(-1).content);
  assert.match(repair.instruction, /用户负责上传附件，豆包负责读取和核验/u);
  assert.match(repair.instruction, /不得新增后续流程/u);
  assert.match(repair.instruction, /否定表达可以保留/u);
  assert.equal(repair.qualityGateFeedback, "上一版互换了附件上传与核验角色，并新增了后续流程。");
});

test("accepts a natural courteous request opener from the de-AI model", async () => {
  const result = await requestInteractionRewrite({
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "openai-compatible",
        baseUrl: "https://api.mugua.test/v1",
        model: "gemini-3.1-pro-preview",
        timeoutMs: 5_000,
      },
      prompt: "只核验钉钉实时字幕的官方来源。",
      roundNumber: 2,
      fetchImpl: async () => new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: '{"prompt":"麻烦只核验钉钉实时字幕的官方来源。"}' } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
  assert.equal(result.prompt, "麻烦只核验钉钉实时字幕的官方来源。");
});

test("accepts a natural courteous de-AI candidate without an unnecessary retry", async () => {
  let calls = 0;
  const source = "我想核对腾讯会议的官方来源。";
  const result = await requestInteractionRewrite({
    job: { taskGoal: "形成平台对比表" },
    policy: {
      type: "openai-compatible",
      baseUrl: "https://api.mugua.test/v1",
      model: "gemini-3.1-pro-preview",
      timeoutMs: 5_000,
    },
    prompt: source,
    roundNumber: 1,
    fetchImpl: async () => {
      calls += 1;
      const prompt = calls === 1 ? "麻烦你核对腾讯会议的官方来源。" : source;
      return new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: JSON.stringify({ prompt }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.prompt, "麻烦你核对腾讯会议的官方来源。");
  assert.deepEqual(result.contentValidationTrace.map((item) => item.status), ["accepted"]);
});

test("allows a repeated request opener when the follow-up itself is natural", async () => {
  const result = await requestInteractionRewrite({
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "openai-compatible",
        baseUrl: "https://api.mugua.test/v1",
        model: "gemini-3.1-pro-preview",
        timeoutMs: 5_000,
      },
      prompt: "继续核验钉钉实时字幕的官方来源。",
      recentPrompts: ["请先核对腾讯会议的官方原文。"],
      roundNumber: 2,
      fetchImpl: async () => new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: '{"prompt":"请继续核验钉钉实时字幕的官方来源。"}' } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
  assert.equal(result.prompt, "请继续核验钉钉实时字幕的官方来源。");
});

test("pauses instead of accepting a de-AI rewrite that changes a factual anchor", async () => {
  await assert.rejects(
    requestInteractionRewrite({
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "openai-compatible",
        baseUrl: "https://api.mugua.test/v1",
        model: "gemini-3.1-pro-preview",
        timeoutMs: 5_000,
      },
      prompt: "我想根据2026年资料核对腾讯会议并整理Excel对比表。",
      roundNumber: 1,
      fetchImpl: async () => new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: '{"prompt":"我想根据2025年资料核对腾讯会议并整理Excel对比表。"}' } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    }),
    (error) => error.code === "MODEL_INVOCATION_FAILED" && /numbers-changed/u.test(error.message),
  );
});

test("isolates feedback-note rewriting from future task goals", async () => {
  let requestBody;
  const source = "当前清单引用的服务商文章缺少标题和链接，证据等级不足以支持试点决策。";
  const result = await requestInteractionRewrite({
    job: { taskGoal: "形成可下载电子表格并选出唯一优先平台" },
    policy: {
      type: "openai-compatible",
      baseUrl: "https://api.mugua.test/v1",
      model: "gemini-3.1-pro-preview",
      timeoutMs: 5_000,
    },
    prompt: source,
    roundNumber: 1,
    textPurpose: "feedback-note",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: JSON.stringify({ prompt: source }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const userPayload = JSON.parse(requestBody.messages.at(-1).content);
  assert.equal(Object.hasOwn(userPayload, "taskGoal"), false);
  assert.match(requestBody.messages[0].content, /不得引入原文未出现的后续目标/u);
  assert.equal(result.prompt, source);
});

test("keeps later chat rewrites focused on the current narrowing step", async () => {
  let requestBody;
  const source = "你把五份真实附件的文件名和对应核对项列出来。";
  const result = await requestInteractionRewrite({
    job: {
      initialAttachmentNames: ["a.pdf", "b.pdf"],
      taskGoal: "形成可下载的 Excel 核对表",
    },
    policy: {
      type: "openai-compatible",
      baseUrl: "https://api.mugua.test/v1",
      model: "gemini-3.1-pro-preview",
      timeoutMs: 5_000,
    },
    prompt: source,
    roundNumber: 2,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { content: JSON.stringify({ prompt: source }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const userPayload = JSON.parse(requestBody.messages.at(-1).content);
  assert.equal(Object.hasOwn(userPayload, "taskGoal"), false);
  assert.equal(Object.hasOwn(userPayload, "initialAttachmentNames"), false);
  assert.equal(result.prompt, source);
});

test("runs a check-only Codex quality gate after de-AI rewriting", async () => {
  let captured;
  const result = await requestPromptPreflight({
    conversationContext: {
      previousPrompt: "先整理平台差异。",
      previousResponse: "当前缺少来源链接和访问日期。",
    },
    job: { taskGoal: "形成平台对比表" },
    policy: {
      type: "local-codex",
      model: "gpt-codex-review-model",
      timeoutMs: 5_000,
    },
    prompt: "核对腾讯会议缺失的来源链接，判断对应结论是否还能保留。",
    sourcePrompt: "核对腾讯会议缺失的来源链接，判断对应结论是否还能保留。",
    roundNumber: 2,
    localCodexImpl: async (value) => {
      captured = value;
      return {
        id: "resp_quality_gate",
        model: value.model,
        provider: "local-codex-cli",
        content: '{"pass":true,"issues":[]}',
        usage: {},
      };
    },
  });
  assert.match(captured.userPrompt, /sourcePrompt/u);
  assert.match(captured.userPrompt, /candidatePrompt/u);
  assert.match(captured.userPrompt, /当前缺少来源链接和访问日期/u);
  assert.match(captured.systemPrompt, /每轮只把问题收窄一层/u);
  assert.match(captured.systemPrompt, /sourcePrompt 是完整可见事实源/u);
  assert.match(captured.systemPrompt, /一个主要判断或交付目标/u);
  assert.equal(result.pass, true);
  assert.equal(result.prompt, "核对腾讯会议缺失的来源链接，判断对应结论是否还能保留。");
  assert.equal(result.changed, false);
  assert.equal(result.model, "gpt-codex-review-model");
  assert.equal(result.provider, "local-codex-cli");
});

test("runs the quality gate through the locally logged-in Codex CLI without an API key", async () => {
  let captured;
  const result = await requestPromptPreflight({
    job: { taskGoal: "形成平台对比表" },
    localCodexImpl: async (value) => {
      captured = value;
      return {
        content: '{"pass":true,"issues":[]}',
        id: "local-codex-test",
        model: value.model,
        provider: "local-codex-cli",
        usage: {},
      };
    },
    policy: {
      type: "local-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      timeoutMs: 5_000,
    },
    prompt: "核对腾讯会议缺失的来源链接，判断对应结论是否还能保留。",
    sourcePrompt: "核对腾讯会议缺失的来源链接，判断对应结论是否还能保留。",
    roundNumber: 2,
  });
  assert.equal(result.pass, true);
  assert.equal(result.provider, "local-codex-cli");
  assert.equal(captured.model, "gpt-5.6-sol");
  assert.equal(captured.reasoningEffort, "high");
  assert.equal(captured.outputSchema.properties.pass.type, "boolean");
});

test("runs the Codex quality gate through a custom Responses API with exact usage", async () => {
  const previous = process.env.TEST_CODEX_RESPONSES_KEY;
  process.env.TEST_CODEX_RESPONSES_KEY = "custom-secret";
  let captured;
  try {
    const result = await requestPromptPreflight({
      job: { taskGoal: "核对经营数据并形成可追溯结论。" },
      policy: {
        type: "responses-api",
        baseUrl: "https://gateway.example/v1",
        apiKeyEnv: "TEST_CODEX_RESPONSES_KEY",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        timeoutMs: 5_000,
      },
      prompt: "请核对本轮回复中的经营数据来源，并收窄到一个可验证结论。",
      sourcePrompt: "请核对本轮回复中的经营数据来源，并收窄到一个可验证结论。",
      roundNumber: 2,
      responsesApiImpl: async (value) => {
        captured = value;
        return {
          id: "resp_custom_policy",
          model: value.model,
          provider: "openai-compatible-responses-api",
          content: '{"pass":true,"issues":[]}',
          usage: {
            metered: true,
            source: "responses-api",
            requestCount: 1,
            inputTokens: 100,
            cachedInputTokens: 20,
            uncachedInputTokens: 80,
            outputTokens: 30,
            reasoningTokens: 25,
            visibleOutputTokens: 5,
            totalTokens: 130,
          },
        };
      },
    });
    assert.equal(captured.apiKey, "custom-secret");
    assert.equal(captured.baseUrl, "https://gateway.example/v1");
    assert.equal(captured.outputSchema.properties.pass.type, "boolean");
    assert.equal(result.provider, "openai-compatible-responses-api");
    assert.equal(result.usage.totalTokens, 130);
  } finally {
    if (previous == null) delete process.env.TEST_CODEX_RESPONSES_KEY;
    else process.env.TEST_CODEX_RESPONSES_KEY = previous;
  }
});

test("keeps metered usage when the Responses adapter fails after receiving a response", async () => {
  const previous = process.env.TEST_CODEX_RESPONSES_API_KEY;
  process.env.TEST_CODEX_RESPONSES_API_KEY = "test-only-secret";
  try {
    await assert.rejects(requestPromptPreflight({
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "responses-api",
        baseUrl: "https://gateway.example/openai",
        apiKeyEnv: "TEST_CODEX_RESPONSES_API_KEY",
        model: "gpt-5.6-sol",
        timeoutMs: 5_000,
      },
      prompt: "核对腾讯会议的官方来源。",
      sourcePrompt: "核对腾讯会议的官方来源。",
      roundNumber: 1,
      responsesApiImpl: async () => {
        const error = new Error("structured output was invalid");
        error.provider = "openai-compatible-responses-api";
        error.model = "gpt-5.6-sol";
        error.responseId = "resp_metered_failure";
        error.usage = {
          metered: true,
          source: "responses-api",
          requestCount: 1,
          inputTokens: 18,
          cachedInputTokens: 0,
          uncachedInputTokens: 18,
          outputTokens: 4,
          reasoningTokens: 3,
          visibleOutputTokens: 1,
          totalTokens: 22,
        };
        throw error;
      },
    }), (error) => error.code === "MODEL_INVOCATION_FAILED"
      && error.usage?.totalTokens === 22
      && error.responseId === "resp_metered_failure");
  } finally {
    if (previous == null) delete process.env.TEST_CODEX_RESPONSES_API_KEY;
    else process.env.TEST_CODEX_RESPONSES_API_KEY = previous;
  }
});

test("grounds feedback preflight in the actual response, artifacts, and proposed score", async () => {
  let captured;
  const result = await requestPromptPreflight({
    conversationContext: {
      currentPrompt: "请补齐对比表中的来源链接和访问日期。",
      currentResponse: "已补齐腾讯会议条目，但钉钉的导出权限仍未找到公开说明。",
      currentResponseArtifacts: [{ kind: "online-spreadsheet", title: "平台对比表" }],
      proposedScore: 3,
      proposedVote: "like",
      proposedLabels: ["其他"],
      evidenceQuote: "钉钉的导出权限仍未找到公开说明",
      successCriteria: ["每项判断有来源", "不推测公开页面未说明的内容"],
    },
    job: { taskGoal: "形成平台对比表" },
    policy: {
      type: "local-codex",
      model: "gpt-codex-review-model",
      timeoutMs: 5_000,
    },
    prompt: "大部分来源已经补上，钉钉的导出权限还缺少公开依据。",
    sourcePrompt: "多数来源已补齐，但钉钉导出权限缺少公开依据。",
    roundNumber: 3,
    textPurpose: "feedback-note",
    localCodexImpl: async (value) => {
      captured = value;
      return {
        id: "resp_feedback_quality_gate",
        model: value.model,
        provider: "local-codex-cli",
        content: '{"pass":true,"issues":[]}',
        usage: {},
      };
    },
  });
  assert.match(captured.systemPrompt, /不得随机/u);
  assert.match(captured.systemPrompt, /3\/4分只能对应like/u);
  assert.match(captured.userPrompt, /currentResponseArtifacts/u);
  assert.match(captured.userPrompt, /proposedScore/u);
  assert.match(captured.userPrompt, /钉钉的导出权限仍未找到公开说明/u);
  assert.match(captured.userPrompt, /平台对比表/u);
  assert.equal(result.pass, true);
  assert.equal(result.textPurpose, "feedback-note");
});

test("a failed Codex quality decision cannot be rewritten or silently released", async () => {
  await assert.rejects(
    requestPromptPreflight({
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "local-codex",
        model: "gpt-codex-review-model",
        timeoutMs: 5_000,
      },
      prompt: "核对腾讯会议缺失的来源链接，判断对应结论是否还能保留。",
      sourcePrompt: "核对腾讯会议缺失的来源链接，判断对应结论是否还能保留。",
      roundNumber: 2,
      localCodexImpl: async () => ({
        id: "resp_quality_reject",
        model: "gpt-codex-review-model",
        provider: "local-codex-cli",
        content: '{"pass":false,"issues":["任务目的发生变化"]}',
        usage: {},
      }),
    }),
    (error) => error.code === "MODEL_INVOCATION_FAILED" && /任务目的发生变化/u.test(error.message),
  );
});

test("the deterministic gate allows a repeated request opener after Codex passes it", async () => {
  const result = await requestPromptPreflight({
      conversationContext: {
        recentPrompts: ["请先核对腾讯会议的官方原文。"],
      },
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "local-codex",
        model: "gpt-codex-review-model",
        timeoutMs: 5_000,
      },
      prompt: "请继续核验钉钉实时字幕的官方来源。",
      sourcePrompt: "继续核验钉钉实时字幕的官方来源。",
      roundNumber: 2,
      localCodexImpl: async () => ({
        id: "resp_quality_false_pass",
        model: "gpt-codex-review-model",
        provider: "local-codex-cli",
        content: '{"pass":true,"issues":[]}',
        usage: {},
      }),
    });
  assert.equal(result.pass, true);
  assert.equal(result.prompt, "请继续核验钉钉实时字幕的官方来源。");
});

test("uses the local Codex model to evaluate a response and plan the next interaction", async () => {
  let captured;
  const result = await requestPolicyDecision({
    availableAttachments: [{
      name: "附件二_来源核对截图.png",
      summary: "包含访问日期和原始字段。",
    }],
    job: { taskGoal: "完善公司内部平台对比表", successCriteria: ["补齐来源"] },
    maxRounds: 6,
    policy: {
      type: "local-codex",
      model: "gpt-codex-planner-model",
      timeoutMs: 5_000,
    },
    roundNumber: 1,
    transcript: [{ round: 1, prompt: "整理平台对比表。", response: "已完成初稿。" }],
    localCodexImpl: async (value) => {
      captured = value;
      return {
        id: "resp_planner",
        model: value.model,
        provider: "local-codex-cli",
        content: JSON.stringify({
          evaluation: {
            score: 3,
            vote: "like",
            labels: ["内容准确", "其他"],
            note: "初稿已经覆盖主要平台，内容准确，可以继续补齐来源信息。",
            evidenceQuote: "已完成初稿",
          },
          nextPrompt: "你这版还缺来源链接和访问日期，我补了一张原始页面截图，请结合附件二把这两项核对清楚。",
          nextAttachmentNames: ["附件二_来源核对截图.png"],
          productAssessment: null,
        }),
        usage: {},
      };
    },
  });
  assert.match(captured.systemPrompt, /真人用户/u);
  assert.match(captured.systemPrompt, /再向下一层收窄/u);
  assert.match(captured.systemPrompt, /一个主要判断或交付目标/u);
  assert.match(captured.systemPrompt, /evidenceQuote/u);
  assert.equal(result.evaluator.provider, "local-codex-cli");
  assert.equal(result.evaluation.score, 3);
  assert.equal(result.evaluation.evidenceQuote, "已完成初稿");
  assert.deepEqual(result.nextAttachmentNames, ["附件二_来源核对截图.png"]);
  assert.match(result.nextPrompt, /来源链接/u);
});

test("asks the evaluator to correct an evidence quote that is not verbatim", async () => {
  let calls = 0;
  const result = await requestPolicyDecision({
    job: { taskGoal: "完善公司内部平台对比表", successCriteria: ["补齐来源"] },
    maxRounds: 6,
    policy: { type: "local-codex", model: "gpt-codex-planner-model", timeoutMs: 5_000 },
    roundNumber: 2,
    transcript: [{ round: 2, prompt: "核对来源。", response: "官方页面没有写明套餐限制。" }],
    localCodexImpl: async (value) => {
      calls += 1;
      const corrected = calls > 1;
      if (corrected) assert.match(value.userPrompt, /逐字复制/u);
      return {
        id: `resp_planner_${calls}`,
        model: value.model,
        provider: "local-codex-cli",
        content: JSON.stringify({
          evaluation: {
            score: 3,
            vote: "like",
            labels: ["内容准确", "其他"],
            note: "已明确保留官方证据边界，但还需要继续补齐套餐信息。",
            evidenceQuote: corrected ? "没有写明套餐限制" : "官方文档未说明套餐限制",
          },
          nextPrompt: "请继续核对套餐限制的官方原文。",
          nextAttachmentNames: [],
          productAssessment: null,
        }),
        usage: {},
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.evaluation.evidenceQuote, "没有写明套餐限制");
  assert.equal(result.evaluator.validationFailures.length, 1);
});

test("feeds a non-advancing follow-up back to the evaluator before accepting it", async () => {
  let calls = 0;
  const result = await requestPolicyDecision({
    decisionValidator: (decision) => {
      const audit = auditDomesticWorkScope(decision.nextPrompt, {
        context: "采购团队正在复核项目台账。",
        requireInteractionAdvance: true,
        requireWorkScene: true,
      });
      if (!audit.pass) throw new Error(`scope rejected: ${audit.issues.join(",")}`);
    },
    job: { taskGoal: "完善公司采购复核表", successCriteria: ["补齐来源"] },
    maxRounds: 6,
    policy: { type: "local-codex", model: "gpt-codex-planner-model", timeoutMs: 5_000 },
    roundNumber: 1,
    transcript: [{ round: 1, prompt: "核对采购台账。", response: "金额复核已经完成。" }],
    localCodexImpl: async (value) => {
      calls += 1;
      if (calls === 2) {
        assert.match(value.userPrompt, /scope rejected/u);
        assert.match(value.userPrompt, /一个尚未完成的实质判断/u);
        assert.match(value.userPrompt, /不得只让对方表态/u);
      }
      return {
        id: `resp_scope_${calls}`,
        model: value.model,
        provider: "local-codex-cli",
        content: JSON.stringify({
          evaluation: {
            score: 3,
            vote: "like",
            labels: ["内容准确", "其他"],
            note: "本轮金额复核已经完成，下一层可以继续核对来源位置。",
            evidenceQuote: "金额复核已经完成",
          },
          nextPrompt: calls === 1
            ? "你对这个结果怎么看。"
            : "你把六包金额的来源页码补齐到核对表。",
          nextAttachmentNames: [],
          productAssessment: null,
        }),
        usage: {},
      };
    },
  });
  assert.equal(calls, 2);
  assert.match(result.nextPrompt, /补齐/u);
  assert.equal(result.evaluator.validationFailures.length, 1);
});

test("uses three quick retries and three six-minute retries before pausing", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    requestPromptPreflight({
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "local-codex",
        model: "gpt-codex-review-model",
        timeoutMs: 5_000,
      },
      prompt: "请继续完善对比表。",
      roundNumber: 2,
      sleepImpl: async (ms) => waits.push(ms),
      localCodexImpl: async () => {
        calls += 1;
        const error = new Error("temporarily unavailable");
        error.retryable = true;
        throw error;
      },
    }),
    (error) => error.code === "MODEL_INVOCATION_EXHAUSTED" && error.attempts.length === 7,
  );
  assert.equal(calls, 7);
  assert.deepEqual(waits, [20_000, 20_000, 20_000, 360_000, 360_000, 360_000]);
});

test("does not retry non-retryable model errors", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    requestPromptPreflight({
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "local-codex",
        model: "gpt-codex-review-model",
        timeoutMs: 5_000,
      },
      prompt: "请继续完善对比表。",
      roundNumber: 2,
      sleepImpl: async (ms) => waits.push(ms),
      localCodexImpl: async () => {
        calls += 1;
        throw new Error("unauthorized");
      },
    }),
    (error) => error.code === "MODEL_INVOCATION_FAILED" && /unauthorized/u.test(error.message),
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("an operator pause cancels model retry waiting without fallback", async () => {
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(
    requestPromptPreflight({
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "local-codex",
        model: "gpt-codex-review-model",
        timeoutMs: 5_000,
      },
      prompt: "请继续完善对比表。",
      roundNumber: 2,
      signal: controller.signal,
      sleepImpl: async () => controller.abort(new JobPauseRequestedError()),
      localCodexImpl: async () => {
        calls += 1;
        const error = new Error("temporarily unavailable");
        error.retryable = true;
        throw error;
      },
    }),
    (error) => error.code === "JOB_PAUSE_REQUESTED",
  );
  assert.equal(calls, 1);
});

test("a shared quota gate is checked before every model retry", async () => {
  let gateChecks = 0;
  let modelCalls = 0;
  await assert.rejects(
    requestPromptPreflight({
      beforeModelAttempt: async () => {
        gateChecks += 1;
        if (gateChecks > 1) {
          throw Object.assign(new Error("quota wait"), { code: "INTERACTION_QUOTA_SUSPENDED" });
        }
      },
      job: { taskGoal: "形成平台对比表" },
      policy: {
        type: "local-codex",
        model: "gpt-codex-review-model",
        timeoutMs: 5_000,
      },
      prompt: "请继续完善对比表。",
      roundNumber: 2,
      sleepImpl: async () => {},
      localCodexImpl: async () => {
        modelCalls += 1;
        const error = new Error("temporarily unavailable");
        error.retryable = true;
        throw error;
      },
    }),
    (error) => error.code === "INTERACTION_QUOTA_SUSPENDED",
  );
  assert.equal(gateChecks, 2);
  assert.equal(modelCalls, 1);
});
