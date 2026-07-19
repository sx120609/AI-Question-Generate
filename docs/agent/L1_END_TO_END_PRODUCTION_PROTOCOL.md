# L1 探索型端到端生产协议

开始任何 L1 选题前，必须先读 [`SOURCE_DERIVED_QUESTION_BASELINE.md`](SOURCE_DERIVED_QUESTION_BASELINE.md)。来源先行、对象级证据和禁止编造均继承自二期，不是三期新增或可选规则。

## 1. 运行定位

本协议是三期默认生产档位。开发阶段可以使用 Codex、浏览器控制或表格工具分析规则和调试代码；正式生产阶段不得依赖 Codex 技能、Computer Use 配额或人工接管。VM 只运行仓库代码，并调用已配置的模型、重写、飞书和后续豆包自动化接口。

默认入口：

```powershell
node build/automation/run_context.mjs `
  --profile=l1 `
  --annotator="沈礼" `
  --count=2 `
  --spreadsheetToken="<spreadsheet-token>" `
  --sheetId="<sheet-id>"
```

不传 `--profile` 时等价于 `--profile=l1`。历史 L2 任务必须显式传入 `--profile=l2`。

## 2. L1 硬协议

| 项目 | L1 生产要求 |
| --- | --- |
| 任务类型 | `L1 探索型` |
| 题面长度 | 硬范围 120—700 个可见字符；通常 220—520 |
| 关键步骤 | 4—8 步 |
| 人类工时 | 硬下限 3 小时；通常至少 4 小时 |
| 附件 | 沿用当前 L2 的真实性、可读性、可追溯性和对象级证据标准；L1 为 1—3 个，推荐 1—2 个核心文件 |
| 选题来源 | 先读取真实附件正文，再从其中的具体对象、事件、指标、记录或规则冲突抽取题目；标题或行业相关不算支撑 |
| 一级目录 | 只能从飞书现有下拉项中原样选择，并与附件正文匹配；不生成新类目或近义类目 |
| 产物格式 | 可留空；填写时必须使用小写扩展名 |
| 产物内容 | 必填，必须说明最终期望得到什么 |
| 多轮交互 | 每轮围绕 1 个主要判断或交付目标展开，允许多个从属核验维度共同服务它；看到真实回复后再规划下一轮 |
| 推理密度 | 每轮主体必须推进来源、差异、证据冲突、计算口径或业务判断；机械交付动作只能附带出现 |
| 题面密度 | L2标准只升级附件；逐包数字、完整公式、字段全集、未来风险和回滚树不得倾倒进L1题面 |
| 证据边界 | 事实、合理推断和待确认项分开，不得补造 |
| 默认用户 | 国内用户；禁止国外平台和国内敏感议题 |
| 交互连续性 | 每轮必须继续真实工作场景并推进证据、产物、验证或决策 |
| 豆包追问规划 | 固定 6 轮，生产必须依据上一轮真实回复动态规划并逐层收窄；预写脚本仅限开发回归 |
| 豆包工作模式 | 每次新会话启用“办公任务”，首次进入和每次发送前都必须读回确认“本地电脑”未启用；状态不明确时暂停 |
| 豆包附件 | 首轮至少上传一份具体业务附件；后续可按证据缺口追加尚未上传的真实附件，每次均复验并读回 |
| 豆包人评 | 依据本轮实际体验给 0—4 分，分数与赞踩固定映射，并保存回复原文证据；禁止随机、轮换或预填评分 |
| 豆包错误 | 豆包自身的错误、工具痕迹或服务提示只记录为体验观察；仅禁止 worker 把自身报错、接口状态或调试信息发送进聊天和人评 |
| 最终产物 | 优先强制原格式；允许对应的在线表格/文档/演示/页面。只有明确无法返回原格式且已提供可用替代内容时才接受 best-effort |
| 计算难度 | 至少具备多变量/多维、时间序列、约束/情景、数据清洗、口径复核中的两类 |

3 小时是根据三期示例中已经通过质检的样例设置的硬下限；生成目标仍以 4—6 小时为主。二期文档的 4 小时要求保留为建议线，不把已经通过的三期 3 小时样例误判为无效。

## 3. 反退化要求

L1 的“短”和“分轮推进”不等于简单题。以下任务必须退回并重新选题：

- 单一网页即可直接回答的查询；
- 只需摘抄或改写一份材料；
- 只把题面数字代入公式的计算题；
- 个人生活场景中没有证据冲突、信息缺口或真实决策约束的费用比较；
- 通过虚构工时、附件或文件格式制造难度。
- 只有公开网页或通用规则材料，缺少真实对象级业务附件；
- 涉及国外平台或国内敏感议题的选题、附件或后续追问；
- 生成后转成闲聊、生活问答或不推进原工作目标的交互；
- 只有单步四则运算或直接代数代入，且没有至少两类真实计算复杂度的题目。
- 因附件数量较多，把附件中的数字、公式、字段和来源位置逐项搬进题面；
- 一轮提出多个彼此无关的决策目标或独立交付物，或一次穷举未来风险、限制、回滚和验收分支。多个核验维度共同服务一个判断不属于超载。
- 初始附件超过 3 个，或为了附件数量把材料清单、字段和数字搬进题面；
- 题目或追问主要由导出、下载、改格式、增删列、重命名、检查文件状态和保持可编辑组成；
- 先编公司计划、岗位压力、预算、时限、内部缺口或试点安排，再找同领域附件拼接；
- 一级目录不是飞书下拉项，或分类只来自题面想象而无法回到附件正文；

三期示例中的通勤成本题已被质检标记为“工作场景不符合，计算题过于简单”，因此不进入 L1 参考抽样池。

## 4. 受控输入

- `config/l1_production_protocol.json`：L1 输入与阶段顺序。
- `inputs/production/l1_phase3_reference_examples.json`：从三期示例表提取的 5 条可用结构参考；被退回样例已排除。
- `inputs/production/L1题面第一道质检提示词.txt`：难度、证据、附件、工时和轮次边界质检。
- `inputs/production/L1题面第二道质检提示词.txt`：只改语言，不强制括号、分号或产物格式指标。
- `config/structural_diversity_l1.json`：L1 长度与结构去重基准。

每次创建 run 都会重新读取并哈希这些输入，同时由 5 条三期样例生成 run 内的 `sources/naturalness_baseline.json`。

## 5. 自动生产阶段

三期相对二期新增豆包动态多轮交互及其人评、分享和日志证据。六轮是最低完整交互量，不是任务终止上限。第六轮后若任务目标或最终产物仍有可修复缺口，worker 继续针对具体缺口追问；豆包明确无法完成，或至少两次针对同一关键缺口追问后仍无实质进展时，可以按“豆包未完成”收口并提交，提交包必须列出未解决项和实际体验评价。默认安全上限为十二轮，可在任务配置中通过 `maximumRounds` 调整到不超过二十轮。交互开始前的选题去重、真实资料检索、原件下载、`sources/download_manifest.json`、事实账本、附件质量闸门、两道质检、去 AI、生产轨迹和组合放行回执继续执行二期路径；交互结束后只整理飞书表要求的字段，不采集产物截图。L1 只复用 L2 的附件与证据路径。题面和单轮交互继续保持 L1 密度，每轮围绕一个主要判断或交付目标推进，允许多个核验维度共同服务它。

豆包 worker 只能读取已经由上述路径签出的附件。任务配置必须绑定同一记录的 `qa/production_trace.json`、`feishu/production_trace_gate_receipt.json`、`feishu/release_gate_receipt.json` 和 `sources/download_manifest.json`。四者缺失、哈希不一致、记录 UID 不一致、附件集合不一致、来源使用占位域名或下载清单没有最终 URL/内容类型时，任务在连接豆包前失败。

```text
L1 样例抽样
  → 结构拆解
  → 国内工作范围门禁
  → 选题与事实账本
  → L2 同质量标准真实附件规划（L1 为 1—3 个，推荐 1—2 个核心文件）
  → 请求者题面
  → 第一道质量质检
  → 第二道语言质检
  → 去 AI 改写
  → 角色 / 自然度 / 结构 / 生产轨迹门禁
  → 飞书 dry-run
  → 写入
  → 单元格和附件读回
