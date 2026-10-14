import test from 'node:test';
import assert from 'node:assert/strict';
import { createC1CompletedEditorialFixture } from './fixtures/c1-completed-editorial-fixture.mjs';
import { assessC1DraftEditorialContent, applyC1EditorialReview } from '../lib/c1-editorial-review-contract.mjs';
import { readCompletedC1AiSoftwareJobResult } from '../lib/software-job-contract.mjs';

function blocked(bundle) {
  const assessment=assessC1DraftEditorialContent(bundle);
  assert.equal(assessment.status,'blocked');
  assert.equal(assessment.editedVersion,null);
  assert.ok(assessment.reasons.length>0);
  return assessment;
}

test('v2 changes only description and its review translation from a genuinely applied result',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected external call');});
  const f=await createC1CompletedEditorialFixture();
  const original=structuredClone(f.bundle),before=await f.repository.readSnapshot();
  const assessed=assessC1DraftEditorialContent(f.bundle);
  assert.equal(assessed.status,'editorial_proposed',JSON.stringify(assessed.reasons));
  assert.equal(assessed.originalValidation.valid,true);
  assert.equal(assessed.editedValidation.valid,true);
  const version=assessed.editedVersion;
  assert.equal(version.schemaVersion,'c1-draft-editorial-version-v2');
  assert.equal(version.status,'proposal_only');
  assert.equal(version.providerReceiptReplaced,false);
  assert.equal(version.productionApproved,false);
  assert.equal(version.automaticApplicationAllowed,false);
  assert.equal(version.semanticValidation.automatedSemanticProof,false);
  assert.equal(version.changes.length,1);
  assert.equal(version.changes[0].path,'output.description');
  assert.equal(version.output.description.text,f.bundle.correctionPlan.items[0].correctedText);
  assert.equal(version.output.description.reviewZh,f.bundle.correctionPlan.items[0].correctedReviewZh);
  assert.ok(version.output.description.factRefs.includes(f.addedFact.factPath));
  assert.ok(version.output.description.assertions.some(row=>row.factPath===f.addedFact.factPath));
  for(const key of Object.keys(original.receipt.output).filter(key=>key!=='description')) assert.deepEqual(version.output[key],original.receipt.output[key]);
  assert.notEqual(version.outputFingerprint,original.receipt.outputFingerprint);
  assert.deepEqual(f.bundle,original);
  assert.deepEqual(await f.repository.readSnapshot(),before);
  assert.equal(f.gatewayCalls(),1);
  assert.equal(before.runtime.operationAudit.filter(row=>row.action==='c1_ai_draft_apply').length,1);
  const second=structuredClone(f.bundle);second.correctionPlan.items[0].correctedReviewZh+=' 新版测试释义。';
  assert.notEqual(assessC1DraftEditorialContent(second).editedVersion.editorialVersionId,version.editorialVersionId);
  const {settledExecution}=readCompletedC1AiSoftwareJobResult(f.bundle.sourceJob,{allowApplied:true});
  assert.throws(()=>applyC1EditorialReview({skuPackage:f.candidate.lifecycleV11.skuPackage,bundle:f.bundle,editedVersion:version,
    ownerConfirmation:{confirmedAt:f.at},settledExecution}),
    error=>error.code==='C1_EDITORIAL_OWNER_CONFIRMATION_INVALID');
  assert.deepEqual(await f.repository.readSnapshot(),before);
});

test('v2 rejects unapplied or mismatched successful source records without changing them',async()=>{
  const f=await createC1CompletedEditorialFixture();
  for(const mutate of [b=>b.sourceJob.resultEnvelope.applicationDisposition='result_recorded_no_candidate_mutation',
    b=>b.sourceJob.status='failed',b=>b.sourceJob.externalRequestState='unknown_outcome',
    b=>b.sourceJob.candidateId='candidate:foreign',b=>b.sourceJob.skuPackageId='sku:foreign',
    b=>b.sourceJob.scopeBinding.identity.storeRef.stableStoreId='store:foreign',
    b=>b.sourceJob.resultEnvelope.payloadFingerprint='0'.repeat(64),
    b=>b.request.requestFingerprint='0'.repeat(64),b=>b.receipt.outputFingerprint='0'.repeat(64)]) {
    const changed=structuredClone(f.bundle);mutate(changed);const before=structuredClone(changed);
    blocked(changed);assert.deepEqual(changed,before);
  }
  assert.deepEqual(await f.repository.readSnapshot(),f.document);
});

test('v2 rejects stale original values, undeclared edits, missing evidence and no-op changes',async()=>{
  const f=await createC1CompletedEditorialFixture();
  for(const mutate of [p=>p.items[0].originalText+=' changed',p=>p.items[0].originalReviewZh+=' changed',
    p=>delete p.items[0].correctedReviewZh,p=>p.items[0].correctedReviewZh='',
    p=>p.items[0].extraField=true,p=>p.items[0].factPaths.push('productAttributes.unknown.fact'),
    p=>p.items[0].sourceRefs=[],p=>p.items[0].originalAssertions[0].value='changed',
    p=>p.items[0].path='output.nonexistent',p=>p.items.push(structuredClone(p.items[0])),
    p=>p.items=[],p=>p.items[0].factPaths=['owner-fact:outside-this-request']]) {
    const changed=structuredClone(f.bundle);mutate(changed.correctionPlan);blocked(changed);
  }
  const noop=structuredClone(f.bundle),item=noop.correctionPlan.items[0],original=noop.receipt.output.description;
  item.correctedText=original.text;item.correctedReviewZh=original.reviewZh;item.factPaths=[...original.factRefs];
  item.sourceRefs=[...new Set(item.factPaths.flatMap(path=>noop.request.verifiedFacts.find(fact=>fact.factPath===path).evidenceRefs))];
  assert.equal(blocked(noop).reasons[0].code,'EDITORIAL_NO_CHANGE');
  const incomplete=structuredClone(f.bundle);
  assert.ok(incomplete.correctionPlan.items[0].sourceRefs.length>1);
  incomplete.correctionPlan.items[0].sourceRefs.pop();
  assert.equal(blocked(incomplete).reasons[0].code,'EDITORIAL_EVIDENCE_INSUFFICIENT');
  assert.deepEqual(await f.repository.readSnapshot(),f.document);
});
