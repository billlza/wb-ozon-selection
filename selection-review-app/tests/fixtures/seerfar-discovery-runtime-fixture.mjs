import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonBusinessStateRepository, initialBusinessStateDocument } from '../../lib/business-state-repository.mjs';
import { createLocalDevelopmentWorkerRegistry } from '../../lib/worker-registry.mjs';
import { createRepositoryBackedSoftwareJobStore } from '../../lib/software-job-repository.mjs';
import { createActorContext } from '../../lib/runtime-identity.mjs';
import { createADiscoveryRuntimeServices } from '../../lib/a-discovery-runtime-services.mjs';
import { createADiscoveryCandidateImportUseCase } from '../../lib/a-discovery-candidate-import.mjs';

export const seerfarDiscoveryAt = '2026-09-09T04:00:00.000Z';
export const syntheticMarketProduct = (sku = 2107989735) => ({
  sku, title: 'Explicitly synthetic organizer', productUrl: `https://www.ozon.ru/product/${sku}`,
  imageUrl: 'https://images.example.test/synthetic-organizer.png', price: 297, sales: 2
});

/** Synthetic category and points are isolated test inputs, never operational configuration. */
export async function createSeerfarDiscoveryRuntimeFixture(t, { products = [syntheticMarketProduct()], hasNextPage = false, filters = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerfar-discovery-integration-'));
  const filePath = path.join(directory, 'state.json');
  await fs.writeFile(filePath, JSON.stringify(initialBusinessStateDocument({ now: seerfarDiscoveryAt })));
  let now = seerfarDiscoveryAt, secretReads = 0;
  const calls = [], instances = [], waits = [];
  const clock = () => now;
  const advance = ms => { now = new Date(Date.parse(now) + ms).toISOString(); };
  const repository = createJsonBusinessStateRepository({ filePath });
  const owner = createActorContext({ authenticatedAt: now, userId: 'owner:synthetic-seerfar', sessionId: 'session:synthetic-seerfar',
    actorType: 'human', roles: ['owner'], source: 'authenticated_identity_provider' });
  const plan = {
    schemaVersion: 'a-discovery-plan-v2', planId: 'plan:synthetic-seerfar', version: 'version:synthetic-1', provider: 'seerfar',
    contractVersion: 'seerfar-category-discovery-v1', direction: 'Explicitly synthetic category integration test',
    requests: [{ requestId: 'request:synthetic-category', method: 'category_detail', platform: 'ozon', categoryId: '100_200',
      fulfillment: 'rfbs', pageNumber: 1, pageSize: 20, categoryEvidenceRef: 'evidence:synthetic-category', contractEvidenceRef: 'evidence:synthetic-contract',
      // Synthetic owner-declared query conditions; absent unless a test declares them.
      ...(filters === null ? {} : { filters: structuredClone(filters) }) }],
    budget: { unit: 'seerfar_points', maxRequests: 3, maxCredits: 15, policyRef: 'policy:synthetic-budget', policyVersion: 'version:synthetic-1',
      costEvidenceRef: 'evidence:synthetic-cost-only', estimatedPointsByStep: { quota_before: 0, category_detail: 15, quota_after: 0 } },
    exclusions: ['Explicit brands and IP risk', 'Powered products'],
    selection: { schemaVersion: 'a-discovery-selection-v2', marketOrder: 'provider_order', supplierOrder: 'not_requested', maxCandidates: 1 }
  };
  const evidence = { schemaVersion:'seerfar-discovery-evidence-v1', evidenceId:'evidence:synthetic-discovery', version:'version:synthetic-1',
    status:'active',verifiedAt:'2026-09-09T03:00:00.000Z',effectiveFrom:null,expiresAt:null,supersededBy:null,
    category:{evidenceRef:plan.requests[0].categoryEvidenceRef,sourceRef:'source:synthetic-category-only',platform:'ozon',categoryId:'100_200',fulfillment:'rfbs'},
    protocol:{evidenceRef:plan.requests[0].contractEvidenceRef,sourceRef:'source:synthetic-contract-only',contractVersion:plan.contractVersion,method:'category_detail',pageNumber:1,pageSize:20},
    billing:{evidenceRef:plan.budget.costEvidenceRef,sourceRef:'source:synthetic-cost-only',policyRef:plan.budget.policyRef,policyVersion:plan.budget.policyVersion,
      unit:plan.budget.unit,estimatedPointsByStep:structuredClone(plan.budget.estimatedPointsByStep)} };
  const connectorBinding = { schemaVersion: 'seerfar-discovery-binding-v1', provider: 'seerfar', bindingId: 'binding:synthetic-seerfar',
    configurationVersion: 'version:synthetic-1', credentialAlias: 'seerfar-synthetic-only', budgetPolicyRef: plan.budget.policyRef,
    contractVersion: plan.contractVersion, allowedMethods: ['category_detail'], timeoutMs: 1000 };
  const serviceBinding = { schemaVersion: 'a-discovery-service-binding-v1', serviceId: 'service:synthetic-seerfar',
    configurationVersion: 'version:synthetic-1', connectorBindingId: connectorBinding.bindingId,
    connectorConfigurationVersion: connectorBinding.configurationVersion, workerId: 'worker:synthetic-seerfar', workerVersion: 'version:synthetic-1',
    leaseDurationMs: 60000, pumpIntervalMs: 1000 };
  const readSecret = async () => { secretReads++; return 'synthetic-secret-only'; };
  function response(call, { status = 200, body } = {}) {
    const data = call.step === 'category_detail' ? { id: plan.requests[0].categoryId, productList: structuredClone(products), hasNextPage } : { remaining: call.step === 'quota_before' ? 100 : 85 };
    return new Response(JSON.stringify(body === undefined ? { code: status, data } : body),
      { status, headers: { 'content-type': 'application/json', 'x-request-id': `synthetic-${call.step}` } });
  }
  function create(overrides = {}) {
    const targetRepository = overrides.repository === undefined ? repository : overrides.repository;
    const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock });
    const store = createRepositoryBackedSoftwareJobStore({ businessStateRepository: targetRepository, workerRegistry, serverClock: clock });
    const importer = createADiscoveryCandidateImportUseCase({ repository: targetRepository, serverClock: clock, storeBindings: [] });
    const fetchImpl = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://api.seerfar.cn') throw new Error('UNEXPECTED_SYNTHETIC_FETCH_ORIGIN');
      let step;
      if (parsed.pathname === '/open-api/category/detail/search/ozon') step = 'category_detail';
      else if (parsed.pathname === '/open-api/quota') step = calls.some(call => call.step === 'quota_before') ? 'quota_after' : 'quota_before';
      else throw new Error('UNEXPECTED_SYNTHETIC_FETCH_PATH');
      const call = { step, url, method: init.method, body: init.body, at: clock() };
      calls.push(call);
      return overrides.respond === undefined ? response(call) : overrides.respond(call, response);
    };
    const { respond, ...serviceOverrides } = overrides;
    void respond;
    const service = createADiscoveryRuntimeServices({ repository: targetRepository, softwareJobStore: store, workerRegistry, runtimeMode: 'local_development',
      serverClock: clock, serviceBindings: [serviceBinding], connectorBindings: [connectorBinding], plans: [plan], getEvidenceRecords:()=>[evidence], readSecret, fetchImpl,
      sleep: async ms => { waits.push(ms); advance(ms); }, onBatchReady: input => importer.importBatch(input), onError: async error => { throw error; },
      ...serviceOverrides });
    instances.push(service);
    return { service, store, importer, repository: targetRepository };
  }
  const prepare = service => service.createBatch({ actor: owner, input: { planId: plan.planId, planVersion: plan.version, targetStore: 'miska',
    bindingId: connectorBinding.bindingId, configurationVersion: connectorBinding.configurationVersion, idempotencyKey: 'create:synthetic-seerfar' } });
  const authorize = (service, created, overrides = {}) => service.authorizeAndRun({ actor: owner, input: {
    batchId: created.batch.batchId, expectedRevision: created.batch.revision, expiresAt: '2026-09-09T05:00:00.000Z',
    idempotencyKey: 'authorize:synthetic-seerfar', ...overrides } });
  t.after(async () => { await Promise.all(instances.map(service => service.stop())); await fs.rm(directory, { recursive: true, force: true }); });
  return { repository, filePath, clock, advance, calls, waits, plan, connectorBinding, serviceBinding, owner, create, prepare, authorize,
    coldRepository: () => createJsonBusinessStateRepository({ filePath }), counts: () => ({ secretReads, requests: calls.length }), response, evidence };
}
