import { C1_UNKNOWN_CLASSIFICATION_VERSION } from './c1-product-plan.mjs';
import { assertFormalCommissionBeforeProduction } from "./commission-estimate-authorization.mjs";
import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertCurrentC1SkuRightsReview } from "./c1-sku-rights-review.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";
import { assertValidFinalProductPlanConfirmationCard, createFinalProductPlanConfirmationCard } from "./final-product-plan-confirmation-card.mjs";
import { assertProductionProfitPriceCurrent } from "./final-pricing-review.mjs";
import { assertAuthorizedMediaUnchanged } from "./production-authorization-preparation.mjs";
import {
  assertValidLifecyclePackage,
  validateLifecycleTransition,
  validateProductionAuthorizationRecord
} from "./product-lifecycle-schema.mjs";
import {
  assertNoProductionSecrets,
  fingerprintCanonicalRecord
} from "./production-contract-primitives.mjs";
import { validateProductionAuthorizationPreparation, assertCurrentC1MatchesProductionPreparation, isProductionExecutionBinding, PRODUCTION_AUTHORIZATION_VERSION, PRODUCTION_PUBLISH_SCOPES, PRODUCTION_WRITE_FIELDS } from "./production-authorization-preparation.mjs";

export {
  PRODUCTION_AUTHORIZATION_FINAL_CARD_INPUT_SNAPSHOT_VERSION,
  PRODUCTION_AUTHORIZATION_FINAL_MANIFEST_VERSION,
  PRODUCTION_AUTHORIZATION_PENDING_INPUTS_VERSION,
  PRODUCTION_AUTHORIZATION_PREPARATION_VERSION,
  createPendingProductionAuthorizationInputs,
  fingerprintC1Snapshot,
  fingerprintFinalCardInputSnapshot,
  fingerprintFinalManifest,
  fingerprintFinalUploads,
  fingerprintAuthorizedMedia,
  fingerprintProductionAuthorizationPreparation,
  validateProductionAuthorizationPreparation
} from "./production-authorization-preparation.mjs";

export { PRODUCTION_AUTHORIZATION_VERSION, DRAFT_ONLY_PUBLISH_SCOPE, VALIDATION_MODERATION_PUBLISH_SCOPE,
  PRODUCTION_PUBLISH_SCOPES, PRODUCTION_WRITE_FIELDS } from "./production-authorization-preparation.mjs";
export const C2_D_HANDOFF_VERSION = "c2-d-handoff-v1";

const NOT_APPLICABLE = "not_applicable";
const OWNER_DECISION_OPTION = "approve_for_production_authorization";
const OWNER_DECISION_KEYS = Object.freeze([
  "decisionId", "selectedOption", "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint",
  "sourceConfirmationCardId", "merchantSku", "warehouseRef", "credentialAlias", "stock",
  "buyerTargetPrice", "platformWritePrice", "priceConversion", "publishScope", "allowedWriteFields", "exclusions",
  "ownerDecisionFingerprint", "ownerConfirmation", "executionBinding"
]);
const OWNER_CONFIRMATION_KEYS = Object.freeze([
  "schemaVersion", "decisionId", "actorId", "actorType", "role", "confirmedAt",
  "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint", "sourceC1Fingerprint",
  "sourceCandidateRevision", "sourceSkuRevision", "ownerDecisionFingerprint"
]);
const OWNER_ACTOR_KEYS = Object.freeze([
  "schemaVersion", "userId", "sessionId", "actorType", "roles", "source", "authenticatedAt"
]);
const OWNER_COMMERCIAL_FIELDS = Object.freeze(["selectedOption", "merchantSku", "warehouseRef", "credentialAlias", "stock",
  "buyerTargetPrice", "platformWritePrice", "priceConversion", "publishScope", "allowedWriteFields", "exclusions", "executionBinding"]);
