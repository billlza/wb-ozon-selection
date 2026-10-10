import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { assertBusinessStateRepositoryBoundary, assertCentralPersistenceBoundary } from "./business-state-repository.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";
import { fingerprintCanonicalRecord } from "./production-contract-primitives.mjs";
import { resolveC1SkuRightsReviewForFacts } from "./c1-sku-rights-review.mjs";
import { applyPreparedC1OzonAttributeMapping, assertValidC1ProductPlan, verifyC1ProductFacts } from "./c1-product-plan.mjs";
import { sameStoreRef } from "./store-binding.mjs";
import { assertCurrentC1SkuRightsReview } from "./c1-sku-rights-review.mjs";
import { resolveSavedC1ColorDictionaryValue } from './c1-color-dictionary-read-use-case.mjs';

export const C1_OZON_ATTRIBUTE_MAPPING_VERSION = "c1-ozon-attribute-mapping-v1";

export class C1OzonAttributeMappingError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "C1OzonAttributeMappingError";
    this.code = code;
    this.detail = detail;
  }
}

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function factAtPath(plan, path) { return String(path || "").split(".").reduce((node, key) => node?.[key], plan); }

/** Pure candidate projection shared by the authenticated mutation and isolated
 * previews. It never persists or authenticates; candidate revision is reserved
 * for the surrounding atomic repository commit. */
