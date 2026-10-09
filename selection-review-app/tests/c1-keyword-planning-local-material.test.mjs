import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { produceC1KeywordPlanningLocalMaterial } from "../lib/c1-keyword-planning-local-material.mjs";
import { persistC1KeywordPlanningLocalMaterial } from "../lib/c1-keyword-planning-local-material-persistence.mjs";
import { createKeywordEvidenceSnapshot } from "../lib/keyword-evidence-snapshot.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";

const NOW = "2026-08-25T08:00:00.000Z";
const EXPIRES = "2026-08-26T08:00:00.000Z";
const CANDIDATE_ID = "NON-TRAIN-LOCAL-MATERIAL";
const SKU_ID = "sku-lifecycle:NON-TRAIN-LOCAL-MATERIAL:WHITE";
const SUPPLY_REF = "evidence:supply:local-material:white";

function fact(value, sourceRefs = [SUPPLY_REF], verificationStatus = "confirmed") {
  return { value, verificationStatus, sourceRefs };
}

function sales(index) {
  return {
    schemaVersion: "sales-snapshot-v1.1",
    snapshotId: `sales:local-material:${index}`,
    version: `sales-v${index}`,
    fingerprint: `sales-fingerprint-${index}`,
    platform: "ozon",
    sellerType: index === 3 ? "unknown" : "cross_border_cn",
    title: `Деревянная полка для ванной ${index}`,
    attributes: { material: "дерево", color: "белый" },
    collectedAt: NOW,
    evidenceRef: `evidence:sales:local-material:${index}`,
    currentPrice: 1200 + index,
    currency: "RUB"
  };
}

function plan() {
  const first = sales(1);
  const schema = {
    evidenceId: "schema:local-material",
    platform: "ozon",
    store: "dandanshu",
    schemaRevision: "schema-v1",
    requiredFields: [],
    collectedAt: NOW
  };
  return {
    schemaVersion: "c1-product-plan-v1.1",
    c1PlanId: "c1:local-material:1",
    status: "facts_checked",
    createdAt: NOW,
    inputRefs: { salesSnapshotId: first.snapshotId, selectedSupplySnapshotId: SUPPLY_REF, profitModelVersion: "profit-v1", platformSchemaEvidenceId: schema.evidenceId },
    identity: { parentOpportunityId: "opportunity:local-material", skuPackageId: SKU_ID, supplierOptionId: "supplier-option:local-material", supplierSkuId: "WHITE", variantKey: "颜色:白色", targetPlatform: "ozon", targetStore: "dandanshu" },
    inputSnapshots: {
      salesSnapshot: first,
      confirmedSupplierSkuSnapshot: { snapshotId: SUPPLY_REF, version: "supply-v1", fingerprint: "supply-fingerprint-1" },
      profitModel: { profitModelVersion: "profit-v1", result: "passed" },
      platformSchemaRules: schema
    },
    externalAccesses: [], profitRecalculated: false, skuReplaced: false,
    finalSeo: null, finalAttributes: null, complianceDecision: null, generatedAssets: null, productionPayload: null,
    factVerificationVersion: "c1-fact-verification-v1.1", factsVerifiedAt: NOW,
    exactSkuVerification: { status: fact("verified"), supplierSkuId: fact("WHITE"), variantKey: fact("颜色:白色") },
    productAttributes: { status: fact("known"), material: fact("wood"), color: fact("unknown", [SUPPLY_REF], "unknown"), weight: fact(210) },
    platformCategory: { status: fact("identified"), categoryName: fact("Полки для ванной"), descriptionCategoryId: fact("17033001"), typeId: fact("94001") },
    schemaSnapshot: { status: fact("frozen"), schemaRevision: fact("schema-v1"), requiredFields: fact([]) },
    batteryAssessment: { status: fact("known"), assessment: fact("no_battery"), powered: fact(false), containsBattery: fact(false) },
    categoryRestrictions: { status: fact("known"), restrictions: fact([]) },
    platformCompliance: { status: fact("clear"), assessment: fact({ status: "clear" }), requiredFieldGapCount: fact(0) },
    seoTitleDraft: null, descriptionDraft: null, bulletPointsDraft: null, searchKeywordsDraft: null, seoEvidenceLayer: null
  };
}

