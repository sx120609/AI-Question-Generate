# 开发版包使用说明

开发版用于代码审阅、二次开发、自动测试和本机联调。它不是带账号、登录态或接口凭据的部署镜像。

## 包含内容

- 根 README、`.gitignore` 与开发包构建清单；
- `build/automation/`、`build/manual_review/`、`build/formal_production/`、`build/migrations/` 源码及测试；
- `doubao-automation/` 的源码、测试、示例、VM 辅助脚本和 `package-lock.json`；
- `config/`、`inputs/`、`docs/` 中的受控协议、模板、参考样本和操作文档。

开发版明确排除：

- `.git/`、`.codex/`、`.agents/`、`outputs/`、`dist/`、`build/tmp/`；
- 所有 `node_modules/`、`__pycache__/`、`*.pyc`；
- `.env`、`.env.*`、`*.local`、`.npmrc`、`runtime-secrets.json`；
- 文件名包含 `secret`、`credential`、`token-cache` 的本机配置文件；
- 豆包 profile、浏览器登录态、飞书令牌、API 密钥、现有任务结果和生产日志；
- Node.js 便携运行时。开发者自行安装 Node.js 20+。

## 构建与校验

在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  build/automation/build-development-package.ps1
```

脚本先复制允许目录，再对 staging 目录执行文件名和内容扫描。发现私密配置文件、疑似 `sk-...` 密钥、私钥头、Cookie/Authorization 实值或本机个人网关配置时直接失败，不生成 ZIP。成功后在 `dist/` 写入：

```text
AI-Question-Generate-dev-<version>.zip
AI-Question-Generate-dev-<version>.zip.sha256.txt
AI-Question-Generate-dev-<version>.manifest.json
```

可用下面的命令复核哈希：

```powershell
Get-FileHash .\dist\AI-Question-Generate-dev-<version>.zip -Algorithm SHA256
Get-Content .\dist\AI-Question-Generate-dev-<version>.zip.sha256.txt
```

## 解压后初始化

```powershell
node --version
node --test build/automation/*.test.mjs
cd doubao-automation
npm install
npm test
```

以上测试使用本地 mock，不需要真实 API 密钥。需要连接豆包时，再按 `doubao-automation/README.md` 启动隔离 profile；需要生产题目时，先阅读 `docs/agent/SOURCE_DERIVED_QUESTION_BASELINE.md` 与 `docs/agent/L1_END_TO_END_PRODUCTION_PROTOCOL.md`。

## 本机配置

开发包只保留环境变量名称，不提供值。真实联调时在本机 PowerShell 会话或开发包目录之外的私有 secret 文件中设置：

```powershell
$env:CODEX_RESPONSES_API_KEY="<set-locally>"
$env:CODEX_RESPONSES_BASE_URL="https://gateway.example/v1"
$env:CODEX_RESPONSES_MODEL="gpt-5.6-sol"
$env:CODEX_RESPONSES_REASONING_EFFORT="high"
$env:DE_AI_REWRITE_API_KEY="<set-locally>"
$env:DE_AI_REWRITE_BASE_URL="https://rewrite.example/v1"
$env:DE_AI_REWRITE_MODEL="<set-locally>"
```

不要把实际值写进示例 JSON、任务包、运行结果或源码。`apiKeyEnv` 只记录需要读取哪个环境变量，不是密钥本身。

## 异步交互与额度恢复

生成端和交互端彼此独立。生产完成一题即可入队；最多三个同登录态豆包窗口并发领取，多余任务保留在 `pending/`。任一窗口出现额度耗尽回复后，全局闸门暂停所有交互与新的模型调用：

- 24 小时内：等待到提示时间后 1 分钟，原会话重试同一轮；
- 超过 24 小时或无法解析：任务保存为 `paused_quota_wait`，批次状态保存为 `paused-quota` 后退出。

收到继续指示后运行：

```powershell
node doubao-automation/src/cli.mjs resume-quota --queue <queue-directory>
```

随后重启交互池，或用原批次的 `--resume-batch --recover-running` 入口恢复。额度回复不会进入评分模型，也不会导致附件重复上传或会话废弃。
