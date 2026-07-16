# L2 自动生产与飞书提交工作流

本文件是新会话启动自动生产时必须先读的 runbook。目标是自动完成：可仿题面独立抽样、结构拆解、资料搜集、附件下载、题目生产、两道本地质检、过程留痕、飞书提交和外部质检反馈修正，直到通过或确认质检存在 bug。端到端硬约束见 `docs/agent/L2_END_TO_END_PRODUCTION_PROTOCOL.md`。

新 run 必须通过 `production_preflight.mjs`。该预检逐次读取二期要求、`可仿题面.xlsx` 和两份增强质检提示词，逐题只抽取题面与附件内容概括；缺文件、表头不匹配或有效样本不足时直接阻止生产。创建 `createAutoRun` 时预检已自动执行，结果保存在 `<run>/sources/production_input_packet.json`。

## 核心原则

- 真实资料优先，不为质检误报改坏附件形态。
- 每题只使用本次抽取样例的题面与附件概括，先模仿其推进、收束和附件配合结构；领域、对象、附件、数字、原句和固定产物组合不得复用。题面口吻仍由当前角色和事实决定。
- 交付物要从具体业务疑问里长出来，不能每条都先说“做一份意见和一张表”。
- 多线程生产时，每个 run 只写自己的目录；共享资源必须拿锁。
- 选题先登记，避免多个线程做相似题。
- 每个 run 只预留名额，不分配开头、信息顺序、流程或 Word/Excel 组合；这些内容必须从来源事实长出来。
- B 列由一个拥有有限视角的“请求者角色”单独写成；其他字段由字段编译 agent 生成，禁止一个 agent 看着整行 TSV 一次性成题。
- 飞书正文提交必须携带组合发布回执。回执同时绑定事实来源、隐藏角色卡、request sidecar、真人正例基准、自然度报告、结构报告、候选稿和当前填充计划，不能靠“记得运行 lint”。
- 外部质检是反馈源，不是唯一裁判。三轮后同类误报可在本地证据齐全时判定为系统 bug。

## 新会话启动步骤

1. 阅读以下文件：
   - `config/generated_identities.json`（系统生成身份与默认维护范围）
   - `docs/agent/L2_PRODUCER_AGENT.md`
   - `docs/agent/L2_PROMPTS.md`
   - `docs/agent/DE_AI_STYLE_PIPELINE.md`
   - `docs/agent/STRUCTURAL_DIVERSITY_GATE.md`
   - `docs/agent/AI_STYLE_REVISION_GUIDE.md`
   - `docs/agent/FEISHU_FILLING_WORKFLOW.md`
   - `docs/agent/FEISHU_USER_AUTH_AND_CLI.md`
   - 本文件

2. 创建独立运行目录：

   ```powershell
   $node='C:\Users\Carbene\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
   & $node build\automation\run_context.mjs --objective="生产2条L2并提交飞书" --annotator="沈礼" --count=2 --spreadsheetToken="QOgrs2gCShzw5MtHNi3cSg9rnB7" --sheetId="ff061b"
   ```

3. 后续所有中间文件写到该 run 目录：
   - `sources/`：来源卡、搜索结果、网页快照，以及 `fact_ledger.json`、`scene_cards.json` 等隐藏情境产物；这些隐藏产物不进入飞书。
   - `attachments/`：本 run 下载的真实附件。
   - `drafts/`：草稿 TSV、审校稿、内部审阅稿。
   - `feishu/`：填表计划、行号预留、上传结果和 `role_consistency_report.json`。
   - `qa/`：每轮质检 HTML 和解析 JSON。
   - `logs/events.jsonl`：流水线事件。

   `run_context` 同时在 `sources/diversity_plan.json` 写入本批名额。v3 计划只含 `sourceDriven` 名额标识，不再给写作者分配话术或产物拓扑。

不要在生产中直接覆盖共享的 `outputs/l2_questions.tsv`。只有人工明确要求导出统一样例时，才把 run 产物复制到共享输出。

## 多线程权限边界

每个自动生产线程必须遵守：

- 只能写自己的 `outputs/auto_runs/<run_id>/`。
- 可以读公共规则、示例和已有产物，但不能改其他 run 的文件。
- 不能直接修改别人的飞书行。
- 提交飞书前必须获取 sheet 锁，并预留行号。
- 附件上传只能上传本 run 的附件目录，或经来源卡明确记录的外部真实文件。

