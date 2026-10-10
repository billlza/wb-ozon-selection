/**
 * 「这条类目在这个店里还没有商品，精确佣金读不到」——认出这一类失败，和这一类失败下软件敢提议的那一个费率。
 *
 * 软件算佣金的规矩是：从主人自己店里已经上着的、同一个 description_category_id + type_id 的商品上，读出平台
 * 实际收的那个费率。一个店在一条类目的第一件商品必然撞上这一下：店里没有同类商品，读不到，重试多少次都一样。
 *
 * 这个模块只做五件事，五件都不碰网络、不碰记录（它只把记录算成句子，写记录的是路由）：
 *   一、从服务端那句失败原话里认出这一类。认的是机器可读的码，不是那句中文——中文会改，码不会。失败的话被
 *       层层包过（422 的 evidencePreparation.failure.reason 里是 provider 的包装，再里面才是原话），所以
 *       这里在整句里找那些码。
 *   二、把服务端顺带说出来的「官方佣金表这一次卡在哪」逐字捡出来交给页面。软件不概括、不改写：主人有权知道
 *       那张表本来可以自己成交、这一次为什么没成。服务端没说的时候这里就是空的，页面也就不说那一句。
 *   三、给出替代费率的提议。费率、档位、来源引用只从页面已经有的那份解析结果里取，三样缺一样就不提议——
 *       证据含糊的地方软件不替主人签字。它也不缓存任何一个数：目标成交价跨过档位分界线，同一份解析结果会
 *       给出另一档，这里跟着走。
 *   四、把上面一二两件事的结论写成一条可以存进候选记录的事实（`buildCommissionEstimateSignal`）。
 *   五、从那条已保存的记录构建出页面要摆的那一块（`buildCommissionEstimateStep`）。
 *
 * 四和五是 2026-09-14 那天现场抓到的那个 bug 逼出来的。原来这一块只活在页面内存里：确认失败 → 页面记下
 * 「撞上了」→ 页面在 finally 里重读资料 → 而同一次失败里服务端把物流比较落了盘，落盘把 dataRevision 顶高
 * 一格（lib/guoo-route-comparison.mjs 的 appendGuooRouteComparison）→ 页面按 dataRevision 变化清掉内存状态
 * → 这一块还没渲染就没了，主人看到的只有一句读不懂的 422。页面内存治不好这个病：主人还会硬刷新。所以这一
 * 次失败本身要变成服务端保存的事实，页面只负责渲染——照 cargoFactsStepV1 和 ozonCategoryReadStepV1 的样板。
 *
 * 两个码要一起认，因为它们是同一件事在两代证据服务下的两种说法：
 *   · 旧的本地只读证据服务把「店里没有同类商品可读 RFBS 佣金」回成 HTTP 500，原话里带 OZON_ 那个码；
 *   · 修好之后它回 HTTP 200 + 一份合格的 data_unavailable 证据，那个码在这条路径上再也不出现，改由消费方
 *     lib/lifecycle-b-real-evidence-readers.mjs 的 assertEstimateScopeAndValidity 抛出 B_ 那个码。
 * 证据服务是单独部署的，主人机器上可能还是旧的，所以旧信号也得继续认。
 *
 * 2026-09-14 之后这个模块还多了一件事（见文件末尾那一段）：佣金还是估算的时候，软件敢往下走到哪一步。
 * 那个判断放在这里而不是新开一个文件，是因为它问的还是同一件事——「这一次用的是不是估算佣金，凭什么」。
 */

import { PROFIT_THRESHOLD_POLICIES } from './profit-threshold-policy.mjs';

/** 本地只读证据服务对「店里没有同类商品可读 RFBS 佣金」的稳定说法，它的机器可读前缀（HTTP 500 那一代）。 */
export const OZON_EVIDENCE_COMMISSION_UNAVAILABLE = 'OZON_EVIDENCE_COMMISSION_UNAVAILABLE';

/**
 * 证据服务已经好好地回了「读不到」之后，消费方在缺主人授权时抛的那个码，逐字取自
 * lib/lifecycle-b-real-evidence-readers.mjs。那边有两个地方抛它，两个地方说的都是「这一次差的是主人的
 * 授权」：assertEstimateScopeAndValidity（只在 data_unavailable 这一条分支上跑，缺授权或范围对不上）和
 * normalizeCommissionEstimate（带上来的授权本身不成形）。两种都该把那一块摆出来让主人重新勾一次。
 */
