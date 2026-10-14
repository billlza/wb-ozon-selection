import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { productionOwnerDecisionFixture as fixture } from "./fixtures/production-owner-decision-fixture.mjs";
import { historicalAuthorizedProductionFixture } from "./helpers/c2-software-fixture.mjs";
import { createFinalProductPlanConfirmationCard } from "../lib/final-product-plan-confirmation-card.mjs";
import { commitSingleOwnerProductionAuthorization, createProductionAuthorization, commitProductionOwnerDecision, commitProductionAuthorizationHandoff,
  validateProductionAuthorization, assertCurrentProductionAuthorization } from "../lib/production-authorization.mjs";
import { createJsonBusinessStateRepository, createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { PRODUCTION_EXACT_COMMISSION_REQUIRED } from "../lib/commission-estimate-authorization.mjs";
import { loadPublishedSchemaValidator } from "./helpers/published-schema-validator.mjs";
import { assertValidLifecyclePackage } from "../lib/product-lifecycle-schema.mjs";
import { fingerprintCanonicalRecord } from "../lib/production-contract-primitives.mjs";

const validator = await loadPublishedSchemaValidator();
const validateCard = validator.getSchema("final-product-plan-confirmation-card-v1.1");
const validateAuthorization = validator.getSchema("production-authorization-v1.2");

function assertSaved(result) {
  const sku = result.candidate.lifecycleV11.skuPackage;
  const authorization = sku.productionAuthorization;
  assert.equal(validateCard(sku.productionConfirmationCard), true, JSON.stringify(validateCard.errors));
  assert.equal(validateAuthorization(authorization), true, JSON.stringify(validateAuthorization.errors));
  assert.deepEqual(validateProductionAuthorization(authorization, { candidateId: result.candidate.id, candidateRevision: result.candidate.dataRevision, skuPackage: sku, lifecycleState: "persisted" }), { valid: true, errors: [] });
  assert.equal(authorization.confirmedByActorId, authorization.authorizedByActorId);
  assert.equal(authorization.confirmedAt, authorization.authorizedAt);
  assert.equal(authorization.ownerConfirmation.schemaVersion, "production-owner-confirmation-v2");
  assert.equal(authorization.ownerDecisionSnapshot.schemaVersion, "production-owner-decision-snapshot-v2");
  assert.deepEqual(authorization.executionBinding, authorization.ownerDecisionSnapshot.executionBinding);
  assert.deepEqual(authorization.executionBinding, sku.productionConfirmationCard.ownerDecision.executionBinding);
  assert.equal(authorization.ownerAuthorization.source, "authenticated_identity_provider");
  assert.equal(Object.hasOwn(authorization, "technicalAuthorization"), false);
  assert.equal(result.result.externalRequests, 0); assert.equal(result.result.platformWrites, 0);
  for (const field of ["productionPlanCreated", "executionIntentCreated", "dWritePermissionGranted"]) assert.equal(result.result[field], false);
  assert.equal(result.result.softwareJobCreated, true);
  assert.equal(sku.dHandoff.schemaVersion, "c2-d-handoff-v2");
  assert.equal(sku.dHandoff.status, "software_job_queued");
  assert.equal(sku.businessPhase, "D");
  assert.equal(sku.technicalStatus, "queued");
  assertValidLifecyclePackage(sku);
  const validateHandoff = validator.getSchema("product-lifecycle-v1.1#/$defs/c2DHandoff");
  assert.equal(validateHandoff(sku.dHandoff), true, JSON.stringify(validateHandoff.errors));
  return authorization;
}

test("one current human confirmation atomically saves its card decision, immutable exact authorization and one D handoff", async () => {
  const { args, repository, candidate } = fixture();
  const before = structuredClone(candidate.lifecycleV11.skuPackage);
  const outcomes = await Promise.all([commitSingleOwnerProductionAuthorization(args), commitSingleOwnerProductionAuthorization(args)]);
  assert.deepEqual(outcomes.map(value => value.status).sort(), ["committed", "idempotent_replay"]);
  const committed = outcomes.find(value => value.status === "committed");
  const authorization = assertSaved(committed);
  assert.equal(committed.candidate.dataRevision, candidate.dataRevision + 1);
  assert.equal(committed.candidate.lifecycleV11.skuPackage.dataRevision, before.dataRevision + 1);
  assert.equal(committed.candidate.lifecycleV11.skuPackage.productionConfirmationCard.cardRevision, before.productionConfirmationCard.cardRevision + 1);
  assert.deepEqual(committed.candidate.lifecycleV11.skuPackage.c2FinalAssets, before.c2FinalAssets);
  const stored = await repository.readSnapshot();
  assert.equal(stored.runtime.operationAudit.length, 1); assert.equal(stored.runtime.idempotencyRecords.length, 1);
  assert.equal(stored.runtime.operationAudit[0].actor.userId, args.actor.userId);
  assert.equal(stored.candidates[0].lifecycleV11.skuPackage.dHandoff.productionAuthorizationId, authorization.authorizationId);
  assert.equal(stored.runtime.softwareJobs.length, 1);
  const [job] = stored.runtime.softwareJobs;
  assert.equal(job.jobId, `d-production-job:${fingerprintCanonicalRecord(authorization)}`);
  assert.equal(job.jobType, "d_production_execution");
  assert.equal(job.status, "queued"); assert.equal(job.attempt, 0); assert.equal(job.externalRequestState, "not_sent");
  assert.equal(job.revision, committed.candidate.dataRevision);
  assert.equal(job.scopeBinding.authorizationRef, authorization.authorizationId);
  assert.equal(job.admissionDecision.admissionKind, "domain_handoff");
  assert.equal(job.admissionDecision.executionBindingSnapshot, null);
  assert.equal(stored.runtime.softwareJobAuthorizationRecords?.length ?? 0, 0);
  assert.equal(stored.runtime.softwareJobCredentialBindings?.length ?? 0, 0);
  assert.deepEqual(authorization.executionBinding, { bindingId: args.input.bindingId, configurationVersion: args.input.configurationVersion, warehouseId: "10001" });
  assert.equal(stored.dispatches.length, 0);
  const replay = await commitSingleOwnerProductionAuthorization(args);
  assert.equal(replay.status, "idempotent_replay"); assert.deepEqual(await repository.readSnapshot(), stored);
});

test("PA replay rejects a missing job, changed scope, detached handoff and duplicate PA job without repairing history", async () => {
  for (const corrupt of [document => { document.runtime.softwareJobs = []; },
    document => { document.runtime.softwareJobs[0].scopeBinding.authorizationFingerprint = "f".repeat(64); },
    document => { document.runtime.softwareJobs[0].scopeBinding.credentialAlias = "alias:other"; },
    document => { document.runtime.softwareJobs[0].scopeBinding.productionBinding.warehouseId = "90002"; },
    document => { document.runtime.softwareJobs[0].scopeBinding.identity.storeRef.mappingVersion = "mapping:other"; },
    document => { document.candidates[0].lifecycleV11.skuPackage.dHandoff.softwareJobRef.jobId = "job:other"; },
    document => { delete document.runtime.idempotencyRecords[0].result.softwareJobRef; document.runtime.softwareJobs = []; },
    document => { document.runtime.softwareJobs.push({ ...structuredClone(document.runtime.softwareJobs[0]), jobId: "job:duplicate" }); }]) {
    const { args, repository } = fixture(); await commitSingleOwnerProductionAuthorization(args);
    await repository.transact(document => { corrupt(document); return { changed: true, document, result: null }; });
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSingleOwnerProductionAuthorization(args), /HALF_STATE_REJECTED|D_JOB_HANDOFF_PERSISTED_SOURCE_CONFLICT|DE_JOB_SCOPE_D_SOURCE_CONFLICT/);
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});

test("failed PA file replacement publishes neither authorization nor D job and retains the original file", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "single-owner-failed-write-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  const base = fixture(); const initial = await base.repository.readSnapshot();
  const { writeFile } = await import("node:fs/promises"); await writeFile(filePath, JSON.stringify(initial));
  const bytes = await readFile(filePath); let proposed;
  const repository = createJsonBusinessStateRepository({ filePath, atomicWriter: async (_target, document) => {
    proposed = structuredClone(document);
    throw new Error("SYNTHETIC_ATOMIC_REPLACEMENT_FAILED");
  } });
  await assert.rejects(() => commitSingleOwnerProductionAuthorization({ ...base.args, repository }), /SYNTHETIC_ATOMIC_REPLACEMENT_FAILED/);
  assert.equal(proposed.runtime.softwareJobs.length, 1);
  assert.ok(proposed.candidates[0].lifecycleV11.skuPackage.productionAuthorization);
  assert.deepEqual(await readFile(filePath), bytes);
  assert.deepEqual(await repository.readSnapshot(), initial);
});

