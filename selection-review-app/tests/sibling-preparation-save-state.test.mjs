import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPreparationSaveState,
  createPreparationSession,
  createPreparationValues,
  preparationValuesEqual,
  preparationDraftScopeCurrent
} from '../src/siblingPreparationState.js';

function fixture(parentCandidateId = 'fixture:parent:A') {
  const supplierSkuIds = ['fixture:black', 'fixture:black-cp', 'fixture:white-cp'];
  const catalog = {
    schemaVersion: 'sibling-preparation-catalog-v1',
    catalogId: 'fixture:save-state', version: 2, offerId: 'fixture:offer', platform: 'ozon',
    supplierSkuIds, excludedSupplierSkuIds: ['fixture:parent-sku'],
    defaults: {
      goods: '18', freight: '6.5', other: '0', packaging: '0', weight: '0.2',
      price: '848', length: '20', width: '30', height: '5', stock: '100',
      route: 'fixture:route', titleRu: 'Fixture title', titleZh: '',
      descriptionRu: 'Fixture description', descriptionZh: 'Common review',
      bulletRu: 'Fixture bullet', bulletZh: '',
      quantityOneEvidenceSourceNote: '', rightsExpiresAt: ''
    },
    colors: Object.fromEntries(supplierSkuIds.map((id, index) => [id, {
      colorRu: `fixture:color:${index}`, platformColors: [`fixture:platform-color:${index}`],
      defaultOrder: [`front:${index}`, 'back', 'detail']
    }])),
    assets: [
      ...supplierSkuIds.map((onlySourceSkuId, index) => ({assetId: `front:${index}`, onlySourceSkuId})),
      {assetId: 'back', onlySourceSkuId: null}, {assetId: 'detail', onlySourceSkuId: null}
    ]
  };
  const members = supplierSkuIds.map((supplierSkuId, index) => ({
    id: `${parentCandidateId}:child:${index}`, dataRevision: index + 1,
    siblingSourceV1: {supplierSkuId}
  }));
  const values = createPreparationValues(catalog, {id: parentCandidateId}, members);
  values.page = 2;
  values.members.forEach((member, index) => { member.hero = `front:${index}`; });
  values.members[0].overrides = {descriptionZh: ''};
  values.members[1].overrides = {stock: '21'};
  values.members[2].order = ['front:2', 'detail', 'back'];
  return {
    catalog,
    input: {
      parentCandidateId, parentRevision: 78,
      memberRevisions: members.map(member => ({candidateId: member.id, revision: member.dataRevision})),
      expectedDraftRevision: 1, idempotencyKey: 'fixture:save:A:1', values
    }
  };
}

function receipt(input, catalog) {
  return {
    draft: {
      schemaVersion: 'sibling-preparation-draft-v1', parentCandidateId: input.parentCandidateId,
      sourceRevision: input.parentRevision, memberRevisions: structuredClone(input.memberRevisions),
      draftRevision: input.expectedDraftRevision + 1,
      catalogId: catalog.catalogId, catalogVersion: catalog.version,
      values: structuredClone(input.values), idempotencyKey: input.idempotencyKey,
      productionAuthorizationGranted: false
    },
    externalRequests: 0, platformWrites: 0
  };
}

function readback(input, catalog) {
  return {
    ...receipt(input, catalog), configured: true,
    catalog: {catalogId: catalog.catalogId, version: catalog.version}
  };
}

function postError(status, code, body = {}) {
  return Object.assign(new Error(code), {
    status, body: {code, externalRequests: 0, platformWrites: 0, ...body}
  });
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
  }
  return value;
}

test('values compare by complete structure, preserve explicit empty overrides and retain every array order', () => {
  const {input} = fixture(), reordered = reverseObjectKeys(input.values);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(input.values));
  assert.equal(preparationValuesEqual(input.values, reordered), true);
  for (const mutate of [
    value => { delete value.members[0].overrides.descriptionZh; },
    value => { value.members[0].overrides.descriptionZh = null; },
    value => { value.members[0].hero = null; },
    value => { value.members[0].order = ['front:0', 'detail', 'back']; },
    value => { value.members[2].order.pop(); },
    value => { value.members.reverse(); },
    value => { value.members[1].platformColors.push('fixture:another-color'); },
    value => { value.shared.stock = 100; },
    value => { delete value.page; },
    value => { value.supplyReviewed = true; }
  ]) {
    const changed = structuredClone(input.values); mutate(changed);
    assert.equal(preparationValuesEqual(input.values, changed), false);
  }
});

