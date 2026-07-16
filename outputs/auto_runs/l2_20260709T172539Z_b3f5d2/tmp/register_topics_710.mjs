import { registerTopic } from "../../../../build/automation/topic_registry.mjs";

const runId = "l2_20260709T172539Z_b3f5d2";

const topics = [
  {
    topicId: "沈礼_7.10_01",
    title: "连锁茶饮小程序会员抽奖促销上线前复核",
    primaryCategory: "品牌市场与电商零售",
    secondaryCategory: "会员营销与促销合规",
    tertiaryCategory: "茶饮小程序积分抽奖与优惠券规则复核",
    businessScenario:
      "茶饮品牌7月新品活动上线前，会员积分抽奖、券包、生日标签和小程序弹窗需要法务先审。",
    mainDecision: "判断促销规则、广告弹窗和会员字段哪些可上线、哪些要补材料或暂停。",
    role: "品牌会员运营/法务",
    artifactFormats: "docx, xlsx",
    artifactSummary: "活动规则审改意见和促销/会员字段补件表",
    attachmentSummary: "促销、消保、互联网广告、个人信息、网络交易规则",
    keywords: ["茶饮", "积分抽奖", "优惠券", "会员标签", "促销合规"],
  },
  {
    topicId: "沈礼_7.10_02",
    title: "儿童智能手表入园定位试点隐私复核",
    primaryCategory: "科技软件与 AI 工作流",
    secondaryCategory: "智能硬件与数据合规",
    tertiaryCategory: "儿童智能终端定位与监护人授权复核",
    businessScenario:
      "幼儿园想引入儿童智能手表做入园打卡、定位围栏、SOS录音和家长端提醒。",
    mainDecision: "判断哪些功能可以试点、哪些儿童个人信息处理要监护人授权或暂缓。",
    role: "园方信息化负责人/产品法务",
    artifactFormats: "docx, xlsx",
    artifactSummary: "试点隐私复核意见和功能/数据/授权核对表",
    attachmentSummary:
      "未成年人网络保护、儿童个人信息、个人信息保护、网络数据安全、App收集行为认定",
    keywords: ["儿童智能手表", "定位", "监护人授权", "儿童个人信息", "幼儿园"],
  },
  {
    topicId: "沈礼_7.10_03",
    title: "演出票务平台实名购票与退票规则改版复核",
    primaryCategory: "互联网与平台业务",
    secondaryCategory: "票务平台规则与消费者保护",
    tertiaryCategory: "大型营业性演出票务实名退票与规则公示复核",
    businessScenario:
      "票务平台准备改演唱会实名购票、退票梯次、转赠限制和防倒票提示规则。",
    mainDecision: "判断新版票务规则哪些可以上线公示、哪些需要演出方或公安文旅确认。",
    role: "票务平台产品经理/合规",
    artifactFormats: "docx, xlsx",
    artifactSummary: "规则改版复核意见和票务规则/证据缺口核对表",
    attachmentSummary:
      "大型营业性演出管理通知、营业性演出条例、大型群众性活动安全、平台规则、个人信息保护、消保条例",
    keywords: ["演出票务", "实名购票", "梯次退票", "防倒票", "平台规则"],
  },
];

const results = [];
for (const topic of topics) {
  results.push(await registerTopic(topic, {
    runId,
    owner: runId,
    status: "reserved",
  }));
}

console.log(JSON.stringify(results, null, 2));
