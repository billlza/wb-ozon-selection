import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeerfarDiscoveryRuntimeFixture } from './fixtures/seerfar-discovery-runtime-fixture.mjs';
import { buildDiscoveryMarketSalesSnapshot, currentSalesSnapshot, discoveryMarketSnapshotId,
  ensureDiscoveryMarketSalesSnapshot, readDiscoveryMarketRecord } from '../lib/discovery-market-snapshot.mjs';
import { validateSalesSnapshot } from '../lib/sales-snapshot.mjs';
import { buildRealAConfirmationCard } from '../lib/real-a-confirmation-card.mjs';

// The whole test runs on the synthetic discovery fixture's own saved records. Nothing is read from a platform.
const category = { fullCategoryId: ['100_200'], titlePath: 'Товары для дома > Органайзеры',
  cnTitlePath: '家居用品 > 收纳整理', enTitlePath: 'Home > Organizers' };
const SKU = 2107989735;
const marketRow = (extra = {}) => ({ sku: SKU, title: 'Explicitly synthetic organizer',
  productUrl: `https://www.ozon.ru/product/${SKU}`, imageUrl: 'https://images.example.test/synthetic-organizer.png',
  price: 1850, sales: 330, revenue: 610500, reviewCount: 371, reviewRating: 4.7,
  weight: 1300, dimension: '750x210x40', categoryInfo: category, ...extra });

async function importedDiscoveryCandidate(t, rows = [marketRow()]) {
  const fixture = await createSeerfarDiscoveryRuntimeFixture(t, { products: rows });
  const { service } = fixture.create();
  const created = await fixture.prepare(service);
  await fixture.authorize(service, created);
  const document = await fixture.repository.readSnapshot();
  const candidate = document.candidates.find(value => value.aDiscoveryEvidenceV2?.marketProductId === String(SKU));
  assert.ok(candidate, '发现批次应保存一个待核验候选');
  return { fixture, document, candidate };
}

test('已保存的查询回执可以直接投影成一条销售快照，每个数字都带服务商记录和回执引用', async t => {
  const { document, candidate } = await importedDiscoveryCandidate(t);
  assert.deepEqual(candidate.salesSnapshotsV11, undefined);
  const record = readDiscoveryMarketRecord({ document, candidate });
  assert.equal(record.status, 'available');
  const snapshot = buildDiscoveryMarketSalesSnapshot(record);
  assert.equal(validateSalesSnapshot(snapshot).valid, true);
  assert.equal(snapshot.source, 'seerfar_category_detail');
  assert.equal(snapshot.collectorMode, 'provider_category_result_read_only');
  assert.equal(snapshot.collectorVersion, 'seerfar-category-detail-v1');
  assert.equal(snapshot.snapshotId, discoveryMarketSnapshotId({ receiptId: record.receipt.receiptId, marketProductId: String(SKU) }));
  assert.equal(snapshot.platform, 'ozon');
  assert.equal(snapshot.currentPrice, 1850);
  assert.equal(snapshot.currency, 'RUB');
  assert.equal(snapshot.priceCurrencySource, 'ozon_platform_currency');
  assert.equal(snapshot.categoryPath, '家居用品 > 收纳整理');
  assert.equal(snapshot.collectedAt, record.receipt.completedAt);
  assert.equal(snapshot.sellerType, 'unknown');
  assert.equal(snapshot.sellerIdentityEvidence.status, 'unverified');
  assert.deepEqual(snapshot.marketMetrics,
    { salesCount: 330, salesWindow: { startDate: null, endDate: null }, revenue: 610500, reviewCount: 371, reviewRating: 4.7 });
  assert.deepEqual(snapshot.evidenceRefs, [record.product.providerRecordRef, record.receipt.receiptId]);
  assert.equal(snapshot.evidenceRef, record.product.providerRecordRef);
  assert.deepEqual(snapshot.imageRefs, ['https://images.example.test/synthetic-organizer.png']);
  assert.equal(snapshot.readOnly, true);
});

