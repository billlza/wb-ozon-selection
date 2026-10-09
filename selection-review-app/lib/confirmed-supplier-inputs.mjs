import { isDeepStrictEqual } from "node:util";
import { assertNoRawPersistenceKeys, assertNoProductionSecrets, isCanonicalFrozenRef } from "./production-contract-primitives.mjs";
import { readDeclaredCargoFacts } from "./cargo-facts-declaration.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { derivedVariantKey } from "./supplier-option.mjs";
import { readAProductDetailSupplierEvidence } from "./a-product-detail-evidence.mjs";
import { validateC1SkuRightsReview } from "./c1-sku-rights-review.mjs";
import { readOwnerProductFacts, OWNER_PRODUCT_FACT_LABELS } from "./owner-product-facts.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const canonicalTime = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export class ConfirmedSupplierInputError extends Error {
  constructor(code) { super(code); this.name = "ConfirmedSupplierInputError"; this.code = code; }
}
const fail = code => { throw new ConfirmedSupplierInputError(code); };

/** Consume the existing owner declaration, never the software's unsigned proposal. */
export function readConfirmedSupplierPowerProfile(candidate) {
  let facts;
  try { facts = readDeclaredCargoFacts(candidate); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("CARGO_FACTS_RECORD_INVALID:")) fail("CONFIRMED_CARGO_RECORD_INVALID");
    throw error;
  }
  if (facts === null) return null;
  const record = candidate.cargoFactsV1;
  if (record.declaredBy !== "owner" || !Number.isSafeInteger(candidate.dataRevision) || !Number.isSafeInteger(record.declaredRevision) || record.declaredRevision < 0 || record.declaredRevision > candidate.dataRevision ||
      !Number.isFinite(Date.parse(record.declaredAt)) ||
      facts.sourceRef !== `owner-cargo-facts:${candidate.id}:${record.declaredRevision}:${record.declaredAt}`) fail("CONFIRMED_CARGO_SOURCE_MISMATCH");
  if (facts.batteryType === "unknown") return null;
  return facts.batteryType === "none"
    ? { containsBattery: false, batteryType: "none", sourceRef: facts.sourceRef }
    : { containsBattery: true, batteryType: facts.batteryType, sourceRef: facts.sourceRef };
}

/** Resolve the same capture and canonical variant identity used by the A confirmation card. */
function confirmedVariantSelection(candidate, { supplierSkuId, variantKey, captureId, confirmedSupplySnapshot = null }) {
  const apiEvidence = readAProductDetailSupplierEvidence(candidate);
  const capture = apiEvidence ? apiEvidence.supplierCapture : candidate.sourceCapture;
  if (apiEvidence && confirmedSupplySnapshot !== null) {
    const frozen = confirmedSupplySnapshot.supplierOption;
    const observed = apiEvidence.supplierOption;
    if (!object(frozen) || ["supplierOptionId", "offerId", "productUrl", "evidenceRef"].some(key => frozen[key] !== observed[key]) ||
        frozen.evidenceRef !== apiEvidence.evidence.supplierReceiptRef) fail("CONFIRMED_VARIANT_CAPTURE_MISMATCH");
    captureId = apiEvidence.evidence.supplierReceiptRef;
  }
  if (!capture || capture.skuChoices === undefined) return null;
  if (!Array.isArray(capture.skuChoices) || capture.skuChoices.some(choice => !object(choice)) ||
      !text(captureId) || capture.captureId !== captureId) fail("CONFIRMED_VARIANT_CAPTURE_MISMATCH");
  const matches = capture.skuChoices.filter(choice => choice.sourceSkuId === supplierSkuId);
  if (matches.length !== 1 || !object(matches[0].attributes)) fail("CONFIRMED_VARIANT_IDENTITY_MISMATCH");
  const canonicalVariant = apiEvidence ? matches[0].variantKey : derivedVariantKey(matches[0]);
  if (canonicalVariant !== variantKey) fail("CONFIRMED_VARIANT_IDENTITY_MISMATCH");
  const attributes = {};
  for (const [key, value] of Object.entries(matches[0].attributes)) {
    if (!text(value) && !(typeof value === "number" && Number.isFinite(value))) fail("CONFIRMED_VARIANT_ATTRIBUTE_INVALID");
    attributes[key] = value;
  }
  return { attributes, capture, index: capture.skuChoices.findIndex(choice => choice.sourceSkuId === supplierSkuId), apiEvidence: apiEvidence !== null };
}

