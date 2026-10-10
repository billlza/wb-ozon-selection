/**
 * 「做这件」卡（关口 1）上软件先选好的三样东西：最像的 Ozon 同款、最像的 1688 同款、最便宜又能一件起订的货源。
 *
 * 这里只读 candidate.ozonImageMatch / candidate.supplierImageMatch 里已经保存的找同款结果和主人逐条点过的判断，
 * 不访问任何平台，也不改任何记录。软件先选的永远只是「建议」：主人点「做这件」之前，什么都没有确认（AGENTS.md §4.3、§4.4）。
 *
 * 浏览器和服务端读的是同一份规则，所以这个文件不能 import 任何 Node 模块。
 */
/** 和 lib/store-profile.mjs 的 SKIP_REASONS 同一组码和字（测试逐字对齐）；那边连着 node:crypto，进不了浏览器。 */
export const GATE1_SKIP_REASONS = Object.freeze({ too_large: "尺寸太大", thin_profit: "利润太薄", brand_risk: "品牌风险",
  not_this_kind: "不想做这类", other: "其他" });
export const GATE1_PICK_TAGS = Object.freeze({ software: "软件先选的", owner: "你改过" });
export const GATE1_SLOTS = Object.freeze(["ozon", "match", "supplier"]);
const SIMILARITY_ORDER = Object.freeze(["identical", "similar"]);
const MAX_NOTE_LENGTH = 200;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = value => (typeof value === "string" ? value.trim() : "");

function judgementOf(record, id) {
  const judgements = isObject(record?.judgements) ? record.judgements : {};
  const value = judgements[id]?.judgement;
  return ["exact", "near", "wrong"].includes(value) ? value : null;
}

/** 找同款的结果只有读回来、比过首图之后才能拿来挑。 */
function usableResults(record) {
  if (!isObject(record) || !["comparing", "compared"].includes(record.status)) return [];
  return Array.isArray(record.results) ? record.results.filter(isObject) : [];
}

/**
 * 一条结果能不能被软件先选上：主人点过「是同款」的一定能；没点过的只看首图一致或很像。
 * 主人说过「近似款」或「不是」的永远不选——近似款只能当价格参考，不能当同款或货源（AGENTS.md §4.3）。
 */
function rankedRows(record, idKey) {
  return usableResults(record).map((item, order) => ({ item, order, id: text(item[idKey]), judgement: judgementOf(record, item[idKey]) }))
    .filter(row => row.id !== "" && row.judgement !== "wrong" && row.judgement !== "near" &&
      (row.judgement === "exact" || SIMILARITY_ORDER.includes(row.item.similarity)))
    .sort((left, right) => (left.judgement === "exact" ? 0 : 1) - (right.judgement === "exact" ? 0 : 1) ||
      SIMILARITY_ORDER.indexOf(left.item.similarity) - SIMILARITY_ORDER.indexOf(right.item.similarity) ||
      (finite(left.item.distance) ?? 99) - (finite(right.item.distance) ?? 99) || left.order - right.order);
}

/**
 * 1688 搜图结果每条带一句价格说明，比如「运费5元」「包邮」。读得懂就给出国内运费，读不懂就是 null——不猜。
 */
export function domesticShippingFromPriceNote(note) {
  const value = text(note);
  if (value === "") return null;
  if (/包邮|免运费/u.test(value)) return 0;
  const match = value.match(/运费\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*元?/u);
  return match ? Math.round(Number(match[1]) * 100) / 100 : null;
}

/** 一件起订：1688 页面写着起批量 1 才算；没读到起批量的不算，留给主人打开页面核对。 */
export const moqOne = item => finite(item?.quantityBegin) === 1;

function supplierRow(row) {
  const shipping = domesticShippingFromPriceNote(row.item.priceNote);
  const priceCny = finite(row.item.priceCny);
  return Object.freeze({
    offerId: row.id,
    sourceUrl: text(row.item.sourceUrl) || `https://detail.1688.com/offer/${row.id}.html`,
    title: text(row.item.title) || `1688 商品 ${row.id}`,
    imageUrl: text(row.item.imageUrl) || null,
    similarity: row.item.similarity ?? "unknown",
    judgement: row.judgement,
    priceCny,
    priceNote: text(row.item.priceNote) || null,
    domesticShippingRmb: shipping,
    allInPurchaseRmb: priceCny === null ? null : Math.round((priceCny + (shipping ?? 0)) * 100) / 100,
    shippingKnown: shipping !== null,
    quantityBegin: finite(row.item.quantityBegin),
    moqOne: moqOne(row.item),
    shopName: text(row.item.shopName) || null,
    isSourceOffer: row.item.isSourceOffer === true
  });
}