```

结构拆解、附件规划、题面起草和最终编译通过 `build/automation/production_generation_runner.mjs` 执行；两道质检通过 `build/automation/two_quality_gate_runner.mjs` 执行。两者经 `build/automation/production_model_client.mjs` 调用 Codex 模型并记录 `codex-model`、真实模型名、原始响应路径和哈希。当前单题完整入口 `build/automation/produce_l1_single_task.mjs` 同时支持本机已登录的 Codex CLI 和自定义官方兼容 Responses 接口；默认保留 `local-codex`，显式设置 `--codex-backend=responses-api` 才走自定义接口。L1 不执行 L2 专用的额外连续性审计调用。

第三方模型接口只是显式可选项：只有设置 `PRODUCTION_MODEL_PROVIDER=third-party`，并同时提供 `THIRD_PARTY_MODEL_API_KEY`、`THIRD_PARTY_MODEL_BASE_URL` 和 `THIRD_PARTY_MODEL` 时才启用；系统不会在 Codex 模型失败后静默换供应商。去 AI 改写是唯一使用 `build/automation/mugua_de_ai_rewrite_client.mjs` 直连 Mugua Chat Completions 的步骤，默认模型是 `gemini-3.1-pro-preview`，提示词来自 `inputs/production/L1题面去AI改写提示词.txt`，密钥只从 `DE_AI_REWRITE_API_KEY` 读取。三条路径都不依赖 Codex 技能。

自定义 Responses 接口配置和单题入口：

```powershell
$env:CODEX_BACKEND="responses-api"
$env:CODEX_RESPONSES_API_KEY="<custom-api-key>"
$env:CODEX_RESPONSES_BASE_URL="https://gateway.example/openai"
$env:CODEX_RESPONSES_MODEL="gpt-5.6-sol"
$env:CODEX_RESPONSES_REASONING_EFFORT="high"
$env:DE_AI_REWRITE_API_KEY="<rewrite-api-key>"
$env:DE_AI_REWRITE_BASE_URL="https://api.mugua.link/v1"
$env:DE_AI_REWRITE_MODEL="gemini-3.1-pro-preview"