/** SKU-specific choices override product-wide variant lists after exact capture/SKU matching. */
export function readConfirmedSupplierVariantAttributes(candidate, selection) {
  return confirmedVariantSelection(candidate, selection)?.attributes ?? null;
}

/** Saved supplier wording for the exact confirmed offer/SKU. Text remains reference,
 * never a confirmation of every marketing claim in a product-wide title. */
export function readConfirmedSupplierTextReferences(candidate) {
  // A UI-only SKU choice list is not a persisted supplier-text capture. Absence
  // is represented by not_provided; a declared capture still has to validate.
  if (candidate.aProductDetailEvidenceV1 === undefined && !Object.hasOwn(candidate.sourceCapture ?? {}, "title") &&
      (!Object.hasOwn(candidate.sourceCapture ?? {}, "captureId") || !Object.hasOwn(candidate.sourceCapture ?? {}, "skuChoices"))) return [];
  const sku = candidate.lifecycleV11?.skuPackage;
  const supply = sku?.selectedSupplySnapshot;
  if (!supply || !object(supply.supplierOption) || supply.ownerSupplyConfirmation?.status !== "confirmed") fail("CONFIRMED_SUPPLIER_SNAPSHOT_MISMATCH");
  buildSavedSkuFactReconciliation({ candidate });
  const captureId = supply.supplierSku.attributes?.quantityOneEvidence?.captureId;
  const selection = confirmedVariantSelection(candidate, { supplierSkuId: sku.supplierSkuId, variantKey: sku.variantKey, captureId, confirmedSupplySnapshot: supply });
  if (selection === null) fail("CONFIRMED_SUPPLIER_TEXT_SOURCE_MISMATCH");
  const { capture } = selection;
  const option = supply.supplierOption;
  if (option.sourcePlatform !== "1688" || capture.offerId !== option.offerId ||
      capture.sourceUrl !== option.productUrl || option.productUrl !== `https://detail.1688.com/offer/${option.offerId}.html` ||
      supply.ownerSupplyConfirmation.supplierOptionId !== option.supplierOptionId) fail("CONFIRMED_SUPPLIER_TEXT_SOURCE_MISMATCH");
  const result = [];
  if (selection.apiEvidence) {
    const evidence = readAProductDetailSupplierEvidence(candidate).evidence;
    const facts = evidence.supplierResult.facts;
    for (const [key, kind] of [["title", "supplier_title"]]) {
      const value = facts[key];
      if (value === undefined || value === null || value === "unknown" || value === "") continue;
      if (!text(value)) fail("CONFIRMED_SUPPLIER_TEXT_INVALID");
      result.push({ text: value, sourceRef: `${evidence.supplierReceiptRef}#/steps/0/result/facts/${key}`, kind });
    }
  } else if (capture.title !== undefined && capture.title !== null && capture.title !== "") {
    if (!text(capture.title) || !text(capture.titleSource)) fail("CONFIRMED_SUPPLIER_TEXT_INVALID");
    result.push({ text: capture.title, sourceRef: `${capture.captureId}#/title`, kind: "supplier_title" });
  }
  if (!selection.apiEvidence) {
    for (const [key, value] of Object.entries(selection.attributes)) {
      result.push({ text: `${key}：${value}`, sourceRef: `${capture.captureId}#/skuChoices/${selection.index}/attributes/${encodeURIComponent(key.replaceAll("~", "~0").replaceAll("/", "~1"))}`,
        kind: "supplier_variant_attribute" });
    }
  }
  // Only frozen supplier attributes are eligible; current product-wide lists are
  // not substituted for the exact variant selected above.
  for (const [key, value] of Object.entries(supply.supplierSku.attributes)) {
    if ((!selection.apiEvidence && Object.hasOwn(selection.attributes, key)) || ["品牌", "有可授权的自有品牌"].includes(key) || typeof value !== "string" || !value.trim()) continue;
    result.push({ text: `${key}：${value}`, sourceRef: `${supply.snapshotId}#/supplierSku/attributes/${encodeURIComponent(key.replaceAll("~", "~0").replaceAll("/", "~1"))}`,
      kind: "supplier_attribute" });
  }
  return result;
}