function keyword(keyword) {
  return { keyword, sourceRefs: ["keyword:local"], factRefs: [SUPPLY_REF], score: null, scoringVersion: null, confidence: null, decision: null, decisionReason: null };
}

function candidate({ comparableCount = 3, includeSnapshot = true } = {}) {
  const c1Plan = plan();
  const sku = { g1Identity: { schemaVersion: "g1-identity-v1", candidateId: CANDIDATE_ID, skuPackageId: SKU_ID, platform: "ozon", storeRef: { stableStoreId: "dandanshu", platformStoreId: "synthetic-seller-001", mappingVersion: "synthetic-v1" }, supplierSkuId: "WHITE", merchantSku: "not_applicable", warehouseRef: "not_applicable", credentialAlias: "not_applicable", platformProductId: "not_applicable" }, skuPackageId: SKU_ID, supplierSkuId: "WHITE", businessPhase: "C1", businessResult: "pending", technicalStatus: "completed", ownerAction: "none", dataRevision: 8, c1ProductPlan: c1Plan };
  const snapshots = Array.from({ length: comparableCount }, (_, index) => sales(index + 1));
  const summaries = snapshots.map((snapshot) => ({ snapshotId: snapshot.snapshotId, sellerType: snapshot.sellerType, role: "primary", comparability: "comparable", priceEvidenceStatus: "verified", validityStatus: "current", evidenceTraceable: true }));
  const value = {
    id: CANDIDATE_ID,
    dataRevision: 20,
    workflowStatus: "listing_preparation",
    lifecycleV11: {
      skuPackage: sku,
      opportunityPackage: { parentOpportunityId: c1Plan.identity.parentOpportunityId, salesSnapshots: snapshots, marketAssessment: { primarySampleIds: snapshots.map((item) => item.snapshotId), sampleSummaries: summaries } }
    }
  };
  if (includeSnapshot) {
    const binding = {
      candidateId: CANDIDATE_ID,
      parentOpportunityId: c1Plan.identity.parentOpportunityId,
      skuPackageId: SKU_ID,
      dataRevision: 8,
      salesSnapshotVersion: "sales-v1",
      salesSnapshotFingerprint: "sales-fingerprint-1",
      supplySkuFactsVersion: "supply-v1",
      supplySkuFactsFingerprint: "supply-fingerprint-1"
    };
    value.lifecycleV11.k3CurrentBindingV1 = binding;
    value.lifecycleV11.k3KeywordEvidenceSnapshotV1 = createKeywordEvidenceSnapshot({
      snapshotId: "keyword-evidence:local-material:20",
      identity: { candidateId: CANDIDATE_ID, parentOpportunityId: c1Plan.identity.parentOpportunityId, skuPackageId: SKU_ID, dataRevision: 8 },
      bindings: {
        salesSnapshot: { snapshotId: c1Plan.inputRefs.salesSnapshotId, version: "sales-v1", fingerprint: "sales-fingerprint-1" },
        supplySkuFacts: { version: "supply-v1", fingerprint: "supply-fingerprint-1" }
      },
      collectedAt: NOW,
      expiresAt: EXPIRES,
      asOf: NOW,
      currentBinding: binding,
      sourceAttempts: [{ schemaVersion: "keyword-source-attempt-v1", attemptId: "attempt:local", provider: "local_fusion", queryId: "query:local", queryText: "local", locale: "ru-RU", targetPlatform: "ozon", traceRef: "trace:local", startedAt: NOW, channel: "local_fusion", status: "completed", requestId: "request:local", receiptId: null, completedAt: NOW, resultCount: 3, failureClass: null }],
      groups: { title_keywords: [keyword("полка для ванной")], attribute_and_tag_keywords: [keyword("деревянная полка")], description_long_tail: [keyword("полка для ванной без сверления")] }
    });
  }
  return value;
}