test('未声明的字段、错误的采集模式和缺失的证据引用都会被销售快照校验拒绝', async t => {
  const { document, candidate } = await importedDiscoveryCandidate(t);
  const snapshot = buildDiscoveryMarketSalesSnapshot(readDiscoveryMarketRecord({ document, candidate }));
  const invalid = (patch, path) => {
    const result = validateSalesSnapshot({ ...structuredClone(snapshot), ...patch });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.path === path), `${path} 应被拒绝：${JSON.stringify(result.errors)}`);
  };
  invalid({ ownerNote: '主人补的' }, '$');
  invalid({ collectorMode: 'real_page_read_only' }, 'collectorMode');
  invalid({ evidenceRefs: [snapshot.evidenceRef] }, 'evidenceRefs');
  invalid({ evidenceRefs: [snapshot.evidenceRef, snapshot.evidenceRef] }, 'evidenceRefs');
  invalid({ sellerType: 'cross_border_cn' }, 'sellerType');
  invalid({ priceCurrencySource: 'provider_declared' }, 'priceCurrencySource');
  invalid({ marketMetrics: { ...snapshot.marketMetrics, salesCount: 12.5 } }, 'marketMetrics.salesCount');
  invalid({ marketMetrics: { ...snapshot.marketMetrics, reviewRating: -1 } }, 'marketMetrics.reviewRating');
  invalid({ marketMetrics: { ...snapshot.marketMetrics, extra: 1 } }, 'marketMetrics');
  invalid({ marketMetrics: { ...snapshot.marketMetrics, salesWindow: { startDate: '2026/08/12', endDate: null } } }, 'marketMetrics.salesWindow');
  invalid({ source: 'ozon_page_read' }, 'source');
});

test('首次打开找货只写一次快照，重复调用不再改动，已有有效快照永远不被覆盖', async t => {
  const { document, candidate } = await importedDiscoveryCandidate(t);
  const first = ensureDiscoveryMarketSalesSnapshot({ document, candidate });
  assert.equal(first.changed, true);
  assert.equal(first.status, 'derived_from_discovery_receipt');
  assert.equal(candidate.salesSnapshotsV11.length, 1);
  const saved = JSON.stringify(candidate.salesSnapshotsV11);
  const second = ensureDiscoveryMarketSalesSnapshot({ document, candidate });
  assert.equal(second.changed, false);
  assert.equal(second.status, 'existing_valid_snapshot');
  assert.equal(JSON.stringify(candidate.salesSnapshotsV11), saved);
  // A real page read stays the current snapshot; the projection never replaces or outranks it.
  const pageRead = { ...structuredClone(first.snapshot), snapshotId: 'sales-snapshot:real-page-read',
    collectedAt: '2099-01-01T00:00:00.000Z' };
  candidate.salesSnapshotsV11 = [pageRead];
  const third = ensureDiscoveryMarketSalesSnapshot({ document, candidate });
  assert.equal(third.changed, false);
  assert.equal(candidate.salesSnapshotsV11.length, 1);
  assert.equal(currentSalesSnapshot(candidate).snapshotId, 'sales-snapshot:real-page-read');
});

test('没有查询回执的候选不产生任何快照，也不会被改动', async t => {
  const { document } = await importedDiscoveryCandidate(t);
  const plain = { id: 'candidate:synthetic-plain', dataRevision: 1, targetStore: 'miska', productName: '手工候选' };
  const before = JSON.stringify(plain);
  const outcome = ensureDiscoveryMarketSalesSnapshot({ document, candidate: plain });
  assert.deepEqual(outcome, { changed: false, status: 'no_discovery_evidence', snapshot: null });
  assert.equal(JSON.stringify(plain), before);
  const orphan = { ...plain, aDiscoveryEvidenceV2: { provider: 'seerfar', platform: 'ozon',
    marketProductId: '999999999', marketReceiptRef: 'a-discovery-receipt:a-discovery-job:missing', batchId: 'a-discovery-batch:missing' } };
  assert.equal(ensureDiscoveryMarketSalesSnapshot({ document, candidate: orphan }).status, 'receipt_missing');
});

test('投影出的快照直接满足A确认卡的销售快照要求，卡片仍然零业务写入', async t => {
  const { document, candidate } = await importedDiscoveryCandidate(t);
  assert.equal(buildRealAConfirmationCard(candidate).salesReview, null);
  ensureDiscoveryMarketSalesSnapshot({ document, candidate });
  const before = JSON.stringify(candidate);
  const card = buildRealAConfirmationCard(candidate);
  assert.equal(card.salesReview.snapshotId, candidate.salesSnapshotsV11[0].snapshotId);
  assert.equal(card.salesReview.source, 'seerfar_category_detail');
  assert.equal(card.salesReview.currentPrice, 1850);
  assert.equal(card.salesReview.marketMetrics.salesCount, 330);
  assert.equal(card.salesReview.marketMetrics.reviewCount, 371);
  assert.deepEqual(card.boundaries, { candidateWrites: 0, platformAccesses: 0, platformWrites: 0, taskDispatches: 0, automationStarted: false });
  assert.equal(JSON.stringify(candidate), before);
});