test("new input rejects old protocol, software/default identity, stale source, forged aliases and changed exact scope without mutation", async () => {
  const { args, repository } = fixture(); const before = await repository.readSnapshot();
  const cases = [
    value => { delete value.input.contractVersion; }, value => { value.input.contractVersion = "production-authorization-v1.1"; },
    value => { value.input.confirmExactScope = false; }, value => { value.actor.source = "development_default"; },
    value => { value.actor.actorType = "software"; }, value => { value.actor.roles = ["production_authorizer"]; },
    value => { value.actor.authenticatedAt = "2026-09-08T00:00:00.000Z"; }, value => { value.input.dataRevision += 1; }, value => { value.input.skuRevision += 1; },
    value => { value.input.cardRevision += 1; }, value => { value.input.cardId = "card:other"; }, value => { value.input.sourcePreparationFingerprint = "a".repeat(64); },
    value => { value.input.warehouseRef = "warehouse:invented"; }, value => { value.input.credentialAlias = "alias:invented"; },
    value => { value.input.platformWritePrice = { amount: 1, currency: "CNY" }; }, value => { value.input.ownerConfirmation = {}; }
  ];
  for (const change of cases) {
    const changed = { ...args, actor: structuredClone(args.actor), input: structuredClone(args.input) }; change(changed);
    await assert.rejects(() => commitSingleOwnerProductionAuthorization(changed)); assert.deepEqual(await repository.readSnapshot(), before);
  }
  await commitSingleOwnerProductionAuthorization(args); const saved = await repository.readSnapshot();
  for (const input of [{ ...args.input, merchantSku: "different" }, { ...args.input, bindingId: "binding:other" }, { ...args.input, configurationVersion: "configuration:2" }]) {
    await assert.rejects(() => commitSingleOwnerProductionAuthorization({ ...args, input }), /IDEMPOTENCY_CONFLICT/); assert.deepEqual(await repository.readSnapshot(), saved);
  }
  await assert.rejects(() => commitSingleOwnerProductionAuthorization({ ...args, actor: { ...args.actor, userId: "another-owner" } }), /IDEMPOTENCY_CONFLICT/);
});

