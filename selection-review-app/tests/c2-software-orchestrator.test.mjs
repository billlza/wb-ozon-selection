import { fact, draft, packageFixture, assetRegions, finalAssets, ownerDecision } from "./helpers/c2-software-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  C2_SOFTWARE_TECHNICAL_FAILURE_RECORD_VERSION,
  confirmC2SoftwareFinalUploads,
  createC2SoftwareContainer,
  prepareC2FinalUploadManifest,
  prepareC2SoftwareInput,
  recordC2SoftwareTechnicalFailure
} from "../lib/c2-software-orchestrator.mjs";
import {
  addAiDraftAssets,
  createC2AssetLifecycle,
  fingerprintC2AuthorizationPreparation,
  fingerprintC2FinalManifest,
  fingerprintC2FinalCardInputSnapshot,
  normalizeC2FinalUploads,
  prepareC2StableAssetTransportManifest,
  resolveC2EffectiveVideoRequirement,
  selectConfirmedFinalUploadsForProduction,
  settleC2StableAssetTransport,
  stageC2StableAssetTransport,
  validateC2AssetLifecycle
} from "../lib/c2-asset-lifecycle.mjs";
import {
  fingerprintProductionAuthorizationPreparation,
  fingerprintFinalManifest,
  fingerprintFinalUploads,
  validateProductionAuthorizationPreparation
} from "../lib/production-authorization-preparation.mjs";
import {
  assertValidLifecyclePackage,
  validateC2ProductionAuthorizationPreparationRecord
} from "../lib/product-lifecycle-schema.mjs";
import {
  C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED,
  C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
  C2_REFERENCE_FIELD_SEMANTICS,
  C2_REFERENCE_SEMANTICS,
  C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES,
  C2_DIAGNOSTIC_MAX_PATHS,
  C2_ASSET_LIFECYCLE_REFERENCE_SCHEMA_DEFS,
  C2_REFERENCE_SCHEMA_DEFS,
  LOCAL_FINAL_ASSET_REF_PATTERN_SOURCE,
  CANONICAL_CLOUD_CREDENTIAL_QUERY_KEYS,
  C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS,
  C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE,
  C2_SOFTWARE_INPUT_CANONICAL_FROZEN_REF_PATTERN_SOURCE,
  C2_SOFTWARE_INPUT_CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE,
  CANONICAL_FROZEN_REF_PATTERN_SOURCE,
  CANONICAL_FROZEN_REF_PATTERN_SOURCE as SAFE_FROZEN_REF_PATTERN_SOURCE,
  CANONICAL_STABLE_HTTPS_ASSET_REF_LOCAL_HOST_PATTERN_SOURCE,
  CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH,
  CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE,
  PERCENT_ENCODING_MAX_DECODE_DEPTH,
  PRODUCTION_CONTRACT_MAX_DEPTH,
  PRODUCTION_CONTRACT_MAX_NODES,
  PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED,
  SAFE_FROZEN_REF_MAX_LENGTH,
  assertNoProductionSecrets,
  assertCanonicalAnalysisAssetRef,
  collectCanonicalC2ReferenceErrors,
  assertCanonicalC2ReferenceTree,
  assertCanonicalC1AuthorizationId,
  assertCanonicalFrozenRef,
  assertCanonicalFrozenRef as assertSafeFrozenRef,
  assertCanonicalStableHttpsAssetRef,
  hasPercentEncodingBeyondDecodeDepth,
  isCanonicalC1AuthorizationId,
  isCanonicalAnalysisAssetRef,
  isCanonicalFrozenRef,
  isCanonicalFrozenRef as isSafeFrozenRef,
  isCanonicalStableHttpsAssetRef
} from "../lib/production-contract-primitives.mjs";
import { generateC2ReferenceSchema } from "../scripts/generate-c2-reference-schema.mjs";
import {
  fingerprintProductionAuthorizationPreparation as fingerprintPreparationViaProductionAuthorization,
  validateProductionAuthorizationPreparation as validatePreparationViaProductionAuthorization
} from "../lib/production-authorization.mjs";
import {
  enqueueC2StableAssetTransport,
  settleC2StableAssetTransportJob
} from "../lib/c2-stable-asset-transport-use-case.mjs";
import { createJsonBusinessStateRepository, createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { createSoftwareJobResultEnvelope } from "../lib/software-job-contract.mjs";
import { createActorContext, createLocalDevelopmentActor, createWorkerDescriptor } from "../lib/runtime-identity.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";
import { assertNoSoftwareJobScopeConflict } from "../lib/software-job-admission.mjs";

const NOW = "2026-08-22T06:00:00.000Z";
const LATER = "2026-08-22T06:10:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);
const SHA_G = "1".repeat(64);
const LIFECYCLE_LOCAL_FINAL_URLS = Object.freeze([
  "https://assets.internal/final/main.jpg",
  "https://assets.localdomain/final/main.jpg",
  "https://assets.lan/final/main.jpg",
  "https://assets.home/final/main.jpg"
]);

function stableTransportWorkerRegistry({ clock = () => NOW, workerIds = ["worker-stable-transport-1"] } = {}) {
  const registry = createLocalDevelopmentWorkerRegistry({ clock, heartbeatTtlMs: 30 * 60_000 });
  for (const workerId of workerIds) {
    registry.register({
      workerId,
      capabilities: ["stable-asset-transport"],
      version: "1.0.0",
      observedAt: clock()
    });
  }
  return registry;
}

function percentEncode(value, depth) {
  let encoded = value;
  for (let round = 0; round < depth; round += 1) encoded = encodeURIComponent(encoded);
  return encoded;
}

function encodePercentTripletsBytewise(value) {
  return value.replace(/%[0-9a-f]{2}/gi, (triplet) =>
    [...triplet].map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")
  );
}

function encodeEveryCharacter(value) {
  return [...value].map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
}

function resolveLocalSchemaRef(rootSchema, schema) {
  if (!schema?.$ref) return schema;
  return schema.$ref.slice(2).split("/").reduce((value, key) => value[key], rootSchema);
}

function publishedStringConstraintAccepts(rootSchema, rawSchema, value) {
  const schema = resolveLocalSchemaRef(rootSchema, rawSchema);
  if (typeof value !== "string") return false;
  if (Array.isArray(schema?.oneOf)) {
    const matchingBranches = schema.oneOf.filter((branch) => publishedStringConstraintAccepts(rootSchema, branch, value));
    if (matchingBranches.length !== 1) return false;
  }
  if (Array.isArray(schema?.anyOf)) {
    if (!schema.anyOf.some((branch) => publishedStringConstraintAccepts(rootSchema, branch, value))) return false;
  }
  if (Array.isArray(schema?.allOf)) {
    if (!schema.allOf.every((branch) => publishedStringConstraintAccepts(rootSchema, branch, value))) return false;
  }
  if (schema?.not !== undefined && publishedStringConstraintAccepts(rootSchema, schema.not, value)) return false;
  if (schema?.const !== undefined && value !== schema.const) return false;
  if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) return false;
  if (schema?.type !== undefined && schema.type !== "string") return false;
  if (schema?.minLength !== undefined && value.length < schema.minLength) return false;
  if (schema?.maxLength !== undefined && value.length > schema.maxLength) return false;
  if (schema?.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return false;
  return true;
}

function publishedStringArrayConstraintAccepts(rootSchema, schema, values) {
  if (!Array.isArray(values)) return false;
  if (schema.minItems !== undefined && values.length < schema.minItems) return false;
  if (schema.maxItems !== undefined && values.length > schema.maxItems) return false;
  if (schema.uniqueItems === true && new Set(values).size !== values.length) return false;
  return values.every((value) => publishedStringConstraintAccepts(rootSchema, schema.items, value));
}

function finalVideo() {
  return {
    assetId: "final:fixture:shelf:video",
    mediaType: "video",
    assetRef: "https://assets.example.com/owner/shelf-video-v1.mp4",
    fileName: "shelf-video.mp4",
    byteSize: 4096, width: 1200, height: 1600,
    assetVersion: "final-v1",
    sha256: SHA_E,
    sourceEvidenceRef: "owner-upload:shelf-video",
    stableUrlEvidenceRef: "stable-url:shelf-video-v1",
    usageAuthorization: { status: "owner_authorized_for_listing", evidenceRef: "owner-confirmation:shelf-final-v1" },
    sourceType: "owner_provided_final_upload",
    order: 3,
    role: "gallery_image"
  };
}

test("普通非火车SKU只从C1事实、draft_only SEO和三素材域准备C2输入", () => {
  const pkg = packageFixture();
  const prepared = prepareC2SoftwareInput({
    skuPackage: pkg,
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    preparedAt: NOW
  });
  assert.equal(prepared.status, "ready");
  assert.equal(Object.hasOwn(pkg, "storeRef"), false);
  assert.equal(Object.hasOwn(pkg.c1ProductPlan.identity, "storeRef"), false);
  assert.deepEqual(prepared.identity, pkg.g1Identity);
  assert.equal(Object.hasOwn(prepared.identity, "variantKey"), false);
  assert.equal(prepared.variantKey, pkg.variantKey);
  // 槽位合同已废止：C1 不再交出媒体摘要，冻结 Schema 也不再携带槽位。
  assert.equal(Object.hasOwn(pkg.c1ProductPlan, "mediaRequirements"), false);
  assert.equal(Object.hasOwn(pkg.c1ProductPlan.inputSnapshots.platformSchemaRules, "mediaRequirements"), false);
  assert.equal(prepared.c1.seoDraft.status, "draft_only");
  assert.equal(prepared.assets.collected[0].productionEligible, false);
  assert.equal(prepared.assets.aiDrafts[0].productionEligible, false);
  assert.deepEqual(prepared.assets.finalUploads, []);
  assert.equal(prepared.c1.canonicalHandoff.contractVersion, "g1-c1-domain-contract-v1");
  assert.deepEqual(prepared.c1.canonicalHandoff.identity, pkg.g1Identity);
  assert.equal(
    prepared.c1.canonicalHandoff.draftOnlySeo.providerJobRef.storeRef,
    pkg.g1Identity.storeRef.stableStoreId
  );
  assert.equal(typeof prepared.c1.canonicalHandoff.draftOnlySeo.providerJobRef.storeRef, "string");
  assert.equal(prepared.c1.canonicalHandoff.draftOnlySeo.formalProviderResultAccepted, true);
  assert.deepEqual(prepared.c1.canonicalHandoff.keywordEvidenceRefs, ["keyword:fixture:shelf"]);
  assert.deepEqual(prepared.c1.canonicalHandoff.unknownManifest, []);
  assert.match(prepared.sourceC1Fingerprint, /^[a-f0-9]{64}$/);
  assert.match(prepared.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(prepared.executionPolicy, {
    externalAccessAllowed: false,
    imageGenerationAllowed: false,
    xiaohouziAllowed: false,
    gptImageAllowed: false,
    gateway4318Allowed: false,
    codexDispatchAllowed: false,
    productionAllowed: false,
    automaticRetry: false
  });
});

test("正式ready只机械承接已持久G1身份，variantKey保持唯一顶层来源", () => {
  const cases = [
    ["missing identity", /g1Identity: 必须保存完整G1身份/, (pkg) => { delete pkg.g1Identity; }],
    ["missing structured store", /g1Identity\.storeRef: 必须是稳定结构化店铺引用/, (pkg) => { delete pkg.g1Identity.storeRef; }],
    ["unknown stable store", /g1Identity\.storeRef\.stableStoreId: 必须是明确店铺身份值/, (pkg) => { pkg.g1Identity.storeRef.stableStoreId = "unknown"; }],
    ["invalid platform store", /g1Identity\.storeRef\.platformStoreId: 必须是明确店铺身份值/, (pkg) => { pkg.g1Identity.storeRef.platformStoreId = null; }],
    ["invalid mapping version", /g1Identity\.storeRef\.mappingVersion: 必须是明确店铺身份值/, (pkg) => { pkg.g1Identity.storeRef.mappingVersion = "not_applicable"; }],
    ["wrong identity version", /g1Identity\.schemaVersion: 必须使用g1-identity-v1/, (pkg) => { pkg.g1Identity.schemaVersion = "g1-identity-v0"; }],
    ["identity extra variant", /G1_IDENTITY_REQUIRED/, (pkg) => { pkg.g1Identity.variantKey = pkg.variantKey; }],
    ["missing top-level variant", /variantKey: 变体标识必须是非空字符串/, (pkg) => { delete pkg.variantKey; }],
    ["sentinel top-level variant", /G1_IDENTITY_REQUIRED/, (pkg) => { pkg.variantKey = "unknown"; }],
    ["candidate drift", /G1_IDENTITY_DRIFT/, (pkg) => { pkg.g1Identity.candidateId = "opportunity:other"; }],
    ["sku package drift", /g1Identity\.skuPackageId: 必须与SKU生命周期一致/, (pkg) => { pkg.g1Identity.skuPackageId = "sku-lifecycle:other"; }],
    ["platform drift", /g1Identity\.platform: 必须与目标平台一致/, (pkg) => { pkg.g1Identity.platform = "wb"; }],
    ["stable store drift", /g1Identity\.storeRef\.stableStoreId: 必须与目标店铺一致/, (pkg) => { pkg.g1Identity.storeRef.stableStoreId = "store:ozon:other"; }],
    ["supplier sku drift", /g1Identity\.supplierSkuId: 供应SKU不得替换/, (pkg) => { pkg.g1Identity.supplierSkuId = "OTHER"; }],
    ["legacy variant drift", /C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH/, (pkg) => {
      pkg.c1ProductPlan.identity.variantKey = "颜色:OTHER";
      pkg.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.variantKey = "颜色:OTHER";
      pkg.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot.ownerSupplyConfirmation.variantKey = "颜色:OTHER";
      pkg.selectedSupplySnapshot.supplierSku.variantKey = "颜色:OTHER";
      pkg.selectedSupplySnapshot.ownerSupplyConfirmation.variantKey = "颜色:OTHER";
    }]
  ];
  for (const [name, expected, mutate] of cases) {
    const pkg = packageFixture();
    const beforeRevision = pkg.dataRevision;
    mutate(pkg);
    assert.throws(() => prepareC2SoftwareInput({
      skuPackage: pkg,
      expectedDataRevision: beforeRevision,
      assetRegions: assetRegions(),
      preparedAt: NOW
    }), expected, name);
    assert.equal(pkg.dataRevision, beforeRevision, name);
    assert.equal(pkg.c2FinalAssets, null, name);
    assert.equal(pkg.productionAuthorization, null, name);
    assert.equal(pkg.productionRecord, null, name);
  }
});

test("provider原始storeRef与授权scope必须逐字等于G1 stableStoreId", () => {
  const synchronizedProviderStoreDrift = packageFixture();
  synchronizedProviderStoreDrift.c1ProductPlan.draftOnlySeo.providerJobRef.storeRef = "store:ozon:other";
  synchronizedProviderStoreDrift.c1ProductPlan.draftOnlySeo.providerJobRef.authorizationRef.scope.storeRef = "store:ozon:other";
  synchronizedProviderStoreDrift.c1ProductPlan.seoEvidenceLayer.providerJobRef = structuredClone(
    synchronizedProviderStoreDrift.c1ProductPlan.draftOnlySeo.providerJobRef
  );
  assert.throws(() => prepareC2SoftwareInput({
    skuPackage: synchronizedProviderStoreDrift,
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    preparedAt: NOW
  }), /FORMAL_PROVIDER_REQUIRED/);

  const scopeOnlyDrift = packageFixture();
  scopeOnlyDrift.c1ProductPlan.draftOnlySeo.providerJobRef.authorizationRef.scope.storeRef = "store:ozon:other";
  scopeOnlyDrift.c1ProductPlan.seoEvidenceLayer.providerJobRef = structuredClone(
    scopeOnlyDrift.c1ProductPlan.draftOnlySeo.providerJobRef
  );
  assert.throws(() => prepareC2SoftwareInput({
    skuPackage: scopeOnlyDrift,
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    preparedAt: NOW
  }), /FORMAL_PROVIDER_REQUIRED/);
  assert.equal(synchronizedProviderStoreDrift.c2FinalAssets, null);
  assert.equal(scopeOnlyDrift.c2FinalAssets, null);
});

test("G1身份、C1冻结引用、Schema媒体与revision必须同源", () => {
  const cases = [
    [/CANONICAL_GATE_BLOCKED/, (pkg) => { pkg.c1ProductPlan.frozenInputRefs.storeRef = "store:ozon:other"; }],
    [/CANONICAL_GATE_BLOCKED/, (pkg) => { pkg.c1ProductPlan.identity.targetStore = "store:ozon:other"; }],
    [/C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH/, (pkg) => { pkg.c1ProductPlan.inputSnapshots.platformSchemaRules.storeRef = "store:ozon:other"; }],
    [/TARGET_CONTEXT_INVALID/, (pkg) => { pkg.c1ProductPlan.inputSnapshots.platformSchemaRules.store = "store:ozon:other"; }],
    [/TARGET_CONTEXT_INVALID/, (pkg) => { pkg.c1ProductPlan.inputSnapshots.platformSchemaRules.mediaRequirements = { imageSlots: [] }; }],
    [/CANONICAL_GATE_BLOCKED/, (pkg) => { pkg.c1ProductPlan.revisionRefs.resultRevision = 7; }]
  ];
  for (const [expected, mutate] of cases) {
    const pkg = packageFixture();
    mutate(pkg);
    assert.throws(() => prepareC2SoftwareInput({
      skuPackage: pkg,
      expectedDataRevision: 7,
      assetRegions: assetRegions(),
      preparedAt: NOW
    }), expected);
    assert.equal(pkg.dataRevision, 7);
    assert.equal(pkg.c2FinalAssets, null);
    assert.equal(pkg.productionAuthorization, null);
  }
});

test("新版C1 canonical正式provider、关键词、revision和顶层unknown任一不完整都零C2准备", () => {
  const cases = [
    {
      expected: /FORMAL_PROVIDER_REQUIRED/,
      mutate: (pkg) => {
        pkg.c1ProductPlan.draftOnlySeo.formalProviderResultAccepted = false;
        pkg.c1ProductPlan.draftOnlySeo.providerJobRef = null;
        pkg.c1ProductPlan.unknownManifest.push({
          fieldPath: "draftOnlySeo.providerResult",
          reason: "formal_provider_job_result_missing",
          sourceRefs: ["receipt:c1-ai-content:fixture"],
          blockingScope: "required_field",
          blocksC2Handoff: true
        });
      }
    },
    {
      expected: /FORMAL_PROVIDER_REQUIRED/,
      mutate: (pkg) => { pkg.c1ProductPlan.draftOnlySeo.providerJobRef.providerId = "unknown"; }
    },
    {
      expected: /FORMAL_PROVIDER_REQUIRED/,
      mutate: (pkg) => { delete pkg.c1ProductPlan.draftOnlySeo.providerJobRef.authorizationRef; }
    },
    {
      expected: /FORMAL_PROVIDER_REQUIRED/,
      mutate: (pkg) => { pkg.c1ProductPlan.draftOnlySeo.providerJobRef.terminalStatus = "unknown_outcome"; }
    },
    {
      expected: /FORMAL_PROVIDER_REQUIRED/,
      mutate: (pkg) => { pkg.c1ProductPlan.seoEvidenceLayer.aiReceiptId = "receipt:c1-ai-content:other"; }
    },
    {
      expected: /CANONICAL_GATE_BLOCKED/,
      mutate: (pkg) => {
        pkg.c1ProductPlan.draftOnlySeo.providerJobRef.receiptRef = "Bearer secret=token";
        pkg.c1ProductPlan.seoEvidenceLayer.providerJobRef = structuredClone(pkg.c1ProductPlan.draftOnlySeo.providerJobRef);
      }
    },
    {
      expected: /FORMAL_KEYWORDS_REQUIRED/,
      mutate: (pkg) => { pkg.c1ProductPlan.keywordEvidenceRefs = []; }
    },
    {
      expected: /FORMAL_KEYWORDS_REQUIRED/,
      mutate: (pkg) => { pkg.c1ProductPlan.descriptionDraft.keywordEvidenceRefs = []; }
    },
    {
      expected: /CANONICAL_GATE_BLOCKED/,
      mutate: (pkg) => { pkg.c1ProductPlan.revisionRefs.resultRevision = 8; }
    },
    {
      expected: /CANONICAL_GATE_BLOCKED/,
      mutate: (pkg) => { pkg.c1ProductPlan.schemaSnapshotRef = "schema:other"; }
    }
  ];
  for (const { expected, mutate } of cases) {
    const pkg = packageFixture();
    pkg.c1ProductPlan.inputSnapshots.platformSchemaRules.unknownManifest.blockingItems = [];
    mutate(pkg);
    assert.throws(() => prepareC2SoftwareInput({
      skuPackage: pkg,
      expectedDataRevision: 7,
      assetRegions: assetRegions(),
      preparedAt: NOW
    }), expected);
    assert.equal(pkg.c1ProductPlan.draftOnlySeo.status, "draft_only");
    assert.equal(pkg.c2FinalAssets, null);
    assert.equal(pkg.productionAuthorization, null);
  }
});

test("非阻断informational unknown保留在最终卡事实快照但从canonical handoff清零", () => {
  const pkg = packageFixture();
  pkg.c1ProductPlan.unknownManifest.push({
    fieldPath: "optional.marketingNote",
    reason: "optional_note_not_provided",
    sourceRefs: ["evidence:optional:marketing-note"],
    blockingScope: "informational",
    blocksC2Handoff: false
  });
  const prepared = prepareC2SoftwareInput({
    skuPackage: pkg, expectedDataRevision: 7, assetRegions: assetRegions(), preparedAt: NOW
  });
  assert.deepEqual(prepared.c1.canonicalHandoff.unknownManifest, []);
  assert.equal(prepared.c1.verifiedFacts.unknownManifest.length, 1);
  const initialized = createC2SoftwareContainer({
    skuPackage: pkg, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });
  assert.equal(
    confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.unknownManifest.length,
    1
  );
});

test("冻结Schema缺少平台或店铺身份时明确fail-closed且不猜补", () => {
  const pkg = packageFixture();
  pkg.c1ProductPlan.inputSnapshots.platformSchemaRules.schemaRevision = "schema-v9";
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: pkg,
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    createdAt: NOW
  }), /TARGET_CONTEXT_INVALID/);
  assert.equal(pkg.c2FinalAssets, null);
  assert.equal(pkg.productionAuthorization, null);
});

test("C1完成后原子创建c2_waiting_final_uploads且重复调用幂等", () => {
  const pkg = packageFixture();
  const first = createC2SoftwareContainer({ skuPackage: pkg, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW });
  assert.equal(first.state, "c2_waiting_final_uploads");
  assert.equal(first.skuPackage.businessPhase, "C2");
  assert.equal(first.skuPackage.ownerAction, "provide_final_assets");
  assert.equal(first.skuPackage.dataRevision, 8);
  assert.equal(first.c2AssetLifecycle.assets.finalUploads.length, 0);
  assert.equal(first.c2AssetLifecycle.platformUploads, 0);
  assert.equal(first.skuPackage.productionAuthorization, null);

  const second = createC2SoftwareContainer({
    skuPackage: first.skuPackage,
    expectedDataRevision: 8,
    assetRegions: assetRegions(),
    createdAt: LATER
  });
  assert.equal(second.idempotent, true);
  assert.equal(second.skuPackage.dataRevision, 8);
});

test("C2确认本地不可变成品并保留授权准备，公开转存留给D", () => {
  const initialized = createC2SoftwareContainer({ skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW });
  const assets = finalAssets().map((asset, index) => {
    const assetId = `c2-local:00000000-0000-4000-8000-00000000000${index}`;
    return { ...asset, assetId, assetRef: `local-asset:${assetId}`, assetVersion: `sha256:${asset.sha256}`, byteSize: 512, stableUrlEvidenceRef: "not_applicable" };
  });
  const manifest = prepareC2FinalUploadManifest({ skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: assets, preparedAt: LATER });
  const result = confirmC2SoftwareFinalUploads({ skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalManifest: manifest, ownerDecision: ownerDecision(manifest), confirmedAt: LATER });
  assert.equal(result.state, "c2_ready");
  assert.equal(result.productionAuthorizationCreated, false);
  assert.equal(result.dHandoffCreated, false);
  assert.equal(result.c2AssetLifecycle.platformUploads, 0);
  assert.deepEqual(result.productionAuthorizationPreparation.finalUploads.map(asset => asset.assetRef), assets.map(asset => asset.assetRef));
  assert.equal(validateC2AssetLifecycle(result.c2AssetLifecycle).valid, true);
  assertValidLifecyclePackage(JSON.parse(JSON.stringify(result.skuPackage)));
  for (const change of [
    asset => { asset.assetRef = "local-asset:c2-local:00000000-0000-4000-8000-999999999999"; },
    asset => { asset.stableUrlEvidenceRef = "stable-url:unverified"; },
    asset => { asset.assetVersion = "different"; },
    asset => { asset.byteSize = null; }
  ]) {
    const altered = structuredClone(assets); change(altered[0]);
    assert.throws(() => prepareC2FinalUploadManifest({ skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: altered, preparedAt: LATER }), /C2_FINAL_ASSET_LOCATION_INVALID/);
  }
});

test("主人锁定素材版本、SHA、首图和顺序后才进入c2_ready", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(),
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    createdAt: NOW
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalUploadAssets: finalAssets(),
    preparedAt: LATER
  });
  assert.equal(manifest.status, "awaiting_owner_confirmation");
  assert.equal(manifest.assets[0].role, "main_image");

  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });
  assert.equal(confirmed.state, "c2_ready");
  assert.equal(confirmed.confirmationCardPreparationReady, true);
  assert.equal(confirmed.productionAuthorizationCreated, false);
  assert.equal(confirmed.dHandoffCreated, false);
  assert.equal(confirmed.skuPackage.productionAuthorization, null);
  assert.equal(confirmed.skuPackage.businessPhase, "C2");
  assert.equal(confirmed.skuPackage.businessResult, "pending");
  assert.equal(confirmed.skuPackage.ownerAction, "authorize_production");
  assert.equal(confirmed.productionAuthorizationPreparation.status, "awaiting_final_card_approval");
  assert.equal(confirmed.productionAuthorizationPreparation.productionAuthorizationCreated, false);
  assert.equal(confirmed.productionAuthorizationPreparation.dHandoffCreated, false);
  assert.equal(confirmed.productionAuthorizationPreparation.ownerFinalCardAuthorizationDecision, null);
  assert.equal(confirmed.productionAuthorizationPreparation.targetContext.platform, "ozon");
  assert.equal(confirmed.productionAuthorizationPreparation.targetContext.storeRef, "store:ozon:dandanshu");
  assert.equal(confirmed.productionAuthorizationPreparation.targetContext.schemaEvidenceRef, "schema:fixture:ozon:bathroom-shelf");
  assert.equal(confirmed.productionAuthorizationPreparation.sourceDataRevision, 8);
  assert.equal(confirmed.productionAuthorizationPreparation.resultDataRevision, 9);
  assert.equal(
    confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.sourceDataRevision,
    confirmed.productionAuthorizationPreparation.sourceDataRevision
  );
  assert.equal(
    confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.resultDataRevision,
    confirmed.productionAuthorizationPreparation.resultDataRevision
  );
  assert.equal(
    Object.hasOwn(confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.inputSnapshots.platformSchemaRules, "mediaRequirements"),
    false
  );
  assert.equal(
    confirmed.productionAuthorizationPreparation.targetContext.schemaRevision,
    confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.inputSnapshots.platformSchemaRules.schemaRevision
  );
  assert.equal(
    confirmed.productionAuthorizationPreparation.targetContext.schemaEvidenceRef,
    confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.inputSnapshots.platformSchemaRules.evidenceId
  );
  assert.equal(
    validateProductionAuthorizationPreparation({
      preparation: confirmed.productionAuthorizationPreparation,
      candidateId: confirmed.skuPackage.g1Identity.candidateId,
      skuPackage: confirmed.skuPackage
    }),
    confirmed.productionAuthorizationPreparation
  );
  assert.deepEqual(confirmed.productionAuthorizationPreparation.targetContext, {
    platform: confirmed.c2AssetLifecycle.targetContext.platform,
    targetStore: confirmed.c2AssetLifecycle.targetContext.targetStore,
    storeRef: confirmed.c2AssetLifecycle.targetContext.storeRef,
    schemaRevision: confirmed.c2AssetLifecycle.targetContext.schemaRevision,
    schemaEvidenceRef: confirmed.c2AssetLifecycle.targetContext.schemaEvidenceRef
  });
  assert.deepEqual(confirmed.productionAuthorizationPreparation.finalUploads, confirmed.c2AssetLifecycle.assets.finalUploads);
  assert.deepEqual(
    confirmed.productionAuthorizationPreparation.ownerFinalUploadConfirmation,
    confirmed.c2AssetLifecycle.ownerFinalUploadConfirmation
  );
  assert.deepEqual(confirmed.productionAuthorizationPreparation.pendingAuthorizationInputs, {
    schemaVersion: "c2-authorization-pending-inputs-v1",
    status: "awaiting_independent_owner_authorization",
    merchantSku: null,
    credentialAlias: null,
    warehouseRef: null,
    stock: null,
    price: null,
    allowedWriteFields: null,
    exclusions: null,
    sourceConfirmationCardId: null,
    ownerBusinessDecision: null,
    buyerTargetPrice: null,
    platformWritePrice: null,
    priceConversion: null,
    publishScope: null,
    confirmedAt: null
  });
  assert.equal(confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.schemaVersion, "c2-final-card-input-snapshot-v1");
  assert.equal(confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.activeProfitModel.result, "passed");
  assert.equal(
    confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.seoTitleDraft.text,
    "Полка для ванной"
  );
  assert.deepEqual(
    confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.inputSnapshots.confirmedSupplierSkuSnapshot.ownerSupplyConfirmation,
    confirmed.productionAuthorizationPreparation.finalCardInputSnapshot.selectedSupplySnapshot.ownerSupplyConfirmation
  );
  assert.match(confirmed.productionAuthorizationPreparation.finalCardInputFingerprint, /^[a-f0-9]{64}$/);
  assert.match(confirmed.productionAuthorizationPreparation.preparationFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(confirmed.c2AssetLifecycle.assets.collected, initialized.c2AssetLifecycle.assets.collected);
  assert.deepEqual(confirmed.c2AssetLifecycle.assets.aiDrafts, initialized.c2AssetLifecycle.assets.aiDrafts);
  assert.deepEqual(confirmed.c2AssetLifecycle.assets.finalUploads.map((asset) => asset.order), [1, 2]);
});