export const B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED = 'B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED';

/** 认出这一类失败的那两个码。别的码一律不算——这一块是「店里还没有这条类目的商品」专用的。 */
const AUTHORIZATION_REQUIRED_CODES = Object.freeze([
  OZON_EVIDENCE_COMMISSION_UNAVAILABLE,
  B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED
]);

/**
 * 消费方把官方佣金表的缺口接在授权缺失那句话后面时用的那个连接词和分隔号，逐字取自同一个文件：
 * `throw new Error(`${error.message}；官方佣金表未能成交：${officialGaps.join("、")}`)`。
 */
const OFFICIAL_GAPS_MARKER = '；官方佣金表未能成交：';
const OFFICIAL_GAPS_SEPARATOR = '、';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

/** 一句 `CODE: 说明` 最前面那个机器可读的码；没有这样的前缀就是 null。 */
export function remoteEvidenceReasonCode(value) {
  const match = /^([A-Z][A-Z0-9_]{2,79})(?::|$)/u.exec(text(value) ?? '');
  return match === null ? null : match[1];
}

/** 一次失败里所有可能带着原话的地方，全部收上来当字符串看。 */
function failureReasons(cause) {
  if (typeof cause === 'string') return [cause];
  if (!isObject(cause)) return [];
  const body = isObject(cause.body) ? cause.body : cause;
  const preparation = isObject(body.evidencePreparation) ? body.evidencePreparation : null;
  const calls = Array.isArray(preparation?.providerCalls) ? preparation.providerCalls : [];
  return [
    cause.message, cause.remoteError, body.message, preparation?.failure?.reason,
    ...calls.map(call => call?.reason)
  ].filter(value => typeof value === 'string' && value.length > 0);
}

/**
 * 这一次 A 确认的失败，是不是「精确佣金读不到、只差主人授权」那一类。
 * 手上直接拿着证据读取器抛的那个错误对象时，它自己已经标好了；只拿到 HTTP 回体时，就在原话里找那两个码。
 */
export function exactCommissionUnavailable(cause) {
  if (isObject(cause) && cause.exactCommissionUnavailable === true) return true;
  return failureReasons(cause).some(reason => AUTHORIZATION_REQUIRED_CODES.some(code => reason.includes(code)));
}

/**
 * 服务端这一次说的「官方佣金表未能成交」卡在哪几处，逐字。
 *
 * 会走到这一步，说明官方费率表没能自己把这件商品的证据立起来——立起来了，消费方直接返回那份真证据，主人
 * 根本看不到授权那一块。所以这几个缺口是主人应得的交代：那张表本来可以自己成交，这一次为什么没成。
 *
 * 只做拆分和去重，一个字都不改。服务端根本没提这件事（比如这台机器上压根没配官方费率表）时返回空数组，
 * 由页面照实地什么都不说，不在这里替它造一句。
 */
export function officialCommissionTableGaps(cause) {
  const gaps = [];
  for (const reason of failureReasons(cause)) {
    const marker = reason.indexOf(OFFICIAL_GAPS_MARKER);
    if (marker < 0) continue;
    // 缺口是用「、」串起来的，「；」只可能是后面又接了别的一句，到那里为止。
    const tail = reason.slice(marker + OFFICIAL_GAPS_MARKER.length).split('；')[0];
    for (const piece of tail.split(OFFICIAL_GAPS_SEPARATOR)) {
      const gap = text(piece);
      if (gap !== null && !gaps.includes(gap)) gaps.push(gap);
    }
  }
  return gaps;
}

/**
 * 精确佣金读不到时，软件按官方费率表提议的那一个费率，整份取自已经解析好的 `skuChoiceTableV1.sources`。
 * 费率、档位、来源引用任意一样拿不出来就返回 null：那种时候软件什么也不提议，由页面照实说。
 */
export function commissionEstimateProposal(sources) {
  if (!isObject(sources)) return null;
  const commissionRate = finite(sources.commissionRate);
  const commissionTier = text(sources.commissionTier);
  const commissionSourceRef = text(sources.commissionSourceRef);
  if (commissionRate === null || commissionRate <= 0 || commissionRate >= 1) return null;
  if (commissionTier === null || commissionSourceRef === null) return null;
  return Object.freeze({
    commissionRate,
    commissionTier,
    commissionSourceRef,
    targetSalePriceRub: finite(sources.targetSalePriceRub)
  });
}

