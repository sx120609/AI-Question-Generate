import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkTopicConflict,
  registerTopic,
  topicSimilarity,
  validateTopicStructure,
} from "./topic_registry.mjs";

function validTopic(overrides = {}) {
  return {
    topicId: "topic-a",
    title: "连锁餐饮门店冷链签收异常处置",
    primaryCategory: "供应链与采购",
    secondaryCategory: "冷链履约管理",
    tertiaryCategory: "冷链到货温控与签收复核",
    businessScenario: "区域仓收到门店上报的到货温度异常，需要在付款前复核责任边界。",
    mainDecision: "决定该批次应接收、折价接收还是拒收，并确定承运方责任。",
    role: "供应链履约经理",
    artifactFormats: "docx, xlsx",
    artifactSummary: "异常处置意见与批次核对表",
    attachmentSummary: "温控记录、签收单与运输合同",
    keywords: ["冷链", "签收", "温控"],
    ...overrides,
  };
}

async function withTemporaryRegistry(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-registry-test-"));
  const registryPath = path.join(dir, "registry.json");
  try {
    return await fn(registryPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("registerTopic compares different topics from the same run", async () => {
  await withTemporaryRegistry(async (registryPath) => {
    const first = await registerTopic(validTopic({ topicId: "same-run-a" }), {
      runId: "same-run",
      registryPath,
    });
    assert.equal(first.ok, true);

    const second = await registerTopic(validTopic({ topicId: "same-run-b" }), {
      runId: "same-run",
      registryPath,
    });
    assert.equal(second.ok, false);
    assert.equal(second.conflict.runId, "same-run");
    assert.equal(second.conflict.topicId, "same-run-a");
  });
});

test("artifactFormats remains diagnostic but does not change total similarity", () => {
  const candidate = validTopic({ topicId: "candidate", artifactFormats: "docx, xlsx" });
  const sameFormat = validTopic({
    topicId: "same-format",
    title: "海上风机齿轮箱振动检修窗口",
    primaryCategory: "设备运维",
    secondaryCategory: "海上风电检修",
    tertiaryCategory: "齿轮箱振动趋势复核",
    businessScenario: "运维船期受限，需要依据振动数据确定检修窗口。",
    mainDecision: "决定立即停机检修、限功率运行还是延后至下一船期。",
    role: "风电场可靠性工程师",
    artifactFormats: "docx, xlsx",
    artifactSummary: "检修决策纪要与振动趋势表",
    attachmentSummary: "振动频谱、工单与气象窗口",
    keywords: ["风机", "齿轮箱", "振动"],
  });
  const differentFormat = { ...sameFormat, artifactFormats: "pptx" };

  const withSameFormat = topicSimilarity(candidate, sameFormat);
  const withDifferentFormat = topicSimilarity(candidate, differentFormat);

  assert.equal(withSameFormat.artifactScore, 1);
  assert.equal(withDifferentFormat.artifactScore, 0);
  assert.equal(withSameFormat.score, withDifferentFormat.score);
});

test("registerTopic rejects missing required structure before writing", async () => {
  await withTemporaryRegistry(async (registryPath) => {
    const malformed = validTopic({ role: " " });
    assert.throws(() => validateTopicStructure(malformed), /role/);
    await assert.rejects(
      registerTopic(malformed, { runId: "invalid-run", registryPath }),
      /missing or blank required fields: role/
    );
    await assert.rejects(fs.access(registryPath), (error) => error?.code === "ENOENT");
  });
});

test("registerTopic rejects replacement characters and repeated question-mark corruption", async () => {
  await withTemporaryRegistry(async (registryPath) => {
    const repeatedQuestions = validTopic({ title: "损坏???题目" });
    const replacementCharacter = validTopic({ businessScenario: "资料中出现�乱码" });

    assert.throws(() => validateTopicStructure(repeatedQuestions), /corrupted text.*title/);
    assert.throws(() => validateTopicStructure(replacementCharacter), /corrupted text.*businessScenario/);
    await assert.rejects(
      registerTopic(repeatedQuestions, { runId: "invalid-run", registryPath }),
      /corrupted text detected/
    );
  });
});

test("checkTopicConflict can ignore one exact topic while preserving ignoreRunId compatibility", async () => {
  await withTemporaryRegistry(async (registryPath) => {
    await registerTopic(validTopic({ topicId: "existing-topic" }), {
      runId: "existing-run",
      registryPath,
    });

    const conflict = await checkTopicConflict(validTopic(), { registryPath });
    assert.equal(conflict.ok, false);

    const exactIgnore = await checkTopicConflict(validTopic(), {
      registryPath,
      ignoreRunId: "existing-run",
      ignoreTopicId: "existing-topic",
    });
    assert.equal(exactIgnore.ok, true);

    const legacyRunIgnore = await checkTopicConflict(validTopic(), {
      registryPath,
      ignoreRunId: "existing-run",
    });
    assert.equal(legacyRunIgnore.ok, true);
  });
});