test("current resolution receives transaction evidence and any resolver failure rolls back every production field", async () => {
  const { args, repository, commercialDecision } = fixture();
  await repository.transact(document => { document.evidencePacks = [{ evidenceId: "evidence:transaction-current" }]; return { changed: true, document, result: null }; });
  const before = await repository.readSnapshot();
  let observed = false;
  await assert.rejects(() => commitSingleOwnerProductionAuthorization({ ...args, resolveProductionAuthorizationDecision: value => {
    observed = true; assert.deepEqual(value.evidencePacks, before.evidencePacks); assert.deepEqual(value.input, args.input); assert.equal(value.candidate.dataRevision, args.input.dataRevision);
    value.candidate.id = "changed-private-copy"; throw new Error("PRODUCTION_CONFIGURATION_CHANGED");
  } }), /PRODUCTION_CONFIGURATION_CHANGED/);
  assert.equal(observed, true); assert.deepEqual(await repository.readSnapshot(), before);
  for (const mutate of [value => { value.platformWritePrice.amount += 1; }, value => { value.priceConversion.evidenceRef = "fx:other"; }, value => { value.credentialAlias = "cookie=private"; }, value => { value.merchantSku = "other"; }, value => { value.executionBinding.configurationVersion = "config:other"; }, value => { value.executionBinding.bindingId = "binding:other"; }]) {
    const changed = structuredClone(commercialDecision); mutate(changed);
    await assert.rejects(() => commitSingleOwnerProductionAuthorization({ ...args, resolveProductionAuthorizationDecision: () => changed }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});

test("saved old commercial decisions are read only and the retired two-step writes cannot issue v1.2 authority", async () => {
  const { args, repository, formal } = fixture();
  await assert.rejects(() => commitProductionOwnerDecision(args), /RECONFIRMATION_REQUIRED/);
  await assert.rejects(() => commitProductionAuthorizationHandoff(args), /RECONFIRMATION_REQUIRED/);
  const legacy = historicalAuthorizedProductionFixture({ sourceSkuPackage: formal.merged.skuPackage, sourceCandidateRevision: args.input.dataRevision });
  const historical = legacy.productionAuthorization;
  assert.equal(validateProductionAuthorization(historical).valid, true);
  assert.equal(validator.getSchema("production-authorization-v1.1")(historical), true);
  assert.throws(() => assertCurrentProductionAuthorization(historical), /RECONFIRMATION_REQUIRED/);
  const oldBusinessCard = structuredClone(legacy.skuPackage);
  oldBusinessCard.productionAuthorization = null; oldBusinessCard.dHandoff = null; oldBusinessCard.dataRevision = historical.authorizedDataRevision;
  await repository.transact(document => { document.candidates[0].lifecycleV11.skuPackage = oldBusinessCard; return { changed: true, document, result: null }; });
  const before = await repository.readSnapshot(); const card = oldBusinessCard.productionConfirmationCard;
  const input = { ...args.input, cardId: card.cardId, cardRevision: card.cardRevision, skuRevision: oldBusinessCard.dataRevision,
    sourcePreparationFingerprint: historical.sourcePreparationFingerprint, sourceFinalCardInputFingerprint: historical.sourceFinalCardInputFingerprint };
  await assert.rejects(() => commitSingleOwnerProductionAuthorization({ ...args, input, serverClock: () => legacy.createdAt }), error => error.code === "PRODUCTION_CURRENT_CONFIRMATION_REQUIRED");
  assert.deepEqual(await repository.readSnapshot(), before);
});

test("new authorization and card persist together across JSON reopen and failed stale submissions preserve bytes", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "single-owner-production-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  const { args } = fixture(document => createJsonBusinessStateRepository({ filePath, initializeIfMissing: true, initialDocument: document }));
  const saved = await commitSingleOwnerProductionAuthorization(args); assertSaved(saved);
  const bytes = await readFile(filePath); const repository = createJsonBusinessStateRepository({ filePath });
  assert.deepEqual((await repository.readSnapshot()).candidates[0], saved.candidate);
  assert.deepEqual((await repository.readSnapshot()).candidates[0].lifecycleV11.skuPackage.productionAuthorization.executionBinding,
    { bindingId: args.input.bindingId, configurationVersion: args.input.configurationVersion, warehouseId: "10001" });
  assert.equal((await commitSingleOwnerProductionAuthorization({ ...args, repository })).status, "idempotent_replay");
  await assert.rejects(() => commitSingleOwnerProductionAuthorization({ ...args, repository, input: { ...args.input, sourceFinalCardInputFingerprint: "a".repeat(64) } }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(await readFile(filePath), bytes);
});

test("actual owner form renders verified Chinese choices and frozen currencies with one confirmation, no alias or second-person field", async () => {
  const { build } = await import("vite"); const { default: react } = await import("@vitejs/plugin-react");
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("./production-owner-form-render.jsx", import.meta.url));
  const component = fileURLToPath(new URL("../src/components/ProductionOwnerDecisionForm.jsx", import.meta.url));
  const built = await build({ configFile: false, logLevel: "warn", plugins: [react(), { name: "production-owner-form-render",
    resolveId: id => id === entry ? entry : null,
    load: id => id === entry ? `import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import Form from ${JSON.stringify(component)};export const render=(candidate,identity)=>renderToStaticMarkup(<Form candidate={candidate} identity={identity} onSave={()=>{}}/>);` : null }],
    ssr: { noExternal: true }, build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: "es" } } } });
  const chunk = built.output.find(item => item.type === "chunk" && item.isEntry);
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
  const { candidate, preparedView } = fixture(); candidate.productionOwnerPreparation = preparedView;
  const before = structuredClone(candidate);
  const html = render(candidate, { canSaveProductionOwnerDecision: true });
  for (const label of ["合成测试店铺", "合成测试仓库", "买家目标成交价", "RUB", "后台写入价", "CNY", "通过进入生产授权", "本店商品货号"]) assert.ok(html.includes(label), label);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 1);
  assert.match(html, /<label class="production-owner-scope-confirmation"><input type="checkbox"[^>]*\/><span>我确认/);
  assert.equal((html.match(/<select /g) || []).length, 1);
  assert.doesNotMatch(html, /credential-alias:synthetic|warehouse:synthetic|独立技术授权|另一位|type="number"|type="datetime-local"/);
  assert.deepEqual(candidate, before);
  const blocked = structuredClone(candidate); blocked.productionOwnerPreparation.ready = false;
  blocked.productionOwnerPreparation.gaps = [{ code: "missing_configuration", message: "当前店铺尚未配置已核验仓库" }];
  const blockedHtml = render(blocked, { canSaveProductionOwnerDecision: true });
  assert.match(blockedHtml, /当前店铺尚未配置已核验仓库/); assert.match(blockedHtml, /type="submit"[^>]*disabled/); assert.doesNotMatch(blockedHtml, /<select/);
  assert.match(render(candidate, { canSaveProductionOwnerDecision: false }), /正式主人身份尚不可用/);
});


