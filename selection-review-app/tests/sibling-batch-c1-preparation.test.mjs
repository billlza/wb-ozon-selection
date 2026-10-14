import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { commitSiblingBatchC1Preparation, previewSiblingBatchC1Preparation } from '../lib/sibling-batch-c1-preparation.mjs';
import { commitSiblingBatchC2Final } from '../lib/sibling-batch-c2-final.mjs';
import { productionOwnerDecisionFixture } from './fixtures/production-owner-decision-fixture.mjs';
import { commitBatchOwnerProductionAuthorization } from '../lib/d-batch-production-authorization.mjs';
import { siblingBatchAuthorizationInput } from '../src/siblingBatchAuthorizationInput.js';
import { prepareProductionCommercialDraft } from '../lib/production-commercial-draft.mjs';
import { buildProductionOwnerPreparationView } from '../lib/production-owner-preparation.mjs';
import { attachProductionProfitEvidence } from './fixtures/production-profit-evidence-fixture.mjs';
import { at, oneColorFixture, threeColorFixture, threeColorC2Fixture } from './fixtures/sibling-batch-final-family-fixture.mjs';
import { loadPublishedSchemaValidator } from './helpers/published-schema-validator.mjs';
import { assertC1SiblingNeutralReuse } from '../lib/c1-sibling-neutral-copy.mjs';
import { fingerprintCanonicalRecord } from '../lib/production-contract-primitives.mjs';

test('three selected colors share one saved dictionary and one formal parent draft but each receives its own C1 and C2', async () => {
  const { repository, actor, input, ids } = await threeColorFixture();
  const result = await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
    actor, input, serverClock: () => at });
  assert.equal(result.members.length, 3);
  assert.equal(result.externalRequests, 0);
  assert.equal(result.paidCalls, 0);
  const saved = await repository.readSnapshot();
  for (const id of ids) {
    const sku = saved.candidates.find(item => item.id === id).lifecycleV11.skuPackage;
    assert.equal(sku.businessPhase, 'C2');
    assert.equal(sku.c2FinalAssets.status, 'awaiting_final_uploads');
    assert.equal(sku.c1ProductPlan.draftOnlySeo.formalProviderResultAccepted, false);
  }
  assert.equal(new Set(ids.map(id => saved.candidates.find(item => item.id === id).lifecycleV11.skuPackage.c1ProductPlan.c1PlanId)).size, 3);
  const validator = await loadPublishedSchemaValidator();
  const validate = validator.getSchema('c1-product-plan-v1.1');
  for (const id of ids) {
    const plan = saved.candidates.find(item => item.id === id).lifecycleV11.skuPackage.c1ProductPlan;
    assert.equal(validate(plan), true, JSON.stringify(validate.errors));
    assert.equal(plan.draftOnlySeo.siblingFormalReuseRecord.schemaVersion, 'c1-sibling-neutral-reuse-v2');
    assert.equal(Object.hasOwn(plan.draftOnlySeo.siblingFormalReuseRecord, 'sourcePlan'), false);
  }
  const replay = await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
    actor, input, serverClock: () => at });
  assert.equal(replay.status, 'idempotent_replay');
  assert.deepEqual(await repository.readSnapshot(), saved);
});

test('saved batch replay rejects a changed parent revision, source copy, or batch membership without writes', async () => {
  const { repository, actor, input } = await oneColorFixture();
  await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
    actor, input, serverClock: () => at });
  const checkReplayConflict = async code => {
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchC1Preparation({ repository,
      runtimeMode: 'local_development', actor, input, serverClock: () => at }), code);
    assert.deepEqual(await repository.readSnapshot(), before);
  };
  await repository.transact(document => {
    document.candidates[0].dataRevision += 1;
    return { changed: true, document, result: null };
  });
  await checkReplayConflict(/SIBLING_BATCH_C1_PARENT_CHANGED/);
  await repository.transact(document => {
    const parent = document.candidates[0];
    parent.dataRevision -= 1;
    parent.lifecycleV11.skuPackage.c1ProductPlan.seoTitleDraft.value += ' revised';
    return { changed: true, document, result: null };
  });
  await checkReplayConflict(/SIBLING_BATCH_C1_PARENT_CHANGED/);
  await repository.transact(document => {
    const parent = document.candidates[0];
    parent.lifecycleV11.skuPackage.c1ProductPlan.seoTitleDraft.value =
      parent.lifecycleV11.skuPackage.c1ProductPlan.seoTitleDraft.value.replace(/ revised$/, '');
    parent.sourceCapture.selectedSkuIds = [parent.lifecycleV11.skuPackage.supplierSkuId];
    return { changed: true, document, result: null };
  });
  await checkReplayConflict(/SIBLING_BATCH_C1_SCOPE_MISMATCH/);
});