/** 存进候选记录的那条事实的版本号。 */
export const COMMISSION_ESTIMATE_SIGNAL_VERSION = 'commission-estimate-signal-v1';

/** 页面拿到的那一块的版本号，和 cargo-facts-step-v1、ozon-category-read-step-v1 同一套叫法。 */
export const COMMISSION_ESTIMATE_STEP_VERSION = 'commission-estimate-step-v1';

/** 官方佣金表的缺口是机器可读的码（OFFICIAL_TABLE_*），最多留这么多条；再多说明上游出了别的事，不往记录里灌。 */
const MAX_OFFICIAL_GAPS = 20;

/**
 * 一次 A 确认停在 B 证据准备上时，把这一次的结论写成一条可以存进候选记录的事实。
 *
 * 存的只有主人真正需要的那几样：这是不是「精确佣金读不到、只差主人授权」那一类、服务端顺带说的官方佣金表缺口
 * （逐字），以及这条记录说的是哪一版资料。
 *
 * 不存服务端那句失败原话。那句话里可能带着本机证据服务的回环地址或者资费表的本机路径，而业务记录不许保存这两样
 * （lib/runtime-identity.mjs 的 assertSafeBusinessMutationCandidate 明文禁止）。原话在这一次的 422 回体里已经
 * 原样交给主人了，记录留下的是它的结论。
 *
 * 每一次停都要存，撞上的和没撞上的都存：主人这一次改好了类目、下一次停在别的地方时，`exactCommissionUnavailable`
 * 就是 false，那一块跟着消失。只存撞上的那几次，反而会留下一条永远不被覆盖的旧记录。
 *
 * `resultRevision` 必须是这一次落盘全部写完之后的那个 dataRevision——同一次失败里物流比较也在落盘，它会把版本
 * 顶高一格；用顶高之前的值，这条记录一存进去就是过期的。
 */
export function buildCommissionEstimateSignal({ evidencePreparation = null, recordedAt, sourceRevision, resultRevision }) {
  const at = text(recordedAt);
  if (at === null || !Number.isFinite(Date.parse(at))) {
    throw new Error('COMMISSION_ESTIMATE_SIGNAL_RECORDED_AT_INVALID: 这一次失败的记录时间无效');
  }
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 ||
      !Number.isSafeInteger(resultRevision) || resultRevision < sourceRevision) {
    throw new Error('COMMISSION_ESTIMATE_SIGNAL_REVISION_INVALID: 这一次失败的修订号必须是不倒退的非负整数');
  }
  const cause = { evidencePreparation };
  return {
    schemaVersion: COMMISSION_ESTIMATE_SIGNAL_VERSION,
    recordedAt: at,
    sourceRevision,
    resultRevision,
    exactCommissionUnavailable: exactCommissionUnavailable(cause),
    officialCommissionTableGaps: officialCommissionTableGaps(cause).slice(0, MAX_OFFICIAL_GAPS),
    // 停在哪一层，照服务端自己的说法（guoo_route_comparison、provider:commission……）；它没说就是 null。
    failureLayer: text(evidencePreparation?.failure?.layer)
  };
}

/**
 * 「估算佣金授权」那一块，整份由服务端从已保存的记录构建：页面不再自己记「刚才撞上没撞上」，硬刷新之后它还在。
 *
 * `present` 为真才摆这一块：有一条本软件写下的记录、它说的是这一类、并且这件商品还没确认成功——已经有
 * aConfirmationReceipt 或 skuPackage 的商品，这一步早过去了，再摆一个待签的授权只会误导。
 *
 * `current` 说的是「这条记录说的还不还是当前这一版资料」，判法和 guooRouteComparisonsV1 一样：resultRevision
 * 对得上当前 dataRevision 才算。对不上时这一块不消失，只是照实说它说的是哪一版——消失正是这次要修的那个病：
 * 主人改一次资料，能救他的那条出路就无声无息地没了。
 */
