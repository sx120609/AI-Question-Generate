# AI-Question-Generate

面向垂直领域高难度题目的生产与交付工作流。当前默认生产档位是三期 `L1 探索型`；历史 `L2 流程型` 通过显式 `--profile=l2` 保留。仓库将题目抽样、选题去重、证据与附件规划、两道质量检查、结构与自然度门禁、飞书写入和读回验证串成一条可追溯流水线。

它不是通用的题目生成器：每个题目都必须以真实可访问资料为基础，并保留从输入、草稿、质检到提交回执的证据链。

## 工作流

```text
生产输入与参考样本
        ↓
抽样与结构拆解 → 选题去重 → 附件与事实账本
        ↓
Codex 模型生成请求者题面 → Codex 模型第一轮质检 → Codex 模型第二轮语言质检
        ↓
专用重写接口去 AI 化
        ↓
结构 / 角色一致性 / 自然度 / 发布门禁
        ↓
不可变交互任务包 → 持久化任务队列
        ↓
同登录态多窗口豆包交互池
        ↓
飞书预演 → 授权写入 → 单元格读回核验
```

关键约束：

- 每题从同档位参考样本中独立抽样，只复用结构，不复用领域、对象、附件、数字或固定交付物组合。
- L1 的每轮交互保持探索型难度和分阶段推进，产物格式仍可留空；附件沿用当前 L2 的真实性、可读性、可追溯性和对象级证据标准，但数量控制在 1—3 个并推荐 1—2 个核心文件。题面与追问必须以证据核对、差异解释、口径复核或业务判断为主体，导出和格式整理只能作为附带交付动作。
- 每个自动化运行只能写入自己的 `outputs/auto_runs/<run_id>/` 目录；共享注册表和飞书表格通过锁协调。
- 正文写入前，发布门禁会校验候选 TSV、填表计划、生产过程回执、结构报告、自然度报告及角色一致性报告。
- 正式写入后必须读取目标单元格核对；API 返回成功本身不构成完成。
- 题面与附件生产不连接豆包；生产完成后将任务、附件和签名证据快照入队。豆包交互进程只消费任务池，并可让多个固定窗口按 `targetId` 并发执行，详见 [生成与豆包交互解耦架构](docs/agent/INTERACTION_QUEUE_ARCHITECTURE.md)。

## 目录说明

| 路径 | 内容 |
| --- | --- |
| `docs/agent/` | 生产协议、提示词、质量标准、飞书操作说明和运行手册。新任务先从这里开始。 |
| `docs/rules/` | 原始生产要求及其解读。 |
| `docs/examples/` | 人工审核范例和从范例中提炼的经验。 |
| `inputs/production/` | 三期 L1 参考样例、历史 L2 可仿题面及各档位两道质检提示词，是新运行的受控输入。 |
| `config/` | 生产协议、维护身份、自然度基准和结构多样性基准。 |
| `build/automation/` | 可复用的生产、门禁、飞书读写、锁和验证模块。 |
| `build/manual_review/` | 人工复核、附件核验以及 Word/Excel 审阅材料生成工具。 |
| `build/formal_production/` | 正式批次的生产入口。 |
| `build/migrations/` | 已提交内容的专项升级、审计和修复脚本。 |
| `outputs/auto_runs/` | 每次自动化运行的隔离工作区、附件、草稿、日志、回执与读回结果。 |
| `doubao-automation/` | 独立豆包交互 worker、不可变任务队列和同登录态多窗口并发池。 |
| `outputs/formal_runs/` | 正式批次的导出、填表计划和提交记录。 |
| `outputs/analysis/` | 审计、质检和验证报告。 |
| `outputs/attachments/` | 已下载并核验的资料及清单。 |

## 快速开始

### 1. 准备运行环境

需要 Node.js 20+。主要自动化模块不依赖项目级安装；本机已安装 Node.js 时可直接运行：

```powershell
node --version
node --test build/automation/*.test.mjs
```

生产模型默认通过官方兼容 Responses 接口调用 `gpt-5.6-sol`；去 AI 化使用独立的 OpenAI 兼容 Chat Completions 接口。两套凭据必须分开配置，并且只保存在本机环境或仓库外的私有 secret 文件中：

```powershell
$env:CODEX_RESPONSES_API_KEY="<set-locally>"
$env:CODEX_RESPONSES_BASE_URL="https://gateway.example/v1"
$env:CODEX_RESPONSES_MODEL="gpt-5.6-sol"
$env:CODEX_RESPONSES_REASONING_EFFORT="high"
$env:DE_AI_REWRITE_API_KEY="<rewrite-api-key>"
$env:DE_AI_REWRITE_BASE_URL="https://rewrite.example/v1"
$env:DE_AI_REWRITE_MODEL="gemini-3.1-pro-preview"
```

上述值只是变量名和占位示例。任务配置只记录 `apiKeyEnv`、模型和接口类型，不记录密钥；开发版压缩包也不包含 `.env`、`runtime-secrets.json`、个人网关地址或任何已有运行结果。

