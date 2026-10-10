import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readOzonCommissionReference, readOzonCommissionReferenceTiers, OzonCommissionReferenceError } from '../lib/ozon-commission-reference-reader.mjs';

const FILE_SHA256 = 'ab'.repeat(32);
const EFFECTIVE_FROM = '2025-12-01';
const AS_OF = '2026-09-10T12:00:00.000Z';

const petBedRow = {
  row: 1395, typeRu: 'Лежак для животных', typeZh: '宠物躺床', typeEn: 'Pet Bed',
  category3Ru: 'Аксессуар для перевозки и сна', category3Zh: '携带和睡眠配件', category3En: 'Carrying & Sleeping Accessory',
  mpCategoryRu: 'Товары для животных', mpCategoryZh: '宠物用品', mpCategoryEn: 'Pet Products', brand: 'All',
  rfbs_le1500: 0.12, rfbs_1500_5000: 0.14, rfbs_gt5000: 0.15, fbp_le1500: 0.11, fbp_1500_5000: 0.13, fbp_gt5000: 0.14
};
const brandSpecificRow = {
  row: 2001, typeRu: 'Бренд Тип', typeZh: '品牌专属类型', typeEn: 'Brand Specific Type',
  category3Ru: 'Категория 3', category3Zh: '类别三', category3En: 'Category Three',
  mpCategoryRu: 'Товары для животных', mpCategoryZh: '宠物用品', mpCategoryEn: 'Pet Products', brand: 'Acme',
  rfbs_le1500: 0.10, rfbs_1500_5000: 0.12, rfbs_gt5000: 0.13, fbp_le1500: 0.09, fbp_1500_5000: 0.11, fbp_gt5000: 0.12
};
const ambiguousPetsRow = {
  row: 3001, typeRu: 'Общий тип', typeZh: '模糊类型', typeEn: 'Ambiguous Type',
  category3Ru: 'Категория A', category3Zh: '类别甲', category3En: 'Category A',
  mpCategoryRu: 'Товары для животных', mpCategoryZh: '宠物用品', mpCategoryEn: 'Pet Products', brand: 'All',
  rfbs_le1500: 0.20, rfbs_1500_5000: 0.21, rfbs_gt5000: 0.22, fbp_le1500: 0.19, fbp_1500_5000: 0.20, fbp_gt5000: 0.21
};
const ambiguousHomeRow = {
  row: 3002, typeRu: 'Общий тип', typeZh: '模糊类型', typeEn: 'Ambiguous Type',
  category3Ru: 'Категория B', category3Zh: '类别乙', category3En: 'Category B',
  mpCategoryRu: 'Товары для дома', mpCategoryZh: '家居用品', mpCategoryEn: 'Home Goods', brand: 'All',
  rfbs_le1500: 0.25, rfbs_1500_5000: 0.26, rfbs_gt5000: 0.27, fbp_le1500: 0.24, fbp_1500_5000: 0.25, fbp_gt5000: 0.26
};
const rateMissingRow = {
  row: 4001, typeRu: 'Тип без ставки', typeZh: '缺失费率类型', typeEn: 'Missing Rate Type',
  category3Ru: 'Категория C', category3Zh: '类别丙', category3En: 'Category C',
  mpCategoryRu: 'Товары для животных', mpCategoryZh: '宠物用品', mpCategoryEn: 'Pet Products', brand: 'All',
  rfbs_le1500: null, rfbs_1500_5000: 0.30, rfbs_gt5000: 0.31, fbp_le1500: 0.28, fbp_1500_5000: 0.29, fbp_gt5000: 0.30
};
const duplicateRowA = {
  row: 5001, typeRu: 'Повторяющийся тип', typeZh: '重复类型', typeEn: 'Duplicate Type',
  category3Ru: 'Категория D', category3Zh: '类别丁', category3En: 'Category D',
  mpCategoryRu: 'Товары для животных', mpCategoryZh: '宠物用品', mpCategoryEn: 'Pet Products', brand: 'All',
  rfbs_le1500: 0.15, rfbs_1500_5000: 0.16, rfbs_gt5000: 0.17, fbp_le1500: 0.14, fbp_1500_5000: 0.15, fbp_gt5000: 0.16
};
const duplicateRowB = {
  row: 5002, typeRu: 'Повторяющийся тип', typeZh: '重复类型', typeEn: 'Duplicate Type',
  category3Ru: 'Категория E', category3Zh: '类别戊', category3En: 'Category E',
  mpCategoryRu: 'Товары для животных', mpCategoryZh: '宠物用品', mpCategoryEn: 'Pet Products', brand: 'All',
  rfbs_le1500: 0.15, rfbs_1500_5000: 0.16, rfbs_gt5000: 0.17, fbp_le1500: 0.14, fbp_1500_5000: 0.15, fbp_gt5000: 0.16
};