test("production final card rejects normalized impossible dates and new binding validator shares its published lexical bounds", async () => {
  const { candidate } = fixture();
  const source = structuredClone(candidate.lifecycleV11.skuPackage); source.productionConfirmationCard = null;
  for (const createdAt of ["2026-02-30T07:00:00.000Z", "2026-08-22", "2026-08-22T07:00:00", "2026-08-22T24:00:00.000Z"]) {
    assert.throws(() => createFinalProductPlanConfirmationCard({ skuPackage: source, createdAt }), /FINAL_PLAN_CARD_INPUT_GAP/);
  }
  const { isProductionExecutionBinding } = await import("../lib/production-authorization-preparation.mjs");
  const schemaValidator = validator.getSchema("production-authorization-v1.2#/$defs/executionBinding");
  for (const [warehouseId, expected] of [["1", true], ["10001", true], [String(Number.MAX_SAFE_INTEGER), true], ["9007199254740992", false], ["0001", false], ["0", false], ["1.5", false]]) {
    const binding = { bindingId: "binding:synthetic:1", configurationVersion: "config-v1", warehouseId };
    assert.equal(isProductionExecutionBinding(binding), expected, warehouseId); assert.equal(schemaValidator(binding), expected, warehouseId);
  }
  for (const bindingId of ["binding:id#/selection", "binding/warehouse", "a".repeat(162)]) {
    const binding = { bindingId, configurationVersion: "config-v1", warehouseId: "10001" };
    assert.equal(isProductionExecutionBinding(binding), false); assert.equal(schemaValidator(binding), false);
  }
});