共享锁位置：

- `outputs/locks/topic_registry.lock`：选题注册表锁。
- `outputs/locks/structure_registry.lock`：来源驱动名额预留与最终指纹登记锁。
- `outputs/locks/sheet_<token>_<sheet>.lock`：飞书表行号和提交锁。

行号预留：

1. 浏览器扫描当前表格最下面的可写行。
2. 调用 `reserveRows`，传入扫描得到的 `firstCandidateRow`。
3. 只允许写返回的 `[startRow, endRow]`。
4. 如果填表失败，reservation 标为 `aborted`；不要把同一 run 自动写到别的行。

## 选题去重

多线程最容易出的问题不是抢文件，而是做出相似题。每个候选题在资料搜集前必须先登记。

使用 `build/automation/topic_registry.mjs`：

```powershell
$topic = @{
  title="丹佛酒店公共EV充电桩踏勘前判断"
  primaryCategory="房地产与大宗资产"
  secondaryCategory="酒店资产运营与设施改造"
  tertiaryCategory="酒店停车场EV充电桩选址与税务预审"
  mainDecision="是否值得约电气承包商现场踏勘"
  artifactFormats="docx, xlsx"
  keywords=@("酒店","EV充电桩","30C","踏勘","科罗拉多")
} | ConvertTo-Json -Compress
& $node build\automation\topic_registry.mjs --runId="<run_id>" --topicJson="$topic"
```

冲突处理：

- 相似度 >= 默认阈值 `0.46` 时，必须换题。
- 换题优先换主决策和行业对象，而不是只换地点或公司名；产物仍由真实业务用途决定。
- 同一级目录下可以并行，但三级场景、资料组合、主判断和交付用途不能高度重叠。
- 通过或提交后的题保持 `accepted/submitted` 状态，继续参与去重；废弃题标 `abandoned`。

## 选题生成规则

好题先有真实业务压力，再找资料。

候选题至少要有来源可证的角色或使用者、具体事实或证据和主决策。下面内容只在来源确实出现时保留，不能为了完整度补写：

- 发起人：我、老板、客户、项目组、委员会、运营同事等。
- 时间压力：这周、月底前、会前、提审前、供应商回复前等；来源没有就不加。
- 主决策：是否推进、是否踏勘、是否上架、是否调解、是否补材料。
- 资料用途：附件分别支撑哪些判断。
- 交付对象：老板、客户、委员会、法务、运营、供应商。

避免：

- “为某某做预审，形成某某清单”作为题面开头。
- 同一批题都用“老板要不要推进”但只是换行业。
- 只换地点、公司名、产品名，本质还是同一题。

## 结构多样性与长度门禁

主题去重只解决“做的是不是同一个业务问题”，结构门禁还要解决“是不是仍用同一套叙事和任务图”。两者都必须通过。

生成前先执行抽样绑定的六段主流程，角色卡只嵌入第三段，不得绕开前两段：

1. `reference-breakdown`：只读抽样题面与附件概括，拆出业务场景、卡点、唯一主任务、附件支撑、产物来源和后半段收束逻辑。
2. `attachment-plan`：基于已核验来源构建全新的附件集合，具体对象或执行材料占主体。
3. `question-draft`：把结构拆解、附件方案、事实账本和隐藏角色卡合并为题面初稿。
4. `first-quality-gate`：先单独记录结构审计，再逐字使用输入包中的第一道质检词，返回原版 `{pass, issues}` JSON。
5. `second-language-gate`：仅在第一道 `pass=true` 且 `issues=[]` 后运行，逐字使用输入包中的第二道质检词。
6. `final-compiler`：冻结第二道修改后题面，编译正式字段和候选 TSV。

上述节点写入 `sources/production_workflow_state.json`。第一道连续两轮失败必须放弃本题并重新抽样；所有题完成后才能导出 `qa/production_trace.json`。

隐藏角色与反模板链在主流程内按以下方式执行：

