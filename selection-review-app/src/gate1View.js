import { GATE1_PICK_TAGS, GATE1_SKIP_REASONS, gate1BrandRisk, gate1PickTag, gate1SkipInputErrors } from "../lib/gate1-preselect.mjs";

/**
 * 「做这件」卡要显示的东西，全部从服务端那份 gate1V1 里读：选项、软件先选的、每一对售价 × 货源的粗算。
 * 浏览器不算钱：主人换了一格，这里只换一个键去取服务端已经算好的那一格。
 */
export { GATE1_PICK_TAGS, GATE1_SKIP_REASONS };
export const GATE1_SHORTFALL_LABELS = Object.freeze({ change_supplier: "换货源", change_price: "改售价", skip: "不做" });
const FACT_FIELDS = Object.freeze({
  domesticShippingRmb: { label: "国内运费（元）", hint: "包邮填 0" },
  packedWeightKg: { label: "打包重量（公斤）", hint: "" },
  targetSalePriceRub: { label: "目标成交价（卢布）", hint: "" }
});
const WEIGHT_BASIS = Object.freeze({ captured: "采到的规格重量", seerfar: "Seerfar 记录的重量", declared: "之前填过的重量" });
const DIMENSION_BASIS = Object.freeze({ captured: "采到的尺寸", seerfar_volume: "Seerfar 记录的尺寸", category_default: "这一类商品常见的尺寸（估的）" });
const NUMBER = /^\d+(?:\.\d+)?$/u;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const yuan = value => (finite(value) === null ? null : `¥${value.toFixed(2)}`);
export const rubles = value => (finite(value) === null ? null : `${String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, " ")} ₽`);

/** 卡处在哪一种样子：hidden（不归这张卡管）、open（等主人做不做）、accepted、shortfall（正式利润没过线）、skipped。 */
export function gate1Mode(gate1, candidate) {
  if (!isObject(gate1)) return "hidden";
  if (isObject(gate1.shortfall)) return "shortfall";
  if (gate1.open === true) return "open";
  if (gate1.decision?.decision === "accept") return "accepted";
  if (gate1.decision?.decision === "skip" && candidate?.workflowStatus === "eliminated") return "skipped";
  return "hidden";
}

/** 主人当前选的三格：没动过的格子用软件先选的。 */
export function gate1Picks(gate1, local = {}) {
  const pre = gate1?.preselection ?? {};
  const value = key => (Object.hasOwn(local, key) ? local[key] : pre[key] ?? null);
  return { ozonProductId: value("ozonProductId"), matchOfferId: value("matchOfferId"), supplierOfferId: value("supplierOfferId") };
}

function profitLine(profit, estimate) {
  if (!isObject(estimate)) return { status: "unavailable", text: "粗算：本店成本规则、汇率或物流表读不到，还算不了。" };
  if (estimate.missing?.length) return { status: "incomplete", text: `粗算：还缺${estimate.missing.join("、")}，算不出来。` };
  if (!isObject(profit)) return { status: "incomplete", text: "粗算：这家货源的价格没读到，算不出来。" };
  const margin = finite(profit.marginRate) === null ? "" : `（利润率 ${(profit.marginRate * 100).toFixed(1)}%）`;
  const threshold = `本店门槛：每件 ≥ ${yuan(profit.minimumUnitProfitRmb)} ${profit.thresholdPolicy === "both" ? "且" : "或"}利润率 ≥ ${Math.round(profit.targetMarginRate * 100)}%`;
  const shipping = profit.shippingAssumedZero ? "；国内运费没读到，先按 0 算" : "";
  return { status: profit.passes ? "pass" : "fail",
    text: `粗算：每件赚 ${yuan(profit.unitProfitRmb)}${margin}，${profit.passes ? "过线" : "不过线"}。${threshold}${shipping}。这是估算，不是正式利润。` };
}

/**
 * 整张卡的显示数据。`local` 是主人在卡上改过的格子，`facts` 是补的那几项（字符串，原样来自输入框）。
 */