/**
 * 钱的闸门在上架这一刻。
 *
 * 这道闸门加在服务端的提交路径上，不是页面上藏个按钮：`commitSingleOwnerProductionAuthorization` 在它那一次
 * 原子事务的 `mutate` 里读仓库当时的记录来判，所以直接打接口、拿一份过期的页面来提交，都一样被拦。拦下来
 * 的那一次什么都没落盘——下面逐字比较了整份快照。
 */
test("佣金还是估算时，生产授权在服务端被拒绝，稳定码可被页面识别，且一个字节都没落盘", async () => {
  const base = fixture();
  const document = await base.repository.readSnapshot();
  const sku = document.candidates[0].lifecycleV11.skuPackage;
  const model = sku.profitModels.find(item => item.profitModelVersion === sku.activeProfitModelVersion);
  // 把当前生效那一份利润记录换成「条件测算 + 估算佣金」，别的一概不动：确认卡、冻结素材、指纹都还是原来那些。
  Object.assign(model, { commissionMode: "estimated", calculationType: "conditional", exactCommissionRequiredForFormalB: true });
  const repository = createMemoryBusinessStateRepository(document);
  const before = await repository.readSnapshot();
  await assert.rejects(() => commitSingleOwnerProductionAuthorization({ ...base.args, repository }), error => {
    assert.equal(error.code, PRODUCTION_EXACT_COMMISSION_REQUIRED);
    assert.equal(error.code, "PRODUCTION_AUTHORIZATION_EXACT_COMMISSION_REQUIRED");
    assert.equal(error.exactCommissionRequiredForProduction, true);
    assert.equal(error.ownerNextStep, "b_exact_commission_recalculate");
    assert.equal(error.commissionMode, "estimated");
    return true;
  });
  // 没有授权、没有 D 交接、没有软件作业、没有审计记录——拒绝发生在任何东西落盘之前。
  assert.deepEqual(await repository.readSnapshot(), before);
  // 换回精确佣金，同一份输入就该照常保存：这道闸门只拦估算佣金这一件事。
  const exactDocument = await base.repository.readSnapshot();
  const committed = await commitSingleOwnerProductionAuthorization({ ...base.args, repository: createMemoryBusinessStateRepository(exactDocument) });
  assert.equal(committed.status, "committed");
  assert.equal(committed.candidate.lifecycleV11.skuPackage.productionAuthorization.schemaVersion, "production-authorization-v1.2");
});