export function buildCommissionEstimateStep(candidate) {
  const saved = isObject(candidate?.commissionEstimateSignalV1) ? candidate.commissionEstimateSignalV1 : null;
  const record = saved !== null && saved.schemaVersion === COMMISSION_ESTIMATE_SIGNAL_VERSION ? saved : null;
  const dataRevision = Number.isSafeInteger(candidate?.dataRevision) ? candidate.dataRevision : null;
  const lifecycle = isObject(candidate?.lifecycleV11) ? candidate.lifecycleV11 : {};
  const confirmed = isObject(lifecycle.aConfirmationReceipt) || isObject(lifecycle.skuPackage);
  const recordedRevision = Number.isSafeInteger(record?.resultRevision) ? record.resultRevision : null;
  const present = record !== null && record.exactCommissionUnavailable === true && !confirmed;
  const gaps = Array.isArray(record?.officialCommissionTableGaps) ? record.officialCommissionTableGaps : [];
  return {
    schemaVersion: COMMISSION_ESTIMATE_STEP_VERSION,
    candidateId: text(candidate?.id),
    dataRevision,
    present,
    current: present && recordedRevision !== null && recordedRevision === dataRevision,
    recordedRevision: present ? recordedRevision : null,
    recordedAt: present ? text(record.recordedAt) : null,
    officialGaps: present ? gaps.map(gap => text(gap)).filter(gap => gap !== null) : []
  };
}

/* ────────────────────────── 佣金还是估算的时候，软件敢往下走到哪一步 ────────────────────────── */

/**
 * 「这件的条件测算，是不是**仅仅**因为佣金还是估算」——一个判断，三处共用。
 *
 * 为什么要有这么一个函数：一件停在条件测算的商品，`skuPackage.businessResult` 是 `manual_review`，
 * `profitModel.result` 也是 `manual_review`。可是 `manual_review` 是个筐：利润没过门槛、市场价容不下、
 * 执行期留着一件没解决的异常，都可能落进同一个字眼。软件绝不能凭这一个字眼放行——那等于把三道本来拦得住
 * 的闸门一起拆了。所以这里不看结论，只看结构化字段，一条一条对：
 *
 *   · `calculationType === "conditional"`      这一次算的确实是条件测算，不是正式计算；
 *   · `commissionMode === "estimated"`          用的确实是估算佣金（`exact` 和 `official_reference` 都不算）；
 *   · `exactCommissionRequiredForFormalB === true`  记录自己承认「正式 B 还欠一个精确佣金」；
 *   · `thresholds` 与 `thresholdVersion` 对得上已发布的门槛版本，并且按它自己的 `logic` 判下来是满足的；
 *   · `marketFit.status === "fits_market"`      市场价容得下这条成本线；
 *   · `executionRuntime.exceptionCase` 没有一件 `open` 的。
 *
 * 任何一条不成立，都不是「仅仅因为佣金是估算」，照旧拦住，并把不成立的那几条逐条说出来——主人有权知道
 * 拦他的到底是哪一道，而不是只看见一个「待人工复核」。
 *
 * 门槛按它自己的 `logic` 判，不写死 `any`：记录里存着 `logic`，就按记录里的那个判；碰上不认识的 `logic`
 * 一律算不满足。软件不替主人猜一条它读不懂的规矩。
 *
 * 门槛数值还要和 `thresholdVersion` 指的那一版逐项相等（`PROFIT_THRESHOLD_POLICIES`）。不这么对一次的话，
 * 一份把 `minimumUnitProfitRmb` 写成 0 的记录能自己把自己判成通过——门槛就成了记录自己说了算的东西。
 */
export const CONDITIONAL_COMMISSION_RELEASE_VERSION = 'conditional-commission-release-v1';

/** 拦住的理由，机器可读的码。中文会改，码不会——页面认的是这些。 */
export const CONDITIONAL_COMMISSION_BLOCK_CODES = Object.freeze({
  PROFIT_MODEL_UNREADABLE: 'PROFIT_MODEL_UNREADABLE',
  CALCULATION_NOT_CONDITIONAL: 'CALCULATION_NOT_CONDITIONAL',
  COMMISSION_MODE_NOT_ESTIMATED: 'COMMISSION_MODE_NOT_ESTIMATED',
  EXACT_COMMISSION_NOT_REQUIRED_FOR_FORMAL_B: 'EXACT_COMMISSION_NOT_REQUIRED_FOR_FORMAL_B',
  PROFIT_THRESHOLD_POLICY_UNKNOWN: 'PROFIT_THRESHOLD_POLICY_UNKNOWN',
  PROFIT_THRESHOLD_NOT_MET: 'PROFIT_THRESHOLD_NOT_MET',
  MARKET_FIT_NOT_PASSED: 'MARKET_FIT_NOT_PASSED',
  OPEN_EXCEPTION_CASE: 'OPEN_EXCEPTION_CASE'
});

