import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createHash } from "node:crypto";

import { scoreAndGroupKeywordEvidence, KEYWORD_SCORING_VERSION, KEYWORD_SCORING_COMPONENTS, validateKeywordScoredSnapshot } from "../lib/keyword-evidence-scoring.mjs";
import { prepareKeywordEvidence } from "../lib/keyword-evidence-orchestrator.mjs";
import { createKeywordEvidenceSnapshot, keywordScoringGroupLimits, validateKeywordEvidenceSnapshot } from "../lib/keyword-evidence-snapshot.mjs";

const NOW = "2026-08-23T06:00:00.000Z";
const identity = { candidateId: "CX-K3-001", parentOpportunityId: "opportunity:CX-K3-001", skuPackageId: "sku:CX-K3-001:1", dataRevision: 9 };
const bindings = {
  salesSnapshot: { snapshotId: "sales:CX-K3-001:9", version: "sales-v1", fingerprint: "sales-fp-9" },
  supplySkuFacts: { version: "supply-v1", fingerprint: "supply-fp-9" }
};
const currentBinding = {
  ...identity,
  salesSnapshotVersion: bindings.salesSnapshot.version,
  salesSnapshotFingerprint: bindings.salesSnapshot.fingerprint,
  supplySkuFactsVersion: bindings.supplySkuFacts.version,
  supplySkuFactsFingerprint: bindings.supplySkuFacts.fingerprint
};

function attempt() {
  return {
    schemaVersion: "keyword-source-attempt-v1", attemptId: "attempt:local", provider: "local-keyword-fusion", channel: "local_fusion",
    queryId: "local:1", queryText: "frozen evidence", locale: "ru-RU", targetPlatform: "ozon", requestId: "local:1", receiptId: null,
    startedAt: NOW, completedAt: NOW, status: "completed", resultCount: 1, failureClass: null, traceRef: "local:trace"
  };
}

function raw(term, matchType = "exact_match", index = 1, refs = {}) {
  return {
    term,
    sourceRefs: refs.sourceRefs ?? ["attempt:local", `source:${index}`],
    factRefs: refs.factRefs ?? [`fact:${index}`],
    competitorRefs: refs.competitorRefs ?? (matchType === "exact_match" || matchType === "substitute" ? [`competitor:${index}`] : []),
    sourceTrust: null,
    matchType
  };
}

function preparation(candidates) {
  const base = {
    schemaVersion: "keyword-evidence-preparation-v1",
    sourcePreparationVersion: "keyword-source-preparation-v1",
    preparationId: "prep:1",
    preparationFingerprint: "",
    identity: structuredClone(identity), bindings: structuredClone(bindings), scope: { platform: "ozon", exactSku: "SKU-1", fulfillment: "rfbs" },
    businessGate: { approved: true, approvedAt: NOW, note: "approved", evidenceRef: "owner:A:9" }, preparedAt: NOW,
    result: "source_candidates_ready", coverage: "full", reusedSnapshot: null, sourceAttempts: [attempt()], rawCandidatePool: candidates,
    pointsBefore: null, pointsAfter: null, pointsSpent: null,
    connector: { seerfarConnectorSuspended: false, suspensionReason: null, healthTrigger: null, standardSkuCalls: 0, healthReceipts: [] },
    execution: { seerfarApiCalls: 0, browserCalls: 0, localFusionRuns: 1, networkCallsByLocalFusion: 0, modelCallsByLocalFusion: 0, automaticRetries: 0 },
    businessEffect: { businessPhaseChanged: false, businessResultChanged: false, bOrC1Created: false, dispatchesCreated: 0 }
  };
  return base;
}

