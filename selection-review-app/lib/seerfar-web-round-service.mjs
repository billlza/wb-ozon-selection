/**
 * 服务端的 Seerfar 会员前台查询（方案 B 第一段）：主人点"收一轮" → 存下这轮的条件和一次性只读许可 → 插件领取，
 * 在主人自己已登录的 Chrome 里打开「热销榜单选品」页，收下主人按建议条件搜出的那一页结果 → 服务端按固定规则筛、
 * 粗算利润，排在前面的几个收成待核验候选。
 *
 * 和其他插件作业同一套规矩：一次性令牌、插件明确领取、领取后只回传一次、超时收口、重启对账、不自动重试。
 * 作业会话只活在建立它的进程里；中央持久化的是轮次记录（document.runtime.seerfarWebRounds），会话丢了轮次会被收口。
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { estimateDiscoveredProduct } from './a-discovery-estimate.mjs';
import { knownMarketProductIds } from './a-discovery-candidate-import.mjs';
import { createInitialCandidate } from './candidate-initialization.mjs';
import { assertSafeBusinessMutationCandidate } from './runtime-identity.mjs';
import { planSeerfarQueries } from './seerfar-selection-plan.mjs';
import { storeSeedsForPlan } from './store-sales-seed-service.mjs';
import { readStoreProfile, readStoreProfiles } from './store-profile.mjs';
import { SEERFAR_WEB_SEARCH_ENDPOINT, SEERFAR_WEB_SEARCH_PAGE, SEERFAR_WEB_PAGE_SIZE } from './seerfar-web-discovery-contract.mjs';
import { SEERFAR_WEB_CAPTURE_WAIT_MS, SEERFAR_WEB_ROUND_MODE, SeerfarWebRoundError, claimSeerfarWebRound, completeSeerfarWebRound,
  createSeerfarWebRoundRecord, failSeerfarWebRound, normalizeSeerfarWebCapture, sameQueryRoundToday, seerfarWebCandidateEvidence,
  seerfarWebEstimateProduct, seerfarWebRoundPublic, seerfarWebRounds } from './seerfar-web-round.mjs';

export const SEERFAR_WEB_CAPTURE_KIND = 'seerfar_web_discovery';
const httpFail = (status, code, message) => Object.assign(new SeerfarWebRoundError(code, message), { status, publicMessage: message });

function sameToken(expected, provided) {
  const left = Buffer.from(String(expected || '')), right = Buffer.from(String(provided || ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export function createSeerfarWebRoundService({ readData, mutateData, mutateDataWhenChanged, now, businessDate, estimateInputs, storeBindings,
  config, configError = null, requiredExtensionVersion, queueTtlMs = 2 * 60 * 1000, executionTtlMs = SEERFAR_WEB_CAPTURE_WAIT_MS + 60 * 1000,
  isCaptureControlBusy = () => false, log = () => {} }) {
  if ([readData, mutateData, mutateDataWhenChanged, now, businessDate, isCaptureControlBusy].some(fn => typeof fn !== 'function') ||
      !Array.isArray(storeBindings) || typeof requiredExtensionVersion !== 'string') throw new TypeError('SEERFAR_WEB_ROUND_SERVICE_DEPENDENCY_INVALID');
  const sessions = new Map();
  const timers = new Map();

  function clearTimer(captureId) {
    const timer = timers.get(captureId);
    if (timer) clearTimeout(timer);
    timers.delete(captureId);
  }

  async function closeRound(roundId, captureId, code) {
    return mutateDataWhenChanged(document => {
      const rounds = seerfarWebRounds(document);
      const record = rounds[roundId];
      if (!record || record.captureId !== captureId) return { changed: false };
      const failed = failSeerfarWebRound(record, code, now());
      if (!failed) return { changed: false };
      rounds[roundId] = failed;
      return { changed: true, result: failed };
    });
  }

  function scheduleExpiry(session, expectedStatus, timeoutMs) {
    clearTimer(session.captureId);
    const timer = setTimeout(() => {
      const current = sessions.get(session.captureId);
      if (!current || current.jobStatus !== expectedStatus) return;
      current.jobStatus = expectedStatus === 'claimed' ? 'unknown_outcome' : 'expired';
      sessions.delete(session.captureId);
      void closeRound(session.roundId, session.captureId, expectedStatus === 'claimed' ? 'unknown_outcome' : 'extension_job_unclaimed')
        .catch(error => log('Seerfar 榜单作业超时收口失败', error));
    }, timeoutMs);
    timer.unref?.();
    timers.set(session.captureId, timer);
  }

  function plans(document) {
    if (!config) return {};
    const date = businessDate();
    return Object.fromEntries(Object.entries(readStoreProfiles(document, { config })).map(([store, profile]) =>
      [store, planSeerfarQueries({ businessDate: date, profile, calendar: config.calendar, seeds: storeSeedsForPlan(document, store) })]));
  }

  function view(document) {
    const rounds = Object.values(seerfarWebRounds(structuredClone(document)))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 20).map(seerfarWebRoundPublic);
    const todayRuns = Object.fromEntries(rounds.filter(round => round.businessDate === businessDate() && round.status !== 'failed')
      .map(round => [`${round.targetStore}|${round.query.queryId}`, round.roundId]));
    return { businessDate: businessDate(), configError, plans: plans(document), rounds, todayRuns,
      busy: [...sessions.values()].some(session => ['queued', 'claimed'].includes(session.jobStatus)) };
  }

  function activeSession() {
    return [...sessions.values()].find(session => ['queued', 'claim_pending', 'claimed'].includes(session.jobStatus)) || null;
  }

  async function startRound({ actor, targetStore, queryId }) {
    if (!config) throw httpFail(503, 'CONFIG_UNAVAILABLE', 'Seerfar 选品档案或季节日历读不出来，这一轮没有开始。');
    if (activeSession() || isCaptureControlBusy()) throw httpFail(409, 'CAPTURE_BUSY', '插件正在做别的采集，这一轮没有开始，也不会排队。');
    const captureId = `SWR-${randomUUID()}`;
    const session = { captureId, token: randomBytes(32).toString('base64url'), roundId: null, targetStore, candidateId: null,
      captureKind: SEERFAR_WEB_CAPTURE_KIND, jobStatus: 'queued', attempt: 0, createdAt: Date.now(), expiresAt: Date.now() + queueTtlMs,
      requiredExtensionVersion, claimedAt: null, claimedExtensionVersion: '', claimedExtensionOrigin: '' };
    sessions.set(captureId, session);
    let record;
    try {
      record = await mutateData(document => {
        const plan = plans(document)[targetStore];
        if (!plan) throw httpFail(400, 'STORE_UNKNOWN', '这家店没有 Seerfar 选品档案。');
        const query = plan.queries.find(value => value.queryId === queryId);
        if (!query) throw httpFail(409, 'QUERY_NOT_CURRENT', '这条查询不在今天的建议里了，请刷新再选。');
        const existing = sameQueryRoundToday(document, { targetStore, queryId, businessDate: plan.businessDate });
        if (existing) throw httpFail(409, 'ALREADY_RUN_TODAY', '这条查询今天已经收过一轮了，同一天不重复查。');
        const created = createSeerfarWebRoundRecord({ targetStore, businessDate: plan.businessDate, query, plan, requestedBy: actor.userId, at: now(), captureId });
        seerfarWebRounds(document)[created.roundId] = created;
        return created;
      });
    } catch (error) {
      sessions.delete(captureId);
      throw error;
    }
    session.roundId = record.roundId;
    scheduleExpiry(session, 'queued', queueTtlMs);
    return { round: seerfarWebRoundPublic(record), captureJob: { jobId: captureId, mode: SEERFAR_WEB_ROUND_MODE, status: 'queued', roundId: record.roundId } };
  }

  async function claim(captureId, extensionVersion, extensionOrigin) {
    const session = sessions.get(captureId);
    if (!session || session.jobStatus !== 'queued' || session.attempt !== 0 || session.expiresAt <= Date.now()) {
      throw httpFail(409, 'NOT_CLAIMABLE', '这次 Seerfar 作业已领取、失效或不存在，不能再次执行。');
    }
    if (String(extensionVersion) !== session.requiredExtensionVersion) {
      throw httpFail(409, 'EXTENSION_VERSION_MISMATCH', `这次作业要求插件 v${session.requiredExtensionVersion}`);
    }
    session.jobStatus = 'claim_pending';
    session.attempt = 1;
    clearTimer(captureId);
    let record;
    try {
      record = await mutateData(document => {
        const rounds = seerfarWebRounds(document);
        const current = rounds[session.roundId];
        if (!current || current.captureId !== captureId) throw httpFail(409, 'STATE_CONFLICT', '这一轮不再等这次作业。');
        rounds[session.roundId] = claimSeerfarWebRound(current, now());
        return rounds[session.roundId];
      });
    } catch (error) {
      // A failed durable write may still have landed: never reopen this claim.
      session.jobStatus = 'unknown_outcome';
      sessions.delete(captureId);
      throw error;
    }
    session.jobStatus = 'claimed';
    session.claimedAt = Date.now();
    session.claimedExtensionVersion = String(extensionVersion);
    session.claimedExtensionOrigin = String(extensionOrigin || '');
    session.expiresAt = Date.now() + executionTtlMs;
    scheduleExpiry(session, 'claimed', executionTtlMs);
    return { captureJob: { captureId, jobId: captureId, roundId: record.roundId, mode: SEERFAR_WEB_ROUND_MODE, pageUrl: SEERFAR_WEB_SEARCH_PAGE,
      endpoint: SEERFAR_WEB_SEARCH_ENDPOINT, categoryPaths: [...record.request.categoryPaths], sellerType: record.request.sellerType,
      maxRecords: SEERFAR_WEB_PAGE_SIZE, waitMs: SEERFAR_WEB_CAPTURE_WAIT_MS, requiredExtensionVersion: session.requiredExtensionVersion,
      attempt: 1, token: session.token }, jobNotice: null };
  }

  async function estimatesFor(document, record, products, at) {
    const storeRule = estimateInputs.storeRule(document, record.targetStore);
    const fx = await estimateInputs.resolveExchangeRate(document, at);
    const { rows } = await estimateInputs.resolveFreightRows();
    const estimates = new Map();
    for (const product of products) {
      const estimateProduct = seerfarWebEstimateProduct(product);
      const commission = await estimateInputs.resolveCommission(estimateProduct, at);
      estimates.set(product.productId, estimateDiscoveredProduct({ product: estimateProduct, storeRule, fx, commission, tariffRows: rows,
        assumptions: estimateInputs.assumptions }));
    }
    return estimates;
  }

  async function acceptResult({ roundId, input, origin }) {
    const session = sessions.get(String(input?.captureId || ''));
    if (!session || session.roundId !== roundId) throw httpFail(409, 'SESSION_INVALID', 'Seerfar 作业会话不存在或已失效。');
    if (!session.claimedExtensionOrigin || session.claimedExtensionOrigin !== String(origin || '')) {
      throw httpFail(409, 'ORIGIN_MISMATCH', '回传来源与领取来源不一致。');
    }
    if (!sameToken(session.token, input.token)) throw httpFail(403, 'TOKEN_INVALID', 'Seerfar 作业令牌无效。');
    if (session.jobStatus !== 'claimed' || session.attempt !== 1) throw httpFail(409, 'NOT_CLAIMED', '这次作业还没有被插件领取，不能回传结果。');
    if (!['captured', 'failed'].includes(input.status)) throw httpFail(400, 'RESULT_INVALID', '回传状态无效。');
    // One result per claim, whatever happens next.
    session.jobStatus = 'reported';
    clearTimer(session.captureId);
    sessions.delete(session.captureId);
    if (input.status === 'failed') {
      const closed = await closeRound(roundId, session.captureId, typeof input.failureCode === 'string' ? input.failureCode : 'system_error');
      return closed ? seerfarWebRoundPublic(closed) : null;
    }
    const snapshot = await readData();
    const savedRecord = seerfarWebRounds(structuredClone(snapshot))[roundId];
    if (!savedRecord || savedRecord.status !== 'capturing' || savedRecord.captureId !== session.captureId) {
      throw httpFail(409, 'STATE_CONFLICT', '这一轮不再等这次结果。');
    }
    const result = normalizeSeerfarWebCapture(savedRecord, input.capture);
    if (result.error) {
      const closed = await closeRound(roundId, session.captureId, result.error);
      return closed ? seerfarWebRoundPublic(closed) : null;
    }
    const at = now();
    const estimates = await estimatesFor(snapshot, savedRecord, result.products, at);
    const completed = await mutateData(document => {
      const record = seerfarWebRounds(document)[roundId];
      if (!record || record.status !== 'capturing' || record.captureId !== session.captureId) throw httpFail(409, 'STATE_CONFLICT', '这一轮不再等这次结果。');
      const { source: _source, editedBy: _editedBy, editedAt: _editedAt, ...profile } = readStoreProfile(document, record.targetStore, { config });
      return completeSeerfarWebRound({ document, record, result, profile, knownProductIds: knownMarketProductIds(document.candidates), estimates, at,
        requestTemplate: input.requestTemplate, createCandidate: (product, entry) => {
          const id = `candidate:${randomUUID()}`;
          const candidate = createInitialCandidate({ input: { targetStore: record.targetStore, productName: product.title, productUrl: product.productUrl,
            // The provider's main image is display-only evidence for the 1688 image search; it is not a listing asset.
            imageUrl: typeof product.imageUrl === 'string' ? product.imageUrl : '' }, source: 'software', id, timestamp: at, storeBindings });
          candidate.targetPlatform = 'ozon';
          candidate.seerfarWebDiscoveryEvidence = seerfarWebCandidateEvidence({ record, product, entry, candidateRevision: candidate.dataRevision });
          candidate.history.push({ id: `history:${randomUUID()}`, actor: 'software', action: 'seerfar_web_discovery_imported', at,
            detail: `Seerfar 榜单（${record.query.routeLabel}：${record.query.reason}）这一轮第 ${entry.rank} 名，粗算最高能接受采购价 ${entry.ceilingRmb} 元；` +
              '只是待核验商品，还没有货源、没有确认供货，也没有正式利润。' });
          assertSafeBusinessMutationCandidate(candidate);
          document.candidates.unshift(candidate);
          return id;
        } });
    });
    return seerfarWebRoundPublic(completed);
  }

  /** Sessions die with the process; any round still waiting on one can never get a result. */
  async function reconcileAfterRestart() {
    return mutateDataWhenChanged(document => {
      const rounds = seerfarWebRounds(document);
      const closed = [];
      for (const [roundId, record] of Object.entries(rounds)) {
        if (sessions.has(record.captureId)) continue;
        const failed = failSeerfarWebRound(record, 'capture_job_lost', now());
        if (!failed) continue;
        rounds[roundId] = failed;
        closed.push(roundId);
      }
      return { changed: closed.length > 0, result: closed };
    });
  }

  return Object.freeze({ view, startRound, claim, acceptResult, reconcileAfterRestart, activeSession, owns: captureId => sessions.has(captureId) });
}
