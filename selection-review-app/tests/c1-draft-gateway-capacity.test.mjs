import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRequest, seoRules } from './fixtures/c1-ai-draft-fixture.mjs';
import { c1DraftPreparedCandidate } from './fixtures/c1-draft-source-fixture.mjs';
import { KEYWORD_NOW } from './fixtures/c1-keyword-planning-fixture.mjs';
import { buildC1GatewayJob, C1AiGatewayError } from '../lib/c1-ai-gateway.mjs';
import { validateC1AiDraftRequest } from '../lib/c1-ai-draft-contract.mjs';
import { prepareCurrentC1AiDraftRequest, assertCurrentC1AiDraftRequestSources } from '../lib/c1-ai-draft-request-source.mjs';
import { prepareC1SoftwareInputs } from '../lib/c1-software-input-preparation.mjs';
import { createC1SoftwareEvidenceStage } from '../lib/c1-software-evidence-stage.mjs';
import { createC1DraftRuntimeServices } from '../lib/c1-draft-runtime-services.mjs';
import { buildC1DraftRuntimeView } from '../lib/c1-draft-runtime-view.mjs';
import { createMemoryBusinessStateRepository, createJsonBusinessStateRepository } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../lib/worker-registry.mjs';

const compact='c1-gateway-input-compact-v1';
const maximum=24000;
const tooLarge=error=>error instanceof C1AiGatewayError && error.code==='C1_AI_GATEWAY_INPUT_TOO_LARGE';
const binding={schemaVersion:'c1-draft-service-binding-v1',provider:'terra',modelVersion:'gpt-5.6-terra',
  credentialAlias:'gateway-alias:synthetic:capacity',workerId:'worker:synthetic:capacity',workerVersion:'worker-version:1',
  gatewayOrigin:'http://127.0.0.1:4318',configurationVersion:'configuration:synthetic:capacity',leaseDurationMs:90000};
const owner=createActorContext({userId:'owner:synthetic:capacity',sessionId:'session:synthetic:capacity',actorType:'human',roles:['owner'],
  source:'authenticated_identity_provider',authenticatedAt:KEYWORD_NOW});
function requestWithText(text,encoding) {
  return buildRequest({seoRules:{...seoRules(),prohibitedClaims:[text]},...(encoding===null?{}:{gatewayInputEncodingVersion:encoding})});
}
function wire(request) {
  return buildC1GatewayJob({candidateId:request.sourceIdentity.candidateId,dataRevision:1,request});
}

for (const encoding of [null,compact]) {
  test(`${encoding??'legacy'} gateway capacity counts the complete encoded UTF-16 text at 24000 and 24001`,()=>{
    const marker='Синтетическое правило 中文 😀 ';
    const initial=requestWithText(marker,encoding);
    assert.equal(initial.gatewayInputEncodingVersion,encoding??undefined);
    assert.equal(validateC1AiDraftRequest(initial).valid,true);
    const baseline=wire(initial).input.text.trim().length;
    assert.ok(baseline<maximum);
    const boundary=requestWithText(marker+'x'.repeat(maximum-baseline),encoding);
    const before=structuredClone(boundary);
    const job=wire(boundary);
    assert.equal(job.input.text.trim().length,maximum);
    assert.ok(Buffer.byteLength(job.input.text,'utf8')>maximum);
    assert.deepEqual(boundary,before);
    const oversized=requestWithText(marker+'x'.repeat(maximum-baseline+1),encoding);
    assert.equal(validateC1AiDraftRequest(oversized).valid,true);
    assert.throws(()=>wire(oversized),tooLarge);
  });
}

function oversizedCandidate() {
  const candidate=c1DraftPreparedCandidate();
  const old=candidate.lifecycleV11.c1SoftwareEvidenceV1;
  const inputs={skuPackage:candidate.lifecycleV11.skuPackage,
    frozenSeoRules:{...structuredClone(old.frozenSeoRules),prohibitedClaims:['synthetic-capacity-rule:'+ 'я'.repeat(40000)]},
    k3KeywordEvidenceSnapshot:old.k3KeywordEvidenceSnapshot,k3CurrentBinding:old.k3CurrentBinding,
    frozenComplexityDecision:old.frozenComplexityDecision};
  const preparedInputs=prepareC1SoftwareInputs({...inputs,preparedAt:old.stagedAt});
  assert.equal(preparedInputs.status,'ready');
  candidate.lifecycleV11.c1SoftwareEvidenceV1=structuredClone(createC1SoftwareEvidenceStage({...inputs,
    candidateId:candidate.id,candidateRevision:old.sourceCandidateRevision,preparedInputs,stagedAt:old.stagedAt}).evidence);
  return candidate;
}

