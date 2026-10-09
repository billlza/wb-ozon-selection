import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSavedLocalPreparationCandidate, LOCAL_DRAFT_AT } from './fixtures/c1-local-draft-source-fixture.mjs';
import { prepareC1LocalDraftSource, C1_LOCAL_DRAFT_FAILURE_CODES } from '../lib/c1-local-draft-source.mjs';
import { prepareCurrentC1AiDraftRequest, assertCurrentC1AiDraftRequestSources } from '../lib/c1-ai-draft-request-source.mjs';
import { buildC1AiDraftRequest, validateC1AiDraftRequest, validateC1AiDraftReceipt, mergeC1AiDraftReceipt } from '../lib/c1-ai-draft-contract.mjs';
import { receipt, authorizedExecution, settledExecution, buildRequest, seoRules } from './fixtures/c1-ai-draft-fixture.mjs';
import { fingerprintCanonicalRecord as digest } from '../lib/production-contract-primitives.mjs';
import { buildC1GatewayJob, C1_AI_GATEWAY_OUTPUT_SCHEMA } from '../lib/c1-ai-gateway.mjs';
import { verifyC1ProductFacts, applyC1SkuAttributeScopeReview, validateC1FactVerification } from '../lib/c1-product-plan.mjs';
import { prepareC2SoftwareInput } from '../lib/c2-software-orchestrator.mjs';
import { projectC1CompetitorTextSnapshot } from '../lib/c1-software-input-preparation.mjs';
import { addSyntheticC1Review } from './fixtures/c1-seo-review-fixture.mjs';

function prepare(options) {
  const candidate = createSavedLocalPreparationCandidate(options);
  const prepared = prepareC1LocalDraftSource({ candidate, preparedAt: LOCAL_DRAFT_AT });
  candidate.lifecycleV11.skuPackage = structuredClone(prepared.skuPackage);
  candidate.lifecycleV11.c1LocalDraftSourceV1 = structuredClone(prepared.sourceEvidence);
  return { candidate, prepared, request: prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT) };
}
function localReceipt(request) {
  function cited(field) {
    const keyword = request.keywordEvidence.keywords.find(item => item.allowedOutputFields.includes(field));
    const fact = request.verifiedFacts.find(item => item.factPath === keyword.factRefs[0]);
    return { text: keyword.query, factRefs: [fact.factPath], keywordRefs: [keyword.keywordEvidenceRef],
      assertions: [{ factPath: fact.factPath, value: structuredClone(fact.value) }] };
  }
  const output = { status: 'draft_only', locale: 'ru-RU', claimCoverage: 'complete', unsupportedClaims: [],
    title: cited('title'), description: cited('description'), bulletPoints: request.factDefinitionsVersion ? [] : [cited('bulletPoints')],
    searchKeywords: request.keywordEvidence.keywords.some(k => k.allowedOutputFields.includes('searchKeywords')) ? [cited('searchKeywords')] : [] };
  addSyntheticC1Review(request, output);
  return receipt(request, { output, outputFingerprint: digest(output), startedAt: LOCAL_DRAFT_AT, completedAt: LOCAL_DRAFT_AT });
}

