export const LEVEL1_CATEGORY_OPTIONS = Object.freeze([
  "互联网与平台业务",
  "科技软件与 AI 工作流",
  "游戏与互动内容",
  "品牌市场与电商零售",
  "投资战略、专业服务与企业经营",
  "金融服务与财富投研",
  "教育科研与生命科学",
  "法律、政务与公共服务",
  "房地产与大宗资产",
  "个人金融与理财投资",
  "商业与市场分析",
  "职业发展与教育规划",
  "企业经营与战略决策",
  "科技与产品研发",
  "个人生活与重大决策",
]);

export function isAllowedLevel1Category(value) {
  return LEVEL1_CATEGORY_OPTIONS.includes(String(value ?? "").trim());
}

export function assertAllowedLevel1Category(value, { label = "一级目录" } = {}) {
  const normalized = String(value ?? "").trim();
  if (!isAllowedLevel1Category(normalized)) {
    throw new Error(`${label} must be selected from the configured Feishu options: ${normalized || "<empty>"}`);
  }
  return normalized;
}