/** A separately versioned preparation record. It does not edit the old confirmed card or authorize a write. */
export function buildSavedSkuFactReconciliation({ candidate }) {
  const sku = candidate.lifecycleV11?.skuPackage, supply = sku?.selectedSupplySnapshot;
  if (!sku || !supply || supply.ownerSupplyConfirmation?.status !== "confirmed" ||
      !object(sku.g1Identity) || sku.g1Identity.candidateId !== candidate.id || sku.g1Identity.platform !== candidate.targetPlatform ||
      sku.g1Identity.skuPackageId !== sku.skuPackageId || sku.g1Identity.supplierSkuId !== sku.supplierSkuId ||
      !sameStoreRef(sku.g1Identity.storeRef, candidate.storeRef) ||
      [supply.supplierSku, supply.ownerSupplyConfirmation].some(item => !object(item) || item.supplierSkuId !== sku.supplierSkuId || item.variantKey !== sku.variantKey)) {
    fail("CONFIRMED_SUPPLIER_SNAPSHOT_MISMATCH");
  }
  const records = [], power = readConfirmedSupplierPowerProfile(candidate);
  if (power) records.push({ field: "battery", value: power.containsBattery ? "battery_present" : "no_battery", status: "confirmed",
    label: "电池", valueZh: power.containsBattery ? "含电池" : "无电池", sourceRefs: [power.sourceRef], powerProfile: power });
  const captureId = supply.supplierSku.attributes?.quantityOneEvidence?.captureId;
  const selection = confirmedVariantSelection(candidate, { supplierSkuId: sku.supplierSkuId, variantKey: sku.variantKey, captureId, confirmedSupplySnapshot: supply });
  if (selection) {
    const { capture, attributes: selected, index: selectedIndex } = selection;
    // API captures use the frozen ownerSupplyConfirmation checked above. The
    // browser path additionally retains its explicit owner SKU selection.
    if (!selection.apiEvidence && (capture.skuSelection?.selectedBy !== "owner" || !Array.isArray(capture.skuSelection.selectedSkuIds) ||
        !capture.skuSelection.selectedSkuIds.includes(sku.supplierSkuId))) fail("CONFIRMED_VARIANT_OWNER_SELECTION_MISSING");
    for (const [key, label] of [["颜色", "颜色"], ["尺码", "尺码"], ["规格", "选中规格"]]) {
      if (selected[key] !== undefined) records.push({ field: key === "颜色" ? "color" : key === "尺码" ? "size" : "variant", label,
        value: selected[key], valueZh: selected[key], status: "confirmed", sourceRefs: [`${captureId}#/skuChoices/${selectedIndex}/attributes`, supply.snapshotId] });
    }
  }
  const rights = sku.c1ProductPlan?.inputSnapshots?.skuRightsReview;
  if (rights !== undefined && rights !== null) {
    // Later C2 revisions do not invalidate the earlier signed review. Bind the
    // original supply and complete identity without relabelling its revision.
    const validation = validateC1SkuRightsReview(rights, { sourceIdentity: sku.g1Identity,
      variantKey: sku.variantKey, sourceSupplySnapshotId: supply.snapshotId });
    if (!validation.valid) fail("CONFIRMED_BRAND_SOURCE_MISMATCH");
    if (rights.brand.status === "unbranded") records.push({ field: "brand", label: "品牌", value: "Нет бренда", valueZh: "无品牌",
      status: "confirmed", sourceRefs: [...rights.brand.evidenceRefs] });
  }
  return { schemaVersion: "saved-sku-fact-reconciliation-v1", sourceCandidateId: candidate.id, sourceRevision: candidate.dataRevision,
    skuPackageId: sku.skuPackageId, supplierSkuId: sku.supplierSkuId, variantKey: sku.variantKey,
    sourceCardId: sku.productionConfirmationCard?.cardId ?? null, applicationStatus: "prepared_from_saved_confirmations", records,
    writesFrozenHistory: false, productionAuthorized: false };
}

