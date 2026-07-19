# 豆包 L1 自动化 VM 包

生产封装包可以自带 Node.js 和运行依赖；仓库生成的开发版包只包含源码、测试和脚本，不包含任何 API 配置、密钥或 `runtime-secrets.json`。开发版先安装 Node.js 20+ 并运行 `npm install`，真实接口配置由使用者在本机环境中单独提供。

依次运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\01-self-test.ps1
.\02-start-doubao.ps1
```

首次隔离资料目录尚未登录时，在豆包窗口完成一次登录，再重新运行 `02-start-doubao.ps1`。脚本会新建“办公任务”，运行器会在每次发送前确认“本地电脑”没有启用。
已有专用资料目录时可用 `-Profile "C:\DoubaoAutomation\User Data"` 指定，不复制个人豆包资料。

真实任务先在仓库二期生产路径中完成资料检索、原件下载、事实账本、附件闸门、两道质检和组合放行，再把该 run 的附件与四份签出文件放入任务目录。`jobs\job.json` 必须绑定同一记录的生产轨迹、轨迹门禁回执、组合放行回执和下载清单。worker 会在连接豆包前核对记录 UID、候选哈希、文件集合、来源 URL、字节数和 SHA-256；手写附件、占位来源或自建数据无法启动。

生成与交互现在可以分开运行。生成机或生产进程完成任务后先建立不可变任务包并入队，这一步不连接豆包：

```powershell
.\05-enqueue-job.ps1 -JobConfig .\jobs\job.json
```

同一豆包登录态可以打开多个窗口。先运行包内 CLI 的 `list-windows` 取得每个窗口的 `targetId`，需要时用 `create-window` 在同一登录上下文中增加窗口，再启动并发池：

```powershell
& .\runtime\node.exe .\src\cli.mjs list-windows --port 9229
& .\runtime\node.exe .\src\cli.mjs create-window --port 9229
.\06-run-pool.ps1 -TargetIds TARGET_A,TARGET_B
```

每个窗口固定绑定一个 worker，同一任务只会被一个 worker 原子领取。附件、生产证据和配置都已复制进队列任务包，后续生产目录变化不会静默改变已入队任务。窗口正文交互保持并行；分享链接和日志复制会通过队列锁短暂排队，避免多个窗口争用系统剪贴板。

任一窗口收到额度耗尽回复后，全部交互窗口会共用同一个暂停闸门。24 小时内等待到提示时间后 1 分钟自动恢复；超过 24 小时或没有可解析时间时，运行中任务进入 `paused/`、未领取任务留在 `pending/`，进程退出等待指示。继续时运行：

```powershell
.\07-resume-quota.ps1
.\06-run-pool.ps1 -TargetIds TARGET_A,TARGET_B,TARGET_C
```

```powershell
.\03-run-job.ps1 -JobConfig .\jobs\job.json
```

如果任务在发送前门禁或模型重试处暂停，保持同一个豆包会话打开，可从连续完成的下一轮续跑：

```powershell
.\03-run-job.ps1 -JobConfig .\jobs\job.json -Resume
```

续跑会校验配置哈希、会话 ID、连续完成轮次和已上传附件；不匹配时直接拒绝，不会串会话或盲目重复发送。

生产至少完成六轮。第六轮后仍有可修复缺口时继续追问，默认最多十二轮。每轮消息和人评先经 Mugua Gemini 3.1 Pro 去AI，再由本机已登录的 Codex `gpt-5.6-sol` 规划或质检。任何模型失败都会按限定次数重试，耗尽后暂停，不会 fallback 放行。任务完成后生成飞书 `READY_NOT_SUBMITTED` 包。豆包明确无法完成，或重复追问仍无实质进展时生成 `READY_WITH_DOUBAO_GAP` 包，记录未解决项并允许按真实产品问题提交。两类提交包都不会自动写入飞书。

开发版不生成 `runtime-secrets.json`。运行前在当前 PowerShell 会话设置 `DE_AI_REWRITE_API_KEY`、`DE_AI_REWRITE_BASE_URL` 和 `DE_AI_REWRITE_MODEL`；使用 Responses 后端时再设置 `CODEX_RESPONSES_API_KEY` 与 `CODEX_RESPONSES_BASE_URL`。这些值不得写回开发包目录。旧的生产封装脚本如显式生成带密钥的 `runtime-secrets.json`，其产物仍属于敏感包，不能当作开发版分发。