async function validPreparation(candidates) {
  const frozen = {
    productFactTerms: candidates.filter((c) => c.matchType === "target_fact").map((c) => ({ ...c })),
    comparables: candidates.filter((c) => ["exact_match", "substitute"].includes(c.matchType)).map((c, i) => ({
      competitorRef: c.competitorRefs[0], comparabilityStatus: "proven", comparabilityEvidenceRefs: [`compare:${i}`], matchType: c.matchType,
      terms: [{ term: c.term, sourceRefs: c.sourceRefs, factRefs: c.factRefs, sourceTrust: null }]
    })),
    seedEvidence: candidates.filter((c) => c.matchType === "multi_seed").map((c) => ({ ...c }))
  };
  return prepareKeywordEvidence({
    identity, bindings, platform: "ozon", exactSku: "SKU-1", fulfillment: "rfbs", locale: "ru-RU",
    businessGate: { approved: true, approvedAt: NOW, note: "approved", evidenceRef: "owner:A:9" }, now: NOW,
    policy: { browserAllowed: false, browserPreauthorized: false },
    healthPolicy: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", ttlMs: 3600000, suspectedSystemicFailure: false,
      standardSkus: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], lastProof: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", provedAt: NOW } },
    frozenEvidence: frozen, reusableSnapshot: null
  }, { seerfarApi: async () => ({ attempt: { ...attempt(), channel: "api", provider: "seerfar", attemptId: "attempt:api", queryId: "api:1", requestId: "api:1", traceRef: "api:trace", resultCount: 0, failureClass: "true_empty" }, candidates: [] }) });
}

function component(value, name, extra = {}) {
  if (value === null) return null;
  return { value, rawValue: value, normalizationRule: "identity_0_100", evidenceRef: `metric:${name}`, observedAt: NOW, period: "30d", ...extra };
}

function metric(candidate, semantic, overrides = {}) {
  const components = Object.fromEntries(Object.keys(KEYWORD_SCORING_COMPONENTS).map((name) => [name, component(80, name)]));
  components.semanticMatch = component(semantic, "semanticMatch");
  components.returnCancelHealth = component(95, "returnCancelHealth", {
    rawValue: undefined, raw: { returnRate: 0.03, cancelRate: 0.02 }, normalizationRule: undefined,
    conversionRule: "round4(100-(returnRate+cancelRate)*100)"
  });
  if (candidate.matchType !== "exact_match") {
    components.competitorConsensus = null;
    components.competitorCount = null;
  }
  Object.assign(components, overrides);
  return { key: `${candidate.term.toLocaleLowerCase()}\u0000${candidate.matchType}`, descriptionGate: { approved: true, evidenceRef: `description-gate:${candidate.term}`, reason: "fact supported long tail" }, components };
}

function score(prep, metrics) {
  return scoreAndGroupKeywordEvidence({
    preparation: prep,
    metricEvidence: { version: "keyword-metrics-v1", preparationFingerprint: prep.preparationFingerprint, candidates: metrics },
    collectedAt: NOW, expiresAt: "2026-08-24T06:00:00.000Z", currentBinding
  });
}

test("版本化数量策略与Schema一致，九组件权重仍为100", async () => {
  assert.equal(Object.values(KEYWORD_SCORING_COMPONENTS).reduce((a, b) => a + b, 0), 100);
  for (const version of ["keyword-scoring-v1", KEYWORD_SCORING_VERSION]) {
    const schema = JSON.parse(await readFile(new URL(`../schema/${version}.schema.json`, import.meta.url), "utf8"));
    assert.equal(schema.properties.scoringVersion.const, version);
    assert.deepEqual(schema.properties.weights.const, KEYWORD_SCORING_COMPONENTS);
    assert.deepEqual(schema.properties.groupLimits.const, keywordScoringGroupLimits(version));
  }
});

test("语义79即使热度满分也不能进入title/tag，只能描述", async () => {
  const candidate = raw("hot but borderline");
  const prep = await validPreparation([candidate]);
  const m = metric(candidate, 79, { searchDemand: component(100, "searchDemand"), searchGrowth: component(100, "searchGrowth") });
  const snapshot = score(prep, [m]);
  assert.equal(snapshot.groups.title_keywords.length, 0);
  assert.equal(snapshot.groups.attribute_and_tag_keywords.length, 0);
  assert.equal(snapshot.groups.description_long_tail[0].keyword, candidate.term);
  assert.equal(snapshot.groups.description_long_tail[0].usageRestriction, "description_only");
  assert.deepEqual(snapshot.groups.description_long_tail[0].placementGateEvidence, m.descriptionGate);
});

test("语义80边界可进入title", async () => {
  const candidate = raw("semantic boundary");
  const prep = await validPreparation([candidate]);
  const snapshot = score(prep, [metric(candidate, 80)]);
  assert.equal(snapshot.groups.title_keywords[0].keyword, candidate.term);
});

