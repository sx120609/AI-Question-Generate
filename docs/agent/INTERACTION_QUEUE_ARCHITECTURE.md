# 生成与豆包交互解耦架构

## 目标

生产端与交互端不再属于同一个进程：

- 生产端只负责选题、下载真实附件、生成题面、两道质检、去 AI、事实与放行回执，并输出最终 `job.json`。
- 入队步骤把 `job.json`、附件和四份生产证据复制成不可变任务包。原生产目录随后发生变化，不会改变已经入队的版本。
- 交互端只从任务池原子领取任务，不参与题面或附件生成，也不写飞书。
- 一个豆包窗口对应一个 worker。多个窗口共享同一个浏览器上下文和登录态，但每个 worker 固定绑定自己的 CDP `targetId`，所有发送、回复识别、人评、截图、分享和日志操作都只使用该窗口的 `Page` 对象。

## 持久化布局

默认队列可以放在 `C:\DoubaoAutomation\interaction-queue`：

```text
interaction-queue/
  quota-pause.json
  packages/<jobId>/
    job.json
    manifest.json
    attachments/*
    evidence/
      production_trace.json
      production_trace_gate_receipt.json
      release_gate_receipt.json
      download_manifest.json
  pending/*.json
  running/*.json
  completed/*.json
  paused/*.json
  failed/*.json
  results/*.json
  locks/*.lock/owner.json
```

入队时重新验证生产回执、候选绑定、附件集合、真实文件大小和 SHA-256，再复制到 `packages`。任务包中的配置与清单各有独立 SHA-256，worker 领取后再次读回验证。`pending -> running` 使用同卷原子重命名，多个 worker 不会领取同一任务。

运行中的队列项带 `workerId`、`targetId`、随机 lease token 和心跳。worker 崩溃后，超过租约时间的任务会回到 `pending`；正常暂停、失败和完成分别进入独立目录，不会混作成功。

## 生产进程

生产进程不需要启动豆包或连接 CDP。生成并签出 `job.json` 后执行：

```powershell
cd doubao-automation
node src/cli.mjs enqueue-job `
  --queue C:\DoubaoAutomation\interaction-queue `
  --config C:\path\to\generated-run\doubao\job.json
```

也可以在 VM 包中运行：

```powershell
.\05-enqueue-job.ps1 -JobConfig .\jobs\job.json
```

生产者可以持续生成并入队。队列不会连接豆包，也不会因当前没有空闲交互窗口而阻塞生产。

## Codex Responses API 与精确计量

单题生产使用 `--codex-backend=responses-api` 时，生成出的 `job.json` 会让追问规划、评价决策和发送前质检继续使用同一个自定义官方兼容 Responses 端点。运行交互 worker 前，必须在每个 worker 进程中设置同一个 `CODEX_RESPONSES_API_KEY`；任务包只保存 `apiKeyEnv`、`baseUrl`、模型和推理等级，不保存密钥。

每个窗口仍独立写自己的结果 JSON。`codexUsageSummary` 汇总该任务所有已返回官方 `usage` 的 Codex 请求，包括语义校验失败后发生的重试；字段包含请求数、输入、缓存输入、非缓存输入、输出、推理、可见输出和总 token。任何 Responses 成功结果缺少官方 `usage` 时 fail closed，任务不能以“已完整计量”状态结束。本机 Codex CLI 路径继续可用，但其结果明确标为未计量，不能和精确 API 用量混合统计。

## 同登录态并发交互

先启动一个专用 profile 并完成一次登录。查看现有窗口：

```powershell
node src/cli.mjs list-windows --port 9229
```

需要时让 CDP 在同一浏览器上下文中创建新窗口，再重新读取窗口 ID：

```powershell
node src/cli.mjs create-window --port 9229
node src/cli.mjs list-windows --port 9229
```

将不同 `targetId` 交给并发池：

```powershell
node src/cli.mjs queue-pool `
  --port 9229 `
  --queue C:\DoubaoAutomation\interaction-queue `
  --target-ids TARGET_A,TARGET_B,TARGET_C
```

VM 包等价命令：

```powershell
.\06-run-pool.ps1 -TargetIds TARGET_A,TARGET_B,TARGET_C
```

并发池启动前会验证所有 target 都属于同一个 `browserContextId`。同一窗口同一时间最多运行一个任务；同一 worker 在该窗口内串行领取后续任务。不同窗口之间没有共享 `Page`、会话 ID、回复身份、附件状态或结果文件。分享链接和日志取证仍会使用操作系统剪贴板，因此只把这段短操作放进队列级跨进程互斥锁；正文交互、上传、等待回复、截图和评价仍保持并行。

使用 `--once` 时，每个窗口最多领取一个任务，适合 smoke test。长驻模式不加 `--once`，队列暂时为空时 worker 保持等待，后续生产者入队后会自动继续。

## 隔离和恢复约束

- 多窗口场景必须显式使用 `targetId`；不再用“当前唯一聊天页”猜测窗口。
- 结果 JSON 记录 `executionSlot.endpoint/browserContextId/targetId/workerId`。断点续跑必须回到保存状态中的同一窗口 target，避免串会话。
- 系统剪贴板是所有窗口共享的全局资源。worker 会通过 `locks/system-clipboard.lock` 排队完成分享和日志复制，并用心跳回收崩溃进程遗留的过期锁。
- 每个任务继续新建独立 Office Task，会话内仍按原规则核验“本地电脑”关闭、发送读回、稳定回复 ID、人评、分享和日志。
- 队列只解决调度与窗口隔离，不绕过账号额度、验证码或豆包自身并发限制。任何真实失败继续按 `paused`、`failed` 或 `INCOMPLETE_NOT_SUBMITTED` 留痕。
- 飞书提交仍在验证完成后的独立步骤执行，交互池不会自动写飞书。

## 一体化异步批次入口

`build/automation/run_l1_async_pipeline.mjs` 把独立生产者、持久仓库和交互池接成同一个异步协调器。它不会把生产和交互重新耦合：每道题一旦生成并通过生产门禁就立即入仓，其他题继续生成；三个窗口只消费已经入仓的任务，多余任务保留在 `pending`，不占窗口也不阻塞生产。

```powershell
$env:CODEX_RESPONSES_API_KEY="<custom-api-key>"
node build/automation/run_l1_async_pipeline.mjs `
  --batch-id l1-api-batch-001 `
  --spec-file inputs/production/l1_six_task_specs_20260719.json `
  --slugs task_a,task_b,task_c,task_d,task_e `
  --production-concurrency 3 `
  --target-ids TARGET_A,TARGET_B,TARGET_C `
  --codex-base-url https://custom.example.com `
  --codex-model gpt-5.6-sol `
  --reasoning-effort high
```

