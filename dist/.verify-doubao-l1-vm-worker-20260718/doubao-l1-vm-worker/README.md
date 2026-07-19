# Doubao VM Worker

这是一个独立运行的 Windows 豆包桌面端自动化程序。运行时不使用 Codex
Computer Use、不依赖坐标录制，也不需要 Codex 在线。它给豆包启动一个仅监听
`127.0.0.1` 的 Chrome DevTools Protocol 端口，再用 `playwright-core` 操作应用内
稳定的 DOM 属性。

## 已验证的完整闭环

2026-07-17 已在独立豆包测试账号和隔离 profile 上完成两次真实六轮基础闭环回归。下面列出当前 worker 的完整生产规则；其中动态逐层追问、中途追加附件、证据绑定评分和最终产物分级验收是回归之后新增的规则，已经通过自动测试，但仍需在固定版本 VM 上补一轮真实 smoke：

- 每题新建 Office Task；
- 所有候选附件先按当前 L2 标准复核真实文件、SHA-256 和对象级证据；首轮至少上传一份具体业务附件，后续可根据真实回复自然追加尚未引入的附件，每次都读回精确文件名与数量且禁止重复上传；
- 连续 6 问 6 答，逐轮等待回复真正结束；
- 每轮聊天消息和评价备注都先由 Mugua `gemini-3.1-pro-preview` 去 AI，再由 Codex 模型独立质检，最后由本地规则拦截我们准备发送的运行报错、调试痕迹和怪异标点；
- 每轮依据本轮真实回复给出 0–4 分体验评分，3/4 分点赞、0/1/2 分点踩；评分必须引用回复或产物卡片中的原文证据，再选择标签、强制包含“其他”、填写详细备注并提交；
- 每轮在评价前截取最新回复/产物区域，保存 PNG、文件大小、响应块 ID 和 SHA-256 回执；
- 最终分享时全选全部消息并读回分享链接；
- 从“更多 -> 反馈与举报 -> 复制信息”读回反馈 URL 和日志 ID；
- 最后一轮对请求产物做强验收：优先要求原格式，允许 Excel/Word/PPT/HTML 对应的在线表格/文档/演示/页面；只有豆包明确说明原格式不可提供且已经给出可用替代内容时，才记录 best-effort 接受；
- 将六轮 Prompt、人评、产物截图回执、产物验收、全选分享链接和日志 ID 编译为 `READY_NOT_SUBMITTED` 飞书待提交包；
- 每一步将状态写入 JSON，结束时再执行完整结果门禁。

第二次回归专门验证了豆包虚拟列表：第 6 轮时可见回复节点数仍为 5，worker
依靠唯一消息块 ID 成功识别了新回复，不依赖节点数量或屏幕坐标。

## 安装

```powershell
cd doubao-automation
npm install
npm test
```

## 启动隔离客户端

```powershell
node src/cli.mjs launch `
  --exe "C:\Users\automation\AppData\Local\Doubao\Application\app\Doubao.exe" `
  --profile "C:\DoubaoAutomation\User Data" `
  --port 9229
```

第一次需要在这个专用 profile 中人工登录一次。后续任务不会读取或保存密码，
也不会尝试绕过验证码。CDP 端口固定绑定回环地址，不能暴露给 VM 网络。

登录后可检查运行状态。每个生产会话都必须启用“办公任务”，并在首次进入和每次发送前读回确认“本地电脑”处于未启用状态；按钮缺失、重复或状态不明确都会暂停，不能发送：

```powershell
node src/cli.mjs probe --port 9229
node src/cli.mjs inspect --port 9229
```

## 六轮无人值守任务

预定义模式只用于开发回归，必须显式设置 `developmentOnlyScripted=true`，不能用于生产聊天：

```powershell
node src/cli.mjs run-job `
  --port 9229 `
  --config examples\six-round-job.example.json `
  --output C:\DoubaoAutomation\results\job-001.json
```

任务配置必须提供绝对 `attachmentRoot` 和非空 `attachments`。每项附件必须记录真实文件名、相对路径、SHA-256、来源 URL、分类、对象、时间或事件及独有内容。具体业务材料占比不得低于 80%，至少一项必须是对象级 `specific-business` 证据；只有公开网页或通用规则材料时，配置校验直接失败。示例 JSON 中的附件字段都是占位符，运行前必须替换为真实文件和真实哈希。

需要把部分材料留到后续自然补充时，在任务配置中填写 `initialAttachmentNames`，首轮只上传其中的文件，其余文件作为已核验候选附件提供给动态规划器。每项候选附件可填写 `introductionHint`，说明什么证据缺口出现时适合追加；规划器只能选择真实清单中尚未上传的文件。

每个运行中的结果都会记录唯一 `runId` 和 worker PID。需要暂停时不要只关闭外层终端，使用同一结果文件发出可核验的停止请求：

```powershell
node src/cli.mjs stop-job --file C:\DoubaoAutomation\results\job-001.json
```

worker 会在模型请求、重试等待、发送前、回复等待、评价和分享阶段响应停止请求，并把状态写成
`paused_by_operator`。十秒内未能优雅停止时，`stop-job` 只会定向终止结果文件记录的那个 PID，确认进程退出后再落盘；不会按进程名批量结束其他 Node 任务。

正式生产必须使用 `examples/openai-policy.example.json` 所示的 `openai-compatible` 动态模式。程序根据每轮真实回复决定赞/踩、评价理由、下一轮追问及是否需要追加尚未上传的附件。追问必须承接上一轮的具体结论、数字、引用、口径冲突、遗漏或产物状态，并且每轮只收窄一层，不能使用预写脚本或机械的“继续完善”。追问规划与评价生成直接调用 VM 上已经登录的本机 Codex CLI，模型为
`gpt-5.6-sol`；每次调用使用临时会话、只读沙箱、忽略项目规则并由 JSON Schema 限制输出，不需要 `CODEX_MODEL_API_KEY`，也不使用 Computer Use 技能。Codex CLI 默认从 `%LOCALAPPDATA%\OpenAI\Codex\bin` 自动发现，也可由 `CODEX_CLI_PATH` 显式指定。

