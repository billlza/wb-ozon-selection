import { C1_FACT_DEFINITIONS_VERSION } from "./c1-ai-draft-contract.mjs";
import { assertC1SupplierFactRevisionProjection, ConfirmedSupplierInputError } from "./confirmed-supplier-inputs.mjs";
import { createC1EditorialDraftReference, assertC1EditorialSource, assertC1EditorialPlan, assertC1EditorialSnapshot, C1EditorialSourceError } from "./c1-editorial-review-contract.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { isDeepStrictEqual } from "node:util";
import { assertC1PricingResultReuse, assertC1PricingReuseRecordSource, createC1PricingReuseReference, C1_PRICING_REUSE_REFERENCE_VERSION, C1PricingReuseError } from "./c1-pricing-result-reuse.mjs";
import { assertC1SiblingFormalReuse, createC1SiblingFormalReference, C1_SIBLING_FORMAL_REFERENCE_VERSION } from "./c1-sibling-formal-draft-reuse.mjs";
import { assertCurrentC1SkuRightsReview, C1SkuRightsReviewError } from "./c1-sku-rights-review.mjs";
import {
  assertValidLifecyclePackage,
  validateLifecycleTransition
} from "./product-lifecycle-schema.mjs";
import {
  C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED,
  C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
  PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
  appendC2DiagnosticPath,
  assertNoProductionSecrets,
  assertNoRawPersistenceKeys,
  assertCanonicalAnalysisAssetRef,
  assertCanonicalC1AuthorizationId,
  assertCanonicalFrozenRef,
  assertCanonicalStableHttpsAssetRef,
  assertFinalAssetLocation,
  isLocalFinalAssetRef,
  collectCanonicalC2ReferenceErrors,
  formatC2ReferenceDiagnostic,
  fingerprintCanonicalRecord,
  isCanonicalAnalysisAssetRef,
  isCanonicalC1AuthorizationId,
  isCanonicalStableHttpsAssetRef
} from "./production-contract-primitives.mjs";
import { assertValidC1ProductPlan, C1_CANONICAL_CONTRACT_VERSION, normalizeC1SourceIdentity as normalizeC2G1IdentityValue } from "./c1-product-plan.mjs";
import {
  PRODUCTION_AUTHORIZATION_FINAL_CARD_INPUT_SNAPSHOT_VERSION as C2_FINAL_CARD_INPUT_SNAPSHOT_VERSION,
  PRODUCTION_AUTHORIZATION_FINAL_MANIFEST_VERSION as C2_FINAL_MANIFEST_VERSION,
  PRODUCTION_AUTHORIZATION_PENDING_INPUTS_VERSION as C2_AUTHORIZATION_PENDING_INPUTS_VERSION,
  PRODUCTION_AUTHORIZATION_PREPARATION_VERSION as C2_AUTHORIZATION_PREPARATION_VERSION,
  createPendingProductionAuthorizationInputs,
  fingerprintAuthorizedMedia,
  fingerprintC1Snapshot,
  fingerprintFinalCardInputSnapshot,
  fingerprintFinalManifest,
  fingerprintFinalUploads,
  fingerprintProductionAuthorizationPreparation as fingerprintC2AuthorizationPreparation,
  validateProductionAuthorizationPreparation
} from "./production-authorization-preparation.mjs";

export const C2_ASSET_LIFECYCLE_VERSION = "c2-asset-lifecycle-v1.1";
export const COLLECTED_ASSET_PLATFORMS = Object.freeze(["ozon", "wb", "1688", "pinduoduo"]);
export const ASSET_MEDIA_TYPES = Object.freeze(["image", "video"]);
export const C2_SOFTWARE_STATE_VERSION = "c2-software-state-v1";
export const C2_TARGET_CONTEXT_VERSION = "c2-target-context-v1";
export const C2_UNKNOWN_MANIFEST_VERSION = "c1-unknown-manifest-v1";
export const C2_STABLE_ASSET_TRANSPORT_VERSION = "c2-stable-asset-transport-v1";
export const C2_STAGED_ASSET_MANIFEST_VERSION = "c2-staged-asset-manifest-v1";
export { C1_CANONICAL_CONTRACT_VERSION } from "./c1-product-plan.mjs";
export {
  C2_AUTHORIZATION_PENDING_INPUTS_VERSION,
  C2_AUTHORIZATION_PREPARATION_VERSION,
  C2_FINAL_CARD_INPUT_SNAPSHOT_VERSION,
  C2_FINAL_MANIFEST_VERSION,
  fingerprintC2AuthorizationPreparation
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isReservedStableAssetHost(host) {
  const normalized = String(host ?? "").trim().toLowerCase();
  if (!normalized) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized) || /^\[[0-9a-f:.]+\]$/i.test(normalized)) return true;
  return ["localhost", "local", "localdomain", "lan", "home", "internal"].some((suffix) =>
    normalized === suffix || normalized.endsWith(`.${suffix}`)
  );
}

function sha256(value) {
  return fingerprintCanonicalRecord(value);
}

export function fingerprintC2FinalManifest({
  authorizedMediaFingerprint,
  effectiveVideoRequirement,
  mainImageAssetId,
  videoDisposition,
  assets
}) {
  return fingerprintFinalManifest({
    authorizedMediaFingerprint,
    effectiveVideoRequirement,
    mainImageAssetId,
    videoDisposition,
    assets
  });
}

/**
 * 「主人授权的那批图」的唯一身份：按主人给的顺序取实际公网地址，第一张就是主图。
 * 授权之后任何一张地址被换掉、顺序被动过、多一张少一张，这个值都会变，
 * 所以从主人确认一直到 D 真正发出去的那一刻都用它对照。
 */
export function fingerprintC2AuthorizedMedia(assets) {
  return fingerprintAuthorizedMedia(assets);
}

function assertSha256(value, field) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ""))) {
    throw new Error(`C2_ASSET_INPUT_GAP: ${field}必须是SHA256`);
  }
}

function isOpaqueEvidenceRef(value) {
  try {
    assertCanonicalFrozenRef(value);
    return true;
  } catch {
    return false;
  }
}

function assertOpaqueEvidenceRef(value, field) {
  assertCanonicalFrozenRef(value, field);
}

const G1_REQUIRED_SENTINELS = new Set(["unknown", "null", "undefined", "not_applicable"]);

function normalizeC2G1Binding(skuPackage) {
  const identity = normalizeC2G1IdentityValue(skuPackage?.g1Identity);
  if (!nonEmptyString(skuPackage?.variantKey) || G1_REQUIRED_SENTINELS.has(skuPackage.variantKey.trim().toLowerCase())) {
    throw new Error("C2_G1_IDENTITY_REQUIRED: skuPackage.variantKey必须是已持久的非哨兵规格键");
  }
  assertNoProductionSecrets(skuPackage.variantKey, "skuPackage.variantKey");
  if (!nonEmptyString(skuPackage.parentOpportunityId) ||
      identity.skuPackageId !== skuPackage.skuPackageId ||
      identity.platform !== skuPackage.targetPlatform ||
      identity.storeRef.stableStoreId !== skuPackage.targetStore ||
      identity.supplierSkuId !== skuPackage.supplierSkuId) {
    throw new Error("C2_G1_IDENTITY_DRIFT: 已持久G1身份与SKU生命周期投影不一致");
  }
  return deepFreeze({ identity, variantKey: skuPackage.variantKey });
}

function canonicalDraftKeywordRefs(draft, path) {
  if (!isObject(draft) || draft.status !== "draft_only" || !nonEmptyString(draft.text) ||
      draft.productionApproved !== false || !Array.isArray(draft.factRefs) || draft.factRefs.length === 0 ||
      draft.factRefs.some((ref) => !nonEmptyString(ref)) ||
      !Array.isArray(draft.keywordEvidenceRefs) || draft.keywordEvidenceRefs.length === 0 ||
      draft.keywordEvidenceRefs.some((ref) => !nonEmptyString(ref)) ||
      new Set(draft.keywordEvidenceRefs).size !== draft.keywordEvidenceRefs.length) {
    throw new Error(`C2_C1_FORMAL_KEYWORDS_REQUIRED: ${path}必须逐段保留事实与正式关键词证据`);
  }
  return draft.keywordEvidenceRefs;
}

const C1_EDITORIAL_REFERENCE_VERSION = "c1-editorial-source-reference-v1";

function isEditorialDraftReference(draft) {
  return draft?.editorialSource?.schemaVersion === C1_EDITORIAL_REFERENCE_VERSION;
}

/** Canonical handoffs carry a projection; only the sibling C1 snapshot owns the full source. */
function editorialDraftMatchesSnapshot(draft, sourceDraft, identity, resultSkuRevision) {
  if (!isEditorialDraftReference(draft)) return sameJson(draft, sourceDraft);
  if (sourceDraft?.editorialSource?.schemaVersion !== "c1-editorial-source-v2") return false;
  try {
    return sameJson(draft, createC1EditorialDraftReference({ draftOnlySeo: sourceDraft, identity, resultSkuRevision }));
  } catch (error) {
    if (!(error instanceof C1EditorialSourceError) && !/^C1_AI_/.test(error.message)) throw error;
    return false;
  }
}

function pricingDraftMatchesSnapshot(draft, sourcePlan, identity, resultSkuRevision, targetProfitModelVersion) {
  const sourceDraft = sourcePlan?.draftOnlySeo;
  if (draft?.pricingReuseRecord?.schemaVersion !== C1_PRICING_REUSE_REFERENCE_VERSION) return sameJson(draft, sourceDraft);
  if (sourceDraft?.pricingReuseRecord?.schemaVersion !== "c1-pricing-result-reuse-v1") return false;
  try {
    const reference = createC1PricingReuseReference({ record: sourceDraft.pricingReuseRecord, identity,
      resultSkuRevision, targetPlanId: sourcePlan.c1PlanId, targetProfitModelVersion });
    return sameJson(draft, { ...sourceDraft, pricingReuseRecord: reference });
  } catch (error) {
    if (!(error instanceof C1PricingReuseError) && !(error instanceof C1SkuRightsReviewError) && !/^C1_AI_/.test(error.message)) throw error;
    return false;
  }
}

function canonicalDraftMatchesSnapshot(draft, sourcePlan, identity, resultSkuRevision, targetProfitModelVersion) {
  if (draft?.sourceType === 'sibling_shared_formal_provider') {
    const sourceDraft = sourcePlan?.draftOnlySeo;
    if (!['c1-sibling-formal-reuse-v1', 'c1-sibling-neutral-reuse-v2'].includes(
      sourceDraft?.siblingFormalReuseRecord?.schemaVersion)) return false;
    const record = sourceDraft.siblingFormalReuseRecord;
    return sameJson(draft, { ...sourceDraft, siblingFormalReuseRecord:
      createC1SiblingFormalReference({ record, identity, resultSkuRevision }) });
  }
  return draft?.sourceType === "owner_confirmed_editorial"
    ? editorialDraftMatchesSnapshot(draft, sourcePlan?.draftOnlySeo, identity, resultSkuRevision)
    : pricingDraftMatchesSnapshot(draft, sourcePlan, identity, resultSkuRevision, targetProfitModelVersion);
}

export function normalizeC1CanonicalHandoffContract(skuPackage) {
  const plan = skuPackage?.c1ProductPlan;
  assertValidC1ProductPlan(plan);
  const g1 = normalizeC2G1Binding(skuPackage);
  const canonicalContract = {
    draftOnlySeo: plan.draftOnlySeo,
    keywordEvidenceRefs: plan.keywordEvidenceRefs,
    revisionRefs: plan.revisionRefs,
    frozenInputRefs: plan.frozenInputRefs,
    unknownManifest: plan.unknownManifest
  };
  assertNoRawPersistenceKeys(canonicalContract, "c1CanonicalContract");
  assertNoProductionSecrets({ frozenC1Handoff: canonicalContract }, "c1CanonicalContract");
  if (plan.contractVersion !== C1_CANONICAL_CONTRACT_VERSION) {
    throw new Error(`C2_C1_CANONICAL_GATE_BLOCKED: C1必须使用${C1_CANONICAL_CONTRACT_VERSION}`);
  }
  const expectedC1Revision = skuPackage.c2FinalAssets?.softwareState?.sourceDataRevision ?? skuPackage.dataRevision;
  const revisionRefs = plan.revisionRefs;
  if (!isObject(revisionRefs) || !Number.isInteger(revisionRefs.sourceRevision) ||
      revisionRefs.resultRevision !== revisionRefs.sourceRevision + 1 || revisionRefs.resultRevision > expectedC1Revision) {
    throw new Error("C2_C1_CANONICAL_GATE_BLOCKED: C1 revisionRefs无效或超出当前冻结revision");
  }
  const frozen = plan.frozenInputRefs;
  if (frozen?.candidateId !== g1.identity.candidateId) throw new Error("C2_G1_IDENTITY_DRIFT: C1候选引用与已持久G1候选身份不一致");
  if (!isObject(plan.identity) || plan.identity.parentOpportunityId !== skuPackage.parentOpportunityId ||
      plan.identity.skuPackageId !== g1.identity.skuPackageId ||
      plan.identity.supplierSkuId !== g1.identity.supplierSkuId ||
      plan.identity.variantKey !== g1.variantKey || plan.identity.targetPlatform !== g1.identity.platform ||
      plan.identity.targetStore !== g1.identity.storeRef.stableStoreId) {
    throw new Error("C2_G1_IDENTITY_DRIFT: C1身份与已持久G1身份或唯一variantKey不一致");
  }
  if (!isObject(frozen) || frozen.candidateId !== g1.identity.candidateId ||
      frozen.skuPackageId !== g1.identity.skuPackageId || frozen.platform !== g1.identity.platform ||
      frozen.storeRef !== g1.identity.storeRef.stableStoreId || frozen.sourceRevision !== revisionRefs.sourceRevision ||
      frozen.salesSnapshotId !== plan.inputRefs.salesSnapshotId ||
      frozen.selectedSupplySnapshotId !== plan.inputRefs.selectedSupplySnapshotId ||
      frozen.profitModelVersion !== plan.inputRefs.profitModelVersion ||
      frozen.schemaSnapshotRef !== plan.inputRefs.platformSchemaEvidenceId ||
      plan.schemaSnapshotRef !== plan.inputRefs.platformSchemaEvidenceId ||
      !nonEmptyString(frozen.ownerSupplyConfirmationRef)) {
    throw new Error("C2_C1_CANONICAL_GATE_BLOCKED: C1顶层冻结引用与当前SKU或输入证据不一致");
  }
  for (const field of [
    "candidateId", "skuPackageId", "platform", "storeRef", "salesSnapshotId",
    "selectedSupplySnapshotId", "ownerSupplyConfirmationRef", "profitModelVersion", "schemaSnapshotRef"
  ]) {
    assertCanonicalFrozenRef(frozen[field], `frozenInputRefs.${field}`);
  }
  const draft = plan.draftOnlySeo;
  if (draft?.sourceType === "owner_confirmed_editorial") {
    assertC1EditorialPlan({ plan, identity: g1.identity, resultSkuRevision: expectedC1Revision });
  } else if (draft?.sourceType === 'sibling_shared_formal_provider') {
    assertC1SiblingFormalReuse({ plan, resultSkuRevision: expectedC1Revision });
  } else {
    const job = draft?.providerJobRef;
    const pricingReuse = draft?.pricingReuseRecord === undefined ? null : assertC1PricingResultReuse({ plan, resultSkuRevision: expectedC1Revision });
    const allowedDraftKeys = new Set([
      "status", "formalProviderResultAccepted", "reason", "aiRequestId", "aiRequestFingerprint",
      "inputFingerprint", "sourceRevision", "receiptRef", "providerJobRef", "pricingReuseRecord"
    ]);
    if (!isObject(draft) || draft.status !== "draft_only" || draft.formalProviderResultAccepted !== true ||
        Object.keys(draft).some((key) => !allowedDraftKeys.has(key)) || draft.reason !== null || !isObject(job)) {
      throw new Error("C2_C1_FORMAL_PROVIDER_REQUIRED: draft_only草稿必须已接受正式provider作业结果");
    }
    assertOpaqueEvidenceRef(draft.aiRequestId, "draftOnlySeo.aiRequestId");
    assertOpaqueEvidenceRef(draft.receiptRef, "draftOnlySeo.receiptRef");
    if (!/^[a-f0-9]{64}$/.test(String(draft.aiRequestFingerprint || ""))) {
      throw new Error("C2_C1_FORMAL_PROVIDER_REQUIRED: draftOnlySeo.aiRequestFingerprint必须是SHA-256");
    }
    const allowedJobKeys = new Set([
      "jobId", "jobType", "providerId", "providerVersion", "candidateId", "skuPackageId", "platform",
      "storeRef", "authorizationRef", "inputFingerprint", "sourceRevision", "receiptRef", "terminalStatus",
      "requestSubmitted", "responseVerified"
    ]);
    if (Object.keys(job).some((key) => !allowedJobKeys.has(key)) || job.jobType !== "c1_ai_draft" ||
        !nonEmptyString(job.jobId) || !nonEmptyString(job.providerId) || job.providerId === "unknown" ||
        !nonEmptyString(job.providerVersion) || job.providerVersion === "unknown" ||
        job.candidateId !== g1.identity.candidateId || job.skuPackageId !== g1.identity.skuPackageId ||
        job.platform !== g1.identity.platform || job.storeRef !== g1.identity.storeRef.stableStoreId ||
        !/^[a-f0-9]{64}$/.test(String(job.inputFingerprint || "")) ||
        (pricingReuse === null && (job.sourceRevision !== expectedC1Revision - 1 || job.sourceRevision < revisionRefs.resultRevision)) ||
        job.terminalStatus !== "completed" ||
        job.requestSubmitted !== true || job.responseVerified !== true) {
      throw new Error("C2_C1_FORMAL_PROVIDER_REQUIRED: 正式provider作业身份、revision、终态或回执状态无效");
    }
    for (const field of ["providerId", "providerVersion", "candidateId", "skuPackageId", "platform", "storeRef"]) {
      assertCanonicalFrozenRef(job[field], `draftOnlySeo.providerJobRef.${field}`);
    }
    assertOpaqueEvidenceRef(job.receiptRef, "draftOnlySeo.providerJobRef.receiptRef");
    const authorization = job.authorizationRef;
    const authorizationKeys = new Set(["authorizationId", "authorizationType", "scope"]);
    const authorizationScopeKeys = new Set(["candidateId", "skuPackageId", "platform", "storeRef", "sourceRevision", "jobType"]);
    if (!isObject(authorization) || Object.keys(authorization).some((key) => !authorizationKeys.has(key)) ||
        !nonEmptyString(authorization.authorizationId) ||
        authorization.authorizationType !== "paid_ai_draft" || !isObject(authorization.scope) ||
        Object.keys(authorization.scope).some((key) => !authorizationScopeKeys.has(key)) ||
        authorization.scope.candidateId !== job.candidateId || authorization.scope.skuPackageId !== job.skuPackageId ||
        authorization.scope.platform !== job.platform || authorization.scope.storeRef !== job.storeRef ||
        authorization.scope.sourceRevision !== job.sourceRevision || authorization.scope.jobType !== job.jobType) {
      throw new Error("C2_C1_FORMAL_PROVIDER_REQUIRED: 正式provider作业缺少完整付费授权作用域");
    }
    for (const field of ["candidateId", "skuPackageId", "platform", "storeRef"]) {
      assertCanonicalFrozenRef(authorization.scope[field], `draftOnlySeo.providerJobRef.authorizationRef.scope.${field}`);
    }
    assertCanonicalC1AuthorizationId(
      authorization.authorizationId,
      "draftOnlySeo.providerJobRef.authorizationRef.authorizationId"
    );
    if (!isObject(plan.seoEvidenceLayer) || !sameJson(plan.seoEvidenceLayer.providerJobRef, job)) {
      throw new Error("C2_C1_FORMAL_PROVIDER_REQUIRED: SEO证据层必须锁定同一正式provider作业引用");
    }
    if (draft.inputFingerprint !== job.inputFingerprint || draft.sourceRevision !== job.sourceRevision ||
        plan.seoEvidenceLayer.inputFingerprint !== job.inputFingerprint ||
        plan.seoEvidenceLayer.sourceRevision !== job.sourceRevision ||
        plan.seoEvidenceLayer.aiRequestId !== draft.aiRequestId ||
        plan.seoEvidenceLayer.aiRequestFingerprint !== draft.aiRequestFingerprint ||
        plan.seoEvidenceLayer.aiReceiptId !== draft.receiptRef) {
      throw new Error("C2_C1_FORMAL_PROVIDER_REQUIRED: 草稿、SEO证据层与正式provider作业输入或revision不一致");
    }
  }
  if (!Array.isArray(plan.keywordEvidenceRefs) || plan.keywordEvidenceRefs.length === 0 ||
      plan.keywordEvidenceRefs.some((ref) => !nonEmptyString(ref)) ||
      new Set(plan.keywordEvidenceRefs).size !== plan.keywordEvidenceRefs.length) {
    throw new Error("C2_C1_FORMAL_KEYWORDS_REQUIRED: 必须提供去重后的正式keywordEvidenceRefs");
  }
  plan.keywordEvidenceRefs.forEach((ref, index) => assertOpaqueEvidenceRef(ref, `keywordEvidenceRefs[${index}]`));
  if (!Array.isArray(plan.bulletPointsDraft) || (plan.bulletPointsDraft.length === 0 && plan.seoEvidenceLayer?.factDefinitionsVersion !== C1_FACT_DEFINITIONS_VERSION) ||
      !isObject(plan.searchKeywordsDraft) || plan.searchKeywordsDraft.status !== "draft_only" ||
      plan.searchKeywordsDraft.productionApproved !== false || !Array.isArray(plan.searchKeywordsDraft.keywords) ||
      plan.searchKeywordsDraft.keywords.length === 0) {
    throw new Error("C2_C1_FORMAL_KEYWORDS_REQUIRED: SEO各段与搜索词必须保持draft_only并有正式证据");
  }
  const searchKeywordRefs = plan.searchKeywordsDraft.keywords.flatMap((item, index) => {
    if (!isObject(item) || !nonEmptyString(item.query) || !Array.isArray(item.factRefs) || item.factRefs.length === 0 ||
        item.factRefs.some((ref) => !nonEmptyString(ref)) || !Array.isArray(item.evidenceRefs) ||
        item.evidenceRefs.length === 0 || item.evidenceRefs.some((ref) => !nonEmptyString(ref))) {
      throw new Error(`C2_C1_FORMAL_KEYWORDS_REQUIRED: searchKeywordsDraft.keywords[${index}]缺少事实或正式关键词证据`);
    }
    return item.evidenceRefs;
  });
  const adoptedKeywordRefs = [
    ...canonicalDraftKeywordRefs(plan.seoTitleDraft, "seoTitleDraft"),
    ...canonicalDraftKeywordRefs(plan.descriptionDraft, "descriptionDraft"),
    ...plan.bulletPointsDraft.flatMap((item, index) => canonicalDraftKeywordRefs(item, `bulletPointsDraft[${index}]`)),
    ...searchKeywordRefs
  ];
  if (adoptedKeywordRefs.length === 0 || adoptedKeywordRefs.some((ref) => !plan.keywordEvidenceRefs.includes(ref))) {
    throw new Error("C2_C1_FORMAL_KEYWORDS_REQUIRED: 顶层正式关键词引用必须覆盖全部已采用SEO草稿关键词证据");
  }
  // 槽位合同已废止：C1 不再交出任何媒体摘要，这里也不再要求它。
  // 哪些图上架、按什么顺序，全部由主人在 C2 逐张确认（见 confirmFinalUploads）。
  // 更早写下的记录里那个 mediaRequirements: null 的空壳没有任何槽位主张，放行；非 null 一律拒收。
  if (Object.hasOwn(plan, "mediaRequirements") && plan.mediaRequirements !== null) {
    throw new Error("C2_C1_CANONICAL_GATE_BLOCKED: 槽位合同已废止，C1不得再交出平台媒体槽位摘要");
  }
  if (!Array.isArray(plan.unknownManifest)) {
    throw new Error("C2_C1_CANONICAL_GATE_BLOCKED: 顶层unknownManifest必须是数组");
  }
  for (const [index, entry] of plan.unknownManifest.entries()) {
    const allowedUnknownKeys = new Set(["fieldPath", "reason", "sourceRefs", "blockingScope", "blocksC2Handoff"]);
    if (!isObject(entry) || Object.keys(entry).some((key) => !allowedUnknownKeys.has(key)) ||
        !nonEmptyString(entry.fieldPath) || !nonEmptyString(entry.reason) ||
        !Array.isArray(entry.sourceRefs) || entry.sourceRefs.length === 0 ||
        entry.sourceRefs.some((ref) => !nonEmptyString(ref)) ||
        new Set(entry.sourceRefs).size !== entry.sourceRefs.length ||
        !["informational", "required_field", "compliance"].includes(entry.blockingScope) ||
        entry.blocksC2Handoff !== ["required_field", "compliance"].includes(entry.blockingScope)) {
      throw new Error(`C2_C1_CANONICAL_GATE_BLOCKED: unknownManifest[${index}]无效`);
    }
    entry.sourceRefs.forEach((ref, refIndex) => assertOpaqueEvidenceRef(ref, `unknownManifest[${index}].sourceRefs[${refIndex}]`));
    if (entry.blocksC2Handoff === true) {
      throw new Error(`C2_REQUIRED_UNKNOWN_BLOCKING: ${entry.fieldPath}仍是C1→C2阻断unknown`);
    }
  }
  return deepFreeze({
    contractVersion: plan.contractVersion,
    identity: structuredClone(g1.identity),
    frozenInputRevisionRefs: structuredClone(revisionRefs),
    handoffRevisionRefs: { sourceRevision: expectedC1Revision, resultRevision: expectedC1Revision + 1 },
    frozenInputRefs: structuredClone(frozen),
    schemaSnapshotRef: plan.schemaSnapshotRef,
    // Previously completed full v2 handoffs retain their exact historical shape.
    // New handoffs share the complete source kept in finalCardInputSnapshot.c1Snapshot.
    draftOnlySeo: ['c1-sibling-formal-reuse-v1', 'c1-sibling-neutral-reuse-v2'].includes(
      draft?.siblingFormalReuseRecord?.schemaVersion)
      ? { ...structuredClone(draft), siblingFormalReuseRecord: createC1SiblingFormalReference({
        record: draft.siblingFormalReuseRecord, identity: g1.identity, resultSkuRevision: expectedC1Revision }) }
      : draft?.pricingReuseRecord?.schemaVersion === "c1-pricing-result-reuse-v1" &&
      !(skuPackage.c2FinalAssets?.status === "completed" &&
        skuPackage.c2FinalAssets.productionAuthorizationPreparation?.frozenC1Handoff?.draftOnlySeo?.pricingReuseRecord?.schemaVersion === "c1-pricing-result-reuse-v1")
      ? { ...structuredClone(draft), pricingReuseRecord: createC1PricingReuseReference({ record: draft.pricingReuseRecord,
        identity: g1.identity, resultSkuRevision: expectedC1Revision, targetPlanId: plan.c1PlanId,
        targetProfitModelVersion: plan.inputRefs.profitModelVersion }) }
      : draft?.editorialSource?.schemaVersion === "c1-editorial-source-v2" &&
      !(skuPackage.c2FinalAssets?.status === "completed" &&
        skuPackage.c2FinalAssets.productionAuthorizationPreparation?.frozenC1Handoff?.draftOnlySeo?.editorialSource?.schemaVersion === "c1-editorial-source-v2")
      ? createC1EditorialDraftReference({ draftOnlySeo: draft, identity: g1.identity, resultSkuRevision: expectedC1Revision })
      : structuredClone(draft),
    keywordEvidenceRefs: structuredClone(plan.keywordEvidenceRefs),
    unknownManifest: []
  });
}

