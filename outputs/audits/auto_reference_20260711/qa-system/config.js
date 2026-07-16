/**
 * 配置管理 - 所有配置从环境变量读取，插入 API Key 即可用
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ROOT_DIR = __dirname;
const PARENT_DIR = path.dirname(ROOT_DIR);

module.exports = {
  // ========== DeepSeek API 配置 ==========
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || 'sk-your-api-key',
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat',

  // ========== 文件路径配置 ==========
  RULES_PATH: process.env.RULES_PATH || path.join(PARENT_DIR, '垂域高难度题目生产--二期要求.md'),
  PROMPT_PATH: process.env.PROMPT_PATH || path.join(PARENT_DIR, '完整AI质检Prompt_QA_PROMPT原文_1.txt'),
  CASES_PATH: process.env.CASES_PATH || path.join(PARENT_DIR, '反馈表.xlsx'),

  // ========== 模型参数 ==========
  TEMPERATURE: 0.1,
  MAX_TOKENS: 4096,
  FEW_SHOT_COUNT: 3,

  // ========== 输出配置 ==========
  OUTPUT_DIR: path.join(ROOT_DIR, 'output'),
};
