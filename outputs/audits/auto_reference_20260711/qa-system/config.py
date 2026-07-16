"""
配置管理 - 所有配置从环境变量读取，插入 API Key 即可用
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# 项目根目录
ROOT_DIR = Path(__file__).parent
PARENT_DIR = ROOT_DIR.parent

# 加载 .env 文件
load_dotenv(ROOT_DIR / ".env")

# ========== DeepSeek API 配置 ==========
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "sk-your-api-key")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# ========== 文件路径配置 ==========
RULES_PATH = os.getenv("RULES_PATH", str(PARENT_DIR / "垂域高难度题目生产--二期要求.md"))
PROMPT_PATH = os.getenv("PROMPT_PATH", str(PARENT_DIR / "完整AI质检Prompt_QA_PROMPT原文_1.txt"))
CASES_PATH = os.getenv("CASES_PATH", str(PARENT_DIR / "反馈表.xlsx"))

# ========== 模型参数 ==========
TEMPERATURE = 0.1          # 低温度 = 更稳定
MAX_TOKENS = 4096
FEW_SHOT_COUNT = 3         # 每次检索的案例数

# ========== 输出配置 ==========
OUTPUT_DIR = ROOT_DIR / "output"
OUTPUT_DIR.mkdir(exist_ok=True)