/**
 * C2 的目标绑定：平台、店铺、冻结 Schema 修订与证据。全部取自 Ozon 证据服务真实返回的字段
 * （evidenceId / platform / store / storeRef / schemaRevision），不再经过那份从没人赋过值的
 * platformSchemaRules.mediaRequirements。槽位、内容规则、视频槽位一律不存在。
 */
export function normalizeC2TargetContract(skuPackage) {
  const plan = skuPackage?.c1ProductPlan;
  assertValidC1ProductPlan(plan);
  const canonicalC1 = normalizeC1CanonicalHandoffContract(skuPackage);
  const g1Identity = canonicalC1.identity;
  const schemaRules = plan.inputSnapshots?.platformSchemaRules;
  if (!isObject(schemaRules)) {
    throw new Error("C2_TARGET_CONTEXT_INVALID: 缺少冻结平台Schema证据");
  }
  if (Object.hasOwn(schemaRules, "mediaRequirements") && schemaRules.mediaRequirements !== null) {
    throw new Error("C2_TARGET_CONTEXT_INVALID: 槽位合同已废止，冻结Schema不得再携带媒体槽位");
  }
  const expectedEvidenceRef = plan.inputRefs?.platformSchemaEvidenceId;
  const confirmedSchemaRevision = plan.schemaSnapshot?.schemaRevision;
  for (const [field, value] of Object.entries({
    evidenceId: schemaRules.evidenceId,
    platform: schemaRules.platform,
    store: schemaRules.store,
    schemaRevision: schemaRules.schemaRevision
  })) {
    if (!nonEmptyString(value)) throw new Error(`C2_TARGET_CONTEXT_INVALID: platformSchemaRules.${field}必须是非空字符串`);
  }
  const expectedSourceDataRevision = skuPackage.c2FinalAssets?.softwareState?.sourceDataRevision ?? skuPackage.dataRevision;
  if (schemaRules.platform !== g1Identity.platform || schemaRules.platform !== skuPackage.targetPlatform ||
      schemaRules.platform !== plan.identity.targetPlatform ||
      schemaRules.store !== g1Identity.storeRef.stableStoreId ||
      schemaRules.store !== skuPackage.targetStore || schemaRules.store !== plan.identity.targetStore ||
      !sameStoreRef(schemaRules.storeRef, g1Identity.storeRef) ||
      schemaRules.evidenceId !== expectedEvidenceRef || schemaRules.evidenceId !== canonicalC1.schemaSnapshotRef ||
      confirmedSchemaRevision?.verificationStatus !== "confirmed" ||
      confirmedSchemaRevision.value !== schemaRules.schemaRevision) {
    throw new Error("C2_TARGET_CONTEXT_INVALID: platform/storeRef/Schema修订或证据与当前C1不一致");
  }
  const targetContext = {
    schemaVersion: C2_TARGET_CONTEXT_VERSION,
    platform: schemaRules.platform,
    targetStore: schemaRules.store,
    storeRef: g1Identity.storeRef.stableStoreId,
    schemaRevision: schemaRules.schemaRevision,
    schemaEvidenceRef: schemaRules.evidenceId,
    sourceDataRevision: expectedSourceDataRevision,
    sourceC1Fingerprint: fingerprintC2SourceC1(skuPackage)
  };
  return deepFreeze({
    targetContext,
    unknownManifest: {
      schemaVersion: C2_UNKNOWN_MANIFEST_VERSION,
      sourceDataRevision: expectedSourceDataRevision,
      blockingItems: []
    },
    canonicalC1,
    g1Identity: structuredClone(g1Identity),
    variantKey: skuPackage.variantKey
  });
}

function bindC2TargetContractToSourceRevision(targetContract, sourceDataRevision) {
  if (!Number.isInteger(sourceDataRevision)) {
    throw new Error("C2_TARGET_CONTEXT_INVALID: 最终确认sourceRevision必须是整数");
  }
  return deepFreeze({
    ...structuredClone(targetContract),
    targetContext: { ...structuredClone(targetContract.targetContext), sourceDataRevision }
  });
}

export function normalizeC2OwnerVideoRequirement(ownerVideoRequirement, skuPackage) {
  if (ownerVideoRequirement === null || ownerVideoRequirement === undefined) return null;
  assertNoRawPersistenceKeys(ownerVideoRequirement, "ownerVideoRequirement");
  try {
    assertNoProductionSecrets(ownerVideoRequirement, "ownerVideoRequirement");
  } catch (error) {
    if (String(error?.message || "").startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:")) {
      throw new Error("C2_SENSITIVE_INPUT_REJECTED: ownerVideoRequirement不得包含秘密");
    }
    throw error;
  }
  const allowedKeys = new Set([
    "schemaVersion", "required", "confirmedBy", "skuPackageId", "sourceDataRevision", "evidenceRef"
  ]);
  if (!isObject(ownerVideoRequirement) || Object.keys(ownerVideoRequirement).some((key) => !allowedKeys.has(key)) ||
      ownerVideoRequirement.schemaVersion !== "c2-owner-video-requirement-v1" ||
      ownerVideoRequirement.required !== true || ownerVideoRequirement.confirmedBy !== "owner" ||
      ownerVideoRequirement.skuPackageId !== skuPackage.skuPackageId ||
      ownerVideoRequirement.sourceDataRevision !== skuPackage.dataRevision ||
      !nonEmptyString(ownerVideoRequirement.evidenceRef)) {
    throw new Error("C2_VIDEO_REQUIREMENT_INVALID: 主人视频要求必须绑定当前SKU、revision和证据且不得包含额外字段");
  }
  assertOpaqueEvidenceRef(ownerVideoRequirement.evidenceRef, "ownerVideoRequirement.evidenceRef");
  return deepFreeze({
    schemaVersion: "c2-owner-video-requirement-v1",
    required: true,
    confirmedBy: "owner",
    skuPackageId: ownerVideoRequirement.skuPackageId,
    sourceDataRevision: ownerVideoRequirement.sourceDataRevision,
    evidenceRef: ownerVideoRequirement.evidenceRef
  });
}

/**
 * 冻结 Schema 从来没有交出过视频要求（那份 schemaVideoRequirement 挂在已废止的槽位合同上），
 * 所以「这个商品要不要视频」现在只有一个来源：主人自己说。没说就是不要。
 */
export function resolveC2EffectiveVideoRequirement({ skuPackage, ownerVideoRequirement = null }) {
  const normalizedOwnerRequirement = normalizeC2OwnerVideoRequirement(ownerVideoRequirement, skuPackage);
  if (normalizedOwnerRequirement === null) {
    return deepFreeze({ status: "not_required", requiredBy: "default", evidenceRefs: [] });
  }
  return deepFreeze({
    status: "required",
    requiredBy: "owner",
    evidenceRefs: [normalizedOwnerRequirement.evidenceRef]
  });
}

export function assertC2HasNoDownstreamState(skuPackage) {
  if (!isObject(skuPackage)) throw new Error("C2_DOWNSTREAM_STATE_CONFLICT: SKU生命周期包无效");
  const conflictingFields = [
    "productionConfirmationCard", "productionAuthorization", "productionRecord", "dAssetTransport",
    "externalListingRecord", "eVerificationRecord"
  ].filter((field) => skuPackage[field] !== null && skuPackage[field] !== undefined);
  if (conflictingFields.length > 0) {
    throw new Error(`C2_DOWNSTREAM_STATE_CONFLICT: 已存在${conflictingFields.join(",")}，禁止重新准备C2授权或D交接`);
  }
}

function assertStableFinalAssetUrl(value, path) {
  try {
    assertNoProductionSecrets(value, path);
    assertCanonicalStableHttpsAssetRef(value, path);
    const host = new URL(value).hostname.toLowerCase();
    if (isReservedStableAssetHost(host)) {
      throw new Error(`C2_FINAL_ASSET_ADDRESS_INVALID: ${path}不得使用本机或保留域名`);
    }
  } catch (error) {
    if (String(error?.message || "").startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:")) {
      throw new Error(`C2_FINAL_ASSET_ADDRESS_INVALID: ${path}不得包含凭据或临时签名`);
    }
    throw error;
  }
}

function assertFinalUploadEvidenceRef(value, path) {
  assertNoProductionSecrets(value, path);
  assertCanonicalFrozenRef(value, path);
}

function normalizeListingAuthorization(value, path) {
  assertNoRawPersistenceKeys(value, path);
  assertNoProductionSecrets(value, path);
  if (!isObject(value) || value.status !== "owner_authorized_for_listing" || !nonEmptyString(value.evidenceRef)) {
    throw new Error(`C2_FINAL_ASSET_INVALID: ${path}缺少主人上架用途授权证据`);
  }
  assertFinalUploadEvidenceRef(value.evidenceRef, `${path}.evidenceRef`);
  return { status: "owner_authorized_for_listing", evidenceRef: value.evidenceRef };
}

function stableAssetIdentity(asset) {
  return `${asset.assetRef}\u0000${asset.assetVersion}`;
}

export function normalizeC2FinalUploads({
  finalUploadAssets,
  existingAssets,
  effectiveVideoRequirement,
  addedAt
}) {
  if (!Array.isArray(finalUploadAssets) || finalUploadAssets.length === 0 || !isoDateTime(addedAt)) {
    throw new Error("C2_FINAL_ASSET_INVALID: 最终素材和时间必须有效");
  }
  const existing = [...(existingAssets?.collected || []), ...(existingAssets?.aiDrafts || [])];
  const existingIds = new Set(existing.map((asset) => asset.assetId));
  const existingIdentities = new Set(existing.map(stableAssetIdentity));
  const existingHashes = new Set(existing.map((asset) => asset.sha256));
  const normalized = finalUploadAssets.map((asset, index) => {
    const path = `assets.finalUploads[${index}]`;
    if (isObject(asset)) {
      const {
        assetRef: _assetRef,
        sourceEvidenceRef: _sourceEvidenceRef,
        stableUrlEvidenceRef: _stableUrlEvidenceRef,
        usageAuthorization: _usageAuthorization,
        ...nonReferenceFields
      } = asset;
      try {
        assertNoProductionSecrets(nonReferenceFields, path);
      } catch (error) {
        if (String(error?.message || "").startsWith("PRODUCTION_AUTHORIZATION_SECRET_REJECTED:")) {
          throw new Error(`C2_SENSITIVE_INPUT_REJECTED: ${path}不得包含秘密字段或凭据值`);
        }
        throw error;
      }
    }
    assertNoRawPersistenceKeys(asset, path);
    if (!isObject(asset) || !nonEmptyString(asset.assetId) || !ASSET_MEDIA_TYPES.includes(asset.mediaType) ||
        !nonEmptyString(asset.assetRef) || !nonEmptyString(asset.assetVersion) || !nonEmptyString(asset.fileName) ||
        !nonEmptyString(asset.sourceEvidenceRef)) {
      throw new Error(`C2_FINAL_ASSET_INVALID: ${path}缺少文件身份、来源或稳定地址`);
    }
    if (asset.fileName === "." || asset.fileName === ".." || /[\\/\u0000-\u001f]/.test(asset.fileName)) {
      throw new Error(`C2_FINAL_ASSET_INVALID: ${path}.fileName必须是安全文件名而不是路径`);
    }
    for (const field of ["byteSize", "width", "height"]) {
      if (asset[field] !== undefined && asset[field] !== null && (!Number.isFinite(asset[field]) || asset[field] < 0)) {
        throw new Error(`C2_FINAL_ASSET_INVALID: ${path}.${field}必须是非负有限数值或null`);
      }
    }
    assertSha256(asset.sha256, `${path}.sha256`);
    if (!isLocalFinalAssetRef(asset.assetRef)) assertStableFinalAssetUrl(asset.assetRef, `${path}.assetRef`);
    if (!nonEmptyString(asset.stableUrlEvidenceRef)) {
      throw new Error(`C2_FINAL_ASSET_INVALID: ${path}缺少稳定地址证据`);
    }
    assertFinalUploadEvidenceRef(asset.sourceEvidenceRef, `${path}.sourceEvidenceRef`);
    assertFinalUploadEvidenceRef(asset.stableUrlEvidenceRef, `${path}.stableUrlEvidenceRef`);
    assertFinalAssetLocation(asset, path);
    if (asset.sourceType !== "owner_provided_final_upload") {
      throw new Error("C2_OWNER_CONFIRMATION_REQUIRED: collected或aiDrafts不得原地改名为finalUploads");
    }
    // 角色由主人给的顺序定死：第一张就是主图，其余按序进图库。软件不重排、不改选。
    const derivedRole = index === 0 ? "main_image" : "gallery_image";
    if (asset.role !== undefined && asset.role !== derivedRole) {
      throw new Error(`C2_FINAL_ASSET_INVALID: ${path}.role只能是主人顺序推出的${derivedRole}`);
    }
    const item = {
      assetId: asset.assetId,
      mediaType: asset.mediaType,
      assetRef: asset.assetRef,
      fileName: asset.fileName,
      assetVersion: asset.assetVersion,
      sha256: asset.sha256,
      sourceEvidenceRef: asset.sourceEvidenceRef,
      stableUrlEvidenceRef: asset.stableUrlEvidenceRef,
      usageAuthorization: normalizeListingAuthorization(asset.usageAuthorization, `${path}.usageAuthorization`),
      sourceType: "owner_provided_final_upload",
      order: asset.order,
      role: derivedRole,
      byteSize: Number.isFinite(asset.byteSize) ? asset.byteSize : null,
      width: Number.isFinite(asset.width) ? asset.width : null,
      height: Number.isFinite(asset.height) ? asset.height : null,
      addedAt: asset.addedAt || addedAt,
      lifecycleArea: "finalUploads",
      ownerConfirmed: true,
      productionEligible: true
    };
    if (!Number.isInteger(item.order) || item.order !== index + 1) {
      throw new Error("C2_FINAL_ASSET_INVALID: 素材顺序必须从1连续锁定");
    }
    if (!isoDateTime(item.addedAt)) {
      throw new Error(`C2_FINAL_ASSET_INVALID: ${path}.addedAt必须是有效时间`);
    }
    if (existingIds.has(item.assetId) || existingIdentities.has(stableAssetIdentity(item)) || existingHashes.has(item.sha256)) {
      throw new Error("C2_ASSET_REGION_CONFLICT: finalUploads必须是独立稳定上传记录，禁止复用其他区域身份");
    }
    return item;
  });
  const ids = normalized.map((asset) => asset.assetId);
  const identities = normalized.map(stableAssetIdentity);
  const hashes = normalized.map((asset) => asset.sha256);
  if (new Set(ids).size !== ids.length || new Set(identities).size !== identities.length || new Set(hashes).size !== hashes.length) {
    throw new Error("C2_FINAL_ASSET_INVALID: 最终素材文件身份不得重复");
  }
  const mainImages = normalized.filter((asset) => asset.role === "main_image");
  if (mainImages.length !== 1 || mainImages[0].order !== 1 || mainImages[0].mediaType !== "image") {
    throw new Error("C2_FINAL_ASSET_INVALID: 必须且只能有一个排第1的图片首图");
  }
  const videoCount = normalized.filter((asset) => asset.mediaType === "video").length;
  if (effectiveVideoRequirement.status === "required" && videoCount === 0) {
    throw new Error("C2_VIDEO_REQUIRED: 主人要求视频，缺失时禁止准备授权");
  }
  return deepFreeze({
    assets: normalized,
    mainImageAssetId: mainImages[0].assetId,
    authorizedMediaFingerprint: fingerprintAuthorizedMedia(normalized),
    videoDisposition: videoCount > 0 ? "includes_video" : "excludes_video"
  });
}

