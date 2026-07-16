#!/usr/bin/env python3
"""
自动质检系统 - 主入口
用法:
    # 1. 设置 API Key（二选一）
    #    方式A: 复制 .env.example 为 .env，填入你的 DeepSeek API Key
    #    方式B: 设置环境变量 export DEEPSEEK_API_KEY=sk-xxx

    # 2. 单条质检
    python main.py --title "你的题目文本" --task-type L2

    # 3. 批量质检（从 Excel 读取待检题目）
    python main.py --batch

    # 4. 批量质检（限定数量）
    python main.py --batch --limit 10

    # 5. 从文件读取题目质检
    python main.py --file test_questions.txt

    # 6. 交互模式
    python main.py --interactive
"""
import sys
import os
import argparse
import json
from pathlib import Path

# 确保能导入同目录模块
sys.path.insert(0, str(Path(__file__).parent))

from config import (
    DEEPSEEK_API_KEY, RULES_PATH, PROMPT_PATH, CASES_PATH, OUTPUT_DIR
)
from qa_engine import QAEngine


def check_api_key():
    """检查 API Key 是否已配置"""
    if DEEPSEEK_API_KEY in ("sk-your-api-key", "sk-your-deepseek-api-key-here", ""):
        print("=" * 60)
        print("❌ 请先配置 DeepSeek API Key！")
        print("=" * 60)
        print("\n两种方式任选一种：")
        print("  1. 编辑 qa-system/.env 文件，设置: DEEPSEEK_API_KEY=sk-xxx")
        print("  2. 设置环境变量: set DEEPSEEK_API_KEY=sk-xxx")
        print("\n获取 API Key: https://platform.deepseek.com/api_keys")
        print("=" * 60)
        return False
    return True


def cmd_single(args):
    """单条质检"""
    if not check_api_key():
        return

    engine = QAEngine(prompt_path=PROMPT_PATH, cases_path=CASES_PATH)

    result = engine.check_one(
        title=args.title,
        task_type=args.task_type or "",
        attachment_details=args.attachment or "",
        output=args.output or "",
        use_few_shot=not args.no_fewshot,
    )

    print("\n" + "=" * 60)
    print("📋 质检结果")
    print("=" * 60)

    if result.get("error"):
        print(f"❌ API 调用失败: {result['error']}")
        return

    if result["pass"]:
        print("✅ 通过 —— 该题目无问题")
    elif result["pass"] is False:
        print(f"❌ 不通过 —— 发现 {len(result['issues'])} 个问题：\n")
        for i, issue in enumerate(result["issues"], 1):
            print(f"  [{i}] {issue.get('category', '')} ({issue.get('severity', '')})")
            print(f"      问题: {issue.get('problem', '')}")
            print(f"      建议: {issue.get('short_note', issue.get('fix', ''))}")
            print()
    else:
        print("⚠️ 结果解析失败，原始返回：")
        print(result.get("raw_response", "")[:500])

    print(f"⏱️ 耗时: {result['time']}s | 💰 Token: {result['tokens']}")


def cmd_batch(args):
    """批量质检"""
    if not check_api_key():
        return

    from data_loader import load_test_set

    print(f"📂 从反馈表加载待检题目...")
    items = load_test_set(CASES_PATH, limit=args.limit)

    if not items:
        print("⚠️ 没有找到待质检的题目（所有题目都已有质检意见）")
        return

    print(f"📋 共 {len(items)} 条待检题目\n")

    engine = QAEngine(prompt_path=PROMPT_PATH, cases_path=CASES_PATH)

    results = engine.check_batch(
        items,
        use_few_shot=not args.no_fewshot,
        verbose=not args.quiet,
    )

    # 保存结果
    output_path = OUTPUT_DIR / "batch_result.json"
    engine.save_results(results, str(output_path))

    # 同时生成可读报告
    from data_loader import load_cases_from_excel
    _generate_report(results, OUTPUT_DIR / "batch_report.md")


def cmd_interactive(args):
    """交互模式"""
    if not check_api_key():
        return

    print("\n" + "=" * 60)
    print("🤖 自动质检系统 - 交互模式")
    print("   输入题目文本，按 Enter 后 Ctrl+D (Unix) 或 Ctrl+Z (Win) 提交")
    print("   输入 'quit' 退出")
    print("=" * 60)

    engine = QAEngine(prompt_path=PROMPT_PATH, cases_path=CASES_PATH)

    while True:
        print("\n" + "-" * 40)
        task_type = input("任务类型 (L1/L2/L3，可选): ").strip()

        if task_type.lower() == "quit":
            break

        print("题目文本（支持多行，输入 'done' 结束）:")
        lines = []
        while True:
            try:
                line = input()
            except EOFError:
                break
            if line.strip() == "done":
                break
            lines.append(line)

        title = "\n".join(lines)
        if not title.strip():
            print("题目为空，跳过")
            continue

        print("\n🔍 正在质检...")
        result = engine.check_one(title=title, task_type=task_type)

        if result.get("pass"):
            print("✅ 通过")
        elif result.get("pass") is False:
            print(f"❌ 不通过 - {len(result['issues'])} 个问题")
            for issue in result["issues"]:
                print(f"  - {issue.get('problem', '')}")
        else:
            print(f"⚠️ 解析异常: {result.get('raw_response', '')[:300]}")


