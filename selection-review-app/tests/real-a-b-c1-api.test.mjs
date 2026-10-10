import { currentOtherCosts, currentCostRule } from './fixtures/real-a-b-flow-fixture.mjs';
import { sanitize1688Evidence } from '../lib/source-capture.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";
import { SYNTHETIC_STORE_REF } from "./fixtures/store-binding-fixture.mjs";
import { runRealAConfirmationToBAndC1 } from "../lib/real-a-b-c1-flow.mjs";
import { DEFAULT_GUOO_TARIFF_PATH } from "../lib/guoo-tariff-reader.mjs";
import { DEFAULT_RULES } from "../lib/workflow.mjs";
import { createMusicBoxCandidate } from "./helpers/legacy-candidate-fixture.mjs";
import { buildOwnerCargoFactsRecord } from "../lib/cargo-facts-declaration.mjs";
import { stopApiProcess, allocatedTestPorts } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { api: port, gateway: evidencePort } = allocatedTestPorts();
const evidenceServer = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const { kind, ...scope } = JSON.parse(Buffer.concat(chunks).toString());
  evidenceCalls.push(kind);
  assert.equal(request.url, "/api/read-only/evidence/ozon");
  const now = new Date().toISOString();
  const pack = evidencePacks().find(value => value.kind === kind);
  const evidence = kind === "commission" ? { status: "data_unavailable", current: false,
    reasonCode: "exact_commission_unavailable", scope, checkedAt: now,
    sourceType: "isolated_test", sourceRef: "fixture:exact-commission-unavailable" }
    : { scope, current: true, checkedAt: now, expiresAt: pack.expiresAt,
      sourceType: pack.sourceType, sourceRef: pack.sourceRef, evidenceData: pack.evidenceData };
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: true, evidence }));
});
const evidenceCalls = [];
await new Promise((resolve, reject) => { evidenceServer.once("error", reject); evidenceServer.listen(evidencePort, "127.0.0.1", resolve); });
const evidenceUrl = `http://127.0.0.1:${evidenceServer.address().port}`;
test.after(async () => { evidenceServer.closeAllConnections(); await new Promise(resolve => evidenceServer.close(resolve)); });
const probeDirectory = await mkdtemp(path.join(tmpdir(), "a-b-api-network-guard-"));
const preload = path.join(probeDirectory, "isolated-boundary.mjs");
const guooFile = path.join(appDir, "data", "logistics", path.basename(DEFAULT_GUOO_TARIFF_PATH));
const readProbe = path.join(probeDirectory, "guoo-reads.jsonl");
const forbiddenFile = path.join(probeDirectory, "forbidden-call.json");
await writeFile(preload, `import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {writeFileSync,appendFileSync} from 'node:fs';
const deny=kind=>{writeFileSync(${JSON.stringify(forbiddenFile)},JSON.stringify({kind}));throw new Error('UNEXPECTED_TEST_EXTERNAL_ACTION');};
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{if(new URL(url).origin!==${JSON.stringify(evidenceUrl)})return deny('network');return nativeFetch(url,options);};
const nativeExecFile=childProcess.execFile;
childProcess.execFile=(command,args,...rest)=>{
 const allowed=command==='/usr/bin/unzip'&&Array.isArray(args)&&args[1]===${JSON.stringify(guooFile)}&&
 ((args.length===2&&args[0]==='-Z1')||(args.length===3&&args[0]==='-p'&&/^(?:xl\\/workbook\\.xml|xl\\/_rels\\/workbook\\.xml\\.rels|xl\\/sharedStrings\\.xml|xl\\/worksheets\\/sheet[0-9]+\\.xml)$/.test(args[2])));
 if(!allowed)return deny('credentials');
 appendFileSync(${JSON.stringify(readProbe)},JSON.stringify(args)+'\\n');
 return nativeExecFile(command,args,...rest);
};
childProcess.execFile[promisify.custom]=(...args)=>new Promise((resolve,reject)=>childProcess.execFile(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
// The GUOO reader opens the workbook with Node's own zlib; a real read of the project workbook shows up here (unzip stays allowed for history).
const nativeReadFile=fsPromises.readFile;
fsPromises.readFile=(file,...rest)=>{
 if(String(file)===${JSON.stringify(guooFile)})appendFileSync(${JSON.stringify(readProbe)},JSON.stringify(['readFile',String(file)])+'\\n');
 return nativeReadFile(file,...rest);
};
syncBuiltinESMExports();
`);
test.after(async () => {
  try { await assert.rejects(readFile(forbiddenFile), { code: "ENOENT" }); }
  finally { await rm(probeDirectory, { recursive: true, force: true }); }
});
const isolatedEnv = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`, SELECTION_REVIEW_RUNTIME_MODE: "local_development", SELECTION_REVIEW_IDENTITY_PROVIDER: "development_default",
  SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: evidenceUrl, SELECTION_REVIEW_GUOO_TARIFF_FILE: guooFile,
  SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: "[]", SELECTION_REVIEW_C1_KEYWORD_SERVICE_BINDINGS_JSON: "[]",
  SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: "[]", SELECTION_REVIEW_OZON_DE_CREDENTIAL_BINDINGS_JSON: "[]",
  SELECTION_REVIEW_OZON_ACCOUNT_READ_SERVICE_BINDINGS_JSON: "[]", SELECTION_REVIEW_OZON_ACCOUNT_DISCOVERY_BINDINGS_JSON: "[]",
  SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: "[]", SELECTION_REVIEW_OSS_RUNTIME_CONFIGURATION_JSON: "null" };
const baseUrl = `http://127.0.0.1:${port}`;
const TEST_CATEGORY = "ozon:17028743:971097529";