function c1SourceSnapshot(plan) {
  return {
    c1PlanId: plan.c1PlanId,
    ...(plan.sourceFactsRevision === undefined ? {} : { sourceFactsRevision: structuredClone(plan.sourceFactsRevision), supersedes: structuredClone(plan.supersedes) }),
    status: plan.status,
    contractVersion: plan.contractVersion,
    revisionRefs: structuredClone(plan.revisionRefs),
    frozenInputRefs: structuredClone(plan.frozenInputRefs),
    schemaSnapshotRef: plan.schemaSnapshotRef,
    identity: structuredClone(plan.identity),
    inputRefs: structuredClone(plan.inputRefs),
    inputSnapshots: structuredClone(plan.inputSnapshots),
    factVerificationVersion: plan.factVerificationVersion,
    factsVerifiedAt: plan.factsVerifiedAt,
    exactSkuVerification: structuredClone(plan.exactSkuVerification),
    productAttributes: structuredClone(plan.productAttributes),
    platformCategory: structuredClone(plan.platformCategory),
    schemaSnapshot: structuredClone(plan.schemaSnapshot),
    batteryAssessment: structuredClone(plan.batteryAssessment),
    categoryRestrictions: structuredClone(plan.categoryRestrictions),
    platformCompliance: structuredClone(plan.platformCompliance),
    seoTitleDraft: structuredClone(plan.seoTitleDraft),
    descriptionDraft: structuredClone(plan.descriptionDraft),
    bulletPointsDraft: structuredClone(plan.bulletPointsDraft),
    searchKeywordsDraft: structuredClone(plan.searchKeywordsDraft),
    seoEvidenceLayer: structuredClone(plan.seoEvidenceLayer),
    draftOnlySeo: structuredClone(plan.draftOnlySeo),
    keywordEvidenceRefs: structuredClone(plan.keywordEvidenceRefs),
    unknownManifest: structuredClone(plan.unknownManifest)
  };
}

function buildFinalCardInputSnapshot(skuPackage, canonicalC1) {
  const plan = skuPackage.c1ProductPlan;
  const g1 = normalizeC2G1Binding(skuPackage);
  const activeProfitModel = skuPackage.profitModels?.find(
    (model) => model.profitModelVersion === skuPackage.activeProfitModelVersion
  );
  const confirmedSupplySnapshot = plan.inputSnapshots?.confirmedSupplierSkuSnapshot;
  const selectedSupplySnapshot = skuPackage.selectedSupplySnapshot;
  const ownerSupplyConfirmation = confirmedSupplySnapshot?.ownerSupplyConfirmation;
  const salesSnapshot = plan.inputSnapshots?.salesSnapshot;
  if (!isObject(activeProfitModel) || activeProfitModel.result !== "passed" ||
      plan.inputSnapshots?.profitModel?.profitModelVersion !== skuPackage.activeProfitModelVersion ||
      plan.inputSnapshots?.profitModel?.result !== "passed" ||
      plan.inputRefs.profitModelVersion !== skuPackage.activeProfitModelVersion ||
      canonicalC1.frozenInputRefs.profitModelVersion !== skuPackage.activeProfitModelVersion ||
      !sameJson(activeProfitModel, plan.inputSnapshots.profitModel)) {
    throw new Error("C2_FINAL_CARD_INPUT_GAP: 缺少当前B正式通过利润模型快照");
  }
  if (!isObject(confirmedSupplySnapshot) || !isObject(selectedSupplySnapshot) || !isObject(ownerSupplyConfirmation) ||
      !nonEmptyString(ownerSupplyConfirmation.confirmationVersion) ||
      ownerSupplyConfirmation.status !== "confirmed" || ownerSupplyConfirmation.confirmedBy !== "owner" ||
      !isoDateTime(ownerSupplyConfirmation.confirmedAt) ||
      ownerSupplyConfirmation.parentOpportunityId !== skuPackage.parentOpportunityId ||
      !Number.isInteger(ownerSupplyConfirmation.sourceOpportunityRevision) ||
      ownerSupplyConfirmation.supplierOptionId !== skuPackage.supplierOptionId ||
      ownerSupplyConfirmation.supplierSkuId !== g1.identity.supplierSkuId ||
      ownerSupplyConfirmation.variantKey !== g1.variantKey ||
      confirmedSupplySnapshot.snapshotId !== plan.inputRefs.selectedSupplySnapshotId ||
      canonicalC1.frozenInputRefs.selectedSupplySnapshotId !== confirmedSupplySnapshot.snapshotId ||
      selectedSupplySnapshot.snapshotId !== confirmedSupplySnapshot.snapshotId ||
      !sameJson(selectedSupplySnapshot.ownerSupplyConfirmation, ownerSupplyConfirmation) ||
      !sameJson(selectedSupplySnapshot.supplierSku, confirmedSupplySnapshot.supplierSku) ||
      confirmedSupplySnapshot.supplierSku?.supplierSkuId !== g1.identity.supplierSkuId ||
      confirmedSupplySnapshot.supplierSku?.variantKey !== g1.variantKey ||
      confirmedSupplySnapshot.supplierOptionIdentity?.supplierOptionId !== skuPackage.supplierOptionId ||
      !nonEmptyString(confirmedSupplySnapshot.supplierOptionIdentity?.sourcePlatform) ||
      !nonEmptyString(confirmedSupplySnapshot.supplierOptionIdentity?.productUrl) ||
      !nonEmptyString(confirmedSupplySnapshot.supplierOptionIdentity?.offerId) ||
      !nonEmptyString(confirmedSupplySnapshot.supplierOptionIdentity?.evidenceRef) ||
      !sameJson({
        supplierOptionId: selectedSupplySnapshot.supplierOption?.supplierOptionId,
        sourcePlatform: selectedSupplySnapshot.supplierOption?.sourcePlatform,
        productUrl: selectedSupplySnapshot.supplierOption?.productUrl,
        offerId: selectedSupplySnapshot.supplierOption?.offerId,
        evidenceRef: selectedSupplySnapshot.supplierOption?.evidenceRef
      }, confirmedSupplySnapshot.supplierOptionIdentity)) {
    throw new Error("C2_FINAL_CARD_INPUT_GAP: 缺少主人确认供货方案的冻结快照");
  }
  if (!isObject(salesSnapshot) || salesSnapshot.snapshotId !== plan.inputRefs.salesSnapshotId ||
      canonicalC1.frozenInputRefs.salesSnapshotId !== salesSnapshot.snapshotId ||
      !skuPackage.inheritedSalesSnapshotRefs?.includes(salesSnapshot.snapshotId)) {
    throw new Error("C2_FINAL_CARD_INPUT_GAP: 缺少当前销售证据冻结快照");
  }
  if (plan.identity.parentOpportunityId !== skuPackage.parentOpportunityId ||
      plan.identity.skuPackageId !== g1.identity.skuPackageId ||
      plan.identity.supplierOptionId !== skuPackage.supplierOptionId ||
      plan.identity.supplierSkuId !== g1.identity.supplierSkuId || plan.identity.variantKey !== g1.variantKey ||
      plan.identity.targetPlatform !== g1.identity.platform ||
      plan.identity.targetStore !== g1.identity.storeRef.stableStoreId ||
      !sameJson(canonicalC1.identity, g1.identity)) {
    throw new Error("C2_FINAL_CARD_INPUT_GAP: C1身份与当前SKU生命周期不一致");
  }
  const c1Snapshot = c1SourceSnapshot(plan);
  const finalCardInput = { selectedSupplySnapshot, activeProfitModel, c1Snapshot };
  assertNoRawPersistenceKeys(finalCardInput, "finalCardInputSnapshot");
  assertNoProductionSecrets({ finalCardInputSnapshot: finalCardInput }, "finalCardInputSnapshot");
  return {
    schemaVersion: C2_FINAL_CARD_INPUT_SNAPSHOT_VERSION,
    skuPackageId: skuPackage.skuPackageId,
    sourceDataRevision: skuPackage.dataRevision,
    resultDataRevision: skuPackage.dataRevision + 1,
    sourceC1Fingerprint: fingerprintC1Snapshot(g1.identity, c1Snapshot),
    identity: structuredClone(g1.identity),
    variantKey: g1.variantKey,
    inheritedSalesSnapshotRefs: structuredClone(skuPackage.inheritedSalesSnapshotRefs),
    selectedSupplySnapshot: structuredClone(skuPackage.selectedSupplySnapshot),
    activeProfitModelVersion: skuPackage.activeProfitModelVersion,
    activeProfitModel: structuredClone(activeProfitModel),
    c1Snapshot,
    canonicalC1: structuredClone(canonicalC1)
  };
}

export function fingerprintC2FinalCardInputSnapshot(snapshot) {
  return fingerprintFinalCardInputSnapshot(snapshot);
}

export function fingerprintC2SourceC1(skuPackage) {
  const g1 = normalizeC2G1Binding(skuPackage);
  const plan = skuPackage.c1ProductPlan;
  assertValidC1ProductPlan(plan);
  return fingerprintC1Snapshot(g1.identity, c1SourceSnapshot(plan));
}

export function fingerprintC2AssetManifest(assets) {
  if (!isObject(assets)) throw new Error("C2_ASSET_INPUT_GAP: 缺少素材三域");
  const fields = [
    "assetId", "mediaType", "assetRef", "assetVersion", "sha256", "sourcePlatform",
    "sourceEvidenceRef", "usageAuthorization", "sourceType", "generatorRef", "fileName",
    "byteSize", "width", "height", "order", "role", "stableUrlEvidenceRef",
    "ownerConfirmed", "productionEligible"
  ];
  const view = Object.fromEntries(["collected", "aiDrafts", "finalUploads"].map((region) => [
    region,
    (assets[region] || []).map((asset) => Object.fromEntries(fields
      .filter((field) => asset[field] !== undefined)
      .map((field) => [field, structuredClone(asset[field])])))
  ]));
  return sha256(view);
}

