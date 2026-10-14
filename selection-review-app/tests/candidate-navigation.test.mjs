import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { api } from '../src/api.js';
import { createLatestRead, createSelectionGuard, openSavedCandidate } from '../src/formState.js';

const state = { candidates: [{ id: 'candidate:a', dataRevision: 71, workflowStatus: 'awaiting_data' },
  { id: 'candidate:b', dataRevision: 72, workflowStatus: 'codex_processing' }] };
function harness(read) {
  const reads = createLatestRead(), selectionGuard = createSelectionGuard();
  let context = { ownerId: 'owner:synthetic', view: 'desk', store: 'miska' };
  const opened = [], missing = [], published = [], options = [];
  const readState = value => {
    options.push(value);
    return reads.run(read, result => published.push(result), value);
  };
  const open = candidateId => openSavedCandidate({ candidateId, readState, selectionGuard,
    getContext: () => ({ ...context }), onOpen: candidate => opened.push(candidate), onMissing: () => missing.push(candidateId) });
  return { reads, selectionGuard, open, opened, missing, published, options,
    changeContext: change => { context = { ...context, ...change }; } };
}

test('opening the saved revision 71 survives overlapping polls and publishes the actual HTTP 200 result once', async t => {
  const response = Promise.withResolvers(), requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return response.promise; });
  const h = harness(api.getState), opened = h.open('candidate:a');
  const pollController = new AbortController();
  const polling = h.reads.run(api.getState, () => assert.fail('joined poll must not republish'), { signal: pollController.signal });
  pollController.abort();
  assert.equal(requests.length, 1);assert.equal(requests[0].url, '/api/state');assert.equal(requests[0].options.signal.aborted, false);
  response.resolve(new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  assert.equal(await opened, 'opened');assert.deepEqual(await polling, state);
  assert.deepEqual(h.opened, [state.candidates[0]]);assert.deepEqual(h.missing, []);assert.deepEqual(h.published, [state]);
  assert.deepEqual(h.options, [{ protect: true, joinProtected: true }]);
});

test('a late pre-navigation poll cannot overwrite the saved candidate selected by the new protected read', async () => {
  const old = Promise.withResolvers(), fresh = Promise.withResolvers(), h = harness(() => fresh.promise);
  let oldSignal;
  const polling = h.reads.run(signal => { oldSignal = signal; return old.promise; }, value => h.published.push(value));
  const opening = h.open('candidate:a');assert.equal(oldSignal.aborted, true);
  fresh.resolve(state);assert.equal(await opening, 'opened');
  old.resolve({ candidates: [] });assert.equal(await polling, null);
  assert.deepEqual(h.published, [state]);assert.deepEqual(h.opened, [state.candidates[0]]);assert.deepEqual(h.missing, []);
});

test('explicit read failure is preserved and never converted into candidate missing', async () => {
  const failure = Object.assign(new Error('shared state unavailable'), { status: 503 });
  const h = harness(async () => { throw failure; });
  await assert.rejects(h.open('candidate:a'), error => error === failure);
  assert.deepEqual(h.opened, []);assert.deepEqual(h.missing, []);assert.deepEqual(h.published, []);
});

test('only a successful current snapshot lacking the requested candidate reports missing', async () => {
  const h = harness(async () => state);
  assert.equal(await h.open('candidate:absent'), 'missing');
  assert.deepEqual(h.missing, ['candidate:absent']);assert.deepEqual(h.opened, []);assert.deepEqual(h.published, [state]);
  // App load already owns its error notice and returns null after a failed or cancelled read.
  const unavailable = harness(async () => null);
  assert.equal(await unavailable.open('candidate:a'), 'cancelled');
  assert.deepEqual(unavailable.missing, []);assert.deepEqual(unavailable.opened, []);
});

test('logout, leaving the source page and switching stores cancel late navigation without reporting missing', async () => {
  for (const changed of [{ ownerId: null }, { ownerId: 'owner:other' }, { view: 'accounts' }, { store: 'dandanshu' }]) {
    const gate = Promise.withResolvers(), h = harness(() => gate.promise), pending = h.open('candidate:a');
    h.changeContext(changed);gate.resolve(state);
    assert.equal(await pending, 'cancelled', JSON.stringify(changed));assert.deepEqual(h.opened, []);assert.deepEqual(h.missing, []);
  }
});