const BASE_CATALOG = {
  schemaVersion: 'ozon-official-commission-reference-v1', platform: 'ozon', sellerRegion: 'CN', effectiveFrom: EFFECTIVE_FROM,
  sourceUrl: 'https://cdn.ozone.ru/s3/utils-common/Tarifs_CN_01_12_2025_1761720496.xlsx',
  sourcePage: 'https://global-help.ozon.com/zh/commissions/ozon-fees/commissions/?region=CHN',
  fileSha256: FILE_SHA256, fileLastModified: '2026-08-12T09:53:49Z', downloadedAt: '2026-09-10T05:48:00Z',
  priceTiersRub: { le1500: [0, 1500], '1500_5000': [1500.01, 5000], gt5000: [5000.01, null] },
  salesSchemes: ['rfbs', 'fbp'],
  sheets: {
    'MP Tree Tarifs CN': { rows: [{
      row: 45, blockRu: 'Животные', blockEn: 'Animals', blockZh: '宠物用品', mpCategoryRu: 'Товары для животных',
      mpCategoryEn: 'Pet Products', mpCategoryZh: '宠物用品', rfbs_le1500: 0.12, rfbs_1500_5000: 0.14, rfbs_gt5000: 0.15,
      fbp_le1500: 0.11, fbp_1500_5000: 0.13, fbp_gt5000: 0.14
    }] },
    'Full ChinaHK': { rows: [petBedRow, brandSpecificRow, ambiguousPetsRow, ambiguousHomeRow, rateMissingRow, duplicateRowA, duplicateRowB] }
  }
};

const VERSION_STATE = Object.freeze({ fileSha256: FILE_SHA256, effectiveFrom: EFFECTIVE_FROM, status: 'active' });

const project = row => ({ row: row.row, typeRu: row.typeRu, typeZh: row.typeZh, typeEn: row.typeEn,
  category3Zh: row.category3Zh, mpCategoryZh: row.mpCategoryZh, brand: row.brand });

const buildScope = (overrides = {}) => ({
  platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', priceRub: 1500,
  typeIdentity: { typeZh: '宠物躺床' }, ...overrides
});

async function fixture(t, { catalog = BASE_CATALOG, raw } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ozon-commission-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, 'catalog.json');
  await writeFile(catalogPath, raw !== undefined ? raw : JSON.stringify(catalog));
  const base = { catalogPath, scope: buildScope(), versionState: structuredClone(VERSION_STATE), asOf: AS_OF };
  const tierScope = { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', typeIdentity: { typeZh: '宠物躺床' } };
  return { catalogPath, lookup: overrides => readOzonCommissionReference({ ...base, ...overrides }),
    tiers: overrides => readOzonCommissionReferenceTiers({ ...base, scope: tierScope, ...overrides }) };
}

const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof OzonCommissionReferenceError && error.code === code);

test('valid read for a pet-bed type across all three price tiers and both sales schemes', async t => {
  const f = await fixture(t);
  const expected = {
    le1500: { rfbs: 0.12, fbp: 0.11 }, '1500_5000': { rfbs: 0.14, fbp: 0.13 }, gt5000: { rfbs: 0.15, fbp: 0.14 }
  };
  for (const [priceRub, tier] of [[1500, 'le1500'], [3000, '1500_5000'], [6000, 'gt5000']]) {
    for (const salesScheme of ['rfbs', 'fbp']) {
      const result = await f.lookup({ scope: buildScope({ priceRub, salesScheme }) });
      assert.equal(result.priceTier, tier);
      assert.equal(result.commissionRate, expected[tier][salesScheme]);
      assert.deepEqual(result.gaps, []);
      assert.deepEqual(result.matchedRows, [project(petBedRow)]);
      assert.equal(result.schemaVersion, 'ozon-commission-reference-read-v1');
      assert.equal(result.platform, 'ozon'); assert.equal(result.sellerRegion, 'CN');
      assert.equal(result.checkedAt, AS_OF);
      assert.deepEqual(result.source, {
        sourceUrl: BASE_CATALOG.sourceUrl, sourcePage: BASE_CATALOG.sourcePage, effectiveFrom: EFFECTIVE_FROM,
        fileSha256: FILE_SHA256, fileLastModified: BASE_CATALOG.fileLastModified, downloadedAt: BASE_CATALOG.downloadedAt,
        catalogSchemaVersion: BASE_CATALOG.schemaVersion
      });
      assert.deepEqual(result.versionState, VERSION_STATE);
    }
  }
});

