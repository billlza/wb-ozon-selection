import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBusinessStateRepository, initialBusinessStateDocument } from '../lib/business-state-repository.mjs';
import { createActorContext } from '../lib/runtime-identity.mjs';
import { saveSiblingBatchCommercialDrafts } from '../lib/sibling-batch-commercial-drafts.mjs';
import { readyAuthorizationFamily, secondReadyMember } from './fixtures/sibling-batch-final-fixture.mjs';
import { siblingBatchAuthorizationInput } from '../src/siblingBatchAuthorizationInput.js';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

test('one current final card yields one batch authorization request and excludes the previous import', () => {
  const { source, parent, child } = readyAuthorizationFamily();
  const decision = siblingBatchAuthorizationInput(parent, [child], source.args.input.bindingId,
    { inventoryAction: 'create_only' });
  assert.equal(decision.ready, true);
  assert.equal(decision.input.parentCandidateId, parent.id);
  assert.equal(decision.input.parentRevision, parent.dataRevision);
  assert.deepEqual(decision.input.excludedOfferIds, ['MERCHANT-PREVIOUS']);
  assert.equal(decision.input.members[0].ownerInput.merchantSku, 'MERCHANT-CHILD');
  assert.equal(decision.input.members[0].ownerInput.confirmExactScope, true);
  const stale = structuredClone(child);
  stale.productionOwnerPreparation.source.dataRevision -= 1;
  assert.equal(siblingBatchAuthorizationInput(parent, [stale], source.args.input.bindingId,
    { inventoryAction: 'create_only' }).ready, false);
  assert.deepEqual(siblingBatchAuthorizationInput({ ...parent, dataRevision: null }, [child],
    source.args.input.bindingId, { inventoryAction: 'create_only' }),
  { ready: false, reason: '父卡身份或当前版本缺失，请刷新批次清单。', input: null });
});

test('one final decision locks the existing post-import contract and ordered E offer scope', () => {
  const { source, parent, child } = readyAuthorizationFamily();
  const second = secondReadyMember(parent);
  const bindingId = source.args.input.bindingId;
  const createOnly = siblingBatchAuthorizationInput(parent, [child, second], bindingId,
    { inventoryAction: 'create_only' });
  assert.equal(createOnly.ready, true);
  assert.deepEqual({ parentCandidateId: createOnly.input.parentCandidateId,
    parentRevision: createOnly.input.parentRevision },
  { parentCandidateId: parent.id, parentRevision: parent.dataRevision });
  assert.deepEqual(createOnly.input.postImportScope, { schemaVersion: 'd-batch-post-import-scope-v1',
    inventoryAction: 'create_only', eReadbackOfferIds: ['MERCHANT-CHILD', 'MERCHANT-SECOND'] });
  assert.deepEqual(createOnly.input.members.map(member => member.candidateId), [child.id, second.id]);
  const withStock = siblingBatchAuthorizationInput(parent, [child, second], bindingId,
    { inventoryAction: 'write_authorized_stock' });
  assert.equal(withStock.ready, true);
  assert.deepEqual(withStock.input.postImportScope, { schemaVersion: 'd-batch-post-import-scope-v1',
    inventoryAction: 'write_authorized_stock', eReadbackOfferIds: ['MERCHANT-CHILD', 'MERCHANT-SECOND'] });
  assert.equal(siblingBatchAuthorizationInput(parent, [child, second], bindingId).ready, false);
  assert.equal(siblingBatchAuthorizationInput(parent, [child, second], bindingId,
    { inventoryAction: '' }).ready, false);
});

test('final decision rejects a warehouse that is empty, expired or absent from a selected member', () => {
  const { source, parent, child } = readyAuthorizationFamily();
  const bindingId = source.args.input.bindingId;
  assert.equal(siblingBatchAuthorizationInput(parent, [child], '').ready, false);
  const expired = structuredClone(child);
  expired.productionOwnerPreparation.executionBindings = [];
  assert.equal(siblingBatchAuthorizationInput(parent, [expired], bindingId).ready, false);
  const wrongVersion = structuredClone(child);
  wrongVersion.productionOwnerPreparation.executionBindings[0].configurationVersion = '';
  assert.equal(siblingBatchAuthorizationInput(parent, [wrongVersion], bindingId).ready, false);
});

