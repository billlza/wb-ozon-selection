import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateDiscoveredProduct, pricingGuidance } from "./a-discovery-estimate.mjs";
import { categoryDefaultDimensions } from "./category-default-dimensions.mjs";
import { resolveLifecycleBProfitRule } from "./lifecycle-b-evidence-runtime.mjs";
import { storesOfPlatform } from "./store-registry.mjs";
import { profitAtPurchase } from "./supplier-draft.mjs";

/**
 * WB 粗算（统一改动清单第 7 条）：一件商品如果放到 WB 卖，每件大概赚多少、卖多少钱才过线。
 *
 * 和 Ozon 粗算同一套公式（estimateDiscoveredProduct + profitAtPurchase + pricingGuidance），只把三样输入换成 WB 的：
 *   - 佣金：项目里存的 WB 中国卖家佣金表（data/commissions/wb-china-2026-09-09*.json，字段 kgvpChina），按 WB 类目号取；
 *   - 物流：CEL 资费表 WB 页的陆运 Wb-Economy（lib/cel-tariff-reader.mjs），百克进位；陆空联运要先备货到珲春仓，单件直发不用它；
 *   - 店铺成本规则：rules.wbCrossListing（广告、退货、损耗、提现、贴单），和 Ozon 店一样由主人批准的那一份。
 * 永远是估算（assumed: true）：佣金表自己标着「参考，不能当正式利润证据」，WB 的正式 B 还没接（AGENTS §5）。
 * 这里只读已保存的记录，不写状态、不碰平台。
 */
export const WB_ROUGH_PROFIT_SCHEMA = "wb-rough-profit-v1";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 本项目采用的 WB 佣金表版本；换表要连这里一起改，版本对不上时佣金按缺失处理，不悄悄换数。 */
export const WB_COMMISSION_REFERENCE = Object.freeze({
  catalogPath: path.join(PROJECT_ROOT, "data", "commissions", "wb-china-2026-09-09.json"),
  sourcePath: path.join(PROJECT_ROOT, "data", "commissions", "wb-china-2026-09-09.source.json"),
  sellerRegion: "CN",
  versionState: Object.freeze({ catalogId: "wb-china-commission", catalogVersion: "2026-09-09T05:02:34.628109Z", status: "active" })
});

/**
 * 标题认 WB 类目：只认已经用真实商品核对过、存了映射的类目（data/platform-mappings/wb-<类目号>.json）。
 * 认不出来就空着，不拿别的类目的佣金顶。
 */
