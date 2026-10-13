/**
 * 「做这件」之后，不花钱的几步由软件自己往下走（主人 2026-10-11 定的方向：点了「做这件」，算利润、整理资料、准备文案
 * 这些自己跑，只在有问题、要花钱或要主人签字时停下）。
 *
 * 这一份只管两件事，都不读不写：
 * 1. 许可（gate1AutopilotGrantV1）：主人点「做这件」时一起存下，或者在商品页上点「让软件接着做」时存下。许可的范围就是
 *    下面几步，全部只用已经保存的资料：不访问平台、不调 AI、不花钱、不改主人签过的东西。重新做一轮关口 1、换了 SKU 包
 *    或者商品被淘汰，许可就不再算数。
 * 2. 下一步（planGate1Autopilot）：按已经保存的记录，判断下一步是软件能做的哪一步，还是停在哪儿等主人。
 *
 * 一直停下来等主人的：重新读费用证据（只主人触发）、属性映射、付费生成文案、传图、上架确认；品牌与权利没在「做这件」卡上
 * 声明的，也停下等主人声明。
 * 文案写好后不再单独确认，软件让它进入传图，主人在「上架」卡上和图片一起看（v2 许可起才有这一步）。
 * 主人在「做这件」卡上声明了品牌与权利的，C1 计划一生成，软件就把那份声明原样记成权利评审（v3 许可起才有这一步，
 * lib/gate1-rights-declaration.mjs）。
 * v4 许可起，1688 规格采回来以后，软件用主人自己的浏览器读一次主人在卡上认的那个 Ozon 同款页面（只看，不写），
 * 算利润要的类目和对标价格就有了。这是唯一一步要打开平台的：许可里单独存一份公开页面读取授权（publicRead），锁定
 * 网站、动作、商品编号、次数（一次）、阶段和修订号（AGENTS.md §8.1）；建读页面作业的那个事务里就按它扣掉一次
 * （debitGate1PublicRead），次数用完就不建作业、零外部请求；读不成就停下说清楚，不自己再读。
 * 软件某一步出错就记下来停住，不自己重试；主人之后改了别的资料（修订号变了）也不再试这一步（AGENTS.md §8.3）。
 * 只有主人点「让软件再试一次」，或者重新点「做这件」换了一份许可，软件才会再做这一步。
 */
import { gate1RightsDeclarationCurrent } from './gate1-rights-declaration.mjs';
import { canonicalOzonCapturePageUrl, ozonCapturePageProductId } from './ozon-page-capture-job.mjs';
import { validateSalesSnapshot } from './sales-snapshot.mjs';

export const GATE1_AUTOPILOT_GRANT_SCHEMA_VERSION = 'gate1-autopilot-grant-v1';
export const GATE1_AUTOPILOT_RECORD_SCHEMA_VERSION = 'gate1-autopilot-v1';
export const GATE1_AUTOPILOT_VIEW_SCHEMA_VERSION = 'gate1-autopilot-view-v1';
/**
 * 卡上那句许可说明的版本。做这件的请求带着它，才算主人看过这句话。v2 多了一步「文案写好后直接进入传图」：文案不再单独
 * 确认，和图片、店铺、价格一起在「上架」卡上看、一起点（lib/gate2-listing.mjs）。v3 再多一步「按卡上的声明记下品牌与
 * 权利」。v4 再多一步「规格采回来后读一次认下的 Ozon 同款页面」。老版本的许可照旧算数，只是不含后来加的步骤。
 */
export const GATE1_AUTOPILOT_SCOPE_VERSION = 'gate1-autopilot-scope-v4';
const GATE1_AUTOPILOT_SCOPE_VERSIONS = Object.freeze(['gate1-autopilot-scope-v1', 'gate1-autopilot-scope-v2', 'gate1-autopilot-scope-v3',
  GATE1_AUTOPILOT_SCOPE_VERSION]);
export const GATE1_AUTOPILOT_ACTOR_SOURCE = 'gate1_autopilot';
export const GATE1_AUTOPILOT_ACTOR_USER_ID = 'selection-review-software';
export const GATE1_AUTOPILOT_CONSENT_LINE = '点「做这件」之后，1688 规格采回来时，软件用你的浏览器读一次你认的那个 Ozon 同款页面，只看类目和价格，不写任何东西；' +
  '重算利润、整理属性和关键词、准备文案请求这几步不花钱，软件自己往下做；' +
  '上面声明了品牌与权利的，规格定下后软件按这份声明记到这件商品上；文案写好就直接进入传图，文案和图片最后在上架卡上一起看。' +
  '要花钱、要你传图和点「上架」时，它停下来等你；品牌与权利没声明的，到时候也停下等你。';
