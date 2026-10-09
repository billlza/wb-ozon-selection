import { allocatedTestPorts } from './helpers/api-process-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { productionOwnerDecisionHttpFixture, startSavedDEApi } from './helpers/d-e-saved-api-fixture.mjs';
import { createSavedConditionalBFixture, savedGuooRouteComparison } from './fixtures/real-a-b-flow-fixture.mjs';


async function startFixture(t, { rejected = false, mutate = null, evidenceServiceOrigin = null } = {}) {
  const fixture = await createSavedConditionalBFixture({ rejected });
  const owner = await productionOwnerDecisionHttpFixture();
  const document = { ...owner.document, ...fixture.document };
  if (mutate) mutate(document);
  const directory = await mkdtemp(path.join(tmpdir(), 'b-exact-http-state-'));
  const probeDirectory = await mkdtemp(path.join(tmpdir(), 'b-exact-http-probe-'));
  const probe = path.join(probeDirectory, 'counts.json'), preload = path.join(probeDirectory, 'deny-external.mjs');
  await writeFile(probe, JSON.stringify({ credentials: 0, network: 0 }));
  // The isolated child uses the producer's business clock; native timers remain real.
  // Tripwires throw before any actual credential access or request, without fake success.
  await writeFile(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';
const NativeDate=Date;const at=NativeDate.parse(${JSON.stringify(fixture.at)});globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};
const counts={credentials:0,network:0};function deny(kind){counts[kind]++;writeFileSync(${JSON.stringify(probe)},JSON.stringify(counts));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');}
cp.execFile=()=>deny('credentials');syncBuiltinESMExports();
const allowed=${JSON.stringify(evidenceServiceOrigin)};const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>allowed!==null&&String(url).startsWith(allowed)?realFetch(url,init):deny('network');`);
  const { api: port, gateway: dependencyPort } = allocatedTestPorts();
  const environment = { SELECTION_REVIEW_TEST_GATEWAY_PORT: String(dependencyPort),
    SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: '[]', SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON: '[]',
    ...(evidenceServiceOrigin === null ? {} : { SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: evidenceServiceOrigin }),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}` };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  let api;
  try { Object.assign(process.env, environment); api = await startSavedDEApi(t, { directory, port, document, binding: owner.binding }); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  t.after(async () => { assert.deepEqual(JSON.parse(await readFile(probe, 'utf8')), { credentials: 0, network: 0 }); await rm(probeDirectory, { recursive: true, force: true }); });
  const input = { candidateId: fixture.candidate.id, expectedRevision: fixture.candidate.dataRevision,
    skuPackageId: fixture.candidate.lifecycleV11.skuPackage.skuPackageId, failureId: 'failure:b-exact',
    idempotencyKey: 'b-exact:http:1', auditEventId: 'audit:b-exact:http:1' };
  return { ...fixture, api, input, route: `/api/candidates/${input.candidateId}/lifecycle/b/exact-commission/recalculate` };
}

for (const rejected of [false, true]) {
  test(`real B HTTP ${rejected ? 'rejection' : 'pass'} preserves A, saves formal profit once and independently reads the result`, async t => {
    const { api, input, route } = await startFixture(t, { rejected });
    const original = await api.readBytes();
    assert.equal((await api.post(route, input, { authenticated: false })).status, 401);
    assert.deepEqual(await api.readBytes(), original);
    await api.authenticate();
    const before = await api.readBytes(), prior = await api.readDocument();
    const state = await api.get('/api/state');
    assert.equal(state.status, 200);
    const view = state.body.candidates.find(c => c.id === input.candidateId).bExactCommissionRuntimeView;
    assert.equal(view.canRecalculate, true);
    assert.equal(view.expectedRevision, input.expectedRevision);
    assert.deepEqual(await api.readBytes(), before, 'availability GET must not calculate or write');
    for (const attempt of [
      { input, options: { headers: { Origin: 'https://invalid.example', 'Sec-Fetch-Site': 'cross-site' } }, status: 403 },
      { input, options: { headers: { 'Content-Type': 'text/plain' } }, status: 415 },
      { input: { ...input, extra: true }, status: 400 },
      { input: { ...input, expectedRevision: String(input.expectedRevision) }, status: 400 },
      { input: { ...input, candidateId: 'wrong' }, status: 400 },
      { input: { ...input, expectedRevision: input.expectedRevision - 1 }, status: 409 },
      { input: { ...input, skuPackageId: 'wrong' }, status: 409 },
      { input: { ...input, failureId: 'wrong' }, status: 409 }
    ]) {
      const response = await api.post(route, attempt.input, attempt.options);
      assert.equal(response.status, attempt.status, JSON.stringify(response.body) + api.stderr.join(''));
      assert.deepEqual(await api.readBytes(), before);
    }
    const response = await api.post(route, input);
    assert.equal(response.status, 200, JSON.stringify(response.body) + api.stderr.join(''));
    assert.equal(response.body.recalculationStatus, 'committed');
    assert.equal(response.body.result.status, rejected ? 'rejected' : 'passed');
    const saved = await api.readDocument(), candidate = saved.candidates[0], life = candidate.lifecycleV11;
    const oldLife = prior.candidates[0].lifecycleV11;
    for (const key of ['aConfirmationReceipt', 'opportunityPackage', 'ownerSupplyConfirmation']) assert.deepEqual(life[key], oldLife[key]);
    assert.deepEqual(life.skuPackage.selectedSupplySnapshot, oldLife.skuPackage.selectedSupplySnapshot);
    assert.deepEqual(life.skuPackage.profitModels.slice(0, -1), oldLife.skuPackage.profitModels);
    assert.equal(life.skuPackage.profitModels.length, oldLife.skuPackage.profitModels.length + 1);
    assert.equal(life.skuPackage.profitModels.at(-1).calculationType, 'formal');
    assert.equal(life.c1Handoffs.length, rejected ? 0 : 1);
    assert.equal(candidate.workflowStatus, rejected ? 'eliminated' : 'listing_preparation');
    assert.equal(candidate.executionRuntime.technicalFailure, null);
    assert.deepEqual(response.body.result.priorTechnicalFailure, prior.candidates[0].executionRuntime.technicalFailure);
    assert.deepEqual(response.body.result.priorSystemEvidenceBundle, oldLife.bSystemEvidenceBundle);
    assert.deepEqual(saved.runtime.softwareJobs, prior.runtime.softwareJobs);
    const bytes = await api.readBytes();
    const replay = await api.post(route, input);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.recalculationStatus, 'idempotent_replay');
    assert.deepEqual(replay.body.result, response.body.result);
    assert.deepEqual(await api.readBytes(), bytes);
    const readback = await api.get('/api/state');
    assert.equal(readback.status, 200);
    const reread = readback.body.candidates.find(c => c.id === input.candidateId);
    assert.equal(reread.dataRevision, candidate.dataRevision);
    assert.equal(reread.lifecycleV11.skuPackage.activeProfitModelVersion, life.skuPackage.activeProfitModelVersion);
    assert.deepEqual(reread.lifecycleV11.c1Handoffs, life.c1Handoffs);
    await api.assertClean();
  });
}