const WB_SUBJECT_GUESSES = Object.freeze([
  Object.freeze({ subjectId: 734, subjectName: "Жилеты для животных",
    patterns: Object.freeze([/(宠物|狗|猫)[^，,。；;\s]{0,4}(背心|马甲)/u, /жилет[^.,;]{0,30}(кош|кот|собак|пс[аоу]|щен|животн)/iu]) })
]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const text = (value, limit = 800) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

export function wbStoreId() {
  return storesOfPlatform("wb")[0] ?? null;
}

/**
 * 主人在请求里指定了类目号就用它；没指定时按标题认，认不出返回 null。
 * 先看我们自己的商品名（上架时的定位），再看货源标题：同一件货在货源那边可能按别的用途卖（背心那件是酒瓶装饰）。
 */
export function wbRoughSubject({ titles = [], wbSubject = null } = {}) {
  if (wbSubject !== null && wbSubject !== undefined && wbSubject !== "") {
    const subjectId = Number(wbSubject);
    return Number.isSafeInteger(subjectId) && subjectId > 0 ? { subjectId, subjectName: null, basis: "requested" } : null;
  }
  for (const title of titles.map(value => text(value)).filter(Boolean)) {
    const guess = WB_SUBJECT_GUESSES.find(rule => rule.patterns.some(pattern => pattern.test(title)));
    if (guess) return { subjectId: guess.subjectId, subjectName: guess.subjectName, basis: "title_guess" };
  }
  return null;
}

function activeProfitModel(candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const models = Array.isArray(sku?.profitModels) ? sku.profitModels : [];
  return models.find(model => model?.profitModelVersion === sku?.activeProfitModelVersion) ?? models.at(-1) ?? null;
}

function dimensionsOf(value) {
  if (!isObject(value)) return null;
  const sides = [value.length, value.width, value.height];
  return sides.every(positive) ? { lengthCm: sides[0], widthCm: sides[1], heightCm: sides[2] } : null;
}

const firstOf = options => options.find(([value]) => positive(value)) ?? [null, null];

/**
 * 粗算要的事实，全部从这件商品已经存下的记录里读：进价、重量、尺寸、售价、标题。
 * 售价默认取 Ozon 那边的数（正式利润的建议价、主人填的目标价、找同款的参考价），因为 WB 这边还没有自己的同款价；
 * 请求里给了 priceRub 就按它算。读不到的写进 missing，不猜。
 */
export function wbRoughFacts(candidate, { priceRub = null } = {}) {
  const draft = isObject(candidate?.supplierDraftV1) ? candidate.supplierDraftV1 : null;
  const rough = isObject(candidate?.roughProfit) ? candidate.roughProfit : null;
  const requestedPrice = priceRub === null || priceRub === undefined || priceRub === "" ? null : Number(priceRub);
  const requestedInvalid = requestedPrice !== null && !positive(requestedPrice);
  const [purchaseRmb, purchaseBasis] = firstOf([[draft?.allInPurchaseRmb, "supplier_draft"], [rough?.purchaseRmb, "intake_rough"],
    [candidate?.purchasePriceRmb, "candidate_purchase"]]);
  const [weightKg, weightBasis] = firstOf([[draft?.packedWeightKg, "supplier_draft"], [candidate?.packedWeightKg, "candidate_packed"],
    [rough?.weightKg, "intake_rough"]]);
  const [salePriceRub, priceBasis] = requestedInvalid ? [null, null] : firstOf([[requestedPrice, "requested"], [activeProfitModel(candidate)?.recommendedSalePriceRub, "ozon_formal_price"],
    [draft?.targetSalePriceRub, "owner_target_price"], [rough?.salePriceRub, "ozon_reference"], [candidate?.expectedPriceRub, "candidate_expected_price"]]);
  const titles = [text(candidate?.productName), text(candidate?.sourceCapture?.title)].filter(Boolean);
  const saved = dimensionsOf(draft?.dimensionsCm) ?? dimensionsOf(candidate?.dimensionsCm);
  const assumed = saved ? null : titles.map(title => categoryDefaultDimensions({ title })).find(Boolean) ?? null;
  const missing = [];
  if (requestedInvalid) missing.push("售价（请求里的价格无效）");
  else if (salePriceRub === null) missing.push("售价");
  if (purchaseRmb === null) missing.push("货源价");
  if (weightKg === null) missing.push("重量");
  if (!saved && !assumed) missing.push("尺寸");
  return {
    purchaseRmb, purchaseBasis, weightKg, weightBasis, salePriceRub, priceBasis, titles,
    dimensionsCm: saved ?? (assumed ? { lengthCm: assumed.lengthCm, widthCm: assumed.widthCm, heightCm: assumed.heightCm } : null),
    dimensionsBasis: saved ? "saved" : assumed ? "category_default" : null, dimensionsLabel: assumed?.label ?? null, missing
  };
}

/** WB 店的成本规则：主人保存的优先，默认值只补没存过的字段（和 Ozon 两家店同一个做法）。 */
export function wbStoreRule(document, fallbackRules) {
  const saved = isObject(document?.rules) ? document.rules : {};
  const rules = { ...fallbackRules, ...saved, wbCrossListing: { ...fallbackRules?.wbCrossListing, ...saved.wbCrossListing } };
  return resolveLifecycleBProfitRule({ targetStore: wbStoreId() }, rules);
}

/** 佣金表和物流表的读取，由 server.mjs 注入读文件的函数；每次调用各读一次，不缓存。 */
export function createWbRoughEstimateInputs({ readers, configuration = {} }) {
  if (typeof readers?.commission !== "function" || typeof readers?.tariff !== "function") throw new TypeError("WB_ROUGH_ESTIMATE_DEPENDENCY_INVALID");
  const reference = configuration.commissionReference ?? WB_COMMISSION_REFERENCE;
  const tariffFile = text(configuration.celTariffFile, 4096) || null;

  async function resolveCommission(subjectId, at) {
    const gap = code => ({ rate: null, tier: null, sourceRef: null, gaps: [{ code, field: "wbCommission", blocking: true }] });
    let read;
    try {
      read = await readers.commission({ catalogPath: reference.catalogPath, sourcePath: reference.sourcePath, asOf: at,
        scope: { platform: "wb", sellerRegion: reference.sellerRegion, subjectId, salesScheme: null },
        versionState: structuredClone(reference.versionState) });
    } catch (error) {
      return gap(text(error?.code, 120) || "WB_COMMISSION_REFERENCE_UNREADABLE");
    }
    if (read?.status !== "matched_with_gaps" || typeof read.commissionRate !== "number") return gap(`WB_COMMISSION_${String(read?.status ?? "unreadable").toUpperCase()}`);
    return { rate: read.commissionRate, tier: null, subjectName: read.matchedRow?.subjectName ?? null,
      sourceRef: `wb-commission:${read.source.catalogVersion}:subject-${subjectId}`, gaps: structuredClone(read.gaps) };
  }

  async function resolveFreightRows() {
    if (tariffFile === null) return { rows: [], ruleVersion: null, sourceRef: null, error: "CEL_TARIFF_NOT_CONFIGURED" };
    try {
      const catalog = await readers.tariff({ filePath: tariffFile });
      // 陆空联运 Wb-Express 要先把货备到珲春仓，单件从国内直发的粗算只比较不用备货的线路。
      const rows = (Array.isArray(catalog?.rows) ? catalog.rows : []).filter(row => row?.requiresPrestock === false)
        .map(row => ({ ...row, ruleVersion: catalog.ruleVersion }));
      return { rows, ruleVersion: text(catalog?.ruleVersion, 120) || null, sourceRef: text(catalog?.sourceRef, 400) || null, error: null };
    } catch (error) {
      return { rows: [], ruleVersion: null, sourceRef: null, error: error?.code === "ENOENT" ? "CEL_TARIFF_FILE_MISSING" : text(error?.code, 120) || "CEL_TARIFF_UNREADABLE" };
    }
  }

  return Object.freeze({ resolveCommission, resolveFreightRows });
}

const FREIGHT_MISSING = Object.freeze({ CEL_TARIFF_NOT_CONFIGURED: "WB 物流表（没配置 CEL 资费表）", CEL_TARIFF_FILE_MISSING: "WB 物流表（工作台里还没有 CEL 资费表文件）" });

/** 按事实和三样输入算出一份 WB 粗算。缺什么就停在 incomplete，并把缺的写成中文。 */
export function buildWbRoughProfit({ facts, subject, storeRule, fx, commission, freight, assumptions, estimatedAt }) {
  const base = {
    schemaVersion: WB_ROUGH_PROFIT_SCHEMA, platform: "wb", storeId: wbStoreId(), assumed: true, estimatedAt,
    salePriceRub: facts.salePriceRub, priceBasis: facts.priceBasis, purchaseRmb: facts.purchaseRmb, purchaseBasis: facts.purchaseBasis,
    weightKg: facts.weightKg, weightBasis: facts.weightBasis, dimensionsCm: facts.dimensionsCm, dimensionsBasis: facts.dimensionsBasis,
    dimensionsLabel: facts.dimensionsLabel, subjectId: subject?.subjectId ?? null, subjectName: commission?.subjectName ?? subject?.subjectName ?? null,
    subjectBasis: subject?.basis ?? null, commissionRate: commission?.rate ?? null, commissionGaps: commission?.gaps ?? [],
    route: null, chargeableKg: null, freightRmb: null, revenueCny: null, profitPerUnitRmb: null, marginRate: null, passes: null,
    breakEvenPriceRub: null, thresholdPriceRub: null, thresholdBasis: null,
    inputs: { tariffRuleVersion: freight?.ruleVersion ?? null, tariffSourceRef: freight?.sourceRef ?? null,
      commissionSourceRef: commission?.sourceRef ?? null, fxSourceRef: fx?.sourceRef ?? null, fxRateDate: fx?.rateDate ?? null,
      costPolicyVersion: typeof storeRule?.pricingPolicyVersion === "string" ? storeRule.pricingPolicyVersion : null }
  };
  const missing = [...facts.missing];
  if (!subject) missing.push("WB 类目（标题认不出来，要指定类目号）");
  else if (!positive(commission?.rate)) missing.push("WB 佣金");
  if (!storeRule) missing.push("WB 店铺费用规则");
  if (!(fx && positive(fx.rubPerCny))) missing.push("汇率");
  if (freight?.error) missing.push(FREIGHT_MISSING[freight.error] ?? "WB 物流表（读不出来）");
  if (missing.length) return { ...base, status: "incomplete", missing };
  const dimensionMm = `${facts.dimensionsCm.lengthCm * 10}x${facts.dimensionsCm.widthCm * 10}x${facts.dimensionsCm.heightCm * 10}`;
  const estimate = estimateDiscoveredProduct({
    product: { productId: null, price: facts.salePriceRub, weightGrams: Math.round(facts.weightKg * 1000), dimensionMm },
    storeRule, fx, commission, tariffRows: freight.rows, assumptions
  });
  const chosen = estimate.freight.chosen;
  const known = { ...base, route: chosen?.route ?? null, chargeableKg: chosen?.chargeableKg ?? null, freightRmb: chosen?.freightRmb ?? null,
    revenueCny: estimate.revenueCny };
  if (estimate.status === "incomplete") {
    return { ...known, status: "incomplete", missing: estimate.missing.map(item => (item === "可行物流线路" ? "可走的 WB 物流线路（重量或尺寸超出 CEL 限制）" : item)) };
  }
  const profit = profitAtPurchase({ estimate, allInPurchaseRmb: facts.purchaseRmb });
  const pricing = pricingGuidance({ fx, tiers: [{ tier: "wb_flat", minRub: 0, maxRub: null, rate: commission.rate }],
    costs: { allInPurchaseRmb: facts.purchaseRmb, nonPurchaseFixedRmb: estimate.ceiling.nonPurchaseFixedRmb }, policy: estimate.costPolicy });
  return { ...known, status: profit.unitProfitRmb < 0 ? "negative" : "ok", profitPerUnitRmb: profit.unitProfitRmb, marginRate: profit.marginRate,
    passes: profit.passes, breakEvenPriceRub: pricing.breakEven?.priceRub ?? null, thresholdPriceRub: pricing.threshold?.priceRub ?? null,
    thresholdBasis: pricing.threshold?.basis ?? null, missing: [] };
}

/**
 * GET /api/candidates/:id/wb-rough-profit 返回的内容：读这件的事实、认 WB 类目、取佣金 / 物流 / 汇率，算一次。
 * 汇率和 Ozon 粗算共用同一个读取（先用已存的官方汇率，没有才读一次央行）。
 */
export async function wbRoughProfitForCandidate({ document, candidate, priceRub = null, wbSubject = null, at, inputs, rules,
  resolveExchangeRate, assumptions }) {
  const facts = wbRoughFacts(candidate, { priceRub });
  const subject = wbRoughSubject({ titles: facts.titles, wbSubject });
  let storeRule = null;
  try { storeRule = wbStoreRule(document, rules); } catch { storeRule = null; }
  const [fx, freight, commission] = await Promise.all([resolveExchangeRate(document, at), inputs.resolveFreightRows(),
    subject ? inputs.resolveCommission(subject.subjectId, at) : null]);
  return { candidateId: candidate.id, dataRevision: candidate.dataRevision ?? null,
    ...buildWbRoughProfit({ facts, subject, storeRule, fx, commission, freight, assumptions, estimatedAt: at }) };
}