export const GATE1_AUTOPILOT_STEPS = Object.freeze({
  a_read_ozon_benchmark: '读一次你认的那个 Ozon 同款页面',
  b_exact_recalculation: '用店里的实收费率重算利润',
  c1_supply_backfill: '补齐已采到的供应属性',
  c1_apply_rights: '按你在「做这件」卡上的声明记下品牌与权利',
  c1_local_material: '整理商品属性与关键词',
  c1_prepare_copy: '准备文案请求',
  c1_forward_copy: '把写好的文案送进传图'
});
/** 许可里那份公开页面读取授权：只读这一个 Ozon 商品页、只读一次、只在确认供货之前（AGENTS.md §8.1）。 */
export const GATE1_PUBLIC_READ_SCHEMA_VERSION = 'gate1-public-read-v1';
export const GATE1_PUBLIC_READ_EXCLUDES = Object.freeze(['store_backend', 'login_required_page', 'platform_write', 'paid_call']);
const RAN_STEPS_KEPT = 12;
const PUBLIC_READS_KEPT = 12;
const STOP_LINES_SHOWN = 4;
const LOCAL_MATERIAL_VERSION = 'c1-local-preparation-v2';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * 许可本身。via 是 gate1_accept（做这件那一下）或 owner_continue（商品页上「让软件接着做」）。
 * 绑在关口 1 那一次决定上；没有关口 1 记录的老商品，绑在当时的 SKU 包上。两样都没有就不发许可。
 */
export function buildGate1AutopilotGrant({ candidateId, sourceRevision, decision = null, skuPackageId = null, via, grantedAt, grantedBy }) {
  if (!['gate1_accept', 'owner_continue'].includes(via)) throw new Error('GATE1_AUTOPILOT_GRANT_VIA_INVALID');
  const accepted = decision?.decision === 'accept' ? decision : null;
  if (via === 'gate1_accept' && accepted === null) throw new Error('GATE1_AUTOPILOT_GRANT_DECISION_REQUIRED');
  if (accepted === null && text(skuPackageId) === null) throw new Error('GATE1_AUTOPILOT_GRANT_UNBOUND');
  if (text(candidateId) === null || !Number.isInteger(sourceRevision) || text(grantedAt) === null) {
    throw new Error('GATE1_AUTOPILOT_GRANT_INPUT_INVALID');
  }
  const publicRead = gate1PublicReadFor({ candidateId, sourceRevision, decision: accepted, skuPackageId });
  return Object.freeze({
    schemaVersion: GATE1_AUTOPILOT_GRANT_SCHEMA_VERSION,
    grantId: `gate1-autopilot-grant:${candidateId}:${sourceRevision}`,
    scopeVersion: GATE1_AUTOPILOT_SCOPE_VERSION,
    scope: Object.freeze(Object.keys(GATE1_AUTOPILOT_STEPS)),
    via,
    grantedAt,
    grantedBy: text(grantedBy),
    sourceRevision,
    gate1DecidedAt: accepted?.decidedAt ?? null,
    gate1RoundIndex: accepted?.roundIndex ?? null,
    skuPackageId: text(skuPackageId),
    ...(publicRead === null ? {} : { publicRead }),
    paidCalls: 0,
    platformWrites: 0
  });
}

/**
 * 认下的那个 Ozon 同款页面。卡上没认 Ozon 同款、地址不是一个能直接打开的商品页、或者已经确认过供货（有 SKU 包），
 * 就没有这份授权，软件也就不读。
 */
function gate1PublicReadFor({ candidateId, sourceRevision, decision, skuPackageId }) {
  const ozon = decision?.picks?.ozon;
  if (!isObject(ozon) || text(skuPackageId) !== null) return null;
  const productId = ozonCapturePageProductId(ozon.sourceUrl);
  const productUrl = productId === '' ? null : canonicalOzonCapturePageUrl(ozon.sourceUrl, productId);
  if (productUrl === null || String(ozon.id) !== productId) return null;
  return Object.freeze({
    schemaVersion: GATE1_PUBLIC_READ_SCHEMA_VERSION,
    site: 'www.ozon.ru',
    action: 'read_product_page',
    productId,
    productUrl,
    maxReads: 1,
    stage: 'A',
    candidateId,
    sourceRevision,
    excludes: GATE1_PUBLIC_READ_EXCLUDES
  });
}

