/**
 * 数据加载器 - 加载规则文档、Prompt、GoodCase/BadCase
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ========== 规则 & Prompt 加载 ==========

function loadRulesText(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`规则文档不存在: ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf-8');
}

function loadQAPrompt(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`Prompt文件不存在: ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf-8');
}

// ========== Case 加载（从 Excel 反馈表）==========

function loadCasesFromExcel(filepath) {
  /**
   * 从反馈表.xlsx 加载 GoodCase 和 BadCase
   *
   * GoodCase = 无质检意见的题目
   * BadCase = 有质检意见的题目
   *
   * Returns: { good: [...], bad: [...] }
   */
  if (!fs.existsSync(filepath)) {
    throw new Error(`反馈表不存在: ${filepath}`);
  }

  const wb = XLSX.readFile(filepath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const goodCases = [];
  const badCases = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const uid = String(row[0] || '').trim();
    const title = String(row[1] || '').trim();
    const taskType = String(row[2] || '').trim();
    const categoryL1 = String(row[3] || '').trim();
    const categoryL2 = String(row[4] || '').trim();
    const categoryL3 = String(row[5] || '').trim();
    const taskSummary = String(row[6] || '').trim();
    const attachmentDesc = String(row[9] || '').trim();
    const outputFormat = String(row[12] || '').trim();
    const expertName = String(row[16] || '').trim();
    const reviewStatus = String(row[18] || '').trim();
    const reviewOpinion = String(row[19] || '').trim();

    if (!uid || !title) continue;

    const caseItem = {
      uid,
      title: title.substring(0, 2000),
      taskType,
      category: [categoryL1, categoryL2, categoryL3].filter(Boolean).join(' > '),
      taskSummary,
      attachmentDesc: attachmentDesc.substring(0, 500),
      outputFormat,
      expertName,
    };

    if (reviewOpinion) {
      caseItem.issues = reviewOpinion;
      badCases.push(caseItem);
    } else {
      goodCases.push(caseItem);
    }
  }

  console.log(`📊 加载完成: ${goodCases.length} 条 GoodCase, ${badCases.length} 条 BadCase`);
  return { good: goodCases, bad: badCases };
}

// ========== 测试集提取 ==========

function loadTestSet(filepath, limit = 0) {
  /** 加载待质检的题目（无质检意见的） */
  const wb = XLSX.readFile(filepath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const testItems = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const uid = String(row[0] || '').trim();
    const title = String(row[1] || '').trim();
    const taskType = String(row[2] || '').trim();
    const reviewOpinion = String(row[19] || '').trim();

    if (!uid || !title) continue;

    // 只取待质检的
    if (!reviewOpinion) {
      testItems.push({
        uid,
        title: title.substring(0, 2000),
        taskType,
      });
    }

    if (limit && testItems.length >= limit) break;
  }

  return testItems;
}

module.exports = {
  loadRulesText,
  loadQAPrompt,
  loadCasesFromExcel,
  loadTestSet,
};