test('Chinese, English and Russian identity fields each resolve the same row, and combining fields is conjunctive', async t => {
  const f = await fixture(t);
  for (const typeIdentity of [{ typeZh: '宠物躺床' }, { typeEn: 'Pet Bed' }, { typeRu: 'Лежак для животных' },
    { typeZh: '宠物躺床', typeEn: 'Pet Bed' }]) {
    const result = await f.lookup({ scope: buildScope({ typeIdentity }) });
    assert.equal(result.commissionRate, 0.12);
    assert.deepEqual(result.matchedRows, [project(petBedRow)]);
  }
  const mismatched = await f.lookup({ scope: buildScope({ typeIdentity: { typeZh: '宠物躺床', typeEn: 'Wrong Name' } }) });
  assert.equal(mismatched.commissionRate, null);
  assert.deepEqual(mismatched.gaps, [{ code: 'TYPE_NOT_FOUND', field: 'scope.typeIdentity', blocking: true }]);
});

test('identity match trims, collapses whitespace and ignores case on both sides', async t => {
  const f = await fixture(t);
  for (const typeIdentity of [{ typeEn: '  pet   BED  ' }, { typeZh: '  宠物躺床 ' }, { typeRu: 'лежак ДЛЯ  животных' }]) {
    const result = await f.lookup({ scope: buildScope({ typeIdentity }) });
    assert.equal(result.commissionRate, 0.12);
    assert.deepEqual(result.matchedRows, [project(petBedRow)]);
  }
});

test('unmatched type identity is a blocking TYPE_NOT_FOUND gap, not a zero rate', async t => {
  const f = await fixture(t);
  const result = await f.lookup({ scope: buildScope({ typeIdentity: { typeZh: '不存在的类型' } }) });
  assert.equal(result.commissionRate, null);
  assert.deepEqual(result.matchedRows, []);
  assert.deepEqual(result.gaps, [{ code: 'TYPE_NOT_FOUND', field: 'scope.typeIdentity', blocking: true }]);
});

test('rows sharing an identity with different rates are TYPE_AMBIGUOUS until mpCategoryZh disambiguates', async t => {
  const f = await fixture(t);
  const ambiguous = await f.lookup({ scope: buildScope({ typeIdentity: { typeZh: '模糊类型' } }) });
  assert.equal(ambiguous.commissionRate, null);
  assert.deepEqual(ambiguous.gaps, [{ code: 'TYPE_AMBIGUOUS', field: 'scope.mpCategoryZh', blocking: true }]);
  assert.deepEqual(ambiguous.matchedRows, [project(ambiguousPetsRow), project(ambiguousHomeRow)]);

  const pets = await f.lookup({ scope: buildScope({ typeIdentity: { typeZh: '模糊类型' }, mpCategoryZh: '宠物用品' }) });
  assert.equal(pets.commissionRate, 0.20);
  assert.deepEqual(pets.gaps, []);
  assert.deepEqual(pets.matchedRows, [project(ambiguousPetsRow)]);

  const home = await f.lookup({ scope: buildScope({ typeIdentity: { typeZh: '模糊类型' }, mpCategoryZh: '家居用品' }) });
  assert.equal(home.commissionRate, 0.25);
  assert.deepEqual(home.matchedRows, [project(ambiguousHomeRow)]);
});

test('rows with identical rates under one identity succeed and report every matched row', async t => {
  const f = await fixture(t);
  const result = await f.lookup({ scope: buildScope({ typeIdentity: { typeZh: '重复类型' } }) });
  assert.equal(result.commissionRate, 0.15);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.matchedRows, [project(duplicateRowA), project(duplicateRowB)]);
});