function evidencePacks() {
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return [{
    id: "fees:ozon:dandanshu:music-box:api-test",
    kind: "commission",
    status: "active",
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: TEST_CATEGORY, salesScheme: "rfbs" },
    checkedAt,
    expiresAt,
    evidenceData: {
      commissionRate: 0.14, commissionEvidenceMode: "exact",
      descriptionCategoryId: 17028743,
      typeId: 971097529,
      otherCosts: {
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 0,
        advertisingRate: 0,
        returnReserveRate: 0,
        damageReserveRate: 0.05,
        withdrawalFeeRate: 0.02,
        targetMarginRate: 0.15,
        minimumUnitProfitRmb: 20,
        priceIncrementCny: 1,
        thresholdLogic: "any",
        pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
      }
    }
  }, {
    id: "logistics:guoo:music-box:api-test",
    kind: "logistics_tariff",
    status: "active",
    scope: { route: "GUOO Economy Small", ruleVersion: "guoo-2026-08-19" },
    checkedAt,
    expiresAt,
    evidenceData: {
      chargeableWeightRule: "max_actual_volume",
      perKgRmb: 20,
      perParcelRmb: 10,
      volumeDivisorCm3PerKg: 6000,
      minimumChargeableWeightKg: 0,
      weightRoundingKg: 0.1
    }
  }, {
    id: "fx:official:api-test:RUB-CNY",
    kind: "exchange_rate",
    status: "active",
    scope: { pair: "RUB/CNY" },
    checkedAt,
    expiresAt,
    evidenceData: {
      rubPerCny: 12
    }
  }, {
    id: "schema:ozon:dandanshu:music-box:api-test",
    kind: "schema",
    status: "active",
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: TEST_CATEGORY, ruleVersion: "ozon-current" },
    checkedAt,
    expiresAt,
    evidenceData: {
      schemaRevision: "api-test",
      requiredFields: [],
      descriptionCategoryId: 17028743,
      typeId: 971097529
    }
  }].map((pack) => ({
    ...pack,
    sourceType: "isolated_test",
    sourceRef: `fixture:${pack.id}`
  }));
}

