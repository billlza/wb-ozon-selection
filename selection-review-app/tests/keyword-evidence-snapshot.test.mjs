import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  KEYWORD_FAILURE_CLASSES,
  KEYWORD_GROUPS,
  KEYWORD_PREPARATION_STATUSES,
  classifyKeywordSourceFailure,
  createKeywordEvidenceSnapshot,
  readLegacyKeywordEvidenceReadOnly,
  validateKeywordEvidenceSnapshot
} from "../lib/keyword-evidence-snapshot.mjs";

const NOW = "2026-08-23T02:00:00.000Z";
const EXPIRES = "2026-08-24T02:00:00.000Z";
const binding = Object.freeze({
  candidateId: "CX-TEST-001",
  parentOpportunityId: "opportunity:CX-TEST-001",
  skuPackageId: "sku-package:CX-TEST-001:SKU-1",
  dataRevision: 7,
  salesSnapshotVersion: "sales-snapshot-v1.1",
  salesSnapshotFingerprint: "sales-fingerprint-001",
  supplySkuFactsVersion: "supply-sku-facts-v1",
  supplySkuFactsFingerprint: "supply-fingerprint-001"
});

function attempt(overrides = {}) {
  return {
    schemaVersion: "keyword-source-attempt-v1",
    attemptId: "attempt:1",
    provider: "keyword-provider",
    channel: "api",
    queryId: "query:1",
    queryText: "mechanical music box",
    locale: "ru-RU",
    targetPlatform: "ozon",
    requestId: "request:1",
    receiptId: null,
    startedAt: NOW,
    completedAt: "2026-08-23T02:00:05.000Z",
    status: "completed",
    resultCount: 3,
    failureClass: null,
    traceRef: "receipt:request:1",
    ...overrides
  };
}

function keyword(value, factRef) {
  return {
    keyword: value,
    sourceRefs: ["attempt:1"],
    factRefs: [factRef],
    score: null,
    scoringVersion: null,
    confidence: null,
    decision: null,
    decisionReason: null
  };
}

function input(overrides = {}) {
  return {
    snapshotId: "keyword-evidence:CX-TEST-001:7",
    identity: {
      candidateId: binding.candidateId,
      parentOpportunityId: binding.parentOpportunityId,
      skuPackageId: binding.skuPackageId,
      dataRevision: binding.dataRevision
    },
    bindings: {
      salesSnapshot: {
        snapshotId: "sales:CX-TEST-001:7",
        version: binding.salesSnapshotVersion,
        fingerprint: binding.salesSnapshotFingerprint
      },
      supplySkuFacts: {
        version: binding.supplySkuFactsVersion,
        fingerprint: binding.supplySkuFactsFingerprint
      }
    },
    collectedAt: NOW,
    expiresAt: EXPIRES,
    asOf: NOW,
    currentBinding: binding,
    sourceAttempts: [attempt()],
    groups: {
      title_keywords: [keyword("mechanical music box", "sales:CX-TEST-001:7#/samples/0/title")],
      attribute_and_tag_keywords: [keyword("hand crank", "supply:CX-TEST-001:7#/facts/mechanism")],
      description_long_tail: [keyword("retro sewing machine gift", "sales:CX-TEST-001:7#/samples/0/productName")]
    },
    ...overrides
  };
}