for (const scenario of [
  { name: 'missing exact commission', mutate: d => { d.evidencePacks = d.evidencePacks.filter(p => p.kind !== 'commission'); }, status: 'evidence_required' },
  { name: 'frozen supply drift', mutate: d => { d.candidates[0].lifecycleV11.skuPackage.selectedSupplySnapshot.supplierSku.actualPurchaseCost += 1; }, status: 'source_conflict' }
]) {
  test(`real B HTTP rejects ${scenario.name} without writes or external calls`, async t => {
    const { api, input, route } = await startFixture(t, scenario);
    await api.authenticate();
    const before = await api.readBytes();
    const state = await api.get('/api/state');
    assert.equal(state.status, 200, JSON.stringify(state.body));
    const view = state.body.candidates.find(c => c.id === input.candidateId).bExactCommissionRuntimeView;
    assert.equal(view.canRecalculate, false);
    assert.equal(view.status, scenario.status);
    const response = await api.post(route, input);
    assert.equal(response.status, 409, JSON.stringify(response.body) + api.stderr.join(''));
    assert.deepEqual(await api.readBytes(), before);
    await api.assertClean();
  });
}

/**
 * 两次点击里的第一次：重新读一次费用证据。
 *
 * 这一条钉的是这条路**在真的服务端进程里**做了什么：主人身份才进得来，已冻结的商品不再被那道
 * 线路闸门挡住，而整条候选记录——**包括 dataRevision**——逐字节不变。版本号一涨，紧接着那一步复算
 * 就会当场过期（停止记录和官方费表绑定同时钉在当前这一版上），所以这里比的是字节，不是「大概没动」。
 *
 * 这台夹具上四类证据都还是当期的，所以这一轮判定为「原样复用」，一个只读提供器都不会被调用——
 * 子进程里连 fetch 都被拦成异常，跑得通本身就说明这条路没有去打任何外部接口。
 */
