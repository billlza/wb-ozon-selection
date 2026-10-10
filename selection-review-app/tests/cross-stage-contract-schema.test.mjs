import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertNoProductionSecrets } from "../lib/product-lifecycle-schema.mjs";

async function schema(name) {
  return JSON.parse(await readFile(new URL(`../schema/${name}`, import.meta.url), "utf8"));
}

function localDefinition(root, contract) {
  if (!contract?.$ref?.startsWith("#/$defs/")) return contract;
  return root.$defs[contract.$ref.slice("#/$defs/".length)];
}

function acceptsStringContract(contract, value, root = { $defs: {} }) {
  contract = localDefinition(root, contract);
  if (contract.type === "string" && typeof value !== "string") return false;
  if (contract.minLength !== undefined && value.length < contract.minLength) return false;
  if (contract.maxLength !== undefined && value.length > contract.maxLength) return false;
  if (contract.pattern && !new RegExp(contract.pattern).test(value)) return false;
  if (contract.not?.const !== undefined && value === contract.not.const) return false;
  if (contract.not?.enum?.includes(value)) return false;
  return (contract.allOf || []).every((rule) => {
    rule = localDefinition(root, rule);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
    if (rule.not?.pattern && new RegExp(rule.not.pattern).test(value)) return false;
    if (rule.not?.const !== undefined && value === rule.not.const) return false;
    if (rule.not?.enum?.includes(value)) return false;
    if (rule.allOf && !acceptsStringContract(rule, value, root)) return false;
    return true;
  });
}

const SECRET_FACT_STRINGS = [
  ["bearer-space", "Bearer abc"],
  ["bearer-colon", "Bearer:abc"],
  ["authorization-bearer", "Authorization: Bearer abc"],
  ["authorization-assignment", "authorization=abc"],
  ["access-token", "accessToken=sk_live_123"],
  ["access-token-json", "{\"accessToken\":\"abc\"}"],
  ["refresh-token", "REFRESH_TOKEN: refresh_123"],
  ["client-secret", "client-secret = secret_123"],
  ["session-cookie", "sessionCookie: sid=abc"],
  ["api-key", "api key=key_123"],
  ["password", "password=abc"],
  ["credential", "credential:abc"],
  ["signature", "signature=abc"],
  ["url-userinfo-password", "https://user:pass@example.test/a"],
  ["url-userinfo-user", "https://user@example.test/a"],
  ["url-access-token", "https://example.test/a?access_token=abc"],
  ["url-authorization", "https://example.test/a?authorization=abc"],
  ["url-signature", "https://example.test/a?X-Amz-Signature=abc"],
  ["url-encoded-token", "https://example.test/a?%74oken=abc"],
  ["url-middle-encoded-token", "https://example.test/a?a%63cessToken=abc"],
  ["url-encoded-separator", "https://example.test/a?access%5Ftoken=abc"],
  ["query-only-encoded-token", "?access%54oken=abc"],
  ["relative-encoded-token", "relative?access%54oken=abc"]
];

const LEGITIMATE_FACT_STRINGS = [
  "tokenizer=blue",
  "secretless-build",
  "clientSecretlessMode=strict",
  "sessionCookiePolicy label",
  "signature style",
  "authorization required",
  "Bearer plant extract",
  "access token lifecycle documentation",
  "cookie cutter shape",
  "api-keyboard:sku",
  "password notebook",
  "credential holder",
  "https://example.test/p/a@b?q=tokenizer",
  "https://example.test/a?signaturePolicy=required",
  "https://example.test/a?note=accessToken",
  "https://example.test/a?q=%20",
  "?utm%5Fsource=abc",
  "?caf%C3%A9=abc",
  "relative?product%5Ftype=shelf"
];