function actor() {
  return createActorContext({ userId: "selection-review-software", sessionId: "test:local-material", actorType: "software", roles: ["operator"], source: "test_state_machine", authenticatedAt: NOW });
}

test("普通非火车SKU只从已确认事实、3条冻结竞品文本和有效快照生成本地原料", () => {
  const result = produceC1KeywordPlanningLocalMaterial({ candidate: candidate(), expectedRevision: 20, producedAt: NOW });
  assert.equal(result.status, "ready");
  assert.equal(result.material.competitorTextSnapshots.length, 3);
  assert.equal(result.material.reusableKeywordSnapshot.status, "ready");
  assert.ok(result.material.exactLiteralFactTerms.some((item) => item.term === "wood"));
  assert.ok(!result.material.exactLiteralFactTerms.some((item) => item.term === "unknown"));
  assert.ok(!result.material.exactLiteralFactTerms.some((item) => item.term === "210"));
  assert.ok(result.material.competitorTextSnapshots.every((item) => item.role === "buyer_language_reference_only"));
  assert.deepEqual(Object.values(result.production.execution), [1, 0, 0, 0, 0, 0, 0]);
});

test("竞品不足或复用快照缺失时诚实not_ready，不制造完整SourceRecord或true_empty", () => {
  const few = produceC1KeywordPlanningLocalMaterial({ candidate: candidate({ comparableCount: 1 }), expectedRevision: 20, producedAt: NOW });
  assert.equal(few.status, "not_ready");
  assert.equal(few.material, null);
  assert.ok(few.production.gaps.some((item) => item.code === "comparable_count_invalid"));
  const noSnapshot = produceC1KeywordPlanningLocalMaterial({ candidate: candidate({ includeSnapshot: false }), expectedRevision: 20, producedAt: NOW });
  assert.equal(noSnapshot.status, "not_ready");
  assert.ok(noSnapshot.production.gaps.some((item) => item.code === "reusable_keyword_snapshot_missing"));
  assert.equal(JSON.stringify(noSnapshot).includes("true_empty"), false);
});

test("本地原料CAS保存r到r+1，同输入幂等且其他候选不变", async () => {
  const other = { id: "OTHER", dataRevision: 4, workflowStatus: "selection_processing" };
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate(), other] });
  const input = { repository, runtimeMode: "local_development", actor: actor(), candidateId: CANDIDATE_ID, expectedRevision: 20, producedAt: NOW, codexOffline: true };
  const first = await persistC1KeywordPlanningLocalMaterial(input);
  assert.equal(first.status, "committed");
  assert.equal(first.candidate.dataRevision, 21);
  assert.equal(first.candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1.resultCandidateRevision, 21);
  const replay = await persistC1KeywordPlanningLocalMaterial({ ...input, expectedRevision: 21 });
  assert.equal(replay.status, "already_current");
  const stored = await repository.readSnapshot();
  assert.deepEqual(stored.candidates[1], other);
  assert.equal(stored.runtime.softwareJobs?.length ?? 0, 0);
  assert.equal(stored.runtime.dispatches?.length ?? 0, 0);
});

test("并发同输入只提交一次，revision漂移与客户端秘密整笔拒绝", async () => {
  const repository = createMemoryBusinessStateRepository({ candidates: [candidate()] });
  const input = { repository, runtimeMode: "local_development", actor: actor(), candidateId: CANDIDATE_ID, expectedRevision: 20, producedAt: NOW, codexOffline: true };
  const [left, right] = await Promise.all([persistC1KeywordPlanningLocalMaterial(input), persistC1KeywordPlanningLocalMaterial(input)]);
  assert.equal([left.status, right.status].filter((status) => status === "committed").length, 1);
  await assert.rejects(() => persistC1KeywordPlanningLocalMaterial({ ...input, expectedRevision: 19 }), /REVISION_CONFLICT/);
  const poisoned = candidate();
  poisoned.lifecycleV11.opportunityPackage.salesSnapshots[0].attributes.prompt = "api_key=secret";
  assert.throws(() => produceC1KeywordPlanningLocalMaterial({ candidate: poisoned, expectedRevision: 20, producedAt: NOW }), /SECRET_FORBIDDEN/);
});