/** Known source failures stay visible on this card, without hiding all other candidates. */
export function inspectSavedSkuFactReconciliation({ candidate }) {
  try { return buildSavedSkuFactReconciliation({ candidate }); }
  catch (error) {
    if (!(error instanceof ConfirmedSupplierInputError)) throw error;
    return { schemaVersion: "saved-sku-fact-reconciliation-v1", applicationStatus: "blocked", code: error.code,
      message: "已保存的确认资料未通过身份或来源核对，需要工程修复；未采用这些资料。", records: [],
      writesFrozenHistory: false, productionAuthorized: false };
  }
}


/** A traceable input revision, separate from the original four frozen C1 inputs. */
export function createC1SupplierFactRevision({ candidate, revisionId, targetC1PlanId, preparedAt }) {
  if (!isCanonicalFrozenRef(revisionId) || !isCanonicalFrozenRef(targetC1PlanId) ||
      !canonicalTime(preparedAt)) fail("C1_SUPPLIER_FACT_REVISION_INPUT_INVALID");
  const reconciliation = buildSavedSkuFactReconciliation({ candidate });
  const ownerDeclaration = readOwnerProductFacts(candidate);
  if (ownerDeclaration !== null && Date.parse(ownerDeclaration.confirmedAt) > Date.parse(preparedAt)) fail("C1_SUPPLIER_FACT_REVISION_OWNER_TIME_INVALID");
  const sku = candidate.lifecycleV11.skuPackage;
  const sourceCandidate = {};
  for (const key of ["id", "dataRevision", "targetPlatform", "targetStore", "storeRef", "cargoFactsV1", "aProductDetailEvidenceV1"]) {
    if (Object.hasOwn(candidate, key)) sourceCandidate[key] = structuredClone(candidate[key]);
  }
  if (candidate.aProductDetailEvidenceV1 !== undefined) {
    const evidence = candidate.aProductDetailEvidenceV1;
    sourceCandidate.salesSnapshotsV11 = structuredClone(candidate.salesSnapshotsV11.filter(item => item.snapshotId === evidence.salesSnapshotId));
    sourceCandidate.supplierOptionsV11 = structuredClone(candidate.supplierOptionsV11.filter(item => item.supplierOptionId === evidence.supplierOptionId));
  }
  if (candidate.sourceCapture !== undefined) sourceCandidate.sourceCapture = Object.fromEntries(
    ["captureId", "skuChoices", "skuSelection"].filter(key => Object.hasOwn(candidate.sourceCapture, key))
      .map(key => [key, structuredClone(candidate.sourceCapture[key])]));
  sourceCandidate.lifecycleV11 = { skuPackage: {
    dataRevision: sku.dataRevision, skuPackageId: sku.skuPackageId, supplierSkuId: sku.supplierSkuId, variantKey: sku.variantKey,
    g1Identity: structuredClone(sku.g1Identity), selectedSupplySnapshot: structuredClone(sku.selectedSupplySnapshot),
    productionConfirmationCard: { cardId: sku.productionConfirmationCard.cardId },
    c1ProductPlan: { c1PlanId: sku.c1ProductPlan.c1PlanId, inputSnapshots: { skuRightsReview: structuredClone(sku.c1ProductPlan.inputSnapshots.skuRightsReview) } }
  } };
  if (ownerDeclaration !== null) {
    sourceCandidate.lifecycleV11.ownerProductFactsV1 = structuredClone(ownerDeclaration);
    sourceCandidate.lifecycleV11.skuPackage.targetPlatform = sku.targetPlatform;
  }
  const record = { schemaVersion: ownerDeclaration === null ? "c1-supplier-fact-revision-v1" : "c1-supplier-fact-revision-v2", revisionId, targetC1PlanId, preparedAt,
    sourceCandidateRevision: candidate.dataRevision, sourceSkuRevision: sku.dataRevision,
    sourceC1PlanId: sku.c1ProductPlan.c1PlanId, sourceSupplySnapshotId: sku.selectedSupplySnapshot.snapshotId,
    sourceIdentity: structuredClone(sku.g1Identity), records: structuredClone(reconciliation.records), sourceCandidate };
  assertNoRawPersistenceKeys(record, "sourceFactsRevision");
  assertNoProductionSecrets(record, "sourceFactsRevision");
  return record;
}