test("缺Seerfar指标的local_fusion候选保留null并按已有权重归一化、低覆盖不阻塞", async () => {
  const candidate = raw("local fact", "target_fact");
  const prep = await validPreparation([candidate]);
  const m = metric(candidate, 90, {
    searchDemand: null, addToCartConversion: null, searchGrowth: null, competitorConsensus: null, competitorCount: null, titleDensity: null
  });
  const snapshot = score(prep, [m]);
  const record = snapshot.groups.title_keywords[0];
  assert.equal(record.components.searchDemand.value, null);
  assert.equal(record.components.searchDemand.evidenceRef, null);
  assert.ok(record.evidenceCoverage < 0.5);
  assert.ok(record.score > 0);
  assert.equal(snapshot.scoringContext.execution.networkCalls, 0);
});

test("exact与substitute证据分离，替代品不能增加精确竞品共识", async () => {
  const exact = raw("exact term", "exact_match", 1);
  const substitute = raw("substitute term", "substitute", 2);
  const prep = await validPreparation([exact, substitute]);
  const snapshot = score(prep, [metric(exact, 90), metric(substitute, 90)]);
  const exactRecord = snapshot.groups.title_keywords.find((x) => x.keyword === exact.term);
  const substituteRecord = snapshot.groups.title_keywords.find((x) => x.keyword === substitute.term);
  assert.equal(exactRecord.matchType, "exact_match");
  assert.equal(substituteRecord.matchType, "substitute");
  assert.equal(substituteRecord.components.competitorConsensus.value, null);
  assert.equal(substituteRecord.components.competitorCount.value, null);
});

test("非exact提供伪竞品共识或数量时明确拒绝", async () => {
  const candidate = raw("fake consensus", "substitute");
  const prep = await validPreparation([candidate]);
  for (const name of ["competitorConsensus", "competitorCount"]) {
    assert.throws(() => score(prep, [metric(candidate, 90, { [name]: component(99, name) })]), /NON_EXACT_CONSENSUS_FORBIDDEN/);
  }
});

test("19个唯一词按现行上限分组且无需补齐旧minimum", async () => {
  const candidates = Array.from({ length: 19 }, (_, i) => raw(`minimum keyword ${String(i).padStart(2, "0")}`, "exact_match", Math.floor(i / 2) + 1));
  const frozenComparables = Array.from({ length: 10 }, (_, group) => ({
    competitorRef: `competitor:${group + 1}`, comparabilityStatus: "proven", comparabilityEvidenceRefs: [`compare:${group + 1}`], matchType: "exact_match",
    terms: candidates.slice(group * 2, group * 2 + 2).map((c) => ({ term: c.term, sourceRefs: c.sourceRefs, factRefs: c.factRefs, sourceTrust: null }))
  }));
  const prep = await prepareKeywordEvidence({
    identity, bindings, platform: "ozon", exactSku: "SKU-1", fulfillment: "rfbs", locale: "ru-RU",
    businessGate: { approved: true, approvedAt: NOW, note: "approved", evidenceRef: "owner:A:9" }, now: NOW,
    policy: { browserAllowed: false, browserPreauthorized: false },
    healthPolicy: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", ttlMs: 3600000, suspectedSystemicFailure: false,
      standardSkus: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], lastProof: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", provedAt: NOW } },
    frozenEvidence: { productFactTerms: [], comparables: frozenComparables, seedEvidence: [] }, reusableSnapshot: null
  }, { seerfarApi: async () => ({ attempt: { ...attempt(), channel: "api", provider: "seerfar", attemptId: "attempt:api", queryId: "api:1", requestId: "api:1", traceRef: "api:trace", resultCount: 0, failureClass: "true_empty" }, candidates: [] }) });
  const snapshot = score(prep, prep.rawCandidatePool.map((c) => metric(c, 90)));
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot.groups).map(([k, v]) => [k, v.length])), {
    title_keywords: 5, attribute_and_tag_keywords: 12, description_long_tail: 2
  });
  const keywords = Object.values(snapshot.groups).flat();
  const historicalReady = historicalV1(snapshot, {
    title_keywords: keywords.slice(0, 3), attribute_and_tag_keywords: keywords.slice(3, 9), description_long_tail: keywords.slice(9)
  });
  assert.equal(historicalReady.status, "ready");
  assert.equal(validateKeywordScoredSnapshot(historicalReady, { currentBinding, asOf: NOW }).valid, true);
  const historicalShortfall = historicalV1(snapshot);
  assert.equal(historicalShortfall.status, "needs_review");
  assert.equal(validateKeywordScoredSnapshot(historicalShortfall, { currentBinding, asOf: NOW }).valid, true);
});

