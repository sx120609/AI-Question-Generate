# 飞书表格自动化重构方案

这部分专门替代旧的“浏览器坐标点单元格”方案。以后正文列、选项列、状态列优先走 OpenAPI 或官方 CLI；浏览器只保留给普通电子表格里暂时没有稳定公开写入接口的真实附件上传。

用户身份授权详见 [FEISHU_USER_AUTH_AND_CLI.md](FEISHU_USER_AUTH_AND_CLI.md)。正式生产优先使用 `--transport=lark-cli`，让官方 CLI 以用户身份调用 Sheets API。

## 参考项目

- `larksuite/cli`：官方开源 CLI，特点是 Shortcut -> API 命令 -> Raw API 三层结构，适合 agent 先用结构化命令，必要时再退到 raw API。
- `larksuite/node-sdk`：官方 Node SDK，封装 token、请求和语义化 API 调用，适合后续做常驻服务或更完整的 Feishu client。
- `lark-sheets` skill：强调 wiki 链接不能直接当 spreadsheet token，需要先把 wiki token 解析成真实 `obj_token` 和 `obj_type`。
- Feishu OpenAPI `values_batch_update`：支持一次向多个 range 写值，适合批量写 B:O、U 等普通单元格。

## 新边界

1. 禁止用坐标批量写正文列。
2. B:O 里除 J 列外，统一从 `feishu_fill_plan_*.json` 生成 `valueRanges`，再走 `values_batch_update`。
3. J 列是附件对象列，不把文件名或路径写进去冒充附件。脚本只生成 `feishu_attachment_upload_queue_*.json`，后续上传真实文件对象。
4. K/L 必须在本地 lint 先过：K 是真实扩展名短标签，L 按附件逐项写资料名、中文用途/摘要、来源 URL 和边界。
5. 多线程提交必须拿 `outputs/locks/sheet_*.lock`，只写本 run 预留行。

## 使用

正式表优先顺序：

1. 通过 API 或人工读表确定最后一行，生成本 run 的 fill plan。
2. 先只写 A 列 UID 占位，防止别的线程或同事抢行。
3. 再用 API 批量写 A:P 中除 J 列外的文本/选项字段。
4. 最后只用浏览器兜底上传 J 列真实附件对象，并复核文件名。

先 dry-run，检查将要写入的 range 和附件上传队列：

```powershell
node build\automation\feishu_sheet_submit.mjs `
  --plan=outputs\feishu_fill_plan_376_377.json `
  --sheet-id=<sheet_id> `
  --rows=376,377
```

### 先占 UID

UID 占位必须在正式写入前完成。它只写 A 列，不碰题目、附件或质检列：

```powershell
node build\automation\feishu_uid_reserve.mjs `
  --plan=outputs\formal_runs\<run_id>\feishu_fill_plan_<rows>.json `
  --wiki-url=https://ycnni67pjhck.feishu.cn/wiki/LpjWwH0m9iAxxMkA1vIcDhaInoh `
  --sheet-title="7.08 L2作业表" `
  --rows=121,122,123 `
  --transport=lark-cli
```

确认 dry-run 后执行：

```powershell
node build\automation\feishu_uid_reserve.mjs `
  --plan=outputs\formal_runs\<run_id>\feishu_fill_plan_<rows>.json `
  --wiki-url=https://ycnni67pjhck.feishu.cn/wiki/LpjWwH0m9iAxxMkA1vIcDhaInoh `
  --sheet-title="7.08 L2作业表" `
  --rows=121,122,123 `
  --transport=lark-cli `
  --apply `
  --verify
```

如果没有可用的 `FEISHU_USER_ACCESS_TOKEN` / tenant token / app credential，且 `lark-cli` 用户授权也没有配置，UID 占位不能走 API。此时只能临时用浏览器在 A 列写 UID，但仍必须先占 UID，再继续写其他列。

如果只有 wiki 链接，需要设置飞书访问凭证，让脚本先解析 wiki 节点：

```powershell
$env:FEISHU_USER_ACCESS_TOKEN='<user_or_tenant_token>'
node build\automation\feishu_sheet_submit.mjs `
  --plan=outputs\feishu_fill_plan_376_377.json `
  --wiki-url=https://mcn59agnjgqe.feishu.cn/wiki/JJ9Mw5Hxsit09ekv1pPc33RvnXd `
  --rows=376,377