test('one stock draft submission saves every selected sibling atomically and excludes the old import', async () => {
  const { source, parent, child } = readyAuthorizationFamily();
  const second = secondReadyMember(parent);
  const document = initialBusinessStateDocument({ now: source.args.serverClock() });
  document.candidates = [parent, child, second];
  const repository = createMemoryBusinessStateRepository(document);
  const actor = createActorContext({ userId: 'synthetic-owner', sessionId: 'batch-stock', actorType: 'human',
    roles: ['owner'], source: 'authenticated_identity_provider', authenticatedAt: source.args.serverClock() });
  const input = { parentCandidateId: parent.id, parentRevision: parent.dataRevision, members: [child, second].map((item, index) => ({
    candidateId: item.id, expectedRevision: item.dataRevision,
    skuPackageId: item.lifecycleV11.skuPackage.skuPackageId,
    merchantSku: item.lifecycleV11.productionCommercialDraftV1.merchantSku, stock: 80 + index })) };
  const rejected = structuredClone(input);
  rejected.members[1].expectedRevision -= 1;
  await assert.rejects(saveSiblingBatchCommercialDrafts({ repository, runtimeMode: 'local_development', actor,
    input: rejected, serverClock: source.args.serverClock }), /MEMBER_CHANGED/);
  assert.deepEqual((await repository.readSnapshot()).candidates, [parent, child, second]);
  const duplicateOffer = structuredClone(input);
  duplicateOffer.members[1].merchantSku = duplicateOffer.members[0].merchantSku;
  await assert.rejects(saveSiblingBatchCommercialDrafts({ repository, runtimeMode: 'local_development', actor,
    input: duplicateOffer, serverClock: source.args.serverClock }), /INPUT_INVALID/);
  assert.deepEqual((await repository.readSnapshot()).candidates, [parent, child, second]);
  const saved = await saveSiblingBatchCommercialDrafts({ repository, runtimeMode: 'local_development', actor,
    input, serverClock: source.args.serverClock });
  assert.equal(saved.members.length, 2);
  const after = await repository.readSnapshot();
  assert.deepEqual(after.candidates.slice(1).map(item => item.lifecycleV11.productionCommercialDraftV1.stock), [80, 81]);
  assert.deepEqual(after.candidates[0], parent);
  assert.equal(after.candidates.slice(1).every(item => item.dataRevision >
    [child, second].find(original => original.id === item.id).dataRevision), true);
  await assert.rejects(saveSiblingBatchCommercialDrafts({ repository, runtimeMode: 'local_development', actor,
    input, serverClock: source.args.serverClock }), /MEMBER_CHANGED/);
  assert.deepEqual((await repository.readSnapshot()).candidates, after.candidates);
});

let renderBatch;
async function renderFinalBatch(props) {
  if (!renderBatch) {
    const entry = fileURLToPath(new URL('./sibling-batch-final-ui-entry.jsx', import.meta.url));
    const component = fileURLToPath(new URL('../src/components/SiblingBatchPreparation.jsx', import.meta.url));
    const output = await build({ configFile: false, logLevel: 'warn', plugins: [react(), {
      name: 'sibling-batch-final-review-ui-test', resolveId: id => id === entry ? entry : null,
      load: id => id === entry ? `import React from 'react';import{renderToStaticMarkup}from'react-dom/server';
        import Batch from ${JSON.stringify(component)};
        export const render=props=>renderToStaticMarkup(<Batch {...props}/>);` : null
    }], ssr: { noExternal: true }, build: { ssr: true, write: false,
      rollupOptions: { input: entry, output: { format: 'es' } } } });
    const chunk = output.output.find(item => item.type === 'chunk' && item.isEntry);
    assert.ok(chunk);
    const module = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
    renderBatch = module.render;
  }
  return renderBatch(props);
}