function payload(candidate) {
  return {
    dataRevision: candidate.dataRevision,
    sourceCandidateId: candidate.id, sourceDataRevision: candidate.dataRevision,
    targetPlatform: candidate.targetPlatform, storeRef: structuredClone(candidate.storeRef),
    decision: "confirm",
    salesReview: {
      snapshotId: candidate.salesSnapshotsV11[0].snapshotId,
      comparability: "comparable",
      validityStatus: "current",
      confidence: "limited"
    },
    supplierConfirmation: {
      captureId: candidate.sourceCapture.captureId,
      minimumOrderQuantity: 1,
      matchType: 'exact_match',
      quantityOneEvidenceSourceNote: 'Synthetic owner verified this exact SKU quantity-one price and MOQ for the API scenario.',
      productUrl: "https://detail.1688.com/offer/876240928352.html",
      supplierSkuId: "SKU-SEWING-MACHINE-01",
      variantKey: "手摇缝纫机音乐盒",
      unitProductPrice: 15.3,
      unitDomesticFreight: 2,
      otherPurchaseCosts: 0,
      actualPurchaseCost: 17.3,
      weightKg: 0.4,
      dimensionsCm: { length: 12, width: 12, height: 7 },
      ownerSupplyConfirmed: true
    }
  };
}

function markSupplierCaptureReady(candidate) {
  candidate.sourceUrl = "https://detail.1688.com/offer/876240928352.html";
  const evidence = sanitize1688Evidence({ offerId: '876240928352', sourceUrl: candidate.sourceUrl,
    observedAt: new Date().toISOString(), title: 'Explicitly synthetic API supplier SKU',
    skus: [{ sourceSkuId: 'SKU-SEWING-MACHINE-01', propPath: '手摇缝纫机音乐盒', attributes: { 款式: '手摇缝纫机音乐盒' },
      priceCny: null, priceSource: null, stock: null, stockSource: null }]
  }, '876240928352');
  candidate.sourceCapture = {
    ...evidence,
    captureId: "SCJ-api-test-ready",
    jobId: "SCJ-api-test-ready",
    status: "captured_waiting_owner_selection",
    jobStatus: "completed",
    mode: "a_supplier_capture",
    attempt: 1,
    originalSourceUrl: "https://qr.1688.com/s/7OnLCakq",
    sourceUrl: candidate.sourceUrl,
    offerId: "876240928352",
    skuChoices: evidence.skus,
    selectedSkuIds: [],
    ownerSupplyConfirmed: false,
    writeOccurred: false,
    businessStateEffect: "unchanged"
  };
  return candidate;
}

async function waitForHealth(child, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

// 只有需要读主人页面的那一个场景会登录；别的场景仍然跑开发默认身份，这里每次起服务前先清空。
let ownerCookie = "";

async function post(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin",
      ...(ownerCookie ? { Cookie: ownerCookie } : {}) },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json(), cookie: response.headers.get("set-cookie") };
}

async function get(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { Origin: baseUrl, "Sec-Fetch-Site": "same-origin", ...(ownerCookie ? { Cookie: ownerCookie } : {}) }
  });
  return { response, body: await response.json() };
}

/** 主人在「算利润」里签下的那份运输属性：没有它，GUOO 线路核验一律 unknown，确认根本走不到读佣金那一步。 */
const DECLARED_CARGO_FACTS = { batteryType: "none", batteryEnergyWh: null, generalCargo: true,
  personalUse: true, irregularShape: false };

