/**
 * 质检引擎 - 调用 DeepSeek V4 API 执行质检
 */
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const config = require('./config');
const { loadQAPrompt, loadCasesFromExcel } = require('./data_loader');
const { CaseRetriever } = require('./case_retriever');
const { buildFullPrompt } = require('./prompt_builder');

class QAEngine {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || config.DEEPSEEK_API_KEY;
    this.baseURL = opts.baseURL || config.DEEPSEEK_BASE_URL;
    this.model = opts.model || config.DEEPSEEK_MODEL;
    this.promptPath = opts.promptPath || config.PROMPT_PATH;
    this.casesPath = opts.casesPath || config.CASES_PATH;

    // 初始化 OpenAI 客户端（DeepSeek 兼容）
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    });

    // 加载基础 Prompt
    this.basePrompt = '';
    try {
      this.basePrompt = loadQAPrompt(this.promptPath);
    } catch (e) {
      console.warn('⚠️ 无法加载 Prompt 文件:', e.message);
    }

    // 加载案例 & 构建检索器
    this.caseRetriever = null;
    try {
      const cases = loadCasesFromExcel(this.casesPath);
      this.caseRetriever = new CaseRetriever(cases.good, cases.bad).buildIndex();
    } catch (e) {
      console.warn('⚠️ 无法加载案例文件:', e.message);
    }

    this.callCount = 0;
    this.totalTokens = 0;
  }

  async checkOne(title, taskType = '', attachmentDetails = '', output = '', useFewShot = true) {
    /**
     * 对一条题目进行质检
     * Returns: { pass, issues, rawResponse, tokens, time, error? }
     */
    // 1. 检索 GoodCase 和 BadCase
    let goodCases = [];
    let badCases = [];
    if (useFewShot && this.caseRetriever) {
      goodCases = this.caseRetriever.retrieveGood(title, config.FEW_SHOT_COUNT);
      badCases = this.caseRetriever.retrieveBad(title, config.FEW_SHOT_COUNT);
    }

    // 2. 组装 Prompt
    const prompt = buildFullPrompt({
      basePrompt: this.basePrompt,
      title,
      taskType,
      attachmentDetails,
      output,
      goodCases,
      badCases,
    });

    console.log(`  📝 GoodCase: ${goodCases.length} | BadCase: ${badCases.length}`);

    // 3. 调用 DeepSeek API
    const startTime = Date.now();

    let response;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: config.TEMPERATURE,
        max_tokens: config.MAX_TOKENS,
        response_format: { type: 'json_object' },
      });
    } catch (e) {
      return {
        pass: null,
        issues: [],
        error: e.message,
        rawResponse: '',
        tokens: 0,
        time: (Date.now() - startTime) / 1000,
      };
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const raw = response.choices[0].message.content;

    // 4. 解析结果
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      // 尝试从 Markdown 代码块中提取
      let rawClean = raw;
      if (raw.includes('```json')) {
        rawClean = raw.split('```json')[1].split('```')[0];
      } else if (raw.includes('```')) {
        rawClean = raw.split('```')[1].split('```')[0];
      }
      try {
        result = JSON.parse(rawClean);
      } catch {
        result = { pass: null, issues: [], parseError: true };
      }
    }

    // 5. 统计
    const tokensUsed = response.usage ? response.usage.total_tokens : 0;
    this.callCount += 1;
    this.totalTokens += tokensUsed;

    return {
      pass: result.pass,
      issues: result.issues || [],
      rawResponse: raw,
      tokens: tokensUsed,
      time: Math.round(elapsed * 100) / 100,
    };
  }

  async checkBatch(items, useFewShot = true, verbose = true) {
    /** 批量质检 */
    const results = [];
    const total = items.length;

    for (let i = 0; i < total; i++) {
      const item = items[i];
      const uid = item.uid || `item-${i}`;

      if (verbose) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[${i + 1}/${total}] ${uid}`);
        console.log(`  题目: ${(item.title || '').substring(0, 80)}...`);
      }

      const result = await this.checkOne(
        item.title || '',
        item.taskType || '',
        item.attachmentDetails || '',
        item.output || '',
        useFewShot
      );

      item.result = result;
      results.push(item);

      if (verbose) {
        const status = result.pass === true ? '✅ 通过'
          : result.pass === false ? '❌ 不通过'
          : '⚠️ 异常';
        console.log(`  ${status} | 问题: ${result.issues.length} | 耗时: ${result.time}s | Token: ${result.tokens}`);
      }

      // 避免请求过快
      if (i < total - 1) {
        await sleep(500);
      }
    }

    if (verbose) {
      const passed = results.filter(r => r.result.pass === true).length;
      const failed = results.filter(r => r.result.pass === false).length;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📊 批量质检完成: ${passed} 通过, ${failed} 不通过, ${total - passed - failed} 异常`);
      console.log(`💰 总 Token: ${this.totalTokens}`);
    }

    return results;
  }

  saveResults(results, outputPath) {
    const output = results.map(item => ({
      uid: item.uid,
      title: (item.title || '').substring(0, 200),
      taskType: item.taskType,
      pass: item.result.pass,
      issues: item.result.issues,
      tokens: item.result.tokens,
      time: item.result.time,
      error: item.result.error,
    }));

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`💾 结果已保存到: ${path.resolve(outputPath)}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { QAEngine };
