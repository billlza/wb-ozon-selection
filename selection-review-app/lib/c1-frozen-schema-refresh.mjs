import { C1_SCHEMA_CONTENT_FIELDS } from "./lifecycle-b-input-bundle.mjs";

export class C1FrozenSchemaRefreshError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "C1FrozenSchemaRefreshError";
    this.code = code;
    this.detail = detail;
  }
}

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
/** 两边都没有店铺身份也算一致；一有一无是真冲突，不能放过。 */
function sameStoreRef(a, b) {
  const hasA = isObject(a), hasB = isObject(b);
  if (!hasA && !hasB) return true;
  if (!hasA || !hasB) return false;
  return a.stableStoreId === b.stableStoreId && a.platformStoreId === b.platformStoreId &&
    a.mappingVersion === b.mappingVersion;
}

/**
 * 把计划里冻结的那份平台 Schema 换成**刚读回来的同一个类目**的新版本。
 *
 * 为什么需要它：2026-09-17 02:44 冻结这件商品时，证据服务的 Schema 读取把 47 个属性
 * 筛成了 4 个必填、还丢掉了字典号（当天深夜才补上）。于是冻结副本里没有属性表，
 * 主人在界面上根本挑不了属性，也就没法把中文事实对到 Ozon 的俄文字典值上。
 *
 * 它只在计划还停在 `inputs_ready` 时可做——那时事实**尚未冻结**，换的是「冻之前的输入」。
 *
 * **换的必须是同一个类目、同一个店铺**：descriptionCategoryId、typeId、platform、store、storeRef
 * 有任何一项对不上就停。换成别的类目那是另一件商品，不是刷新。
 *
 * 三个引用必须**一起**换：`inputRefs.platformSchemaEvidenceId`、`frozenInputRefs.schemaSnapshotRef`
 * 和 `plan.schemaSnapshotRef`。C2 的规范门（c2-asset-lifecycle.mjs）要求三者逐字相同，
 * 只换一半，计划自己就不自洽，到 C2 门口才会炸。
 *
 * 必填字段变了不拦，但**如实报出来**：那是平台侧真的改了，主人有权知道。
 */
export function refreshC1FrozenPlatformSchema({ skuPackage, freshPack, refreshedAt }) {
  if (!isObject(skuPackage) || !isObject(freshPack) || !nonEmpty(refreshedAt) || Number.isNaN(Date.parse(refreshedAt))) {
    throw new C1FrozenSchemaRefreshError("C1_FROZEN_SCHEMA_REFRESH_INPUT_INVALID");
  }
  if (skuPackage.businessPhase !== "C1") throw new C1FrozenSchemaRefreshError("C1_FROZEN_SCHEMA_REFRESH_PHASE_REJECTED");
  if (skuPackage.productionAuthorization || skuPackage.productionRecord) {
    throw new C1FrozenSchemaRefreshError("C1_FROZEN_SCHEMA_REFRESH_ALREADY_PRODUCED");
  }
  const plan = skuPackage.c1ProductPlan;
  if (!isObject(plan) || plan.status !== "inputs_ready") {
    throw new C1FrozenSchemaRefreshError("C1_FROZEN_SCHEMA_REFRESH_FACTS_ALREADY_FROZEN");
  }
  const current = plan.inputSnapshots?.platformSchemaRules;
  if (!isObject(current)) throw new C1FrozenSchemaRefreshError("C1_FROZEN_SCHEMA_REFRESH_CURRENT_MISSING");
  if (freshPack.kind !== "schema" || freshPack.status !== "active" || !nonEmpty(freshPack.id) ||
      !isObject(freshPack.evidenceData) || !isObject(freshPack.scope) ||
      !nonEmpty(freshPack.scope.ruleVersion) || !nonEmpty(freshPack.checkedAt)) {
    throw new C1FrozenSchemaRefreshError("C1_FROZEN_SCHEMA_REFRESH_PACK_INVALID");
  }
  const data = freshPack.evidenceData;
  // 同一个类目、同一个店铺才算刷新。任何一项对不上，那是别的商品的 Schema。
  if (Number(data.descriptionCategoryId) !== Number(current.descriptionCategoryId) ||
      Number(data.typeId) !== Number(current.typeId) ||
      freshPack.scope.platform !== current.platform || freshPack.scope.store !== current.store ||
      !sameStoreRef(freshPack.scope.storeRef, current.storeRef)) {
    throw new C1FrozenSchemaRefreshError("C1_FROZEN_SCHEMA_REFRESH_SCOPE_MISMATCH");
  }
  if (!Array.isArray(data.attributes) || data.attributes.length === 0) {
    // 读回来的仍然没有属性表，说明证据服务还没带出类目属性。照实说，不假装刷新成功。
    throw new C1FrozenSchemaRefreshError("C1_FROZEN_SCHEMA_REFRESH_ATTRIBUTES_MISSING");
  }
  if (!nonEmpty(data.schemaRevision) || !Array.isArray(data.requiredFields)) {
    throw new C1FrozenSchemaRefreshError("C1_FROZEN_SCHEMA_REFRESH_PACK_INVALID");
  }

  const next = {
    ...Object.fromEntries(C1_SCHEMA_CONTENT_FIELDS
      .filter((field) => Object.hasOwn(data, field))
      .map((field) => [field, structuredClone(data[field])])),
    evidenceId: freshPack.id,
    platform: current.platform,
    store: current.store,
    storeRef: structuredClone(current.storeRef),
    ruleVersion: freshPack.scope.ruleVersion,
    schemaRevision: data.schemaRevision,
    collectedAt: freshPack.checkedAt,
    requiredFields: structuredClone(data.requiredFields)
  };

  const before = new Map((current.requiredFields ?? []).map((item) => [item.fieldKey, item.label]));
  const after = new Map(next.requiredFields.map((item) => [item.fieldKey, item.label]));
  const change = {
    schemaVersion: "c1-frozen-schema-refresh-change-v1",
    previousEvidenceId: current.evidenceId,
    previousSchemaRevision: current.schemaRevision,
    evidenceId: next.evidenceId,
    schemaRevision: next.schemaRevision,
    collectedAt: next.collectedAt,
    attributeCount: next.attributes.length,
    dictionaryBackedCount: next.attributes.filter((item) => Number(item.dictionaryId) > 0).length,
    requiredFieldsAdded: [...after.keys()].filter((key) => !before.has(key)),
    requiredFieldsRemoved: [...before.keys()].filter((key) => !after.has(key)),
    refreshedAt
  };

  const updated = structuredClone(skuPackage);
  const target = updated.c1ProductPlan;
  target.inputSnapshots.platformSchemaRules = next;
  // 三个引用一起换：少换一个，C2 的规范门就会判计划不自洽。
  target.inputRefs.platformSchemaEvidenceId = next.evidenceId;
  target.frozenInputRefs.schemaSnapshotRef = next.evidenceId;
  target.schemaSnapshotRef = next.evidenceId;
  return { skuPackage: updated, change };
}