test("首图、顺序、SHA或主人清单任一不一致都拒绝", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const badOrder = finalAssets();
  badOrder[0].order = 2;
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: badOrder, preparedAt: LATER
  }), /FINAL_ASSET_INVALID/);

  const badSha = finalAssets();
  badSha[0].sha256 = "not-a-sha";
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: badSha, preparedAt: LATER
  }), /ASSET_INPUT_GAP/);

  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  assert.throws(() => confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: { ...ownerDecision(manifest), approvedManifestSha256: "f".repeat(64) },
    confirmedAt: LATER
  }), /OWNER_CONFIRMATION_REQUIRED/);
});

test("未来读取端只验证冻结准备对象，不重算或依赖当前C1", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });
  const detachedFromCurrentC1 = structuredClone(confirmed.skuPackage);
  detachedFromCurrentC1.c1ProductPlan = null;
  const selected = selectConfirmedFinalUploadsForProduction(detachedFromCurrentC1);
  assert.deepEqual(selected.assets, confirmed.c2AssetLifecycle.assets.finalUploads);
  assert.deepEqual(
    selected.productionAuthorizationPreparation.finalCardInputSnapshot,
    confirmed.productionAuthorizationPreparation.finalCardInputSnapshot
  );
  assert.equal(selected.productionAuthorizationCreated, false);
  assert.equal(selected.dHandoffCreated, false);
  assert.equal(detachedFromCurrentC1.productionAuthorization, null);

  const identityDrift = structuredClone(detachedFromCurrentC1);
  identityDrift.g1Identity.storeRef.stableStoreId = "store:ozon:other";
  assert.throws(() => selectConfirmedFinalUploadsForProduction(identityDrift), /G1_IDENTITY_DRIFT|AUTHORIZATION_PREPARATION_DRIFT/);

  const variantDrift = structuredClone(detachedFromCurrentC1);
  variantDrift.variantKey = "颜色:OTHER";
  assert.throws(() => selectConfirmedFinalUploadsForProduction(variantDrift), /AUTHORIZATION_PREPARATION_DRIFT/);
});

test("C2创建后追加AI草稿产生合法中间revision仍可确认finalUploads", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const added = addAiDraftAssets({
    skuPackage: initialized.skuPackage,
    addedAt: LATER,
    aiDraftAssets: [{
      assetId: "ai-draft:fixture:shelf:2",
      mediaType: "image",
      assetRef: "https://drafts.example.com/shelf-2-v1.jpg",
      assetVersion: "asset-v1",
      sha256: SHA_C,
      generatorRef: "receipt:fixture:image-draft-2",
      sourceEvidenceRef: "receipt:fixture:image-draft-2",
      usageAuthorization: { status: "draft_reference_only", evidenceRef: "rights:ai-draft:shelf-2" }
    }]
  });
  assert.equal(added.skuPackage.dataRevision, 9);
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: added.skuPackage, expectedDataRevision: 9, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: added.skuPackage,
    expectedDataRevision: 9,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });
  assert.equal(confirmed.skuPackage.dataRevision, 10);
  assert.equal(confirmed.productionAuthorizationPreparation.frozenC1Handoff.handoffRevisionRefs.resultRevision, 8);
  assert.equal(confirmed.productionAuthorizationPreparation.sourceDataRevision, 9);
  assert.equal(confirmed.productionAuthorizationPreparation.productionAuthorizationCreated, false);
  assert.equal(confirmed.productionAuthorizationPreparation.dHandoffCreated, false);
});

test("最终卡冻结前拒绝供货确认、B利润同版本漂移和快照合法字段秘密值", () => {
  const cases = [
    {
      name: "supply confirmation drift",
      expected: /FINAL_CARD_INPUT_GAP/,
      mutateBeforeCreate: (pkg) => { pkg.selectedSupplySnapshot.ownerSupplyConfirmation.status = "rejected"; }
    },
    {
      name: "profit model content drift",
      expected: /FINAL_CARD_INPUT_GAP/,
      mutateBeforeCreate: (pkg) => { pkg.profitModels[0].calculatedAt = LATER; }
    },
    {
      name: "supplier SKU identity drift",
      expected: /FINAL_CARD_INPUT_GAP/,
      mutateBeforeCreate: (pkg) => {
        pkg.selectedSupplySnapshot.supplierSku.supplierSkuId = "WRONG-SKU";
        pkg.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.supplierSkuId = "WRONG-SKU";
      }
    },
    {
      name: "secret-bearing frozen URL",
      expected: /SENSITIVE_INPUT_REJECTED/,
      rejectAtCreate: true,
      mutateBeforeCreate: (pkg) => {
        const secretUrl = "https://detail.1688.com/offer/fixture.html?token=secret";
        pkg.selectedSupplySnapshot.supplierOption.productUrl = secretUrl;
        pkg.c1ProductPlan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierOptionIdentity.productUrl = secretUrl;
      }
    },
    {
      name: "raw provider response in supply snapshot",
      expected: /SENSITIVE_INPUT_REJECTED/,
      rejectAtCreate: true,
      mutateBeforeCreate: (pkg) => {
        pkg.selectedSupplySnapshot.rawResponse = { body: "opaque upstream payload" };
      }
    },
    {
      name: "response headers in profit snapshot",
      expected: /SENSITIVE_INPUT_REJECTED/,
      rejectAtCreate: true,
      mutateBeforeCreate: (pkg) => {
        pkg.profitModels[0].responseHeaders = { etag: "opaque" };
        pkg.c1ProductPlan.inputSnapshots.profitModel.responseHeaders = { etag: "opaque" };
      }
    }
  ];
  for (const { name, expected, rejectAtCreate = false, mutateBeforeCreate } of cases) {
    const pkg = packageFixture();
    mutateBeforeCreate(pkg);
    if (rejectAtCreate) {
      assert.throws(() => createC2SoftwareContainer({
        skuPackage: pkg, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
      }), expected, name);
      assert.equal(pkg.c2FinalAssets, null, name);
      assert.equal(pkg.productionAuthorization, null, name);
      assert.equal(pkg.productionRecord, null, name);
      continue;
    }
    const initialized = createC2SoftwareContainer({
      skuPackage: pkg, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
    });
    const manifest = prepareC2FinalUploadManifest({
      skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
    });
    assert.throws(() => confirmC2SoftwareFinalUploads({
      skuPackage: initialized.skuPackage,
      expectedDataRevision: 8,
      finalManifest: manifest,
      ownerDecision: ownerDecision(manifest),
      confirmedAt: LATER
    }), expected, name);
    assert.equal(initialized.skuPackage.c2FinalAssets.productionAuthorizationPreparation, null);
    assert.equal(initialized.skuPackage.productionAuthorization, null);
    assert.equal(initialized.skuPackage.productionRecord, null);
    assert.equal(initialized.skuPackage.c2FinalAssets.platformUploads, 0);
    assert.equal(initialized.skuPackage.c2FinalAssets.productionStarted, false);
  }
});

test("已存准备对象即使同步重算Level-1指纹仍拒绝伪canonical授权和秘密字符串", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });
  for (const { mutate, expectedPath } of [
    { expectedPath: "draftOnlySeo", mutate: (preparation) => {
      preparation.frozenC1Handoff.draftOnlySeo.providerJobRef.authorizationRef = {};
      preparation.finalCardInputSnapshot.canonicalC1.draftOnlySeo.providerJobRef.authorizationRef = {};
    } },
    { mutate: (preparation) => {
      preparation.finalCardInputSnapshot.selectedSupplySnapshot.supplierOption.productUrl =
        "https://detail.1688.com/offer/fixture.html?token=secret";
    } },
    { mutate: (preparation) => {
      preparation.finalCardInputSnapshot.selectedSupplySnapshot.supplierOption.productUrl =
        percentEncode("https://detail.1688.com/offer/fixture.html?authorization=abc", 3);
    } },
    { mutate: (preparation) => {
      preparation.finalUploads[0].assetRef = "https://assets.example.com/final.jpg%ZZ%3Fcredentials%3Dabc";
    } },
    { expectedPath: "draftOnlySeo", mutate: (preparation) => {
      preparation.frozenC1Handoff.draftOnlySeo.providerJobRef.providerId = "unknown";
      preparation.finalCardInputSnapshot.canonicalC1.draftOnlySeo.providerJobRef.providerId = "unknown";
    } },
    { expectedPath: "selectedSupplySnapshot", mutate: (preparation) => {
      preparation.finalCardInputSnapshot.selectedSupplySnapshot.supplierSku.supplierSkuId = "OTHER-SKU";
      preparation.finalCardInputSnapshot.c1Snapshot.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.supplierSkuId = "OTHER-SKU";
    } },
    { expectedPath: "activeProfitModel", mutate: (preparation) => {
      preparation.finalCardInputSnapshot.activeProfitModel.unitProfitRmb = 999;
    } },
    { expectedPath: "productionAuthorizationPreparation", mutate: (preparation) => {
      // 主人授权的是这批地址：换掉任何一张都必须被拦下。
      preparation.finalUploads[1].assetRef = "https://assets.example.com/owner/swapped-v1.jpg";
    } },
    { expectedPath: "unknownManifest", mutate: (preparation) => {
      preparation.finalCardInputSnapshot.c1Snapshot.unknownManifest.push({
        fieldPath: "productAttributes.material",
        reason: "required fact missing",
        sourceRefs: ["evidence:fixture:required-unknown"],
        blockingScope: "required_field",
        blocksC2Handoff: true
      });
    } },
    { expectedPath: "seoTitleDraft", mutate: (preparation) => {
      preparation.finalCardInputSnapshot.c1Snapshot.seoTitleDraft.keywordEvidenceRefs = [];
    } },
    { expectedPath: "frozenInputRefs", mutate: (preparation) => {
      preparation.finalCardInputSnapshot.c1Snapshot.frozenInputRefs.storeRef = "store:ozon:other";
    } },
    { expectedPath: "exactSkuVerification", mutate: (preparation) => {
      delete preparation.finalCardInputSnapshot.c1Snapshot.exactSkuVerification;
    } },
    { expectedPath: "platformSchemaRules", mutate: (preparation) => {
      preparation.finalCardInputSnapshot.c1Snapshot.inputSnapshots.platformSchemaRules.schemaRevision = "schema-v9";
    } },
    { expectedPath: "frozenInputRefs", mutate: (preparation) => {
      preparation.frozenC1Handoff.frozenInputRefs.sourceRevision = 999;
      preparation.finalCardInputSnapshot.canonicalC1.frozenInputRefs.sourceRevision = 999;
      preparation.finalCardInputSnapshot.c1Snapshot.frozenInputRefs.sourceRevision = 999;
    } },
    { mutate: (preparation) => {
      preparation.finalCardInputSnapshot.selectedSupplySnapshot.rawResponse = { body: "opaque upstream payload" };
    } },
    { mutate: (preparation) => {
      preparation.finalCardInputSnapshot.activeProfitModel.responseHeaders = { etag: "opaque" };
    } },
    { mutate: (preparation) => {
      preparation.finalCardInputSnapshot.c1Snapshot.rawHtml = "<html>opaque</html>";
    } },
    { mutate: (preparation) => {
      preparation.finalCardInputSnapshot.selectedSupplySnapshot.rawHeaders = ["HTTP/1.1 200 OK", "opaque"];
    } }
  ]) {
    const stored = structuredClone(confirmed.skuPackage);
    const preparation = stored.c2FinalAssets.productionAuthorizationPreparation;
    mutate(preparation);
    preparation.finalCardInputFingerprint = fingerprintC2FinalCardInputSnapshot(preparation.finalCardInputSnapshot);
    preparation.preparationFingerprint = fingerprintC2AuthorizationPreparation(preparation);
    const validation = validateC2AssetLifecycle(stored.c2FinalAssets);
    assert.equal(validation.valid, false);
    if (expectedPath) {
      assert.ok(validation.errors.some((error) => error.path.includes(expectedPath)), JSON.stringify(validation.errors));
    }
    assert.throws(
      () => selectConfirmedFinalUploadsForProduction(stored),
      /C2素材包校验失败|C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED/
    );
    assert.equal(stored.productionAuthorization, null);
    assert.equal(stored.productionRecord, null);
    assert.equal(stored.c2FinalAssets.platformUploads, 0);
    assert.equal(stored.c2FinalAssets.productionStarted, false);
  }
});

test("confirmed C1事实快照诊断不回显嵌套动态键且保留已知路径", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });
  const factPath = "productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.productAttributes";

  for (const dynamicKey of ["CUSTOM_SECRET_VALUE", "\u0000comma,secret", "x".repeat(100_000)]) {
    const stored = structuredClone(confirmed.skuPackage);
    stored.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.productAttributes[dynamicKey] = {
      value: "unknown",
      verificationStatus: "confirmed",
      sourceRefs: ["evidence:fixture:product-attributes"]
    };
    const frozenStored = structuredClone(stored);
    const validation = validateC2AssetLifecycle(stored.c2FinalAssets);
    const serializedErrors = JSON.stringify(validation.errors);
    assert.equal(validation.valid, false);
    assert.equal(serializedErrors.includes(dynamicKey), false);
    assert.ok(validation.errors.some((error) => error.path.startsWith(`${factPath}.[unknown]`)));
    assert.throws(
      () => selectConfirmedFinalUploadsForProduction(stored),
      (error) => {
        const message = String(error.message);
        assert.match(message, /^C2素材包校验失败:/);
        assert.equal(message.includes(dynamicKey), false);
        assert.ok(Buffer.byteLength(message, "utf8") <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES);
        return true;
      }
    );
    assert.deepEqual(stored, frozenStored, "校验不得继续改变动态事实输入");
  }

  const knownField = structuredClone(confirmed.skuPackage);
  knownField.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.productAttributes.status = {
    value: "unknown",
    verificationStatus: "confirmed",
    sourceRefs: ["evidence:fixture:product-attributes"]
  };
  const knownValidation = validateC2AssetLifecycle(knownField.c2FinalAssets);
  assert.ok(knownValidation.errors.some((error) => error.path === `${factPath}.status`));

  const repeatedDynamicFields = structuredClone(confirmed.skuPackage);
  const attributes = repeatedDynamicFields.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.productAttributes;
  for (const dynamicKey of ["first-secret", "second-secret"]) {
    attributes[dynamicKey] = {
      value: "unknown",
      verificationStatus: "confirmed",
      sourceRefs: ["evidence:fixture:product-attributes"]
    };
  }
  attributes.nested = [{
    value: "unknown",
    verificationStatus: "confirmed",
    sourceRefs: ["evidence:fixture:product-attributes"]
  }];
  const repeatedValidation = validateC2AssetLifecycle(repeatedDynamicFields.c2FinalAssets);
  const unknownFactErrors = repeatedValidation.errors.filter((error) =>
    error.path === `${factPath}.[unknown]` && error.message === "C1事实必须保留有效值、核验状态和来源引用"
  );
  assert.equal(unknownFactErrors.length, 1);
  assert.ok(repeatedValidation.errors.some((error) =>
    error.path === `${factPath}.[unknown][0]` && error.message === "C1事实必须保留有效值、核验状态和来源引用"
  ));
});

test("C2软件入口的raw扫描复用公共有界诊断并保持秘密优先", () => {
  const assertRejectedWithoutEcho = (name, mutate, expectedSummary) => {
    const pkg = packageFixture();
    mutate(pkg);
    const before = structuredClone(pkg);
    assert.throws(
      () => prepareC2SoftwareInput({
        skuPackage: pkg,
        expectedDataRevision: 7,
        assetRegions: assetRegions(),
        preparedAt: NOW
      }),
      (error) => {
        const message = String(error.message);
        assert.match(message, /^C2_SOFTWARE_SENSITIVE_INPUT_REJECTED:/);
        assert.ok(message.endsWith(expectedSummary), `${name}:${message}`);
        assert.ok(Buffer.byteLength(message, "utf8") <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES);
        return true;
      },
      name
    );
    assert.deepEqual(pkg, before, `${name}:输入不得改变`);
    assert.equal(pkg.c2FinalAssets, null);
  };

  assertRejectedWithoutEcho("raw key", (pkg) => {
    pkg.selectedSupplySnapshot.rawResponse = { body: "opaque upstream payload" };
  }, "raw-persistence-key");

  for (const dynamicKey of ["accessToken", "x".repeat(100_000)]) {
    const value = dynamicKey === "accessToken" ? "ordinary" : "Bearer secret-value";
    const pkg = packageFixture();
    pkg.selectedSupplySnapshot[dynamicKey] = value;
    const before = structuredClone(pkg);
    assert.throws(
      () => prepareC2SoftwareInput({
        skuPackage: pkg,
        expectedDataRevision: 7,
        assetRegions: assetRegions(),
        preparedAt: NOW
      }),
      (error) => {
        const message = String(error.message);
        assert.match(message, /^C2_SOFTWARE_SENSITIVE_INPUT_REJECTED:/);
        assert.ok(Buffer.byteLength(message, "utf8") <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES);
        assert.equal(message.includes(dynamicKey), false);
        assert.equal(message.includes("Bearer secret-value"), false);
        return true;
      },
      `secret:${dynamicKey.length}`
    );
    assert.deepEqual(pkg, before);
  }

  const secretThenWide = packageFixture();
  secretThenWide.selectedSupplySnapshot.accessToken = "ordinary";
  secretThenWide.selectedSupplySnapshot.untrusted = Object.fromEntries(
    Array.from({ length: PRODUCTION_CONTRACT_MAX_NODES + 1 }, (_value, index) => [`field${index}`, "ordinary"])
  );
  const frozenSecretThenWide = structuredClone(secretThenWide);
  assert.throws(
    () => prepareC2SoftwareInput({
      skuPackage: secretThenWide,
      expectedDataRevision: 7,
      assetRegions: assetRegions(),
      preparedAt: NOW
    }),
    (error) => {
      const message = String(error.message);
      assert.equal(message, "C2_SOFTWARE_SENSITIVE_INPUT_REJECTED: C2源快照不得包含秘密");
      assert.equal(message.includes("accessToken"), false);
      assert.equal(message.includes("field9999"), false);
      return true;
    }
  );
  assert.deepEqual(secretThenWide, frozenSecretThenWide);

  for (const [name, mutate] of [
    ["wide", (pkg) => {
      pkg.selectedSupplySnapshot.untrusted = Object.fromEntries(
        Array.from({ length: PRODUCTION_CONTRACT_MAX_NODES + 1 }, (_value, index) => [`field${index}`, "ordinary"])
      );
    }],
    ["deep", (pkg) => {
      let cursor = pkg.selectedSupplySnapshot;
      for (let depth = 0; depth <= PRODUCTION_CONTRACT_MAX_DEPTH; depth += 1) {
        cursor.untrusted = {};
        cursor = cursor.untrusted;
      }
    }]
  ]) {
    assertRejectedWithoutEcho(name, mutate, "resource-limit");
  }
});

test("C2资产入口复用公共raw扫描且诊断有界", () => {
  const assertAssetRejected = (name, mutate, expected) => {
    const pkg = packageFixture();
    const regions = assetRegions();
    mutate(regions.collected[0]);
    const frozenPackage = structuredClone(pkg);
    const frozenRegions = structuredClone(regions);
    assert.throws(
      () => createC2AssetLifecycle({ skuPackage: pkg, collectedAssets: regions.collected, createdAt: NOW }),
      (error) => {
        const message = String(error.message);
        assert.match(message, expected, `${name}:${message}`);
        assert.ok(Buffer.byteLength(message, "utf8") <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES);
        return true;
      },
      name
    );
    assert.deepEqual(pkg, frozenPackage, `${name}:package不得改变`);
    assert.deepEqual(regions, frozenRegions, `${name}:assets不得改变`);
    assert.equal(pkg.c2FinalAssets, null);
  };

  assertAssetRejected("raw response", (asset) => {
    asset.rawResponse = { body: "opaque upstream payload" };
  }, /^C2_SENSITIVE_INPUT_REJECTED:/);

  for (const [dynamicKey, value] of [
    ["accessToken", "ordinary"],
    ["x".repeat(100_000), "Bearer secret-value"]
  ]) {
    assertAssetRejected(`secret:${dynamicKey.length}`, (asset) => {
      asset[dynamicKey] = value;
    }, /^PRODUCTION_AUTHORIZATION_SECRET_REJECTED:/);
  }

  assertAssetRejected("wide", (asset) => {
    asset.untrusted = Object.fromEntries(
      Array.from({ length: PRODUCTION_CONTRACT_MAX_NODES + 1 }, (_value, index) => [`field${index}`, "ordinary"])
    );
  }, /^PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED:/);

  assertAssetRejected("deep", (asset) => {
    let cursor = asset;
    for (let depth = 0; depth <= PRODUCTION_CONTRACT_MAX_DEPTH; depth += 1) {
      cursor.untrusted = {};
      cursor = cursor.untrusted;
    }
  }, /^PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED:/);

  const secretThenWidePackage = packageFixture();
  const secretThenWideRegions = assetRegions();
  secretThenWideRegions.collected[0].accessToken = "ordinary";
  secretThenWideRegions.collected[0].untrusted = Object.fromEntries(
    Array.from({ length: PRODUCTION_CONTRACT_MAX_NODES + 1 }, (_value, index) => [`field${index}`, "ordinary"])
  );
  const frozenSecretThenWidePackage = structuredClone(secretThenWidePackage);
  const frozenSecretThenWideRegions = structuredClone(secretThenWideRegions);
  assert.throws(
    () => createC2AssetLifecycle({
      skuPackage: secretThenWidePackage,
      collectedAssets: secretThenWideRegions.collected,
      createdAt: NOW
    }),
    (error) => {
      const message = String(error.message);
      assert.match(message, /^PRODUCTION_AUTHORIZATION_SECRET_REJECTED:/);
      assert.equal(message.includes("accessToken"), false);
      assert.equal(message.includes("field9999"), false);
      assert.ok(Buffer.byteLength(message, "utf8") <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES);
      return true;
    }
  );
  assert.deepEqual(secretThenWidePackage, frozenSecretThenWidePackage);
  assert.deepEqual(secretThenWideRegions, frozenSecretThenWideRegions);
});

test("多SKU、修订和C1指纹隔离，禁止串用或漂移覆盖", () => {
  const shelf = packageFixture({ sku: "SHELF-WHITE" });
  const basket = packageFixture({ sku: "BASKET-BLACK", title: "Корзина для ванной" });
  const shelfC2 = createC2SoftwareContainer({ skuPackage: shelf, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW });
  const basketC2 = createC2SoftwareContainer({ skuPackage: basket, expectedDataRevision: 7, assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, createdAt: NOW });
  assert.notEqual(shelfC2.c2AssetLifecycle.softwareState.sourceC1Fingerprint, basketC2.c2AssetLifecycle.softwareState.sourceC1Fingerprint);
  assert.equal(basket.dataRevision, 7);
  assert.equal(basket.c2FinalAssets, null);
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: shelfC2.skuPackage, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  }), /REVISION_CONFLICT/);

  const drifted = structuredClone(shelfC2.skuPackage);
  drifted.c1ProductPlan.descriptionDraft.text = "漂移文本";
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: drifted, expectedDataRevision: 8, assetRegions: assetRegions(), createdAt: NOW
  }), /SOURCE_DRIFT/);
});

test("目标绑定只接受当前platform、storeRef和Schema证据，且必填unknown必须清零", () => {
  const mutations = [
    (pkg) => { pkg.c1ProductPlan.inputSnapshots.platformSchemaRules.platform = "wb"; },
    (pkg) => { pkg.c1ProductPlan.inputSnapshots.platformSchemaRules.store = "store:ozon:other"; },
    (pkg) => { pkg.c1ProductPlan.inputSnapshots.platformSchemaRules.evidenceId = "schema:other"; },

    (pkg) => { pkg.c1ProductPlan.inputSnapshots.platformSchemaRules.mediaRequirements = { imageSlots: [] }; }
  ];
  for (const mutate of mutations) {
    const pkg = packageFixture();
    mutate(pkg);
    assert.throws(() => prepareC2SoftwareInput({
      skuPackage: pkg,
      expectedDataRevision: 7,
      assetRegions: assetRegions(),
      preparedAt: NOW
    }), /TARGET_CONTEXT_INVALID|C1_SKU_RIGHTS_REVIEW_SCOPE_MISMATCH/);
    assert.equal(pkg.c2FinalAssets, null);
    assert.equal(pkg.productionAuthorization, null);
  }

  const unknown = packageFixture();
  unknown.c1ProductPlan.inputSnapshots.platformSchemaRules.unknownManifest.blockingItems = [];
  unknown.c1ProductPlan.unknownManifest.push({
    fieldPath: "attributes.material",
    reason: "required_material_unknown",
    sourceRefs: ["schema:fixture:ozon:bathroom-shelf"],
    blockingScope: "required_field",
    blocksC2Handoff: true
  });
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: unknown,
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    createdAt: NOW
  }), /REQUIRED_UNKNOWN_BLOCKING/);
  assert.equal(unknown.productionAuthorization, null);
});