const REFRESH_RULE_VERSION = 'guoo-2026-08-19';

function refreshableDocument(document) {
  const candidate = document.candidates[0];
  // 服务端按自己配置的那一版资费规则核对；夹具原来的版本号换成它，线路本身不变。
  candidate.lifecycleEvidenceContextV11.logisticsRuleVersion = REFRESH_RULE_VERSION;
  candidate.lifecycleV11.bSystemEvidenceBundle.context.logisticsRuleVersion = REFRESH_RULE_VERSION;
  candidate.lifecycleV11.bSystemEvidenceBundle.logisticsEvidence.ruleVersion = REFRESH_RULE_VERSION;
  document.evidencePacks.find(pack => pack.kind === 'logistics_tariff').scope.ruleVersion = REFRESH_RULE_VERSION;
  candidate.guooRouteComparisonsV1 = [savedGuooRouteComparison(candidate.id, candidate.dataRevision - 1,
    { ruleVersion: REFRESH_RULE_VERSION })];
  return document;
}

const refreshRoute = candidateId => `/api/candidates/${candidateId}/lifecycle/b-evidence/refresh`;

test('重读费用证据：只主人进得来，已冻结的商品走得通，整条记录逐字节不变', async t => {
  const { api, input } = await startFixture(t, { mutate: refreshableDocument });
  const route = refreshRoute(input.candidateId);
  const payload = { candidateId: input.candidateId, expectedRevision: input.expectedRevision };

  const original = await api.readBytes();
  assert.equal((await api.post(route, payload, { authenticated: false })).status, 401);
  assert.deepEqual(await api.readBytes(), original, '没登录就读证据？一个字节都不许落盘');

  await api.authenticate();
  const before = await api.readBytes();
  for (const attempt of [
    { input: payload, options: { headers: { Origin: 'https://invalid.example', 'Sec-Fetch-Site': 'cross-site' } }, status: 403 },
    { input: payload, options: { headers: { 'Content-Type': 'text/plain' } }, status: 415 },
    { input: { ...payload, extra: true }, status: 400 },
    { input: { ...payload, expectedRevision: String(payload.expectedRevision) }, status: 400 },
    { input: { ...payload, candidateId: 'wrong' }, status: 400 },
    { input: { ...payload, expectedRevision: payload.expectedRevision - 1 }, status: 409 }
  ]) {
    const response = await api.post(route, attempt.input, attempt.options);
    assert.equal(response.status, attempt.status, JSON.stringify(response.body) + api.stderr.join(''));
    assert.deepEqual(await api.readBytes(), before);
  }

  const response = await api.post(route, payload);
  assert.equal(response.status, 200, JSON.stringify(response.body) + api.stderr.join(''));
  // 四类证据都还是当期的：原样复用，没有提交新包，也没有调用任何只读提供器。
  assert.deepEqual(response.body.evidencePacks, []);
  assert.equal(response.body.candidateStateChanged, false);
  assert.equal(response.body.platformWrites, 0);
  assert.deepEqual(response.body.evidencePreparation.providerCalls, []);
  assert.equal(response.body.evidencePreparation.plan.status, 'ready_from_reuse');

  // 这一条是重点：版本号和整条记录原地不动，下一步复算才接得上。
  assert.deepEqual(await api.readBytes(), before, '重读这一步不许改动已冻结的记录，版本号也不许涨');
  assert.equal(response.body.candidate.dataRevision, payload.expectedRevision);
  assert.equal(response.body.candidate.bExactCommissionRuntimeView.expectedRevision, payload.expectedRevision);
  assert.equal(response.body.candidate.bExactCommissionRuntimeView.canRecalculate, true,
    '重读之后复算必须当场可用，而不是被自己顶过期');

  // 真的接得上：同一个版本号提交复算，服务端收得下。
  const recalculated = await api.post(`/api/candidates/${input.candidateId}/lifecycle/b/exact-commission/recalculate`, input);
  assert.equal(recalculated.status, 200, JSON.stringify(recalculated.body) + api.stderr.join(''));
  assert.equal(recalculated.body.recalculationStatus, 'committed');
  assert.equal(recalculated.body.result.status, 'passed');
  await api.assertClean();
});

