import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProductionEntities as normalize, restoreProductionEntities as restore, PRODUCTION_ENTITY_REFERENCE_VERSION, createProductionEntityResolver } from "../lib/production-entity-storage.mjs";
import { fingerprintFinalCardInputSnapshot } from "../lib/production-authorization-preparation.mjs";
import { productionOwnerDecisionFixture } from "./fixtures/production-owner-decision-fixture.mjs";
import { commitSingleOwnerProductionAuthorization } from "../lib/production-authorization.mjs";
import { historicalPlanFixture } from "./helpers/d-software-fixture.mjs";
import { createProductionPlan } from "../lib/production-plan.mjs";

async function fixture() {
  const owner = productionOwnerDecisionFixture();
  await commitSingleOwnerProductionAuthorization(owner.args);
  const candidate = (await owner.repository.readSnapshot()).candidates[0];
  const skuPackage = candidate.lifecycleV11.skuPackage;
  const authorization = skuPackage.productionAuthorization;
  const plan = createProductionPlan({ productionAuthorization: authorization, candidateId: candidate.id,
    candidateRevision: candidate.dataRevision, skuPackage, createdAt: owner.formal.at });
  const snapshot = authorization.lockedScope.finalCardInputSnapshot;
  return { candidate, authorization, plan, snapshot };
}
const hasCode = code => error => error.code === `PRODUCTION_ENTITY_${code}`;

test("real snapshot / authorization / plan normalize losslessly with one record per immutable identity", async () => {
  const { candidate, authorization, plan, snapshot } = await fixture();
  const source = { snapshot, authorization, plan, second: structuredClone(plan) };
  const before = structuredClone(source);
  const packed = normalize(source, { candidateId: candidate.id });
  assert.deepEqual(packed.records.map(record => record.kind), ["final_card_input_snapshot", "production_authorization", "production_plan"]);
  assert.equal(packed.records[0].entityId, `final-card-input-snapshot:${fingerprintFinalCardInputSnapshot(snapshot)}`);
  assert.equal(packed.records[1].value.lockedScope.finalCardInputSnapshot.schemaVersion, PRODUCTION_ENTITY_REFERENCE_VERSION);
  assert.equal(packed.records[2].value.sourceAuthorization.entityId, authorization.authorizationId);
  assert.deepEqual(restore(packed.value, packed.records, { candidateId: candidate.id }), source);
  assert.deepEqual(source, before);
  assert.deepEqual(normalize(packed.value, { candidateId: candidate.id }), { value: packed.value, records: [] });
});

test("missing, wrong scope, content conflicts and duplicate registry ids fail explicitly", async () => {
  const { candidate, authorization, plan } = await fixture();
  const packed = normalize(plan);
  assert.throws(() => restore(packed.value, packed.records.slice(1)), hasCode("MISSING"));
  assert.throws(() => restore(packed.value, packed.records, { candidateId: "candidate:other" }), hasCode("SCOPE_MISMATCH"));
  const wrongScope = structuredClone(packed.records);
  wrongScope[0].scope.storeRef.stableStoreId = "another-store";
  assert.throws(() => restore(packed.value, wrongScope), hasCode("SCOPE_MISMATCH"));
  const changed = structuredClone(authorization); changed.status = "changed";
  assert.throws(() => normalize([authorization, changed], { candidateId: candidate.id }), hasCode("CONFLICT"));
  assert.throws(() => restore(packed.value, [...packed.records, packed.records[0]]), hasCode("CONFLICT"));
});

test("reference contracts, illegal dependency positions and cycles are rejected", async () => {
  const { snapshot, plan } = await fixture();
  const packed = normalize(plan);
  const malformed = { ...packed.value, extra: true };
  assert.throws(() => restore(malformed, packed.records), hasCode("SHAPE_INVALID"));
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => normalize(cycle), hasCode("CYCLE"));
  const cyclicRecords = structuredClone(packed.records);
  cyclicRecords[1].value.lockedScope.finalCardInputSnapshot = structuredClone(packed.value);
  assert.throws(() => restore(packed.value, cyclicRecords), hasCode("DEPENDENCY_INVALID"));
  const nested = structuredClone(snapshot); nested.extra = structuredClone(plan);
  assert.throws(() => normalize(nested), hasCode("DEPENDENCY_INVALID"));
  const missingScope = structuredClone(packed.value); delete missingScope.scope.variantKey;
  assert.throws(() => restore(missingScope, packed.records), hasCode("SHAPE_INVALID"));
});

test("root, entity, depth, text and reference budgets are enforced before unbounded expansion", async () => {
  const { snapshot } = await fixture();
  assert.throws(() => normalize(Array.from({ length: 20001 }, () => null)), hasCode("RESOURCE_LIMIT_EXCEEDED"));
  assert.throws(() => normalize({ data: "a".repeat(1024 * 1024 + 1) }), hasCode("RESOURCE_LIMIT_EXCEEDED"));
  let deep = {}; for (let i = 0; i < 129; i++) deep = { child: deep };
  assert.throws(() => normalize(deep), hasCode("RESOURCE_LIMIT_EXCEEDED"));
  assert.throws(() => normalize({ ...snapshot, extra: Array.from({ length: 10000 }, () => null) }), hasCode("RESOURCE_LIMIT_EXCEEDED"));
  const packed = normalize(snapshot);
  assert.throws(() => normalize(Array.from({ length: 257 }, () => packed.value)), hasCode("RESOURCE_LIMIT_EXCEEDED"));
  assert.throws(() => restore(Array.from({ length: 257 }, () => packed.value), packed.records), hasCode("RESOURCE_LIMIT_EXCEEDED"));
});