test('equal values avoid a save only while parent, every member and catalog identity still match', () => {
  const { input, catalog } = fixture();
  const draft = receipt(input, catalog).draft;
  const parent = { id: input.parentCandidateId, dataRevision: input.parentRevision };
  const siblings = input.memberRevisions.map((row, index) => ({
    id: row.candidateId, dataRevision: row.revision,
    siblingSourceV1: { supplierSkuId: catalog.supplierSkuIds[index] }
  }));
  assert.equal(preparationDraftScopeCurrent(draft, parent, siblings, catalog), true);
  assert.equal(preparationDraftScopeCurrent(draft, parent, [...siblings].reverse(), catalog), true);
  for (const change of [
    scope => { scope.parent.dataRevision += 1; },
    scope => { scope.parent.id = 'fixture:other-parent'; },
    scope => { scope.siblings[1].dataRevision += 1; },
    scope => { scope.siblings.splice(1, 1); },
    scope => { scope.siblings[1].siblingSourceV1.supplierSkuId = 'fixture:other-sku'; },
    scope => { scope.siblings[1].siblingSourceV1.supplierSkuId = scope.siblings[0].siblingSourceV1.supplierSkuId; },
    scope => { scope.catalog.version += 1; },
    scope => { scope.catalog.catalogId = 'fixture:other-catalog'; },
    scope => { scope.catalog.supplierSkuIds.push('fixture:fourth-sku'); },
    scope => { scope.draft.memberRevisions.pop(); },
    scope => { scope.draft.memberRevisions[1] = structuredClone(scope.draft.memberRevisions[0]); }
  ]) {
    const scope = structuredClone({ draft, parent, siblings, catalog }); change(scope);
    assert.equal(preparationValuesEqual(scope.draft.values, input.values), true);
    assert.equal(preparationDraftScopeCurrent(scope.draft, scope.parent, scope.siblings, scope.catalog), false);
  }
  assert.equal(preparationDraftScopeCurrent(null, parent, siblings, catalog), false);
  assert.equal(preparationDraftScopeCurrent(draft, parent, siblings, null), false);
});

test('begin synchronously rejects double clicks and keeps its own input and catalog matching baseline', () => {
  const state = createPreparationSaveState(), {input, catalog} = fixture();
  const originalInput = structuredClone(input), originalCatalog = structuredClone(catalog);
  assert.equal(state.status, 'idle');
  assert.equal(state.reconcile(readback(input, catalog)), 'none');
  const request = state.begin(input, catalog);
  assert.equal(state.status, 'saving');
  assert.deepEqual(request.input, originalInput);
  assert.notEqual(request.input, input);
  assert.notEqual(request.input.values, input.values);
  assert.throws(() => state.begin(input, catalog));
  assert.equal(state.reconcile(readback(originalInput, originalCatalog)), 'pending');
  assert.equal(state.status, 'saving');
  input.idempotencyKey = 'fixture:edited-source';
  input.values.shared.titleRu = 'Edited after begin';
  input.memberRevisions[0].revision += 1;
  request.input.idempotencyKey = 'fixture:edited-handle';
  request.input.values.members[0].order.reverse();
  catalog.catalogId = 'fixture:edited-catalog'; catalog.version += 1;
  assert.equal(state.confirm(request, receipt(originalInput, originalCatalog)), true);
  assert.equal(state.status, 'idle');
});

test('editing the returned request cannot make a receipt for different values pass confirmation', () => {
  const state = createPreparationSaveState(), {input, catalog} = fixture();
  const request = state.begin(input, catalog);
  request.input.values.members[0].hero = null;
  assert.equal(state.confirm(request, receipt(request.input, catalog)), false);
  assert.equal(state.status, 'unknown');
  assert.equal(state.reconcile(readback(input, catalog)), 'confirmed');
  assert.equal(state.status, 'idle');
});

test('confirmed POST and unknown GET receipts accept reordered object keys without weakening values', () => {
  const {input, catalog} = fixture(), state = createPreparationSaveState();
  const request = state.begin(input, catalog);
  assert.equal(state.confirm(request, reverseObjectKeys(receipt(input, catalog))), true);
  const retry = state.begin({
    ...input, expectedDraftRevision: input.expectedDraftRevision + 1, idempotencyKey: 'fixture:save:A:2'
  }, catalog);
  assert.equal(state.fail(retry, new TypeError('Failed to fetch')), 'unknown');
  assert.equal(state.reconcile(reverseObjectKeys(readback(retry.input, catalog))), 'confirmed');
  assert.equal(state.status, 'idle');
});