for (const scenario of [
  { name: '没有线路比较可依据', mutate: d => { refreshableDocument(d); d.candidates[0].guooRouteComparisonsV1 = []; }, code: 'COMPARISON_REQUIRED' },
  { name: '已经不在条件测算上', mutate: d => { refreshableDocument(d); d.candidates[0].lifecycleV11.status = 'b_passed_auto_c1'; }, code: 'CONDITIONAL_B_REQUIRED' },
  { name: '已冻结的线路和比较对不上', mutate: d => { refreshableDocument(d); d.candidates[0].lifecycleEvidenceContextV11.route = 'guoo-express-small'; }, code: 'FROZEN_ROUTE_CONFLICT' }
]) {
  test(`重读费用证据在「${scenario.name}」时停住，不落盘也不打任何只读来源`, async t => {
    const { api, input } = await startFixture(t, { mutate: scenario.mutate });
    await api.authenticate();
    const before = await api.readBytes();
    const response = await api.post(refreshRoute(input.candidateId),
      { candidateId: input.candidateId, expectedRevision: input.expectedRevision });
    assert.equal(response.status, 422, JSON.stringify(response.body) + api.stderr.join(''));
    assert.match(response.body.message, new RegExp(scenario.code, 'u'));
    assert.deepEqual(await api.readBytes(), before);
    await api.assertClean();
  });
}

/**
 * 两步接得上：真的读回新证据、真的落了盘，然后同一个版本号提交复算，服务端收得下。
 *
 * 复现的就是主人第一件真货那个形状：类目已经冻成平台身份，佣金和 Schema 还挂在读取时的类目路径上，
 * 两份都是孤儿，复算永远说「读不到更好的证据」。这里让重读这一步真的去读（打的是本机桩，不是平台），
 * 把新证据落盘，再走复算。
 *
 * 钉死的是这条：重读落盘之后，**候选记录连同 dataRevision 一个字节都没变**，所以复算的那三处版本钉
 * （停止记录、运行时、以及官方费表绑定）全都还成立。重读那一步只要把版本顶高一格，这一条当场变红——
 * 先是候选字节对不上，再是复算返回 409。
 */
const ORPHANED_CATEGORY = 'ozon:17028966:96063';

function strandedDocument(document) {
  refreshableDocument(document);
  // r24 那一刀：适用范围冻成平台身份，可同一轮提交的佣金和 Schema 还挂在读取时的类目路径上。
  document.candidates[0].lifecycleEvidenceContextV11.category = ORPHANED_CATEGORY;
  return document;
}

/** 本机只读证据服务的桩：按请求的适用范围原样回一份当期证据，绝不代表平台做任何写操作。 */
async function startEvidenceServiceStub(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const { kind, ...scope } = JSON.parse(body);
      requests.push({ kind, scope, url: request.url });
      const evidence = kind === 'commission'
        ? { current: true, scope, sourceType: 'ozon_seller_api_current_products',
            sourceRef: 'ozon-seller-api:/v3/product/info/list:synthetic', checkedAt: '2026-08-18T03:00:00.000Z',
            expiresAt: '2026-08-19T03:00:00.000Z',
            // 商品成本不跟着佣金来源走：真实 reader 会拒绝带成本的佣金结果，成本来自当前成本政策。
            evidenceData: { commissionRate: 0.12, commissionEvidenceMode: 'exact',
              descriptionCategoryId: 17028966, typeId: 96063 } }
        : { current: true, scope, sourceType: 'ozon_seller_api_current_schema',
            sourceRef: 'ozon-seller-api:/v1/description-category/attribute:17028966:96063',
            checkedAt: '2026-08-18T03:00:00.000Z', expiresAt: '2026-08-19T03:00:00.000Z',
            evidenceData: { schemaRevision: '2026-08-18', requiredFields: [],
              descriptionCategoryId: 17028966, typeId: 96063 } };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, evidence }));
    });
  });
  const port = allocatedTestPorts().second;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { origin: `http://127.0.0.1:${port}`, requests };
}