test("JSON keys preserve __proto__; special properties do not become references", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"schemaVersion":"__proto__","authorizationId":"ordinary-business-value"}');
  const packed = normalize(input);
  assert.deepEqual(packed.value, input);
  assert.deepEqual(packed.records, []);
  assert.deepEqual(restore(packed.value, []), input);
  assert.equal({}.polluted, undefined);
  const getter = Object.defineProperty({}, "bad", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => normalize(getter), hasCode("JSON_INVALID"));
});


test("resolver index reuse never aliases returned candidates or historical snapshots", async () => {
  const { plan } = await fixture();
  const packed = normalize({ current: plan, historical: plan });
  const resolver = createProductionEntityResolver(packed.records);
  const first = resolver.restore(packed.value);
  const second = resolver.restore(packed.value);
  first.current.sourceAuthorization.status = "changed locally";
  assert.equal(first.historical.sourceAuthorization.status, "confirmed");
  assert.equal(second.current.sourceAuthorization.status, "confirmed");
  assert.deepEqual(resolver.restore(packed.value), second);
  assert.throws(() => resolver.restore(packed.value, { candidateId: "candidate:another" }), hasCode("SCOPE_MISMATCH"));
});

test("published historical plan retains its v1.1 authorization inline and restores unchanged", () => {
  const { plan } = historicalPlanFixture();
  const packed = normalize(plan);
  assert.deepEqual(packed.records.map(record => record.kind), ["final_card_input_snapshot", "production_plan"]);
  assert.equal(packed.records[1].value.sourceAuthorization.schemaVersion, "production-authorization-v1.1");
  assert.deepEqual(restore(packed.value, packed.records), plan);
});


test("diagnostic paths redact arbitrary keys and dotted keys cannot masquerade as dependencies", async () => {
  const secretKey = "password=should-never-appear-in-a-diagnostic";
  const cyclic = {}; cyclic[secretKey] = cyclic;
  assert.throws(() => normalize(cyclic), error => error.code === "PRODUCTION_ENTITY_CYCLE" &&
    error.message.includes("[unknown]") && !error.message.includes(secretKey));
  const { authorization, snapshot } = await fixture();
  const disguised = { ...authorization, "lockedScope.finalCardInputSnapshot": snapshot };
  assert.throws(() => normalize(disguised), error => error.code === "PRODUCTION_ENTITY_DEPENDENCY_INVALID" && error.message.endsWith("$.[unknown]"));
  const unusualKey = { ["\ud800"]: "JSON allows this key" };
  assert.deepEqual(restore(normalize(unusualKey).value, []), unusualKey);
});

test("hydration enforces combined depth and counts dependencies behind cached references", async () => {
  const { snapshot } = await fixture();
  // A minimal storage-contract fixture isolates expansion budgets; it is not a business authorization.
  const compactSnapshot = { schemaVersion: snapshot.schemaVersion, identity: snapshot.identity, skuPackageId: snapshot.skuPackageId,
    variantKey: snapshot.variantKey, sourceDataRevision: snapshot.sourceDataRevision, resultDataRevision: snapshot.resultDataRevision };
  const authorization = { schemaVersion: "production-authorization-v1.2", authorizationId: "production-auth:resource-test",
    sourceIdentity: snapshot.identity, identity: snapshot.identity,
    sourceFinalCardInputFingerprint: fingerprintFinalCardInputSnapshot(compactSnapshot),
    lockedScope: { ...snapshot.identity, variantKey: snapshot.variantKey, finalCardInputSnapshot: compactSnapshot } };
  const plan = { schemaVersion: "production-plan-v1.1", planId: "production-plan:resource-test", sourceAuthorization: authorization };
  const packed = normalize(plan);
  assert.throws(() => restore(Array.from({ length: 86 }, () => packed.value), packed.records), hasCode("RESOURCE_LIMIT_EXCEEDED"));
  const deepSnapshot = structuredClone(compactSnapshot);
  let tail = {}; for (let index = 0; index < 120; index++) tail = { nested: tail };
  deepSnapshot.payload = tail;
  const deepPacked = normalize(deepSnapshot);
  let root = deepPacked.value; for (let index = 0; index < 10; index++) root = { nested: root };
  assert.throws(() => restore(root, deepPacked.records), hasCode("RESOURCE_LIMIT_EXCEEDED"));
});

test("resolver validates each reachable private record once without aliasing its registry input", async () => {
  const { plan } = await fixture();
  const packed = normalize(plan);
  const calls = [];
  const resolver = createProductionEntityResolver(packed.records, { validateRecord: record => {
    assert.equal(Object.isFrozen(record.value), true);
    calls.push(record.entityId);
  } });
  const first = resolver.restore(packed.value);
  packed.records[0].value.sourceDataRevision += 50;
  assert.deepEqual(resolver.restore(packed.value), first);
  assert.equal(calls.length, 3);
  const rejected = createProductionEntityResolver(normalize(plan).records, { validateRecord: () => { throw new Error("explicit record rejection"); } });
  assert.throws(() => rejected.restore(packed.value), /explicit record rejection/);
});
