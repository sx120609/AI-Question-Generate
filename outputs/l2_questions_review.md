# L2 题目人工审阅稿

生成日期：2026-07-09

## 题目 1：睡眠健康 App 上架前数据安全与素材合规预审

### 来源卡片

1. Apple App Store 审核指南
   - 来源：Apple Developer
   - URL：https://developer.apple.com/app-store/review/guidelines/
   - 格式：HTML
   - 用途：核验健康、隐私、误导性表述和产品安全要求。
   - 边界：不能证明具体 App 一定过审。

2. Apple App Store 产品页创建说明
   - 来源：Apple Developer
   - URL：https://developer.apple.com/app-store/product-page/
   - 格式：HTML
   - 用途：核验产品页描述、截图和元数据表达。
   - 边界：不能替代审核反馈。

3. Apple App 隐私详情与数据类型说明
   - 来源：Apple Developer
   - URL：https://developer.apple.com/app-store/app-privacy-details/
   - 格式：HTML
   - 用途：核验 App 隐私标签和数据类型披露口径。
   - 边界：不能证明 SDK 实际采集行为。

4. Google Play 数据安全表单填写说明
   - 来源：Google Play Console Help
   - URL：https://support.google.com/googleplay/android-developer/answer/10787469?hl=en
   - 格式：HTML
   - 用途：核验数据安全表单、数据收集共享和第三方代码披露要求。
   - 边界：不能替代代码审计。

5. Google Play 健康应用类别与声明要求
   - 来源：Google Play Console Help
   - URL：https://support.google.com/googleplay/android-developer/answer/13996367?hl=en
   - 格式：HTML
   - 用途：判断睡眠建议和健康功能声明范围。
   - 边界：不能证明功能不构成医疗用途。

6. FTC 背书与推荐广告指南（2023）
   - 来源：Federal Trade Commission
   - URL：https://www.ftc.gov/system/files/ftc_gov/pdf/p204500_endorsement_guides_in_2023.pdf
   - 格式：PDF
   - 用途：核验达人付费合作、体验效果和披露要求。
   - 边界：不能覆盖各州或海外广告规则。

### 内部质检

结论：放行。

- 飞书列完整，UID 留空。
- L2 难度成立：6 个附件、12 小时、10 个关键步骤。
- 附件包含 Apple、Google Play 和 FTC 官方资料，能支撑上架与投放预审。
- 产物为 Word/飞书文档、Excel/飞书表格和文案修改清单，没有要求 Markdown。
- 题面有真实限制：8 月底提审、健康功能、达人投放、SDK 和隐私披露缺口。
- 风格已人工化处理，没有无主语命令句、错位黑话或身份错位。

## 题目 2：科罗拉多酒店停车场 EV 充电桩选址与税务预审

### 来源卡片

1. AFDC 替代燃料站数据下载说明
   - 来源：Alternative Fuels Data Center
   - URL：https://afdc.energy.gov/data_download
   - 格式：HTML
   - 用途：确认数据下载口径和更新方式。
   - 边界：不能证明酒店现场适合施工。

2. AFDC 替代燃料站 API 说明 All Stations
   - 来源：AFDC API documentation
   - URL：https://developer.nlr.gov/docs/transportation/alt-fuel-stations-v1/all/
   - 格式：HTML
   - 用途：核验 CSV 字段、状态、接入类型和查询参数。
   - 边界：不能替代现场距离测量。

3. AFDC 科罗拉多 EV 充电站数据
   - 来源：AFDC API
   - URL：https://developer.nlr.gov/api/alt-fuel-stations/v1.csv?api_key=DEMO_KEY&fuel_type=ELEC&state=CO&limit=all
   - 格式：CSV
   - 用途：做科罗拉多公共 EV 站点密度和竞争初筛。
   - 边界：不能证明实时可用性和价格。

4. Joint Office 公共 EV 充电站选址检查清单
   - 来源：Joint Office of Energy and Transportation
   - URL：https://driveelectric.gov/files/ev-site-selection.pdf
   - 格式：PDF
   - 用途：核验公共可达性、安全、照明、ADA 和交通可见度等选址因素。
   - 边界：不能替代工程踏勘。

5. IRS Form 8911 说明
   - 来源：Internal Revenue Service
   - URL：https://www.irs.gov/pub/irs-pdf/i8911.pdf
   - 格式：PDF
   - 用途：识别 30C 抵免的表单、PWA、Schedule A 和资料留存要求。
   - 边界：不能判断最终可抵免金额。

6. IRS 企业替代燃料车辆加注设施抵免说明
   - 来源：Internal Revenue Service
   - URL：https://www.irs.gov/pub/irs-pdf/p6028.pdf
   - 格式：PDF
   - 用途：解释企业安装充电设备可能涉及的 30C 抵免框架。
   - 边界：不能替代会计师意见。

### 内部质检

结论：放行。

- 飞书列完整，UID 留空。
- L2 难度成立：6 个附件、14 小时、11 个关键步骤。
- 附件含 HTML、CSV、PDF，且 CSV 能支撑周边站点密度初筛。
- 产物为 Excel/飞书表格、Word/飞书文档和踏勘邮件，没有要求 Markdown。
- 题面明确禁止编造施工报价、电价、税收抵免金额和实时站点状态。
- 风格已人工化处理，没有模板腔、错位黑话或身份错位。