test("首图顺序、稳定地址、来源授权和三区独立身份共同组成硬门", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });

  // 主人排第一张的必须是图片，而且软件不许自己给别的图安主图角色。
  const forgedRole = finalAssets();
  forgedRole[1].role = "main_image";
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: forgedRole, preparedAt: LATER
  }), /FINAL_ASSET_INVALID/);

  const reordered = finalAssets();
  reordered[0].order = 2;
  reordered[1].order = 1;
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: reordered, preparedAt: LATER
  }), /FINAL_ASSET_INVALID/);

  for (const invalidUrl of [
    "/owner/local.jpg",
    "http://assets.example.com/owner/main.jpg",
    "https://user:password@assets.example.com/owner/main.jpg",
    "https://127.0.0.1/owner/main.jpg",
    "https://assets.example.com/owner/main.jpg?token=secret"
  ]) {
    const invalid = finalAssets();
    invalid[0].assetRef = invalidUrl;
    assert.throws(() => prepareC2FinalUploadManifest({
      skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: invalid, preparedAt: LATER
    }), /FINAL_ASSET_ADDRESS_INVALID|C2_REFERENCE_REJECTED_NONCANONICAL/);
  }

  const missingStableEvidence = finalAssets();
  delete missingStableEvidence[0].stableUrlEvidenceRef;
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: missingStableEvidence, preparedAt: LATER
  }), /FINAL_ASSET_INVALID/);

  const crossRegionIdentity = finalAssets();
  crossRegionIdentity[0].assetRef = initialized.c2AssetLifecycle.assets.collected[0].assetRef;
  crossRegionIdentity[0].assetVersion = initialized.c2AssetLifecycle.assets.collected[0].assetVersion;
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: crossRegionIdentity, preparedAt: LATER
  }), /ASSET_REGION_CONFLICT/);

  const crossRegionContent = finalAssets();
  crossRegionContent[0].sha256 = initialized.c2AssetLifecycle.assets.collected[0].sha256;
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: crossRegionContent, preparedAt: LATER
  }), /ASSET_REGION_CONFLICT/);

  const pathLikeFileName = finalAssets();
  pathLikeFileName[0].fileName = "../shelf-main.jpg";
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: pathLikeFileName, preparedAt: LATER
  }), /FINAL_ASSET_INVALID/);

  const invalidAddedAt = finalAssets();
  invalidAddedAt[0].addedAt = "not-a-date";
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: invalidAddedAt, preparedAt: LATER
  }), /FINAL_ASSET_INVALID/);

  const secretBearing = finalAssets();
  secretBearing[0].accessToken = "must-not-persist";
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: secretBearing, preparedAt: LATER
  }), /SENSITIVE_INPUT_REJECTED/);
  const secretEvidenceValue = finalAssets();
  secretEvidenceValue[0].sourceEvidenceRef = "Bearer:secret-token";
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalUploadAssets: secretEvidenceValue,
    preparedAt: LATER
  }), /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/);
  assert.equal(initialized.skuPackage.productionAuthorization, null);
});

test("finalUploads直接导出边界复用公共秘密门并保留合法稳定URL", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const normalize = (assets) => normalizeC2FinalUploads({
    finalUploadAssets: assets,
    existingAssets: initialized.c2AssetLifecycle.assets,
    effectiveVideoRequirement: resolveC2EffectiveVideoRequirement({
      skuPackage: initialized.skuPackage
    }),
    addedAt: LATER
  });

  for (const legalUrl of [
    "https://assets.example.com/owner/shelf-main-v1.jpg?version=1",
    "https://assets.example.com/owner/shelf-main-v1.jpg?tokenizer=tool",
    "https://assets.example.com/owner/shelf-main-v1.jpg?secretless=design",
    "https://assets.example.com/owner/shelf-main-v1.jpg?credentialAlias=ozon",
    "https://assets.example.com/owner/shelf-main-v1.jpg?securityPolicy=required",
    "https://assets.example.com/owner/shelf-main-v1.jpg?securityLabel=public",
    "https://assets.example.com/owner/shelf-main-v1.jpg?x-oss-process=image"
  ]) {
    const assets = finalAssets();
    assets[0].assetRef = legalUrl;
    const result = normalize(assets);
    assert.equal(result.assets[0].assetRef, legalUrl);
    assert.equal(result.assets[0].ownerConfirmed, true);
    assert.equal(result.assets[0].productionEligible, true);
    assert.equal(result.assets[0].lifecycleArea, "finalUploads");
    assert.equal(result.mainImageAssetId, assets[0].assetId);
    assert.equal(result.videoDisposition, "excludes_video");
  }
  const legalEvidenceRefs = finalAssets();
  legalEvidenceRefs[0].sourceEvidenceRef = "tokenizer-ref";
  legalEvidenceRefs[0].stableUrlEvidenceRef = "secretless-ref";
  legalEvidenceRefs[0].usageAuthorization.evidenceRef = "credential-alias:ozon:dandanshu";
  const normalizedEvidenceRefs = normalize(legalEvidenceRefs);
  assert.equal(normalizedEvidenceRefs.assets[0].sourceEvidenceRef, "tokenizer-ref");
  assert.equal(normalizedEvidenceRefs.assets[0].stableUrlEvidenceRef, "secretless-ref");
  assert.equal(
    normalizedEvidenceRefs.assets[0].usageAuthorization.evidenceRef,
    "credential-alias:ozon:dandanshu"
  );

  const immutableSuccessAssets = finalAssets();
  immutableSuccessAssets[0].assetRef = "https://assets.example.com/owner/shelf-main-v1.jpg?x-oss-process=image";
  const successAssetsBefore = structuredClone(immutableSuccessAssets);
  const successExistingBefore = structuredClone(initialized.c2AssetLifecycle.assets);
  const successRequirementsBefore = structuredClone(initialized.c2AssetLifecycle.targetContext);
  assert.equal(normalize(immutableSuccessAssets).assets[0].assetRef, immutableSuccessAssets[0].assetRef);
  assert.deepEqual(immutableSuccessAssets, successAssetsBefore);
  assert.deepEqual(initialized.c2AssetLifecycle.assets, successExistingBefore);
  assert.deepEqual(initialized.c2AssetLifecycle.targetContext, successRequirementsBefore);

  const unsafeQueryKeys = [
    "authorization", "bearer", "basic", "cookie", "cookies", "cookiejar", "headers", "requestHeaders",
    "token", "access_token", "refresh_token", "client_secret", "api_key", "signature", "expires", "expiry",
    ...CANONICAL_CLOUD_CREDENTIAL_QUERY_KEYS
  ];
  assert.ok(unsafeQueryKeys.includes("security-token"));
  for (const key of unsafeQueryKeys) {
    const assets = finalAssets();
    assets[0].assetRef = `https://assets.example.com/owner/shelf-main-v1.jpg?${key}=abc`;
    assert.throws(() => normalize(assets), /(?:C2_FINAL_ASSET_ADDRESS_INVALID|PRODUCTION_SAFE_FROZEN_REF_INVALID)/);
  }
  for (const localFinalUrl of LIFECYCLE_LOCAL_FINAL_URLS) {
    const assets = finalAssets();
    assets[0].assetRef = localFinalUrl;
    assert.throws(() => normalize(assets), /C2_FINAL_ASSET_ADDRESS_INVALID/, localFinalUrl);
  }
  const immutableFailureAssets = finalAssets();
  immutableFailureAssets[0].assetRef = "https://assets.example.com/owner/shelf-main-v1.jpg?x-oss-security-token=temporary";
  const failureAssetsBefore = structuredClone(immutableFailureAssets);
  const failureExistingBefore = structuredClone(initialized.c2AssetLifecycle.assets);
  const failureRequirementsBefore = structuredClone(initialized.c2AssetLifecycle.targetContext);
  assert.throws(() => normalize(immutableFailureAssets), /C2_FINAL_ASSET_ADDRESS_INVALID/);
  assert.deepEqual(immutableFailureAssets, failureAssetsBefore);
  assert.deepEqual(initialized.c2AssetLifecycle.assets, failureExistingBefore);
  assert.deepEqual(initialized.c2AssetLifecycle.targetContext, failureRequirementsBefore);
  for (const key of ["authorization", "bearer", "cookie", "credentials"]) {
    let encodedKey = [...key].map((character) =>
      `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    for (let depth = 1; depth <= 3; depth += 1) {
      const assets = finalAssets();
      assets[0].assetRef = `https://assets.example.com/owner/shelf-main-v1.jpg?${encodedKey}=abc`;
      assert.throws(() => normalize(assets), /C2_FINAL_ASSET_ADDRESS_INVALID/);
      encodedKey = encodeURIComponent(encodedKey);
    }
  }
  for (const unsafeSuffix of [
    "%ZZ%3Fauthorization%3Dabc", "%ZZ%3Fbearer%3Dabc", "%ZZ%3Fcookie%3Dabc",
    "%ZZ%3Ftoken%3Dabc", "%ZZ%3Fsecret%3Dabc", "%ZZ%3Fcredentials%3Dabc",
    "%ZZ-token%3Dabc", "%ZZBearer%20abc123", "%ZZnote%3ABearer",
    "%ZZ%2F%2Fuser%3Apass%40assets.example.com%2Ffinal.jpg",
    "note%3ABearer%20abc123", "https%3A%2F%2Fuser%3Apass%40assets.example.com%2Ffinal.jpg"
  ]) {
    const assets = finalAssets();
    assets[0].assetRef = `https://assets.example.com/owner/shelf-main-v1.jpg${unsafeSuffix}`;
    assert.throws(() => normalize(assets), /C2_FINAL_ASSET_ADDRESS_INVALID/);
  }
  for (const key of ["authorization", "bearer", "cookie", "secret"]) {
    const unsafeUrl = `https://assets.example.com/owner/shelf-main-v1.jpg?${key}=abc`;
    for (let depth = 1; depth <= 3; depth += 1) {
      const assets = finalAssets();
      assets[0].assetRef = percentEncode(unsafeUrl, depth);
      assert.throws(() => normalize(assets), /C2_FINAL_ASSET_ADDRESS_INVALID/);
    }
  }
  for (const unsafePath of [
    "https://assets.example.com/owner/token:abc/shelf-main-v1.jpg",
    "https://assets.example.com/owner/safe/authorization:abc/shelf-main-v1.jpg"
  ]) {
    const assets = finalAssets();
    assets[0].assetRef = unsafePath;
    assert.equal(isCanonicalStableHttpsAssetRef(unsafePath), false, unsafePath);
    assert.throws(() => assertCanonicalStableHttpsAssetRef(unsafePath), /C2_REFERENCE_REJECTED_NONCANONICAL/);
    assert.throws(() => normalize(assets), /C2_FINAL_ASSET_ADDRESS_INVALID/);
  }

  for (const mutate of [
    (asset) => { asset.sourceEvidenceRef = "authorization:abc"; },
    (asset) => { asset.stableUrlEvidenceRef = "bearer:abc"; },
    (asset) => { asset.usageAuthorization.evidenceRef = "cookie:abc"; }
  ]) {
    const assets = finalAssets();
    mutate(assets[0]);
    assert.throws(() => normalize(assets), /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/);
  }
});

test("视频默认not_required，只有Schema或当前SKU主人证据能升级为required", () => {
  const defaultC2 = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const defaultManifest = prepareC2FinalUploadManifest({
    skuPackage: defaultC2.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  assert.equal(defaultManifest.effectiveVideoRequirement.status, "not_required");
  assert.equal(defaultManifest.videoDisposition, "excludes_video");

  // 冻结 Schema 从没交出过视频要求：视频现在只能由主人自己要求（见下面的 ownerVideoRequirement 用例）。
  const schemaRequiredC2 = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const withVideo = [...finalAssets(), finalVideo()];
  const schemaVideoManifest = prepareC2FinalUploadManifest({
    skuPackage: schemaRequiredC2.skuPackage, expectedDataRevision: 8, finalUploadAssets: withVideo, preparedAt: LATER
  });
  assert.equal(schemaVideoManifest.videoDisposition, "includes_video");

  const ownerRequiredC2 = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const ownerVideoRequirement = {
    schemaVersion: "c2-owner-video-requirement-v1",
    required: true,
    confirmedBy: "owner",
    skuPackageId: ownerRequiredC2.skuPackage.skuPackageId,
    sourceDataRevision: 8,
    evidenceRef: "owner-decision:video-required"
  };
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: ownerRequiredC2.skuPackage,
    expectedDataRevision: 8,
    finalUploadAssets: withVideo,
    ownerVideoRequirement: { ...ownerVideoRequirement, sourceDataRevision: 7 },
    preparedAt: LATER
  }), /VIDEO_REQUIREMENT_INVALID/);
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: ownerRequiredC2.skuPackage,
    expectedDataRevision: 8,
    finalUploadAssets: finalAssets(),
    ownerVideoRequirement,
    preparedAt: LATER
  }), /VIDEO_REQUIRED/);
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: ownerRequiredC2.skuPackage,
    expectedDataRevision: 8,
    finalUploadAssets: withVideo,
    ownerVideoRequirement: { ...ownerVideoRequirement, metadata: { accessToken: "must-not-persist" } },
    preparedAt: LATER
  }), /SENSITIVE_INPUT_REJECTED/);
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: ownerRequiredC2.skuPackage,
    expectedDataRevision: 8,
    finalUploadAssets: withVideo,
    ownerVideoRequirement: { ...ownerVideoRequirement, evidenceRef: "Bearer-secret-token" },
    preparedAt: LATER
  }), /SENSITIVE_INPUT_REJECTED/);
  const ownerVideoManifest = prepareC2FinalUploadManifest({
    skuPackage: ownerRequiredC2.skuPackage,
    expectedDataRevision: 8,
    finalUploadAssets: withVideo,
    ownerVideoRequirement,
    preparedAt: LATER
  });
  const ownerVideoConfirmed = confirmC2SoftwareFinalUploads({
    skuPackage: ownerRequiredC2.skuPackage,
    expectedDataRevision: 8,
    finalManifest: ownerVideoManifest,
    ownerDecision: ownerDecision(ownerVideoManifest),
    confirmedAt: LATER
  });
  assert.equal(ownerVideoConfirmed.productionAuthorizationPreparation.videoDisposition, "includes_video");
  assert.equal(ownerVideoConfirmed.c2AssetLifecycle.ownerVideoRequirement.skuPackageId, ownerRequiredC2.skuPackage.skuPackageId);
  assert.equal(ownerVideoConfirmed.c2AssetLifecycle.ownerVideoRequirement.sourceDataRevision, 8);
  assert.equal(ownerVideoConfirmed.skuPackage.productionAuthorization, null);
  assert.equal(ownerVideoConfirmed.dHandoffCreated, false);

  const contradictory = packageFixture();
  contradictory.c1ProductPlan.inputSnapshots.platformSchemaRules.mediaRequirements = { videoSlots: [{ minCount: 1 }] };
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: contradictory, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  }), /CANONICAL_GATE_BLOCKED|TARGET_CONTEXT_INVALID/);
});

test("确认边界重验C1、媒体要求、素材版本并支持完全相同输入幂等重试", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });

  const c1Drift = structuredClone(initialized.skuPackage);
  c1Drift.c1ProductPlan.inputSnapshots.platformSchemaRules.schemaRevision = "schema-v2";
  assert.throws(() => confirmC2SoftwareFinalUploads({
    skuPackage: c1Drift,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  }), /SOURCE_DRIFT|TARGET_CONTEXT_DRIFT/);

  const assetDrift = structuredClone(manifest);
  assetDrift.assets[1].assetVersion = "final-v2";
  assert.throws(() => confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: assetDrift,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  }), /FINAL_MANIFEST_INVALID/);

  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });
  const retry = confirmC2SoftwareFinalUploads({
    skuPackage: confirmed.skuPackage,
    expectedDataRevision: 9,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.skuPackage.dataRevision, 9);
  assert.equal(retry.productionAuthorizationCreated, false);
  assert.equal(retry.dHandoffCreated, false);

  for (const mutate of [
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.skuPackageId = "sku-lifecycle:other"; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.sourceDataRevision -= 1; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.resultDataRevision += 1; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.ownerConfirmationAt = NOW; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.finalManifestVersion = "c2-final-manifest-v2"; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.targetContext.storeRef = "store:ozon:other"; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.finalUploads[1].assetRef = "https://assets.example.com/owner/swapped-v1.jpg"; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.frozenC1Handoff.keywordEvidenceRefs = ["keyword:other"]; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.finalUploads[0].order = 2; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.effectiveVideoRequirement.status = "required"; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.ownerFinalUploadConfirmation.approvedAssetIds.reverse(); },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.activeProfitModel.unitProfitRmb = 999; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.finalCardInputFingerprint = SHA_B; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.ownerFinalCardAuthorizationDecision = { approved: true }; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.pendingAuthorizationInputs.merchantSku = "guessed"; },
    (pkg) => { pkg.c2FinalAssets.productionAuthorizationPreparation.preparationFingerprint = SHA_A; }
  ]) {
    const driftedPreparation = structuredClone(confirmed.skuPackage);
    mutate(driftedPreparation);
    assert.throws(() => createC2SoftwareContainer({
      skuPackage: driftedPreparation,
      expectedDataRevision: 9,
      assetRegions: assetRegions(),
      createdAt: NOW
    }), /AUTHORIZATION_PREPARATION_DRIFT|C2素材包校验失败/);
  }
});

test("既有授权或D/E状态一律零准备、零确认、零handoff", () => {
  for (const field of [
    "productionConfirmationCard", "productionAuthorization", "productionRecord", "dAssetTransport",
    "externalListingRecord", "eVerificationRecord"
  ]) {
    const pkg = packageFixture();
    pkg[field] = { status: "existing" };
    assert.throws(() => prepareC2SoftwareInput({
      skuPackage: pkg,
      expectedDataRevision: 7,
      assetRegions: assetRegions(),
      preparedAt: NOW
    }), /DOWNSTREAM_STATE_CONFLICT/);
    assert.equal(pkg.c2FinalAssets, null);
  }

  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const withExistingAuthorization = structuredClone(initialized.skuPackage);
  withExistingAuthorization.productionAuthorization = { status: "existing" };
  assert.throws(() => prepareC2FinalUploadManifest({
    skuPackage: withExistingAuthorization,
    expectedDataRevision: 8,
    finalUploadAssets: finalAssets(),
    preparedAt: LATER
  }), /DOWNSTREAM_STATE_CONFLICT/);

  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalUploadAssets: finalAssets(),
    preparedAt: LATER
  });
  const withExistingCard = structuredClone(initialized.skuPackage);
  withExistingCard.productionConfirmationCard = { status: "awaiting_owner_business_confirmation" };
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: withExistingCard,
    expectedDataRevision: 8,
    assetRegions: assetRegions(),
    createdAt: LATER
  }), /DOWNSTREAM_STATE_CONFLICT/);
  assert.throws(() => addAiDraftAssets({
    skuPackage: withExistingCard,
    aiDraftAssets: [],
    addedAt: LATER
  }), /DOWNSTREAM_STATE_CONFLICT/);
  assert.throws(() => confirmC2SoftwareFinalUploads({
    skuPackage: withExistingCard,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  }), /DOWNSTREAM_STATE_CONFLICT/);
  assert.equal(withExistingCard.dataRevision, 8);
  assert.equal(withExistingCard.c2FinalAssets.productionAuthorizationPreparation, null);
  assert.equal(withExistingCard.productionAuthorization, null);
});

test("已存C2对象的秘密、额外字段及生产痕迹在运行时一律拒绝", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const mutations = [
    (pkg) => { pkg.c2FinalAssets.assets.collected[0].accessToken = "must-not-persist"; },
    (pkg) => { pkg.c2FinalAssets.assets.extra = [{ accessToken: "must-not-persist" }]; },
    (pkg) => { pkg.c2FinalAssets.generationIntegrations.token = "must-not-persist"; },
    (pkg) => { pkg.c2FinalAssets.softwareState.executionPolicy.token = "must-not-persist"; },
    (pkg) => { pkg.c2FinalAssets.platformUploads = 1; },
    (pkg) => { pkg.c2FinalAssets.productionStarted = true; }
  ];
  for (const mutate of mutations) {
    const polluted = structuredClone(initialized.skuPackage);
    mutate(polluted);
    assert.throws(() => createC2SoftwareContainer({
      skuPackage: polluted,
      expectedDataRevision: 8,
      assetRegions: assetRegions(),
      createdAt: LATER
    }), /C2素材包校验失败|商品生命周期数据校验失败/);
    assert.equal(polluted.productionAuthorization, null);
    assert.equal(polluted.c2FinalAssets.productionAuthorizationPreparation, null);
  }
});

test("技术失败生成独立版本记录且不改变candidate revision、阶段或下游状态", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const before = structuredClone(initialized.skuPackage);
  const failed = recordC2SoftwareTechnicalFailure({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    failure: {
      layer: "asset_manifest_storage",
      failureClass: "persistence_failure",
      code: "WRITE_FAILED",
      evidenceRef: "evidence:c2:write-failed"
    },
    failedAt: LATER
  });
  assert.equal(failed.technicalStatus, "failed");
  assert.equal(failed.automaticRetry, false);
  assert.equal(failed.candidateChanged, false);
  assert.deepEqual(failed.skuPackage, before);
  assert.equal(failed.skuPackage.dataRevision, initialized.skuPackage.dataRevision);
  assert.equal(failed.skuPackage.businessPhase, initialized.skuPackage.businessPhase);
  assert.equal(failed.skuPackage.businessResult, initialized.skuPackage.businessResult);
  assert.equal(failed.skuPackage.ownerAction, initialized.skuPackage.ownerAction);
  assert.deepEqual(failed.skuPackage.audit, initialized.skuPackage.audit);
  assert.equal(failed.skuPackage.productionAuthorization, null);
  assert.equal(failed.skuPackage.c2FinalAssets.productionAuthorizationPreparation, null);
  assert.equal(failed.productionAuthorizationCreated, false);
  assert.equal(failed.dHandoffCreated, false);
  assert.equal(failed.technicalFailureRecord.schemaVersion, C2_SOFTWARE_TECHNICAL_FAILURE_RECORD_VERSION);
  assert.match(failed.technicalFailureRecord.failureRecordId, /^c2-technical-failure:[a-f0-9]{64}$/);
  assert.equal(failed.technicalFailureRecord.candidateId, initialized.skuPackage.g1Identity.candidateId);
  assert.equal(failed.technicalFailureRecord.skuPackageId, initialized.skuPackage.skuPackageId);
  assert.equal(failed.technicalFailureRecord.assetPackageId, initialized.skuPackage.c2FinalAssets.assetPackageId);
  assert.equal(failed.technicalFailureRecord.sourceDataRevision, initialized.skuPackage.dataRevision);
  assert.equal(failed.technicalFailureRecord.businessPhase, initialized.skuPackage.businessPhase);
  assert.equal(
    failed.technicalFailureRecord.sourceC1Fingerprint,
    initialized.skuPackage.c2FinalAssets.softwareState.sourceC1Fingerprint
  );
  assert.deepEqual(failed.technicalFailureRecord.failure, {
    layer: "asset_manifest_storage",
    failureClass: "persistence_failure",
    code: "WRITE_FAILED",
    evidenceRef: "evidence:c2:write-failed",
    failedAt: LATER
  });
  assert.equal(failed.technicalFailureRecord.status, "stopped");
  assert.equal(failed.technicalFailureRecord.automaticRetry, false);
  assert.equal(failed.technicalFailureRecord.businessResultChanged, false);
  assert.equal(failed.technicalFailureRecord.c1Changed, false);
  assert.equal(failed.technicalFailureRecord.productionStarted, false);
  assert.equal(failed.technicalFailureRecord.productionAuthorizationCreated, false);
  assert.equal(failed.technicalFailureRecord.dHandoffCreated, false);
  assert.deepEqual(failed.technicalFailureRecord.auditEvent, {
    event: "c2_software_technical_failure_stopped",
    at: LATER,
    failureRecordId: failed.technicalFailureRecord.failureRecordId,
    sourceDataRevision: initialized.skuPackage.dataRevision,
    automaticRetry: false,
    businessResultChanged: false,
    c1Changed: false,
    productionStarted: false
  });
  assert.equal(Object.isFrozen(failed.technicalFailureRecord), true);
  assert.equal(Object.isFrozen(failed.technicalFailureRecord.auditEvent), true);
  const replay = recordC2SoftwareTechnicalFailure({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    failure: {
      layer: "asset_manifest_storage",
      failureClass: "persistence_failure",
      code: "WRITE_FAILED",
      evidenceRef: "evidence:c2:write-failed"
    },
    failedAt: LATER
  });
  assert.deepEqual(replay.technicalFailureRecord, failed.technicalFailureRecord);
  assert.deepEqual(replay.skuPackage, initialized.skuPackage);

  assert.throws(() => recordC2SoftwareTechnicalFailure({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    failure: {
      layer: "asset_manifest_storage",
      failureClass: "persistence_failure",
      code: "WRITE_FAILED",
      evidenceRef: "evidence:c2:write-failed",
      message: "底层错误可能包含秘密"
    },
    failedAt: LATER
  }), /FAILURE_INVALID/);

  for (const evidenceRef of [
    "https://evidence.example/item?token=secret",
    "https://user:pass@evidence.example/item",
    "Bearer secret",
    `Bearer ${"secret".repeat(64)}`
  ]) {
    assert.throws(() => recordC2SoftwareTechnicalFailure({
      skuPackage: initialized.skuPackage,
      expectedDataRevision: 8,
      failure: {
        layer: "asset_manifest_storage",
        failureClass: "persistence_failure",
        code: "WRITE_FAILED",
        evidenceRef
      },
      failedAt: LATER
    }), /SECRET_REJECTED/);
  }
  for (const evidenceRef of ["evidence ref", "证据:write-failed", "evidence%3Awrite-failed"]) {
    const inputBefore = structuredClone(initialized.skuPackage);
    assert.throws(() => recordC2SoftwareTechnicalFailure({
      skuPackage: initialized.skuPackage,
      expectedDataRevision: 8,
      failure: {
        layer: "asset_manifest_storage",
        failureClass: "persistence_failure",
        code: "WRITE_FAILED",
        evidenceRef
      },
      failedAt: LATER
    }), /C2_REFERENCE_REJECTED_NONCANONICAL/);
    assert.deepEqual(initialized.skuPackage, inputBefore, evidenceRef);
  }
  assert.throws(() => recordC2SoftwareTechnicalFailure({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    failure: {
      layer: "asset_manifest_storage",
      failureClass: "persistence_failure",
      code: "WRITE_FAILED",
      evidenceRef: `evidence:${"x".repeat(257)}`
    },
    failedAt: LATER
  }), /FAILURE_INVALID/);

  const downstream = structuredClone(initialized.skuPackage);
  downstream.productionAuthorization = { status: "existing" };
  assert.throws(() => recordC2SoftwareTechnicalFailure({
    skuPackage: downstream,
    expectedDataRevision: 8,
    failure: {
      layer: "asset_manifest_storage",
      failureClass: "persistence_failure",
      code: "WRITE_FAILED",
      evidenceRef: "evidence:c2:write-failed"
    },
    failedAt: LATER
  }), /DOWNSTREAM_STATE_CONFLICT/);
});