/** 上传之前还没有公网地址，所以 staging 清单只锁文件身份、顺序、首图和视频处置。 */
export function fingerprintC2StagedAssetManifest({
  sourceC1Fingerprint,
  effectiveVideoRequirement,
  mainImageAssetId,
  videoDisposition,
  assets
}) {
  return sha256({
    schemaVersion: C2_STAGED_ASSET_MANIFEST_VERSION,
    sourceC1Fingerprint,
    effectiveVideoRequirement,
    mainImageAssetId,
    videoDisposition,
    assets
  });
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function validateAllowedKeys(value, allowedKeys, path, errors) {
  if (!isObject(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) push(errors, appendC2DiagnosticPath(path, key), "不允许额外字段");
  }
}

function validateBaseAsset(asset, path, errors) {
  if (!isObject(asset)) {
    push(errors, path, "必须是对象");
    return false;
  }
  if (!nonEmptyString(asset.assetId)) push(errors, `${path}.assetId`, "必须是非空字符串");
  if (!ASSET_MEDIA_TYPES.includes(asset.mediaType)) push(errors, `${path}.mediaType`, "必须是image或video");
  if (!nonEmptyString(asset.assetRef)) push(errors, `${path}.assetRef`, "必须是非空引用");
  if (!nonEmptyString(asset.assetVersion)) push(errors, `${path}.assetVersion`, "必须锁定素材版本");
  if (!/^[a-f0-9]{64}$/.test(String(asset.sha256 || ""))) push(errors, `${path}.sha256`, "必须锁定SHA256文件身份");
  if (!isoDateTime(asset.addedAt)) push(errors, `${path}.addedAt`, "必须是有效时间");
  return true;
}

function validateAnalysisAssetRef(asset, path, errors) {
  if (nonEmptyString(asset?.assetRef) && !isCanonicalAnalysisAssetRef(asset.assetRef)) {
    push(errors, `${path}.assetRef`, C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED);
  }
}

function validateFinalAssetRef(asset, path, errors) {
  try {
    assertFinalAssetLocation(asset, path);
  } catch (error) {
    if (!/^(C2_FINAL_ASSET_LOCATION_INVALID|C2_REFERENCE_REJECTED_NONCANONICAL):/.test(error.message)) throw error;
    push(errors, `${path}.assetRef`, C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED);
  }
}

function validateAssetRegions(assets, errors) {
  if (!isObject(assets)) {
    push(errors, "assets", "必须是对象");
    return;
  }
  validateAllowedKeys(assets, ["collected", "aiDrafts", "finalUploads"], "assets", errors);
  for (const region of ["collected", "aiDrafts", "finalUploads"]) {
    if (!Array.isArray(assets[region])) push(errors, `assets.${region}`, "必须是数组");
  }
  if (!["collected", "aiDrafts", "finalUploads"].every((region) => Array.isArray(assets[region]))) return;

  const ids = new Map();
  const stableIdentities = new Map();
  const contentHashes = new Map();
  function register(asset, region, path) {
    if (ids.has(asset.assetId)) push(errors, `${path}.assetId`, `素材ID已存在于${ids.get(asset.assetId)}`);
    const identity = nonEmptyString(asset.assetRef) && nonEmptyString(asset.assetVersion) ? stableAssetIdentity(asset) : null;
    if (identity && stableIdentities.has(identity)) push(errors, `${path}.assetRef`, `稳定素材身份已存在于${stableIdentities.get(identity)}`);
    if (nonEmptyString(asset.sha256) && contentHashes.has(asset.sha256)) {
      push(errors, `${path}.sha256`, `文件内容已存在于${contentHashes.get(asset.sha256)}`);
    }
    ids.set(asset.assetId, region);
    if (identity) stableIdentities.set(identity, region);
    if (nonEmptyString(asset.sha256)) contentHashes.set(asset.sha256, region);
  }
  assets.collected.forEach((asset, index) => {
    const path = `assets.collected[${index}]`;
    validateBaseAsset(asset, path, errors);
    validateAnalysisAssetRef(asset, path, errors);
    validateAllowedKeys(asset, [
      "assetId", "mediaType", "assetRef", "sourcePlatform", "sourceEvidenceRef", "assetVersion", "sha256",
      "usageAuthorization", "addedAt", "lifecycleArea", "usagePolicy", "productionEligible"
    ], path, errors);
    if (!COLLECTED_ASSET_PLATFORMS.includes(asset.sourcePlatform)) push(errors, `${path}.sourcePlatform`, "来源平台无效");
    if (!nonEmptyString(asset.sourceEvidenceRef)) push(errors, `${path}.sourceEvidenceRef`, "必须保留采集证据");
    if (asset.lifecycleArea !== "collected") push(errors, `${path}.lifecycleArea`, "必须是collected");
    if (asset.usagePolicy !== "analysis_reference_only") push(errors, `${path}.usagePolicy`, "采集素材只能用于分析参考");
    if (!isObject(asset.usageAuthorization) || asset.usageAuthorization.status !== "analysis_reference_only" ||
        !nonEmptyString(asset.usageAuthorization.evidenceRef)) {
      push(errors, `${path}.usageAuthorization`, "采集素材必须锁定分析用途授权证据");
    }
    validateAllowedKeys(asset.usageAuthorization, ["status", "evidenceRef"], `${path}.usageAuthorization`, errors);
    if (asset.productionEligible !== false) push(errors, `${path}.productionEligible`, "采集素材禁止进入D");
    register(asset, "collected", path);
  });
  assets.aiDrafts.forEach((asset, index) => {
    const path = `assets.aiDrafts[${index}]`;
    validateBaseAsset(asset, path, errors);
    validateAnalysisAssetRef(asset, path, errors);
    validateAllowedKeys(asset, [
      "assetId", "mediaType", "assetRef", "assetVersion", "sha256", "sourceType", "generatorRef",
      "sourceEvidenceRef", "usageAuthorization", "addedAt", "lifecycleArea", "productionEligible"
    ], path, errors);
    if (asset.lifecycleArea !== "aiDrafts") push(errors, `${path}.lifecycleArea`, "必须是aiDrafts");
    if (asset.sourceType !== "ai_generated_draft") push(errors, `${path}.sourceType`, "AI区只接受AI草稿");
    if (!isObject(asset.usageAuthorization) || asset.usageAuthorization.status !== "draft_reference_only" ||
        !nonEmptyString(asset.usageAuthorization.evidenceRef)) {
      push(errors, `${path}.usageAuthorization`, "AI草稿必须锁定草稿用途授权证据");
    }
    validateAllowedKeys(asset.usageAuthorization, ["status", "evidenceRef"], `${path}.usageAuthorization`, errors);
    if (asset.productionEligible !== false) push(errors, `${path}.productionEligible`, "AI草稿不能自动进入D");
    register(asset, "aiDrafts", path);
  });
  assets.finalUploads.forEach((asset, index) => {
    const path = `assets.finalUploads[${index}]`;
    validateBaseAsset(asset, path, errors);
    validateFinalAssetRef(asset, path, errors);
    validateAllowedKeys(asset, [
      "assetId", "mediaType", "assetRef", "fileName", "assetVersion", "sha256", "sourceEvidenceRef",
      "stableUrlEvidenceRef", "usageAuthorization", "sourceType", "order", "role", "byteSize",
      "width", "height", "addedAt", "lifecycleArea", "ownerConfirmed", "productionEligible"
    ], path, errors);
    if (asset.lifecycleArea !== "finalUploads") push(errors, `${path}.lifecycleArea`, "必须是finalUploads");
    if (asset.sourceType !== "owner_provided_final_upload") push(errors, `${path}.sourceType`, "最终素材必须由主人提供并确认");
    if (asset.ownerConfirmed !== true) push(errors, `${path}.ownerConfirmed`, "最终素材必须由主人确认");
    if (asset.productionEligible !== true) push(errors, `${path}.productionEligible`, "确认后的最终素材才可成为未来D输入");
    if (!nonEmptyString(asset.fileName) || asset.role !== (index === 0 ? "main_image" : "gallery_image") ||
        asset.order !== index + 1) {
      push(errors, path, "最终素材必须锁定文件名，并保持主人给的顺序（第一张即主图）");
    }
    if (!nonEmptyString(asset.sourceEvidenceRef) || !nonEmptyString(asset.stableUrlEvidenceRef)) {
      push(errors, path, "最终素材必须锁定来源与稳定地址证据");
    }
    if (!isObject(asset.usageAuthorization) || asset.usageAuthorization.status !== "owner_authorized_for_listing" ||
        !nonEmptyString(asset.usageAuthorization.evidenceRef)) {
      push(errors, `${path}.usageAuthorization`, "最终素材必须锁定主人上架用途授权");
    }
    validateAllowedKeys(asset.usageAuthorization, ["status", "evidenceRef"], `${path}.usageAuthorization`, errors);
    register(asset, "finalUploads", path);
  });
}

function validateStoredTargetContext(targetContext, unknownManifest, errors) {
  if (!isObject(targetContext) || targetContext.schemaVersion !== C2_TARGET_CONTEXT_VERSION) {
    push(errors, "targetContext", `必须是${C2_TARGET_CONTEXT_VERSION}`);
    return;
  }
  validateAllowedKeys(targetContext, [
    "schemaVersion", "platform", "targetStore", "storeRef", "schemaRevision",
    "schemaEvidenceRef", "sourceDataRevision", "sourceC1Fingerprint"
  ], "targetContext", errors);
  for (const field of ["platform", "targetStore", "storeRef", "schemaRevision", "schemaEvidenceRef", "sourceC1Fingerprint"]) {
    if (!nonEmptyString(targetContext[field])) push(errors, `targetContext.${field}`, "必须是非空字符串");
  }
  if (!Number.isInteger(targetContext.sourceDataRevision) || targetContext.sourceDataRevision < 0) {
    push(errors, "targetContext.sourceDataRevision", "必须锁定源修订号");
  }
  if (!isObject(unknownManifest) || unknownManifest.schemaVersion !== C2_UNKNOWN_MANIFEST_VERSION ||
      !Number.isInteger(unknownManifest.sourceDataRevision) || !Array.isArray(unknownManifest.blockingItems) ||
      unknownManifest.blockingItems.length !== 0) {
    push(errors, "unknownManifest", "必填unknown清单必须绑定revision且保持清零");
  }
  validateAllowedKeys(unknownManifest, ["schemaVersion", "sourceDataRevision", "blockingItems"], "unknownManifest", errors);
}

function validateStoredCanonicalC1Handoff(value, path, storedTargetContext, errors, sourcePlan) {
  validateAllowedKeys(value, [
    "contractVersion", "identity", "frozenInputRevisionRefs", "handoffRevisionRefs", "frozenInputRefs", "schemaSnapshotRef",
    "draftOnlySeo", "keywordEvidenceRefs", "unknownManifest"
  ], path, errors);
  if (!isObject(value) || value.contractVersion !== C1_CANONICAL_CONTRACT_VERSION) {
    push(errors, path, "必须是严格的G1 C1 canonical冻结交接");
    return;
  }
  const frozenRevisions = value.frozenInputRevisionRefs;
  const handoffRevisions = value.handoffRevisionRefs;
  let g1Identity = null;
  try {
    g1Identity = normalizeC2G1IdentityValue(value.identity, `${path}.identity`);
  } catch (error) {
    push(errors, `${path}.identity`, error.message);
  }
  if (!isObject(frozenRevisions) || !Number.isInteger(frozenRevisions.sourceRevision) ||
      frozenRevisions.resultRevision !== frozenRevisions.sourceRevision + 1 ||
      !isObject(handoffRevisions) || !Number.isInteger(handoffRevisions.sourceRevision) ||
      handoffRevisions.resultRevision !== handoffRevisions.sourceRevision + 1 ||
      handoffRevisions.sourceRevision < frozenRevisions.resultRevision) {
    push(errors, `${path}.handoffRevisionRefs`, "冻结输入与C1到C2交接revision无效");
  }
  validateAllowedKeys(value.frozenInputRefs, [
    "candidateId", "skuPackageId", "platform", "storeRef", "sourceRevision", "salesSnapshotId",
    "selectedSupplySnapshotId", "ownerSupplyConfirmationRef", "profitModelVersion", "schemaSnapshotRef"
  ], `${path}.frozenInputRefs`, errors);
  if (!isObject(value.frozenInputRefs) || value.frozenInputRefs.schemaSnapshotRef !== value.schemaSnapshotRef ||
      value.frozenInputRefs.sourceRevision !== frozenRevisions?.sourceRevision ||
      value.frozenInputRefs.candidateId !== g1Identity?.candidateId ||
      value.frozenInputRefs.skuPackageId !== g1Identity?.skuPackageId ||
      value.frozenInputRefs.platform !== g1Identity?.platform ||
      value.frozenInputRefs.storeRef !== g1Identity?.storeRef?.stableStoreId) {
    push(errors, `${path}.frozenInputRefs`, "冻结输入引用与Schema引用不一致");
  }
  for (const field of [
    "candidateId", "skuPackageId", "platform", "storeRef", "salesSnapshotId",
    "selectedSupplySnapshotId", "ownerSupplyConfirmationRef", "profitModelVersion", "schemaSnapshotRef"
  ]) {
    try {
      assertCanonicalFrozenRef(value.frozenInputRefs?.[field], `${path}.frozenInputRefs.${field}`);
    } catch (error) {
      push(errors, `${path}.frozenInputRefs.${field}`, error.message);
    }
  }
  const draft = value.draftOnlySeo;
  if (draft?.sourceType === "owner_confirmed_editorial") {
    try {
      if (isEditorialDraftReference(draft)) {
        if (!editorialDraftMatchesSnapshot(draft, sourcePlan?.draftOnlySeo, g1Identity, handoffRevisions?.sourceRevision)) {
          push(errors, `${path}.draftOnlySeo.editorialSource`, "C2_EDITORIAL_REFERENCE_SOURCE_MISMATCH");
        }
      } else {
        assertC1EditorialSource({ draftOnlySeo: draft, identity: g1Identity, resultSkuRevision: handoffRevisions?.sourceRevision });
      }
    } catch (error) {
      if (!(error instanceof C1EditorialSourceError) && !/^C1_AI_/.test(error.message)) throw error;
      push(errors, `${path}.draftOnlySeo.editorialSource`, error.message);
    }
  } else if (draft?.sourceType === 'sibling_shared_formal_provider') {
    try {
      if (draft.siblingFormalReuseRecord?.schemaVersion === C1_SIBLING_FORMAL_REFERENCE_VERSION) {
        if (!canonicalDraftMatchesSnapshot(draft, sourcePlan, g1Identity, handoffRevisions?.sourceRevision,
          value.frozenInputRefs?.profitModelVersion)) throw new Error('C1_SIBLING_SHARED_REFERENCE_SOURCE_MISMATCH');
      } else {
        assertC1SiblingFormalReuse({ plan: sourcePlan, resultSkuRevision: handoffRevisions?.sourceRevision });
      }
    } catch (error) { push(errors, `${path}.draftOnlySeo.siblingFormalReuseRecord`, error.message); }
  } else {
    const job = draft?.providerJobRef;
    const authorization = job?.authorizationRef;
    const scope = authorization?.scope;
    if (draft?.pricingReuseRecord !== undefined) {
      try {
        const reuse = draft.pricingReuseRecord;
        if (reuse.schemaVersion === C1_PRICING_REUSE_REFERENCE_VERSION) {
          if (!pricingDraftMatchesSnapshot(draft, sourcePlan, g1Identity, handoffRevisions?.sourceRevision,
            value.frozenInputRefs?.profitModelVersion)) throw new C1PricingReuseError("C1_PRICING_REUSE_REFERENCE_SOURCE_MISMATCH");
        } else {
          assertC1PricingReuseRecordSource(reuse);
          if (reuse.resultSkuRevision !== handoffRevisions?.sourceRevision ||
              reuse.targetProfitModelVersion !== value.frozenInputRefs?.profitModelVersion ||
              !sameJson(reuse.sourceIdentity, g1Identity)) throw new C1PricingReuseError("C1_PRICING_REUSE_TARGET_CONFLICT");
        }
      } catch (error) {
        if (!(error instanceof C1PricingReuseError) && !(error instanceof C1SkuRightsReviewError) && !/^C1_AI_/.test(error.message)) throw error;
        push(errors, `${path}.draftOnlySeo.pricingReuseRecord`, error.message);
      }
    }
    validateAllowedKeys(draft, [
      "status", "formalProviderResultAccepted", "reason", "aiRequestId", "aiRequestFingerprint",
      "inputFingerprint", "sourceRevision", "receiptRef", "providerJobRef", "pricingReuseRecord"
    ], `${path}.draftOnlySeo`, errors);
    validateAllowedKeys(job, [
      "jobId", "jobType", "providerId", "providerVersion", "candidateId", "skuPackageId", "platform",
      "storeRef", "authorizationRef", "inputFingerprint", "sourceRevision", "receiptRef", "terminalStatus",
      "requestSubmitted", "responseVerified"
    ], `${path}.draftOnlySeo.providerJobRef`, errors);
    validateAllowedKeys(authorization, ["authorizationId", "authorizationType", "scope"], `${path}.draftOnlySeo.providerJobRef.authorizationRef`, errors);
    validateAllowedKeys(scope, [
      "candidateId", "skuPackageId", "platform", "storeRef", "sourceRevision", "jobType"
    ], `${path}.draftOnlySeo.providerJobRef.authorizationRef.scope`, errors);
    if (!isObject(draft) || draft.status !== "draft_only" || draft.formalProviderResultAccepted !== true ||
        draft.reason !== null || !isOpaqueEvidenceRef(draft.aiRequestId) ||
        !/^[a-f0-9]{64}$/.test(String(draft.aiRequestFingerprint || "")) ||
        !isOpaqueEvidenceRef(draft.receiptRef) || !isObject(job) ||
        !isOpaqueEvidenceRef(job.jobId) || job.jobType !== "c1_ai_draft" ||
        !nonEmptyString(job.providerId) || job.providerId === "unknown" ||
        !nonEmptyString(job.providerVersion) || job.providerVersion === "unknown" ||
        !/^[a-f0-9]{64}$/.test(String(job.inputFingerprint || "")) ||
        !isOpaqueEvidenceRef(job.receiptRef) || job.terminalStatus !== "completed" ||
        job.requestSubmitted !== true || job.responseVerified !== true || !isObject(authorization) ||
        !isCanonicalC1AuthorizationId(authorization.authorizationId) ||
        authorization.authorizationType !== "paid_ai_draft" || !isObject(scope) ||
        draft.inputFingerprint !== job.inputFingerprint || draft.sourceRevision !== job.sourceRevision ||
        (draft?.pricingReuseRecord === undefined && job.sourceRevision !== handoffRevisions?.sourceRevision - 1) ||
        job.candidateId !== g1Identity?.candidateId || job.skuPackageId !== g1Identity?.skuPackageId ||
        job.platform !== g1Identity?.platform || job.storeRef !== g1Identity?.storeRef?.stableStoreId ||
        scope.candidateId !== job.candidateId || scope.skuPackageId !== job.skuPackageId ||
        scope.platform !== job.platform || scope.storeRef !== job.storeRef ||
        scope.sourceRevision !== job.sourceRevision || scope.jobType !== job.jobType) {
      push(errors, `${path}.draftOnlySeo`, "必须冻结正式provider完成、回执核验和授权引用");
    }
    for (const [fieldPath, fieldValue] of [
      ...["providerId", "providerVersion", "candidateId", "skuPackageId", "platform", "storeRef"]
        .map((field) => [`${path}.draftOnlySeo.providerJobRef.${field}`, job?.[field]]),
      ...["candidateId", "skuPackageId", "platform", "storeRef"]
        .map((field) => [`${path}.draftOnlySeo.providerJobRef.authorizationRef.scope.${field}`, scope?.[field]])
    ]) {
      try {
        assertCanonicalFrozenRef(fieldValue, fieldPath);
      } catch (error) {
        push(errors, fieldPath, error.message);
      }
    }
  }
  if (!Array.isArray(value.keywordEvidenceRefs) || value.keywordEvidenceRefs.length === 0 ||
      value.keywordEvidenceRefs.some((ref) => !isOpaqueEvidenceRef(ref)) ||
      new Set(value.keywordEvidenceRefs).size !== value.keywordEvidenceRefs.length) {
    push(errors, `${path}.keywordEvidenceRefs`, "必须冻结非空去重正式关键词证据引用");
  }
  if (value.schemaSnapshotRef !== storedTargetContext?.schemaEvidenceRef ||
      storedTargetContext?.platform !== g1Identity?.platform ||
      storedTargetContext?.targetStore !== g1Identity?.storeRef?.stableStoreId ||
      storedTargetContext?.storeRef !== g1Identity?.storeRef?.stableStoreId) {
    push(errors, `${path}.schemaSnapshotRef`, "canonical交接必须与冻结目标绑定同一Schema证据和店铺");
  }
  if (!Array.isArray(value.unknownManifest) || value.unknownManifest.length !== 0) {
    push(errors, `${path}.unknownManifest`, "进入C2的canonical阻断unknown必须为空");
  }
}

function validateStoredC1FactSections(c1, errors) {
  const factSectionNames = [
    "exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot",
    "batteryAssessment", "categoryRestrictions", "platformCompliance"
  ];
  const emittedDiagnostics = new Set();
  const pushFactError = (path, message) => {
    const key = `${path}\u0000${message}`;
    if (emittedDiagnostics.has(key)) return;
    emittedDiagnostics.add(key);
    push(errors, path, message);
  };
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, appendC2DiagnosticPath(path, index, true)));
      return;
    }
    if (!isObject(value)) return;
    if ("sourceRefs" in value &&
        (!Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0 ||
          value.sourceRefs.some((ref) => !nonEmptyString(ref)))) {
      pushFactError(appendC2DiagnosticPath(path, "sourceRefs", false), "C1事实分区来源元数据必须是非空引用数组");
    }
    if ("verificationStatus" in value) {
      if (!["confirmed", "unknown"].includes(value.verificationStatus) ||
          !Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0 ||
          value.sourceRefs.some((ref) => !nonEmptyString(ref)) ||
          (value.verificationStatus === "unknown" && value.value !== "unknown") ||
          (value.verificationStatus === "confirmed" &&
            (value.value === "unknown" || value.value === null || value.value === undefined))) {
        pushFactError(path, "C1事实必须保留有效值、核验状态和来源引用");
      }
      return;
    }
    Object.entries(value).forEach(([key, child]) => {
      if (!["verifiedAt", "sourceRefs", "reason"].includes(key)) {
        visit(child, appendC2DiagnosticPath(path, key, false));
      }
    });
  };
  for (const name of factSectionNames) {
    const section = c1?.[name];
    const path = `productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.${name}`;
    if (!isObject(section) || !isObject(section.status)) {
      pushFactError(path, "最终卡必须冻结完整C1事实分区及其状态");
      continue;
    }
    visit(section, path);
  }
}

function validateStoredC1PlatformSchemaRules(c1, preparation, errors) {
  const path = "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.inputSnapshots.platformSchemaRules";
  const rules = c1?.inputSnapshots?.platformSchemaRules;
  const target = preparation?.targetContext;
  if (!isObject(rules) || (Object.hasOwn(rules, "mediaRequirements") && rules.mediaRequirements !== null) ||
      rules.evidenceId !== target?.schemaEvidenceRef || rules.platform !== target?.platform ||
      rules.store !== target?.targetStore || !sameStoreRef(rules.storeRef, preparation?.frozenC1Handoff?.identity?.storeRef) ||
      rules.schemaRevision !== target?.schemaRevision) {
    push(errors, path, "冻结platformSchemaRules身份、Schema修订和目标范围必须与授权准备上下文一致");
  }
}

