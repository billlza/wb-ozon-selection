import test from 'node:test';
import assert from 'node:assert/strict';
import {createC1PaidFormalFixture} from './fixtures/c1-draft-source-fixture.mjs';
import {buildRequest} from './fixtures/c1-ai-draft-fixture.mjs';
import {buildC1GatewayJob} from '../lib/c1-ai-gateway.mjs';
import {decodeC1GatewayInput} from '../lib/c1-gateway-input-encoding.mjs';
import {fingerprintCanonicalRecord} from '../lib/production-contract-primitives.mjs';

const payload = job => JSON.parse(job.input.text.slice(job.input.text.lastIndexOf('\n\n') + 2));
test('compact writing view omits only completed scoring calculations; all decisions, sources and original audit remain exact',()=>{
  const {request,candidate}=createC1PaidFormalFixture();
  const before=structuredClone(request);
  const job=buildC1GatewayJob({candidateId:candidate.id,dataRevision:candidate.dataRevision,request});
  const projected=decodeC1GatewayInput(payload(job));
  const expected=structuredClone(request.keywordEvidence);
  assert.ok(expected.keywords.some(keyword=>Object.hasOwn(keyword,'components')));
  for(const keyword of expected.keywords) delete keyword.components;
  assert.deepEqual(projected.keywordEvidence,expected);
  assert.deepEqual(projected.verifiedFacts,request.verifiedFacts);
  assert.deepEqual(projected.factDefinitions,request.factDefinitions);
  assert.deepEqual(projected.competitorTextEvidence,request.competitorTextEvidence);
  assert.deepEqual(projected.referenceContext,request.referenceContext);
  assert.deepEqual(projected.seoRules,request.seoRules);
  assert.deepEqual(request,before);
  assert.equal(job.evidenceRefs.find(ref=>ref.kind==='seo_keyword_evidence').contentSha256,fingerprintCanonicalRecord(request.keywordEvidence));
  assert.match(job.input.text,/components计算审计明细保存在原证据记录/);
  assert.deepEqual(job.outputSchema,request.outputContractSnapshot.outputSchema);
});
test('legacy writing payload retains its complete scoring record without compact projection or instructions',()=>{
  const request=buildRequest(),before=structuredClone(request);
  const job=buildC1GatewayJob({candidateId:request.sourceIdentity.candidateId,dataRevision:1,request});
  assert.deepEqual(payload(job).keywordEvidence,request.keywordEvidence);
  assert.doesNotMatch(job.input.text,/components计算审计明细保存在原证据记录/);
  assert.deepEqual(request,before);
});
