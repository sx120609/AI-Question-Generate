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

真实任务必须把 L2 同标准的业务附件放入任务目录，并将 `jobs\job.example.json` 中的文件名、SHA-256、来源、对象级证据、首轮问题和成功条件替换为真实值。运行：

```powershell
.\03-run-job.ps1 -JobConfig .\jobs\job.json
```

如果任务在发送前门禁、模型重试或截图校验处暂停，保持同一个豆包会话打开，可从连续完成的下一轮续跑：

```powershell
.\03-run-job.ps1 -JobConfig .\jobs\job.json -Resume
```

续跑会校验配置哈希、会话 ID、连续完成轮次和已上传附件；不匹配时直接拒绝，不会串会话或盲目重复发送。

生产固定六轮。每轮消息和人评先经 Mugua Gemini 3.1 Pro 去AI，再由本机已登录的 Codex `gpt-5.6-sol` 规划或质检。任何模型失败都会按限定次数重试，耗尽后暂停，不会 fallback 放行。任务完成后只生成飞书 `READY_NOT_SUBMITTED` 包，不会自动提交飞书。若豆包连续返回额度或服务提示，运行器仍按真实体验评分并收尾；最终产物门禁不通过时生成 `INCOMPLETE_NOT_SUBMITTED` 证据包，绝不伪装成完成件。

`runtime-secrets.json` 和 ZIP 内含 Mugua API 密钥，请按敏感文件保管，不要上传公共仓库或发给无关人员。