1. 从原始记录和附件抽出带稳定 `fact_id` 的事实账本：组织与业务环节、来源可证角色、已经发生的事、数字或引语、现有材料、未知事项、唯一主决策和真实交付对象。
2. 现场选角 agent 只创建隐藏角色卡和微型工作世界，记录 `personaId`、职责与权限、当前阶段、已知/未知事实、收件人、结果用途、沟通环境和禁止越权知识。角色卡不得增加没有 `fact_id` 的事件。
3. 请求者 agent 只进入该角色写 B 列原始消息及 request sidecar，不接触任务概括、产物内容、关键步骤或整行 TSV。同一角色卡独立生成 3 个候选，禁止靠新增老板、会议、截止时间或冲突制造差异。
4. 独立审核 agent 对三个 B 候选做知识越权、故事化添戏、角色互换、同作者遮罩、sidecar 原文和交付格式检查，并与同批声音信号比较。先淘汰硬失败候选，再选角色因果最强且与同批最不像同一作者的一条；不得拼接候选。
5. 字段编译 agent 只根据事实账本、资料包和获选 B 编译其余列，B 列逐字冻结；发现不一致只能输出 blocked 并退回请求者/审核阶段，不能在编译阶段润色。
6. 把获选记录写入 `sources/scene_cards.json` 的 `scene-card-bundle`，再由 `runSceneCardGate` 对最终 TSV 复验获选 B、`personaId`、角色卡、事实账本、sidecar、事实边界和 M/B 映射，输出 `feishu/role_consistency_report.json`。报告必须是 `kind=scene-card-gate-report`、`gateId=scene-card-role-consistency-v1` 且状态为 `PASS`，包含逐行结果与遮罩后的整批相似审计，并绑定 candidate/bundle/fact-ledger/evaluation 哈希；任一哈希变化都会使旧报告失效。随后才运行自然度、结构和 release gate。

成题后：

```powershell
& $node build\automation\release_gate.mjs `
  --candidate="<run草稿tsv>" `
  --baseline="config/naturalness_benchmark_v2.json" `
  --fill-plan="<run>/feishu/feishu_fill_plan.json" `
  --naturalness-report="<run>/feishu/naturalness_gate_report.json" `
  --scene-card="<run>/sources/scene_cards.json" `
  --role-consistency-report="<run>/feishu/role_consistency_report.json" `
  --structure-report="<run>/feishu/structure_gate_report.json" `
  --structure-receipt="<run>/feishu/structure_gate_receipt.json" `
  --release-receipt="<run>/feishu/release_gate_receipt.json"