/** Reconstruct the declared facts from saved evidence, rather than trusting a list of replacement values. */
export function resolveC1SupplierFactRevision({ plan, sourceIdentity }) {
  const revision = plan.sourceFactsRevision;
  const supply = plan.inputSnapshots?.confirmedSupplierSkuSnapshot;
  if (!object(supply) || !object(supply.supplierSku)) fail("C1_SUPPLIER_FACT_REVISION_SOURCE_CHANGED");
  if (revision === undefined) return { supplierSku: supply.supplierSku, attributeSources: {}, powerSourceRef: null };
  const keys = ["schemaVersion", "revisionId", "targetC1PlanId", "preparedAt", "sourceCandidateRevision", "sourceSkuRevision",
    "sourceC1PlanId", "sourceSupplySnapshotId", "sourceIdentity", "records", "sourceCandidate"];
  if (!object(revision) || Object.keys(revision).length !== keys.length || keys.some(key => !Object.hasOwn(revision, key)) ||
      !["c1-supplier-fact-revision-v1", "c1-supplier-fact-revision-v2"].includes(revision.schemaVersion) || !isCanonicalFrozenRef(revision.revisionId) ||
      revision.targetC1PlanId !== plan.c1PlanId || revision.sourceC1PlanId !== plan.supersedes?.c1PlanId ||
      !isDeepStrictEqual(revision.sourceIdentity, sourceIdentity) || revision.sourceSupplySnapshotId !== supply.snapshotId ||
      sourceIdentity?.candidateId !== plan.frozenInputRefs?.candidateId || sourceIdentity?.skuPackageId !== plan.identity?.skuPackageId ||
      sourceIdentity?.supplierSkuId !== plan.identity?.supplierSkuId || sourceIdentity?.platform !== plan.identity?.targetPlatform ||
      !sameStoreRef(sourceIdentity?.storeRef, plan.inputSnapshots.platformSchemaRules?.storeRef) ||
      !Number.isSafeInteger(revision.sourceSkuRevision) || revision.sourceSkuRevision < 1 ||
      revision.sourceCandidate?.lifecycleV11?.skuPackage?.dataRevision !== revision.sourceSkuRevision ||
      revision.sourceCandidate?.lifecycleV11?.skuPackage?.c1ProductPlan?.c1PlanId !== revision.sourceC1PlanId ||
      revision.sourceCandidate?.id !== sourceIdentity?.candidateId || revision.sourceCandidate?.dataRevision !== revision.sourceCandidateRevision ||
      !canonicalTime(revision.preparedAt)) fail("C1_SUPPLIER_FACT_REVISION_SCOPE_MISMATCH");
  assertNoRawPersistenceKeys(revision, "sourceFactsRevision");
  assertNoProductionSecrets(revision, "sourceFactsRevision");
  const sourceSupply = revision.sourceCandidate.lifecycleV11?.skuPackage?.selectedSupplySnapshot;
  if (sourceSupply?.snapshotId !== supply.snapshotId || !isDeepStrictEqual(sourceSupply.supplierSku, supply.supplierSku) ||
      !isDeepStrictEqual(sourceSupply.ownerSupplyConfirmation, supply.ownerSupplyConfirmation)) fail("C1_SUPPLIER_FACT_REVISION_SOURCE_CHANGED");
  const rebuilt = buildSavedSkuFactReconciliation({ candidate: revision.sourceCandidate });
  if (!isDeepStrictEqual(rebuilt.records, revision.records)) fail("C1_SUPPLIER_FACT_REVISION_SOURCE_CHANGED");
  const declaration = readOwnerProductFacts(revision.sourceCandidate);
  if ((revision.schemaVersion === "c1-supplier-fact-revision-v2") !== (declaration !== null)) fail("C1_SUPPLIER_FACT_REVISION_OWNER_SOURCE_MISMATCH");
  if (declaration !== null && Date.parse(declaration.confirmedAt) > Date.parse(revision.preparedAt)) fail("C1_SUPPLIER_FACT_REVISION_OWNER_TIME_INVALID");
  const ownerFacts = declaration === null ? [] : Object.entries(declaration.facts).filter(([, value]) => value !== null)
    .map(([fieldKey, value]) => ({ fieldKey, label: OWNER_PRODUCT_FACT_LABELS[fieldKey],
      fact: { value: structuredClone(value), verificationStatus: "confirmed", sourceRefs: [`${declaration.declarationId}#/facts/${fieldKey}`], reason: null } }));
  const supplierSku = structuredClone(supply.supplierSku), attributeSources = {};
  let powerSourceRef = null;
  for (const [index, item] of revision.records.entries()) {
    const ref = `${revision.revisionId}#/records/${index}`;
    if (item.field === "battery") {
      const previous = supplierSku.powerProfile;
      if (object(previous) && typeof previous.containsBattery === "boolean" && previous.containsBattery !== item.powerProfile.containsBattery) {
        fail("C1_SUPPLIER_FACT_REVISION_POWER_CONFLICT");
      }
      supplierSku.powerProfile = { ...(object(previous) ? previous : {}), ...structuredClone(item.powerProfile) };
      powerSourceRef = ref;
    }
    const key = { color: "颜色", size: "尺码", variant: "规格" }[item.field];
    if (key) { supplierSku.attributes[key] = item.value; attributeSources[key] = ref; }
  }
  return { supplierSku, attributeSources, powerSourceRef, ...(declaration === null ? {} : { ownerFacts }) };
}


