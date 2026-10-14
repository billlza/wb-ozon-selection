import test from 'node:test';
import assert from 'node:assert/strict';

import {
  B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED, OZON_EVIDENCE_COMMISSION_UNAVAILABLE, buildCommissionEstimateSignal,
  buildCommissionEstimateStep, commissionEstimateProposal, exactCommissionUnavailable, officialCommissionTableGaps,
  remoteEvidenceReasonCode
} from '../lib/commission-estimate-authorization.mjs';
// 这个 bug 的引信就是它：同一次失败里物流比较落盘，落盘把 dataRevision 顶高一格。用真的那一个，不自己模拟。
import { appendGuooRouteComparison, compareGuooRoutes } from '../lib/guoo-route-comparison.mjs';

// 2026-09-14 现场那一次的原话，从最里面一层往外抄：证据服务 → 只读读取器 → 证据提供器 → a-confirm 的 422。
// 这是证据服务还会把「店里没有同类商品」回成 HTTP 500 的那一代。
const REMOTE = `${OZON_EVIDENCE_COMMISSION_UNAVAILABLE}: 店铺当前没有同 description category 和 type 的商品可读取 RFBS 佣金`;
const READER = `OZON_LOCAL_EVIDENCE_FAILED: HTTP 500: ${REMOTE}`;
const PROVIDER = `B_EVIDENCE_PROVIDER_READ_FAILED: ${READER}`;

// 证据服务修好之后的那一代：它回 HTTP 200 + 一份合格的 data_unavailable 证据，OZON_ 那个码在这条路径上再也
// 不出现，缺授权时由消费方 lib/lifecycle-b-real-evidence-readers.mjs 抛出下面这一句。整句逐字取自那边的实跑。
const FIXED_READER = `${B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED}: 缺少当前候选、revision和精确范围的单次估算授权`;
const FIXED_PROVIDER = `B_EVIDENCE_PROVIDER_READ_FAILED: ${FIXED_READER}`;
/** 同一句话后面接上官方佣金表这一次卡在哪几处；服务端用「、」串，用「；」起头。 */
const withOfficialGaps = (...gaps) => `${FIXED_PROVIDER}；官方佣金表未能成交：${gaps.join('、')}`;
/** 浏览器里 api.js 抛的那一个：message 是服务端的 message，body 是整份回体。 */
const httpFailure = (reason, message = `A确认后的B系统证据准备已停止：${reason}`) => Object.assign(new Error(message), {
  status: 422,
  body: {
    message,
    evidencePreparation: {
      status: 'failed',
      failure: { layer: 'provider:commission', reason },
      providerCalls: [{ kind: 'commission', attempt: 1, status: 'failed', reason }]
    },
    guooRouteComparison: null
  }
});

test('机器可读的那个前缀认得出来，中文说明变了也不影响', () => {
  assert.equal(remoteEvidenceReasonCode(REMOTE), OZON_EVIDENCE_COMMISSION_UNAVAILABLE);
  assert.equal(remoteEvidenceReasonCode(`${OZON_EVIDENCE_COMMISSION_UNAVAILABLE}: 换一句完全不同的中文`), OZON_EVIDENCE_COMMISSION_UNAVAILABLE);
  assert.equal(remoteEvidenceReasonCode(OZON_EVIDENCE_COMMISSION_UNAVAILABLE), OZON_EVIDENCE_COMMISSION_UNAVAILABLE);
  assert.equal(remoteEvidenceReasonCode('OZON_EVIDENCE_STORE_UNAUTHORIZED: 别的失败'), 'OZON_EVIDENCE_STORE_UNAUTHORIZED');
  // 没有机器可读前缀的话就是没有，不要从中文里猜一个出来。
  assert.equal(remoteEvidenceReasonCode('店铺当前没有同类商品'), null);
  assert.equal(remoteEvidenceReasonCode('HTTP 500'), null);
  assert.equal(remoteEvidenceReasonCode(''), null);
  assert.equal(remoteEvidenceReasonCode(null), null);
  assert.equal(remoteEvidenceReasonCode({ code: OZON_EVIDENCE_COMMISSION_UNAVAILABLE }), null);
});

test('「精确佣金读不到」这一类，从 a-confirm 那个 422 的原话里认出来', () => {
  // 页面手上就是这一个：422 的整份回体，原话被包了三层。
  assert.equal(exactCommissionUnavailable(httpFailure(PROVIDER)), true);
  // 只拿到那句话本身，或者只拿到 message，也要认得出来。
  assert.equal(exactCommissionUnavailable(PROVIDER), true);
  assert.equal(exactCommissionUnavailable(new Error(READER)), true);
  // 服务端抛的那个错误对象自己已经标好了，就用它标的。
  assert.equal(exactCommissionUnavailable(Object.assign(new Error('无关的话'), { exactCommissionUnavailable: true })), true);

  // 别的失败不能顺带把这一块摆出来：这一块是「店里还没有这条类目的商品」专用的。
  assert.equal(exactCommissionUnavailable(httpFailure('B_EVIDENCE_PROVIDER_READ_FAILED: OZON_LOCAL_EVIDENCE_FAILED: HTTP 500')), false);
  assert.equal(exactCommissionUnavailable(httpFailure('B_EVIDENCE_PROVIDER_READ_FAILED: OZON_LOCAL_EVIDENCE_FAILED: HTTP 401: OZON_EVIDENCE_STORE_UNAUTHORIZED: 凭据过期')), false);
  assert.equal(exactCommissionUnavailable(Object.assign(new Error('商品资料已变化，请刷新后重新确认A阶段'), { status: 409 })), false);
  assert.equal(exactCommissionUnavailable(null), false);
  assert.equal(exactCommissionUnavailable(undefined), false);
  assert.equal(exactCommissionUnavailable({}), false);
  assert.equal(exactCommissionUnavailable(42), false);
});