test('one wrong color or one stale row saves no C1/C2 state for any of three colors', async () => {
  for (const change of [
    input => { input.members[1].colorMappings['10096'] = 'not-official'; },
    input => { input.members[2].candidateRevision += 1; }
  ]) {
    const { repository, actor, input } = await threeColorFixture();
    change(input);
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
      actor, input, serverClock: () => at }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});

test('one C2 confirmation creates three independent final cards from the three-color C1 batch', async () => {
  const { repository, actor, input, verifiedAssets } = await threeColorC2Fixture();
  const result = await commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets, serverClock: () => at });
  assert.equal(result.members.length, 3);
  const saved = await repository.readSnapshot();
  assert.equal(saved.candidates.slice(1).every(child =>
    child.lifecycleV11.skuPackage.productionConfirmationCard?.status === 'awaiting_owner_business_confirmation'), true);
  assert.equal(new Set(saved.candidates.slice(1).map(child => child.lifecycleV11.skuPackage.c2FinalAssets.assets.finalUploads[0].sha256)).size, 3);
  const replay = await commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets: new Map(), serverClock: () => at });
  assert.equal(replay.status, 'idempotent_replay');
  assert.deepEqual(await repository.readSnapshot(), saved);
});

async function authorizePreparedColors(repository, actor, checkStale) {
  const saved = await repository.readSnapshot();
  const firstFixture = productionOwnerDecisionFixture(createMemoryBusinessStateRepository,
    { sourceCandidate: saved.candidates[1], sourceAt: at });
  const configuration = firstFixture.configuration;
  const decisions = saved.candidates.slice(1).map((child, index) => {
    const sourceCandidate = index === 0 ? firstFixture.candidate : structuredClone(child);
    const evidence = index === 0 ? firstFixture : attachProductionProfitEvidence(sourceCandidate);
    const candidate = prepareProductionCommercialDraft({ candidate: sourceCandidate,
      merchantSku: `SYNTHETIC-COLOR-${index}`, stock: 50 + index,
      savedByUserId: 'synthetic-owner', savedAt: at, merchantSkuClaims: [] }).candidate;
    const preparation = buildProductionOwnerPreparationView({ candidate,
      configuration, evidencePacks: evidence.evidencePacks,
      currentCommissionCatalogs: evidence.currentCommissionCatalogs, observedAt: at });
    assert.equal(preparation.ready, true);
    return { candidateId: child.id, candidate, preparation };
  });
  await repository.transact(document => {
    for (const { candidateId, candidate } of decisions) {
      const index = document.candidates.findIndex(item => item.id === candidateId);
      document.candidates[index] = structuredClone(candidate);
    }
    document.evidencePacks = structuredClone(firstFixture.evidencePacks);
    document.currentCommissionCatalogs = structuredClone(firstFixture.currentCommissionCatalogs);
    return { changed: true, document, result: null };
  });
  const parent=(await repository.readSnapshot()).candidates[0];
  const pageDecision = siblingBatchAuthorizationInput(parent,
    decisions.map(({ candidate, preparation }) => ({ ...candidate, productionOwnerPreparation: preparation })),
    firstFixture.args.input.bindingId, { inventoryAction: 'create_only' });
  assert.equal(pageDecision.ready, true, pageDecision.reason);
  const authorizationInput = pageDecision.input;
  assert.deepEqual(authorizationInput.members.map(member => member.candidateId),
    decisions.map(({ candidateId }) => candidateId));
  const beforeAuthorization = await repository.readSnapshot();
  if (checkStale) {
    const stale = structuredClone(authorizationInput);
    stale.members[stale.members.length - 1].ownerInput.dataRevision += 1;
    await assert.rejects(() => commitBatchOwnerProductionAuthorization({ repository,
      runtimeMode: 'local_development', actor, input: stale,
      configuration, serverClock: () => at }));
    for(const change of [
      input=>{input.members.pop();input.postImportScope.eReadbackOfferIds.pop();},
      input=>{input.members[0].candidateId='candidate:unselected';},
      input=>{input.members[1]=structuredClone(input.members[0]);},
      input=>{input.members.reverse();input.postImportScope.eReadbackOfferIds.reverse();},
      input=>{input.parentRevision+=1;},
      input=>{input.excludedOfferIds=['SYNTHETIC-WRONG-FIRST'];}
    ]){
      const altered=structuredClone(authorizationInput);change(altered);
      await assert.rejects(()=>commitBatchOwnerProductionAuthorization({repository,
        runtimeMode:'local_development',actor,input:altered,
        configuration,serverClock:()=>at}));
    }
    assert.deepEqual(await repository.readSnapshot(), beforeAuthorization);
  }
  const batch = await commitBatchOwnerProductionAuthorization({ repository, runtimeMode: 'local_development',
    actor, input: authorizationInput, configuration,
    serverClock: () => at });
  const authorized = await repository.readSnapshot();
  assert.deepEqual(await commitBatchOwnerProductionAuthorization({repository,runtimeMode:'local_development',
    actor,input:authorizationInput,configuration,
    serverClock:()=>at}),batch);
  assert.deepEqual(await repository.readSnapshot(),authorized);
  assert.deepEqual(authorized.candidates[0], saved.candidates[0]);
  assert.equal(authorized.candidates.slice(1).every(child => child.lifecycleV11.skuPackage.productionAuthorization), true);
  return batch;
}