def _generate_report(results: list, output_path: str):
    """生成可读的 Markdown 报告"""
    lines = [
        "# 自动质检报告",
        "",
        f"**质检时间**: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"**总数**: {len(results)}",
        "",
        f"| 状态 | 数量 |",
        f"|------|------|",
    ]

    passed = sum(1 for r in results if r["result"].get("pass"))
    failed = sum(1 for r in results if r["result"].get("pass") is False)
    error_count = sum(1 for r in results if r["result"].get("pass") is None)

    lines.append(f"| ✅ 通过 | {passed} |")
    lines.append(f"| ❌ 不通过 | {failed} |")
    lines.append(f"| ⚠️ 异常 | {error_count} |")
    lines.append("")
    lines.append("---")
    lines.append("")

    for item in results:
        result = item["result"]
        status = "✅" if result.get("pass") else ("❌" if result.get("pass") is False else "⚠️")
        lines.append(f"## {status} {item.get('uid', '')}")
        lines.append(f"- **题目**: {item.get('title', '')[:200]}")
        lines.append(f"- **任务类型**: {item.get('task_type', '')}")

        if result.get("issues"):
            lines.append("- **问题**:")
            for issue in result["issues"]:
                lines.append(f"  - {issue.get('category', '')}: {issue.get('problem', '')}")
                lines.append(f"    > {issue.get('short_note', issue.get('fix', ''))}")

        if result.get("error"):
            lines.append(f"- **错误**: {result['error']}")

        lines.append(f"- Token: {result.get('tokens', 0)} | 耗时: {result.get('time', 0)}s")
        lines.append("")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"📄 报告已保存到: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="🤖 自动质检系统 - 基于 DeepSeek V4 API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python main.py --title "帮我制定一份旅游计划" --task-type L1
  python main.py --batch --limit 5
  python main.py --interactive
        """
    )

    # 单条质检
    parser.add_argument("--title", type=str, help="单条质检：题目文本")
    parser.add_argument("--task-type", type=str, default="", help="任务类型 (L1/L2/L3)")
    parser.add_argument("--attachment", type=str, default="", help="附件描述")
    parser.add_argument("--output", type=str, default="", help="产物内容")

    # 批量质检
    parser.add_argument("--batch", action="store_true", help="批量质检：从反馈表读取待检题目")
    parser.add_argument("--limit", type=int, default=0, help="批量质检数量限制（0=全部）")

    # 交互模式
    parser.add_argument("--interactive", "-i", action="store_true", help="交互模式")

    # 选项
    parser.add_argument("--no-fewshot", action="store_true", help="禁用 Few-Shot 案例检索")
    parser.add_argument("--quiet", "-q", action="store_true", help="安静模式（批量时不打印进度）")
    parser.add_argument("--model", type=str, default="", help="覆盖模型选择")

    # 配置
    parser.add_argument("--setup", action="store_true", help="初始化 .env 配置文件")

    args = parser.parse_args()

    if args.setup:
        _setup_env()
        return

    # 检查模型覆盖
    if args.model:
        import config
        config.DEEPSEEK_MODEL = args.model

    if args.batch:
        cmd_batch(args)
    elif args.interactive:
        cmd_interactive(args)
    elif args.title:
        cmd_single(args)
    else:
        parser.print_help()
        print("\n💡 提示: 使用 --batch 进行批量质检，或 --title 进行单条质检")


def _setup_env():
    """创建 .env 配置文件"""
    env_path = Path(__file__).parent / ".env"
    example_path = Path(__file__).parent / ".env.example"

    if env_path.exists():
        print(f"⚠️ .env 已存在: {env_path}")
        overwrite = input("是否覆盖? (y/n): ").strip().lower()
        if overwrite != "y":
            return

    api_key = input("请输入 DeepSeek API Key: ").strip()
    model = input("模型选择 (默认 deepseek-chat, 推理版用 deepseek-reasoner): ").strip()
    if not model:
        model = "deepseek-chat"

    with open(env_path, "w", encoding="utf-8") as f:
        f.write(f"""# DeepSeek API 配置
DEEPSEEK_API_KEY={api_key}
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL={model}

# 文件路径
RULES_PATH=../垂域高难度题目生产--二期要求.md
PROMPT_PATH=../完整AI质检Prompt_QA_PROMPT原文_1.txt
CASES_PATH=../反馈表.xlsx
""")
    print(f"✅ 配置文件已创建: {env_path}")


if __name__ == "__main__":
    main()