export function applySavedDictionaryMappingToPreparedRevision({ candidate, input, confirmationRef, confirmedBy, observedAt }) {
  if (!isObject(candidate) || !isObject(input) || candidate.id !== input.candidateId ||
      candidate.dataRevision !== input.expectedRevision || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      !nonEmpty(observedAt) || !Number.isFinite(Date.parse(observedAt)) ||
      !nonEmpty(input.receiptId) || !isObject(input.mapping) ||
      ["attributeId", "value", "sourceFactPath"].some(key => !nonEmpty(input.mapping[key]))) {
    throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_INPUT_INVALID");
  }
  candidate = structuredClone(candidate);
  const life = candidate.lifecycleV11, sku = life?.skuPackage, plan = sku?.c1ProductPlan;
  const prep = life?.c1FinalPlanRevisionPreparation;
  if (sku?.skuPackageId !== input.skuPackageId || sku.businessPhase !== "C1" || plan?.status !== "facts_checked" ||
      !prep || prep.schemaVersion !== "c1-final-plan-revision-preparation-v1" || prep.status !== "facts_prepared" ||
      prep.candidateId !== candidate.id || prep.skuPackageId !== sku.skuPackageId ||
      prep.targetC1PlanId !== plan.c1PlanId || prep.sourceFactsRevisionId !== plan.sourceFactsRevision?.revisionId ||
      prep.historyRef !== plan.supersedes?.historyRef || prep.sourceC1PlanId !== plan.supersedes?.c1PlanId ||
      prep.supplierSkuId !== sku.supplierSkuId || prep.variantKey !== sku.variantKey ||
      prep.resultCandidateRevision > candidate.dataRevision ||
      ["c1AiDraftRequestV1", "c1AiDraftJobRefV1", "c1LocalDraftSourceV1", "c1ContentReviewV1", "c1EditorialContentReviewV1", "c1FinalPlanRevisionCompletion"]
        .some(key => life[key] !== undefined && life[key] !== null) ||
      sku.productionAuthorization || sku.productionRecord || sku.c2FinalAssets || sku.productionConfirmationCard) {
    throw new C1OzonAttributeMappingError("C1_PREPARED_MAPPING_LINEAGE_REJECTED");
  }
  const history = life.c1FinalPlanRevisionHistory?.filter(item => item.preparationId === prep.historyRef);
  if (!Array.isArray(history) || history.length !== 1 || history[0].sourceC1PlanId !== prep.sourceC1PlanId ||
      history[0].sourceCandidateRevision !== prep.sourceCandidateRevision ||
      !sameStoreRef(history[0].sourceIdentity?.storeRef, sku.g1Identity.storeRef) ||
      history[0].sourceIdentity?.supplierSkuId !== sku.g1Identity.supplierSkuId ||
      history[0].sourceIdentity?.candidateId !== candidate.id || history[0].sourceIdentity?.skuPackageId !== sku.skuPackageId ||
      history[0].sourceIdentity?.platform !== sku.g1Identity.platform || history[0].variantKey !== sku.variantKey) {
    throw new C1OzonAttributeMappingError("C1_PREPARED_MAPPING_LINEAGE_REJECTED");
  }
  assertValidC1ProductPlan(plan);
  assertCurrentC1SkuRightsReview({ plan, sourceIdentity: sku.g1Identity, observedAt });
  const schema = plan.inputSnapshots.platformSchemaRules;
  const receipts = life.c1OzonDictionaryReadReceipts?.filter(item => item.receiptId === input.receiptId);
  const receipt = receipts?.[0], mapping = input.mapping;
  if (!Array.isArray(receipts) || receipts.length !== 1 || receipt.schemaVersion !== "c1-ozon-dictionary-read-receipt-v1" ||
      receipt.status !== "completed" || receipt.candidateId !== candidate.id || receipt.skuPackageId !== sku.skuPackageId ||
      receipt.sourceC1PlanId !== prep.sourceC1PlanId || !Number.isSafeInteger(receipt.sourceCandidateRevision) ||
      receipt.sourceCandidateRevision < 1 || receipt.sourceCandidateRevision > prep.sourceCandidateRevision ||
      receipt.platform !== "ozon" || sku.g1Identity.platform !== "ozon" ||
      !sameStoreRef(receipt.storeRef, sku.g1Identity.storeRef) || !sameStoreRef(receipt.storeRef, schema.storeRef) ||
      receipt.schemaRevision !== schema.schemaRevision || receipt.descriptionCategoryId !== schema.descriptionCategoryId ||
      receipt.typeId !== schema.typeId || String(receipt.attributeId) !== mapping.attributeId || receipt.query !== mapping.value ||
      !nonEmpty(receipt.sourceRef) || !nonEmpty(receipt.ownerInstructionRef) || receipt.requestCount !== 1 ||
      !nonEmpty(receipt.checkedAt) || !Number.isFinite(Date.parse(receipt.checkedAt)) || Date.parse(receipt.checkedAt) > Date.parse(observedAt) ||
      (receipt.requestedAt !== undefined && (!nonEmpty(receipt.requestedAt) || !Number.isFinite(Date.parse(receipt.requestedAt)) ||
        Date.parse(receipt.requestedAt) > Date.parse(receipt.checkedAt))) ||
      (receipt.httpStatus !== undefined && (!Number.isInteger(receipt.httpStatus) || receipt.httpStatus < 200 || receipt.httpStatus >= 300)) ||
      !isObject(receipt.exactMatch) || receipt.exactMatch.value !== mapping.value ||
      !Number.isSafeInteger(receipt.exactMatch.id) || receipt.exactMatch.id <= 0) {
    throw new C1OzonAttributeMappingError("C1_PREPARED_MAPPING_RECEIPT_REJECTED");
  }
  const fact = factAtPath(plan, mapping.sourceFactPath);

  candidate.lifecycleV11.skuPackage = structuredClone(applyPreparedC1OzonAttributeMapping({ skuPackage: sku,
    mapping: { ...mapping, dictionaryValueId: receipt.exactMatch.id, sourceFactValue: fact?.value,
      dictionaryEvidenceRef: receipt.sourceRef }, confirmationRef, confirmedBy, mappedAt: observedAt }).skuPackage);
  candidate.updatedAt = observedAt; candidate.lastModifiedBy = "software";
  return { candidate, result: { mappedAttributeIds: [mapping.attributeId], receiptId: receipt.receiptId,
    externalCalls: 0, aiCalls: 0, platformWrites: 0, paidCalls: 0, productionAuthorized: false } };
}

