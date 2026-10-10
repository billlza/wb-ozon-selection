/**
 * A-stage estimate for a discovered market product (owner decisions 2026-09-10): the code computes every number from
 * evidenced inputs (official commission, official FX, GUOO tariff rows, the store's cost policy); nothing is guessed.
 * Oversize (volumetric weight above actual) is an informational flag only. A negative purchase ceiling means the
 * product is excluded from the owner's selectable pool; that exclusion is the caller's job, this module only reports.
 */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonNegative = value => finite(value) && value >= 0;
const fail = (code, detail = '') => { throw new Error(`A_DISCOVERY_ESTIMATE_${code}${detail ? `: ${detail}` : ''}`); };
/** Same rounding as workflow.mjs roundDownCurrency: floor to cents (negative values floor away from zero). */
export function roundDownCents(value) { return Math.floor(value * 100 + 1e-9) / 100; }
const VOLUME_DIVISOR_CM3_PER_KG = 12000;

/** "0.001-2KG" / "2.001-30KG\n收抛" → {minKg, maxKg}; unknown text → null (row cannot be judged). */
export function parseWeightLimitKg(text) {
  if (typeof text !== 'string') return null;
  const match = text.replace(/\s+/g, '').match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)KG/i);
  if (!match) return null;
  const minKg = Number(match[1]), maxKg = Number(match[2]);
  return minKg <= maxKg ? { minKg, maxKg } : null;
}

/** "三边之和不超150CM，单边最大尺寸不超60CM" / "…不超310CM，单边最大尺寸不超150*80*80CM" → {sumMaxCm, sideMaxCm[] (sorted descending)}. */
export function parseSizeLimitCm(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, '');
  const sum = flat.match(/三边之和不超(\d+(?:\.\d+)?)CM/i);
  const side = flat.match(/单边最大尺寸不超(\d+(?:\.\d+)?(?:\*\d+(?:\.\d+)?){0,2})CM/i);
  if (!sum && !side) return null;
  const sides = side ? side[1].split('*').map(Number) : null;
  return { sumMaxCm: sum ? Number(sum[1]) : null,
    sideMaxCm: sides === null ? null : (sides.length === 1 ? [sides[0], sides[0], sides[0]] : sides).sort((a, b) => b - a) };
}

/** Same text format as the formal stage's GUOO price band (guoo-route-comparison rangeFromText): "1-1500₽" → {min, max}; anything else → null. */
export function parsePriceLimitRub(text) {
  if (typeof text !== 'string') return null;
  const match = text.replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)₽$/);
  if (!match) return null;
  const min = Number(match[1]), max = Number(match[2]);
  return min > 0 && max > 0 && min <= max ? { min, max } : null;
}

const validDefaultDimensions = value => isObject(value) && ['lengthCm', 'widthCm', 'heightCm'].every(key => finite(value[key]) && value[key] > 0) &&
  typeof value.label === 'string' && value.label.trim() !== '' && value.label.length <= 40;

/**
 * Captured dimensions always win. Only when the caller opts in (粗算 only, never formal profit) and the actual weight is
 * known does a missing size fall back to a cube of the provider's volume, then to the caller's category default.
 */
function packageFacts(product, { allowAssumed = false, defaultDimensions = null } = {}) {
  const actualKg = nonNegative(product.weightGrams) ? product.weightGrams / 1000 : null;
  let sidesCm = null, basis = null;
  if (typeof product.dimensionMm === 'string' && /^\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?[x×]\d+(?:\.\d+)?$/.test(product.dimensionMm.trim())) {
    sidesCm = product.dimensionMm.trim().split(/[x×]/).map(value => Number(value) / 10).sort((a, b) => b - a);
    if (sidesCm.some(value => !(value > 0))) sidesCm = null;
    else basis = 'captured';
  }
  if (sidesCm === null && allowAssumed && actualKg !== null) {
    if (finite(product.volumeLitres) && product.volumeLitres > 0) {
      // Cube side rounded up to the millimetre, so the assumed box is never smaller than the provider's volume.
      const side = Math.ceil(Math.cbrt(product.volumeLitres * 1000) * 10 - 1e-9) / 10;
      sidesCm = [side, side, side]; basis = 'seerfar_volume';
    } else if (defaultDimensions !== null) {
      sidesCm = [defaultDimensions.lengthCm, defaultDimensions.widthCm, defaultDimensions.heightCm].sort((a, b) => b - a); basis = 'category_default';
    }
  }
  const volumetricKg = sidesCm ? sidesCm[0] * sidesCm[1] * sidesCm[2] / VOLUME_DIVISOR_CM3_PER_KG : null;
  return { actualKg, sidesCm, volumetricKg, dimensionsBasis: basis, dimensionsLabel: basis === 'category_default' ? defaultDimensions.label : null };
}

