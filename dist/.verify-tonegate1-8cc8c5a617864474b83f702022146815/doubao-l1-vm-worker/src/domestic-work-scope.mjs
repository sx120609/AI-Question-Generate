export const DOMESTIC_WORK_SCOPE_POLICY_VERSION = "domestic-work-scope-v1";

const FOREIGN_PLATFORM_PATTERNS = Object.freeze([
  /\b(?:Zoom|Microsoft\s+Teams|Google\s+Meet|Slack|Discord|WhatsApp|Telegram|Facebook|Instagram|YouTube|Twitter|GitHub|GitLab|Jira|Confluence|ChatGPT|Claude|Gemini|AWS|Amazon\s+Web\s+Services|Azure|Google\s+Cloud)\b/iu,
  /(?:谷歌会议|微软\s*Teams|亚马逊云|脸书|推特|油管)/iu,
  /(?:zoom\.us|teams\.microsoft\.com|meet\.google\.com|slack\.com|discord\.com|whatsapp\.com|telegram\.(?:org|me)|facebook\.com|instagram\.com|youtube\.com|twitter\.com|\bx\.com\b|github\.com|gitlab\.com)/iu,
  /(?:国外|海外|境外|国际)(?:[^。！？!?\n]{0,8})(?:平台|软件|应用|网站|云服务|社交媒体)/iu,
]);

const DOMESTIC_SENSITIVE_PATTERNS = Object.freeze([
  /政治敏感|敏感政治|政治人物|党和国家领导人|国家领导人|政府舆情|维稳|群体性事件|示威游行/iu,
  /军事行动|军队部署|武器装备|国防机密|作战计划|军情/iu,
  /民族冲突|宗教冲突|分裂活动|独立运动|领土争议/iu,
  /国家安全.{0,12}(?:调查|情报|行动)|涉密(?:材料|文件|系统|数据)|机密(?:材料|文件|情报)/iu,
]);

const WORK_CONTEXT = /项目|业务|运营|门店|公司|团队|部门|岗位|客户|供应商|员工|采购|财务|销售|库存|订单|合同|台账|排期|交付|工单|审批|报表|工作簿|汇报|POC|试点|质检|生产|运维/iu;
const WORK_ADVANCEMENT = /核对|整理|分析|评估|复盘|规划|筛查|验证|更新|汇总|测算|核算|估算|算一下|算出|预测|建模|生成|制作|输出|交付|判断|比较|补充|修订|导出|检查|排查|形成|列出/iu;
const CASUAL_OR_OFFTOPIC = /讲个笑话|聊聊别的|陪我聊天|你是谁|写首诗|星座运势|娱乐八卦|随便聊聊/iu;
const CALCULATION_INTENT = /计算(?!机)|测算|核算|估算|算一下|算出|建模|预测|敏感性分析|盈亏平衡|回归分析/iu;
const SIMPLE_EXPRESSION = /(?:^|[^\d])\d+(?:\.\d+)?\s*[+\-*/×÷]\s*\d+(?:\.\d+)?(?:\s*[+\-*/×÷]\s*\d+(?:\.\d+)?)*\s*[=?？]?\s*$/u;
const CALCULATION_COMPLEXITY = Object.freeze([
  /近\s*\d+\s*(?:个月|月|季度|年)|时间序列|同比|环比|趋势|滚动/iu,
  /分(?:门店|区域|渠道|产品|客户|批次)|多个|多维|不同(?:情景|方案|口径)|逐项|各类/iu,
  /比率|费率|利率|税率|退货率|转化率|成本|收益|毛利|加权|折现|周转|占比|单价|现金流/iu,
  /约束|上限|下限|阈值|情景|方案比较|敏感性|优化目标|资源限制/iu,
  /复核|校验|对账|误差|口径|异常值|缺失值|去重|清洗|交叉验证/iu,
]);

function collectText(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectText(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectText(item, result));
  return result;
}

function complexityCount(text) {
  return CALCULATION_COMPLEXITY.filter((pattern) => pattern.test(text)).length;
}

export function auditDomesticWorkScope(value, {
  context = "",
  requireInteractionAdvance = false,
  requireWorkScene = false,
} = {}) {
  const ownText = collectText(value).join("\n").trim();
  const contextText = collectText(context).join("\n").trim();
  const combined = `${contextText}\n${ownText}`.trim();
  const issues = [];

  if (FOREIGN_PLATFORM_PATTERNS.some((pattern) => pattern.test(ownText))) issues.push("foreign-platform");
  if (DOMESTIC_SENSITIVE_PATTERNS.some((pattern) => pattern.test(ownText))) issues.push("domestic-sensitive-topic");
  if (CASUAL_OR_OFFTOPIC.test(ownText)) issues.push("non-work-interaction");
  if (requireWorkScene && !(WORK_CONTEXT.test(combined) && WORK_ADVANCEMENT.test(combined))) issues.push("work-scene-missing");
  if (requireInteractionAdvance && !WORK_ADVANCEMENT.test(ownText)) issues.push("interaction-does-not-advance-work");

  if (CALCULATION_INTENT.test(combined)) {
    const count = complexityCount(combined);
    if (count < 2 || (SIMPLE_EXPRESSION.test(ownText) && count < 3)) issues.push("calculation-too-simple");
  }

  return {
    calculationComplexityCount: complexityCount(combined),
    issues: [...new Set(issues)],
    pass: issues.length === 0,
    policyVersion: DOMESTIC_WORK_SCOPE_POLICY_VERSION,
  };
}

export class DomesticWorkScopeError extends Error {
  constructor(message, { audit } = {}) {
    super(message);
    this.name = "DomesticWorkScopeError";
    this.code = "CONTENT_SCOPE_BLOCKED";
    this.audit = audit;
    this.issues = audit?.issues ?? [];
  }
}

export function assertDomesticWorkScope(value, options = {}) {
  const audit = auditDomesticWorkScope(value, options);
  if (!audit.pass) {
    throw new DomesticWorkScopeError(`Content failed the domestic work-scope gate: ${audit.issues.join(", ")}.`, { audit });
  }
  return audit;
}
