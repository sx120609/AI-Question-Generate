"""
案例检索器 - 使用 BM25 + jieba 分词找到最相关的 GoodCase/BadCase
"""
import re
import math
from typing import List, Dict, Tuple
from collections import Counter

try:
    import jieba
    HAS_JIEBA = True
except ImportError:
    HAS_JIEBA = False


class BM25Retriever:
    """简易 BM25 检索器，无需额外依赖即可运行"""

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.documents: List[str] = []
        self.doc_tokens: List[List[str]] = []
        self.doc_freq: Counter = Counter()
        self.avg_doc_len: float = 0
        self.total_docs: int = 0

    def tokenize(self, text: str) -> List[str]:
        """分词"""
        # 清理文本
        text = re.sub(r'[^一-龥a-zA-Z0-9]', ' ', text)

        if HAS_JIEBA:
            tokens = list(jieba.cut(text))
        else:
            # 简易分词：中文按字符，英文按空格
            tokens = []
            for chunk in text.split():
                if re.search(r'[一-龥]', chunk):
                    tokens.extend(list(chunk))
                else:
                    tokens.append(chunk.lower())
            tokens = [t for t in tokens if len(t.strip()) > 1]

        return [t.strip().lower() for t in tokens if t.strip() and len(t.strip()) > 1]

    def fit(self, documents: List[str]):
        """构建索引"""
        self.documents = documents
        self.doc_tokens = [self.tokenize(doc) for doc in documents]
        self.total_docs = len(documents)

        # 计算文档频率
        self.doc_freq = Counter()
        for tokens in self.doc_tokens:
            unique_tokens = set(tokens)
            for token in unique_tokens:
                self.doc_freq[token] += 1

        # 平均文档长度
        total_len = sum(len(tokens) for tokens in self.doc_tokens)
        self.avg_doc_len = total_len / max(self.total_docs, 1)

    def score(self, query: str, doc_idx: int) -> float:
        """计算 query 与文档的 BM25 分数"""
        query_tokens = self.tokenize(query)
        doc_tokens = self.doc_tokens[doc_idx]
        doc_len = len(doc_tokens)

        score = 0.0
        token_counts = Counter(doc_tokens)

        for token in query_tokens:
            if token not in self.doc_freq:
                continue
            tf = token_counts.get(token, 0)
            df = self.doc_freq[token]

            # IDF
            idf = math.log((self.total_docs - df + 0.5) / (df + 0.5) + 1.0)

            # BM25 公式
            numerator = tf * (self.k1 + 1)
            denominator = tf + self.k1 * (1 - b + b * doc_len / max(self.avg_doc_len, 1))
            score += idf * numerator / max(denominator, 0.01)

        return score

    def search(self, query: str, top_k: int = 3) -> List[Tuple[int, float, str]]:
        """检索最相关的 top_k 篇文档"""
        scores = [(i, self.score(query, i)) for i in range(self.total_docs)]
        scores.sort(key=lambda x: x[1], reverse=True)

        results = []
        for idx, score in scores[:top_k]:
            if score > 0:
                results.append((idx, score, self.documents[idx]))
        return results


class CaseRetriever:
    """案例检索器 —— 用 BM25 找到与待检题目最相关的 GoodCase 和 BadCase"""

    def __init__(self, good_cases: List[Dict], bad_cases: List[Dict]):
        self.good_cases = good_cases
        self.bad_cases = bad_cases
        self.good_retriever: BM25Retriever = None
        self.bad_retriever: BM25Retriever = None

    def build_index(self):
        """构建检索索引"""
        if self.good_cases:
            self.good_retriever = BM25Retriever()
            self.good_retriever.fit([c["title"] for c in self.good_cases])

        if self.bad_cases:
            self.bad_retriever = BM25Retriever()
            self.bad_retriever.fit([c["title"] for c in self.bad_cases])

        print(f"🔍 检索索引已构建: {len(self.good_cases)} good, {len(self.bad_cases)} bad")
        return self

    def retrieve_good(self, query: str, top_k: int = 3) -> List[Dict]:
        """检索最相关的 GoodCase"""
        if not self.good_retriever:
            return self.good_cases[:top_k]  # 无索引时直接返回前几个
        results = self.good_retriever.search(query, top_k)
        return [self.good_cases[idx] for idx, _, _ in results]

    def retrieve_bad(self, query: str, top_k: int = 3) -> List[Dict]:
        """检索最相关的 BadCase"""
        if not self.bad_retriever:
            return self.bad_cases[:top_k]
        results = self.bad_retriever.search(query, top_k)
        return [self.bad_cases[idx] for idx, _, _ in results]

    def retrieve(self, query: str, top_k: int = 3) -> Tuple[List[Dict], List[Dict]]:
        """同时检索 GoodCase 和 BadCase"""
        good = self.retrieve_good(query, top_k)
        bad = self.retrieve_bad(query, top_k)
        return good, bad
