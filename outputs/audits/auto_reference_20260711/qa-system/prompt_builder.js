/**
 * Prompt 组装器 - 同时使用 GoodCase 和 BadCase 做 Few-Shot
 *
 * 核心设计：
 * - GoodCase 作为"合格范例"，展示通过质检的题目长什么样
 * - BadCase 作为"踩坑警告"，展示真实违规模式
 * - 双向对比让模型更准确理解合格/不合格的边界
 * - 加反偏见指令：防止模型盲目模仿 GoodCase 或只因为比 BadCase 好就放过
 */
function formatGoodCase(caseItem, index) {
  return `### ✅ 合格范例 ${index + 1}
- **题目摘要**: ${(caseItem.title || '').substring(0, 400)}
- **任务类型**: ${caseItem.taskType || ''}
- **通过原因**: 该题目信息支撑充分、场景真实自然、产物要求适度，各方面均符合质检规范。
`;
}

function formatBadCase(caseItem, index) {
  const issues = (caseItem.issues || '').substring(0, 300);
  return `### ❌ 踩坑案例 ${index + 1}
- **题目摘要**: ${(caseItem.title || '').substring(0, 400)}
- **被打回的原因**: ${issues}
- **教训**: 以上问题模式如果在待检题目中出现，同样需要判不通过。
`;
}

function buildFullPrompt({
  basePrompt,
  title,
  taskType,
  attachmentDetails = '',
  output = '',
  goodCases = [],
  badCases = [],
}) {
  // ===== 同时使用 GoodCase 和 BadCase =====
  const fewShotParts = [];

  // -- GoodCase：展示什么是对的 --
  if (goodCases.length > 0) {
    fewShotParts.push(`
## ✅ 参考：以下是真实通过质检的合格题目
**这些案例展示了符合规范的题目长什么样。它们信息支撑充分、场景真实、产物要求合理，因此通过了质检。**
**注意：待检题目的内容/领域与这些范例不同是正常的，不能因此扣分。你只需要参考它们的"规范性"水平。**

`);
    goodCases.forEach((c, i) => {
      fewShotParts.push(formatGoodCase(c, i));
    });
  }

  // -- BadCase：展示什么是错的 --
  if (badCases.length > 0) {
    fewShotParts.push(`
## ❌ 重要：以下是真实被质检打回的题目案例
**这些案例展示了必须判不通过的典型违规模式。如果待检题目出现同类问题，必须报错，不要手软。**

`);
    badCases.forEach((c, i) => {
      fewShotParts.push(formatBadCase(c, i));
    });
  }

  // 双向反偏见指令
  if (goodCases.length > 0 || badCases.length > 0) {
    fewShotParts.push(`
---
**关键提醒（非常重要）**：
1. ${goodCases.length > 0 ? '✅ GoodCase 展示的是"合格标准"——待检题目需要在规范性上达到同等水平才算通过。' : ''}
2. ${badCases.length > 0 ? '❌ BadCase 展示的是"红线"——待检题目中出现同类违规必须判不通过。' : ''}
3. 不要因为待检题目「看起来比 BadCase 好一点」就放过 —— 只要有同类违规就必须报
4. 也不要因为待检题目「写得长/看起来专业」就默认通过 —— 长不等于合格
5. ${goodCases.length > 0 ? 'GoodCase 的领域/内容与待检题目不同是正常的——不要因为内容不同而扣分，只比较"规范性"。' : ''}
6. 记住：规则是硬约束，不是软建议。命中"必须判错"的条目一定要报。
`);
  }

  const fewShotText = fewShotParts.join('');

  // ===== 构建用户输入（待检数据）=====
  const userInput = `【待检数据】
任务类型：${taskType}

【规则2/3唯一可检查文本：题目字段】
<TITLE_FIELD>
${title}
</TITLE_FIELD>

【参考信息：只能用于理解任务和判断附件/数据是否支撑任务】
附件原文摘录：${attachmentDetails || '（空）'}
产物内容列：${output || '（空）'}
`;

  return {
    system: basePrompt + fewShotText,
    user: userInput,
  };
}

module.exports = { buildFullPrompt };
