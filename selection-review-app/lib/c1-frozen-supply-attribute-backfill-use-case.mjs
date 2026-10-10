import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";

export class C1SupplyAttributeBackfillError extends Error {
  constructor(code) { super(code); this.name = "C1SupplyAttributeBackfillError"; this.code = code; }
}

/** 品牌不是事实：主人签的是无品牌声明，1688 页面上的牌子不能当商品事实搬进来。与 real-a-b-c1-flow.mjs 同一份名单。 */
const SUPPLIER_ATTRIBUTE_KEYS_NOT_FACTS = new Set(["品牌", "有可授权的自有品牌"]);
const UNKNOWN = "unknown";

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }

/**
 * 同一次采集里已经采到、但当时没有搬进冻结快照的供应商属性。
 *
 * 为什么需要这一步：2026-09-17 02:44 冻结这件商品的供应快照时，`supplierOption()` 还没有搬运
 * `sourceCapture.supplierAttributes`（那是当天晚些时候 r36 才补上的）。结果是页面上明明采到了
 * 17 条属性——面料「牛津布」、产品类别、适合季节、颜色——冻结快照里却只有数量与成本证据，
 * `material` 恒为 "unknown"。C1 事实核验因此确认不出任何一条商品属性，下游要靠事实背书的
 * 关键词就无从谈起（`c1-seo-draft.mjs` 要求每个词都绑到 verificationStatus === "confirmed" 的事实）。
 *
 * 这一步**不引入任何新证据**：搬的是同一个 captureId 里已经存在的字段。所以它要求
 * 冻结快照记的 captureId 与候选当前的 `sourceCapture.captureId` **完全相同**——
 * 不同就说明那是另一次采集，属于新证据，必须走正经的货源确认流程，不能从这里抄近路。
 *
 * 它也**只补不改**：任何已经冻结过的键，新值必须逐字相同，否则停下来报错。
 * `material` 只允许从 "unknown" 变成页面上的面料，已经有值就不动。
 * 价格、重量、尺寸、主人确认、SKU 身份一律不碰。
 *
 * 只允许在 C1 计划还停在 `inputs_ready` 时做——那时事实**尚未冻结**，
 * 补的是「冻之前的输入」，不是「改已冻的事实」。计划一旦 facts_checked 就拒绝。
 */
export function createC1SupplyAttributeBackfillUseCase({ repository, runtimeMode, serverClock }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode) || typeof serverClock !== "function") {
    throw new TypeError("C1_SUPPLY_ATTRIBUTE_BACKFILL_DEPENDENCY_INVALID");
  }
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);
  return Object.freeze({
    async backfill({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      const keys = ["candidateId", "expectedRevision", "skuPackageId", "idempotencyKey", "auditEventId"];
      if (!isObject(input) || Object.keys(input).length !== keys.length ||
          keys.some(key => !Object.hasOwn(input, key)) ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
          keys.filter(key => key !== "expectedRevision").some(key => !nonEmpty(input[key]))) {
        throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_INPUT_INVALID");
      }
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") {
        throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_AUTHENTICATED_OWNER_REQUIRED");
      }
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"],
        action: "c1_frozen_supply_attribute_backfill", candidateId: input.candidateId, skuPackageId: input.skuPackageId,
        expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId,
        serverClock,
        mutate: ({ candidate, observedAt }) => {
          const sku = candidate.lifecycleV11?.skuPackage;
          if (sku?.skuPackageId !== input.skuPackageId) throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_SOURCE_CONFLICT");
          if (sku.businessPhase !== "C1") throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_PHASE_REJECTED");
          if (sku.productionAuthorization || sku.productionRecord) {
            throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_ALREADY_PRODUCED");
          }
          const plan = sku.c1ProductPlan;
          // 事实一旦冻结，这里就不再是「补输入」而是「改已冻事实」，必须拒绝。
          if (!isObject(plan) || plan.status !== "inputs_ready") {
            throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_FACTS_ALREADY_FROZEN");
          }

          const captured = candidate?.sourceCapture?.supplierAttributes;
          if (!isObject(captured)) throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_CAPTURE_MISSING");
          const captureId = candidate?.sourceCapture?.captureId;
          if (!nonEmpty(captureId)) throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_CAPTURE_MISSING");

          const targets = [sku.selectedSupplySnapshot, plan.inputSnapshots?.confirmedSupplierSkuSnapshot];
          if (targets.some(target => !isObject(target?.supplierSku) || !isObject(target.supplierSku.attributes))) {
            throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_SNAPSHOT_SHAPE_UNEXPECTED");
          }
          // 同一次采集才准补。冻结快照自己记着当时那次采集的号，两边对不上就说明是新证据。
          for (const target of targets) {
            if (target.supplierSku.attributes?.quantityOneEvidence?.captureId !== captureId) {
              throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_CAPTURE_MISMATCH");
            }
          }

          const additions = {};
          for (const [key, value] of Object.entries(captured)) {
            if (SUPPLIER_ATTRIBUTE_KEYS_NOT_FACTS.has(key)) continue;
            if (typeof value !== "string" || !value.trim()) continue;
            additions[key] = value.trim();
          }
          if (Object.keys(additions).length === 0) throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_NOTHING_TO_ADD");

          // 只补不改：已经冻过的键，新值必须逐字相同。对不上就停，不悄悄以新的为准。
          for (const target of targets) {
            for (const [key, value] of Object.entries(additions)) {
              if (!Object.hasOwn(target.supplierSku.attributes, key)) continue;
              if (target.supplierSku.attributes[key] !== value) {
                throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_FROZEN_VALUE_CONFLICT");
              }
            }
          }
          const fabric = additions["面料"] ?? null;
          for (const target of targets) {
            const current = target.supplierSku.material;
            if (fabric !== null && current !== UNKNOWN && current !== fabric) {
              throw new C1SupplyAttributeBackfillError("C1_SUPPLY_ATTRIBUTE_BACKFILL_FROZEN_VALUE_CONFLICT");
            }
          }

          let addedKeys = [];
          for (const target of targets) {
            const before = { ...target.supplierSku.attributes };
            Object.assign(target.supplierSku.attributes, additions);
            addedKeys = Object.keys(additions).filter(key => !Object.hasOwn(before, key));
            // 面料就是材质。采不到就保持 unknown，不替主人猜。
            if (fabric !== null && target.supplierSku.material === UNKNOWN) target.supplierSku.material = fabric;
          }

          candidate.updatedAt = observedAt;
          candidate.lastModifiedBy = "software";
          return {
            candidate,
            result: {
              schemaVersion: "c1-frozen-supply-attribute-backfill-result-v1",
              captureId,
              addedAttributeKeys: [...addedKeys],
              materialResolved: fabric,
              skippedNonFactKeys: Object.keys(captured).filter(key => SUPPLIER_ATTRIBUTE_KEYS_NOT_FACTS.has(key)),
              externalCalls: 0, aiCalls: 0, platformWrites: 0, paidCalls: 0
            }
          };
        }
      });
    }
  });
}