function evaluateRoute(row, facts, { priceRub, enforcePriceLimit }) {
  const tariff = row?.evidenceData;
  if (!isObject(tariff) || !nonNegative(tariff.perKgRmb) || !nonNegative(tariff.perParcelRmb)) return { route: row?.route ?? null, feasible: false, reason: 'tariff_row_invalid' };
  const weight = parseWeightLimitKg(tariff.weightLimit), size = parseSizeLimitCm(tariff.sizeLimit ?? row.sizeLimit);
  if (!weight || !size) return { route: row.route, feasible: false, reason: 'limits_unparsed' };
  const volumetric = tariff.chargeableWeightRule === 'max_actual_volume';
  if (facts.actualKg === null && !volumetric) return { route: row.route, feasible: false, reason: 'actual_weight_missing' };
  if (facts.sidesCm === null) return { route: row.route, feasible: false, reason: 'dimensions_missing' };
  const minimum = nonNegative(tariff.minimumChargeableWeightKg) ? tariff.minimumChargeableWeightKg : 0;
  const divisor = volumetric && nonNegative(tariff.volumeDivisorCm3PerKg) && tariff.volumeDivisorCm3PerKg > 0 ? tariff.volumeDivisorCm3PerKg : VOLUME_DIVISOR_CM3_PER_KG;
  const volumetricKg = volumetric ? facts.sidesCm[0] * facts.sidesCm[1] * facts.sidesCm[2] / divisor : null;
  const weightForLimit = facts.actualKg ?? volumetricKg;
  if (weightForLimit < weight.minKg || weightForLimit > weight.maxKg) return { route: row.route, feasible: false, reason: 'weight_outside_limit' };
  const sum = facts.sidesCm[0] + facts.sidesCm[1] + facts.sidesCm[2];
  if (size.sumMaxCm !== null && sum > size.sumMaxCm) return { route: row.route, feasible: false, reason: 'size_sum_outside_limit' };
  if (size.sideMaxCm !== null && facts.sidesCm.some((side, index) => side > size.sideMaxCm[index])) return { route: row.route, feasible: false, reason: 'side_outside_limit' };
  // Opt-in like the assumed sizes: a parsed band always rides on the route, but rejects only when the caller asks; an unparsed band never rejects.
  const price = parsePriceLimitRub(tariff.declaredValueLimitRub);
  if (enforcePriceLimit && price !== null && (priceRub < price.min || priceRub > price.max)) return { route: row.route, feasible: false, reason: 'price_outside_limit' };
  const chargeableKg = Math.max(facts.actualKg ?? 0, volumetricKg ?? 0, minimum);
  return { route: row.route, feasible: true, reason: null, chargeableWeightRule: tariff.chargeableWeightRule, chargeableKg: Math.round(chargeableKg * 1000) / 1000,
    volumetricKg: volumetricKg === null ? null : Math.round(volumetricKg * 1000) / 1000, freightRmb: roundDownCents(chargeableKg * tariff.perKgRmb + tariff.perParcelRmb),
    perKgRmb: tariff.perKgRmb, perParcelRmb: tariff.perParcelRmb, priceLimitRub: price, ruleVersion: row.ruleVersion ?? null, actualWeightMissing: facts.actualKg === null };
}

/** Cost policy values exactly as the store rule carries them (see workflow.mjs profitRule / currentProfitResult). */
export function costPolicyFromStoreRule(storeRule) {
  if (!isObject(storeRule)) fail('STORE_RULE_INVALID');
  const numbers = ['advertisingReserveRate', 'returnOpsReserveRate', 'damageLossReserveRate', 'withdrawalFeeRate', 'labelCostRmb', 'fixedOtherRmb', 'minimumUnitProfitRmb', 'targetMarginRate'];
  const policy = {};
  for (const key of numbers) {
    const value = Number(storeRule[key] ?? 0);
    if (!nonNegative(value)) fail('STORE_RULE_INVALID', key);
    policy[key] = value;
  }
  policy.thresholdPolicy = storeRule.thresholdPolicy === 'both' ? 'both' : 'either';
  policy.pricingPolicyVersion = typeof storeRule.pricingPolicyVersion === 'string' ? storeRule.pricingPolicyVersion : null;
  return policy;
}