test("同词不同matchType跨组只保留一次，重复证据进入rejected", async () => {
  const exact = raw("Same   Keyword", "exact_match", 1);
  const substitute = raw("same keyword", "substitute", 2);
  const prep = await validPreparation([exact, substitute]);
  const snapshot = score(prep, [metric(exact, 95), metric(substitute, 90)]);
  assert.equal(Object.values(snapshot.groups).flat().filter((x) => x.keyword.toLowerCase().replace(/\s+/g, " ") === "same keyword").length, 1);
  const duplicate = snapshot.scoringContext.rejected.find((x) => x.reason === "duplicate_term");
  assert.ok(duplicate);
  assert.ok(duplicate.sourceRefs.length > 0);
  assert.ok(duplicate.factRefs.length > 0);
});

test("metric key重复或超出当前候选池时拒绝", async () => {
  const candidate = raw("metric scope");
  const prep = await validPreparation([candidate]);
  const valid = metric(candidate, 90);
  assert.throws(() => score(prep, [valid, structuredClone(valid)]), /METRIC_KEY_DUPLICATE/);
  assert.throws(() => score(prep, [{ ...valid, key: "foreign\u0000exact_match" }]), /METRIC_KEY_OUT_OF_SCOPE/);
});

test("动态指标缺period、原始值或归一规则时拒绝", async () => {
  const candidate = raw("traceability");
  const prep = await validPreparation([candidate]);
  for (const broken of [
    { ...component(50, "searchDemand"), period: null },
    { value: 50, evidenceRef: "metric:x", observedAt: NOW, period: "30d", normalizationRule: "identity_0_100" },
    { value: 50, rawValue: 10, evidenceRef: "metric:x", observedAt: NOW, period: "30d" }
  ]) {
    assert.throws(() => score(prep, [metric(candidate, 90, { searchDemand: broken })]), /COMPONENT_UNTRACEABLE/);
  }
});

test("非空组件必须保存真实原始数值或有效结构化raw且JSON往返不丢失", async () => {
  const candidate = raw("raw evidence");
  const prep = await validPreparation([candidate]);
  for (const rawEvidence of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const broken = component(50, "searchDemand", { rawValue: rawEvidence, raw: null });
    assert.throws(() => score(prep, [metric(candidate, 90, { searchDemand: broken })]), /COMPONENT_UNTRACEABLE/);
  }
  assert.throws(() => score(prep, [metric(candidate, 90, { searchDemand: component(50, "searchDemand", { rawValue: null, raw: {} }) })]), /COMPONENT_UNTRACEABLE/);
  const snapshot = JSON.parse(JSON.stringify(score(prep, [metric(candidate, 90)])));
  assert.equal(snapshot.groups.title_keywords[0].components.searchDemand.rawValue, 80);
  snapshot.groups.title_keywords[0].components.searchDemand.rawValue = null;
  assert.equal(validateKeywordScoredSnapshot(snapshot, { currentBinding, asOf: NOW }).valid, false);
});

test("return/cancel原始比例越界或错误方向拒绝", async () => {
  const candidate = raw("bad returns");
  const prep = await validPreparation([candidate]);
  for (const rawRates of [{ returnRate: -0.1, cancelRate: 0 }, { returnRate: 1.1, cancelRate: 0 }, { returnRate: 0.6, cancelRate: 0.6 }]) {
    assert.throws(() => score(prep, [metric(candidate, 90, {
      returnCancelHealth: component(0, "returnCancelHealth", { rawValue: undefined, raw: rawRates, normalizationRule: undefined, conversionRule: "round4(100-(returnRate+cancelRate)*100)" })
    })]), /RETURN_CANCEL_DIRECTION_INVALID/);
  }
});

test("descriptionGate必须保存批准、证据和原因", async () => {
  const candidate = raw("description gate");
  const prep = await validPreparation([candidate]);
  for (const gate of [true, { approved: true, evidenceRef: "", reason: "ok" }, { approved: true, evidenceRef: "gate:1", reason: "" }]) {
    const m = metric(candidate, 75); m.descriptionGate = gate;
    const snapshot = score(prep, [m]);
    assert.equal(snapshot.groups.description_long_tail.length, 0);
    assert.equal(snapshot.scoringContext.rejected[0].reason, "description_gate_missing_or_untraceable");
  }
});