test('only brand-specific rows matching an identity is a blocking BRAND_SPECIFIC_ONLY gap', async t => {
  const f = await fixture(t);
  const result = await f.lookup({ scope: buildScope({ typeIdentity: { typeZh: '品牌专属类型' } }) });
  assert.equal(result.commissionRate, null);
  assert.deepEqual(result.gaps, [{ code: 'BRAND_SPECIFIC_ONLY', field: 'matchedRows', blocking: true }]);
  assert.deepEqual(result.matchedRows, [project(brandSpecificRow)]);
});

test('a null rate for the exact scheme and tier is RATE_MISSING, scoped to that one cell', async t => {
  const f = await fixture(t);
  const missing = await f.lookup({ scope: buildScope({ typeIdentity: { typeZh: '缺失费率类型' }, salesScheme: 'rfbs', priceRub: 1000 }) });
  assert.equal(missing.commissionRate, null);
  assert.deepEqual(missing.gaps, [{ code: 'RATE_MISSING', field: 'matchedRows.rfbs_le1500', blocking: true }]);
  assert.deepEqual(missing.matchedRows, [project(rateMissingRow)]);

  const present = await f.lookup({ scope: buildScope({ typeIdentity: { typeZh: '缺失费率类型' }, salesScheme: 'fbp', priceRub: 1000 }) });
  assert.equal(present.commissionRate, 0.28);
  assert.deepEqual(present.gaps, []);
});

test('asOf before the catalog effective date is NOT_YET_EFFECTIVE, and the boundary instant is allowed', async t => {
  const f = await fixture(t);
  const early = await f.lookup({ asOf: '2025-11-30T23:59:59.000Z' });
  assert.equal(early.commissionRate, null);
  assert.deepEqual(early.gaps, [{ code: 'NOT_YET_EFFECTIVE', field: 'source.effectiveFrom', blocking: true }]);
  assert.deepEqual(early.matchedRows, []);

  const boundary = await f.lookup({ asOf: '2025-12-01T00:00:00.000Z' });
  assert.equal(boundary.commissionRate, 0.12);
  assert.deepEqual(boundary.gaps, []);
});

test('version state must reference this catalog exact fileSha256 and effectiveFrom, or the read is blocked', async t => {
  const f = await fixture(t);
  const wrongHash = await f.lookup({ versionState: { ...VERSION_STATE, fileSha256: 'cd'.repeat(32) } });
  assert.equal(wrongHash.commissionRate, null);
  assert.deepEqual(wrongHash.gaps, [{ code: 'CATALOG_VERSION_MISMATCH', field: 'versionState', blocking: true }]);

  const wrongDate = await f.lookup({ versionState: { ...VERSION_STATE, effectiveFrom: '2025-11-01' } });
  assert.deepEqual(wrongDate.gaps, [{ code: 'CATALOG_VERSION_MISMATCH', field: 'versionState', blocking: true }]);

  const invalidated = await f.lookup({ versionState: { ...VERSION_STATE, status: 'invalidated' } });
  assert.equal(invalidated.commissionRate, null);
  assert.deepEqual(invalidated.gaps, [{ code: 'CATALOG_VERSION_INVALIDATED', field: 'versionState.status', blocking: true }]);
});

test('catalog content is validated strictly: schema version, closed keys and rate ranges', async t => {
  const badSchema = await fixture(t, { catalog: { ...BASE_CATALOG, schemaVersion: 'wrong-version' } });
  await rejectsCode(badSchema.lookup(), 'CATALOG_INVALID');

  const extraKey = await fixture(t, { catalog: { ...BASE_CATALOG, unexpectedField: true } });
  await rejectsCode(extraKey.lookup(), 'CATALOG_INVALID');

  const badRateCatalog = structuredClone(BASE_CATALOG);
  badRateCatalog.sheets['Full ChinaHK'].rows[0].rfbs_le1500 = 1.5;
  const badRate = await fixture(t, { catalog: badRateCatalog });
  await rejectsCode(badRate.lookup(), 'CATALOG_INVALID');

  const malformed = await fixture(t, { raw: '{not valid json' });
  await rejectsCode(malformed.lookup(), 'CATALOG_UNREADABLE');
});