async function startEstimateScenario(t, { oldEstimate = false, exact = false, frozen = false, cargoFacts = false, ownerSession = false } = {}) {
  const candidate = markSupplierCaptureReady(createMusicBoxCandidate());
  if (cargoFacts) {
    candidate.cargoFactsV1 = buildOwnerCargoFactsRecord({ candidate, facts: { ...DECLARED_CARGO_FACTS },
      declaredAt: new Date(Date.now() - 60_000).toISOString() });
  }
  delete candidate.lifecycleV11;
  candidate.workflowStatus = 'codex_processing'; candidate.listingHandoff = null;
  candidate.processing = { state: 'idle', manualHold: false };
  candidate.lifecycleEvidenceContextV11 = { ...candidate.lifecycleEvidenceContextV11, category: TEST_CATEGORY, salesScheme: "rfbs" };
  const packs = evidencePacks();
  const historical = { ...structuredClone(packs[0]), id: 'fees:historical-estimate', checkedAt: new Date().toISOString(),
    evidenceData: { ...structuredClone(packs[0].evidenceData), commissionRate: 0.01,
      commissionEvidenceMode: 'estimated', estimateAuthorized: true, exactCommissionRequiredAtC: true } };
  if (frozen) {
    candidate.lifecycleEvidenceContextV11 = { ...candidate.lifecycleEvidenceContextV11, platform:'ozon',store:'dandanshu',salesScheme:'rfbs',route:'GUOO Economy Small',logisticsRuleVersion:'guoo-2026-08-19',exchangePair:'RUB/CNY',schemaRuleVersion:'ozon-current' };
    const at = new Date().toISOString();
    const first = runRealAConfirmationToBAndC1({ candidate, otherCosts: currentOtherCosts(candidate), submission: payload(candidate), evidencePacks: packs, confirmedAt: at });
    candidate.dataRevision += 1;
    candidate.lifecycleV11 = { schemaVersion: 'product-lifecycle-v1.1', status: 'b_passed_auto_c1',
      aConfirmationReceipt: { receiptId: first.confirmationReceiptId, decision: 'confirm', sourceCandidateRevision: first.sourceCandidateRevision, confirmedAt: at },
      opportunityPackage: first.opportunityPackage, ownerSupplyConfirmation: first.ownerSupplyConfirmation,
      bSystemEvidenceBundle: first.systemEvidenceBundle, skuPackage: first.skuPackage, c1Handoffs: [first.c1Handoff] };
  }
  const document = { meta: { version: 2, title: 'isolated conditional B', automationStarted: false },
    rules: { ...structuredClone(DEFAULT_RULES), ozonDandanshu: { ...structuredClone(DEFAULT_RULES.ozonDandanshu), ...currentCostRule(candidate) } }, candidates: [candidate], evidencePacks: [
      ...(exact ? [packs[0]] : []), ...(oldEstimate ? [historical] : []), ...packs.slice(1)], dispatches: [], workflowComments: [] };
  const directory = await mkdtemp(path.join(tmpdir(), 'conditional-b-api-'));
  const dataFile = path.join(directory, 'candidates.json');
  await writeFile(dataFile, JSON.stringify(document));
  // 主人页面的那几条只读视图只认真正登录过的身份，所以要读视图的场景用本机口令身份起服务；
  // 私有身份目录必须和源码、业务数据分开，所以它自己一个临时目录，服务端自己按 0700 建里面那一层。
  let identityEnv = {};
  if (ownerSession) {
    const privateRoot = await mkdtemp(path.join(tmpdir(), 'conditional-b-owner-'));
    t.after(() => rm(privateRoot, { recursive: true, force: true }));
    identityEnv = { SELECTION_REVIEW_IDENTITY_PROVIDER: 'local_owner_password',
      SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(privateRoot, 'identity', 'owner.json') };
  }
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, 'server.mjs'), '--api-only'], { cwd: appDir,
    env: { ...process.env, ...isolatedEnv, ...identityEnv, SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: 'dandanshu', platform: 'ozon', storeRef: SYNTHETIC_STORE_REF }]),
      SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_PUBLIC_ORIGIN: baseUrl, SELECTION_REVIEW_ALLOWED_ORIGINS: baseUrl,
      SELECTION_REVIEW_AUTO_DELIVER: 'off', SELECTION_REVIEW_CODEX_DISPATCH: 'off' }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  t.after(async () => { await stopApiProcess(child); await rm(directory, { recursive: true, force: true }); ownerCookie = ''; });
  await waitForHealth(child, stderr);
  if (ownerSession) {
    const session = await post('/api/owner-access/setup', { password: 'synthetic password for this isolated A confirmation test' });
    assert.equal(session.response.status, 200, JSON.stringify(session.body));
    ownerCookie = String(session.cookie).split(';')[0];
  }
  return { candidate, dataFile, stderr, document };
}