test("description_only严格绑定70到79、事实引用和固化门禁证据", async () => {
  const candidate = raw("gated description");
  const prep = await validPreparation([candidate]);
  const snapshot = score(prep, [metric(candidate, 75)]);
  const mutations = [
    (copy) => { copy.groups.description_long_tail[0].components.semanticMatch.value = 69; },
    (copy) => { copy.groups.description_long_tail[0].placementGateEvidence = null; },
    (copy) => { copy.groups.description_long_tail[0].placementGateEvidence.evidenceRef = ""; },
    (copy) => { copy.groups.description_long_tail[0].factRefs = []; }
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(snapshot); mutate(copy);
    assert.equal(validateKeywordScoredSnapshot(copy, { currentBinding, asOf: NOW }).valid, false);
  }
});

test("多竞品共同词保留全部refs进入快照", async () => {
  const candidates = [1, 2, 3].map((i) => raw("shared keyword", "exact_match", i));
  const prep = await validPreparation(candidates);
  const merged = prep.rawCandidatePool.find((x) => x.term === "shared keyword");
  const snapshot = score(prep, [metric(merged, 90)]);
  const record = snapshot.groups.title_keywords[0];
  assert.equal(record.sourceRefs.length >= 4, true);
});

test("数量不足不填充，上限截断稳定并保存拒绝理由", async () => {
  const small = [raw("only one")];
  const smallPrep = await validPreparation(small);
  const partial = score(smallPrep, [metric(small[0], 90)]);
  assert.equal(partial.status, "ready");
  assert.deepEqual(partial.scoringContext.gaps, []);
  assert.equal(Object.values(partial.groups).flat().length, 1);

  const manyInputCandidates = Array.from({ length: 40 }, (_, i) => raw(`keyword ${String(i).padStart(2, "0")}`, "exact_match", Math.floor(i / 4) + 1));
  const frozenComparables = Array.from({ length: 10 }, (_, group) => ({
    competitorRef: `competitor:${group + 1}`,
    comparabilityStatus: "proven",
    comparabilityEvidenceRefs: [`compare:${group + 1}`],
    matchType: "exact_match",
    terms: manyInputCandidates.slice(group * 4, group * 4 + 4).map((c) => ({ term: c.term, sourceRefs: c.sourceRefs, factRefs: c.factRefs, sourceTrust: null }))
  }));
  const manyPrep = await prepareKeywordEvidence({
    identity, bindings, platform: "ozon", exactSku: "SKU-1", fulfillment: "rfbs", locale: "ru-RU",
    businessGate: { approved: true, approvedAt: NOW, note: "approved", evidenceRef: "owner:A:9" }, now: NOW,
    policy: { browserAllowed: false, browserPreauthorized: false },
    healthPolicy: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", ttlMs: 3600000, suspectedSystemicFailure: false,
      standardSkus: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], lastProof: { connectorVersion: "v1", apiSchemaVersion: "v1", controlledWindowId: "w1", provedAt: NOW } },
    frozenEvidence: { productFactTerms: [], comparables: frozenComparables, seedEvidence: [] }, reusableSnapshot: null
  }, { seerfarApi: async () => ({ attempt: { ...attempt(), channel: "api", provider: "seerfar", attemptId: "attempt:api", queryId: "api:1", requestId: "api:1", traceRef: "api:trace", resultCount: 0, failureClass: "true_empty" }, candidates: [] }) });
  const full = score(manyPrep, manyPrep.rawCandidatePool.map((c) => metric(c, 90)));
  assert.ok(full.groups.title_keywords.length <= 5);
  assert.ok(full.groups.attribute_and_tag_keywords.length <= 12);
  assert.ok(full.groups.description_long_tail.length <= 20);
  assert.equal(new Set(Object.values(full.groups).flat().map((x) => x.keyword)).size, Object.values(full.groups).flat().length);
  assert.equal(full.scoringContext.rejected.filter((x) => x.reason === "group_capacity_or_cross_group_dedup").length, 3);
});