export function estimateDiscoveredProduct({ product, storeRule, fx, commission, tariffRows, assumptions }) {
  if (!isObject(product) || !finite(product.price) || product.price <= 0) fail('PRODUCT_INVALID');
  if (!isObject(assumptions) || !nonNegative(assumptions.packagingRmbDefault)) fail('ASSUMPTIONS_INVALID', 'packagingRmbDefault');
  for (const flag of ['allowAssumedDimensions', 'enforcePriceLimit']) if (assumptions[flag] !== undefined && typeof assumptions[flag] !== 'boolean') fail('ASSUMPTIONS_INVALID', flag);
  const defaultDimensions = assumptions.defaultDimensionsCm ?? null;
  if (defaultDimensions !== null && !validDefaultDimensions(defaultDimensions)) fail('ASSUMPTIONS_INVALID', 'defaultDimensionsCm');
  if (!Array.isArray(tariffRows)) fail('TARIFF_ROWS_INVALID');
  const policy = costPolicyFromStoreRule(storeRule);
  const missing = [];
  const fxSource = isObject(fx) && finite(fx.rubPerCny) && fx.rubPerCny > 0 ? { rubPerCny: fx.rubPerCny, rateDate: fx.rateDate ?? null, sourceRef: fx.sourceRef ?? null } : null;
  if (!fxSource) missing.push('汇率');
  const commissionSource = { rate: isObject(commission) && finite(commission.rate) && commission.rate >= 0 && commission.rate < 1 ? commission.rate : null,
    tier: commission?.tier ?? null, sourceRef: commission?.sourceRef ?? null, gaps: Array.isArray(commission?.gaps) ? structuredClone(commission.gaps) : [] };
  if (commissionSource.rate === null) missing.push('官方佣金');
  const facts = packageFacts(product, { allowAssumed: assumptions.allowAssumedDimensions === true, defaultDimensions });
  const routes = tariffRows.map(row => evaluateRoute(row, facts, { priceRub: product.price, enforcePriceLimit: assumptions.enforcePriceLimit === true }));
  const feasibleRoutes = routes.filter(route => route.feasible).sort((a, b) => a.freightRmb - b.freightRmb);
  const chosen = feasibleRoutes[0] ?? null;
  const freight = { status: facts.actualKg === null && facts.sidesCm === null ? 'unknown_dimensions' : chosen ? 'quoted' : 'no_feasible_route',
    actualKg: facts.actualKg, sidesCm: facts.sidesCm, dimensionsBasis: facts.dimensionsBasis,
    dimensionsAssumed: facts.dimensionsBasis === 'seerfar_volume' || facts.dimensionsBasis === 'category_default', dimensionsLabel: facts.dimensionsLabel, volumetricKg: facts.volumetricKg === null ? null : Math.round(facts.volumetricKg * 1000) / 1000,
    oversize: facts.actualKg !== null && facts.volumetricKg !== null && facts.volumetricKg > facts.actualKg,
    chosen, feasibleRoutes, rejectedRoutes: routes.filter(route => !route.feasible).map(route => ({ route: route.route, reason: route.reason })),
    noFeasibleRoute: chosen === null && facts.sidesCm !== null };
  if (freight.status === 'unknown_dimensions') missing.push('包装尺寸重量');
  else if (freight.status === 'no_feasible_route') missing.push('可行物流线路');
  const revenueCny = fxSource ? roundDownCents(product.price / fxSource.rubPerCny) : null;
  let ceiling = null;
  if (missing.length === 0) {
    const reserveRate = commissionSource.rate + policy.advertisingReserveRate + policy.returnOpsReserveRate + policy.damageLossReserveRate + policy.withdrawalFeeRate;
    const fixed = chosen.freightRmb + assumptions.packagingRmbDefault + policy.labelCostRmb + policy.fixedOtherRmb;
    const profitLimited = roundDownCents(revenueCny * (1 - reserveRate) - fixed - policy.minimumUnitProfitRmb);
    const marginLimited = roundDownCents(revenueCny * (1 - reserveRate - policy.targetMarginRate) - fixed);
    const maximumAllInPurchaseRmb = roundDownCents(policy.thresholdPolicy === 'both' ? Math.min(profitLimited, marginLimited) : Math.max(profitLimited, marginLimited));
    const midPurchase = maximumAllInPurchaseRmb > 0 ? roundDownCents(maximumAllInPurchaseRmb / 2) : 0;
    const unitProfitAtMid = roundDownCents(revenueCny * (1 - reserveRate) - fixed - midPurchase);
    ceiling = { reserveRate: Math.round(reserveRate * 10000) / 10000, nonPurchaseFixedRmb: roundDownCents(fixed), profitLimitedCeilingRmb: profitLimited, marginLimitedCeilingRmb: marginLimited,
      maximumAllInPurchaseRmb, midPurchaseRmb: midPurchase, unitProfitAtMidRmb: unitProfitAtMid, marginAtMid: revenueCny > 0 ? Math.round(unitProfitAtMid / revenueCny * 10000) / 10000 : null,
      freightShareOfRevenue: revenueCny > 0 ? Math.round(chosen.freightRmb / revenueCny * 10000) / 10000 : null };
  }
  const status = missing.length ? 'incomplete' : ceiling.maximumAllInPurchaseRmb <= 0 ? 'negative' : 'ok';
  return { schemaVersion: 'a-discovery-estimate-v1', productId: product.productId ?? null, priceRub: product.price, revenueCny, fx: fxSource,
    commission: commissionSource, costPolicy: policy,
    // 这笔「每单额外操作费」是不是一个假设值，由调用方说了算：发现批量估算那条路没有商品可问，只能按项目默认值假设；
    // 单件商品那条路问的是这件货自己的声明，那就不是假设。旧调用方不传这个标记，行为一个字都不变。
    assumptions: { packagingRmbDefault: assumptions.packagingRmbDefault, assumed: assumptions.extraHandlingDeclared !== true },
    freight, ceiling, status, missing };
}