test("公共PA敏感query使用完整规范键边界且40k输入保持线性上界", async () => {
  const authorization = await schema("production-authorization-v1.1.schema.json");
  const stringPatterns = authorization.$defs.noProductionSecrets.else.else.then.allOf.map((rule) => rule.not.pattern);
  const exactQueryPatterns = stringPatterns.filter((pattern) => pattern.includes("%(?:25){0,2}(?:3[Ff]|26|23)"));

  assert.equal(exactQueryPatterns.length, 10);
  for (const pattern of stringPatterns) {
    assert.equal(pattern.includes("[?&#][^?=&#]*(?:token|secret"), false);
    assert.equal(pattern.includes("(?:[?&#]|%3[fF]|%26)[^?=&#]{0,64}"), false);
  }
  for (const pattern of exactQueryPatterns) {
    assert.equal(pattern.includes("[^A-Za-z0-9%?=&#]"), true);
    assert.equal(pattern.includes("(?!(?:23|26|3[Ff]"), true);
    assert.equal(pattern.includes("(?:=|%(?:25){0,2}3[Dd]|(?=[&#]"), true);
  }
  const encodedAssignmentBoundary = "(?:^|[^A-Za-z0-9_%]|%(?:25){0,2}(?!(?:3[0-9]|4[1-9A-Fa-f]|5[0-9AaFf]|6[1-9A-Fa-f]|7[0-9Aa]))[0-9A-Fa-f]{2})";
  assert.equal(stringPatterns.some((pattern) => pattern.includes(encodedAssignmentBoundary)), true);
  assert.equal(stringPatterns.some((pattern) => pattern.includes("(?<![A-Za-z0-9_%])")), false);

  const secretPatterns = stringPatterns.map((pattern) => new RegExp(pattern));
  for (const legal of [
    "https://x.test/?tokenizer=tool",
    "https://x.test/?secretless=design",
    "https://x.test/?credentialAlias=ozon",
    "?mytoken=tool",
    "?notsecret=design",
    "?my_token=label",
    "?authorizationId=auth_record_1",
    "?accessTokenPolicy=required",
    "?clientSecretlessMode=strict"
  ]) {
    assert.equal(secretPatterns.some((pattern) => pattern.test(legal)), false, legal);
    assert.doesNotThrow(() => assertNoProductionSecrets({ note: legal }), legal);
  }
  assert.equal(secretPatterns.some((pattern) => pattern.test("?ordinary?token=abc")), true);
  assert.equal(secretPatterns.some((pattern) => pattern.test("?ordinary?product=wood")), false);

  const encodeAllAscii = (value) => [...value]
    .map((character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
  const encodeRounds = (value, rounds) => {
    let encoded = rounds === 0 ? value : encodeAllAscii(value);
    for (let round = 1; round < rounds; round += 1) encoded = encodeURIComponent(encoded);
    return encoded;
  };

  let encodedAssignmentBoundaryRegressionCount = 0;
  for (const prefix of ["-", " ", "("]) {
    for (let rounds = 1; rounds <= 3; rounds += 1) {
      const value = encodeRounds(`${prefix}token=abc`, rounds);
      assert.equal(
        secretPatterns.some((pattern) => pattern.test(value)),
        true,
        `encoded assignment boundary ${JSON.stringify(prefix)}/${rounds}`
      );
      assert.throws(
        () => assertNoProductionSecrets({ note: value }),
        /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/,
        `encoded assignment boundary ${JSON.stringify(prefix)}/${rounds}`
      );
      encodedAssignmentBoundaryRegressionCount += 1;
    }
  }
  assert.equal(encodedAssignmentBoundaryRegressionCount, 9);
  for (const legal of [encodeRounds("xtoken=abc", 1), encodeRounds("_token=abc", 2), encodeRounds("7token=abc", 3)]) {
    assert.equal(secretPatterns.some((pattern) => pattern.test(legal)), false, legal);
    assert.doesNotThrow(() => assertNoProductionSecrets({ note: legal }), legal);
  }
  for (const key of [
    "authorization", "bearer", "password", "cookie", "cookies", "cookiejar", "headers", "requestheaders",
    "token", "tokenAt", "secret", "secretAt", "credential", "credentialAt", "credentials", "credentialsAt",
    "accessToken", "accessTokenAt", "refreshToken", "refreshTokenAt", "clientSecret", "clientSecretAt",
    "sessionCookie", "sessionCookieAt", "apiKey", "apiKeyAt", "signature", "signatureAt",
    "credentialValue", "credentialValueAt", "credentialSecret", "credentialSecretAt",
    "credentialToken", "credentialTokenAt", "credentialPassword", "credentialPasswordAt",
    "expires", "expiry", "xAmzSignature"
  ]) {
    for (let rounds = 0; rounds <= 3; rounds += 1) {
      const encodedKeyAssignment = `?${encodeRounds(key, rounds)}${encodeRounds("=", rounds)}abc`;
      const encodedWholeQuery = encodeRounds(`?${key}=abc`, rounds);
      for (const [form, value] of [["key", encodedKeyAssignment], ["query", encodedWholeQuery]]) {
        assert.equal(secretPatterns.some((pattern) => pattern.test(value)), true, `${key}/${form}/${rounds}`);
        assert.throws(
          () => assertNoProductionSecrets({ note: value }),
          /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/,
          `${key}/${form}/${rounds}`
        );
      }
    }
  }

  for (const [label, value] of [
    ["raw", "?".repeat(40_000)],
    ["percent-encoded", "%3F".repeat(40_000)]
  ]) {
    secretPatterns.some((pattern) => pattern.test(value));
    const durationsMs = [];
    for (let index = 0; index < 3; index += 1) {
      const startedAt = process.hrtime.bigint();
      assert.equal(secretPatterns.some((pattern) => pattern.test(value)), false);
      durationsMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    }
    durationsMs.sort((left, right) => left - right);
    const medianMs = durationsMs[1];
    assert.ok(medianMs < 500, `40k ${label} query separators took ${medianMs.toFixed(3)}ms`);
  }
});

test("C2公共Schema锁定canonical handoff、正式provider完成回执与空阻断清单", async () => {
  const [c2, lifecycle] = await Promise.all([
    schema("c2-software-input-v1.schema.json"),
    schema("product-lifecycle-v1.1.schema.json")
  ]);
  assert.equal(c2.$id, "c2-software-input-v1");
  assert.equal(c2.additionalProperties, false);
  assert.equal(c2.allOf[0].$ref, "#/$defs/noSensitivePropertyNames");
  assert.equal(c2.allOf[1].$ref, "#/$defs/noTransportCredentialPropertyNames");
  assert.equal(c2.allOf[2].$ref, "#/$defs/noCompositeSecretPropertyNames");
  assert.equal(c2.properties.identity.$ref, "#/$defs/c2G1Identity");
  assert.equal(c2.$defs.c2G1Identity.allOf[0].$ref, "product-lifecycle-v1.1#/$defs/g1Identity");
  assert.ok(lifecycle.$defs.SkuLifecyclePackage.required.includes("g1Identity"));
  assert.equal(lifecycle.$defs.SkuLifecyclePackage.properties.g1Identity.$ref, "#/$defs/g1Identity");
  assert.equal(lifecycle.$defs.g1Identity.additionalProperties, false);
  for (const field of ["merchantSku", "warehouseRef", "credentialAlias", "platformProductId"]) {
    assert.equal(lifecycle.$defs.g1Identity.properties[field].type, "string", field);
    assert.equal(lifecycle.$defs.g1Identity.properties[field].not.enum.includes("not_applicable"), false, field);
    assert.equal(c2.$defs.c2G1Identity.allOf[1].properties[field].const, "not_applicable", field);
  }
  assert.equal(c2.properties.c1.$ref, "#/$defs/c1Snapshot");
  assert.equal(c2.$defs.c1Snapshot.additionalProperties, false);
  assert.ok(c2.$defs.c1Snapshot.required.includes("canonicalHandoff"));

  const canonical = c2.$defs.canonicalHandoff;
  assert.equal(canonical.additionalProperties, false);
  for (const field of [
    "identity", "frozenInputRevisionRefs", "handoffRevisionRefs", "frozenInputRefs", "schemaSnapshotRef",
    "draftOnlySeo", "keywordEvidenceRefs", "unknownManifest"
  ]) assert.ok(canonical.required.includes(field), field);
  // 槽位合同已废止：canonical 交接不再携带任何媒体摘要。
  assert.equal(Object.hasOwn(canonical.properties, "mediaRequirements"), false);
  assert.equal(canonical.properties.unknownManifest.maxItems, 0);
  assert.equal(canonical.properties.draftOnlySeo.$ref, "#/$defs/draftOnlySeo");
  assert.equal(canonical.properties.identity.$ref, "#/$defs/c2G1Identity");

  const draft = c2.$defs.draftOnlySeo.oneOf[0];
  assert.equal(draft.additionalProperties, false);
  assert.equal(draft.properties.status.const, "draft_only");
  assert.equal(draft.properties.formalProviderResultAccepted.const, true);
  assert.equal(draft.properties.reason.type, "null");
  assert.equal(draft.properties.providerJobRef.$ref, "#/$defs/providerJobRef");

  const job = c2.$defs.providerJobRef;
  assert.equal(job.additionalProperties, false);
  assert.equal(job.properties.jobType.const, "c1_ai_draft");
  assert.equal(job.properties.terminalStatus.const, "completed");
  assert.equal(job.properties.requestSubmitted.const, true);
  assert.equal(job.properties.responseVerified.const, true);
  assert.ok(job.required.includes("providerVersion"));
  assert.ok(job.required.includes("receiptRef"));
  assert.ok(job.required.includes("inputFingerprint"));
  assert.ok(job.required.includes("sourceRevision"));

  const authorization = c2.$defs.paidAuthorizationRef;
  assert.equal(authorization.additionalProperties, false);
  assert.equal(authorization.properties.authorizationType.const, "paid_ai_draft");
  assert.deepEqual(c2.$defs.paidAuthorizationScope.required, [
    "candidateId", "skuPackageId", "platform", "storeRef", "sourceRevision", "jobType"
  ]);
  assert.equal(c2.$defs.paidAuthorizationScope.properties.jobType.const, "c1_ai_draft");
  for (const storeRefContract of [
    c2.$defs.providerJobRef.properties.storeRef,
    c2.$defs.paidAuthorizationScope.properties.storeRef,
    c2.$defs.frozenInputRefs.properties.storeRef
  ]) {
    assert.deepEqual(storeRefContract.allOf, [
      { $ref: "#/$defs/c2SecretCheckedContractString" },
      { $ref: "#/$defs/canonicalFrozenRef" }
    ]);
  }
});

test("C2公共Schema拒绝旧宽draft状态、秘密形态引用和生产副作用", async () => {
  const c2 = await schema("c2-software-input-v1.schema.json");
  assert.equal(c2.$defs.seoDraft.properties.status.const, "draft_only");
  assert.notEqual(c2.$defs.draftOnlySeo.oneOf[0].properties.formalProviderResultAccepted.const, false);
  assert.equal(c2.$defs.initialAssetRegions.properties.finalUploads.maxItems, 0);
  for (const rule of Object.values(c2.$defs.executionPolicy.properties)) assert.equal(rule.const, false);

  assert.equal(c2.$defs.safeReferenceValue, undefined);
  assert.equal(c2.$defs.safeFactReferenceValue, undefined);
  const refContract = c2.$defs.canonicalFrozenRef;
  assert.equal(acceptsStringContract(refContract, "receipt:c1:completed-001", c2), true);
  for (const safe of [
    "tokenizer-service", "secretless-build", "api-keyboard:sku", "evidence:fixture:version-1"
  ]) {
    assert.equal(acceptsStringContract(refContract, safe, c2), true, safe);
  }
  for (const unsafe of [
    "Bearer:abc", "api_key:abc", "COOKIE:abc", "password:abc", "secret:abc", "signatureAt:abc",
    "credential_at:abc", "expiresAt:abc", "EXPIRY_AT:abc", "rawResponseAt:abc", "RAW_REQUEST_AT:abc",
    "request_body:abc", "response-headers-at:abc", "rawHtml:abc", "rawPayload:abc",
    "https://user:pass@example.test/a", "https://example.test/a?token=abc",
    "https://example.test/a?X-Amz-Signature=abc", "https://example.test/a?%74oken=abc"
  ]) assert.equal(acceptsStringContract(refContract, unsafe, c2), false, unsafe);
  for (const unsafe of [
    "https://example.test/a?accessToken=abc",
    "https://example.test/a?clientSecret=abc"
  ]) assert.equal(acceptsStringContract(c2.$defs.canonicalFrozenRef, unsafe, c2), false, unsafe);
  assert.equal(acceptsStringContract(c2.$defs.opaqueEvidenceRef, "ref//raw", c2), false);

  const forbiddenKey = new RegExp(c2.$defs.noSensitivePropertyNames.then.propertyNames.not.pattern);
  for (const key of [
    "rawResponse", "raw_response_at", "requestBody", "response-headers", "rawHtml", "rawPayload",
    "tokenAt", "cookie_at", "secret", "signature", "credential_value", "expiresAt", "EXPIRY_AT"
  ]) assert.equal(forbiddenKey.test(key), true, key);
  assert.equal(forbiddenKey.test("credentialAlias"), false);

  const compositeSecretKey = new RegExp(c2.$defs.noCompositeSecretPropertyNames.then.propertyNames.not.pattern);
  for (const key of [
    "accessToken", "ACCESS_TOKEN", "access-token", "AccessTokenAt", "access_token_at", "access-token-at",
    "refreshToken", "REFRESH_TOKEN", "refresh-token", "RefreshTokenAt", "refresh_token_at", "refresh-token-at",
    "clientSecret", "CLIENT_SECRET", "client-secret", "ClientSecretAt", "client_secret_at", "client-secret-at",
    "sessionCookie", "SESSION_COOKIE", "session-cookie", "SessionCookieAt", "session_cookie_at", "session-cookie-at"
  ]) assert.equal(compositeSecretKey.test(key), true, key);
  for (const safe of ["authorizationRef", "accessTokenizedLabel", "clientSecretlessMode", "sessionCookiePolicy"]) {
    assert.equal(compositeSecretKey.test(safe), false, safe);
  }

  for (const [label, value] of SECRET_FACT_STRINGS) {
    assert.equal(acceptsStringContract(c2.$defs.formalFactString, value, c2), false, label);
  }
  for (const value of LEGITIMATE_FACT_STRINGS) {
    assert.equal(acceptsStringContract(c2.$defs.formalFactString, value, c2), true, value);
  }
});

test("C2公共Schema把冻结Schema、媒体摘要与正式关键词引用纳入同一canonical对象", async () => {
  const c2 = await schema("c2-software-input-v1.schema.json");
  assert.deepEqual(c2.$defs.verifiedFacts.required, [
    "exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot", "batteryAssessment",
    "categoryRestrictions", "platformCompliance", "unknownManifest"
  ]);
  assert.equal(c2.$defs.verifiedFacts.properties.schemaSnapshot.$ref, "#/$defs/frozenSchemaSnapshot");
  assert.equal(c2.$defs.frozenSchemaSnapshot.additionalProperties, false);
  assert.deepEqual(c2.$defs.frozenSchemaSnapshot.required, ["status", "schemaRevision"]);
  assert.equal(c2.$defs.confirmedSourcedFact.properties.verificationStatus.const, "confirmed");
  assert.equal(c2.$defs.confirmedSourcedFact.required.includes("reason"), false);
  assert.equal(c2.$defs.confirmedSourcedFact.properties.value.$ref, "#/$defs/formalFactValue");
  assert.deepEqual(c2.$defs.confirmedSourcedFact.properties.sourceRefs.items.allOf, [
    { $ref: "#/$defs/c2SecretCheckedContractString" },
    { $ref: "#/$defs/canonicalFrozenRef" }
  ]);
  assert.equal(c2.$defs.confirmedSourcedFact.properties.reason.oneOf[0].type, "null");
  assert.equal(c2.$defs.confirmedSourcedFact.properties.reason.oneOf[1].$ref, "#/$defs/formalFactString");
  assert.equal(Object.hasOwn(c2.$defs, "mediaRequirements"), false);
  assert.equal(Object.hasOwn(c2.$defs, "detailedMediaRequirements"), false);
  assert.equal(c2.$defs.targetContext.additionalProperties, false);
  assert.ok(c2.$defs.targetContext.required.includes("schemaEvidenceRef"));
  assert.ok(c2.$defs.targetContext.required.includes("schemaRevision"));
  assert.equal(c2.$defs.canonicalHandoff.properties.keywordEvidenceRefs.minItems, 1);
  assert.equal(c2.$defs.canonicalHandoff.properties.keywordEvidenceRefs.uniqueItems, true);
  assert.equal(c2.$defs.canonicalHandoff.properties.unknownManifest.maxItems, 0);
  assert.equal(c2.$defs.verifiedFacts.properties.unknownManifest.items.$ref, "#/$defs/informationalUnknown");
  assert.equal(c2.$defs.seoEvidenceLayer.oneOf[0].additionalProperties, false);
  for (const field of ["inputEvidenceRefs", "providerJobRef", "productionWrites"]) {
    assert.ok(c2.$defs.seoEvidenceLayer.oneOf[0].required.includes(field), field);
  }
  assert.equal(c2.$defs.seoEvidenceLayer.oneOf[0].properties.productionWrites.const, 0);
  for (const [field, definition] of Object.entries({
    exactSkuVerification: "exactSkuVerificationFacts",
    productAttributes: "productAttributeFacts",
    platformCategory: "platformCategoryFacts",
    batteryAssessment: "batteryAssessmentFacts",
    categoryRestrictions: "categoryRestrictionFacts",
    platformCompliance: "platformComplianceFacts"
  })) {
    assert.equal(c2.$defs.verifiedFacts.properties[field].$ref, `#/$defs/${definition}`, field);
    assert.equal(c2.$defs[definition].additionalProperties, false, definition);
  }
  assert.equal(c2.$defs.initialAssetRegions.properties.collected.items.$ref, "#/$defs/collectedAsset");
  assert.equal(c2.$defs.initialAssetRegions.properties.aiDrafts.items.$ref, "#/$defs/aiDraftAsset");
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function confirmedFact(value, sourceRefs = ["evidence:c1:fixture"]) {
  return { value, verificationStatus: "confirmed", sourceRefs };
}

function unknownFact(reason, sourceRefs = ["evidence:c1:fixture"]) {
  return { value: "unknown", verificationStatus: "unknown", sourceRefs, reason };
}

// Schema-only projection built from the accepted aa66 ready shape. Cross-field equality
// and sourceC1Fingerprint generation remain responsibilities of the accepted aa66 runtime.
function aa66ReadyProjection() {
  const expectedDataRevision = 7;
  const stableStoreId = "store:ozon:dandanshu";
  const schemaRef = "schema:fixture:ozon:bathroom-shelf";
  const keywordRef = "keyword:fixture:shelf";
  const identity = {
    schemaVersion: "g1-identity-v1",
    candidateId: "opportunity:fixture:bathroom-shelf",
    skuPackageId: "sku-lifecycle:fixture:SHELF-WHITE",
    platform: "ozon",
    storeRef: { stableStoreId, platformStoreId: "seller-dandanshu-001", mappingVersion: "stores-v1" },
    supplierSkuId: "SHELF-WHITE",
    merchantSku: "not_applicable",
    warehouseRef: "not_applicable",
    credentialAlias: "not_applicable",
    platformProductId: "not_applicable"
  };
  const providerJobRef = {
    jobId: "job:c1-ai-draft:SHELF-WHITE",
    jobType: "c1_ai_draft",
    providerId: "ecommerce-ai-gateway",
    providerVersion: "gateway-v1",
    candidateId: identity.candidateId,
    skuPackageId: identity.skuPackageId,
    platform: identity.platform,
    storeRef: stableStoreId,
    authorizationRef: {
      authorizationId: "authorization:c1-ai-draft:SHELF-WHITE",
      authorizationType: "paid_ai_draft",
      scope: {
        candidateId: identity.candidateId,
        skuPackageId: identity.skuPackageId,
        platform: identity.platform,
        storeRef: stableStoreId,
        sourceRevision: 6,
        jobType: "c1_ai_draft"
      }
    },
    inputFingerprint: "f".repeat(64),
    sourceRevision: 6,
    receiptRef: "receipt:c1-ai-draft:SHELF-WHITE",
    terminalStatus: "completed",
    requestSubmitted: true,
    responseVerified: true
  };
  const draftOnlySeo = {
    status: "draft_only",
    formalProviderResultAccepted: true,
    reason: null,
    aiRequestId: "request:c1-ai-draft:SHELF-WHITE",
    aiRequestFingerprint: "e".repeat(64),
    inputFingerprint: providerJobRef.inputFingerprint,
    sourceRevision: providerJobRef.sourceRevision,
    receiptRef: "receipt:c1-ai-content:SHELF-WHITE",
    providerJobRef
  };
  const canonicalHandoff = {
    contractVersion: "g1-c1-domain-contract-v1",
    identity: structuredClone(identity),
    frozenInputRevisionRefs: { sourceRevision: 4, resultRevision: 5 },
    handoffRevisionRefs: { sourceRevision: expectedDataRevision, resultRevision: expectedDataRevision + 1 },
    frozenInputRefs: {
      candidateId: identity.candidateId,
      skuPackageId: identity.skuPackageId,
      platform: identity.platform,
      storeRef: stableStoreId,
      sourceRevision: 4,
      salesSnapshotId: "sales:fixture:SHELF-WHITE",
      selectedSupplySnapshotId: "evidence:fixture:SHELF-WHITE",
      ownerSupplyConfirmationRef: "evidence:fixture:SHELF-WHITE/ownerSupplyConfirmation",
      profitModelVersion: "profit-v1",
      schemaSnapshotRef: schemaRef
    },
    schemaSnapshotRef: schemaRef,
    draftOnlySeo,
    keywordEvidenceRefs: [keywordRef],
    unknownManifest: []
  };
  const draft = (text) => ({
    status: "draft_only", text,
    factRefs: ["platformCategory.categoryName"],
    keywordEvidenceRefs: [keywordRef],
    productionApproved: false
  });
  const verifiedFacts = {
    exactSkuVerification: {
      status: confirmedFact("verified"),
      verifiedAt: "2026-08-22T06:00:00.000Z",
      sourceRefs: ["evidence:fixture:SHELF-WHITE"],
      supplierSkuId: confirmedFact(identity.supplierSkuId)
    },
    productAttributes: { status: confirmedFact("all_required_fields_known"), material: confirmedFact("plastic") },
    platformCategory: {
      status: confirmedFact("identified"),
      categoryId: confirmedFact("category:ozon:bathroom-shelf", [schemaRef]),
      categoryName: confirmedFact("Polki", [schemaRef])
    },
    schemaSnapshot: { status: confirmedFact("frozen", [schemaRef]), schemaRevision: confirmedFact("schema-v1", [schemaRef]) },
    batteryAssessment: { status: confirmedFact("fact_available"), assessment: confirmedFact("no_battery") },
    categoryRestrictions: { status: confirmedFact("known", [schemaRef]), restrictions: confirmedFact([], [schemaRef]) },
    platformCompliance: { status: confirmedFact("known", [schemaRef]), assessment: confirmedFact({ status: "clear" }, [schemaRef]) },
    unknownManifest: [{
      fieldPath: "optionalMarketingClaim", reason: "not required for C2 handoff", sourceRefs: [schemaRef],
      blockingScope: "informational", blocksC2Handoff: false
    }]
  };
  const seoDraft = {
    status: "draft_only",
    title: draft("Polka dlya vannoy"),
    description: draft("Polka dlya vannoy. Bez sverleniya."),
    bulletPoints: [draft("Dlya vannoy komnaty.")],
    searchKeywords: {
      status: "draft_only",
      keywords: [{ query: "polka dlya vannoy", evidenceRefs: [keywordRef], factRefs: ["platformCategory.categoryName"] }],
      productionApproved: false
    },
    evidenceLayer: {
      draftVersion: "c1-ai-draft-receipt-v1",
      executionStatus: "draft_only",
      aiRequestId: draftOnlySeo.aiRequestId,
      aiRequestFingerprint: draftOnlySeo.aiRequestFingerprint,
      inputFingerprint: providerJobRef.inputFingerprint,
      sourceRevision: providerJobRef.sourceRevision,
      aiReceiptId: draftOnlySeo.receiptRef,
      providerJobRef,
      inputEvidenceRefs: [schemaRef, keywordRef],
      productionWrites: 0
    }
  };
  const c1 = { verifiedFacts, seoDraft, canonicalHandoff };
  const input = {
    schemaVersion: "c2-software-input-v1",
    status: "ready",
    preparedAt: "2026-08-22T06:00:00.000Z",
    expectedDataRevision,
    identity: structuredClone(identity),
    variantKey: "color:SHELF-WHITE",
    sourceC1Fingerprint: "a".repeat(64),
    c1,
    assets: {
      collected: [{
        assetId: "collected:fixture:shelf:1", mediaType: "image",
        assetRef: "https://source.example.com/shelf-1.jpg", sourcePlatform: "ozon",
        sourceEvidenceRef: "evidence:sales:shelf-1", assetVersion: "asset-v1", sha256: "1".repeat(64),
        usageAuthorization: { status: "analysis_reference_only", evidenceRef: "rights:sales:shelf-1" },
        addedAt: "2026-08-22T06:00:00.000Z", lifecycleArea: "collected",
        usagePolicy: "analysis_reference_only", productionEligible: false
      }],
      aiDrafts: [{
        assetId: "ai-draft:fixture:shelf:1", mediaType: "image",
        assetRef: "https://drafts.example.com/shelf-1-v1.jpg", assetVersion: "asset-v1", sha256: "d".repeat(64),
        sourceType: "ai_generated_draft", generatorRef: "receipt:fixture:image-draft-1",
        sourceEvidenceRef: "receipt:fixture:image-draft-1",
        usageAuthorization: { status: "draft_reference_only", evidenceRef: "rights:ai-draft:shelf-1" },
        addedAt: "2026-08-22T06:00:00.000Z", lifecycleArea: "aiDrafts", productionEligible: false
      }],
      finalUploads: []
    },
    executionPolicy: {
      externalAccessAllowed: false, imageGenerationAllowed: false, xiaohouziAllowed: false,
      gptImageAllowed: false, gateway4318Allowed: false, codexDispatchAllowed: false,
      productionAllowed: false, automaticRetry: false
    }
  };
  return { ready: { ...input, inputFingerprint: sha256(input) } };
}

function assertExactSchemaKeys(value, contract, path) {
  assert.deepEqual(Object.keys(value).sort(), [...contract.required].sort(), path);
  assert.equal(contract.additionalProperties, false, path);
}

function schemaTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function resolveSchemaRef(documents, current, ref) {
  const [documentId, fragment = ""] = ref.split("#");
  const document = documentId ? documents.get(documentId) : current;
  if (!document) throw new Error(`unknown schema document ${documentId}`);
  const resolved = fragment.split("/").slice(1).reduce((value, key) => value[key], document);
  return { document, schema: resolved };
}

function projectionErrors(value, contract, documents, current, path = "$") {
  if (contract === true || contract === undefined) return [];
  if (contract === false) return [`${path}: false schema`];
  if (contract.$ref) {
    const resolved = resolveSchemaRef(documents, current, contract.$ref);
    return projectionErrors(value, resolved.schema, documents, resolved.document, path);
  }
  const errors = [];
  for (const branch of contract.allOf || []) errors.push(...projectionErrors(value, branch, documents, current, path));
  if (contract.oneOf) {
    const matches = contract.oneOf.filter(
      (branch) => projectionErrors(value, branch, documents, current, path).length === 0
    ).length;
    if (matches !== 1) errors.push(`${path}: expected exactly one oneOf branch, got ${matches}`);
  }
  if (contract.not && projectionErrors(value, contract.not, documents, current, path).length === 0) {
    errors.push(`${path}: matched forbidden schema`);
  }
  const types = Array.isArray(contract.type) ? contract.type : contract.type ? [contract.type] : [];
  if (types.length > 0 && !types.some((type) => schemaTypeMatches(value, type))) {
    errors.push(`${path}: expected ${types.join("|")}`);
    return errors;
  }
  if (contract.const !== undefined && JSON.stringify(value) !== JSON.stringify(contract.const)) {
    errors.push(`${path}: const mismatch`);
  }
  if (contract.enum && !contract.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${path}: enum mismatch`);
  }
  if (typeof value === "string") {
    if (contract.minLength !== undefined && value.length < contract.minLength) errors.push(`${path}: minLength`);
    if (contract.maxLength !== undefined && value.length > contract.maxLength) errors.push(`${path}: maxLength`);
    if (contract.pattern && !new RegExp(contract.pattern).test(value)) errors.push(`${path}: pattern`);
    if (contract.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path}: date-time`);
    if (contract.format === "uri") {
      try { new URL(value); } catch { errors.push(`${path}: uri`); }
    }
  }
  if (typeof value === "number" && contract.minimum !== undefined && value < contract.minimum) {
    errors.push(`${path}: minimum`);
  }
  if (Array.isArray(value)) {
    if (contract.minItems !== undefined && value.length < contract.minItems) errors.push(`${path}: minItems`);
    if (contract.maxItems !== undefined && value.length > contract.maxItems) errors.push(`${path}: maxItems`);
    if (contract.uniqueItems && new Set(value.map((item) => JSON.stringify(canonicalize(item)))).size !== value.length) {
      errors.push(`${path}: uniqueItems`);
    }
    value.forEach((item, index) => errors.push(...projectionErrors(item, contract.items, documents, current, `${path}[${index}]`)));
  } else if (value && typeof value === "object") {
    for (const field of contract.required || []) {
      if (!Object.hasOwn(value, field)) errors.push(`${path}.${field}: required`);
    }
    const patterns = Object.entries(contract.patternProperties || {});
    for (const [key, child] of Object.entries(value)) {
      if (contract.propertyNames) errors.push(...projectionErrors(key, contract.propertyNames, documents, current, `${path}.{${key}}`));
      if (contract.properties?.[key]) {
        errors.push(...projectionErrors(child, contract.properties[key], documents, current, `${path}.${key}`));
        continue;
      }
      const matched = patterns.filter(([pattern]) => new RegExp(pattern).test(key));
      if (matched.length > 0) {
        for (const [, branch] of matched) errors.push(...projectionErrors(child, branch, documents, current, `${path}.${key}`));
      } else if (contract.additionalProperties === false) {
        errors.push(`${path}.${key}: additional property`);
      } else if (contract.additionalProperties && typeof contract.additionalProperties === "object") {
        errors.push(...projectionErrors(child, contract.additionalProperties, documents, current, `${path}.${key}`));
      }
    }
  }
  if (contract.if) {
    const matches = projectionErrors(value, contract.if, documents, current, path).length === 0;
    if (matches && contract.then) errors.push(...projectionErrors(value, contract.then, documents, current, path));
    if (!matches && contract.else) errors.push(...projectionErrors(value, contract.else, documents, current, path));
  }
  return errors;
}

function assertAa66ProjectionConsistency(ready) {
  const canonical = ready.c1.canonicalHandoff;
  const job = canonical.draftOnlySeo.providerJobRef;
  const scope = job.authorizationRef.scope;
  const stableStoreId = ready.identity.storeRef.stableStoreId;
  assert.deepEqual(canonical.identity, ready.identity);
  assert.equal(Object.hasOwn(ready.identity, "variantKey"), false);
  assert.equal(Object.hasOwn(canonical.identity, "variantKey"), false);
  assert.equal(ready.variantKey, "color:SHELF-WHITE");
  assert.equal(job.candidateId, ready.identity.candidateId);
  assert.equal(job.skuPackageId, ready.identity.skuPackageId);
  assert.equal(job.platform, ready.identity.platform);
  assert.equal(job.storeRef, stableStoreId);
  assert.deepEqual(scope, {
    candidateId: job.candidateId, skuPackageId: job.skuPackageId, platform: job.platform,
    storeRef: job.storeRef, sourceRevision: job.sourceRevision, jobType: job.jobType
  });
  assert.equal(canonical.frozenInputRefs.storeRef, stableStoreId);
  assert.equal(canonical.handoffRevisionRefs.sourceRevision, ready.expectedDataRevision);
  assert.equal(canonical.handoffRevisionRefs.resultRevision, ready.expectedDataRevision + 1);
  assert.equal(canonical.frozenInputRevisionRefs.resultRevision, canonical.frozenInputRevisionRefs.sourceRevision + 1);
  assert.equal(job.sourceRevision, ready.expectedDataRevision - 1);
  assert.equal(canonical.draftOnlySeo.inputFingerprint, job.inputFingerprint);
  assert.equal(canonical.draftOnlySeo.sourceRevision, job.sourceRevision);
  assert.deepEqual(ready.c1.seoDraft.evidenceLayer.providerJobRef, job);
  assert.equal(ready.c1.seoDraft.evidenceLayer.aiReceiptId, canonical.draftOnlySeo.receiptRef);
  assert.equal(ready.c1.seoDraft.evidenceLayer.aiRequestId, canonical.draftOnlySeo.aiRequestId);
  assert.equal(canonical.schemaSnapshotRef, canonical.frozenInputRefs.schemaSnapshotRef);
  // 槽位合同已废止：C1 事实层和 canonical 交接都不再携带媒体摘要。
  assert.equal(Object.hasOwn(ready.c1.verifiedFacts, "mediaRequirements"), false);
  assert.equal(Object.hasOwn(canonical, "mediaRequirements"), false);
  assert.deepEqual(canonical.unknownManifest, []);
  assert.ok(ready.c1.verifiedFacts.unknownManifest.every(
    (entry) => entry.blockingScope === "informational" && entry.blocksC2Handoff === false
  ));
  const assetIds = [...ready.assets.collected, ...ready.assets.aiDrafts].map((asset) => asset.assetId);
  assert.equal(new Set(assetIds).size, assetIds.length);
  assert.deepEqual(ready.assets.finalUploads, []);
  const { inputFingerprint, ...input } = ready;
  assert.equal(inputFingerprint, sha256(input));
}

test("aa66正式ready形状投影通过公共Schema并保留运行时同源边界", async () => {
  const [c2, lifecycle, editorial, completedEditorial, c2Assets, siblingReuse] = await Promise.all([
    schema("c2-software-input-v1.schema.json"),
    schema("product-lifecycle-v1.1.schema.json"),
    schema("c1-editorial-source-v1.schema.json"),
    schema("c1-editorial-source-v2.schema.json"),
    schema("c2-asset-lifecycle-v1.1.schema.json"),
    schema("c1-sibling-formal-reuse-v1.schema.json")
  ]);
  const documents = new Map([[c2.$id, c2], [lifecycle.$id, lifecycle], [editorial.$id, editorial], ["c1-editorial-source-v1.schema.json", editorial],
    [completedEditorial.$id, completedEditorial], ["c1-editorial-source-v2.schema.json", completedEditorial],
    [c2Assets.$id, c2Assets], ["c2-asset-lifecycle-v1.1.schema.json", c2Assets],
    [siblingReuse.$id, siblingReuse], ["c1-sibling-formal-reuse-v1.schema.json", siblingReuse]]);
  const { ready } = aa66ReadyProjection();
  assertExactSchemaKeys(ready, c2, "ready");
  assertExactSchemaKeys(ready.c1, c2.$defs.c1Snapshot, "ready.c1");
  assertExactSchemaKeys(ready.c1.canonicalHandoff, c2.$defs.canonicalHandoff, "canonicalHandoff");
  assertExactSchemaKeys(ready.c1.canonicalHandoff.draftOnlySeo, c2.$defs.draftOnlySeo.oneOf[0], "draftOnlySeo");
  assertExactSchemaKeys(ready.c1.canonicalHandoff.draftOnlySeo.providerJobRef, c2.$defs.providerJobRef, "providerJobRef");
  assertExactSchemaKeys(ready.assets, c2.$defs.initialAssetRegions, "assets");
  assertExactSchemaKeys(ready.assets.collected[0], c2.$defs.collectedAsset, "collectedAsset");
  assertExactSchemaKeys(ready.assets.aiDrafts[0], c2.$defs.aiDraftAsset, "aiDraftAsset");
  const legalAuthorizationId = ready.c1.canonicalHandoff.draftOnlySeo.providerJobRef.authorizationRef.authorizationId;
  assert.equal(legalAuthorizationId, "authorization:c1-ai-draft:SHELF-WHITE");
  assert.equal(acceptsStringContract(c2.$defs.c1OpaqueAuthorizationId, legalAuthorizationId, c2), true);
  assert.equal(acceptsStringContract(c2.$defs.opaqueEvidenceRef, legalAuthorizationId, c2), false);
  assert.deepEqual(projectionErrors(ready, c2, documents, c2), []);
  assertAa66ProjectionConsistency(ready);

  const noncanonicalFactIdentity = structuredClone(ready);
  noncanonicalFactIdentity.c1.verifiedFacts.exactSkuVerification.supplierSkuId.value = "sku%3Alegacy";
  assert.ok(
    projectionErrors(noncanonicalFactIdentity, c2, documents, c2)
      .some((error) => error.includes("supplierSkuId.value") && error.includes("pattern")),
    "事实包装内的identity引用也必须使用canonicalFrozenRef"
  );

  const fullProducerFacts = structuredClone(ready);
  Object.assign(fullProducerFacts.c1.verifiedFacts.exactSkuVerification, {
    supplierOptionId: confirmedFact("supplier-option:SHELF-WHITE"),
    variantKey: confirmedFact(ready.variantKey),
    sourcePlatform: confirmedFact("1688"),
    offerId: confirmedFact("offer:SHELF-WHITE"),
    productUrl: confirmedFact("https://detail.1688.example/SHELF-WHITE")
  });
  Object.assign(fullProducerFacts.c1.verifiedFacts.productAttributes, {
    supplierAttributes: [{ fieldKey: "color", fact: confirmedFact("white") }],
    weight: confirmedFact({ value: 0.5, unit: "kg" }),
    dimensions: confirmedFact({ length: 30, width: 12, height: 8, unit: "cm" }),
    requiredPlatformFields: [{
      fieldKey: "material", label: "Material", fact: unknownFact("not_present_in_frozen_supplier_attributes")
    }]
  });
  Object.assign(fullProducerFacts.c1.verifiedFacts.platformCategory, {
    platform: confirmedFact(ready.identity.platform),
    store: confirmedFact(ready.identity.storeRef.stableStoreId),
    categoryPath: confirmedFact(["Home", "Bathroom"]),
    descriptionCategoryId: confirmedFact("description-category:1"),
    typeId: confirmedFact("type:1")
  });
  Object.assign(fullProducerFacts.c1.verifiedFacts.batteryAssessment, {
    powered: confirmedFact(false),
    containsBattery: confirmedFact(false),
    batteryType: unknownFact("not_applicable"),
    batteryCount: unknownFact("not_applicable"),
    batteryCapacity: unknownFact("not_applicable")
  });
  Object.assign(fullProducerFacts.c1.verifiedFacts.platformCompliance, {
    profitGate: confirmedFact("passed"),
    requiredFieldGapCount: confirmedFact(0)
  });
  assert.deepEqual(projectionErrors(fullProducerFacts, c2, documents, c2), []);

  for (const mutate of [
    (copy) => { copy.c1.canonicalHandoff.identity.candidateId = "opportunity:drift"; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef.storeRef = "store:ozon:other"; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef.authorizationRef.scope.storeRef = "store:ozon:other"; },
    (copy) => { copy.c1.canonicalHandoff.schemaSnapshotRef = "schema:other"; },
    (copy) => { copy.c1.verifiedFacts.schemaSnapshot.schemaRevision.value = "schema-v2"; },
    (copy) => { copy.assets.aiDrafts[0].assetId = copy.assets.collected[0].assetId; },
    (copy) => { copy.assets.finalUploads.push({ assetId: "forbidden" }); },
    (copy) => { copy.inputFingerprint = "0".repeat(64); }
  ]) {
    const drifted = structuredClone(ready);
    mutate(drifted);
    assert.throws(() => assertAa66ProjectionConsistency(drifted));
  }

  for (const mutate of [
    (copy) => { copy.status = "draft_only"; },
    (copy) => { delete copy.identity.credentialAlias; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.formalProviderResultAccepted = false; },
    (copy) => { delete copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef.storeRef = { stableStoreId: "store:ozon:dandanshu" }; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef.terminalStatus = "running"; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef.terminalStatus = "unknown_outcome"; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef.receiptRef = "RAW_RESPONSE_AT:secret"; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef.authorizationRef.scope.raw_payload = "secret"; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef.authorizationRef.authorizationId = "credential:abc"; },
    (copy) => { copy.c1.canonicalHandoff.draftOnlySeo.providerJobRef.authorizationRef.authorizationId = "https://user:pass@example.test/a"; },
    (copy) => { copy.c1.verifiedFacts.productAttributes.authorization = "Bearer secret"; },
    (copy) => { copy.c1.verifiedFacts.productAttributes.headers = { Authorization: "Bearer secret" }; },
    (copy) => { copy.c1.canonicalHandoff.unknownManifest.push({ fieldPath: "required" }); },
    (copy) => { copy.c1.verifiedFacts.unknownManifest[0].blocksC2Handoff = true; },
    (copy) => { copy.assets.collected[0].usagePolicy = "production_allowed"; },
    (copy) => { copy.assets.aiDrafts[0].sourceType = "owner_upload"; },
    (copy) => { copy.assets.finalUploads.push({ assetId: "forbidden" }); }
  ]) {
    const rejected = structuredClone(ready);
    mutate(rejected);
    assert.notDeepEqual(projectionErrors(rejected, c2, documents, c2), [], mutate.toString());
  }

  const factSections = [
    ["exactSkuVerification", "supplierSkuId"],
    ["productAttributes", "material"],
    ["platformCategory", "categoryName"],
    ["batteryAssessment", "assessment"],
    ["categoryRestrictions", "restrictions"],
    ["platformCompliance", "assessment"]
  ];
  for (const [section, factField] of factSections) {
    for (const mutate of [
      (copy) => { copy.c1.verifiedFacts[section].status = "draft_only"; },
      (copy) => { copy.c1.verifiedFacts[section].status = confirmedFact("draft_only"); },
      (copy) => { copy.c1.verifiedFacts[section][factField].value = { nested: { status: "draft_only" } }; },
      (copy) => { copy.c1.verifiedFacts[section][factField].value = { nested: { status: confirmedFact("draft_only") } }; },
      (copy) => { copy.c1.verifiedFacts[section][factField].value = { nested: { productionAllowed: true } }; },
      (copy) => { copy.c1.verifiedFacts[section][factField].value = [{ nested: { publishPath: "/publish" } }]; }
    ]) {
      const rejected = structuredClone(ready);
      mutate(rejected);
      assert.notDeepEqual(projectionErrors(rejected, c2, documents, c2), [], `${section}.${factField}`);
    }
  }

  for (const key of [
    "accessToken", "ACCESS_TOKEN", "access-token", "AccessTokenAt", "access_token_at", "access-token-at",
    "refreshToken", "REFRESH_TOKEN", "refresh-token", "RefreshTokenAt", "refresh_token_at", "refresh-token-at",
    "clientSecret", "CLIENT_SECRET", "client-secret", "ClientSecretAt", "client_secret_at", "client-secret-at",
    "sessionCookie", "SESSION_COOKIE", "session-cookie", "SessionCookieAt", "session_cookie_at", "session-cookie-at"
  ]) {
    const rejected = structuredClone(ready);
    rejected.c1.verifiedFacts.productAttributes.material.value = { evidenceRef: { [key]: "secret" } };
    assert.notDeepEqual(projectionErrors(rejected, c2, documents, c2), [], key);
  }

  for (const [wrapper, key] of [["metadataRef", "password"], ["evidenceId", "rawPayload"]]) {
    const rejected = structuredClone(ready);
    rejected.c1.verifiedFacts.productAttributes.material.value = { [wrapper]: { [key]: "secret" } };
    assert.notDeepEqual(projectionErrors(rejected, c2, documents, c2), [], `${wrapper}.${key}`);
  }

  for (const [label, value] of SECRET_FACT_STRINGS) {
    const rejected = structuredClone(ready);
    rejected.c1.verifiedFacts.productAttributes.material.value = { nested: [{ note: value }] };
    assert.notDeepEqual(projectionErrors(rejected, c2, documents, c2), [], label);
  }

  for (const value of LEGITIMATE_FACT_STRINGS) {
    const accepted = structuredClone(ready);
    accepted.c1.verifiedFacts.productAttributes.material.value = { nested: [{ note: value }] };
    assert.deepEqual(projectionErrors(accepted, c2, documents, c2), [], value);
  }

  for (const mutate of [
    (copy) => { copy.c1.verifiedFacts.schemaSnapshot.schemaRevision.value = "api_key=abc"; },
    (copy) => { copy.c1.verifiedFacts.productAttributes.material.reason = "credential=abc"; },
    (copy) => { copy.c1.verifiedFacts.unknownManifest[0].reason = "Bearer:abc"; },
    (copy) => { copy.c1.verifiedFacts.productAttributes.material.sourceRefs[0] = "https://example.test/a?accessToken=abc"; },
    (copy) => { copy.c1.verifiedFacts.platformCategory.categoryName.value = "clientSecret=abc"; }
  ]) {
    const rejected = structuredClone(ready);
    mutate(rejected);
    assert.notDeepEqual(projectionErrors(rejected, c2, documents, c2), []);
  }
});

function productionAuthorizationSchemaFixture() {
  const sourceIdentity = {
    schemaVersion: "g1-identity-v1",
    candidateId: "candidate:b1",
    skuPackageId: "sku:b1",
    platform: "ozon",
    storeRef: { stableStoreId: "store:ozon:dandanshu", platformStoreId: "seller-001", mappingVersion: "stores-v1" },
    supplierSkuId: "supplier-sku-1",
    merchantSku: "not_applicable",
    warehouseRef: "not_applicable",
    credentialAlias: "not_applicable",
    platformProductId: "not_applicable"
  };
  const identity = {
    ...structuredClone(sourceIdentity),
    merchantSku: "merchant-sku-1",
    warehouseRef: "warehouse:ozon:main",
    credentialAlias: "credential-alias:ozon:dandanshu"
  };
  const finalUpload = {
    assetId: "asset:main",
    mediaType: "image",
    assetRef: "https://assets.example.test/main.png",
    fileName: "main.png",
    assetVersion: "asset-v1",
    sha256: "d".repeat(64),
    sourceEvidenceRef: "evidence:main",
    stableUrlEvidenceRef: "stable:main",
    usageAuthorization: { status: "owner_authorized_for_listing", evidenceRef: "rights:main" },
    sourceType: "owner_provided_final_upload",
    order: 1,
    role: "main_image",
    byteSize: 1024,
    width: 1000,
    height: 1000,
    addedAt: "2026-08-31T08:00:00.000Z",
    lifecycleArea: "finalUploads",
    ownerConfirmed: true,
    productionEligible: true
  };
  const finalCardInputSnapshot = {
    schemaVersion: "c2-final-card-input-snapshot-v1",
    skuPackageId: "sku:b1",
    sourceDataRevision: 7,
    resultDataRevision: 8,
    sourceC1Fingerprint: "c".repeat(64),
    identity: structuredClone(sourceIdentity),
    variantKey: "color:white",
    inheritedSalesSnapshotRefs: ["sales:1"],
    selectedSupplySnapshot: { snapshotId: "supply:1" },
    activeProfitModelVersion: "profit-v1",
    activeProfitModel: { profitModelVersion: "profit-v1", result: "passed" },
    c1Snapshot: { status: "seo_draft_ready" },
    canonicalC1: { identity: structuredClone(sourceIdentity), unknownManifest: [] }
  };
  return {
    schemaVersion: "production-authorization-v1.1",
    authorizationId: `production-auth:sku:b1:${"a".repeat(64)}:owner-decision-1`,
    status: "confirmed",
    confirmedBy: "owner",
    confirmedByActorId: "owner-1",
    confirmedAt: "2026-08-31T08:00:00.000Z",
    authorizedByActorId: "authorizer-1",
    authorizedAt: "2026-08-31T08:01:00.000Z",
    ownerDecisionId: "owner-decision-1",
    ownerConfirmation: {
      schemaVersion: "production-owner-confirmation-v1",
      decisionId: "owner-decision-1",
      actorId: "owner-1",
      actorType: "human",
      role: "owner",
      confirmedAt: "2026-08-31T08:00:00.000Z",
      sourcePreparationFingerprint: "a".repeat(64),
      sourceFinalCardInputFingerprint: "b".repeat(64),
      sourceC1Fingerprint: "c".repeat(64),
      sourceCandidateRevision: 5,
      sourceSkuRevision: 8,
      ownerDecisionFingerprint: "8".repeat(64)
    },
    technicalAuthorization: {
      schemaVersion: "production-technical-authorization-v1",
      actorId: "authorizer-1",
      actorType: "human",
      role: "production_authorizer",
      authorizedAt: "2026-08-31T08:01:00.000Z"
    },
    ownerDecisionFingerprint: "8".repeat(64),
    ownerDecisionSnapshot: {
      schemaVersion: "production-owner-decision-snapshot-v1",
      decisionId: "owner-decision-1",
      sourceConfirmationCardId: "final-plan-card:sku:b1:8",
      sourcePreparationFingerprint: "a".repeat(64),
      sourceFinalCardInputFingerprint: "b".repeat(64),
      sourceC1Fingerprint: "c".repeat(64),
      sourceCandidateRevision: 5,
      sourceSkuRevision: 8,
      identity: structuredClone(identity),
      buyerTargetPrice: { amount: 1831, currency: "RUB" },
      platformWritePrice: { amount: 151.78, currency: "CNY" },
      priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:evidence:1", checkedAt: "2026-08-31T00:00:00.000Z" },
      stock: 37,
      publishScope: "create_draft_only",
      allowedWriteFields: ["title", "price", "stock", "assets.finalUploads"],
      exclusions: [],
      authorizedMediaFingerprint: "e".repeat(64),
      finalManifestSha256: "f".repeat(64),
      finalUploadsFingerprint: "1".repeat(64),
      mainImageAssetId: "asset:main",
      videoDisposition: "excludes_video",
      effectiveVideoRequirement: { status: "not_required", requiredBy: "default", evidenceRefs: [] }
    },
    sourceConfirmationCardId: "final-plan-card:sku:b1:8",
    sourcePreparationFingerprint: "a".repeat(64),
    sourceFinalCardInputFingerprint: "b".repeat(64),
    sourceC1Fingerprint: "c".repeat(64),
    sourceCandidateRevision: 5,
    resultCandidateRevision: 6,
    authorizedDataRevision: 8,
    resultDataRevision: 9,
    sourceIdentity,
    identity,
    lockedScope: {
      candidateId: "candidate:b1",
      skuPackageId: "sku:b1",
      variantKey: "color:white",
      platform: "ozon",
      storeRef: structuredClone(identity.storeRef),
      merchantSku: identity.merchantSku,
      supplierSkuId: identity.supplierSkuId,
      warehouseRef: identity.warehouseRef,
      credentialAlias: identity.credentialAlias,
      schemaRevision: "schema-v1",
      schemaEvidenceRef: "schema:evidence:1",
      activeProfitModelVersion: "profit-v1",
      buyerTargetPrice: { amount: 1831, currency: "RUB" },
      platformWritePrice: { amount: 151.78, currency: "CNY" },
      priceConversion: { rubPerCny: 12.0637, evidenceRef: "fx:evidence:1", checkedAt: "2026-08-31T00:00:00.000Z" },
      stock: 37,
      authorizedMediaFingerprint: "e".repeat(64),
      finalManifestVersion: "c2-final-manifest-v1",
      finalManifestSha256: "f".repeat(64),
      finalUploadsFingerprint: "1".repeat(64),
      mainImageAssetId: "asset:main",
      videoDisposition: "excludes_video",
      effectiveVideoRequirement: { status: "not_required", requiredBy: "default", evidenceRefs: [] },
      finalUploads: [finalUpload],
      finalCardInputSnapshot,
      publishScope: "create_draft_only",
      allowedWriteFields: ["title", "price", "stock", "assets.finalUploads"],
      exclusions: []
    },
    scopeExpansionAllowed: false,
    fieldMutationAllowed: false,
    skuReplacementAllowed: false,
    assetReplacementAllowed: false,
    readPolicy: "authorization_snapshot_only",
    productionExecuted: false,
    platformWrites: 0
  };
}

test("C2到D公共Schema区分历史交接与单D作业排队，交接本身零外部执行", async () => {
  const [authorization, lifecycle, productionPlan, singleOwnerAuthorization] = await Promise.all([
    schema("production-authorization-v1.1.schema.json"),
    schema("product-lifecycle-v1.1.schema.json"),
    schema("production-plan-v1.1.schema.json"),
    schema("production-authorization-v1.2.schema.json")
  ]);
  assert.equal(authorization.additionalProperties, false);
  for (const field of [
    "ownerDecisionFingerprint", "ownerDecisionSnapshot",
    "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint", "sourceC1Fingerprint",
    "sourceCandidateRevision", "resultCandidateRevision", "authorizedDataRevision", "resultDataRevision",
    "sourceIdentity", "identity", "lockedScope"
  ]) assert.ok(authorization.required.includes(field), field);
  assert.equal(authorization.properties.sourceIdentity.$ref, "#/$defs/sourceG1Identity");
  assert.equal(authorization.$defs.sourceG1Identity.allOf[0].$ref, "product-lifecycle-v1.1#/$defs/g1Identity");
  assert.equal(authorization.properties.identity.$ref, "product-lifecycle-v1.1#/$defs/g1Identity");
  assert.equal(authorization.$defs.lockedScope.additionalProperties, false);
  for (const field of [
    "candidateId", "skuPackageId", "variantKey", "platform", "storeRef", "merchantSku", "supplierSkuId",
    "warehouseRef", "credentialAlias", "schemaRevision", "schemaEvidenceRef",
    "buyerTargetPrice", "platformWritePrice", "priceConversion", "stock", "authorizedMediaFingerprint",
    "finalManifestSha256", "finalUploadsFingerprint", "mainImageAssetId", "videoDisposition", "effectiveVideoRequirement", "finalUploads",
    "publishScope", "allowedWriteFields", "exclusions"
  ]) assert.ok(authorization.$defs.lockedScope.required.includes(field), field);
  assert.equal(authorization.$defs.finalUpload.additionalProperties, false);
  assert.equal(authorization.$defs.finalUpload.properties.ownerConfirmed.const, true);
  assert.equal(authorization.$defs.finalUpload.properties.productionEligible.const, true);

  assert.deepEqual(lifecycle.$defs.c2DHandoff, {
    oneOf: [{ $ref: "#/$defs/historicalC2DHandoff" }, { $ref: "#/$defs/queuedC2DHandoff" }]
  });
  const handoff = lifecycle.$defs.c2DHandoffBase;
  assert.equal(handoff.type, "object");
  assert.equal(handoff.additionalProperties, false);
  const handoffFields = [
    "schemaVersion", "handoffId", "status", "candidateId", "skuPackageId", "identity", "variantKey",
    "productionAuthorizationId", "ownerDecisionId", "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint",
    "sourceCandidateRevision", "resultCandidateRevision", "sourceSkuRevision", "resultSkuRevision", "createdAt",
    "uniqueOwner", "productionPlanCreated", "executionIntentCreated", "softwareJobCreated", "dWritePermissionGranted",
    "externalRequests", "platformWrites"
  ];
  assert.deepEqual(handoff.required, handoffFields);
  assert.deepEqual(Object.keys(handoff.properties), [...handoffFields, "softwareJobRef"]);
  assert.equal(handoff.properties.uniqueOwner.const, "d_software");
  assert.equal(handoff.properties.productionPlanCreated.const, false);
  assert.equal(handoff.properties.executionIntentCreated.const, false);
  assert.equal(handoff.properties.dWritePermissionGranted.const, false);
  assert.equal(handoff.properties.externalRequests.const, 0);
  assert.equal(handoff.properties.platformWrites.const, 0);
  assert.deepEqual(lifecycle.$defs.historicalC2DHandoff, {
    allOf: [
      { $ref: "#/$defs/c2DHandoffBase" },
      { type: "object", properties: {
        softwareJobRef: false,
        schemaVersion: { const: "c2-d-handoff-v1" },
        status: { const: "awaiting_explicit_d_start" },
        softwareJobCreated: { const: false }
      } }
    ]
  });
  assert.deepEqual(lifecycle.$defs.queuedC2DHandoff, {
    allOf: [
      { $ref: "#/$defs/c2DHandoffBase" },
      { type: "object", required: ["softwareJobRef"], properties: {
        softwareJobRef: { $ref: "#/$defs/c2DHandoffBase/properties/softwareJobRef" },
        schemaVersion: { const: "c2-d-handoff-v2" },
        status: { const: "software_job_queued" },
        softwareJobCreated: { const: true }
      } }
    ]
  });
  assert.deepEqual(handoff.properties.softwareJobRef, {
    type: "object", additionalProperties: false,
    required: ["jobId", "jobType", "candidateId", "skuPackageId", "sourceRevision", "resultRevision", "inputFingerprint"],
    properties: {
      jobId: { $ref: "software-job-v1.schema.json#/$defs/strictRef" },
      jobType: { const: "d_production_execution" },
      candidateId: { $ref: "software-job-v1.schema.json#/$defs/strictRef" },
      skuPackageId: { $ref: "software-job-v1.schema.json#/$defs/strictRef" },
      sourceRevision: { type: "integer", minimum: 0 },
      resultRevision: { type: "integer", minimum: 1 },
      inputFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" }
    }
  });
  assert.equal(lifecycle.$defs.SkuLifecyclePackage.properties.dHandoff.oneOf[1].$ref, "#/$defs/c2DHandoff");
  assert.deepEqual(lifecycle.$defs.SkuLifecyclePackage.properties.productionAuthorization.oneOf[1].oneOf, [{ $ref: "production-authorization-v1.1" }, { $ref: "production-authorization-v1.2" }]);
  assert.equal(Object.hasOwn(lifecycle.$defs.SkuLifecyclePackage.properties.productionAuthorization.oneOf[1], "properties"), false);
  assert.equal(productionPlan.$id, "production-plan-v1.1");
  assert.deepEqual(productionPlan.properties.sourceAuthorization.oneOf, [{ $ref: "production-authorization-v1.1" }, { $ref: "production-authorization-v1.2" }]);
  assert.equal(singleOwnerAuthorization.required.includes("technicalAuthorization"), false);
  assert.equal(singleOwnerAuthorization.required.includes("ownerAuthorization"), true);
  assert.equal(singleOwnerAuthorization.$defs.ownerConfirmation.properties.schemaVersion.const, "production-owner-confirmation-v2");
  assert.equal(singleOwnerAuthorization.$defs.ownerAuthorization.properties.source.const, "authenticated_identity_provider");
  const removedAuthorizationMirrors = [
    "sourceAuthorizationId", "sourceAuthorizationFingerprint", "sourcePreparationFingerprint",
    "sourceFinalCardInputFingerprint", "sourceC1Fingerprint", "sourceCandidateRevision",
    "resultCandidateRevision", "authorizedDataRevision", "resultDataRevision", "candidateId", "skuPackageId"
  ];
  for (const field of removedAuthorizationMirrors) {
    assert.equal(productionPlan.required.includes(field), false, field);
    assert.equal(Object.hasOwn(productionPlan.properties, field), false, field);
  }
  for (const forbidden of ["store", "sku", "stock", "title", "content", "packing", "schemaWriteBindings"]) {
    assert.equal(Object.hasOwn(productionPlan.properties, forbidden), false, forbidden);
  }

  const documents = new Map([
    [authorization.$id, authorization],
    [singleOwnerAuthorization.$id, singleOwnerAuthorization],
    [lifecycle.$id, lifecycle],
    [productionPlan.$id, productionPlan]
  ]);
  const fixture = productionAuthorizationSchemaFixture();
  const lifecycleAuthorizationBranch = lifecycle.$defs.SkuLifecyclePackage.properties.productionAuthorization.oneOf[1];
  assert.deepEqual(projectionErrors(fixture, authorization, documents, authorization), []);
  assert.deepEqual(projectionErrors(fixture, lifecycleAuthorizationBranch, documents, lifecycle), []);
  for (const legalText of [
    "tokenizer tool", "secretless design", "cookie cutter", "Basic design", "Bearer material",
    "credential-alias:ozon:dandanshu", "https://x.test/path/size%20chart",
    "https://x.test/?q=100%25%20cotton", "opaque:authorization-ref%2Fsafe", "size%2520chart"
  ]) {
    const legal = structuredClone(fixture);
    legal.lockedScope.finalCardInputSnapshot.c1Snapshot.note = legalText;
    assert.deepEqual(projectionErrors(legal, authorization, documents, authorization), [], legalText);
  }
  const legalEncodedKeys = structuredClone(fixture);
  legalEncodedKeys.lockedScope.finalCardInputSnapshot.c1Snapshot["color%20name"] = "white";
  legalEncodedKeys.lockedScope.finalCardInputSnapshot.c1Snapshot["size%2520label"] = "large";
  legalEncodedKeys.lockedScope.finalCardInputSnapshot.c1Snapshot["material%252520note"] = "cotton";
  legalEncodedKeys.lockedScope.finalCardInputSnapshot.c1Snapshot["product%20tokenizer"] = "tool";
  legalEncodedKeys.lockedScope.finalCardInputSnapshot.c1Snapshot["credential%2520alias"] = "opaque-ref";
  assert.deepEqual(projectionErrors(legalEncodedKeys, authorization, documents, authorization), []);
  assert.deepEqual(projectionErrors(legalEncodedKeys, lifecycleAuthorizationBranch, documents, lifecycle), []);
  for (const mutate of [
    (copy) => { copy.identity = {}; },
    (copy) => { delete copy.lockedScope.merchantSku; },
    (copy) => { copy.lockedScope.extra = true; },
    (copy) => { copy.ownerConfirmation.role = "production_authorizer"; },
    (copy) => { copy.technicalAuthorization.role = "owner"; },
    (copy) => { copy.lockedScope.finalCardInputSnapshot.c1Snapshot.credential_value = "raw-value"; },
    (copy) => { copy.lockedScope.finalCardInputSnapshot.c1Snapshot.token = "abc"; },
    (copy) => { copy.lockedScope.finalCardInputSnapshot.c1Snapshot.secret = "abc"; },
    (copy) => { copy.lockedScope.finalCardInputSnapshot.c1Snapshot.credentials = "abc"; },
    (copy) => { copy.lockedScope.finalCardInputSnapshot.c1Snapshot.note = "token=abc"; },
    (copy) => { copy.lockedScope.finalCardInputSnapshot.c1Snapshot.note = "secret:abc"; },
    (copy) => { copy.lockedScope.finalCardInputSnapshot.c1Snapshot.note = "cookie=abc"; },
    (copy) => { copy.lockedScope.finalCardInputSnapshot.c1Snapshot.note = "https://x.test/?access%252554oken=abc"; }
  ]) {
    const rejected = structuredClone(fixture);
    mutate(rejected);
    assert.notDeepEqual(projectionErrors(rejected, authorization, documents, authorization), []);
    assert.notDeepEqual(projectionErrors(rejected, lifecycleAuthorizationBranch, documents, lifecycle), []);
  }
  for (const encodedSecret of [
    { key: "%74oken", value: "abc" }, { key: "%2574oken", value: "abc" }, { key: "%252574oken", value: "abc" },
    { key: "%73ecret", value: "abc" }, { key: "%2573ecret", value: "abc" }, { key: "%252573ecret", value: "abc" },
    { key: "%63redentials", value: "abc" },
    { key: "to%20ken", value: "abc" }, { key: "to%2520ken", value: "abc" }, { key: "to%252520ken", value: "abc" },
    { key: "tok%65n", value: "abc" }, { key: "%74%6F%6B%65%6E", value: "abc" },
    { key: "access%2DtokenAt", value: "abc" }, { key: "credential%5Fvalue", value: "abc" },
    { key: "note", value: "%73ecret%3Aabc" }, { key: "note", value: "%2573ecret%253Aabc" },
    { key: "note", value: "%252573ecret%25253Aabc" },
    { key: "note", value: "%74oken%3Dabc" }, { key: "note", value: "%2574oken%253Dabc" },
    { key: "note", value: "%252574oken%25253Dabc" },
    { key: "note", value: "https://x.test/?%63redentials%3Dabc" },
    { key: "note", value: "https://x.test/?%2563redentials%253Dabc" },
    { key: "note", value: "https://x.test/?%252563redentials%25253Dabc" },
    { key: "note", value: "https://user:pass%40x.test/path" },
    { key: "note", value: "https://user:pass%2540x.test/path" },
    { key: "note", value: "https://user:pass%252540x.test/path" },
    { key: "note", value: "https%3A%2F%2Fuser%3Apass%40x.test/path" },
    { key: "note", value: "https%253A%252F%252Fuser%253Apass%2540x.test/path" },
    { key: "note", value: "https%25253A%25252F%25252Fuser%25253Apass%252540x.test/path" }
  ]) {
    const rejected = structuredClone(fixture);
    rejected.lockedScope.finalCardInputSnapshot.c1Snapshot[encodedSecret.key] = encodedSecret.value;
    assert.notDeepEqual(projectionErrors(rejected, authorization, documents, authorization), [], JSON.stringify(encodedSecret));
    assert.notDeepEqual(projectionErrors(rejected, lifecycleAuthorizationBranch, documents, lifecycle), [], JSON.stringify(encodedSecret));
  }

  const planFixture = {
    schemaVersion: "production-plan-v1.1",
    planId: "plan:b1:1",
    mode: "simulation",
    status: "prepared",
    createdAt: "2026-08-31T09:00:00.000Z",
    sourceAuthorization: structuredClone(fixture),
    sourceReadPolicy: "authorization_snapshot_only",
    sourceDataAccess: "production_authorization_only",
    productResearchPerformed: false,
    platformWrites: 0,
    productCreated: false,
    assetsUploaded: 0,
    readbackPerformed: false
  };
  assert.deepEqual(projectionErrors(planFixture, productionPlan, documents, productionPlan), []);
  const planWithAuthorizationMirror = { ...structuredClone(planFixture), sourceAuthorizationId: fixture.authorizationId };
  assert.notDeepEqual(projectionErrors(planWithAuthorizationMirror, productionPlan, documents, productionPlan), []);
  assert.equal(Object.hasOwn(handoff.properties, "productionPlan"), false);
  assert.equal(Object.hasOwn(handoff.properties, "executionIntent"), false);
});

test("server只接原子授权处理器且旧入口永久零派发", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const immutableStart = source.indexOf('if (req.method === "POST" && (realProductionAuthorizationPriceRepairRoute || realProductionAuthorizationRevisionRoute))');
  const lifecycleMarker = 'if (req.method === "POST" && (realProductionOwnerDecisionRoute || realProductionAuthorizationRoute))';
  const immutableEnd = source.indexOf(lifecycleMarker, immutableStart);
  const immutableRoute = source.slice(immutableStart, immutableEnd);
  assert.ok(immutableStart > 0 && immutableEnd > immutableStart);
  assert.match(immutableRoute, /json\(res, 410/);
  assert.match(immutableRoute, /externalRequests: 0/);
  assert.match(immutableRoute, /platformWrites: 0/);
  assert.doesNotMatch(immutableRoute, /mutateData|reviseProductionAuthorization/);
  const lifecycleStart = source.indexOf(lifecycleMarker);
  const lifecycleEnd = source.indexOf('if (req.method === "POST" && legacyFireTrainFinalAssetsRoute)', lifecycleStart);
  const lifecycleRoute = source.slice(lifecycleStart, lifecycleEnd);
  assert.ok(lifecycleStart > 0 && lifecycleEnd > lifecycleStart);
  assert.match(lifecycleRoute, /commitSingleOwnerProductionAuthorization/);
  assert.match(lifecycleRoute, /resolveProductionOwnerPreparation/);
  assert.match(lifecycleRoute, /production_authorization_reconfirmation_required/);
  // 钱的闸门那一次拒绝，页面认的是 code 和 ownerNextStep 这两个 ASCII 标记，不靠那句中文；
  // 回体还要照实说这一次零外部请求、零平台写入。
  assert.match(lifecycleRoute, /ExactCommissionRequiredForProductionError/);
  assert.match(lifecycleRoute, /code: error\.code, ownerNextStep: error\.ownerNextStep/);
  assert.match(lifecycleRoute, /exactCommissionRequiredForProduction: true/);
  assert.match(lifecycleRoute, /使用精确费用复算/u);
  assert.doesNotMatch(lifecycleRoute, /createCandidateDispatch|deliverDispatch|createProductionPlan|ExecutionIntent/);
  const legacyStart = source.indexOf('if (req.method === "POST" && productionAuthorizationRoute)');
  const legacyEnd = source.indexOf('const dispatchClaimRoute', legacyStart);
  const legacyRoute = source.slice(legacyStart, legacyEnd);
  assert.ok(legacyStart > 0 && legacyEnd > legacyStart);
  assert.match(legacyRoute, /json\(res, 410/);
  assert.match(legacyRoute, /dispatchesCreated: 0/);
  assert.doesNotMatch(legacyRoute, /createCandidateDispatch|deliverDispatch|mutateData/);
});