test('malformed scope, version state, asOf or catalog path throw rather than silently proceeding', async t => {
  const f = await fixture(t);
  const cases = [
    { scope: buildScope({ platform: 'wb' }) },
    { scope: buildScope({ sellerRegion: 'RU' }) },
    { scope: buildScope({ salesScheme: 'fbo' }) },
    { scope: buildScope({ priceRub: 0 }) },
    { scope: buildScope({ priceRub: -5 }) },
    { scope: buildScope({ priceRub: Infinity }) },
    { scope: buildScope({ priceRub: '1500' }) },
    { scope: { ...buildScope(), extra: 'must-not-appear' } },
    { scope: buildScope({ typeIdentity: {} }) },
    { scope: buildScope({ typeIdentity: { typeXx: 'foo' } }) },
    { scope: buildScope({ typeIdentity: { typeZh: '' } }) },
    { versionState: { ...VERSION_STATE, status: 'unknown' } },
    { versionState: { ...VERSION_STATE, fileSha256: 'zz'.repeat(32) } },
    { versionState: { ...VERSION_STATE, effectiveFrom: '2025-12-1' } },
    { versionState: { fileSha256: FILE_SHA256, effectiveFrom: EFFECTIVE_FROM } },
    { asOf: '2026-02-30T12:00:00.000Z' },
    { asOf: '2026-09-10' },
    { catalogPath: '' },
    { catalogPath: undefined }
  ];
  for (const overrides of cases) {
    await rejectsCode(f.lookup(overrides), 'INPUT_INVALID');
  }
});

// The whole rate ladder in one read. Pricing guidance has to answer "what would another price earn", and the band
// edges must come from the catalog itself — this is the read that keeps 1500/5000 out of the calling code.
test('每档费率和它适用的卢布区间一次读全，区间边界来自目录自己', async t => {
  const f = await fixture(t);
  const read = await f.tiers();
  assert.equal(read.schemaVersion, 'ozon-commission-reference-tiers-read-v1');
  assert.equal(read.salesScheme, 'rfbs');
  assert.equal(read.checkedAt, AS_OF);
  assert.deepEqual(read.gaps, []);
  assert.deepEqual(read.matchedRows, [project(petBedRow)]);
  assert.deepEqual(read.tiers, [
    { tier: 'le1500', rate: 0.12, minRub: 0, maxRub: 1500 },
    { tier: '1500_5000', rate: 0.14, minRub: 1500.01, maxRub: 5000 },
    { tier: 'gt5000', rate: 0.15, minRub: 5000.01, maxRub: null }
  ]);
  assert.equal(read.source.fileSha256, FILE_SHA256);
  assert.equal(read.source.effectiveFrom, EFFECTIVE_FROM);
  // The same read for the other sales scheme carries that scheme's own rates, never rFBS's.
  const fbp = await f.tiers({ scope: { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'fbp', typeIdentity: { typeZh: '宠物躺床' } } });
  assert.deepEqual(fbp.tiers.map(tier => tier.rate), [0.11, 0.13, 0.14]);
});

test('档位读取用与单价读取同一套版本闸门和缺口词，坏输入一律拒绝', async t => {
  const f = await fixture(t);
  for (const [overrides, code] of [
    [{ versionState: { ...VERSION_STATE, fileSha256: 'cd'.repeat(32) } }, 'CATALOG_VERSION_MISMATCH'],
    [{ versionState: { ...VERSION_STATE, status: 'invalidated' } }, 'CATALOG_VERSION_INVALIDATED'],
    [{ asOf: '2025-11-30T00:00:00.000Z' }, 'NOT_YET_EFFECTIVE'],
    [{ scope: { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', typeIdentity: { typeZh: '查无此类' } } }, 'TYPE_NOT_FOUND'],
    [{ scope: { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', typeIdentity: { typeZh: '品牌专属类型' } } }, 'BRAND_SPECIFIC_ONLY'],
    [{ scope: { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', typeIdentity: { typeZh: '模糊类型' } } }, 'TYPE_AMBIGUOUS']
  ]) {
    const read = await f.tiers(overrides);
    assert.deepEqual(read.tiers, [], code);
    assert.deepEqual(read.gaps.map(gap => gap.code), [code]);
    assert.equal(read.gaps[0].blocking, true);
  }
  // A price is not part of this read, and an unknown key is refused exactly as the single-price read refuses one.
  for (const scope of [
    { platform: 'wb', sellerRegion: 'CN', salesScheme: 'rfbs', typeIdentity: { typeZh: '宠物躺床' } },
    { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', priceRub: 1500, typeIdentity: { typeZh: '宠物躺床' } },
    { platform: 'ozon', sellerRegion: 'CN', salesScheme: 'rfbs', typeIdentity: {} }
  ]) {
    await rejectsCode(f.tiers({ scope }), 'INPUT_INVALID');
  }
});