async function fixture(t,{json,saved}) {
  const candidate=oversizedCandidate();
  let request;
  if(saved) {
    request=prepareCurrentC1AiDraftRequest(candidate,KEYWORD_NOW);
    assert.equal(validateC1AiDraftRequest(request).valid,true);
    assertCurrentC1AiDraftRequestSources({candidate,request,observedAt:KEYWORD_NOW});
    candidate.lifecycleV11.c1AiDraftRequestV1=structuredClone(request);
    candidate.dataRevision+=1;
  }
  const document={candidates:[candidate],runtime:{softwareJobs:[],softwareJobAuthorizationRecords:[],softwareJobCredentialBindings:[]}};
  let repository;
  if(json) {
    const directory=await mkdtemp(path.join(tmpdir(),'c1-capacity-test-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const filePath=path.join(directory,'state.json');
    await writeFile(filePath,JSON.stringify(document));
    repository=createJsonBusinessStateRepository({filePath});
  } else repository=createMemoryBusinessStateRepository(document);
  let calls=0;
  const fetchImpl=async()=>{calls+=1;throw new Error('Unexpected external request');};
  t.mock.method(globalThis,'fetch',fetchImpl);
  const registry=createLocalDevelopmentWorkerRegistry({clock:()=>KEYWORD_NOW});
  const services=createC1DraftRuntimeServices({repository,runtimeMode:'local_development',serverClock:()=>KEYWORD_NOW,
    workerRegistry:registry,serviceBindings:[binding],fetchImpl});
  return {candidate,request,repository,services,calls:()=>calls};
}

for(const json of [false,true]) {
  for(const saved of [false,true]) {
    test(`${json?'JSON':'memory'} ${saved?'authorization':'preparation'} rejects valid oversized source without state changes or fetch`,async t=>{
      const f=await fixture(t,{json,saved});
      const before=await f.repository.readSnapshot();
      if(saved) {
        const view=buildC1DraftRuntimeView({candidate:before.candidates[0],runtime:before.runtime,serviceBindings:[binding],observedAt:KEYWORD_NOW});
        assert.equal(view.sourceBlockReason,'C1_AI_GATEWAY_INPUT_TOO_LARGE');
        assert.equal(view.canAuthorize,false);
        assert.equal(view.canContinueSaved,false);
        assert.equal(view.automaticRetryAllowed,false);
      }
      const input={candidateId:f.candidate.id,expectedRevision:f.candidate.dataRevision,
        idempotencyKey:`capacity:${saved?'authorize':'prepare'}`,auditEventId:`audit:capacity:${saved?'authorize':'prepare'}`};
      if(saved) Object.assign(input,{requestRef:f.request.requestId,requestFingerprint:f.request.requestFingerprint,confirmPaidCall:true,expiresAt:null});
      await assert.rejects(()=>saved?f.services.authorizeAndEnqueue({actor:owner,input}):f.services.prepareCurrent({actor:owner,input}),tooLarge);
      const after=await f.repository.readSnapshot();
      assert.deepEqual(after,before);
      assert.equal(after.runtime.softwareJobs.length,0);
      assert.equal(after.runtime.softwareJobAuthorizationRecords.length,0);
      assert.equal(after.runtime.softwareJobCredentialBindings.length,0);
      assert.equal(f.calls(),0);
    });
  }
}

test('the original collection-bound nineteen-keyword input is rejected atomically during handoff retry',async t=>{
  const {createC1KeywordHandoffRetryFixture}=await import('./fixtures/c1-keyword-handoff-retry-fixture.mjs');
  let fetches=0;t.mock.method(globalThis,'fetch',async()=>{fetches++;throw new Error('Unexpected external request');});
  const f=await createC1KeywordHandoffRetryFixture({attributeSourceGranularity:'collection'});
  const before=await f.repository.readSnapshot();
  const request=prepareCurrentC1AiDraftRequest(before.candidates[0],f.clock());
  assert.equal(request.keywordEvidence.keywords.length,19);
  assert.ok(request.keywordEvidence.keywords.every(row=>row.factRefs.length===24&&Object.keys(row.components).length===9));
  assert.throws(()=>wire(request),tooLarge);
  await assert.rejects(()=>f.createServices().retryKeywordHandoff({actor:f.owner,input:f.input}),tooLarge);
  assert.deepEqual(await f.repository.readSnapshot(),before);
  assert.deepEqual(f.counts(),{keywordCalls:1,gatewayCalls:0});
  assert.equal(fetches,0);
});
