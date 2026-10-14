// This fixture preserves the historical three-group scoring contract.
const KEYWORD_SCORING_VERSION = "keyword-scoring-v1";
import { createFormalC1DraftFixture } from './formal-c1-flow-fixture.mjs';
import { createKeywordEvidenceSnapshot } from '../../lib/keyword-evidence-snapshot.mjs';
import { KEYWORD_SCORING_COMPONENTS } from '../../lib/keyword-evidence-scoring.mjs';
import { prepareC1SoftwareInputs } from '../../lib/c1-software-input-preparation.mjs';
import { createC1SoftwareEvidenceStage } from '../../lib/c1-software-evidence-stage.mjs';
import { KEYWORD_NOW } from './c1-keyword-planning-fixture.mjs';
import { createC1AiAccounting } from '../../lib/c1-ai-draft-contract.mjs';
import { prepareCurrentC1AiDraftRequest } from '../../lib/c1-ai-draft-request-source.mjs';
import { authorizedExecution, settledExecution } from './c1-ai-draft-fixture.mjs';
import { fingerprintCanonicalRecord } from '../../lib/production-contract-primitives.mjs';
import { addSyntheticC1Review } from './c1-seo-review-fixture.mjs';

/** Complete executable fixture; legacy formal fixtures remain available separately for historical occupancy. */
export function createC1PaidFormalFixture({ credentialAlias = 'gateway-alias:formal', ...options } = {}) {
  const formal = createFormalC1DraftFixture({ ...options, salesSnapshotVersion: 'sales-snapshot-v1.1' });
  const source = structuredClone(formal.candidate);
  source.dataRevision -= 2;
  const candidate = c1DraftPreparedCandidate({ candidate: source, at: formal.at });
  const request = prepareCurrentC1AiDraftRequest(candidate, formal.at);
  candidate.dataRevision += 1;
  candidate.lifecycleV11.c1AiDraftRequestV1 = structuredClone(request);
  const execution = authorizedExecution(request, candidate.dataRevision + 1, { softwareJobId: formal.receipt.softwareJobId,
    authorizationId: formal.authorizedExecution.authorizationRef.authorizationId });
  const receipt = c1DraftPaidReceipt({ request, authorizedExecution: execution }, formal.at);
  return { ...formal, candidate, request, receipt, authorizedExecution: execution,
    settledExecution: settledExecution(request, receipt, execution),
    executionBinding: { provider: request.provider, modelVersion: `gpt-5.6-${request.provider}`, credentialAlias, allowedWorkerIds: ["worker-c1-draft"] } };
}

export function c1DraftPreparedCandidate({ candidate = null, at = KEYWORD_NOW } = {}) {
  candidate = candidate === null ? createFormalC1DraftFixture({ at, salesSnapshotVersion: "sales-snapshot-v1.1" }).candidate : structuredClone(candidate);
  const sku = candidate.lifecycleV11.skuPackage, plan = sku.c1ProductPlan;
  const binding = { candidateId: candidate.id, parentOpportunityId: plan.identity.parentOpportunityId, skuPackageId: sku.skuPackageId,
    dataRevision: sku.dataRevision, supplierSkuId: sku.supplierSkuId,
    salesSnapshotVersion: plan.inputSnapshots.salesSnapshot.version ?? plan.inputSnapshots.salesSnapshot.schemaVersion,
    salesSnapshotFingerprint: fingerprintCanonicalRecord(plan.inputSnapshots.salesSnapshot),
    supplySkuFactsVersion: 'c1-confirmed-supplier-sku-snapshot-v1', supplySkuFactsFingerprint: fingerprintCanonicalRecord(plan.inputSnapshots.confirmedSupplierSkuSnapshot),
    preparationFingerprint: 'k2:synthetic:paid-flow', metricEvidenceFingerprint: 'metrics:synthetic:paid-flow', scoringPayloadFingerprint: null };
  const groups = Object.fromEntries([['title_keywords', 3], ['attribute_and_tag_keywords', 6], ['description_long_tail', 10]].map(([group, count]) =>
    [group, Array.from({ length: count }, (_, index) => ({ keyword: `сборная модель ${group} ${index}`, sourceRefs: [`keyword:synthetic:${group}:${index}`],
      factRefs: plan.platformCategory.categoryName.sourceRefs, score: 90, scoringVersion: KEYWORD_SCORING_VERSION, confidence: 0.35,
      decision: 'adopted', decisionReason: `${group}_ranked_selection`, matchType: 'target_fact', evidenceCoverage: 0.35, usageRestriction: null,
      placementGateEvidence: null, components: Object.fromEntries(Object.keys(KEYWORD_SCORING_COMPONENTS).map(name => [name,
        name === 'semanticMatch' ? { value: 90, rawValue: 90, raw: null, normalizationRule: 'identity_0_100', conversionRule: null,
          evidenceRef: 'metric:synthetic:semantic', observedAt: at, period: null } : null])) }))]));
  const scoringContext = { scoringVersion: KEYWORD_SCORING_VERSION, preparationId: 'k2:synthetic:paid-flow', preparationFingerprint: binding.preparationFingerprint,
    pointsBefore: 0, pointsAfter: 0, pointsSpent: 0, coverage: 'full',
    groupLimits: { title_keywords: { min: 3, max: 5 }, attribute_and_tag_keywords: { min: 6, max: 12 }, description_long_tail: { min: 10, max: 20 } },
    gaps: [], rejected: [], metricEvidenceVersion: 'keyword-metrics-v1', metricEvidenceFingerprint: binding.metricEvidenceFingerprint,
    execution: { networkCalls: 0, modelCalls: 0, codexDispatches: 0, bOrC1Created: false, sharedWrites: 0 } };
  scoringContext.scoringPayloadFingerprint = fingerprintCanonicalRecord({ groups, rejected: [], gaps: [],
    preparationFingerprint: binding.preparationFingerprint, metricEvidenceFingerprint: binding.metricEvidenceFingerprint });
  binding.scoringPayloadFingerprint = scoringContext.scoringPayloadFingerprint;
  const snapshot = createKeywordEvidenceSnapshot({ snapshotId: 'k3:synthetic:paid-flow',
    identity: { candidateId: candidate.id, parentOpportunityId: binding.parentOpportunityId, skuPackageId: sku.skuPackageId, dataRevision: sku.dataRevision },
    bindings: { salesSnapshot: { snapshotId: plan.inputRefs.salesSnapshotId, version: binding.salesSnapshotVersion, fingerprint: binding.salesSnapshotFingerprint },
      supplySkuFacts: { version: binding.supplySkuFactsVersion, fingerprint: binding.supplySkuFactsFingerprint } },
    currentBinding: binding, collectedAt: at, expiresAt: new Date(Date.parse(at) + 86_400_000).toISOString(), asOf: at,
    sourceAttempts: [{ schemaVersion: 'keyword-source-attempt-v1', attemptId: 'attempt:synthetic:local', provider: 'local-keyword-fusion', channel: 'local_fusion',
      queryId: 'query:synthetic:local', queryText: 'frozen synthetic evidence', locale: 'ru-RU', targetPlatform: 'ozon', requestId: 'request:synthetic:local', receiptId: null,
      startedAt: at, completedAt: at, status: 'completed', resultCount: 19, failureClass: null, traceRef: 'trace:synthetic:local' }],
    groups, statusOverride: 'ready', scoringContext });
  const frozenSeoRules = { rulesVersion: 'seo:synthetic:paid-flow', locale: 'ru-RU', titleMaxLength: 120, descriptionMaxLength: 1800,
    bulletPointLimit: 5, prohibitedClaims: [], evidenceRef: 'policy:seo:synthetic', frozenAt: at };
  const inputs = { skuPackage: sku, frozenSeoRules, k3KeywordEvidenceSnapshot: snapshot, k3CurrentBinding: binding, frozenComplexityDecision: null };
  const preparedInputs = prepareC1SoftwareInputs({ ...inputs, preparedAt: at });
  const stage = createC1SoftwareEvidenceStage({ ...inputs, candidateId: candidate.id, candidateRevision: candidate.dataRevision,
    preparedInputs, stagedAt: at });
  candidate.lifecycleV11.c1SoftwareEvidenceV1 = stage.evidence;
  candidate.lifecycleV11.k3KeywordEvidenceSnapshotV1 = snapshot;
  candidate.lifecycleV11.k3CurrentBindingV1 = binding;
  candidate.dataRevision += 1;
  return candidate;
}