async function guooReadCount() {
  try { return (await readFile(readProbe, 'utf8')).trim().split('\n').length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

async function assertBlockedComparison({ candidate, dataFile, document, input = payload(candidate) }) {
  const firstCall = evidenceCalls.length, beforeReads = await guooReadCount();
  const result = await post(`/api/candidates/${candidate.id}/lifecycle/a-confirm`, input);
  assert.equal(result.response.status, 422, JSON.stringify(result.body));
  assert.match(result.body.message, /B系统证据准备已停止/);
  assert.equal(result.body.guooRouteComparison.status, 'blocked');
  assert.equal(result.body.guooRouteComparison.routes.length, 15);
  assert.deepEqual(result.body.guooRouteComparison.routes.map(row => row.rowNumber), Array.from({length:15}, (_,i)=>i+10));
  assert.equal(result.body.guooRouteComparison.ruleVersion, 'guoo-2026-08-19');
  assert.equal(result.body.guooRouteComparison.selectedRoute, null);
  assert.deepEqual(result.body.evidencePreparation.providerCalls, []);
  assert.deepEqual(evidenceCalls.slice(firstCall), []);
  assert.ok(await guooReadCount() > beforeReads, '必须真实读取项目GUOO原表');
  const saved = JSON.parse(await readFile(dataFile, 'utf8')), current = saved.candidates[0];
  assert.equal(current.dataRevision, candidate.dataRevision + 1);
  assert.equal(current.guooRouteComparisonsV1.length, (candidate.guooRouteComparisonsV1?.length || 0) + 1);
  const comparison = current.guooRouteComparisonsV1.at(-1);
  assert.equal(comparison.sourceRevision, candidate.dataRevision);
  assert.equal(comparison.resultRevision, current.dataRevision);
  assert.ok(Number.isFinite(Date.parse(comparison.recordedAt)));
  assert.deepEqual(current.guooRouteComparisonsV1.slice(0,-1), candidate.guooRouteComparisonsV1 || []);
  for (const key of ['workflowStatus','lifecycleV11','listingHandoff','lifecycleEvidenceContextV11','processing',
    'estimatedCommissionAuthorization','acceptedEstimatedCommission','profitModels','bPassedAt']) {
    assert.deepEqual(current[key], candidate[key], `阻断不得修改 ${key}`);
  }
  assert.deepEqual(saved.evidencePacks, document.evidencePacks);
  assert.deepEqual(saved.dispatches, []);
  assert.equal(saved.meta.automationStarted, false);
  return { current, result };
}

test('真实GUOO前置阻断不接受浏览器假费率，保留证据校验并原子追加比较', async t => {
  const scenario = await startEstimateScenario(t, { exact: true });
  const {candidate,dataFile,stderr} = scenario;
  const untraceableCommission = await post("/api/evidence-packs", {
    kind: "commission",
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: TEST_CATEGORY, salesScheme: "rfbs" },
    summary: "缺来源的结构化证据不得进入正式证据库",
    sourceType: "isolated_test",
    checkedAt: "2026-08-18T02:20:00.000Z",
    expiresAt: "2026-08-19T02:20:00.000Z",
    evidenceData: evidencePacks()[0].evidenceData
  });
  assert.equal(untraceableCommission.response.status, 422);
  assert.match(untraceableCommission.body.message, /可追溯来源/);

  const noExpiryCommission = await post("/api/evidence-packs", {
    kind: "commission",
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: TEST_CATEGORY, salesScheme: "rfbs" },
    summary: "缺有效期的结构化证据不得进入正式证据库",
    sourceType: "isolated_test",
    sourceRef: "fixture:no-expiry",
    checkedAt: "2026-08-18T02:25:00.000Z",
    evidenceData: evidencePacks()[0].evidenceData
  });
  assert.equal(noExpiryCommission.response.status, 422);
  assert.match(noExpiryCommission.body.message, /失效时间/);

  const refreshedCommission = await post("/api/evidence-packs", {
    kind: "commission",
    scope: { platform: "ozon", store: "dandanshu", storeRef: structuredClone(SYNTHETIC_STORE_REF), category: TEST_CATEGORY, salesScheme: "rfbs" },
    summary: "隔离测试中的当前店铺类目佣金",
    sourceType: "isolated_test",
    sourceRef: "fixture:refreshed-commission",
    checkedAt: new Date(Date.now() - 30_000).toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    evidenceData: {
      commissionRate: 0.15, commissionEvidenceMode: "exact",
      descriptionCategoryId: 17028743,
      typeId: 971097529,
      otherCosts: {
        packagingRmb: 1.5,
        labelRmb: 1.5,
        fixedOtherRmb: 0,
        advertisingRate: 0,
        returnReserveRate: 0,
        damageReserveRate: 0.05,
        withdrawalFeeRate: 0.02,
        targetMarginRate: 0.15,
        minimumUnitProfitRmb: 20,
        priceIncrementCny: 1,
        thresholdLogic: "any",
        pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
      }
    }
  });
  assert.equal(refreshedCommission.response.status, 201);
  const refreshedCommissionId = refreshedCommission.body.evidencePack.id;


  scenario.document = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.ok(scenario.document.evidencePacks.some(pack => pack.id === refreshedCommissionId));
  const injected = payload(candidate);
  injected.systemEvidence = {platformFeeEvidence:{evidenceId:'browser-fake',commissionRate:0},
    logisticsEvidence:{evidenceId:'browser-fake',amountRmb:0},exchangeRateEvidence:{evidenceId:'browser-fake',rubPerCny:999}};
  const {current} = await assertBlockedComparison({...scenario,input:injected});
  const beforeStale = await readFile(dataFile, 'utf8'), beforeReads = await guooReadCount();
  const stale = await post(`/api/candidates/${candidate.id}/lifecycle/a-confirm`, payload(candidate));
  assert.equal(stale.response.status, 409);
  assert.equal(await readFile(dataFile, 'utf8'), beforeStale);
  assert.equal(await guooReadCount(), beforeReads);
  await assertBlockedComparison({...scenario,candidate:current});
  assert.equal(stderr.join(''), '');
});