test('已保存 v2 材料从 inputs_ready 免费构造同一正式请求，保留已签无品牌，绑定材料及修订', () => {
  const original = createSavedLocalPreparationCandidate();
  const before = structuredClone(original);
  const prepared = prepareC1LocalDraftSource({ candidate: original, preparedAt: LOCAL_DRAFT_AT });
  assert.deepEqual(original, before);
  assert.equal(original.lifecycleV11.skuPackage.c1ProductPlan.status, 'inputs_ready');
  assert.equal(prepared.skuPackage.c1ProductPlan.status, 'facts_checked');
  assert.equal(prepared.skuPackage.dataRevision, prepared.sourceEvidence.sourceSkuRevision + 2);
  assert.deepEqual(prepared.skuPackage.profitModels, original.lifecycleV11.skuPackage.profitModels);
  const { candidate, request } = prepare();
  assert.deepEqual(validateC1AiDraftRequest(request), { valid: true, errors: [] });
  assert.equal(request.keywordEvidence.collectionMode, 'local_preparation');
  assert.equal(request.keywordEvidence.sourceBindings.materialFingerprint, candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1.materialFingerprint);
  assert.equal(request.keywordEvidence.sourceBindings.sourceSkuRevision, original.lifecycleV11.skuPackage.dataRevision);
  assert.equal(request.keywordEvidence.sourceBindings.preparedSkuRevision, request.sourceSkuRevision);
  assert.equal(request.executionPolicy.platformAccessAllowed, false);
  assert.equal(request.executionPolicy.productionWriteAllowed, false);
  assert.equal(candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1, undefined);
  assert.equal(candidate.lifecycleV11.c1SoftwareEvidenceV1, undefined);
  assert.equal(candidate.lifecycleV11.c1AiDraftRequestV1, undefined);
  assert.deepEqual(request.keywordEvidence.keywords.map(k => k.query), ['3D-пазл', 'Дерево']);
  assert.deepEqual(request.keywordEvidence.keywords[0].allowedOutputFields, ['title', 'description', 'bulletPoints']);
  assert.ok(request.keywordEvidence.keywords.every(k => !Object.hasOwn(k, 'searchVolume') && !Object.hasOwn(k, 'conversion')));
  assert.equal(request.seoRules.titleMaxLength, null);
  assert.equal(request.seoRules.descriptionMaxLength, null);
  assert.equal(request.seoRules.bulletPointLimit, null);
  assert.deepEqual(request.seoRules.writingRules, candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1.writingRules);
  assert.equal(request.verifiedFacts.find(f => f.factPath === 'platformCompliance.skuRightsReview.brand').value.status, 'unbranded');
  assert.doesNotThrow(() => assertCurrentC1AiDraftRequestSources({ candidate, request, observedAt: LOCAL_DRAFT_AT }));
});

test('整款多色及原始儿童/男女字段不进入可引用SKU事实，不能由回执冒充本品事实', () => {
  const { candidate, request } = prepare();
  const material = candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1;
  assert.equal(material.attributes.find(a => a.fieldKey === '10096').status, 'scope_unresolved');
  assert.ok(candidate.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.supplierAttributes.some(a => a.fact.value === '儿童'));
  assert.ok(request.verifiedFacts.every(f => !f.factPath.includes('supplierAttributes')));
  assert.ok(!request.verifiedFacts.some(f => JSON.stringify(f.value).includes('разноцветный')));
  const plan = candidate.lifecycleV11.skuPackage.c1ProductPlan;
  const colour = plan.productAttributes.ozonAttributes.find(attribute => attribute.fieldKey === '10096');
  assert.equal(colour.fact.verificationStatus, 'unknown');
  assert.equal(colour.fact.value, 'unknown');
  assert.equal(colour.dictionaryValueId, null);
  assert.ok(colour.fact.sourceRefs.includes(`local-preparation:${material.materialFingerprint}`));
  const rawColour = plan.productAttributes.supplierAttributes.find(attribute => attribute.fieldKey === 'colour');
  assert.equal(rawColour.fact.verificationStatus, 'unknown');
  assert.equal(plan.inputSnapshots.confirmedSupplierSkuSnapshot.supplierSku.attributes.colour, '红,蓝');
  assert.equal(candidate.lifecycleV11.skuPackage.ozonAttributeMappingsV1.mappings.find(mapping => mapping.attributeId === '10096').value, 'разноцветный');
  assert.ok(plan.unknownManifest.some(item => item.reason === 'sku_attribute_scope_unresolved' && item.blocksC2Handoff === false));
  const response = localReceipt(request);
  response.output.description.factRefs.push('productAttributes.ozonAttributes.2.fact');
  response.output.description.assertions.push({ factPath: 'productAttributes.ozonAttributes.2.fact', value: { value: 'разноцветный', dictionaryValueId: 12 } });
  response.outputFingerprint = digest(response.output);
  assert.equal(validateC1AiDraftReceipt({ request, receipt: response }).valid, false);
});

