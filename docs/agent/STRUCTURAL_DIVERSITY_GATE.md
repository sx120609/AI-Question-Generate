# L2 结构多样性门禁

## 目标

本门禁同时解决正文复刻和结构复刻，但不再为了追求分类差异，强迫真实任务套用不合场景的开头、信息顺序、流程或产物。提示词中的“换一种风格”不能作为放行依据；生产系统应优先硬拦共享长句、正文高度重复和换名词式改写，把结构分类用于诊断和人工复核，并在提交边界强制验票。

## 为什么正文与结构信号都要看

两道题可以几乎没有相同短语，却仍然共享以下结构：

- 都从背景摘要开始，再列附件、缺件和交付要求；
- 都是“核验资料 → 提取数据 → 写 Word → 做 Excel → 最终检查”；
- Word 永远是顺序报告，Excel 永远是顺序台账；
- 决策形式、证据组织、段落与句群切分、句长节奏和信息顺序相同；
- 只替换行业、公司、金额和日期。

因此，正文词法相似、共享长句、主题去重和结构指纹需要联合使用。正文高度重复是硬问题；两个真实任务恰好都需要“建议 + 清单”则不应仅凭分类相同直接判失败。

## 四层强约束

### 1. 来源驱动名额，不再分配结构护照

`createAutoRun` 仍在全局锁内预留名额并写入 `<run>/sources/diversity_plan.json`，但 v3 每个名额只含 `sourceDriven: true`、序号和标识。系统不再给写作者轮换开头模式、信息顺序、决策形态、证据拓扑、流程拓扑或 Word/Excel 组合。差异必须来自原始事实和真实工作关系，不能来自预分配的风格皮肤。

手工补建来源驱动名额时使用：

```powershell
node build/automation/structure_gate.mjs `
  --mode=allocate `
  --run-id="<run_id>" `
  --count=3 `
  --out="<run>/sources/diversity_plan.json"
```

候选选择先看事实是否全部可回到来源、场景和主决策是否真实独立，再看正文是否复刻历史。不能为了让分类距离最大而生造“阶段门、情景模型、例外路由”等术语。

### 2. 题面长度和信息密度硬门槛

- 少于 700 个可见字符：`FAIL`。
- 去掉附件名和交付格式套话后，核心场景少于 300 个字符：`FAIL`。
- 800–1400 个可见字符是非强制建议区间，不按 run 轮换长度带。
- 超过 1450 个可见字符：`WARN`，人工检查是否复述附件、重复边界或堆叠产物细节。
- 超过 1500 个可见字符：`FAIL`。
- 题面至少识别出 4 类有效信息，并覆盖：人物或使用者、事实或证据、主决策和明确交付请求。时间、会议、冲突和缺口只有来源或业务表达确实需要时才写；M/N 列承担结构化真值，但不能代替 B 列说清要模型交付什么。
- 重复附件摘要、空泛形容词和免责句不会弥补信息覆盖不足。

长度是必要条件，不是充分条件。目标是增加真实决策信息，而不是把短模板拉长。

### 3. 五字段结构指纹与历史碰撞检测

门禁读取 `题目`、`任务概括`、`产物内容`、`做题关键步骤` 的归一化正文，并结合附件组织信号，提取以下维度：

- 开头模式和信息顺序；
- 决策形态；
- 证据拓扑；
- Word/Excel 的内部内容拓扑、先后关系和关联方式；
- 归一化步骤动作及其角色序列；
- 阶段门、分支、例外分流、循环、并行或证据追溯等流程拓扑；
- 句群、段落边界与句长节奏；允许按业务意群自然分段，段间仅一个换行符，不得用连续空行制造节奏，也不分配固定段落数量。
- 题面与多字段正文的词法相似度；
- 共享连续长句。

扩展名本身仍不参与题面语义相似度计算，避免把两个不同任务仅因都使用Word判成近邻；但格式分布不再被忽略。独立的产物格式门禁会检查常见办公格式覆盖、组合集中度、单一格式使用率和每种格式的真实业务用途，整批固定使用 `docx, xlsx` 会直接失败。

默认规则：

- 同批或历史题面词法相似度达到硬阈值、正文整体高度重复，或共享至少 24 个连续归一化字符：`FAIL`；
- 同批步骤角色序列相似度达到 0.90，且业务正文也高度相似：`FAIL`；只有步骤动作相近时为 `REVIEW`；
- 同批重复“决策形态 + Word/Excel 内容拓扑 + 流程拓扑”：`REVIEW`，不再单独判失败；
- 同批综合结构相似度达到阈值但未形成正文硬重复：`REVIEW`；
- 历史综合相似度达到 0.82，且多个结构与正文维度同时较高：`FAIL`；
- 来源驱动名额不包含任何待匹配的结构分类。

阈值及权重统一在 `config/structural_diversity.json` 管理。

### 4. 组合发布回执锁住提交边界

成题并生成 fill plan 后运行：

