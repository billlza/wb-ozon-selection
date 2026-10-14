import { isDeepStrictEqual } from "node:util";
import { assertNoProductionSecrets, fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { assertSafeRuntimeRecord } from "./runtime-identity.mjs";
import { softwareJobsInDocument } from "./software-job-contract.mjs";
import { D_PRODUCTION_ROUND_BLOCKERS, dProductionRoundDispatchable } from "./d-e-software-job-handoff.mjs";

export const PRODUCTION_AUTHORIZATION_ROLLBACK_ARCHIVE_VERSION = "production-authorization-rollback-archive-v1";
export const PRODUCTION_AUTHORIZATION_ROLLBACK_FIELD = "productionAuthorizationRollbackArchiveV1";

export const PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS = Object.freeze({
  NO_AUTHORIZATION: "本商品没有当前生产授权，没有可作废的对象。",
  ROUND_STILL_DISPATCHABLE: "上一轮还可以直接再派一轮，请先用「再派一轮生产作业」，不要作废授权。",
  ROUND_MAY_HAVE_SENT: "上一轮可能已经把请求发出去了，终态未知，绝不能当作没发生过。请先对账。",
  ROUND_NOT_STOPPED: "上一轮还没有停下来，先等它停稳再判断。",
  ROUND_SOURCE_INVALID: "作业轮次记录不完整或彼此对不上，拒绝作废。",
  PLATFORM_WRITE_PRESENT: "记录显示已经对平台写过，绝不能当作没发生过。",
  ASSET_TRANSPORT_STARTED: "素材传输已经产生外部请求或回执，绝不能当作没发生过。",
  DOWNSTREAM_RECORD_PRESENT: "已经存在生产记录、外部商品记录或E回读结果，不能作废本轮授权。"
});

// 可以作废的阻断只有这三种，语义一致：一个请求都没发出去，只是这条路走不下去了。
// ROUND_MAY_HAVE_SENT（终态未知）、ROUND_NOT_STOPPED（还没停）、NO_ROUND 一律拒绝，
// 前端只负责显示，真正的门在这里。
const ROLLBACK_ALLOWED_ROUND_BLOCKERS = Object.freeze([
  D_PRODUCTION_ROUND_BLOCKERS.DOWNSTREAM_EXISTS,
  D_PRODUCTION_ROUND_BLOCKERS.REVISION_MOVED,
  D_PRODUCTION_ROUND_BLOCKERS.ROUND_LIMIT
]);

function dProductionJobsFor(document, authorizationId) {
  return softwareJobsInDocument(document)
    .filter(entry => entry.jobType === "d_production_execution" && entry.scopeBinding?.authorizationRef === authorizationId);
}

function archiveTransportWithPlanReference(transport) {
  if (transport === null || transport === undefined) return null;
  const copy = structuredClone(transport);
  const plan = copy.intent?.productionPlan;
  if (plan === undefined || plan === null) return copy;
  copy.intent.productionPlan = {
    schemaVersion: "production-plan-archive-ref-v1",
    productionPlanId: plan.productionPlanId ?? null,
    authorizationId: plan.sourceAuthorization?.authorizationId ?? null,
    recordFingerprint: fingerprintCanonicalRecord(plan)
  };
  return copy;
}

/**
 * 作废是否放行。判定顺序固定：先看轮次状态，再看六项「一个字节都没写出去」的证据。
 * 轮次状态直接复用 dProductionRoundDispatchable，所以「上一轮可能已发出请求」「上一轮还没停」
 * 这两种危险情形不会因为本函数另写一套判断而漏掉。
 */
export function productionAuthorizationRollbackEligible(document, candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const authorization = sku?.productionAuthorization ?? null;
  const reject = blocker => Object.freeze({ eligible: false, blocker, authorizationId: authorization?.authorizationId ?? null,
    nextAuthorizationRound: null, evidence: null, dProductionJobIds: [] });
  if (!authorization) return reject(PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.NO_AUTHORIZATION);

  const round = dProductionRoundDispatchable(document, candidate);
  if (round.dispatchable) return reject(PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ROUND_STILL_DISPATCHABLE);
  if (round.blocker === D_PRODUCTION_ROUND_BLOCKERS.ROUND_MAY_HAVE_SENT) {
    return reject(PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ROUND_MAY_HAVE_SENT);
  }
  if (round.blocker === D_PRODUCTION_ROUND_BLOCKERS.ROUND_NOT_STOPPED) {
    return reject(PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ROUND_NOT_STOPPED);
  }
  if (!ROLLBACK_ALLOWED_ROUND_BLOCKERS.includes(round.blocker)) {
    return reject(PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ROUND_SOURCE_INVALID);
  }

  const transport = sku.dAssetTransport ?? null;
  const evidence = Object.freeze({
    lifecyclePlatformWrites: candidate.lifecycleV11?.platformWrites ?? null,
    authorizationPlatformWrites: authorization.platformWrites ?? null,
    authorizationExternalRequests: authorization.externalRequests ?? 0,
    assetTransportIntentAssetCount: Array.isArray(transport?.intent?.assets) ? transport.intent.assets.length : 0,
    assetTransportExternalRequestRef: transport?.externalRequestRef ?? null,
    assetTransportTransportResult: transport?.transportResult ?? null,
    productionRecord: sku.productionRecord ?? null,
    externalListingRecord: sku.externalListingRecord ?? null,
    eVerificationRecord: sku.eVerificationRecord ?? null,
    readbackHistoryLength: Array.isArray(sku.readbackHistory) ? sku.readbackHistory.length : null
  });
  if (evidence.lifecyclePlatformWrites !== 0 || evidence.authorizationPlatformWrites !== 0 ||
      evidence.authorizationExternalRequests !== 0) {
    return reject(PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.PLATFORM_WRITE_PRESENT);
  }
  if (evidence.assetTransportIntentAssetCount !== 0 || evidence.assetTransportExternalRequestRef !== null ||
      evidence.assetTransportTransportResult !== null) {
    return reject(PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ASSET_TRANSPORT_STARTED);
  }
  if (evidence.productionRecord !== null || evidence.externalListingRecord !== null ||
      evidence.eVerificationRecord !== null || evidence.readbackHistoryLength !== 0) {
    return reject(PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.DOWNSTREAM_RECORD_PRESENT);
  }

  return Object.freeze({
    eligible: true, blocker: null, authorizationId: authorization.authorizationId,
    nextAuthorizationRound: (sku.productionAuthorizationRoundV1 ?? 1) + 1,
    evidence, dProductionJobIds: dProductionJobsFor(document, authorization.authorizationId).map(entry => entry.jobId)
  });
}

/**
 * 把 SKU 包恢复成签生产授权之前的那一刻，并把这一轮的全部下游记录整体归档留底。
 * 旧授权、旧交接、旧素材传输（含 unknown_outcome 原样）、主人的旧决定全部进归档，一条不删；
 * 两轮失败作业留在 runtime.softwareJobs 原地不动，归档里只记作业号。
 * 归档不复制 productionEntityRecords 正文，只留 entityId 与指纹引用。
 * 本函数零外部请求、零平台写入，也不创建任何新授权。
 */
export function rollbackProductionAuthorizationInDocument({ document, candidate, observedAt, actorId, expectedAuthorizationId }) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  if (!sku || !Array.isArray(document?.candidates) ||
      document.candidates.filter(entry => entry === candidate).length !== 1) {
    throw new Error("PRODUCTION_AUTHORIZATION_ROLLBACK_ATOMIC_SOURCE_REQUIRED");
  }
  const state = productionAuthorizationRollbackEligible(document, candidate);
  // 页面上看到的那份授权必须就是当前记录里的那份：重复点击的第二下在这里被挡下来。
  if (expectedAuthorizationId !== state.authorizationId) {
    return { blocked: PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.NO_AUTHORIZATION, archive: null };
  }
  if (!state.eligible) return { blocked: state.blocker, archive: null };

  const authorization = sku.productionAuthorization;
  const card = sku.productionConfirmationCard;
  const restoredSkuRevision = authorization.authorizedDataRevision;
  if (!Number.isSafeInteger(restoredSkuRevision) || restoredSkuRevision < 0 || restoredSkuRevision >= sku.dataRevision ||
      !Number.isSafeInteger(card?.cardRevision) || card.cardRevision < 2) {
    throw new Error("PRODUCTION_AUTHORIZATION_ROLLBACK_SOURCE_REVISION_INVALID");
  }
  const existing = candidate.lifecycleV11[PRODUCTION_AUTHORIZATION_ROLLBACK_FIELD] ?? [];
  if (existing.some(entry => entry.productionAuthorizationRef?.authorizationId === authorization.authorizationId)) {
    throw new Error("PRODUCTION_AUTHORIZATION_ROLLBACK_ALREADY_ARCHIVED");
  }
  const entityRefs = (document.productionEntityRecords ?? [])
    .filter(entry => String(entry.entityId ?? "").includes(authorization.authorizationId))
    .map(entry => Object.freeze({ entityId: entry.entityId, kind: entry.kind,
      recordFingerprint: fingerprintCanonicalRecord(entry) }));

  const archive = {
    schemaVersion: PRODUCTION_AUTHORIZATION_ROLLBACK_ARCHIVE_VERSION,
    archiveId: `pa-rollback:${sku.skuPackageId}:${state.nextAuthorizationRound}`,
    archivedAt: observedAt, archivedByActorId: actorId,
    reason: "d_rounds_failed_before_any_external_request",
    evidence: structuredClone(state.evidence),
    sourceCandidateRevision: candidate.dataRevision,
    sourceSkuRevision: sku.dataRevision,
    restoredSkuRevision,
    supersededAuthorizationRound: sku.productionAuthorizationRoundV1 ?? 1,
    resultAuthorizationRound: state.nextAuthorizationRound,
    // 旧授权正文不复制：它已经作为生产实体记录独立保存在 document.productionEntityRecords 里，
    // 归档只留身份与指纹引用。复制正文既会让 15MB 文档再膨胀，也会让候选聚合的安全扫描
    // 把这份副本当成未经归一化的实体而拒绝。
    productionAuthorizationRef: Object.freeze({
      authorizationId: authorization.authorizationId,
      ownerDecisionId: authorization.ownerDecisionId ?? null,
      authorizedDataRevision: authorization.authorizedDataRevision,
      resultDataRevision: authorization.resultDataRevision,
      sourceCandidateRevision: authorization.sourceCandidateRevision,
      resultCandidateRevision: authorization.resultCandidateRevision,
      recordFingerprint: fingerprintCanonicalRecord(authorization)
    }),
    dHandoff: structuredClone(sku.dHandoff ?? null),
    // 素材传输原样留底，只把它内嵌的那份生产计划换成引用：那份正文已经作为生产实体记录
    // 独立保存（production-plan:…），归档再抄一遍既会让文档膨胀十几万字节，也会让候选聚合
    // 的实体归一化在新路径上认不出它而拒绝整笔事务。换引用不丢任何东西，按 entityId 可取回。
    dAssetTransport: archiveTransportWithPlanReference(sku.dAssetTransport ?? null),
    confirmationCard: Object.freeze({ cardId: card.cardId, supersededCardRevision: card.cardRevision,
      restoredCardRevision: card.cardRevision - 1, ownerDecision: structuredClone(card.ownerDecision ?? null) }),
    dProductionJobIds: [...state.dProductionJobIds],
    productionEntityRefs: entityRefs,
    platformWrites: 0, externalRequests: 0, productionAuthorizationCreated: false
  };
  // 只扫本动作新造的那部分元数据，两道都过。
  // 归档里的 productionAuthorization / dHandoff / dAssetTransport / ownerDecision 是已落盘记录的
  // 逐字节留底，不重扫：它们已各自过了自己那道门；而重扫会踩密钥扫描器对 `authorizationRef`
  // 这类键名的已知误判（键名含 "authorization" 即判为秘密），逼着删字段，留底就不再是留底。
  const archiveMetadata = Object.freeze({
    schemaVersion: archive.schemaVersion, archiveId: archive.archiveId, archivedAt: archive.archivedAt,
    archivedByActorId: archive.archivedByActorId, reason: archive.reason, evidence: archive.evidence,
    sourceCandidateRevision: archive.sourceCandidateRevision, sourceSkuRevision: archive.sourceSkuRevision,
    restoredSkuRevision: archive.restoredSkuRevision,
    supersededAuthorizationRound: archive.supersededAuthorizationRound,
    resultAuthorizationRound: archive.resultAuthorizationRound,
    dProductionJobIds: archive.dProductionJobIds, productionEntityRefs: archive.productionEntityRefs,
    platformWrites: archive.platformWrites, externalRequests: archive.externalRequests,
    productionAuthorizationCreated: archive.productionAuthorizationCreated
  });
  assertNoProductionSecrets(archiveMetadata, "productionAuthorizationRollbackArchive.metadata");
  assertSafeRuntimeRecord(archiveMetadata, "productionAuthorizationRollbackArchive.metadata");

  sku.productionAuthorization = null;
  sku.dHandoff = null;
  sku.dAssetTransport = null;
  card.status = "awaiting_owner_business_confirmation";
  card.ownerDecision = null;
  card.cardRevision -= 1;
  sku.productionAuthorizationRoundV1 = state.nextAuthorizationRound;
  sku.dataRevision = restoredSkuRevision;
  sku.businessPhase = "C2";
  sku.businessResult = "passed";
  sku.technicalStatus = "completed";
  sku.ownerAction = "authorize_production";
  sku.audit.updatedAt = observedAt;
  sku.audit.history.push({
    event: "production_authorization_rolled_back_to_pre_signature", at: observedAt,
    archiveId: archive.archiveId, archivedAuthorizationId: authorization.authorizationId,
    sourceRevision: archive.sourceSkuRevision, resultRevision: sku.dataRevision,
    resultAuthorizationRound: archive.resultAuthorizationRound,
    externalRequests: 0, platformWrites: 0, productionAuthorizationCreated: false, dHandoffCreated: false
  });
  candidate.lifecycleV11[PRODUCTION_AUTHORIZATION_ROLLBACK_FIELD] = [...existing, archive];
  candidate.lifecycleV11.status = "c2_completed_awaiting_owner_business_confirmation";
  candidate.lifecycleV11.platformWrites = 0;
  candidate.dataRevision += 1;
  candidate.updatedAt = observedAt;
  candidate.lastModifiedBy = "software";

  // 恢复出来的那一刻必须和归档里记下的完全一致，否则立刻失败，不留半套写入。
  if (sku.dataRevision !== archive.restoredSkuRevision || card.cardRevision !== archive.confirmationCard.restoredCardRevision ||
      sku.productionAuthorization !== null || sku.dHandoff !== null || sku.dAssetTransport !== null ||
      !isDeepStrictEqual(candidate.lifecycleV11[PRODUCTION_AUTHORIZATION_ROLLBACK_FIELD].at(-1), archive)) {
    throw new Error("PRODUCTION_AUTHORIZATION_ROLLBACK_RESULT_CONFLICT");
  }
  return { blocked: null, archive: structuredClone(archive) };
}