test("本地原料Schema固定3至5竞品且没有外部执行字段入口", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c1-keyword-planning-local-material-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.competitorTextSnapshots.minItems, 3);
  assert.equal(schema.properties.competitorTextSnapshots.maxItems, 5);
  assert.equal(schema.properties.reusableKeywordSnapshot.$ref, "keyword-evidence-snapshot-v1.schema.json");
  assert.equal(schema.properties.bindings.additionalProperties, false);
  const productionSchema = JSON.parse(await readFile(new URL("../schema/c1-keyword-planning-local-material-production-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(productionSchema.additionalProperties, false);
  assert.equal(productionSchema.properties.execution.properties.codexDispatches.const, 0);
});

// 密钥扫描器按**字段名**判，`categoryToken` 里带 "token" 就被当成凭据——2026-09-17 实测：
// 主人签完权利声明后，整条 C1 准备链被这一条误报挡死。放行的依据不是「这个名字我保证没问题」，
// 而是**值本身当场可证**：必须恰好等于同层两个明文数字拼出来的公开类目串。证明不了的照旧拒绝。
function withCategoryEvidence(evidence) {
  const poisoned = candidate();
  poisoned.lifecycleV11.opportunityPackage.salesSnapshots[0].platformCategoryEvidence = evidence;
  return poisoned;
}

test("categoryToken 只有在等于同层明文类目串时才放行，差一点就当密钥拒绝", () => {
  const proven = withCategoryEvidence({ descriptionCategoryId: 17028966, typeId: 96063, categoryToken: "ozon:17028966:96063" });
  assert.doesNotThrow(() => produceC1KeywordPlanningLocalMaterial({ candidate: proven, expectedRevision: 20, producedAt: NOW }),
    "值等于同层两个明文数字拼出来的串，就不是密钥");

  for (const [why, evidence] of [
    ["数字对不上", { descriptionCategoryId: 17028966, typeId: 96063, categoryToken: "ozon:17028966:99999" }],
    ["缺同层依据", { categoryToken: "ozon:17028966:96063" }],
    ["换了平台前缀", { descriptionCategoryId: 17028966, typeId: 96063, categoryToken: "wb:17028966:96063" }],
    ["塞了真凭据", { descriptionCategoryId: 17028966, typeId: 96063, categoryToken: "Bearer abc123" }],
    ["同层依据是字符串不是整数", { descriptionCategoryId: "17028966", typeId: "96063", categoryToken: "ozon:17028966:96063" }],
    ["同层依据是负数", { descriptionCategoryId: -17028966, typeId: -96063, categoryToken: "ozon:-17028966:-96063" }]
  ]) {
    assert.throws(() => produceC1KeywordPlanningLocalMaterial({ candidate: withCategoryEvidence(evidence), expectedRevision: 20, producedAt: NOW }),
      /SECRET_FORBIDDEN/, `${why}：证明不了就必须照旧拒绝`);
  }
});

test("放行只认 categoryToken 这一个名字，其他撞名字段照旧拒绝", () => {
  for (const key of ["accessToken", "apiToken", "token", "refresh_token"]) {
    const poisoned = withCategoryEvidence({ descriptionCategoryId: 17028966, typeId: 96063, [key]: "ozon:17028966:96063" });
    assert.throws(() => produceC1KeywordPlanningLocalMaterial({ candidate: poisoned, expectedRevision: 20, producedAt: NOW }),
      /SECRET_FORBIDDEN/, `${key} 不在放行之列`);
  }
});