/**
 * Pricing guidance (owner question 2026-09-11: "目标成交价应该平台算给我看，我怎么知道卖多少钱是赚钱的").
 *
 * The profit formula is exactly the one `estimateDiscoveredProduct` and the supplier draft already use — revenue at the
 * official FX, minus the reserve rates, minus the non-purchase fixed costs, minus the declared purchase — read backwards
 * to answer "which sale price reaches this profit". Nothing here invents a rate: the commission ladder is handed in by
 * the caller exactly as the official table carries it, including the ruble band each rate applies to. Because the rate
 * jumps at a band edge, the inverse is solved once inside every band and only a solution that actually falls inside its
 * own band is kept; the answer is the cheapest legal price across the bands.
 */
const PRICE_SEARCH_STEPS = 24;

const tierBand = tier => {
  if (!isObject(tier) || !finite(tier.rate) || tier.rate < 0 || tier.rate >= 1 || !nonNegative(tier.minRub)) return null;
  const max = tier.maxRub === null ? Infinity : finite(tier.maxRub) && tier.maxRub > tier.minRub ? tier.maxRub : null;
  return max === null ? null : { min: Math.max(tier.minRub, 1), max };
};

/** The band one price falls in, read from the bands themselves; a price outside every band has no rate. */
export function commissionTierForPrice(tiers, priceRub) {
  if (!Array.isArray(tiers) || !finite(priceRub)) return null;
  return tiers.find(tier => {
    const band = tierBand(tier);
    return band !== null && priceRub >= band.min && priceRub <= band.max;
  }) ?? null;
}

function pricingContext({ fx, costs, policy }) {
  if (!isObject(fx) || !finite(fx.rubPerCny) || fx.rubPerCny <= 0) return null;
  if (!isObject(costs) || !finite(costs.allInPurchaseRmb) || !finite(costs.nonPurchaseFixedRmb)) return null;
  if (!isObject(policy)) return null;
  const reserveBase = ['advertisingReserveRate', 'returnOpsReserveRate', 'damageLossReserveRate', 'withdrawalFeeRate']
    .reduce((total, key) => (nonNegative(policy[key]) ? total + policy[key] : NaN), 0);
  if (!finite(reserveBase)) return null;
  return { rubPerCny: fx.rubPerCny, reserveBase,
    totalCostRmb: roundDownCents(costs.allInPurchaseRmb + costs.nonPurchaseFixedRmb),
    allInPurchaseRmb: costs.allInPurchaseRmb, nonPurchaseFixedRmb: costs.nonPurchaseFixedRmb };
}