test("退货取消越低health越高且原始比例与规则可追溯", async () => {
  const candidate = raw("healthy keyword");
  const prep = await validPreparation([candidate]);
  const snapshot = score(prep, [metric(candidate, 90)]);
  const health = snapshot.groups.title_keywords[0].components.returnCancelHealth;
  assert.equal(health.value, 95);
  assert.deepEqual(health.raw, { returnRate: 0.03, cancelRate: 0.02 });
  assert.throws(() => score(prep, [metric(candidate, 90, {
    returnCancelHealth: component(5, "returnCancelHealth", { rawValue: undefined, raw: { returnRate: 0.03, cancelRate: 0.02 }, normalizationRule: undefined, conversionRule: "wrong" })
  })]), /RETURN_CANCEL_DIRECTION_INVALID/);
});

test("重复调用幂等，跨SKU、revision与Preparation指纹漂移拒绝", async () => {
  const candidate = raw("stable keyword");
  const prep = await validPreparation([candidate]);
  const metrics = [metric(candidate, 90)];
  assert.deepEqual(score(prep, metrics), score(prep, metrics));
  for (const mutate of [
    (binding) => { binding.candidateId = "OTHER"; },
    (binding) => { binding.dataRevision = 10; },
    (binding) => { binding.salesSnapshotFingerprint = "other"; }
  ]) {
    const drift = structuredClone(currentBinding); mutate(drift);
    assert.throws(() => scoreAndGroupKeywordEvidence({ preparation: prep, metricEvidence: { version: "keyword-metrics-v1", preparationFingerprint: prep.preparationFingerprint, candidates: metrics }, collectedAt: NOW, expiresAt: "2026-08-24T06:00:00.000Z", currentBinding: drift }), /PREPARATION_INVALID/);
  }
  assert.throws(() => scoreAndGroupKeywordEvidence({ preparation: prep, metricEvidence: { version: "keyword-metrics-v1", preparationFingerprint: "drift", candidates: metrics }, collectedAt: NOW, expiresAt: "2026-08-24T06:00:00.000Z", currentBinding }), /FINGERPRINT_DRIFT/);
});

test("输出兼容K1快照且保持K2 attempts、点数、binding、有效期和零副作用", async () => {
  const candidate = raw("trace keyword");
  const prep = await validPreparation([candidate]);
  const snapshot = score(prep, [metric(candidate, 90)]);
  assert.equal(validateKeywordEvidenceSnapshot(snapshot, { currentBinding, asOf: NOW }).valid, true);
  assert.deepEqual(snapshot.sourceAttempts, prep.sourceAttempts);
  assert.equal(snapshot.scoringContext.pointsSpent, prep.pointsSpent);
  assert.deepEqual(snapshot.bindings, prep.bindings);
  assert.deepEqual(snapshot.validity, { collectedAt: NOW, expiresAt: "2026-08-24T06:00:00.000Z" });
  assert.deepEqual(snapshot.businessEffect, { businessPhaseChanged: false, businessResultChanged: false, bOrC1Created: false, dispatchesCreated: 0 });
  assert.deepEqual(snapshot.scoringContext.execution, { networkCalls: 0, modelCalls: 0, codexDispatches: 0, bOrC1Created: false, sharedWrites: 0 });
});

