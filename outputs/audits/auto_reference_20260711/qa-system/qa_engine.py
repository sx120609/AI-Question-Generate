"""
质检引擎 - 调用 DeepSeek V4 API 执行质检
"""
import json
import time
from typing import List, Dict, Optional
from pathlib import Path

from openai import OpenAI

from config import (
    DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL,
    TEMPERATURE, MAX_TOKENS, FEW_SHOT_COUNT,
)
from data_loader import load_qa_prompt, load_cases_from_excel
from case_retriever import CaseRetriever
from prompt_builder import build_full_prompt, estimate_tokens


class QAEngine:
    """自动质检引擎"""

    def __init__(
        self,
        api_key: str = None,
        base_url: str = None,
        model: str = None,
        prompt_path: str = None,
        cases_path: str = None,
    ):
        self.api_key = api_key or DEEPSEEK_API_KEY
        self.base_url = base_url or DEEPSEEK_BASE_URL
        self.model = model or DEEPSEEK_MODEL

        # 初始化 DeepSeek 客户端（兼容 OpenAI SDK）
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
        )

        # 加载基础 Prompt
        self.base_prompt = ""
        if prompt_path:
            self.base_prompt = load_qa_prompt(prompt_path)

        # 加载案例 & 构建检索器
        self.case_retriever: Optional[CaseRetriever] = None
        if cases_path:
            cases = load_cases_from_excel(cases_path)
            self.case_retriever = CaseRetriever(
                good_cases=cases["good"],
                bad_cases=cases["bad"],
            ).build_index()

        self.call_count = 0
        self.total_tokens = 0

    def check_one(
        self,
        title: str,
        task_type: str = "",
        attachment_details: str = "",
        output: str = "",
        use_few_shot: bool = True,
    ) -> Dict:
        """
        对一条题目进行质检

        Args:
            title: 题目文本
            task_type: 任务类型 (L1/L2/L3)
            attachment_details: 附件描述
            output: 产物内容
            use_few_shot: 是否启用 Few-Shot 案例

        Returns:
            {"pass": True/False, "issues": [...], "raw_response": "...", "tokens": N, "time": N}
        """
        # 1. 检索相关案例
        good_cases, bad_cases = [], []
        if use_few_shot and self.case_retriever:
            good_cases, bad_cases = self.case_retriever.retrieve(
                title, top_k=FEW_SHOT_COUNT
            )

        # 2. 组装 Prompt
        prompt = build_full_prompt(
            base_prompt=self.base_prompt,
            title=title,
            task_type=task_type,
            attachment_details=attachment_details,
            output=output,
            good_cases=good_cases,
            bad_cases=bad_cases,
        )

        # 3. 估算 token
        estimated = estimate_tokens(prompt["system"] + prompt["user"])
        print(f"  📝 预估 token: ~{estimated} | GoodCase: {len(good_cases)} | BadCase: {len(bad_cases)}")

        # 4. 调用 DeepSeek API
        start_time = time.time()

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": prompt["system"]},
                    {"role": "user", "content": prompt["user"]},
                ],
                temperature=TEMPERATURE,
                max_tokens=MAX_TOKENS,
                response_format={"type": "json_object"},
            )
        except Exception as e:
            return {
                "pass": None,
                "issues": [],
                "error": str(e),
                "raw_response": "",
                "tokens": 0,
                "time": time.time() - start_time,
            }

        elapsed = time.time() - start_time
        raw = response.choices[0].message.content

        # 5. 解析结果
        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            # 尝试从 Markdown 代码块中提取
            raw_clean = raw
            if "```json" in raw:
                raw_clean = raw.split("```json")[1].split("```")[0]
            elif "```" in raw:
                raw_clean = raw.split("```")[1].split("```")[0]
            try:
                result = json.loads(raw_clean)
            except json.JSONDecodeError:
                result = {"pass": None, "issues": [], "parse_error": True}

        # 6. 统计
        usage = response.usage
        tokens_used = usage.total_tokens if usage else estimated
        self.call_count += 1
        self.total_tokens += tokens_used

        return {
            "pass": result.get("pass"),
            "issues": result.get("issues", []),
            "raw_response": raw,
            "tokens": tokens_used,
            "time": round(elapsed, 2),
        }

    def check_batch(
        self,
        items: List[Dict],
        use_few_shot: bool = True,
        verbose: bool = True,
    ) -> List[Dict]:
        """
        批量质检

        Args:
            items: [{"uid": "...", "title": "...", "task_type": "..."}, ...]
            use_few_shot: 是否启用 Few-Shot
            verbose: 是否打印进度

        Returns:
            每条加上质检结果的列表
        """
        results = []
        total = len(items)

        for i, item in enumerate(items):
            uid = item.get("uid", f"item-{i}")
            title = item.get("title", "")
            task_type = item.get("task_type", "")
            attachment_details = item.get("attachment_details", "")
            output = item.get("output", "")

            if verbose:
                print(f"\n{'='*60}")
                print(f"[{i+1}/{total}] {uid}")
                print(f"  题目: {title[:80]}...")

            result = self.check_one(
                title=title,
                task_type=task_type,
                attachment_details=attachment_details,
                output=output,
                use_few_shot=use_few_shot,
            )

            item["result"] = result
            results.append(item)

            if verbose:
                status = "✅ 通过" if result.get("pass") else ("❌ 不通过" if result.get("pass") is False else "⚠️ 解析失败")
                issues_count = len(result.get("issues", []))
                print(f"  {status} | 问题数: {issues_count} | 耗时: {result['time']}s | Token: {result['tokens']}")

            # 避免请求过快
            if i < total - 1:
                time.sleep(0.5)

        if verbose:
            passed = sum(1 for r in results if r["result"].get("pass") is True)
            failed = sum(1 for r in results if r["result"].get("pass") is False)
            print(f"\n{'='*60}")
            print(f"📊 批量质检完成: {passed} 通过, {failed} 不通过, {total - passed - failed} 异常")
            print(f"💰 总 Token: {self.total_tokens}")

        return results

    def save_results(self, results: List[Dict], output_path: str):
        """保存结果到 JSON"""
        output = []
        for item in results:
            output.append({
                "uid": item.get("uid"),
                "title": item.get("title", "")[:200],
                "task_type": item.get("task_type"),
                "pass": item["result"].get("pass"),
                "issues": item["result"].get("issues", []),
                "tokens": item["result"].get("tokens"),
                "time": item["result"].get("time"),
                "error": item["result"].get("error"),
            })

        path = Path(output_path)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        print(f"💾 结果已保存到: {path.absolute()}")