/** 许可还算不算数：同一次关口 1 决定、同一个 SKU 包、商品没被淘汰。同款各色的成员不归这里管。 */
export function gate1AutopilotGrantCurrent(candidate) {
  const grant = candidate?.gate1AutopilotGrantV1;
  if (!isObject(grant) || grant.schemaVersion !== GATE1_AUTOPILOT_GRANT_SCHEMA_VERSION ||
      !GATE1_AUTOPILOT_SCOPE_VERSIONS.includes(grant.scopeVersion) || !Array.isArray(grant.scope)) return false;
  if (candidate.workflowStatus === 'eliminated' || isObject(candidate.siblingSourceV1)) return false;
  if (grant.gate1DecidedAt !== null) {
    const decision = candidate.gate1DecisionV1;
    if (decision?.decision !== 'accept' || decision.decidedAt !== grant.gate1DecidedAt) return false;
  }
  if (grant.skuPackageId !== null && candidate.lifecycleV11?.skuPackage?.skuPackageId !== grant.skuPackageId) return false;
  return grant.gate1DecidedAt !== null || grant.skuPackageId !== null;
}

/** 这个身份是不是「做这件之后自己往下走」的那个软件身份。 */
export function isGate1AutopilotActor(actor) {
  return actor?.actorType === 'software' && actor.source === GATE1_AUTOPILOT_ACTOR_SOURCE &&
    actor.userId === GATE1_AUTOPILOT_ACTOR_USER_ID && Array.isArray(actor.roles) && actor.roles.includes('operator');
}

/** 用例在事务里调用：软件身份只有在这件商品的许可还算数、这一步又在许可范围里时才放行。 */
export function gate1AutopilotMayAct(actor, candidate, step) {
  return isGate1AutopilotActor(actor) && Object.hasOwn(GATE1_AUTOPILOT_STEPS, step) && gate1AutopilotGrantCurrent(candidate) &&
    candidate.gate1AutopilotGrantV1.scope.includes(step);
}

/** 当前那份本地准备材料，和 C1LocalPreparationPanel 判断「是不是当前的」用同一条规则。 */
function currentLocalMaterial(lifecycle, sku, dataRevision) {
  const saved = lifecycle.c1KeywordPlanningLocalMaterialV1;
  const material = saved?.schemaVersion === LOCAL_MATERIAL_VERSION ? saved : null;
  if (!material) return null;
  const adopted = lifecycle.c1LocalDraftSourceV1?.materialFingerprint === material.materialFingerprint;
  const current = adopted || (material.resultCandidateRevision === dataRevision && material.sourceSkuRevision === sku.dataRevision);
  return current ? material : null;
}

/** 冻结快照里还没有这次采集采到的页面属性，而同一次采集确实采到了：和补齐用例拒绝的条件一一对应。 */
function supplyBackfillApplies(candidate, sku) {
  const plan = sku.c1ProductPlan;
  if (plan?.status !== 'inputs_ready' || sku.productionAuthorization || sku.productionRecord) return false;
  const captured = candidate.sourceCapture?.supplierAttributes;
  const captureId = text(candidate.sourceCapture?.captureId);
  if (!isObject(captured) || captureId === null) return false;
  const additions = Object.entries(captured).filter(([key, value]) =>
    !['品牌', '有可授权的自有品牌'].includes(key) && text(value) !== null);
  if (!additions.length) return false;
  const targets = [sku.selectedSupplySnapshot, plan.inputSnapshots?.confirmedSupplierSkuSnapshot];
  if (targets.some(target => !isObject(target?.supplierSku?.attributes) ||
      target.supplierSku.attributes.quantityOneEvidence?.captureId !== captureId)) return false;
  // 已经补过（或采集当时就带上了）：页面属性的键至少有一个已在冻结快照里，就不再动它。
  return targets.every(target => Object.keys(target.supplierSku.attributes)
    .every(key => ['quantityOneEvidence', 'purchaseCostComponents'].includes(key)));
}