/** What one sale price actually earns, with the same rounding the saved estimate uses. */
export function pricePointAt({ priceRub, fx, tiers, costs, policy }) {
  const context = pricingContext({ fx, costs, policy });
  if (context === null || !finite(priceRub) || priceRub <= 0) return null;
  const tier = commissionTierForPrice(tiers, priceRub);
  if (tier === null) return null;
  const reserveRate = tier.rate + context.reserveBase;
  const revenueCny = roundDownCents(priceRub / context.rubPerCny);
  const unitProfitRmb = roundDownCents(revenueCny * (1 - reserveRate) - context.totalCostRmb);
  return { priceRub, commissionRate: tier.rate, commissionTier: tier.tier ?? null,
    reserveRate: Math.round(reserveRate * 10000) / 10000, revenueCny, unitProfitRmb,
    marginRate: revenueCny > 0 ? Math.round(unitProfitRmb / revenueCny * 10000) / 10000 : null };
}

const reaches = (point, want) => point !== null && (want.kind === 'margin'
  ? point.marginRate !== null && point.marginRate >= want.value
  : point.unitProfitRmb >= want.value);

/** The cheapest whole-ruble price inside one band that reaches the target, or null when the band cannot reach it. */
function solveInTier({ tier, want, fx, tiers, costs, policy }) {
  const context = pricingContext({ fx, costs, policy });
  const band = tierBand(tier);
  if (context === null || band === null) return null;
  const reserveRate = tier.rate + context.reserveBase;
  const denominator = want.kind === 'margin' ? 1 - reserveRate - want.value : 1 - reserveRate;
  if (!(denominator > 0)) return null;
  const numerator = want.kind === 'unit_profit' ? context.totalCostRmb + want.value : context.totalCostRmb;
  const raw = numerator * context.rubPerCny / denominator;
  if (!finite(raw) || raw <= 0) return null;
  let priceRub = Math.max(Math.ceil(raw), Math.ceil(band.min), 1);
  // Cent-level rounding inside the formula can leave the analytic price one or two roubles short; step up, never down.
  for (let step = 0; step < PRICE_SEARCH_STEPS && priceRub <= band.max; step += 1, priceRub += 1) {
    if (reaches(pricePointAt({ priceRub, fx, tiers, costs, policy }), want)) return priceRub;
  }
  return null;
}

function lowestPriceFor(want, inputs) {
  const solved = (Array.isArray(inputs.tiers) ? inputs.tiers : [])
    .map(tier => solveInTier({ tier, want, ...inputs })).filter(value => value !== null);
  return solved.length === 0 ? null : Math.min(...solved);
}

const roundUpTo = (value, step) => Math.ceil(value / step) * step;
const roundDownTo = (value, step) => Math.floor(value / step) * step;

/** Two plain round prices to sit between the threshold price and the market price, so the ladder is readable. */
function roundLadderPrices(thresholdRub, marketRub) {
  const base = finite(thresholdRub) ? thresholdRub : null;
  if (base === null) return [];
  if (finite(marketRub) && marketRub > base) {
    return [roundUpTo(base + 1, 100), roundDownTo(marketRub - 1, 100)]
      .filter(value => value > base && value < marketRub);
  }
  const first = roundUpTo(base + 1, 100);
  return [first, first + 100];
}

/**
 * The four things the owner asked to see beside the 找货 form: the price that breaks even, the cheapest price that
 * reaches this store's own profit threshold (and which of the two thresholds it reached), what the same product sells
 * for today and what that price would earn, and a short ladder of prices with the profit each one leaves.
 */