export function gate1CardView(gate1, { local = {}, facts = {} } = {}) {
  const picks = gate1Picks(gate1, local);
  const pre = gate1?.preselection ?? {};
  const ozonOptions = Array.isArray(gate1?.ozonOptions) ? gate1.ozonOptions : [];
  const supplierOptions = Array.isArray(gate1?.supplierOptions) ? gate1.supplierOptions : [];
  const ozon = ozonOptions.find(row => row.productId === picks.ozonProductId) ?? null;
  const match = supplierOptions.find(row => row.offerId === picks.matchOfferId) ?? null;
  const supplier = supplierOptions.find(row => row.offerId === picks.supplierOfferId) ?? null;
  const priceKey = ozon ? ozon.productId : "market";
  const cell = gate1?.roughProfit?.byPrice?.[priceKey] ?? null;
  const profit = supplier ? cell?.profits?.[supplier.offerId] ?? null : null;
  const reopenPrice = gate1?.reopen?.choice === "change_price";
  const targetPrice = ozon?.priceRub ?? finite(gate1?.marketPriceRub);
  const packageFacts = gate1?.packageFacts ?? {};
  const realDimensions = ["captured", "seerfar_volume"].includes(packageFacts.dimensionsBasis);
  const askFor = [];
  if (supplier && supplier.domesticShippingRmb === null) askFor.push("domesticShippingRmb");
  if (finite(packageFacts.weightGrams) === null) askFor.push("packedWeightKg");
  if (!realDimensions) askFor.push("dimensionsCm");
  if (targetPrice === null || reopenPrice) askFor.push("targetSalePriceRub");
  const factErrors = {};
  for (const key of askFor) {
    if (key === "dimensionsCm") {
      for (const side of ["length", "width", "height"]) {
        if (!(NUMBER.test(String(facts[side] ?? "").trim()) && Number(facts[side]) > 0)) factErrors[side] = "填大于 0 的厘米数";
      }
      continue;
    }
    const value = String(facts[key] ?? "").trim();
    const ok = NUMBER.test(value) && (key === "domesticShippingRmb" ? Number(value) >= 0 : Number(value) > 0);
    if (!ok) factErrors[key] = key === "domesticShippingRmb" ? "填国内运费，包邮填 0" : "填大于 0 的数字";
  }
  const blockers = [];
  if (!supplier) blockers.push(supplierOptions.length ? "先选一家货源" : "1688 找同款还没有找到同款，先在下面找一次");
  if (supplier && supplier.priceCny === null) blockers.push("这家货源的价格没读到，换一家");
  if (supplier && supplier.quantityBegin !== null && supplier.quantityBegin > 1) blockers.push("这家货源不能一件起订，换一家");
  if (Object.keys(factErrors).length) blockers.push("把下面缺的几项补上");
  const brand = gate1BrandRisk({ marketBrand: gate1?.marketBrand ?? null, ozonTitle: ozon?.title, supplierTitle: supplier?.title });
  return {
    picks, ozon, match, supplier, ozonOptions, supplierOptions,
    tags: { ozon: gate1PickTag(pre.ozonProductId ?? null, picks.ozonProductId), match: gate1PickTag(pre.matchOfferId ?? null, picks.matchOfferId),
      supplier: gate1PickTag(pre.supplierOfferId ?? null, picks.supplierOfferId) },
    targetPriceRub: targetPrice,
    profit: profitLine(profit, cell?.estimate ?? null),
    basisLine: basisLine(gate1?.roughProfit ?? null, packageFacts),
    brand,
    askFor: askFor.map(key => key === "dimensionsCm" ? { key, label: "包装长宽高（厘米）", hint: "读不到真实尺寸；粗算按类目常见尺寸估，正式算利润要真实的" }
      : { key, ...FACT_FIELDS[key], hint: key === "targetSalePriceRub" && targetPrice !== null ? `Ozon 同款现在卖 ${rubles(targetPrice)}` : FACT_FIELDS[key].hint }),
    factErrors,
    blockers,
    canAccept: blockers.length === 0
  };
}

function basisLine(roughProfit, packageFacts) {
  const weight = WEIGHT_BASIS[roughProfit?.weightBasis ?? packageFacts.weightBasis];
  const dimensions = DIMENSION_BASIS[roughProfit?.dimensionsBasis ?? packageFacts.dimensionsBasis];
  const parts = [weight ? `重量按${weight}` : "重量还没有", dimensions ? `尺寸按${dimensions}` : "尺寸还没有"];
  return `${parts.join("，")}。`;
}