function validateStoredFinalCardInputSnapshot(snapshot, preparation, errors) {
  validateAllowedKeys(snapshot, [
    "schemaVersion", "skuPackageId", "sourceDataRevision", "resultDataRevision", "sourceC1Fingerprint",
    "identity", "variantKey", "inheritedSalesSnapshotRefs", "selectedSupplySnapshot", "activeProfitModelVersion",
    "activeProfitModel", "c1Snapshot", "canonicalC1"
  ], "productionAuthorizationPreparation.finalCardInputSnapshot", errors);
  if (!isObject(snapshot)) return;

  let identity = null;
  try {
    identity = normalizeC2G1IdentityValue(
      snapshot.identity,
      "productionAuthorizationPreparation.finalCardInputSnapshot.identity"
    );
  } catch (error) {
    push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.identity", error.message);
  }
  const variantKey = snapshot.variantKey;
  const c1 = snapshot.c1Snapshot;
  const canonical = snapshot.canonicalC1;
  const selectedSupply = snapshot.selectedSupplySnapshot;
  const confirmedSupply = c1?.inputSnapshots?.confirmedSupplierSkuSnapshot;
  const ownerConfirmation = confirmedSupply?.ownerSupplyConfirmation;
  const activeProfit = snapshot.activeProfitModel;
  const frozenProfit = c1?.inputSnapshots?.profitModel;
  const salesSnapshot = c1?.inputSnapshots?.salesSnapshot;
  const c1Identity = c1?.identity;

  if (c1?.sourceFactsRevision !== undefined) {
    try { assertC1SupplierFactRevisionProjection({ plan: c1, sourceIdentity: identity }); }
    catch (error) {
      if (!(error instanceof ConfirmedSupplierInputError)) throw error;
      push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.sourceFactsRevision", error.code);
    }
  }
  validateStoredC1FactSections(c1, errors);
  validateStoredC1PlatformSchemaRules(c1, preparation, errors);

  if (!nonEmptyString(c1?.c1PlanId) || c1?.status !== "seo_draft_ready" ||
      !["c1-fact-verification-v1.1", "c1-fact-verification-v1.2"].includes(c1?.factVerificationVersion) || !isoDateTime(c1?.factsVerifiedAt)) {
    push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot", "最终卡必须冻结已完成事实核验和SEO草稿的C1快照");
  }

  if (!isObject(identity) || !isObject(c1Identity) || !nonEmptyString(variantKey) ||
      snapshot.skuPackageId !== identity?.skuPackageId || snapshot.skuPackageId !== c1Identity?.skuPackageId ||
      !nonEmptyString(c1Identity?.parentOpportunityId) ||
      identity?.supplierSkuId !== c1Identity?.supplierSkuId || variantKey !== c1Identity?.variantKey ||
      identity?.platform !== c1Identity?.targetPlatform ||
      identity?.storeRef?.stableStoreId !== c1Identity?.targetStore ||
      !sameJson(canonical?.identity, identity) ||
      canonical?.frozenInputRefs?.candidateId !== identity?.candidateId ||
      canonical?.frozenInputRefs?.skuPackageId !== identity?.skuPackageId ||
      canonical?.frozenInputRefs?.platform !== identity?.platform ||
      canonical?.frozenInputRefs?.storeRef !== identity?.storeRef?.stableStoreId ||
      preparation?.targetContext?.platform !== identity?.platform ||
      preparation?.targetContext?.targetStore !== identity?.storeRef?.stableStoreId ||
      preparation?.targetContext?.storeRef !== identity?.storeRef?.stableStoreId) {
    push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.identity", "最终卡、C1和canonical身份必须完全一致");
  }

  if (c1?.contractVersion !== canonical?.contractVersion ||
      !sameJson(c1?.revisionRefs, canonical?.frozenInputRevisionRefs) ||
      !sameJson(c1?.frozenInputRefs, canonical?.frozenInputRefs) ||
      c1?.schemaSnapshotRef !== canonical?.schemaSnapshotRef ||
      c1?.inputRefs?.platformSchemaEvidenceId !== canonical?.schemaSnapshotRef) {
    push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.frozenInputRefs", "C1原始冻结revision、输入引用和Schema必须与canonical一致");
  }

  if (!isObject(activeProfit) || activeProfit.result !== "passed" ||
      !nonEmptyString(snapshot.activeProfitModelVersion) ||
      activeProfit?.profitModelVersion !== snapshot.activeProfitModelVersion ||
      frozenProfit?.profitModelVersion !== snapshot.activeProfitModelVersion || frozenProfit?.result !== "passed" ||
      c1?.inputRefs?.profitModelVersion !== snapshot.activeProfitModelVersion ||
      canonical?.frozenInputRefs?.profitModelVersion !== snapshot.activeProfitModelVersion ||
      !sameJson(activeProfit, frozenProfit)) {
    push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.activeProfitModel", "必须冻结同一版本的B正式通过利润模型");
  }

  if (!isObject(selectedSupply) || !isObject(confirmedSupply) || !isObject(ownerConfirmation) ||
      !nonEmptyString(ownerConfirmation?.confirmationVersion) || ownerConfirmation?.status !== "confirmed" ||
      ownerConfirmation?.confirmedBy !== "owner" || !isoDateTime(ownerConfirmation?.confirmedAt) ||
      ownerConfirmation?.parentOpportunityId !== c1Identity?.parentOpportunityId ||
      !Number.isInteger(ownerConfirmation?.sourceOpportunityRevision) ||
      ownerConfirmation?.supplierOptionId !== c1Identity?.supplierOptionId ||
      ownerConfirmation?.supplierSkuId !== identity?.supplierSkuId || ownerConfirmation?.variantKey !== variantKey ||
      confirmedSupply?.snapshotId !== c1?.inputRefs?.selectedSupplySnapshotId ||
      canonical?.frozenInputRefs?.selectedSupplySnapshotId !== confirmedSupply?.snapshotId ||
      selectedSupply?.snapshotId !== confirmedSupply?.snapshotId ||
      !sameJson(selectedSupply?.ownerSupplyConfirmation, ownerConfirmation) ||
      !sameJson(selectedSupply?.supplierSku, confirmedSupply?.supplierSku) ||
      confirmedSupply?.supplierSku?.supplierSkuId !== identity?.supplierSkuId ||
      confirmedSupply?.supplierSku?.variantKey !== variantKey ||
      confirmedSupply?.supplierOptionIdentity?.supplierOptionId !== c1Identity?.supplierOptionId ||
      !nonEmptyString(confirmedSupply?.supplierOptionIdentity?.sourcePlatform) ||
      !nonEmptyString(confirmedSupply?.supplierOptionIdentity?.productUrl) ||
      !nonEmptyString(confirmedSupply?.supplierOptionIdentity?.offerId) ||
      !nonEmptyString(confirmedSupply?.supplierOptionIdentity?.evidenceRef) ||
      !sameJson({
        supplierOptionId: selectedSupply?.supplierOption?.supplierOptionId,
        sourcePlatform: selectedSupply?.supplierOption?.sourcePlatform,
        productUrl: selectedSupply?.supplierOption?.productUrl,
        offerId: selectedSupply?.supplierOption?.offerId,
        evidenceRef: selectedSupply?.supplierOption?.evidenceRef
      }, confirmedSupply?.supplierOptionIdentity)) {
    push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.selectedSupplySnapshot", "必须冻结同一主人确认供货方案、供应SKU和来源身份");
  }

  if (!isObject(salesSnapshot) || salesSnapshot?.snapshotId !== c1?.inputRefs?.salesSnapshotId ||
      canonical?.frozenInputRefs?.salesSnapshotId !== salesSnapshot?.snapshotId ||
      !Array.isArray(snapshot.inheritedSalesSnapshotRefs) ||
      !snapshot.inheritedSalesSnapshotRefs.includes(salesSnapshot?.snapshotId)) {
    push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.inheritedSalesSnapshotRefs", "必须冻结同一销售证据引用");
  }

  if (c1?.draftOnlySeo?.pricingReuseRecord !== undefined) {
    try { assertC1PricingResultReuse({ plan: c1, resultSkuRevision: canonical?.handoffRevisionRefs?.sourceRevision }); }
    catch (error) {
      if (!(error instanceof C1PricingReuseError) && !(error instanceof C1SkuRightsReviewError) && !/^C1_AI_/.test(error.message)) throw error;
      push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.draftOnlySeo.pricingReuseRecord", error.message);
    }
  }
  const evidenceLayer = c1?.seoEvidenceLayer;
  const draft = c1?.draftOnlySeo;
  if (draft?.sourceType === "owner_confirmed_editorial") {
    try {
      assertC1EditorialSnapshot({ plan: c1, identity: snapshot.identity, resultSkuRevision: canonical?.handoffRevisionRefs?.sourceRevision });
    } catch (error) {
      if (!(error instanceof C1EditorialSourceError) && !/^C1_AI_/.test(error.message)) throw error;
      push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.seoEvidenceLayer", error.message);
    }
  } else if (draft?.sourceType === 'sibling_shared_formal_provider') {
    try { assertC1SiblingFormalReuse({ plan: c1, resultSkuRevision: canonical?.handoffRevisionRefs?.sourceRevision }); }
    catch (error) { push(errors, 'productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.draftOnlySeo.siblingFormalReuseRecord', error.message); }
  } else {
    const job = draft?.providerJobRef;
    if (!isObject(evidenceLayer) || !sameJson(evidenceLayer?.providerJobRef, job) ||
        evidenceLayer?.inputFingerprint !== job?.inputFingerprint ||
        evidenceLayer?.sourceRevision !== job?.sourceRevision || evidenceLayer?.aiRequestId !== draft?.aiRequestId ||
        evidenceLayer?.aiRequestFingerprint !== draft?.aiRequestFingerprint || evidenceLayer?.aiReceiptId !== draft?.receiptRef) {
      push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.seoEvidenceLayer", "必须冻结与canonical草稿一致的正式SEO作业证据层");
    }

  }

  try {
    if (!Array.isArray(c1?.bulletPointsDraft) || (c1.bulletPointsDraft.length === 0 && evidenceLayer?.factDefinitionsVersion !== C1_FACT_DEFINITIONS_VERSION) ||
        !isObject(c1?.searchKeywordsDraft) || c1.searchKeywordsDraft.status !== "draft_only" ||
        c1.searchKeywordsDraft.productionApproved !== false ||
        !Array.isArray(c1.searchKeywordsDraft.keywords) || c1.searchKeywordsDraft.keywords.length === 0) {
      throw new Error("SEO各段与搜索词必须保持draft_only并有正式证据");
    }
    const adoptedRefs = [
      ...canonicalDraftKeywordRefs(c1.seoTitleDraft, "seoTitleDraft"),
      ...canonicalDraftKeywordRefs(c1.descriptionDraft, "descriptionDraft"),
      ...c1.bulletPointsDraft.flatMap((item, index) => canonicalDraftKeywordRefs(item, `bulletPointsDraft[${index}]`)),
      ...c1.searchKeywordsDraft.keywords.flatMap((item, index) => {
        if (!isObject(item) || !nonEmptyString(item.query) || !Array.isArray(item.factRefs) || item.factRefs.length === 0 ||
            item.factRefs.some((ref) => !nonEmptyString(ref)) || !Array.isArray(item.evidenceRefs) ||
            item.evidenceRefs.length === 0 || item.evidenceRefs.some((ref) => !isOpaqueEvidenceRef(ref))) {
          throw new Error(`searchKeywordsDraft.keywords[${index}]缺少事实或正式关键词证据`);
        }
        return item.evidenceRefs;
      })
    ];
    if (adoptedRefs.length === 0 || adoptedRefs.some((ref) => !canonical?.keywordEvidenceRefs?.includes(ref))) {
      throw new Error("canonical顶层关键词证据未覆盖全部SEO采用词");
    }
  } catch (error) {
    push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.seoTitleDraft", error.message);
  }

  if (!Array.isArray(c1?.unknownManifest)) {
    push(errors, "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.unknownManifest", "C1原始unknown清单必须是数组");
  } else {
    c1.unknownManifest.forEach((entry, index) => {
      const path = `productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.unknownManifest[${index}]`;
      validateAllowedKeys(entry, ["fieldPath", "reason", "sourceRefs", "blockingScope", "blocksC2Handoff"], path, errors);
      if (!isObject(entry) || !nonEmptyString(entry.fieldPath) || !nonEmptyString(entry.reason) ||
          !Array.isArray(entry.sourceRefs) || entry.sourceRefs.length === 0 ||
          entry.sourceRefs.some((ref) => !isOpaqueEvidenceRef(ref)) ||
          new Set(entry.sourceRefs).size !== entry.sourceRefs.length ||
          entry.blockingScope !== "informational" || entry.blocksC2Handoff !== false) {
        push(errors, path, "进入C2的原始unknown只能保留非阻断informational项");
      }
    });
  }
}

function validateStoredOwnerVideoRequirement(value, effectiveVideoRequirement, errors) {
  if (value === null) {
    if (effectiveVideoRequirement?.requiredBy === "owner") {
      push(errors, "ownerVideoRequirement", "主人要求视频时必须持久化当前SKU决定");
    }
    return;
  }
  validateAllowedKeys(value, [
    "schemaVersion", "required", "confirmedBy", "skuPackageId", "sourceDataRevision", "evidenceRef"
  ], "ownerVideoRequirement", errors);
  if (!isObject(value) || value.schemaVersion !== "c2-owner-video-requirement-v1" || value.required !== true ||
      value.confirmedBy !== "owner" || !nonEmptyString(value.skuPackageId) ||
      !Number.isInteger(value.sourceDataRevision) || !nonEmptyString(value.evidenceRef)) {
    push(errors, "ownerVideoRequirement", "主人视频决定必须锁定当前SKU、revision和证据");
  }
  if (effectiveVideoRequirement?.requiredBy !== "owner" ||
      !sameJson(effectiveVideoRequirement.evidenceRefs, [value.evidenceRef])) {
    push(errors, "ownerVideoRequirement", "持久化主人视频决定必须与有效视频要求一致");
  }
}

function validateEffectiveVideoRequirement(value, errors) {
  validateAllowedKeys(value, ["status", "requiredBy", "evidenceRefs"], "effectiveVideoRequirement", errors);
  if (!isObject(value) || !["required", "not_required"].includes(value.status) ||
      !["owner", "default"].includes(value.requiredBy) || !Array.isArray(value.evidenceRefs)) {
    push(errors, "effectiveVideoRequirement", "最终视频要求无效");
    return;
  }
  if (value.status === "not_required" && (value.requiredBy !== "default" || value.evidenceRefs.length !== 0)) {
    push(errors, "effectiveVideoRequirement", "not_required只能来自默认规则");
  }
  if (value.status === "required" && (value.requiredBy !== "owner" || value.evidenceRefs.length === 0)) {
    push(errors, "effectiveVideoRequirement", "required视频只能来自当前SKU主人决定并保留证据");
  }
}

function validateSoftwareState(state, errors) {
  if (!isObject(state)) {
    push(errors, "softwareState", "必须是对象");
    return;
  }
  validateAllowedKeys(state, [
    "schemaVersion", "lifecycleStatus", "sourceDataRevision", "sourceC1Fingerprint",
    "assetManifestFingerprint", "executionPolicy", "technicalState"
  ], "softwareState", errors);
  validateAllowedKeys(state.executionPolicy, [
    "externalAccessAllowed", "imageGenerationAllowed", "codexDispatchAllowed", "productionAllowed", "automaticRetry"
  ], "softwareState.executionPolicy", errors);
  validateAllowedKeys(state.technicalState, ["status", "failure", "automaticRetry"], "softwareState.technicalState", errors);
  validateAllowedKeys(state.technicalState?.failure, [
    "layer", "failureClass", "code", "evidenceRef", "failedAt"
  ], "softwareState.technicalState.failure", errors);
  if (state.schemaVersion !== C2_SOFTWARE_STATE_VERSION) push(errors, "softwareState.schemaVersion", `必须是${C2_SOFTWARE_STATE_VERSION}`);
  if (!["c2_waiting_final_uploads", "c2_ready"].includes(state.lifecycleStatus)) push(errors, "softwareState.lifecycleStatus", "软件状态无效");
  if (!Number.isInteger(state.sourceDataRevision) || state.sourceDataRevision < 0) push(errors, "softwareState.sourceDataRevision", "必须锁定源修订号");
  for (const field of ["sourceC1Fingerprint", "assetManifestFingerprint"]) {
    if (!/^[a-f0-9]{64}$/.test(String(state[field] || ""))) push(errors, `softwareState.${field}`, "必须是SHA256");
  }
  if (!isObject(state.executionPolicy) || state.executionPolicy.externalAccessAllowed !== false ||
      state.executionPolicy.imageGenerationAllowed !== false || state.executionPolicy.codexDispatchAllowed !== false ||
      state.executionPolicy.productionAllowed !== false || state.executionPolicy.automaticRetry !== false) {
    push(errors, "softwareState.executionPolicy", "C2软件容器必须保持零外部访问、零生成、零派发、零生产和零自动重试");
  }
  if (!isObject(state.technicalState) || !["completed", "failed"].includes(state.technicalState.status) ||
      state.technicalState.automaticRetry !== false) push(errors, "softwareState.technicalState", "技术状态必须显式停止自动重试");
  if (state.technicalState?.status === "completed" && state.technicalState.failure !== null) {
    push(errors, "softwareState.technicalState.failure", "completed技术状态不得保存失败对象");
  }
  if (state.technicalState?.status === "failed" && !isObject(state.technicalState.failure)) {
    push(errors, "softwareState.technicalState.failure", "failed技术状态必须保存结构化失败证据");
  }
}

function validateStableAssetTransport(value, lifecycle, errors) {
  if (value === null) return;
  const path = "stableAssetTransport";
  validateAllowedKeys(value, [
    "schemaVersion", "status", "jobRef", "stagedAssetManifestFingerprint", "stagedAssets",
    "ownerStagingConfirmation", "transportResult"
  ], path, errors);
  if (!isObject(value) || value.schemaVersion !== C2_STABLE_ASSET_TRANSPORT_VERSION ||
      !["awaiting_verified_result", "verified"].includes(value.status)) {
    push(errors, path, `必须是${C2_STABLE_ASSET_TRANSPORT_VERSION}`);
    return;
  }
  const job = value.jobRef;
  validateAllowedKeys(job, [
    "schemaVersion", "jobId", "jobType", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "inputFingerprint"
  ], `${path}.jobRef`, errors);
  if (!isObject(job) || job.schemaVersion !== "c2-stable-asset-transport-job-ref-v1" ||
      job.jobType !== "c2_stable_asset_transport" || !nonEmptyString(job.jobId) ||
      !nonEmptyString(job.candidateId) || !nonEmptyString(job.skuPackageId) ||
      !Number.isInteger(job.sourceRevision) || job.resultRevision !== job.sourceRevision + 1 ||
      !/^[a-f0-9]{64}$/.test(String(job.inputFingerprint || ""))) {
    push(errors, `${path}.jobRef`, "必须锁定唯一SoftwareJob身份与revision");
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.stagedAssetManifestFingerprint || "")) ||
      !Array.isArray(value.stagedAssets) || value.stagedAssets.length === 0) {
    push(errors, path, "必须锁定非空staged manifest及其指纹");
  }
  const confirmation = value.ownerStagingConfirmation;
  validateAllowedKeys(confirmation, [
    "schemaVersion", "status", "confirmedBy", "confirmedByUserId", "confirmedAt", "confirmationRef",
    "approvedStagedAssetManifestFingerprint", "approvedSourceC1Fingerprint", "approvedAssetIds",
    "approvedMainImageAssetId", "approvedVideoDisposition"
  ], `${path}.ownerStagingConfirmation`, errors);
  if (!isObject(confirmation) || confirmation.schemaVersion !== "c2-owner-staging-confirmation-v1" ||
      confirmation.status !== "confirmed" || confirmation.confirmedBy !== "owner" || !nonEmptyString(confirmation.confirmedByUserId) || !isoDateTime(confirmation.confirmedAt) ||
      !isOpaqueEvidenceRef(confirmation.confirmationRef) ||
      confirmation.approvedStagedAssetManifestFingerprint !== value.stagedAssetManifestFingerprint ||
      !sameJson(confirmation.approvedAssetIds, value.stagedAssets.map((asset) => asset.assetId))) {
    push(errors, `${path}.ownerStagingConfirmation`, "主人staging确认必须锁定同一文件身份、顺序、首图和媒体要求");
  }
  for (const [index, asset] of value.stagedAssets.entries()) {
    const assetPath = `${path}.stagedAssets[${index}]`;
    validateAllowedKeys(asset, [
      "assetId", "mediaType", "fileName", "assetVersion", "sha256", "sourceEvidenceRef", "usageAuthorization",
      "sourceType", "order", "role", "byteSize", "width", "height"
    ], assetPath, errors);
    if (!isObject(asset) || !nonEmptyString(asset.assetId) || !ASSET_MEDIA_TYPES.includes(asset.mediaType) ||
        !nonEmptyString(asset.fileName) || !nonEmptyString(asset.assetVersion) || !/^[a-f0-9]{64}$/.test(String(asset.sha256 || "")) ||
        !nonEmptyString(asset.sourceEvidenceRef) || !Number.isInteger(asset.order) || asset.order !== index + 1 ||
        asset.role !== (index === 0 ? "main_image" : "gallery_image") || Object.hasOwn(asset, "assetRef")) {
      push(errors, assetPath, "staging素材必须只保存文件身份和主人给的顺序，不得保存路径或地址");
    }
  }
  if (isObject(confirmation) && Array.isArray(value.stagedAssets) && value.stagedAssets.length > 0 &&
      fingerprintC2StagedAssetManifest({
        sourceC1Fingerprint: confirmation.approvedSourceC1Fingerprint,
        effectiveVideoRequirement: lifecycle.effectiveVideoRequirement,
        mainImageAssetId: confirmation.approvedMainImageAssetId,
        videoDisposition: confirmation.approvedVideoDisposition,
        assets: value.stagedAssets
      }) !== value.stagedAssetManifestFingerprint) {
    push(errors, `${path}.stagedAssetManifestFingerprint`, "必须由staged文件身份、首图、顺序和媒体要求重算");
  }
  if (value.status === "awaiting_verified_result" && value.transportResult !== null) {
    push(errors, `${path}.transportResult`, "等待阶段不得保存传输结果");
  }
  if (value.status === "verified") {
    const result = value.transportResult;
    validateAllowedKeys(result, [
      "schemaVersion", "resultRef", "jobId", "jobType", "candidateId", "skuPackageId", "revision",
      "workerId", "leaseId", "externalRequestRef", "externalRequestState", "payloadKind", "payload",
      "payloadFingerprint", "applicationDisposition", "recordedAt"
    ], `${path}.transportResult`, errors);
    const payload = result?.payload;
    const payloadFingerprint = isObject(payload) ? sha256(payload) : null;
    if (!isObject(result) || result.schemaVersion !== "software-job-result-envelope-v1" ||
        result.jobId !== job?.jobId || result.jobType !== job?.jobType || result.candidateId !== job?.candidateId ||
        result.skuPackageId !== job?.skuPackageId || result.revision !== job?.resultRevision ||
        result.externalRequestState !== "succeeded" || result.payloadKind !== "c2_stable_asset_transport" ||
        result.applicationDisposition !== "applied" || result.payloadFingerprint !== payloadFingerprint ||
        !isObject(payload) || payload.schemaVersion !== "c2-stable-asset-transport-result-v1" || payload.status !== "verified" ||
        payload.jobId !== job?.jobId || payload.candidateId !== job?.candidateId || payload.skuPackageId !== job?.skuPackageId ||
        payload.revision !== job?.resultRevision || payload.stagedAssetManifestFingerprint !== value.stagedAssetManifestFingerprint ||
        payload.finalManifestSha256 !== lifecycle.productionAuthorizationPreparation?.finalManifestSha256 || !isoDateTime(payload.verifiedAt) ||
        !Array.isArray(payload.assets) || payload.assets.length !== value.stagedAssets.length) {
      push(errors, `${path}.transportResult`, "完成阶段必须保存与job、staging和final manifest同源的已验证结果");
    }
    for (const [index, asset] of (payload?.assets || []).entries()) {
      const staged = value.stagedAssets[index];
      const assetPath = `${path}.transportResult.assets[${index}]`;
      validateAllowedKeys(asset, ["assetId", "sha256", "order", "role", "stableUrl", "stableUrlEvidenceRef"], assetPath, errors);
      let stableUrlValid = false;
      try {
        assertVerifiedStableUrl(asset?.stableUrl, [new URL(asset?.stableUrl).hostname.toLowerCase()], `${assetPath}.stableUrl`);
        stableUrlValid = true;
      } catch {
        stableUrlValid = false;
      }
      if (!staged || asset?.assetId !== staged.assetId || asset?.sha256 !== staged.sha256 || asset?.order !== staged.order ||
          asset?.role !== staged.role || !stableUrlValid ||
          !isOpaqueEvidenceRef(asset?.stableUrlEvidenceRef)) {
        push(errors, assetPath, "verified地址必须逐项保留staged文件身份、顺序和角色");
      }
    }
  }
}