test("C2软件路径零外部访问、零派发、零图片生成", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("C2不应访问网络");
  };
  try {
    const result = createC2SoftwareContainer({
      skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
    });
    assert.equal(calls, 0);
    assert.equal(result.c2AssetLifecycle.softwareState.executionPolicy.codexDispatchAllowed, false);
    assert.equal(result.c2AssetLifecycle.softwareState.executionPolicy.imageGenerationAllowed, false);
    assert.equal(result.c2AssetLifecycle.softwareState.executionPolicy.productionAllowed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("C2与PA执行模块共享唯一中性preparation合同实现", async () => {
  const c2Source = await readFile(new URL("../lib/c2-asset-lifecycle.mjs", import.meta.url), "utf8");
  const preparationSource = await readFile(
    new URL("../lib/production-authorization-preparation.mjs", import.meta.url),
    "utf8"
  );
  const lifecycleSource = await readFile(new URL("../lib/product-lifecycle-schema.mjs", import.meta.url), "utf8");
  const primitivesSource = await readFile(
    new URL("../lib/production-contract-primitives.mjs", import.meta.url),
    "utf8"
  );
  const productionAuthorizationSource = await readFile(
    new URL("../lib/production-authorization.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(c2Source, /from "\.\/production-authorization\.mjs"/);
  assert.match(c2Source, /from "\.\/production-authorization-preparation\.mjs"/);
  assert.match(c2Source, /from "\.\/production-contract-primitives\.mjs"/);
  assert.doesNotMatch(preparationSource, /from "\.\/product-lifecycle-schema\.mjs"/);
  assert.match(preparationSource, /from "\.\/production-contract-primitives\.mjs"/);
  assert.match(lifecycleSource, /from "\.\/production-authorization-preparation\.mjs"/);
  assert.doesNotMatch(primitivesSource, /from "\.\/(?:product-lifecycle-schema|production-authorization-preparation|production-authorization|c2-asset-lifecycle)\.mjs"/);
  assert.match(
    productionAuthorizationSource,
    /from "\.\/production-authorization-preparation\.mjs"/
  );
  assert.strictEqual(
    validatePreparationViaProductionAuthorization,
    validateProductionAuthorizationPreparation
  );
  assert.strictEqual(
    fingerprintPreparationViaProductionAuthorization,
    fingerprintProductionAuthorizationPreparation
  );
  assert.strictEqual(
    validateC2ProductionAuthorizationPreparationRecord,
    validateProductionAuthorizationPreparation
  );
  assert.equal(
    [preparationSource, lifecycleSource].filter((source) =>
      /export function validateProductionAuthorizationPreparation\s*\(/.test(source)).length,
    1
  );
  assert.equal(
    [primitivesSource, preparationSource, lifecycleSource, c2Source, productionAuthorizationSource]
      .filter((source) => /export function fingerprintCanonicalRecord\s*\(/.test(source)).length,
    1
  );
  assert.equal(
    [primitivesSource, preparationSource, lifecycleSource, c2Source, productionAuthorizationSource]
      .filter((source) => /export function assertNoProductionSecrets\s*\(/.test(source)).length,
    1
  );
});

test("canonicalFrozenRef Schema与唯一运行时边界对长度、秘密和合法近似值同判", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  const safeFrozenRefSchema = schema.$defs.canonicalFrozenRef;
  assert.equal(safeFrozenRefSchema.maxLength, SAFE_FROZEN_REF_MAX_LENGTH);
  assert.equal(safeFrozenRefSchema.pattern, SAFE_FROZEN_REF_PATTERN_SOURCE);

  const legalValues = [
    "a", "a".repeat(256), "candidate:user@example.com", "tokenizer-service", "secretless-build",
    "api-keyboard:sku", "credentialAlias:ozon", "authorizationId:record-1", "cookieCutter:tool"
  ];
  const unsafeValues = [
    "", "a".repeat(257), "a".repeat(20_000), "a".repeat(40_000),
    "商品证据ref", "https://provider.example/path/user@example.com", "https%3A%2F%2Fprovider.example%2Fpath",
    "authorization=required", "token:none", "a?b", "a&b", "a=b", "a\\b", "a//b",
    "token=abc", "authorization:abc", "bearer=abc", "basic=abc", "client-secret=abc",
    "safe/token:abc", "safe/authorization:abc", "safe/cookie:abc", "safe:token:abc",
    "https://user:pass@provider.example/id", "https://provider.example/id?token=abc",
    "https%3A%2F%2Fuser%3Apass%40provider.example%2Fid",
    "ftp%3A%2F%2Fuser%3Apass%40provider.example%2Fid", "//user:pass@provider.example/id",
    "prefix%20https%3A%2F%2Fuser%40provider.example%2Ffile",
    "prefix%20%2F%2Fuser%40provider.example%2Ffile",
    "https://provider.example/id?%74oken=abc", "Bearer%20abc123", "note%3ABearer%20abc123",
    "%ZZ%3Fauthorization%3Dabc", "%E0%A4%A%3Ftoken%3Dabc", "%2%3Fcookie%3Dabc",
    "%ZZ-token%3Dabc", "%ZZBearer%20abc123", "%ZZBasic%20abc123", "%ZZnote%3ABearer",
    "%ZZ%2F%2Fuser%3Apass%40provider.example%2Ffile",
    "line\nbreak", "safe-ref\n", "tab\tvalue", "nul\u0000value"
  ];
  for (const value of legalValues) {
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), true, value);
    assert.equal(isSafeFrozenRef(value), true, value);
    assert.equal(assertSafeFrozenRef(value), value);
  }
  for (const value of unsafeValues) {
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, value.slice(0, 80));
    assert.equal(isSafeFrozenRef(value), false, value.slice(0, 80));
    assert.throws(() => assertSafeFrozenRef(value), /C2_REFERENCE_REJECTED_NONCANONICAL/);
  }
  for (const key of ["authorization", "bearer", "basic", "cookie", "secret", "token", "credentials"]) {
    const unsafeUrl = `https://provider.example/id?${key}=abc`;
    for (let depth = 1; depth <= 3; depth += 1) {
      const value = percentEncode(unsafeUrl, depth);
      assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, `${key}:${depth}`);
      assert.equal(isSafeFrozenRef(value), false, `${key}:${depth}`);
      assert.throws(() => assertSafeFrozenRef(value), /C2_REFERENCE_REJECTED_NONCANONICAL/);
    }
  }

  const encodedContainerInput = packageFixture();
  encodedContainerInput.g1Identity.storeRef.platformStoreId = percentEncode(
    "https://provider.example/id?authorization=abc",
    3
  );
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: encodedContainerInput,
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    createdAt: NOW
  }), /G1_IDENTITY_REQUIRED|SAFE_FROZEN_REF_INVALID|SECRET_REJECTED/);
  assert.equal(encodedContainerInput.c2FinalAssets, null);
  assert.equal(encodedContainerInput.productionAuthorization, null);
  assert.equal(encodedContainerInput.productionRecord, null);

  const malformedPercentContainerInput = packageFixture();
  malformedPercentContainerInput.g1Identity.storeRef.platformStoreId = "%ZZ%3Fauthorization%3Dabc";
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: malformedPercentContainerInput,
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    createdAt: NOW
  }), /G1_IDENTITY_REQUIRED|SAFE_FROZEN_REF_INVALID|SECRET_REJECTED/);
  assert.equal(malformedPercentContainerInput.c2FinalAssets, null);
  assert.equal(malformedPercentContainerInput.productionAuthorization, null);
  assert.equal(malformedPercentContainerInput.productionRecord, null);

  const oversizedIdentity = packageFixture();
  oversizedIdentity.g1Identity.candidateId = "x".repeat(257);
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: oversizedIdentity,
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    createdAt: NOW
  }), /C2_REFERENCE_REJECTED_NONCANONICAL/);
});

test("canonicalFrozenRef对多层整体编码URL authority与认证标签保持Schema运行时同判", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  const safeFrozenRefSchema = schema.$defs.canonicalFrozenRef;
  const assertParity = (value, expected, label) => {
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), expected, `${label}:schema`);
    assert.equal(isSafeFrozenRef(value), expected, `${label}:runtime`);
    if (expected) assert.equal(assertSafeFrozenRef(value), value, `${label}:assert`);
    else assert.throws(() => assertSafeFrozenRef(value), /C2_REFERENCE_REJECTED_NONCANONICAL/, `${label}:assert`);
  };

  for (const [value, expected] of [
    ["https://provider.example/path/user@example.com", true],
    ["https://provider.example/?contact=user@example.com", true],
    ["https://provider.example/#contact=user@example.com", true],
    ["https://user:pass@provider.example/path", false],
    ["//user:pass@provider.example/path", false]
  ]) {
    for (let depth = 1; depth <= 3; depth += 1) {
      assertParity(percentEncode(value, depth), false, `noncanonical-authority:${depth}:${value}:${expected}`);
    }
  }
  for (let depth = 1; depth <= 3; depth += 1) {
    const encodedSlash = percentEncode("/", depth);
    const encodedQuery = percentEncode("?", depth);
    const encodedHash = percentEncode("#", depth);
    const encodedEquals = percentEncode("=", depth);
    const encodedAt = percentEncode("@", depth);
    for (const value of [
      `https://provider.example${encodedSlash}path${encodedSlash}user${encodedAt}example.com`,
      `https://provider.example${encodedQuery}contact${encodedEquals}user${encodedAt}example.com`,
      `https://provider.example${encodedHash}contact${encodedEquals}user${encodedAt}example.com`
    ]) assertParity(value, false, `noncanonical-delimiter:${depth}:${value}`);
  }

  for (const label of ["Bearer", "Basic"]) {
    const payload = `${label} credential123`;
    for (let depth = 1; depth <= 3; depth += 1) {
      const wholeEncoded = percentEncode(payload, depth);
      assertParity(wholeEncoded, false, `authorization:${label}:${depth}`);
      assert.throws(() => assertNoProductionSecrets({ note: wholeEncoded }), /SECRET_REJECTED/);
    }
    const partiallyEncoded = `%${label.charCodeAt(0).toString(16)}${label.slice(1)}%20%63redential123`;
    assertParity(partiallyEncoded, false, `authorization:${label}:partial`);
    assert.throws(() => assertNoProductionSecrets({ note: partiallyEncoded }), /SECRET_REJECTED/);
  }
  for (const malformedPrefixedSecret of [
    "%G%74%6F%6B%65%6E%3Dabc", "%G1%74%6F%6B%65%6E%3Dabc", "%ZZ-token%3Dabc",
    "%ZZBearer%20abc123", "%ZZ%2F%2Fuser%3Apass%40example.test%2Fa",
    "%Gtoken%3Dabc", "%Gauthorization%3Dabc", "%Gbearer%20abc123", "%Gnote%3ABearer"
  ]) {
    assertParity(malformedPrefixedSecret, false, `malformed:${malformedPrefixedSecret}`);
    assert.throws(() => assertNoProductionSecrets({ note: malformedPrefixedSecret }), /SECRET_REJECTED/);
  }
});

test("任何percent编码在canonical引用门、容器与准备对象均fail-closed", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  const safeFrozenRefSchema = schema.$defs.canonicalFrozenRef;
  const depthFourValues = [
    percentEncode("https://provider.example/id?token=abc", PERCENT_ENCODING_MAX_DECODE_DEPTH + 1),
    percentEncode("https://provider.example/id?authorization=abc", PERCENT_ENCODING_MAX_DECODE_DEPTH + 1),
    percentEncode("token=abc", PERCENT_ENCODING_MAX_DECODE_DEPTH + 1),
    percentEncode("Bearer credential123", PERCENT_ENCODING_MAX_DECODE_DEPTH + 1),
    percentEncode("Basic credential123", PERCENT_ENCODING_MAX_DECODE_DEPTH + 1),
    percentEncode("note:Bearer credential123", PERCENT_ENCODING_MAX_DECODE_DEPTH + 1),
    "%74%6F%6B%65%6E%25%32%35%32%35%32%35%33%44%61%62%63"
  ];
  const allowedAtDepthThree = percentEncode(
    "https://provider.example/id?contact=user@example.com",
    PERCENT_ENCODING_MAX_DECODE_DEPTH
  );
  assert.equal(hasPercentEncodingBeyondDecodeDepth(allowedAtDepthThree), false);
  assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, allowedAtDepthThree), false);
  assert.equal(isSafeFrozenRef(allowedAtDepthThree), false);

  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });

  for (const value of depthFourValues) {
    assert.equal(hasPercentEncodingBeyondDecodeDepth(value), true, value);
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, value);
    assert.equal(isSafeFrozenRef(value), false, value);
    assert.throws(() => assertSafeFrozenRef(value), /C2_REFERENCE_REJECTED_NONCANONICAL/);
    assert.throws(() => assertNoProductionSecrets({ note: value }), /SECRET_REJECTED/);

    const containerInput = packageFixture();
    containerInput.g1Identity.storeRef.platformStoreId = value;
    assert.throws(() => createC2SoftwareContainer({
      skuPackage: containerInput, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
    }), /G1_IDENTITY_REQUIRED|SAFE_FROZEN_REF_INVALID|SECRET_REJECTED/);
    assert.equal(containerInput.c2FinalAssets, null);
    assert.equal(containerInput.productionAuthorization, null);
    assert.equal(containerInput.productionRecord, null);

    const stored = structuredClone(confirmed.skuPackage);
    const preparation = stored.c2FinalAssets.productionAuthorizationPreparation;
    preparation.finalUploads[0].assetRef = value;
    stored.c2FinalAssets.assets.finalUploads = structuredClone(preparation.finalUploads);
    preparation.finalUploadsFingerprint = fingerprintFinalUploads(preparation.finalUploads);
    preparation.finalManifestSha256 = fingerprintFinalManifest({
      authorizedMediaFingerprint: preparation.authorizedMediaFingerprint,
      effectiveVideoRequirement: preparation.effectiveVideoRequirement,
      mainImageAssetId: preparation.mainImageAssetId,
      videoDisposition: preparation.videoDisposition,
      assets: preparation.finalUploads
    });
    preparation.ownerFinalUploadConfirmation.approvedManifestSha256 = preparation.finalManifestSha256;
    stored.c2FinalAssets.ownerFinalUploadConfirmation = structuredClone(preparation.ownerFinalUploadConfirmation);
    preparation.preparationFingerprint = fingerprintC2AuthorizationPreparation(preparation);
    assert.throws(() => validateProductionAuthorizationPreparation({
      preparation,
      candidateId: stored.g1Identity.candidateId,
      skuPackage: stored
    }), /PRODUCTION_AUTHORIZATION_SECRET_REJECTED|C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED/);
    assert.equal(stored.productionAuthorization, null);
    assert.equal(stored.productionRecord, null);
    assert.equal(stored.c2FinalAssets.platformUploads, 0);
    assert.equal(stored.c2FinalAssets.productionStarted, false);
  }
});

test("嵌套赋值在公共门、容器与准备对象中逐边界拒绝", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  const safeFrozenRefSchema = schema.$defs.canonicalFrozenRef;
  const mixedEncodedUnsafe = [
    "x%3Dtoken%3Dabc",
    "foo%3Aauthorization%3Dabc",
    "https%3A%2F%2Fx.test%2F%3Fx%3Dtoken%3Dabc",
    "%2Dtoken%3Dabc",
    "-%2Dtoken%3Dabc",
    "_%2Dtoken%3Dabc",
    "%5F%2Dtoken%3Dabc",
    "%2D%2Dtoken%3Dabc",
    "x%3A%2Dtoken%3Dabc",
    "x%3B%2Dtoken%3Dabc",
    "x(%2Dtoken%3Dabc",
    "%3F_token%3Dx",
    "%25_token%3Dx"
  ].flatMap((value) => [
    value,
    percentEncode(value, 1),
    percentEncode(value, 2),
    encodePercentTripletsBytewise(value),
    percentEncode(encodePercentTripletsBytewise(value), 1)
  ]);
  const nestedAssignments = [
    "x=token=abc",
    "foo:authorization=abc",
    "https://x.test/?x=token=abc",
    "https://provider.example/redirect?next=https://x.test/?token=abc",
    percentEncode("https://provider.example/redirect?next=https://x.test/?token=abc", 3),
    "safe%3Dok%3Btoken%3Dabc",
    "x=token=none=abc",
    "x=authorization=required=abc",
    "token=required=abc",
    "authorization=none=abc",
    "token=",
    "authorization:",
    "safe=ok&token=",
    percentEncode("x=token=none=abc", 3),
    "%25253Dtoken%3Dx",
    "%25%25253Dtoken%3Dx",
    ...mixedEncodedUnsafe
  ];
  for (const legal of [
    "x=token=none", "foo:authorization=required", "authorization=required&product=wood",
    "token:none&version=1", "https://x.test/?x=tokenizer=tool", "%5Ftoken%3Dabc",
    ...["-", "/", ";"].flatMap((separator) =>
      Array.from({ length: PERCENT_ENCODING_MAX_DECODE_DEPTH }, (_unused, index) =>
        `token=none${percentEncode(separator, index + 1)}label`
      )
    )
  ]) {
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, legal), false, legal);
    assert.equal(isSafeFrozenRef(legal), false, legal);
    assert.doesNotThrow(() => assertNoProductionSecrets({ note: legal }));
  }

  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });

  for (const value of nestedAssignments) {
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, value);
    assert.equal(isSafeFrozenRef(value), false, value);
    assert.throws(() => assertSafeFrozenRef(value), /C2_REFERENCE_REJECTED_NONCANONICAL/);
    assert.throws(() => assertNoProductionSecrets({ note: value }), /SECRET_REJECTED/);

    const containerInput = packageFixture();
    containerInput.g1Identity.storeRef.platformStoreId = value;
    assert.throws(() => createC2SoftwareContainer({
      skuPackage: containerInput, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
    }), /G1_IDENTITY_REQUIRED|SAFE_FROZEN_REF_INVALID|SECRET_REJECTED/);
    assert.equal(containerInput.c2FinalAssets, null);
    assert.equal(containerInput.productionAuthorization, null);
    assert.equal(containerInput.productionRecord, null);

    const stored = structuredClone(confirmed.skuPackage);
    const preparation = stored.c2FinalAssets.productionAuthorizationPreparation;
    preparation.finalUploads[0].assetRef = value;
    stored.c2FinalAssets.assets.finalUploads = structuredClone(preparation.finalUploads);
    preparation.finalUploadsFingerprint = fingerprintFinalUploads(preparation.finalUploads);
    preparation.finalManifestSha256 = fingerprintFinalManifest({
      authorizedMediaFingerprint: preparation.authorizedMediaFingerprint,
      effectiveVideoRequirement: preparation.effectiveVideoRequirement,
      mainImageAssetId: preparation.mainImageAssetId,
      videoDisposition: preparation.videoDisposition,
      assets: preparation.finalUploads
    });
    preparation.ownerFinalUploadConfirmation.approvedManifestSha256 = preparation.finalManifestSha256;
    stored.c2FinalAssets.ownerFinalUploadConfirmation = structuredClone(preparation.ownerFinalUploadConfirmation);
    preparation.preparationFingerprint = fingerprintC2AuthorizationPreparation(preparation);
    assert.throws(() => validateProductionAuthorizationPreparation({
      preparation,
      candidateId: stored.g1Identity.candidateId,
      skuPackage: stored
    }), /PRODUCTION_AUTHORIZATION_SECRET_REJECTED|C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED/);
    assert.equal(stored.productionAuthorization, null);
    assert.equal(stored.productionRecord, null);
    assert.equal(stored.c2FinalAssets.platformUploads, 0);
    assert.equal(stored.c2FinalAssets.productionStarted, false);
  }
  for (const raw of ["x=token=none=abc", "x=authorization=required=abc", "token=required=abc", "authorization=none=abc"]) {
    for (let depth = 1; depth <= 3; depth += 1) {
      const value = percentEncode(raw, depth);
      assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, `${raw}:${depth}:schema`);
      assert.equal(isSafeFrozenRef(value), false, `${raw}:${depth}:runtime`);
      assert.throws(() => assertNoProductionSecrets({ note: value }), /SECRET_REJECTED/, `${raw}:${depth}:secret`);
    }
  }
});

test("mixed percent projections keep helper, C2 Schema and runtime on one bounded boundary", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  const safeFrozenRefSchema = schema.$defs.canonicalFrozenRef;
  const projections = (value) => [
    value,
    percentEncode(value, 1),
    percentEncode(value, 2),
    encodePercentTripletsBytewise(value),
    percentEncode(encodePercentTripletsBytewise(value), 1)
  ];
  const unsafe = [
    "x%3Dtoken%3Dabc",
    "foo%3Aauthorization%3Dabc",
    "https%3A%2F%2Fx.test%2F%3Fx%3Dtoken%3Dabc",
    "%3F_token%3Dx",
    "?/_token=x",
    "%3F%2F_token%3Dx",
    "x?/_token=abc",
    "x?%2F_token%3Dabc",
    "%25_token%3Dx",
    "safe=ok&token=required",
    "safe=ok&authorization=required",
    encodePercentTripletsBytewise(encodeEveryCharacter("token=abc")),
    encodePercentTripletsBytewise(encodeEveryCharacter("authorization=abc"))
  ];
  const bytewiseDepthFour = encodePercentTripletsBytewise(
    encodePercentTripletsBytewise(encodePercentTripletsBytewise("x%3Dtoken%3Dabc"))
  );
  const legal = [
    "x-token%3Dx",
    "x%2Dtoken%3Dx",
    "x-%2Dtoken%3Dx",
    "x_%2Dtoken%3Dx",
    "token=none%2Dlabel",
    "token=required%2Flabel",
    "token=not_required%3Blabel",
    "token=not-applicable%2Dlabel"
  ];
  for (const value of unsafe.flatMap(projections)) {
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, `${value}:schema`);
    assert.equal(isSafeFrozenRef(value), false, `${value}:runtime`);
    assert.throws(() => assertNoProductionSecrets({ note: value }), /SECRET_REJECTED/, `${value}:secret`);
  }
  assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, bytewiseDepthFour), false, "bytewise-depth4:schema");
  assert.equal(isSafeFrozenRef(bytewiseDepthFour), false, "bytewise-depth4:runtime");
  assert.throws(() => assertNoProductionSecrets({ note: bytewiseDepthFour }), /SECRET_REJECTED/, "bytewise-depth4:secret");
  for (const value of legal.flatMap(projections)) {
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, `${value}:schema`);
    assert.equal(isSafeFrozenRef(value), false, `${value}:runtime`);
    assert.doesNotThrow(() => assertNoProductionSecrets({ note: value }), `${value}:secret`);
  }
  for (const value of [
    encodePercentTripletsBytewise(encodeEveryCharacter("tokenizer=tool")),
    percentEncode(encodePercentTripletsBytewise(encodeEveryCharacter("tokenizer=tool")), 1)
  ]) {
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, `${value}:schema`);
    assert.equal(isSafeFrozenRef(value), false, `${value}:runtime`);
    assert.doesNotThrow(() => assertNoProductionSecrets({ note: value }), `${value}:secret`);
  }
  const hyphenPrefixes = ["", ...Array.from({ length: 95 }, (_unused, index) => String.fromCharCode(index + 32))];
  for (const prefix of hyphenPrefixes) {
    for (let depth = 0; depth < PERCENT_ENCODING_MAX_DECODE_DEPTH; depth += 1) {
      const value = percentEncode(`${prefix}%2Dtoken%3Dabc`, depth);
      const secretSafe = (() => {
        try { assertNoProductionSecrets({ note: value }); return true; } catch { return false; }
      })();
      assert.equal(isSafeFrozenRef(value), false, `${value}:hyphen-runtime`);
      assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, `${value}:hyphen-schema`);
      if (secretSafe) assert.doesNotThrow(() => assertNoProductionSecrets({ note: value }), `${value}:hyphen-secret`);
      else assert.throws(() => assertNoProductionSecrets({ note: value }), /SECRET_REJECTED/, `${value}:hyphen-secret`);
    }
  }
});

test("safe assignment普通文本矩阵通过公共secret helper但不成为canonical引用", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  const safeFrozenRefSchema = schema.$defs.canonicalFrozenRef;
  const safeStatuses = ["none", "required", "not_required", "not-applicable"];
  const encodedSeparators = ["%2F", "%3B", "%2D"];
  const safeAssignmentTextValues = safeStatuses.flatMap((status) =>
    encodedSeparators.flatMap((separator) => [
      `token=${status}${separator}label`,
      `authorization=${status}${separator}label`
    ]));
  const projections = (value) => [
    value,
    percentEncode(value, 1),
    percentEncode(value, 2),
    encodePercentTripletsBytewise(value),
    percentEncode(encodePercentTripletsBytewise(value), 1)
  ];

  for (const value of safeAssignmentTextValues.flatMap(projections)) {
    assert.doesNotThrow(() => assertNoProductionSecrets({ note: value }), `${value}:secret-helper`);
    assert.equal(publishedStringConstraintAccepts(schema, safeFrozenRefSchema, value), false, `${value}:schema-ref`);
    assert.equal(isSafeFrozenRef(value), false, `${value}:runtime-ref`);
  }

  for (const prefixUnit of ["?", "%3F"]) {
    const medians = [];
    for (const size of [20_000, 40_000]) {
      const value = `${prefixUnit.repeat(size)}token=abc`;
      const durationsMs = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const start = process.hrtime.bigint();
        assert.throws(() => assertNoProductionSecrets({ note: value }), /SECRET_REJECTED/, `${prefixUnit}:${size}:secret`);
        durationsMs.push(Number(process.hrtime.bigint() - start) / 1_000_000);
      }
      durationsMs.sort((left, right) => left - right);
      const medianMs = durationsMs[1];
      assert.ok(medianMs < 1_000, `secret scanner remained bounded for ${prefixUnit}:${size} in ${medianMs}ms`);
      medians.push(medianMs);
    }
    assert.ok(
      medians[1] < medians[0] * 4 + 20,
      `secret scanner ${prefixUnit} 40k/20k growth was ${medians[1].toFixed(3)}/${medians[0].toFixed(3)}ms`
    );
  }
});