function ozonRow(row) {
  return Object.freeze({
    productId: row.id,
    sourceUrl: text(row.item.sourceUrl) || `https://www.ozon.ru/product/${row.id}/`,
    title: text(row.item.title) || `Ozon 商品 ${row.id}`,
    imageUrl: text(row.item.imageUrl) || null,
    similarity: row.item.similarity ?? "unknown",
    judgement: row.judgement,
    priceRub: finite(row.item.priceRub),
    reviewCount: finite(row.item.reviewCount),
    isSourceProduct: row.item.isSourceProduct === true
  });
}

/** 能当 Ozon 同款的那几条，最像的排第一。 */
export function gate1OzonOptions(candidate) {
  return rankedRows(candidate?.ozonImageMatch, "productId").map(ozonRow);
}

/** 能当 1688 同款 / 货源的那几条，最像的排第一。 */
export function gate1SupplierOptions(candidate) {
  return rankedRows(candidate?.supplierImageMatch, "offerId").map(supplierRow);
}

/**
 * 最便宜又能一件起订的那一家：只在同款候选里挑，按货价加读得出的国内运费排；没读到价格的不算。
 * 一件起订是供货方案的硬门禁（AGENTS.md §4.3），所以起批量没读到的也不算。
 */
export function cheapestMoqOne(options) {
  return options.filter(row => row.moqOne && row.allInPurchaseRmb !== null)
    .reduce((best, row) => (best === null || row.allInPurchaseRmb < best.allInPurchaseRmb ? row : best), null);
}

/** 软件先选的三样。哪一样没有可选的就是 null，卡上照实说没找到。 */
export function gate1Preselection(candidate) {
  const ozon = gate1OzonOptions(candidate);
  const suppliers = gate1SupplierOptions(candidate);
  return Object.freeze({
    ozonProductId: ozon[0]?.productId ?? null,
    matchOfferId: suppliers[0]?.offerId ?? null,
    supplierOfferId: cheapestMoqOne(suppliers)?.offerId ?? null
  });
}

/** 每一格是软件先选的，还是主人改过的。 */
export function gate1PickTag(softwareId, chosenId) {
  if (chosenId === null || chosenId === undefined || chosenId === "") return null;
  return chosenId === softwareId ? "software" : "owner";
}

const BRAND_FREE = /^(?:нет бренда|без бренда|no brand|noname|无品牌|无|none|-)$/iu;
const SUPPLIER_BRAND_WORDS = /正品|官方旗舰|品牌授权|授权店|专柜|联名|官方正版|正版授权|迪士尼|disney|hello\s*kitty|三丽鸥|sanrio|宝可梦|pokemon|漫威|marvel|乐高|lego/iu;

/**
 * 品牌风险那一行。软件只看得到三样东西：这件商品市场记录里的品牌字段、选中的 Ozon 同款标题、选中的 1688 货源标题。
 * 看见品牌或授权字样就直说；什么都没看见也只说「没看到」，不说「没有品牌风险」——第三方品牌/IP 的判断由主人做（AGENTS.md §4.2）。
 */
export function gate1BrandRisk({ marketBrand = null, ozonTitle = null, supplierTitle = null } = {}) {
  const brand = text(marketBrand);
  const signals = [];
  if (brand !== "" && !BRAND_FREE.test(brand)) signals.push(`Ozon 上这件商品标着品牌「${brand}」`);
  const supplierHit = text(supplierTitle).match(SUPPLIER_BRAND_WORDS);
  if (supplierHit) signals.push(`1688 货源标题里有「${supplierHit[0]}」`);
  const ozonHit = text(ozonTitle).match(SUPPLIER_BRAND_WORDS);
  if (ozonHit) signals.push(`Ozon 同款标题里有「${ozonHit[0]}」`);
  if (signals.length) {
    return Object.freeze({ level: "warn", line: `品牌风险：${signals.join("；")}。确认不是第三方品牌或授权款再做，是的话点「不做这件」选「品牌风险」。` });
  }
  return Object.freeze({ level: "none_seen", line: "品牌风险：品牌字段和两边标题里没看到品牌或授权字样。软件只查了这几处，图上的商标和 IP 形象要你自己看一眼。" });
}

/** 不做这件：原因只能是给定的五个；「其他」要写一句备注。备注只收短的一行纯文本。 */
export function gate1SkipInputErrors({ reason, note }) {
  if (!Object.hasOwn(GATE1_SKIP_REASONS, reason)) return "请选一个不做的原因";
  if (note !== undefined && note !== null && typeof note !== "string") return "备注只能是文字";
  const value = typeof note === "string" ? note.trim() : "";
  if (value.length > MAX_NOTE_LENGTH || /\p{Cc}/u.test(value)) return `备注最多 ${MAX_NOTE_LENGTH} 个字的一行文字`;
  if (reason === "other" && value === "") return "选「其他」时写一句为什么";
  return null;
}