test("K3扩展字段、载荷指纹、状态、gaps及绑定篡改均可发现", async () => {
  const candidates = Array.from({ length: 3 }, (_, i) => raw(`tamper ${i}`, "exact_match", i + 1));
  const prep = await validPreparation(candidates);
  const snapshot = score(prep, prep.rawCandidatePool.map((c) => metric(c, 90)));
  const cases = [
    (copy) => { copy.groups.title_keywords[0].matchType = "invalid"; },
    (copy) => { copy.groups.title_keywords[0].components.searchDemand.period = null; },
    (copy) => { copy.scoringContext.scoringPayloadFingerprint = "changed"; },
    (copy) => { copy.status = "partial_ready"; },
    (copy) => { copy.scoringContext.gaps = [{ group: "title_keywords", requiredMin: 3, actual: 3, missing: 0 }]; },
    (copy) => { copy.scoringContext.preparationFingerprint = "changed"; }
  ];
  for (const mutate of cases) {
    const copy = structuredClone(snapshot); mutate(copy);
    const validation = validateKeywordScoredSnapshot(copy, {
      currentBinding,
      expectedPreparationFingerprint: prep.preparationFingerprint,
      expectedMetricEvidenceFingerprint: snapshot.scoringContext.metricEvidenceFingerprint,
      asOf: NOW
    });
    assert.equal(validation.valid, false);
  }
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

function historicalV1(snapshot, historicalGroups = snapshot.groups) {
  const groups = structuredClone(historicalGroups);
  for (const item of Object.values(groups).flat()) item.scoringVersion = "keyword-scoring-v1";
  const context = structuredClone(snapshot.scoringContext);
  context.scoringVersion = "keyword-scoring-v1";
  context.groupLimits = keywordScoringGroupLimits(context.scoringVersion);
  context.gaps = Object.entries(context.groupLimits).filter(([group, limit]) => groups[group].length < limit.min)
    .map(([group, limit]) => ({ group, requiredMin: limit.min, actual: groups[group].length, missing: limit.min - groups[group].length }));
  context.scoringPayloadFingerprint = digest({ groups, rejected: context.rejected, gaps: context.gaps,
    preparationFingerprint: context.preparationFingerprint, metricEvidenceFingerprint: context.metricEvidenceFingerprint });
  return createKeywordEvidenceSnapshot({
    snapshotId: `keyword-evidence:${identity.candidateId}:${identity.dataRevision}:${digest({ preparation: context.preparationFingerprint, metrics: context.metricEvidenceFingerprint }).slice(0, 16)}`,
    identity, bindings, collectedAt: NOW, expiresAt: snapshot.validity.expiresAt, asOf: NOW,
    sourceAttempts: snapshot.sourceAttempts, groups, scoringContext: context,
    statusOverride: context.gaps.length === 0 ? "ready" : Object.values(groups).some(items => items.length === 0) ? "partial_ready" : "needs_review"
  });
}

test("新评分一词ready，历史v1一词仍partial_ready且新旧ID不碰撞", async () => {
  const candidate = raw("one traceable title");
  const prep = await validPreparation([candidate]);
  const current = score(prep, [metric(candidate, 90)]);
  assert.equal(current.status, "ready");
  assert.equal(current.scoringContext.scoringVersion, "keyword-scoring-v2");
  assert.deepEqual(current.groups.attribute_and_tag_keywords, []);
  assert.deepEqual(current.groups.description_long_tail, []);
  const historical = historicalV1(current);
  const before = JSON.stringify(historical);
  assert.equal(historical.status, "partial_ready");
  assert.deepEqual(historical.scoringContext.gaps.map(item => item.missing), [2, 6, 10]);
  assert.equal(validateKeywordScoredSnapshot(historical, { currentBinding, asOf: NOW }).valid, true);
  assert.equal(JSON.stringify(historical), before);
  assert.notEqual(current.snapshotId, historical.snapshotId);
  assert.deepEqual(score(prep, [metric(candidate, 90)]), current);
});

test("未知评分版本、错配数量策略和混合词版本均拒绝", async () => {
  const candidate = raw("version binding");
  const prep = await validPreparation([candidate]);
  const snapshot = score(prep, [metric(candidate, 90)]);
  for (const change of [
    copy => { copy.scoringContext.scoringVersion = "keyword-scoring-v999"; },
    copy => { copy.scoringContext.groupLimits = keywordScoringGroupLimits("keyword-scoring-v1"); },
    copy => { copy.groups.title_keywords[0].scoringVersion = "keyword-scoring-v1"; }
  ]) {
    const copy = structuredClone(snapshot); change(copy);
    const { snapshotFingerprint, ...payload } = copy;
    copy.snapshotFingerprint = digest(payload);
    assert.equal(validateKeywordScoredSnapshot(copy, { currentBinding, asOf: NOW }).valid, false);
  }
});

test("只有描述限定词不满足标题最低要求，不伪造标题词", async () => {
  const candidate = raw("description only");
  const prep = await validPreparation([candidate]);
  const snapshot = score(prep, [metric(candidate, 75)]);
  assert.equal(snapshot.status, "partial_ready");
  assert.deepEqual(snapshot.scoringContext.gaps, [{ group: "title_keywords", requiredMin: 1, actual: 0, missing: 1 }]);
  assert.deepEqual(snapshot.groups.title_keywords, []);
  assert.equal(snapshot.groups.description_long_tail.length, 1);
});