/**
 * 这份利润记录按它自己存着的那条门槛规矩判下来，过没过。
 * 读不出数、或者 `logic` 不是本软件认识的那两种，一律返回 null——「判不出来」不等于「过了」。
 */
export function profitThresholdSatisfiedByOwnLogic(profitModel) {
  const thresholds = isObject(profitModel?.thresholds) ? profitModel.thresholds : null;
  const unitProfitRmb = finite(profitModel?.unitProfitRmb);
  const profitMargin = finite(profitModel?.profitMargin);
  const minimumUnitProfitRmb = finite(thresholds?.minimumUnitProfitRmb);
  const minimumProfitMargin = finite(thresholds?.minimumProfitMargin);
  if (unitProfitRmb === null || profitMargin === null || minimumUnitProfitRmb === null || minimumProfitMargin === null) return null;
  const profitReached = unitProfitRmb >= minimumUnitProfitRmb;
  const marginReached = profitMargin >= minimumProfitMargin;
  if (thresholds.logic === 'all') return profitReached && marginReached;
  if (thresholds.logic === 'any') return profitReached || marginReached;
  return null;
}

/** 这份记录存的门槛数值，和它自称的那一版门槛政策逐项相等吗。 */
function thresholdPolicyMatches(profitModel) {
  const policy = PROFIT_THRESHOLD_POLICIES[profitModel?.thresholdVersion];
  if (!isObject(policy)) return false;
  return Object.entries(policy).every(([key, value]) => profitModel.thresholds?.[key] === value);
}

/**
 * 一份利润记录（外加这件商品的执行期状态）够不够「仅仅因为佣金是估算」那一种放行。
 *
 * 纯函数：不读盘、不发请求、不改入参。三处共用同一个返回值——C1 那道闸门、上架那道闸门、页面那一块。
 */
export function resolveConditionalCommissionRelease({ profitModel, executionRuntime = null }) {
  const codes = CONDITIONAL_COMMISSION_BLOCK_CODES;
  const model = isObject(profitModel) ? profitModel : null;
  const blockedBy = [];
  if (model === null) blockedBy.push(codes.PROFIT_MODEL_UNREADABLE);
  else {
    if (model.calculationType !== 'conditional') blockedBy.push(codes.CALCULATION_NOT_CONDITIONAL);
    if (model.commissionMode !== 'estimated') blockedBy.push(codes.COMMISSION_MODE_NOT_ESTIMATED);
    if (model.exactCommissionRequiredForFormalB !== true) blockedBy.push(codes.EXACT_COMMISSION_NOT_REQUIRED_FOR_FORMAL_B);
    if (!thresholdPolicyMatches(model)) blockedBy.push(codes.PROFIT_THRESHOLD_POLICY_UNKNOWN);
    if (profitThresholdSatisfiedByOwnLogic(model) !== true) blockedBy.push(codes.PROFIT_THRESHOLD_NOT_MET);
    if (model.marketFit?.status !== 'fits_market') blockedBy.push(codes.MARKET_FIT_NOT_PASSED);
  }
  // 执行期留着一件没解决的异常，就是还有一件事没交代清楚；那种时候不放行，和佣金无关。
  if (isObject(executionRuntime) && executionRuntime.exceptionCase?.status === 'open') blockedBy.push(codes.OPEN_EXCEPTION_CASE);
  return Object.freeze({
    schemaVersion: CONDITIONAL_COMMISSION_RELEASE_VERSION,
    conditionalOnEstimatedCommissionOnly: blockedBy.length === 0,
    blockedBy: Object.freeze([...blockedBy]),
    commissionMode: model === null ? null : text(model.commissionMode),
    commissionRate: model === null ? null : finite(model.commissionRate),
    unitProfitRmb: model === null ? null : finite(model.unitProfitRmb),
    profitMargin: model === null ? null : finite(model.profitMargin),
    minimumUnitProfitRmb: model === null ? null : finite(model.thresholds?.minimumUnitProfitRmb),
    minimumProfitMargin: model === null ? null : finite(model.thresholds?.minimumProfitMargin),
    thresholdLogic: model === null ? null : text(model.thresholds?.logic),
    marketFitStatus: model === null ? null : text(model.marketFit?.status)
  });
}

