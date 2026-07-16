#!/usr/bin/env node
/**
 * 自动质检系统 - 主入口
 *
 * 用法:
 *   # 1. 初始化配置
 *   node main.js --setup
 *
 *   # 2. 单条质检
 *   node main.js --title "你的题目文本" --task-type L2
 *
 *   # 3. 批量质检（从 Excel 读取待检题目）
 *   node main.js --batch
 *
 *   # 4. 批量质检（限定数量）
 *   node main.js --batch --limit 10
 *
 *   # 5. 交互模式
 *   node main.js --interactive
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('./config');
const { QAEngine } = require('./qa_engine');
const { loadTestSet } = require('./data_loader');

// ========== 辅助函数 ==========

function checkApiKey() {
  const key = config.DEEPSEEK_API_KEY;
  if (!key || key === 'sk-your-api-key' || key === 'sk-your-deepseek-api-key-here') {
    console.log('='.repeat(60));
    console.log('❌ 请先配置 DeepSeek API Key！');
    console.log('='.repeat(60));
    console.log('');
    console.log('两种方式任选一种：');
    console.log('  1. 运行: node main.js --setup');
    console.log('  2. 编辑 qa-system/.env 文件，设置: DEEPSEEK_API_KEY=sk-xxx');
    console.log('');
    console.log('获取 API Key: https://platform.deepseek.com/api_keys');
    console.log('='.repeat(60));
    return false;
  }
  return true;
}

function parseArgs() {
  const args = {
    title: '',
    taskType: '',
    attachment: '',
    output: '',
    batch: false,
    limit: 0,
    interactive: false,
    noFewshot: false,
    quiet: false,
    setup: false,
    model: '',
  };

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--title': args.title = argv[++i] || ''; break;
      case '--task-type': args.taskType = argv[++i] || ''; break;
      case '--attachment': args.attachment = argv[++i] || ''; break;
      case '--output': args.output = argv[++i] || ''; break;
      case '--batch': args.batch = true; break;
      case '--limit': args.limit = parseInt(argv[++i]) || 0; break;
      case '--interactive': case '-i': args.interactive = true; break;
      case '--no-fewshot': args.noFewshot = true; break;
      case '--quiet': case '-q': args.quiet = true; break;
      case '--setup': args.setup = true; break;
      case '--model': args.model = argv[++i] || ''; break;
      case '--help': case '-h':
        printHelp();
        process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
🤖 自动质检系统 - 基于 DeepSeek V4 API

用法:
  node main.js [选项]

单条质检:
  node main.js --title "题目文本" --task-type L2

批量质检:
  node main.js --batch                  # 质检所有待检题目
  node main.js --batch --limit 10       # 只质检 10 条

交互模式:
  node main.js --interactive

初始化:
  node main.js --setup                  # 配置 API Key

选项:
  --title <text>       单条质检的题目文本
  --task-type <type>   任务类型 (L1/L2/L3)
  --attachment <text>  附件描述
  --output <text>      产物内容
  --batch              批量质检（从反馈表读取）
  --limit <n>          批量质检数量限制
  --interactive, -i    交互模式
  --no-fewshot         禁用 Few-Shot 案例检索（只靠规则判断）
  --quiet, -q          安静模式
  --model <name>       模型选择 (deepseek-chat / deepseek-reasoner)
  --setup              初始化配置
  --help, -h           显示帮助
`);
}

// ========== 命令实现 ==========

async function cmdSetup() {
  const envPath = path.join(__dirname, '.env');

  if (fs.existsSync(envPath)) {
    console.log(`⚠️ .env 已存在: ${envPath}`);
    const answer = await ask(`是否覆盖? (y/n): `);
    if (answer.toLowerCase() !== 'y') return;
  }

  const apiKey = await ask('请输入 DeepSeek API Key: ');
  const model = await ask('模型选择 (默认 deepseek-chat, 推理版用 deepseek-reasoner): ');
  const finalModel = model.trim() || 'deepseek-chat';

  const content = `# DeepSeek API 配置
DEEPSEEK_API_KEY=${apiKey.trim()}
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=${finalModel}

# 文件路径（一般不需要改）
RULES_PATH=../垂域高难度题目生产--二期要求.md
PROMPT_PATH=../完整AI质检Prompt_QA_PROMPT原文_1.txt
CASES_PATH=../反馈表.xlsx
`;

  fs.writeFileSync(envPath, content, 'utf-8');
  console.log(`✅ 配置文件已创建: ${envPath}`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer); });
  });
}

async function cmdSingle(args) {
  if (!checkApiKey()) return;

  const engine = new QAEngine();
  if (args.model) engine.model = args.model;

  const result = await engine.checkOne(
    args.title,
    args.taskType,
    args.attachment,
    args.output,
    !args.noFewshot
  );

  console.log('');
  console.log('='.repeat(60));
  console.log('📋 质检结果');
  console.log('='.repeat(60));

  if (result.error) {
    console.log(`❌ API 调用失败: ${result.error}`);
    return;
  }

  if (result.pass === true) {
    console.log('✅ 通过 —— 该题目无问题');
  } else if (result.pass === false) {
    console.log(`❌ 不通过 —— 发现 ${result.issues.length} 个问题：\n`);
    result.issues.forEach((issue, i) => {
      console.log(`  [${i + 1}] ${issue.category || ''} (${issue.severity || ''})`);
      console.log(`      问题: ${issue.problem || ''}`);
      console.log(`      建议: ${issue.short_note || issue.fix || ''}`);
      console.log('');
    });
  } else {
    console.log('⚠️ 结果解析失败，原始返回：');
    console.log((result.rawResponse || '').substring(0, 500));
  }

  console.log(`⏱️ 耗时: ${result.time}s | 💰 Token: ${result.tokens}`);
}

async function cmdBatch(args) {
  if (!checkApiKey()) return;

  console.log('📂 从反馈表加载待检题目...');
  const items = loadTestSet(config.CASES_PATH, args.limit);

  if (items.length === 0) {
    console.log('⚠️ 没有找到待质检的题目（所有题目都已有质检意见）');
    return;
  }

  console.log(`📋 共 ${items.length} 条待检题目\n`);

  const engine = new QAEngine();
  if (args.model) engine.model = args.model;

  const results = await engine.checkBatch(items, !args.noFewshot, !args.quiet);

  // 保存结果
  const jsonPath = path.join(config.OUTPUT_DIR, 'batch_result.json');
  engine.saveResults(results, jsonPath);

  // 生成报告
  generateReport(results, path.join(config.OUTPUT_DIR, 'batch_report.md'));
}

async function cmdInteractive(args) {
  if (!checkApiKey()) return;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log('='.repeat(60));
  console.log('🤖 自动质检系统 - 交互模式');
  console.log('   输入题目文本后按 Enter 提交质检');
  console.log('   输入 quit 退出');
  console.log('='.repeat(60));

  const engine = new QAEngine();
  if (args.model) engine.model = args.model;

  const askQ = (q) => new Promise(resolve => rl.question(q, resolve));

  while (true) {
    console.log('');
    console.log('-'.repeat(40));
    const taskType = await askQ('任务类型 (L1/L2/L3，可选): ');
    if (taskType.toLowerCase() === 'quit') break;

    const title = await askQ('题目文本: ');
    if (title.toLowerCase() === 'quit') break;

    if (!title.trim()) {
      console.log('题目为空，跳过');
      continue;
    }

    console.log('\n🔍 正在质检...');
    const result = await engine.checkOne(title, taskType);

    if (result.pass === true) {
      console.log('✅ 通过');
    } else if (result.pass === false) {
      console.log(`❌ 不通过 - ${result.issues.length} 个问题`);
      result.issues.forEach(issue => {
        console.log(`  - [${issue.category}] ${issue.problem}`);
        console.log(`    > ${issue.short_note || issue.fix || ''}`);
      });
    } else {
      console.log(`⚠️ 异常: ${result.error || (result.rawResponse || '').substring(0, 200)}`);
    }
  }

  rl.close();
}

function generateReport(results, outputPath) {
  const lines = [];
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  lines.push('# 自动质检报告');
  lines.push('');
  lines.push(`**质检时间**: ${now}`);
  lines.push(`**总数**: ${results.length}`);
  lines.push('');

  const passed = results.filter(r => r.result.pass === true).length;
  const failed = results.filter(r => r.result.pass === false).length;
  const errorCount = results.filter(r => r.result.pass === null).length;

  lines.push('| 状态 | 数量 |');
  lines.push('|------|------|');
  lines.push(`| ✅ 通过 | ${passed} |`);
  lines.push(`| ❌ 不通过 | ${failed} |`);
  lines.push(`| ⚠️ 异常 | ${errorCount} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const item of results) {
    const result = item.result;
    const status = result.pass === true ? '✅' : result.pass === false ? '❌' : '⚠️';
    lines.push(`## ${status} ${item.uid || ''}`);
    lines.push(`- **题目**: ${(item.title || '').substring(0, 200)}`);
    lines.push(`- **任务类型**: ${item.taskType || ''}`);

    if (result.issues && result.issues.length > 0) {
      lines.push('- **问题**:');
      for (const issue of result.issues) {
        lines.push(`  - ${issue.category || ''}: ${issue.problem || ''}`);
        lines.push(`    > ${issue.short_note || issue.fix || ''}`);
      }
    }

    if (result.error) {
      lines.push(`- **错误**: ${result.error}`);
    }

    lines.push(`- Token: ${result.tokens || 0} | 耗时: ${result.time || 0}s`);
    lines.push('');
  }

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
  console.log(`📄 报告已保存到: ${path.resolve(outputPath)}`);
}

// ========== 主函数 ==========

async function main() {
  const args = parseArgs();

  if (args.setup) {
    await cmdSetup();
    return;
  }

  if (args.batch) {
    await cmdBatch(args);
  } else if (args.interactive) {
    await cmdInteractive(args);
  } else if (args.title) {
    await cmdSingle(args);
  } else {
    printHelp();
    console.log('💡 提示: 使用 --batch 进行批量质检，或 --title 进行单条质检');
  }
}

main().catch(err => {
  console.error('❌ 运行出错:', err.message);
  process.exit(1);
});