export function validateC2AssetLifecycle(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: [{ path: "$", message: "必须是对象" }] };
  const canonicalReferenceErrors = collectCanonicalC2ReferenceErrors(value);
  errors.push(...canonicalReferenceErrors);
  if (canonicalReferenceErrors.some((item) => item.message === C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED)) {
    return { valid: false, errors };
  }
  try {
    assertNoRawPersistenceKeys(value, "$");
    assertNoProductionSecrets(value, "$");
  } catch (error) {
    push(errors, "$", error.message);
  }
  validateAllowedKeys(value, [
    "schemaVersion", "assetPackageId", "status", "createdAt", "updatedAt", "assets", "targetContext",
    "unknownManifest", "effectiveVideoRequirement", "ownerVideoRequirement", "ownerFinalUploadConfirmation",
    "productionAuthorizationPreparation", "dReadPolicy", "generationIntegrations", "platformUploads",
    "productionStarted", "softwareState", "stableAssetTransport"
  ], "$", errors);
  if (value.schemaVersion !== C2_ASSET_LIFECYCLE_VERSION) push(errors, "schemaVersion", `必须是${C2_ASSET_LIFECYCLE_VERSION}`);
  if (!nonEmptyString(value.assetPackageId)) push(errors, "assetPackageId", "必须是非空字符串");
  if (!["awaiting_final_uploads", "completed"].includes(value.status)) push(errors, "status", "状态无效");
  if (!isoDateTime(value.createdAt) || !isoDateTime(value.updatedAt)) push(errors, "createdAt", "必须保存有效时间");
  validateAssetRegions(value.assets, errors);
  validateStoredTargetContext(value.targetContext, value.unknownManifest, errors);
  if (value.softwareState === undefined) {
    push(errors, "softwareState", "必须提供冻结软件状态；旧记录需显式迁移");
  } else {
    validateSoftwareState(value.softwareState, errors);
  }
  if (value.softwareState !== undefined &&
      value.softwareState.sourceC1Fingerprint !== value.targetContext?.sourceC1Fingerprint) {
    push(errors, "softwareState.sourceC1Fingerprint", "必须与冻结目标绑定一致");
  }
  validateStableAssetTransport(value.stableAssetTransport, value, errors);
  if (!isObject(value.dReadPolicy)) {
    push(errors, "dReadPolicy", "必须是对象");
  } else {
    validateAllowedKeys(value.dReadPolicy, [
      "onlyAllowedArea", "collectedAllowed", "aiDraftsAllowed", "ownerConfirmationRequired"
    ], "dReadPolicy", errors);
    if (value.dReadPolicy.onlyAllowedArea !== "assets.finalUploads") push(errors, "dReadPolicy.onlyAllowedArea", "D只能读取assets.finalUploads");
    if (value.dReadPolicy.collectedAllowed !== false) push(errors, "dReadPolicy.collectedAllowed", "collected禁止进入D");
    if (value.dReadPolicy.aiDraftsAllowed !== false) push(errors, "dReadPolicy.aiDraftsAllowed", "aiDrafts禁止自动进入D");
    if (value.dReadPolicy.ownerConfirmationRequired !== true) push(errors, "dReadPolicy.ownerConfirmationRequired", "必须要求主人确认");
  }
  validateAllowedKeys(value.generationIntegrations, ["xiaohouzi", "otherAiTools"], "generationIntegrations", errors);
  if (!isObject(value.generationIntegrations) || value.generationIntegrations.xiaohouzi !== "not_connected" ||
      value.generationIntegrations.otherAiTools !== "not_connected") {
    push(errors, "generationIntegrations", "C2不得隐式连接图片生成集成");
  }
  if (value.platformUploads !== 0) push(errors, "platformUploads", "C2不得产生平台上传");
  if (value.productionStarted !== false) push(errors, "productionStarted", "C2不得启动生产");
  if (value.status === "awaiting_final_uploads") {
    if (value.ownerFinalUploadConfirmation !== null) push(errors, "ownerFinalUploadConfirmation", "等待阶段必须为null");
    if (Array.isArray(value.assets?.finalUploads) && value.assets.finalUploads.length !== 0) push(errors, "assets.finalUploads", "未确认前必须为空");
    if (value.softwareState !== undefined && value.softwareState.lifecycleStatus !== "c2_waiting_final_uploads") push(errors, "softwareState.lifecycleStatus", "等待最终素材时必须是c2_waiting_final_uploads");
    if (value.stableAssetTransport === null && value.effectiveVideoRequirement !== null) push(errors, "effectiveVideoRequirement", "创建staging清单前必须为null");
    if (value.stableAssetTransport === null && value.ownerVideoRequirement !== null) push(errors, "ownerVideoRequirement", "创建staging清单前必须为null");
    if (value.productionAuthorizationPreparation !== null) push(errors, "productionAuthorizationPreparation", "最终卡准备前必须为null");
    if (value.stableAssetTransport !== null && value.stableAssetTransport?.status !== "awaiting_verified_result") {
      push(errors, "stableAssetTransport", "未完成C2时transport slot必须等待唯一SoftwareJob验证结果");
    }
  }
  if (value.status === "completed") {
    if (value.stableAssetTransport !== null && value.stableAssetTransport?.status !== "verified") {
      push(errors, "stableAssetTransport", "传输路径完成C2时必须有verified结果");
    }
    const confirmation = value.ownerFinalUploadConfirmation;
    validateAllowedKeys(confirmation, [
      "status", "confirmedBy", "confirmedAt", "approvedManifestVersion", "approvedManifestSha256",
      "approvedAuthorizedMediaFingerprint", "approvedAssetIds", "approvedMainImageAssetId",
      "approvedVideoDisposition", "confirmationNote"
    ], "ownerFinalUploadConfirmation", errors);
    if (!isObject(confirmation) || confirmation.status !== "confirmed" || confirmation.confirmedBy !== "owner" || !isoDateTime(confirmation.confirmedAt)) {
      push(errors, "ownerFinalUploadConfirmation", "完成C2必须有主人确认记录");
    }
    if (confirmation?.approvedManifestVersion !== C2_FINAL_MANIFEST_VERSION || confirmation?.confirmationNote !== null) {
      push(errors, "ownerFinalUploadConfirmation", "主人确认必须锁定当前manifest版本且不得持久化自由文本备注");
    }
    if (!Array.isArray(value.assets?.finalUploads) || value.assets.finalUploads.length === 0) push(errors, "assets.finalUploads", "完成C2必须有最终上传素材");
    const finalIds = (value.assets?.finalUploads || []).map((asset) => asset.assetId);
    if (!Array.isArray(confirmation?.approvedAssetIds) || !sameJson(confirmation.approvedAssetIds, finalIds)) {
      push(errors, "ownerFinalUploadConfirmation.approvedAssetIds", "确认清单必须与最终上传素材完全一致且顺序一致");
    }
    // 主人确认的就是这批地址、这个顺序。第一张是主图，指纹按这批地址算。
    const mainImageId = value.assets?.finalUploads?.[0]?.assetId;
    let approvedMediaFingerprint = null;
    try {
      approvedMediaFingerprint = fingerprintAuthorizedMedia(value.assets?.finalUploads || []);
    } catch (error) {
      push(errors, "assets.finalUploads", error.message);
    }
    if (confirmation?.approvedMainImageAssetId !== mainImageId ||
        confirmation?.approvedAuthorizedMediaFingerprint !== approvedMediaFingerprint ||
        !["includes_video", "excludes_video"].includes(confirmation?.approvedVideoDisposition)) {
      push(errors, "ownerFinalUploadConfirmation", "主人确认必须锁定首图、实际授权图片地址清单和视频处置");
    }
    validateEffectiveVideoRequirement(value.effectiveVideoRequirement, errors);
    validateStoredOwnerVideoRequirement(value.ownerVideoRequirement, value.effectiveVideoRequirement, errors);
    validateAllowedKeys(value.productionAuthorizationPreparation, [
      "schemaVersion", "status", "skuPackageId", "sourceDataRevision", "resultDataRevision", "sourceC1Fingerprint",
      "authorizedMediaFingerprint", "finalManifestVersion", "finalManifestSha256", "finalUploadsFingerprint",
      "mainImageAssetId", "videoDisposition", "ownerConfirmationAt", "targetContext", "frozenC1Handoff",
      "finalUploads", "effectiveVideoRequirement", "ownerVideoRequirement", "ownerFinalUploadConfirmation",
      "finalCardInputSnapshot", "finalCardInputFingerprint", "ownerFinalCardAuthorizationDecision",
      "pendingAuthorizationInputs", "preparationFingerprint",
      "productionAuthorizationCreated", "dHandoffCreated"
    ], "productionAuthorizationPreparation", errors);
    const preparation = value.productionAuthorizationPreparation;
    validateStoredCanonicalC1Handoff(
      preparation?.frozenC1Handoff,
      "productionAuthorizationPreparation.frozenC1Handoff",
      value.targetContext,
      errors,
      preparation?.finalCardInputSnapshot?.c1Snapshot
    );
    validateStoredCanonicalC1Handoff(
      preparation?.finalCardInputSnapshot?.canonicalC1,
      "productionAuthorizationPreparation.finalCardInputSnapshot.canonicalC1",
      value.targetContext,
      errors,
      preparation?.finalCardInputSnapshot?.c1Snapshot
    );
    validateStoredFinalCardInputSnapshot(preparation?.finalCardInputSnapshot, preparation, errors);
    validateAllowedKeys(preparation?.targetContext, [
      "platform", "targetStore", "storeRef", "schemaRevision", "schemaEvidenceRef"
    ], "productionAuthorizationPreparation.targetContext", errors);
    if (!isObject(preparation) ||
        preparation.schemaVersion !== C2_AUTHORIZATION_PREPARATION_VERSION ||
        preparation.status !== "awaiting_final_card_approval" ||
        !Number.isInteger(preparation.sourceDataRevision) ||
        preparation.resultDataRevision !== preparation.sourceDataRevision + 1 ||
        preparation.sourceC1Fingerprint !== value.softwareState?.sourceC1Fingerprint ||
        preparation.authorizedMediaFingerprint !== approvedMediaFingerprint ||
        !sameJson(preparation.targetContext, {
          platform: value.targetContext?.platform,
          targetStore: value.targetContext?.targetStore,
          storeRef: value.targetContext?.storeRef,
          schemaRevision: value.targetContext?.schemaRevision,
          schemaEvidenceRef: value.targetContext?.schemaEvidenceRef
        }) ||
        preparation.finalManifestSha256 !== confirmation?.approvedManifestSha256 ||
        preparation.mainImageAssetId !== confirmation?.approvedMainImageAssetId ||
        preparation.videoDisposition !== confirmation?.approvedVideoDisposition ||
        !sameJson(preparation.finalUploads, value.assets?.finalUploads || []) ||
        !sameJson(preparation.effectiveVideoRequirement, value.effectiveVideoRequirement) ||
        !sameJson(preparation.ownerVideoRequirement, value.ownerVideoRequirement) ||
        !sameJson(preparation.ownerFinalUploadConfirmation, confirmation) ||
        !isObject(preparation.finalCardInputSnapshot) ||
        preparation.finalCardInputSnapshot.schemaVersion !== C2_FINAL_CARD_INPUT_SNAPSHOT_VERSION ||
        preparation.finalCardInputSnapshot.skuPackageId !== preparation.skuPackageId ||
        preparation.finalCardInputSnapshot.sourceDataRevision !== preparation.sourceDataRevision ||
        preparation.finalCardInputSnapshot.resultDataRevision !== preparation.resultDataRevision ||
        preparation.finalCardInputSnapshot.sourceC1Fingerprint !== preparation.sourceC1Fingerprint ||
        !isObject(preparation.finalCardInputSnapshot.c1Snapshot) ||
        preparation.finalCardInputSnapshot.identity?.platform !== preparation.targetContext?.platform ||
        preparation.finalCardInputSnapshot.identity?.storeRef?.stableStoreId !== preparation.targetContext?.targetStore ||
        preparation.finalCardInputSnapshot.identity?.storeRef?.stableStoreId !== preparation.targetContext?.storeRef ||
        preparation.finalCardInputSnapshot.c1Snapshot.identity?.skuPackageId !== preparation.skuPackageId ||
        fingerprintC1Snapshot(
          preparation.finalCardInputSnapshot.identity,
          preparation.finalCardInputSnapshot.c1Snapshot
        ) !== preparation.sourceC1Fingerprint ||
        !sameJson(preparation.finalCardInputSnapshot.identity, preparation.frozenC1Handoff.identity) ||
        !sameJson(preparation.finalCardInputSnapshot.canonicalC1, preparation.frozenC1Handoff) ||
        !canonicalDraftMatchesSnapshot(preparation.frozenC1Handoff.draftOnlySeo,
          preparation.finalCardInputSnapshot.c1Snapshot,
          preparation.finalCardInputSnapshot.identity, preparation.frozenC1Handoff.handoffRevisionRefs?.sourceRevision,
          preparation.frozenC1Handoff.frozenInputRefs?.profitModelVersion) ||
        !sameJson(preparation.finalCardInputSnapshot.c1Snapshot.keywordEvidenceRefs, preparation.frozenC1Handoff.keywordEvidenceRefs) ||
        preparation.frozenC1Handoff.handoffRevisionRefs?.sourceRevision !== value.softwareState?.sourceDataRevision ||
        preparation.frozenC1Handoff.handoffRevisionRefs?.resultRevision !== value.softwareState?.sourceDataRevision + 1 ||
        preparation.sourceDataRevision < preparation.frozenC1Handoff.handoffRevisionRefs?.resultRevision ||
        preparation.finalCardInputFingerprint !== fingerprintC2FinalCardInputSnapshot(preparation.finalCardInputSnapshot) ||
        preparation.ownerFinalCardAuthorizationDecision !== null ||
        !isObject(preparation.frozenC1Handoff) ||
        preparation.finalUploadsFingerprint !== fingerprintFinalUploads(value.assets?.finalUploads || []) ||
        preparation.finalManifestSha256 !== fingerprintC2FinalManifest({
          authorizedMediaFingerprint: approvedMediaFingerprint,
          effectiveVideoRequirement: value.effectiveVideoRequirement,
          mainImageAssetId: confirmation?.approvedMainImageAssetId,
          videoDisposition: confirmation?.approvedVideoDisposition,
          assets: value.assets?.finalUploads || []
        }) ||
        !sameJson(preparation.pendingAuthorizationInputs, createPendingProductionAuthorizationInputs()) ||
        preparation.preparationFingerprint !== fingerprintC2AuthorizationPreparation(preparation) ||
        preparation.productionAuthorizationCreated !== false || preparation.dHandoffCreated !== false) {
      push(errors, "productionAuthorizationPreparation", "C2完成后只能生成等待最终卡确认的不可变授权准备快照");
    }
    try {
      const normalized = normalizeC2FinalUploads({
        finalUploadAssets: value.assets.finalUploads,
        existingAssets: value.assets,
        effectiveVideoRequirement: value.effectiveVideoRequirement,
        addedAt: confirmation?.confirmedAt
      });
      if (!sameJson(normalized.assets, value.assets.finalUploads) ||
          normalized.videoDisposition !== confirmation?.approvedVideoDisposition ||
          normalized.authorizedMediaFingerprint !== confirmation?.approvedAuthorizedMediaFingerprint) {
        push(errors, "assets.finalUploads", "最终素材与主人确认的地址清单、顺序或视频处置不一致");
      }
    } catch (error) {
      push(errors, "assets.finalUploads", error.message);
    }
    if (value.softwareState !== undefined && value.softwareState.lifecycleStatus !== "c2_ready") push(errors, "softwareState.lifecycleStatus", "最终素材确认后必须是c2_ready");
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidC2AssetLifecycle(value) {
  const result = validateC2AssetLifecycle(value);
  const resourcePaths = [...new Set(result.errors
    .filter((item) => item.message === C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED ||
      item.message === PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)
    .map((item) => item.path))];
  if (resourcePaths.length > 0) {
    throw new Error(formatC2ReferenceDiagnostic(
      C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
      resourcePaths,
      "resource-limit"
    ));
  }
  const migrationPaths = [...new Set(result.errors
    .filter((item) => item.message === C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED)
    .map((item) => item.path))];
  if (migrationPaths.length > 0) {
    throw new Error(formatC2ReferenceDiagnostic(
      C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED,
      migrationPaths,
      "migration-required"
    ));
  }
  if (!result.valid) throw new Error(formatC2ReferenceDiagnostic(
    "C2素材包校验失败",
    result.errors.map((item) => item.path),
    "validation-failed"
  ));
  return value;
}

export function assertC2FrozenContractCurrent(skuPackage) {
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  const lifecycle = skuPackage.c2FinalAssets;
  if (!isObject(lifecycle.softwareState)) {
    throw new Error("C2_SOFTWARE_LEGACY_STATE_REQUIRES_MIGRATION: 历史C2缺少冻结软件合同");
  }
  assertValidC2AssetLifecycle(lifecycle);
  if (lifecycle.softwareState.technicalState.status !== "completed") {
    throw new Error("C2_SOFTWARE_TECHNICAL_FAILURE_BLOCKING: 技术失败状态禁止继续准备授权");
  }
  const sourceC1Fingerprint = fingerprintC2SourceC1(skuPackage);
  if (sourceC1Fingerprint !== lifecycle.softwareState.sourceC1Fingerprint) {
    throw new Error("C2_SOFTWARE_SOURCE_DRIFT: 当前C1事实、媒体要求或unknown清单已漂移");
  }
  const sourceContract = normalizeC2TargetContract(skuPackage);
  const currentContract = lifecycle.status === "completed"
    ? bindC2TargetContractToSourceRevision(sourceContract, skuPackage.dataRevision - 1)
    : sourceContract;
  if (!sameJson(currentContract.targetContext, lifecycle.targetContext) ||
      !sameJson(currentContract.unknownManifest, lifecycle.unknownManifest)) {
    throw new Error("C2_TARGET_CONTEXT_DRIFT: 当前平台、storeRef或冻结Schema证据已漂移");
  }
  if (fingerprintC2AssetManifest(lifecycle.assets) !== lifecycle.softwareState.assetManifestFingerprint) {
    throw new Error("C2_SOFTWARE_ASSET_MANIFEST_CONFLICT: 已冻结素材身份或版本已漂移");
  }
  if (lifecycle.status === "completed") {
    const confirmation = lifecycle.ownerFinalUploadConfirmation;
    const preparation = lifecycle.productionAuthorizationPreparation;
    if (preparation.skuPackageId !== skuPackage.skuPackageId ||
        preparation.resultDataRevision !== skuPackage.dataRevision ||
        preparation.resultDataRevision !== preparation.sourceDataRevision + 1 ||
        preparation.ownerConfirmationAt !== confirmation.confirmedAt ||
        preparation.finalManifestVersion !== C2_FINAL_MANIFEST_VERSION ||
        !sameJson(preparation.frozenC1Handoff, currentContract.canonicalC1) ||
        preparation.preparationFingerprint !== fingerprintC2AuthorizationPreparation(preparation) ||
        (lifecycle.ownerVideoRequirement !== null &&
         (lifecycle.ownerVideoRequirement.skuPackageId !== skuPackage.skuPackageId ||
          lifecycle.ownerVideoRequirement.sourceDataRevision !== preparation.sourceDataRevision))) {
      throw new Error("C2_AUTHORIZATION_PREPARATION_DRIFT: 授权准备与当前SKU、revision、主人确认或manifest版本不一致");
    }
    validateProductionAuthorizationPreparation({
      preparation,
      candidateId: skuPackage.g1Identity.candidateId,
      skuPackage
    });
  }
  return currentContract;
}

export function resolveC2FinalConfirmationTargetContract(skuPackage) {
  const currentContract = assertC2FrozenContractCurrent(skuPackage);
  return skuPackage.c2FinalAssets.status === "completed"
    ? currentContract
    : bindC2TargetContractToSourceRevision(currentContract, skuPackage.dataRevision);
}

function assertCanonicalNewAnalysisAssetReferences(asset, path, referenceFields) {
  assertCanonicalAnalysisAssetRef(asset?.assetRef, `${path}.assetRef`);
  for (const [field, value] of referenceFields) {
    assertCanonicalFrozenRef(value, `${path}.${field}`);
  }
}

function normalizeCollectedAsset(asset, addedAt) {
  assertCanonicalNewAnalysisAssetReferences(asset, "assets.collected", [
    ["assetId", asset?.assetId],
    ["sourceEvidenceRef", asset?.sourceEvidenceRef],
    ["usageAuthorization.evidenceRef", asset?.usageAuthorization?.evidenceRef]
  ]);
  assertNoProductionSecrets(asset, "assets.collected");
  assertNoRawPersistenceKeys(asset, "assets.collected");
  if (!nonEmptyString(asset.assetVersion)) throw new Error("C2_ASSET_INPUT_GAP: collected必须锁定素材版本");
  assertSha256(asset.sha256, "assets.collected.sha256");
  if (!isObject(asset.usageAuthorization) || asset.usageAuthorization.status !== "analysis_reference_only" ||
      !nonEmptyString(asset.usageAuthorization.evidenceRef)) {
    throw new Error("C2_ASSET_INPUT_GAP: collected必须锁定分析用途授权证据");
  }
  return {
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    assetRef: asset.assetRef,
    sourcePlatform: asset.sourcePlatform,
    sourceEvidenceRef: asset.sourceEvidenceRef,
    assetVersion: asset.assetVersion || null,
    sha256: asset.sha256 || null,
    usageAuthorization: { status: "analysis_reference_only", evidenceRef: asset.usageAuthorization.evidenceRef },
    addedAt: asset.addedAt || addedAt,
    lifecycleArea: "collected",
    usagePolicy: "analysis_reference_only",
    productionEligible: false
  };
}

function normalizeAiDraftAsset(asset, addedAt) {
  assertCanonicalNewAnalysisAssetReferences(asset, "assets.aiDrafts", [
    ["assetId", asset?.assetId],
    ["generatorRef", asset?.generatorRef],
    ["sourceEvidenceRef", asset?.sourceEvidenceRef],
    ["usageAuthorization.evidenceRef", asset?.usageAuthorization?.evidenceRef]
  ]);
  assertNoProductionSecrets(asset, "assets.aiDrafts");
  assertNoRawPersistenceKeys(asset, "assets.aiDrafts");
  if (!nonEmptyString(asset.assetVersion)) throw new Error("C2_ASSET_INPUT_GAP: aiDrafts必须锁定素材版本");
  assertSha256(asset.sha256, "assets.aiDrafts.sha256");
  if (!isObject(asset.usageAuthorization) || asset.usageAuthorization.status !== "draft_reference_only" ||
      !nonEmptyString(asset.usageAuthorization.evidenceRef)) {
    throw new Error("C2_ASSET_INPUT_GAP: aiDrafts必须锁定草稿用途授权证据");
  }
  return {
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    assetRef: asset.assetRef,
    assetVersion: asset.assetVersion || null,
    sha256: asset.sha256 || null,
    sourceType: "ai_generated_draft",
    generatorRef: asset.generatorRef,
    sourceEvidenceRef: asset.sourceEvidenceRef || null,
    usageAuthorization: { status: "draft_reference_only", evidenceRef: asset.usageAuthorization.evidenceRef },
    addedAt: asset.addedAt || addedAt,
    lifecycleArea: "aiDrafts",
    productionEligible: false
  };
}

export function createC2AssetLifecycle({ skuPackage, collectedAssets = [], aiDraftAssets = [], createdAt }) {
  assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt: createdAt });
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertValidC1ProductPlan(skuPackage.c1ProductPlan);
  if (skuPackage.businessPhase !== "C1" || skuPackage.c1ProductPlan.status !== "seo_draft_ready") {
    throw new Error("C2_ASSET_GATE_REJECTED: C1 SEO草稿尚未准备完成");
  }
  if (skuPackage.c2FinalAssets !== null) throw new Error("C2_ASSET_GATE_REJECTED: C2素材包已经存在");
  if (!isoDateTime(createdAt)) throw new Error("C2_ASSET_INPUT_GAP: 创建时间无效");
  if (!Array.isArray(collectedAssets) || !Array.isArray(aiDraftAssets)) throw new Error("C2_ASSET_INPUT_GAP: 素材区域必须是数组");

  const targetContract = normalizeC2TargetContract(skuPackage);
  const normalizedCollected = collectedAssets.map((asset) => normalizeCollectedAsset(asset, createdAt));
  const normalizedAiDrafts = aiDraftAssets.map((asset) => normalizeAiDraftAsset(asset, createdAt));
  const sourceC1Fingerprint = fingerprintC2SourceC1(skuPackage);

  const lifecycle = {
    schemaVersion: C2_ASSET_LIFECYCLE_VERSION,
    assetPackageId: `c2-assets:${skuPackage.skuPackageId}`,
    status: "awaiting_final_uploads",
    createdAt,
    updatedAt: createdAt,
    assets: {
      collected: normalizedCollected,
      aiDrafts: normalizedAiDrafts,
      finalUploads: []
    },
    targetContext: structuredClone(targetContract.targetContext),
    unknownManifest: structuredClone(targetContract.unknownManifest),
    effectiveVideoRequirement: null,
    ownerVideoRequirement: null,
    ownerFinalUploadConfirmation: null,
    productionAuthorizationPreparation: null,
    stableAssetTransport: null,
    dReadPolicy: {
      onlyAllowedArea: "assets.finalUploads",
      collectedAllowed: false,
      aiDraftsAllowed: false,
      ownerConfirmationRequired: true
    },
    generationIntegrations: {
      xiaohouzi: "not_connected",
      otherAiTools: "not_connected"
    },
    platformUploads: 0,
    productionStarted: false,
    softwareState: {
      schemaVersion: C2_SOFTWARE_STATE_VERSION,
      lifecycleStatus: "c2_waiting_final_uploads",
      sourceDataRevision: skuPackage.dataRevision,
      sourceC1Fingerprint,
      assetManifestFingerprint: fingerprintC2AssetManifest({ collected: normalizedCollected, aiDrafts: normalizedAiDrafts, finalUploads: [] }),
      executionPolicy: {
        externalAccessAllowed: false,
        imageGenerationAllowed: false,
        codexDispatchAllowed: false,
        productionAllowed: false,
        automaticRetry: false
      },
      technicalState: { status: "completed", failure: null, automaticRetry: false }
    }
  };
  assertValidC2AssetLifecycle(lifecycle);

  const c1Before = structuredClone(skuPackage.c1ProductPlan);
  const profitBefore = structuredClone(skuPackage.profitModels);
  const next = structuredClone(skuPackage);
  next.c2FinalAssets = lifecycle;
  next.dataRevision += 1;
  next.businessPhase = "C2";
  next.businessResult = "pending";
  next.technicalStatus = "completed";
  next.ownerAction = "provide_final_assets";
  next.audit.updatedAt = createdAt;
  next.audit.history.push({
    event: "c2_asset_lifecycle_created",
    at: createdAt,
    collectedCount: lifecycle.assets.collected.length,
    aiDraftCount: lifecycle.assets.aiDrafts.length,
    finalUploadCount: 0,
    xiaohouziConnected: false,
    platformUploads: 0,
    productionStarted: false
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`C2素材生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  if (!sameJson(c1Before, next.c1ProductPlan) || !sameJson(profitBefore, next.profitModels)) {
    throw new Error("C2_ASSET_PROTECTED_DATA_CHANGED: 商品事实、SEO草稿或利润被改写");
  }
  return deepFreeze({ flowVersion: "c2-asset-lifecycle-flow-v1.1", skuPackage: next, c2AssetLifecycle: next.c2FinalAssets });
}

export function addAiDraftAssets({ skuPackage, aiDraftAssets, addedAt }) {
  assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt: addedAt });
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  assertC2FrozenContractCurrent(skuPackage);
  if (skuPackage.c2FinalAssets.status !== "awaiting_final_uploads") throw new Error("C2_ASSET_GATE_REJECTED: 已完成的素材包不能追加AI草稿");
  if (!Array.isArray(aiDraftAssets) || !isoDateTime(addedAt)) throw new Error("C2_ASSET_INPUT_GAP: AI草稿输入无效");
  const next = structuredClone(skuPackage);
  next.c2FinalAssets.assets.aiDrafts.push(...aiDraftAssets.map((asset) => ({
    ...normalizeAiDraftAsset(asset, addedAt)
  })));
  next.c2FinalAssets.updatedAt = addedAt;
  next.c2FinalAssets.softwareState.assetManifestFingerprint = fingerprintC2AssetManifest(next.c2FinalAssets.assets);
  next.dataRevision += 1;
  next.audit.updatedAt = addedAt;
  next.audit.history.push({ event: "c2_ai_drafts_added_without_promotion", at: addedAt, count: aiDraftAssets.length, finalUploadsChanged: false });
  assertValidC2AssetLifecycle(next.c2FinalAssets);
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error("C2素材生命周期转换失败");
  return deepFreeze({ flowVersion: "c2-ai-draft-flow-v1.1", skuPackage: next, c2AssetLifecycle: next.c2FinalAssets });
}

export function confirmFinalUploads({
  skuPackage,
  finalUploadAssets,
  ownerVideoRequirement = null,
  ownerDecision,
  confirmedAt,
  observedAt = confirmedAt
}) {
  assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt });
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  if (skuPackage.c2FinalAssets.status !== "awaiting_final_uploads") throw new Error("C2_ASSET_GATE_REJECTED: 最终素材已经确认");
  if (!isObject(ownerDecision) || ownerDecision.status !== "confirmed" || ownerDecision.confirmedBy !== "owner") {
    throw new Error("C2_OWNER_CONFIRMATION_REQUIRED: finalUploads必须由主人明确确认");
  }
  assertNoRawPersistenceKeys(ownerDecision, "ownerDecision");
  assertNoProductionSecrets(ownerDecision, "ownerDecision");
  if (ownerDecision.confirmationNote !== undefined && ownerDecision.confirmationNote !== null) {
    throw new Error("C2_SENSITIVE_INPUT_REJECTED: 主人确认不得持久化自由文本备注");
  }
  if (!isoDateTime(confirmedAt)) throw new Error("C2_ASSET_INPUT_GAP: 确认时间无效");
  const targetContract = resolveC2FinalConfirmationTargetContract(skuPackage);
  const normalizedOwnerVideoRequirement = normalizeC2OwnerVideoRequirement(ownerVideoRequirement, skuPackage);
  const effectiveVideoRequirement = resolveC2EffectiveVideoRequirement({
    skuPackage,
    ownerVideoRequirement: normalizedOwnerVideoRequirement
  });
  const videoErrors = [];
  validateEffectiveVideoRequirement(effectiveVideoRequirement, videoErrors);
  if (videoErrors.length > 0) throw new Error("C2_VIDEO_REQUIREMENT_INVALID: 最终视频要求无效");
  const normalized = normalizeC2FinalUploads({
    finalUploadAssets,
    existingAssets: skuPackage.c2FinalAssets.assets,
    effectiveVideoRequirement,
    addedAt: observedAt
  });
  const approvedAssetIds = normalized.assets.map((asset) => asset.assetId);
  const expectedManifestSha256 = fingerprintC2FinalManifest({
    authorizedMediaFingerprint: normalized.authorizedMediaFingerprint,
    effectiveVideoRequirement,
    mainImageAssetId: normalized.mainImageAssetId,
    videoDisposition: normalized.videoDisposition,
    assets: normalized.assets
  });
  // 主人确认的是这一批公网地址、这个顺序：地址清单指纹必须由主人自己带过来对上。
  if (!sameJson(ownerDecision.approvedAssetIds, approvedAssetIds) ||
      ownerDecision.approvedMainImageAssetId !== normalized.mainImageAssetId ||
      ownerDecision.approvedAuthorizedMediaFingerprint !== normalized.authorizedMediaFingerprint ||
      ownerDecision.approvedVideoDisposition !== normalized.videoDisposition ||
      ownerDecision.approvedManifestVersion !== C2_FINAL_MANIFEST_VERSION ||
      ownerDecision.approvedManifestSha256 !== expectedManifestSha256) {
    throw new Error("C2_OWNER_CONFIRMATION_REQUIRED: 主人确认必须锁定图片地址清单、首图、顺序和视频处置");
  }

  const next = structuredClone(skuPackage);
  next.c2FinalAssets.targetContext = structuredClone(targetContract.targetContext);
  next.c2FinalAssets.assets.finalUploads = structuredClone(normalized.assets);
  next.c2FinalAssets.effectiveVideoRequirement = structuredClone(effectiveVideoRequirement);
  next.c2FinalAssets.ownerVideoRequirement = structuredClone(normalizedOwnerVideoRequirement);
  const frozenOwnerConfirmation = {
    status: "confirmed",
    confirmedBy: "owner",
    confirmedAt,
    approvedManifestVersion: ownerDecision.approvedManifestVersion,
    approvedManifestSha256: ownerDecision.approvedManifestSha256,
    approvedAuthorizedMediaFingerprint: ownerDecision.approvedAuthorizedMediaFingerprint,
    approvedAssetIds,
    approvedMainImageAssetId: normalized.mainImageAssetId,
    approvedVideoDisposition: normalized.videoDisposition,
    confirmationNote: null
  };
  next.c2FinalAssets.ownerFinalUploadConfirmation = structuredClone(frozenOwnerConfirmation);
  const finalCardInputSnapshot = buildFinalCardInputSnapshot(skuPackage, targetContract.canonicalC1);
  const preparation = {
    schemaVersion: C2_AUTHORIZATION_PREPARATION_VERSION,
    status: "awaiting_final_card_approval",
    skuPackageId: skuPackage.skuPackageId,
    sourceDataRevision: skuPackage.dataRevision,
    resultDataRevision: skuPackage.dataRevision + 1,
    sourceC1Fingerprint: targetContract.targetContext.sourceC1Fingerprint,
    authorizedMediaFingerprint: normalized.authorizedMediaFingerprint,
    finalManifestVersion: ownerDecision.approvedManifestVersion,
    finalManifestSha256: ownerDecision.approvedManifestSha256,
    finalUploadsFingerprint: fingerprintFinalUploads(normalized.assets),
    mainImageAssetId: normalized.mainImageAssetId,
    videoDisposition: normalized.videoDisposition,
    ownerConfirmationAt: confirmedAt,
    targetContext: {
      platform: targetContract.targetContext.platform,
      targetStore: targetContract.targetContext.targetStore,
      storeRef: targetContract.targetContext.storeRef,
      schemaRevision: targetContract.targetContext.schemaRevision,
      schemaEvidenceRef: targetContract.targetContext.schemaEvidenceRef
    },
    frozenC1Handoff: structuredClone(targetContract.canonicalC1),
    finalUploads: structuredClone(normalized.assets),
    effectiveVideoRequirement: structuredClone(effectiveVideoRequirement),
    ownerVideoRequirement: structuredClone(normalizedOwnerVideoRequirement),
    ownerFinalUploadConfirmation: structuredClone(frozenOwnerConfirmation),
    finalCardInputSnapshot,
    finalCardInputFingerprint: fingerprintC2FinalCardInputSnapshot(finalCardInputSnapshot),
    ownerFinalCardAuthorizationDecision: null,
    pendingAuthorizationInputs: createPendingProductionAuthorizationInputs(),
    productionAuthorizationCreated: false,
    dHandoffCreated: false
  };
  preparation.preparationFingerprint = fingerprintC2AuthorizationPreparation(preparation);
  next.c2FinalAssets.productionAuthorizationPreparation = preparation;
  next.c2FinalAssets.status = "completed";
  next.c2FinalAssets.updatedAt = confirmedAt;
  next.c2FinalAssets.softwareState.lifecycleStatus = "c2_ready";
  next.c2FinalAssets.softwareState.assetManifestFingerprint = fingerprintC2AssetManifest(next.c2FinalAssets.assets);
  next.c2FinalAssets.softwareState.technicalState = { status: "completed", failure: null, automaticRetry: false };
  next.dataRevision += 1;
  next.businessResult = "pending";
  next.technicalStatus = "completed";
  next.ownerAction = "authorize_production";
  next.audit.updatedAt = confirmedAt;
  next.audit.history.push({
    event: "c2_final_uploads_owner_confirmed",
    at: confirmedAt,
    approvedAssetIds,
    approvedMainImageAssetId: normalized.mainImageAssetId,
    videoDisposition: normalized.videoDisposition,
    collectedPromoted: false,
    aiDraftsPromoted: false,
    productionAuthorizationCreated: false,
    dHandoffCreated: false,
    platformUploads: 0,
    productionStarted: false
  });
  assertValidC2AssetLifecycle(next.c2FinalAssets);
  validateProductionAuthorizationPreparation({
    preparation: next.c2FinalAssets.productionAuthorizationPreparation,
    candidateId: next.g1Identity.candidateId,
    skuPackage: next
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`C2素材生命周期转换失败：${transition.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return deepFreeze({ flowVersion: "c2-final-upload-confirmation-flow-v1.1", skuPackage: next, c2AssetLifecycle: next.c2FinalAssets });
}

function normalizeStagedAssets({ stagedAssets, effectiveVideoRequirement }) {
  if (!Array.isArray(stagedAssets) || stagedAssets.length === 0) throw new Error("C2_STAGED_ASSET_INVALID: stagedAssets不能为空");
  const normalized = stagedAssets.map((asset, index) => {
    const path = `stagedAssets[${index}]`;
    assertNoRawPersistenceKeys(asset, path);
    assertNoProductionSecrets(asset, path);
    const allowed = new Set([
      "assetId", "mediaType", "fileName", "assetVersion", "sha256", "sourceEvidenceRef", "usageAuthorization",
      "sourceType", "order", "role", "byteSize", "width", "height"
    ]);
    const derivedRole = index === 0 ? "main_image" : "gallery_image";
    if (!isObject(asset) || Object.keys(asset).some((key) => !allowed.has(key)) || Object.hasOwn(asset, "assetRef") ||
        !nonEmptyString(asset.assetId) || !ASSET_MEDIA_TYPES.includes(asset.mediaType) || !nonEmptyString(asset.fileName) ||
        asset.fileName === "." || asset.fileName === ".." || /[\\/\u0000-\u001f]/.test(asset.fileName) ||
        !nonEmptyString(asset.assetVersion) || !/^[a-f0-9]{64}$/.test(String(asset.sha256 || "")) ||
        !nonEmptyString(asset.sourceEvidenceRef) || asset.sourceType !== "owner_provided_final_upload" ||
        !Number.isInteger(asset.order) || asset.order !== index + 1 ||
        (asset.role !== undefined && asset.role !== derivedRole)) {
      throw new Error(`C2_STAGED_ASSET_INVALID: ${path}文件身份或顺序无效`);
    }
    assertFinalUploadEvidenceRef(asset.sourceEvidenceRef, `${path}.sourceEvidenceRef`);
    const usageAuthorization = normalizeListingAuthorization(asset.usageAuthorization, `${path}.usageAuthorization`);
    for (const field of ["byteSize", "width", "height"]) {
      if (asset[field] !== undefined && asset[field] !== null && (!Number.isFinite(asset[field]) || asset[field] < 0)) {
        throw new Error(`C2_STAGED_ASSET_INVALID: ${path}.${field}无效`);
      }
    }
    return {
      assetId: asset.assetId, mediaType: asset.mediaType, fileName: asset.fileName, assetVersion: asset.assetVersion,
      sha256: asset.sha256, sourceEvidenceRef: asset.sourceEvidenceRef, usageAuthorization,
      sourceType: "owner_provided_final_upload", order: asset.order, role: derivedRole,
      byteSize: Number.isFinite(asset.byteSize) ? asset.byteSize : null,
      width: Number.isFinite(asset.width) ? asset.width : null,
      height: Number.isFinite(asset.height) ? asset.height : null
    };
  });
  if (new Set(normalized.map((asset) => asset.assetId)).size !== normalized.length ||
      new Set(normalized.map((asset) => asset.sha256)).size !== normalized.length) throw new Error("C2_STAGED_ASSET_INVALID: 文件身份不得重复");
  const main = normalized.filter((asset) => asset.role === "main_image");
  if (main.length !== 1 || main[0].order !== 1 || main[0].mediaType !== "image") throw new Error("C2_STAGED_ASSET_INVALID: 首图无效");
  const hasVideo = normalized.some((asset) => asset.mediaType === "video");
  if (effectiveVideoRequirement.status === "required" && !hasVideo) throw new Error("C2_VIDEO_REQUIRED: staged清单缺少必填视频");
  return { assets: normalized, mainImageAssetId: main[0].assetId, videoDisposition: hasVideo ? "includes_video" : "excludes_video" };
}

export function stageC2StableAssetTransport({
  skuPackage,
  stagedAssets,
  ownerVideoRequirement = null,
  ownerStagingConfirmation,
  jobRef,
  stagedAt
}) {
  assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt: stagedAt });
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  assertC2FrozenContractCurrent(skuPackage);
  if (skuPackage.c2FinalAssets.status !== "awaiting_final_uploads" || skuPackage.c2FinalAssets.stableAssetTransport !== null) {
    throw new Error("C2_STABLE_TRANSPORT_CONFLICT");
  }
  if (!isoDateTime(stagedAt) || !isObject(jobRef) || jobRef.schemaVersion !== "c2-stable-asset-transport-job-ref-v1" ||
      jobRef.jobType !== "c2_stable_asset_transport" || jobRef.skuPackageId !== skuPackage.skuPackageId ||
      jobRef.candidateId !== skuPackage.g1Identity.candidateId || jobRef.resultRevision !== jobRef.sourceRevision + 1 ||
      !/^[a-f0-9]{64}$/.test(String(jobRef.inputFingerprint || ""))) throw new Error("C2_STABLE_TRANSPORT_JOB_REF_INVALID");
  const prepared = prepareC2StableAssetTransportManifest({ skuPackage, stagedAssets, ownerVideoRequirement });
  const { targetContract, normalizedOwnerVideoRequirement, effectiveVideoRequirement, staged, stagedAssetManifestFingerprint: fingerprint } = prepared;
  assertNoRawPersistenceKeys(ownerStagingConfirmation, "ownerStagingConfirmation");
  assertNoProductionSecrets(ownerStagingConfirmation, "ownerStagingConfirmation");
  if (!isObject(ownerStagingConfirmation) || ownerStagingConfirmation.schemaVersion !== "c2-owner-staging-confirmation-v1" ||
      ownerStagingConfirmation.status !== "confirmed" || ownerStagingConfirmation.confirmedBy !== "owner" ||
      !nonEmptyString(ownerStagingConfirmation.confirmedByUserId) || !isoDateTime(ownerStagingConfirmation.confirmedAt)) {
    throw new Error("C2_OWNER_STAGING_CONFIRMATION_REQUIRED: 主人身份或时间无效");
  }
  if (!isOpaqueEvidenceRef(ownerStagingConfirmation.confirmationRef)) {
    throw new Error("C2_OWNER_STAGING_CONFIRMATION_REQUIRED: confirmationRef无效");
  }
  if (ownerStagingConfirmation.approvedStagedAssetManifestFingerprint !== fingerprint ||
      ownerStagingConfirmation.approvedSourceC1Fingerprint !== targetContract.targetContext.sourceC1Fingerprint ||
      !sameJson(ownerStagingConfirmation.approvedAssetIds, staged.assets.map((asset) => asset.assetId)) ||
      ownerStagingConfirmation.approvedMainImageAssetId !== staged.mainImageAssetId ||
      ownerStagingConfirmation.approvedVideoDisposition !== staged.videoDisposition) {
    throw new Error("C2_OWNER_STAGING_CONFIRMATION_REQUIRED: staging清单绑定漂移");
  }
  const next = structuredClone(skuPackage);
  next.c2FinalAssets.updatedAt = stagedAt;
  next.c2FinalAssets.effectiveVideoRequirement = structuredClone(effectiveVideoRequirement);
  next.c2FinalAssets.ownerVideoRequirement = structuredClone(normalizedOwnerVideoRequirement);
  next.c2FinalAssets.stableAssetTransport = {
    schemaVersion: C2_STABLE_ASSET_TRANSPORT_VERSION,
    status: "awaiting_verified_result",
    jobRef: structuredClone(jobRef),
    stagedAssetManifestFingerprint: fingerprint,
    stagedAssets: structuredClone(staged.assets),
    ownerStagingConfirmation: structuredClone(ownerStagingConfirmation),
    transportResult: null
  };
  next.dataRevision += 1;
  next.ownerAction = "none";
  next.audit.updatedAt = stagedAt;
  next.audit.history.push({
    event: "c2_stable_asset_transport_staged", at: stagedAt, jobId: jobRef.jobId,
    stagedAssetManifestFingerprint: fingerprint, productionAuthorizationCreated: false, dHandoffCreated: false,
    platformUploads: 0, productionStarted: false
  });
  assertValidC2AssetLifecycle(next.c2FinalAssets);
  return deepFreeze({ flowVersion: "c2-stable-asset-transport-staging-flow-v1", skuPackage: next, c2AssetLifecycle: next.c2FinalAssets });
}