test('缺佣金时真实GUOO先保存缺口，零佣金及其他provider调用', async t => {
  const scenario = await startEstimateScenario(t);
  await assertBlockedComparison(scenario);
  assert.equal(scenario.stderr.join(''), '');
});

/**
 * 2026-09-14 现场那个 bug 的回归：主人点「确认，进入文案素材」，服务端读不到精确佣金停在 422，**同一次失败里**
 * 物流比较落了盘，落盘把 dataRevision 顶高一格。页面在 finally 里重读资料——原来这一读，页面内存里那个「撞上了」
 * 的信号就被当成旧版本清掉了，能救主人的那一块还没渲染就没了。
 *
 * 所以这里走的是完整的那一条真路：真的 GUOO 原表、真的落盘、真的重读视图，断言那一块仍然在，并且说的就是当前
 * 这一版资料。把服务端那条记录改回用顶高之前的版本号（也就是这个 bug 原来的形状），下面 current 那一条立刻变红。
 */
test('精确佣金读不到：物流比较落盘把版本顶高一格，重新读视图那一块仍然在（2026-09-14 现场 bug）', async t => {
  const scenario = await startEstimateScenario(t, { cargoFacts: true, ownerSession: true });
  const { candidate, dataFile, stderr } = scenario;
  const firstCall = evidenceCalls.length;
  // 主人填的目标成交价：GUOO 表按申报价值分档，没有它，表里每一行的报价资格都是「说不准」，确认根本走不到读佣金。
  const input = { ...payload(candidate), targetSalePriceRub: 2000 };
  const result = await post(`/api/candidates/${candidate.id}/lifecycle/a-confirm`, input);

  // 一、确认确实停在「精确佣金读不到、只差主人授权」这一类，而且是读过佣金之后才停的。
  assert.equal(result.response.status, 422, JSON.stringify(result.body));
  assert.match(result.body.message, /B_EVIDENCE_PROVIDER_READ_FAILED: B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED/u);
  assert.deepEqual(evidenceCalls.slice(firstCall), ['commission']);
  assert.equal(result.body.evidencePreparation.failure.layer, 'provider:commission');
  assert.equal(result.body.guooRouteComparison.status, 'compared');
  assert.equal(result.body.guooRouteComparison.transportVerified, true);

  // 二、同一次失败里物流比较落了盘，dataRevision 被顶高一格——这就是这个 bug 的引信。
  const saved = JSON.parse(await readFile(dataFile, 'utf8')).candidates[0];
  assert.equal(saved.dataRevision, candidate.dataRevision + 1);
  assert.equal(saved.guooRouteComparisonsV1.at(-1).resultRevision, saved.dataRevision);

  // 三、这一次停在哪，服务端存成了事实，记的是顶高之后的那个版本号。
  assert.equal(saved.commissionEstimateSignalV1.schemaVersion, 'commission-estimate-signal-v1');
  assert.equal(saved.commissionEstimateSignalV1.exactCommissionUnavailable, true);
  assert.equal(saved.commissionEstimateSignalV1.sourceRevision, candidate.dataRevision);
  assert.equal(saved.commissionEstimateSignalV1.resultRevision, saved.dataRevision);
  assert.equal(saved.commissionEstimateSignalV1.failureLayer, 'provider:commission');
  // 这台机器上没配官方佣金表，服务端也就没说缺口；软件不替它造一句。
  assert.deepEqual(saved.commissionEstimateSignalV1.officialCommissionTableGaps, []);
  // 服务端那句原话不进业务记录：它可能带着本机回环地址或本机路径。
  assert.equal(JSON.stringify(saved.commissionEstimateSignalV1).includes('B_EVIDENCE_PROVIDER_READ_FAILED'), false);

  // 四、页面重读资料（失败之后 finally 里就是这一下）：那一块仍然在，并且说的就是当前这一版资料。
  const view = await get(`/api/candidates/${candidate.id}/lifecycle/supplier-draft`);
  assert.equal(view.response.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.dataRevision, saved.dataRevision);
  assert.equal(view.body.commissionEstimateStepV1.present, true, '重读之后这一块必须还在');
  assert.equal(view.body.commissionEstimateStepV1.current, true, '它说的就是当前这一版资料');
  assert.equal(view.body.commissionEstimateStepV1.recordedRevision, saved.dataRevision);
  assert.deepEqual(view.body.commissionEstimateStepV1.officialGaps, []);

  // 五、这一整轮没有形成利润结论、没有进 C1、没有向平台写任何东西。
  assert.equal(saved.workflowStatus, candidate.workflowStatus);
  assert.equal(saved.lifecycleV11?.skuPackage ?? null, null);
  assert.equal(saved.acceptedEstimatedCommission, undefined);
  assert.equal(stderr.join(''), '');
});