/**
 * 这件商品当前生效的那一份 B 利润记录。
 * 生效版本必须唯一：`activeProfitModelVersion` 指到零份或者两份以上，一律当读不出来。
 */
export function activeProfitModelOf(skuPackage) {
  if (!isObject(skuPackage) || !Array.isArray(skuPackage.profitModels)) return null;
  const matched = skuPackage.profitModels.filter(model =>
    isObject(model) && model.profitModelVersion === skuPackage.activeProfitModelVersion);
  return matched.length === 1 ? matched[0] : null;
}

/* ───────────────────────────────── 上架那道闸门 ───────────────────────────────── */

/**
 * 生产授权／上架在佣金还是估算时拒绝的那个码。
 *
 * 前缀必须是 `PRODUCTION_AUTHORIZATION_`：server.mjs 的生产确认路由只把
 * `^(?:PRODUCTION_OWNER|PRODUCTION_AUTHORIZATION|BUSINESS_MUTATION|RUNTIME_OPERATION)_[A-Z_]+$`
 * 当成「软件认得的拒绝」，别的一律变成 500 加一句读不懂的话。改名要连那条正则一起看。
 */
export const PRODUCTION_EXACT_COMMISSION_REQUIRED = 'PRODUCTION_AUTHORIZATION_EXACT_COMMISSION_REQUIRED';

/** 主人下一步该做的那一件事，机器可读的名字；页面拿它决定把哪个按钮指出来。 */
export const EXACT_COMMISSION_RECALCULATION_ACTION = 'b_exact_commission_recalculate';

/** 上架那道闸门拒绝时抛的错误。带稳定 ASCII 码和结构化标记，页面不靠中文字符串认它。 */
export class ExactCommissionRequiredForProductionError extends Error {
  constructor({ commissionMode = null, skuPackageId = null } = {}) {
    super(`${PRODUCTION_EXACT_COMMISSION_REQUIRED}: 佣金还是估算的，先用「用更好的费用证据重算」重算一次再上架`);
    this.name = 'ExactCommissionRequiredForProductionError';
    this.code = PRODUCTION_EXACT_COMMISSION_REQUIRED;
    this.exactCommissionRequiredForProduction = true;
    this.commissionMode = commissionMode;
    this.skuPackageId = skuPackageId;
    this.ownerNextStep = EXACT_COMMISSION_RECALCULATION_ACTION;
  }
}

/** Reject conditional commission before the full frozen-input production gate.
 * official_reference is formal,
 * but never sufficient alone: production must also pass assertProductionProfitPriceCurrent.
 */
export function assertFormalCommissionBeforeProduction(skuPackage) {
  const model = activeProfitModelOf(skuPackage);
  if (isObject(model) && ['exact', 'official_reference'].includes(model.commissionMode)) return model;
  throw new ExactCommissionRequiredForProductionError({
    commissionMode: model === null ? null : text(model.commissionMode),
    skuPackageId: text(skuPackage?.skuPackageId)
  });
}

/* ─────────────────────── 一路上都要看得见「佣金还是估算的」 ─────────────────────── */

/** 页面拿到的那一块的版本号，和 commission-estimate-step-v1 同一套叫法。 */
export const ESTIMATED_COMMISSION_NOTICE_STEP_VERSION = 'estimated-commission-notice-step-v1';

const percentText = rate => (rate === null ? null : `${Number((rate * 100).toFixed(2))}%`);
const moneyText = amount => (amount === null ? null : `¥${amount.toFixed(2)}`);

/**
 * 「这件的佣金还是估算的」那一块，整份由服务端从已保存的记录构建，挂在每一份候选视图上。
 *
 * 为什么要一路挂着：主人从条件测算走到上架之前会经过好几个界面，中间隔着几天。只在出事的那一屏说一次，他会
 * 忘；忘了之后最坏的结果是拿一个估算费率去上架。所以这一块跟着商品走，直到佣金真的换成精确的为止。
 *
 * 语气：这不是一件有问题的商品。利润门槛本来就过了，市场价也容得下——它只是还差一道正式化手续。所以这里不
 * 用红字、不说「异常」、不说「失败」，只把三件事说清楚：佣金是估算的、现在这个结论只是条件测算、上架之前必
 * 须先做一次精确费用复算。
 *
 * 已经上过架或者已经拿到生产授权的商品不摆这一块：那时候佣金早就是精确的了（上架那道闸门只认 exact），再摆
 * 一句「还差一道手续」只会误导。
 */
