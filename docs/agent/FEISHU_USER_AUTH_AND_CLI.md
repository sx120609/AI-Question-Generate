# 飞书用户身份授权与 CLI 接入

## 结论

正式生产优先使用官方 `lark-cli` 的用户身份授权，不再依赖浏览器坐标批量填正文列，也不要求我们申请企业级 tenant token。

但这里没有“绕过权限”的合法路径：首次配置仍需要你的飞书账号在浏览器里确认授权；如果组织完全禁止开放平台应用或用户授权，那 OpenAPI/CLI 都拿不到可用凭证，只能退回浏览器人工态。

## 为什么选 lark-cli

- 官方项目 `larksuite/cli` 覆盖 Sheets、Drive、Wiki 等域，支持 `--as user` 以用户身份调用 API。
- `auth login` 使用设备授权流，适合 agent：可以先返回 verification URL，用户打开链接授权后再继续。
- 我们自己的脚本继续负责行锁、UID 占位、fill plan、附件队列，`lark-cli` 只负责底层鉴权和 API 调用。

参考：

- https://github.com/larksuite/cli
- https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_installation?lang=zh-CN
- https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token
- https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3
- https://open.feishu.cn/document/server-docs/docs/sheets-v3/data-operation/write-data-to-multiple-ranges?lang=zh-CN

## 本机状态

当前机器没有全局 `node/npm/lark-cli`，但 Codex 桌面自带 Node 和 pnpm。仓库里的桥接脚本会优先尝试全局 `lark-cli`，找不到时自动走内置 pnpm：

```powershell
node <bundled-pnpm.mjs> --silent dlx @larksuite/cli@latest ...
```

所以后续正式生产命令不需要手动安装全局 npm。

## 首次配置

先查看当前状态：

```powershell
& 'C:\Users\Carbene\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  build\automation\feishu_auth_setup.mjs status
```

如果返回 `not_configured`，执行配置：

```powershell
& 'C:\Users\Carbene\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  build\automation\feishu_auth_setup.mjs config-init
```

这个命令会等待浏览器设置完成。保持终端开着，按输出里的链接在浏览器完成配置。

配置好后发起用户登录：

```powershell
& 'C:\Users\Carbene\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  build\automation\feishu_auth_setup.mjs login
```

默认请求 `sheets,drive,wiki` 推荐权限，并用 `--no-wait` 返回授权链接。你打开链接确认后，如果输出里包含 `device_code`，用下面命令继续轮询：

```powershell
& 'C:\Users\Carbene\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  build\automation\feishu_auth_setup.mjs resume --device-code=<device_code>
```

最后检查：

```powershell
& 'C:\Users\Carbene\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  build\automation\feishu_auth_setup.mjs doctor
```

## 正式生产调用

UID 占位：

```powershell
& 'C:\Users\Carbene\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  build\automation\feishu_uid_reserve.mjs `
  --plan=outputs\formal_runs\<run_id>\feishu_fill_plan_<rows>.json `
  --wiki-url=https://ycnni67pjhck.feishu.cn/wiki/LpjWwH0m9iAxxMkA1vIcDhaInoh `
  --sheet-title="7.08 L2作业表" `
  --rows=<rows> `
  --transport=lark-cli `
  --apply `
  --verify
```

正文和选项列写入：

```powershell
& 'C:\Users\Carbene\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  build\automation\feishu_sheet_submit.mjs `
  --plan=outputs\formal_runs\<run_id>\feishu_fill_plan_<rows>.json `
  --wiki-url=https://ycnni67pjhck.feishu.cn/wiki/LpjWwH0m9iAxxMkA1vIcDhaInoh `
  --sheet-title="7.08 L2作业表" `
  --rows=<rows> `
  --transport=lark-cli `
  --skip-attachments `
  --apply `
  --verify
```

J 列附件仍只上传真实文件对象，不写路径、不写文件清单冒充附件。

## 多线程边界

- `lark-cli` 授权可以共享，同一台机器只需要登录一次。
- `config-init` 和 `login` 不要多线程同时跑。
- 正式生产每个线程必须有自己的 `run_id`、`outputs/auto_runs/<run_id>`、附件目录、fill plan。
- 抢行必须先写 A 列 UID，占位成功后才生成/写入其他列。
- 写表脚本仍会使用 `outputs/locks` 里的锁，同一张表同一 sheet 的 API 写入不会并发撞车。
- 选题去重仍由 `topic_registry.mjs` 管，不能只靠人工记忆。

## 直接 token 仍可用

如果之后你拿到了临时用户 token，也可以直接设置：

```powershell
$env:FEISHU_USER_ACCESS_TOKEN='<user_access_token>'
```

脚本会优先使用环境变量 token。不要把 token 写进仓库、日志或 fill plan；`.gitignore` 已经排除了 `outputs/secrets/`、`outputs/tmp/` 和 `.env*`。