test("canonical C2引用由公共原语和两份Schema生成器逐字同源", async () => {
  const [lifecycleSchema, inputSchema] = await Promise.all([
    readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../schema/c2-software-input-v1.schema.json", import.meta.url), "utf8").then(JSON.parse)
  ]);
  assert.equal(lifecycleSchema.$id, "c2-asset-lifecycle-v1.1");
  assert.equal(inputSchema.$id, "c2-software-input-v1");
  for (const schema of [lifecycleSchema, inputSchema]) {
    const expectedReferenceDefs = schema.$id === lifecycleSchema.$id
      ? C2_ASSET_LIFECYCLE_REFERENCE_SCHEMA_DEFS
      : schema.$id === inputSchema.$id
        ? C2_REFERENCE_SCHEMA_DEFS
        : assert.fail(`unexpected schema id: ${schema.$id}`);
    assert.deepEqual(schema.$defs.canonicalFrozenRef, expectedReferenceDefs.canonicalFrozenRef);
    assert.deepEqual(schema.$defs.canonicalStableHttpsAssetRef, expectedReferenceDefs.canonicalStableHttpsAssetRef);
    assert.deepEqual(schema.$defs.analysisAssetRef, expectedReferenceDefs.analysisAssetRef);
    assert.deepEqual(schema.$defs.c1OpaqueAuthorizationId, expectedReferenceDefs.c1OpaqueAuthorizationId);
    const generatedSchema = generateC2ReferenceSchema(schema);
    assert.deepEqual(generatedSchema, schema);
  }
  for (const unsupportedSchema of [
    {},
    { $id: null },
    { $id: "unknown-c2-reference-schema" },
    { $id: `prefix-${lifecycleSchema.$id}-suffix` },
    { $id: `https://example.com/schemas/${lifecycleSchema.$id}.schema.json` },
    { $id: `https://example.com/schemas/${inputSchema.$id}.schema.json` }
  ]) {
    assert.throws(() => generateC2ReferenceSchema(unsupportedSchema), /C2_REFERENCE_SCHEMA_UNSUPPORTED_SCHEMA_ID/);
  }
  assert.throws(() => generateC2ReferenceSchema({
    $id: lifecycleSchema.$id,
    $defs: {}
  }), /C2_REFERENCE_SCHEMA_SEMANTIC_PATH_MISSING/);
  assert.throws(() => generateC2ReferenceSchema({
    $id: inputSchema.$id,
    $defs: { paidAuthorizationRef: { type: "object", properties: {} } }
  }), /C2_REFERENCE_SCHEMA_SEMANTIC_PATH_MISSING/);
  const missingMode = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/generate-c2-reference-schema.mjs", import.meta.url))
  ], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(missingMode.status, 0);
  assert.match(missingMode.stderr, /C2_REFERENCE_SCHEMA_MODE_REQUIRED/);
  const bothModes = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/generate-c2-reference-schema.mjs", import.meta.url)),
    "--check",
    "--write"
  ], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(bothModes.status, 0);
  assert.match(bothModes.stderr, /C2_REFERENCE_SCHEMA_MODE_REQUIRED/);
  for (const schema of [lifecycleSchema, inputSchema]) {
    assert.equal(schema.$defs.collectedAsset.properties.assetRef.$ref, "#/$defs/analysisAssetRef");
    assert.equal(schema.$defs.aiDraftAsset.properties.assetRef.$ref, "#/$defs/analysisAssetRef");
  }
  const finalLocationSchema = { oneOf: [
    { $ref: "#/$defs/canonicalStableHttpsAssetRef" },
    { type: "string", pattern: LOCAL_FINAL_ASSET_REF_PATTERN_SOURCE }
  ] };
  assert.deepEqual(lifecycleSchema.$defs.finalAsset.properties.assetRef, finalLocationSchema);
  const semanticMappingProbe = generateC2ReferenceSchema({
    $id: inputSchema.$id,
    $defs: {
      paidAuthorizationRef: { type: "object", properties: { authorizationId: { type: "string" } } },
      detailedMediaRequirements: { type: "object", properties: {} },
      collectedAsset: { type: "object", properties: { assetRef: { type: "string" } } },
      finalAsset: { type: "object", properties: { assetRef: { type: "string" } } }
    },
    type: "object",
    properties: { unrelated: { type: "object", properties: { assetRef: { type: "string" } } } }
  });
  assert.equal(semanticMappingProbe.$defs.collectedAsset.properties.assetRef.$ref, "#/$defs/analysisAssetRef");
  assert.deepEqual(semanticMappingProbe.$defs.finalAsset.properties.assetRef, finalLocationSchema);
  assert.equal(semanticMappingProbe.$defs.paidAuthorizationRef.properties.authorizationId.$ref, "#/$defs/c1OpaqueAuthorizationId");
  assert.deepEqual(semanticMappingProbe.properties.unrelated.properties.assetRef, { type: "string" });
  const noFieldNameGuessProbe = generateC2ReferenceSchema({
    $id: inputSchema.$id,
    $defs: {
      paidAuthorizationRef: { type: "object", properties: { authorizationId: { type: "string" } } },
      detailedMediaRequirements: { type: "object", properties: {} },
      referenceValue: { oneOf: [{ $ref: "#/$defs/c2SecretCheckedContractString" }, { type: "null" }] }
    },
    type: "object",
    properties: {
      unrelated: {
        type: "object",
        properties: {
          authorizationId: { type: "string" },
          sourceRef: { type: "string" },
          arbitraryRef: { type: "string" }
        }
      }
    }
  });
  assert.equal(noFieldNameGuessProbe.$defs.referenceValue.oneOf[0].$ref, "#/$defs/c2SecretCheckedContractString");
  assert.deepEqual(noFieldNameGuessProbe.properties.unrelated.properties.authorizationId, { type: "string" });
  assert.deepEqual(noFieldNameGuessProbe.properties.unrelated.properties.sourceRef, { type: "string" });
  assert.deepEqual(noFieldNameGuessProbe.properties.unrelated.properties.arbitraryRef, { type: "string" });
  assert.deepEqual(
    C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.schemaPaths.c2SoftwareInput,
    [["$defs", "paidAuthorizationRef", "properties", "authorizationId"]]
  );
  assert.equal(lifecycleSchema.$defs.canonicalFrozenRef.pattern, CANONICAL_FROZEN_REF_PATTERN_SOURCE);
  assert.equal(inputSchema.$defs.canonicalFrozenRef.pattern, C2_SOFTWARE_INPUT_CANONICAL_FROZEN_REF_PATTERN_SOURCE);
  assert.equal(
    lifecycleSchema.$defs.canonicalStableHttpsAssetRef.pattern,
    CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE
  );
  assert.equal(
    lifecycleSchema.$defs.canonicalStableHttpsAssetRef.allOf[0].not.pattern,
    CANONICAL_STABLE_HTTPS_ASSET_REF_LOCAL_HOST_PATTERN_SOURCE
  );
  assert.equal(
    inputSchema.$defs.canonicalStableHttpsAssetRef.pattern,
    C2_SOFTWARE_INPUT_CANONICAL_STABLE_HTTPS_ASSET_REF_PATTERN_SOURCE
  );

  const frozenAllowedCharacters = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~:/@#+-");
  for (let code = 0; code <= 127; code += 1) {
    const character = String.fromCharCode(code);
    const value = `a${character}b`;
    const expected = frozenAllowedCharacters.has(character);
    assert.equal(isCanonicalFrozenRef(value), expected, `ascii:${code}:runtime`);
    assert.equal(
      publishedStringConstraintAccepts(lifecycleSchema, lifecycleSchema.$defs.canonicalFrozenRef, value),
      expected,
      `ascii:${code}:schema`
    );
  }
  for (const value of ["candidate:A", "a".repeat(256), "tokenizer:tool", "secretless:design", "credentialAlias:ozon"]) {
    assert.equal(assertCanonicalFrozenRef(value), value);
  }
  for (const value of [
    "", "a".repeat(257), "商品ref", "a%20b", "a?b", "a&b", "a=b", "a\\b", "a//b",
    "token:abc", "secret:abc", "authorization:abc", "Bearer-secret"
  ]) assert.throws(() => assertCanonicalFrozenRef(value), /C2_REFERENCE_REJECTED_NONCANONICAL/, value);
  assert.equal(assertCanonicalC1AuthorizationId("authorization:c1-ai-draft:SHELF-WHITE"), "authorization:c1-ai-draft:SHELF-WHITE");
  assert.equal(isCanonicalC1AuthorizationId("authorization:c1-ai-draft:token"), false);

  const shortStableUrl = "https://assets.example.com/owner/main.jpg";
  const maxStableUrl = `https://assets.example.com/${"a".repeat(
    CANONICAL_STABLE_HTTPS_ASSET_REF_MAX_LENGTH - "https://assets.example.com/".length
  )}`;
  const stableAllowed = [
    shortStableUrl,
    maxStableUrl,
    "https://assets.example.com/path/user@example.com",
    "https://assets.example.com/path?tokenizer=tool&secretless=design&credentialAlias=ozon",
    "https://assets.example.com/path?version=1&sigmoid=curve&locale=ru"
  ];
  const stableRejected = [
    `${maxStableUrl}a`, "http://assets.example.com/path", "HTTPS://assets.example.com/path",
    "https://Assets.example.com/path", "https://assets.example.com", "https://user:pass@assets.example.com/path",
    "https://127.0.0.1/path", "https://[::1]/path", "https://localhost/path",
    "https://foo.localhost/path", "https://a.b.localhost/path", "https://assets.local/path",
    "https://assets.example.com/a%20b", "https://assets.example.com/a#fragment",
    "https://assets.example.com/../secret", "https://assets.example.com/a\\b",
    "https://assets.example.com/a//b", "https://assets.example.com/a?token=abc",
    "https://assets.example.com/a?client_secret=abc",
    ...CANONICAL_CLOUD_CREDENTIAL_QUERY_KEYS.map((key) => `https://assets.example.com/a?${key}=abc`),
    "https://assets.example.com/a?expires=1", "https://assets.example.com/a?empty="
  ];
  for (const value of stableAllowed) {
    assert.equal(assertCanonicalStableHttpsAssetRef(value), value);
    for (const schema of [lifecycleSchema, inputSchema]) {
      assert.equal(publishedStringConstraintAccepts(schema, schema.$defs.canonicalStableHttpsAssetRef, value), true, value);
    }
  }
  for (const value of stableRejected) {
    assert.throws(() => assertCanonicalStableHttpsAssetRef(value), /C2_REFERENCE_REJECTED_NONCANONICAL/, value);
    for (const schema of [lifecycleSchema, inputSchema]) {
      assert.equal(publishedStringConstraintAccepts(schema, schema.$defs.canonicalStableHttpsAssetRef, value), false, value);
    }
  }
  for (const value of LIFECYCLE_LOCAL_FINAL_URLS) {
    assert.equal(
      publishedStringConstraintAccepts(lifecycleSchema, lifecycleSchema.$defs.canonicalStableHttpsAssetRef, value),
      false,
      `lifecycle:${value}`
    );
    assert.equal(
      publishedStringConstraintAccepts(inputSchema, inputSchema.$defs.canonicalStableHttpsAssetRef, value),
      true,
      `software-input:${value}`
    );
  }
  for (const key of CANONICAL_CLOUD_CREDENTIAL_QUERY_KEYS) {
    assert.throws(
      () => assertNoProductionSecrets(`https://assets.example.com/a?${key}=abc`, `assetRef.${key}`),
      /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/
    );
  }
  for (const value of [
    "https://assets.example.com/path?ossVersion=1",
    "https://assets.example.com/path?credentialAlias=ozon",
    "https://assets.example.com/path?signaturePolicy=required",
    "https://assets.example.com/path?securityPolicy=required",
    "https://assets.example.com/path?securityLabel=public",
    "https://assets.example.com/path?x-oss-process=image"
  ]) {
    assert.equal(assertCanonicalStableHttpsAssetRef(value), value, value);
    assert.doesNotThrow(() => assertNoProductionSecrets(value, "assetRef"), value);
    for (const schema of [lifecycleSchema, inputSchema]) {
      assert.equal(
        publishedStringConstraintAccepts(schema, schema.$defs.canonicalStableHttpsAssetRef, value),
        true,
        `${schema.$id}:${value}`
      );
    }
  }
});

test("C1 opaque authorizationId只在已批准语义路径通过两道公共门", async () => {
  const opaqueAuthorizationId = "authorization:c1-ai-draft:SHELF-WHITE";
  const allowed = {
    frozenC1Handoff: {
      draftOnlySeo: { providerJobRef: { authorizationRef: { authorizationId: opaqueAuthorizationId } } }
    }
  };
  assert.doesNotThrow(() => assertNoProductionSecrets(allowed, "allowed"));
  assert.doesNotThrow(() => assertCanonicalC2ReferenceTree(allowed, "allowed"));

  const unrelated = { unrelated: { authorizationId: opaqueAuthorizationId } };
  assert.throws(() => assertNoProductionSecrets(unrelated, "unrelated"), /PRODUCTION_AUTHORIZATION_SECRET_REJECTED/);
  assert.throws(() => assertCanonicalC2ReferenceTree(unrelated, "unrelated"), /C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED/);

  const lifecycleSchema = JSON.parse(await readFile(
    new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"
  ));
  const inputSchema = JSON.parse(await readFile(
    new URL("../schema/c2-software-input-v1.schema.json", import.meta.url), "utf8"
  ));
  assert.equal(
    publishedStringConstraintAccepts(inputSchema, inputSchema.$defs.paidAuthorizationRef.properties.authorizationId, opaqueAuthorizationId),
    true
  );
  const lifecycleAuthorizationId = lifecycleSchema.$defs.canonicalC1Handoff.properties.draftOnlySeo.oneOf[0]
    .properties.providerJobRef.properties.authorizationRef.properties.authorizationId;
  assert.equal(publishedStringConstraintAccepts(lifecycleSchema, lifecycleAuthorizationId, opaqueAuthorizationId), true);
  assert.deepEqual(inputSchema.$defs.referenceValue.oneOf[0], { $ref: "#/$defs/c2SecretCheckedContractString" });
});

test("公共canonical collector按原始已声明字段校验引用且不回显动态事实键", () => {
  assert.equal(C2_REFERENCE_SEMANTICS.fields, C2_REFERENCE_FIELD_SEMANTICS);
  const declaredReferenceFields = [
    "evidenceRefs", "factRefs", "keywordEvidenceRefs", "receiptRef", "schemaSnapshotRef",
    "salesSnapshotId", "selectedSupplySnapshotId", "profitModelVersion", "platformSchemaEvidenceId"
  ];
  for (const field of declaredReferenceFields) {
    assert.equal(C2_REFERENCE_FIELD_SEMANTICS[field], "canonicalFrozenRef", field);
  }
  assert.equal(C2_REFERENCE_FIELD_SEMANTICS.sourceRefs, "canonicalFrozenRef");

  for (const value of ["evidence%3Alegacy", "ｅvidence:legacy", " evidence:legacy"]) {
    for (const field of ["sourceRefs", "evidenceRefs", "factRefs", "keywordEvidenceRefs"]) {
      const errors = collectCanonicalC2ReferenceErrors({ dynamicFact: { [field]: [value] } }, "collector");
      assert.ok(errors.some((error) => error.message === C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED), `${field}:${value}`);
      assert.ok(errors.every((error) => !error.path.includes("dynamicFact")), `${field}:${JSON.stringify(errors)}`);
      assert.ok(errors.some((error) => error.path === "collector.[unknown]." + field + "[0]"), JSON.stringify(errors));
    }
    for (const field of ["receiptRef", "schemaSnapshotRef"]) {
      const errors = collectCanonicalC2ReferenceErrors({ dynamicFact: { [field]: value } }, "collector");
      assert.ok(errors.some((error) => error.path === "collector.[unknown]." + field), JSON.stringify(errors));
    }
    for (const field of ["salesSnapshotId", "selectedSupplySnapshotId", "profitModelVersion", "platformSchemaEvidenceId"]) {
      const errors = collectCanonicalC2ReferenceErrors({ dynamicFact: { inputRefs: { [field]: value } } }, "collector");
      assert.ok(errors.some((error) => error.path === `collector.[unknown].inputRefs.${field}`), JSON.stringify(errors));
    }
  }

  assert.deepEqual(
    collectCanonicalC2ReferenceErrors({ dynamicFact: { customRef: "https://legacy.example/path" } }, "collector"),
    [],
    "未声明动态customRef不得因后缀猜测为引用"
  );
  assert.ok(
    collectCanonicalC2ReferenceErrors({ dynamicFact: { sourceRefs: ["https://evidence.example.com/path"] } }, "collector")
      .some((error) => error.message === C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED),
    "sourceRefs必须与两份已发布Schema同义，不得扩展为稳定HTTPS"
  );

  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const manifest = prepareC2FinalUploadManifest({
    skuPackage: initialized.skuPackage, expectedDataRevision: 8, finalUploadAssets: finalAssets(), preparedAt: LATER
  });
  const confirmed = confirmC2SoftwareFinalUploads({
    skuPackage: initialized.skuPackage,
    expectedDataRevision: 8,
    finalManifest: manifest,
    ownerDecision: ownerDecision(manifest),
    confirmedAt: LATER
  });
  const stored = structuredClone(confirmed.skuPackage);
  const dynamicKey = "sourceRefs-secret-name";
  stored.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.productAttributes[dynamicKey] = {
    value: "valid product fact",
    verificationStatus: "confirmed",
    sourceRefs: ["evidence%3Alegacy"]
  };
  const validation = validateC2AssetLifecycle(stored.c2FinalAssets);
  assert.equal(validation.valid, false);
  const migrationError = validation.errors.find((error) => error.message === C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED);
  assert.ok(migrationError, JSON.stringify(validation.errors));
  assert.equal(migrationError.path.includes(dynamicKey), false);
  assert.equal(migrationError.path, "$.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.productAttributes.[unknown].sourceRefs[0]");
  assert.throws(
    () => validateProductionAuthorizationPreparation({
      preparation: stored.c2FinalAssets.productionAuthorizationPreparation,
      candidateId: stored.g1Identity.candidateId,
      skuPackage: stored
    }),
    /C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED/
  );

  const httpsStored = structuredClone(confirmed.skuPackage);
  httpsStored.c2FinalAssets.productionAuthorizationPreparation.finalCardInputSnapshot.c1Snapshot.productAttributes[dynamicKey] = {
    value: "valid product fact",
    verificationStatus: "confirmed",
    sourceRefs: ["https://evidence.example.com/path"]
  };
  assert.equal(validateC2AssetLifecycle(httpsStored.c2FinalAssets).valid, false);
  assert.throws(
    () => validateProductionAuthorizationPreparation({
      preparation: httpsStored.c2FinalAssets.productionAuthorizationPreparation,
      candidateId: httpsStored.g1Identity.candidateId,
      skuPackage: httpsStored
    }),
    /C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED/
  );
});

test("analysis素材允许canonical opaque引用而finalUploads只允许稳定HTTPS", async () => {
  const lifecycleSchema = JSON.parse(await readFile(
    new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"
  ));
  const inputSchema = JSON.parse(await readFile(
    new URL("../schema/c2-software-input-v1.schema.json", import.meta.url), "utf8"
  ));
  const regions = assetRegions();
  regions.collected[0].assetRef = "asset:analysis:collected:shelf-white:v1";
  regions.aiDrafts[0].assetRef = "asset:analysis:draft:shelf-white:v1";
  const result = createC2SoftwareContainer({
    skuPackage: packageFixture(),
    expectedDataRevision: 7,
    assetRegions: regions,
    createdAt: NOW
  });
  assert.equal(result.skuPackage.c2FinalAssets.assets.collected[0].assetRef, regions.collected[0].assetRef);
  assert.equal(result.skuPackage.c2FinalAssets.assets.aiDrafts[0].assetRef, regions.aiDrafts[0].assetRef);
  assert.equal(assertCanonicalAnalysisAssetRef(regions.collected[0].assetRef), regions.collected[0].assetRef);
  assert.equal(isCanonicalAnalysisAssetRef(regions.aiDrafts[0].assetRef), true);
  for (const schema of [lifecycleSchema, inputSchema]) {
    for (const definitionName of ["collectedAsset", "aiDraftAsset"]) {
      assert.equal(
        publishedStringConstraintAccepts(schema, schema.$defs[definitionName].properties.assetRef, regions.collected[0].assetRef),
        true,
        `${schema.$id}:${definitionName}`
      );
    }
  }

  const opaqueFinalAssets = finalAssets();
  opaqueFinalAssets[0].assetRef = regions.collected[0].assetRef;
  assert.throws(() => normalizeC2FinalUploads({
    finalUploadAssets: opaqueFinalAssets,
    existingAssets: result.skuPackage.c2FinalAssets.assets,
    effectiveVideoRequirement: result.skuPackage.c2FinalAssets.effectiveVideoRequirement,
    addedAt: LATER
  }), /C2_REFERENCE_REJECTED_NONCANONICAL/);
  assert.equal(
    publishedStringConstraintAccepts(
      lifecycleSchema,
      lifecycleSchema.$defs.finalAsset.properties.assetRef,
      regions.collected[0].assetRef
    ),
    false
  );
  assert.equal(result.skuPackage.productionAuthorization, null);
  assert.equal(result.skuPackage.productionRecord, null);

  for (const key of CANONICAL_CLOUD_CREDENTIAL_QUERY_KEYS) {
    const signedRegions = assetRegions();
    signedRegions.collected[0].assetRef = `https://assets.example.com/source.jpg?${key}=temporary`;
    const input = packageFixture();
    assert.throws(() => createC2SoftwareContainer({
      skuPackage: input,
      expectedDataRevision: 7,
      assetRegions: signedRegions,
      createdAt: NOW
    }), /(?:PRODUCTION_AUTHORIZATION_SECRET_REJECTED|C2_REFERENCE_REJECTED_NONCANONICAL)/);
    assert.equal(input.c2FinalAssets, null);
    assert.equal(input.productionAuthorization, null);
    assert.equal(input.productionRecord, null);
  }
});

test("公共秘密与canonical引用扫描对超深和超量对象显式有界fail-closed", () => {
  assert.equal(PRODUCTION_CONTRACT_MAX_DEPTH, 128);
  assert.equal(PRODUCTION_CONTRACT_MAX_NODES, 10_000);
  const nestedObject = (depth) => {
    const root = {};
    let current = root;
    for (let index = 0; index < depth; index += 1) {
      current.child = {};
      current = current.child;
    }
    return root;
  };
  assert.doesNotThrow(() => assertNoProductionSecrets(nestedObject(128), "depth128"));
  assert.doesNotThrow(() => assertCanonicalC2ReferenceTree(nestedObject(128), "depth128"));
  assert.throws(() => assertNoProductionSecrets(nestedObject(129), "depth129"), new RegExp(PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED));
  assert.throws(() => assertCanonicalC2ReferenceTree(nestedObject(129), "depth129"), new RegExp(C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED));
  const deeplyNested = {};
  let cursor = deeplyNested;
  for (let depth = 0; depth < 20_000; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  const startedAt = performance.now();
  assert.throws(
    () => assertNoProductionSecrets(deeplyNested, "deep"),
    new RegExp(PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)
  );
  assert.throws(
    () => assertCanonicalC2ReferenceTree(deeplyNested, "deep"),
    new RegExp(C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED)
  );
  assert.ok(performance.now() - startedAt < 1_000);

  const exactlyBoundedNodes = Object.fromEntries(
    Array.from({ length: PRODUCTION_CONTRACT_MAX_NODES - 1 }, (_, index) => [`field${index}`, "ordinary"])
  );
  assert.doesNotThrow(() => assertNoProductionSecrets(exactlyBoundedNodes, "wide10000"));
  assert.doesNotThrow(() => assertCanonicalC2ReferenceTree(exactlyBoundedNodes, "wide10000"));
  const tooManyNodes = Object.fromEntries(
    Array.from({ length: PRODUCTION_CONTRACT_MAX_NODES }, (_, index) => [`field${index}`, "ordinary"])
  );
  assert.throws(
    () => assertNoProductionSecrets(tooManyNodes, "wide"),
    new RegExp(PRODUCTION_CONTRACT_RESOURCE_LIMIT_EXCEEDED)
  );
  assert.throws(
    () => assertCanonicalC2ReferenceTree(tooManyNodes, "wide"),
    new RegExp(C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED)
  );
});

test("直接C2领域入口在构造前拒绝非canonical analysis引用且不改revision", () => {
  const invalidCollectedValues = {
    assetRef: "https://assets.example.com/source.jpg?security-token=temporary",
    assetId: "asset%3Alegacy",
    sourceEvidenceRef: "evidence%3Alegacy",
    "usageAuthorization.evidenceRef": "authorization%3Alegacy"
  };
  for (const [field, value] of Object.entries(invalidCollectedValues)) {
    const invalidCollected = assetRegions().collected[0];
    if (field === "usageAuthorization.evidenceRef") invalidCollected.usageAuthorization.evidenceRef = value;
    else invalidCollected[field] = value;
    const createInput = packageFixture();
    const before = structuredClone(createInput);
    assert.throws(() => createC2AssetLifecycle({
      skuPackage: createInput,
      collectedAssets: [invalidCollected],
      aiDraftAssets: [],
      createdAt: NOW
    }), /C2_REFERENCE_REJECTED_NONCANONICAL/, `collected:${field}`);
    assert.deepEqual(createInput, before, `collected:${field}:输入不得改变`);
    assert.equal(createInput.dataRevision, 7);
    assert.equal(createInput.c2FinalAssets, null);
  }

  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const invalidDraftValues = {
    assetRef: "https://assets.example.com/draft.jpg?security-token=temporary",
    assetId: "asset%3Alegacy",
    generatorRef: "generator%3Alegacy",
    sourceEvidenceRef: "evidence%3Alegacy",
    "usageAuthorization.evidenceRef": "authorization%3Alegacy"
  };
  for (const [field, value] of Object.entries(invalidDraftValues)) {
    const invalidDraft = assetRegions().aiDrafts[0];
    if (field === "usageAuthorization.evidenceRef") invalidDraft.usageAuthorization.evidenceRef = value;
    else invalidDraft[field] = value;
    const before = structuredClone(initialized.skuPackage);
    assert.throws(() => addAiDraftAssets({
      skuPackage: initialized.skuPackage,
      aiDraftAssets: [invalidDraft],
      addedAt: LATER
    }), /C2_REFERENCE_REJECTED_NONCANONICAL/, `aiDraft:${field}`);
    assert.deepEqual(initialized.skuPackage, before, `aiDraft:${field}:输入不得改变`);
    assert.equal(initialized.skuPackage.dataRevision, 8);
    assert.equal(initialized.skuPackage.c2FinalAssets.assets.aiDrafts.length, 1);
  }
});

test("新输入拒绝非canonical引用且旧冻结记录明确要求新revision迁移", () => {
  const newInput = packageFixture();
  newInput.g1Identity.storeRef.platformStoreId = "store%3Alegacy";
  const beforeNewInput = structuredClone(newInput);
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: newInput,
    expectedDataRevision: 7,
    assetRegions: assetRegions(),
    createdAt: NOW
  }), /C2_REFERENCE_REJECTED_NONCANONICAL/);
  assert.deepEqual(newInput, beforeNewInput);
  assert.equal(newInput.productionAuthorization, null);
  assert.equal(newInput.productionRecord, null);

  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const legacy = structuredClone(initialized.skuPackage);
  legacy.c2FinalAssets.assets.collected[0].assetId = "asset%3Alegacy";
  legacy.c2FinalAssets.assets.collected[0].sourceEvidenceRef = "evidence%3Alegacy";
  const frozenLegacy = structuredClone(legacy);
  const validation = validateC2AssetLifecycle(legacy.c2FinalAssets);
  assert.equal(validation.valid, false);
  const migrationPaths = validation.errors
    .filter((error) => error.message === C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED)
    .map((error) => error.path);
  const legacySourceEvidencePath = migrationPaths.find((path) =>
    path.endsWith("assets.collected[0].sourceEvidenceRef")
  );
  const legacyAssetIdPath = migrationPaths.find((path) => path.endsWith("assets.collected[0].assetId"));
  assert.ok(legacySourceEvidencePath, JSON.stringify(migrationPaths));
  assert.ok(legacyAssetIdPath, JSON.stringify(migrationPaths));
  assert.throws(
    () => selectConfirmedFinalUploadsForProduction(legacy),
    (error) => error.message.startsWith(`${C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED}:`) &&
      error.message.includes(legacyAssetIdPath) && error.message.includes(legacySourceEvidencePath)
  );
  assert.deepEqual(legacy, frozenLegacy);
  assert.equal(legacy.productionAuthorization, null);
  assert.equal(legacy.productionRecord, null);
  assert.equal(legacy.c2FinalAssets.platformUploads, 0);
  assert.equal(legacy.c2FinalAssets.productionStarted, false);
});

test("C2 canonical诊断有界、资源优先且不回显动态键", () => {
  assert.equal(C2_DIAGNOSTIC_MAX_PATHS, 16);
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const resourceLimited = structuredClone(initialized.skuPackage);
  resourceLimited.c2FinalAssets.assets.collected[0].sourceEvidenceRef = Array.from(
    { length: PRODUCTION_CONTRACT_MAX_NODES + 1 },
    (_value, index) => index % 2 === 0
      ? `evidence%3Alegacy-${index}`
      : `evidence:fixture:canonical-${index}`
  );
  const frozenResourceLimited = structuredClone(resourceLimited);
  const resourceValidation = validateC2AssetLifecycle(resourceLimited.c2FinalAssets);
  assert.ok(resourceValidation.errors.some((item) =>
    item.message === C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED
  ));
  assert.ok(resourceValidation.errors.some((item) =>
    item.message === C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED
  ));
  assert.throws(
    () => selectConfirmedFinalUploadsForProduction(resourceLimited),
    (error) => {
      const message = String(error.message);
      assert.match(message, new RegExp(`^${C2_REFERENCE_CONTRACT_RESOURCE_LIMIT_EXCEEDED}:`));
      assert.ok(message.endsWith(":resource-limit"));
      assert.ok(Buffer.byteLength(message, "utf8") <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES);
      assert.equal(message.includes("evidence%3Alegacy-"), false);
      return true;
    }
  );
  assert.deepEqual(resourceLimited, frozenResourceLimited);

  for (const dynamicKey of ["CUSTOM_SECRET_VALUE_123456789", "x".repeat(100_000)]) {
    const dynamicField = structuredClone(initialized.skuPackage);
    dynamicField.c2FinalAssets.assets.collected[0][dynamicKey] = "ordinary";
    const frozenDynamicField = structuredClone(dynamicField);
    assert.throws(
      () => selectConfirmedFinalUploadsForProduction(dynamicField),
      (error) => {
        const message = String(error.message);
        assert.match(message, /^C2素材包校验失败:/);
        assert.ok(Buffer.byteLength(message, "utf8") <= C2_DIAGNOSTIC_MAX_ERROR_MESSAGE_BYTES);
        assert.equal(message.includes(dynamicKey), false);
        assert.equal(message.includes("CUSTOM_SECRET_VALUE"), false);
        return true;
      },
      "动态字段不得回显到C2错误路径"
    );
    assert.deepEqual(dynamicField, frozenDynamicField);
  }
});

