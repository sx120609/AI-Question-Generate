# 豆包 L1 自动化 VM 包

本包只要求 VM 已安装并登录 Codex Desktop、已安装豆包客户端。Node.js、运行依赖和 Mugua 去AI配置已经包含在包内。

依次运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\01-self-test.ps1
.\02-start-doubao.ps1
```

首次隔离资料目录尚未登录时，在豆包窗口完成一次登录，再重新运行 `02-start-doubao.ps1`。脚本会新建“办公任务”，运行器会在每次发送前确认“本地电脑”没有启用。
已有专用资料目录时可用 `-Profile "C:\DoubaoAutomation\User Data"` 指定，不复制个人豆包资料。

真实任务先在仓库二期生产路径中完成资料检索、原件下载、事实账本、附件闸门、两道质检和组合放行，再把该 run 的附件与四份签出文件放入任务目录。`jobs\job.json` 必须绑定同一记录的生产轨迹、轨迹门禁回执、组合放行回执和下载清单。worker 会在连接豆包前核对记录 UID、候选哈希、文件集合、来源 URL、字节数和 SHA-256；手写附件、占位来源或自建数据无法启动。

```powershell
.\03-run-job.ps1 -JobConfig .\jobs\job.json
```

如果任务在发送前门禁或模型重试处暂停，保持同一个豆包会话打开，可从连续完成的下一轮续跑：

```powershell
.\03-run-job.ps1 -JobConfig .\jobs\job.json -Resume
```

续跑会校验配置哈希、会话 ID、连续完成轮次和已上传附件；不匹配时直接拒绝，不会串会话或盲目重复发送。

生产固定六轮。每轮消息和人评先经 Mugua Gemini 3.1 Pro 去AI，再由本机已登录的 Codex `gpt-5.6-sol` 规划或质检。任何模型失败都会按限定次数重试，耗尽后暂停，不会 fallback 放行。任务完成后只生成飞书 `READY_NOT_SUBMITTED` 包，不会自动提交飞书。若豆包连续返回额度或服务提示，运行器仍按真实体验评分并收尾；最终产物门禁不通过时生成 `INCOMPLETE_NOT_SUBMITTED` 证据包，绝不伪装成完成件。

`runtime-secrets.json` 和 ZIP 内含 Mugua API 密钥，请按敏感文件保管，不要上传公共仓库或发给无关人员。
