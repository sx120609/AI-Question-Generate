# Feishu post-submit QA — round 1

- Checked rows: 22
- Passed: 18
- Failed: 4
- Authoritative round receipt: `qa_round_1783694087569.json`
- Question and attachment field changes: none by this QA task

## Row status

| Row | Status |
| ---: | :--- |
| 121 | PASS |
| 122 | PASS |
| 123 | PASS |
| 134 | PASS |
| 135 | PASS |
| 136 | PASS |
| 140 | PASS |
| 141 | PASS |
| 142 | PASS |
| 143 | FAIL |
| 144 | FAIL |
| 145 | PASS |
| 146 | PASS |
| 147 | PASS |
| 148 | FAIL |
| 149 | PASS |
| 172 | PASS |
| 173 | FAIL |
| 174 | PASS |
| 178 | PASS |
| 179 | PASS |
| 180 | PASS |

## Failure details

### Row 143 — information support

仅凭营业执照、执业许可证和自查结论不足以判断本月能否递交医保定点申请。QA 要求补充实际运营时长、人员证书、系统截图、价格记录、追溯码记录和基金内控制度正文等材料，或把任务明确限定为基于缺失项输出补件清单。

### Row 144 — prompt style

QA 认为核心目标明确，但题目细节过多，建议聚焦“制作捐赠票据复核模板和规则说明”，精简冗余描述。

### Row 148 — information support

QA 认为缺少算法参数、训练数据来源、授权记录、岗位证明和复核日志等关键材料，并要求补充当前时间或政策生效时间，以判断法规适用性和灰度条件。

### Row 173 — source material

QA 认为缺少家长授权文本、供应商合同、系统数据流、权限截图、保存设置和替代方案等核心素材，建议补齐材料，或把任务限定为仅基于法规给出合规核对框架。

## Retry note

Rows 179 and 180 were retried after long-running requests. All returned receipts for both rows agree on PASS. The complete 22-row receipt above is used as the authoritative first-round result.