const rejectedPostCodes = [
  [422, 'CATALOG_SCOPE'], [422, 'DRAFT_INVALID'], [422, 'INPUT_INVALID'], [422, 'VERSION_LIMIT'],
  [409, 'MEMBERS_CHANGED'], [409, 'SOURCE_CHANGED'], [409, 'DRAFT_CONFLICT'], [409, 'FROZEN']
].map(([status, suffix]) => [status, `SIBLING_PREPARATION_${suffix}`]);

test('only the eight explicit POST rejection codes with matching status and zero counters release the request', () => {
  for (const [status, code] of rejectedPostCodes) {
    const state = createPreparationSaveState(), {input, catalog} = fixture();
    const request = state.begin(input, catalog);
    assert.equal(state.fail(request, postError(status, code)), 'idle', code);
    assert.equal(state.status, 'idle', code);
    assert.equal(state.reconcile(readback(input, catalog)), 'none', code);
    assert.equal(state.confirm(request, receipt(input, catalog)), false, code);
  }
});

test('a known conflict leaves edits intact and allows a new manual save using the freshly read revision', () => {
  const state = createPreparationSaveState(), {input, catalog} = fixture();
  const request = state.begin(input, catalog);
  input.values.shared.titleRu = 'User edit retained through conflict';
  assert.equal(state.fail(request, postError(409, 'SIBLING_PREPARATION_DRAFT_CONFLICT')), 'idle');
  const latestDraft = receipt(request.input, catalog).draft;
  latestDraft.draftRevision = 7;
  latestDraft.idempotencyKey = 'fixture:other-save';
  assert.equal(state.reconcile({configured: true, catalog, draft: latestDraft, externalRequests: 0, platformWrites: 0}), 'none');
  assert.equal(state.status, 'idle');
  assert.equal(input.values.shared.titleRu, 'User edit retained through conflict');
  const next = state.begin({
    ...input, expectedDraftRevision: latestDraft.draftRevision, idempotencyKey: 'fixture:save:A:manual'
  }, catalog);
  assert.equal(next.input.expectedDraftRevision, 7);
  assert.notEqual(next.input.idempotencyKey, request.input.idempotencyKey);
  assert.equal(next.input.values.shared.titleRu, 'User edit retained through conflict');
  assert.equal(state.confirm(next, receipt(next.input, catalog)), true);
  assert.equal(state.status, 'idle');
});

test('network, malformed JSON, unknown 500 and replay conflict failures keep the original request unknown', () => {
  const errors = [
    new TypeError('Failed to fetch'), Object.assign(new Error('aborted'), {name: 'AbortError'}),
    Object.assign(new Error('Invalid JSON'), {status: 409}),
    Object.assign(new Error('Invalid JSON'), {status: 200}),
    Object.assign(new Error('Unknown save failure'), {status: 500}),
    postError(500, 'SIBLING_PREPARATION_SOURCE_CHANGED'),
    postError(409, 'SIBLING_PREPARATION_REPLAY_CONFLICT'),
    postError(409, 'SIBLING_PREPARATION_UNRECOGNIZED'),
    Object.assign(new Error('Missing body'), {status: 409, code: 'SIBLING_PREPARATION_DRAFT_CONFLICT'})
  ];
  for (const error of errors) {
    const state = createPreparationSaveState(), {input, catalog} = fixture();
    const request = state.begin(input, catalog);
    assert.equal(state.fail(request, error), 'unknown', error.message);
    assert.equal(state.status, 'unknown', error.message);
    assert.throws(() => state.begin({...input, idempotencyKey: 'fixture:replacement'}, catalog));
    assert.equal(state.reconcile(readback(input, catalog)), 'confirmed', error.message);
    assert.equal(state.status, 'idle', error.message);
  }
});

test('known rejection codes cannot clear pending on wrong status or absent, nonzero or nonnumeric counters', () => {
  const changes = [
    error => { error.status = error.status === 409 ? 422 : 409; },
    error => { delete error.status; },
    error => { delete error.body; },
    error => { delete error.body.code; },
    error => { delete error.body.externalRequests; },
    error => { delete error.body.platformWrites; },
    error => { error.body.externalRequests = 1; },
    error => { error.body.platformWrites = 1; },
    error => { error.body.externalRequests = '0'; },
    error => { error.body.platformWrites = false; }
  ];
  for (const [status, code] of rejectedPostCodes) {
    for (const change of changes) {
      const state = createPreparationSaveState(), {input, catalog} = fixture();
      const request = state.begin(input, catalog), error = postError(status, code); change(error);
      assert.equal(state.fail(request, error), 'unknown', code);
      assert.equal(state.status, 'unknown', code);
    }
  }
});