题面要求具体文件时，建议显式配置 `productRequirement.requestedFormats`，可用值为 `excel`、`word`、`ppt`、`html`、`pdf`。未配置时 worker 会从题面中识别常见格式。原格式或等价在线产物必须有真实产物卡片、链接或文件节点作为证据；只有文字声称“已经生成”不能通过最终验收。

所有模式都必须同时配置 `interactionRewrite` 和 `promptPreflight`。每条聊天消息和评价备注先由
`interactionRewrite` 调用 Mugua `gemini-3.1-pro-preview` 去 AI；本地事实锚点门禁会核对数字、日期、链接、
英文缩写、引号内容和已知国内平台名称。随后 `promptPreflight` 通过本机已登录的 Codex CLI 对照改写前后文本
做只读质检，不得修改后放行。命中“报错”“异常”、调试/工具痕迹、代码围栏、Markdown 标题或列表、
乱码、表情和重复标点时直接停止，不允许把内部运行状态写进甲方可见聊天记录。

默认用户按国内用户处理。首轮题面和每轮追问在调用审校模型前、模型返回后各执行一次
`domestic-work-scope-v1` 硬门禁：国外平台、国内敏感议题、闲聊或不推进原工作目标的追问都会进入
`paused_content_scope_blocked`，不会发送。计算类内容必须至少包含多变量或多维数据、时间序列、约束或情景、
数据清洗、口径复核中的两类复杂度；单步四则运算和直接代数代入不放行。

豆包回复中的工具执行进度、沙箱说明、内部工具名、额度提示、服务繁忙或其他错误只记录为
`responseVisibility.observations`，不会让 worker 停机。它们属于豆包自身的实际表现，评分模型必须像真人用户一样据此降低评分，并自然决定下一步如何核对或重试。只有我们准备发送的聊天消息和人评备注仍执行严格可见文本门禁，禁止把 worker、接口或模型调用错误写进甲方可见记录。

Codex 追问规划、Codex 质检和 Mugua 去 AI 都采用同一套 fail-closed 重试策略。首次调用失败后，在两分钟内快速重试三次；仍不可用时，
每隔六分钟再试一次，共三次。七次调用全部失败后，结果状态写成 `paused_model_unavailable`，
只允许人工恢复同一任务，不会切换模型、调用规则替代模型判断或生成自动放行结果。HTTP 401 等配置错误
不参与等待重试，会立即写成 `paused_model_error` 并保留失败位置。两种模型暂停状态都禁止 fallback、评价、追问、分享和后续飞书入队。

结果写入采用临时文件加原子替换。发送、收到回复、评价中、评价完成、分享中和最终
完成都会单独落盘。正式回填前运行：

```powershell
node src/cli.mjs verify-result --file C:\DoubaoAutomation\results\job-001.json
```

门禁只接受以下结果：至少 6 轮全部完成、首轮及后续新增附件都在发送前复验且豆包端文件名/数量精确读回、每轮聊天消息和评价备注均有通过的 Gemini 3.1 Pro 去 AI 回执与
Codex 质检回执、质检后可见文本未再次变化、每轮响应截图的响应块 ID/PNG/SHA-256/大小均能读回、每轮评价已提交且面板已关闭、每轮包含“其他”和详细备注，动态评分包含与赞踩一致的0–4分及来自实际回复的原文证据，最终产物满足原格式、允许的在线等价格式或有明确限制说明的可用替代内容，
分享面板至少包含全部轮次且已全选、分享链接/反馈链接/日志 ID/会话 ID 格式均有效、飞书待提交包与六轮结果逐项一致。

## 单步诊断命令

```powershell
node src/cli.mjs office --port 9229
node src/cli.mjs run-once --port 9229 --text "测试消息" --timeout-ms 180000
node src/cli.mjs inspect-latest --port 9229
node src/cli.mjs evaluate-latest --port 9229 --vote like `
  --labels "内容准确,内容完善,其他" --note "填写针对真实回复的详细理由"
node src/cli.mjs copy-share --port 9229
node src/cli.mjs copy-log --port 9229
```

## 结果与飞书

完整结果 JSON 已包含飞书提交所需的 `shareLink`、`feedbackUrl`、`logId`、
`conversationId`、六轮 prompt/response、逐轮评价、附件上传回执和产物截图回执。
同名 `<result>.artifacts/` 目录保存六张 PNG 与 `feishu-submission-package.json`。
待提交包固定写成 `READY_NOT_SUBMITTED`：当前测试不会代替用户猜测生产提交表。
接入真实提交表时，应先明确目标表、sheet ID、行预留和字段映射，再让只有通过
`verify-result` 的包进入现有飞书 OpenAPI/官方 CLI 写入队列，并在写后读回分享链接、
日志 ID 及截图附件对象。未知目标表或缺少精确字段映射时禁止外部写入。

## 稳定性边界

- 所有动作使用唯一 selector，并在写入后读回；selector 不唯一就停止。
- 回复结束由停止按钮消失、文本稳定和消息块 ID 共同确认。
- 独立 profile 与个人豆包数据隔离。
- 客户端升级、登录失效、验证码、网络长期中断会让任务明确失败并保留停点；不能靠脚本
  合法地保证账号永不失效。
- 正式 VM 应固定豆包版本窗口，先跑 smoke test，再放行生产队列。