test("发布的C2 Schema冻结软件状态、三域和下游边界", async () => {
  const lifecycleSchema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  const inputSchema = JSON.parse(await readFile(new URL("../schema/c2-software-input-v1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(lifecycleSchema.properties.softwareState.properties.lifecycleStatus.enum, ["c2_waiting_final_uploads", "c2_ready"]);
  assert.equal(lifecycleSchema.properties.softwareState.properties.executionPolicy.properties.productionAllowed.const, false);
  assert.deepEqual(inputSchema.$defs.initialAssetRegions.required, ["collected", "aiDrafts", "finalUploads"]);
  assert.equal(inputSchema.$defs.executionPolicy.properties.xiaohouziAllowed.const, false);
  assert.equal(inputSchema.$defs.executionPolicy.properties.gptImageAllowed.const, false);
  assert.equal(inputSchema.$defs.executionPolicy.properties.gateway4318Allowed.const, false);
  assert.equal(lifecycleSchema.additionalProperties, false);
  assert.ok(lifecycleSchema.required.includes("targetContext"));
  assert.ok(lifecycleSchema.required.includes("unknownManifest"));
  assert.ok(lifecycleSchema.required.includes("productionAuthorizationPreparation"));
  assert.ok(lifecycleSchema.required.includes("ownerVideoRequirement"));
  assert.equal(lifecycleSchema.$defs.finalAsset.additionalProperties, false);
  assert.deepEqual(lifecycleSchema.$defs.finalAsset.properties.assetRef.oneOf, [
    { $ref: "#/$defs/canonicalStableHttpsAssetRef" },
    { type: "string", pattern: LOCAL_FINAL_ASSET_REF_PATTERN_SOURCE }
  ]);
  assert.equal(lifecycleSchema.$defs.analysisAuthorization.properties.status.const, "analysis_reference_only");
  assert.equal(lifecycleSchema.$defs.draftAuthorization.properties.status.const, "draft_reference_only");
  assert.equal(lifecycleSchema.$defs.listingAuthorization.properties.status.const, "owner_authorized_for_listing");
  const finalAssetProperties = lifecycleSchema.$defs.finalAsset.properties;
  for (const legalUrl of [
    "https://assets.example.com/final/main.jpg?version=1",
    "https://assets.example.com/final/main.jpg?tokenizer=tool",
    "https://assets.example.com/final/main.jpg?secretless=design"
  ]) {
    assert.equal(publishedStringConstraintAccepts(lifecycleSchema, finalAssetProperties.assetRef, legalUrl), true, legalUrl);
  }
  for (const unsafeUrl of [
    "https://user:pass@assets.example.com/final/main.jpg",
    "https://assets.example.com/final/token:abc/main.jpg",
    "https://assets.example.com/final/safe/authorization:abc/main.jpg",
    "https://assets.example.com/final/main.jpg?authorization=abc",
    "https://assets.example.com/final/main.jpg#token=abc",
    "https://localhost/final/main.jpg",
    "https://127.0.0.1/final/main.jpg",
    ...LIFECYCLE_LOCAL_FINAL_URLS
  ]) {
    assert.equal(publishedStringConstraintAccepts(lifecycleSchema, finalAssetProperties.assetRef, unsafeUrl), false, unsafeUrl);
  }
  for (let depth = 1; depth <= 3; depth += 1) {
    const unsafeUrl = percentEncode("https://assets.example.com/final/main.jpg?authorization=abc", depth);
    assert.equal(publishedStringConstraintAccepts(lifecycleSchema, finalAssetProperties.assetRef, unsafeUrl), false, `asset:${depth}`);
  }
  for (const refSchema of [
    finalAssetProperties.sourceEvidenceRef,
    finalAssetProperties.stableUrlEvidenceRef,
    lifecycleSchema.$defs.listingAuthorization.properties.evidenceRef
  ]) {
    assert.equal(publishedStringConstraintAccepts(lifecycleSchema, refSchema, "credential-alias:ozon:dandanshu"), true);
    assert.equal(publishedStringConstraintAccepts(lifecycleSchema, refSchema, "authorization:abc"), false);
    assert.equal(publishedStringConstraintAccepts(lifecycleSchema, refSchema, "safe/token:abc"), false);
    assert.equal(publishedStringConstraintAccepts(lifecycleSchema, refSchema, "https://user:pass@x.test/path"), false);
  }
  assert.equal(lifecycleSchema.properties.generationIntegrations.additionalProperties, false);
  assert.equal(lifecycleSchema.properties.softwareState.required.includes("authorizedMediaFingerprint"), false);
  const preparationSchema = lifecycleSchema.properties.productionAuthorizationPreparation.oneOf[1];
  for (const field of [
    "targetContext", "frozenC1Handoff", "authorizedMediaFingerprint", "finalUploads", "effectiveVideoRequirement",
    "ownerFinalUploadConfirmation", "finalCardInputSnapshot", "finalCardInputFingerprint",
    "ownerFinalCardAuthorizationDecision", "pendingAuthorizationInputs", "preparationFingerprint"
  ]) assert.ok(preparationSchema.required.includes(field));
  assert.equal(preparationSchema.properties.pendingAuthorizationInputs.properties.merchantSku.type, "null");
  assert.equal(preparationSchema.properties.pendingAuthorizationInputs.properties.credentialAlias.type, "null");
  assert.equal(preparationSchema.properties.frozenC1Handoff.$ref, "#/$defs/canonicalC1Handoff");
  assert.ok(lifecycleSchema.$defs.canonicalC1Handoff.required.includes("identity"));
  assert.equal(lifecycleSchema.$defs.canonicalC1Handoff.properties.identity.$ref, "#/$defs/g1Identity");
  assert.equal(lifecycleSchema.$defs.g1Identity.additionalProperties, false);
  assert.deepEqual(lifecycleSchema.$defs.g1Identity.required, [
    "schemaVersion", "candidateId", "skuPackageId", "platform", "storeRef", "supplierSkuId",
    "merchantSku", "warehouseRef", "credentialAlias", "platformProductId"
  ]);
  assert.equal(lifecycleSchema.$defs.g1Identity.properties.storeRef.additionalProperties, false);
  assert.deepEqual(lifecycleSchema.$defs.g1Identity.properties.storeRef.required, [
    "stableStoreId", "platformStoreId", "mappingVersion"
  ]);
  assert.equal(Object.hasOwn(lifecycleSchema.$defs.g1Identity.properties, "variantKey"), false);
  for (const field of ["merchantSku", "warehouseRef", "credentialAlias", "platformProductId"]) {
    assert.equal(lifecycleSchema.$defs.g1Identity.properties[field].const, "not_applicable");
  }
  assert.equal(
    preparationSchema.properties.finalCardInputSnapshot.properties.canonicalC1.$ref,
    "#/$defs/canonicalC1Handoff"
  );
  assert.equal(preparationSchema.properties.finalCardInputSnapshot.properties.identity.$ref, "#/$defs/g1Identity");
  assert.ok(preparationSchema.properties.finalCardInputSnapshot.required.includes("variantKey"));
  assert.deepEqual(
    preparationSchema.properties.finalCardInputSnapshot.allOf,
    [{ $ref: "#/$defs/noRawPersistenceKeys" }]
  );
  const forbiddenPersistenceKey = new RegExp(lifecycleSchema.$defs.noRawPersistenceKeys.then.propertyNames.not.pattern);
  for (const key of [
    "rawResponse", "raw_response", "rawRequest", "rawHtml", "rawPayload", "rawHeaders", "raw_headers",
    "responseBody", "requestHeaders", "response_headers"
  ]) assert.equal(forbiddenPersistenceKey.test(key), true, key);
  for (const key of [
    "headers", "signature", "credential", "credentials", "expires", "expiresAt", "expires_at", "expiry",
    "credentialAlias", "authorizationRef", "responseVerified"
  ]) {
    assert.equal(forbiddenPersistenceKey.test(key), false, key);
  }
  assert.equal(preparationSchema.properties.productionAuthorizationCreated.const, false);
  assert.equal(preparationSchema.properties.dHandoffCreated.const, false);
});

test("发布Schema拒绝伪正式provider、秘密回执、原始响应、弱revision和关键词绕过", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$defs.c1OpaqueAuthorizationId.pattern, C1_OPAQUE_AUTHORIZATION_ID_PATTERN_SOURCE);
  assert.equal(publishedStringConstraintAccepts(
    schema,
    schema.$defs.c1OpaqueAuthorizationId,
    "authorization:c1-ai-draft:SHELF-WHITE"
  ), true);
  for (const unsafeAuthorizationId of [
    "authorization:c1-ai-draft:bearer-token",
    "authorization:c1-ai-draft:Basic-record",
    "authorization:c1-ai-draft:token",
    "authorization:c1-ai-draft:client-secret",
    "authorization:c1-ai-draft:t-o-k-e-n"
  ]) {
    assert.equal(publishedStringConstraintAccepts(
      schema,
      schema.$defs.c1OpaqueAuthorizationId,
      unsafeAuthorizationId
    ), false, unsafeAuthorizationId);
  }
  assert.equal(schema.$defs.canonicalFrozenRef.maxLength, 256);
  assert.equal(schema.$defs.canonicalFrozenRef.pattern.startsWith("^(?=.{1,256}$)"), true);
  for (const legal of [
    "candidate:user@example.com",
    "tokenizer-service",
    "secretless-build"
  ]) {
    assert.equal(publishedStringConstraintAccepts(schema, schema.$defs.canonicalFrozenRef, legal), true, legal);
  }
  for (const oversized of ["a".repeat(257), "a".repeat(20_000), "a".repeat(40_000)]) {
    assert.equal(publishedStringConstraintAccepts(schema, schema.$defs.canonicalFrozenRef, oversized), false);
  }
  const canonical = schema.$defs.canonicalC1Handoff;
  const frozen = canonical.properties.frozenInputRefs;
  const draftSchema = canonical.properties.draftOnlySeo.oneOf[0];
  const job = draftSchema.properties.providerJobRef;
  const authorization = job.properties.authorizationRef;
  const scope = authorization.properties.scope;
  const expectedFrozenRefs = [
    "candidateId", "skuPackageId", "platform", "storeRef", "sourceRevision", "salesSnapshotId",
    "selectedSupplySnapshotId", "ownerSupplyConfirmationRef", "profitModelVersion", "schemaSnapshotRef"
  ];
  assert.equal(frozen.additionalProperties, false);
  assert.deepEqual(frozen.required, expectedFrozenRefs);
  assert.equal(frozen.properties.sourceRevision.type, "integer");
  assert.equal(frozen.properties.sourceRevision.minimum, 0);
  assert.equal(canonical.properties.handoffRevisionRefs.properties.sourceRevision.minimum, 1);
  assert.equal(canonical.properties.handoffRevisionRefs.properties.resultRevision.minimum, 2);

  for (const [objectSchema, forbiddenKey] of [
    [draftSchema, "token"],
    [job, "cookie"],
    [authorization, "clientSecret"],
    [scope, "rawResponse"]
  ]) {
    assert.equal(objectSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(objectSchema.properties, forbiddenKey), false);
  }

  const opaqueSchemas = [
    draftSchema.properties.aiRequestId,
    draftSchema.properties.receiptRef,
    job.properties.jobId,
    job.properties.receiptRef,
    authorization.properties.authorizationId,
    canonical.properties.keywordEvidenceRefs.items,
    canonical.properties.schemaSnapshotRef
  ];
  for (const value of [
    "", " ", "https://provider.example/receipt", "receipt:token=secret", "cookie:session",
    "Bearer-secret", "api_key:value", "a".repeat(257)
  ]) {
    for (const stringSchema of opaqueSchemas) {
      assert.equal(publishedStringConstraintAccepts(schema, stringSchema, value), false, value);
    }
  }
  for (const value of ["request:c1-ai-draft:SHELF-WHITE", "receipt:c1-ai-draft:SHELF-WHITE", "keyword:fixture:shelf"]) {
    assert.equal(publishedStringConstraintAccepts(schema, schema.$defs.opaqueEvidenceRef, value), true);
  }

  assert.equal(publishedStringConstraintAccepts(schema, job.properties.providerId, "unknown"), false);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.providerVersion, "unknown"), false);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.providerId, "ecommerce-ai-gateway"), true);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.providerId, "provider@example.com"), true);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.providerVersion, "1.2.3+build"), true);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.providerId, "tokenizer-service"), true);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.providerVersion, "secretless-build"), true);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.candidateId, "api-keyboard:sku"), true);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.candidateId, "https://provider.example/id?version=1"), false);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.candidateId, "https://provider.example/id?q=%20"), false);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.candidateId, "https://provider.example/id?version"), false);
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.providerId, "provider token=secret"), false);
  for (const unsafeUrl of [
    "https://user:pass@provider.example/id",
    "https://provider.example/id?signature=x",
    "https://provider.example/id?credential=x",
    "https://provider.example/id?expires=x",
    "https://provider.example/id?expiresAt=x",
    "https://provider.example/id?%73ignature=x",
    "https://provider.example/id?cred%65ntial=x",
    "https://provider.example/id?token",
    "https://provider.example/id?%74oken"
  ]) {
    assert.equal(publishedStringConstraintAccepts(schema, job.properties.candidateId, unsafeUrl), false, unsafeUrl);
  }
  for (const safeUrl of [
    "https://provider.example/id?xsignature=x",
    "https://provider.example/id?credentialId=x",
    "https://provider.example/id?tokenizer=tool",
    "https://provider.example/id?secretless=design"
  ]) {
    assert.equal(publishedStringConstraintAccepts(schema, job.properties.candidateId, safeUrl), false, safeUrl);
  }
  assert.equal(publishedStringConstraintAccepts(schema, job.properties.candidateId, "candidate:user@example.com"), true);
  assert.equal(job.properties.jobType.const, "c1_ai_draft");
  assert.equal(authorization.properties.authorizationType.const, "paid_ai_draft");
  assert.equal(job.properties.terminalStatus.const, "completed");
  assert.equal(job.properties.requestSubmitted.const, true);
  assert.equal(job.properties.responseVerified.const, true);
  assert.ok(job.required.includes("authorizationRef"));
  assert.ok(job.required.includes("receiptRef"));
  assert.ok(scope.required.includes("sourceRevision"));
  assert.ok(scope.required.includes("storeRef"));
  assert.equal(job.properties.storeRef.$ref, "#/$defs/canonicalFrozenRef");
  assert.equal(scope.properties.storeRef.$ref, "#/$defs/canonicalFrozenRef");

  for (const fingerprintSchema of [
    draftSchema.properties.aiRequestFingerprint,
    draftSchema.properties.inputFingerprint,
    job.properties.inputFingerprint
  ]) {
    assert.equal(publishedStringConstraintAccepts(schema, fingerprintSchema, "not-sha"), false);
    assert.equal(publishedStringConstraintAccepts(schema, fingerprintSchema, SHA_A), true);
  }
  assert.equal(job.properties.sourceRevision.minimum, 0);
  assert.equal(scope.properties.sourceRevision.minimum, 0);

  const keywordRefs = canonical.properties.keywordEvidenceRefs;
  assert.equal(publishedStringArrayConstraintAccepts(schema, keywordRefs, []), false);
  assert.equal(publishedStringArrayConstraintAccepts(schema, keywordRefs, ["keyword:fixture:shelf", "keyword:fixture:shelf"]), false);
  assert.equal(publishedStringArrayConstraintAccepts(schema, keywordRefs, ["keyword:fixture:shelf", "token:secret"]), false);
  assert.equal(publishedStringArrayConstraintAccepts(schema, keywordRefs, ["keyword:fixture:shelf"]), true);
  assert.equal(canonical.properties.unknownManifest.maxItems, 0);
  assert.equal([{}].length <= canonical.properties.unknownManifest.maxItems, false);

  const preparationSchema = schema.properties.productionAuthorizationPreparation.oneOf[1];
  assert.equal(preparationSchema.properties.frozenC1Handoff.$ref, "#/$defs/canonicalC1Handoff");
  assert.equal(
    preparationSchema.properties.finalCardInputSnapshot.properties.canonicalC1.$ref,
    "#/$defs/canonicalC1Handoff"
  );
});

test("canonicalFrozenRef超长输入在20k和40k量级均以常数长度门快速拒绝", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/c2-asset-lifecycle-v1.1.schema.json", import.meta.url), "utf8"));
  const pattern = new RegExp(schema.$defs.canonicalFrozenRef.pattern);
  const medians = [];
  for (const size of [20_000, 40_000]) {
    const value = `https://provider.example/id?${"?".repeat(size)}`;
    assert.equal(pattern.test(value), false);
    assert.equal(isSafeFrozenRef(value), false);
    const durationsMs = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = process.hrtime.bigint();
      assert.equal(pattern.test(value), false);
      assert.equal(isSafeFrozenRef(value), false);
      durationsMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    }
    durationsMs.sort((left, right) => left - right);
    const medianMs = durationsMs[1];
    assert.ok(medianMs < 25, `${size} safeFrozenRef took ${medianMs.toFixed(3)}ms`);
    medians.push(medianMs);
  }
  assert.ok(medians[1] < medians[0] * 4 + 5, `40k/20k growth was ${medians[1].toFixed(3)}/${medians[0].toFixed(3)}ms`);
});

test("缺少softwareState的C2记录在Schema与运行时都无效，并明确要求迁移", () => {
  const current = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const legacy = structuredClone(current.skuPackage);
  delete legacy.c2FinalAssets.softwareState;
  const diagnosis = validateC2AssetLifecycle(legacy.c2FinalAssets);
  assert.equal(diagnosis.valid, false);
  assert.ok(diagnosis.errors.some((item) => item.path === "softwareState"));
  assert.throws(() => createC2SoftwareContainer({
    skuPackage: legacy, expectedDataRevision: 8, assetRegions: assetRegions(), createdAt: NOW
  }), /LEGACY_STATE_REQUIRES_MIGRATION/);
});

function transportEnvelopeJob(jobRef, {
  workerId = "worker-stable-transport-1",
  leaseId = "lease-stable-transport-1",
  externalRequestRef = "request:c2-stable-transport:fixture"
} = {}) {
  return {
    jobId: jobRef.jobId,
    jobType: jobRef.jobType,
    candidateId: jobRef.candidateId,
    skuPackageId: jobRef.skuPackageId,
    revision: jobRef.resultRevision,
    workerId,
    leaseId,
    externalRequestRef
  };
}

function c2TransportPayload({ skuPackage, jobRef, stagedAssets, stagedAssetManifestFingerprint, stableUrlPrefix, settledAt }) {
  const assets = stagedAssets.map((asset, index) => ({
    assetId: asset.assetId,
    sha256: asset.sha256,
    order: asset.order,
    role: asset.role,
    stableUrl: `${stableUrlPrefix}/${index + 1}.jpg`,
    stableUrlEvidenceRef: `stable-url-evidence:${jobRef.jobId.split(":").pop()}:${index + 1}`
  }));
  const finalAssets = assets.map((asset, index) => ({
    ...structuredClone(stagedAssets[index]),
    assetRef: asset.stableUrl,
    stableUrlEvidenceRef: asset.stableUrlEvidenceRef
  }));
  const effectiveVideoRequirement = resolveC2EffectiveVideoRequirement({
    skuPackage,
    ownerVideoRequirement: skuPackage.c2FinalAssets.ownerVideoRequirement
  });
  const normalized = normalizeC2FinalUploads({
    finalUploadAssets: finalAssets,
    existingAssets: skuPackage.c2FinalAssets.assets,
    effectiveVideoRequirement,
    addedAt: settledAt
  });
  return {
    schemaVersion: "c2-stable-asset-transport-result-v1",
    status: "verified",
    jobId: jobRef.jobId,
    candidateId: jobRef.candidateId,
    skuPackageId: jobRef.skuPackageId,
    revision: jobRef.resultRevision,
    stagedAssetManifestFingerprint,
    finalManifestSha256: fingerprintC2FinalManifest({
      authorizedMediaFingerprint: normalized.authorizedMediaFingerprint,
      effectiveVideoRequirement,
      mainImageAssetId: normalized.mainImageAssetId,
      videoDisposition: normalized.videoDisposition,
      assets: normalized.assets
    }),
    verifiedAt: settledAt,
    assets
  };
}

function c2TransportResultEnvelope({
  job,
  jobRef,
  skuPackage,
  stagedAssets,
  stagedAssetManifestFingerprint,
  stableUrlPrefix,
  settledAt,
  resultRef,
  applicationDisposition = "applied",
  mutatePayload = null
}) {
  const payload = c2TransportPayload({
    skuPackage,
    jobRef,
    stagedAssets,
    stagedAssetManifestFingerprint,
    stableUrlPrefix,
    settledAt
  });
  if (mutatePayload) mutatePayload(payload);
  return createSoftwareJobResultEnvelope({
    job,
    resultRef,
    payloadKind: "c2_stable_asset_transport",
    payload,
    recordedAt: settledAt,
    applicationDisposition
  });
}

function stableTransportAuthorizationRecord({
  skuPackage,
  sourceRevision,
  resultRevision,
  authorizationRef,
  stagedAssetManifestFingerprint,
  ownerStagingConfirmation,
  allowedStableAssetHosts
}) {
  return {
    schemaVersion: "software-job-authorization-record-v1",
    authorizationId: authorizationRef,
    status: "active",
    action: "c2_stable_asset_transport",
    candidateId: skuPackage.g1Identity.candidateId,
    skuPackageId: skuPackage.skuPackageId,
    sourceRevision,
    resultRevision,
    platform: skuPackage.g1Identity.platform,
    storeRef: structuredClone(skuPackage.g1Identity.storeRef),
    supplierSkuId: skuPackage.g1Identity.supplierSkuId,
    variantKey: skuPackage.variantKey,
    sideEffectScope: "c2_stable_asset_transport",
    stagedAssetManifestFingerprint,
    ownerStagingConfirmationRef: ownerStagingConfirmation.confirmationRef,
    allowedStableAssetHosts,
    authorizedByUserId: ownerStagingConfirmation.confirmedByUserId,
    authorizedAt: ownerStagingConfirmation.confirmedAt,
    expiresAt: null,
    maxUses: 1,
    useCount: 0,
    consumedByJobId: null,
    consumedAt: null
  };
}

function stableTransportCredentialBinding({
  skuPackage,
  credentialAlias,
  allowedStableAssetHosts,
  allowedWorkerIds = ["worker-stable-transport-1", "worker-failed", "worker-unknown_outcome"]
}) {
  return {
    schemaVersion: "software-job-credential-binding-v1",
    bindingId: "credential-binding:oss:repository-fixture",
    credentialAlias,
    status: "active",
    provider: "oss",
    platform: skuPackage.g1Identity.platform,
    storeRef: structuredClone(skuPackage.g1Identity.storeRef),
    sideEffectScope: "c2_stable_asset_transport",
    allowedStableAssetHosts,
    allowedWorkerIds,
    redaction: "credential_alias_only",
    boundAt: NOW,
    expiresAt: null
  };
}

function stableTransportFixture({
  includeAuthorization = true,
  includeCredential = true,
  mutateAuthorization = null,
  mutateCredential = null,
  rightsExpiresAt = null
} = {}) {
  const sourcePackage = packageFixture();
  if (rightsExpiresAt !== null) sourcePackage.c1ProductPlan.inputSnapshots.skuRightsReview.expiresAt = rightsExpiresAt;
  const initialized = createC2SoftwareContainer({
    skuPackage: sourcePackage, expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const stagedAssets = finalAssets().map(({ assetRef: _assetRef, stableUrlEvidenceRef: _stableUrlEvidenceRef, ...asset }) => ({
    ...asset
  }));
  const preparedStaging = prepareC2StableAssetTransportManifest({ skuPackage: initialized.skuPackage, stagedAssets });
  const ownerStagingConfirmation = {
    schemaVersion: "c2-owner-staging-confirmation-v1",
    status: "confirmed",
    confirmedBy: "owner",
    confirmedByUserId: "owner-1",
    confirmedAt: NOW,
    confirmationRef: "owner-confirmation:c2-staging:repository-fixture",
    approvedStagedAssetManifestFingerprint: preparedStaging.stagedAssetManifestFingerprint,
    approvedSourceC1Fingerprint: preparedStaging.targetContract.targetContext.sourceC1Fingerprint,
    approvedAssetIds: preparedStaging.staged.assets.map((asset) => asset.assetId),
    approvedMainImageAssetId: preparedStaging.staged.mainImageAssetId,
    approvedVideoDisposition: preparedStaging.staged.videoDisposition
  };
  const candidateId = initialized.skuPackage.g1Identity.candidateId;
  const transportAuthorizationRef = "transport-authz:c2:repository-fixture";
  const credentialAlias = "credential-alias:oss:repository-fixture";
  const allowedStableAssetHosts = ["assets.example.com"];
  const authorizationRecord = stableTransportAuthorizationRecord({
    skuPackage: initialized.skuPackage,
    sourceRevision: 20,
    resultRevision: 21,
    authorizationRef: transportAuthorizationRef,
    stagedAssetManifestFingerprint: preparedStaging.stagedAssetManifestFingerprint,
    ownerStagingConfirmation,
    allowedStableAssetHosts
  });
  if (mutateAuthorization) mutateAuthorization(authorizationRecord);
  const credentialBinding = stableTransportCredentialBinding({
    skuPackage: initialized.skuPackage,
    credentialAlias,
    allowedStableAssetHosts
  });
  if (mutateCredential) mutateCredential(credentialBinding);
  const repository = createMemoryBusinessStateRepository({
    candidates: [{
      id: candidateId,
      dataRevision: 20,
      workflowStatus: "c2_waiting_final_uploads",
      lifecycleV11: { status: "c2_waiting_final_uploads", platformWrites: 0, skuPackage: initialized.skuPackage }
    }],
    runtime: {
      operationAudit: [],
      idempotencyRecords: [],
      softwareJobs: [],
      softwareJobAuthorizationRecords: includeAuthorization ? [authorizationRecord] : [],
      softwareJobCredentialBindings: includeCredential ? [credentialBinding] : []
    },
    dispatches: []
  });
  const enqueueInput = {
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW, userId: "owner-1" }),
    candidateId,
    expectedCandidateRevision: 20,
    stagedAssets,
    ownerStagingConfirmation,
    transportAuthorizationRef,
    credentialAlias,
    allowedStableAssetHosts,
    serverTime: NOW,
    serverClock: () => NOW
  };
  return {
    initialized,
    stagedAssets,
    preparedStaging,
    ownerStagingConfirmation,
    candidateId,
    transportAuthorizationRef,
    credentialAlias,
    allowedStableAssetHosts,
    repository,
    enqueueInput
  };
}

async function claimAndStartStableTransport({ repository, job, requestAt = NOW }) {
  let clock = NOW;
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: repository,
    serverClock: () => clock,
    workerRegistry: stableTransportWorkerRegistry({ clock: () => clock })
  });
  const worker = createWorkerDescriptor({
    workerId: "worker-stable-transport-1",
    capabilities: ["stable-asset-transport"],
    version: "1.0.0",
    observedAt: NOW
  });
  await store.claim({ jobId: job.jobId, worker, leaseId: "lease-stable-transport-1", leaseDurationMs: 30 * 60_000 });
  clock = requestAt;
  await store.markExternalRequestStarted({
    jobId: job.jobId,
    workerId: worker.workerId,
    leaseId: "lease-stable-transport-1",
    externalRequestRef: "request:c2-stable-transport:repository-fixture"
  });
  clock = LATER;
  const actor = createActorContext({
    userId: worker.workerId,
    sessionId: "session:stable-transport:1",
    actorType: "worker",
    roles: ["operator"],
    source: "stable-asset-transport-worker",
    authenticatedAt: NOW
  });
  return { store, worker, actor, waitingJob: await store.get(job.jobId), clock: () => clock };
}

async function stableTransportSettlementFixture({ rightsExpiresAt = null, receiptAt = LATER, requestAt = NOW } = {}) {
  const fixture = stableTransportFixture({ rightsExpiresAt });
  await enqueueC2StableAssetTransport(fixture.enqueueInput);
  const job = (await fixture.repository.readSnapshot()).runtime.softwareJobs[0];
  const runtime = await claimAndStartStableTransport({ repository: fixture.repository, job, requestAt });
  const snapshot = await fixture.repository.readSnapshot();
  const skuPackage = snapshot.candidates[0].lifecycleV11.skuPackage;
  const jobRef = skuPackage.c2FinalAssets.stableAssetTransport.jobRef;
  const envelope = c2TransportResultEnvelope({
    job: runtime.waitingJob, jobRef, skuPackage, stagedAssets: fixture.stagedAssets,
    stagedAssetManifestFingerprint: fixture.preparedStaging.stagedAssetManifestFingerprint,
    stableUrlPrefix: "https://assets.example.com/late-receipt", settledAt: receiptAt,
    resultRef: "receipt:c2-stable-transport:late-receipt"
  });
  return { fixture, jobRef, skuPackage, envelope, input: {
    repository: fixture.repository, runtimeMode: "local_development", actor: runtime.actor,
    candidateId: fixture.candidateId, jobId: job.jobId, workerId: runtime.worker.workerId,
    leaseId: "lease-stable-transport-1", status: "completed", externalRequestState: "succeeded",
    resultRef: envelope.resultRef, externalRequestRef: runtime.waitingJob.externalRequestRef,
    transportResultEnvelope: envelope, serverTime: NOW, serverClock: () => LATER
  } };
}

test("C2稳定传输直接收口按实际当前时钟拒绝已过期权利且保留主人确认", async () => {
  const { skuPackage, jobRef, envelope } = await stableTransportSettlementFixture({ rightsExpiresAt: LATER });
  const before = structuredClone(skuPackage);
  assert.throws(() => settleC2StableAssetTransport({
    skuPackage, jobRef, transportResultEnvelope: envelope,
    allowedStableAssetHosts: ["assets.example.com"], settledAt: LATER
  }), { code: "C1_SKU_RIGHTS_REVIEW_EXPIRED" });
  assert.deepEqual(skuPackage, before);
});