export function buildEstimatedCommissionNoticeStep(candidate) {
  const skuPackage = isObject(candidate?.lifecycleV11?.skuPackage) ? candidate.lifecycleV11.skuPackage : null;
  const model = activeProfitModelOf(skuPackage);
  const authorized = skuPackage !== null &&
    (isObject(skuPackage.productionAuthorization) || isObject(skuPackage.productionRecord) || isObject(skuPackage.externalListingRecord));
  const estimated = isObject(model) && model.commissionMode === 'estimated' && model.exactCommissionRequiredForFormalB === true;
  const present = estimated && !authorized;
  if (!present) {
    return {
      schemaVersion: ESTIMATED_COMMISSION_NOTICE_STEP_VERSION,
      candidateId: text(candidate?.id),
      dataRevision: Number.isSafeInteger(candidate?.dataRevision) ? candidate.dataRevision : null,
      present: false, release: null, sentences: [], ownerNextStep: null, blocksProduction: false
    };
  }
  const release = resolveConditionalCommissionRelease({ profitModel: model, executionRuntime: candidate?.executionRuntime ?? null });
  const rate = percentText(release.commissionRate);
  const unitProfit = moneyText(release.unitProfitRmb);
  const margin = percentText(release.profitMargin);
  const minimumProfit = moneyText(release.minimumUnitProfitRmb);
  const minimumMargin = percentText(release.minimumProfitMargin);
  const either = release.thresholdLogic === 'any' ? '满足任一项' : release.thresholdLogic === 'all' ? '两项都要满足' : null;
  const thresholdSentence = minimumProfit === null || minimumMargin === null || either === null
    ? '利润门槛按当前已发布的那一版判。'
    : `利润门槛是单件利润 ≥ ${minimumProfit} 或利润率 ≥ ${minimumMargin}（${either}）。`;
  return {
    schemaVersion: ESTIMATED_COMMISSION_NOTICE_STEP_VERSION,
    candidateId: text(candidate?.id),
    dataRevision: Number.isSafeInteger(candidate?.dataRevision) ? candidate.dataRevision : null,
    present: true,
    release,
    ownerNextStep: EXACT_COMMISSION_RECALCULATION_ACTION,
    // 这一块在，上架就一定会被服务端拦下来——两处读的是同一份记录的同一个字段。
    blocksProduction: true,
    sentences: [
      rate === null
        ? '这件商品的平台佣金还是估算的，不是从你店里同类目已上架商品上读到的实际费率。'
        : `这件商品的平台佣金还是估算的：${rate}，来自官方费率表，不是从你店里同类目已上架商品上读到的实际费率。`,
      unitProfit === null || margin === null
        ? `所以现在这个利润结论只是条件测算，不是正式 B 通过。${thresholdSentence}`
        : `所以现在这个利润结论只是条件测算，不是正式 B 通过：单件利润 ${unitProfit}、利润率 ${margin}。${thresholdSentence}` +
          (release.conditionalOnEstimatedCommissionOnly
            ? '这两条和市场价这一条都已经过了——这不是一件有问题的商品，只是一件还差一道正式化手续的商品。'
            : ''),
      // 这里必须把两件事分开说。重算能用两种比估算更好的证据（店里的实收费率、官方费率表上的公开费率），
      // 两种都能形成正式 B；生产仍须核对当前冻结输入与适用证据。
      // 少说这一句，主人就会拿官方费率表重算完、以为可以上架了，再在生产授权那一步被拦一次。
      '上架之前必须先用「用更好的费用证据重算」把利润重算一次，正式 B 通过之后才能提交生产授权。' +
        '重算认两种证据：你店里同类目在售商品的实收费率，和官方费率表上这条类目的公开费率；' +
        '两种都能让 B 正式通过，但上架这道闸门只认店里的实收费率，用官方费率表重算过的仍然上不了架。' +
        '在那之前，这件商品不会有任何东西被写到平台上。'
    ]
  };
}
