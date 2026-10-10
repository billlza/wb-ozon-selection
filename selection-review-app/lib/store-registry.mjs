/**
 * 平台和店铺分开建模（统一改动清单第 7 条）。
 *
 * 平台只有 Ozon 和 WB；店铺挂在平台下面。凡是要知道「这家店在哪个平台」的地方都从这里查，
 * 不再从店铺键猜（以前到处写 targetStore === "wb" ? "wb" : "ozon"）。
 *
 * 这里只放不含秘密、不随环境变化的登记信息。卖家号、仓库号、凭据别名仍在本机运行配置
 * （SELECTION_REVIEW_STORE_BINDINGS_JSON 等）里；listStores 只回答「身份配没配」，不回传这些号码。
 *
 * 三家店的店名和身份放在哪还没定（AGENTS 13.1），所以 label 只是从以前界面常量搬过来的显示文字，
 * 一律 labelConfirmed: false，不能当店铺身份用；13.1 定下来以后再从批准的配置里取。
 * "wb" 是历史上一直在用的店铺键，先沿用。
 */

export const STORE_REGISTRY_VERSION = "stores-v1";

export const PLATFORMS = Object.freeze([
  Object.freeze({ platform: "ozon", label: "Ozon" }),
  Object.freeze({ platform: "wb", label: "WB" })
]);

// 顺序就是界面下拉框里的顺序，和以前 STORE_LABELS 的顺序一致。
export const STORES = Object.freeze([
  Object.freeze({ storeId: "dandanshu", platform: "ozon", label: "蛋蛋鼠", labelConfirmed: false, profitRuleKey: "ozonDandanshu" }),
  Object.freeze({ storeId: "miska", platform: "ozon", label: "Miska", labelConfirmed: false, profitRuleKey: "ozonMiska" }),
  Object.freeze({ storeId: "wb", platform: "wb", label: "WB", labelConfirmed: false, profitRuleKey: "wbCrossListing" })
]);

const byId = new Map(STORES.map(store => [store.storeId, store]));

export function isKnownPlatform(platform) {
  return PLATFORMS.some(item => item.platform === platform);
}

export function isKnownStore(storeId) {
  return typeof storeId === "string" && byId.has(storeId);
}

/** 店铺所在平台；不认识的店铺返回 null，由调用方决定怎么处理，这里不兜底。 */
export function platformOfStore(storeId) {
  return isKnownStore(storeId) ? byId.get(storeId).platform : null;
}

export function storeLabel(storeId) {
  return isKnownStore(storeId) ? byId.get(storeId).label : null;
}

/** 店铺对应的成本规则在 rules 里的键（ozonDandanshu / ozonMiska / wbCrossListing）。 */
export function profitRuleKeyOfStore(storeId) {
  return isKnownStore(storeId) ? byId.get(storeId).profitRuleKey : null;
}

export function storesOfPlatform(platform) {
  return STORES.filter(store => store.platform === platform).map(store => store.storeId);
}

/** { 店铺键: 平台 }，给还按对象查表的旧代码用。 */
export function storePlatformMap() {
  return Object.fromEntries(STORES.map(store => [store.storeId, store.platform]));
}

/** { 店铺键: 显示名 }，给界面下拉框和列表用。 */
export function storeLabelMap() {
  return Object.fromEntries(STORES.map(store => [store.storeId, store.label]));
}

/**
 * GET /api/stores 的返回内容。storeBindings 是 runtime-configuration 已校验过的店铺绑定；
 * 只看某家店有没有绑定，不把平台店铺号等身份字段带出去。
 */
export function listStores({ storeBindings = [] } = {}) {
  if (!Array.isArray(storeBindings)) throw new Error("STORE_REGISTRY_BINDINGS_INVALID: 店铺绑定必须是数组");
  const configured = new Set(storeBindings.map(binding => binding?.targetStore));
  return {
    registryVersion: STORE_REGISTRY_VERSION,
    platforms: PLATFORMS.map(item => ({ platform: item.platform, label: item.label, storeIds: storesOfPlatform(item.platform) })),
    stores: STORES.map(store => ({
      storeId: store.storeId,
      platform: store.platform,
      label: store.label,
      labelConfirmed: store.labelConfirmed,
      identityConfigured: configured.has(store.storeId)
    }))
  };
}