export function prepareC2StableAssetTransportManifest({ skuPackage, stagedAssets, ownerVideoRequirement = null }) {
  assertC2HasNoDownstreamState(skuPackage);
  assertValidLifecyclePackage(skuPackage);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  assertC2FrozenContractCurrent(skuPackage);
  const targetContract = resolveC2FinalConfirmationTargetContract(skuPackage);
  const normalizedOwnerVideoRequirement = normalizeC2OwnerVideoRequirement(ownerVideoRequirement, skuPackage);
  const effectiveVideoRequirement = resolveC2EffectiveVideoRequirement({
    skuPackage, ownerVideoRequirement: normalizedOwnerVideoRequirement
  });
  const staged = normalizeStagedAssets({ stagedAssets, effectiveVideoRequirement });
  const stagedAssetManifestFingerprint = fingerprintC2StagedAssetManifest({
    sourceC1Fingerprint: targetContract.targetContext.sourceC1Fingerprint,
    effectiveVideoRequirement,
    mainImageAssetId: staged.mainImageAssetId,
    videoDisposition: staged.videoDisposition,
    assets: staged.assets
  });
  return deepFreeze({ targetContract, normalizedOwnerVideoRequirement, effectiveVideoRequirement, staged, stagedAssetManifestFingerprint });
}