```

确认 dry-run 结果后才允许真实写入：

先为本批生成过程回执。该门禁会逐行核对输入包、过程留痕、候选 TSV 和填表计划，并读取本 run 的真实附件计算哈希：

```powershell
node build\automation\production_trace_gate.mjs `
  --packet=outputs\auto_runs\<run_id>\sources\production_input_packet.json `
  --trace=outputs\auto_runs\<run_id>\qa\production_trace.json `
  --candidate=outputs\auto_runs\<run_id>\drafts\l2_questions.tsv `
  --fill-plan=outputs\auto_runs\<run_id>\feishu\feishu_fill_plan.json `
  --attachment-root=outputs\auto_runs\<run_id>\attachments `
  --report=outputs\auto_runs\<run_id>\feishu\production_trace_gate_report.json `
  --receipt=outputs\auto_runs\<run_id>\feishu\production_trace_gate_receipt.json
```

之后提交命令必须同时携带组合发布回执和过程回执：

```powershell
node build\automation\feishu_sheet_submit.mjs `
  --plan=outputs\feishu_fill_plan_376_377.json `
  --wiki-url=https://mcn59agnjgqe.feishu.cn/wiki/JJ9Mw5Hxsit09ekv1pPc33RvnXd `
  --rows=376,377 `
  --release-receipt=outputs\auto_runs\<run_id>\feishu\release_gate_receipt.json `
  --process-receipt=outputs\auto_runs\<run_id>\feishu\production_trace_gate_receipt.json `
  --transport=lark-cli `
  --skip-attachments `
  --apply `
  --verify
```

脚本会生成：

- `outputs/feishu_api_value_ranges_<rows>.json`：实际要写的 API ranges。
- `outputs/feishu_attachment_upload_queue_<rows>.json`：J 列真实附件上传清单。队列里的文件名必须保留真实扩展名，并以 `附件一_`、`附件二_` 这类前缀开头。

正文批量写入时建议加 `--skip-attachments`，只生成/写入文本和选项 value ranges。附件队列在上传 J 列前单独生成，避免 UID 占位或正文写入阶段混入附件动作。

正式提交器、底层 OpenAPI 写入和浏览器单元格写入允许 B 列连写或按业务意群自然分段，段间只能有一个换行符，不要求固定段数；L 列附件内容同样禁止连续换行，每条附件摘要之间只保留一个换行符。连续换行形成空白行、项目符号、编号规格单或缺少明确交付请求都会被拒绝。生成 fill plan 时只断言，不静默改稿。只要写 B/G/L/N/O，就必须同时携带 `combined-release-gate-v2` 回执与 `l2-production-trace-gate-v2` 回执。过程回执证明每一行都完成独立抽样、新附件构建和两道质检，并绑定真实附件文件内容；物理写入前重新校验所有产物和附件哈希，再逐格匹配 address、field、value。M 列格式维护可以单独执行。O 列继续保留步骤换行，并受回执值绑定。

## 认证

支持三种环境变量，按顺序取：

- `FEISHU_USER_ACCESS_TOKEN`
- `FEISHU_TENANT_ACCESS_TOKEN`
- `FEISHU_ACCESS_TOKEN`

也可以设置：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

这种情况下脚本会自动取 tenant token。正式写用户协作文档时，更推荐官方 `lark-cli auth` 管理授权，然后在提交命令中显式加 `--transport=lark-cli`。如果已设置 `FEISHU_USER_ACCESS_TOKEN`，脚本会优先使用这个 token；如果没有 token 和 app credential，`auto` 模式会退到 `lark-cli`。

## 为什么仍保留附件上传队列

普通电子表格里的“插入 -> 附件”是单元格附件对象。公开资料和官方 CLI 对 Sheets 的稳定能力集中在读写、追加、查找、导出；多维表格附件字段才有明确的上传素材再写 file token 流程。为了不伪造附件、不写路径冒充文件，J 列先由脚本生成真实文件队列，再由浏览器上传这一个动作兜底。

浏览器兜底只做三件事：

1. 跳到 J 列目标单元格。
2. 通过文件选择器上传队列里的真实文件。
3. 复核可见文件名。

任何正文列、格式列、来源说明列都不再靠浏览器坐标粘贴。

## 正式表经验

- 正式表 wiki 链接不能直接当 spreadsheet token。OpenAPI 路径应传 `--wiki-url`，并用 `--sheet-title="7.08 L2作业表"` 或解析后的 sheet id。
- 正式表可从外部质检链接读到真实参数，例如 `spreadsheet_token=<token>`、`sheet_id=<sheet_id>`、`qa_result_col=<col>`、`qa_note_col=<col>`。后续不要硬编码，优先从表内质检链接或 OpenAPI 元信息解析。
- 浏览器模拟点击只保留两个场景：没有 OpenAPI/CLI 用户授权时写 UID 临时占位；J 列上传真实附件对象。