test("C2晚到稳定回执在当前权利过期后持久保存不应用并可JSON重启幂等回读", async (t) => {
  const receiptAt = "2026-08-22T06:05:00.000Z";
  const { fixture, envelope, input } = await stableTransportSettlementFixture({ rightsExpiresAt: LATER, receiptAt });
  const before = await fixture.repository.readSnapshot();
  const directory = await mkdtemp(path.join(os.tmpdir(), "c2-late-stable-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  await writeFile(filePath, JSON.stringify(before), "utf8");
  const repository = createJsonBusinessStateRepository({ filePath });
  const result = await settleC2StableAssetTransportJob({ ...input, repository });
  assert.equal(result.status, "committed");
  assert.equal(result.result.applicationDisposition, "result_recorded_no_candidate_mutation");
  assert.equal(result.result.applicationBlockReason, "C1_SKU_RIGHTS_REVIEW_EXPIRED");
  const restarted = createJsonBusinessStateRepository({ filePath });
  const persisted = await restarted.readSnapshot();
  assert.deepEqual(persisted.candidates, before.candidates);
  assert.equal(persisted.runtime.softwareJobs.length, 1);
  assert.equal(persisted.runtime.softwareJobs[0].status, "completed");
  assert.equal(persisted.runtime.softwareJobs[0].completedAt, LATER);
  assert.equal(persisted.runtime.softwareJobs[0].resultEnvelope.recordedAt, receiptAt);
  assert.deepEqual(persisted.runtime.softwareJobs[0].resultEnvelope.payload, envelope.payload);
  assert.equal(persisted.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, "result_recorded_no_candidate_mutation");
  assert.deepEqual(persisted.runtime.softwareJobAuthorizationRecords, before.runtime.softwareJobAuthorizationRecords);
  assert.equal(persisted.runtime.softwareJobAuthorizationRecords[0].useCount, 1);
  assert.deepEqual(persisted.dispatches, []);
  assert.equal((await settleC2StableAssetTransportJob({ ...input, repository: restarted })).status, "idempotent_replay");
  assert.deepEqual(await restarted.readSnapshot(), persisted);
  const repeatedJob = structuredClone(persisted.runtime.softwareJobs[0]);
  repeatedJob.jobId = "software-job:c2-stable-asset-transport:repeated-scope";
  repeatedJob.revision += 1;
  repeatedJob.scopeBinding.sourceRevision += 1;
  repeatedJob.scopeBinding.resultRevision += 1;
  assert.throws(() => assertNoSoftwareJobScopeConflict(persisted, repeatedJob), /SOFTWARE_JOB_SCOPE_CONFLICT/);
  const differentStoreJob = structuredClone(repeatedJob);
  differentStoreJob.scopeBinding.storeRef = { stableStoreId: "miska", platformStoreId: "seller-miska-001", mappingVersion: "stores-v1" };
  assert.doesNotThrow(() => assertNoSoftwareJobScopeConflict(persisted, differentStoreJob));
});

test("C2稳定回执按冻结源验证且同revision来源变化只保存结果并明确原因", async () => {
  for (const mutate of [
    pkg => { pkg.g1Identity.storeRef.platformStoreId = "seller:changed"; },
    pkg => { pkg.dataRevision += 1; },
    pkg => { pkg.c1ProductPlan.inputSnapshots.skuRightsReview.reviewId = "rights-review:replacement"; },
    pkg => { pkg.selectedSupplySnapshot.supplierSku.weightKg = 9; },
    pkg => { pkg.c2FinalAssets.stableAssetTransport.stagedAssets[0].sha256 = SHA_F; },
    pkg => { pkg.c2FinalAssets.stableAssetTransport = null; },
    pkg => { pkg.c2FinalAssets.stableAssetTransport.jobRef.jobId = "software-job:c2:replacement"; }
  ]) {
    const { fixture, envelope, input } = await stableTransportSettlementFixture();
    await fixture.repository.transact(async document => {
      mutate(document.candidates[0].lifecycleV11.skuPackage);
      return { changed: true, document, result: null };
    });
    const before = await fixture.repository.readSnapshot();
    const result = await settleC2StableAssetTransportJob(input);
    assert.equal(result.result.applicationDisposition, "result_recorded_no_candidate_mutation");
    assert.equal(result.result.applicationBlockReason, "C2_STABLE_TRANSPORT_SOURCE_CONFLICT");
    const after = await fixture.repository.readSnapshot();
    assert.deepEqual(after.candidates, before.candidates);
    assert.deepEqual(after.runtime.softwareJobs[0].resultEnvelope.payload, envelope.payload);
    assert.equal(after.runtime.softwareJobs[0].status, "completed");
    assert.deepEqual(after.dispatches, []);
    assert.equal((await settleC2StableAssetTransportJob(input)).status, "idempotent_replay");
    assert.deepEqual(await fixture.repository.readSnapshot(), after);
  }
});

test("C2有效晚到回执使用当前完成时间且不重写主人确认或无关备注", async () => {
  const { fixture, input } = await stableTransportSettlementFixture({ receiptAt: "2026-08-22T06:05:00.000Z" });
  await fixture.repository.transact(async document => {
    document.candidates[0].notes = "owner note during transport";
    document.candidates[0].lifecycleV11.skuPackage.audit.updatedAt = "2026-08-22T06:06:00.000Z";
    return { changed: true, document, result: null };
  });
  const before = await fixture.repository.readSnapshot();
  const result = await settleC2StableAssetTransportJob(input);
  assert.equal(result.result.applicationDisposition, "applied");
  const after = await fixture.repository.readSnapshot();
  const c2 = after.candidates[0].lifecycleV11.skuPackage.c2FinalAssets;
  assert.equal(c2.status, "completed");
  assert.equal(c2.updatedAt, LATER);
  assert.equal(after.candidates[0].notes, before.candidates[0].notes);
  assert.deepEqual(c2.stableAssetTransport.ownerStagingConfirmation,
    before.candidates[0].lifecycleV11.skuPackage.c2FinalAssets.stableAssetTransport.ownerStagingConfirmation);
  assert.equal(c2.ownerFinalUploadConfirmation.confirmedAt, NOW);
  assert.equal(c2.productionAuthorizationPreparation.ownerConfirmationAt, NOW);
  assert.equal(after.runtime.softwareJobs[0].completedAt, LATER);
  assert.equal(after.candidates[0].lifecycleV11.skuPackage.productionAuthorization, null);
});

test("C2回执时间不能晚于服务端时钟或早于素材验证且拒绝时零持久化变更", async () => {
  for (const [receiptAt, recordedAt] of [
    ["2026-08-22T06:11:00.000Z", "2026-08-22T06:11:00.000Z"],
    ["2026-08-22T06:05:00.000Z", "2026-08-22T06:04:00.000Z"]
  ]) {
    const { fixture, input } = await stableTransportSettlementFixture({ receiptAt });
    const envelope = { ...input.transportResultEnvelope, recordedAt };
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(() => settleC2StableAssetTransportJob({ ...input, transportResultEnvelope: envelope }), /C2_STABLE_TRANSPORT_RESULT_INVALID/);
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  }
});

test("C2已发请求的过期租约只能持久登记原回执，JSON重启后禁止重领或再发", async (t) => {
  const completedAt = "2026-08-22T06:45:00.000Z";
  const { fixture, envelope, input } = await stableTransportSettlementFixture({ receiptAt: "2026-08-22T06:40:00.000Z" });
  const before = await fixture.repository.readSnapshot();
  const directory = await mkdtemp(path.join(os.tmpdir(), "c2-expired-lease-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  await writeFile(filePath, JSON.stringify(before), "utf8");
  const repository = createJsonBusinessStateRepository({ filePath });
  const settlement = { ...input, repository, serverClock: () => completedAt };
  const result = await settleC2StableAssetTransportJob(settlement);
  assert.equal(result.result.applicationDisposition, "result_recorded_no_candidate_mutation");
  assert.equal(result.result.applicationBlockReason, "C2_STABLE_TRANSPORT_LEASE_EXPIRED");
  const restarted = createJsonBusinessStateRepository({ filePath });
  const persisted = await restarted.readSnapshot();
  assert.deepEqual(persisted.candidates, before.candidates);
  assert.equal(persisted.runtime.softwareJobs[0].completedAt, completedAt);
  assert.equal(persisted.runtime.softwareJobs[0].status, "completed");
  assert.deepEqual(persisted.runtime.softwareJobs[0].resultEnvelope.payload, envelope.payload);
  assert.equal(persisted.runtime.softwareJobs[0].leaseExpiresAt, before.runtime.softwareJobs[0].leaseExpiresAt);
  assert.equal(persisted.runtime.softwareJobs[0].attempt, 1);
  assert.deepEqual(persisted.runtime.softwareJobAuthorizationRecords, before.runtime.softwareJobAuthorizationRecords);
  assert.equal((await settleC2StableAssetTransportJob({ ...settlement, repository: restarted })).status, "idempotent_replay");
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: restarted, serverClock: () => completedAt,
    workerRegistry: stableTransportWorkerRegistry({ clock: () => completedAt })
  });
  await assert.rejects(() => store.claim({
    jobId: input.jobId,
    worker: createWorkerDescriptor({ workerId: input.workerId, capabilities: ["stable-asset-transport"], version: "1.0.0", observedAt: completedAt }),
    leaseId: "lease:replacement", leaseDurationMs: 60_000
  }), /SOFTWARE_JOB/);
  await assert.rejects(() => store.markExternalRequestStarted({
    jobId: input.jobId, workerId: input.workerId, leaseId: input.leaseId,
    externalRequestRef: "request:forbidden:repeat"
  }), /SOFTWARE_JOB/);
  assert.deepEqual(await restarted.readSnapshot(), persisted);
});

test("C2过期回执不得用自报成功绕过未发请求、原Worker或原租约", async () => {
  for (const scenario of ["not_sent", "wrong_worker", "wrong_lease"]) {
    const { fixture, input } = await stableTransportSettlementFixture({ receiptAt: "2026-08-22T06:40:00.000Z" });
    const settlement = { ...input, serverClock: () => "2026-08-22T06:45:00.000Z" };
    if (scenario === "not_sent") {
      await fixture.repository.transact(async document => {
        const job = document.runtime.softwareJobs[0];
        job.status = "claimed";
        job.externalRequestState = "not_sent";
        job.externalRequestRef = null;
        return { changed: true, document, result: null };
      });
    } else if (scenario === "wrong_worker") {
      settlement.workerId = "worker:unassigned";
      settlement.actor = { ...input.actor, userId: settlement.workerId };
      settlement.transportResultEnvelope = { ...input.transportResultEnvelope, workerId: settlement.workerId };
    } else {
      settlement.leaseId = "lease:unassigned";
      settlement.transportResultEnvelope = { ...input.transportResultEnvelope, leaseId: settlement.leaseId };
    }
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(() => settleC2StableAssetTransportJob(settlement), /C2_STABLE_TRANSPORT_RESULT_REJECTED|SOFTWARE_JOB_LEASE_REJECTED/);
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  }
});

test("C2稳定回执验证时间不得早于持久请求发出时刻", async () => {
  for (const recordedAt of ["2026-08-22T06:02:00.000Z", "2026-08-22T06:05:00.000Z"]) {
    const { fixture, input } = await stableTransportSettlementFixture({
      requestAt: "2026-08-22T06:03:00.000Z", receiptAt: "2026-08-22T06:02:00.000Z"
    });
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(() => settleC2StableAssetTransportJob({
      ...input, transportResultEnvelope: { ...input.transportResultEnvelope, recordedAt }
    }), /C2_STABLE_TRANSPORT_RESULT_BEFORE_REQUEST/);
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  }
});

test("C2真实reconcile与JSON重启后晚回执只追加一份对账证据且保留unknown终态", async (t) => {
  const requestAt = "2026-08-22T06:03:00.000Z";
  const receiptAt = "2026-08-22T06:05:00.000Z";
  const lateAt = "2026-08-22T06:45:00.000Z";
  for (const [method, reconciledAt] of [
    ["reconcileExpiredLeases", "2026-08-22T06:35:00.000Z"],
    ["reconcileAfterRestart", "2026-08-22T06:08:00.000Z"]
  ]) {
    const { fixture, envelope, input } = await stableTransportSettlementFixture({ requestAt, receiptAt });
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2-reconciled-late-receipt-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "state.json");
    const waiting = await fixture.repository.readSnapshot();
    await writeFile(filePath, JSON.stringify(waiting), "utf8");
    const repository = createJsonBusinessStateRepository({ filePath });
    const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: repository, serverClock: () => reconciledAt });
    assert.deepEqual((await store[method]()).reconciled, [input.jobId]);
    const reconciled = await repository.readSnapshot();
    assert.equal(reconciled.runtime.softwareJobs[0].status, "unknown_outcome");
    assert.equal(reconciled.runtime.softwareJobs[0].lastProgressAt, requestAt);
    assert.equal(reconciled.runtime.softwareJobs[0].progressRef, input.externalRequestRef);
    assert.equal(reconciled.runtime.softwareJobs[0].completedAt, reconciledAt);
    const restarted = createJsonBusinessStateRepository({ filePath });
    const settlement = { ...input, repository: restarted, serverClock: () => lateAt };
    const concurrent = await Promise.all([settleC2StableAssetTransportJob(settlement), settleC2StableAssetTransportJob(settlement)]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), ["committed", "idempotent_replay"]);
    const result = concurrent.find(entry => entry.status === "committed");
    assert.equal(result.result.status, "unknown_outcome");
    assert.equal(result.result.applicationDisposition, "result_recorded_no_candidate_mutation");
    assert.equal(result.result.applicationBlockReason, "C2_STABLE_TRANSPORT_RECONCILIATION_REQUIRED");
    assert.equal(result.result.reconciliationRequestStartedAt, requestAt);
    assert.equal(result.result.reconciliationEvidenceRecordedAt, lateAt);
    assert.deepEqual(result.result.transportResultEnvelope.payload, envelope.payload);
    const secondRestart = createJsonBusinessStateRepository({ filePath });
    const persisted = await secondRestart.readSnapshot();
    assert.deepEqual(persisted.candidates, reconciled.candidates);
    assert.deepEqual(persisted.runtime.softwareJobs, reconciled.runtime.softwareJobs);
    assert.deepEqual(persisted.runtime.softwareJobAuthorizationRecords, reconciled.runtime.softwareJobAuthorizationRecords);
    assert.equal(persisted.runtime.idempotencyRecords.length, reconciled.runtime.idempotencyRecords.length + 1);
    assert.deepEqual(persisted.runtime.idempotencyRecords.at(-1).result, result.result);
    assert.deepEqual(persisted.dispatches, []);
    assert.equal((await settleC2StableAssetTransportJob({ ...settlement, repository: secondRestart })).status, "idempotent_replay");
    await assert.rejects(() => settleC2StableAssetTransportJob({
      ...settlement, repository: secondRestart, resultRef: "receipt:c2:second-late-result",
      transportResultEnvelope: { ...envelope, resultRef: "receipt:c2:second-late-result" }
    }), /C2_STABLE_TRANSPORT_RECONCILIATION_EVIDENCE_CONFLICT/);
    assert.deepEqual(await secondRestart.readSnapshot(), persisted);
    const stoppedStore = createRepositoryBackedSoftwareJobStore({ businessStateRepository: secondRestart, serverClock: () => lateAt });
    assert.deepEqual((await stoppedStore.reconcileAfterRestart()).reconciled, []);
    assert.deepEqual(await stoppedStore.listWaitingPlatform(), []);
  }
});

test("C2已经对账的原Worker晚回执仍拒绝错误holder和请求前时间", async () => {
  for (const scenario of ["wrong_worker", "wrong_lease", "before_request", "missing_request_ref"]) {
    const requestAt = "2026-08-22T06:03:00.000Z";
    const { fixture, input } = await stableTransportSettlementFixture({
      requestAt, receiptAt: scenario === "before_request" ? "2026-08-22T06:02:00.000Z" : "2026-08-22T06:05:00.000Z"
    });
    const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: fixture.repository, serverClock: () => LATER });
    await store.reconcileAfterRestart();
    const settlement = { ...input, serverClock: () => "2026-08-22T06:15:00.000Z" };
    if (scenario === "wrong_worker") {
      settlement.workerId = "worker:unassigned";
      settlement.actor = { ...input.actor, userId: settlement.workerId };
      settlement.transportResultEnvelope = { ...input.transportResultEnvelope, workerId: settlement.workerId };
    } else if (scenario === "wrong_lease") {
      settlement.leaseId = "lease:unassigned";
      settlement.transportResultEnvelope = { ...input.transportResultEnvelope, leaseId: settlement.leaseId };
    } else if (scenario === "missing_request_ref") {
      await fixture.repository.transact(async document => {
        document.runtime.softwareJobs[0].externalRequestRef = null;
        return { changed: true, document, result: null };
      });
    }
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(() => settleC2StableAssetTransportJob(settlement),
      /SOFTWARE_JOB_LEASE_REJECTED|C2_STABLE_TRANSPORT_RESULT_BEFORE_REQUEST|C2_STABLE_TRANSPORT_RESULT_REJECTED/);
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  }
});

test("C2旧unknown记录未保留请求时刻时仅保存缺口证据，不猜时间或改原终态", async () => {
  const { fixture, envelope, input } = await stableTransportSettlementFixture({
    requestAt: "2026-08-22T06:03:00.000Z", receiptAt: "2026-08-22T06:05:00.000Z"
  });
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: fixture.repository, serverClock: () => LATER });
  await store.reconcileAfterRestart();
  await fixture.repository.transact(async document => {
    const job = document.runtime.softwareJobs[0];
    job.lastProgressAt = job.completedAt;
    job.progressRef = null;
    return { changed: true, document, result: null };
  });
  const before = await fixture.repository.readSnapshot();
  const result = await settleC2StableAssetTransportJob({ ...input, serverClock: () => "2026-08-22T06:15:00.000Z" });
  assert.equal(result.result.applicationBlockReason, "C2_STABLE_TRANSPORT_REQUEST_START_TIME_UNAVAILABLE");
  assert.equal(result.result.reconciliationRequestStartedAt, null);
  assert.equal(result.result.applicationDisposition, "result_recorded_no_candidate_mutation");
  assert.deepEqual(result.result.transportResultEnvelope.payload, envelope.payload);
  const after = await fixture.repository.readSnapshot();
  assert.deepEqual(after.candidates, before.candidates);
  assert.deepEqual(after.runtime.softwareJobs, before.runtime.softwareJobs);
  assert.deepEqual(after.runtime.idempotencyRecords.at(-1).result, result.result);
});

test("C2稳定传输以staged文件身份确认并只在verified结果后重算final manifest", () => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const pkg = initialized.skuPackage;
  const stagedAssets = finalAssets().map(({ assetRef: _assetRef, stableUrlEvidenceRef: _stableUrlEvidenceRef, ...asset }) => ({
    ...asset
  }));
  const preparedStaging = prepareC2StableAssetTransportManifest({ skuPackage: pkg, stagedAssets });
  const stagedAssetManifestFingerprint = preparedStaging.stagedAssetManifestFingerprint;
  const jobRef = {
    schemaVersion: "c2-stable-asset-transport-job-ref-v1",
    jobId: "software-job:c2-stable-asset-transport:fixture",
    jobType: "c2_stable_asset_transport",
    candidateId: pkg.g1Identity.candidateId,
    skuPackageId: pkg.skuPackageId,
    sourceRevision: 20,
    resultRevision: 21,
    inputFingerprint: SHA_A
  };
  const ownerStagingConfirmation = {
    schemaVersion: "c2-owner-staging-confirmation-v1",
    status: "confirmed",
    confirmedBy: "owner",
    confirmedByUserId: "owner-1",
    confirmedAt: NOW,
    confirmationRef: "owner-confirmation:c2-staging:fixture",
    approvedStagedAssetManifestFingerprint: stagedAssetManifestFingerprint,
    approvedSourceC1Fingerprint: preparedStaging.targetContract.targetContext.sourceC1Fingerprint,
    approvedAssetIds: stagedAssets.map((asset) => asset.assetId),
    approvedMainImageAssetId: stagedAssets[0].assetId,
    approvedVideoDisposition: "excludes_video"
  };
  assert.equal(ownerStagingConfirmation.approvedStagedAssetManifestFingerprint, preparedStaging.stagedAssetManifestFingerprint);
  assert.equal(ownerStagingConfirmation.approvedSourceC1Fingerprint, preparedStaging.targetContract.targetContext.sourceC1Fingerprint);
  assert.deepEqual(ownerStagingConfirmation.approvedAssetIds, preparedStaging.staged.assets.map((asset) => asset.assetId));
  assert.equal(ownerStagingConfirmation.approvedMainImageAssetId, preparedStaging.staged.mainImageAssetId);
  assert.equal(ownerStagingConfirmation.approvedVideoDisposition, preparedStaging.staged.videoDisposition);
  const staged = stageC2StableAssetTransport({
    skuPackage: pkg, stagedAssets, ownerStagingConfirmation, jobRef, stagedAt: NOW
  });
  assert.equal(staged.skuPackage.c2FinalAssets.status, "awaiting_final_uploads");
  assert.deepEqual(staged.skuPackage.c2FinalAssets.assets.finalUploads, []);
  assert.equal(staged.skuPackage.c2FinalAssets.productionAuthorizationPreparation, null);
  assert.equal("assetRef" in staged.skuPackage.c2FinalAssets.stableAssetTransport.stagedAssets[0], false);

  const envelopeJob = transportEnvelopeJob(jobRef);
  const transportResultEnvelope = c2TransportResultEnvelope({
    job: envelopeJob,
    jobRef,
    skuPackage: staged.skuPackage,
    stagedAssets,
    stagedAssetManifestFingerprint,
    stableUrlPrefix: "https://assets.example.com/final",
    settledAt: LATER,
    resultRef: "receipt:c2-stable-transport:fixture"
  });
  const completed = settleC2StableAssetTransport({
    skuPackage: staged.skuPackage,
    jobRef,
    transportResultEnvelope,
    allowedStableAssetHosts: ["assets.example.com"],
    settledAt: LATER
  });
  assert.equal(completed.skuPackage.c2FinalAssets.status, "completed");
  assert.equal(completed.skuPackage.c2FinalAssets.stableAssetTransport.status, "verified");
  assert.notEqual(
    completed.skuPackage.c2FinalAssets.stableAssetTransport.transportResult.payload.finalManifestSha256,
    stagedAssetManifestFingerprint
  );
  assert.equal(completed.skuPackage.c2FinalAssets.productionAuthorizationPreparation.productionAuthorizationCreated, false);
  assert.equal(completed.skuPackage.c2FinalAssets.productionAuthorizationPreparation.dHandoffCreated, false);

  for (const [caseIndex, mutate] of [
    (result) => { result.assets[0].sha256 = SHA_F; },
    (result) => { result.assets.reverse(); },
    (result) => { result.assets[0].stableUrl = "https://other.example.com/final/1.jpg"; },
    (result) => { result.assets[0].stableUrl = "https://localhost/final/1.jpg"; },
    (result) => { result.assets[0].stableUrl = "https://assets.example.com/final/1.jpg?signature=secret"; },
    (result) => { result.assets[0].stableUrl = "file:///tmp/final.jpg"; },
    (result) => { result.finalManifestSha256 = SHA_F; }
  ].entries()) {
    assert.throws(() => settleC2StableAssetTransport({
      skuPackage: staged.skuPackage,
      jobRef,
      transportResultEnvelope: c2TransportResultEnvelope({
        job: envelopeJob,
        jobRef,
        skuPackage: staged.skuPackage,
        stagedAssets,
        stagedAssetManifestFingerprint,
        stableUrlPrefix: "https://assets.example.com/final",
        settledAt: LATER,
        resultRef: `receipt:c2-stable-transport:drift:${caseIndex}`,
        mutatePayload: mutate
      }),
      allowedStableAssetHosts: ["assets.example.com"],
      settledAt: LATER
    }), /C2_STABLE_TRANSPORT|C2_FINAL_ASSET|C2_REFERENCE|PRODUCTION_AUTHORIZATION|RUNTIME_IDENTITY_INVALID/);
  }
});