test('unknown save retains the original key and values after editing until complete same-key readback', () => {
  const state = createPreparationSaveState(), session = createPreparationSession();
  const {input, catalog} = fixture(); session.select(input.parentCandidateId);
  const token = session.capture(), original = structuredClone(input), request = state.begin(input, catalog);
  assert.equal(state.fail(request, new TypeError('Failed to fetch')), 'unknown');
  input.values.members[0].order = ['front:0', 'detail', 'back'];
  input.values.members[1].hero = null;
  input.values.shared.titleRu = 'Newer unsaved title'; session.edited();
  assert.equal(session.current(token), true);
  assert.equal(session.unchanged(token), false);
  assert.equal(state.status, 'unknown');
  assert.deepEqual(request.input, original);
  assert.throws(() => state.begin({...input, idempotencyKey: 'fixture:new-save'}, catalog));
  assert.throws(() => state.begin({
    ...input, parentCandidateId: 'fixture:parent:B', idempotencyKey: 'fixture:new-parent-save'
  }, catalog));
  assert.equal(state.reconcile({...readback(original, catalog), draft: null}), 'unknown');
  const otherKey = readback(original, catalog); otherKey.draft.idempotencyKey = 'fixture:other-key';
  assert.equal(state.reconcile(otherKey), 'unknown');
  assert.equal(state.reconcile(readback(original, catalog)), 'confirmed');
  assert.equal(state.status, 'idle');
  assert.equal(input.values.shared.titleRu, 'Newer unsaved title');
  assert.equal(preparationValuesEqual(input.values, original.values), false);
  const next = state.begin({
    ...input, expectedDraftRevision: original.expectedDraftRevision + 1, idempotencyKey: 'fixture:save:edited'
  }, catalog);
  assert.deepEqual(next.input.values, input.values);
});

const invalidReceipts = [
  ['schema', response => { response.draft.schemaVersion = 'sibling-preparation-draft-v2'; }],
  ['parent', response => { response.draft.parentCandidateId = 'fixture:other-parent'; }],
  ['source revision', response => { response.draft.sourceRevision += 1; }],
  ['member identity', response => { response.draft.memberRevisions[0].candidateId = 'fixture:other-child'; }],
  ['member revision', response => { response.draft.memberRevisions[1].revision += 1; }],
  ['missing member', response => { response.draft.memberRevisions.pop(); }],
  ['member order', response => { response.draft.memberRevisions.reverse(); }],
  ['key', response => { response.draft.idempotencyKey = 'fixture:other-key'; }],
  ['catalog', response => { response.draft.catalogId = 'fixture:other-catalog'; }],
  ['catalog version', response => { response.draft.catalogVersion += 1; }],
  ['old draft revision', response => { response.draft.draftRevision -= 1; }],
  ['future draft revision', response => { response.draft.draftRevision += 1; }],
  ['nonnumeric draft revision', response => { response.draft.draftRevision = String(response.draft.draftRevision); }],
  ['authorization', response => { response.draft.productionAuthorizationGranted = true; }],
  ['missing authorization flag', response => { delete response.draft.productionAuthorizationGranted; }],
  ['missing values', response => { delete response.draft.values; }],
  ['incomplete values', response => { delete response.draft.values.shared; }],
  ['explicit empty override', response => { delete response.draft.values.members[0].overrides.descriptionZh; }],
  ['hero', response => { response.draft.values.members[1].hero = null; }],
  ['gallery selection', response => { response.draft.values.members[2].order.pop(); }],
  ['gallery order', response => { response.draft.values.members[0].order = ['front:0', 'detail', 'back']; }],
  ['shared copy', response => { response.draft.values.shared.titleRu = 'Different saved title'; }],
  ['external request', response => { response.externalRequests = 1; }],
  ['platform write', response => { response.platformWrites = 1; }],
  ['missing external counter', response => { delete response.externalRequests; }],
  ['missing platform counter', response => { delete response.platformWrites; }],
  ['nonnumeric external counter', response => { response.externalRequests = '0'; }],
  ['nonnumeric platform counter', response => { response.platformWrites = false; }]
];

test('POST receipt mismatch stays unknown and only the original complete GET can confirm it', () => {
  for (const [name, mutate] of invalidReceipts) {
    const state = createPreparationSaveState(), {input, catalog} = fixture();
    const request = state.begin(input, catalog), response = receipt(input, catalog); mutate(response);
    assert.equal(state.confirm(request, response), false, name);
    assert.equal(state.status, 'unknown', name);
    assert.equal(state.reconcile(readback(input, catalog)), 'confirmed', name);
    assert.equal(state.status, 'idle', name);
  }
});