test('孤儿证据：重读真的读回新证据并落盘，候选记录和版本号不动，紧接着的复算接得上', async t => {
  const stub = await startEvidenceServiceStub(t);
  const { api, input } = await startFixture(t, { mutate: strandedDocument, evidenceServiceOrigin: stub.origin });
  const route = refreshRoute(input.candidateId);
  const payload = { candidateId: input.candidateId, expectedRevision: input.expectedRevision };
  await api.authenticate();

  // 重读之前：这件商品卡死在「读不到更好的证据」。
  const stuck = await api.get('/api/state');
  const stuckView = stuck.body.candidates.find(c => c.id === input.candidateId).bExactCommissionRuntimeView;
  assert.equal(stuckView.canRecalculate, false);
  assert.equal(stuckView.blockReason, 'B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE');
  assert.equal((await api.post(`/api/candidates/${input.candidateId}/lifecycle/b/exact-commission/recalculate`, input)).status, 409);

  const before = await api.readDocument();
  const frozenCandidates = JSON.stringify(before.candidates);

  const response = await api.post(route, payload);
  assert.equal(response.status, 201, JSON.stringify(response.body) + api.stderr.join(''));

  // 只读了佣金和 Schema，打的全是本机桩；线路资费和汇率照旧复用，没有重新读过。
  assert.deepEqual(stub.requests.map(item => item.kind).sort(), ['commission', 'schema']);
  assert.ok(stub.requests.every(item => item.url === '/api/read-only/evidence/ozon'));
  assert.equal(response.body.platformWrites, 0);
  assert.equal(response.body.candidateStateChanged, false);
  assert.deepEqual(response.body.evidencePacks.map(pack => pack.kind).sort(), ['commission', 'schema']);
  // 新证据和这件商品自己的适用范围同键——不是又一份孤儿。
  for (const pack of response.body.evidencePacks) assert.equal(pack.scope.category, ORPHANED_CATEGORY);

  const after = await api.readDocument();
  // 这一条是重点：证据多了两份，候选记录连同 dataRevision 一个字节都没变。
  assert.equal(JSON.stringify(after.candidates), frozenCandidates, '重读不许动已冻结的记录，版本号也不许涨');
  assert.equal(after.evidencePacks.length, before.evidencePacks.length + 2);
  assert.equal(after.candidates[0].dataRevision, input.expectedRevision);

  // 版本钉住了，所以下一步接得上：同一个 expectedRevision 提交复算，服务端收得下并算出正式B。
  const view = response.body.candidate.bExactCommissionRuntimeView;
  assert.equal(view.canRecalculate, true, '重读之后复算必须当场可用，而不是被自己顶过期');
  assert.equal(view.expectedRevision, input.expectedRevision);
  assert.equal(view.commissionEvidenceMode, 'exact');
  assert.equal(view.commissionRate, 0.12);

  const recalculated = await api.post(`/api/candidates/${input.candidateId}/lifecycle/b/exact-commission/recalculate`, input);
  assert.equal(recalculated.status, 200, JSON.stringify(recalculated.body) + api.stderr.join(''));
  assert.equal(recalculated.body.recalculationStatus, 'committed');
  assert.equal(recalculated.body.result.commissionEvidenceMode, 'exact');
  const final = await api.readDocument(), life = final.candidates[0].lifecycleV11;
  assert.equal(life.skuPackage.profitModels.at(-1).calculationType, 'formal');
  // 涨版本号的是复算那一步（以及它之后的 C1 接续），不是重读那一步——重读之后还是 expectedRevision。
  assert.ok(final.candidates[0].dataRevision > input.expectedRevision);
  // 重读那一步落下来的证据，复算一份也没改写。
  for (const pack of response.body.evidencePacks) {
    assert.deepEqual(final.evidencePacks.find(item => item.id === pack.id),
      after.evidencePacks.find(item => item.id === pack.id));
  }
  await api.assertClean();
});