node build/automation/produce_l1_single_task.mjs `
  --spec-file inputs/production/l1_six_task_specs_20260719.json `
  --slug <task-slug> `
  --codex-backend responses-api
```

`CODEX_RESPONSES_BASE_URL` 可填写网关根地址、以 `/v1` 结尾的地址或完整 `/v1/responses` 地址；程序统一使用 Bearer 鉴权和官方 Responses 请求、响应结构，不要求端点属于 OpenAI 官方域名。密钥只从环境变量或本机 secrets 文件读取，不进入任务包、状态或回执。

Responses 模式会把每次成功请求的输入、缓存输入、输出、推理、可见输出和总 token，以及响应 ID、请求 ID、实际模型写入阶段回执。生产阶段汇总位于 `qa/codex_usage_summary.json`；豆包交互阶段汇总位于结果 JSON 的 `codexUsageSummary`。接口不返回官方 `usage` 时任务直接失败，不使用字符数或本地 tokenizer 猜算。默认 `local-codex` 路径仍可用，但只能标记为未计量，不能冒充精确 API 用量。

这里的“Codex 模型 API”指代码直接调用模型接口；不是在生产机上启动 Codex 会话，也不消耗 Browser/Computer Use 技能额度。

## 6. 无人工干预策略

正式生产只接受全部门禁 `PASS` 的记录。任何 `FAIL` 或 `REVIEW` 都不得自动伪造审核签字，也不得继续提交；生产控制器应自动执行最小修复，超过重试上限后放弃当前候选并重新抽样。外部接口超时采用有上限的重试和退避，耗尽后隔离本题，不阻塞其他任务。

第一道质量质检连续失败两次时，状态机会进入 `ABANDONED_RESAMPLE_REQUIRED`。这不是人工待办，而是自动丢弃并换题的信号。

## 7. L2 兼容

```powershell
node build/automation/run_context.mjs `
  --profile=l2 `
  --annotator="沈礼" `
  --count=2
```

L2 仍使用原参考工作簿、700—1500 字、非空产物格式、格式覆盖和原两道质检协议。L1 与 L2 共用附件真实性、可读性、可追溯性、具体业务材料占比和对象级证据标准；L1 另设 1—3 个数量范围并推荐 1—2 个核心文件，避免附件数量把题面推成 L2 密度。两种档位继续使用不同的结构政策和注册表。
