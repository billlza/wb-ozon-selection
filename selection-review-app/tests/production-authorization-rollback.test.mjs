import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { productionOwnerDecisionFixture } from "./fixtures/production-owner-decision-fixture.mjs";
import { commitSingleOwnerProductionAuthorization, buildProductionOwnerDecisionId } from "../lib/production-authorization.mjs";
import { createJsonBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { persistJsonThroughRealTarget } from "../lib/atomic-json-persistence.mjs";
import { createProductionAuthorizationRollbackUseCase } from "../lib/production-authorization-rollback-use-case.mjs";
import { productionAuthorizationRollbackEligible, PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS }
  from "../lib/production-authorization-rollback.mjs";
import { createRepositoryBackedSoftwareJobStore } from "../lib/software-job-repository.mjs";
import { buildDESavedJobRuntimeView } from "../lib/d-e-runtime-view.mjs";
import { createLocalDevelopmentWorkerRegistry } from "../lib/worker-registry.mjs";

const OWNER = Object.freeze({ schemaVersion: "actor-context-v1", userId: "owner:test", sessionId: "session:test",
  actorType: "human", roles: ["owner"], source: "authenticated_identity_provider",
  authenticatedAt: "2026-08-01T00:00:00.000Z" });

/** 已签授权、D 作业已排队、上一轮停在「失败且一个请求都没发出去」的真实形状。 */
async function signedFixture(t, { moveRevision = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pa-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");
  const source = productionOwnerDecisionFixture(document => createJsonBusinessStateRepository({ filePath,
    initializeIfMissing: true, initialDocument: document, atomicWriter: persistJsonThroughRealTarget }));
  const committed = await commitSingleOwnerProductionAuthorization(source.args);
  const repository = source.repository;
  // 时钟必须真往前走，而且要留在夹具那份生产绑定的有效期之内。
  let clock = Date.parse(source.formal.at);
  const serverClock = () => new Date((clock += 1000)).toISOString();
  const useCase = createProductionAuthorizationRollbackUseCase({ repository, serverClock });
  // 让上一轮停在「失败且未发出」，并把候选往前推一格，制造 REVISION_MOVED。
  await repository.transact(document => {
    const job = document.runtime.softwareJobs.find(entry => entry.jobType === "d_production_execution");
    job.status = "failed"; job.attempt = 1; job.externalRequestState = "not_sent";
    job.externalRequestRef = null; job.resultEnvelope = null; job.failureClass = "known_technical_failure";
    if (moveRevision) document.candidates[0].dataRevision += 1;
    return { changed: true, document, result: null };
  });
  const snapshot = await repository.readSnapshot();
  const candidate = snapshot.candidates[0];
  return { repository, filePath, useCase, committed, candidate, source,
    authorizationId: candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId,
    input: { candidateId: candidate.id, authorizationId: candidate.lifecycleV11.skuPackage.productionAuthorization.authorizationId,
      expectedRevision: candidate.dataRevision, confirmNothingWasSentToPlatform: true } };
}

async function rejectsUnchanged(f, action, matcher) {
  const before = await f.repository.readSnapshot();
  const bytes = await readFile(f.filePath);
  await assert.rejects(action, matcher);
  assert.deepEqual(await f.repository.readSnapshot(), before);
  assert.deepEqual(await readFile(f.filePath), bytes);
}

test("作废把SKU包恢复到签字前并整体归档留底，图片、文案与失败历史一字不动", async t => {
  const f = await signedFixture(t);
  const before = await f.repository.readSnapshot();
  const beforeSku = before.candidates[0].lifecycleV11.skuPackage;
  const authorizedRevision = beforeSku.productionAuthorization.authorizedDataRevision;

  const committed = await f.useCase.rollback({ actor: OWNER, input: f.input });
  const result = committed.result ?? committed;

  const after = await f.repository.readSnapshot();
  const sku = after.candidates[0].lifecycleV11.skuPackage;
  assert.equal(sku.dataRevision, authorizedRevision, "SKU修订退回签字前那一格");
  assert.equal(sku.productionAuthorization, null);
  assert.equal(sku.dHandoff, null);
  assert.equal(sku.dAssetTransport, null);
  assert.equal(sku.productionConfirmationCard.status, "awaiting_owner_business_confirmation");
  assert.equal(sku.productionConfirmationCard.ownerDecision, null);
  assert.equal(sku.productionConfirmationCard.cardRevision, beforeSku.productionConfirmationCard.cardRevision - 1);
  assert.equal(sku.productionAuthorizationRoundV1, 2);
  assert.equal(sku.businessPhase, "C2");
  assert.equal(sku.ownerAction, "authorize_production");
  assert.equal(after.candidates[0].dataRevision, before.candidates[0].dataRevision + 1, "候选修订只进不退");
  assert.equal(result.externalRequests, 0);
  assert.equal(result.platformWrites, 0);
  assert.equal(result.productionAuthorizationCreated, false);

  // C2 冻结件、素材、文案逐字不变。
  assert.deepEqual(sku.c2FinalAssets, beforeSku.c2FinalAssets);
  assert.deepEqual(sku.c1ProductPlan, beforeSku.c1ProductPlan);
  // 失败作业留在原地，一条不删。
  assert.deepEqual(after.runtime.softwareJobs.map(entry => entry.jobId), before.runtime.softwareJobs.map(entry => entry.jobId));

  const [archive] = after.candidates[0].lifecycleV11.productionAuthorizationRollbackArchiveV1;
  assert.equal(archive.productionAuthorizationRef.authorizationId, f.authorizationId);
  assert.equal(archive.restoredSkuRevision, authorizedRevision);
  assert.equal(archive.resultAuthorizationRound, 2);
  assert.equal(archive.platformWrites, 0);
  assert.equal(archive.externalRequests, 0);
  assert.ok(archive.dProductionJobIds.length >= 1, "归档记下被作废那一轮的作业号");
  assert.deepEqual(archive.confirmationCard.ownerDecision, beforeSku.productionConfirmationCard.ownerDecision);
});

test("归档只留实体引用与指纹，不复制授权正文或生产计划正文", async t => {
  const f = await signedFixture(t);
  await f.useCase.rollback({ actor: OWNER, input: f.input });
  const after = await f.repository.readSnapshot();
  const [archive] = after.candidates[0].lifecycleV11.productionAuthorizationRollbackArchiveV1;
  assert.equal(archive.productionAuthorization, undefined, "不复制授权正文");
  assert.match(archive.productionAuthorizationRef.recordFingerprint, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(archive);
  assert.ok(!serialized.includes('"lockedScope"'), "归档里不得出现授权 lockedScope 正文");
  assert.ok(serialized.length < 64 * 1024, `归档体积须受控，实际 ${serialized.length} 字节`);
  if (archive.dAssetTransport?.intent?.productionPlan) {
    assert.equal(archive.dAssetTransport.intent.productionPlan.schemaVersion, "production-plan-archive-ref-v1");
  }
});

test("连点第二下和重复请求都被挡下，且零持久化变更", async t => {
  const f = await signedFixture(t);
  await f.useCase.rollback({ actor: OWNER, input: f.input });
  const after = await f.repository.readSnapshot();
  // 第二下：页面上那一版 revision 已经过期。
  await rejectsUnchanged(f, () => f.useCase.rollback({ actor: OWNER, input: f.input }), /CANDIDATE_CHANGED|商品资料已变化/);
  // 刷新后再点一次：已经没有可作废的授权。
  await rejectsUnchanged(f, () => f.useCase.rollback({ actor: OWNER,
    input: { ...f.input, expectedRevision: after.candidates[0].dataRevision } }), /没有可作废的对象/);
});

test("上一轮可能已经发出请求时绝不放行作废", async t => {
  const f = await signedFixture(t);
  await f.repository.transact(document => {
    const job = document.runtime.softwareJobs.find(entry => entry.jobType === "d_production_execution");
    job.externalRequestState = "sent"; job.externalRequestRef = "request:unknown-outcome";
    return { changed: true, document, result: null };
  });
  const snapshot = await f.repository.readSnapshot();
  const state = productionAuthorizationRollbackEligible(snapshot, snapshot.candidates[0]);
  assert.equal(state.eligible, false);
  assert.equal(state.blocker, PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ROUND_MAY_HAVE_SENT);
  await rejectsUnchanged(f, () => f.useCase.rollback({ actor: OWNER,
    input: { ...f.input, expectedRevision: snapshot.candidates[0].dataRevision } }), /终态未知/);
});

test("还能直接再派一轮时不给作废，六项证据缺一也不给", async t => {
  const dispatchable = await signedFixture(t, { moveRevision: false });
  const snapshot = await dispatchable.repository.readSnapshot();
  const state = productionAuthorizationRollbackEligible(snapshot, snapshot.candidates[0]);
  assert.equal(state.eligible, false);
  assert.equal(state.blocker, PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ROUND_STILL_DISPATCHABLE);

  const written = await signedFixture(t);
  await written.repository.transact(document => {
    document.candidates[0].lifecycleV11.platformWrites = 1;
    return { changed: true, document, result: null };
  });
  const writtenSnapshot = await written.repository.readSnapshot();
  const writtenState = productionAuthorizationRollbackEligible(writtenSnapshot, writtenSnapshot.candidates[0]);
  assert.equal(writtenState.eligible, false);
  assert.equal(writtenState.blocker, PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.PLATFORM_WRITE_PRESENT);
  await rejectsUnchanged(written, () => written.useCase.rollback({ actor: OWNER,
    input: { ...written.input, expectedRevision: writtenSnapshot.candidates[0].dataRevision } }), /绝不能当作没发生过/);
});

test("第1轮决定号格式不变，第2轮带轮次后缀，非正整数轮次拒绝", () => {
  const base = { candidateId: "candidate:x", cardId: "final-plan-card:sku:14", cardRevision: 1 };
  assert.equal(buildProductionOwnerDecisionId(base), "owner-decision:candidate:x:final-plan-card:sku:14:2");
  assert.equal(buildProductionOwnerDecisionId({ ...base, authorizationRound: 1 }),
    "owner-decision:candidate:x:final-plan-card:sku:14:2");
  assert.equal(buildProductionOwnerDecisionId({ ...base, authorizationRound: 2 }),
    "owner-decision:candidate:x:final-plan-card:sku:14:2:r2");
  for (const round of [0, -1, 1.5, "2", null]) {
    assert.throws(() => buildProductionOwnerDecisionId({ ...base, authorizationRound: round }),
      /PRODUCTION_AUTHORIZATION_ROUND_INVALID/);
  }
});

test("作废后重签得到不同的授权号、交接号和D作业号，且新作业排队未执行", async t => {
  const f = await signedFixture(t);
  const before = await f.repository.readSnapshot();
  const archivedAuthorizationId = f.authorizationId;
  const archivedJobIds = before.runtime.softwareJobs.filter(entry => entry.jobType === "d_production_execution")
    .map(entry => entry.jobId);
  const archivedHandoffId = before.candidates[0].lifecycleV11.skuPackage.dHandoff.handoffId;

  await f.useCase.rollback({ actor: OWNER, input: f.input });

  const restored = await f.repository.readSnapshot();
  const sku = restored.candidates[0].lifecycleV11.skuPackage;
  const card = sku.productionConfirmationCard;
  const preparation = sku.c2FinalAssets.productionAuthorizationPreparation;
  // 主人在现有界面上重签：同一份合同、同一个绑定，只是卡和修订回到了签字前那一刻。
  const resign = await commitSingleOwnerProductionAuthorization({
    ...f.source.args,
    input: { ...f.source.args.input, dataRevision: restored.candidates[0].dataRevision,
      skuRevision: sku.dataRevision, cardId: card.cardId, cardRevision: card.cardRevision,
      sourcePreparationFingerprint: preparation.preparationFingerprint,
      sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint },
    serverClock: () => new Date(Date.parse(f.source.formal.at) + 10_000).toISOString()
  });

  const signed = await f.repository.readSnapshot();
  const next = signed.candidates[0].lifecycleV11.skuPackage;
  assert.notEqual(next.productionAuthorization.authorizationId, archivedAuthorizationId, "新授权号必须与已归档的不同");
  assert.notEqual(next.dHandoff.handoffId, archivedHandoffId, "新交接号必须与已归档的不同");
  assert.match(next.productionAuthorization.ownerDecisionId, /:r2$/, "第2轮决定号带轮次后缀");
  const newJobs = signed.runtime.softwareJobs.filter(entry => entry.jobType === "d_production_execution" &&
    !archivedJobIds.includes(entry.jobId));
  assert.equal(newJobs.length, 1, "重签后排出且只排出一个新的D作业");
  assert.equal(newJobs[0].status, "queued");
  assert.equal(newJobs[0].attempt, 0);
  assert.equal(newJobs[0].externalRequestState, "not_sent");
  const resignResult = resign.result ?? resign;
  assert.equal(resignResult.externalRequests, 0);
  assert.equal(resignResult.platformWrites, 0);
  // 价格、库存、素材与第一轮授权逐字相同。
  const archivedScope = before.candidates[0].lifecycleV11.skuPackage.productionAuthorization.lockedScope;
  assert.deepEqual(next.productionAuthorization.lockedScope.platformWritePrice, archivedScope.platformWritePrice);
  assert.deepEqual(next.productionAuthorization.lockedScope.buyerTargetPrice, archivedScope.buyerTargetPrice);
  assert.equal(next.productionAuthorization.lockedScope.stock, archivedScope.stock);
  assert.deepEqual(next.productionAuthorization.lockedScope.finalUploads, archivedScope.finalUploads);
});

test("重签后的新D作业能被真实领取，素材守卫按当前登记核验，全程零外部请求", async t => {
  const f = await signedFixture(t);
  const before = await f.repository.readSnapshot();
  const archivedJobIds = before.runtime.softwareJobs.filter(entry => entry.jobType === "d_production_execution")
    .map(entry => entry.jobId);

  await f.useCase.rollback({ actor: OWNER, input: f.input });
  const restored = await f.repository.readSnapshot();
  const sku = restored.candidates[0].lifecycleV11.skuPackage;
  const card = sku.productionConfirmationCard;
  const preparation = sku.c2FinalAssets.productionAuthorizationPreparation;
  await commitSingleOwnerProductionAuthorization({
    ...f.source.args,
    input: { ...f.source.args.input, dataRevision: restored.candidates[0].dataRevision,
      skuRevision: sku.dataRevision, cardId: card.cardId, cardRevision: card.cardRevision,
      sourcePreparationFingerprint: preparation.preparationFingerprint,
      sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint },
    serverClock: () => new Date(Date.parse(f.source.formal.at) + 10_000).toISOString()
  });

  const signed = await f.repository.readSnapshot();
  const [job] = signed.runtime.softwareJobs.filter(entry => entry.jobType === "d_production_execution" &&
    !archivedJobIds.includes(entry.jobId));
  assert.ok(job, "重签后必须有一个新的D作业");

  const scope = job.scopeBinding;
  let clock = new Date(Date.parse(f.source.formal.at) + 20_000).toISOString();
  const binding = { schemaVersion: "d-e-execution-binding-v1", serviceId: "service:rollback-test",
    serviceConfigurationVersion: "service-config:rollback-test:1",
    productionBinding: structuredClone(scope.productionBinding), platform: "ozon",
    storeRef: structuredClone(scope.identity.storeRef), warehouseRef: scope.warehouseRef,
    credentialAlias: scope.credentialAlias, workerId: "worker:rollback-test", workerVersion: "version:1",
    configurationEvidence: { evidenceRef: "evidence:rollback-test-configuration", checkedAt: clock,
      expiresAt: new Date(Date.parse(clock) + 300_000).toISOString() } };
  const registry = createLocalDevelopmentWorkerRegistry({ clock: () => clock, heartbeatTtlMs: 300_000 });
  const worker = registry.register({ workerId: binding.workerId, version: binding.workerVersion,
    capabilities: ["ozon-production-execution"], observedAt: clock });
  const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: f.repository,
    serverClock: () => clock, workerRegistry: registry, resolveDEExecutionBinding: () => structuredClone(binding) });

  const claimed = await store.claim({ jobId: job.jobId, worker, leaseId: "lease:rollback-test", leaseDurationMs: 60_000 });
  const claimedJob = claimed.job ?? claimed;
  assert.equal(claimedJob.jobId, job.jobId);
  assert.equal(claimedJob.status, "claimed");
  assert.equal(claimedJob.externalRequestState, "not_sent", "领取本身绝不发出任何外部请求");

  // 领取后的准入守卫：作用域、授权指纹和当前记录必须仍然对得上。
  const guard = await f.repository.transact(document => ({ changed: false,
    result: store.assertDEExecutionInDocument({ document, jobId: job.jobId, workerId: worker.workerId,
      leaseId: "lease:rollback-test", observedAt: clock }) }));
  assert.ok(guard, "准入守卫必须给出结论而不是抛出");

  const afterClaim = await f.repository.readSnapshot();
  const skuAfter = afterClaim.candidates[0].lifecycleV11.skuPackage;
  assert.equal(skuAfter.productionRecord, null, "领取和守卫都不得产生生产记录");
  assert.equal(afterClaim.candidates[0].lifecycleV11.platformWrites, 0, "全程零平台写入");
  assert.deepEqual(skuAfter.c2FinalAssets.assets.finalUploads,
    before.candidates[0].lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads, "素材逐字未变");
});

test("轮次用尽同样放行作废；可作废的阻断集合固定为三种，其余后端一律拒绝", async t => {
  const f = await signedFixture(t, { moveRevision: false });
  const snapshot = await f.repository.readSnapshot();

  // 轮次用尽：作业号里的轮次已达上限，但什么都没发出去。
  const atLimit = structuredClone(snapshot);
  const job = atLimit.runtime.softwareJobs.find(entry => entry.jobType === "d_production_execution");
  job.jobId = `${job.jobId}:round20`;
  const limitState = productionAuthorizationRollbackEligible(atLimit, atLimit.candidates[0]);
  assert.equal(limitState.eligible, true, `轮次用尽应放行作废，实际阻断：${limitState.blocker}`);

  // 还能再派一轮：不给作废。
  const dispatchable = productionAuthorizationRollbackEligible(snapshot, snapshot.candidates[0]);
  assert.equal(dispatchable.eligible, false);
  assert.equal(dispatchable.blocker, PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ROUND_STILL_DISPATCHABLE);

  // 还没停：不给作废。
  const running = structuredClone(snapshot);
  running.runtime.softwareJobs.find(entry => entry.jobType === "d_production_execution").status = "claimed";
  assert.equal(productionAuthorizationRollbackEligible(running, running.candidates[0]).blocker,
    PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ROUND_NOT_STOPPED);

  // 可能已发出：不给作废。
  const sent = structuredClone(snapshot);
  const sentJob = sent.runtime.softwareJobs.find(entry => entry.jobType === "d_production_execution");
  sentJob.externalRequestState = "sent"; sentJob.externalRequestRef = "request:unknown";
  assert.equal(productionAuthorizationRollbackEligible(sent, sent.candidates[0]).blocker,
    PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.ROUND_MAY_HAVE_SENT);

  // 根本没有授权：不给作废。
  const none = structuredClone(snapshot);
  none.candidates[0].lifecycleV11.skuPackage.productionAuthorization = null;
  assert.equal(productionAuthorizationRollbackEligible(none, none.candidates[0]).blocker,
    PRODUCTION_AUTHORIZATION_ROLLBACK_BLOCKERS.NO_AUTHORIZATION);

  // 后端也拒绝，不只靠前端不显示：直接对当前（可再派一轮）状态提交作废请求。
  await rejectsUnchanged(f, () => f.useCase.rollback({ actor: OWNER,
    input: { ...f.input, expectedRevision: snapshot.candidates[0].dataRevision } }), /请先用「再派一轮生产作业」/);
});

/** 作废→重签之后的文档：归档两轮（旧授权号）＋当前轮（新授权号）。 */
async function archivedPlusCurrentDocument(t) {
  const f = await signedFixture(t);
  await f.useCase.rollback({ actor: OWNER, input: f.input });
  const restored = (await f.repository.readSnapshot()).candidates[0];
  const sku = restored.lifecycleV11.skuPackage;
  const card = sku.productionConfirmationCard;
  const preparation = sku.c2FinalAssets.productionAuthorizationPreparation;
  await commitSingleOwnerProductionAuthorization({ ...f.source.args,
    input: { ...f.source.args.input, dataRevision: restored.dataRevision, skuRevision: sku.dataRevision,
      cardId: card.cardId, cardRevision: card.cardRevision,
      sourcePreparationFingerprint: preparation.preparationFingerprint,
      sourceFinalCardInputFingerprint: preparation.finalCardInputFingerprint },
    serverClock: () => new Date(Date.parse(f.source.formal.at) + 10_000).toISOString() });
  return await f.repository.readSnapshot();
}

const viewFor = document => buildDESavedJobRuntimeView({ candidate: document.candidates[0],
  runtime: document.runtime, observedAt: "2026-08-12T13:30:00.000Z" });

test("归档轮次带旧授权号时视图不再误判来源冲突，按钮按当前轮状态给", async t => {
  const document = await archivedPlusCurrentDocument(t);
  const view = viewFor(document);
  assert.notEqual(view.status, "source_conflict", "归档轮次是正常状态，不是来源错乱");
  assert.equal(view.d.sourceBlockReason, null);
  // 这一层只喂了候选与作业，没喂服务/绑定配置，所以继续与否由配置阻断决定；
  // 本条要钉死的是「不再因为归档轮次判来源错乱」，配置齐备下的可继续由验收测试覆盖。
  assert.equal(view.d.status, "queued", "当前轮应当被认出来，而不是退化成 source_conflict");
  assert.ok(view.d.configurationBlockReason !== undefined);
  assert.equal(view.canRollbackAuthorization, false, "还没失败，不该给作废");
});

test("外来授权号不在归档里时，仍然判来源冲突", async t => {
  const document = await archivedPlusCurrentDocument(t);
  const current = document.candidates[0].lifecycleV11.skuPackage.productionAuthorization.authorizationId;
  const stranger = document.runtime.softwareJobs.find(job => job.jobType === "d_production_execution" &&
    job.scopeBinding.authorizationRef !== current);
  assert.ok(stranger, "夹具里应当有归档轮次");
  stranger.scopeBinding = { ...stranger.scopeBinding, authorizationRef: `${stranger.scopeBinding.authorizationRef}:stranger` };
  const view = viewFor(document);
  assert.equal(view.status, "source_conflict");
  assert.equal(view.d.sourceBlockReason, "DE_SAVED_JOB_REFERENCE_CONFLICT");
  assert.equal(view.canContinueSaved, false);
});

test("归档轮次一旦带着回执或已发出的请求，仍然判来源冲突", async t => {
  for (const mutate of [
    job => { job.resultEnvelope = { schemaVersion: "software-job-result-envelope-v1", jobId: job.jobId }; },
    job => { job.externalRequestRef = "request:someone-sent-this"; },
    job => { job.externalRequestState = "sent"; },
    job => { job.status = "completed"; }
  ]) {
    const document = await archivedPlusCurrentDocument(t);
    const current = document.candidates[0].lifecycleV11.skuPackage.productionAuthorization.authorizationId;
    const archived = document.runtime.softwareJobs.find(job => job.jobType === "d_production_execution" &&
      job.scopeBinding.authorizationRef !== current);
    mutate(archived);
    const view = viewFor(document);
    assert.equal(view.status, "source_conflict", `归档轮次被改成 ${JSON.stringify(archived.status)} / ${archived.externalRequestState} 后必须判冲突`);
    assert.equal(view.d.sourceBlockReason, "DE_SAVED_JOB_REFERENCE_CONFLICT");
  }
});