同一批次最多只允许一个活跃协调器，`coordinator.lock` 会拒绝重复进程。异常退出后使用原批次恢复：

```powershell
node build/automation/run_l1_async_pipeline.mjs `
  --batch-id l1-api-batch-001 `
  --resume-batch `
  --recover-running `
  --target-ids TARGET_A,TARGET_B,TARGET_C
```

恢复任务带 `resumeTargetId`，只能由原窗口领取，而且原窗恢复优先于普通仓库任务。这样既保留会话上下文，也避免新任务先占用原窗口后使断点失效。生产、交互、排队和恢复事件分别写入批次目录的 `pipeline_state.json`、`pipeline_events.jsonl` 与 `interaction-queue/`；凭据不写入这些文件。

生产交互不设置“回复总耗时达到 N 分钟就失败”的硬截止。worker 只用页面 DOM 观察新回复身份、正文变化、停止按钮和稳定完成态；等待过程中不调用任何大模型。只有出现一条新的完整回复后，才进入一次事件驱动的评估与下一轮规划。人工暂停、进程退出、登录失效或明确页面错误仍会中止当前等待，并保留可恢复状态。

新交互发送第一条消息前必须同时读回：页面位于无会话 ID 的办公任务根地址、已发送消息数为 0、已接收消息数为 0。任何一项不满足都不能发送。断点恢复时，如果可见首轮/后续轮消息或附件与保存状态不一致，旧会话直接记为 `CONVERSATION_ABANDONED`；任务包保持不变，结果进入历史归档，然后新建空白办公任务从第一轮重新开始。禁止在不匹配的旧会话中重发第一轮、补发附件或继续追问。

豆包的订阅或额度管理弹窗属于可恢复的界面遮罩，不代表会话内容失效。点击点赞、点踩、分享或更多菜单前，worker 会只识别带 `data-setting-modal-layer` 且包含额度管理订阅 iframe 的可见弹窗，先用 `Escape` 关闭，再执行消息动作；如果动作与弹窗同时出现，则关闭后只重试该消息动作，不重发当前轮提示词。此类失败从保存的反馈阶段和原窗口断点恢复，只有题面、附件或可见消息身份不匹配时才废弃整个会话。

## 额度回复的全局暂停闸门

会话正文里的额度耗尽回复不再作为普通回答交给 Codex 评估，也不再触发评分、反馈或下一轮提示词。任一窗口识别到“额度用完”及恢复时间后，会把原回复、回复身份和暂停回执归档到当前轮的 `quotaHistory`，同时在队列根目录写入 `quota-pause.json`。三个 worker 共用同一个闸门：闸门生效后，运行中的窗口会在最近的安全检查点停止，空闲窗口不再领取任务；等待期间不发送消息、不点击人评，也不调用任何大模型。

- 可解析的继续时间不超过 24 小时时，交互池等待到豆包提示的恢复时间后再加 1 分钟，然后在原窗口、原会话中重试未执行成功的同一轮提示词。改写、预检不重复运行，已经上传的附件不重复上传。
- 需要等待超过 24 小时，或额度回复没有可解析的恢复时间时，闸门进入 `manual` 模式。运行中的任务写成 `paused_quota_wait` 并进入 `paused/`，尚未领取的任务继续留在 `pending/`，协调器退出，不进行后台模型分析。
- 收到继续指示后，执行 `node src/cli.mjs resume-quota --queue <dir>`。该命令显式释放持久化闸门，并把所有 `paused_quota_wait` 任务按原 `targetId` 放回队列；随后重新启动原交互池即可断点恢复。

一体化批次会把 `pipeline_state.json.status` 写成 `paused-quota` 后正常退出。恢复时先执行 `resume-quota`，再用原 `batch-id` 运行 `run_l1_async_pipeline.mjs --resume-batch --recover-running`；已经完成生产或仍在仓库中的任务不会重新生成。

额度回复是账号级限流，不属于会话污染，因此不会废弃当前会话。只有题面、附件或可见消息身份不匹配等不可恢复错误仍按原规则归档并新建 Office Task。