test("v1契约覆盖六种准备状态、九种失败分类和三组关键词", async () => {
  assert.deepEqual(KEYWORD_PREPARATION_STATUSES, ["ready", "partial_ready", "technical_unavailable", "true_empty", "stale", "needs_review"]);
  assert.deepEqual(KEYWORD_FAILURE_CLASSES, ["login_required", "quota_or_rate_limit", "network_timeout", "network_error", "selector_changed", "input_not_committed", "stale_result", "true_empty", "provider_server_error"]);
  assert.deepEqual(KEYWORD_GROUPS, ["title_keywords", "attribute_and_tag_keywords", "description_long_tail"]);
  const schema = JSON.parse(await readFile(new URL("../schema/keyword-evidence-snapshot-v1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.status.enum, KEYWORD_PREPARATION_STATUSES);
  assert.deepEqual(Object.keys(schema.properties.groups.properties), KEYWORD_GROUPS);
});

test("完整三组形成ready快照，未知评分字段保持null且K1没有业务副作用", () => {
  const snapshot = createKeywordEvidenceSnapshot(input());
  assert.equal(snapshot.status, "ready");
  assert.match(snapshot.snapshotFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.groups.title_keywords[0].score, null);
  assert.equal(snapshot.groups.title_keywords[0].scoringVersion, null);
  assert.equal(snapshot.groups.title_keywords[0].confidence, null);
  assert.equal(snapshot.groups.title_keywords[0].decision, null);
  assert.deepEqual(snapshot.businessEffect, {
    businessPhaseChanged: false,
    businessResultChanged: false,
    bOrC1Created: false,
    dispatchesCreated: 0
  });
  assert.equal(Object.isFrozen(snapshot), true);
});

test("true_empty只接受完成查询、可追溯receipt和严格零结果", () => {
  const emptyAttempt = attempt({ requestId: null, receiptId: "receipt:empty", resultCount: 0, failureClass: "true_empty" });
  const snapshot = createKeywordEvidenceSnapshot(input({
    sourceAttempts: [emptyAttempt],
    groups: Object.fromEntries(KEYWORD_GROUPS.map((group) => [group, []]))
  }));
  assert.equal(snapshot.status, "true_empty");

  assert.throws(() => createKeywordEvidenceSnapshot(input({
    sourceAttempts: [{ ...emptyAttempt, completedAt: null }],
    groups: Object.fromEntries(KEYWORD_GROUPS.map((group) => [group, []]))
  })), /true_empty必须有查询完成时间/);
});

test("API 500保留后，浏览器明确完成零结果仍形成true_empty", () => {
  const failedApi = attempt({
    attemptId: "attempt:api",
    completedAt: null,
    status: "failed",
    resultCount: null,
    failureClass: "provider_server_error"
  });
  const emptyBrowser = attempt({
    attemptId: "attempt:browser",
    channel: "browser",
    requestId: null,
    receiptId: "receipt:browser-empty",
    resultCount: 0,
    failureClass: "true_empty"
  });
  const snapshot = createKeywordEvidenceSnapshot(input({
    sourceAttempts: [failedApi, emptyBrowser],
    groups: Object.fromEntries(KEYWORD_GROUPS.map((group) => [group, []]))
  }));
  assert.equal(snapshot.status, "true_empty");
  assert.equal(snapshot.sourceAttempts[0].failureClass, "provider_server_error");
});

test("成功正结果与零结果并存但尚无关键词时必须needs_review", () => {
  const emptyBrowser = attempt({
    attemptId: "attempt:browser",
    channel: "browser",
    requestId: null,
    receiptId: "receipt:browser-empty",
    resultCount: 0,
    failureClass: "true_empty"
  });
  const snapshot = createKeywordEvidenceSnapshot(input({
    sourceAttempts: [attempt(), emptyBrowser],
    groups: Object.fromEntries(KEYWORD_GROUPS.map((group) => [group, []]))
  }));
  assert.equal(snapshot.status, "needs_review");
});

test("技术失败优先于零结果，500明确映射provider_server_error", () => {
  const common = { channel: "api", provider: "provider", queryId: "q", requestId: "r", completed: true, completedAt: NOW, resultCount: 0 };
  assert.equal(classifyKeywordSourceFailure({ ...common, httpStatus: 500 }), "provider_server_error");
  assert.equal(classifyKeywordSourceFailure(common), "true_empty");
});

test("login、quota、network、selector、input、stale分类互不混淆", () => {
  const cases = [
    [{ channel: "api", loginRequired: true }, "login_required"],
    [{ channel: "api", quotaExceeded: true }, "quota_or_rate_limit"],
    [{ channel: "api", timeout: true }, "network_timeout"],
    [{ channel: "browser", selectorChanged: true }, "selector_changed"],
    [{ channel: "browser", inputCommitted: false }, "input_not_committed"],
    [{ channel: "api", stale: true }, "stale_result"]
  ];
  for (const [observation, expected] of cases) assert.equal(classifyKeywordSourceFailure(observation), expected);
  assert.equal(new Set(cases.map(([, expected]) => expected)).size, cases.length);
});

test("local_fusion只接受已完成且正结果，不承载provider失败分类", () => {
  const localFusion = attempt({
    attemptId: "attempt:fusion",
    provider: "local-keyword-fusion",
    channel: "local_fusion",
    queryId: "fusion:1",
    queryText: "frozen upstream keyword inputs",
    resultCount: 2
  });
  const snapshot = createKeywordEvidenceSnapshot(input({ sourceAttempts: [localFusion] }));
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.sourceAttempts[0].channel, "local_fusion");
  assert.equal(classifyKeywordSourceFailure({ channel: "local_fusion", loginRequired: true }), null);

  for (const invalid of [
    { status: "failed", completedAt: null, resultCount: null, failureClass: "provider_server_error" },
    { resultCount: 0, failureClass: "true_empty" },
    { resultCount: null }
  ]) {
    assert.throws(() => createKeywordEvidenceSnapshot(input({ sourceAttempts: [{ ...localFusion, ...invalid }] })), /local_fusion只允许/);
  }
});

test("技术失败形成technical_unavailable但不改变业务结论", () => {
  const failed = attempt({ completedAt: null, status: "failed", resultCount: null, failureClass: "network_timeout" });
  const snapshot = createKeywordEvidenceSnapshot(input({
    sourceAttempts: [failed],
    groups: Object.fromEntries(KEYWORD_GROUPS.map((group) => [group, []]))
  }));
  assert.equal(snapshot.status, "technical_unavailable");
  assert.equal(snapshot.businessEffect.businessResultChanged, false);
  assert.equal(snapshot.businessEffect.bOrC1Created, false);
  assert.equal(snapshot.businessEffect.dispatchesCreated, 0);
});

test("部分结果与需人工复核分别为partial_ready和needs_review", () => {
  const partialGroups = Object.fromEntries(KEYWORD_GROUPS.map((group) => [group, []]));
  partialGroups.title_keywords = [keyword("music box", "sales:CX-TEST-001:7#/samples/0/title")];
  assert.equal(createKeywordEvidenceSnapshot(input({ groups: partialGroups })).status, "partial_ready");
  assert.equal(createKeywordEvidenceSnapshot(input({ needsReview: true })).status, "needs_review");
});

test("过期证据形成stale且不复用关键词结论", () => {
  const snapshot = createKeywordEvidenceSnapshot(input({ asOf: "2026-08-25T02:00:00.000Z" }));
  assert.equal(snapshot.status, "stale");
});

test("跨SKU、revision、销售快照和供应事实漂移全部拒绝", () => {
  const snapshot = createKeywordEvidenceSnapshot(input());
  for (const [field, value] of [
    ["candidateId", "CX-OTHER"],
    ["parentOpportunityId", "opportunity:OTHER"],
    ["skuPackageId", "sku-package:OTHER"],
    ["dataRevision", 8],
    ["salesSnapshotVersion", "sales-snapshot-v2"],
    ["salesSnapshotFingerprint", "other-sales-fingerprint"],
    ["supplySkuFactsVersion", "supply-sku-facts-v2"],
    ["supplySkuFactsFingerprint", "other-supply-fingerprint"]
  ]) {
    const validation = validateKeywordEvidenceSnapshot(snapshot, { currentBinding: { ...binding, [field]: value }, asOf: NOW });
    assert.equal(validation.valid, false, field);
    assert.equal(validation.errors.some((error) => error.path === `binding.${field}`), true, field);
  }
});

test("指纹可发现内容漂移", () => {
  const snapshot = structuredClone(createKeywordEvidenceSnapshot(input()));
  snapshot.groups.title_keywords[0].keyword = "tampered";
  const validation = validateKeywordEvidenceSnapshot(snapshot, { currentBinding: binding, asOf: NOW });
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((error) => error.path === "snapshotFingerprint"), true);
});

test("旧数据只读兼容，缺失事实只能unknown或null", () => {
  const legacySource = { keywords: ["old keyword"] };
  const view = readLegacyKeywordEvidenceReadOnly(legacySource);
  assert.equal(view.legacyReadOnly, true);
  assert.equal(view.snapshotId, "unknown");
  assert.equal(view.identity.dataRevision, null);
  assert.deepEqual(view.groups, Object.fromEntries(KEYWORD_GROUPS.map((group) => [group, []])));
  assert.deepEqual(legacySource, { keywords: ["old keyword"] });
  assert.equal(Object.isFrozen(view), true);
});


test("v2快照按标题最低数量派生ready，v1与未评分快照保留旧覆盖语义", () => {
  const titleOnly = { title_keywords: [keyword("confirmed title", "fact:title")], attribute_and_tag_keywords: [], description_long_tail: [] };
  const context = {
    scoringVersion: "keyword-scoring-v2", preparationFingerprint: "preparation:one", metricEvidenceFingerprint: "metrics:one",
    execution: { networkCalls: 0, modelCalls: 0, codexDispatches: 0, bOrC1Created: false, sharedWrites: 0 }
  };
  const current = createKeywordEvidenceSnapshot(input({ groups: titleOnly, scoringContext: context }));
  assert.equal(current.status, "ready");
  assert.equal(createKeywordEvidenceSnapshot(input({ groups: titleOnly })).status, "partial_ready");
  assert.equal(createKeywordEvidenceSnapshot(input({ groups: titleOnly, scoringContext: { ...context, scoringVersion: "keyword-scoring-v1" } })).status, "partial_ready");
  assert.throws(() => createKeywordEvidenceSnapshot(input({ groups: titleOnly, scoringContext: context, statusOverride: "partial_ready" })), /KEYWORD_EVIDENCE_INVALID/);
  const noTitle = { title_keywords: [], attribute_and_tag_keywords: [], description_long_tail: [keyword("description", "fact:description")] };
  assert.equal(createKeywordEvidenceSnapshot(input({ groups: noTitle, scoringContext: context })).status, "partial_ready");
  assert.throws(() => createKeywordEvidenceSnapshot(input({ groups: noTitle, scoringContext: context, statusOverride: "ready" })), /KEYWORD_EVIDENCE_INVALID/);
  assert.throws(() => createKeywordEvidenceSnapshot(input({ groups: titleOnly, scoringContext: { ...context, scoringVersion: "keyword-scoring-v999" } })), /评分版本无效/);
});