const SINGLE_OWNER_INPUT_KEYS = Object.freeze(["contractVersion", "dataRevision", "skuRevision", "cardId", "cardRevision",
  "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint", "bindingId", "configurationVersion", "merchantSku", "confirmExactScope"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDateTime(value) {
  if (!nonEmptyString(value) || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value) || Number.isNaN(Date.parse(value))) return false;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === value.slice(0, 10);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256(value) {
  return fingerprintCanonicalRecord(value);
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function exactKeys(value, keys) {
  return isObject(value) && sameJson(Object.keys(value).sort(), [...keys].sort());
}

function validMoney(value) {
  return isObject(value) && Number.isFinite(value.amount) && value.amount > 0 &&
    ["CNY", "RUB"].includes(value.currency) && exactKeys(value, ["amount", "currency"]);
}

function validPriceConversion(value) {
  return isObject(value) && Number.isFinite(value.rubPerCny) && value.rubPerCny > 0 &&
    nonEmptyString(value.evidenceRef) && isoDateTime(value.checkedAt) &&
    exactKeys(value, ["rubPerCny", "evidenceRef", "checkedAt"]);
}

function validateExecutionBinding(binding) {
  if (!isProductionExecutionBinding(binding)) {
    throw new Error("PRODUCTION_AUTHORIZATION_EXECUTION_BINDING_INVALID");
  }
  assertNoSecrets(binding, "executionBinding");
  return binding;
}

function assertSafeString(value, path) {
  if (!nonEmptyString(value)) throw new Error(`PRODUCTION_AUTHORIZATION_INPUT_GAP:${path}`);
  const text = value.trim();
  assertNoProductionSecrets(text, path);
  return text;
}

function assertNoSecrets(value, path = "input") {
  assertNoProductionSecrets(value, path);
}

function validateOwnerDecision(ownerDecision, preparation, sourceCandidateRevision, sourceSkuRevision, snapshotContext) {
  if (!exactKeys(ownerDecision, OWNER_DECISION_KEYS) || ownerDecision.selectedOption !== OWNER_DECISION_OPTION ||
      ownerDecision.sourcePreparationFingerprint !== preparation.preparationFingerprint || ownerDecision.sourceFinalCardInputFingerprint !== preparation.finalCardInputFingerprint) {
    throw new Error("PRODUCTION_AUTHORIZATION_OWNER_CONFIRMATION_REQUIRED");
  }
  validateExecutionBinding(ownerDecision.executionBinding);
  const owner = ownerDecision.ownerConfirmation;
  if (!exactKeys(owner, OWNER_CONFIRMATION_KEYS) || owner.schemaVersion !== "production-owner-confirmation-v2" ||
      owner.actorType !== "human" || owner.role !== "owner" || owner.decisionId !== ownerDecision.decisionId ||
      !nonEmptyString(owner.actorId) || !isoDateTime(owner.confirmedAt) ||
      owner.sourcePreparationFingerprint !== preparation.preparationFingerprint ||
      owner.sourceFinalCardInputFingerprint !== preparation.finalCardInputFingerprint ||
      owner.sourceC1Fingerprint !== preparation.sourceC1Fingerprint || owner.sourceCandidateRevision !== sourceCandidateRevision || owner.sourceSkuRevision !== sourceSkuRevision) {
    throw new Error("PRODUCTION_AUTHORIZATION_HUMAN_OWNER_CONFIRMATION_REQUIRED");
  }
  for (const field of ["decisionId", "sourceConfirmationCardId", "merchantSku", "warehouseRef", "credentialAlias"]) {
    assertSafeString(ownerDecision[field], `ownerDecision.${field}`);
    if (["unknown", "null", "undefined", NOT_APPLICABLE].includes(ownerDecision[field].trim().toLowerCase())) throw new Error(`PRODUCTION_AUTHORIZATION_INPUT_GAP:ownerDecision.${field}`);
  }
  const expectedCardId = `final-plan-card:${preparation.skuPackageId}:${preparation.resultDataRevision}`;
  if (ownerDecision.sourceConfirmationCardId !== expectedCardId) throw new Error("PRODUCTION_AUTHORIZATION_OWNER_CONFIRMATION_REQUIRED:sourceConfirmationCardId");
  if (!Number.isInteger(ownerDecision.stock) || ownerDecision.stock < 0) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP:stock");
  if (!validMoney(ownerDecision.buyerTargetPrice) || ownerDecision.buyerTargetPrice.currency !== "RUB" ||
      !validMoney(ownerDecision.platformWritePrice) || ownerDecision.platformWritePrice.currency !== "CNY" || !validPriceConversion(ownerDecision.priceConversion)) {
    throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP:price");
  }
  const converted = ownerDecision.buyerTargetPrice.amount / ownerDecision.priceConversion.rubPerCny;
  if (Math.abs(converted - ownerDecision.platformWritePrice.amount) > 0.02) throw new Error("PRODUCTION_AUTHORIZATION_INPUT_GAP:priceConversion");
  if (!PRODUCTION_PUBLISH_SCOPES.includes(ownerDecision.publishScope) || !Array.isArray(ownerDecision.exclusions) ||
      !Array.isArray(ownerDecision.allowedWriteFields) || ownerDecision.allowedWriteFields.length === 0 ||
      new Set(ownerDecision.allowedWriteFields).size !== ownerDecision.allowedWriteFields.length ||
      ownerDecision.allowedWriteFields.some((field) => !PRODUCTION_WRITE_FIELDS.includes(field)) || ownerDecision.exclusions.some((field) => !nonEmptyString(field))) {
    throw new Error("PRODUCTION_AUTHORIZATION_SCOPE_REJECTED");
  }
  assertNoSecrets(ownerDecision, "ownerDecision");
  const ownerDecisionSnapshot = buildProductionOwnerDecisionSnapshot({
    ...snapshotContext,
    sourceCandidateRevision,
    preparation,
    ownerDecision
  });
  const expectedOwnerDecisionFingerprint = sha256(ownerDecisionSnapshot);
  if (ownerDecision.ownerDecisionFingerprint !== expectedOwnerDecisionFingerprint || owner.ownerDecisionFingerprint !== expectedOwnerDecisionFingerprint) {
    throw new Error("PRODUCTION_AUTHORIZATION_OWNER_DECISION_DRIFT:fingerprint");
  }
  return ownerDecisionSnapshot;
}

function validateOwnerActor(actor) {
  if (!exactKeys(actor, OWNER_ACTOR_KEYS) || actor.schemaVersion !== "actor-context-v1" || actor.actorType !== "human" ||
      !nonEmptyString(actor.userId) || !nonEmptyString(actor.sessionId) || actor.source !== "authenticated_identity_provider" ||
      !isoDateTime(actor.authenticatedAt) || !Array.isArray(actor.roles) || !actor.roles.includes("owner")) {
    throw new Error("PRODUCTION_OWNER_AUTHENTICATED_IDENTITY_REQUIRED");
  }
  authorizeOperation({ actor, requiredRoles: ["owner"] });
  assertNoSecrets(actor, "ownerActor");
  return actor;
}

// This retired entry cannot turn an old commercial decision into current write authority.
export function assertIndependentProductionAuthorizationActors() {
  throw new Error("PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED");
}

export function validateProductionAuthorization(authorization, context = {}) {
  return validateProductionAuthorizationRecord(authorization, context);
}

export function assertValidProductionAuthorization(authorization, context = {}) {
  const result = validateProductionAuthorization(authorization, context);
  if (!result.valid) throw new Error(`ProductionAuthorization校验失败：${result.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  return authorization;
}

/** Validate historical records without granting them new execution eligibility. */
export function assertCurrentProductionAuthorization(authorization, context = {}) {
  assertValidProductionAuthorization(authorization, context);
  if (authorization.schemaVersion !== PRODUCTION_AUTHORIZATION_VERSION) throw new Error("PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED");
  assertCurrentC1SkuRightsReview({ plan: authorization.lockedScope.finalCardInputSnapshot.c1Snapshot,
    sourceIdentity: authorization.sourceIdentity, observedAt: context.observedAt });
  return authorization;
}

function buildAuthorizedIdentity(sourceIdentity, ownerDecision) {
  return { ...structuredClone(sourceIdentity), merchantSku: ownerDecision.merchantSku, warehouseRef: ownerDecision.warehouseRef, credentialAlias: ownerDecision.credentialAlias };
}

export function buildProductionOwnerDecisionSnapshot({ candidateId, sourceCandidateRevision, skuPackage, preparation, ownerDecision, contractVersion = PRODUCTION_AUTHORIZATION_VERSION }) {
  if (!["production-authorization-v1.1", PRODUCTION_AUTHORIZATION_VERSION].includes(contractVersion)) throw new Error("PRODUCTION_AUTHORIZATION_VERSION_INVALID");
  const singleOwner = contractVersion === PRODUCTION_AUTHORIZATION_VERSION;
  if (singleOwner) validateExecutionBinding(ownerDecision.executionBinding);
  const sourceIdentity = preparation.finalCardInputSnapshot.identity;
  const identity = buildAuthorizedIdentity(sourceIdentity, ownerDecision);
  return {
    schemaVersion: singleOwner ? "production-owner-decision-snapshot-v2" : "production-owner-decision-snapshot-v1",
    ...(singleOwner ? { executionBinding: structuredClone(ownerDecision.executionBinding) } : {}),
    decisionId: ownerDecision.decisionId,
    sourceConfirmationCardId: ownerDecision.sourceConfirmationCardId,
    sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint,
    sourceC1Fingerprint: preparation.sourceC1Fingerprint,
    sourceCandidateRevision,
    sourceSkuRevision: skuPackage.dataRevision,
    identity: structuredClone(identity),
    buyerTargetPrice: structuredClone(ownerDecision.buyerTargetPrice),
    platformWritePrice: structuredClone(ownerDecision.platformWritePrice),
    priceConversion: structuredClone(ownerDecision.priceConversion),
    stock: ownerDecision.stock,
    publishScope: ownerDecision.publishScope,
    allowedWriteFields: structuredClone(ownerDecision.allowedWriteFields),
    exclusions: structuredClone(ownerDecision.exclusions),
    authorizedMediaFingerprint: preparation.authorizedMediaFingerprint,
    finalManifestSha256: preparation.finalManifestSha256,
    finalUploadsFingerprint: preparation.finalUploadsFingerprint,
    mainImageAssetId: preparation.mainImageAssetId,
    videoDisposition: preparation.videoDisposition,
    effectiveVideoRequirement: structuredClone(preparation.effectiveVideoRequirement)
  };
}

/** 同一张卡在第2轮及以后重签时，卡号、cardRevision 与 preparationFingerprint 都与第1轮相同，
 * 所以决定号必须带轮次，否则新授权会和已归档的那份算出完全一样的 ID。第1轮格式不变。 */
export function buildProductionOwnerDecisionId({ candidateId, cardId, cardRevision, authorizationRound = 1 }) {
  if (!Number.isInteger(authorizationRound) || authorizationRound < 1) {
    throw new Error("PRODUCTION_AUTHORIZATION_ROUND_INVALID");
  }
  const base = `owner-decision:${candidateId}:${cardId}:${cardRevision + 1}`;
  return authorizationRound === 1 ? base : `${base}:r${authorizationRound}`;
}

export function createProductionAuthorization({ candidate, evidencePacks, currentCommissionCatalogs = [], candidateId, sourceCandidateRevision, currentCandidateRevision, skuPackage, commercialDecision, ownerActor, authorizedAt }) {
  assertValidLifecyclePackage(skuPackage);
  assertCurrentC1MatchesProductionPreparation({ preparation: skuPackage.c2FinalAssets?.productionAuthorizationPreparation, candidateId, skuPackage });
  assertProductionProfitPriceCurrent({ candidate, skuPackage, evidencePacks, currentCommissionCatalogs, observedAt: authorizedAt });
  if (candidate.id !== candidateId || candidate.dataRevision !== currentCandidateRevision) throw new Error("PRODUCTION_AUTHORIZATION_PROFIT_SOURCE_REQUIRED");
  assertCurrentC1SkuRightsReview({ plan: skuPackage.c1ProductPlan, sourceIdentity: skuPackage.g1Identity, observedAt: authorizedAt });
  validateOwnerActor(ownerActor);
  const card = skuPackage.productionConfirmationCard;
  assertValidFinalProductPlanConfirmationCard(card);
  if (card.riskAndUnknowns.classificationVersion !== C1_UNKNOWN_CLASSIFICATION_VERSION) {
    throw new Error('PRODUCTION_AUTHORIZATION_FINAL_CARD_CLASSIFICATION_REQUIRED: 旧确认卡须按当前冻结输入重新生成，不自动放行');
  }
  if (card.status !== "awaiting_owner_business_confirmation" || card.ownerDecision !== null) {
    throw new Error("PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED:历史决定只读");
  }
  const sourceWithoutCard = structuredClone(skuPackage);
  sourceWithoutCard.productionConfirmationCard = null;
  const expectedCard = createFinalProductPlanConfirmationCard({ skuPackage: sourceWithoutCard, createdAt: card.createdAt }).confirmationCard;
  if (!sameJson(card, expectedCard)) throw new Error("PRODUCTION_AUTHORIZATION_CARD_DRIFT");
  if (expectedCard.riskAndUnknowns.blockingUnknownCount > 0 || !["exact", "official_reference"].includes(card.profitResult.commissionMode.value)) {
    throw new Error("PRODUCTION_AUTHORIZATION_FINAL_CARD_INCOMPLETE");
  }
  if (!exactKeys(commercialDecision, OWNER_COMMERCIAL_FIELDS) || commercialDecision.selectedOption !== OWNER_DECISION_OPTION) {
    throw new Error("PRODUCTION_OWNER_COMMERCIAL_INPUT_INVALID");
  }
  if (skuPackage.businessPhase !== "C2" || skuPackage.productionAuthorization !== null || skuPackage.productionRecord !== null ||
      (skuPackage.dHandoff !== null && skuPackage.dHandoff !== undefined) || skuPackage.dAssetTransport?.status === "unknown_outcome") {
    throw new Error("PRODUCTION_AUTHORIZATION_GATE_REJECTED:已有下游状态或结果未知");
  }
  if (!Number.isInteger(sourceCandidateRevision) || sourceCandidateRevision < 0 || !Number.isInteger(currentCandidateRevision) ||
      currentCandidateRevision < 0 || sourceCandidateRevision !== currentCandidateRevision || !isoDateTime(authorizedAt)) {
    throw new Error("PRODUCTION_AUTHORIZATION_REVISION_CONFLICT:currentCandidateRevision");
  }
  if (Date.parse(ownerActor.authenticatedAt) > Date.parse(authorizedAt) || Date.parse(card.createdAt) > Date.parse(authorizedAt)) throw new Error("PRODUCTION_OWNER_CLOCK_INVALID");
  const preparation = skuPackage.c2FinalAssets?.productionAuthorizationPreparation;
  // 授权落库前最后一次确认：要授权的就是主人确认过的那批地址和那个顺序。
  assertAuthorizedMediaUnchanged(preparation.finalUploads, preparation.authorizedMediaFingerprint, "createProductionAuthorization");
  const profit = preparation.finalCardInputSnapshot.activeProfitModel;
  if (commercialDecision.buyerTargetPrice?.amount !== profit.recommendedSalePriceRub || commercialDecision.platformWritePrice?.amount !== profit.recommendedSalePriceCny ||
      !sameJson(commercialDecision.priceConversion, profit.priceConversion)) throw new Error("PRODUCTION_AUTHORIZATION_FROZEN_PRICE_DRIFT");
  // 第2轮及以后的授权（上一轮已整体归档、SKU包恢复到签字前）必须带轮次：卡号、cardRevision 与
  // preparationFingerprint 在恢复后全部相同，不带轮次会算出与已归档授权一字不差的
  // decisionId / authorizationId / handoffId，审计分不清哪一轮。第1轮格式不变。
  const decisionId = buildProductionOwnerDecisionId({ candidateId, cardId: card.cardId,
    cardRevision: card.cardRevision, authorizationRound: skuPackage.productionAuthorizationRoundV1 ?? 1 });
  const ownerDecision = { ...structuredClone(commercialDecision), decisionId, sourceConfirmationCardId: card.cardId,
    sourcePreparationFingerprint: preparation.preparationFingerprint, sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint };
  ownerDecision.ownerDecisionFingerprint = sha256(buildProductionOwnerDecisionSnapshot({ candidateId, sourceCandidateRevision, skuPackage, preparation, ownerDecision }));
  ownerDecision.ownerConfirmation = { schemaVersion: "production-owner-confirmation-v2", decisionId, actorId: ownerActor.userId,
    actorType: "human", role: "owner", confirmedAt: authorizedAt, sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint, sourceC1Fingerprint: preparation.sourceC1Fingerprint,
    sourceCandidateRevision, sourceSkuRevision: skuPackage.dataRevision, ownerDecisionFingerprint: ownerDecision.ownerDecisionFingerprint };
  const sourceIdentity = structuredClone(preparation.finalCardInputSnapshot.identity);
  const identity = buildAuthorizedIdentity(sourceIdentity, ownerDecision);
  const ownerDecisionSnapshot = validateOwnerDecision(ownerDecision, preparation, sourceCandidateRevision, skuPackage.dataRevision, {
    candidateId,
    skuPackage
  });
  const authorizationId = `production-auth:${skuPackage.skuPackageId}:${preparation.preparationFingerprint}:${ownerDecision.decisionId}`;
  const handoffId = `d-handoff:${authorizationId}`;
  const authorization = {
    schemaVersion: PRODUCTION_AUTHORIZATION_VERSION,
    authorizationId,
    status: "confirmed",
    confirmedBy: "owner",
    confirmedByActorId: ownerDecision.ownerConfirmation.actorId,
    confirmedAt: ownerDecision.ownerConfirmation.confirmedAt,
    authorizedByActorId: ownerActor.userId,
    authorizedAt,
    ownerDecisionId: ownerDecision.decisionId,
    ownerConfirmation: structuredClone(ownerDecision.ownerConfirmation),
    ownerDecisionFingerprint: ownerDecision.ownerDecisionFingerprint,
    ownerDecisionSnapshot,
    executionBinding: structuredClone(ownerDecision.executionBinding),
    ownerAuthorization: {
      schemaVersion: "production-owner-authorization-v1",
      actorId: ownerActor.userId,
      actorType: "human",
      role: "owner",
      source: "authenticated_identity_provider",
      authorizedAt
    },
    sourceConfirmationCardId: ownerDecision.sourceConfirmationCardId,
    sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint,
    sourceC1Fingerprint: preparation.sourceC1Fingerprint,
    sourceCandidateRevision,
    resultCandidateRevision: sourceCandidateRevision + 1,
    authorizedDataRevision: skuPackage.dataRevision,
    resultDataRevision: skuPackage.dataRevision + 1,
    sourceIdentity,
    identity,
    lockedScope: {
      candidateId,
      skuPackageId: skuPackage.skuPackageId,
      variantKey: skuPackage.variantKey,
      platform: sourceIdentity.platform,
      storeRef: structuredClone(sourceIdentity.storeRef),
      merchantSku: ownerDecision.merchantSku,
      supplierSkuId: sourceIdentity.supplierSkuId,
      warehouseRef: ownerDecision.warehouseRef,
      credentialAlias: ownerDecision.credentialAlias,
      schemaRevision: preparation.targetContext.schemaRevision,
      schemaEvidenceRef: preparation.targetContext.schemaEvidenceRef,
      activeProfitModelVersion: preparation.finalCardInputSnapshot.activeProfitModelVersion,
      buyerTargetPrice: structuredClone(ownerDecision.buyerTargetPrice),
      platformWritePrice: structuredClone(ownerDecision.platformWritePrice),
      priceConversion: structuredClone(ownerDecision.priceConversion),
      stock: ownerDecision.stock,
      authorizedMediaFingerprint: preparation.authorizedMediaFingerprint,
      finalManifestVersion: preparation.finalManifestVersion,
      finalManifestSha256: preparation.finalManifestSha256,
      finalUploadsFingerprint: preparation.finalUploadsFingerprint,
      mainImageAssetId: preparation.mainImageAssetId,
      videoDisposition: preparation.videoDisposition,
      effectiveVideoRequirement: structuredClone(preparation.effectiveVideoRequirement),
      finalUploads: structuredClone(preparation.finalUploads),
      finalCardInputSnapshot: structuredClone(preparation.finalCardInputSnapshot),
      publishScope: ownerDecision.publishScope,
      allowedWriteFields: structuredClone(ownerDecision.allowedWriteFields),
      exclusions: structuredClone(ownerDecision.exclusions)
    },
    scopeExpansionAllowed: false,
    fieldMutationAllowed: false,
    skuReplacementAllowed: false,
    assetReplacementAllowed: false,
    readPolicy: "authorization_snapshot_only",
    productionExecuted: false,
    platformWrites: 0
  };
  const dHandoff = {
    schemaVersion: C2_D_HANDOFF_VERSION,
    handoffId,
    status: "awaiting_explicit_d_start",
    candidateId,
    skuPackageId: skuPackage.skuPackageId,
    identity: structuredClone(identity),
    variantKey: skuPackage.variantKey,
    productionAuthorizationId: authorizationId,
    ownerDecisionId: ownerDecision.decisionId,
    sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint,
    sourceCandidateRevision,
    resultCandidateRevision: sourceCandidateRevision + 1,
    sourceSkuRevision: skuPackage.dataRevision,
    resultSkuRevision: skuPackage.dataRevision + 1,
    createdAt: authorizedAt,
    uniqueOwner: "d_software",
    productionPlanCreated: false,
    executionIntentCreated: false,
    softwareJobCreated: false,
    dWritePermissionGranted: false,
    externalRequests: 0,
    platformWrites: 0
  };
  assertValidProductionAuthorization(authorization, {
    candidateId,
    candidateRevision: sourceCandidateRevision,
    skuPackage,
    lifecycleState: "source"
  });
  assertNoSecrets(dHandoff, "dHandoff");
  const protectedPreparation = structuredClone(preparation);
  const next = structuredClone(skuPackage);
  next.productionConfirmationCard.ownerDecision = ownerDecision;
  next.productionConfirmationCard.status = "owner_business_approved";
  next.productionConfirmationCard.cardRevision += 1;
  assertValidFinalProductPlanConfirmationCard(next.productionConfirmationCard);
  next.productionAuthorization = authorization;
  next.dHandoff = dHandoff;
  next.dataRevision += 1;
  next.businessPhase = "C2";
  next.businessResult = "passed";
  next.technicalStatus = "completed";
  next.ownerAction = "none";
  next.audit.updatedAt = authorizedAt;
  next.audit.history.push({
    event: "production_authorization_and_d_handoff_created_atomically",
    at: authorizedAt,
    authorizationId,
    handoffId,
    sourcePreparationFingerprint: preparation.preparationFingerprint,
    sourceCandidateRevision,
    resultCandidateRevision: sourceCandidateRevision + 1,
    sourceSkuRevision: skuPackage.dataRevision,
    resultSkuRevision: skuPackage.dataRevision + 1,
    productionPlanCreated: false,
    executionIntentCreated: false,
    softwareJobCreated: false,
    dWritePermissionGranted: false,
    externalRequests: 0,
    platformWrites: 0
  });
  const transition = validateLifecycleTransition(skuPackage, next);
  if (!transition.valid) throw new Error(`PRODUCTION_AUTHORIZATION_LIFECYCLE_INVALID:${transition.errors.map((item) => item.path).join(",")}`);
  if (!sameJson(protectedPreparation, next.c2FinalAssets.productionAuthorizationPreparation)) throw new Error("PRODUCTION_AUTHORIZATION_PREPARATION_MUTATED");
  assertValidLifecyclePackage(next);
  return deepFreeze({ flowVersion: "c2-d-single-owner-authorization-handoff-v2", skuPackage: next, productionAuthorization: authorization, dHandoff });
}

/** Retired writes remain explicit failures; historical records are never rewritten. */
export async function commitProductionOwnerDecision() {
  throw new Error("PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED");
}
export async function commitProductionAuthorizationHandoff() {
  throw new Error("PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED");
}

export async function commitSingleOwnerProductionAuthorization({ repository, runtimeMode, actor, candidateId, input,
  resolveProductionAuthorizationDecision, serverClock }) {
  validateOwnerActor(actor);
  if (!exactKeys(input, SINGLE_OWNER_INPUT_KEYS) || input.contractVersion !== PRODUCTION_AUTHORIZATION_VERSION || input.confirmExactScope !== true) {
    throw new Error("PRODUCTION_AUTHORIZATION_RECONFIRMATION_REQUIRED");
  }
  if (![input.dataRevision, input.skuRevision, input.cardRevision].every(value => Number.isInteger(value) && value >= 0) || input.cardRevision < 1 ||
      typeof serverClock !== "function" || typeof resolveProductionAuthorizationDecision !== "function") throw new Error("PRODUCTION_AUTHORIZATION_INPUT_INVALID");
  for (const field of ["cardId", "bindingId", "configurationVersion", "merchantSku", "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint"]) assertSafeString(input[field], `input.${field}`);
  assertNoSecrets(input, "input");
  const snapshot = await repository.readSnapshot();
  const sku = snapshot.candidates?.find(entry => entry.id === candidateId)?.lifecycleV11?.skuPackage;
  if (!sku) throw new Error("PRODUCTION_AUTHORIZATION_CANDIDATE_NOT_FOUND");
  const key = `single-owner-production-authz:${candidateId}:${input.cardId}:${input.cardRevision}:${input.dataRevision}`;
  const decisionId = buildProductionOwnerDecisionId({ candidateId, cardId: input.cardId,
    cardRevision: input.cardRevision, authorizationRound: sku.productionAuthorizationRoundV1 ?? 1 });
  return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"],
    action: "create_single_owner_production_authorization_and_d_handoff", candidateId, skuPackageId: sku.skuPackageId,
    expectedRevision: input.dataRevision, idempotencyKey: key, inputFingerprint: sha256({ candidateId, actorId: actor.userId, input }),
    auditEventId: `audit:${key}`, authorizationRef: `production-auth:${sku.skuPackageId}:${input.sourcePreparationFingerprint}:${decisionId}`,
    externalRequestState: "not_sent", externalRequestRef: null, serverClock,
    softwareJobEffect: { schemaVersion: "business-mutation-domain-handoff-effect-v1", kind: "software_job", operation: "enqueue", jobType: "d_production_execution" },
    includeMerchantSkuClaims: true,
    mutate: ({ candidate, observedAt, evidencePacks, currentCommissionCatalogs, merchantSkuClaims }) => {
      if(candidate.siblingPreparationDraftRefV1) throw new Error('PRODUCTION_AUTHORIZATION_BATCH_CONFIRMATION_REQUIRED');
      if (merchantSkuClaims.some(claim => claim.merchantSku === input.merchantSku)) {
        throw new Error('PRODUCTION_AUTHORIZATION_OFFER_RESERVED');
      }
      const currentSku = candidate.lifecycleV11?.skuPackage;
      const card = currentSku?.productionConfirmationCard;
      const preparation = currentSku?.c2FinalAssets?.productionAuthorizationPreparation;
      if (!currentSku || currentSku.skuPackageId !== sku.skuPackageId || currentSku.dataRevision !== input.skuRevision ||
          card?.cardId !== input.cardId || card.cardRevision !== input.cardRevision ||
          preparation?.preparationFingerprint !== input.sourcePreparationFingerprint || preparation.finalCardInputFingerprint !== input.sourceFinalCardInputFingerprint) {
        throw new Error("PRODUCTION_AUTHORIZATION_CARD_DRIFT");
      }
      // Reject estimated inputs first; the resolver and direct creator both enforce the full current frozen-evidence gate.
      assertFormalCommissionBeforeProduction(currentSku);
      // Resolve only current, verified local configuration and frozen price evidence inside the same transaction.
      const commercialDecision = resolveProductionAuthorizationDecision({ candidate: structuredClone(candidate), input: structuredClone(input), observedAt, evidencePacks, currentCommissionCatalogs });
      if (!exactKeys(commercialDecision, OWNER_COMMERCIAL_FIELDS) || commercialDecision.merchantSku !== input.merchantSku.trim()) throw new Error("PRODUCTION_OWNER_COMMERCIAL_INPUT_INVALID");
      validateExecutionBinding(commercialDecision.executionBinding);
      if (commercialDecision.executionBinding.bindingId !== input.bindingId || commercialDecision.executionBinding.configurationVersion !== input.configurationVersion) {
        throw new Error("PRODUCTION_AUTHORIZATION_EXECUTION_BINDING_DRIFT");
      }
      const result = createProductionAuthorization({ candidate, evidencePacks, currentCommissionCatalogs, candidateId, sourceCandidateRevision: input.dataRevision, currentCandidateRevision: candidate.dataRevision,
        skuPackage: currentSku, commercialDecision, ownerActor: actor, authorizedAt: observedAt });
      candidate.lifecycleV11.skuPackage = structuredClone(result.skuPackage);
      candidate.lifecycleV11.status = "production_authorized_awaiting_explicit_d_start";
      candidate.lifecycleV11.platformWrites = 0; candidate.updatedAt = observedAt; candidate.lastModifiedBy = actor.userId;
      return { candidate, result: { schemaVersion: "single-owner-production-authorization-result-v1", productionAuthorization: structuredClone(result.productionAuthorization), dHandoff: structuredClone(result.dHandoff),
        productionPlanCreated: false, executionIntentCreated: false, softwareJobCreated: false, dWritePermissionGranted: false, externalRequests: 0, platformWrites: 0 } };
    }
  });
}

export function reviseProductionAuthorization() {
  throw new Error("PRODUCTION_AUTHORIZATION_IMMUTABLE:必须创建新的显式授权版本，禁止覆盖当前授权");
}

export function reviseProductionAuthorizationPriceSemantics() {
  throw new Error("PRODUCTION_AUTHORIZATION_IMMUTABLE:禁止原地修复不可变授权");
}

export { readAuthorizedProductionSnapshot } from "./production-authorization-snapshot.mjs";