test('the final one-page review displays every row and lets the owner set shared stock then override one row', async () => {
  const { parent, child } = readyAuthorizationFamily();
  const html = await renderFinalBatch({ parent, siblings: [child], onAuthorize: () => {} });
  assert.match(html, /MERCHANT-CHILD/);
  assert.match(html, /37/);
  assert.match(html, /RUB/);
  assert.match(html, /CNY/);
  assert.match(html, /批量库存/);
  assert.match(html, /黑色[^<]*库存调整/);
  assert.doesNotMatch(html, /仅创建商品|导入后库存动作/);
  assert.match(html, /确认上架（含创建和库存）/);
  assert.match(html, /写入每款下表确认的库存/);
  assert.match(html, /全成员.*E.*回读/);
});

test('the final one-page review shows a blocked row’s precise gap beside that SKU', async () => {
  const { parent, child } = readyAuthorizationFamily();
  const blocked = structuredClone(child);
  blocked.productionOwnerPreparation.ready = false;
  blocked.productionOwnerPreparation.gaps = [{ code: 'PRODUCTION_BINDING_EXPIRED',
    message: '合成黑色行的仓库核验已过期' }];
  blocked.productionOwnerPreparation.executionBindings = [];
  const html = await renderFinalBatch({ parent, siblings: [blocked], onAuthorize: () => {} });
  assert.match(html, /黑色/);
  assert.match(html, /MERCHANT-CHILD/);
  assert.match(html, /合成黑色行的仓库核验已过期/);
  assert.match(html, /<button[^>]*disabled[^>]*>确认上架（含创建和库存）<\/button>/);
});

test('execution view keeps per-member unknown and string E gaps visible and offers only unsent stock continuation', async () => {
  const { parent, child } = readyAuthorizationFamily();
  const executionView = { batchId: 'd-batch:synthetic', externalRequestState: 'unknown_outcome',
    excludedOfferIds: ['MERCHANT-PREVIOUS'], members: [{ candidateId: child.id,
      offerId: 'MERCHANT-CHILD', importStatus: 'imported', inventoryStatus: 'awaiting_prerequisites',
      eStatus: 'needs_owner', eGaps: ['synthetic_e_gap'], listedVerified: false }] };
  const html = await renderFinalBatch({ parent, siblings: [child], executionView,
    onResumeStock: () => {}, onRefreshExecution: () => {} });
  assert.match(html, /结果未知，待对账/);
  assert.match(html, /MERCHANT-PREVIOUS/);
  assert.match(html, /synthetic_e_gap/);
  assert.match(html, /恢复明确未发送的库存续作/);
  assert.doesNotMatch(html, /确认上架（含创建和库存）/);
});

test('a proven unsent batch import names the exact offer and bounded stop reason',async()=>{
  const {parent,child}=readyAuthorizationFamily();
  const executionView={batchId:'d-batch:synthetic',externalRequestState:'not_sent',
    excludedOfferIds:['MERCHANT-PREVIOUS'],members:[{candidateId:child.id,
      offerId:'MERCHANT-CHILD',importStatus:'prewrite_blocked',
      importGapCode:'OZON_BATCH_LIMIT_EVIDENCE_REQUIRED',inventoryStatus:'not_started',
      eStatus:'not_started',eGaps:[],listedVerified:false}]};
  const html=await renderFinalBatch({parent,siblings:[child],executionView,
    onRefreshExecution:()=>{}});
  assert.match(html,/MERCHANT-CHILD/);
  assert.match(html,/已确认未发送，写入前停止/);
  assert.match(html,/OZON_BATCH_LIMIT_EVIDENCE_REQUIRED/);
  assert.doesNotMatch(html,/恢复明确未发送的库存续作/);
});