test('范围审查在领域层处理必填颜色与其来源alias，计数和C2阻断同步；重复或空审查不增修订', () => {
  const candidate = createSavedLocalPreparationCandidate();
  const sku = candidate.lifecycleV11.skuPackage;
  const schema = sku.c1ProductPlan.inputSnapshots.platformSchemaRules;
  schema.requiredFields.push({ fieldKey: '10096', label: 'Цвет', required: true });
  schema.requiredFields.push({ fieldKey: 'colour_alias', label: 'Colour alias', required: true, sourceAttributeKeys: ['colour'] });
  const checked = verifyC1ProductFacts({ skuPackage: sku, skuRightsReview: sku.c1RightsReviewRecord.review, verifiedAt: LOCAL_DRAFT_AT }).skuPackage;
  assert.equal(checked.c1ProductPlan.productAttributes.requiredPlatformFields.find(field => field.fieldKey === '10096').fact.verificationStatus, 'confirmed');
  const mapping = sku.ozonAttributeMappingsV1.mappings.find(item => item.attributeId === '10096');
  const scopeReview = { schemaVersion: 'c1-sku-attribute-scope-review-v1', evidenceRef: `local-preparation:${candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1.materialFingerprint}`,
    attributes: [{ fieldKey: '10096', sourceFactPath: mapping.sourceFactPath }] };
  const result = applyC1SkuAttributeScopeReview({ skuPackage: checked, scopeReview, reviewedAt: LOCAL_DRAFT_AT });
  assert.equal(result.changed, true);
  assert.equal(result.skuPackage.dataRevision, checked.dataRevision + 1);
  assert.deepEqual(result.skuPackage.selectedSupplySnapshot, checked.selectedSupplySnapshot);
  assert.deepEqual(result.skuPackage.ozonAttributeMappingsV1, checked.ozonAttributeMappingsV1);
  assert.deepEqual(result.skuPackage.c1ProductPlan.inputSnapshots, checked.c1ProductPlan.inputSnapshots);
  const plan = result.skuPackage.c1ProductPlan;
  assert.deepEqual(plan.productAttributes.requiredPlatformFields.filter(field => ['10096', 'colour_alias'].includes(field.fieldKey)).map(field => field.fact.verificationStatus), ['unknown', 'unknown']);
  assert.equal(plan.platformCompliance.requiredFieldGapCount.value, 2);
  assert.equal(plan.productAttributes.status.value, 'required_fields_incomplete');
  assert.ok(plan.unknownManifest.some(item => item.reason === 'sku_attribute_scope_unresolved' && item.blocksC2Handoff));
  assert.equal(validateC1FactVerification(plan).valid, true);
  const request = buildC1AiDraftRequest({ skuPackage: result.skuPackage,
    competitorTextSnapshot: projectC1CompetitorTextSnapshot(plan), seoRules: seoRules(), requestedAt: LOCAL_DRAFT_AT,
    taskClassification: { complexity: 'standard', preapprovedForSol: false, reason: 'scope regression', markedBy: 'software', markedAt: LOCAL_DRAFT_AT },
    keywordEvidence: { evidenceId: 'test:scope-keywords', status: 'ready', targetPlatform: 'ozon', targetSkuPackageId: result.skuPackage.skuPackageId,
      observedAt: LOCAL_DRAFT_AT, collectionMode: 'reused_verified_evidence', sourcePlatform: 'ozon',
      keywords: [{ query: '3D-пазл', group: 'core_product_type', keywordEvidenceRef: 'test:scope-keyword', relevanceStatus: 'retained',
        factBindingPaths: ['platformCategory.categoryName'], allowedOutputFields: ['title', 'description', 'bulletPoints', 'searchKeywords'] }] } });
  const response = localReceipt(request);
  const admitted = authorizedExecution(request, candidate.dataRevision);
  const merged = mergeC1AiDraftReceipt({ skuPackage: result.skuPackage, request, receipt: response,
    settledExecution: settledExecution(request, response, admitted), mergedAt: LOCAL_DRAFT_AT });
  assert.throws(() => prepareC2SoftwareInput({ skuPackage: merged.skuPackage, expectedDataRevision: merged.skuPackage.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, preparedAt: LOCAL_DRAFT_AT }), /C2_REQUIRED_UNKNOWN_BLOCKING/);
  const again = applyC1SkuAttributeScopeReview({ skuPackage: result.skuPackage, scopeReview, reviewedAt: LOCAL_DRAFT_AT });
  assert.equal(again.changed, false);
  assert.equal(again.skuPackage.dataRevision, result.skuPackage.dataRevision);
  const empty = applyC1SkuAttributeScopeReview({ skuPackage: checked, scopeReview: { ...scopeReview, attributes: [] }, reviewedAt: LOCAL_DRAFT_AT });
  assert.deepEqual(empty.skuPackage, checked);
  assert.throws(() => applyC1SkuAttributeScopeReview({ skuPackage: checked, scopeReview: { ...scopeReview, attributes: [{ fieldKey: '10096', sourceFactPath: 'productAttributes.supplierAttributes.999.fact' }] }, reviewedAt: LOCAL_DRAFT_AT }), /C1_ATTRIBUTE_SCOPE_SOURCE_MISMATCH/);
});