如需主动切到第三方模型接口，再设置 `PRODUCTION_MODEL_PROVIDER=third-party` 以及三个 `THIRD_PARTY_MODEL_*` 变量；默认不会静默回退。

在 Codex 桌面环境中，若系统没有 Node.js，可使用桌面运行时自带的 `node.exe`。涉及飞书用户身份时，仓库脚本会优先使用全局 `lark-cli`，不可用时再尝试其内置回退路径。

### 2. 先阅读运行手册

开始新生产任务前，按以下顺序阅读：

1. [题目来源先行与禁止编造基线](docs/agent/SOURCE_DERIVED_QUESTION_BASELINE.md)
2. [L1 端到端生产协议](docs/agent/L1_END_TO_END_PRODUCTION_PROTOCOL.md)
3. [自动化工具说明](build/automation/README.md)
4. [结构多样性门禁](docs/agent/STRUCTURAL_DIVERSITY_GATE.md)
5. [飞书填写工作流](docs/agent/FEISHU_FILLING_WORKFLOW.md)
6. 如需回放旧批次，再读 [L2 自动生产工作流](docs/agent/AUTO_PRODUCTION_WORKFLOW.md) 与 [L2 端到端协议](docs/agent/L2_END_TO_END_PRODUCTION_PROTOCOL.md)

### 3. 创建隔离运行目录

`run_context.mjs` 会执行输入预检、建立运行目录、创建清单，并为共享资源准备锁。使用已在 `config/generated_identities.json` 登记的标注人：

```powershell
node build/automation/run_context.mjs `
  --profile=l1 `
  --objective="生产 2 条 L1 题目并提交飞书" `
  --annotator="沈礼" `
  --count=2 `
  --spreadsheetToken="<spreadsheet-token>" `
  --sheetId="<sheet-id>"
```

运行目录中的重要产物包括：

- `sources/production_input_packet.json`：本次读取的输入、哈希和参考样本。
- `sources/naturalness_baseline.json`：由三期 L1 可用样例在运行创建时生成的自然度基准。
- `sources/fact_ledger.json`、`sources/scene_cards.json`：事实边界和请求者角色上下文。
- `drafts/`：候选题面与内部审阅版本。
- `attachments/`：该运行专属的真实附件。
- `qa/production_trace.json`：逐题的结构、质量检查及修订轨迹。
- `feishu/`：填表计划、门禁回执和最终读回结果。

### 4. 异步生产并使用三个窗口交互

一体化入口会让生产端持续生成，单题通过门禁后立即进入持久仓库；交互端最多使用三个同登录态窗口并发消费，较快生成出来的多余任务留在 `pending/`，不会占用窗口或阻塞后续生产：

```powershell
node build/automation/run_l1_async_pipeline.mjs `
  --batch-id l1-dev-batch-001 `
  --spec-file inputs/production/l1_six_task_specs_20260719.json `
  --slugs task_a,task_b,task_c,task_d,task_e `
  --production-concurrency 3 `
  --target-ids TARGET_A,TARGET_B,TARGET_C `
  --codex-base-url $env:CODEX_RESPONSES_BASE_URL `
  --codex-model gpt-5.6-sol `
  --reasoning-effort high
```

任一窗口收到额度耗尽回复后，三个窗口共用的额度闸门会立即停止新的消息、评价和模型调用。可解析等待不超过 24 小时时，系统在豆包提示时间后 1 分钟恢复并重试原轮；超过 24 小时或无法解析时间时，批次写成 `paused-quota` 后退出。收到继续指示后执行：

```powershell
node doubao-automation/src/cli.mjs resume-quota `
  --queue outputs/async_batches/l1-dev-batch-001/interaction-queue