```powershell
node build/automation/release_gate.mjs `
  --candidate="<run>/drafts/l2_questions.tsv" `
  --baseline="config/naturalness_benchmark_v2.json" `
  --fill-plan="<run>/feishu/feishu_fill_plan.json" `
  --naturalness-report="<run>/feishu/naturalness_gate_report.json" `
  --naturalness-review-request="<run>/feishu/naturalness_review_request.json" `
  --naturalness-review-signoff="<run>/feishu/naturalness_review_signoff.json" `
  --scene-card="<run>/sources/scene_cards.json" `
  --role-consistency-report="<run>/feishu/role_consistency_report.json" `
  --structure-report="<run>/feishu/structure_gate_report.json" `
  --structure-review-request="<run>/feishu/structure_review_request.json" `
  --structure-review-signoff="<run>/feishu/structure_review_signoff.json" `
  --structure-receipt="<run>/feishu/structure_gate_receipt.json" `
  --release-receipt="<run>/feishu/release_gate_receipt.json"
```

自然度先按 `config/naturalness_benchmark_v2.json` 的真人正例分位数和显式语言策略运行；随后 scene-card gate 复验有限视角、事实账本、request contract、role trace 与遮罩后同作者碰撞，再进入结构门禁。角色一致性必须直接 `PASS`，不允许人工 override；自然度与结构的 `REVIEW` 只有取得独立、哈希绑定的 `APPROVE` 才能继续。三层全部授权后才生成 v2 release receipt。回执绑定：

- 当前策略编号和版本；
- fill plan 中每一行的 UID、飞书行号和正文哈希；
- 整批哈希；
- 真人正例基准、候选稿和自然度报告哈希；
- 事实账本、隐藏角色卡 bundle、角色一致性报告、逐行角色卡与 sidecar 哈希；
- 自然度或结构 REVIEW 的请求、独立签核和审核人身份；
- 结构报告和内部结构回执哈希。

正式提交只要涉及 B/G/L/N/O 任一叙述字段，`feishu_sheet_submit.mjs`、底层 OpenAPI 客户端和浏览器写入器都必须接收组合 release receipt，在物理写入前重新验证全部哈希，并逐格核对 address、field 和 value。CLI 为兼容仍可接受旧参数名，但裸结构回执和 v1 release receipt 都会被拒绝。门禁后改一个字、换一条步骤、更改角色卡、事实账本、基准、报告或签核，旧回执都会失效；只维护 M 列格式值时不需要回执。

提交边界要求 B 列为自然工作消息：可以连写或按业务意群分段，段间只允许一个换行符，连续换行产生空白行会被直接拒绝；不得使用项目符号、编号规格单或固定段落壳，也不要求固定为 2 段或 3 段。O 列编号步骤仍保留逐行换行。

正式提交器会在写飞书正文前自动在全局锁内重跑历史碰撞检查并登记为 `reserved`；API 写入成功（要求 readback 时还须 readback 成功）后自动升级为 `submitted`。这是默认行为，不能把登记动作留给执行者记忆。外部 QA 通过后，可用下列命令把状态升级为 `accepted`：

```powershell
node build/automation/structure_gate.mjs `
  --mode=register `
  --run-id="<run_id>" `
  --candidate="<run>/drafts/l2_questions.tsv" `
  --fill-plan="<run>/feishu/feishu_fill_plan.json" `
  --receipt="<run>/feishu/release_gate_receipt.json" `
  --status=accepted
```

每次状态登记前都会在锁内再次比较最新历史，避免两个并发 run 都在较早快照上通过。

## 失败后的处理方式

- `question-too-short`：补业务事实、时限、冲突、缺件、使用对象和决策后果，不复述附件目录。
- `information-coverage-insufficient`：补缺少的信息组，不用泛化背景凑字。
- `question-too-long`：删除附件复述、重复边界、字段字典和已经在步骤列出现的操作说明。
- `batch/history-lexical-duplicate`：重写共享长句和同款正文骨架；只换行业名词、金额或日期无效。
- `batch-step-action-isomorphism`：若同时伴随业务正文高度相似，重构真实工作对象与动作依赖；若只是通用步骤相近，进入人工复核。
- `batch/history-structure-collision`：先判断是否为两个真实独立任务；不要为了改变分类生造流程术语或正式产物。
- `REVIEW`：阻断状态。默认删除旧回执并生成 `PENDING_REVIEW` 请求；只有独立审核者的 `APPROVE` 文件与候选、基准、报告和请求哈希完全一致时才可放行。模型复核必须标明为独立模型审核，不能冒充人工审核。

## 既有记录

沈礼和裴硬由本系统生成，现有记录按 UID 作为系统维护范围。它们会参与后续碰撞检查，但不会被门禁脚本静默重写；修改时应直接定位这两个身份的全部记录，另开有明确行范围的改写 run，并重新经过事实保护、附件核对、整批自然度、结构门禁和 QA。