test('GET cannot reconcile a null, foreign, incomplete or mismatched draft or current catalog', () => {
  const cases = [
    ...invalidReceipts,
    ['unconfigured', response => { response.configured = false; }],
    ['missing configured', response => { delete response.configured; }],
    ['truthy configured', response => { response.configured = 'true'; }],
    ['missing catalog', response => { delete response.catalog; }],
    ['foreign current catalog', response => { response.catalog.catalogId = 'fixture:other-catalog'; }],
    ['changed current catalog version', response => { response.catalog.version += 1; }],
    ['null draft', response => { response.draft = null; }]
  ];
  for (const [name, mutate] of cases) {
    const state = createPreparationSaveState(), {input, catalog} = fixture();
    const request = state.begin(input, catalog);
    assert.equal(state.fail(request, new TypeError('Failed to fetch')), 'unknown');
    const response = readback(input, catalog); mutate(response);
    assert.equal(state.reconcile(response), 'unknown', name);
    assert.equal(state.status, 'unknown', name);
    assert.throws(() => state.begin(input, catalog), name);
    assert.equal(state.reconcile(readback(input, catalog)), 'confirmed', name);
  }
});

test('missing or malformed success and readback payloads never clear a pending request', () => {
  for (const response of [null, undefined, {}, {draft: null}, 'invalid JSON body']) {
    const state = createPreparationSaveState(), {input, catalog} = fixture();
    const request = state.begin(input, catalog);
    assert.equal(state.confirm(request, response), false);
    assert.equal(state.status, 'unknown');
    assert.equal(state.reconcile(response), 'unknown');
    assert.equal(state.status, 'unknown');
    assert.equal(state.reconcile(readback(input, catalog)), 'confirmed');
  }
});

test('late success, failure and readback cannot change another parent or a later visit to the same parent', () => {
  const state = createPreparationSaveState(), session = createPreparationSession();
  const a = fixture(); session.select(a.input.parentCandidateId);
  const oldToken = session.capture(), oldRequest = state.begin(a.input, a.catalog);
  assert.equal(state.confirm(oldRequest, receipt(a.input, a.catalog)), true);
  const b = fixture('fixture:parent:B'); b.input.idempotencyKey = 'fixture:save:B:1';
  session.select(b.input.parentCandidateId);
  const current = state.begin(b.input, b.catalog);
  assert.equal(session.current(oldToken), false);
  assert.equal(state.confirm(oldRequest, receipt(a.input, a.catalog)), false);
  assert.equal(state.fail(oldRequest, postError(409, 'SIBLING_PREPARATION_DRAFT_CONFLICT')), 'stale');
  assert.equal(state.status, 'saving');
  assert.equal(state.fail(current, new TypeError('Failed to fetch')), 'unknown');
  assert.equal(state.reconcile(readback(a.input, a.catalog)), 'unknown');
  assert.equal(state.status, 'unknown');
  assert.equal(state.reconcile(readback(b.input, b.catalog)), 'confirmed');
  session.select(a.input.parentCandidateId);
  const nextInput = {...a.input, expectedDraftRevision: 2, idempotencyKey: 'fixture:save:A:later'};
  const returned = state.begin(nextInput, a.catalog);
  assert.equal(session.current(oldToken), false);
  assert.equal(state.confirm(oldRequest, receipt(a.input, a.catalog)), false);
  assert.equal(state.fail(oldRequest, new TypeError('Late failure')), 'stale');
  assert.equal(state.status, 'saving');
  assert.equal(state.fail(returned, new TypeError('Failed to fetch')), 'unknown');
  assert.equal(state.reconcile(readback(a.input, a.catalog)), 'unknown');
  assert.equal(state.reconcile(readback(nextInput, a.catalog)), 'confirmed');
});

test('an equal cloned request handle is stale and cannot confirm or fail the active request', () => {
  const state = createPreparationSaveState(), {input, catalog} = fixture();
  const request = state.begin(input, catalog), duplicateHandle = structuredClone(request);
  assert.equal(state.confirm(duplicateHandle, receipt(input, catalog)), false);
  assert.equal(state.fail(duplicateHandle, new TypeError('Late failure')), 'stale');
  assert.equal(state.status, 'saving');
  assert.equal(state.confirm(request, receipt(input, catalog)), true);
  assert.equal(state.status, 'idle');
  assert.equal(state.fail(request, new TypeError('Late failure')), 'stale');
  assert.equal(state.reconcile(readback(input, catalog)), 'none');
});
