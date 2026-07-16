/**
 * 案例检索器 - 使用 BM25 算法找到最相关的 GoodCase/BadCase
 */
class BM25Retriever {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.documents = [];
    this.docTokens = [];
    this.docFreq = {};
    this.avgDocLen = 0;
    this.totalDocs = 0;
  }

  tokenize(text) {
    // 清理文本，提取中文词和英文词
    const cleaned = text.replace(/[^一-龥a-zA-Z0-9]/g, ' ');
    const tokens = [];

    // 按空格和中文分词（简易：中文2-gram）
    const parts = cleaned.split(/\s+/);
    for (const part of parts) {
      if (!part) continue;
      if (/[一-龥]/.test(part)) {
        // 中文：按字符切分后用 2-gram
        const chars = [...part];
        for (let i = 0; i < chars.length; i++) {
          tokens.push(chars[i]);
          if (i < chars.length - 1) {
            tokens.push(chars[i] + chars[i + 1]); // bigram
          }
        }
      } else if (part.length > 1) {
        tokens.push(part.toLowerCase());
      }
    }

    return tokens.filter(t => t.length >= 1);
  }

  fit(documents) {
    this.documents = documents;
    this.docTokens = documents.map(doc => this.tokenize(doc));
    this.totalDocs = documents.length;
    this.docFreq = {};

    for (const tokens of this.docTokens) {
      const unique = new Set(tokens);
      for (const token of unique) {
        this.docFreq[token] = (this.docFreq[token] || 0) + 1;
      }
    }

    const totalLen = this.docTokens.reduce((sum, t) => sum + t.length, 0);
    this.avgDocLen = totalLen / Math.max(this.totalDocs, 1);
  }

  score(query, docIdx) {
    const queryTokens = this.tokenize(query);
    const docTokens = this.docTokens[docIdx];
    const docLen = docTokens.length;

    // 计算 token 频率
    const tokenCounts = {};
    for (const t of docTokens) {
      tokenCounts[t] = (tokenCounts[t] || 0) + 1;
    }

    let score = 0;
    for (const token of queryTokens) {
      if (!(token in this.docFreq)) continue;
      const tf = tokenCounts[token] || 0;
      const df = this.docFreq[token];
      const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1.0);
      const numerator = tf * (this.k1 + 1);
      const denominator = tf + this.k1 * (1 - this.b + this.b * docLen / Math.max(this.avgDocLen, 1));
      score += idf * numerator / Math.max(denominator, 0.01);
    }

    return score;
  }

  search(query, topK = 3) {
    if (this.totalDocs === 0) return [];

    const scores = [];
    for (let i = 0; i < this.totalDocs; i++) {
      scores.push({ idx: i, score: this.score(query, i) });
    }
    scores.sort((a, b) => b.score - a.score);

    return scores
      .filter(s => s.score > 0)
      .slice(0, topK)
      .map(s => ({ idx: s.idx, score: s.score, doc: this.documents[s.idx] }));
  }
}

class CaseRetriever {
  constructor(goodCases, badCases) {
    this.goodCases = goodCases;
    this.badCases = badCases;
    this.goodRetriever = null;
    this.badRetriever = null;
  }

  buildIndex() {
    if (this.goodCases.length > 0) {
      this.goodRetriever = new BM25Retriever();
      this.goodRetriever.fit(this.goodCases.map(c => c.title));
    }
    if (this.badCases.length > 0) {
      this.badRetriever = new BM25Retriever();
      this.badRetriever.fit(this.badCases.map(c => c.title));
    }
    console.log(`🔍 检索索引已构建: ${this.goodCases.length} good, ${this.badCases.length} bad`);
    return this;
  }

  retrieveGood(query, topK = 3) {
    if (!this.goodRetriever) return this.goodCases.slice(0, topK);
    const results = this.goodRetriever.search(query, topK);
    return results.map(r => this.goodCases[r.idx]);
  }

  retrieveBad(query, topK = 3) {
    if (!this.badRetriever) return this.badCases.slice(0, topK);
    const results = this.badRetriever.search(query, topK);
    return results.map(r => this.badCases[r.idx]);
  }

  retrieve(query, topK = 3) {
    return {
      good: this.retrieveGood(query, topK),
      bad: this.retrieveBad(query, topK),
    };
  }
}

module.exports = { BM25Retriever, CaseRetriever };