test('独立B证据准备入口在GUOO缺口前零provider且不改业务数据', async t => {
  const scenario = await startEstimateScenario(t, { exact: true });
  const before = await readFile(scenario.dataFile, 'utf8');
  const calls = evidenceCalls.length, reads = await guooReadCount();
  const result = await post(`/api/candidates/${scenario.candidate.id}/lifecycle/b-evidence/prepare`, {
    dataRevision: scenario.candidate.dataRevision
  });
  assert.equal(result.response.status, 422, JSON.stringify(result.body));
  assert.match(JSON.stringify(result.body), /GUOO/);
  assert.equal(evidenceCalls.length, calls);
  assert.equal(await guooReadCount(), reads);
  assert.equal(await readFile(scenario.dataFile, 'utf8'), before);
  assert.equal(scenario.stderr.join(''), '');
});

test('五输入API自动保存经济轻小件46.07表内推荐，未猜配送或调用平台', async t => {
  const scenario = await startEstimateScenario(t, { exact: true });
  const input = payload(scenario.candidate);
  input.targetSalePriceRub = 2000;
  input.supplierConfirmation.weightKg = 1;
  input.supplierConfirmation.dimensionsCm = { length: 20, width: 20, height: 8 };
  const calls = evidenceCalls.length;
  const response = await post(`/api/candidates/${scenario.candidate.id}/lifecycle/a-confirm`, input);
  assert.equal(response.response.status, 422, JSON.stringify(response.body));
  const comparison = response.body.guooRouteComparison;
  assert.equal(comparison.status, 'compared');
  assert.equal(comparison.selectedRoute, 'GUOO Economy Small');
  assert.equal(comparison.selectedRouteLabel, '经济轻小件');
  assert.equal(comparison.minimumRoutes[0].totalFreightRmb, 46.07);
  assert.equal(comparison.transportVerified, false);
  const saved = JSON.parse(await readFile(scenario.dataFile, 'utf8'));
  const current = saved.candidates[0];
  assert.equal(current.guooRouteComparisonsV1[0].inputSnapshot.salePrice.amountRub, 2000);
  assert.equal(current.dataRevision, scenario.candidate.dataRevision + 1);
  assert.deepEqual(current.lifecycleV11, scenario.candidate.lifecycleV11);
  assert.equal(evidenceCalls.length, calls);
  const before = await readFile(scenario.dataFile, 'utf8');
  const readiness = await post(`/api/candidates/${current.id}/lifecycle/b-evidence/prepare`, { dataRevision: current.dataRevision });
  assert.equal(readiness.response.status, 422, JSON.stringify(readiness.body));
  assert.match(JSON.stringify(readiness.body), /TRANSPORT_EVIDENCE_REQUIRED/);
  assert.equal(await readFile(scenario.dataFile, 'utf8'), before);
  assert.equal(evidenceCalls.length, calls);
  assert.equal(scenario.stderr.join(''), '');
});

