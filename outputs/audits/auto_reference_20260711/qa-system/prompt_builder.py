"""
Prompt 组装器 - 将规则、GoodCase、BadCase 组装进 Prompt
"""
from typing import List, Dict


def format_rules_compact(rules: List[Dict]) -> str:
    """将结构化规则格式化为精简文本（给模型看的）"""
    lines = []
    for r in rules:
        severity_tag = {"严重": "🔴", "中等": "🟡", "轻微": "🟢"}.get(r["severity"], "")
        lines.append(f"{r['id']}. [{r['severity']}] {r['title']}")
        # 核心判断标准
        detail = r["detail"]
        # 提取关键句
        if len(detail) > 300:
            detail = detail[:300] + "..."
        lines.append(f"   {detail}")
    return "\n".join(lines)


def format_good_case(case: Dict, index: int) -> str:
    """格式化一条 GoodCase"""
    return f"""### 通过案例 {index + 1}
- **任务类型**: {case.get('task_type', '')}
- **领域**: {case.get('category', '')}
- **题目**: {case['title'][:800]}
- **判定**: ✅ 通过 —— 此题目真实、信息充分、可执行，无违规项
"""


def format_bad_case(case: Dict, index: int) -> str:
    """格式化一条 BadCase"""
    issues = case.get("issues", "")
    return f"""### 不通过案例 {index + 1}
- **任务类型**: {case.get('task_type', '')}
- **领域**: {case.get('category', '')}
- **题目**: {case['title'][:800]}
- **判定**: ❌ 不通过 —— 问题如下：
  {issues[:400]}
"""


def build_full_prompt(
    base_prompt: str,
    title: str,
    task_type: str,
    attachment_details: str = "",
    output: str = "",
    good_cases: List[Dict] = None,
    bad_cases: List[Dict] = None,
) -> str:
    """
    组装完整的质检 Prompt

    结构:
    1. System: 基础质检 Prompt（你的原文）
    2. Few-Shot: GoodCase + BadCase
    3. User: 待检数据
    """
    good_cases = good_cases or []
    bad_cases = bad_cases or []

    # ===== 构建 Few-Shot 部分 =====
    few_shot_parts = []

    if good_cases:
        few_shot_parts.append("## 📗 参考——正确通过的题目（你的判断应与此一致）\n")
        for i, case in enumerate(good_cases):
            few_shot_parts.append(format_good_case(case, i))

    if bad_cases:
        few_shot_parts.append("\n## 📕 参考——被判定不通过的题目（注意同类问题）\n")
        for i, case in enumerate(bad_cases):
            few_shot_parts.append(format_bad_case(case, i))

    few_shot_text = "\n".join(few_shot_parts) if few_shot_parts else ""

    # ===== 构建用户输入（待检数据）=====
    user_input = f"""【待检数据】
任务类型：{task_type}

【规则2/3唯一可检查文本：题目字段】
<TITLE_FIELD>
{title}
</TITLE_FIELD>

【参考信息：只能用于理解任务和判断附件/数据是否支撑任务】
附件原文摘录：{attachment_details or "（空）"}
产物内容列：{output or "（空）"}
"""

    # ===== 组装最终 Prompt =====
    # System = 基础规则 + Few-Shot
    system_content = base_prompt

    if few_shot_text:
        system_content += f"\n\n{few_shot_text}"

    return {
        "system": system_content,
        "user": user_input,
    }


def estimate_tokens(text: str) -> int:
    """估算 token 数（中文字符约 1.5 token/字，英文约 0.3 token/字）"""
    chinese_chars = len([c for c in text if '一' <= c <= '鿿'])
    other_chars = len(text) - chinese_chars
    return int(chinese_chars * 1.5 + other_chars * 0.3)