test('logout cancellation of the shared reader prevents old authenticated state from being published', async () => {
  const gate = Promise.withResolvers(), h = harness(() => gate.promise), pending = h.open('candidate:a');
  h.changeContext({ ownerId: null });h.reads.cancel();gate.resolve({ ...state, runtimeArchitecture: { currentUser: { userId: 'owner:synthetic' } } });
  assert.equal(await pending, 'cancelled');assert.deepEqual(h.published, []);assert.deepEqual(h.opened, []);assert.deepEqual(h.missing, []);
});

test('rapid A then B clicks share one protected read but only the latest selection may navigate', async () => {
  const gate = Promise.withResolvers();let calls = 0;
  const h = harness(() => { calls++;return gate.promise; });
  const first = h.open('candidate:a'), second = h.open('candidate:b');
  assert.equal(calls, 1);gate.resolve(state);
  assert.equal(await first, 'cancelled');assert.equal(await second, 'opened');
  assert.deepEqual(h.opened, [state.candidates[1]]);assert.deepEqual(h.missing, []);assert.deepEqual(h.published, [state]);
});

test('a newer unrelated selection invalidates navigation even when owner, view and store are unchanged', async () => {
  const gate = Promise.withResolvers(), h = harness(() => gate.promise), opening = h.open('candidate:a');
  h.selectionGuard.changed();gate.resolve(state);
  assert.equal(await opening, 'cancelled');assert.deepEqual(h.opened, []);assert.deepEqual(h.missing, []);
});

test('navigation joins an in-flight permission read without aborting it or claiming its publication callback', async () => {
  const gate = Promise.withResolvers(), h = harness(() => assert.fail('navigation must reuse permission read'));
  let permissionSignal;const permissionPublished = [];
  const permission = h.reads.run(signal => { permissionSignal = signal;return gate.promise; }, value => permissionPublished.push(value), { protect: true });
  const opening = h.open('candidate:a');assert.equal(permissionSignal.aborted, false);
  gate.resolve(state);assert.deepEqual(await permission, state);assert.equal(await opening, 'opened');
  assert.deepEqual(permissionPublished, [state]);assert.deepEqual(h.published, []);assert.deepEqual(h.opened, [state.candidates[0]]);
});

test('explicit fresh permission reads still replace old protected navigation by default', async () => {
  const old = Promise.withResolvers(), fresh = Promise.withResolvers(), h = harness(() => old.promise);
  const opening = h.open('candidate:a'), permissions = [];
  const refresh = h.reads.run(() => fresh.promise, value => permissions.push(value), { protect: true });
  old.resolve(state);assert.equal(await opening, 'cancelled');fresh.resolve({ candidates: [] });await refresh;
  assert.deepEqual(h.opened, []);assert.deepEqual(h.missing, []);assert.deepEqual(h.published, []);assert.deepEqual(permissions, [{ candidates: [] }]);
});

test('opening without a current owner does not start a read or fabricate a missing candidate', async () => {
  let calls = 0;const h = harness(async () => { calls++;return state; });h.changeContext({ ownerId: null });
  assert.equal(await h.open('candidate:a'), 'cancelled');assert.equal(calls, 0);
  assert.deepEqual(h.opened, []);assert.deepEqual(h.missing, []);
});

test('App reserves permission confirmation for the explicit owner refresh and wires navigation to the tested coordinator', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/confirmOwnerPermissions\s*:\s*true/g)].length, 1);
  assert.match(source, /const refreshOwnerPermissions[\s\S]*?load\(true,\s*\{\s*protect:\s*true,\s*confirmOwnerPermissions:\s*true,\s*signal\s*\}\)/);
  assert.match(source, /if \(confirmOwnerPermissions\) ownerPermissionsKnown\.current = true/);
  assert.doesNotMatch(source, /if \(protect\) ownerPermissionsKnown\.current = true/);
  assert.match(source, /async function openDiscoveredCandidate[\s\S]*?return openSavedCandidate\(/);
});