test('a selected 32-variant family prepares exactly 31 C1/C2 cards and one 31-member authorization', async () => {
  const { repository, actor, input, verifiedAssets } = await threeColorC2Fixture(31);
  const before = await repository.readSnapshot();
  assert.equal(before.candidates.length, 32);
  assert.equal(before.candidates[0].lifecycleV11.skuPackage.technicalStatus, 'unknown_outcome');
  const result = await commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets, serverClock: () => at });
  assert.equal(result.members.length, 31);
  const saved = await repository.readSnapshot();
  assert.equal(saved.candidates.slice(1).filter(child =>
    child.lifecycleV11.skuPackage.productionConfirmationCard?.status === 'awaiting_owner_business_confirmation').length, 31);
  assert.equal(saved.candidates.slice(1).every(child => {
    const reuse = child.lifecycleV11.skuPackage.c1ProductPlan.draftOnlySeo.siblingFormalReuseRecord;
    return reuse.schemaVersion === 'c1-sibling-neutral-reuse-v2' && !Object.hasOwn(reuse, 'sourcePlan') &&
      JSON.stringify(reuse).length < 4000;
  }), true);
  assert.deepEqual(saved.candidates[0], before.candidates[0]);
  const batch = await authorizePreparedColors(repository, actor, false);
  assert.equal(batch.members.length, 31);
});

test('one final owner decision authorizes all three prepared colors without authorizing the unknown first item', async () => {
  const { repository, actor, input, verifiedAssets } = await threeColorC2Fixture();
  await commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets, serverClock: () => at });
  const batch = await authorizePreparedColors(repository, actor, true);
  assert.equal(batch.members.length, 3);
});

test('a cross-color main image conflict saves no final card for any row', async () => {
  const { repository, actor, input, verifiedAssets } = await threeColorC2Fixture();
  const saved = await repository.readSnapshot();
  const second = saved.candidates[2];
  const wrongHash = verifiedAssets.get(saved.candidates[1].id)[0].sha256;
  const secondAssets = verifiedAssets.get(second.id);
  secondAssets[0].sha256 = wrongHash;
  await repository.transact(document => {
    document.candidates[2].lifecycleV11.c2UploadDraft.uploads[0].sha256 = wrongHash;
    return { changed: true, document, result: null };
  });
  const before = await repository.readSnapshot();
  await assert.rejects(() => commitSiblingBatchC2Final({ repository, runtimeMode: 'local_development',
    actor, input, verifiedAssets, serverClock: () => at }));
  assert.deepEqual(await repository.readSnapshot(), before);
});