/**
 * 主人把一条**已确认的中文事实**对到 **Ozon 类目字典里的俄文值**上。
 *
 * 为什么必须有这一步：本品的事实来自 1688，全是中文（2026-09-17 实测：44 条已确认事实里
 * 值是俄文的只有类目路径那一条）。而 Ozon 这边两处都要俄文——
 *  - 关键词要求**逐字等于**某条已确认事实的值（`c1-keyword-planning-evidence-producer.mjs`，
 *    bindingRelation 只认 exact_value），没有俄文值的事实就凑不出俄文关键词；
 *  - 字典属性没有 dictionaryValueId，真发 import 会报 OZON_ADAPTER_DICTIONARY_VALUE_REQUIRED。
 *
 * 软件在这里只做能证伪的事：
 *  - 属性号必须在**当前冻结 schema** 的属性表里；
 *  - 带字典的属性，俄文值必须由 Ozon 自己的字典读数**逐字命中**（"Оксфорд" 和 "Оксфорд 210D"
 *    是两个值，不拿近似的顶）；字典读数在事务之外完成，写入时不打任何外部调用；
 *  - 中文那端必须是一条 verificationStatus === "confirmed" 且不是 "unknown" 的事实，
 *    它当时的值一并记下来，将来漂了投影就会退回 unknown（见 c1-product-plan.mjs 的 ozonAttributeFacts）。
 *
 * 中俄之间的对应关系是**商业判断，软件读不出来**，由主人给，如实记成他的确认——
 * 和 A 阶段抽样复核同一套语义。
 *
 * 原始 map 只允许 `inputs_ready`；已核验的新准备版本使用
 * mapPreparedRevision，消费已保存回执并保留原冻结输入和历史。
 */
