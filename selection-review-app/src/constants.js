import { storeLabelMap } from "../lib/store-registry.mjs";

// 店铺显示名统一从店铺登记表取，顺序也跟它走。
export const STORE_LABELS = storeLabelMap();

export const QUEUE_LABELS = {
  awaiting_user_direction: "待你确认",
  codex_processing: "选品处理",
  needs_user_data: "需你补资料",
  listing_preparation: "待上架准备",
  ready_to_list: "上架前确认",
  listed: "已上架",
  eliminated: "已淘汰"
};

export const STATUS_LABELS = QUEUE_LABELS;

export const USER_DECISION_LABELS = {
  viable: "可做",
  reject: "不行",
  unsure: "待确认"
};

export const CODEX_DECISION_LABELS = {
  approved: "通过",
  sourcePending: "来源待核",
  needsInfo: "需补资料",
  blocked: "证据不足，已停止",
  eliminated: "淘汰"
};

export const SOURCE_LABELS = {
  user: "你提交",
  software: "软件发现",
  codex: "Codex选品"
};

export const GROUP_LABELS = {
  evergreen: "通用",
  halloween: "万圣节",
  christmas: "圣诞",
  miska: "Miska",
  userAdded: "用户添加"
};

export const PROFIT_RULES = [
  "单件利润 ≥ 20 RMB，或利润率 ≥ 15%（满足任一项即可）",
  "默认自然流量：广告成本按0记录；有真实投放计划时另算",
  "促销20% / 25% / 30%只反推标价，不从折后成交价二次扣除",
  "退货/运营 5%",
  "破损/丢失 5%",
  "贴标 1.5 RMB",
  "采购到手总价（已含国内运费）、包材、国际物流和当前真实佣金完整计入"
];