export function assertC1SupplierFactRevisionProjection({ plan, sourceIdentity }) {
  if (plan.productAttributes && Object.hasOwn(plan.productAttributes, "ownerDeclaredFacts") &&
      plan.sourceFactsRevision?.schemaVersion !== "c1-supplier-fact-revision-v2") fail("C1_SUPPLIER_FACT_REVISION_OWNER_SOURCE_MISMATCH");
  const projected = resolveC1SupplierFactRevision({ plan, sourceIdentity });
  if (plan.sourceFactsRevision === undefined || plan.status === "inputs_ready") return projected;
  if (projected.ownerFacts !== undefined && !isDeepStrictEqual(plan.productAttributes?.ownerDeclaredFacts, projected.ownerFacts)) {
    fail("C1_SUPPLIER_FACT_REVISION_OWNER_PROJECTION_CHANGED");
  }
  if (projected.ownerFacts === undefined && plan.productAttributes?.ownerDeclaredFacts !== undefined) fail("C1_SUPPLIER_FACT_REVISION_OWNER_PROJECTION_CHANGED");
  for (const [key, ref] of Object.entries(projected.attributeSources)) {
    const entries = plan.productAttributes?.supplierAttributes?.filter(item => item.fieldKey === key);
    if (!Array.isArray(entries) || entries.length !== 1 || entries[0].fact.verificationStatus !== "confirmed" ||
        !isDeepStrictEqual(entries[0].fact.value, projected.supplierSku.attributes[key]) ||
        !isDeepStrictEqual(entries[0].fact.sourceRefs, [ref])) fail("C1_SUPPLIER_FACT_REVISION_PROJECTION_CHANGED");
  }
  if (projected.powerSourceRef) for (const field of ["containsBattery", "batteryType"]) {
    const fact = plan.batteryAssessment?.[field];
    if (fact?.verificationStatus !== "confirmed" || fact.value !== projected.supplierSku.powerProfile[field] ||
        !isDeepStrictEqual(fact.sourceRefs, [projected.powerSourceRef])) fail("C1_SUPPLIER_FACT_REVISION_PROJECTION_CHANGED");
  }
  return projected;
}
