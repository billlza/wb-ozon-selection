import { createFormalC1DraftFixture } from './formal-c1-flow-fixture.mjs';
import { createC1SkuRightsReviewRecord } from '../../lib/c1-sku-rights-review.mjs';
import { produceC1LocalPreparation } from '../../lib/c1-keyword-planning-local-material.mjs';

export const LOCAL_DRAFT_AT = '2026-08-25T08:00:00.000Z';

/** Synthetic saved local material, produced by the real local preparation path.
 * No K3 evidence, formal draft request, job, or external service is supplied. */
export function createSavedLocalPreparationCandidate({ at = LOCAL_DRAFT_AT, titleOnly = false, withReferenceSources = false, referenceAttributeCount = 0, additionalPlatformAttributeCount = 0 } = {}) {
  const fixture = createFormalC1DraftFixture({ at, salesSnapshotVersion: 'sales-snapshot-v1.1', ...(withReferenceSources ? { salesAttributes: { ...Object.fromEntries(Array.from({ length: referenceAttributeCount }, (_, index) => [`Свойство ${index}`, `Синтетическая характеристика ${index}`])), 'Описание на русском / 尺寸~': 'Синтетическое описание', 'Описание': 'Сохраненное описание синтетического товара' } } : {}), skuAttributes: { colour: '红,蓝', age: '儿童', gender: '中性/男女均可', ...(withReferenceSources ? { quantityOneEvidence: { captureId: 'SCJ-synthetic-editorial' }, '说明/材质~俄文': '合成木材' } : {}) } });
  const candidate = structuredClone(fixture.candidate);
  const sku = structuredClone(fixture.created.skuPackage);
  candidate.lifecycleV11.skuPackage = sku;
  const plan = sku.c1ProductPlan;
  const facts = fixture.checked.c1ProductPlan;
  const colourIndex = facts.productAttributes.supplierAttributes.findIndex(item => item.fieldKey === 'colour');
  const definitions = [['8229', 'Тип', '3D-пазл', 'platformCategory.categoryName', '3D-пазл']];
  if (!titleOnly) definitions.push(['4967', 'Материал', 'Дерево', 'productAttributes.material', facts.productAttributes.material.value]);
  for (let index = 0; index < additionalPlatformAttributeCount; index++) definitions.push([String(20000 + index), `Синтетическое свойство ${index}`, 'Дерево', 'productAttributes.material', facts.productAttributes.material.value]);
  definitions.push(['10096', 'Цвет', 'разноцветный', `productAttributes.supplierAttributes.${colourIndex}.fact`, '红,蓝']);
  plan.inputSnapshots.platformSchemaRules.attributes = definitions.map(([id, label]) => ({ fieldKey: id, label, complexId: 0, dictionaryId: 1, required: false }));
  sku.ozonAttributeMappingsV1 = { schemaRevision: plan.inputSnapshots.platformSchemaRules.schemaRevision,
    confirmationRef: 'owner:mapping:synthetic', mappings: definitions.map(([id, label, value, path, sourceValue]) => ({
      attributeId: id, attributeLabel: label, value, sourceFactValue: sourceValue, sourceFactPath: path,
      dictionaryValueId: 12, dictionaryEvidenceRef: `dictionary:synthetic:${id}`
    })) };
  sku.c1RightsReviewRecord = createC1SkuRightsReviewRecord({ plan, sourceIdentity: sku.g1Identity,
    sourceCandidateRevision: candidate.dataRevision - 1, declaredByUserId: 'synthetic-owner', declaredAt: at,
    ownerDeclaration: { brand: { status: 'unbranded', name: null }, rights: { status: 'verified', basis: 'no_third_party_rights_identified' },
      reviewedAt: at, expiresAt: '2099-01-01T00:00:00.000Z' } });
  candidate.sourceCapture = { selectedSkuIds: [sku.supplierSkuId, 'OTHER-COLOUR'],
    skuChoices: [{ sourceSkuId: sku.supplierSkuId, attributes: { 颜色: '红', 规格: '红>均码' } }] };
  if (withReferenceSources) {
    const supply = sku.selectedSupplySnapshot;
    candidate.sourceCapture = { captureId: 'SCJ-synthetic-editorial', offerId: supply.supplierOption.offerId,
      sourceUrl: supply.supplierOption.productUrl, observedAt: at, title: '合成火车模型', titleSource: 'offerDetail.subject',
      skuChoices: [{ sourceSkuId: sku.supplierSkuId, propPath: sku.variantKey, attributes: { '颜色/尺寸~俄文': '红色', '编码%2F': '合成百分号属性', '尺码': '均码' } }],
      skuSelection: { selectedBy: 'owner', selectedSkuIds: [sku.supplierSkuId] } };
  }
  candidate.lifecycleV11.opportunityPackage.salesSnapshots = [];
  candidate.salesSnapshotsV11 = [];
  const prepared = produceC1LocalPreparation({ candidate, expectedRevision: candidate.dataRevision, producedAt: at });
  if (prepared.status !== 'ready') throw new Error(`LOCAL_DRAFT_FIXTURE_NOT_READY: ${JSON.stringify(prepared.production.gaps)}`);
  candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1 = structuredClone(prepared.material);
  candidate.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1 = structuredClone(prepared.production);
  candidate.dataRevision += 1;
  return candidate;
}