test('非必填未知颜色随正式草稿进入C2时仍为unknown', () => {
  const { candidate, request } = prepare();
  const response = localReceipt(request);
  const admitted = authorizedExecution(request, candidate.dataRevision);
  const merged = mergeC1AiDraftReceipt({ skuPackage: candidate.lifecycleV11.skuPackage, request, receipt: response,
    settledExecution: settledExecution(request, response, admitted), mergedAt: LOCAL_DRAFT_AT });
  const input = prepareC2SoftwareInput({ skuPackage: merged.skuPackage, expectedDataRevision: merged.skuPackage.dataRevision,
    assetRegions: { collected: [], aiDrafts: [], finalUploads: [] }, preparedAt: LOCAL_DRAFT_AT });
  assert.equal(input.status, 'ready');
  assert.equal(input.c1.verifiedFacts.productAttributes.ozonAttributes.find(attribute => attribute.fieldKey === '10096').fact.verificationStatus, 'unknown');
  assert.ok(input.c1.verifiedFacts.unknownManifest.some(item => item.reason === 'sku_attribute_scope_unresolved' && item.blocksC2Handoff === false));
});

test('材料、来源、SKU、选中变体任一漂移拒绝，显式本地来源不回退 K3', () => {
  for (const mutate of [
    c => { c.lifecycleV11.c1KeywordPlanningLocalMaterialV1.keywords[0].term = '伪造'; },
    c => { c.lifecycleV11.skuPackage.dataRevision += 1; },
    c => { c.sourceCapture.skuChoices[0].attributes.颜色 = '蓝'; },
    c => { c.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1.inputFingerprint = 'wrong'; }
  ]) {
    const candidate = createSavedLocalPreparationCandidate(); mutate(candidate);
    assert.throws(() => prepareC1LocalDraftSource({ candidate, preparedAt: LOCAL_DRAFT_AT }), /C1_LOCAL_DRAFT_/);
  }
  for (const mutate of [
    c => { c.lifecycleV11.c1LocalDraftSourceV1.materialFingerprint = 'wrong'; },
    c => { c.lifecycleV11.skuPackage.targetStore = 'another'; },
    c => { c.lifecycleV11.skuPackage.c1ProductPlan.productAttributes.ozonAttributes[0].fact.value.value = 'другой'; },
    c => { c.lifecycleV11.c1LocalDraftSourceV1 = null; }
  ]) {
    const { candidate } = prepare(); mutate(candidate);
    assert.throws(() => prepareCurrentC1AiDraftRequest(candidate, LOCAL_DRAFT_AT), /C1_LOCAL_DRAFT_/);
  }
});