test('证据服务修好之后，「只差主人授权」那个码同样认得出来，旧信号也不丢', () => {
  // 修好之后这条路上根本不会再出现 OZON_ 那个码：认不出 B_ 这个，那一块就永远不出现，主人永远看不到出路。
  assert.equal(FIXED_PROVIDER.includes(OZON_EVIDENCE_COMMISSION_UNAVAILABLE), false, '修好之后旧码确实不在场');
  assert.equal(exactCommissionUnavailable(httpFailure(FIXED_PROVIDER)), true);
  assert.equal(exactCommissionUnavailable(FIXED_PROVIDER), true);
  assert.equal(exactCommissionUnavailable(new Error(FIXED_READER)), true);
  // 官方佣金表的缺口接在后面时照样认得出来。
  assert.equal(exactCommissionUnavailable(httpFailure(withOfficialGaps('TYPE_NOT_FOUND', 'CATALOG_VERSION_MISMATCH'))), true);
  // 同一个码的另一个抛出点：带上来的 commissionEstimate 本身不成形。中文不一样，码一样，照认。
  assert.equal(exactCommissionUnavailable(httpFailure(
    `B_EVIDENCE_PROVIDER_READ_FAILED: ${B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED}: 估算佣金必须由主人对当前SKU明确授权`)), true);

  // 旧的那一代还在跑的机器上，旧信号必须继续认——证据服务是单独部署的。
  assert.equal(exactCommissionUnavailable(httpFailure(PROVIDER)), true);

  // 相邻的几个码不能被顺带认成这一类：它们说的不是「现在就差你授权」。
  for (const reason of [
    'B_EVIDENCE_PROVIDER_READ_FAILED: B_EVIDENCE_COMMISSION_ESTIMATE_EXPIRED: 估算授权不在明确有效时间窗内',
    'B_EVIDENCE_PROVIDER_READ_FAILED: B_EVIDENCE_COMMISSION_ESTIMATE_INVALID: 估算佣金率必须在0到1之间',
    'B_EVIDENCE_PROVIDER_READ_FAILED: B_EVIDENCE_COMMISSION_UNAVAILABLE_INVALID: 不可用必须是本轮同范围明确结果，不能保留佣金数值',
    'B_EVIDENCE_PROVIDER_ESTIMATE_SCOPE_MISMATCH: 估算授权不属于本轮候选与修订'
  ]) assert.equal(exactCommissionUnavailable(httpFailure(reason)), false, reason);

  // 跟这件事无关的失败一律不摆这一块：版本冲突、店铺没绑、网络断了。
  assert.equal(exactCommissionUnavailable(Object.assign(new Error('商品资料已变化，请刷新后重新确认A阶段'), { status: 409 })), false);
  assert.equal(exactCommissionUnavailable(httpFailure('B_EVIDENCE_PROVIDER_READ_FAILED: OZON_LOCAL_EVIDENCE_FAILED: HTTP 403: OZON_EVIDENCE_STORE_NOT_BOUND: 这个店还没有绑定')), false);
  assert.equal(exactCommissionUnavailable(new TypeError('fetch failed')), false);
});