export function createC1OzonAttributeMappingUseCase({ repository, runtimeMode, serverClock, readDictionaryValue }) {
  if (!["local_development", "central_test", "central_production"].includes(runtimeMode) ||
      typeof serverClock !== "function" || typeof readDictionaryValue !== "function") {
    throw new TypeError("C1_OZON_ATTRIBUTE_MAPPING_DEPENDENCY_INVALID");
  }
  if (runtimeMode === "local_development") assertBusinessStateRepositoryBoundary(repository);
  else assertCentralPersistenceBoundary(repository);

  function planAt(candidate, skuPackageId, observedAt) {
    const sku = candidate?.lifecycleV11?.skuPackage;
    if (sku?.skuPackageId !== skuPackageId) throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_SOURCE_CONFLICT");
    if (sku.businessPhase !== "C1") throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_PHASE_REJECTED");
    if (sku.productionAuthorization || sku.productionRecord) {
      throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_ALREADY_PRODUCED");
    }
    const plan = sku.c1ProductPlan;
    if (!isObject(plan) || plan.status !== "inputs_ready") {
      throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_FACTS_ALREADY_FROZEN");
    }
    const schema = plan.inputSnapshots?.platformSchemaRules;
    if (!isObject(schema) || !Array.isArray(schema.attributes) || schema.attributes.length === 0) {
      // 冻结 schema 里没有属性表，说明这份证据是证据服务补出类目属性之前读的。
      throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_SCHEMA_ATTRIBUTES_MISSING");
    }
    // 中文那端要对着**核验之后**的事实查，所以先在内存里冻一份，不落盘。
    //
    // 声明已经签过就必须一起传进去，否则 verifyC1ProductFacts 会因为
    // 「已保存记录与冻结快照对不上」判 C1_RIGHTS_RECORD_DECLARATION_MISMATCH（2026-09-17 踩过）。
    // 还没签声明的候选不拦：这一步不冻结任何东西，权利那道闸在事实核验和上架前各有自己的关口。
    // 但声明**存在却没通过**是真问题，那就停下来。
    const rights = resolveC1SkuRightsReviewForFacts({ skuPackage: sku, observedAt });
    if (Object.hasOwn(sku, "c1RightsReviewRecord") && rights.status !== "verified") {
      throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_RIGHTS_NOT_VERIFIED", rights.code ?? rights.status);
    }
    const verified = verifyC1ProductFacts({ skuPackage: structuredClone(sku), skuRightsReview: rights.review, verifiedAt: observedAt }).skuPackage;
    return { sku, schema, verifiedPlan: verified.c1ProductPlan };
  }

  /** 计划里所有已确认、且不是 "unknown" 的事实，摊给主人当映射的中文那一端。 */
  function confirmedFacts(plan) {
    const found = [];
    const visit = (value, path) => {
      if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}.${index}`));
      if (!isObject(value)) return;
      if (["productAttributes.ozonAttributes", "productAttributes.requiredPlatformFields"].some((prefix) => path.startsWith(prefix))) return;
      if (value.verificationStatus === "confirmed" && Object.hasOwn(value, "value")) {
        if (value.value !== "unknown" && typeof value.value === "string") found.push({ factPath: path, value: value.value });
        return;
      }
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
    };
    for (const field of ["exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot",
      "batteryAssessment", "categoryRestrictions", "platformCompliance"]) visit(plan[field], field);
    return found;
  }

  return Object.freeze({
    /** New prepared revisions consume an already persisted, single-request
     * receipt. No dictionary reader is invoked, including during replay. */
    async mapPreparedRevision({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      const keys = ["candidateId", "skuPackageId", "expectedRevision", "receiptId", "mapping", "idempotencyKey", "auditEventId"];
      if (!isObject(input) || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)) ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
          keys.filter(key => !["mapping", "expectedRevision"].includes(key)).some(key => !nonEmpty(input[key])) ||
          !isObject(input.mapping) || Object.keys(input.mapping).length !== 3 ||
          ["attributeId", "value", "sourceFactPath"].some(key => !nonEmpty(input.mapping[key]))) {
        throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_INPUT_INVALID");
      }
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") {
        throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_AUTHENTICATED_OWNER_REQUIRED");
      }
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"],
        action: "c1_prepared_revision_ozon_attribute_mapping", candidateId: input.candidateId,
        skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId, serverClock,
        mutate: ({ candidate, observedAt }) => {
          return applySavedDictionaryMappingToPreparedRevision({ candidate, input,
            confirmationRef: `owner-ozon-attribute-mapping:${candidate.id}:${input.expectedRevision}`,
            confirmedBy: actor.userId, observedAt });
        }
      });
    },
    /**
     * 只读：把这个类目的全部属性、可以拿来当依据的已确认事实、以及已经签过的映射摊开。
     * 不改任何数据，也不查字典——字典查询只在主人真的要映射某个值时才发。
     */
    async propose({ actor, input }) {
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (!isObject(input) || !nonEmpty(input.candidateId) || !nonEmpty(input.skuPackageId) ||
          !Number.isSafeInteger(input.expectedRevision)) {
        throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_INPUT_INVALID");
      }
      const snapshot = await repository.readSnapshot();
      const candidate = snapshot.candidates?.find((item) => item.id === input.candidateId);
      if (!candidate) throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_CANDIDATE_NOT_FOUND");
      if (candidate.dataRevision !== input.expectedRevision) {
        throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_REVISION_CONFLICT");
      }
      const observedAt = new Date(serverClock()).toISOString();
      const { sku, schema, verifiedPlan } = planAt(candidate, input.skuPackageId, observedAt);
      const mapped = new Map((sku.ozonAttributeMappingsV1?.mappings ?? []).map((item) => [String(item.attributeId), item]));
      return Object.freeze({
        schemaVersion: "c1-ozon-attribute-proposal-v1",
        candidateId: candidate.id,
        dataRevision: candidate.dataRevision,
        skuPackageId: sku.skuPackageId,
        schemaRevision: schema.schemaRevision,
        category: `ozon:${schema.descriptionCategoryId}:${schema.typeId}`,
        attributes: schema.attributes.map((attribute) => ({
          fieldKey: String(attribute.fieldKey),
          label: attribute.label ?? null,
          required: attribute.required === true,
          dictionaryId: attribute.dictionaryId ?? 0,
          mapping: mapped.get(String(attribute.fieldKey)) ? structuredClone(mapped.get(String(attribute.fieldKey))) : null
        })),
        confirmedFacts: confirmedFacts(verifiedPlan),
        observedAt
      });
    },

    async map({ actor, input }) {
      input = structuredClone(input); actor = structuredClone(actor);
      const keys = ["candidateId", "expectedRevision", "skuPackageId", "mappings", "idempotencyKey", "auditEventId"];
      if (!isObject(input) || Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)) ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
          !Array.isArray(input.mappings) || input.mappings.length === 0 ||
          keys.filter((key) => !["expectedRevision", "mappings"].includes(key)).some((key) => !nonEmpty(input[key]))) {
        throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_INPUT_INVALID");
      }
      for (const mapping of input.mappings) {
        if (!isObject(mapping) || Object.keys(mapping).length !== 3 ||
            !nonEmpty(mapping.attributeId) || !nonEmpty(mapping.value) || !nonEmpty(mapping.sourceFactPath)) {
          throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_ENTRY_INVALID");
        }
      }
      const attributeIds = input.mappings.map((item) => item.attributeId.trim());
      if (new Set(attributeIds).size !== attributeIds.length) {
        throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_DUPLICATE_ATTRIBUTE");
      }
      authorizeOperation({ actor, requiredRoles: ["owner"] });
      if (actor.actorType !== "human" || actor.source !== "authenticated_identity_provider") {
        throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_AUTHENTICATED_OWNER_REQUIRED");
      }

      const snapshot = await repository.readSnapshot();
      const candidate = snapshot.candidates?.find((item) => item.id === input.candidateId);
      if (!candidate) throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_CANDIDATE_NOT_FOUND");
      if (candidate.dataRevision !== input.expectedRevision) {
        throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_REVISION_CONFLICT");
      }
      const observedAt = new Date(serverClock()).toISOString();
      const { sku, schema, verifiedPlan } = planAt(candidate, input.skuPackageId, observedAt);
      const attributeById = new Map(schema.attributes.map((item) => [String(item.fieldKey), item]));

      // 字典核实在事务之外做完：写入那一刻不打任何外部调用。
      const resolved = [];
      let dictionaryExternalCalls = 0;
      for (const mapping of input.mappings) {
        const attributeId = mapping.attributeId.trim();
        const value = mapping.value.trim();
        const attribute = attributeById.get(attributeId);
        if (!attribute) throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_ATTRIBUTE_NOT_IN_SCHEMA", attributeId);
        // 依据不能是**另一条映射自己产出的事实**（productAttributes.ozonAttributes 那一段）。
        // 2026-09-18 真踩到：第二轮把上一轮的产出当成「我们的事实」，6 条里 5 条绑回了自己，
        // 漂移守卫就此失效——它比的是事实值有没有变，而事实就是它自己。
        // 两段派生事实都不能当依据：ozonAttributes 是上一轮映射的投影，
        // requiredPlatformFields 也会被映射回填——绑过去就是自己给自己作证。
        if (["productAttributes.ozonAttributes", "productAttributes.requiredPlatformFields"]
          .some((prefix) => String(mapping.sourceFactPath).startsWith(prefix))) {
          throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_SELF_REFERENCED_FACT", `${attributeId} → ${mapping.sourceFactPath}`);
        }
        const fact = factAtPath(verifiedPlan, mapping.sourceFactPath);
        if (!isObject(fact) || fact.verificationStatus !== "confirmed" || fact.value === "unknown") {
          throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_SOURCE_FACT_NOT_CONFIRMED", `${attributeId} → ${mapping.sourceFactPath}`);
        }
        let dictionaryValueId = null;
        let dictionaryEvidenceRef = `${schema.evidenceId}#/attributes/${attributeId}`;
        if (attribute.dictionaryId > 0) {
          const savedSiblingColor = candidate.siblingSourceV1 && ['10096', '10097'].includes(attributeId);
          let exact, readSourceRef;
          if (savedSiblingColor) {
            const saved = resolveSavedC1ColorDictionaryValue({ candidate,
              evidencePacks: snapshot.evidencePacks, attributeId, value, observedAt });
            exact = { value, dictionaryValueId: saved.dictionaryValueId };
            readSourceRef = saved.sourceRef;
          } else {
            dictionaryExternalCalls += 1;
            const read = await readDictionaryValue({ store: schema.store,
              category: `ozon:${schema.descriptionCategoryId}:${schema.typeId}`, attributeId, value });
            exact = read?.evidenceData?.exactMatch ?? read?.exactMatch ?? null;
            readSourceRef = read?.sourceRef;
          }
          if (!isObject(exact) || exact.value !== value || !Number.isInteger(exact.dictionaryValueId) || exact.dictionaryValueId <= 0) {
            // 近似值不顶替：字典里没有逐字相同的那一条，就是没有。
            throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_DICTIONARY_VALUE_NOT_FOUND", `${attributeId} → ${value}`);
          }
          dictionaryValueId = exact.dictionaryValueId;
          if (nonEmpty(readSourceRef)) dictionaryEvidenceRef = readSourceRef;
        }
        resolved.push({
          attributeId, attributeLabel: attribute.label ?? null, dictionaryId: attribute.dictionaryId,
          value, dictionaryValueId,
          sourceFactPath: mapping.sourceFactPath, sourceFactValue: structuredClone(fact.value),
          dictionaryEvidenceRef
        });
      }

      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ["owner"],
        action: "c1_ozon_attribute_mapping", candidateId: input.candidateId, skuPackageId: input.skuPackageId,
        expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey,
        inputFingerprint: fingerprintCanonicalRecord(input), auditEventId: input.auditEventId,
        serverClock,
        mutate: ({ candidate: current, evidencePacks, observedAt: stagedAt }) => {
          // 读快照到落盘之间数据可能已经变了：身份和状态再查一遍，对不上就整轮不写。
          const { sku: currentSku, schema: currentSchema } = planAt(current, input.skuPackageId, stagedAt);
          if (currentSku.dataRevision !== sku.dataRevision || currentSchema.schemaRevision !== schema.schemaRevision) {
            throw new C1OzonAttributeMappingError("C1_OZON_ATTRIBUTE_MAPPING_SOURCE_CHANGED");
          }
          if (current.siblingSourceV1) {
            for (const mapping of resolved.filter(item => item.dictionaryId > 0 &&
                ['10096', '10097'].includes(item.attributeId))) {
              const saved = resolveSavedC1ColorDictionaryValue({ candidate: current,
                evidencePacks, attributeId: mapping.attributeId, value: mapping.value, observedAt: stagedAt });
              if (saved.dictionaryValueId !== mapping.dictionaryValueId ||
                  saved.sourceRef !== mapping.dictionaryEvidenceRef) {
                throw new C1OzonAttributeMappingError('C1_OZON_ATTRIBUTE_MAPPING_SOURCE_CHANGED');
              }
            }
          }
          currentSku.ozonAttributeMappingsV1 = {
            schemaVersion: C1_OZON_ATTRIBUTE_MAPPING_VERSION,
            schemaRevision: schema.schemaRevision,
            confirmationRef: `owner-ozon-attribute-mapping:${input.candidateId}:${input.expectedRevision}`,
            confirmedBy: actor.userId,
            confirmedAt: stagedAt,
            mappings: structuredClone(resolved)
          };
          current.updatedAt = stagedAt;
          current.lastModifiedBy = "software";
          return {
            candidate: current,
            result: {
              schemaVersion: "c1-ozon-attribute-mapping-result-v1",
              mappedAttributeIds: resolved.map((item) => item.attributeId),
              dictionaryBackedCount: resolved.filter((item) => item.dictionaryValueId !== null).length,
              freeTextCount: resolved.filter((item) => item.dictionaryValueId === null).length,
              externalCalls: dictionaryExternalCalls,
              aiCalls: 0, platformWrites: 0, paidCalls: 0
            }
          };
        }
      });
    }
  });
}