```

`--fill-plan` 不是可省略的形式参数。组合门禁会把 TSV 的五个叙述字段与待提交行逐条做哈希核对，并验证 `runSceneCardGate` 的 `PASS` 报告以及获选候选对应的事实账本、角色卡和 request sidecar；角色一致性、自然度和结构均通过后才签发回执。任何 `REVIEW` 默认阻断，只有独立审核人的哈希绑定 `APPROVE` 才能继续。

自然度门禁现为 `naturalness-gate-v4`，指标版本为 `naturalness-metrics-v4`，语言策略为 `human-approved-request-punctuation-v3`。v4 以正式表人工直通稿校正“请”、自然段落、句号比例和场景化自检，不再把步骤数量众数或末步自检本身当成模板证据。旧 v1/v2/v3 报告和回执只保留为历史提交证据，不能授权任何新的 B 列写入。

硬要求：

- 题面少于 700 个可见字符直接失败；800-1400 为非强制参考区间，1450 以上检查复述，不再分配长度带。
- 长度不能靠附件复述、空泛形容词或重复免责句堆出来；有效信息覆盖不足仍失败。
- 共享长句、正文高度重复、步骤动作与业务正文同时同构会失败；单个结构分类接近进入阻断式 `REVIEW`，不能由脚本自动接受。
- 历史近邻比较同时看题面节奏、信息顺序、决策、附件组织、产物内容和步骤任务图。扩展名本身不进入语义相似度，但独立格式门禁会拦截固定 `docx, xlsx`、核心办公格式缺失、组合过度集中和没有真实用途的格式。
- 碰撞后要重构 B/G/L/N/O 五列，不能只把某些词换成近义词。

## 资料与附件

资料搜集优先级：

1. 官方、监管、公司帮助中心、公开数据、年报/公告、法院/政府/协会文件。
2. 原始文件优先：PDF、HTML、CSV、XLSX、DOCX、PPTX、JSON、图片、ZIP。
3. 英文资料可以用，但文件展示名尽量用中文主体名称，L 列必须逐项补完整中文摘要、来源 URL 和资料边界；只写文件提供的信息，不写用途话术。
4. 核心附件做不到中文资料或中文主体命名时，附件质量闸门直接判“不建议成题”，当前选题作废并换题；不要靠英文原件硬撑一条 L2。
5. 不要把英文原件改造成“中文要点附件”来替代真实来源；必要时可以另附译文，但要说明它是辅助译文。
6. 入库文件名必须按飞书样例加附件序号前缀，例如 `附件一_资料名.pdf`、`附件二_数据表_2026-07-09.csv`。序号、J 列可见文件名和 L 列说明必须对应。
7. 正式成题前必须用下载脚本或 `fetch` 验证来源链接在生产机上可读。浏览器能打开但脚本/外部质检无法读取的站点，不作为主要来源；优先换机器可读的官方中文页面或换题。
8. L 列不写“用于支持”或“为……提供依据”。每个附件至少要有来源 URL、可直接使用的中文正文摘录或数据口径，以及资料自身的覆盖边界；法规库跳转页、地方政府站点、PDF 附件尤其要补足正文口径，避免复检读取失败。

附件质量闸门不过，不得成题。

## 题目生成

题目生成严格按 `抽样结构拆解 -> 新附件构建 -> 事实账本/现场选角 -> 请求者初稿 -> 第一道质检 -> 第二道质检 -> 字段冻结 -> scene-card gate复验` 执行，可执行 prompt 见 `build/automation/production_pipeline_prompts.mjs`。题面必须像角色本人发给 AI 或同事的工作消息，不要每条都套同一个“背景-缺件-交付物”模板。B 列至少有一次清楚委托，能直接读出请求方、动作和交付物；系统生成记录禁用“请”，可自然使用“帮我、你给我、我想要、需要你、麻烦你”等表达，但它们不是要求轮换的封闭词表，也不能退化成“Word需要……、Excel按……”。开头由该角色此刻最关心的来源事实决定，段落由业务意群决定。

交付物和具体争议点要在角色消息里形成清楚因果，但不规定谁先出现；例如角色可能先说明卡点再提出文件，也可能先说“你给我做一份Word意见”，随后补充为什么需要它。请求句位置由沟通情境决定，不统一写成“帮我生成”。

请求者 agent 的可见产物只有 B 列；内部必须同时产生 request sidecar：`requestContract.requestSpan/action/outputs[{format,humanName,purpose}]`、`roleTrace.blockageSpan/motivationSpan/downstreamUseSpan`、`usedFactIds` 和 `deliberatelyOmitted`。`requestSpan` 与 `roleTrace` 中每个非空 span 必须在 B 列逐字且只出现一次，`action` 必须是 `requestSpan` 中的逐字动作短语，`humanName` 必须是题面原词并逐字出现在 `requestSpan`。`usedFactIds` 和 `deliberatelyOmitted` 互不重叠，合并后必须完整覆盖 `sceneCard.informationBoundary.knownFactIds`。sidecar 不能替正文补足请求。字段编译 agent 只填写 G、L、N、O 等其余字段，不能反向把规格说明或审核口径塞回 B 列。

角色卡只保留完成当前任务所需的组织背景、职责权限、流程阶段、已知/未知事实、收件人、结果用途和沟通环境。禁止人物小传、性格标签和故事化冲突。`沈礼`、`裴硬`是 `config/generated_identities.json` 中的系统标注身份，不是题中主人公；每条题另建独立 `personaId`。

如果手头只有法规、政策或案例，题面和后续字段必须把范围压住：写“素材审查、话术红线、会前答疑、模板框架、现场勘查、待收材料”，不要写“具体产品上架判断、可改造评估、逐房源放行、批次结论”。同一条数据里，分类、题面、附件内容、产物内容和步骤的边界要一致，不能前面说不判断、后面又让模型做结论。

字段要求：

- `任务类型` 固定使用飞书选项值 `L2 流程型`。
- `人类完成时间` 写 `10h`、`12h`。
- `相关附件` 本地写真实文件名，并带 `附件一_`、`附件二_` 这类前缀；文件名尽量用中文主体名称；飞书 J 列上传真实文件。
- `附件内容` 按附件逐项写资料名、完整中文摘要、正文摘录或数据口径、来源 URL 和资料覆盖边界，不写产题用途。
- `产物格式` 只写小写扩展名短标签，例如 `docx, xlsx`、`pptx`、`html`；不加“Word文档”“Excel表格”或括号。B 列必须用 Word、Excel、PPT、网页等人类名称明确提出 M 列中的全部交付物，产物内容再展开验收细节。
- `做题关键步骤` 8-15 条，逐行 `1. ...`。
- `题目` 可见字符硬下限 700，800-1400 为非强制参考；超过 1450 检查复述，超过 1500 不放行。至少覆盖角色/使用者、事实/证据、主决策和明确交付请求，不强塞没有来源的时间或缺口。
- `题目` 可以连写，也可以按业务意群自然分段；段间只允许一个换行符，禁止连续换行形成空白行，禁止项目符号和编号规格单，不设置固定段落数量配额。
- `题目` 一旦被独立审核选中就冻结；后续字段审校若发现矛盾，整条返回对应 agent，不得由编译器或 QA 直接改写 B 列。

这条规则在多层代码边界执行：生成器产出自然段落；`buildFeishuFillPlan` 只做断言，不会静默改变已经过门禁的候选稿；正式提交器、底层 OpenAPI 批量写入和浏览器单元格写入会拒绝项目符号/编号规格单、超过 8 段或缺少明确请求的 B 列。当前在线历史题不会被自动改写，今后只要重写 B 列就必须遵守新规则。

## 去 AI 风格审校

成题后、飞书提交前必须跑一轮独立去 AI 风格诊断，按 `docs/agent/DE_AI_STYLE_PIPELINE.md` 执行。诊断 agent 只给出证据、选择或退回阶段，不直接代写 B 列。

固定顺序：

1. 锁定事实，不改附件、时间、主决策、产物格式和来源边界。
2. 先用事实保护检查新增数字、日期、引语和时间词；任何无法回到来源的“合理情节”都删除。
3. 清理“不要/必须”式提示词约束；通用边界移入事实账本和验收规则，不批量改写成待确认栏。
4. 清理二分对照壳、本质拔高壳、助手路标词、机械顺序壳、假互动结尾。
5. 检查角色有限视角、角色互换、同作者遮罩和 request sidecar 原文映射；失败就退回现场选角或请求者 agent。
6. 运行 `lint_ai_style.mjs`、事实保护、scene-card gate、整批自然度门禁和结构门禁；组合门禁通过才生成 v2 release receipt。

## 本地校验

正式填表前必须运行：

```powershell
& $node build\manual_review\lint_ai_style.mjs <run草稿tsv>
```

随后必须运行组合发布门禁。lint 通过、逐行外部 QA 通过或结构单项通过，都不等于整批自然度通过。

至少检查：

- 字段格式、时间格式、任务类型。
- 附件文件是否真实存在。
- 题面是否有人类场景锚点。
- 产物格式是否真实。
- 关键步骤数量和编号。
- 附件内容是否逐项有资料名、中文摘要、来源 URL 和资料边界，且没有用途话术。
- 题面长度、有效信息覆盖、同批及历史结构近邻、步骤任务图和产物拓扑是否通过。
- 角色卡、事实账本和 request sidecar 是否齐全且哈希绑定；B 列事实是否都在该角色可知范围内。
- 是否通过角色互换测试和同作者遮罩测试；遮去公司、产品、行业和附件专名后仍共享整套骨架的候选不能放行。

## 飞书提交

1. 验证组合 release receipt；缺失、非 PASS、政策版本过期，或事实账本、角色卡、候选、基准、任一报告、填充计划哈希不一致时停止。
2. 获取 sheet 锁。
3. 预留行号。
4. 文本列自动填。
5. 选项列按飞书下拉值选择。
6. J 列通过 `插入 -> 附件` 上传真实文件。
7. 读回文件名，确认保存到云端。

上传附件使用 `build/manual_review/feishu_browser_fill.mjs` 的：

- `uploadFeishuCellAttachments`
- `verifyVisibleAttachmentNames`

不要使用 Windows 系统级文件粘贴。

## 三轮质检与修正

每条提交后至少跑三轮，除非提前通过。

每轮流程：

1. 调用 `build/automation/qa_client.mjs` 或对应函数跑 QA。
2. 保存原始 HTML 和解析 JSON 到 run 的 `qa/`。
3. 按反馈分类：
   - 格式问题：修字段。
   - 题面问题：退回请求者 agent，沿用已核验角色卡和事实账本重写，补回“谁让模型做什么、交付什么”，同时打散固定句群、段落骨架和请求框架；QA 或字段编译 agent 不得直接补句。
   - 产物要求生硬：把“Word需要……、Excel按……”改成与业务疑问相连的自然委托，不只替换格式名，也不机械在句首补“帮我”。
   - 标点问题：检查短开头、第一枚标点、顿号枚举和前段冒号分号；按意群重写，禁止全局把句号替换成逗号。
   - 步骤问题：补足 8-15 条，确认飞书内是真换行。
   - 附件问题：本地核对真实文件、可打开、文件名带附件序号、L 列逐项中文摘要和来源 URL；确实缺资料就回到资料搜集。
4. 修完后重新提交对应字段，再跑下一轮。
5. 每次质检出现真实问题，都要把问题沉淀回生成链条：更新 `docs/agent/L2_PROMPTS.md`、`docs/agent/L2_PRODUCER_AGENT.md` 或本地 lint 规则，并在 `docs/agent/QA_FEEDBACK_LEARNINGS.md` 或 run 报告中写明“问题 -> 修复 -> 下次预防”。不要只修飞书当前行。

判定系统 bug 的条件：

- 同一类问题连续三轮出现。
- 本地证据齐全，例如附件真实上传、文件能打开、文件名和 L 列序号一致、L 列有中文摘要和来源 URL、附件数量满足要求。
- 继续修改会损害真实资料或人工可读性。

判定 bug 后停止追改，并在 run 报告里写明覆盖依据。

## 最终报告

每个 run 结束时输出：

- run id 和预留行号。
- 每条题的主决策、目录、附件清单。
- 本地校验结果。
- 飞书上传复核结果。
- 三轮 QA 记录。
- 每轮修改内容。
- 最终状态：通过 / 本地确认通过但 QA bug / 失败需人工处理。

## 飞书提交层

正式提交不再使用浏览器坐标批量粘贴正文列。新会话必须先读 `docs/agent/FEISHU_API_AUTOMATION.md`：

1. 先运行 `build/automation/feishu_auth_setup.mjs status`。如果未配置，按 `docs/agent/FEISHU_USER_AUTH_AND_CLI.md` 完成 `config-init` 和 `login`。
2. 通过 `build/automation/feishu_sheet_submit.mjs` dry-run 生成 API `valueRanges`。
3. 先运行 `build/automation/feishu_uid_reserve.mjs --transport=lark-cli --apply --verify`，只写 A 列 UID 占位。占位未成功时不得继续写正文。
4. 用 Sheets `values_batch_update` 写入除 J 列外的正文、选项和说明字段；正式命令必须同时传入 `--release-receipt=<run>/feishu/release_gate_receipt.json` 和 `--process-receipt=<run>/feishu/production_trace_gate_receipt.json`，默认带 `--transport=lark-cli --skip-attachments`，附件队列单独生成。裸 structure receipt、缺少过程回执或历史 v1 回执均不能写 B/G/L/N/O。
5. 单独生成 J 列真实附件上传队列。
6. 浏览器自动化只允许用于 J 列附件对象上传和可见文件名复核；没有 OpenAPI/CLI 用户授权时，浏览器也只能先写 A 列 UID 占位，再写本 run 行。
7. 多线程场景下，API 写入和附件上传都必须限定在本 run 已预留且 A 列 UID 已占位的行号内。

## 字段级反模板与缺证据处理

后续生成不能只做题面去模板化。提交前必须逐行检查 `题目`、`任务概括`、`附件内容`、`产物内容`、`做题关键步骤` 五个叙述字段，确认它们不是同一套壳子换行业词。高风险模板包括：

- 题面用“部门A认为……部门B认为……”或“请基于四个附件……”作固定转场。
- `附件内容` 统一以“以下为四个附件……”开头。
- `产物内容` 统一以“最终产物为两个可编辑文件……”开头。
- `做题关键步骤` 统一套“核验四个附件 -> 生成 Word -> 生成 Excel -> 交付前检查”。

返工时回到隐藏角色卡和真实工作流：只使用事实账本中确有的会议压力、群聊争议、上线评审或资料包缺口，不能把这些元素当作可轮换开头；附件说明要写清“资料能证明什么、不能证明什么”；产物说明要写清使用对象和有来源的使用场景、验收边界；步骤要围绕本题实际判断动作组织，而不是机械列文档生产步骤。

如果题目或交付物提到合同、流水、截图、授权记录、字段字典、算法参数、训练数据、房源明细、证照真实性、现场消防、后台数据等业务事实，附件里没有提供的部分必须写成“待补材料、待确认边界、补件清单或暂缓判断”，不能让模型凭法规、政策或行业资料替具体事实下结论。