test('官方佣金表这一次卡在哪几处，原样捡出来；服务端没说就一个字都不造', () => {
  // 有缺口：逐字，顺序照服务端说的，重复的那几层只算一次。
  const gaps = httpFailure(withOfficialGaps('TYPE_NOT_FOUND', 'CATALOG_VERSION_MISMATCH'));
  assert.deepEqual(officialCommissionTableGaps(gaps), ['TYPE_NOT_FOUND', 'CATALOG_VERSION_MISMATCH']);
  // 官方费表读取本身抛了异常时，消费方给的是 OFFICIAL_TABLE_ 前缀那一个，照样原样上来。
  assert.deepEqual(officialCommissionTableGaps(httpFailure(withOfficialGaps('OFFICIAL_TABLE_CATALOG_UNREADABLE'))),
    ['OFFICIAL_TABLE_CATALOG_UNREADABLE']);
  // 一个字都不许改：大小写、下划线、中文说明，服务端写成什么样就是什么样。
  assert.deepEqual(officialCommissionTableGaps(withOfficialGaps('official_table_Rate_Unusable', '版本状态 status=stale')),
    ['official_table_Rate_Unusable', '版本状态 status=stale']);
  // 只拿到那一句话本身，或者只拿到 Error，也要捡得出来。
  assert.deepEqual(officialCommissionTableGaps(new Error(withOfficialGaps('TYPE_NOT_FOUND'))), ['TYPE_NOT_FOUND']);

  // 服务端没提官方佣金表（这台机器上压根没配）：空的，页面也就不说那一句。
  assert.deepEqual(officialCommissionTableGaps(httpFailure(FIXED_PROVIDER)), []);
  assert.deepEqual(officialCommissionTableGaps(httpFailure(PROVIDER)), []);
  assert.deepEqual(officialCommissionTableGaps(Object.assign(new Error('商品资料已变化'), { status: 409 })), []);
  for (const empty of [null, undefined, {}, 42, '']) assert.deepEqual(officialCommissionTableGaps(empty), [], String(empty));
  // 「未能成交：」后面什么都没有时不要造出一个空缺口来。
  assert.deepEqual(officialCommissionTableGaps(`${FIXED_PROVIDER}；官方佣金表未能成交：`), []);
  assert.deepEqual(officialCommissionTableGaps(`${FIXED_PROVIDER}；官方佣金表未能成交：、 、`), []);
  // 缺口后面又接了别的一句时，到那里为止，不把后半句当成缺口。
  assert.deepEqual(officialCommissionTableGaps(`${withOfficialGaps('TYPE_NOT_FOUND')}；证据准备：{"status":"failed"}`), ['TYPE_NOT_FOUND']);
});

