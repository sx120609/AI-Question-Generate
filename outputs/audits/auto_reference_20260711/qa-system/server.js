/**
 * 自动质检系统 - Web 服务器
 * 提供可视化界面和 REST API
 *
 * 启动: node server.js
 * 访问: http://localhost:3456
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { QAEngine } = require('./qa_engine');
const { loadTestSet, loadCasesFromExcel } = require('./data_loader');

const app = express();
const PORT = process.env.PORT || 3456;

// 中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'web')));

// ========== API 路由 ==========

// --- 首页仪表盘数据 ---
app.get('/api/dashboard', (req, res) => {
  try {
    const cases = loadCasesFromExcel(config.CASES_PATH);
    const testSet = loadTestSet(config.CASES_PATH, 0);

    // 读取最近的批量结果
    let lastBatch = null;
    const resultPath = path.join(config.OUTPUT_DIR, 'batch_result.json');
    if (fs.existsSync(resultPath)) {
      try {
        lastBatch = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      } catch {}
    }

    res.json({
      totalCases: cases.good.length + cases.bad.length,
      goodCount: cases.good.length,
      badCount: cases.bad.length,
      pendingCount: testSet.length,
      lastBatch: lastBatch ? {
        time: fs.statSync(resultPath).mtime.toISOString(),
        total: lastBatch.length,
        passed: lastBatch.filter(r => r.pass === true).length,
        failed: lastBatch.filter(r => r.pass === false).length,
      } : null,
      model: config.DEEPSEEK_MODEL,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 案例列表（分页） ---
app.get('/api/cases', (req, res) => {
  try {
    const type = req.query.type || 'all'; // all | good | bad | pending
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const search = (req.query.search || '').toLowerCase();

    const cases = loadCasesFromExcel(config.CASES_PATH);

    let allCases = [];
    cases.good.forEach(c => { c.caseType = 'good'; allCases.push(c); });
    cases.bad.forEach(c => { c.caseType = 'bad'; allCases.push(c); });

    // 筛选
    let filtered = allCases;
    if (type === 'good') filtered = cases.good.map(c => ({ ...c, caseType: 'good' }));
    else if (type === 'bad') filtered = cases.bad.map(c => ({ ...c, caseType: 'bad' }));
    else if (type === 'pending') filtered = cases.good.map(c => ({ ...c, caseType: 'pending' }));

    if (search) {
      filtered = filtered.filter(c =>
        (c.uid || '').toLowerCase().includes(search) ||
        (c.title || '').toLowerCase().includes(search) ||
        (c.taskType || '').toLowerCase().includes(search) ||
        (c.issues || '').toLowerCase().includes(search)
      );
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    res.json({
      items,
      page,
      pageSize,
      total,
      totalPages,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 单条质检 ---
app.post('/api/qa/single', async (req, res) => {
  const { title, taskType, attachment, output, useFewShot } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: '题目内容不能为空' });
  }

  try {
    const engine = new QAEngine();
    const result = await engine.checkOne(
      title.trim(),
      taskType || '',
      attachment || '',
      output || '',
      useFewShot !== false
    );

    res.json({
      uid: 'single-' + Date.now(),
      title: title.trim().substring(0, 200),
      taskType: taskType || '',
      pass: result.pass,
      issues: result.issues,
      tokens: result.tokens,
      time: result.time,
      error: result.error,
      rawResponse: result.rawResponse,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 批量质检 ---
app.post('/api/qa/batch', async (req, res) => {
  const { limit, ids, useFewShot } = req.body;

  try {
    let items = loadTestSet(config.CASES_PATH, 0);

    if (ids && ids.length > 0) {
      items = items.filter(item => ids.includes(item.uid));
    }
    if (limit && limit > 0) {
      items = items.slice(0, limit);
    }

    if (items.length === 0) {
      return res.json({ message: '没有待质检的题目', results: [] });
    }

    const engine = new QAEngine();

    // 保存到文件
    const jsonPath = path.join(config.OUTPUT_DIR, 'batch_result.json');
    if (!fs.existsSync(config.OUTPUT_DIR)) {
      fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
    }

    const results = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const result = await engine.checkOne(
        item.title,
        item.taskType || '',
        '',
        '',
        useFewShot !== false
      );

      const formatted = {
        uid: item.uid,
        title: (item.title || '').substring(0, 200),
        taskType: item.taskType || '',
        pass: result.pass,
        issues: result.issues,
        tokens: result.tokens,
        time: result.time,
        error: result.error,
      };
      results.push(formatted);
    }

    // 保存
    engine.saveResults(
      items.map((item, i) => ({ ...item, result: results[i] })),
      jsonPath
    );

    const passed = results.filter(r => r.pass === true).length;
    const failed = results.filter(r => r.pass === false).length;
    const errors = results.filter(r => r.pass === null).length;

    res.json({
      total: results.length,
      passed,
      failed,
      errors,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 查看历史批量结果 ---
app.get('/api/qa/results', (req, res) => {
  try {
    const resultPath = path.join(config.OUTPUT_DIR, 'batch_result.json');
    if (!fs.existsSync(resultPath)) {
      return res.json({ results: [], time: null });
    }

    const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    const stat = fs.statSync(resultPath);

    // 检查单个文件结果
    const outputDir = config.OUTPUT_DIR;
    const individualResults = [];
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir).filter(f => f.startsWith('result_') && f.endsWith('.json'));
      for (const f of files) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(outputDir, f), 'utf-8'));
          individualResults.push(content);
        } catch {}
      }
    }

    res.json({
      results: data,
      individualResults,
      time: stat.mtime.toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 获取规则和 Prompt 摘要 ---
app.get('/api/config', (req, res) => {
  try {
    const promptPath = config.PROMPT_PATH;
    const rulesPath = config.RULES_PATH;

    let promptPreview = '';
    let rulesPreview = '';

    if (fs.existsSync(promptPath)) {
      promptPreview = fs.readFileSync(promptPath, 'utf-8').substring(0, 2000);
    }
    if (fs.existsSync(rulesPath)) {
      rulesPreview = fs.readFileSync(rulesPath, 'utf-8').substring(0, 2000);
    }

    res.json({
      model: config.DEEPSEEK_MODEL,
      fewShotCount: config.FEW_SHOT_COUNT,
      temperature: config.TEMPERATURE,
      maxTokens: config.MAX_TOKENS,
      promptPreview,
      rulesPreview,
      promptFile: config.PROMPT_PATH,
      rulesFile: config.RULES_PATH,
      casesFile: config.CASES_PATH,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 启动 ---
app.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(60));
  console.log('  🤖 自动质检系统 - Web 界面');
  console.log(`  地址: http://localhost:${PORT}`);
  console.log('='.repeat(60));
  console.log('');
  console.log('  功能:');
  console.log('  - 📊 仪表盘: 查看案例统计');
  console.log('  - 🔍 单条质检: 手动输入题目进行质检');
  console.log('  - 📦 批量质检: 批量验收反馈表中的待检题目');
  console.log('  - 📋 案例浏览: 查看 GoodCase 和 BadCase');
  console.log('  - 📈 质检记录: 查看历史质检结果');
  console.log('');
  console.log(`  按 Ctrl+C 停止服务器`);
  console.log('='.repeat(60));
});