test('标题单词足够，不为搜索词凑数；严格回执可合并且仍只形成草稿', () => {
  const { candidate, request } = prepare({ titleOnly: true });
  assert.equal(request.keywordEvidence.keywords.length, 1);
  const response = localReceipt(request);
  assert.deepEqual(response.output.searchKeywords, []);
  assert.deepEqual(validateC1AiDraftReceipt({ request, receipt: response }), { valid: true, errors: [] });
  const admitted = authorizedExecution(request, candidate.dataRevision);
  const saved = settledExecution(request, response, admitted);
  const merged = mergeC1AiDraftReceipt({ skuPackage: candidate.lifecycleV11.skuPackage, request, receipt: response, settledExecution: saved, mergedAt: LOCAL_DRAFT_AT });
  assert.equal(merged.skuPackage.businessPhase, 'C1');
  assert.equal(merged.c1ProductPlan.status, 'seo_draft_ready');
  assert.deepEqual(merged.c1ProductPlan.searchKeywordsDraft.keywords, []);
  assert.equal(merged.c1ProductPlan.seoTitleDraft.productionApproved, false);
});

test('未知长度只限显式本地规则，历史请求保留原限制', () => {
  assert.throws(() => buildRequest({ seoRules: { ...seoRules(), titleMaxLength: null } }), /C1_AI_SEO_RULES_INVALID/);
  const { request } = prepare({ titleOnly: true });
  const response = localReceipt(request);
  response.output.title.text = '3D-пазл '.repeat(30).trim();
  response.outputFingerprint = digest(response.output);
  assert.deepEqual(validateC1AiDraftReceipt({ request, receipt: response }), { valid: true, errors: [] });
  assert.ok(C1_LOCAL_DRAFT_FAILURE_CODES.includes('C1_LOCAL_DRAFT_MATERIAL_DRIFT'));
  assert.ok(C1_LOCAL_DRAFT_FAILURE_CODES.includes('C1_SKU_RIGHTS_REVIEW_REQUIRED'));
});

test('本地来源和请求发布schema严格校验，网关仅对无搜索词用途的本地来源允许空数组', async () => {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const { default: addFormats } = await import('ajv-formats');
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  for (const name of ['c1-ai-draft-request-v1', 'c1-local-draft-source-v2']) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schema/${name}.schema.json`, import.meta.url), 'utf8')));
  }
  const local = prepare({ titleOnly: true });
  for (const [name, value] of [['c1-ai-draft-request-v1', local.request], ['c1-local-draft-source-v2', local.prepared.sourceEvidence]]) {
    const validate = ajv.getSchema(name); assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  for (const [request, minimum] of [[local.request, 0], [prepare().request, 1], [buildRequest(), 1]]) {
    const job = buildC1GatewayJob({ candidateId: request.sourceIdentity.candidateId, dataRevision: 1, request });
    assert.equal(job.outputSchema.properties.searchKeywords.minItems, minimum);
    assert.equal(job.outputSchema.properties.searchKeywords.maxItems, minimum === 0 ? 0 : 50);
    if (minimum === 0) {
      const validate = ajv.compile(job.outputSchema);
      assert.equal(validate(localReceipt(request).output), true, JSON.stringify(validate.errors));
    }
  }
  assert.equal(C1_AI_GATEWAY_OUTPUT_SCHEMA.properties.searchKeywords.minItems, 1);
  const invalid = structuredClone(local.request); invalid.seoRules.titleMaxLength = 120;
  assert.equal(ajv.getSchema('c1-ai-draft-request-v1')(invalid), false);
});