export function pricingGuidance({ fx, tiers, costs, policy, marketPriceRub = null }) {
  const inputs = { fx, tiers, costs, policy };
  const context = pricingContext({ fx, costs, policy });
  const usableTiers = (Array.isArray(tiers) ? tiers : []).filter(tier => tierBand(tier) !== null);
  if (context === null || usableTiers.length === 0) {
    return { status: 'unavailable', breakEven: null, threshold: null, market: null, ladder: [],
      allInPurchaseRmb: null, nonPurchaseFixedRmb: null, rubPerCny: null,
      minimumUnitProfitRmb: null, targetMarginRate: null, thresholdPolicy: null };
  }
  const breakEvenRub = lowestPriceFor({ kind: 'unit_profit', value: 0 }, inputs);
  const byUnitProfit = nonNegative(policy.minimumUnitProfitRmb)
    ? lowestPriceFor({ kind: 'unit_profit', value: policy.minimumUnitProfitRmb }, inputs) : null;
  const byMargin = nonNegative(policy.targetMarginRate)
    ? lowestPriceFor({ kind: 'margin', value: policy.targetMarginRate }, inputs) : null;
  const both = policy.thresholdPolicy === 'both';
  let thresholdRub = null;
  let basis = null;
  if (both && byUnitProfit !== null && byMargin !== null) {
    thresholdRub = Math.max(byUnitProfit, byMargin);
    basis = 'both';
  } else if (!both && (byUnitProfit !== null || byMargin !== null)) {
    const reachable = [byUnitProfit, byMargin].filter(value => value !== null);
    thresholdRub = Math.min(...reachable);
    basis = byUnitProfit === byMargin ? 'both' : byUnitProfit === thresholdRub ? 'unit_profit' : 'margin';
  }
  const point = priceRub => (priceRub === null ? null : pricePointAt({ priceRub, ...inputs }));
  const breakEven = point(breakEvenRub);
  const threshold = point(thresholdRub);
  const market = point(finite(marketPriceRub) && marketPriceRub > 0 ? marketPriceRub : null);
  const labelled = [
    breakEven === null ? null : { label: '保本价', ...breakEven },
    threshold === null ? null : { label: '达标价', ...threshold },
    market === null ? null : { label: '同款市场价', ...market }
  ].filter(Boolean);
  const taken = new Set(labelled.map(entry => entry.priceRub));
  for (const priceRub of roundLadderPrices(thresholdRub, market === null ? null : market.priceRub)) {
    if (taken.has(priceRub)) continue;
    const extra = point(priceRub);
    if (extra === null) continue;
    taken.add(priceRub);
    labelled.push({ label: '整数价位', ...extra });
  }
  return {
    status: breakEven === null && threshold === null && market === null ? 'unavailable' : 'ok',
    breakEven, market, ladder: labelled.sort((a, b) => a.priceRub - b.priceRub),
    threshold: threshold === null ? null : { ...threshold, basis },
    allInPurchaseRmb: context.allInPurchaseRmb, nonPurchaseFixedRmb: context.nonPurchaseFixedRmb,
    rubPerCny: context.rubPerCny, minimumUnitProfitRmb: nonNegative(policy.minimumUnitProfitRmb) ? policy.minimumUnitProfitRmb : null,
    targetMarginRate: nonNegative(policy.targetMarginRate) ? policy.targetMarginRate : null,
    thresholdPolicy: policy.thresholdPolicy ?? null
  };
}

export function estimateOutcomeForPool(estimate) {
  if (!isObject(estimate)) fail('ESTIMATE_INVALID');
  return estimate.status === 'negative' ? 'excluded_negative' : estimate.status === 'ok' ? 'selectable' : 'needs_data';
}

export function describeEstimate(estimate) {
  if (!isObject(estimate)) fail('ESTIMATE_INVALID');
  const commission = estimate.commission.rate === null ? '佣金未知' : `佣金 ${Math.round(estimate.commission.rate * 100)}%`;
  if (estimate.status === 'incomplete') return `无法估算：缺${estimate.missing.join('、')} · ${commission}`;
  const chosen = estimate.freight.chosen;
  const assumed = estimate.freight.dimensionsAssumed !== true ? '' : `（尺寸按${estimate.freight.dimensionsLabel ?? '体积'}假设，仅粗算）`;
  const freight = `${chosen.route} ${chosen.chargeableKg}kg 运费 ¥${chosen.freightRmb.toFixed(2)}${estimate.freight.oversize ? '（超抛）' : ''}${assumed}`;
  if (estimate.status === 'negative') return `预估负利润，已排除 · ${freight} · ${commission}`;
  return `预估采购上限 ¥${estimate.ceiling.maximumAllInPurchaseRmb.toFixed(2)} · ${freight} · ${commission}`;
}