test('替代费率整份取自那份解析结果，缺一样就不提议', () => {
  // 2026-09-14 反光雨衣那一件的真实取值。
  const sources = {
    targetSalePriceRub: 1455,
    commissionRate: 0.12,
    commissionTier: 'le1500',
    commissionSourceRef: 'ozon-official-commission:2025-12-01:sha256:be7832ff9dbd09ee7021aaefe9018a02287332bc22e4c6b470d6cfe0b3649cf0'
  };
  assert.deepEqual(commissionEstimateProposal(sources), {
    commissionRate: 0.12,
    commissionTier: 'le1500',
    commissionSourceRef: sources.commissionSourceRef,
    targetSalePriceRub: 1455
  });
  // 跨过档位分界线的是另一份解析结果，这里照它给的说，自己不记一个旧数。
  assert.equal(commissionEstimateProposal({ ...sources, targetSalePriceRub: 1666, commissionRate: 0.14, commissionTier: 'le5000' }).commissionRate, 0.14);
  assert.equal(commissionEstimateProposal({ ...sources, targetSalePriceRub: 1666, commissionRate: 0.14, commissionTier: 'le5000' }).commissionTier, 'le5000');

  // 费率、档位、来源引用缺任何一样，软件都不提议——证据含糊的地方不替主人签字。
  for (const missing of ['commissionRate', 'commissionTier', 'commissionSourceRef']) {
    assert.equal(commissionEstimateProposal({ ...sources, [missing]: null }), null, missing);
    assert.equal(commissionEstimateProposal({ ...sources, [missing]: undefined }), null, missing);
  }
  assert.equal(commissionEstimateProposal({ ...sources, commissionTier: '   ' }), null);
  assert.equal(commissionEstimateProposal({ ...sources, commissionSourceRef: '' }), null);
  // 不成其为费率的数字不是费率。
  for (const rate of [0, 1, 1.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.12']) {
    assert.equal(commissionEstimateProposal({ ...sources, commissionRate: rate }), null, String(rate));
  }
  // 目标成交价拿不到时照样可以提议，只是那一句不说价格；别的都不能少。
  assert.equal(commissionEstimateProposal({ ...sources, targetSalePriceRub: null }).targetSalePriceRub, null);
  assert.equal(commissionEstimateProposal(null), null);
  assert.equal(commissionEstimateProposal([]), null);
  assert.equal(commissionEstimateProposal('12%'), null);
});

/**
 * 2026-09-14 那一次失败在服务端手上的样子：a-confirm 拿到的是编排返回的 evidencePreparation 本身，
 * 不是 HTTP 回体。同一句原话，同一个包装层数。
 */
const preparation = (reason, layer = 'provider:commission') => ({
  runVersion: 'lifecycle-b-evidence-preparation-v1.1',
  status: 'failed',
  failure: { layer, reason },
  providerCalls: [{ kind: 'commission', attempt: 1, status: 'failed', reason }],
  finalReadiness: null
});
const RECORDED_AT = '2026-09-14T06:30:00.000Z';
const LIVE_REASON = withOfficialGaps('OFFICIAL_TABLE_PRICE_MISSING', 'OFFICIAL_TABLE_TYPE_IDENTITY_MISSING');

/** 一份能通过 assertGuooRouteComparison 的最小比较：只有 17 行这一条在重量区间里，别的行都判 ineligible。 */
function guooRow(rowNumber) {
  const route = `GUOO Synthetic ${rowNumber} PUDO`;
  return { rowNumber, route, routeText: route, deliveryMethods: [route],
    sourceRefs: { perKgRmb: { sheetName: 'Synthetic', cellRef: `K${rowNumber}` } },
    unresolvedRules: [],
    feeCoverage: { status: 'complete', additionalPerParcelRmb: 0, evidenceRef: 'evidence:synthetic-complete-fees' },
    evidenceData: { chargeableWeightRule: 'actual_weight', perKgRmb: 28.1, perParcelRmb: 17.97,
      minimumChargeableWeightKg: 0.001, weightRoundingRule: 'none', weightRoundingKg: null,
      productType: 'Small', weightLimit: rowNumber === 17 ? '0.001-2KG' : '10-30KG', declaredValueLimitRub: '1501-7000₽',
      sizeLimit: '尺寸限制：三边之和不超150CM，单边最大尺寸不超60CM，按实重，按克计费',
      batteryTransportRule: '电池不允许\n只接普货（不接带电、带磁、液体、粉末、刀具、仿牌等产品）' } };
}
const guooComparison = (candidateId, sourceRevision) => compareGuooRoutes({
  candidateId, sourceRevision,
  packaging: { weightKg: 0.21, dimensionsCm: { length: 20, width: 10, height: 5 }, sourceRef: 'evidence:synthetic-packaging' },
  salePrice: { amountRub: 2000, sourceRef: 'evidence:synthetic-target-sale' },
  cargoFacts: { batteryType: 'none', batteryEnergyWh: null, generalCargo: true, personalUse: true,
    irregularShape: false, sourceRef: 'evidence:synthetic-cargo' },
  catalog: { schemaVersion: 'guoo-tariff-catalog-v1', sourceRef: 'evidence:synthetic-catalog',
    ruleVersion: 'synthetic-guoo-v1', observedAt: RECORDED_AT, sourceNotes: [], unresolvedRules: [],
    rows: Array.from({ length: 15 }, (_, index) => guooRow(index + 10)) }
});

test('这一次停在哪，存成一条记录：认的是那两个码，官方佣金表的缺口逐字，服务端那句原话不进记录', () => {
  const record = buildCommissionEstimateSignal({ evidencePreparation: preparation(LIVE_REASON),
    recordedAt: RECORDED_AT, sourceRevision: 27, resultRevision: 28 });
  assert.deepEqual(record, {
    schemaVersion: 'commission-estimate-signal-v1',
    recordedAt: RECORDED_AT,
    sourceRevision: 27,
    resultRevision: 28,
    exactCommissionUnavailable: true,
    officialCommissionTableGaps: ['OFFICIAL_TABLE_PRICE_MISSING', 'OFFICIAL_TABLE_TYPE_IDENTITY_MISSING'],
    failureLayer: 'provider:commission'
  });
  // 服务端那句原话一个字都不存：它可能带着本机证据服务的回环地址或资费表的本机路径，业务记录不许保存这两样。
  // 原话在这一次的 422 回体里已经原样给过主人了。
  assert.equal(JSON.stringify(record).includes('B_EVIDENCE_PROVIDER_READ_FAILED'), false);
  assert.equal(JSON.stringify(record).includes('缺少当前候选'), false);

  // 停在别的地方的那几次也照存，只是不是这一类——它们要能把上一条旧记录盖掉，那一块才跟着消失。
  const blocked = buildCommissionEstimateSignal({
    evidencePreparation: preparation('已得到GUOO表内推荐运费及线路族；这件商品的运输属性还没有你的确认。', 'guoo_route_comparison'),
    recordedAt: RECORDED_AT, sourceRevision: 27, resultRevision: 28 });
  assert.equal(blocked.exactCommissionUnavailable, false);
  assert.deepEqual(blocked.officialCommissionTableGaps, []);
  assert.equal(blocked.failureLayer, 'guoo_route_comparison');

  // 旧的那一代证据服务（HTTP 500 那一版）说的同一件事，照样认得出来。
  assert.equal(buildCommissionEstimateSignal({ evidencePreparation: preparation(PROVIDER),
    recordedAt: RECORDED_AT, sourceRevision: 3, resultRevision: 3 }).exactCommissionUnavailable, true);
  // 服务端连 evidencePreparation 都没给的时候，记录照样成立，只是什么都没认出来。
  const silent = buildCommissionEstimateSignal({ recordedAt: RECORDED_AT, sourceRevision: 0, resultRevision: 0 });
  assert.equal(silent.exactCommissionUnavailable, false);
  assert.equal(silent.failureLayer, null);

  // 修订号和时间不成立的时候宁可报错，也不写一条说不清自己说的是哪一版的记录。
  for (const broken of [{ sourceRevision: 27, resultRevision: 26 }, { sourceRevision: -1, resultRevision: 1 },
    { sourceRevision: 1.5, resultRevision: 2 }, { sourceRevision: 27, resultRevision: null }]) {
    assert.throws(() => buildCommissionEstimateSignal({ evidencePreparation: preparation(LIVE_REASON),
      recordedAt: RECORDED_AT, ...broken }), /COMMISSION_ESTIMATE_SIGNAL_REVISION_INVALID/u, JSON.stringify(broken));
  }
  for (const when of [undefined, null, '', '刚才']) {
    assert.throws(() => buildCommissionEstimateSignal({ evidencePreparation: preparation(LIVE_REASON),
      recordedAt: when, sourceRevision: 27, resultRevision: 28 }), /COMMISSION_ESTIMATE_SIGNAL_RECORDED_AT_INVALID/u, String(when));
  }
});

test('失败那一次物流比较落盘把版本顶高一格，这一块仍然是当期的（2026-09-14 那个 bug）', () => {
  // 现场那一次：主人点确认 → 服务端在同一次失败里把物流比较落了盘 → dataRevision 27 涨到 28。
  const candidate = { id: 'candidate:synthetic-guoo', dataRevision: 27, history: [] };
  const saved = appendGuooRouteComparison(candidate, guooComparison(candidate.id, 27), { recordedAt: RECORDED_AT });
  assert.equal(saved.dataRevision, 28, '物流比较落盘就是会把版本顶高一格，这是这个 bug 的引信');

  // 服务端把这一次的结论记成事实，用的是顶高之后的那个版本号。
  saved.commissionEstimateSignalV1 = buildCommissionEstimateSignal({ evidencePreparation: preparation(LIVE_REASON),
    recordedAt: RECORDED_AT, sourceRevision: 27, resultRevision: saved.dataRevision });
  const step = buildCommissionEstimateStep(saved);
  assert.equal(step.present, true, '重新读一次视图，这一块必须还在');
  assert.equal(step.current, true, '它说的就是当前这一版资料');
  assert.equal(step.recordedRevision, 28);
  assert.equal(step.dataRevision, 28);
  assert.equal(step.recordedAt, RECORDED_AT);
  assert.deepEqual(step.officialGaps, ['OFFICIAL_TABLE_PRICE_MISSING', 'OFFICIAL_TABLE_TYPE_IDENTITY_MISSING']);
  assert.equal(step.schemaVersion, 'commission-estimate-step-v1');
  assert.equal(step.candidateId, 'candidate:synthetic-guoo');

  // 记成顶高之前的那个版本号（也就是这个 bug 原来的形状）：这一块当场变成「说的不是这一版」。
  const stale = { ...saved, commissionEstimateSignalV1: buildCommissionEstimateSignal({
    evidencePreparation: preparation(LIVE_REASON), recordedAt: RECORDED_AT, sourceRevision: 27, resultRevision: 27 }) };
  assert.equal(buildCommissionEstimateStep(stale).present, true, '过期也不许无声消失');
  assert.equal(buildCommissionEstimateStep(stale).current, false);
  assert.equal(buildCommissionEstimateStep(stale).recordedRevision, 27);
});

test('那一块什么时候不该摆：确认成功之后、不是这一类、没有记录或记录不是本软件写的', () => {
  const signal = buildCommissionEstimateSignal({ evidencePreparation: preparation(LIVE_REASON),
    recordedAt: RECORDED_AT, sourceRevision: 27, resultRevision: 28 });
  const candidate = (extra = {}) => ({ id: 'candidate:synthetic-guoo', dataRevision: 28,
    commissionEstimateSignalV1: structuredClone(signal), ...extra });
  assert.equal(buildCommissionEstimateStep(candidate()).present, true);

  // 确认成功之后这一步早过去了：再摆一个待签的授权只会误导主人。
  for (const lifecycle of [{ aConfirmationReceipt: { receiptId: 'receipt:1', decision: 'confirm' } },
    { skuPackage: { skuPackageId: 'sku-package:1' } },
    { aConfirmationReceipt: { receiptId: 'receipt:1' }, skuPackage: { skuPackageId: 'sku-package:1' } }]) {
    const step = buildCommissionEstimateStep(candidate({ lifecycleV11: lifecycle }));
    assert.equal(step.present, false, JSON.stringify(lifecycle));
    assert.equal(step.current, false);
    assert.deepEqual(step.officialGaps, []);
    assert.equal(step.recordedRevision, null);
  }
  // 这件商品刚开始、或者上一次停的不是这一类：这一块根本不存在。
  assert.equal(buildCommissionEstimateStep({ id: 'candidate:synthetic-guoo', dataRevision: 28 }).present, false);
  assert.equal(buildCommissionEstimateStep(candidate({
    commissionEstimateSignalV1: { ...signal, exactCommissionUnavailable: false } })).present, false);
  // 不是本软件写下的格式就不认：宁可不摆，也不照着一份来路不明的记录劝主人签字。
  for (const broken of [{ ...signal, schemaVersion: 'commission-estimate-signal-v2' }, { ...signal, schemaVersion: null },
    'commission-estimate-signal-v1', [], 42]) {
    assert.equal(buildCommissionEstimateStep(candidate({ commissionEstimateSignalV1: broken })).present, false, JSON.stringify(broken));
  }
  // 记录里那几处缺口不成句的，不往页面上摆一个空条目。
  assert.deepEqual(buildCommissionEstimateStep(candidate({
    commissionEstimateSignalV1: { ...signal, officialCommissionTableGaps: ['TYPE_NOT_FOUND', '', '   ', null] }
  })).officialGaps, ['TYPE_NOT_FOUND']);
  // 没有候选、没有版本号时也要给得出一份说得通的答案，不能抛。
  for (const empty of [null, undefined, {}, 'candidate']) {
    const step = buildCommissionEstimateStep(empty);
    assert.equal(step.present, false, String(empty));
    assert.equal(step.candidateId, null);
    assert.equal(step.dataRevision, null);
  }
});

/* ───────── 佣金还是估算的时候，软件敢往下走到哪一步 ───────── */

import { createSavedConditionalBFixture } from './fixtures/real-a-b-flow-fixture.mjs';
import {
  CONDITIONAL_COMMISSION_BLOCK_CODES, EXACT_COMMISSION_RECALCULATION_ACTION, ExactCommissionRequiredForProductionError,
  PRODUCTION_EXACT_COMMISSION_REQUIRED, activeProfitModelOf, assertFormalCommissionBeforeProduction,
  buildEstimatedCommissionNoticeStep, profitThresholdSatisfiedByOwnLogic, resolveConditionalCommissionRelease
} from '../lib/commission-estimate-authorization.mjs';

const BLOCK = CONDITIONAL_COMMISSION_BLOCK_CODES;
// 主人首件就是这一种：走完 A 确认、拿到 B 利润结论、停在条件测算。用真跑出来的那一份，不自己捏一个对象。
const conditional = await createSavedConditionalBFixture();
const conditionalCandidate = conditional.candidate;
const conditionalModel = activeProfitModelOf(conditionalCandidate.lifecycleV11.skuPackage);
/** 换掉当前生效那一份利润记录里的某几个字段，别的原样。 */
const withModel = (patch, runtime) => ({
  profitModel: { ...structuredClone(conditionalModel), ...patch },
  executionRuntime: runtime === undefined ? conditionalCandidate.executionRuntime : runtime
});

test('仅仅因为佣金是估算而停在条件测算的，判为可以放行；判据全部来自结构化字段', () => {
  // 先钉住这一份记录确实是「条件测算 + 估算佣金」那一种，而不是别的原因造成的 manual_review。
  assert.equal(conditionalModel.result, 'manual_review');
  assert.equal(conditionalModel.calculationType, 'conditional');
  assert.equal(conditionalModel.commissionMode, 'estimated');
  assert.equal(conditionalModel.exactCommissionRequiredForFormalB, true);
  assert.equal(conditionalModel.marketFit.status, 'fits_market');
  assert.equal(conditionalCandidate.executionRuntime.exceptionCase, null);

  const release = resolveConditionalCommissionRelease({
    profitModel: conditionalModel, executionRuntime: conditionalCandidate.executionRuntime });
  assert.deepEqual(release.blockedBy, []);
  assert.equal(release.conditionalOnEstimatedCommissionOnly, true);
  // 利润门槛按记录自己存着的那条规矩判，不写死 any。
  assert.equal(release.thresholdLogic, 'any');
  assert.equal(profitThresholdSatisfiedByOwnLogic(conditionalModel), true);
  assert.equal(release.commissionRate, conditionalModel.commissionRate);
  assert.equal(release.unitProfitRmb, conditionalModel.unitProfitRmb);
  assert.equal(release.profitMargin, conditionalModel.profitMargin);
});

test('利润门槛没过的，照旧拦住', () => {
  const thresholds = conditionalModel.thresholds;
  // 两条都差一点：logic 是 any，所以必须两条都不到才算没过。
  const release = resolveConditionalCommissionRelease(withModel({
    unitProfitRmb: thresholds.minimumUnitProfitRmb - 0.01,
    profitMargin: thresholds.minimumProfitMargin - 0.0001
  }));
  assert.equal(release.conditionalOnEstimatedCommissionOnly, false);
  assert.deepEqual(release.blockedBy, [BLOCK.PROFIT_THRESHOLD_NOT_MET]);
  // 只差一条、另一条过了的，按 any 仍然算过——门槛没有被这次改动收紧，也没有被放宽。
  assert.equal(resolveConditionalCommissionRelease(withModel({
    unitProfitRmb: thresholds.minimumUnitProfitRmb - 0.01
  })).conditionalOnEstimatedCommissionOnly, true);
  // logic 换成 all 之后，同一份数字就要两条都过才算过。
  assert.equal(profitThresholdSatisfiedByOwnLogic({
    ...conditionalModel, unitProfitRmb: thresholds.minimumUnitProfitRmb - 0.01,
    thresholds: { ...thresholds, logic: 'all' } }), false);
  // 不认识的 logic 一律算没过：软件不替主人猜一条它读不懂的规矩。
  assert.equal(profitThresholdSatisfiedByOwnLogic({ ...conditionalModel, thresholds: { ...thresholds, logic: 'either' } }), null);
  assert.deepEqual(resolveConditionalCommissionRelease(withModel({
    thresholds: { ...thresholds, logic: 'either' } })).blockedBy, [BLOCK.PROFIT_THRESHOLD_POLICY_UNKNOWN, BLOCK.PROFIT_THRESHOLD_NOT_MET]);
});

test('门槛数值和它自称的那一版对不上的，照旧拦住——记录不能自己把自己判成通过', () => {
  // 把门槛调到 0 就能自己判自己通过；数值必须和 thresholdVersion 指的那一版逐项相等才算数。
  const release = resolveConditionalCommissionRelease(withModel({
    unitProfitRmb: 0.01, profitMargin: 0.0001,
    thresholds: { ...conditionalModel.thresholds, minimumUnitProfitRmb: 0, minimumProfitMargin: 0 }
  }));
  assert.equal(release.conditionalOnEstimatedCommissionOnly, false);
  assert.deepEqual(release.blockedBy, [BLOCK.PROFIT_THRESHOLD_POLICY_UNKNOWN]);
  assert.deepEqual(resolveConditionalCommissionRelease(withModel({ thresholdVersion: 'profit-threshold-v9' })).blockedBy,
    [BLOCK.PROFIT_THRESHOLD_POLICY_UNKNOWN]);
});

test('市场判定没过的，照旧拦住', () => {
  for (const status of ['above_market_needs_review', 'market_conflict', 'severe_market_conflict', 'unknown', null]) {
    const release = resolveConditionalCommissionRelease(withModel({
      marketFit: { ...conditionalModel.marketFit, status } }));
    assert.equal(release.conditionalOnEstimatedCommissionOnly, false, String(status));
    assert.deepEqual(release.blockedBy, [BLOCK.MARKET_FIT_NOT_PASSED], String(status));
  }
});

test('执行期留着一件没解决的异常的，照旧拦住', () => {
  const open = { ...conditionalCandidate.executionRuntime,
    exceptionCase: { schemaVersion: 'exception-case-v2', reasonCode: 'external_dependency_unavailable', status: 'open',
      evidenceRefs: [], dispatchState: 'not_dispatched', automaticRetryAllowed: false } };
  const release = resolveConditionalCommissionRelease({ profitModel: conditionalModel, executionRuntime: open });
  assert.equal(release.conditionalOnEstimatedCommissionOnly, false);
  assert.deepEqual(release.blockedBy, [BLOCK.OPEN_EXCEPTION_CASE]);
  // 已经处理完的那一件不算：它不再挡着谁。
  assert.equal(resolveConditionalCommissionRelease({ profitModel: conditionalModel,
    executionRuntime: { ...open, exceptionCase: { ...open.exceptionCase, status: 'resolved' } } }).conditionalOnEstimatedCommissionOnly, true);
});

test('别的原因造成的 manual_review，照旧拦住——绝不能凭 result 一个字眼放行', () => {
  // 正式计算、精确佣金，结论却是 manual_review：那就是另一件事，和这次要放行的这一种毫无关系。
  const otherReason = resolveConditionalCommissionRelease(withModel({
    result: 'manual_review', calculationType: 'formal', commissionMode: 'exact', exactCommissionRequiredForFormalB: false }));
  assert.equal(otherReason.conditionalOnEstimatedCommissionOnly, false);
  assert.deepEqual(otherReason.blockedBy,
    [BLOCK.CALCULATION_NOT_CONDITIONAL, BLOCK.COMMISSION_MODE_NOT_ESTIMATED, BLOCK.EXACT_COMMISSION_NOT_REQUIRED_FOR_FORMAL_B]);
  // 三个字段各自单独错一个，也一样拦住——三条是「与」的关系，不是投票。
  assert.deepEqual(resolveConditionalCommissionRelease(withModel({ calculationType: 'formal' })).blockedBy, [BLOCK.CALCULATION_NOT_CONDITIONAL]);
  assert.deepEqual(resolveConditionalCommissionRelease(withModel({ commissionMode: 'official_reference' })).blockedBy, [BLOCK.COMMISSION_MODE_NOT_ESTIMATED]);
  assert.deepEqual(resolveConditionalCommissionRelease(withModel({ exactCommissionRequiredForFormalB: false })).blockedBy,
    [BLOCK.EXACT_COMMISSION_NOT_REQUIRED_FOR_FORMAL_B]);
  // 根本读不出一份利润记录的，同样不放行。
  for (const missing of [null, undefined, 'profit', []]) {
    assert.deepEqual(resolveConditionalCommissionRelease({ profitModel: missing, executionRuntime: null }).blockedBy,
      [BLOCK.PROFIT_MODEL_UNREADABLE], String(missing));
  }
});

test('当前生效那一份利润记录必须唯一，指不到或者指到两份都当读不出来', () => {
  const sku = conditionalCandidate.lifecycleV11.skuPackage;
  assert.equal(activeProfitModelOf(sku), sku.profitModels.at(-1));
  assert.equal(activeProfitModelOf({ ...sku, activeProfitModelVersion: 'profit-v99' }), null);
  assert.equal(activeProfitModelOf({ ...sku, profitModels: [...sku.profitModels, structuredClone(conditionalModel)] }), null);
  for (const broken of [null, undefined, {}, { profitModels: 'none' }]) assert.equal(activeProfitModelOf(broken), null, String(broken));
});

test('佣金还是估算时，上架那道闸门拒绝，并给出稳定 ASCII 码和主人下一步', () => {
  const sku = conditionalCandidate.lifecycleV11.skuPackage;
  assert.throws(() => assertFormalCommissionBeforeProduction(sku), error => {
    assert.ok(error instanceof ExactCommissionRequiredForProductionError);
    assert.equal(error.code, PRODUCTION_EXACT_COMMISSION_REQUIRED);
    assert.equal(error.exactCommissionRequiredForProduction, true);
    assert.equal(error.commissionMode, 'estimated');
    assert.equal(error.ownerNextStep, EXACT_COMMISSION_RECALCULATION_ACTION);
    assert.equal(error.skuPackageId, sku.skuPackageId);
    return true;
  });
  // 那个码必须能被生产确认路由分类，否则主人收到的是 500 和一句读不懂的话。
  // 这条正则逐字取自那条路由的分类判断；那边改了这里要红（路由那一头由 cross-stage-contract-schema 钉着）。
  assert.match(PRODUCTION_EXACT_COMMISSION_REQUIRED, /^(?:PRODUCTION_OWNER|PRODUCTION_AUTHORIZATION|BUSINESS_MUTATION|RUNTIME_OPERATION)_[A-Z_]{1,100}$/);
  // official_reference 通过正式佣金类型前置检查；生产另有完整冻结证据门禁。
  const swap = mode => {
    const next = structuredClone(sku);
    next.profitModels.at(-1).commissionMode = mode;
    return next;
  };
  assert.equal(assertFormalCommissionBeforeProduction(swap('official_reference')).commissionMode, 'official_reference');
  assert.throws(() => assertFormalCommissionBeforeProduction(null), { code: PRODUCTION_EXACT_COMMISSION_REQUIRED });
  assert.equal(assertFormalCommissionBeforeProduction(swap('exact')).commissionMode, 'exact');
});

test('「佣金还是估算的」那一块跟着商品走，语气是还差一道手续，不是出了问题', () => {
  const step = buildEstimatedCommissionNoticeStep(conditionalCandidate);
  assert.equal(step.schemaVersion, 'estimated-commission-notice-step-v1');
  assert.equal(step.present, true);
  assert.equal(step.candidateId, conditionalCandidate.id);
  assert.equal(step.dataRevision, conditionalCandidate.dataRevision);
  assert.equal(step.blocksProduction, true);
  assert.equal(step.ownerNextStep, EXACT_COMMISSION_RECALCULATION_ACTION);
  assert.equal(step.release.conditionalOnEstimatedCommissionOnly, true);
  assert.equal(step.sentences.length, 3);
  // 四件事说全：佣金是估算的、现在只是条件测算、上架之前必须先重算一次、重算的两种证据里只有店里实收能上架。
  assert.match(step.sentences[0], /平台佣金还是估算的/u);
  assert.match(step.sentences[1], /条件测算/u);
  assert.match(step.sentences[2], /用更好的费用证据重算/u);
  // 重算能用官方费率表收尾，可上架那道闸门只认店里的实收费率——少说这一句，主人会白高兴一场。
  assert.match(step.sentences[2], /上架这道闸门只认店里的实收费率/u);
  // 不吓唬人：门槛本来就过了，这三句里不许出现这几个字眼。
  for (const sentence of step.sentences) {
    assert.doesNotMatch(sentence, /失败|异常|错误|风险|警告/u, sentence);
  }
  assert.match(step.sentences[1], /不是一件有问题的商品/u);
  // 数字照记录说，不写死。
  assert.ok(step.sentences[0].includes(`${Number((conditionalModel.commissionRate * 100).toFixed(2))}%`));
  assert.ok(step.sentences[1].includes(`¥${conditionalModel.unitProfitRmb.toFixed(2)}`));

  // 佣金换成精确的那一刻它自己消失，不用谁去清。
  const exact = structuredClone(conditionalCandidate);
  exact.lifecycleV11.skuPackage.profitModels.at(-1).commissionMode = 'exact';
  assert.equal(buildEstimatedCommissionNoticeStep(exact).present, false);
  // 已经拿到生产授权的商品不摆这一块：那时候佣金早就是精确的了，再说一句「还差一道手续」只会误导。
  const authorized = structuredClone(conditionalCandidate);
  authorized.lifecycleV11.skuPackage.productionAuthorization = { authorizationId: 'production-auth:synthetic' };
  assert.equal(buildEstimatedCommissionNoticeStep(authorized).present, false);
  // 没有候选、没有 SKU 的也要给得出一份说得通的答案，不能抛。
  for (const empty of [null, undefined, {}, 'candidate']) {
    const none = buildEstimatedCommissionNoticeStep(empty);
    assert.equal(none.present, false, String(empty));
    assert.deepEqual(none.sentences, []);
    assert.equal(none.blocksProduction, false);
  }
});