for (const profitable of [true, false]) {
  test(`本轮估算授权及${profitable ? '低' : '高'}采购成本不能绕过真实GUOO前置`, async t => {
    const scenario = await startEstimateScenario(t);
    const input = payload(scenario.candidate);
    if (!profitable) Object.assign(input.supplierConfirmation,{unitProductPrice:500,actualPurchaseCost:502});
    input.commissionEstimate = {authorized:true,confirmedBy:'owner',commissionRate:0.14};
    await assertBlockedComparison({...scenario,input});
    assert.equal(scenario.stderr.join(''), '');
  });
}

test('历史估算包自报授权不能绕过GUOO或触发佣金读取及估算B', async t => {
  const scenario = await startEstimateScenario(t,{oldEstimate:true});
  const {result} = await assertBlockedComparison(scenario);
  assert.doesNotMatch(JSON.stringify(result.body),/TypeError|Cannot read|commissionEstimate.*null/);
  assert.equal(scenario.stderr.join(''), '');
});

test('准确佣金缓存和本轮估算许可均不能绕过真实GUOO', async t => {
  const scenario = await startEstimateScenario(t,{oldEstimate:true,exact:true});
  const input = payload(scenario.candidate);
  input.commissionEstimate = {authorized:true,confirmedBy:'owner',commissionRate:0.01};
  await assertBlockedComparison({...scenario,input});
  assert.equal(scenario.stderr.join(''), '');
});

test('历史已冻结B和唯一C1幂等重放保持全部字节，零读表和provider', async t => {
  const scenario = await startEstimateScenario(t,{exact:true,frozen:true});
  const before = await readFile(scenario.dataFile,'utf8'), reads = await guooReadCount(), calls = evidenceCalls.length;
  const result = await post(`/api/candidates/${scenario.candidate.id}/lifecycle/a-confirm`,payload(scenario.candidate));
  assert.equal(result.response.status,200,JSON.stringify(result.body));
  assert.equal(result.body.idempotentReplay,true);
  assert.equal(await readFile(scenario.dataFile,'utf8'),before);
  assert.equal(await guooReadCount(),reads); assert.equal(evidenceCalls.length,calls);
  assert.equal(result.body.candidate.lifecycleV11.skuPackage.profitModels.length,1);
  assert.equal(result.body.candidate.lifecycleV11.c1Handoffs.length,1);
  assert.deepEqual(result.body.candidate.lifecycleV11.skuPackage,scenario.candidate.lifecycleV11.skuPackage);
  assert.equal(scenario.stderr.join(''),'');
});

test('主人淘汰仍可原子保存，零读表和provider且不生成利润C1', async t => {
  const scenario = await startEstimateScenario(t,{exact:true});
  const reads = await guooReadCount(), calls = evidenceCalls.length;
  const result = await post(`/api/candidates/${scenario.candidate.id}/lifecycle/a-confirm`,{...payload(scenario.candidate),decision:'reject'});
  assert.equal(result.response.status,200,JSON.stringify(result.body));
  const saved = JSON.parse(await readFile(scenario.dataFile,'utf8')), current=saved.candidates[0];
  assert.equal(current.dataRevision,scenario.candidate.dataRevision+1);
  assert.equal(current.workflowStatus,'eliminated'); assert.equal(current.lifecycleV11.skuPackage,null);
  assert.deepEqual(current.lifecycleV11.c1Handoffs,[]); assert.equal(current.guooRouteComparisonsV1,undefined);
  assert.deepEqual(saved.evidencePacks,scenario.document.evidencePacks); assert.deepEqual(saved.dispatches,[]);
  assert.equal(await guooReadCount(),reads); assert.equal(evidenceCalls.length,calls);
  assert.equal(scenario.stderr.join(''),'');
});