/** 主人在「做这件」卡上声明过品牌与权利、C1 计划刚生成还没有声明记录：软件按那份声明记下（不替换已冻结的计划）。 */
function rightsDeclarationApplies(candidate, sku, granted, observedAt) {
  const plan = sku.c1ProductPlan;
  return granted && candidate.gate1AutopilotGrantV1.scope.includes('c1_apply_rights') && plan?.status === 'inputs_ready' &&
    isObject(plan.inputSnapshots) && !Object.hasOwn(plan.inputSnapshots, 'skuRightsReview') && text(plan.c1PlanId) !== null &&
    (sku.c1RightsReviewRecord === undefined || sku.c1RightsReviewRecord === null) &&
    gate1RightsDeclarationCurrent(candidate, observedAt) !== null;
}

function gapLine(gap) {
  if (gap?.field === 'skuRightsReview') {
    return gap.code === 'C1_SKU_RIGHTS_REVIEW_REQUIRED'
      ? '还没有保存这件商品的品牌与权利声明，这一步只能你来签'
      : '保存过的品牌与权利声明用不了（可能过期了），请重新核对后保存';
  }
  return text(gap?.message) ?? '准备材料还有一项缺口';
}

const stop = (code, line) => Object.freeze({ code, line });

/** 这件商品身上有没有一份真实打开过这个 Ozon 商品页读回来的快照。 */
function realPageSnapshotOf(candidate, productId) {
  return (Array.isArray(candidate.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : []).some(snapshot =>
    snapshot?.collectorMode === 'real_page_read_only' && ozonCapturePageProductId(snapshot.productUrl) === productId &&
    validateSalesSnapshot(snapshot).valid);
}

const readInFlight = capture => ['waiting_extension', 'capturing'].includes(capture?.status) ||
  ['queued', 'claimed'].includes(capture?.jobStatus);

/** 许可里那份公开页面读取授权；没有、形状不对或者次数不是正整数，就当没有。 */
function publicReadOf(grant) {
  const read = isObject(grant?.publicRead) ? grant.publicRead : null;
  return read?.schemaVersion === GATE1_PUBLIC_READ_SCHEMA_VERSION && read.site === 'www.ozon.ru' &&
    read.action === 'read_product_page' && read.stage === 'A' && Number.isInteger(read.maxReads) && read.maxReads > 0 ? read : null;
}

/** 这份许可下软件已经排过几次读页面：建作业那一刻就记一次，后来读没读成都算。 */
function publicReadsUsed(candidate, grant) {
  const reads = candidate.gate1AutopilotV1?.publicReads;
  return (Array.isArray(reads) ? reads : []).filter(item => item?.grantId === grant.grantId).length;
}

/**
 * 建读页面作业的那个事务里调用：软件要读认下的那个 Ozon 同款页面之前，按许可里的公开页面读取授权扣一次
 * （AGENTS.md §8.1）。许可不算数、已经确认过供货、没有这份授权、要读的不是授权里那一页，或者次数已经用完，就不给读：
 * 调用方这时不建作业，也就没有任何外部请求。扣下的这一次和作业写在同一个事务里，作业建了次数就一定扣了；
 * 作业后来没人领、或者没读成，这一次也不退。返回 { ok: true, record }（要存回去的运行记录），或者 { ok: false, code }。
 */
export function debitGate1PublicRead(candidate, { productId, captureId, at }) {
  const refuse = code => Object.freeze({ ok: false, code });
  if (!gate1AutopilotGrantCurrent(candidate)) return refuse('GATE1_PUBLIC_READ_GRANT_NOT_CURRENT');
  const grant = candidate.gate1AutopilotGrantV1;
  const read = publicReadOf(grant);
  if (read === null || !grant.scope.includes('a_read_ozon_benchmark') || read.candidateId !== candidate.id) {
    return refuse('GATE1_PUBLIC_READ_NOT_AUTHORIZED');
  }
  if (isObject(candidate.lifecycleV11?.aConfirmationReceipt) || isObject(candidate.lifecycleV11?.skuPackage)) {
    return refuse('GATE1_PUBLIC_READ_STAGE_CLOSED');
  }
  if (String(productId ?? '') !== read.productId) return refuse('GATE1_PUBLIC_READ_TARGET_MISMATCH');
  if (publicReadsUsed(candidate, grant) >= read.maxReads) return refuse('GATE1_PUBLIC_READ_EXHAUSTED');
  if (text(captureId) === null || text(at) === null) throw new Error('GATE1_PUBLIC_READ_DEBIT_INPUT_INVALID');
  // 还没有运行记录时，补成和 gate1AutopilotRecordAfterRun 写出来的同一个形状。
  const record = isObject(candidate.gate1AutopilotV1) ? candidate.gate1AutopilotV1 : { lastRunAt: null, ranSteps: [], failure: null };
  const publicReads = [...(Array.isArray(record.publicReads) ? record.publicReads : []),
    { grantId: grant.grantId, productId: read.productId, captureId, at, sourceRevision: candidate.dataRevision }].slice(-PUBLIC_READS_KEPT);
  return Object.freeze({ ok: true, record: { ...record, schemaVersion: GATE1_AUTOPILOT_RECORD_SCHEMA_VERSION, publicReads } });
}

/**
 * 确认供货之前那一次读页面。许可里有 publicRead、认下的就是那个商品、还没读到过它：等「做这件」那一下申请的 1688
 * 采集采回规格（采集控制同一时刻只给一个作业），软件读一次。读过一次就不再读：还在读就说在读，没读成就停下等主人。
 */
function benchmarkReadPlan(candidate, granted) {
  if (!granted || isObject(candidate.lifecycleV11?.aConfirmationReceipt)) return null;
  const grant = candidate.gate1AutopilotGrantV1;
  const read = publicReadOf(grant);
  if (read === null || !grant.scope.includes('a_read_ozon_benchmark') || read.candidateId !== candidate.id ||
      String(candidate.gate1DecisionV1?.picks?.ozon?.id ?? '') !== read.productId) return null;
  if (realPageSnapshotOf(candidate, read.productId)) return null;
  const capture = isObject(candidate.salesCapture) ? candidate.salesCapture : null;
  const ran = (Array.isArray(candidate.gate1AutopilotV1?.ranSteps) ? candidate.gate1AutopilotV1.ranSteps : [])
    .some(item => item?.step === 'a_read_ozon_benchmark' && Date.parse(item.at) >= Date.parse(grant.grantedAt));
  // 读失败时那条记录会整份重写（不带 queuedBy），所以「是不是读的这一页」看商品编号；「读没读过」先看建作业时扣下的次数
  // （和作业同一个事务），再看软件自己的运行记录（扣次数之前的老记录只有这一样）。
  const used = publicReadsUsed(candidate, grant) >= read.maxReads;
  const same = capture !== null && capture.productId === read.productId;
  if (used || ran || (same && capture.queuedBy === GATE1_AUTOPILOT_ACTOR_SOURCE)) {
    if (same && readInFlight(capture)) return { working: '软件正在读你认的那个 Ozon 同款页面' };
    const reason = same ? text(capture.reason) : null;
    return { stop: stop('a_ozon_read_failed', `软件读了一次你认的那个 Ozon 同款页面，没读到${reason ? `（${reason.replace(/[。.]+$/u, '')}）` : ''}；` +
      '它不会自己再读，在这件商品的「算利润」里点「读一次这个 Ozon 页面」') };
  }
  if (readInFlight(capture) || candidate.sourceCapture?.status !== 'captured_waiting_owner_selection') return null;
  return { next: { step: 'a_read_ozon_benchmark', productId: read.productId, productUrl: read.productUrl } };
}

/**
 * 存下的出错记录挡不挡这一步。挡的是同一步，而且一直挡着：主人之后改了别的资料（修订号变了）也照样挡（AGENTS.md §8.3）。
 * 只有两种情况放开：主人点「让软件再试一次」（那条路会清掉这条记录），或者出错时那份许可已经换成了新的（主人重新点了
 * 「做这件」）。改法之前存下的记录没有许可编号，能确定它出在现在这份许可之前才放开，分不清就照样挡。
 * 没有许可时软件本来就不会自己做，这里不挡，页面照常让主人点「让软件接着做」。
 */
function failureBlocks(saved, next, grant) {
  if (!isObject(saved) || next === null || saved.step !== next.step || !isObject(grant)) return false;
  if (text(saved.grantId) !== null) return saved.grantId === grant.grantId;
  return !(Date.parse(saved.at) < Date.parse(grant.grantedAt));
}

/**
 * 下一步。只看已经保存的记录（以及服务端顺手算好的「能不能重算」那份视图），不探测、不读平台。
 * 返回 null：这件商品不在「做这件」和「上架确认」之间（还没确认供货、已经上架、被淘汰、同款各色成员，或不是 Ozon）。
 */
export function planGate1Autopilot({ candidate, bExactCommissionRuntimeView = null, c1EditorialPending = false, observedAt = null }) {
  if (!isObject(candidate) || candidate.workflowStatus === 'eliminated' || candidate.workflowStatus === 'listed') return null;
  if (isObject(candidate.siblingSourceV1)) return null;
  const lifecycle = isObject(candidate.lifecycleV11) ? candidate.lifecycleV11 : null;
  const sku = isObject(lifecycle?.skuPackage) ? lifecycle.skuPackage : null;
  const granted = gate1AutopilotGrantCurrent(candidate);
  let next = null;
  const stops = [];
  let working = null;
  if (sku === null) {
    // 还没确认供货：软件只做一件事，读一次认下的 Ozon 同款页面；挑规格、确认供货还是主人在商品页上做，这里不替它说话。
    const read = benchmarkReadPlan(candidate, granted);
    if (read === null) return null;
    next = read.next ?? null;
    working = read.working ?? null;
    if (read.stop) stops.push(read.stop);
  } else if (sku.targetPlatform !== 'ozon' || sku.productionAuthorization || sku.productionRecord ||
      /^[DE]/u.test(String(sku.businessPhase ?? ''))) {
    return null;
  } else if (lifecycle.status === 'b_conditional_awaiting_exact_commission') {
    const recalc = isObject(bExactCommissionRuntimeView) ? bExactCommissionRuntimeView : null;
    if (recalc?.canRecalculate === true && recalc.commissionEvidenceMode === 'exact' && text(recalc.failureId) !== null) {
      next = { step: 'b_exact_recalculation', skuPackageId: sku.skuPackageId, failureId: recalc.failureId };
    } else if (recalc?.canRecalculate === true) {
      stops.push(stop('b_official_reference_only', '只读到 Ozon 官方费率表上的公开费率，不是这个店被扣过的钱；要不要先按它重算利润，由你定'));
    } else {
      stops.push(stop('b_evidence_required', granted
        ? '利润还是按估算佣金算的：在这件商品的页面上重新读一次费用证据，读到店里的实收费率后软件自己重算'
        : '利润还是按估算佣金算的：在这件商品的页面上重新读一次费用证据，再用它重算'));
    }
  } else if (sku.businessPhase === 'C1') {
    const plan = isObject(sku.c1ProductPlan) ? sku.c1ProductPlan : null;
    if (plan?.status === 'seo_draft_ready') {
      // 文案写好了：有 v2 许可就直接进入传图，文案到「上架」卡上和图片一起看。改版方案、有待采用的修订稿、或者老许可，
      // 仍旧停下等主人单独确认文案。
      const forward = granted && candidate.gate1AutopilotGrantV1.scope.includes('c1_forward_copy') && c1EditorialPending !== true &&
        !lifecycle.c1FinalPlanRevisionPreparation && !lifecycle.c1ContentReviewV1 && !lifecycle.c1ContentForwardV1;
      if (forward) next = { step: 'c1_forward_copy', skuPackageId: sku.skuPackageId };
      else stops.push(stop('c1_content_review', '文案已经写好，等你看一眼确认，确认后进入图片'));
    } else if (lifecycle.c1AiDraftJobRefV1) {
      working = '文案正在生成，结果回来后在这件商品的页面上确认';
    } else if (lifecycle.c1AiDraftRequestV1) {
      stops.push(stop('c1_paid_draft', '文案请求已经准备好，等你允许这一次付费生成'));
    } else if (lifecycle.c1SoftwareEvidenceV1) {
      working = '软件正在准备文案请求';
    } else if (supplyBackfillApplies(candidate, sku)) {
      next = { step: 'c1_supply_backfill', skuPackageId: sku.skuPackageId };
    } else if (rightsDeclarationApplies(candidate, sku, granted, observedAt)) {
      next = { step: 'c1_apply_rights', skuPackageId: sku.skuPackageId, c1PlanId: sku.c1ProductPlan.c1PlanId };
    } else {
      const material = currentLocalMaterial(lifecycle, sku, candidate.dataRevision);
      if (material === null) next = { step: 'c1_local_material', skuPackageId: sku.skuPackageId };
      else if (material.status === 'ready_for_review') next = { step: 'c1_prepare_copy', skuPackageId: sku.skuPackageId };
      else {
        const gaps = Array.isArray(material.gaps) ? material.gaps : [];
        const lines = [...new Set(gaps.map(gapLine))];
        for (const line of lines) stops.push(stop('c1_material_gap', line));
        if (!lines.length) stops.push(stop('c1_material_gap', '属性与关键词准备还有缺项，打开这件商品看「商品属性与关键词准备」'));
      }
    }
  } else if (sku.businessPhase === 'C2') {
    // 图排好了就是「上架」那一道确认：图片、店铺写入和写入前的核验在同一张卡上一次点完（lib/gate2-listing.mjs）。
    const draft = isObject(lifecycle.c2UploadDraft) ? lifecycle.c2UploadDraft : null;
    const arranged = Array.isArray(draft?.selection) && draft.selection.length > 0 &&
      !(Array.isArray(draft.uploads) && draft.uploads.some(upload => upload?.status === 'uploading'));
    stops.push(isObject(sku.productionConfirmationCard)
      ? stop('gate2', '方案卡已经生成：在上架卡上看一眼，点「上架」')
      : arranged ? stop('gate2', '图片已经排好：在上架卡上看一眼，点「上架」')
        : stop('c2_assets', lifecycle.c1ContentForwardV1 && !lifecycle.c1ContentReviewV1
          ? '文案已经写好：传上架用的图片，排第一张的就是主图；文案到上架卡上和图片一起看'
          : '文案已确认：传上架用的图片，排第一张的就是主图'));
  } else {
    return null;
  }

  const record = isObject(candidate.gate1AutopilotV1) ? candidate.gate1AutopilotV1 : null;
  const savedFailure = isObject(record?.failure) ? record.failure : null;
  const failure = failureBlocks(savedFailure, next, candidate.gate1AutopilotGrantV1) ? savedFailure : null;
  const ranSteps = (Array.isArray(record?.ranSteps) ? record.ranSteps : []).slice(-RAN_STEPS_KEPT)
    .map(item => Object.freeze({ step: item.step, label: GATE1_AUTOPILOT_STEPS[item.step] ?? item.step, at: item.at ?? null }));
  const label = next === null ? null : GATE1_AUTOPILOT_STEPS[next.step];
  let status;
  let line;
  if (failure !== null) {
    status = 'failed';
    line = `软件${label}时出错停下了（${failure.code}），没有自己重试；之后改了资料它也不会自己再试，要它再做一次就点「让软件再试一次」`;
  } else if (next !== null && granted) {
    status = 'running';
    line = `软件正在${label}`;
  } else if (next !== null) {
    status = 'ready';
    line = `「${label}」这一步不花钱，可以让软件接着做`;
  } else if (stops.length) {
    status = 'waiting_owner';
    line = stops[0].line;
  } else {
    status = 'working';
    line = working;
  }
  return Object.freeze({
    schemaVersion: GATE1_AUTOPILOT_VIEW_SCHEMA_VERSION,
    status,
    granted,
    line,
    next: next === null ? null : Object.freeze({ ...next, label }),
    stops: Object.freeze(stops.slice(0, STOP_LINES_SHOWN)),
    moreStops: Math.max(stops.length - STOP_LINES_SHOWN, 0),
    failure: failure === null ? null : Object.freeze({ step: failure.step, label, code: failure.code, at: failure.at ?? null }),
    ranSteps: Object.freeze(ranSteps),
    paidCalls: 0,
    platformWrites: 0
  });
}

/** 软件某一步出错的那条记录。记下出错时那份许可的编号，换了许可才不再挡（见 failureBlocks）。 */
export function gate1AutopilotFailure({ candidate, step, code, at }) {
  return { step, code, at, sourceRevision: candidate.dataRevision, grantId: text(candidate.gate1AutopilotGrantV1?.grantId) };
}

/** 这一次软件做完的几步，追加进记录；只留最近几条。读页面扣下的次数原样留着。 */
export function gate1AutopilotRecordAfterRun(record, { ranSteps = [], failure = null, at }) {
  const previous = isObject(record) ? record : {};
  const kept = [...(Array.isArray(previous.ranSteps) ? previous.ranSteps : []), ...ranSteps].slice(-RAN_STEPS_KEPT);
  return {
    schemaVersion: GATE1_AUTOPILOT_RECORD_SCHEMA_VERSION,
    lastRunAt: at,
    ranSteps: kept,
    failure: failure === null ? (ranSteps.length ? null : previous.failure ?? null) : failure,
    ...(Array.isArray(previous.publicReads) ? { publicReads: previous.publicReads } : {})
  };
}