```

随后用原 `batch-id` 加 `--resume-batch --recover-running` 重新启动。完整状态与恢复约定见 [生成与豆包交互解耦架构](docs/agent/INTERACTION_QUEUE_ARCHITECTURE.md)。

## 自动化模块

`build/automation/README.md` 给出了所有工具的完整说明；以下是最常用的模块：

| 模块 | 用途 |
| --- | --- |
| `production_preflight.mjs` | 校验生产要求、参考工作簿和质检提示词，生成带哈希的输入包。 |
| `production_profile.mjs` | 定义 L1 默认协议与 L2 兼容协议，包括题长、附件、工时、步骤、格式和语言门槛。 |
| `topic_registry.mjs` | 登记候选题并拦截与历史/并行题目过近的选题。 |
| `production_pipeline_prompts.mjs` | 生成结构拆解、附件规划、起草、两道质检和最终编译的分阶段提示。 |
| `production_generation_runner.mjs` | 默认通过 Codex 模型执行结构拆解、附件规划、题面起草和最终编译，并保存哈希绑定的原始响应。 |
| `production_model_client.mjs` | 将生成和质检默认路由到 `gpt-5.6-sol` Responses API；第三方兼容接口只能显式启用。 |
| `de_ai_rewrite_client.mjs` | 仅在去 AI 化步骤调用专用 `/api/rewrite` 接口，与生成/质检凭据隔离。 |
| `production_workflow_state.mjs` | 维护逐题状态机，阻止跳过步骤；首道质检两次失败后要求重新抽样。 |
| `production_trace_gate.mjs` | 核验题目轨迹、候选 TSV、填表计划和附件哈希的一致性。 |
| `scene_card.mjs` | 核验请求者角色、事实账本和题面之间的边界一致性。 |
| `naturalness_gate.mjs` | 按自然度基准检测模板化语言和批内相似度。 |
| `structure_gate.mjs` | 对照当前批次和历史记录进行叙事结构、交付物与流程拓扑去重。 |
| `release_gate.mjs` | 汇总全部门禁，生成提交正文所必需的发布回执。 |
| `feishu_uid_reserve.mjs` | 在表锁下占用目标行并验证占位结果。 |
| `feishu_sheet_submit.mjs` | 将已签发的填表计划写入飞书，并在写入后验证。 |
| `export_sheet_snapshot.mjs` | 导出写入前后快照，用于精确读回比对。 |

## 飞书提交与验证

飞书属于外部系统，正式写入需要用户已完成授权。先检查用户身份状态：

```powershell
node build/automation/feishu_auth_setup.mjs status
node build/automation/feishu_auth_setup.mjs doctor
```

没有授权时，可按 [飞书用户授权与 CLI 接入说明](docs/agent/FEISHU_USER_AUTH_AND_CLI.md) 进行配置。正式写入前应按以下顺序执行：

1. 导出目标行的写入前快照。
2. 生成并检查 fill plan，确认允许写入的字段和保护字段。
3. 运行生产过程、角色一致性、自然度、结构和发布门禁。
4. 先执行 dry-run，再在已授权的情况下显式传入 `--apply`。
5. 导出最终快照，逐单元格比对写入内容；附件对象和受保护行也要核验未变化。

通常的正文写入字段为 `B/G/L/M/N/O`；附件对象位于 `J` 列，必须保留真实文件对象，不能用本地路径或文件清单替代。具体参数以对应运行目录生成的计划和操作文档为准。

## 已保留的生产证据

仓库中的 `outputs/` 不只是临时构建目录，其中保存了正式批次、附件下载、门禁报告和提交读回证据。例如，`outputs/auto_runs/upgrade_managed_v4_except_7_10_04_20260712/FINAL_SUBMISSION_SUMMARY.md` 记录了一次 21 条托管记录的升级：126 个单元格读回完全一致，99 个既有附件对象保持不变。

为避免把本地环境和敏感信息推送到仓库，下列内容默认被忽略：

- `.env`、`.env.*`、`*.local`
- `outputs/secrets/`、`outputs/tmp/`
- `.codex/`、所有 `node_modules/`

不要把飞书访问令牌、浏览器会话、用户凭据或未脱敏的临时数据写入脚本、日志、fill plan 或提交记录。

## 开发版打包

开发版只包含源码、测试、受控输入、配置模板和使用文档，不包含 `outputs/`、`dist/`、`build/tmp/`、`.git/`、`.codex/`、`node_modules/`、`.env*`、`runtime-secrets.json`、本机登录态或任何 API 密钥。构建命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  build/automation/build-development-package.ps1
```

产物写入 `dist/AI-Question-Generate-dev-<version>.zip`，旁边同时生成 SHA-256 文件和构建清单。解压后的首次验证：

```powershell
node --test build/automation/*.test.mjs
cd doubao-automation
npm install
npm test
```

需要真实调用接口时，由使用者在解压目录之外自行设置环境变量；开发包不提供也不推断任何个人 API 配置。详细内容和安全边界见 [开发版包使用说明](docs/DEVELOPMENT_PACKAGE.md)。

## 维护原则

- 生产规则的变更先更新 `docs/agent/` 或 `config/`，再调整自动化代码和测试。
- 迁移脚本只针对明确范围运行，先保留写入前快照，再执行最终读回。
- 不直接覆盖其他运行目录中的中间产物；需要共享的内容使用注册表和锁机制。
- 新增或修改门禁后，至少运行关联的 `*.test.mjs`；影响正式提交链路时，再运行完整自动化测试并保存结果。
- Codex 技能只允许用于开发、调试和修复。正式生产由仓库脚本直接调用 Codex 模型 API、专用去 AI 接口和飞书接口；不得启动 Codex 会话，也不得把 Browser/Computer Use 技能当作生产依赖。

## 参考入口

- [题目来源先行与禁止编造基线](docs/agent/SOURCE_DERIVED_QUESTION_BASELINE.md)
- [自动化工具说明](build/automation/README.md)
- [L1 端到端生产协议](docs/agent/L1_END_TO_END_PRODUCTION_PROTOCOL.md)
- [L2 提示词与字段规范](docs/agent/L2_PROMPTS.md)
- [AI 风格修订指南](docs/agent/AI_STYLE_REVISION_GUIDE.md)
- [质量反馈经验](docs/agent/QA_FEEDBACK_LEARNINGS.md)
- [附件清单](outputs/attachments/ATTACHMENTS_README.md)
