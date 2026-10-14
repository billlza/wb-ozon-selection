import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { createC1KeywordHandoffRetryFixture, keywordHandoffDraftBinding } from './fixtures/c1-keyword-handoff-retry-fixture.mjs';
import { openExceptionCase } from '../lib/software-execution-state.mjs';

const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
const dependencyPort = Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT);
if (![port, dependencyPort].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535 &&
    ![4317, 4318, 4173].includes(value)) || port === dependencyPort) throw new Error('TEST_REQUIRES_ISOLATED_PORT');

async function retryHttpFixture(t, { configured = true, unknown = false } = {}) {
  const fixture = await createC1KeywordHandoffRetryFixture();
  const ownerFixture = await productionOwnerDecisionHttpFixture();
  const document = { ...ownerFixture.document, candidates: fixture.document.candidates, runtime: fixture.document.runtime };
  if (unknown) {
    const candidate = document.candidates[0];
    candidate.executionRuntime = openExceptionCase(candidate.executionRuntime, {
      exceptionId: 'exception:synthetic:handoff-http', reasonCode: 'system_failure', failureLayer: 'c1_keyword_handoff',
      evidenceRefs: [fixture.job.resultRef], skuPackageId: fixture.job.skuPackageId, softwareJobId: fixture.job.jobId,
      sourceRevision: fixture.job.revision, lastSuccessfulStepId: 'keyword_evidence_persisted',
      externalRequestRefs: [fixture.job.externalRequestRef], unknownOutcome: false, at: fixture.clock()
    });
  }
  const root = await mkdtemp(path.join(tmpdir(), 'keyword-handoff-http-probe-'));
  const directory = await mkdtemp(path.join(tmpdir(), 'keyword-handoff-http-state-'));
  const probeFile = path.join(root, 'attempts.json'), preload = path.join(root, 'deny-external.mjs');
  await writeFile(probeFile, JSON.stringify({ credentials: 0, network: 0 }));
  // Only the isolated server clock is synthetic. Native timers still enforce real timeouts.
  // These tripwires fail before any real keychain or external fetch; they never supply successful responses.
  await writeFile(preload, `import childProcess from 'node:child_process';\nimport {syncBuiltinESMExports} from 'node:module';\nimport {writeFileSync} from 'node:fs';\nconst NativeDate=Date;const fixed=NativeDate.parse(${JSON.stringify(fixture.clock())});globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};\nconst counts={credentials:0,network:0};function deny(kind){counts[kind]++;writeFileSync(${JSON.stringify(probeFile)},JSON.stringify(counts));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');}\nchildProcess.execFile=()=>deny('credentials');syncBuiltinESMExports();globalThis.fetch=async()=>deny('network');\n`);
  const draftBinding = { ...keywordHandoffDraftBinding, gatewayOrigin: `http://127.0.0.1:${dependencyPort}` };
  const env = { SELECTION_REVIEW_TEST_GATEWAY_PORT: String(dependencyPort),
    SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: JSON.stringify(configured ? [draftBinding] : []),
    SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON: '[]', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let api;
  try { Object.assign(process.env, env); api = await startSavedDEApi(t, { directory, port, document, binding: ownerFixture.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  t.after(async () => { assert.deepEqual(JSON.parse(await readFile(probeFile, 'utf8')), { credentials: 0, network: 0 }); await rm(root, { recursive: true, force: true }); });
  return { ...fixture, api, route: `/api/candidates/${fixture.input.candidateId}/lifecycle/c1/keyword-handoff/retry` };
}

test('retry HTTP validates owner, origin and exact body before preserving or preparing one unpaid request', async t => {
  const { api, input, route, job } = await retryHttpFixture(t);
  const original = await api.readBytes();
  assert.equal((await api.post(route, input, { authenticated: false })).status, 401);
  assert.deepEqual(await api.readBytes(), original);
  await api.authenticate();
  const before = await api.readBytes(), prior = await api.readDocument();
  const rejected = [
    { input, options: { headers: { Origin: 'https://invalid.example', 'Sec-Fetch-Site': 'cross-site' } }, status: 403 },
    { input, options: { headers: { 'Content-Type': 'text/plain' } }, status: 415 },
    { input: { ...input, extra: true }, status: 400 },
    { input: { ...input, expectedRevision: String(input.expectedRevision) }, status: 400 },
    { input: { ...input, keywordJobId: false }, status: 400 },
    { input: { ...input, candidateId: 'candidate:wrong' }, status: 400 },
    { input: { ...input, expectedRevision: input.expectedRevision - 1 }, status: 409 },
    { input: { ...input, keywordJobId: 'software-job:wrong' }, status: 409 },
    { input: { ...input, failureId: 'failure:wrong' }, status: 409 }
  ];
  for (const attempt of rejected) {
    const result = await api.post(route, attempt.input, attempt.options);
    assert.equal(result.status, attempt.status, JSON.stringify(result.body) + api.stderr.join(""));
    assert.deepEqual(await api.readBytes(), before);
  }
  const result = await api.post(route, input);
  assert.equal(result.status, 200, JSON.stringify(result.body) + api.stderr.join(""));
  assert.equal(result.body.handoffStatus, 'committed');
  assert.equal(result.body.candidate.id, input.candidateId);
  assert.equal(result.body.candidate.c1DraftRuntimeView.status, 'awaiting_paid_confirmation');
  assert.equal(result.body.candidate.c1DraftRuntimeView.canAuthorize, true);
  const saved = await api.readDocument(), candidate = saved.candidates[0];
  const request = candidate.lifecycleV11.c1AiDraftRequestV1;
  assert.ok(request?.requestId, 'the real route must persist a new draft request');
  assert.equal(candidate.dataRevision, input.expectedRevision + 1);
  assert.equal(candidate.executionRuntime.technicalFailure, null);
  assert.deepEqual(saved.runtime.softwareJobs, prior.runtime.softwareJobs);
  assert.deepEqual(saved.runtime.softwareJobAuthorizationRecords, prior.runtime.softwareJobAuthorizationRecords);
  assert.deepEqual(saved.runtime.softwareJobCredentialBindings, prior.runtime.softwareJobCredentialBindings);
  assert.deepEqual(saved.runtime.softwareJobs.find(value => value.jobId === job.jobId), job);
  const recovery = saved.runtime.idempotencyRecords.find(value => value.action === 'c1_keyword_handoff_retry');
  assert.ok(recovery, 'the retry must have a saved atomic mutation receipt');
  assert.deepEqual(recovery.result.priorTechnicalFailure, prior.candidates[0].executionRuntime.technicalFailure);
  const savedBytes = await api.readBytes();
  const replay = await api.post(route, input);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.handoffStatus, 'idempotent_replay');
  assert.deepEqual(await api.readBytes(), savedBytes);
  const readback = await api.get('/api/state');
  assert.equal(readback.status, 200);
  const rereadCandidate = readback.body.candidates.find(value => value.id === input.candidateId);
  assert.equal(rereadCandidate.dataRevision, candidate.dataRevision);
  assert.equal(rereadCandidate.c1DraftRuntimeView.requestRef, request.requestId);
  assert.equal(rereadCandidate.c1DraftRuntimeView.status, 'awaiting_paid_confirmation');
  await api.assertClean();
});

for (const scenario of [{ name: 'unconfigured gateway', configured: false }, { name: 'unknown exception', unknown: true }]) {
  test(`retry HTTP rejects ${scenario.name} without mutating the completed keyword or making external calls`, async t => {
    const { api, input, route } = await retryHttpFixture(t, scenario);
    await api.authenticate();
    const before = await api.readBytes();
    const result = await api.post(route, input);
    assert.equal(result.status, scenario.configured === false ? 503 : 409, JSON.stringify(result.body) + api.stderr.join(""));
    assert.deepEqual(await api.readBytes(), before);
    assert.equal((await api.readDocument()).candidates[0].lifecycleV11.c1AiDraftRequestV1, undefined);
    await api.assertClean();
  });
}