/** 做这件的请求体：只带选中的三格和主人补的那几项。 */
export function gate1AcceptPayload(gate1, card, facts, dataRevision) {
  const extra = {};
  for (const item of card.askFor) {
    if (item.key === "dimensionsCm") {
      extra.dimensionsCm = { length: Number(facts.length), width: Number(facts.width), height: Number(facts.height) };
    } else extra[item.key] = Number(facts[item.key]);
  }
  return {
    dataRevision,
    ozonProductId: card.picks.ozonProductId ?? null,
    matchOfferId: card.picks.matchOfferId ?? null,
    supplierOfferId: card.picks.supplierOfferId,
    ...(Object.keys(extra).length ? { facts: extra } : {})
  };
}

export function gate1SkipErrors(reason, note) {
  return gate1SkipInputErrors({ reason, note });
}

export function gate1SkipPayload(reason, note, dataRevision) {
  const value = typeof note === "string" ? note.trim() : "";
  return { dataRevision, reason, ...(value ? { note: value } : {}) };
}

/** 做过之后卡上剩的那一行。 */
export function gate1AcceptedLine(decision) {
  const picks = decision?.picks ?? {};
  const tag = row => (row?.tag ? `（${GATE1_PICK_TAGS[row.tag]}）` : "");
  const ozon = picks.ozon ? `Ozon 同款 ${picks.ozon.title}${tag(picks.ozon)}` : "没选 Ozon 同款";
  const supplier = picks.supplier ? `货源 ${picks.supplier.title}${picks.supplier.priceCny !== null ? ` ${yuan(picks.supplier.priceCny)}` : ""}${tag(picks.supplier)}` : "";
  const rough = decision?.roughProfitAtDecision;
  const profit = rough ? `；当时粗算每件 ${yuan(rough.unitProfitRmb)}` : "";
  return `已做这件：${ozon}；${supplier}${profit}。接下来软件采这家货源的规格，再算正式利润。`;
}

/** 正式利润没过线那一行。 */
export function gate1ShortfallView(shortfall) {
  if (!isObject(shortfall)) return null;
  const unit = finite(shortfall.unitProfitRmb) === null ? "没算出" : yuan(shortfall.unitProfitRmb);
  const margin = finite(shortfall.profitMargin) === null ? "" : `、利润率 ${(shortfall.profitMargin * 100).toFixed(1)}%`;
  const gap = finite(shortfall.shortfallRmb) === null ? "" : `，离门槛还差每件 ${yuan(shortfall.shortfallRmb)}`;
  const threshold = finite(shortfall.minimumUnitProfitRmb) === null ? "" :
    `（门槛：每件 ≥ ${yuan(shortfall.minimumUnitProfitRmb)} 或利润率 ≥ ${Math.round((shortfall.minimumProfitMargin ?? 0) * 100)}%）`;
  return { line: `正式利润没过线：每件赚 ${unit}${margin}${gap}${threshold}。`,
    choices: (Array.isArray(shortfall.choices) ? shortfall.choices : Object.keys(GATE1_SHORTFALL_LABELS))
      .filter(choice => Object.hasOwn(GATE1_SHORTFALL_LABELS, choice)).map(choice => ({ choice, label: GATE1_SHORTFALL_LABELS[choice] })) };
}

/** 重新打开的那一轮，卡顶上说一句上一轮怎么了。 */
export function gate1ReopenLine(reopen) {
  if (!isObject(reopen)) return null;
  const gap = finite(reopen.shortfallRmb) === null ? "" : `，差每件 ${yuan(reopen.shortfallRmb)}`;
  const price = finite(reopen.previousTargetSalePriceRub) === null ? "" : `上一轮按 ${rubles(reopen.previousTargetSalePriceRub)} 卖`;
  return reopen.choice === "change_price"
    ? `${price}正式利润没过线${gap}。改一个售价再做这件；上一轮的记录都留着。`
    : `上一轮的货源正式利润没过线${gap}。换一家货源再做这件；上一轮的记录都留着。`;
}