test('one saved official color receipt and common facts advance a sibling from C1 to C2 without another read', async () => {
  const { repository, actor, input, childId } = await oneColorFixture();
  const result = await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
    actor, input, serverClock: () => at });
  assert.equal(result.externalRequests, 0);
  assert.equal(result.members.length, 1);
  const saved = await repository.readSnapshot();
  const sku = saved.candidates.find(item => item.id === childId).lifecycleV11.skuPackage;
  assert.equal(sku.c1ProductPlan.status, 'seo_draft_ready');
  assert.equal(sku.c2FinalAssets.status, 'awaiting_final_uploads');
  assert.equal(sku.ozonAttributeMappingsV1.mappings[0].dictionaryValueId, 910096);
  assert.equal(sku.productionAuthorization, null);
});

test('stale revision or unsupported official color saves no partial C1 state', async () => {
  for (const change of [
    input => { input.members[0].candidateRevision += 1; },
    input => { input.members[0].colorMappings['10096'] = 'not-in-official-receipt'; }
  ]) {
    const { repository, actor, input } = await oneColorFixture();
    change(input);
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
      actor, input, serverClock: () => at }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});

test('old preview, missing source color fact, or changed shared facts cannot commit a sibling batch', async () => {
  for (const change of [
    document => { document.candidates[0].dataRevision += 1; },
    document => { document.candidates[0].lifecycleV11.skuPackage.c1ProductPlan.productAttributes.supplierAttributes
      .find(item => item.fieldKey === '颜色').fact.verificationStatus = 'unknown'; },
    document => { document.candidates[1].lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules.attributes[0].label = 'changed'; }
  ]) {
    const { repository, actor, input } = await oneColorFixture();
    const preview = previewSiblingBatchC1Preparation({ document: await repository.readSnapshot(),
      actor, input, serverClock: () => at });
    assert.equal(preview.previewFingerprint, input.previewFingerprint);
    await repository.transact(document => { change(document); return { changed: true, document, result: null }; });
    const before = await repository.readSnapshot();
    await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
      actor, input, serverClock: () => at }));
    assert.deepEqual(await repository.readSnapshot(), before);
  }
});

test('a source job without a completed applied result cannot supply batch copy', async () => {
  const { repository, actor, input } = await oneColorFixture();
  await repository.transact(document => {
    document.runtime.softwareJobs[0].resultEnvelope.applicationDisposition = 'not_applied';
    return { changed: true, document, result: null };
  });
  const before = await repository.readSnapshot();
  assert.throws(() => previewSiblingBatchC1Preparation({ document: before, actor, input,
    serverClock: () => at }), /C1_CONTENT_REVIEW_APPLIED_RECEIPT_REQUIRED/);
  await assert.rejects(() => commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development',
    actor, input, serverClock: () => at }), /C1_CONTENT_REVIEW_APPLIED_RECEIPT_REQUIRED/);
  assert.deepEqual(await repository.readSnapshot(), before);
});

test('saved v2 copy rechecks each assertion against the current child fact even with a matching content fingerprint', async () => {
  const { repository, actor, input, childId } = await oneColorFixture();
  await commitSiblingBatchC1Preparation({ repository, runtimeMode: 'local_development', actor,
    input, serverClock: () => at });
  const saved = await repository.readSnapshot();
  const plan = saved.candidates.find(item => item.id === childId).lifecycleV11.skuPackage.c1ProductPlan;
  const reuse = plan.draftOnlySeo.siblingFormalReuseRecord;
  plan.seoTitleDraft.assertions[0].value = 'tampered assertion';
  reuse.contentFingerprint = fingerprintCanonicalRecord({ seoTitleDraft: plan.seoTitleDraft,
    descriptionDraft: plan.descriptionDraft, bulletPointsDraft: plan.bulletPointsDraft,
    searchKeywordsDraft: plan.searchKeywordsDraft, keywordEvidenceRefs: plan.keywordEvidenceRefs,
    seoEvidenceLayer: plan.seoEvidenceLayer });
  assert.throws(() => assertC1SiblingNeutralReuse({ plan, resultSkuRevision: reuse.resultSkuRevision }),
    /C1_SIBLING_NEUTRAL_ASSERTION_DIFFERENCE/);
});
