import { validateProductionAuthorizationRecord } from "./product-lifecycle-schema.mjs";
import { assertAuthorizedMediaUnchanged } from "./production-authorization-preparation.mjs";
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function readAuthorizedProductionSnapshot({ productionAuthorization, candidateId, candidateRevision, skuPackage, checkedAt = new Date().toISOString() } = {}) {
  if (!productionAuthorization || !candidateId || !Number.isInteger(candidateRevision) || !skuPackage) {
    throw new Error("PRODUCTION_AUTHORIZATION_CONTEXT_REQUIRED");
  }
  const validation = validateProductionAuthorizationRecord(productionAuthorization, {
    candidateId,
    candidateRevision,
    skuPackage,
    lifecycleState: "persisted"
  });
  if (!validation.valid) throw new Error(`ProductionAuthorization校验失败：${validation.errors.map((item) => `${item.path}: ${item.message}`).join("；")}`);
  // 读授权快照这一步也要确认：锁定范围里的这批地址就是主人当初授权的那批。
  assertAuthorizedMediaUnchanged(
    productionAuthorization.lockedScope.finalUploads,
    productionAuthorization.lockedScope.authorizedMediaFingerprint,
    "readAuthorizedProductionSnapshot"
  );
  return deepFreeze(structuredClone(productionAuthorization));
}