export function c1DraftPaidReceipt({ request, authorizedExecution }, at = request.requestedAt) {
  const piece = (field, selectedKeyword = null) => {
    const keyword = selectedKeyword ?? request.keywordEvidence.keywords.find(item => !item.allowedOutputFields || item.allowedOutputFields.includes(field));
    if (!keyword) throw new Error(`SYNTHETIC_C1_KEYWORD_MISSING:${field}`);
    return { text: keyword.query, factRefs: [...keyword.factRefs], keywordRefs: [keyword.keywordEvidenceRef],
      assertions: keyword.factRefs.map(factPath => ({ factPath, value: structuredClone(request.verifiedFacts.find(fact => fact.factPath === factPath).value) })) };
  };
  const output = { status: 'draft_only', locale: 'ru-RU', claimCoverage: 'complete', unsupportedClaims: [],
    title: piece('title'), description: piece('description'), bulletPoints: [piece('bulletPoints')], searchKeywords: [piece('searchKeywords')] };
  if (request.factDefinitionsVersion === 'c1-fact-definitions-v1') {
    // New-input fixtures need an additional fact; repeated historical copy is
    // retained only when testing the old request contract explicitly.
    const additional = request.keywordEvidence.keywords.find(item =>
      (!item.allowedOutputFields || item.allowedOutputFields.includes('bulletPoints')) && item.query !== output.description.text);
    output.bulletPoints = additional ? [piece('bulletPoints', additional)] : [];
  }
  addSyntheticC1Review(request, output);
  const gatewayJobId = `gateway:${authorizedExecution.jobId}`;
  return { schemaVersion: 'c1-ai-draft-receipt-v1', receiptId: `receipt:${authorizedExecution.jobId}`, providerRequestId: 'provider:synthetic:1',
    softwareJobId: authorizedExecution.jobId, gatewayJobId, accounting: createC1AiAccounting({ gatewayJobId, providerRequestId: 'provider:synthetic:1' }),
    requestId: request.requestId, requestFingerprint: request.requestFingerprint, provider: request.provider,
    modelVersion: request.provider === 'terra' ? 'gpt-5.6-terra' : 'gpt-5.6-sol', serviceVersion: 'synthetic-gateway:1', status: 'completed', attempt: 1,
    startedAt: at, completedAt: at, externalPlatformAccesses: 0, codexDispatches: 0, productionWrites: 0,
    inputEvidenceRefs: [...new Set([request.competitorTextEvidence.evidenceRef, request.keywordEvidence.evidenceId, ...request.verifiedFacts.flatMap(fact => fact.evidenceRefs)])],
    outputFingerprint: fingerprintCanonicalRecord(output), output };
}