test("B3-0a同一Repository事务排队并收口唯一C2稳定传输作业", async (t) => {
  const initialized = createC2SoftwareContainer({
    skuPackage: packageFixture(), expectedDataRevision: 7, assetRegions: assetRegions(), createdAt: NOW
  });
  const stagedAssets = finalAssets().map(({ assetRef: _assetRef, stableUrlEvidenceRef: _stableUrlEvidenceRef, ...asset }) => ({
    ...asset
  }));
  const preparedStaging = prepareC2StableAssetTransportManifest({ skuPackage: initialized.skuPackage, stagedAssets });
  const ownerStagingConfirmation = {
    schemaVersion: "c2-owner-staging-confirmation-v1",
    status: "confirmed",
    confirmedBy: "owner",
    confirmedByUserId: "owner-1",
    confirmedAt: NOW,
    confirmationRef: "owner-confirmation:c2-staging:repository-fixture",
    approvedStagedAssetManifestFingerprint: preparedStaging.stagedAssetManifestFingerprint,
    approvedSourceC1Fingerprint: preparedStaging.targetContract.targetContext.sourceC1Fingerprint,
    approvedAssetIds: preparedStaging.staged.assets.map((asset) => asset.assetId),
    approvedMainImageAssetId: preparedStaging.staged.mainImageAssetId,
    approvedVideoDisposition: preparedStaging.staged.videoDisposition
  };
  const candidateId = initialized.skuPackage.g1Identity.candidateId;
  const transportAuthorizationRef = "transport-authz:c2:repository-fixture";
  const credentialAlias = "credential-alias:oss:repository-fixture";
  const allowedStableAssetHosts = ["assets.example.com"];
  const repository = createMemoryBusinessStateRepository({
    candidates: [{
      id: candidateId,
      dataRevision: 20,
      workflowStatus: "c2_waiting_final_uploads",
      lifecycleV11: { status: "c2_waiting_final_uploads", platformWrites: 0, skuPackage: initialized.skuPackage }
    }],
    runtime: {
      operationAudit: [],
      idempotencyRecords: [],
      softwareJobs: [],
      softwareJobAuthorizationRecords: [stableTransportAuthorizationRecord({
        skuPackage: initialized.skuPackage,
        sourceRevision: 20,
        resultRevision: 21,
        authorizationRef: transportAuthorizationRef,
        stagedAssetManifestFingerprint: preparedStaging.stagedAssetManifestFingerprint,
        ownerStagingConfirmation,
        allowedStableAssetHosts
      })],
      softwareJobCredentialBindings: [stableTransportCredentialBinding({
        skuPackage: initialized.skuPackage,
        credentialAlias,
        allowedStableAssetHosts
      })]
    },
    dispatches: []
  });
  const enqueueInput = {
    repository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW, userId: "owner-1" }),
    candidateId,
    expectedCandidateRevision: 20,
    stagedAssets,
    ownerStagingConfirmation,
    transportAuthorizationRef,
    credentialAlias,
    allowedStableAssetHosts,
    serverTime: NOW,
    serverClock: () => NOW
  };
  const enqueued = await enqueueC2StableAssetTransport(enqueueInput);
  assert.equal(enqueued.status, "committed");
  const afterEnqueue = await repository.readSnapshot();
  assert.equal(afterEnqueue.candidates[0].dataRevision, 21);
  assert.equal(afterEnqueue.candidates[0].lifecycleV11.skuPackage.c2FinalAssets.status, "awaiting_final_uploads");
  assert.deepEqual(afterEnqueue.candidates[0].lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads, []);
  assert.equal(afterEnqueue.runtime.softwareJobs.length, 1);
  assert.doesNotThrow(() => assertValidLifecyclePackage(afterEnqueue.candidates[0].lifecycleV11.skuPackage));
  const job = afterEnqueue.runtime.softwareJobs[0];
  assert.equal(job.revision, 21);
  assert.deepEqual(job.requiredCapabilities, ["stable-asset-transport"]);
  assert.equal(job.scopeBinding.stagedAssetManifestFingerprint, preparedStaging.stagedAssetManifestFingerprint);
  assert.equal((await enqueueC2StableAssetTransport(enqueueInput)).status, "idempotent_replay");

  const restartDirectory = await mkdtemp(path.join(os.tmpdir(), "c2-stable-transport-restart-"));
  t.after(() => rm(restartDirectory, { recursive: true, force: true }));
  const restartFile = path.join(restartDirectory, "business-state.json");
  await writeFile(restartFile, JSON.stringify(afterEnqueue), "utf8");
  const transportRepository = createJsonBusinessStateRepository({ filePath: restartFile });

  let clock = NOW;
  const store = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: transportRepository,
    serverClock: () => clock,
    workerRegistry: stableTransportWorkerRegistry({ clock: () => clock })
  });
  const worker = createWorkerDescriptor({
    workerId: "worker-stable-transport-1",
    capabilities: ["stable-asset-transport"],
    version: "1.0.0",
    observedAt: NOW
  });
  await store.claim({ jobId: job.jobId, worker, leaseId: "lease-stable-transport-1", leaseDurationMs: 30 * 60_000 });
  const workerActor = createActorContext({
    userId: worker.workerId,
    sessionId: "session:stable-transport:1",
    actorType: "worker",
    roles: ["operator"],
    source: "stable-asset-transport-worker",
    authenticatedAt: NOW
  });
  const beforePrematureSettlement = await transportRepository.readSnapshot();
  await assert.rejects(() => settleC2StableAssetTransportJob({
    repository: transportRepository,
    runtimeMode: "local_development",
    actor: workerActor,
    candidateId,
    jobId: job.jobId,
    workerId: worker.workerId,
    leaseId: "lease-stable-transport-1",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: "receipt:premature",
    transportResultEnvelope: {},
    serverTime: NOW,
    serverClock: () => clock
  }), /必须从已持久化in_flight收口/);
  assert.deepEqual(await transportRepository.readSnapshot(), beforePrematureSettlement);
  await store.markExternalRequestStarted({
    jobId: job.jobId,
    workerId: worker.workerId,
    leaseId: "lease-stable-transport-1",
    externalRequestRef: "request:c2-stable-transport:repository-fixture"
  });
  clock = LATER;
  const waitingJob = await store.get(job.jobId);
  assert.deepEqual([waitingJob.status, waitingJob.externalRequestState], ["waiting_platform", "in_flight"]);
  const stagedSnapshot = await transportRepository.readSnapshot();
  const stagedSkuPackage = stagedSnapshot.candidates[0].lifecycleV11.skuPackage;
  const stagedJobRef = stagedSkuPackage.c2FinalAssets.stableAssetTransport.jobRef;
  const transportResultEnvelope = c2TransportResultEnvelope({
    job: waitingJob,
    jobRef: stagedJobRef,
    skuPackage: stagedSkuPackage,
    stagedAssets,
    stagedAssetManifestFingerprint: preparedStaging.stagedAssetManifestFingerprint,
    stableUrlPrefix: "https://assets.example.com/repository",
    settledAt: LATER,
    resultRef: "receipt:c2-stable-transport:repository-fixture"
  });
  const beforeForgedSettlement = await transportRepository.readSnapshot();
  await assert.rejects(() => settleC2StableAssetTransportJob({
    repository: transportRepository,
    runtimeMode: "local_development",
    actor: createLocalDevelopmentActor({ at: NOW, userId: "owner-1" }),
    candidateId,
    jobId: job.jobId,
    workerId: worker.workerId,
    leaseId: "lease-stable-transport-1",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: "receipt:forged",
    externalRequestRef: "request:c2-stable-transport:repository-fixture",
    transportResultEnvelope,
    serverTime: LATER,
    serverClock: () => clock
  }), /WORKER_IDENTITY/);
  assert.deepEqual(await transportRepository.readSnapshot(), beforeForgedSettlement);
  const beforeLeaseRejection = await transportRepository.readSnapshot();
  await assert.rejects(() => settleC2StableAssetTransportJob({
    repository: transportRepository,
    runtimeMode: "local_development",
    actor: workerActor,
    candidateId,
    jobId: job.jobId,
    workerId: worker.workerId,
    leaseId: "lease-other",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: "receipt:wrong-lease",
    externalRequestRef: "request:c2-stable-transport:repository-fixture",
    transportResultEnvelope,
    serverTime: LATER,
    serverClock: () => clock
  }), /LEASE_REJECTED|租约/);
  assert.deepEqual(await transportRepository.readSnapshot(), beforeLeaseRejection);
  const settlementInput = {
    repository: transportRepository,
    runtimeMode: "local_development",
    actor: workerActor,
    candidateId,
    jobId: job.jobId,
    workerId: worker.workerId,
    leaseId: "lease-stable-transport-1",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: "receipt:c2-stable-transport:repository-fixture",
    externalRequestRef: "request:c2-stable-transport:repository-fixture",
    transportResultEnvelope,
    serverTime: LATER,
    serverClock: () => clock
  };
  const settled = await settleC2StableAssetTransportJob(settlementInput);
  assert.equal(settled.status, "committed");
  const afterSettlement = await transportRepository.readSnapshot();
  const storedSku = afterSettlement.candidates[0].lifecycleV11.skuPackage;
  assert.equal(afterSettlement.candidates[0].dataRevision, 22);
  assert.equal(afterSettlement.runtime.softwareJobs[0].status, "completed");
  assert.equal(storedSku.c2FinalAssets.status, "completed");
  assert.equal(storedSku.c2FinalAssets.stableAssetTransport.status, "verified");
  assert.equal(storedSku.productionAuthorization, null);
  assert.equal(storedSku.c2FinalAssets.productionAuthorizationPreparation.productionAuthorizationCreated, false);
  assert.equal(storedSku.c2FinalAssets.productionAuthorizationPreparation.dHandoffCreated, false);
  assert.equal(afterSettlement.dispatches.length, 0);
  assert.equal(
    afterSettlement.runtime.softwareJobs[0].resultEnvelope.payload.finalManifestSha256,
    storedSku.c2FinalAssets.stableAssetTransport.transportResult.payload.finalManifestSha256
  );
  assert.equal((await settleC2StableAssetTransportJob(settlementInput)).status, "idempotent_replay");

  for (const terminal of ["failed", "unknown_outcome"]) {
    let terminalClock = NOW;
    const terminalRepository = createMemoryBusinessStateRepository(afterEnqueue);
    const terminalWorker = createWorkerDescriptor({
      workerId: `worker-${terminal}`,
      capabilities: ["stable-asset-transport"],
      version: "1.0.0",
      observedAt: NOW
    });
    const terminalStore = createRepositoryBackedSoftwareJobStore({
      businessStateRepository: terminalRepository,
      serverClock: () => terminalClock,
      workerRegistry: stableTransportWorkerRegistry({
        clock: () => terminalClock,
        workerIds: [terminalWorker.workerId]
      })
    });
    const terminalLease = `lease-${terminal}`;
    await terminalStore.claim({ jobId: job.jobId, worker: terminalWorker, leaseId: terminalLease, leaseDurationMs: 30 * 60_000 });
    const requestRef = terminal === "unknown_outcome" ? `request:${terminal}` : null;
    if (requestRef) await terminalStore.markExternalRequestStarted({
      jobId: job.jobId,
      workerId: terminalWorker.workerId,
      leaseId: terminalLease,
      externalRequestRef: requestRef
    });
    terminalClock = LATER;
    const candidateBeforeTerminal = (await terminalRepository.readSnapshot()).candidates[0];
    const terminalActor = createActorContext({
      userId: terminalWorker.workerId,
      sessionId: `session:${terminal}`,
      actorType: "worker",
      roles: ["operator"],
      source: "stable-asset-transport-worker",
      authenticatedAt: NOW
    });
    const terminalResult = await settleC2StableAssetTransportJob({
      repository: terminalRepository,
      runtimeMode: "local_development",
      actor: terminalActor,
      candidateId,
      jobId: job.jobId,
      workerId: terminalWorker.workerId,
      leaseId: terminalLease,
      status: terminal,
      externalRequestState: terminal === "failed" ? "not_sent" : "unknown_outcome",
      failureClass: terminal === "failed" ? "transport_failed_before_request" : null,
      externalRequestRef: requestRef,
      transportResultEnvelope: null,
      serverTime: LATER,
      serverClock: () => terminalClock
    });
    assert.equal(terminalResult.status, "committed");
    const terminalSnapshot = await terminalRepository.readSnapshot();
    assert.deepEqual(terminalSnapshot.candidates[0], candidateBeforeTerminal);
    assert.equal(terminalSnapshot.runtime.softwareJobs[0].status, terminal);
    assert.equal(terminalSnapshot.candidates[0].lifecycleV11.skuPackage.productionAuthorization, null);
    assert.equal(terminalSnapshot.dispatches.length, 0);
  }
});

test("B3-0b稳定传输admission在enqueue/claim/request阶段fail-closed且零下游", async () => {
  const enqueueRejects = [
    ["missing authorization", { includeAuthorization: false }, /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_REQUIRED/],
    ["missing credential", { includeCredential: false }, /SOFTWARE_JOB_ADMISSION_CREDENTIAL_REQUIRED/],
    ["authorization drift", {
      mutateAuthorization: (record) => { record.stagedAssetManifestFingerprint = SHA_C; }
    }, /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH/],
    ["authorization expired", {
      mutateAuthorization: (record) => { record.expiresAt = "2026-08-22T05:59:59.000Z"; }
    }, /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_EXPIRED/],
    ["credential host drift", {
      mutateCredential: (record) => { record.allowedStableAssetHosts = ["other.example.com"]; }
    }, /SOFTWARE_JOB_ADMISSION_CREDENTIAL_MISMATCH/],
    ["credential expired", {
      mutateCredential: (record) => { record.expiresAt = "2026-08-22T05:59:59.000Z"; }
    }, /SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED/]
  ];
  for (const [_name, options, pattern] of enqueueRejects) {
    const fixture = stableTransportFixture(options);
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(() => enqueueC2StableAssetTransport(fixture.enqueueInput), pattern);
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  }

  const claimFixture = stableTransportFixture();
  await enqueueC2StableAssetTransport(claimFixture.enqueueInput);
  await claimFixture.repository.transact(async (document) => {
    document.runtime.softwareJobCredentialBindings[0].expiresAt = "2026-08-22T05:59:59.000Z";
    return { changed: true, document, result: null };
  });
  const claimStore = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: claimFixture.repository,
    serverClock: () => NOW,
    workerRegistry: stableTransportWorkerRegistry()
  });
  const worker = createWorkerDescriptor({
    workerId: "worker-stable-transport-1",
    capabilities: ["stable-asset-transport"],
    version: "1.0.0",
    observedAt: NOW
  });
  const queuedJob = (await claimFixture.repository.readSnapshot()).runtime.softwareJobs[0];
  await assert.rejects(() => claimStore.claim({
    jobId: queuedJob.jobId,
    worker,
    leaseId: "lease-stable-transport-1",
    leaseDurationMs: 30 * 60_000
  }), /SOFTWARE_JOB_ADMISSION_CREDENTIAL_EXPIRED/);
  assert.deepEqual(
    [(await claimStore.get(queuedJob.jobId)).status, (await claimStore.get(queuedJob.jobId)).externalRequestState],
    ["queued", "not_sent"]
  );

  const requestFixture = stableTransportFixture();
  await enqueueC2StableAssetTransport(requestFixture.enqueueInput);
  const requestStore = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: requestFixture.repository,
    serverClock: () => NOW,
    workerRegistry: stableTransportWorkerRegistry()
  });
  const requestJob = (await requestFixture.repository.readSnapshot()).runtime.softwareJobs[0];
  await requestStore.claim({
    jobId: requestJob.jobId,
    worker,
    leaseId: "lease-stable-transport-1",
    leaseDurationMs: 30 * 60_000
  });
  await requestFixture.repository.transact(async (document) => {
    document.runtime.softwareJobAuthorizationRecords[0].allowedStableAssetHosts = ["other.example.com"];
    return { changed: true, document, result: null };
  });
  await assert.rejects(() => requestStore.markExternalRequestStarted({
    jobId: requestJob.jobId,
    workerId: worker.workerId,
    leaseId: "lease-stable-transport-1",
    externalRequestRef: "request:c2-stable-transport:request-drift"
  }), /SOFTWARE_JOB_ADMISSION_AUTHORIZATION_MISMATCH/);
  assert.deepEqual(
    [(await requestStore.get(requestJob.jobId)).status, (await requestStore.get(requestJob.jobId)).externalRequestState],
    ["claimed", "not_sent"]
  );
  assert.equal((await requestFixture.repository.readSnapshot()).dispatches.length, 0);
});

test("B3-0c旧revision completed只记录合法封套且伪造C2结果零写入", async () => {
  const fixture = stableTransportFixture();
  await enqueueC2StableAssetTransport(fixture.enqueueInput);
  const job = (await fixture.repository.readSnapshot()).runtime.softwareJobs[0];
  const { worker, actor, waitingJob, clock: transportClock } = await claimAndStartStableTransport({ repository: fixture.repository, job });
  const stagedSnapshot = await fixture.repository.readSnapshot();
  const stagedSkuPackage = stagedSnapshot.candidates[0].lifecycleV11.skuPackage;
  const stagedJobRef = stagedSkuPackage.c2FinalAssets.stableAssetTransport.jobRef;
  const validEnvelope = c2TransportResultEnvelope({
    job: waitingJob,
    jobRef: stagedJobRef,
    skuPackage: stagedSkuPackage,
    stagedAssets: fixture.stagedAssets,
    stagedAssetManifestFingerprint: fixture.preparedStaging.stagedAssetManifestFingerprint,
    stableUrlPrefix: "https://assets.example.com/revision-conflict",
    settledAt: LATER,
    resultRef: "receipt:c2-stable-transport:revision-conflict"
  });
  await fixture.repository.transact(async (document) => {
    document.candidates[0].dataRevision = 22;
    document.candidates[0].workflowStatus = "c2_changed_after_transport_request";
    return { changed: true, document, result: null };
  });
  const beforeRevisionConflict = await fixture.repository.readSnapshot();
  const result = await settleC2StableAssetTransportJob({
    repository: fixture.repository,
    runtimeMode: "local_development",
    actor,
    candidateId: fixture.candidateId,
    jobId: job.jobId,
    workerId: worker.workerId,
    leaseId: "lease-stable-transport-1",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: validEnvelope.resultRef,
    externalRequestRef: "request:c2-stable-transport:repository-fixture",
    transportResultEnvelope: validEnvelope,
    serverTime: LATER,
    serverClock: transportClock
  });
  assert.equal(result.status, "committed");
  const afterRevisionConflict = await fixture.repository.readSnapshot();
  assert.deepEqual(afterRevisionConflict.candidates[0], beforeRevisionConflict.candidates[0]);
  assert.equal(afterRevisionConflict.runtime.softwareJobs[0].status, "completed");
  assert.equal(afterRevisionConflict.runtime.softwareJobs[0].resultEnvelope.applicationDisposition, "revision_conflict_not_applied");
  assert.equal(afterRevisionConflict.runtime.softwareJobs[0].resultEnvelope.payload.finalManifestSha256, validEnvelope.payload.finalManifestSha256);
  assert.equal(afterRevisionConflict.dispatches.length, 0);
  assert.equal(afterRevisionConflict.candidates[0].lifecycleV11.skuPackage.productionAuthorization, null);
  assert.equal(afterRevisionConflict.candidates[0].lifecycleV11.skuPackage.c2FinalAssets.stableAssetTransport.status, "awaiting_verified_result");

  const forgedFixture = stableTransportFixture();
  await enqueueC2StableAssetTransport(forgedFixture.enqueueInput);
  const forgedJob = (await forgedFixture.repository.readSnapshot()).runtime.softwareJobs[0];
  const forgedRuntime = await claimAndStartStableTransport({ repository: forgedFixture.repository, job: forgedJob });
  const forgedStagedSnapshot = await forgedFixture.repository.readSnapshot();
  const forgedSkuPackage = forgedStagedSnapshot.candidates[0].lifecycleV11.skuPackage;
  const forgedJobRef = forgedSkuPackage.c2FinalAssets.stableAssetTransport.jobRef;
  const forgedEnvelope = c2TransportResultEnvelope({
    job: forgedRuntime.waitingJob,
    jobRef: forgedJobRef,
    skuPackage: forgedSkuPackage,
    stagedAssets: forgedFixture.stagedAssets,
    stagedAssetManifestFingerprint: forgedFixture.preparedStaging.stagedAssetManifestFingerprint,
    stableUrlPrefix: "https://assets.example.com/forged",
    settledAt: LATER,
    resultRef: "receipt:c2-stable-transport:forged-host",
    mutatePayload: (payload) => { payload.assets[0].stableUrl = "https://other.example.com/forged/1.jpg"; }
  });
  await forgedFixture.repository.transact(async (document) => {
    document.candidates[0].dataRevision = 22;
    return { changed: true, document, result: null };
  });
  const beforeForged = await forgedFixture.repository.readSnapshot();
  await assert.rejects(() => settleC2StableAssetTransportJob({
    repository: forgedFixture.repository,
    runtimeMode: "local_development",
    actor: forgedRuntime.actor,
    candidateId: forgedFixture.candidateId,
    jobId: forgedJob.jobId,
    workerId: forgedRuntime.worker.workerId,
    leaseId: "lease-stable-transport-1",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: forgedEnvelope.resultRef,
    externalRequestRef: "request:c2-stable-transport:repository-fixture",
    transportResultEnvelope: forgedEnvelope,
    serverTime: LATER,
    serverClock: forgedRuntime.clock
  }), /C2_STABLE_TRANSPORT_RESULT_INVALID/);
  assert.deepEqual(await forgedFixture.repository.readSnapshot(), beforeForged);
});

test("B3-0d封套payload漂移和JSON原子写失败都保持C2逐字不变", async (t) => {
  const driftFixture = stableTransportFixture();
  await enqueueC2StableAssetTransport(driftFixture.enqueueInput);
  const driftJob = (await driftFixture.repository.readSnapshot()).runtime.softwareJobs[0];
  const driftRuntime = await claimAndStartStableTransport({ repository: driftFixture.repository, job: driftJob });
  const stagedSnapshot = await driftFixture.repository.readSnapshot();
  const stagedSkuPackage = stagedSnapshot.candidates[0].lifecycleV11.skuPackage;
  const stagedJobRef = stagedSkuPackage.c2FinalAssets.stableAssetTransport.jobRef;
  const driftEnvelope = c2TransportResultEnvelope({
    job: driftRuntime.waitingJob,
    jobRef: stagedJobRef,
    skuPackage: stagedSkuPackage,
    stagedAssets: driftFixture.stagedAssets,
    stagedAssetManifestFingerprint: driftFixture.preparedStaging.stagedAssetManifestFingerprint,
    stableUrlPrefix: "https://assets.example.com/payload-drift",
    settledAt: LATER,
    resultRef: "receipt:c2-stable-transport:payload-drift"
  });
  driftEnvelope.payload.assets[0].sha256 = SHA_G;
  const beforeDrift = await driftFixture.repository.readSnapshot();
  await assert.rejects(() => settleC2StableAssetTransportJob({
    repository: driftFixture.repository,
    runtimeMode: "local_development",
    actor: driftRuntime.actor,
    candidateId: driftFixture.candidateId,
    jobId: driftJob.jobId,
    workerId: driftRuntime.worker.workerId,
    leaseId: "lease-stable-transport-1",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: driftEnvelope.resultRef,
    externalRequestRef: "request:c2-stable-transport:repository-fixture",
    transportResultEnvelope: driftEnvelope,
    serverTime: LATER,
    serverClock: driftRuntime.clock
  }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID|C2_STABLE_TRANSPORT_RESULT_INVALID/);
  assert.deepEqual(await driftFixture.repository.readSnapshot(), beforeDrift);

  const directory = await mkdtemp(path.join(os.tmpdir(), "c2-stable-transport-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const enqueueFile = path.join(directory, "enqueue.json");
  const enqueueFixture = stableTransportFixture();
  const enqueueBefore = await enqueueFixture.repository.readSnapshot();
  await writeFile(enqueueFile, JSON.stringify(enqueueBefore), "utf8");
  const failingEnqueueRepository = createJsonBusinessStateRepository({
    filePath: enqueueFile,
    atomicWriter: async () => { throw new Error("simulated_c2_enqueue_atomic_failure"); }
  });
  await assert.rejects(() => enqueueC2StableAssetTransport({
    ...enqueueFixture.enqueueInput,
    repository: failingEnqueueRepository
  }), /simulated_c2_enqueue_atomic_failure/);
  assert.deepEqual(JSON.parse(await readFile(enqueueFile, "utf8")), enqueueBefore);

  const completedFile = path.join(directory, "completed.json");
  const completedFixture = stableTransportFixture();
  await enqueueC2StableAssetTransport(completedFixture.enqueueInput);
  const completedJob = (await completedFixture.repository.readSnapshot()).runtime.softwareJobs[0];
  const completedRuntime = await claimAndStartStableTransport({ repository: completedFixture.repository, job: completedJob });
  const completedBefore = await completedFixture.repository.readSnapshot();
  await writeFile(completedFile, JSON.stringify(completedBefore), "utf8");
  const completedSkuPackage = completedBefore.candidates[0].lifecycleV11.skuPackage;
  const completedEnvelope = c2TransportResultEnvelope({
    job: completedRuntime.waitingJob,
    jobRef: completedSkuPackage.c2FinalAssets.stableAssetTransport.jobRef,
    skuPackage: completedSkuPackage,
    stagedAssets: completedFixture.stagedAssets,
    stagedAssetManifestFingerprint: completedFixture.preparedStaging.stagedAssetManifestFingerprint,
    stableUrlPrefix: "https://assets.example.com/atomic-completed",
    settledAt: LATER,
    resultRef: "receipt:c2-stable-transport:atomic-completed"
  });
  const failingCompletedRepository = createJsonBusinessStateRepository({
    filePath: completedFile,
    atomicWriter: async () => { throw new Error("simulated_c2_completed_atomic_failure"); }
  });
  await assert.rejects(() => settleC2StableAssetTransportJob({
    repository: failingCompletedRepository,
    runtimeMode: "local_development",
    actor: completedRuntime.actor,
    candidateId: completedFixture.candidateId,
    jobId: completedJob.jobId,
    workerId: completedRuntime.worker.workerId,
    leaseId: "lease-stable-transport-1",
    status: "completed",
    externalRequestState: "succeeded",
    resultRef: completedEnvelope.resultRef,
    externalRequestRef: "request:c2-stable-transport:repository-fixture",
    transportResultEnvelope: completedEnvelope,
    serverTime: LATER,
    serverClock: completedRuntime.clock
  }), /simulated_c2_completed_atomic_failure/);
  assert.deepEqual(JSON.parse(await readFile(completedFile, "utf8")), completedBefore);

  const failedFile = path.join(directory, "failed.json");
  const failedFixture = stableTransportFixture();
  await enqueueC2StableAssetTransport(failedFixture.enqueueInput);
  const failedJob = (await failedFixture.repository.readSnapshot()).runtime.softwareJobs[0];
  const failedStore = createRepositoryBackedSoftwareJobStore({
    businessStateRepository: failedFixture.repository,
    serverClock: () => NOW,
    workerRegistry: stableTransportWorkerRegistry()
  });
  const failedWorker = createWorkerDescriptor({
    workerId: "worker-stable-transport-1",
    capabilities: ["stable-asset-transport"],
    version: "1.0.0",
    observedAt: NOW
  });
  await failedStore.claim({
    jobId: failedJob.jobId,
    worker: failedWorker,
    leaseId: "lease-stable-transport-1",
    leaseDurationMs: 30 * 60_000
  });
  const failedBefore = await failedFixture.repository.readSnapshot();
  await writeFile(failedFile, JSON.stringify(failedBefore), "utf8");
  const failingFailedRepository = createJsonBusinessStateRepository({
    filePath: failedFile,
    atomicWriter: async () => { throw new Error("simulated_c2_failed_atomic_failure"); }
  });
  const failedActor = createActorContext({
    userId: failedWorker.workerId,
    sessionId: "session:stable-transport:failed",
    actorType: "worker",
    roles: ["operator"],
    source: "stable-asset-transport-worker",
    authenticatedAt: NOW
  });
  await assert.rejects(() => settleC2StableAssetTransportJob({
    repository: failingFailedRepository,
    runtimeMode: "local_development",
    actor: failedActor,
    candidateId: failedFixture.candidateId,
    jobId: failedJob.jobId,
    workerId: failedWorker.workerId,
    leaseId: "lease-stable-transport-1",
    status: "failed",
    externalRequestState: "not_sent",
    failureClass: "transport_failed_before_request",
    externalRequestRef: null,
    transportResultEnvelope: null,
    serverTime: LATER,
    serverClock: () => LATER
  }), /simulated_c2_failed_atomic_failure/);
  assert.deepEqual(JSON.parse(await readFile(failedFile, "utf8")), failedBefore);
});

test("B3-0e稳定传输并发幂等且拒绝路径零PA零D零外部派发", async () => {
  const fixture = stableTransportFixture();
  const results = await Promise.allSettled([
    enqueueC2StableAssetTransport(fixture.enqueueInput),
    enqueueC2StableAssetTransport(fixture.enqueueInput)
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "fulfilled"]);
  assert.deepEqual(results.map((result) => result.value.status).sort(), ["committed", "idempotent_replay"]);
  const snapshot = await fixture.repository.readSnapshot();
  assert.equal(snapshot.runtime.softwareJobs.length, 1);
  assert.equal(snapshot.runtime.operationAudit.length, 1);
  assert.equal(snapshot.dispatches.length, 0);
  assert.equal(snapshot.candidates[0].lifecycleV11.skuPackage.productionAuthorization, null);

  const rejected = stableTransportFixture();
  const beforeRejected = await rejected.repository.readSnapshot();
  await assert.rejects(() => enqueueC2StableAssetTransport({
    ...rejected.enqueueInput,
    transportAuthorizationRef: "transport-authz:c2:repository-fixture?token=abc"
  }), /C2_STABLE_TRANSPORT_INPUT_REJECTED|PRODUCTION_AUTHORIZATION_SECRET_REJECTED/);
  assert.deepEqual(await rejected.repository.readSnapshot(), beforeRejected);
});

test("B3-0f C2 settlement在fingerprint前拒绝循环和超限resultEnvelope", async () => {
  const fixture = stableTransportFixture();
  await enqueueC2StableAssetTransport(fixture.enqueueInput);
  const job = (await fixture.repository.readSnapshot()).runtime.softwareJobs[0];
  const { worker, actor, waitingJob, clock: transportClock } = await claimAndStartStableTransport({ repository: fixture.repository, job });
  const baseEnvelope = {
    schemaVersion: "software-job-result-envelope-v1",
    resultRef: "receipt:c2-stable-transport:bounded",
    jobId: waitingJob.jobId,
    jobType: waitingJob.jobType,
    candidateId: waitingJob.candidateId,
    skuPackageId: waitingJob.skuPackageId,
    revision: waitingJob.revision,
    workerId: waitingJob.workerId,
    leaseId: waitingJob.leaseId,
    externalRequestRef: waitingJob.externalRequestRef,
    externalRequestState: "succeeded",
    payloadKind: "c2_stable_asset_transport",
    payloadFingerprint: SHA_A,
    applicationDisposition: "applied",
    recordedAt: LATER
  };
  const cyclicPayload = { schemaVersion: "c2-stable-asset-transport-result-v1" };
  cyclicPayload.self = cyclicPayload;
  const envelopes = [
    { ...baseEnvelope, payload: cyclicPayload },
    { ...baseEnvelope, resultRef: "receipt:c2-stable-transport:huge-key", payload: { schemaVersion: "c2-stable-asset-transport-result-v1", ["x".repeat(65_537)]: "value" } },
    { ...baseEnvelope, resultRef: "receipt:c2-stable-transport:huge-value", payload: { schemaVersion: "c2-stable-asset-transport-result-v1", value: "x".repeat(65_537) } }
  ];
  for (const envelope of envelopes) {
    const before = await fixture.repository.readSnapshot();
    await assert.rejects(() => settleC2StableAssetTransportJob({
      repository: fixture.repository,
      runtimeMode: "local_development",
      actor,
      candidateId: fixture.candidateId,
      jobId: job.jobId,
      workerId: worker.workerId,
      leaseId: "lease-stable-transport-1",
      status: "completed",
      externalRequestState: "succeeded",
      resultRef: envelope.resultRef,
      externalRequestRef: "request:c2-stable-transport:repository-fixture",
      transportResultEnvelope: envelope,
      serverTime: LATER,
      serverClock: transportClock
    }), /SOFTWARE_JOB_RESULT_ENVELOPE_INVALID/);
    assert.deepEqual(await fixture.repository.readSnapshot(), before);
  }
});