function assertVerifiedStableUrl(value, allowedHosts, path) {
  assertStableFinalAssetUrl(value, path);
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || url.search || url.hash || url.port ||
      isReservedStableAssetHost(host) || !allowedHosts.includes(host)) {
    throw new Error(`C2_STABLE_TRANSPORT_RESULT_INVALID: ${path}不是批准的无凭据稳定HTTPS地址`);
  }
}

export function validateC2StableAssetTransportResult({ skuPackage, jobRef, transportResultEnvelope, allowedStableAssetHosts, settledAt }) {
  assertC2HasNoDownstreamState(skuPackage);
  assertValidC2AssetLifecycle(skuPackage.c2FinalAssets);
  const state = skuPackage.c2FinalAssets.stableAssetTransport;
  if (skuPackage.c2FinalAssets.status !== "awaiting_final_uploads" || state?.status !== "awaiting_verified_result" ||
      !sameJson(state.jobRef, jobRef)) throw new Error("C2_STABLE_TRANSPORT_JOB_REF_CONFLICT");
  const allowedEnvelopeKeys = [
    "schemaVersion", "resultRef", "jobId", "jobType", "candidateId", "skuPackageId", "revision",
    "workerId", "leaseId", "externalRequestRef", "externalRequestState", "payloadKind", "payload",
    "payloadFingerprint", "applicationDisposition", "recordedAt"
  ];
  const transportResult = transportResultEnvelope?.payload;
  const transportResultFingerprint = isObject(transportResult) ? sha256(transportResult) : null;
  const allowedResultKeys = [
    "assets", "candidateId", "finalManifestSha256", "jobId", "revision", "schemaVersion",
    "skuPackageId", "stagedAssetManifestFingerprint", "status", "verifiedAt"
  ];
  if (!Array.isArray(allowedStableAssetHosts) || allowedStableAssetHosts.length === 0 ||
      !isObject(transportResultEnvelope) || transportResultEnvelope.schemaVersion !== "software-job-result-envelope-v1" ||
      Object.keys(transportResultEnvelope).some((key) => !allowedEnvelopeKeys.includes(key)) ||
      transportResultEnvelope.jobId !== jobRef.jobId || transportResultEnvelope.jobType !== jobRef.jobType ||
      transportResultEnvelope.candidateId !== jobRef.candidateId || transportResultEnvelope.skuPackageId !== jobRef.skuPackageId ||
      transportResultEnvelope.revision !== jobRef.resultRevision || transportResultEnvelope.externalRequestState !== "succeeded" ||
      transportResultEnvelope.payloadKind !== "c2_stable_asset_transport" ||
      transportResultEnvelope.applicationDisposition !== "applied" ||
      transportResultEnvelope.payloadFingerprint !== transportResultFingerprint ||
      !isObject(transportResult) || transportResult.schemaVersion !== "c2-stable-asset-transport-result-v1" ||
      Object.keys(transportResult).some((key) => !allowedResultKeys.includes(key)) ||
      transportResult.status !== "verified" || transportResult.jobId !== jobRef.jobId ||
      transportResult.candidateId !== jobRef.candidateId || transportResult.skuPackageId !== jobRef.skuPackageId ||
      transportResult.stagedAssetManifestFingerprint !== state.stagedAssetManifestFingerprint ||
      transportResult.revision !== jobRef.resultRevision || !Array.isArray(transportResult.assets) ||
      transportResult.assets.length !== state.stagedAssets.length ||
      !isoDateTime(transportResult.verifiedAt) || !isoDateTime(transportResultEnvelope.recordedAt) ||
      Date.parse(transportResult.verifiedAt) < Date.parse(state.ownerStagingConfirmation.confirmedAt) ||
      Date.parse(transportResult.verifiedAt) > Date.parse(transportResultEnvelope.recordedAt) ||
      Date.parse(transportResultEnvelope.recordedAt) > Date.parse(settledAt) ||
      !/^[a-f0-9]{64}$/.test(String(transportResult.finalManifestSha256 || "")) || !isoDateTime(settledAt)) {
    throw new Error("C2_STABLE_TRANSPORT_RESULT_INVALID");
  }
  assertNoRawPersistenceKeys(transportResultEnvelope, "transportResultEnvelope");
  assertNoProductionSecrets(transportResultEnvelope, "transportResultEnvelope");
  const finalAssets = transportResult.assets.map((asset, index) => {
    const staged = state.stagedAssets[index];
    const path = `transportResult.assets[${index}]`;
    const allowed = ["assetId", "sha256", "order", "role", "stableUrl", "stableUrlEvidenceRef"];
    if (!isObject(asset) || Object.keys(asset).some((key) => !allowed.includes(key)) ||
        asset.assetId !== staged.assetId || asset.sha256 !== staged.sha256 || asset.order !== staged.order ||
        asset.role !== staged.role || !nonEmptyString(asset.stableUrlEvidenceRef)) {
      throw new Error(`C2_STABLE_TRANSPORT_RESULT_INVALID: ${path}与staging身份不一致`);
    }
    assertVerifiedStableUrl(asset.stableUrl, allowedStableAssetHosts, `${path}.stableUrl`);
    assertFinalUploadEvidenceRef(asset.stableUrlEvidenceRef, `${path}.stableUrlEvidenceRef`);
    return {
      ...structuredClone(staged), assetRef: asset.stableUrl, stableUrlEvidenceRef: asset.stableUrlEvidenceRef
    };
  });
  const target = bindC2TargetContractToSourceRevision(
    normalizeC2TargetContract(skuPackage),
    skuPackage.dataRevision
  ).targetContext;
  const effective = resolveC2EffectiveVideoRequirement({
    skuPackage,
    ownerVideoRequirement: skuPackage.c2FinalAssets.ownerVideoRequirement
  });
  const normalized = normalizeC2FinalUploads({
    finalUploadAssets: finalAssets,
    existingAssets: skuPackage.c2FinalAssets.assets,
    effectiveVideoRequirement: effective,
    addedAt: transportResult.verifiedAt
  });
  const finalManifestSha256 = fingerprintC2FinalManifest({
    authorizedMediaFingerprint: normalized.authorizedMediaFingerprint,
    effectiveVideoRequirement: effective,
    mainImageAssetId: normalized.mainImageAssetId,
    videoDisposition: normalized.videoDisposition,
    assets: normalized.assets
  });
  if (transportResult.finalManifestSha256 !== finalManifestSha256) {
    throw new Error("C2_STABLE_TRANSPORT_RESULT_INVALID: finalManifestSha256与稳定地址清单不一致");
  }
  return deepFreeze({
    state,
    transportResult,
    finalAssets,
    target,
    effective,
    normalized,
    finalManifestSha256
  });
}

/** Outcome recording uses the frozen enqueue source; applying it requires the current source and clock. */
export function c2StableAssetTransportApplicationBlockReason({ skuPackage, sourceSkuPackage, settledAt }) {
  if (!isObject(skuPackage) || !isObject(sourceSkuPackage)) return "C2_STABLE_TRANSPORT_SOURCE_CONFLICT";
  const { audit: _currentAudit, ...currentSource } = skuPackage;
  const { audit: _sourceAudit, ...frozenSource } = sourceSkuPackage;
  if (!isDeepStrictEqual(currentSource, frozenSource)) return "C2_STABLE_TRANSPORT_SOURCE_CONFLICT";
  try {
    assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt: settledAt });
  } catch (error) {
    if (!(error instanceof C1SkuRightsReviewError)) throw error;
    return error.code;
  }
  return null;
}

export function settleC2StableAssetTransport({ skuPackage, jobRef, transportResultEnvelope, allowedStableAssetHosts, settledAt }) {
  assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt: settledAt });
  const {
    state,
    normalized,
    finalManifestSha256
  } = validateC2StableAssetTransportResult({ skuPackage, jobRef, transportResultEnvelope, allowedStableAssetHosts, settledAt });
  const ownerDecision = {
    status: "confirmed",
    confirmedBy: "owner",
    approvedManifestVersion: C2_FINAL_MANIFEST_VERSION,
    approvedManifestSha256: finalManifestSha256,
    approvedAuthorizedMediaFingerprint: normalized.authorizedMediaFingerprint,
    approvedAssetIds: normalized.assets.map((asset) => asset.assetId),
    approvedMainImageAssetId: normalized.mainImageAssetId,
    approvedVideoDisposition: normalized.videoDisposition
  };
  const transientPackage = structuredClone(skuPackage);
  transientPackage.c2FinalAssets.status = "awaiting_final_uploads";
  transientPackage.c2FinalAssets.stableAssetTransport = null;
  transientPackage.c2FinalAssets.effectiveVideoRequirement = null;
  transientPackage.c2FinalAssets.ownerVideoRequirement = null;
  transientPackage.c2FinalAssets.softwareState.lifecycleStatus = "c2_waiting_final_uploads";
  const transientTargetContract = normalizeC2TargetContract(transientPackage);
  transientPackage.c2FinalAssets.targetContext = structuredClone(transientTargetContract.targetContext);
  transientPackage.c2FinalAssets.unknownManifest = structuredClone(transientTargetContract.unknownManifest);
  const completed = confirmFinalUploads({
    skuPackage: transientPackage,
    finalUploadAssets: normalized.assets,
    ownerVideoRequirement: skuPackage.c2FinalAssets.ownerVideoRequirement,
    ownerDecision,
    confirmedAt: state.ownerStagingConfirmation.confirmedAt,
    observedAt: settledAt
  });
  const next = structuredClone(completed.skuPackage);
  next.c2FinalAssets.updatedAt = settledAt;
  next.c2FinalAssets.stableAssetTransport = {
    ...structuredClone(state),
    status: "verified",
    transportResult: structuredClone(transportResultEnvelope)
  };
  next.audit.updatedAt = settledAt;
  next.audit.history.push({
    event: "c2_stable_asset_transport_verified", at: settledAt, jobId: jobRef.jobId,
    stagedAssetManifestFingerprint: state.stagedAssetManifestFingerprint, finalManifestSha256,
    productionAuthorizationCreated: false, dHandoffCreated: false, platformUploads: 0, productionStarted: false
  });
  assertValidC2AssetLifecycle(next.c2FinalAssets);
  validateProductionAuthorizationPreparation({
    preparation: next.c2FinalAssets.productionAuthorizationPreparation,
    candidateId: next.g1Identity.candidateId,
    skuPackage: next
  });
  return deepFreeze({ flowVersion: "c2-stable-asset-transport-settlement-flow-v1", skuPackage: next, c2AssetLifecycle: next.c2FinalAssets });
}

/** C2授权准备读取：不创建ProductionAuthorization，也不创建D handoff。 */
export function selectConfirmedFinalUploadsForProduction(skuPackage) {
  assertC2HasNoDownstreamState(skuPackage);
  const g1 = normalizeC2G1Binding(skuPackage);
  const c2AssetLifecycle = skuPackage.c2FinalAssets;
  assertValidC2AssetLifecycle(c2AssetLifecycle);
  if (c2AssetLifecycle.status !== "completed" || c2AssetLifecycle.ownerFinalUploadConfirmation?.status !== "confirmed") {
    throw new Error("C2_OWNER_CONFIRMATION_REQUIRED: 未经主人确认不得生成未来D素材清单");
  }
  const preparation = c2AssetLifecycle.productionAuthorizationPreparation;
  if (preparation.skuPackageId !== skuPackage.skuPackageId || preparation.resultDataRevision !== skuPackage.dataRevision ||
      preparation.sourceDataRevision + 1 !== preparation.resultDataRevision ||
      !sameJson(preparation.frozenC1Handoff?.identity, g1.identity) ||
      !sameJson(preparation.finalCardInputSnapshot?.identity, g1.identity) ||
      preparation.finalCardInputSnapshot?.variantKey !== g1.variantKey) {
    throw new Error("C2_AUTHORIZATION_PREPARATION_DRIFT: 冻结准备与当前G1身份、variantKey或resultRevision不一致");
  }
  validateProductionAuthorizationPreparation({
    preparation,
    candidateId: g1.identity.candidateId,
    skuPackage
  });
  return deepFreeze({
    sourceArea: "assets.finalUploads",
    skuPackageId: skuPackage.skuPackageId,
    sourceDataRevision: skuPackage.dataRevision,
    ownerConfirmation: structuredClone(c2AssetLifecycle.ownerFinalUploadConfirmation),
    productionAuthorizationPreparation: structuredClone(preparation),
    assets: structuredClone(c2AssetLifecycle.assets.finalUploads),
    collectedIncluded: false,
    aiDraftsIncluded: false,
    productionAuthorizationCreated: false,
    dHandoffCreated: false,
    productionExecuted: false
  });
}
