import { preparationFamily, saveSiblingPreparationDraft } from './lib/sibling-preparation-draft.mjs';
import { siblingSupplyPreparation } from './lib/sibling-supply-preparation.mjs';
import { createLocalSiblingCatalogReader } from './lib/sibling-preparation-catalog.mjs';
import { createInitialCandidate, queuedProcessing } from "./lib/candidate-initialization.mjs";
import { createSiblingSkuCandidate, createSiblingSkuCandidatesBatch, siblingSkuCandidateInput, SiblingSkuCandidateError } from './lib/sibling-sku-candidate.mjs';
import { commitSiblingBatchABAndC1 } from './lib/sibling-batch-a-b-c1.mjs';
import { commitSiblingBatchC1Preparation, previewSiblingBatchC1Preparation } from './lib/sibling-batch-c1-preparation.mjs';
import { commitSiblingBatchC2Final, isSiblingBatchC2Replay } from './lib/sibling-batch-c2-final.mjs';
import { assertSiblingSkuColorProjection, assertSiblingSkuFinalCard } from './lib/sibling-sku-card-guard.mjs';
import { createADiscoveryRuntimeServices, A_DISCOVERY_DECLINE_REASONS } from './lib/a-discovery-runtime-services.mjs';
import { supplierImageSearchAvailability, readSupplierImageSearchPreparation, requireSupplierImageSearchPreparation,
  SupplierImageSearchPreparationError } from './lib/a-supplier-image-search-runtime-services.mjs';
import { ADiscoveryError } from './lib/a-discovery-contract.mjs';
import { createLinkfoxDiscoverySecretReader, createSeerfarDiscoverySecretReader } from './lib/linkfox-discovery-credentials.mjs';
import { createADiscoveryCandidateImportUseCase } from './lib/a-discovery-candidate-import.mjs';
import { loadSeerfarSelectionConfig } from './lib/seerfar-selection-config.mjs';
import { createSeerfarWebRoundService } from './lib/seerfar-web-round-service.mjs';
import { createStoreSalesSeedService } from './lib/store-sales-seed-service.mjs';
import { seerfarTodos } from './lib/seerfar-todos.mjs';
import { StoreProfileError, storeProfileView, updateStoreProfile } from './lib/store-profile.mjs';
import { createOzonStoreSalesReader, storeSalesRoutes } from './lib/ozon-store-sales-reader.mjs';
import { createDiscoveryTitleTranslator, DiscoveryTitleTranslationError } from './lib/discovery-title-translation.mjs';
import { createADiscoveryTitleTranslationUseCase } from './lib/discovery-title-translation-store.mjs';
import { createADiscoveryEstimateInputs, createADiscoveryEstimateUseCase } from './lib/a-discovery-estimate-store.mjs';
import { ensureDiscoveryMarketSalesSnapshot, readDiscoveryMarketRecord, currentSalesSnapshot } from './lib/discovery-market-snapshot.mjs';
import { SupplierDraftError, buildSupplierDraftEstimate, buildSupplierDraftV1, normalizeSupplierDraftInput } from './lib/supplier-draft.mjs';
import {
  SKU_UNIFORM_SUPPLY_LABEL, buildSkuChoiceTable, buildSkuUniformSupplyStep,
  buildOwnerSkuUniformSupplyRecord, inForceSkuUniformSupply, readSkuUniformSupplyDeclaration
} from './lib/sku-choice-estimate.mjs';
import { buildProfitStepReview } from './lib/profit-step-review.mjs';
import {
  CARGO_FACT_KEYS, buildCargoFactsStep, buildOwnerCargoFactsRecord, validateOwnerCargoFactsDeclaration
} from './lib/cargo-facts-declaration.mjs';
import {
  EXTRA_HANDLING_FEE_LABEL, buildExtraHandlingFeesStep, buildOwnerExtraHandlingFeesRecord,
  extraHandlingFeeAssumptions, validateOwnerExtraHandlingFees
} from './lib/extra-handling-fees.mjs';
import { adapt1688CaptureToSupplierOption } from './lib/supplier-option.mjs';
import { readOzonCommissionReference, readOzonCommissionReferenceTiers } from './lib/ozon-commission-reference-reader.mjs';
import { readGuooTariffCatalog } from './lib/guoo-tariff-reader.mjs';
import { readCurrentCbrExchangeRate } from './lib/official-fx-reader.mjs';
import { createAProductDetailRuntimeServices } from './lib/a-product-detail-runtime-services.mjs';
import { createAProductDetailApplicationUseCase } from './lib/a-product-detail-application.mjs';
import { AProductDetailError } from './lib/a-product-detail-contract.mjs';
import { readAProductDetailSupplierEvidence } from './lib/a-product-detail-evidence.mjs';
import { normalizeEvidenceScope, evidenceScopeKey, evidenceScopeMatches, buildExpectedEvidenceScope } from "./lib/lifecycle-evidence-scope.mjs";
import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_AUTOMATION_CONCURRENCY_LIMIT,
  DEFAULT_RULES,
  WORKFLOW_STATUSES,
  promotionPricingGate,
  approvalGate,
  profitReviewGate,
  codexAutoEliminationGate,
  businessDate,
  buildCurrentExecutionRuntimeView,
  claimEligible,
  dailySummary,
  dispatchQueueSummary,
  filterUserNeededFields,
  currentProcessingStatusSummary,
  isActualProcessingRun,
  recordCurrentMaintenanceProgress,
  registerProcessingAttempt,
  recentAvoidanceFeedback,
  requiredInputFields,
  selectionStage,
  purchaseCeilingSummary,
  queueUserDispatch,
  sortDispatchQueue,
  technicalFailureDisposition,
  validateListingRecord,
  validateListingReadback,
  wbAssessmentDecisionGate
} from "./lib/workflow.mjs";
import {
  ACTIVE_DISPATCH_STATES,
  RECOVERABLE_TERMINAL_DISPATCH_STATES,
  activeDispatchForCandidate as selectCurrentDispatch,
  candidateActiveNode,
  collaborationSummary,
  dispatchOwnerForNode,
  ensureCollaborationData,
  isDisabledLegacyCDispatch,
  latestDispatchForCandidate,
  readWorkflowMap,
  validateNodeExecution,
  workflowMapView
} from "./lib/workflow-map.mjs";
import {
  CodexDispatcher,
  createDispatchSkillCatalog,
  dispatchCandidateSnapshot,
  dispatchCapabilityPlan,
  requiredSkillsForDispatch
} from "./lib/codex-dispatcher.mjs";
import {
  extract1688OfferId,
  extractPinduoduoGoodsId,
  normalize1688CaptureSource,
  normalizeSupplierCaptureSource,
  resolveCapturedSku,
  resolveCapturedSkus,
  sanitize1688Evidence,
  sanitizePinduoduoEvidence,
  supplierCapturePlatform,
  supplierPlatformLabel,
  sanitizeSourceCaptureFailureResult,
  sourceCaptureFailureDestinationLabel,
  sourceCaptureFailureMessage
} from "./lib/source-capture.mjs";
import {
  ozonCaptureFailureMessage,
  sanitizeOzonCaptureEvidence
} from "./lib/ozon-sales-capture.mjs";
import {
  ozonCapturePageJobPayload,
  ozonCapturePageJobPublic,
  shouldRebuildOpportunityFromLegacy,
  ozonCapturePageTarget,
  ozonPageReadStopMessage
} from "./lib/ozon-page-capture-job.mjs";
import {
  SUPPLIER_IMAGE_MATCH_JUDGEMENT_LABELS, queuedSupplierImageMatchRecord, SUPPLIER_IMAGE_MATCH_SOURCE_LABELS,
  sanitizeSupplierImageMatchEvidence, supplierImageMatchJobPayload, supplierImageMatchJobPublic, supplierImageMatchRules,
  supplierImageMatchSource
} from "./lib/supplier-image-match.mjs";
import {
  ozonImageMatchJobPayload, ozonImageMatchJobPublic, ozonImageMatchRules, ozonImageMatchTarget, queuedOzonImageMatchRecord,
  sanitizeOzonImageMatchEvidence
} from "./lib/ozon-same-product-match.mjs";
import { fetchImageFingerprint, fetchPublicProductImage, searchUploadImageFromBuffer } from "./lib/image-fingerprint.mjs";
import { buildOzonCategoryReadStep } from "./lib/ozon-category-read-step.mjs";
import { buildCommissionEstimateSignal, buildCommissionEstimateStep, buildEstimatedCommissionNoticeStep,
  ExactCommissionRequiredForProductionError } from "./lib/commission-estimate-authorization.mjs";
import { adaptLegacyCandidateToOpportunity } from "./lib/legacy-candidate-adapter.mjs";
import { buildRealLifecycleEntryPreview } from "./lib/real-lifecycle-entry-preview.mjs";
import { buildRealAConfirmationCard, validateRealAConfirmationSubmission } from "./lib/real-a-confirmation-card.mjs";
import { resolveConfiguredStoreRef, assertCandidateStoreBinding, sameStoreRef } from "./lib/store-binding.mjs";
import {
  AStageTerraGatewayError,
  runAStageTerraAssist
} from "./lib/a-stage-terra-gateway.mjs";
import { applyLifecycleBEvidenceContext } from "./lib/lifecycle-b-evidence-context.mjs";
import { runRealAConfirmationWithSystemEvidence } from "./lib/real-a-b-evidence-orchestration.mjs";
import { GuooRouteComparisonError, appendGuooRouteComparison, assertGuooComparisonReadyForEvidence,
  assertGuooComparisonFrozenForEvidenceRefresh } from "./lib/guoo-route-comparison.mjs";
import { BExactCommissionRecalculationError, assertCurrentBCommissionEvidence } from "./lib/real-a-b-c1-flow.mjs";
import { createBExactCommissionRecalculationUseCase } from "./lib/b-exact-commission-recalculation-use-case.mjs";
import { createFinalPricingReviewUseCase } from "./lib/final-pricing-review-use-case.mjs";
import { buildBExactCommissionRuntimeView } from "./lib/b-exact-commission-runtime-view.mjs";
import {
  inspectLifecycleBInputReadiness,
  resolveLifecycleEvidenceContext,
  isCommissionEstimateAuthorizationForScope,
  validateLifecycleEvidenceData
} from "./lib/lifecycle-b-input-bundle.mjs";
import {
  buildLifecycleBEvidencePreparationPlan,
  runLifecycleBEvidencePreparation
} from "./lib/lifecycle-b-evidence-preparation.mjs";
import { createLifecycleBRealEvidenceProviderRegistry } from "./lib/lifecycle-b-real-evidence-readers.mjs";
import {
  buildLifecycleBExplicitOtherCosts,
  resolveLifecycleBProfitRule,
  assertLifecycleBCostsCurrent,
  inspectLifecycleBCostReadiness,
  commitLifecycleBEvidencePacks,
  commitLifecycleBFeeEvidenceRefresh
} from "./lib/lifecycle-b-evidence-runtime.mjs";
import { completeC1AndStartC2 } from "./lib/lifecycle-c-stage.mjs";
import { createC1DraftRuntimeServices } from "./lib/c1-draft-runtime-services.mjs";
import { buildC1DraftRuntimeView } from "./lib/c1-draft-runtime-view.mjs";
import { OwnerProductFactsError } from "./lib/owner-product-facts.mjs";
import { C1AiGatewayError } from "./lib/c1-ai-gateway.mjs";
import { ConfirmedSupplierInputError } from "./lib/confirmed-supplier-inputs.mjs";
import { createC1ContentReviewUseCase, buildC1ContentReviewView, C1ContentReviewError } from "./lib/c1-content-review-use-case.mjs";
import { createC1EditorialReviewUseCase, buildC1EditorialReviewView, C1EditorialReviewError } from "./lib/c1-editorial-review-use-case.mjs";
import { C1_LOCAL_DRAFT_FAILURE_CODES } from "./lib/c1-local-draft-source.mjs";
import { createC1SkuRightsReviewUseCase } from "./lib/c1-sku-rights-review-submission.mjs";
import { createC1FactsVerificationUseCase, C1FactsVerificationError } from "./lib/c1-facts-verification-use-case.mjs";
import { createC1SupplyAttributeBackfillUseCase, C1SupplyAttributeBackfillError } from "./lib/c1-frozen-supply-attribute-backfill-use-case.mjs";
import { createC1OzonAttributeMappingUseCase, C1OzonAttributeMappingError } from "./lib/c1-ozon-attribute-mapping-use-case.mjs";
import { createOzonDictionaryValueReader, createOzonDictionaryValuesReader } from "./lib/ozon-dictionary-value-reader.mjs";
import { createC1OzonAttributeProposer, C1OzonAttributeProposalError, OZON_ATTRIBUTE_PROPOSAL_MAX_ATTRIBUTES } from "./lib/c1-ozon-attribute-proposal.mjs";
import { resolveC1SkuRightsReviewForFacts } from "./lib/c1-sku-rights-review.mjs";
import { verifyC1ProductFacts } from "./lib/c1-product-plan.mjs";
import { refreshC1FrozenPlatformSchema, C1FrozenSchemaRefreshError } from "./lib/c1-frozen-schema-refresh.mjs";
import { C1SkuRightsReviewError } from "./lib/c1-sku-rights-review.mjs";
import { C1DraftRuntimeUnavailableError } from "./lib/c1-draft-software-runtime.mjs";
import { prepareC1FactKeywordRuntime } from "./lib/c1-fact-keyword-runtime.mjs";
import { buildC1FactKeywordAtomicPatch } from "./lib/c1-fact-keyword-persistence.mjs";
import { acceptC1KeywordEvidenceReadyEvent } from "./lib/c1-keyword-evidence-auto-trigger.mjs";
import {
  buildC1KeywordSoftwareJobPlan
} from "./lib/c1-keyword-software-job-planner.mjs";
import {
  enqueueC1PaidKeywordEvidenceJob
} from "./lib/c1-keyword-software-use-case.mjs";
import { runC1KeywordPlanningEvidenceProduction } from "./lib/c1-keyword-planning-software-use-case.mjs";
import { produceC1LocalPreparation } from "./lib/c1-keyword-planning-local-material.mjs";
import { persistC1KeywordPlanningLocalMaterial } from "./lib/c1-keyword-planning-local-material-persistence.mjs";
import { createSeerfarRuntimeTransport, SEERFAR_RUNTIME_CONNECTOR_VERSION } from "./lib/seerfar-runtime-connector.mjs";
import {
  confirmC2SoftwareFinalUploads,
  createC2SoftwareContainer,
  prepareC2FinalUploadManifest
} from "./lib/c2-software-orchestrator.mjs";
import { createFinalProductPlanConfirmationCard } from "./lib/final-product-plan-confirmation-card.mjs";
import { createConfiguredBusinessStateRepository } from "./lib/business-state-repository.mjs";
import { createSelectionReviewRuntimeConfiguration, createDPlatformObservationPolicyResolver } from "./lib/runtime-configuration.mjs";
import {
  assertTrustedApiRequest,
  isTrustedInternalApiRequest,
  normalizeHttpErrorResponse,
  parseHttpRequestTarget,
  readJsonRequestBody
} from "./lib/http-api-boundary.mjs";
import {
  normalizeCandidateCodexCreateInput,
  normalizeCandidateUserCreateInput,
  normalizeCandidateUserPatchInput
} from "./lib/candidate-user-fields.mjs";
import { normalizeCandidateCommentInput } from "./lib/candidate-comment-boundary.mjs";
import {
  listingPreparationCStageFields,
  listingPreparationInheritedFields,
  normalizeListingPreparationReviewInput
} from "./lib/listing-preparation-review-boundary.mjs";
import { createConfiguredIdentityProvider, OwnerIdentityError } from "./lib/runtime-identity-provider.mjs";
import { assertSafeBusinessMutationCandidate, createActorContext } from "./lib/runtime-identity.mjs";
import { createRepositoryBackedSoftwareJobStore } from "./lib/software-job-repository.mjs";
import { createLocalDevelopmentWorkerRegistry } from "./lib/worker-registry.mjs";
import { assertRuntimeBoundaries } from "./lib/multi-user-central-runtime.mjs";
import { commitSingleOwnerProductionAuthorization, PRODUCTION_AUTHORIZATION_VERSION } from "./lib/production-authorization.mjs";
import { commitBatchOwnerProductionAuthorization } from './lib/d-batch-production-authorization.mjs';
import { saveSiblingBatchCommercialDrafts } from './lib/sibling-batch-commercial-drafts.mjs';
import { projectDBatchExecutionView } from './lib/d-batch-execution-view.mjs';
import { createDEProductionRuntimeServices, DERuntimeUnavailableError } from "./lib/d-e-runtime-services.mjs";
import { buildDESavedJobRuntimeView } from "./lib/d-e-runtime-view.mjs";
import { buildProductionOwnerPreparationView, resolveProductionOwnerPreparation, ProductionOwnerPreparationError } from "./lib/production-owner-preparation.mjs";
import { inspectSavedSkuFactReconciliation } from "./lib/confirmed-supplier-inputs.mjs";
import { buildC1ReviewPresentation } from "./lib/c1-review-presentation.mjs";
import { createSystemEReadbackSoftwareRuntime, EReadbackRuntimeUnavailableError } from "./lib/e-readback-software-use-case.mjs";
import { assertValidLifecyclePackage } from "./lib/product-lifecycle-schema.mjs";
import {
  phase2ADemoCard,
  phase2AResultSummary,
  runPhase2AConfirmation
} from "./lib/phase-2a-simulation.mjs";
import {
  blockExecutionForTechnicalFailure,
  codexDispatchGate,
  completeExecutionStep,
  createSoftwareExecutionRuntime,
  openExceptionCase,
  recordExceptionMaintenanceStarted,
  startSoftwareStep,
  startThirdPartyAiStep,
  simulateNormalSoftwarePath,
  waitForOwner
} from "./lib/software-execution-state.mjs";
import {
  EXCEPTION_MAINTENANCE_PATH,
  NORMAL_PRODUCTION_PATH,
  assertRuntimeCodexDependencyAllowed,
  codexOfflineModeFromEnvironment,
  dispatchDeliveryEnabledFromEnvironment
} from "./lib/codex-independence.mjs";
import { buildThreeStoreMapView } from "./lib/three-store-map.mjs";
import { assembleProductCoreForFamily, buildFamilyListingDrafts, ProductCoreFamilyError } from "./lib/product-core-family.mjs";
import { ProductCoreError } from "./lib/product-core.mjs";
import { loadPlatformMapping, loadPlatformProfile, PlatformProjectionError } from "./lib/platform-projection.mjs";
import { listStores } from "./lib/store-registry.mjs";
import { buildDESoftwareIntegrationView } from "./lib/d-e-software-integration.mjs";
import { assertCurrentProductionExecutionBinding } from "./lib/platform-write-preflight.mjs";
import { assertCurrentC2UploadDraft, reserveC2Upload, settleC2Upload, saveC2UploadSelection, selectedC2DraftAssets, resolveRegisteredC2FinalAsset, LOCAL_UPLOAD_MAX_BYTES } from "./lib/c2-upload-draft.mjs";
import { createC2LocalAssetStore, normalizeC2LocalUpload } from "./lib/c2-local-asset-store.mjs";
import { createC1ImageTextUseCase } from "./lib/c1-image-text-use-case.mjs";
import { createC1FinalPlanRevisionUseCase } from "./lib/c1-final-plan-revision-use-case.mjs";
import { hasUnsettledC1ColorDictionaryRead } from "./lib/c1-final-plan-revision-preparation.mjs";
import { createC1SiblingColorRevisionUseCase, C1SiblingColorRevisionError } from "./lib/c1-sibling-color-revision-use-case.mjs";
import { createC1ColorDictionaryReadUseCase, C1ColorDictionaryReadError } from './lib/c1-color-dictionary-read-use-case.mjs';
import { createLocalImageTextAdapter } from "./lib/local-image-text-adapter.mjs";
import {
  createPersistableAliyunOssAssetIntent,
  executeAliyunOssAssetIntent,
  markAliyunOssAssetIntentPersisted,
  settleAliyunOssAssetIntent
} from "./lib/aliyun-oss-d-asset-integration.mjs";
import { createAliyunOssRuntimeProvider } from "./lib/aliyun-oss-runtime-provider.mjs";
import { createOzonDEHttpTransport } from "./lib/ozon-de-http-transport.mjs";
import { createOzonDEPreflightProvider } from "./lib/ozon-de-preflight-provider.mjs";
import { createRepositoryBackedOzonDEPreflightEvidenceReader } from "./lib/ozon-de-preflight-evidence-reader.mjs";
import { createOzonAccountReadBindingResolver } from "./lib/ozon-account-read-preparation.mjs";
import { createOzonAccountReadEvidenceSource } from "./lib/ozon-account-read-evidence.mjs";
import { loadOzonDEProtocolCatalog } from "./lib/ozon-de-protocol-catalog.mjs";
import { loadOzonProductImportBatchLimitEvidence } from "./lib/ozon-product-import-batch-limit.mjs";
import { createOzonAccountReadServices } from "./lib/ozon-account-read-services.mjs";
import { createConfiguredOzonAccountDiscoveryRuntime } from './lib/ozon-account-discovery-runtime.mjs';
import { OzonAccountReadError } from "./lib/ozon-account-read-contract.mjs";
import { createDProductionRoundUseCase, DProductionRoundError } from "./lib/d-production-round-use-case.mjs";
import { createProductionAuthorizationRollbackUseCase, ProductionAuthorizationRollbackError } from "./lib/production-authorization-rollback-use-case.mjs";
import { createDInitialImportRecoveryUseCase, DInitialImportRecoveryError } from "./lib/d-initial-import-recovery-use-case.mjs";
import { createDUnknownOutcomeReobservationUseCase, DUnknownOutcomeReobservationError } from "./lib/d-unknown-outcome-reobservation-use-case.mjs";
import { createDPlatformStateReconciliationUseCase, DPlatformStateReconciliationError } from "./lib/d-platform-state-reconciliation-use-case.mjs";
import { C1KeywordContinuationRevisionConflictError, createKeywordEvidenceRuntimeServices } from "./lib/keyword-evidence-runtime-services.mjs";

import { createRuntimeHealth } from './lib/runtime-health.mjs';
import { INTAKE_MAX_LINKS_PER_PASTE, intakeBlocker, intakeDuplicateOf, intakeLogin1688State, intakePause, intakeProgress, intakeQueue,
  intakeAttachPlan, intakeResumePlan, intakeRetryPlan, intakeStageUpdate, newIntakeRecord, nextIntakeWork, parseIntakeLinks } from "./lib/intake-pipeline.mjs";
import { buildIntakeRoughProfit, intakeRoughProfitPlan } from "./lib/intake-rough-profit.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeConfiguration = createSelectionReviewRuntimeConfiguration({ env: process.env, appDir, argv: process.argv });
const dataFile = runtimeConfiguration.dataFile;
const runtimeHealth = createRuntimeHealth({ filePath: dataFile, storageAdapter: runtimeConfiguration.stateAdapter });
const workflowMapFile = runtimeConfiguration.workflowMapFile;
const imagesDir = path.join(appDir, "product-images");
const c2FinalUploadsDir = runtimeConfiguration.c2FinalUploadsDir;
const c2LocalAssetStore = createC2LocalAssetStore({ directory: c2FinalUploadsDir });
let c2UploadInProgress = false;
const distDir = path.join(appDir, "dist");
const apiOnly = runtimeConfiguration.apiOnly;
const port = runtimeConfiguration.port;
const host = runtimeConfiguration.bindHost;
const automationConcurrencyLimit = Math.min(
  DEFAULT_AUTOMATION_CONCURRENCY_LIMIT,
  Math.max(1, Number(process.env.SELECTION_REVIEW_CONCURRENCY_LIMIT || DEFAULT_AUTOMATION_CONCURRENCY_LIMIT))
);
const codexOfflineEnabled = codexOfflineModeFromEnvironment(process.env);
const explicitDispatchDeliveryEnabled = dispatchDeliveryEnabledFromEnvironment(process.env);
const LEGACY_DISPATCH_CHANNEL_DISABLED = "旧派发通道已停用：当前不派发 Codex 任务，历史派发只读。";
const aiGatewayUrl = runtimeConfiguration.aiGatewayUrl;
const aiGatewayDeploymentMode = runtimeConfiguration.deploymentMode;
const allowedReviewOrigins = new Set(runtimeConfiguration.allowedOrigins);
const trustedServiceOrigins = new Set([
  runtimeConfiguration.publicOrigin,
  localHttpOrigin(host, port)
]);
const allowedExtensionOrigins = new Set(runtimeConfiguration.allowedExtensionOrigins);
const internalApiRequestToken = randomBytes(32).toString("base64url");
const businessStateRepository = createConfiguredBusinessStateRepository(runtimeConfiguration);
const c1FinalPlanRevisionUseCase = createC1FinalPlanRevisionUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, serverClock: now });
const c1SiblingColorRevisionUseCase = createC1SiblingColorRevisionUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, serverClock: now });
const c1ColorDictionaryReadUseCase = createC1ColorDictionaryReadUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, serverClock: now,
  readDictionaryValues: request => createOzonDictionaryValuesReader({
    ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl
  })(request) });
const c1ImageTextUseCase = createC1ImageTextUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, assetStore: c2LocalAssetStore, serverClock: now,
  extractor: runtimeConfiguration.c1ImageTextExecutable
    ? createLocalImageTextAdapter({ executablePath: runtimeConfiguration.c1ImageTextExecutable }) : null });
const runtimeIdentityProvider = createConfiguredIdentityProvider({
  configuration: runtimeConfiguration,
  clock: () => new Date().toISOString()
});
await runtimeIdentityProvider.initialize();
const workerRegistry = createLocalDevelopmentWorkerRegistry({ clock: () => new Date().toISOString() });
const softwareJobStore = createRepositoryBackedSoftwareJobStore({
  businessStateRepository,
  serverClock: () => new Date().toISOString(),
  workerRegistry
});
const c1SkuRightsReviewUseCase = createC1SkuRightsReviewUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, serverClock: () => now() });
const c1FactsVerificationUseCase = createC1FactsVerificationUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, serverClock: () => now() });
const c1ContentReviewUseCase = createC1ContentReviewUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, serverClock: () => now() });
let c1EditorialProposalBundle = null;
if (runtimeConfiguration.c1EditorialProposalFile !== null) {
  const proposalFile = await fs.open(runtimeConfiguration.c1EditorialProposalFile, "r");
  try {
    const stat = await proposalFile.stat();
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error("C1_EDITORIAL_PROPOSAL_FILE_INVALID");
    const content = await proposalFile.readFile("utf8");
    if (Buffer.byteLength(content, "utf8") > 2_000_000) throw new Error("C1_EDITORIAL_PROPOSAL_FILE_INVALID");
    try { c1EditorialProposalBundle = JSON.parse(content); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("C1_EDITORIAL_PROPOSAL_FILE_INVALID");
    }
  } finally { await proposalFile.close(); }
}
const c1EditorialReviewUseCase = createC1EditorialReviewUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, serverClock: () => now(), proposalBundle: c1EditorialProposalBundle });
function c1EditorialView(candidate, runtime) {
  const sourceJob = runtime?.softwareJobs?.find(job => job.jobId === candidate.lifecycleV11?.c1AiDraftJobRefV1?.jobId);
  return buildC1EditorialReviewView({ candidate, sourceJob, proposalBundle: c1EditorialProposalBundle, observedAt: now() });
}
// 同一次 1688 采集里已经采到、但当时没搬进冻结快照的供应商属性。免费、不碰价格与身份。
const c1SupplyAttributeBackfillUseCase = createC1SupplyAttributeBackfillUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, serverClock: () => now() });
// 主人把中文事实对到 Ozon 字典的俄文值上。字典查询只读、免费，凭证留在本机证据服务里。
const c1OzonAttributeMappingUseCase = createC1OzonAttributeMappingUseCase({ repository: businessStateRepository,
  runtimeMode: runtimeConfiguration.deploymentMode, serverClock: () => now(),
  // 延迟到真正要查字典时才构造：createOzonDictionaryValueReader 对非本机地址会直接抛，
  // 在模块顶层构造等于让整个评审台起不来（B 阶段那套读取器也是按请求构造，同一个道理）。
  readDictionaryValue: (request) => createOzonDictionaryValueReader({
    ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl
  })(request) });

/** 把错误码翻成主人看得懂、并且说清楚「下一步该干什么」的一句话。 */
function supplyBackfillMessage(code) {
  return {
    C1_SUPPLY_ATTRIBUTE_BACKFILL_CAPTURE_MISSING: "这件商品身上没有留下1688页面的属性采集，先回「找货」重新采一次页面。",
    C1_SUPPLY_ATTRIBUTE_BACKFILL_CAPTURE_MISMATCH: "页面属性来自另一次采集，不能直接补进已冻结的供应快照；请回「找货」重新确认货源。",
    C1_SUPPLY_ATTRIBUTE_BACKFILL_FROZEN_VALUE_CONFLICT: "页面上的属性与已经冻结的那份对不上，没有改动任何数据；请先确认货源页面是否换了。",
    C1_SUPPLY_ATTRIBUTE_BACKFILL_FACTS_ALREADY_FROZEN: "本件商品的C1事实已经冻结，补属性只能在冻结之前做。",
    C1_SUPPLY_ATTRIBUTE_BACKFILL_ALREADY_PRODUCED: "本件商品已经生产授权或上架过，不能再改供应属性。",
    C1_SUPPLY_ATTRIBUTE_BACKFILL_NOTHING_TO_ADD: "页面上没有可以补进来的属性（品牌类字段按无品牌规则不作为商品事实）。",
    C1_SUPPLY_ATTRIBUTE_BACKFILL_PHASE_REJECTED: "只有处于C1的商品可以补齐供应属性。"
  }[code] || "当前商品还不满足补齐供应属性的条件，没有改动任何数据。";
}

/**
 * 计划里所有已确认、非 "unknown" 的字符串事实——中文那一端的全部可选依据。
 *
 * **必须排除 `productAttributes.ozonAttributes`**：那一段是主人上一轮签下的映射
 * 投影出来的事实，值本身就是俄文。2026-09-18 真踩到：第二轮生成建议时把它们也当成
 * 「我们自己的事实」发给模型，6 条里有 5 条绑回了**自己**
 * （材料 = Оксфорд，依据写着 productAttributes.ozonAttributes.0.fact，那正是它上一轮的产出）。
 *
 * 后果不是难看而已：漂移守卫比的是「依据的那条事实值有没有变」，
 * 而事实就是它自己，永远不会变——牛津布改成别的面料也发现不了。
 * 一条映射永远不能由另一条映射的产出来背书。
 */
/**
 * 这两段都是**派生**出来的，不能当映射的依据：
 *  - `ozonAttributes`：上一轮映射的投影，值本身就是俄文；
 *  - `requiredPlatformFields`：必填格，**它也会被映射回填**（见 c1-product-plan.mjs）。
 *
 * 2026-09-18 两次真踩到，第二次换了个形状：型号名称绑到了
 * `productAttributes.requiredPlatformFields.0.fact`——那正是它自己要填的那一格。
 * 第一次我只排了 ozonAttributes，漏了这一段，于是同一个毛病换个地方又长出来。
 * 规矩是：**只有原始事实能当依据**，任何被映射回填过的地方都不行。
 */
const OZON_ATTRIBUTE_SELF_PROJECTION_PREFIXES = Object.freeze([
  "productAttributes.ozonAttributes",
  "productAttributes.requiredPlatformFields"
]);
function collectConfirmedStringFacts(plan) {
  const found = [];
  const visit = (value, path) => {
    if (OZON_ATTRIBUTE_SELF_PROJECTION_PREFIXES.some((prefix) => path.startsWith(prefix))) return;
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}.${index}`));
    if (!value || typeof value !== "object") return;
    if (value.verificationStatus === "confirmed" && Object.hasOwn(value, "value")) {
      if (typeof value.value === "string" && value.value !== "unknown") found.push({ factPath: path, value: value.value });
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
  };
  for (const field of ["exactSkuVerification", "productAttributes", "platformCategory", "schemaSnapshot",
    "batteryAssessment", "categoryRestrictions", "platformCompliance"]) visit(plan[field], field);
  return found;
}

function frozenSchemaRefreshMessage(code) {
  return {
    C1_FROZEN_SCHEMA_REFRESH_FACTS_ALREADY_FROZEN: "本件商品的C1事实已经冻结，重读类目资料只能在冻结之前做。",
    C1_FROZEN_SCHEMA_REFRESH_ALREADY_PRODUCED: "本件商品已经生产授权或上架过，不能再换类目资料。",
    C1_FROZEN_SCHEMA_REFRESH_PHASE_REJECTED: "只有处于C1的商品可以重读类目资料。",
    C1_FROZEN_SCHEMA_REFRESH_SCOPE_MISMATCH: "读回来的是别的类目或别的店铺，没有改动任何数据。",
    C1_FROZEN_SCHEMA_REFRESH_ATTRIBUTES_MISSING: "读回来的类目资料里仍然没有属性表——Ozon只读证据服务还没有升级到带出类目属性的版本。",
    C1_FROZEN_SCHEMA_REFRESH_CURRENT_MISSING: "本件商品还没有冻结的平台类目资料。"
  }[code] || "当前商品还不满足重读类目资料的条件，没有改动任何数据。";
}

function ozonMappingMessage(code, detail = null) {
  const base = {
    C1_OZON_ATTRIBUTE_MAPPING_SCHEMA_ATTRIBUTES_MISSING: "这件商品冻结的Ozon类目资料里没有属性表（它是在证据服务补出类目属性之前读的）；请重新读取一次类目Schema。",
    C1_OZON_ATTRIBUTE_MAPPING_DICTIONARY_VALUE_NOT_FOUND: "Ozon字典里没有逐字相同的这个值，没有拿近似值顶替；请从字典候选里挑一个。",
    C1_OZON_ATTRIBUTE_MAPPING_ATTRIBUTE_NOT_IN_SCHEMA: "这个属性不在当前冻结的类目属性表里。",
    C1_OZON_ATTRIBUTE_MAPPING_SOURCE_FACT_NOT_CONFIRMED: "作为依据的那条商品事实还没有确认，不能凭空给商品安一条属性。",
    C1_OZON_ATTRIBUTE_MAPPING_SELF_REFERENCED_FACT: "这条映射的依据是另一条映射自己产出的结果，等于自己给自己作证；请重新生成一次建议。",
    C1_OZON_ATTRIBUTE_MAPPING_FACTS_ALREADY_FROZEN: "本件商品的C1事实已经冻结，属性映射只能在冻结之前做。",
    C1_OZON_ATTRIBUTE_MAPPING_ALREADY_PRODUCED: "本件商品已经生产授权或上架过，不能再改属性映射。",
    C1_OZON_ATTRIBUTE_MAPPING_DUPLICATE_ATTRIBUTE: "同一个属性只能映射一次。",
    C1_OZON_ATTRIBUTE_MAPPING_RIGHTS_NOT_VERIFIED: "本件商品的品牌与权利声明还没有通过，请先处理那一步。",
    C1_OZON_ATTRIBUTE_MAPPING_PHASE_REJECTED: "只有处于C1的商品可以映射Ozon属性。"
  }[code] || "当前商品还不满足保存属性映射的条件，没有改动任何数据。";
  return detail ? `${base}（${detail}）` : base;
}
// Register only explicitly configured capabilities. Construction starts no work.
const bExactCommissionRecalculation = createBExactCommissionRecalculationUseCase({
  repository: businessStateRepository, runtimeMode: runtimeConfiguration.deploymentMode, serverClock: now
});
const finalPricingReviewUseCase = createFinalPricingReviewUseCase({
  repository: businessStateRepository, runtimeMode: runtimeConfiguration.deploymentMode, serverClock: now
});
const c1DraftRuntimeServices = createC1DraftRuntimeServices({
  repository: businessStateRepository, runtimeMode: runtimeConfiguration.deploymentMode,
  serverClock: () => now(), workerRegistry,
  serviceBindings: runtimeConfiguration.c1DraftServiceBindings
});
const keywordEvidenceRuntimeServices = createKeywordEvidenceRuntimeServices({
  repository: businessStateRepository, softwareJobStore, runtimeMode: runtimeConfiguration.deploymentMode,
  serverClock: now, workerRegistry, serviceBindings: runtimeConfiguration.keywordEvidenceServiceBindings,
  createTransport: ({ binding, beforeRequestSend, signal }) => createSeerfarRuntimeTransport({
    timeoutMs: binding.requestTimeoutMs, beforeRequestSend, signal
  }),
  onEvidenceReady: (candidateId, revision) => continueC1SoftwareWhenEvidenceReady(candidateId, revision, { reportConfigurationBlock: true }),
  onError: () => { console.error("C1_KEYWORD_RUNTIME_STOPPED: 关键词服务因异常停止，请核对已保存作业。"); }
});
const aDiscoveryCandidateImport = createADiscoveryCandidateImportUseCase({repository:businessStateRepository,
  serverClock:now,storeBindings:runtimeConfiguration.storeBindings});
const aDiscoveryRuntime = createADiscoveryRuntimeServices({repository:businessStateRepository,softwareJobStore,
  runtimeMode:runtimeConfiguration.deploymentMode,serverClock:now,workerRegistry,
  serviceBindings:runtimeConfiguration.aDiscoveryServiceBindings,connectorBindings:runtimeConfiguration.aDiscoveryConnectorBindings,
  plans:runtimeConfiguration.aDiscoveryPlans,getEvidenceRecords:()=>runtimeConfiguration.aDiscoveryEvidenceRecords,
  readSecret:(runtimeConfiguration.aDiscoveryConnectorBindings[0]?.provider==='seerfar' ? createSeerfarDiscoverySecretReader : createLinkfoxDiscoverySecretReader)({bindings:runtimeConfiguration.aDiscoveryCredentialBindings,runtimeMode:runtimeConfiguration.deploymentMode}),
  fetchImpl:fetch,onBatchReady:input=>aDiscoveryCandidateImport.importBatch(input),onSelectProduct:input=>aDiscoveryCandidateImport.importSelectedProduct(input),
  onError:()=>{console.error('A_DISCOVERY_RUNTIME_STOPPED: 商品发现服务因异常停止，请核对已保存的批次和作业。');}
});
/** Display-only Chinese titles for discovered products; the gateway holds its own credentials, so none are passed here. */
const aDiscoveryTitleTranslationUseCase = (() => {
  const gatewayUrl = typeof runtimeConfiguration.aiGatewayUrl === 'string' ? runtimeConfiguration.aiGatewayUrl.trim() : '';
  if (gatewayUrl === '') return null;
  try {
    return createADiscoveryTitleTranslationUseCase({repository:businessStateRepository,serverClock:now,
      translator:createDiscoveryTitleTranslator({gatewayUrl,fetchImpl:fetch,now,
        gatewayDeploymentMode:runtimeConfiguration.deploymentMode})});
  } catch { return null; }
})();
/**
 * A-stage purchase-ceiling estimate for discovered products. Commission, FX and freight all come from the same official
 * readers the B stage uses; an input that is not configured becomes a recorded gap instead of a guessed number.
 * Packaging is the one declared assumption: 3 RMB per parcel (override with SELECTION_REVIEW_A_ESTIMATE_PACKAGING_RMB).
 * It is stamped into every saved estimate record as `assumed: true`.
 *
 * Since 2026-09-15 this value applies to the DISCOVERY BATCH estimate only. That path screens whole batches of market
 * products before any of them is a candidate, so there is no product to ask and no owner declaration to read; the
 * ceiling it produces is a filter, not a number anyone signs. Every figure shown for ONE product — 找货, 选定, 算利润 —
 * now uses that product's own declared 每单额外操作费 instead (`extraHandlingFeeAssumptions`), because the owner was
 * being shown a profit worked out at ¥3 and then asked to sign one worked out at this product's own cost.
 */
const A_ESTIMATE_PACKAGING_RMB = (() => {
  const raw = String(process.env.SELECTION_REVIEW_A_ESTIMATE_PACKAGING_RMB ?? "").trim();
  return raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 3;
})();
const aEstimateReaders = {
  commission:input=>readOzonCommissionReference(input),
  // The whole official rate ladder for one type, so pricing guidance can answer "what would another price earn"
  // without ever copying the 1500/5000 RUB band edges out of the official table.
  commissionTiers:input=>readOzonCommissionReferenceTiers(input),
  fx:input=>readCurrentCbrExchangeRate({...input,fetchImpl:fetch,
    ...(process.env.SELECTION_REVIEW_CBR_FX_URL?{sourceUrl:process.env.SELECTION_REVIEW_CBR_FX_URL}:{})}),
  tariff:input=>readGuooTariffCatalog(input)
};
const aEstimateConfiguration = {
  ozonCommissionReference:runtimeConfiguration.ozonCommissionReference,
  guooTariffFile:runtimeConfiguration.guooTariffFile,
  packagingRmbDefault:A_ESTIMATE_PACKAGING_RMB
};
const aDiscoveryEstimateUseCase = createADiscoveryEstimateUseCase({
  repository:businessStateRepository,serverClock:now,rules:DEFAULT_RULES,
  readers:aEstimateReaders,configuration:aEstimateConfiguration
});
/** The owner's 找货 draft is priced with exactly the same official inputs as the discovery batch estimate. */
const supplierDraftEstimateInputs = createADiscoveryEstimateInputs({
  rules:DEFAULT_RULES,readers:aEstimateReaders,configuration:aEstimateConfiguration
});
/** The extension version every plugin job requires; declared before the Seerfar round service, which reads it at startup. */
const REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION = "1.4.1";
/**
 * Seerfar 自动选品方案 B（主人 2026-10-10 定）：会员前台「热销榜单选品」一页结果 → 固定规则筛 → 前几个收成待核验候选。
 * 档案和季节日历是 data/seerfar-selection/ 里的版本化配置；读不出来时不启动任何一轮，页面照实显示原因。
 */
const seerfarSelectionConfig = await loadSeerfarSelectionConfig().then(config => ({ config, error: null }),
  error => ({ config: null, error: String(error?.code || 'CONFIG_UNREADABLE') }));
const seerfarWebRounds = createSeerfarWebRoundService({
  readData: () => readData(), mutateData: mutator => mutateData(mutator), mutateDataWhenChanged: mutator => mutateDataWhenChanged(mutator),
  now: () => now(), businessDate: () => businessDate(), estimateInputs: supplierDraftEstimateInputs, storeBindings: runtimeConfiguration.storeBindings,
  config: seerfarSelectionConfig.config, configError: seerfarSelectionConfig.error, requiredExtensionVersion: REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION,
  isCaptureControlBusy: () => captureControlSnapshot().status === "busy",
  log: (message, error) => console.error(message, error)
});
// 本店爆款从销量数据里挑（主人 2026-10-10）：本机只读 Seller API，复用账户读取已声明的店铺与钥匙串绑定。
const storeSalesSeeds = createStoreSalesSeedService({
  readData: () => readData(), mutateData: mutator => mutateData(mutator), mutateDataWhenChanged: mutator => mutateDataWhenChanged(mutator),
  now: () => now(), businessDate: () => businessDate(), estimateInputs: supplierDraftEstimateInputs, config: seerfarSelectionConfig.config,
  reader: createOzonStoreSalesReader({ runtimeMode: runtimeConfiguration.deploymentMode, fetchImpl: fetch,
    routes: storeSalesRoutes({ discoveryBindings: runtimeConfiguration.ozonAccountDiscoveryBindings,
      credentialBindings: runtimeConfiguration.ozonDECredentialBindings, productionBindings: runtimeConfiguration.productionBindings }) }),
  log: (message, detail) => console.error(message, detail)
});
/** Rounds, store sales and the home to-dos derived from both, in one payload. */
function seerfarSelectionView(document, operationResult = null) {
  const rounds = seerfarWebRounds.view(document);
  const storeSales = storeSalesSeeds.view(document);
  return { ...rounds, storeSales, todos: seerfarTodos({ rounds: rounds.rounds, storeSales, businessDate: rounds.businessDate }), operationResult };
}
// ── 「做这件」确认卡（关口 1）：软件先选同款和货源、粗算、品牌提示；做 / 不做 / 利润没过线之后怎么办。逻辑在 lib/gate1-*.mjs。
import { createGate1Service } from './lib/gate1-service.mjs';
import { Gate1Error, applyGate1Shortfall } from './lib/gate1-decision.mjs';
import { recordSkipReason } from './lib/store-profile.mjs';
const gate1Service = createGate1Service({
  readData: () => readData(), mutateData: mutator => mutateData(mutator), now: () => now(), estimateInputs: supplierDraftEstimateInputs,
  readDiscoveryMarketRecord, recordSkipReason, storeProfileConfig: seerfarSelectionConfig.config,
  addHistory: (...args) => addHistory(...args), publicCandidate: (candidate, rules) => publicCandidate(candidate, rules),
  assertSafeCandidate: candidate => assertSafeBusinessMutationCandidate(candidate, "businessMutation.candidate"),
  supplierDraftEstimate: (document, candidate, draft) => supplierDraftEstimate(document, candidate, draft)
});
async function gate1Route(req, res, pathname) {
  const route = pathname.match(/^\/api\/candidates\/([^/]+)\/gate1\/(accept|skip|shortfall)$/);
  if (req.method !== "POST" || !route) return false;
  const actor = runtimeIdentityProvider.resolveActor({ request: req });
  if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
    throw httpError(403, "请先登录主人身份后再决定做不做这件。", { code: "gate1_owner_required" });
  }
  const input = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
  try {
    const candidateId = decodeURIComponent(route[1]);
    const result = await gate1Service[route[2]]({ candidateId, input, actor });
    // 做这件之后页面紧接着申请采集这家货源，要的就是刚存下的找货方案和市场快照，所以连同找货视图一起回。
    let draftView = null;
    if (route[2] === "accept") {
      const document = await readData();
      const saved = document.candidates.find(item => item.id === candidateId);
      draftView = saved ? await supplierDraftView(document, saved) : null;
    }
    json(res, 200, { ...(draftView ?? {}), ...result, dispatch: null });
    return true;
  } catch (error) {
    if (error instanceof Gate1Error) throw httpError(error.status, error.message, { code: error.code, ...error.details });
    if (error instanceof StoreProfileError) throw httpError(error.status, error.publicMessage, { code: `store_profile_${error.code.toLowerCase()}` });
    throw error;
  }
}
// ── 「做这件」确认卡 end
const aProductDetailApplication = createAProductDetailApplicationUseCase({repository:businessStateRepository,serverClock:now});
const aProductDetailRuntime = createAProductDetailRuntimeServices({repository:businessStateRepository,softwareJobStore,
  runtimeMode:runtimeConfiguration.deploymentMode,serverClock:now,workerRegistry,
  serviceBindings:runtimeConfiguration.aProductDetailServiceBindings,connectorBindings:runtimeConfiguration.aProductDetailConnectorBindings,
  readSecret:createLinkfoxDiscoverySecretReader({bindings:runtimeConfiguration.aProductDetailCredentialBindings,runtimeMode:runtimeConfiguration.deploymentMode}),
  fetchImpl:fetch,onDetailsReady:input=>aProductDetailApplication.applyDetails(input),
  onError:()=>{console.error('A_PRODUCT_DETAIL_RUNTIME_STOPPED: 商品详情服务因异常停止，请核对已保存的作业和回执。');}
});
const eReadbackSoftwareRuntime = createSystemEReadbackSoftwareRuntime({
  repository: businessStateRepository, runtimeMode: runtimeConfiguration.deploymentMode,
  serverClock: now, readPlatform: null
});
const ozonDETransport = createOzonDEHttpTransport({ productionBindings: runtimeConfiguration.productionBindings,
  discoveryBindings: runtimeConfiguration.ozonAccountDiscoveryBindings,
  credentialBindings: runtimeConfiguration.ozonDECredentialBindings, runtimeMode: runtimeConfiguration.deploymentMode });
const ossRuntimeProvider = createAliyunOssRuntimeProvider({ config: runtimeConfiguration.ossRuntimeConfiguration,
  localAssetStore: c2LocalAssetStore, now });
const ozonAccountEvidenceSource = createOzonAccountReadEvidenceSource({ repository: businessStateRepository,
  loadCurrentReadBinding: createOzonAccountReadBindingResolver(runtimeConfiguration),
  protocolCatalog: await loadOzonDEProtocolCatalog() });
let batchLimitEvidencePromise = null;
const loadBatchLimitEvidence = () => {
  batchLimitEvidencePromise ??= loadOzonProductImportBatchLimitEvidence();
  return batchLimitEvidencePromise;
};
const ozonDEPreflightProvider = createOzonDEPreflightProvider({ serverClock: now,
  verifySourceSnapshot: ozonAccountEvidenceSource.verifySnapshot,
  loadBatchLimitEvidence,
  readEvidence: createRepositoryBackedOzonDEPreflightEvidenceReader({ repository: businessStateRepository,
    verifySourceReceipt: ozonAccountEvidenceSource.verifySourceReceipt }) });
// 查询策略解析器只构造一次，D 运行时与账户读取服务（按钮）共用，避免两处读法不一致。
const dPlatformObservationPolicyResolver = createDPlatformObservationPolicyResolver(runtimeConfiguration);

const deRuntimeServices = createDEProductionRuntimeServices({
  repository: businessStateRepository, runtimeMode: runtimeConfiguration.deploymentMode,
  serverClock: now, workerRegistry, deServiceBindings: runtimeConfiguration.deServiceBindings,
  productionBindings: runtimeConfiguration.productionBindings,
  requestJson: runtimeConfiguration.ozonDECredentialBindings.length > 0 ? ozonDETransport.requestJson : null,
  inspectPlatform: ozonDEPreflightProvider.inspectPlatform,
  loadAdapterCapabilities: ozonDEPreflightProvider.loadAdapterCapabilities,
  loadBatchMemberEvidence: ozonDEPreflightProvider.loadBatchMemberEvidence,
  loadBatchEReadEvidence: ozonDEPreflightProvider.loadBatchEReadEvidence,
  preflightRequestMode: "persisted_evidence_only",
  upload: ossRuntimeProvider.upload, resolveLocalAsset: ossRuntimeProvider.resolveLocalAsset,
  loadCurrentProductionBinding: currentProductionBinding,
  loadDPlatformObservationPolicy: dPlatformObservationPolicyResolver,
  verifyInventoryPrerequisiteSource: ozonDEPreflightProvider.verifyInventoryPrerequisiteSource,
  observationPumpIntervalMs: runtimeConfiguration.dPlatformObservation.pumpIntervalMs,
  eReadbackPumpIntervalMs: runtimeConfiguration.eReadbackPumpIntervalMs,
  onReadbackError: () => { console.error("E_READBACK_RUNTIME_STOPPED: 独立回读服务因异常停止，请核对已保存作业。"); },
  onObservationError: () => { console.error('D_OBSERVATION_RUNTIME_STOPPED: 状态查询服务因异常停止，请核对已保存作业。'); }
});
const ozonAccountDiscovery = createConfiguredOzonAccountDiscoveryRuntime({configuration:runtimeConfiguration,
  repository:businessStateRepository,workerRegistry,serverClock:now,requestJson:ozonDETransport.requestJson});
const ozonAccountReadServices = createOzonAccountReadServices({ configuration: runtimeConfiguration,
  repository: businessStateRepository, workerRegistry, serverClock: now, requestJson: ozonDETransport.requestJson,
  evidenceSource: ozonAccountEvidenceSource, preflightProvider: ozonDEPreflightProvider, deRuntimeServices,
  // 与 D 运行时同一个解析器：按钮和执行层必须看同一份查询策略。
  loadDPlatformObservationPolicy: dPlatformObservationPolicyResolver });
const dProductionRoundUseCase = createDProductionRoundUseCase({ repository: businessStateRepository, serverClock: now });
const productionAuthorizationRollbackUseCase = createProductionAuthorizationRollbackUseCase({ repository: businessStateRepository, serverClock: now });
const dInitialImportRecoveryUseCase = createDInitialImportRecoveryUseCase({ repository: businessStateRepository,
  serverClock: now, loadDPlatformObservationPolicy: dPlatformObservationPolicyResolver, jobStore: softwareJobStore });
// 与恢复用例同一接线：同一个策略解析器实例、同一个作业仓库。
const dUnknownOutcomeReobservationUseCase = createDUnknownOutcomeReobservationUseCase({ repository: businessStateRepository,
  serverClock: now, loadDPlatformObservationPolicy: dPlatformObservationPolicyResolver, jobStore: softwareJobStore });
const dPlatformStateReconciliationUseCase = createDPlatformStateReconciliationUseCase({ repository: businessStateRepository,
  serverClock: now, loadDPlatformObservationPolicy: dPlatformObservationPolicyResolver, jobStore: softwareJobStore });
const runtimeArchitecture = assertRuntimeBoundaries({
  configuration: runtimeConfiguration,
  businessStateRepository,
  identityProvider: runtimeIdentityProvider,
  softwareJobStore,
  workerRegistry,
  legacyBusinessMutationPathsPresent: true
});
const dispatchSkillCatalog = createDispatchSkillCatalog({
  directory: process.env.SELECTION_REVIEW_DISPATCH_SKILLS_DIR
});
// Historical fire-train adapters are retained for audit/unit tests only.
// They must never be re-enabled from the production review-app runtime.
const legacyManualC1InputEnabled = process.env.SELECTION_REVIEW_LEGACY_MANUAL_C1_INPUT === "true";
const seerfarSoftwareExecutionEnabled = false;
const c1PaidKeywordGenericQueueEnabled = true;

/** Where an owner-eliminated product may be put back: every queue except the eliminated one it is leaving. */
const OWNER_RESTORABLE_STATUSES = Object.freeze([
  "awaiting_user_direction", "codex_processing", "needs_user_data", "listing_preparation", "ready_to_list", "listed"
]);

const USER_FIELDS = [
  "targetStore",
  "productUrl",
  "productName",
  "sourceUrl",
  "competitorUrl",
  "purchasePriceRmb",
  "packagingCostRmb",
  "moq",
  "netWeightKg",
  "packedWeightKg",
  "dimensionsCm",
  "materialsAndAge",
  "powered",
  "complianceStatus",
  "authorizationStatus",
  "expectedPriceRub",
  "sellerRevenueCny",
  "imageUrl",
  "notes",
  "acceptedTestRisk"
];

const RECOVERY_POLICY_VERSION = "system-owned-recovery-v1-2026-08-11";
const RECOVERY_ACTION_LABELS = {
  allow_estimated_commission: "允许本SKU使用估算佣金并继续",
  retry_current_stage_once: "重试当前阶段一次",
  keep_stopped: "保持停止，等待精确证据"
};

const DEFAULTED_USER_FIELDS = new Set([
  "domesticShippingRmb",
  "packagingCostRmb",
  "complianceStatus",
  "authorizationStatus"
]);

const sourceCaptureSessions = new Map();
const salesCaptureSessions = new Map();
const imageMatchSessions = new Map();
const sourceCaptureJobTimers = new Map();
const dispatchDeliveriesInFlight = new Set();
// Only dispatches actually admitted by this process can represent current maintenance.
const currentMaintenanceDispatchIds = new Set();

function activeDispatchForCandidate(data, candidateId) {
  return selectCurrentDispatch(data, candidateId, { activeDispatchIds: currentMaintenanceDispatchIds });
}
const SOURCE_CAPTURE_TTL_MS = 3 * 60 * 1000;
const SOURCE_CAPTURE_JOB_QUEUE_TTL_MS = Math.max(50, Number(process.env.SELECTION_REVIEW_SOURCE_JOB_QUEUE_TTL_MS || 2 * 60 * 1000));
const SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS = Math.max(50, Number(process.env.SELECTION_REVIEW_SOURCE_JOB_EXECUTION_TTL_MS || 60 * 1000));
/** Marks a sales-capture session that is a leased, claimable page-read job rather than a bare legacy session. */
const OZON_PAGE_READ_CAPTURE_KIND = "ozon_page_read";
/** Marks a 1688 image search started from a first picture (Pinduoduo, 1688 or Ozon). */
const SUPPLIER_IMAGE_MATCH_CAPTURE_KIND = "supplier_image_match";
/** Marks an Ozon text search whose results are compared against the same first picture. */
const OZON_IMAGE_MATCH_CAPTURE_KIND = "ozon_image_match";
const EXTENSION_HEARTBEAT_TTL_MS = 75 * 1000;
let latestExtensionHeartbeat = null;
let sourceCaptureJobClaimQueue = Promise.resolve();

function extensionHeartbeatSnapshot(timestamp = Date.now()) {
  if (!latestExtensionHeartbeat) {
    return {
      status: "not_seen",
      fresh: false,
      version: "",
      backgroundReady: false,
      observedAt: null,
      receivedAt: null,
      expiresAt: null
    };
  }
  const fresh = latestExtensionHeartbeat.receivedAtMs + EXTENSION_HEARTBEAT_TTL_MS > timestamp;
  return {
    status: fresh
      ? latestExtensionHeartbeat.backgroundReady ? "connected" : "background_unavailable"
      : "stale",
    fresh,
    version: latestExtensionHeartbeat.version,
    backgroundReady: latestExtensionHeartbeat.backgroundReady,
    observedAt: latestExtensionHeartbeat.observedAt,
    receivedAt: new Date(latestExtensionHeartbeat.receivedAtMs).toISOString(),
    expiresAt: new Date(latestExtensionHeartbeat.receivedAtMs + EXTENSION_HEARTBEAT_TTL_MS).toISOString()
  };
}

function purgeExpiredCaptureSessions(timestamp = Date.now()) {
  for (const sessions of [sourceCaptureSessions, salesCaptureSessions, imageMatchSessions]) {
    for (const [id, session] of sessions.entries()) {
      // A job-backed session is closed by its own lease timer, which is the only thing that also writes the candidate's
      // record. Dropping it here first would leave that record at waiting_extension with nothing left to close it —
      // exactly the "永远卡住" record this project has already paid for twice. 1688 sessions keep the test they had;
      // an Ozon page-read session (captureKind, never set on a 1688 session) gets the same protection.
      if (session.mode === "a_supplier_capture" && session.jobStatus) continue;
      if (session.captureKind === OZON_PAGE_READ_CAPTURE_KIND && session.jobStatus) continue;
      if ([SUPPLIER_IMAGE_MATCH_CAPTURE_KIND, OZON_IMAGE_MATCH_CAPTURE_KIND].includes(session.captureKind) && session.jobStatus) continue;
      if (session.expiresAt <= timestamp || session.consumedAt) sessions.delete(id);
    }
  }
}

function captureControlSnapshot(timestamp = Date.now()) {
  purgeExpiredCaptureSessions(timestamp);
  const active = [
    ...[...sourceCaptureSessions.values()].map((session) => ({ ...session, platform: "1688", captureKind: "supplier" })),
    ...[...salesCaptureSessions.values()].map((session) => ({ ...session, platform: "ozon", captureKind: "sales" })),
    ...[...imageMatchSessions.values()].map((session) => ({ ...session, platform: session.matchKind === "ozon" ? "ozon" : "1688",
      captureKind: session.matchKind === "ozon" ? "ozon_image_match" : "image_match" })),
    ...[seerfarWebRounds.activeSession()].filter(Boolean).map((session) => ({ ...session, candidateId: "Seerfar 榜单", platform: "seerfar", captureKind: "seerfar_web" }))
  ].sort((left, right) => left.createdAt - right.createdAt)[0];
  if (!active) {
    return {
      status: "idle",
      label: "商品采集控制空闲",
      candidateId: null,
      captureId: null,
      platform: null,
      captureKind: null,
      startedAt: null,
      expiresAt: null
    };
  }
  return {
    status: "busy",
    label: `商品采集控制已由 ${active.candidateId} 占用（${active.platform}）`,
    candidateId: active.candidateId,
    captureId: active.captureId,
    platform: active.platform,
    captureKind: active.captureKind,
    startedAt: active.jobStatus === "claimed" && Number.isFinite(active.claimedAt)
      ? new Date(active.claimedAt).toISOString() : null,
    expiresAt: new Date(active.expiresAt).toISOString()
  };
}

function ensureCaptureControlAvailable(candidateId) {
  const control = captureControlSnapshot();
  if (control.status !== "busy") return;
  throw httpError(409, `商品采集控制正由 ${control.candidateId} 使用；本次没有启动，也不会排队或自动重试`, {
    captureControl: control
  });
}

function currentProfitRule(persisted, current) {
  return {
    ...current,
    ...(persisted || {}),
    pricingPolicyVersion: current.pricingPolicyVersion,
    advertisingReserveRate: 0,
    advertisingReserveScenarios: undefined,
    decisionAdvertisingScenario: undefined,
    stressAdvertisingScenario: undefined,
    promotionDiscountScenarios: current.promotionDiscountScenarios,
    decisionPromotionScenario: current.decisionPromotionScenario,
    targetMarginRate: current.targetMarginRate,
    minimumUnitProfitRmb: current.minimumUnitProfitRmb,
    priceRoundRmb: current.priceRoundRmb,
    labelCostRmb: current.labelCostRmb,
    damageLossReserveRate: current.damageLossReserveRate,
    withdrawalFeeRate: current.withdrawalFeeRate,
    thresholdPolicy: "either",
    note: current.note
  };
}


function now() {
  return new Date().toISOString();
}

function fixedRecoveryDecision(kind, summary, actions) {
  return {
    kind,
    summary: String(summary || "").trim(),
    actions: actions.map((id) => ({ id, label: RECOVERY_ACTION_LABELS[id] })),
    policyVersion: RECOVERY_POLICY_VERSION
  };
}

function recoveryText(candidate, dispatch) {
  return [
    candidate.processing?.blockReason,
    candidate.processing?.lastError,
    dispatch?.agentReply,
    dispatch?.error
  ].filter(Boolean).join("\n");
}

function classifyStoppedCandidate(candidate, dispatch) {
  const missing = requiredInputFields(candidate);
  if (missing.length) {
    return {
      kind: "needs_data",
      missing,
      summary: `缺少可填写的B阶段资料：${missing.map((item) => item.label).join("、")}`
    };
  }
  const text = recoveryText(candidate, dispatch);
  if (
    dispatch?.status === "needs_decision" &&
    /估算佣金|佣金.*授权|允许.*佣金/.test(text) &&
    candidate.acceptedEstimatedCommission !== true
  ) {
    return {
      kind: "business_decision",
      summary: "当前精确佣金尚未取得，需要决定是否允许本SKU使用清楚标注的估算佣金。"
    };
  }
  const systemOwned =
    dispatch?.nodeId === "M12" ||
    dispatch?.failureLayer === "missing_business_readback" ||
    (dispatch?.failureLayer === "codex_app_server" && /active writer|正在处理|busy/i.test(text)) ||
    candidate.processing?.dispatchState === "normalized" ||
    /当前派发节点是M04|只做C阶段|项目长期规则也要求C阶段|评审台本地服务.*无法连接|无法调用.*complete/.test(text) ||
    (!dispatch && /1688|Chrome|浏览器/.test(text));
  if (systemOwned || !dispatch) {
    return {
      kind: "system_recovery",
      summary: "系统旧路由、回传或阶段状态有误；按当前B阶段规则自动纠正并继续。"
    };
  }
  return {
    kind: "external_failure",
    summary: text || "当前阶段发生一次真实技术失败，已停止自动重试。"
  };
}

function json(res, status, responseBody, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(responseBody));
}

async function requestBody(req) {
  return readJsonRequestBody(req, { maxBytes: 2_000_000, requireJsonContentType: true });
}

async function requestBinaryBody(req, maxBytes = 100 * 1024 * 1024) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw httpError(413, "最终素材文件过大");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw httpError(413, "最终素材文件过大");
    chunks.push(chunk);
  }
  if (bytes === 0) throw httpError(400, "最终素材文件为空");
  return Buffer.concat(chunks, bytes);
}

async function verifyAndAuthorizeStagedC2Assets({ candidate, dataRevision, draftRevision, assets }) {
  const { draft } = assertCurrentC2UploadDraft(candidate, { dataRevision, draftRevision });
  const selections = draft?.selection;
  if (!Array.isArray(assets) || !selections?.length || assets.length !== selections.length ||
      assets.some((asset, index) => !asset || Object.keys(asset).some(key => !["assetId", "order"].includes(key)) ||
        asset.assetId !== selections[index].assetId || asset.order !== selections[index].order)) {
    throw httpError(409, "确认内容必须与已保存的素材和顺序完全一致", { code: "c2_upload_selection_changed" });
  }
  const verified = [];
  for (const [index, asset] of selectedC2DraftAssets(draft).entries()) {
    await c2LocalAssetStore.read(asset, { verifyContent: true });
    const item = {};
    for (const key of ["assetId", "mediaType", "assetRef", "fileName", "assetVersion", "sha256", "byteSize", "sourceEvidenceRef", "stableUrlEvidenceRef", "sourceType", "width", "height", "order"]) {
      if (asset[key] !== undefined) item[key] = structuredClone(asset[key]);
    }
    // 主人排第一张的就是主图，软件不重排也不改选。
    verified.push({ ...item, role: index === 0 ? "main_image" : "gallery_image", addedAt: asset.stagedAt,
      usageAuthorization: { status: "owner_authorized_for_listing", evidenceRef: `owner-confirmation:c2:${candidate.id}:${dataRevision}` }
    });
  }
  return verified;
}

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

function respondWithError(req, res, error) {
  const normalized = normalizeHttpErrorResponse(error);
  if (normalized.shouldLogStack) console.error(error);
  return json(res, normalized.status, normalized.body, chromeExtensionCors(req));
}

function localHttpOrigin(bindHost, listenPort) {
  const normalizedHost = String(bindHost || "").trim();
  const originHost = normalizedHost.includes(":") && !normalizedHost.startsWith("[")
    ? `[${normalizedHost}]`
    : normalizedHost;
  return `http://${originHost}:${listenPort}`;
}

function chromeExtensionCors(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!allowedExtensionOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function assertClaimedCaptureResultOrigin(session, req, label) {
  const origin = String(req.headers.origin || "").trim();
  if (!session?.claimedExtensionOrigin) {
    throw httpError(409, `${label}作业尚未由插件后台原子领取，不能回传结果`, { code: "capture_job_not_claimed" });
  }
  if (session?.claimedExtensionOrigin && session.claimedExtensionOrigin !== origin) {
    throw httpError(409, `${label}回传来源与领取来源不一致`, { code: "capture_extension_origin_mismatch" });
  }
}

function recordExtensionHeartbeat(input) {
  const version = String(input.version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw httpError(400, "插件心跳版本无效");
  if (typeof input.backgroundReady !== "boolean") throw httpError(400, "插件心跳缺少后台状态");
  const observedAt = input.observedAt ? new Date(input.observedAt) : new Date();
  if (Number.isNaN(observedAt.getTime())) throw httpError(400, "插件心跳时间无效");
  latestExtensionHeartbeat = {
    version,
    backgroundReady: input.backgroundReady,
    observedAt: observedAt.toISOString(),
    receivedAtMs: Date.now()
  };
  return extensionHeartbeatSnapshot();
}

function validCaptureToken(expected, provided) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(provided || ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function captureSession(candidateId, captureId = "") {
  purgeExpiredCaptureSessions();
  if (captureId) return sourceCaptureSessions.get(captureId) || null;
  return [...sourceCaptureSessions.values()].find((session) => session.candidateId === candidateId) || null;
}

function currentSourceCaptureForCandidate(candidate) {
  const capture = candidate.sourceCapture;
  const session = sourceCaptureSessions.get(capture?.captureId);
  const observedAt = Date.now();
  if (!session || session.jobStatus !== "claimed" || session.attempt !== 1 ||
      session.candidateId !== candidate.id || session.dataRevision !== candidate.dataRevision ||
      capture.status !== "capturing" || capture.jobStatus !== "claimed" || capture.attempt !== 1 ||
      !Number.isFinite(session.claimedAt) || !Number.isFinite(session.expiresAt) ||
      session.claimedAt > observedAt || session.expiresAt <= observedAt || session.claimedAt >= session.expiresAt ||
      Date.parse(capture.claimedAt) !== session.claimedAt) return null;
  return {
    currentExecutionConfirmed: true, candidateId: candidate.id, candidateRevision: candidate.dataRevision,
    captureId: session.captureId, claimedAt: new Date(session.claimedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString()
  };
}

function captureSessionPublic(session) {
  return {
    captureId: session.captureId,
    candidateId: session.candidateId,
    dataRevision: session.dataRevision,
    expectedOfferId: session.expectedOfferId,
    sourceUrl: session.sourceUrl,
    originalSourceUrl: session.originalSourceUrl,
    mode: session.mode,
    expiresAt: new Date(session.expiresAt).toISOString(),
    extensionRequest: {
      captureId: session.captureId,
      candidateId: session.candidateId,
      dataRevision: session.dataRevision,
      expectedOfferId: session.expectedOfferId,
      sourceUrl: session.sourceUrl,
      mode: session.mode,
      allowShortLinkResolution: session.mode === "a_supplier_capture" && !session.expectedOfferId
    }
  };
}

function sourceCaptureJobPublic(session) {
  return {
    jobId: session.captureId,
    candidateId: session.candidateId,
    requestRevision: session.requestRevision,
    dataRevision: session.dataRevision,
    mode: session.mode,
    sourceUrl: session.sourceUrl,
    expectedOfferId: session.expectedOfferId,
    status: session.jobStatus,
    attempt: session.attempt,
    requiredExtensionVersion: session.requiredExtensionVersion,
    createdAt: new Date(session.createdAt).toISOString(),
    claimedAt: session.claimedAt ? new Date(session.claimedAt).toISOString() : null,
    expiresAt: new Date(session.expiresAt).toISOString()
  };
}

function sourceCaptureJobPayload(session) {
  return {
    captureId: session.captureId,
    jobId: session.captureId,
    candidateId: session.candidateId,
    dataRevision: session.dataRevision,
    expectedOfferId: session.expectedOfferId,
    sourceUrl: session.sourceUrl,
    mode: session.mode,
    allowShortLinkResolution: !session.expectedOfferId,
    requiredExtensionVersion: session.requiredExtensionVersion,
    attempt: session.attempt,
    token: session.token
  };
}

function clearSourceCaptureJobTimer(captureId) {
  const timer = sourceCaptureJobTimers.get(captureId);
  if (timer) clearTimeout(timer);
  sourceCaptureJobTimers.delete(captureId);
}

async function expireSourceCaptureJob(captureId, expectedStatus) {
  const session = sourceCaptureSessions.get(captureId);
  if (!session || session.jobStatus !== expectedStatus || session.consumedAt) return;
  const failureCode = expectedStatus === "claimed" ? "unknown_outcome" : "extension_job_unclaimed";
  await mutateDataWhenChanged((data) => {
    const current = data.candidates.find((item) => item.id === session.candidateId);
    // The captureId is what identifies the record this job owns; a newer capture replaced it and is protected by that
    // test alone. Also demanding an unchanged dataRevision made any unrelated edit during the wait — saving 找货资料,
    // for example — abandon the closure, leaving the candidate at waiting_extension for good and, through the
    // previous_capture_requires_review guard, refusing every later capture request (owner, blocked 2026-09-11).
    if (!current || current.sourceCapture?.captureId !== captureId) return { changed: false };
    markSourceCaptureFailure(current, session, failureCode, expectedStatus === "claimed"
      ? "插件已领取一次，但在执行期限内没有回传可验证结果"
      : "插件在作业等待期限内没有领取本候选");
    return { changed: true };
  });
  session.jobStatus = failureCode;
  session.consumedAt = Date.now();
  clearSourceCaptureJobTimer(captureId);
  sourceCaptureSessions.delete(captureId);
}

function scheduleSourceCaptureJobExpiry(session, expectedStatus, timeoutMs) {
  clearSourceCaptureJobTimer(session.captureId);
  const timer = setTimeout(() => {
    void expireSourceCaptureJob(session.captureId, expectedStatus).catch((error) => {
      console.error("1688采集作业超时收口失败", error);
    });
  }, timeoutMs);
  timer.unref?.();
  sourceCaptureJobTimers.set(session.captureId, timer);
}

/** A capture record whose session this process does not hold: no result can ever arrive for it any more. */
const RESTART_LOST_CAPTURE_STATUSES = ["waiting_extension", "capturing", "extension_version_mismatch"];
const RESTART_LOST_CAPTURE_JOB_STATUSES = ["queued", "claimed"];

function sourceCaptureLostOnRestart(capture) {
  if (!capture || typeof capture !== "object" || typeof capture.captureId !== "string" || capture.captureId === "") return false;
  if (sourceCaptureSessions.has(capture.captureId)) return false;
  return RESTART_LOST_CAPTURE_STATUSES.includes(capture.status) ||
    RESTART_LOST_CAPTURE_JOB_STATUSES.includes(capture.jobStatus);
}

/**
 * Capture sessions live only in the memory of the process that created them, so every queued, claimed or capturing
 * record found at startup belongs to a process that is gone and can never produce a result. Left open, such a record
 * also trips the previous_capture_requires_review guard and refuses every later capture request for that product.
 * This closes each one exactly once, as a failure we never received a result for: writeOccurred stays false, no
 * business state moves, and a run that finds nothing writes nothing at all.
 */
async function reconcileSourceCaptureJobsAfterRestart() {
  return mutateDataWhenChanged((data) => {
    const closed = [];
    for (const current of data.candidates) {
      const capture = current.sourceCapture;
      if (!sourceCaptureLostOnRestart(capture)) continue;
      markSourceCaptureFailure(current, {
        captureId: capture.captureId,
        expectedOfferId: capture.offerId ?? "",
        sourceUrl: capture.sourceUrl ?? "",
        originalSourceUrl: capture.originalSourceUrl ?? capture.sourceUrl ?? "",
        mode: capture.mode ?? "a_supplier_capture",
        jobStatus: capture.jobStatus ?? null,
        attempt: capture.attempt ?? 0,
        requiredExtensionVersion: capture.requiredExtensionVersion ?? null
      }, "capture_job_lost");
      closed.push(current.id);
    }
    return { changed: closed.length > 0, result: closed };
  });
}

/**
 * "结果未知" is the one capture outcome the software may never resolve by itself: the extension claimed the job and the
 * server then received nothing, so no result exists to read and a silent retry would be a guess. The record therefore
 * blocks every later capture request for that product until a person settles it — which is only honest if a person can
 * actually reach it. The owner had no route and no button for exactly that record on 2026-09-11, and the first product
 * of the day became unusable. POST /api/candidates/:id/source-capture/review is that exit, and nothing else: it records
 * the owner's own acknowledgement that no result arrived, and stamps reviewedAt so this guard stops refusing.
 */
const OWNER_CAPTURE_REVIEW_ACKNOWLEDGEMENTS = Object.freeze(["no_result_received"]);

function sourceCaptureOutcomeUnknown(capture) {
  return capture?.jobStatus === "unknown_outcome" || capture?.failureCode === "unknown_outcome";
}

/** Reviewed by the owner (reviewedAt) means the record is settled: it stays visible as history, it no longer blocks. */
function sourceCaptureAwaitsOwnerReview(capture) {
  return sourceCaptureOutcomeUnknown(capture) && !capture?.reviewedAt;
}

/**
 * 重新采集 — reading the same 1688 page a second time.
 *
 * A capture that came back with specifications closes the door behind it: /lifecycle/a-confirm sees
 * captureReadyForSameSource and stops creating capture jobs for that product, so the product is frozen on whatever that
 * one read happened to contain. On 2026-09-13 the first real product of the day was captured while the server still
 * dropped every per-specification weight, and the owner's 选规格 table could only show 待补 for every freight and every
 * profit, with no way anywhere in the application to ask for a second read. This vocabulary and
 * POST /api/candidates/:id/source-capture/recapture are that way out, and nothing else.
 *
 * The reason is optional and can only be one of these words; no free text ever reaches a saved record.
 */
const OWNER_CAPTURE_RECAPTURE_REASONS = Object.freeze(["weight_missing", "page_changed", "wrong_specifications"]);
const OWNER_CAPTURE_RECAPTURE_REASON_WORDS = Object.freeze({
  weight_missing: "上一次没采到重量",
  page_changed: "1688页面已经改了",
  wrong_specifications: "采到的规格不对"
});

/**
 * What a second read costs, said out loud. A capture job replaces the whole sourceCapture record, so the specifications
 * this product was showing — and any choice the owner had already frozen out of them — are gone the moment the new job
 * is queued. That must never be a silent side effect: the owner is told the count that was voided, in the same write.
 */
function aSupplierRecaptureHistoryDetail(superseded, reason) {
  const choices = Array.isArray(superseded?.skuChoices) ? superseded.skuChoices.length : 0;
  const selected = Array.isArray(superseded?.selectedSkuIds) ? superseded.selectedSkuIds.length : 0;
  const because = OWNER_CAPTURE_RECAPTURE_REASON_WORDS[reason] ? `（主人给的理由：${OWNER_CAPTURE_RECAPTURE_REASON_WORDS[reason]}）` : "";
  const voidedSelection = selected > 0
    ? `；之前选定的${selected}个规格已随重新采集作废，需要重新选`
    : "";
  return `主人要求重新读一次这个1688页面${because}：上一次采到的${choices}个规格已经作废${voidedSelection}；` +
    "重新采集不下单、不联系供应商、不向平台写入任何内容";
}

/**
 * `ownerRecapture` is the only thing that separates a second read from the first one: the same candidate, the same
 * saved 1688 link, the same guards and the same lease, plus one extra history line written inside this same mutation
 * so the voided specifications and the queued job can never be recorded apart from each other.
 */
async function enqueueASupplierCaptureJob({ candidateId, requestRevision, requestedSourceUrl, ownerRecapture = null, onQueued = null }) {
  const existing = captureSession(candidateId);
  if (existing?.mode === "a_supplier_capture" &&
    [existing.requestRevision, existing.dataRevision].includes(requestRevision) &&
    ["queued", "claimed"].includes(existing.jobStatus)) {
    const data = await readData();
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
    const requestedSource = normalizeSupplierCaptureSource(requestedSourceUrl);
    if (Number(current.dataRevision) !== existing.dataRevision || requestedSource.sourceUrl !== existing.sourceUrl ||
        current.sourceCapture?.captureId !== existing.captureId) {
      throw httpError(409, "当前资料与已有采集作业不一致，不能沿用旧作业", { code: "capture_job_state_conflict" });
    }
    return { candidate: publicCandidate(current, data.rules), captureJob: sourceCaptureJobPublic(existing), duplicate: true };
  }
  ensureCaptureControlAvailable(candidateId);
  const source = normalizeSupplierCaptureSource(requestedSourceUrl);
  if (source.type === "invalid") {
    throw httpError(422, "A阶段供应链接不是允许的1688或拼多多短链或精确商品链接", { code: "source_url_invalid" });
  }
  const session = {
    captureId: `SCJ-${randomUUID()}`,
    token: randomBytes(32).toString("base64url"),
    candidateId,
    requestRevision,
    dataRevision: null,
    expectedOfferId: source.offerId,
    sourceUrl: source.sourceUrl,
    originalSourceUrl: source.sourceUrl,
    createdAt: Date.now(),
    expiresAt: Date.now() + SOURCE_CAPTURE_JOB_QUEUE_TTL_MS,
    recoverySuggestion: "",
    mode: "a_supplier_capture",
    jobStatus: "queued",
    attempt: 0,
    requiredExtensionVersion: REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION,
    claimedAt: null,
    claimedExtensionVersion: "",
    claimedExtensionOrigin: ""
  };
  sourceCaptureSessions.set(session.captureId, session);
  let candidate;
  try {
    candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
      if (Number(current.dataRevision) !== Number(requestRevision)) {
        throw httpError(409, "商品资料已变化，请刷新后重新保存A阶段供应链接", { code: "revision_conflict" });
      }
      if (!sourceCaptureAllowed(current, session.mode)) {
        throw httpError(409, "当前商品状态不能建立A阶段供应采集作业", { code: "business_state_rejected" });
      }
      // A live record (still waiting, still running) blocks whatever the owner has reviewed; an unknown-outcome record
      // blocks only until the owner has settled it through source-capture/review.
      if (["waiting_extension", "capturing", "extension_version_mismatch"].includes(current.sourceCapture?.status) ||
          ["queued", "claimed"].includes(current.sourceCapture?.jobStatus) ||
          sourceCaptureAwaitsOwnerReview(current.sourceCapture)) {
        throw httpError(409, "该商品仍有未核实的历史采集记录，请先处理这条记录", { code: "previous_capture_requires_review" });
      }
      if (activeDispatchForCandidate(data, current.id)) {
        throw httpError(409, "当前SKU已有任务等待或运行，不能建立供应采集作业", { code: "candidate_busy" });
      }
      const timestamp = now();
      // Read before the replacement below drops it: a queued job replaces the whole record, so whatever this product
      // was showing — captured specifications, selectedSkuIds, the frozen skuSelection — stops existing right here.
      const superseded = current.sourceCapture;
      current.sourceUrl = source.sourceUrl;
      current.sourceCapture = {
        captureId: session.captureId,
        jobId: session.captureId,
        status: "waiting_extension",
        jobStatus: "queued",
        offerId: source.offerId,
        sourceUrl: source.sourceUrl,
        originalSourceUrl: source.sourceUrl,
        mode: session.mode,
        attempt: 0,
        requiredExtensionVersion: session.requiredExtensionVersion,
        startedAt: timestamp,
        writeOccurred: false,
        businessStateEffect: "unchanged"
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      session.dataRevision = current.dataRevision;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "aSupplierCaptureJobQueued", "主人在新版A确认动作中保存供应链接；系统已建立一个受控采集作业，等待插件后台领取，不自动选择SKU、运行B/C1或派发任务", timestamp);
      if (ownerRecapture) {
        addHistory(current, "user", "aSupplierCaptureRecaptureRequested",
          aSupplierRecaptureHistoryDetail(superseded, ownerRecapture.reason ?? null), timestamp);
      }
      // 录入流水线排的这一步：作业编号和这次排队写在同一次保存里，不会出现排了作业却没记下是谁排的。
      onQueued?.(current, session, timestamp);
      return publicCandidate(current, data.rules);
    });
  } catch (error) {
    sourceCaptureSessions.delete(session.captureId);
    throw error;
  }
  scheduleSourceCaptureJobExpiry(session, "queued", SOURCE_CAPTURE_JOB_QUEUE_TTL_MS);
  return { candidate, captureJob: sourceCaptureJobPublic(session), duplicate: false };
}

function claimASupplierCaptureJob(captureId, extensionVersion, extensionOrigin) {
  const operation = sourceCaptureJobClaimQueue.then(async () => {
    const session = sourceCaptureSessions.get(captureId);
    if (!session || session.mode !== "a_supplier_capture") {
      throw httpError(409, "当前服务没有这次明确创建的采集作业", { code: "capture_job_not_current" });
    }
    if (session.jobStatus !== "queued" || session.attempt !== 0 || session.expiresAt <= Date.now()) {
      throw httpError(409, "该采集作业已领取、失效或结果待核实，不能再次执行", { code: "capture_job_not_claimable" });
    }
    if (String(extensionVersion) !== session.requiredExtensionVersion) {
      throw httpError(409, `本次采集要求插件v${session.requiredExtensionVersion}`, { code: "extension_version_mismatch" });
    }
    session.jobStatus = "claim_pending";
    session.attempt = 1;
    session.claimedAt = Date.now();
    session.claimedExtensionVersion = String(extensionVersion);
    session.claimedExtensionOrigin = String(extensionOrigin || "");
    clearSourceCaptureJobTimer(session.captureId);
    try {
      const claimedRevision = await mutateData((data) => {
        if (session.expiresAt <= Date.now()) throw httpError(409, "采集作业等待期限已结束", { code: "capture_job_expired" });
        const current = data.candidates.find((item) => item.id === session.candidateId);
        if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
        if (current.sourceCapture?.captureId !== session.captureId ||
          current.sourceCapture.status !== "waiting_extension" ||
          current.sourceCapture.jobStatus !== "queued" || current.sourceCapture.attempt !== 0 ||
          current.sourceCapture.sourceUrl !== session.sourceUrl || current.sourceUrl !== session.sourceUrl) {
          throw httpError(409, "当前候选不再等待该采集作业", { code: "capture_job_state_conflict" });
        }
        if (Number(current.dataRevision) !== Number(session.dataRevision)) {
          throw httpError(409, "采集作业修订号已失效", { code: "revision_conflict" });
        }
        current.sourceCapture = {
          ...current.sourceCapture,
          status: "capturing",
          jobStatus: "claimed",
          attempt: 1,
          claimedAt: new Date(session.claimedAt).toISOString(),
          claimedExtensionVersion: session.claimedExtensionVersion,
          failureCode: null,
          reason: null,
          writeOccurred: false,
          businessStateEffect: "unchanged"
        };
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = now();
        current.lastModifiedBy = "system";
        return current.dataRevision;
      });
      session.dataRevision = claimedRevision;
      session.jobStatus = "claimed";
    } catch (error) {
      // A failed durable write can have an uncertain outcome. Never reopen this claim.
      session.jobStatus = "unknown_outcome";
      session.consumedAt = Date.now();
      sourceCaptureSessions.delete(session.captureId);
      throw error;
    }
    session.expiresAt = Date.now() + SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS;
    scheduleSourceCaptureJobExpiry(session, "claimed", SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS);
    return { captureJob: sourceCaptureJobPayload(session), jobNotice: null };
  });
  // Keep the serialization tail usable; the original rejecting operation reaches its caller.
  sourceCaptureJobClaimQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/* ── 读一次 Ozon 商品页 ──────────────────────────────────────────────────────────────────────────────────────────
 * 发起那一半。1688 供应采集的整条链路（全局采集控制锁、排队与执行租约、一次性令牌、插件明确领取、过期收口、
 * 重启对账）今天全部修通了，这里用的就是同一套，只换了目标：读的是 www.ozon.ru 上这件商品自己的页面。
 *
 * 之所以必须有它：算利润要用的类目只认 collectorMode 为 real_page_read_only 的销售快照，而这个 collectorMode
 * 只有插件真的读过页面并回传结果时才会产生。在这之前 /sales-capture/start 是一行写死的 409，于是那份快照永远
 * 出不来，第一件真货卡在「当前类目」上（主人 2026-09-14）。
 *
 * 边界和 1688 那条一模一样：仅主人、封闭输入、修订号不符就 409、占同一把全局采集控制锁、同一套租约与收口。
 * 服务端自己不碰 www.ozon.ru —— 页面只能由主人自己的浏览器经插件读取，验证码和登录墙由收集器如实回报后停下。
 */
function ozonPageReadAllowed(candidate) {
  if (candidate.workflowStatus === "eliminated") return false;
  const capture = candidate.salesCapture;
  return !["waiting_extension", "capturing"].includes(capture?.status) &&
    !["queued", "claimed"].includes(capture?.jobStatus);
}

/**
 * 这次读页面停在哪儿，如实写进这件商品的记录。业务状态一律不动：没有下单、没有联系供应商、没有向 Ozon 写任何
 * 东西，也没有产生任何快照。writeOccurred 恒为 false。
 */
function markOzonPageReadFailure(current, session, code, detail = "", observedAt = now()) {
  const reason = ozonPageReadStopMessage(code, detail);
  current.salesCapture = {
    captureId: session.captureId,
    jobId: session.captureId,
    status: "failed",
    jobStatus: code === "unknown_outcome" ? "unknown_outcome" : "failed",
    technicalStatus: code === "unknown_outcome" ? "unknown_outcome" : "system_error",
    productId: session.expectedProductId,
    productUrl: session.productUrl,
    attempt: Number(session.attempt || 0),
    requiredExtensionVersion: session.requiredExtensionVersion || null,
    failureCode: code,
    failureLayer: "ozon_page_extension_capture",
    reason,
    observedAt,
    stoppedAt: now(),
    businessStateEffect: "unchanged",
    retryAttempted: false,
    writeOccurred: false
  };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = now();
  current.lastModifiedBy = "system";
  addHistory(current, "system", "ozonPageReadStopped",
    `${reason}；这件商品的业务状态没有改变，也没有产生任何销售快照`, observedAt);
}

async function expireOzonPageReadJob(captureId, expectedStatus) {
  const session = salesCaptureSessions.get(captureId);
  if (!session || session.jobStatus !== expectedStatus || session.consumedAt) return;
  const failureCode = expectedStatus === "claimed" ? "unknown_outcome" : "extension_job_unclaimed";
  await mutateDataWhenChanged((data) => {
    const current = data.candidates.find((item) => item.id === session.candidateId);
    // Only the captureId identifies the record this job owns — the same lesson the 1688 closure already paid for:
    // also demanding an unchanged dataRevision let any unrelated edit during the wait abandon the closure and leave
    // the product waiting on an extension that can never answer.
    if (!current || current.salesCapture?.captureId !== captureId) return { changed: false };
    // Only a record still waiting on the extension can be closed here. A record that already reached its verdict needs
    // no closure, and overwriting it would turn a saved page read back into a failure.
    if (!["waiting_extension", "capturing"].includes(current.salesCapture.status)) return { changed: false };
    markOzonPageReadFailure(current, session, failureCode);
    return { changed: true };
  });
  session.jobStatus = failureCode;
  session.consumedAt = Date.now();
  clearSourceCaptureJobTimer(captureId);
  salesCaptureSessions.delete(captureId);
}

function scheduleOzonPageReadJobExpiry(session, expectedStatus, timeoutMs) {
  clearSourceCaptureJobTimer(session.captureId);
  const timer = setTimeout(() => {
    void expireOzonPageReadJob(session.captureId, expectedStatus).catch((error) => {
      console.error("Ozon读页面作业超时收口失败", error);
    });
  }, timeoutMs);
  timer.unref?.();
  sourceCaptureJobTimers.set(session.captureId, timer);
}

/** 同 1688：会话只活在建立它的进程里，所以重启时每一条还在等的记录都不可能再有结果，必须各收口一次。 */
function ozonPageReadLostOnRestart(capture) {
  if (!capture || typeof capture !== "object" || typeof capture.captureId !== "string" || capture.captureId === "") return false;
  if (salesCaptureSessions.has(capture.captureId)) return false;
  return ["waiting_extension", "capturing"].includes(capture.status) ||
    ["queued", "claimed"].includes(capture.jobStatus);
}

async function reconcileOzonPageReadJobsAfterRestart() {
  return mutateDataWhenChanged((data) => {
    const closed = [];
    for (const current of data.candidates) {
      const capture = current.salesCapture;
      if (!ozonPageReadLostOnRestart(capture)) continue;
      markOzonPageReadFailure(current, {
        captureId: capture.captureId,
        expectedProductId: capture.productId ?? "",
        productUrl: capture.productUrl ?? "",
        attempt: capture.attempt ?? 0,
        requiredExtensionVersion: capture.requiredExtensionVersion ?? null
      }, "capture_job_lost");
      closed.push(current.id);
    }
    return { changed: closed.length > 0, result: closed };
  });
}

async function enqueueOzonPageReadJob({ candidateId, requestRevision, requestedProductUrl = null }) {
  const existing = salesCaptureSession(candidateId);
  if (existing?.captureKind === OZON_PAGE_READ_CAPTURE_KIND &&
    [existing.requestRevision, existing.dataRevision].includes(requestRevision) &&
    ["queued", "claimed"].includes(existing.jobStatus)) {
    const data = await readData();
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
    if (Number(current.dataRevision) !== existing.dataRevision ||
        current.salesCapture?.captureId !== existing.captureId) {
      throw httpError(409, "当前资料与已有读页面作业不一致，不能沿用旧作业", { code: "capture_job_state_conflict" });
    }
    return { candidate: publicCandidate(current, data.rules), captureJob: ozonCapturePageJobPublic(existing), duplicate: true };
  }
  ensureCaptureControlAvailable(candidateId);
  const snapshot = await readData();
  const snapshotCandidate = snapshot.candidates.find((item) => item.id === candidateId);
  if (!snapshotCandidate) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
  const target = ozonCapturePageTarget(snapshotCandidate, requestedProductUrl);
  if (!target.ok) throw httpError(422, target.reason, { code: target.code });

  const session = {
    captureId: `OPR-${randomUUID()}`,
    token: randomBytes(32).toString("base64url"),
    candidateId,
    requestRevision,
    dataRevision: null,
    expectedProductId: target.productId,
    productUrl: target.productUrl,
    // 主人指名要读的页面 = 对标（别的商品）。落盘时据此打标，反推目标时会跳过它们，
    // 否则挂上第一个对标之后这件商品就再也读不了自己的页面。
    comparable: target.from === "owner_requested_url",
    createdAt: Date.now(),
    expiresAt: Date.now() + SOURCE_CAPTURE_JOB_QUEUE_TTL_MS,
    captureKind: OZON_PAGE_READ_CAPTURE_KIND,
    jobStatus: "queued",
    attempt: 0,
    requiredExtensionVersion: REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION,
    claimedAt: null,
    claimedExtensionVersion: "",
    claimedExtensionOrigin: ""
  };
  salesCaptureSessions.set(session.captureId, session);
  let candidate;
  try {
    candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
      if (Number(current.dataRevision) !== Number(requestRevision)) {
        throw httpError(409, "商品资料已变化，请刷新后重新发起这次读页面", { code: "revision_conflict" });
      }
      if (!ozonPageReadAllowed(current)) {
        throw httpError(409, "这件商品还有一次读页面没有结束，或者已经淘汰，不能再建立读页面作业", { code: "business_state_rejected" });
      }
      if (activeDispatchForCandidate(data, current.id)) {
        throw httpError(409, "当前商品已有任务等待或运行，不能读这个 Ozon 页面", { code: "candidate_busy" });
      }
      const timestamp = now();
      current.salesCapture = {
        captureId: session.captureId,
        jobId: session.captureId,
        status: "waiting_extension",
        jobStatus: "queued",
        productId: session.expectedProductId,
        productUrl: session.productUrl,
        attempt: 0,
        requiredExtensionVersion: session.requiredExtensionVersion,
        startedAt: timestamp,
        businessStateEffect: "unchanged",
        retryAttempted: false,
        writeOccurred: false
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      session.dataRevision = current.dataRevision;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "ozonPageReadJobQueued",
        `主人要求读一次这个 Ozon 商品页（${session.expectedProductId}）；系统已建立一个受控只读作业，等待插件后台领取。` +
        "不下单、不联系任何人、不向 Ozon 写入任何内容，也不推进业务阶段", timestamp);
      return publicCandidate(current, data.rules);
    });
  } catch (error) {
    salesCaptureSessions.delete(session.captureId);
    throw error;
  }
  scheduleOzonPageReadJobExpiry(session, "queued", SOURCE_CAPTURE_JOB_QUEUE_TTL_MS);
  return { candidate, captureJob: ozonCapturePageJobPublic(session), duplicate: false };
}

function claimOzonPageReadJob(captureId, extensionVersion, extensionOrigin) {
  const operation = sourceCaptureJobClaimQueue.then(async () => {
    const session = salesCaptureSessions.get(captureId);
    if (!session || session.captureKind !== OZON_PAGE_READ_CAPTURE_KIND) {
      throw httpError(409, "当前服务没有这次明确创建的采集作业", { code: "capture_job_not_current" });
    }
    if (session.jobStatus !== "queued" || session.attempt !== 0 || session.expiresAt <= Date.now()) {
      throw httpError(409, "该采集作业已领取、失效或结果待核实，不能再次执行", { code: "capture_job_not_claimable" });
    }
    if (String(extensionVersion) !== session.requiredExtensionVersion) {
      throw httpError(409, `本次采集要求插件v${session.requiredExtensionVersion}`, { code: "extension_version_mismatch" });
    }
    session.jobStatus = "claim_pending";
    session.attempt = 1;
    session.claimedAt = Date.now();
    session.claimedExtensionVersion = String(extensionVersion);
    session.claimedExtensionOrigin = String(extensionOrigin || "");
    clearSourceCaptureJobTimer(session.captureId);
    try {
      const claimedRevision = await mutateData((data) => {
        if (session.expiresAt <= Date.now()) throw httpError(409, "采集作业等待期限已结束", { code: "capture_job_expired" });
        const current = data.candidates.find((item) => item.id === session.candidateId);
        if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
        if (current.salesCapture?.captureId !== session.captureId ||
          current.salesCapture.status !== "waiting_extension" ||
          current.salesCapture.jobStatus !== "queued" || current.salesCapture.attempt !== 0 ||
          current.salesCapture.productId !== session.expectedProductId) {
          throw httpError(409, "当前候选不再等待该采集作业", { code: "capture_job_state_conflict" });
        }
        if (Number(current.dataRevision) !== Number(session.dataRevision)) {
          throw httpError(409, "采集作业修订号已失效", { code: "revision_conflict" });
        }
        current.salesCapture = {
          ...current.salesCapture,
          status: "capturing",
          jobStatus: "claimed",
          attempt: 1,
          claimedAt: new Date(session.claimedAt).toISOString(),
          claimedExtensionVersion: session.claimedExtensionVersion,
          failureCode: null,
          reason: null,
          writeOccurred: false,
          businessStateEffect: "unchanged"
        };
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = now();
        current.lastModifiedBy = "system";
        return current.dataRevision;
      });
      session.dataRevision = claimedRevision;
      session.jobStatus = "claimed";
    } catch (error) {
      // A failed durable write can have an uncertain outcome. Never reopen this claim.
      session.jobStatus = "unknown_outcome";
      session.consumedAt = Date.now();
      salesCaptureSessions.delete(session.captureId);
      throw error;
    }
    session.expiresAt = Date.now() + SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS;
    scheduleOzonPageReadJobExpiry(session, "claimed", SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS);
    return { captureJob: ozonCapturePageJobPayload(session), jobNotice: null };
  });
  // Keep the serialization tail usable; the original rejecting operation reaches its caller.
  sourceCaptureJobClaimQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/**
 * 插件领取作业只有这一个入口，现在它同时认两种会话。
 *
 * 分流只看这次作业编号在不在 Ozon 读页面那张表里：在，就走读页面那条；不在（包括根本不存在的编号），原样交给
 * claimASupplierCaptureJob。所以 1688 那侧的判断顺序、错误码和文案一个字都没变 —— 连「当前服务没有这次明确
 * 创建的采集作业」这句拒绝也仍然由它自己给出。两种作业编号前缀不同（SCJ- / OPR-），不会互相认领。
 */
function claimCaptureJob(captureId, extensionVersion, extensionOrigin) {
  if (salesCaptureSessions.has(captureId)) return claimOzonPageReadJob(captureId, extensionVersion, extensionOrigin);
  if (imageMatchSessions.has(captureId)) return claimImageMatchJob(captureId, extensionVersion, extensionOrigin);
  if (seerfarWebRounds.owns(captureId)) return seerfarWebClaim(captureId, extensionVersion, extensionOrigin);
  return claimASupplierCaptureJob(captureId, extensionVersion, extensionOrigin);
}

/**
 * 找同款 —— 主人点一次，插件在这台电脑的 Chrome 里搜一次，读回结果；服务端再拿首图和每条结果的主图比一次。两种目标：
 *   · 在 1688 找同款：用首图在主人登录的 1688 上搜图，读回最像的 20 条，结果落在 candidate.supplierImageMatch；
 *   · 在 Ozon 找同款：默认在 Ozon 首页的搜索栏上传首图以图搜一次；以图搜只找到近似款时，主人可以改用俄文关键词在 Ozon 站内
 *     搜一次。都读回第一屏，结果落在 candidate.ozonImageMatch。
 * 首图来自采到的拼多多或 1688 货源首图，没有货源采集时用这件商品的 Ozon 主图（见 supplierImageMatchSource）。
 *
 * 链路和上面两种作业是同一套：同一把全局采集控制锁、排队与执行租约、一次性令牌、插件明确领取、过期收口、重启对账。
 * 两种目标只有落点和说法不同，都不碰 sourceCapture、不选 SKU、不确认供货、不推进任何阶段。结果回来以后服务端再取公开图片
 * 算首图指纹，标出「首图一致 / 很像 / 不像」；是不是同款永远由主人逐条判断（AGENTS.md §4.3）。没登录时 1688 只显示
 * 「没有结果」，所以读不到结果一律是无法核实，不是没有同款（§8.3）；Ozon 搜不到也只说明这几个词没搜到。
 */
const IMAGE_MATCH_KINDS = Object.freeze({
  supplier: Object.freeze({
    key: "supplier", field: "supplierImageMatch", rules: supplierImageMatchRules, captureKind: SUPPLIER_IMAGE_MATCH_CAPTURE_KIND,
    idPrefix: "IMJ", historyPrefix: "supplierImageMatch", logLabel: "1688找同款", site: "1688", idField: "offerId",
    jobPayload: supplierImageMatchJobPayload, jobPublic: supplierImageMatchJobPublic,
    target: (candidate) => supplierImageMatchSource(candidate),
    queuedRecord: (previous, target, fields) => queuedSupplierImageMatchRecord(previous, { ...fields, source: target.source }),
    queuedHistory: (target) => `主人要求用${SUPPLIER_IMAGE_MATCH_SOURCE_LABELS[target.source.platform]}在 1688 找一次同款；` +
      "系统已建立一个受控只读作业（登录态只读搜索一次，最多读回 20 条），等待插件后台领取。不下单、不联系任何人、不确认供货，也不推进业务阶段",
    sameTarget: (record, session) => record.source?.imageUrl === session.imageUrl,
    sanitize: (input, session, record) => sanitizeSupplierImageMatchEvidence(input, session.imageUrl,
      { sourceOfferId: record.source?.platform === "1688" ? String(record.source.offerId || "") : "" }),
    resultsHistory: (record, evidence) => `插件在 1688 用${SUPPLIER_IMAGE_MATCH_SOURCE_LABELS[record.source?.platform] || "首图"}搜到 ` +
      `${evidence.cardCount} 条，已保存相似度最高的 ${evidence.items.length} 条，正在比对首图；没有选择 SKU、没有确认供货，业务状态没有改变`,
    itemLabel: (id) => `1688 商品 offer/${id}`
  }),
  ozon: Object.freeze({
    key: "ozon", field: "ozonImageMatch", rules: ozonImageMatchRules, captureKind: OZON_IMAGE_MATCH_CAPTURE_KIND,
    idPrefix: "OMJ", historyPrefix: "ozonImageMatch", logLabel: "Ozon找同款", site: "Ozon", idField: "productId",
    jobPayload: ozonImageMatchJobPayload, jobPublic: ozonImageMatchJobPublic,
    target: (candidate, input) => ozonImageMatchTarget(candidate, input.query, { searchBy: input.searchBy === "image" ? "image" : "text" }),
    queuedRecord: (previous, target, fields) => queuedOzonImageMatchRecord(previous, { ...fields, source: target.source,
      searchBy: target.searchBy, query: target.query, queryOrigin: target.queryOrigin }),
    queuedHistory: (target) => (target.searchBy === "image"
      ? `主人要求拿${SUPPLIER_IMAGE_MATCH_SOURCE_LABELS[target.source.platform]}在 Ozon 以图搜一次，再和结果的主图比，找同款；` +
        "系统已建立一个受控作业（在这台电脑的 Chrome 里打开 Ozon 首页，点一次搜索栏的拍照按钮上传这张图，最多读回 36 条），等待插件后台领取。"
      : `主人要求用「${target.query}」在 Ozon 搜一次，再拿${SUPPLIER_IMAGE_MATCH_SOURCE_LABELS[target.source.platform]}` +
        "和结果的主图比，找同款；系统已建立一个受控只读作业（在这台电脑的 Chrome 里打开一次 Ozon 搜索页，最多读回 36 条），等待插件后台领取。") +
      "不加购、不收藏、不联系任何人，也不推进业务阶段",
    sameTarget: (record, session) => record.source?.imageUrl === session.imageUrl && (record.searchBy ?? "text") === session.searchBy &&
      record.query === session.query,
    sanitize: (input, session) => sanitizeOzonImageMatchEvidence(input, session.query,
      { ownProductId: session.ownProductId, searchBy: session.searchBy }),
    resultsHistory: (record, evidence) => (evidence.searchBy === "image"
      ? `插件在 Ozon 以图搜到 ${evidence.cardCount} 条（Ozon 给这次上传编的号 ${evidence.imageId}），已保存前 ${evidence.items.length} 条，`
      : `插件在 Ozon 用「${record.query}」搜到 ${evidence.cardCount} 条，已保存前 ${evidence.items.length} 条，`) +
      `正在和${SUPPLIER_IMAGE_MATCH_SOURCE_LABELS[record.source?.platform] || "首图"}比对；业务状态没有改变`,
    itemLabel: (id) => `Ozon 商品 ${id}`
  })
});
const imageMatchKindOf = (session) => IMAGE_MATCH_KINDS[session?.matchKind] ?? null;

function imageMatchSessionFor(kind, candidateId, captureId = "") {
  const session = captureId ? imageMatchSessions.get(captureId)
    : [...imageMatchSessions.values()].find((entry) => entry.candidateId === candidateId && entry.matchKind === kind.key);
  return session?.matchKind === kind.key ? session : null;
}

function markImageMatchFailure(kind, current, code, { observedAt, timestamp = now(), detail = "" } = {}) {
  current[kind.field] = kind.rules.failed(current[kind.field], code, { observedAt, timestamp, detail });
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "system";
  addHistory(current, "system", `${kind.historyPrefix}Stopped`, `${current[kind.field].reason}；这件商品的业务状态没有改变`, timestamp);
}

async function expireImageMatchJob(captureId, expectedStatus) {
  const session = imageMatchSessions.get(captureId);
  const kind = imageMatchKindOf(session);
  if (!session || !kind || session.jobStatus !== expectedStatus || session.consumedAt) return;
  const failureCode = expectedStatus === "claimed" ? "unknown_outcome" : "extension_job_unclaimed";
  await mutateDataWhenChanged((data) => {
    const current = data.candidates.find((item) => item.id === session.candidateId);
    // Only the captureId identifies the record this job owns, for the same reason as the two closures above.
    if (!current || current[kind.field]?.captureId !== captureId) return { changed: false };
    if (!kind.rules.inFlight(current[kind.field])) return { changed: false };
    markImageMatchFailure(kind, current, failureCode);
    return { changed: true };
  });
  session.jobStatus = failureCode;
  session.consumedAt = Date.now();
  clearSourceCaptureJobTimer(captureId);
  imageMatchSessions.delete(captureId);
}

function scheduleImageMatchJobExpiry(session, expectedStatus, timeoutMs) {
  clearSourceCaptureJobTimer(session.captureId);
  const timer = setTimeout(() => {
    void expireImageMatchJob(session.captureId, expectedStatus).catch((error) => {
      console.error(`${imageMatchKindOf(session)?.logLabel ?? "找同款"}作业超时收口失败`, error);
    });
  }, timeoutMs);
  timer.unref?.();
  sourceCaptureJobTimers.set(session.captureId, timer);
}

/** 同上：会话只活在建立它的进程里，重启时每一条还在等插件的记录都不可能再有结果。 */
async function reconcileImageMatchJobsAfterRestart() {
  return mutateDataWhenChanged((data) => {
    const closed = [];
    for (const current of data.candidates) {
      for (const kind of Object.values(IMAGE_MATCH_KINDS)) {
        const record = current[kind.field];
        if (!record || typeof record.captureId !== "string" || imageMatchSessions.has(record.captureId)) continue;
        if (!kind.rules.inFlight(record)) continue;
        markImageMatchFailure(kind, current, "capture_job_lost");
        closed.push(`${current.id}（${kind.site}）`);
      }
    }
    return { changed: closed.length > 0, result: closed };
  });
}

async function enqueueImageMatchJob(kind, { candidateId, requestRevision, acknowledgeUnknownOutcome, actor, input = {}, onQueued = null }) {
  const existing = imageMatchSessionFor(kind, candidateId);
  if (existing && [existing.requestRevision, existing.dataRevision].includes(requestRevision) &&
    ["queued", "claimed"].includes(existing.jobStatus)) {
    const data = await readData();
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
    if (current[kind.field]?.captureId !== existing.captureId) {
      throw httpError(409, "当前资料与已有找同款作业不一致，不能沿用旧作业", { code: "capture_job_state_conflict" });
    }
    return { candidate: publicCandidate(current, data.rules), captureJob: kind.jobPublic(existing), duplicate: true };
  }
  ensureCaptureControlAvailable(candidateId);
  const snapshot = await readData();
  const snapshotCandidate = snapshot.candidates.find((item) => item.id === candidateId);
  if (!snapshotCandidate) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
  const target = kind.target(snapshotCandidate, input);
  if (!target.ok) throw httpError(422, target.reason, { code: target.code });

  const session = {
    captureId: `${kind.idPrefix}-${randomUUID()}`,
    token: randomBytes(32).toString("base64url"),
    candidateId,
    requestRevision,
    dataRevision: null,
    matchKind: kind.key,
    imageUrl: target.imageUrl,
    searchUrl: target.searchUrl,
    query: target.query ?? null,
    searchBy: target.searchBy ?? null,
    searchImageServedAt: null,
    ownProductId: target.ownProductId ?? "",
    createdAt: Date.now(),
    expiresAt: Date.now() + SOURCE_CAPTURE_JOB_QUEUE_TTL_MS,
    captureKind: kind.captureKind,
    jobStatus: "queued",
    attempt: 0,
    requiredExtensionVersion: REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION,
    claimedAt: null,
    claimedExtensionVersion: "",
    claimedExtensionOrigin: ""
  };
  imageMatchSessions.set(session.captureId, session);
  let candidate;
  try {
    candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
      if (Number(current.dataRevision) !== Number(requestRevision)) {
        throw httpError(409, "商品资料已变化，请刷新后再找同款", { code: "revision_conflict" });
      }
      const blocker = kind.rules.startBlocker(current, { acknowledgeUnknownOutcome });
      if (blocker) throw httpError(409, blocker.reason, { code: blocker.code });
      // The picture is read again inside the transaction: a capture saved after the snapshot above may name another one.
      const locked = kind.target(current, input);
      if (!locked.ok) throw httpError(422, locked.reason, { code: locked.code });
      if (locked.imageUrl !== session.imageUrl) {
        throw httpError(409, "货源首图刚刚变了，请刷新后再找同款", { code: "revision_conflict" });
      }
      if (activeDispatchForCandidate(data, current.id)) {
        throw httpError(409, "当前商品已有任务等待或运行，不能找同款", { code: "candidate_busy" });
      }
      const timestamp = now();
      current[kind.field] = kind.queuedRecord(current[kind.field], locked, {
        captureId: session.captureId, requiredExtensionVersion: session.requiredExtensionVersion,
        authorizedBy: actor.userId, authorizedAt: timestamp, candidateRevision: Number(requestRevision)
      });
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      session.dataRevision = current.dataRevision;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", `${kind.historyPrefix}Queued`, kind.queuedHistory(locked), timestamp);
      onQueued?.(current, session, timestamp);
      return publicCandidate(current, data.rules);
    });
  } catch (error) {
    imageMatchSessions.delete(session.captureId);
    throw error;
  }
  scheduleImageMatchJobExpiry(session, "queued", SOURCE_CAPTURE_JOB_QUEUE_TTL_MS);
  return { candidate, captureJob: kind.jobPublic(session), duplicate: false };
}

/** Seerfar 榜单作业和其他插件作业排同一个领取队列，避免两张领取请求交错写数据。 */
function seerfarWebClaim(captureId, extensionVersion, extensionOrigin) {
  const operation = sourceCaptureJobClaimQueue.then(() => seerfarWebRounds.claim(captureId, extensionVersion, extensionOrigin)
    .catch((error) => { throw seerfarWebHttpError(error); }));
  sourceCaptureJobClaimQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function seerfarWebHttpError(error) {
  if (!Number.isInteger(error?.status)) return error;
  return httpError(error.status, error.publicMessage || "Seerfar 榜单作业没有继续", { code: `seerfar_web_${String(error.code).toLowerCase()}` });
}

/**
 * 录入流水线（主人 2026-10-10 拍板的找同款草稿第 1 页）。
 *
 * 主人在录入页贴拼多多 / 1688 链接，每条变成一件商品（candidate.intake）；这里的泵一件一件往下推：读货源页、用首图在 1688
 * 找同款、用首图在 Ozon 以图搜、粗算利润。三个作业就是商品页上主人手动点的那三个：同一把采集控制锁、同样的租约和收口。
 * 泵只在插件连着、版本对、采集控制空闲时排下一步，一次只排一个；停下的作业从不自动补跑，等主人点「重跑」或「接着找」。
 * 判断全在 lib/intake-pipeline.mjs，粗算在 lib/intake-rough-profit.mjs；这一段只读写记录、排作业。
 */
const INTAKE_PUMP_INTERVAL_MS = Math.max(50, Number(process.env.SELECTION_REVIEW_INTAKE_PUMP_INTERVAL_MS || 3000));
const INTAKE_PLACEHOLDER_NAME = "录入中的商品";
const INTAKE_ATTACH_MESSAGES = Object.freeze({
  intake_attach_target_eliminated: "这件已经淘汰了，先恢复再贴货源",
  intake_attach_past_gate1: "这件已经过了「做这件」，换货源请在商品页上换",
  intake_attach_supply_confirmed: "这件的供货已经确认过，不能在这里换货源",
  intake_attach_busy: "这件正在读页面或有任务在跑，等它停下再贴",
  intake_attach_has_source: "这件已经有能用的货源，或者还在找，不用再贴",
  intake_attach_duplicate: "这条货源已经在另一件商品上了"
});
const INTAKE_STEP_LABELS = Object.freeze({ capture_source: "读货源页", search_1688: "在 1688 用首图找同款", search_ozon: "在 Ozon 用首图以图搜",
  estimate: "粗算利润" });
const INTAKE_SOURCE_LABELS = Object.freeze({ pinduoduo: "拼多多", "1688": "1688" });
/** 排作业时碰上这些，只是这会儿轮不到（别的作业占着、刚好有人改了这件），下一轮再排；别的拒绝说明这一步开始不了，停下等主人。 */
const INTAKE_TRANSIENT_CODES = new Set(["revision_conflict", "candidate_busy", "capture_job_state_conflict", "image_match_in_flight",
  "ozon_match_in_flight"]);
/** 插件只领页面递过去的作业编号（src/intakeJobBridge.js）；最近这么久里有工作台页面来看过，才算有人能把编号递过去。 */
const INTAKE_BRIDGE_TTL_MS = 20 * 1000;
let intakePumpTimer = null;
let intakePumpRunning = false;
let intakePumpRequested = false;
let intakeHasOpenWork = false;
// 启动时不为录入多读一遍整份数据（数据大时会拖慢启动自检）；工作台页面第一次来看队列时，有排着的才叫醒泵。
let intakePumpPrimed = false;
let intakeBridgeSeenAt = 0;
let intakeLastStart = null;

function intakeExtensionState(timestamp = Date.now()) {
  const heartbeat = extensionHeartbeatSnapshot(timestamp);
  return { online: heartbeat.fresh && heartbeat.backgroundReady, version: heartbeat.version || null,
    requiredVersion: REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION, versionOk: heartbeat.version === REQUIRED_SOURCE_CAPTURE_EXTENSION_VERSION,
    bridge: timestamp - intakeBridgeSeenAt < INTAKE_BRIDGE_TTL_MS, captureControl: captureControlSnapshot(timestamp).status };
}

/** 录入泵排好、插件还没领的那一个作业：工作台页面拿这个编号去递开始信号。一次只有一个。 */
function intakePendingStart(candidates, timestamp = Date.now()) {
  for (const candidate of candidates) {
    const jobs = candidate.intake?.jobs;
    if (!jobs || candidate.workflowStatus === "eliminated" || candidate.gate1) continue;
    for (const [kind, captureId, sessions] of [["supplier_capture", jobs.sourceCaptureId, sourceCaptureSessions],
      ["supplier_image_match", jobs.supplierMatchId, imageMatchSessions], ["ozon_image_match", jobs.ozonMatchId, imageMatchSessions]]) {
      const session = captureId ? sessions.get(captureId) : null;
      if (session?.candidateId === candidate.id && session.jobStatus === "queued" && session.expiresAt > timestamp) {
        return { candidateId: candidate.id, captureId, kind };
      }
    }
  }
  return null;
}

function scheduleIntakePump(delayMs = 0) {
  if (intakePumpRunning) { intakePumpRequested = true; return; }
  if (intakePumpTimer) {
    if (delayMs > 0) return;
    clearTimeout(intakePumpTimer);
  }
  intakePumpTimer = setTimeout(() => { intakePumpTimer = null; void runIntakePump(); }, delayMs);
  intakePumpTimer.unref?.();
}

async function runIntakePump() {
  if (intakePumpRunning) { intakePumpRequested = true; return; }
  intakePumpRunning = true;
  intakePumpRequested = false;
  let active = false;
  let extensionReady = false;
  try {
    // 粗算、跳过 1688 这类不用插件的步骤可以一口气做完；要插件的那一步每轮最多排一个。
    for (let round = 0; round < 50; round += 1) {
      const outcome = await intakePumpStep();
      active = outcome.active;
      extensionReady = outcome.extensionReady;
      if (!outcome.progressed) break;
    }
  } catch (error) {
    console.error("录入流水线这一轮没推进成，下一轮再看", error);
    active = true;
  } finally {
    intakePumpRunning = false;
  }
  intakeHasOpenWork = active;
  if (intakePumpRequested) scheduleIntakePump(0);
  // 插件没连上时排着的都在等，不必常看；插件的下一次心跳会叫醒这里。
  else if (active) scheduleIntakePump(extensionReady ? INTAKE_PUMP_INTERVAL_MS : INTAKE_PUMP_INTERVAL_MS * 5);
}

const intakeInputsFingerprint = (candidate) => JSON.stringify([candidate.sourceCapture?.captureId ?? null, candidate.sourceCapture?.status ?? null,
  ...[candidate.supplierImageMatch, candidate.ozonImageMatch].map((record) => [record?.captureId ?? null, record?.status ?? null,
    record?.comparison?.comparedAt ?? null])]);

/** 一轮：先把每件的 stage / blocker 写回商品，再挑下一件要推进的。 */
async function intakePumpStep() {
  const extension = intakeExtensionState();
  const extensionReady = extension.online && extension.versionOk && extension.bridge && extension.captureControl === "idle";
  const round = await mutateDataWhenChanged((data) => {
    const login1688Expired = intakeLogin1688State(data.candidates) === "expired";
    let changed = false;
    for (const current of data.candidates) {
      if (!current.intake || current.workflowStatus === "eliminated" || current.gate1) continue;
      const timestamp = now();
      let touched = false;
      const update = intakeStageUpdate(current, { login1688Expired });
      if (update) {
        if (update.stage === "blocked" && current.intake.stage !== "blocked") {
          addHistory(current, "system", "intakeBlocked", `录入流水线在这一件停下：${update.blocker.message}。不会自动重跑，业务状态没有改变`, timestamp);
        }
        current.intake = { ...current.intake, ...update };
        touched = true;
      }
      // 占位的名字和图，换成货源页上读到的；主人自己改过的不动。
      const capture = current.sourceCapture;
      if (capture?.status === "captured_waiting_owner_selection" && capture.captureId === current.intake.jobs?.sourceCaptureId) {
        if (current.productName === INTAKE_PLACEHOLDER_NAME && typeof capture.title === "string" && capture.title.trim()) {
          current.productName = capture.title.trim().slice(0, 200);
          touched = true;
        }
        if (!current.imageUrl && capture.mainImageUrl) {
          current.imageUrl = capture.mainImageUrl;
          touched = true;
        }
      }
      if (touched) {
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "system";
        changed = true;
      }
    }
    const work = nextIntakeWork(data.candidates, { extensionReady });
    const open = intakeQueue(data.candidates).some(({ progress }) => progress.stage !== "blocked");
    return { changed, result: { open, work: work && { candidateId: work.candidate.id, step: work.step,
      dataRevision: Number(work.candidate.dataRevision), intake: structuredClone(work.candidate.intake) } } };
  });
  const quiet = { progressed: false, active: round.open, extensionReady };
  if (!round.work) return quiet;
  const { candidateId, step, dataRevision, intake } = round.work;
  if (step === "estimate") {
    await settleIntakeEstimate(candidateId);
    return { ...quiet, progressed: true, active: true };
  }
  if (step === "skip_1688") {
    await mutateDataWhenChanged((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current?.intake || intakeProgress(current, { login1688Expired: true })?.next !== "skip_1688") return { changed: false };
      const timestamp = now();
      current.intake = { ...current.intake, skips: { ...current.intake.skips, supplierMatch: "login_1688_required" } };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "intakeStepSkipped",
        "1688 登录过期了，这一件先不在 1688 找同款，照常往下走；主人登录 1688 后点「接着找」再补搜", timestamp);
      return { changed: true };
    });
    return { ...quiet, progressed: true, active: true };
  }
  const jobKey = { capture_source: "sourceCaptureId", search_1688: "supplierMatchId", search_ozon: "ozonMatchId" }[step];
  const stage = { capture_source: "reading_source", search_1688: "searching_1688", search_ozon: "searching_ozon" }[step];
  const onQueued = (current, session, timestamp) => {
    current.intake = { ...current.intake, stage, blocker: null, startedAt: current.intake.startedAt ?? timestamp,
      jobs: { ...current.intake.jobs, [jobKey]: session.captureId } };
    addHistory(current, "system", "intakeStepQueued", `录入流水线排到这一件：${INTAKE_STEP_LABELS[step]}（只读一次，结果回来前不排别的）`, timestamp);
  };
  try {
    if (step === "capture_source") {
      await enqueueASupplierCaptureJob({ candidateId, requestRevision: dataRevision, requestedSourceUrl: intake.sourceUrl, onQueued });
    } else {
      await enqueueImageMatchJob(step === "search_ozon" ? IMAGE_MATCH_KINDS.ozon : IMAGE_MATCH_KINDS.supplier, {
        candidateId, requestRevision: dataRevision, actor: { userId: intake.submittedBy },
        // 只有主人为这一步点过「重跑」，才算他知道上一次结果未知（商品页上的「已知道」是同一个意思）。
        acknowledgeUnknownOutcome: intake.lastRetry?.step === step,
        input: step === "search_ozon" ? { searchBy: "image" } : {}, onQueued });
    }
    return { ...quiet, active: true };
  } catch (error) {
    if (error?.extra?.captureControl || INTAKE_TRANSIENT_CODES.has(error?.extra?.code)) return { ...quiet, active: true };
    await mutateDataWhenChanged((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current?.intake || current.intake.stage === "blocked") return { changed: false };
      const timestamp = now();
      const blocker = intakeBlocker("step_not_started", { step, detail: String(error?.message || "") });
      current.intake = { ...current.intake, stage: "blocked", blocker };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "intakeBlocked", `录入流水线在这一件停下：${INTAKE_STEP_LABELS[step]}没能开始（${blocker.message}）。不会自动重跑`, timestamp);
      return { changed: true };
    });
    return { ...quiet, progressed: true, active: true };
  }
}

function intakeRoughProfitSummary(roughProfit) {
  if (roughProfit.status === "ok") return `粗算每件约赚 ¥${roughProfit.profitPerUnitRmb}`;
  if (roughProfit.status === "negative") return `粗算每件约亏 ¥${Math.abs(roughProfit.profitPerUnitRmb)}`;
  return `粗算还缺：${roughProfit.missing.join("、")}`;
}

/** 最后一步：用这件已经存下的货源、1688、Ozon 记录粗算一次，写进 candidate.roughProfit，这件就找完了。 */
async function settleIntakeEstimate(candidateId) {
  const snapshot = await readData();
  const candidate = snapshot.candidates.find((item) => item.id === candidateId);
  if (!candidate?.intake) return;
  const at = now();
  let plan = intakeRoughProfitPlan(candidate);
  const packagingRmbDefault = supplierDraftEstimateInputs.assumptions.packagingRmbDefault;
  let storeRule = null;
  try { storeRule = supplierDraftEstimateInputs.storeRule(snapshot, candidate.targetStore); }
  catch { plan = { ...plan, missing: [...plan.missing, "店铺费用规则"] }; }
  let fx = null;
  let tariffRows = [];
  let commission = null;
  if (plan.missing.length === 0) {
    [fx, { rows: tariffRows }, commission] = await Promise.all([
      supplierDraftEstimateInputs.resolveExchangeRate(snapshot, at),
      supplierDraftEstimateInputs.resolveFreightRows(),
      supplierDraftEstimateInputs.resolveCommission({ categoryPath: { cnTitlePath: plan.commissionTypeZh }, price: plan.salePrice.rub }, at)
    ]);
  }
  const roughProfit = buildIntakeRoughProfit({ plan, storeRule, fx, commission, tariffRows, packagingRmbDefault, estimatedAt: at });
  await mutateDataWhenChanged((data) => {
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current?.intake || intakeInputsFingerprint(current) !== intakeInputsFingerprint(candidate)) return { changed: false };
    if (intakeProgress(current, { login1688Expired: intakeLogin1688State(data.candidates) === "expired" })?.next !== "estimate") return { changed: false };
    const timestamp = now();
    current.roughProfit = roughProfit;
    current.intake = { ...current.intake, stage: "ready", blocker: null, finishedAt: timestamp };
    current.dataRevision = Number(current.dataRevision || 0) + 1;
    current.updatedAt = timestamp;
    current.lastModifiedBy = "system";
    addHistory(current, "system", "intakeReady", `录入流水线找完了：${intakeRoughProfitSummary(roughProfit)}。只是粗算，没有确认任何同款或货源，` +
      "业务状态没有改变，等主人点「做这件」", timestamp);
    return { changed: true };
  });
}

function intakeOwner(req, code) {
  const actor = runtimeIdentityProvider.resolveActor({ request: req });
  if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
    throw httpError(403, "请先登录主人身份。", { code });
  }
  return actor;
}

/** 「重跑」和「接着找」共用：把计划写回这一件；读货源页结果未知的，同时记下主人知道了（和 source-capture/review 一样）。 */
function applyIntakeRestart(current, plan, timestamp, detail) {
  if (plan.acknowledgeSourceUnknown) {
    current.sourceCapture = { ...current.sourceCapture, jobStatus: "failed", reviewedAt: timestamp, reviewedBy: "owner",
      acknowledgement: "no_result_received" };
    addHistory(current, "user", "aSupplierCaptureReviewed",
      "主人点「重跑」时确认上一次读货源页没有可用结果：服务端没有收到任何采集证据，业务状态没有改变；现在重新读一次", timestamp);
  }
  current.intake = plan.intake;
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "user";
  addHistory(current, "user", "intakeRestarted", detail, timestamp);
}

function intakeStillBeforeGate1(candidate) {
  return ["awaiting_user_direction", "needs_user_data"].includes(candidate.workflowStatus) && !candidate.lifecycleV11?.aConfirmationReceipt &&
    !candidate.lifecycleV11?.skuPackage && !candidate.gate1;
}

function claimImageMatchJob(captureId, extensionVersion, extensionOrigin) {
  const operation = sourceCaptureJobClaimQueue.then(async () => {
    const session = imageMatchSessions.get(captureId);
    const kind = imageMatchKindOf(session);
    if (!session || !kind || session.captureKind !== kind.captureKind) {
      throw httpError(409, "当前服务没有这次明确创建的采集作业", { code: "capture_job_not_current" });
    }
    if (session.jobStatus !== "queued" || session.attempt !== 0 || session.expiresAt <= Date.now()) {
      throw httpError(409, "该采集作业已领取、失效或结果待核实，不能再次执行", { code: "capture_job_not_claimable" });
    }
    if (String(extensionVersion) !== session.requiredExtensionVersion) {
      throw httpError(409, `本次采集要求插件v${session.requiredExtensionVersion}`, { code: "extension_version_mismatch" });
    }
    session.jobStatus = "claim_pending";
    session.attempt = 1;
    session.claimedAt = Date.now();
    session.claimedExtensionVersion = String(extensionVersion);
    session.claimedExtensionOrigin = String(extensionOrigin || "");
    clearSourceCaptureJobTimer(session.captureId);
    try {
      const claimedRevision = await mutateData((data) => {
        if (session.expiresAt <= Date.now()) throw httpError(409, "采集作业等待期限已结束", { code: "capture_job_expired" });
        const current = data.candidates.find((item) => item.id === session.candidateId);
        if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
        const record = current[kind.field];
        if (record?.captureId !== session.captureId || record.status !== "waiting_extension" ||
          record.jobStatus !== "queued" || record.attempt !== 0 || !kind.sameTarget(record, session)) {
          throw httpError(409, "当前候选不再等待该采集作业", { code: "capture_job_state_conflict" });
        }
        if (Number(current.dataRevision) !== Number(session.dataRevision)) {
          throw httpError(409, "采集作业修订号已失效", { code: "revision_conflict" });
        }
        current[kind.field] = {
          ...record,
          status: "searching",
          jobStatus: "claimed",
          attempt: 1,
          claimedAt: new Date(session.claimedAt).toISOString(),
          claimedExtensionVersion: session.claimedExtensionVersion
        };
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = now();
        current.lastModifiedBy = "system";
        return current.dataRevision;
      });
      session.dataRevision = claimedRevision;
      session.jobStatus = "claimed";
    } catch (error) {
      // A failed durable write can have an uncertain outcome. Never reopen this claim.
      session.jobStatus = "unknown_outcome";
      session.consumedAt = Date.now();
      imageMatchSessions.delete(session.captureId);
      throw error;
    }
    session.expiresAt = Date.now() + SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS;
    scheduleImageMatchJobExpiry(session, "claimed", SOURCE_CAPTURE_JOB_EXECUTION_TTL_MS);
    return { captureJob: kind.jobPayload(session), jobNotice: null };
  });
  sourceCaptureJobClaimQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/**
 * 首图指纹要的图片由服务端自己去图床取：只取公开图片、不带任何登录信息、不跟跳转（见 image-fingerprint.mjs）。
 * SELECTION_REVIEW_IMAGE_FINGERPRINT_FETCH=off 时一张也不取，每条都标「无法比对」——给不能出网的部署和离线测试用。
 */
const IMAGE_FINGERPRINT_FETCH_ENABLED = process.env.SELECTION_REVIEW_IMAGE_FINGERPRINT_FETCH !== "off";
const imageMatchComparisonsInFlight = new Set();

function supplierImageFingerprintOf(url) {
  if (!IMAGE_FINGERPRINT_FETCH_ENABLED) return Promise.reject(Object.assign(new Error("fetch_disabled"), { code: "FETCH_DISABLED" }));
  return fetchImageFingerprint(url, { timeoutMs: 10000 });
}

/** 比一次首图。同一次搜索同一时刻只比一份；比完只落到仍是这次搜索、仍在等比对的那份记录上。 */
async function runImageMatchComparison(kind, candidateId, captureId) {
  if (imageMatchComparisonsInFlight.has(captureId)) return;
  imageMatchComparisonsInFlight.add(captureId);
  try {
    const data = await readData();
    const record = data.candidates.find((item) => item.id === candidateId)?.[kind.field];
    if (record?.captureId !== captureId || record.status !== "comparing") return;
    const comparison = await kind.rules.computeComparison(record, { fingerprintOf: supplierImageFingerprintOf, comparedAt: now() });
    await mutateDataWhenChanged((latest) => {
      const current = latest.candidates.find((item) => item.id === candidateId);
      const applied = current ? kind.rules.comparisonApplied(current[kind.field], comparison) : null;
      if (!applied) return { changed: false };
      current[kind.field] = applied;
      const counts = Object.fromEntries(["identical", "similar", "different", "unknown"]
        .map((level) => [level, applied.results.filter((item) => item.similarity === level).length]));
      const timestamp = now();
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", `${kind.historyPrefix}Compared`,
        `已比对 ${kind.site} 找同款的 ${applied.results.length} 条结果的首图：首图一致 ${counts.identical} 条、很像 ${counts.similar} 条、` +
        `不像 ${counts.different} 条、无法比对 ${counts.unknown} 条；是不是同款等主人逐条判断，业务状态没有改变`, timestamp);
      return { changed: true };
    });
  } catch (error) {
    // The record stays at "comparing"; the owner's 重新比对 is the only way forward, never an automatic retry.
    console.error(`${kind.logLabel}首图比对失败`, error);
  } finally {
    imageMatchComparisonsInFlight.delete(captureId);
  }
}

function salesCaptureSession(candidateId, captureId = "") {
  purgeExpiredCaptureSessions();
  if (captureId) return salesCaptureSessions.get(captureId) || null;
  return [...salesCaptureSessions.values()].find((session) => session.candidateId === candidateId) || null;
}

function salesCaptureSessionPublic(session) {
  return {
    captureId: session.captureId,
    candidateId: session.candidateId,
    dataRevision: session.dataRevision,
    expectedProductId: session.expectedProductId,
    productUrl: session.productUrl,
    expiresAt: new Date(session.expiresAt).toISOString(),
    extensionRequest: {
      captureId: session.captureId,
      candidateId: session.candidateId,
      dataRevision: session.dataRevision,
      expectedProductId: session.expectedProductId,
      productUrl: session.productUrl
    }
  };
}

function salesCaptureTechnicalStatus(code) {
  if (["site_login_required", "site_verification_required", "permission_required", "extension_not_installed"].includes(code)) {
    return "permission_required";
  }
  if (code === "extension_background_unavailable") return "system_error";
  if (["wrong_product", "structured_data_unavailable", "precise_price_missing", "invalid_capture"].includes(code)) {
    return "data_unavailable";
  }
  return "system_error";
}

function listedSourceRecoveryAllowed(candidate) {
  return candidate.workflowStatus === "listed" &&
    candidate.listingRecord?.stateOnly === true &&
    candidate.listingPreparation?.status === "queued" &&
    candidate.sourceCapture?.status !== "verified";
}

function sourceCaptureAllowed(candidate, mode = "listing_preparation") {
  if (mode === "listed_evidence_recovery") return listedSourceRecoveryAllowed(candidate);
  if (mode === "a_supplier_capture") {
    return !candidate.lifecycleV11?.skuPackage &&
      !candidate.lifecycleV11?.aConfirmationReceipt &&
      ["awaiting_user_direction", "needs_user_data", "codex_processing"].includes(candidate.workflowStatus);
  }
  const legacyReadyPendingC = candidate.workflowStatus === "ready_to_list" &&
    !(candidate.listingPreparation?.status === "prepared" && candidate.cCompletedAt);
  if (candidate.workflowStatus !== "listing_preparation" && !legacyReadyPendingC) return false;
  return [
    "awaiting_user_start",
    "blocked",
    "needs_decision",
    "paused_user_stopped",
    "capturing_source"
  ].includes(candidate.listingHandoff?.state) || legacyReadyPendingC;
}

function evidencePackApplies(pack, candidate, timestamp = Date.now()) {
  if (!pack || pack.status !== "active") return false;
  if (pack.expiresAt && new Date(pack.expiresAt).getTime() <= timestamp) return false;
  const scope = pack.scope || {};
  if (["commission", "schema"].includes(pack.kind) && !sameStoreRef(scope.storeRef, candidate.storeRef)) return false;
  const expectedPlatform = candidate.targetStore === "wb" ? "wb" : "ozon";
  const category = String(candidate.codexReview?.category || candidate.codexReview?.productType || candidate.listingPreparation?.category || "").trim().toLowerCase();
  const salesScheme = String(candidate.codexReview?.salesScheme || candidate.listingPreparation?.salesScheme || "").trim().toLowerCase();
  const route = String(candidate.codexReview?.logistics?.route || candidate.listingPreparation?.route || "").trim().toLowerCase();
  const exactMatches = [
    [scope.platform, expectedPlatform],
    [scope.store, candidate.targetStore],
    [scope.category, category],
    [scope.salesScheme, salesScheme],
    [scope.route, route]
  ];
  return exactMatches.every(([required, actual]) =>
    !required || (actual && String(required).trim().toLowerCase() === String(actual).trim().toLowerCase())
  );
}

function attachReusableEvidence(data, candidate) {
  const packs = (data.evidencePacks || []).filter((pack) => evidencePackApplies(pack, candidate));
  const ids = new Set(Array.isArray(candidate.evidencePackIds) ? candidate.evidencePackIds.map(String) : []);
  for (const pack of packs) ids.add(pack.id);
  candidate.evidencePackIds = [...ids];
  return packs.filter((pack) => ids.has(pack.id)).map((pack) => ({
    id: pack.id,
    kind: pack.kind,
    scope: pack.scope,
    summary: pack.summary,
    sourceType: pack.sourceType,
    checkedAt: pack.checkedAt,
    expiresAt: pack.expiresAt,
    ruleVersion: pack.ruleVersion
  }));
}

function normalizeBusinessStateDocument(document) {
  const data = structuredClone(document);
  if (Number(data.meta?.version || 1) !== 2) {
    throw new Error("候选数据尚未迁移到v2");
  }
  data.rules = {
    ...DEFAULT_RULES,
    ...(data.rules || {}),
    // Saved store rules keep their own values; fields introduced later (the owner-approved cost policy template) come from the defaults.
    ozonDandanshu: { ...DEFAULT_RULES.ozonDandanshu, ...(data.rules?.ozonDandanshu || {}) },
    ozonMiska: { ...DEFAULT_RULES.ozonMiska, ...(data.rules?.ozonMiska || {}) },
    wbCrossListing: { ...DEFAULT_RULES.wbCrossListing, ...(data.rules?.wbCrossListing || {}) },
    selectionFlow: {
      ...DEFAULT_RULES.selectionFlow,
      ...(data.rules?.selectionFlow || {}),
      stageBoundaries: {
        ...DEFAULT_RULES.selectionFlow.stageBoundaries,
        ...(data.rules?.selectionFlow?.stageBoundaries || {}),
        A: {
          ...DEFAULT_RULES.selectionFlow.stageBoundaries.A,
          ...(data.rules?.selectionFlow?.stageBoundaries?.A || {})
        },
        B: {
          ...DEFAULT_RULES.selectionFlow.stageBoundaries.B,
          ...(data.rules?.selectionFlow?.stageBoundaries?.B || {})
        },
        C: {
          ...DEFAULT_RULES.selectionFlow.stageBoundaries.C,
          ...(data.rules?.selectionFlow?.stageBoundaries?.C || {})
        }
      },
      antiIdleRun: {
        ...DEFAULT_RULES.selectionFlow.antiIdleRun,
        ...(data.rules?.selectionFlow?.antiIdleRun || {})
      },
      technicalFailurePolicy: DEFAULT_RULES.selectionFlow.technicalFailurePolicy,
      retryPolicy: DEFAULT_RULES.selectionFlow.retryPolicy,
      profitInputs: DEFAULT_RULES.selectionFlow.profitInputs,
      sourcePagePurpose: DEFAULT_RULES.selectionFlow.sourcePagePurpose,
      note: DEFAULT_RULES.selectionFlow.note
    },
    dailyTargets: {
      ...DEFAULT_RULES.dailyTargets,
      ...(data.rules?.dailyTargets || {}),
      cadence: DEFAULT_RULES.dailyTargets.cadence,
      automaticAuditEnabled: false
    },
    listingPreparation: {
      ...DEFAULT_RULES.listingPreparation,
      ...(data.rules?.listingPreparation || {}),
      batchEnabled: false,
      defaultNewStock: 100,
      startPolicy: DEFAULT_RULES.listingPreparation.startPolicy,
      productionPolicy: DEFAULT_RULES.listingPreparation.productionPolicy
    },
    evidenceReuse: {
      ...DEFAULT_RULES.evidenceReuse,
      ...(data.rules?.evidenceReuse || {})
    },
    purchaseInput: {
      ...DEFAULT_RULES.purchaseInput,
      ...(data.rules?.purchaseInput || {}),
      scope: DEFAULT_RULES.purchaseInput.scope,
      domesticShippingRmb: DEFAULT_RULES.purchaseInput.domesticShippingRmb,
      componentPolicy: DEFAULT_RULES.purchaseInput.componentPolicy,
      note: DEFAULT_RULES.purchaseInput.note
    },
    ozonDandanshu: currentProfitRule(data.rules?.ozonDandanshu, DEFAULT_RULES.ozonDandanshu),
    ozonMiska: currentProfitRule(data.rules?.ozonMiska, DEFAULT_RULES.ozonMiska),
    wbCrossListing: currentProfitRule(data.rules?.wbCrossListing, DEFAULT_RULES.wbCrossListing),
    selectionDirections: {
      ...DEFAULT_RULES.selectionDirections,
      ...(data.rules?.selectionDirections || {}),
      dandanshu: {
        ...DEFAULT_RULES.selectionDirections.dandanshu,
        ...(data.rules?.selectionDirections?.dandanshu || {}),
        minimumCrossBorderShare: 0.4,
        requirePositivePurchaseSpaceBeforeSourceSearch: true,
        automaticRetryEnabled: false
      },
      miska: {
        ...DEFAULT_RULES.selectionDirections.miska,
        ...(data.rules?.selectionDirections?.miska || {}),
        automaticAdditionEnabled: false,
        pauseReason: DEFAULT_RULES.selectionDirections.miska.pauseReason,
        userSampleReviewThreshold: DEFAULT_RULES.selectionDirections.miska.userSampleReviewThreshold
      },
      note: DEFAULT_RULES.selectionDirections.note
    }
  };
  return ensureCollaborationData(data);
}

async function readData() {
  return normalizeBusinessStateDocument(await businessStateRepository.readSnapshot());
}

function mutateData(mutator) {
  return businessStateRepository.transact(async (document) => {
    const data = normalizeBusinessStateDocument(document);
    const result = await mutator(data);
    data.meta.updatedAt = now();
    data.meta.date = businessDate();
    return { changed: true, document: data, result };
  });
}

function mutateDataWhenChanged(mutator) {
  return businessStateRepository.transact(async (document) => {
    const data = normalizeBusinessStateDocument(document);
    const outcome = await mutator(data);
    if (!outcome?.changed) return { changed: false, result: outcome?.result };
    data.meta.updatedAt = now();
    data.meta.date = businessDate();
    return { changed: true, document: data, result: outcome.result };
  });
}

function dispatchPublic(dispatch) {
  if (!dispatch) return null;
  const legacyDisabled = isDisabledLegacyCDispatch(dispatch);
  return {
    ...dispatch,
    status: legacyDisabled ? "legacy_disabled" : dispatch.status,
    legacyDisabled,
    message: dispatch.message,
    pendingApproval: dispatch.pendingApproval || null
  };
}

function appendNodeReply(data, dispatch, message, status = "responded") {
  const text = String(message || "").trim();
  if (!text || dispatch.replyCommentId) return;
  const comment = {
    id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor: "codex",
    message: text,
    nodeId: dispatch.nodeId,
    scope: dispatch.scope,
    dispatchId: dispatch.id,
    replyTo: dispatch.commentId || null,
    requiresResponse: status === "needs_decision",
    status,
    at: now()
  };
  if (dispatch.scope === "workflow") {
    data.workflowComments.push(comment);
  } else {
    const candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
    if (candidate) {
      candidate.comments ||= [];
      candidate.comments.push(comment);
    }
  }
  dispatch.replyCommentId = comment.id;
}

function maintenanceProgressInput(input, { candidateRequired = false } = {}) {
  const fields = ["runId", "dataRevision", "progressType", "currentStep", "evidenceRef"];
  if (candidateRequired) fields.push("candidateId");
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(field => !fields.includes(field)) ||
      !Number.isInteger(input.dataRevision) || input.dataRevision < 0 ||
      !["step_change", "new_evidence"].includes(input.progressType) ||
      ["runId", "currentStep", ...(candidateRequired ? ["candidateId"] : [])].some(field =>
        typeof input[field] !== "string" || !input[field].trim() || input[field].length > 1000) ||
      (input.evidenceRef !== undefined && (typeof input.evidenceRef !== "string" || input.evidenceRef.length > 1000))) {
    throw httpError(400, "实质进展必须锁定运行编号、资料修订号、进展类型、当前步骤及新证据引用");
  }
  return input;
}

function applyMaintenanceProgress(candidate, dispatch, input, timestamp) {
  let next;
  try {
    next = recordCurrentMaintenanceProgress(candidate, dispatch, input, timestamp);
  } catch (error) {
    if (/MAINTENANCE_|已记录|没有实质变化|runId/.test(error.message)) throw httpError(409, error.message);
    if (/只有真实运行|实质进展必须|实质进展类型|新证据进展必须/.test(error.message)) throw httpError(400, error.message);
    throw error;
  }
  candidate[next.field] = next.activity;
  dispatch.currentStep = next.activity.currentStep;
  dispatch.lastProgressAt = next.activity.lastProgressAt;
  dispatch.lastEventAt = next.activity.lastProgressAt;
  dispatch.progressEvents = structuredClone(next.activity.progressEvents);
  candidate.updatedAt = next.activity.lastProgressAt;
  candidate.lastModifiedBy = "system";
  addHistory(candidate, "system", "progress", input.progressType === "new_evidence"
    ? `取得新证据：${input.evidenceRef.trim()}；当前步骤：${next.activity.currentStep}`
    : `执行步骤更新：${next.activity.currentStep}`, timestamp);
}

async function postLocalDispatchResult(pathname, payload) {
  const response = await fetch(`${localHttpOrigin(host, port)}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-selection-review-internal-token": internalApiRequestToken
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(body?.error || body?.message || text || `本机回写失败（HTTP ${response.status}）`);
  }
  return body;
}

function maintenanceCompletionInput(input) {
  const fields = ["runId", "status", "reply", "evidence"];
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(field => !fields.includes(field)) ||
      !["completed", "blocked", "needs_decision"].includes(input.status) ||
      ["runId", "reply"].some(field => typeof input[field] !== "string" || !input[field].trim() || input[field].length > 12000) ||
      (input.evidence !== undefined && (typeof input.evidence !== "string" || input.evidence.length > 12000))) {
    throw httpError(400, "收口派发必须只包含运行编号、状态、回复及证据说明");
  }
  return input;
}

function maintenanceCompletionBinding(data, dispatchId) {
  const dispatch = data.dispatches.find(item => item.id === dispatchId);
  const active = dispatch && activeDispatchForCandidate(data, dispatch.candidateId);
  if (!active || active.id !== dispatchId) throw httpError(409, "该派发不是本次正式领取的有效任务");
  return Object.freeze({ dispatchId, candidateId: dispatch.candidateId, runId: dispatch.runId,
    turnId: dispatch.turnId, dataRevision: dispatch.dataRevision, workflowStatusAtDispatch: dispatch.workflowStatusAtDispatch });
}

function assertCurrentMaintenanceWrite(data, candidateId, runId) {
  const active = activeDispatchForCandidate(data, candidateId);
  if (!active || active.runId !== runId) throw httpError(409, "结构化结果不属于当前正式领取的任务");
}

function completeCurrentMaintenanceDispatch(data, dispatchId, input, { sourceBinding = null, structuredResultApplied = false } = {}) {
  const dispatch = data.dispatches.find(item => item.id === dispatchId);
  if (!dispatch) throw httpError(404, "一次性派发不存在");
  const binding = sourceBinding || maintenanceCompletionBinding(data, dispatchId);
  if (!currentMaintenanceDispatchIds.has(dispatchId) || binding.dispatchId !== dispatchId ||
      binding.candidateId !== dispatch.candidateId || binding.runId !== dispatch.runId || binding.turnId !== dispatch.turnId ||
      binding.dataRevision !== dispatch.dataRevision || binding.workflowStatusAtDispatch !== dispatch.workflowStatusAtDispatch ||
      dispatch.runId !== input.runId.trim() || dispatch.runId !== dispatch.turnId ||
      !["running", "permission_required"].includes(dispatch.status)) {
    throw httpError(409, "只能收口本次进程中同一运行编号的派发");
  }
  const candidate = data.candidates.find(item => item.id === dispatch.candidateId);
  if (!candidate) throw httpError(404, "派发对应商品不存在");
  const timestamp = now();
  const finalStatus = input.status === "completed" && !structuredResultApplied ? "responded_unverified" : input.status;
  const candidateStillBound = candidate.dataRevision === binding.dataRevision &&
    candidate.workflowStatus === binding.workflowStatusAtDispatch &&
    activeDispatchForCandidate(data, candidate.id)?.id === dispatchId;
  // A successful domain write already owns its candidate transition. A late
  // completion may settle this dispatch, but cannot alter the newer candidate.
  if (!structuredResultApplied && candidateStillBound) {
    const needsDecision = finalStatus === "needs_decision";
    const needsCommissionDecision = needsDecision && candidate.workflowStatus === "codex_processing" &&
      /估算佣金|佣金.*授权|允许.*佣金/.test(input.reply);
    const message = finalStatus === "responded_unverified" ? "负责人已回复，但没有服务端验证并保存的结构化业务结果" : input.reply.trim();
    const recoveryDecision = fixedRecoveryDecision(needsDecision ? "business_decision" : "result_unverified", message,
      needsCommissionDecision ? ["allow_estimated_commission", "keep_stopped"] : ["retry_current_stage_once", "keep_stopped"]);
    if (["listing_preparation", "ready_to_list"].includes(candidate.workflowStatus) && candidate.listingHandoff?.runId === binding.runId) {
      candidate.listingHandoff = { ...candidate.listingHandoff, state: needsDecision ? "needs_decision" : "blocked",
        runId: null, currentStep: "任务已停止，等待核对结果", lastProgressAt: timestamp,
        blockReason: message, userAction: "请在UI选择固定处理方式", recoveryDecision, stoppedAt: timestamp };
    } else if (candidate.processing?.runId === binding.runId) {
      candidate.processing = { ...queuedProcessing(candidate.processing), state: "blocked", runId: null, startedAt: null,
        currentStep: "任务已停止，等待核对结果", lastRunId: binding.runId, lastProgressAt: timestamp,
        dispatchState: finalStatus, manualHold: true, blockReason: message, userAction: "请在UI选择固定处理方式", recoveryDecision };
    }
    candidate.updatedAt = timestamp;
    candidate.lastModifiedBy = dispatch.assigneeRole;
    addHistory(candidate, "system", "oneShotCompleted", `一次性派发${finalStatus}：${input.reply.trim()}`, timestamp);
    appendNodeReply(data, dispatch, input.reply.trim(), needsDecision ? "needs_decision" : "responded");
  }
  dispatch.status = finalStatus;
  dispatch.agentReply = input.reply.trim();
  dispatch.completionEvidence = String(input.evidence || "").trim();
  dispatch.completedAt = timestamp;
  dispatch.lastEventAt = timestamp;
  dispatch.pendingApproval = null;
  return { dispatch: dispatchPublic(dispatch), candidate: publicCandidate(candidate, data.rules) };
}

async function applyStructuredDispatchResult(dispatchId) {
  const data = await readData();
  const dispatch = data.dispatches.find(item => item.id === dispatchId);
  const result = dispatch?.structuredResult;
  if (!dispatch || !result) return false;
  if (!["running", "permission_required"].includes(dispatch.status)) return true;
  const sourceBinding = maintenanceCompletionBinding(data, dispatchId);
  let resultPayload = null;
  if (result.resultJson) {
    try { resultPayload = JSON.parse(result.resultJson); }
    catch { throw new Error("负责人返回的业务结果JSON无法解析"); }
  }
  let structuredResultApplied = false;
  if (result.resultType === "selection_review") {
    if (result.status !== "completed" || !resultPayload || typeof resultPayload !== "object" || Array.isArray(resultPayload)) {
      throw new Error("选品业务回写缺少完整selection_review结果");
    }
    await postLocalDispatchResult(`/api/candidates/${encodeURIComponent(dispatch.candidateId)}/codex-review`, {
      ...resultPayload, dataRevision: sourceBinding.dataRevision, runId: sourceBinding.runId
    });
    structuredResultApplied = true;
  } else if (result.resultType === "listing_preparation_review") {
    if (!resultPayload || typeof resultPayload !== "object" || Array.isArray(resultPayload)) {
      throw new Error("C阶段业务回写缺少listing_preparation_review结果");
    }
    const expectedCaptureId = dispatch.candidateSnapshot?.sourceCapture?.captureId || null;
    if (expectedCaptureId && resultPayload.sourceCaptureId !== expectedCaptureId) throw new Error("C阶段结果没有带回本轮1688采集编号，不能验收");
    await postLocalDispatchResult(`/api/candidates/${encodeURIComponent(dispatch.candidateId)}/listing-preparation-review`, {
      ...resultPayload, status: resultPayload.status || (result.status === "completed" ? "prepared" : result.status),
      reason: resultPayload.reason || (result.status === "completed" ? "" : result.reply),
      dataRevision: sourceBinding.dataRevision, runId: sourceBinding.runId
    });
    structuredResultApplied = true;
  }
  const input = maintenanceCompletionInput({ runId: sourceBinding.runId, status: result.status, reply: result.reply,
    evidence: result.evidenceSummary || "" });
  await mutateData(current => completeCurrentMaintenanceDispatch(current, dispatchId, input, { sourceBinding, structuredResultApplied }));
  return true;
}

async function handleDispatcherEvent(event) {
  if (event.type === "assistant_delta") return;
  if (event.type === "assignee_available") {
    setTimeout(() => deliverDispatch(event.dispatchId).catch((error) => console.error("负责人空闲后派发失败", error)), 0);
    return;
  }
  if (event.type === "turn_completed") {
    try {
      await applyStructuredDispatchResult(event.dispatchId);
    } catch (error) {
      event.error = `结构化回传处理失败：${error.message}`;
    }
  }
  await mutateDataWhenChanged((data) => {
    const dispatch = (data.dispatches || []).find((item) => item.id === event.dispatchId);
    if (!dispatch) return { changed: false };
    const timestamp = now();
    if (event.type === "approval") {
      dispatch.status = "permission_required";
      dispatch.pendingApproval = event.approval;
      dispatch.lastEventAt = timestamp;
    } else if (event.type === "assistant_message") {
      dispatch.agentReply = event.text;
      dispatch.structuredResult = event.structuredResult || null;
      dispatch.lastEventAt = timestamp;
    } else if (event.type === "turn_completed") {
      dispatch.turnCompletedAt = timestamp;
      dispatch.turnStatus = event.status;
      dispatch.error = event.error || dispatch.error || "";
      if (!["completed", "blocked", "needs_decision"].includes(dispatch.status)) {
        dispatch.status = event.error ? "failed" : "responded_unverified";
        dispatch.failureLayer = event.error ? "codex_turn" : "missing_business_readback";
      }
      const candidate = dispatch.candidateId
        ? data.candidates.find((item) => item.id === dispatch.candidateId)
        : null;
      if (
        candidate?.workflowStatus === "codex_processing" &&
        candidate.processing?.runId === dispatch.runId &&
        Number(candidate.dataRevision) === Number(dispatch.dataRevision) &&
        candidate.workflowStatus === dispatch.workflowStatusAtDispatch
      ) {
        candidate.processing = {
          ...queuedProcessing(candidate.processing),
          state: "blocked",
          runId: null,
          startedAt: null,
          currentStep: event.error ? "派发任务失败，已停止" : "任务已回复，结果未验证",
          lastRunId: dispatch.runId,
          lastProgressAt: timestamp,
          dispatchState: dispatch.status,
          manualHold: true,
          blockReason: event.error
            ? `派发任务失败：${event.error}`
            : "负责人任务已回复，但没有共享数据回写或独立证据",
          userAction: "请在主界面选择固定处理方式",
          recoveryDecision: fixedRecoveryDecision(
            event.error ? "external_failure" : "result_unverified",
            event.error
              ? `派发任务失败：${event.error}`
              : "负责人已经回复，但系统没有取得可验收的结构化结果。",
            ["retry_current_stage_once", "keep_stopped"]
          )
        };
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = dispatch.assigneeRole;
      } else if (
        ["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus) &&
        candidate.listingHandoff?.runId === dispatch.runId &&
        candidate.dataRevision === dispatch.dataRevision &&
        candidate.workflowStatus === dispatch.workflowStatusAtDispatch
      ) {
        candidate.listingHandoff = {
          ...(candidate.listingHandoff || {}),
          state: "blocked",
          runId: null,
          currentStep: event.error ? "负责人任务派发失败，已停止" : "负责人任务已回复，结果未验证",
          blockReason: event.error || "缺少共享数据回写或独立证据",
          recoveryDecision: fixedRecoveryDecision(
            event.error ? "external_failure" : "result_unverified",
            event.error || "负责人已经回复，但系统没有取得可验收的结构化结果。",
            ["retry_current_stage_once", "keep_stopped"]
          ),
          stoppedAt: timestamp
        };
        candidate.updatedAt = timestamp;
      }
      if (!candidate || candidate.dataRevision === dispatch.dataRevision && candidate.workflowStatus === dispatch.workflowStatusAtDispatch) {
        appendNodeReply(
          data,
          dispatch,
          dispatch.agentReply || (event.error ? `任务失败：${event.error}` : "任务已回复，但没有取得可验证的数据回写。"),
          dispatch.status === "needs_decision" ? "needs_decision" : "responded"
        );
      }
    } else {
      return { changed: false };
    }
    return { changed: true, result: dispatchPublic(dispatch) };
  });
}

const codexDispatcher = explicitDispatchDeliveryEnabled
  ? new CodexDispatcher({ onEvent: (event) => handleDispatcherEvent(event), skillCatalog: dispatchSkillCatalog })
  : null;

async function deliverDispatch(dispatchId) {
  if (dispatchDeliveriesInFlight.has(dispatchId)) return null;
  const snapshot = await readData();
  const queuedDispatch = snapshot.dispatches.find((item) => item.id === dispatchId);
  if (isDisabledLegacyCDispatch(queuedDispatch)) return null;
  if (!queuedDispatch || !["queued", "waiting_assignee"].includes(queuedDispatch.status)) return null;
  const delivery = {
    dispatch: { ...queuedDispatch },
    route: { ...snapshot.taskRoutes[queuedDispatch.assigneeRole] },
    candidate: queuedDispatch.candidateId ? snapshot.candidates.find((item) => item.id === queuedDispatch.candidateId) : null
  };
  const gate = delivery.candidate ? codexDispatchGate(delivery.candidate) : null;
  if (delivery.candidate && !gate.allowed) return null;
  if (delivery.candidate) {
    assertRuntimeCodexDependencyAllowed({
      codexOffline: codexOfflineEnabled,
      pathType: gate.mode === "exception" ? EXCEPTION_MAINTENANCE_PATH : NORMAL_PRODUCTION_PATH,
      skuPackageId: delivery.candidate.lifecycleV11?.skuPackage?.skuPackageId || `candidate:${delivery.candidate.id}`,
      dependencyType: "dispatch",
      evidenceRef: `dispatch:${delivery.dispatch.id}`
    });
  }
  if (!codexDispatcher) return null;
  dispatchDeliveriesInFlight.add(dispatchId);

  const map = await readWorkflowMap(workflowMapFile);
  const node = map.nodes.find((item) => item.id === delivery.dispatch.nodeId);
  try {
    const outcome = await codexDispatcher.deliver(delivery.dispatch, delivery.route, node, delivery.candidate);
    const savedDelivery = await mutateDataWhenChanged((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchId);
      if (!dispatch || !["queued", "waiting_assignee"].includes(dispatch.status)) return { changed: false, result: null };
      if (
        outcome.status === "waiting_assignee" &&
        dispatch.status === "waiting_assignee" &&
        dispatch.deliveryDetail === (outcome.detail || "")
      ) return { changed: false, result: dispatchPublic(dispatch) };
      dispatch.status = outcome.status;
      dispatch.turnId = outcome.turnId || null;
      dispatch.runId = outcome.turnId || null;
      dispatch.deliveryDetail = outcome.detail || "";
      dispatch.attachedSkills = Array.isArray(outcome.attachedSkills) ? outcome.attachedSkills : [];
      const timestamp = now();
      dispatch.skillsAttachedAt = outcome.status === "running" ? timestamp : null;
      dispatch.deliveredAt = outcome.status === "running" ? timestamp : null;
      dispatch.startedAt = outcome.status === "running" ? timestamp : null;
      dispatch.lastEventAt = timestamp;
      const candidate = dispatch.candidateId
        ? data.candidates.find((item) => item.id === dispatch.candidateId)
        : null;
      if (outcome.status === "running" && candidate?.executionRuntime?.exceptionCase?.schemaVersion === "exception-case-v2" && gate?.exceptionId) {
        candidate.executionRuntime = recordExceptionMaintenanceStarted(candidate.executionRuntime, {
          exceptionId: gate.exceptionId,
          turnId: outcome.turnId,
          at: timestamp
        });
      }
      if (outcome.status === "blocked") {
        dispatch.failureLayer = outcome.failureLayer || "codex_dispatch";
        dispatch.error = outcome.detail || "负责人任务派发已停止";
        if (candidate?.workflowStatus === "codex_processing") {
          candidate.processing = {
            ...queuedProcessing(candidate.processing),
            state: "blocked",
            runId: null,
            startedAt: null,
            currentStep: "负责人任务写入锁被占用，派发已停止",
            dispatchState: "blocked",
            manualHold: true,
            blockReason: dispatch.error,
            userAction: "先释放对应Codex任务的其他写入连接，再从UI只重试当前SKU一次",
            stoppedAt: timestamp,
            stopReason: dispatch.failureLayer
          };
          candidate.updatedAt = timestamp;
          candidate.lastModifiedBy = "system";
        } else if (["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus)) {
          candidate.listingHandoff = {
            ...(candidate.listingHandoff || {}),
            state: "blocked",
            runId: null,
            currentStep: "上架任务写入锁被占用，C阶段派发已停止",
            blockReason: dispatch.error,
            userAction: "先释放上架任务的其他写入连接，再从UI只重试当前SKU一次",
            stoppedAt: timestamp,
            failureLayer: dispatch.failureLayer
          };
          candidate.updatedAt = timestamp;
          candidate.lastModifiedBy = "system";
        }
      } else if (outcome.status === "running" && candidate?.workflowStatus === "codex_processing") {
        candidate.processing = {
          ...queuedProcessing(candidate.processing),
          state: "running",
          runId: outcome.turnId,
          startedAt: timestamp,
          claimRevision: Number(candidate.dataRevision),
          currentStep: "负责人任务已启动",
          lastProgressAt: timestamp,
          dispatchState: "claimed",
          manualHold: false,
          blockReason: null,
          userAction: ""
        };
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = dispatch.assigneeRole;
        addHistory(candidate, "system", "oneShotTurnStarted", `一次性派发已取得真实运行编号：${outcome.turnId}`, timestamp);
      } else if (outcome.status === "running" && ["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus)) {
        candidate.listingHandoff = {
          ...(candidate.listingHandoff || {}),
          state: "running",
          owner: dispatch.assigneeRole,
          runId: outcome.turnId,
          startedAt: timestamp,
          claimRevision: candidate.dataRevision,
          lastProgressAt: timestamp,
          progressEvents: [],
          currentStep: dispatch.nodeId === "M07" ? "上架任务已开始C阶段" : "上架负责人任务已启动",
          requiredSkills: dispatch.requiredSkills || [],
          attachedSkills: dispatch.attachedSkills,
          skillsAttachedAt: dispatch.skillsAttachedAt,
          sourceCaptureId: dispatch.capabilityPlan?.sourceCapture?.captureId || null
        };
        candidate.updatedAt = timestamp;
      }
      const route = data.taskRoutes[dispatch.assigneeRole];
      route.status = outcome.status === "blocked" ? "failed" : "verified";
      route.verifiedAt = now();
      route.lastError = outcome.status === "blocked" ? dispatch.error : "";
      return { changed: true, result: dispatchPublic(dispatch) };
    });
    if (gate?.mode === "exception" && savedDelivery?.status === "running") currentMaintenanceDispatchIds.add(dispatchId);
    return savedDelivery;
  } catch (error) {
    return mutateDataWhenChanged((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchId);
      if (!dispatch || !["queued", "waiting_assignee"].includes(dispatch.status)) return { changed: false, result: null };
      const timestamp = now();
      const assigneeBusy = /active writer|already has an active writer|负责人正在处理/i.test(String(error.message || ""));
      if (assigneeBusy) {
        const detail = "负责人任务存在未结束轮次，结束后系统再领取";
        if (dispatch.status === "waiting_assignee" && dispatch.deliveryDetail === detail) {
          return { changed: false, result: dispatchPublic(dispatch) };
        }
        dispatch.status = "waiting_assignee";
        dispatch.lastEventAt = timestamp;
        dispatch.failureLayer = "";
        dispatch.error = "";
        dispatch.deliveryDetail = detail;
        const candidate = dispatch.candidateId
          ? data.candidates.find((item) => item.id === dispatch.candidateId)
          : null;
        if (candidate?.workflowStatus === "codex_processing") {
          candidate.processing = {
            ...queuedProcessing(candidate.processing),
            state: "queued",
            runId: null,
            startedAt: null,
            currentStep: "等待选品负责人空闲",
            dispatchState: "waiting_assignee",
            manualHold: false,
            blockReason: null,
            userAction: ""
          };
          candidate.updatedAt = timestamp;
        } else if (["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus)) {
          candidate.listingHandoff = {
            ...(candidate.listingHandoff || {}),
            state: "queued",
            runId: null,
            currentStep: dispatch.assigneeRole === "listing_task" ? "等待上架负责人空闲" : "等待选品负责人空闲",
            blockReason: null
          };
          candidate.updatedAt = timestamp;
        }
        return { changed: true, result: dispatchPublic(dispatch) };
      }
      dispatch.status = "failed";
      dispatch.lastEventAt = timestamp;
      dispatch.failureLayer = "codex_app_server";
      dispatch.error = error.message;
      const candidate = dispatch.candidateId
        ? data.candidates.find((item) => item.id === dispatch.candidateId)
        : null;
      if (
        candidate?.workflowStatus === "codex_processing" &&
        Number(candidate.dataRevision) === Number(dispatch.dataRevision)
      ) {
        candidate.processing = {
          ...queuedProcessing(candidate.processing),
          state: "blocked",
          runId: null,
          startedAt: null,
          currentStep: "一次性派发失败，已停止",
          dispatchState: "failed",
          manualHold: true,
          blockReason: `派发失败层 codex_app_server：${error.message}`,
          userAction: "可在UI选择是否只重试当前阶段一次",
          recoveryDecision: fixedRecoveryDecision(
            "external_failure",
            `派发失败层 codex_app_server：${error.message}`,
            ["retry_current_stage_once", "keep_stopped"]
          ),
          stoppedAt: timestamp,
          stopReason: "codex_app_server"
        };
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = "system";
      } else if (["listing_preparation", "ready_to_list"].includes(candidate?.workflowStatus)) {
        candidate.listingHandoff = {
          ...(candidate.listingHandoff || {}),
          state: "blocked",
          runId: null,
          blockReason: `派发失败层 codex_app_server：${error.message}`,
          stoppedAt: timestamp
        };
        candidate.updatedAt = timestamp;
      }
      const route = data.taskRoutes[dispatch.assigneeRole];
      route.status = "failed";
      route.lastError = error.message;
      return { changed: true, result: dispatchPublic(dispatch) };
    });
  } finally {
    dispatchDeliveriesInFlight.delete(dispatchId);
  }
}

function createDispatchRecord(data, { node, scope, candidate = null, message, commentId = null, trigger = "node_comment" }) {
  if (candidate) {
    const gate = codexDispatchGate(candidate);
    if (!gate.allowed) throw httpError(409, gate.reason);
    assertRuntimeCodexDependencyAllowed({
      codexOffline: codexOfflineEnabled,
      pathType: gate.mode === "exception" ? EXCEPTION_MAINTENANCE_PATH : NORMAL_PRODUCTION_PATH,
      skuPackageId: candidate.lifecycleV11?.skuPackage?.skuPackageId || `candidate:${candidate.id}`,
      dependencyType: "dispatch",
      evidenceRef: `candidate-dispatch:${candidate.id}:${candidate.dataRevision}`
    });
  }
  const assigneeRole = dispatchOwnerForNode(node, scope);
  if (candidate && assigneeRole === "control_task") {
    throw httpError(409, "当前SKU必须直接派给最终选品或上架负责人，不能绕到总控任务");
  }
  const duplicate = (data.dispatches || []).find((item) =>
    item.scope === scope &&
    (candidate
      ? item.candidateId === candidate.id
      : item.nodeId === node.id && item.candidateId === null) &&
    ACTIVE_DISPATCH_STATES.has(item.status) &&
    !isDisabledLegacyCDispatch(item)
  );
  if (duplicate) throw httpError(409, "该节点已有一次工作正在等待或执行，不能重复派发", { dispatchId: duplicate.id });
  const timestamp = now();
  const reusableEvidencePacks = candidate ? attachReusableEvidence(data, candidate) : [];
  const capabilityPlan = candidate ? dispatchCapabilityPlan(node, candidate, dispatchSkillCatalog) : null;
  const requiredSkills = candidate ? requiredSkillsForDispatch(node, candidate, dispatchSkillCatalog) : [];
  const dispatch = {
    id: `D-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scope,
    nodeId: node.id,
    nodeTitle: node.title,
    candidateId: candidate?.id || null,
    dataRevision: candidate ? Number(candidate.dataRevision) : null,
    candidateSnapshot: candidate ? dispatchCandidateSnapshot(candidate) : null,
    reusableEvidencePacks,
    capabilityPlan,
    requiredSkills: requiredSkills.map((skill) => ({ name: skill.name, path: skill.path })),
    attachedSkills: [],
    skillsAttachedAt: null,
    workflowStatusAtDispatch: candidate?.workflowStatus || null,
    assigneeRole,
    assigneeThreadId: data.taskRoutes?.[assigneeRole]?.threadId || null,
    assigneeTitle: data.taskRoutes?.[assigneeRole]?.title || node.owner,
    message: String(message || "").trim(),
    commentId,
    trigger,
    status: "queued",
    runId: null,
    turnId: null,
    createdAt: timestamp,
    lastEventAt: timestamp,
    pendingApproval: null,
    agentReply: "",
    completionEvidence: "",
    productionAuthorized: false
  };
  data.dispatches.push(dispatch);
  return dispatch;
}

function createCandidateDispatch(data, map, candidate, {
  nodeId,
  message,
  trigger,
  actor = "system"
}) {
  const node = map.nodes.find((item) => item.id === nodeId);
  validateNodeExecution(node, "candidate", candidate);
  const timestamp = now();
  const comment = {
    id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor,
    message,
    nodeId: node.id,
    scope: "candidate",
    dispatchId: null,
    requiresResponse: true,
    status: "pending",
    replyTo: null,
    at: timestamp
  };
  candidate.comments ||= [];
  candidate.comments.push(comment);
  const dispatch = createDispatchRecord(data, {
    node,
    scope: "candidate",
    candidate,
    message,
    commentId: comment.id,
    trigger
  });
  comment.dispatchId = dispatch.id;
  return dispatch;
}

function appendControlAlert(data, alert) {
  data.controlAlerts ||= [];
  if (data.controlAlerts.some((item) => item.dedupeKey === alert.dedupeKey)) return false;
  data.controlAlerts.push(alert);
  return true;
}

function cleanUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const parsed = new URL(value.trim());
    parsed.hash = "";
    const kept = new URLSearchParams();
    for (const key of ["offerId", "hotSaleSkuId", "sku", "skuId", "product_id"]) {
      if (parsed.searchParams.has(key)) kept.set(key, parsed.searchParams.get(key));
    }
    parsed.search = kept.toString();
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function candidateLinks(candidate) {
  return [candidate.productUrl, candidate.sourceUrl, candidate.competitorUrl]
    .map(cleanUrl)
    .filter(Boolean);
}

function duplicateCandidate(candidates, links, exceptId = "") {
  const requested = new Set(links.map(cleanUrl).filter(Boolean));
  if (!requested.size) return null;
  return candidates.find(
    (candidate) =>
      candidate.id !== exceptId &&
      candidateLinks(candidate).some((link) => requested.has(link))
  );
}

function nextCandidateId(candidates, prefix) {
  const date = businessDate().replaceAll("-", "");
  const base = `${prefix}-${date}-`;
  const highest = candidates.reduce((maximum, candidate) => {
    if (!candidate.id.startsWith(base)) return maximum;
    return Math.max(maximum, Number(candidate.id.slice(base.length)) || 0);
  }, 0);
  return `${base}${String(highest + 1).padStart(3, "0")}`;
}

function addHistory(candidate, actor, action, detail, at = now()) {
  candidate.history ||= [];
  candidate.history.push({
    id: `H-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor,
    action,
    detail,
    at
  });
}


function capturedSkuLabel(sku) {
  const attributes = Object.entries(sku?.attributes || {}).map(([key, value]) => `${key}:${value}`).join(" · ");
  return [sku?.sourceSkuId, attributes || sku?.propPath].filter(Boolean).join(" · ");
}

function markSourceCaptureFailure(current, session, code, detail = "", observedAt = now(), failureDiagnostics = null) {
  const failureDestinationLabel = sourceCaptureFailureDestinationLabel(failureDiagnostics, code);
  const reason = sourceCaptureFailureMessage(code, failureDestinationLabel || detail, supplierCapturePlatform(session.sourceUrl) || "1688");
  // This rewrites sourceCapture whole, so a late closure on the record the owner already reviewed would erase that
  // review and let previous_capture_requires_review block the product again — the very dead end of 2026-09-11. Only a
  // rewrite of the same captureId can concern that record, and the owner's own acknowledgement survives it.
  const ownerReview = current.sourceCapture?.captureId === session.captureId && current.sourceCapture?.reviewedAt
    ? {
      reviewedAt: current.sourceCapture.reviewedAt,
      reviewedBy: current.sourceCapture.reviewedBy,
      acknowledgement: current.sourceCapture.acknowledgement
    }
    : {};
  current.sourceCapture = {
    captureId: session.captureId,
    status: "failed",
    offerId: session.expectedOfferId,
    sourceUrl: session.sourceUrl,
    originalSourceUrl: session.originalSourceUrl,
    observedAt,
    failureCode: code,
    failureLayer: "source_page_extension_capture",
    failureDiagnostics: failureDiagnostics ? structuredClone(failureDiagnostics) : null,
    failureDestinationLabel,
    reason,
    mode: session.mode,
    jobId: session.jobStatus ? session.captureId : null,
    jobStatus: code === "unknown_outcome" ? "unknown_outcome" : session.jobStatus ? "failed" : null,
    technicalStatus: code === "unknown_outcome" ? "unknown_outcome" : "failed",
    attempt: Number(session.attempt || 0),
    requiredExtensionVersion: session.requiredExtensionVersion || null,
    writeOccurred: false,
    ...ownerReview
  };
  if (session.mode === "a_supplier_capture") {
    current.dataRevision = Number(current.dataRevision || 0) + 1;
    current.updatedAt = now();
    current.lastModifiedBy = "system";
    addHistory(current, "system", "aSupplierCaptureStopped", `${reason}；A阶段业务状态保持不变，没有选择SKU、确认供应方案、运行B/C1或派发任务`, observedAt);
    return;
  }
  if (session.mode === "listed_evidence_recovery") {
    current.dataRevision = Number(current.dataRevision || 0) + 1;
    current.updatedAt = now();
    current.lastModifiedBy = "system";
    addHistory(current, "system", "listedSourceCaptureStopped", `${reason}；已上架记录保持不变，没有派发任务或产生店铺写入`, observedAt);
    return;
  }
  current.workflowStatus = "listing_preparation";
  current.listingPreparation = {
    ...(current.listingPreparation || {}),
    status: "blocked",
    sourceCaptureId: session.captureId,
    failureLayer: "source_page_extension_capture",
    reason,
    stoppedAt: now(),
    writeOccurred: false
  };
  current.listingHandoff = {
    ...(current.listingHandoff || {}),
    state: "blocked",
    owner: "listing_task",
    runId: null,
    currentStep: "1688采集已停止",
    blockReason: reason,
    userAction: "处理页面问题后，可在评审台重新采集当前SKU一次",
    stoppedAt: now(),
    defaultStock: 100
  };
  current.processing = { ...queuedProcessing(current.processing), state: "idle" };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = now();
  current.lastModifiedBy = "system";
  addHistory(current, "system", "sourceCaptureStopped", `${reason}；没有派发任务或产生店铺写入`, observedAt);
}

function markAStageCaptureNeedsOwnerSelection(current, session, evidence) {
  const timestamp = now();
  current.sourceUrl = evidence.sourceUrl;
  current.sourceCapture = {
    captureId: session.captureId,
    status: "captured_waiting_owner_selection",
    mode: "a_supplier_capture",
    jobId: session.captureId,
    jobStatus: "completed",
    attempt: Number(session.attempt || 1),
    requiredExtensionVersion: session.requiredExtensionVersion || null,
    originalSourceUrl: session.originalSourceUrl,
    sourceUrl: evidence.sourceUrl,
    offerId: evidence.offerId,
    title: evidence.title,
    offerStatus: evidence.offerStatus,
    observedAt: evidence.observedAt,
    collectionMethod: evidence.collectionMethod,
    titleSource: evidence.titleSource,
    offerIdSource: evidence.offerIdSource,
    pageSelectedSkuId: evidence.pageSelectedSkuId,
    mainImageUrl: evidence.mainImageUrl,
    mainImageSource: evidence.mainImageSource,
    priceRanges: evidence.priceRanges,
    pageFields: evidence.pageFields,
    supplierAttributes: evidence.supplierAttributes,
    skuChoices: evidence.skus,
    selectedSkuIds: [],
    ownerSupplyConfirmed: false,
    suggestedSkuIds: [],
    matchTerms: [],
    writeOccurred: false,
    businessStateEffect: "unchanged"
  };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "system";
  addHistory(current, "system", "aSupplierCaptureCompleted", `已取得${supplierPlatformLabel(supplierCapturePlatform(evidence.sourceUrl))}精确链接offer/${evidence.offerId}及${evidence.skus.length}个真实SKU；等待主人多选，未自动选择、确认供应方案、运行B/C1或派发任务`, timestamp);
}

function markSourceCaptureNeedsSelection(current, session, evidence, resolution) {
  const timestamp = now();
  current.sourceCapture = {
    captureId: session.captureId,
    status: "needs_sku_selection",
    offerId: evidence.offerId,
    sourceUrl: evidence.sourceUrl,
    title: evidence.title,
    observedAt: evidence.observedAt,
    collectionMethod: evidence.collectionMethod,
    titleSource: evidence.titleSource,
    offerIdSource: evidence.offerIdSource,
    mode: session.mode,
    priceRanges: evidence.priceRanges,
    supplierAttributes: evidence.supplierAttributes,
    matchTerms: resolution.matchTerms || [],
    suggestedSkuIds: (resolution.matches || []).map((sku) => sku.sourceSkuId),
    skuChoices: resolution.choices
  };
  if (session.mode === "listed_evidence_recovery") {
    current.dataRevision = Number(current.dataRevision || 0) + 1;
    current.updatedAt = timestamp;
    current.lastModifiedBy = "system";
    addHistory(current, "system", "listedSourceCaptureNeedsSkuSelection", "已取得1688全部SKU；已上架记录保持不变，等待主人选择准确规格", timestamp);
    return;
  }
  current.workflowStatus = "listing_preparation";
  current.listingPreparation = {
    ...(current.listingPreparation || {}),
    status: "needs_decision",
    sourceCaptureId: session.captureId,
    reason: sourceCaptureFailureMessage("sku_ambiguous")
  };
  current.listingHandoff = {
    ...(current.listingHandoff || {}),
    state: "needs_decision",
    owner: "listing_task",
    runId: null,
    currentStep: "已取得1688全部SKU，等待主人选择一个或多个规格",
    blockReason: sourceCaptureFailureMessage("sku_ambiguous"),
    userAction: "请在评审台勾选本次要采购的一个或多个SKU",
    defaultStock: 100
  };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "system";
  addHistory(current, "system", "sourceCaptureNeedsSkuSelection", "1688结构化数据已取得；目标规格未唯一匹配，因此没有派发任务", timestamp);
}

function saveListedSourceEvidence(current, evidence, resolution) {
  const timestamp = now();
  const selectedSkus = resolution.selected;
  const missingDirectPriceSkuIds = resolution.missingDirectPriceSkuIds || [];
  current.sourceCapture = {
    ...(current.sourceCapture || {}),
    status: "verified",
    mode: "listed_evidence_recovery",
    selectedSkus,
    missingDirectPriceSkuIds,
    skuChoices: undefined,
    suggestedSkuIds: undefined,
    verifiedAt: timestamp,
    writeOccurred: false
  };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "user";
  const selectedText = selectedSkus.map(capturedSkuLabel).join("；");
  const priceGapText = missingDirectPriceSkuIds.length
    ? `；SKU ${missingDirectPriceSkuIds.join("、")}未取得页面直接价格`
    : "";
  addHistory(current, "user", "listedSourceCaptureVerified", `已上架商品补采1688证据完成：${selectedText}${priceGapText}；原上架记录保持不变，未派发任务或产生店铺写入`, timestamp);
}

function queueCapturedListingPreparation(data, map, current, session, evidence, resolution, trigger) {
  const timestamp = now();
  const selectedSkus = resolution.selected;
  const missingDirectPriceSkuIds = resolution.missingDirectPriceSkuIds || [];
  current.workflowStatus = "listing_preparation";
  current.readyAt = null;
  current.cCompletedAt = null;
  current.sourceCapture = {
    captureId: session.captureId,
    status: "verified",
    offerId: evidence.offerId,
    sourceUrl: evidence.sourceUrl,
    title: evidence.title,
    observedAt: evidence.observedAt,
    collectionMethod: evidence.collectionMethod,
    titleSource: evidence.titleSource,
    offerIdSource: evidence.offerIdSource,
    matchTerms: resolution.matchTerms || [],
    selectedSkus,
    missingDirectPriceSkuIds,
    priceRanges: evidence.priceRanges,
    supplierAttributes: evidence.supplierAttributes
  };
  current.listingPreparation = {
    ...(current.listingPreparation || {}),
    status: "queued",
    sourceCaptureId: session.captureId,
    capturedSourceSkus: selectedSkus.map(capturedSkuLabel),
    capturedSourcePricesCny: selectedSkus.map((sku) => sku.priceCny),
    requestedAt: timestamp,
    requestedBy: "user"
  };
  current.listingHandoff = {
    ...(current.listingHandoff || {}),
    state: "queued",
    owner: "listing_task",
    queuedAt: timestamp,
    runId: null,
    currentStep: "1688 SKU选择已保存，等待上架任务继续C阶段",
    blockReason: null,
    defaultStock: 100,
    inheritedInputRevision: Number(current.dataRevision || 0),
    sourceCaptureId: session.captureId
  };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = "user";
  const selectedText = selectedSkus.map(capturedSkuLabel).join("；");
  const priceGapText = missingDirectPriceSkuIds.length
    ? `；其中SKU ${missingDirectPriceSkuIds.join("、")}未取得页面直接价格，必须在C阶段继续核验，不得用阶梯最低价或默认值兜底`
    : "";
  const message = `主人已从评审台完成1688只读采集并选择SKU：offer ${evidence.offerId}，共${selectedSkus.length}个：${selectedText}${priceGapText}；沿用前期已填采购到手总价、真实打包重量尺寸、目标店铺和B阶段证据，只由上架任务继续当前商品C阶段核验，不得执行店铺写入`;
  const dispatch = createCandidateDispatch(data, map, current, {
    nodeId: "M07",
    message,
    trigger,
    actor: "user"
  });
  addHistory(current, "user", "sourceCaptureVerified", `1688已选择${selectedSkus.length}个SKU并向上架任务派发一次C阶段：${selectedText}`, timestamp);
  return dispatch;
}

function completeListing(current, listingRecord, actor, timestamp) {
  current.workflowStatus = "listed";
  current.listingRecord = listingRecord;
  current.listedAt = listingRecord.confirmedAt;
  current.listingHandoff = {
    ...(current.listingHandoff || {}),
    state: "completed",
    owner: "listing_task",
    completedAt: listingRecord.confirmedAt,
    completionMethod: listingRecord.method
  };
  current.processing = { ...queuedProcessing(current.processing), state: "idle" };
  current.dataRevision = Number(current.dataRevision || 0) + 1;
  current.updatedAt = timestamp;
  current.lastModifiedBy = actor;
}

function effectiveNeeds(candidate) {
  if (candidate.workflowStatus !== "needs_user_data") return [];
  const reviewNeeds = candidate.codexReview?.needsFromUser;
  const needs = Array.isArray(reviewNeeds) && reviewNeeds.length
    ? reviewNeeds
    : requiredInputFields(candidate).map((item) => item.label);
  return needs.filter((need) => {
    const label = String(need);
    // “采购到手总价（含国内运费）”是一个完整的用户输入，不能因为
    // 文案中出现“国内运费”就被当成应由系统处理的独立运费字段过滤掉。
    if (/采购到手总价|采购价|货价/.test(label)) return true;
    return !/包材成本|包装成本|国内运费|合规|认证|授权|权属/.test(label);
  });
}

function effectiveNeededFields(candidate) {
  if (candidate.workflowStatus !== "needs_user_data") return [];
  const requested = candidate.codexReview?.needsFromUserFields;
  const valid = Array.isArray(requested)
    ? requested.filter(
        (field) => USER_FIELDS.includes(field) && !DEFAULTED_USER_FIELDS.has(field)
      )
    : [];
  if (valid.length) return filterUserNeededFields(candidate, valid);

  const inferred = [];
  for (const rawNeed of effectiveNeeds(candidate)) {
    const need = String(rawNeed);
    if (/SKU|款式|型号/.test(need)) inferred.push("productName");
    if (/链接|1688|货源/.test(need)) inferred.push(candidate.sourceUrl ? "productUrl" : "sourceUrl");
    if (/采购价|货价|到手总价/.test(need)) inferred.push("purchasePriceRmb");
    if (/重量|实重/.test(need)) inferred.push("packedWeightKg");
    if (/尺寸|长宽高/.test(need)) inferred.push("dimensionsCm");
    if (/非电|带电|电池/.test(need)) inferred.push("powered");
    if (/厚度|防碎|包装说明|补充说明/.test(need)) inferred.push("notes");
  }
  return filterUserNeededFields(candidate, [...new Set(inferred)].filter(
    (field) => USER_FIELDS.includes(field) && !DEFAULTED_USER_FIELDS.has(field)
  ));
}

/**
 * Every official input one product's pricing needs, resolved once: the store's cost policy, the official FX, the
 * official commission for the owner's target price, the whole official rate ladder, and the saved GUOO rows.
 * 找货 and 选定 are both priced from this one resolution, so the two can never be looking at different money.
 */
async function supplierDraftPricingInputs(document, candidate, draft) {
  const at = now();
  const record = readDiscoveryMarketRecord({ document, candidate });
  const marketProduct = record.status === "available" ? record.product : null;
  let storeRule;
  try { storeRule = supplierDraftEstimateInputs.storeRule(document, candidate.targetStore); }
  catch { return null; }
  const [fx, freight] = [await supplierDraftEstimateInputs.resolveExchangeRate(document, at),
    await supplierDraftEstimateInputs.resolveFreightRows()];
  const commission = await supplierDraftEstimateInputs.resolveCommission(
    { categoryPath: marketProduct?.categoryPath ?? null, price: draft.targetSalePriceRub }, at);
  // Pricing guidance needs every band of the same official table, not only the band this one price falls in.
  const commissionTiers = await supplierDraftEstimateInputs.resolveCommissionTiers(
    { categoryPath: marketProduct?.categoryPath ?? null }, at);
  return {
    at, marketProduct, storeRule, fx, freight, commission, commissionTiers,
    // 每单额外操作费按这件货自己的声明算，不按项目假设值 A_ESTIMATE_PACKAGING_RMB。主人看到的利润和他最后签下去的
    // 利润必须是同一个数——2026-09-15 之前页面按 ¥3 显示、确认时按这件货自己的 packagingCostRmb 算，两者不是一回事。
    // 还没声明过的时候这里是 ¥0 且 extraHandlingDeclared 为 false，页面照实说它还没签过字。
    assumptions: extraHandlingFeeAssumptions(candidate),
    inputs: { fxSourceRef: fx?.sourceRef ?? null, fxRateDate: fx?.rateDate ?? null,
      commissionSourceRef: commission.sourceRef, tariffRuleVersion: freight.ruleVersion,
      costPolicyVersion: typeof storeRule.pricingPolicyVersion === "string" ? storeRule.pricingPolicyVersion : null }
  };
}

/**
 * The purchase ceiling and the profit the owner's declared purchase price actually reaches. An input that cannot be
 * resolved keeps the estimate incomplete; the draft is still saved, because the owner's declaration is a fact even
 * when the pricing is not ready.
 */
function supplierDraftEstimateFrom(draft, resolved) {
  return buildSupplierDraftEstimate({
    draft, storeRule: resolved.storeRule, fx: resolved.fx, commission: resolved.commission,
    commissionTiers: resolved.commissionTiers, tariffRows: resolved.freight.rows,
    assumptions: resolved.assumptions, estimatedAt: resolved.at, marketProduct: resolved.marketProduct,
    inputs: resolved.inputs
  });
}

async function supplierDraftEstimate(document, candidate, draft) {
  const resolved = await supplierDraftPricingInputs(document, candidate, draft);
  return resolved === null ? null : supplierDraftEstimateFrom(draft, resolved);
}

/**
 * 选规格 for one product: every captured specification priced on its own weight and its own goods price, through
 * the same engine and the same resolved inputs as the 找货 estimate beside it. A product the extension has not left a
 * set of specifications on has no table at all.
 */
function supplierSkuChoiceTableFrom(candidate, draft, resolved) {
  const capture = candidate?.sourceCapture;
  if (!capture || capture.status !== "captured_waiting_owner_selection") return null;
  const choices = Array.isArray(capture.skuChoices) ? capture.skuChoices : [];
  if (choices.length === 0) return null;
  return buildSkuChoiceTable({
    choices, draft, storeRule: resolved.storeRule, fx: resolved.fx, commission: resolved.commission,
    tariffRows: resolved.freight.rows, assumptions: resolved.assumptions, marketProduct: resolved.marketProduct,
    selectedSkuIds: Array.isArray(capture.selectedSkuIds) ? capture.selectedSkuIds : [],
    builtAt: resolved.at, inputs: resolved.inputs,
    // 同重同价声明：只有主人自己签过、而且签的就是这一次采集，才会有东西传进去。没签过是 null，整张表一如从前。
    uniformSupply: inForceSkuUniformSupply(candidate)
  });
}

/** What the 找货 and 选定 steps show: the saved draft, the market snapshot, a fresh estimate and a fresh spec table. */
async function supplierDraftView(document, candidate) {
  const draft = candidate.supplierDraftV1 ?? null;
  const snapshot = currentSalesSnapshot(candidate);
  // One resolution of the official inputs for the whole view, so the two steps can never show different money.
  const resolved = draft === null ? null : await supplierDraftPricingInputs(document, candidate, draft);
  const estimate = resolved === null ? null : supplierDraftEstimateFrom(draft, resolved);
  const table = resolved === null ? null : supplierSkuChoiceTableFrom(candidate, draft, resolved);
  const publicView = publicCandidate(candidate, document.rules, {}, document.evidencePacks || [], document.currentCommissionCatalogs ?? []);
  return {
    schemaVersion: "supplier-draft-view-v1",
    candidateId: candidate.id,
    dataRevision: candidate.dataRevision,
    supplierDraftV1: draft === null ? null : structuredClone(draft),
    supplierDraftEstimateV1: estimate,
    skuChoiceTableV1: table,
    // 同重同价声明那一小块：这一批采到的规格缺不缺重量和货价、主人签过没有、签的是不是这一次。它自己不算钱。
    skuUniformSupplyStepV1: table === null ? null : buildSkuUniformSupplyStep({ candidate, draft, table }),
    // 算利润 reads the very card the page is handed, so what the owner confirms and what the server validates are the
    // same record. Nothing is computed a second time here: the specification table above already priced every row.
    // 「做这件」确认卡（关口 1）那一份：选项、软件先选的、粗算、品牌提示；卡没打开时只有已存下的决定和利润差额。
    gate1V1: await gate1Service.view(document, candidate),
    profitStepV1: table === null ? null : buildProfitStepReview({
      candidate, draft, table, estimate, card: publicView.realAConfirmationCard ?? null,
      commissionTiers: resolved.commissionTiers, builtAt: resolved.at
    }),
    // 运输属性那一小块：软件提议了什么、凭什么提议、主人确认了没有。它自己不算钱，所以和上面那张表无关。
    cargoFactsStepV1: buildCargoFactsStep(candidate),
    // 每单额外操作费那一小块：包材／拆单费／合包费／额外材料费这一类，每单要另外花的钱。默认一行都没有 = ¥0，
    // 而且那是主人的一次明确声明。缺它的时候 B 阶段证据会在最后一个按钮上抛 B_EVIDENCE_COST_POLICY_INCOMPLETE，
    // 所以它必须在「算利润」里就能填、就能看见缺。
    extraHandlingFeesStepV1: buildExtraHandlingFeesStep(candidate),
    // 类目那一小块：算利润只认真实读过的 Ozon 页面给的类目，这里说清楚现在这条是不是、不是的话出路是什么。
    ozonCategoryReadStepV1: buildOzonCategoryReadStep(candidate),
    // 估算佣金授权那一小块：上一次确认是不是停在「精确佣金读不到、只差主人授权」。它整份来自已保存的记录，
    // 所以主人硬刷新之后这一块还在——页面自己记不住这件事，正是 2026-09-14 那个 bug 的根。
    commissionEstimateStepV1: buildCommissionEstimateStep(candidate),
    marketSnapshot: snapshot === null ? null : structuredClone(snapshot),
    candidate: publicView
  };
}

function publicCandidate(candidate, rules, queueInfo = {}, evidencePacks = [], currentCommissionCatalogs = []) {
  const stripCaptureCredentials = capture => {
    if (!capture) return capture;
    const { token: _token, extensionRequest: _extensionRequest, ...publicState } = capture;
    return publicState;
  };
  candidate = { ...candidate, sourceCapture: stripCaptureCredentials(candidate.sourceCapture), salesCapture: stripCaptureCredentials(candidate.salesCapture) };
  const userDecision = candidate.userEvaluation?.decision || null;
  const codexDecision = candidate.codexReview?.decision || null;
  const opinionsDiffer =
    Boolean(userDecision && codexDecision) &&
    !(
      (userDecision === "viable" && codexDecision === "approved") ||
      (userDecision === "unsure" && ["approved", "sourcePending", "needsInfo"].includes(codexDecision)) ||
      (userDecision === "reject" && codexDecision === "eliminated")
    );
  const realAEligible =
    !candidate.lifecycleV11?.skuPackage &&
    !candidate.lifecycleV11?.aConfirmationReceipt &&
    ["awaiting_user_direction", "needs_user_data", "codex_processing"].includes(candidate.workflowStatus);
  let evidenceCandidate = candidate;
  let evidenceContextFailure = null;
  if (realAEligible) {
    try {
      const comparison = Array.isArray(candidate.guooRouteComparisonsV1) ? candidate.guooRouteComparisonsV1.at(-1) : null;
      evidenceCandidate = applyLifecycleBEvidenceContext(candidate, {
        guooFilePath: runtimeConfiguration.guooTariffFile,
        ...(comparison?.resultRevision === candidate.dataRevision && comparison.selectedRoute
          ? { route: comparison.selectedRoute } : {})
      }).candidate;
    } catch (error) {
      evidenceContextFailure = error instanceof Error ? error.message : String(error);
    }
  }
  const systemEvidenceReadiness = realAEligible
    ? inspectLifecycleBInputReadiness({ candidate: evidenceCandidate, evidencePacks, currentCommissionCatalogs })
    : null;
  let c1KeywordSoftwarePlanningView = null;
  if (candidate.lifecycleV11?.skuPackage?.businessPhase === "C1") {
    const readinessReceipt = candidate.lifecycleV11?.c1KeywordPlanningProductionV1;
    if (["not_ready", "blocked"].includes(readinessReceipt?.status) &&
        readinessReceipt.resultCandidateRevision === candidate.dataRevision) {
      c1KeywordSoftwarePlanningView = {
        status: "not_ready",
        readinessClass: readinessReceipt.status,
        mode: null,
        gaps: structuredClone(readinessReceipt.gaps || []),
        providerCalls: 0,
        automaticRetries: 0,
        browserFallbackAllowed: false,
        codexDispatchAllowed: false
      };
    } else try {
      const plan = buildC1KeywordSoftwareJobPlan({
        candidate,
        expectedRevision: candidate.dataRevision,
        plannedAt: now(),
        existingPlan: candidate.lifecycleV11?.c1KeywordSoftwareJobPlanV1 ?? null
      });
      c1KeywordSoftwarePlanningView = {
        status: plan.status,
        readinessClass: plan.readinessClass,
        mode: plan.mode,
        gaps: structuredClone(plan.gaps || []),
        providerCalls: plan.executionPolicy?.provider === "seerfar_open_api" ? 1 : 0,
        automaticRetries: plan.executionPolicy?.automaticRetries ?? 0,
        browserFallbackAllowed: false,
        codexDispatchAllowed: false
      };
    } catch {
      c1KeywordSoftwarePlanningView = {
        status: "not_ready",
        readinessClass: "planner_rejected_current_data",
        mode: null,
        gaps: [{ code: "planner_rejected_current_data", field: "lifecycleV11", message: "当前C1冻结数据未通过服务端计划校验" }],
        providerCalls: 0,
        automaticRetries: 0,
        browserFallbackAllowed: false,
        codexDispatchAllowed: false
      };
    }
  }
  const eReadbackRuntimeView = deRuntimeServices.readbackView(candidate);
  return {
    ...candidate,
    c1KeywordSoftwarePlanningView,
    c1ReviewPresentation: buildC1ReviewPresentation({ candidate, observedAt: now() }),
    eReadbackRuntimeView,
    productionOwnerPreparation: candidate.lifecycleV11?.skuPackage?.productionConfirmationCard
      ? buildProductionOwnerPreparationView({ candidate, configuration: runtimeConfiguration, evidencePacks, currentCommissionCatalogs, observedAt: now() })
      : null,
    savedSkuFactReconciliation: candidate.lifecycleV11?.skuPackage?.productionConfirmationCard
      ? inspectSavedSkuFactReconciliation({ candidate }) : null,
    executionRuntimeView: buildCurrentExecutionRuntimeView(candidate),
    bExactCommissionRuntimeView: buildBExactCommissionRuntimeView({ candidate, evidencePacks, currentCommissionCatalogs, rules, observedAt: now() }),
    // 「这件的佣金还是估算的」那一块。挂在每一份候选视图上，所以从条件测算一路到上架之前的每一屏都看得见——
    // 中间隔着几天，只在出事那一屏说一次，主人会忘；忘了最坏的结果是拿估算费率去上架。佣金换成精确的那一刻
    // 它自己消失（present 为 false），不用谁去清。
    estimatedCommissionNoticeStepV1: buildEstimatedCommissionNoticeStep(candidate),
    dESoftwareRuntimeView: buildDESoftwareIntegrationView({ candidate, eReadbackRuntimeView,
      currentProductionBinding: currentProductionBinding(candidate), inspectedAt: now() }),
    lifecycleEntryPreview: realAEligible ? buildRealLifecycleEntryPreview(candidate) : null,
    supplierImageSearchPreparation: realAEligible ? supplierImageSearchAvailability() : null,
    realAConfirmationCard: realAEligible ? buildRealAConfirmationCard(candidate, {
      costPolicyReadiness: inspectLifecycleBCostReadiness({ candidate: evidenceCandidate, rules, asOf: now() }),
      systemEvidenceReadiness: evidenceContextFailure ? {
        ...systemEvidenceReadiness,
        contextFailure: evidenceContextFailure
      } : systemEvidenceReadiness,
      systemEvidencePreparationPlan: buildLifecycleBEvidencePreparationPlan({
        candidate: evidenceCandidate,
        evidencePacks,
        currentCommissionCatalogs,
        plannedAt: systemEvidenceReadiness.checkedAt
      })
    }) : null,
    processingStatus: currentProcessingStatusSummary(candidate, { queueInfo }),
    owner:
      ["listing_preparation", "ready_to_list", "listed"].includes(candidate.workflowStatus)
        ? "listing_task"
        : "selection_task",
    purchaseCeiling: purchaseCeilingSummary(candidate, rules),
    displayStatus: candidate.workflowStatus,
    needsFromUser: effectiveNeeds(candidate),
    neededFieldKeys: effectiveNeededFields(candidate),
    approvalGate: approvalGate(candidate, rules),
    profitReviewGate: profitReviewGate(candidate, rules),
    selectionStage: selectionStage(candidate, rules),
    wbAssessmentGate: candidate.wbAssessment
      ? wbAssessmentDecisionGate(candidate.wbAssessment, candidate, rules)
      : null,
    unansweredCommentCount: (candidate.comments || []).filter(
      (comment) =>
        comment.actor === "user" &&
        comment.requiresResponse === true &&
        comment.status !== "responded"
    ).length,
    opinionsDiffer
  };
}

function projectC1PaidKeywordSoftwareJob(candidate, runtime) {
  const ref = candidate?.lifecycleV11?.c1PaidKeywordEvidenceJobRefV1;
  if (!ref || ref.jobType !== "c1_paid_keyword_evidence") return null;
  const job = (runtime?.softwareJobs || []).find((entry) =>
    entry.jobId === ref.jobId &&
    entry.jobType === ref.jobType &&
    entry.candidateId === ref.candidateId &&
    entry.skuPackageId === ref.skuPackageId &&
    entry.revision === ref.resultRevision
  );
  if (!job) {
    return {
      schemaVersion: "c1-paid-keyword-software-job-view-v1",
      jobRef: structuredClone(ref),
      status: "not_found",
      externalRequestState: "not_sent",
      jobId: ref.jobId,
      failureClass: "software_job_not_found",
      automaticRetryAllowed: false
    };
  }
  const activeExecution = keywordEvidenceRuntimeServices.activeExecution;
  const admissionFailure = keywordEvidenceRuntimeServices.lastAdmissionRejection;
  return {
    schemaVersion: "c1-paid-keyword-software-job-view-v1",
    jobRef: structuredClone(ref),
    jobId: job.jobId,
    status: job.status,
    currentExecutionConfirmed: activeExecution?.jobId === job.jobId &&
      activeExecution.workerId === job.workerId && activeExecution.leaseId === job.leaseId &&
      Date.parse(job.leaseExpiresAt) > Date.parse(now()) && ["claimed", "waiting_platform"].includes(job.status),
    serviceStatus: keywordEvidenceRuntimeServices.status,
    admissionFailure: admissionFailure?.jobId === job.jobId ? admissionFailure : null,
    externalRequestState: job.externalRequestState,
    requestedByUserId: job.requestedByUserId,
    ownerUserId: job.ownerUserId,
    workerId: job.workerId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failureClass: job.failureClass,
    automaticRetryAllowed: job.automaticRetryAllowed === true
  };
}

function aiFailureDisposition(error) {
  const code = String(error?.code || "A_TERRA_UNEXPECTED_FAILURE");
  const layer = String(error?.layer || "integration");
  if (code === "MODEL_OUTPUT_SCHEMA_MISMATCH" || layer === "output_schema" || layer === "receipt") {
    return { type: "exception_case", reasonCode: "output_schema_mismatch" };
  }
  const unknownOutcome = Boolean(error?.jobId) && ["gateway_status", "inference"].includes(layer);
  return {
    type: "technical_failure",
    kind: unknownOutcome ? "unknown_outcome" : "external_dependency"
  };
}

async function enrichCapturedSalesSnapshotWithTerra(candidateId, expectedRevision, snapshotId) {
  const snapshotData = await readData();
  const source = snapshotData.candidates.find((item) => item.id === candidateId);
  if (!source || Number(source.dataRevision) !== Number(expectedRevision)) {
    throw httpError(409, "销售快照保存后商品资料发生变化，Terra辅助整理未启动");
  }
  const salesSnapshot = (source.salesSnapshotsV11 || []).find((item) => item.snapshotId === snapshotId);
  if (!salesSnapshot) throw httpError(409, "刚保存的销售快照不存在，Terra辅助整理未启动");
  if ((salesSnapshot.auxiliaryDrafts || []).some((item) => item.provider === "terra")) {
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || [], snapshotData.currentCommissionCatalogs ?? []);
  }

  let assisted;
  try {
    assisted = await runAStageTerraAssist({
      candidate: source,
      snapshot: salesSnapshot,
      gatewayUrl: aiGatewayUrl,
      gatewayDeploymentMode: aiGatewayDeploymentMode
    });
  } catch (error) {
    const failure = error instanceof AStageTerraGatewayError
      ? error
      : new AStageTerraGatewayError("A_TERRA_UNEXPECTED_FAILURE", "integration", String(error?.message || error));
    return mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== Number(expectedRevision)) {
        throw httpError(409, "Terra失败回写前商品资料已变化，本轮异常状态未覆盖新数据");
      }
      const timestamp = now();
      const base = current.executionRuntime || createSoftwareExecutionRuntime({
        candidateId: current.id,
        dataRevision: current.dataRevision,
        businessPhase: "A",
        stepId: "A_TERRA_SALES_ASSIST",
        at: timestamp
      });
      const disposition = aiFailureDisposition(failure);
      current.executionRuntime = disposition.type === "exception_case"
        ? openExceptionCase(base, {
          exceptionId: `exception:${current.id}:${current.dataRevision}:a-terra`,
          reasonCode: disposition.reasonCode,
          failureLayer: failure.layer || "integration",
          evidenceRefs: [salesSnapshot.evidenceRef],
          softwareJobId: failure.jobId || null,
          sourceRevision: current.dataRevision,
          at: timestamp
        })
        : blockExecutionForTechnicalFailure(base, {
          failureId: `technical-failure:${current.id}:${current.dataRevision}:a-terra`,
          kind: disposition.kind,
          errorCode: failure.code,
          failureLayer: failure.layer || "integration",
          evidenceRefs: [salesSnapshot.evidenceRef],
          softwareJobId: failure.jobId || null,
          sourceRevision: current.dataRevision,
          at: timestamp
        });
      current.aStageAi = {
        status: "failed",
        taskType: "sales_comparability_assist",
        model: "gpt-5.6-terra",
        jobId: failure.jobId || null,
        attempt: 1,
        failure: {
          code: failure.code,
          layer: failure.layer,
          safeMessageKey: disposition.type === "exception_case"
            ? `exception.${disposition.reasonCode}`
            : `technical_failure.${disposition.kind}`
        },
        businessStateEffect: "unchanged",
        stoppedAt: timestamp
      };
      current.dataRevision += 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "aTerraAssistFailed", `Terra辅助整理在${failure.layer}层停止；A阶段业务结论未改变，未换模型、未重试`, timestamp);
      return publicCandidate(current, data.rules, {}, data.evidencePacks || [], data.currentCommissionCatalogs ?? []);
    });
  }

  return mutateData((data) => {
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在");
    if (Number(current.dataRevision) !== Number(expectedRevision)) {
      throw httpError(409, "Terra结果返回前商品资料已变化，本轮结果未保存");
    }
    const index = (current.salesSnapshotsV11 || []).findIndex((item) => item.snapshotId === snapshotId);
    if (index < 0) throw httpError(409, "Terra结果对应的销售快照不存在");
    const timestamp = assisted.receipt.completedAt || now();
    current.salesSnapshotsV11[index] = structuredClone(assisted.snapshot);
    const base = current.executionRuntime || createSoftwareExecutionRuntime({
      candidateId: current.id,
      dataRevision: current.dataRevision,
      businessPhase: "A",
      stepId: "A_TERRA_SALES_ASSIST",
      at: timestamp
    });
    const running = startThirdPartyAiStep(base, {
      stepId: "A_TERRA_SALES_ASSIST",
      inputRevision: current.dataRevision,
      inferenceJobId: assisted.jobId,
      at: assisted.receipt.requestedAt || timestamp
    });
    current.executionRuntime = completeExecutionStep(running, {
      outputRevision: current.dataRevision + 1,
      inferenceReceiptId: assisted.receiptId,
      at: timestamp
    });
    current.inferenceReceiptsV1 ||= [];
    if (!current.inferenceReceiptsV1.some((item) => item.receiptId === assisted.receiptId)) {
      current.inferenceReceiptsV1.push({
        receiptId: assisted.receiptId,
        jobId: assisted.jobId,
        model: "gpt-5.6-terra",
        taskType: "sales_comparability_assist",
        attempt: 1,
        evidenceRefs: structuredClone(assisted.receipt.evidenceRefs || []),
        requestHash: assisted.receipt.requestHash,
        outputSchemaHash: assisted.receipt.outputSchemaHash || null,
        validation: structuredClone(assisted.receipt.validation),
        usage: assisted.receipt.usage ?? "unknown",
        completedAt: timestamp
      });
    }
    current.aStageAi = {
      status: "completed",
      taskType: "sales_comparability_assist",
      model: "gpt-5.6-terra",
      jobId: assisted.jobId,
      receiptId: assisted.receiptId,
      attempt: 1,
      authoritative: false,
      businessStateEffect: "unchanged",
      completedAt: timestamp
    };
    current.dataRevision += 1;
    current.updatedAt = timestamp;
    current.lastModifiedBy = "system";
    addHistory(current, "system", "aTerraAssistCompleted", "Terra已基于公开销售快照生成不可覆盖真实字段的A阶段辅助草稿；未作商业决定、未唤醒Codex", timestamp);
    return publicCandidate(current, data.rules, {}, data.evidencePacks || [], data.currentCommissionCatalogs ?? []);
  });
}

async function continueC1SoftwareWhenEvidenceReady(candidateId, expectedRevision, { reportConfigurationBlock = false } = {}) {
  const snapshotData = await readData();
  let source = snapshotData.candidates.find((item) => item.id === candidateId);
  if (!source || Number(source.dataRevision) !== Number(expectedRevision)) {
    throw new C1KeywordContinuationRevisionConflictError();
  }
  if (!source.lifecycleV11?.c1KeywordPlanningEvidenceV1) {
    const producedAt = now();
    const planning = await runC1KeywordPlanningEvidenceProduction({
      repository: businessStateRepository,
      runtimeMode: runtimeConfiguration.deploymentMode,
      actor: createActorContext({
        userId: "selection-review-software",
        sessionId: `c1-keyword-planning:${source.id}:${source.dataRevision}`,
        actorType: "software",
        roles: ["operator"],
        source: "selection_review_state_machine",
        authenticatedAt: producedAt
      }),
      candidateId: source.id,
      expectedRevision: source.dataRevision,
      producedAt,
      codexOffline: true
    });
    if (["committed", "already_current", "idempotent_replay"].includes(planning.status)) {
      source = planning.candidate;
      // Planning alone grants no paid permission. The configured keyword worker consumes only separately authorized jobs.
      return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || [], snapshotData.currentCommissionCatalogs ?? []);
    }
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || [], snapshotData.currentCommissionCatalogs ?? []);
  }
  const skuPackage = source.lifecycleV11?.skuPackage;
  const evidence = source.lifecycleV11?.c1SoftwareEvidenceV1;
  if (!skuPackage || !evidence || skuPackage.businessPhase !== "C1") {
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || [], snapshotData.currentCommissionCatalogs ?? []);
  }
  if (skuPackage.c1ProductPlan?.status === "seo_draft_ready") {
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || [], snapshotData.currentCommissionCatalogs ?? []);
  }
  try {
    const savedJobRef = source.lifecycleV11.c1AiDraftJobRefV1;
    if (savedJobRef) {
      await c1DraftRuntimeServices.continueSavedCurrent({ candidateId, expectedRevision: savedJobRef.resultRevision, jobId: savedJobRef.jobId });
    } else if (!source.lifecycleV11.c1AiDraftRequestV1) {
      await c1DraftRuntimeServices.prepareCurrent({
        actor: createActorContext({ userId: "selection-review-software", sessionId: `c1-draft-prepare:${candidateId}:${source.dataRevision}`,
          actorType: "software", roles: ["operator"], source: "selection_review_state_machine", authenticatedAt: now() }),
        input: { candidateId, expectedRevision: source.dataRevision,
          idempotencyKey: `c1-draft-prepare:${candidateId}:${source.dataRevision}`, auditEventId: `c1-draft-prepare-audit:${candidateId}:${source.dataRevision}` }
      });
    }
  } catch (error) {
    // Configuration is a visible technical prerequisite; an earlier saved owner
    // decision must not be reported as rolled back merely because it is missing.
    if (error instanceof C1DraftRuntimeUnavailableError && reportConfigurationBlock) return { status: "blocked", failureClass: "C1_DRAFT_RUNTIME_UNAVAILABLE" };
    if (error instanceof C1DraftRuntimeUnavailableError) return {
      ...publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || [], snapshotData.currentCommissionCatalogs ?? []),
      c1DraftRuntimeView: buildC1DraftRuntimeView({ candidate: source, runtime: snapshotData.runtime,
        serviceBindings: runtimeConfiguration.c1DraftServiceBindings, observedAt: now() })
    };
    throw error;
  }
  const saved = await readData();
  const current = saved.candidates.find(item => item.id === candidateId);
  if (!current) throw httpError(404, "候选不存在");
  return publicCandidate(current, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []);
}

async function prepareAndContinueC1FactKeywordEvidence(candidateId, input, { triggerReceipt = null } = {}) {
  const snapshotData = await readData();
  const source = snapshotData.candidates.find((item) => item.id === candidateId);
  if (!source) throw httpError(404, "候选不存在");
  if (Number(source.dataRevision) !== Number(input.dataRevision)) {
    throw httpError(409, "C1事实与关键词流水线启动前商品资料已变化，请刷新后重新生成当前证据");
  }
  const skuPackage = source.lifecycleV11?.skuPackage;
  if (!skuPackage || skuPackage.businessPhase !== "C1") {
    throw httpError(409, "当前商品没有可进入C1事实与关键词流水线的冻结SKU包");
  }
  if (source.lifecycleV11?.c1SoftwareEvidenceV1) {
    return continueC1SoftwareWhenEvidenceReady(candidateId, source.dataRevision);
  }

  const timestamp = now();
  let prepared;
  try {
    prepared = await prepareC1FactKeywordRuntime({
      candidateId,
      skuPackage,
      input,
      preparedAt: timestamp,
      existingEvidence: null
    });
  } catch (error) {
    throw httpError(422, String(error?.message || error));
  }
  if (prepared.result.status !== "ready_for_atomic_persist") {
    const reason = prepared.result.gaps?.map((item) => item.message).filter(Boolean).join("；") || "C1事实或关键词证据尚未完整";
    throw httpError(422, `C1_FACT_KEYWORD_NOT_READY: ${reason}`);
  }

  const staged = await mutateData((data) => {
    const current = data.candidates.find((item) => item.id === candidateId);
    if (!current) throw httpError(404, "候选不存在");
    if (Number(current.dataRevision) !== Number(input.dataRevision)) {
      throw httpError(409, "C1事实与关键词结果返回前商品资料已变化，本轮没有保存任何证据");
    }
    const currentSku = current.lifecycleV11?.skuPackage;
    if (!currentSku || currentSku.skuPackageId !== skuPackage.skuPackageId ||
        currentSku.dataRevision !== skuPackage.dataRevision) {
      throw httpError(409, "C1事实与关键词结果对应的SKU包已经变化，本轮没有保存任何证据");
    }
    const patch = buildC1FactKeywordAtomicPatch({
      candidate: current,
      expectedRevision: input.dataRevision,
      sourceSkuPackage: skuPackage,
      prepared,
      triggerReceipt,
      stagedAt: timestamp
    });
    if (current.siblingSourceV1 && patch.lifecycleV11?.skuPackage?.c1ProductPlan?.status !== 'inputs_ready') {
      assertSiblingSkuColorProjection({ ...current, lifecycleV11: patch.lifecycleV11 });
    }
    current.lifecycleV11 = patch.lifecycleV11;
    current.listingPreparation = patch.listingPreparation;
    current.processing = { ...queuedProcessing(current.processing), ...patch.processing };
    current.dataRevision = patch.nextRevision;
    current.updatedAt = patch.updatedAt;
    current.lastModifiedBy = patch.lastModifiedBy;
    addHistory(current, "system", "c1FactKeywordEvidenceAtomicallyStaged", "C1事实、关键词来源、K3评分与软件证据已一次性保存；未派发Codex、未访问销售或供应平台、未进入C2/D/E", timestamp);
    return { nextRevision: current.dataRevision };
  });
  return continueC1SoftwareWhenEvidenceReady(candidateId, staged.nextRevision);
}

async function continueC1FromKeywordEvidenceReadyEvent(candidateId, event) {
  const snapshotData = await readData();
  const source = snapshotData.candidates.find((item) => item.id === candidateId);
  if (!source) throw httpError(404, "候选不存在");
  let accepted;
  try {
    accepted = acceptC1KeywordEvidenceReadyEvent({ candidate: source, event, acceptedAt: now() });
  } catch (error) {
    throw httpError(409, String(error?.message || error));
  }
  if (accepted.status === "idempotent_replay") {
    return publicCandidate(source, snapshotData.rules, {}, snapshotData.evidencePacks || [], snapshotData.currentCommissionCatalogs ?? []);
  }
  return prepareAndContinueC1FactKeywordEvidence(candidateId, accepted.runtimeInput, {
    triggerReceipt: accepted.triggerReceipt
  });
}

async function runC1KeywordEvidenceSoftwareJob(candidateId, input, request) {
  const timestamp = now();
  const snapshot = await readData();
  const source = snapshot.candidates.find((item) => item.id === candidateId);
  if (!source) throw httpError(404, "候选不存在");
  const actor = runtimeIdentityProvider.resolveActor({ request });
  let outcome;
  try {
    outcome = await enqueueC1PaidKeywordEvidenceJob({
      repository: businessStateRepository,
      runtimeMode: "local_development",
      actor,
      candidateId,
      expectedRevision: source.dataRevision,
      clientInput: input,
      serverTime: timestamp,
      serverClock: () => now(),
      // This schema has one shared Seerfar service; the job separately locks its exact store scope.
      allowedWorkerIds: runtimeConfiguration.keywordEvidenceServiceBindings.map(binding => binding.workerId)
    });
  } catch (error) {
    const message = String(error?.message || error);
    throw httpError(message.includes("CLIENT_INPUT_REJECTED") ? 400 : message.includes("REVISION_CONFLICT") ? 409 : 422, message);
  }
  if (outcome.status === "reuse_ready") {
    return prepareAndContinueC1FactKeywordEvidence(candidateId, outcome.reuseInput);
  }
  if (outcome.status === "not_ready") {
    throw httpError(422, "C1_KEYWORD_SOFTWARE_NOT_READY: 服务端冻结证据尚未达到执行门槛", {
      readinessClass: outcome.readinessClass,
      gaps: outcome.gaps
    });
  }
  const data = await readData();
  const current = data.candidates.find((item) => item.id === candidateId);
  if (!current) throw httpError(404, "候选不存在");
  return publicCandidate(current, data.rules, {}, data.evidencePacks || [], data.currentCommissionCatalogs ?? []);
}

function currentProductionBinding(candidate) {
  const bindingId = candidate.lifecycleV11?.skuPackage?.productionAuthorization?.executionBinding?.bindingId;
  return runtimeConfiguration.productionBindings.find(binding => binding.bindingId === bindingId);
}

function savedDEJobView(candidate, runtime) {
  const view = buildDESavedJobRuntimeView({ candidate, runtime: { ...runtime, workers: workerRegistry.snapshot() },
    serviceBindings: runtimeConfiguration.deServiceBindings, productionBindings: runtimeConfiguration.productionBindings,
    dependencyView: deRuntimeServices.dependencyView, observedAt: now() });
  return ozonAccountReadServices.gateSavedView({ candidate, document: { candidates: [candidate], runtime }, view });
}

function publicSavedDECandidate(candidate, data) {
  return { ...publicCandidate(candidate, data.rules, {}, data.evidencePacks || [], data.currentCommissionCatalogs ?? []),
    dESavedJobRuntimeView: savedDEJobView(candidate, data.runtime),
    ozonAccountReadPreparation: ozonAccountReadServices.preparation({ candidate, document: data }) };
}

function responseState(data, request) {
  const rules = data.rules || DEFAULT_RULES;
  const dispatch = dispatchQueueSummary(data.candidates, new Date(), automationConcurrencyLimit);
  for (const id of currentMaintenanceDispatchIds) {
    const record = data.dispatches.find(item => item.id === id);
    if (!record || !ACTIVE_DISPATCH_STATES.has(record.status)) currentMaintenanceDispatchIds.delete(id);
  }
  const candidates = data.candidates.map((candidate) => {
    const publicValue = publicCandidate(
      candidate,
      rules,
      dispatch.positions[candidate.id] || {},
      data.evidencePacks || [],
      data.currentCommissionCatalogs ?? []
    );
    const activeDispatch = activeDispatchForCandidate(data, candidate.id);
    const latestDispatch = latestDispatchForCandidate(data, candidate.id);
    const runtime = candidate.executionRuntime;
    const activeExecutionReference = activeDispatch && runtime ? {
      status: activeDispatch.status,
      candidateId: candidate.id, candidateRevision: candidate.dataRevision, stepId: runtime.stepId,
      inputRevision: runtime.inputRevision, updatedAt: runtime.updatedAt,
      inferenceJobId: runtime.inferenceJobId, exceptionTurnId: activeDispatch.turnId
    } : null;
    return {
      ...publicValue,
      executionRuntimeView: buildCurrentExecutionRuntimeView(candidate, { activeExecutionReference }),
      processingStatus: currentProcessingStatusSummary(candidate, { activeDispatch, queueInfo: dispatch.positions[candidate.id] || {} }),
      c1PaidKeywordSoftwareJob: projectC1PaidKeywordSoftwareJob(candidate, data.runtime),
      c1ContentReviewView: buildC1ContentReviewView(candidate),
      c1EditorialReviewView: c1EditorialView(candidate, data.runtime),
      c1DraftRuntimeView: buildC1DraftRuntimeView({ candidate, runtime: data.runtime,
        serviceBindings: runtimeConfiguration.c1DraftServiceBindings, observedAt: now() }),
      dESavedJobRuntimeView: savedDEJobView(candidate, data.runtime),
      ozonAccountReadPreparation: ozonAccountReadServices.preparation({ candidate, document: data }),
      currentSourceCapture: currentSourceCaptureForCandidate(candidate),
      activeDispatch: dispatchPublic(activeDispatch),
      latestDispatch: dispatchPublic(latestDispatch)
    };
  });
  return {
    meta: data.meta,
    rules,
    extensionHeartbeat: extensionHeartbeatSnapshot(),
    captureControl: captureControlSnapshot(),
    runtimeArchitecture: {
      ...runtimeArchitecture,
      c1DraftServices: c1DraftRuntimeServices.configurationView,
      currentUser: (() => {
        const access = runtimeIdentityProvider.publicAccessState({ request });
        if (access.status !== "authenticated" && access.status !== "development_only") return {
          userId: null, roles: [], authenticated: false, canSaveProductionOwnerDecision: false, canSaveC1RightsReview: false, canAuthorizeC1PaidCall: false, canAuthorizeProduction: false
        };
        const actor = runtimeIdentityProvider.resolveActor({ request });
        const authenticated = actor.source === "authenticated_identity_provider" && actor.actorType === "human";
        return { userId: actor.userId, roles: actor.roles, authenticated,
          canSaveProductionOwnerDecision: authenticated && actor.roles.includes("owner"),
          canSaveC1RightsReview: authenticated && actor.roles.includes("owner"),
          canAuthorizeC1PaidCall: authenticated && actor.roles.includes("owner"),
          canAuthorizeProduction: authenticated && actor.roles.includes("owner") };
      })(),
      workers: workerRegistry.snapshot().map((worker) => ({
        workerId: worker.workerId,
        capabilities: worker.capabilities,
        status: worker.status,
        heartbeatCurrent: worker.heartbeatCurrent
      }))
    },
    summary: {
      ...dailySummary(data.candidates, rules),
      dispatch: {
        ...dispatch,
        processingCounts: collaborationSummary(data, dispatch.processingCounts, { activeDispatchIds: currentMaintenanceDispatchIds })
      },
      controlAlertsPending: (data.controlAlerts || []).filter((item) => !item.acknowledgedAt).length
    },
    evidencePacks: (data.evidencePacks || []).map((pack) => ({
      id: pack.id,
      kind: pack.kind,
      scope: pack.scope,
      summary: pack.summary,
      sourceType: pack.sourceType,
      checkedAt: pack.checkedAt,
      expiresAt: pack.expiresAt,
      status: pack.status
    })),
    candidates
  };
}

function validateStore(store) {
  if (!["dandanshu", "miska", "wb"].includes(store)) {
    throw httpError(400, "请选择目标店铺");
  }
}


async function handleApi(req, res, pathname) {
  assertTrustedApiRequest({
    method: req.method,
    pathname,
    headers: req.headers,
    trustedServiceOrigins: [...trustedServiceOrigins],
    allowedReviewOrigins: [...allowedReviewOrigins],
    allowedExtensionOrigins: [...allowedExtensionOrigins],
    internalRequestToken: internalApiRequestToken
  });
  if (pathname === "/api/owner-access" && req.method === "GET") {
    return json(res, 200, runtimeIdentityProvider.publicAccessState({ request: req }));
  }
  const ownerAccessAction = pathname.match(/^\/api\/owner-access\/(setup|login|logout)$/);
  if (ownerAccessAction && req.method === "POST") {
    // Authentication endpoints accept the review page, never an internal-token bypass.
    assertTrustedApiRequest({ method: req.method, pathname, headers: req.headers,
      trustedServiceOrigins: [...trustedServiceOrigins], allowedReviewOrigins: [...allowedReviewOrigins] });
    if (runtimeIdentityProvider.providerType !== "local_owner_password") {
      return json(res, 503, { code: "owner_identity_not_configured", message: "本地主人登录尚未配置。" });
    }
    const input = await readJsonRequestBody(req, { maxBytes: 8192, requireJsonContentType: true });
    const action = ownerAccessAction[1];
    const fields = action === "logout" ? [] : ["password"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length ||
        fields.some(field => !Object.hasOwn(input, field)) || (action !== "logout" && typeof input.password !== "string")) {
      throw httpError(400, "登录请求字段无效", { code: "owner_identity_input_invalid" });
    }
    const result = action === "setup" ? await runtimeIdentityProvider.setup(input)
      : action === "login" ? await runtimeIdentityProvider.login(input) : runtimeIdentityProvider.logout({ request: req });
    const access = action === "logout" ? runtimeIdentityProvider.publicAccessState({}) : {
      providerType: runtimeIdentityProvider.providerType, status: "authenticated", user: { userId: result.actor.userId }
    };
    return json(res, 200, access, { "Set-Cookie": result.setCookie });
  }
  const extensionCallback = pathname === "/api/extension/heartbeat" ||
    /^\/api\/extension\/capture-jobs\/[A-Za-z0-9_-]{1,160}\/(?:claim|search-image)$/.test(pathname) ||
    /^\/api\/candidates\/[^/]+\/(?:source-capture|sales-capture|image-match|ozon-match)\/result$/.test(pathname) ||
    /^\/api\/seerfar-selection\/rounds\/[^/]+\/result$/.test(pathname);
  if (runtimeIdentityProvider.providerType === "local_owner_password" && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !extensionCallback && !isTrustedInternalApiRequest(req.headers, internalApiRequestToken)) {
    runtimeIdentityProvider.resolveActor({ request: req, touch: true });
  }
  if (req.method === "OPTIONS" && (pathname === "/api/extension/heartbeat" || /^\/api\/extension\/capture-jobs\/[A-Za-z0-9_-]{1,160}\/(?:claim|search-image)$/.test(pathname) || /^\/api\/candidates\/[^/]+\/(?:source-capture|sales-capture|image-match|ozon-match)\/result$/.test(pathname) || /^\/api\/seerfar-selection\/rounds\/[^/]+\/result$/.test(pathname))) {
    const headers = chromeExtensionCors(req);
    if (!headers["Access-Control-Allow-Origin"]) throw httpError(403, "只接受本机Chrome扩展回传");
    res.writeHead(204, headers);
    res.end();
    return;
  }
  if (req.method === "POST" && pathname === "/api/extension/heartbeat") {
    const headers = chromeExtensionCors(req);
    if (!headers["Access-Control-Allow-Origin"]) throw httpError(403, "只接受本机Chrome扩展心跳");
    const heartbeat = recordExtensionHeartbeat(await requestBody(req));
    // 录入页排着的商品在等插件：插件一回来就接着往下走（排着的还没开始过，不算重跑）。
    if (intakeHasOpenWork && heartbeat.fresh) scheduleIntakePump(0);
    return json(res, 200, { accepted: true, heartbeat, captureJob: null, jobNotice: null }, headers);
  }
  const captureClaimRoute = pathname.match(/^\/api\/extension\/capture-jobs\/([A-Za-z0-9_-]{1,160})\/claim$/);
  if (req.method === "POST" && captureClaimRoute) {
    const headers = chromeExtensionCors(req);
    if (!headers["Access-Control-Allow-Origin"]) throw httpError(403, "只接受已配置的Chrome扩展领取作业");
    const input = await requestBody(req);
    if (Object.keys(input).length !== 1 || typeof input.version !== "string" || !/^\d+\.\d+\.\d+$/.test(input.version)) {
      throw httpError(400, "领取请求必须只包含插件版本", { code: "capture_claim_invalid" });
    }
    const claim = await claimCaptureJob(captureClaimRoute[1], input.version, String(req.headers.origin));
    return json(res, 200, { accepted: true, ...claim }, headers);
  }
  /**
   * Ozon 以图搜要上传的那张图。插件领取作业以后，凭这次作业的令牌来取一次：服务端自己去图床取这张首图（与首图比对同一条
   * 只取公开图片的规则），转成普通 JPEG 交出去。只交给领取了这次作业的那个插件，只交一次，只交给以图搜那一种作业。
   */
  const searchImageRoute = pathname.match(/^\/api\/extension\/capture-jobs\/([A-Za-z0-9_-]{1,160})\/search-image$/);
  if (req.method === "POST" && searchImageRoute) {
    const headers = chromeExtensionCors(req);
    if (!headers["Access-Control-Allow-Origin"]) throw httpError(403, "只接受已配置的Chrome扩展取图");
    const input = await requestBody(req);
    if (Object.keys(input).sort().join(",") !== "dataRevision,token" || typeof input.token !== "string" || !Number.isInteger(input.dataRevision)) {
      throw httpError(400, "取图请求必须只包含令牌和修订号", { code: "search_image_request_invalid" });
    }
    const session = imageMatchSessions.get(searchImageRoute[1]);
    if (!session || session.matchKind !== "ozon" || session.searchBy !== "image") {
      throw httpError(409, "这次作业不是 Ozon 以图搜，没有要上传的图", { code: "search_image_not_applicable" });
    }
    assertClaimedCaptureResultOrigin(session, req, IMAGE_MATCH_KINDS.ozon.logLabel);
    if (!validCaptureToken(session.token, input.token)) throw httpError(403, "找同款令牌无效", { code: "capture_token_invalid" });
    if (session.jobStatus !== "claimed" || session.attempt !== 1 || input.dataRevision !== session.dataRevision) {
      throw httpError(409, "找同款作业尚未由插件原子领取，不能取图", { code: "capture_job_not_claimed" });
    }
    if (session.searchImageServedAt) throw httpError(409, "这次以图搜的图已经交给插件，不再重复交出", { code: "search_image_already_served" });
    session.searchImageServedAt = Date.now();
    // Not a server fault: the picture host did not give the image (or this deployment fetches none). The job then stops as such.
    if (!IMAGE_FINGERPRINT_FETCH_ENABLED) throw httpError(422, "这台评审台不取外部图片，没有图可以上传", { code: "search_image_unavailable" });
    let picture;
    try {
      picture = await searchUploadImageFromBuffer(await fetchPublicProductImage(session.imageUrl, { timeoutMs: 10000 }));
    } catch {
      throw httpError(422, "没能取到这张首图", { code: "search_image_unavailable" });
    }
    return json(res, 200, { contentType: picture.contentType, byteLength: picture.buffer.length,
      base64: picture.buffer.toString("base64") }, headers);
  }
  if (req.method === 'GET' && pathname === '/api/live') {
    return json(res, runtimeHealth.live ? 200 : 503, {
      ok: runtimeHealth.live, live: runtimeHealth.live, service: 'selection-review-app', version: 2, checkedAt: now()
    });
  }
  if (req.method === 'GET' && ['/api/health', '/api/ready'].includes(pathname)) {
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once('close', disconnected);
    try {
      const readiness = await runtimeHealth.ready({ signal: controller.signal });
      return json(res, 200, {
        ok: true, ready: true, service: 'selection-review-app', version: 2,
        dataVersion: readiness.dataVersion,
        extensionHeartbeat: extensionHeartbeatSnapshot(), captureControl: captureControlSnapshot(),
        readiness: { fresh: readiness.fresh, durationMs: readiness.durationMs }, checkedAt: now()
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      return json(res, 503, {
        ok: false, ready: false, service: 'selection-review-app', version: 2, dataVersion: null,
        code: `RUNTIME_READINESS_${String(error.code || 'worker_failed').toUpperCase()}`, checkedAt: now()
      });
    } finally { res.off('close', disconnected); }
  }

  if (req.method === "GET" && pathname === "/api/simulations/phase-2a") {
    return json(res, 200, { card: phase2ADemoCard() });
  }

  if (req.method === "GET" && pathname === "/api/simulations/software-execution") {
    return json(res, 200, {
      result: simulateNormalSoftwarePath(),
      persistence: {
        sharedCandidatesWritten: 0,
        dispatchesCreated: 0,
        codexTasksWoken: 0,
        platformAccesses: 0,
        platformWrites: 0
      }
    });
  }

  if (req.method === "POST" && pathname === "/api/simulations/phase-2a/confirm") {
    const input = await requestBody(req);
    const result = runPhase2AConfirmation(input);
    return json(res, 200, {
      result,
      profitSummary: phase2AResultSummary(result),
      persistence: {
        sharedCandidatesWritten: 0,
        dispatchesCreated: 0,
        platformAccesses: 0,
        platformWrites: 0
      }
    });
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return json(res, 200, responseState(await readData(), req));
  }

  // decline saves one fixed owner reason for a market product; it creates nothing, spends nothing and writes no platform.
  // start is the desk's single click: it creates, authorizes and enqueues one round in one saved transaction, so a
  // dropped second request can no longer leave a paid batch that never ran. create and authorize stay for the old card.
  const aDiscoveryRoute = pathname.match(/^\/api\/product-discovery\/(create|start|authorize|continue|select|decline)$/);
  if (req.method === 'GET' && pathname === '/api/product-discovery' || req.method === 'POST' && aDiscoveryRoute) {
    const actor = runtimeIdentityProvider.resolveActor({request:req});
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后查看商品发现计划。');
    }
    try {
      let operationResult = null;
      if (req.method === 'POST') {
        const input = await readJsonRequestBody(req, {maxBytes:8192,requireJsonContentType:true});
        const actions = {create:'createBatch',start:'startRound',authorize:'authorizeAndRun',continue:'continueSavedCurrent',select:'importSelected',decline:'declineProduct'};
        operationResult = await aDiscoveryRuntime[actions[aDiscoveryRoute[1]]]({actor,input});
      }
      const document = await readData();
      return json(res,200,{...aDiscoveryRuntime.view({document,actor}),operationResult});
    } catch (error) {
      if (!(error instanceof ADiscoveryError)) throw error;
      const status = error.code === 'SERVICE_NOT_CONFIGURED' ? 503 :
        ['INPUT_INVALID','PLAN_INVALID','IMPORT_INPUT_INVALID'].includes(error.code) ? 400 : 409;
      // A second round for the same store and direction is refused in the owner's own words, not in batch vocabulary.
      const message = error.code === 'ROUND_ALREADY_RUNNING'
        ? '本店已有一轮查询在进行，等它完成后再找；没有新建批次，也没有再扣点数。'
        : '商品发现未继续，请核对当前计划、批次版本及已保存的执行结果。';
      return json(res,status,{code:error.code,message});
    }
  }

  // Display-only: translated titles are shown beside the provider's own title and never overwrite a saved field.
  if (req.method === 'POST' && pathname === '/api/product-discovery/translate') {
    const actor = runtimeIdentityProvider.resolveActor({request:req});
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后查看商品发现计划。');
    }
    try {
      const input = await readJsonRequestBody(req, {maxBytes:8192,requireJsonContentType:true});
      if (aDiscoveryTitleTranslationUseCase === null) {
        return json(res,503,{code:'AI_GATEWAY_NOT_CONFIGURED',message:'本机AI网关尚未接入；本次没有翻译，也没有保存任何结果。'});
      }
      const operationResult = await aDiscoveryTitleTranslationUseCase.translateBatch({actor,input});
      const document = await readData();
      return json(res,200,{...aDiscoveryRuntime.view({document,actor}),operationResult});
    } catch (error) {
      if (error instanceof DiscoveryTitleTranslationError) {
        return json(res,502,{code:error.code,message:'标题翻译未完成并已停止；没有保存部分结果，商品原始标题未改动。'});
      }
      if (!(error instanceof ADiscoveryError)) throw error;
      const status = error.code === 'SERVICE_NOT_CONFIGURED' ? 503 : error.code === 'INPUT_INVALID' ? 400 : 409;
      return json(res,status,{code:error.code,message:'标题翻译未继续，请核对当前批次版本及已保存的查询结果。'});
    }
  }

  // Reference only: an A-stage purchase ceiling from official inputs. It never replaces the formal B profit conclusion.
  if (req.method === 'POST' && pathname === '/api/product-discovery/estimate') {
    const actor = runtimeIdentityProvider.resolveActor({request:req});
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后查看商品发现计划。');
    }
    try {
      const input = await readJsonRequestBody(req, {maxBytes:8192,requireJsonContentType:true});
      const operationResult = await aDiscoveryEstimateUseCase.estimateBatch({actor,input});
      const document = await readData();
      return json(res,200,{...aDiscoveryRuntime.view({document,actor}),operationResult});
    } catch (error) {
      if (!(error instanceof ADiscoveryError)) throw error;
      const status = error.code === 'SERVICE_NOT_CONFIGURED' ? 503 : error.code === 'INPUT_INVALID' ? 400 : 409;
      return json(res,status,{code:error.code,message:'利润区间未估算，请核对当前批次版本及已保存的查询结果。'});
    }
  }

  // Seerfar 方案 B：今天建议搜什么、最近几轮的结果；主人点"收一轮"建立一次性只读作业；插件回传这一页结果。
  if (pathname === '/api/seerfar-selection' && req.method === 'GET' ||
      pathname === '/api/seerfar-selection/rounds' && req.method === 'POST') {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后再看 Seerfar 榜单。');
    }
    try {
      let operationResult = null;
      if (req.method === 'POST') {
        const input = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['targetStore', 'queryId'].includes(key)) ||
            typeof input.targetStore !== 'string' || typeof input.queryId !== 'string' || input.queryId.length > 300) {
          throw httpError(400, 'Seerfar 榜单请求的字段无效', { code: 'seerfar_web_input_invalid' });
        }
        operationResult = await seerfarWebRounds.startRound({ actor, targetStore: input.targetStore, queryId: input.queryId });
      }
      const document = await readData();
      return json(res, req.method === 'POST' ? 202 : 200, seerfarSelectionView(document, operationResult));
    } catch (error) { throw seerfarWebHttpError(error); }
  }
  const seerfarWebResultRoute = pathname.match(/^\/api\/seerfar-selection\/rounds\/([^/]+)\/result$/);
  if (req.method === 'POST' && seerfarWebResultRoute) {
    const headers = chromeExtensionCors(req);
    if (!headers['Access-Control-Allow-Origin']) throw httpError(403, '只接受已配置的Chrome扩展回传');
    const input = await readJsonRequestBody(req, { maxBytes: 512 * 1024, requireJsonContentType: true });
    try {
      const round = await seerfarWebRounds.acceptResult({ roundId: decodeURIComponent(seerfarWebResultRoute[1]), input, origin: String(req.headers.origin || '') });
      return json(res, 200, { accepted: true, round }, headers);
    } catch (error) { throw seerfarWebHttpError(error); }
  }
  // 店铺档案：卖什么、价格带、重量上限、预售最多等几天、不做原因汇总。主人改的另存新版本，旧版本保留。
  const storeProfileRoute = pathname.match(/^\/api\/store-profiles(?:\/([a-z]+))?$/);
  if (storeProfileRoute && (req.method === 'GET' && !storeProfileRoute[1] || req.method === 'POST' && storeProfileRoute[1])) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后再看店铺档案。');
    }
    if (!seerfarSelectionConfig.config) throw httpError(503, '店铺档案配置读不出来。', { code: 'store_profile_config_unavailable' });
    const config = seerfarSelectionConfig.config;
    if (req.method === 'POST') {
      const input = await readJsonRequestBody(req, { maxBytes: 16 * 1024, requireJsonContentType: true });
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['baseVersion', 'values'].includes(key)) ||
          typeof input.baseVersion !== 'string') throw httpError(400, '店铺档案的字段无效', { code: 'store_profile_input_invalid' });
      try {
        await mutateData(document => updateStoreProfile(document, { targetStore: storeProfileRoute[1], baseVersion: input.baseVersion, values: input.values,
          actor, at: now(), config }));
      } catch (error) {
        if (error instanceof StoreProfileError) throw httpError(error.status, error.publicMessage, { code: `store_profile_${error.code.toLowerCase()}` });
        throw error;
      }
    }
    const document = await readData();
    return json(res, 200, { profiles: Object.fromEntries(Object.keys(config.profiles).map(store => [store, storeProfileView(document, store, { config })])) });
  }

  // 读本店近 8 周按 SKU 的销量（只读 Seller API），挑出"本店爆款找相似"的种子。
  if (req.method === 'POST' && pathname === '/api/seerfar-selection/store-sales') {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后再读本店销量。');
    }
    const input = await readJsonRequestBody(req, { maxBytes: 1024, requireJsonContentType: true });
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'targetStore') || typeof input.targetStore !== 'string') {
      throw httpError(400, '读本店销量的字段无效', { code: 'store_sales_input_invalid' });
    }
    try {
      const operationResult = await storeSalesSeeds.startRead({ actor, targetStore: input.targetStore });
      const document = await readData();
      return json(res, 202, seerfarSelectionView(document, operationResult));
    } catch (error) { throw seerfarWebHttpError(error); }
  }

  const imageSearchRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/supplier-image-search(?:\/(authorize))?$/);
  if (imageSearchRoute && (req.method === 'GET' && !imageSearchRoute[2] || req.method === 'POST' && imageSearchRoute[2])) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后查看1688图搜准备。');
    }
    try {
      const candidateId = decodeURIComponent(imageSearchRoute[1]);
      const document = await readData();
      const input = req.method === 'POST'
        ? await readJsonRequestBody(req, { maxBytes: 8192, requireJsonContentType: true })
        : { candidateId, expectedRevision: new URL(req.url, runtimeConfiguration.publicOrigin).searchParams.get('revision') };
      if (req.method === 'GET') {
        if (!/^(0|[1-9][0-9]*)$/.test(input.expectedRevision ?? '')) throw new SupplierImageSearchPreparationError('INPUT_INVALID');
        input.expectedRevision = Number(input.expectedRevision);
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 ||
          !Object.hasOwn(input, 'candidateId') || !Object.hasOwn(input, 'expectedRevision')) {
        throw new SupplierImageSearchPreparationError('INPUT_INVALID');
      }
      if (input?.candidateId !== candidateId) throw new SupplierImageSearchPreparationError('INPUT_INVALID');
      const preparationInput = { document, actor, candidateId, expectedRevision: input.expectedRevision };
      if (req.method === 'POST') requireSupplierImageSearchPreparation(preparationInput);
      return json(res, 200, readSupplierImageSearchPreparation(preparationInput));
    } catch (error) {
      if (!(error instanceof SupplierImageSearchPreparationError)) throw error;
      return json(res, error.code === 'PAGE_CONTRACT_UNCONFIGURED' ? 503 : error.code === 'INPUT_INVALID' ? 400 : 409,
        { code: error.code, message: '1688图搜尚未就绪；没有创建授权、作业或执行页面操作。' });
    }
  }

  const aProductDetailRoute=pathname.match(/^\/api\/candidates\/([^/]+)\/product-details(?:\/(authorize|continue))?$/);
  if(aProductDetailRoute && (req.method==='GET'&&!aProductDetailRoute[2] || req.method==='POST'&&aProductDetailRoute[2])) {
    const actor=runtimeIdentityProvider.resolveActor({request:req});
    if(actor.source!=='authenticated_identity_provider'||actor.actorType!=='human'||!actor.roles.includes('owner')) {
      throw httpError(403,'请先登录主人身份后查看商品详情准备。');
    }
    const candidateId=decodeURIComponent(aProductDetailRoute[1]);
    try {
      let operationResult=null;
      if(req.method==='POST') {
        const input=await readJsonRequestBody(req,{maxBytes:8192,requireJsonContentType:true});
        if(input?.candidateId!==candidateId)throw new AProductDetailError('INPUT_INVALID');
        const method=aProductDetailRoute[2]==='authorize'?'authorizeAndRun':'continueSavedCurrent';
        operationResult=await aProductDetailRuntime[method]({actor,input});
      }
      const document=await readData(),candidate=document.candidates.find(value=>value.id===candidateId);
      if(!candidate)throw httpError(404,'当前商品不存在。');
      const revisionText=new URL(req.url, runtimeConfiguration.publicOrigin).searchParams.get('revision');
      if(req.method==='GET'&&(!/^(0|[1-9][0-9]*)$/.test(revisionText??'')||!Number.isSafeInteger(Number(revisionText)))) {
        throw new AProductDetailError('INPUT_INVALID');
      }
      const expectedRevision=req.method==='GET'?Number(revisionText):candidate.dataRevision;
      return json(res,200,{...aProductDetailRuntime.view({document,actor,candidateId,expectedRevision}),operationResult});
    }catch(error) {
      if(!(error instanceof AProductDetailError))throw error;
      return json(res,error.code==='SERVICE_NOT_CONFIGURED'?503:error.code==='INPUT_INVALID'?400:409,
        {code:error.code,message:'商品详情未继续，请核对当前商品版本、许可和已保存的回执。'});
    }
  }

  const accountPreparationRoute=pathname.match(/^\/api\/account-preparations\/(create|authorize|continue|select-warehouse)$/);
  if(req.method==='GET'&&pathname==='/api/account-preparations'||req.method==='POST'&&accountPreparationRoute) {
    const actor=runtimeIdentityProvider.resolveActor({request:req});
    if(actor.source!=='authenticated_identity_provider'||actor.actorType!=='human'||!actor.roles.includes('owner'))throw httpError(403,'请先登录主人身份后准备账户。');
    if(req.method==='POST') {
      if(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')throw httpError(415,'账户准备只接受当前确认卡提交。');
      const origin=String(req.headers.origin||'');
      if(origin&&!allowedReviewOrigins.has(origin))throw httpError(403,'账户准备拒绝其他网页来源。');
    }
    try {
      if(req.method==='POST') {
        const input=await requestBody(req);
        if(!input||typeof input!=='object'||Array.isArray(input))throw httpError(400,'账户准备输入无效。');
        const actions={create:'createPreparation',authorize:'authorizeAndRun',continue:'continueSavedRead','select-warehouse':'selectWarehouse'};
        await ozonAccountDiscovery[actions[accountPreparationRoute[1]]]({actor,input});
      }
      const document=await readData();
      return json(res,200,ozonAccountDiscovery.view({document,actor}));
    }catch(error) {
      if(!(error instanceof OzonAccountReadError))throw error;
      const status=/NOT_CONFIGURED/.test(error.code)?503:/CHANGED|CONFLICT|EXPIRED|AMBIGUOUS|ALREADY_EXISTS/.test(error.code)?409:422;
      return json(res,status,{code:error.code,message:'账户准备未完成，请核对当前账户配置、准备记录与已保存的读取结果。'});
    }
  }

  const lifecycleBEvidencePrepareRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/b-evidence\/prepare$/);
  if (req.method === "POST" && lifecycleBEvidencePrepareRoute) {
    const candidateId = lifecycleBEvidencePrepareRoute[1];
    const input = await requestBody(req);
    const snapshot = await readData();
    const candidate = snapshot.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw httpError(404, "候选不存在");
    if (!Number.isSafeInteger(input.dataRevision) || input.dataRevision !== candidate.dataRevision) {
      throw httpError(409, "商品资料已变化，请刷新后重新开始一次只读取证");
    }
    if (activeDispatchForCandidate(snapshot, candidate.id)) {
      throw httpError(409, "当前SKU已有负责人任务，不能同时启动系统证据读取");
    }

    assertCandidateStoreBinding(candidate, runtimeConfiguration.storeBindings);
    try {
      assertGuooComparisonReadyForEvidence(candidate, runtimeConfiguration.guooTariffRuleVersion);
    } catch (error) {
      if (!(error instanceof GuooRouteComparisonError) || !["COMPARISON_REQUIRED", "COMPARISON_NOT_READY",
        "SAVED_RESULT_STALE", "RULE_VERSION_CONFLICT", "FROZEN_CANDIDATE_REVIEW_REQUIRED", "TRANSPORT_EVIDENCE_REQUIRED"].includes(error.code)) throw error;
      throw httpError(422, `${error.message}: 当前版本的物流比较尚未就绪，未调用外部证据提供器。`);
    }
    const plannedAt = now();
    const costReadiness = inspectLifecycleBCostReadiness({ candidate, rules: snapshot.rules, asOf: plannedAt });
    if (!costReadiness.ready) throw httpError(422, `B_COST_POLICY_REQUIRED: ${costReadiness.missing.join("、")}`, { costPolicyReadiness: costReadiness });
    const preparedCosts = buildLifecycleBExplicitOtherCosts(candidate, resolveLifecycleBProfitRule(candidate, snapshot.rules), { asOf: plannedAt });
    const providers = createLifecycleBRealEvidenceProviderRegistry({
      ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl,
      guooFilePath: runtimeConfiguration.guooTariffFile,
      cbrSourceUrl: process.env.SELECTION_REVIEW_CBR_FX_URL,
      ozonCommissionReference: runtimeConfiguration.ozonCommissionReference,
    });
    const run = await runLifecycleBEvidencePreparation({
      candidate,
      evidencePacks: snapshot.evidencePacks || [],
      currentCommissionCatalogs: snapshot.currentCommissionCatalogs ?? [],
      providers,
      plannedAt,
    });
    if (run.status !== "completed") {
      throw httpError(422, `B阶段系统证据读取已停止：${run.failure?.reason || "未知失败"}`, {
        evidencePreparation: run
      });
    }
    if (run.evidencePacksToCommit.length === 0) {
      const currentSnapshot = await readData();
      const current = currentSnapshot.candidates.find(item => item.id === candidateId);
      if (!current || current.dataRevision !== input.dataRevision) throw httpError(409, "取证期间商品资料已变化，复用结果已失效");
      try { assertLifecycleBCostsCurrent({ candidate: current, rules: currentSnapshot.rules, otherCosts: preparedCosts, asOf: now() }); }
      catch (error) {
        if (error.code !== "B_EVIDENCE_COST_POLICY_INCOMPLETE" && !error.code?.startsWith("B_COST_POLICY_")) throw error;
        throw httpError(409, error.message);
      }
      return json(res, 200, {
        evidencePreparation: run,
        evidencePacks: [],
        candidateStateChanged: false,
        dispatchesCreated: 0,
        platformWrites: 0
      });
    }

    const committed = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (current.dataRevision !== input.dataRevision) {
        throw httpError(409, "取证期间商品资料已变化，本轮结果未保存");
      }
      if (activeDispatchForCandidate(data, current.id)) {
        throw httpError(409, "取证期间SKU已被负责人领取，本轮结果未保存");
      }
      assertCandidateStoreBinding(current, runtimeConfiguration.storeBindings);
      try { assertLifecycleBCostsCurrent({ candidate: current, rules: data.rules, otherCosts: preparedCosts, asOf: now() }); }
      catch (error) {
        if (error.code !== "B_EVIDENCE_COST_POLICY_INCOMPLETE" && !error.code?.startsWith("B_COST_POLICY_")) throw error;
        throw httpError(409, error.message);
      }
      return commitLifecycleBEvidencePacks(data, run.evidencePacksToCommit, {
        createdAt: now(),
        currentCommissionCatalogs: data.currentCommissionCatalogs ?? [],
        createdBy: "selection_review_b_evidence"
      });
    });
    return json(res, 201, {
      evidencePreparation: run,
      evidencePacks: committed.map((pack) => ({
        id: pack.id,
        kind: pack.kind,
        scope: pack.scope,
        summary: pack.summary,
        sourceType: pack.sourceType,
        sourceRef: pack.sourceRef,
        checkedAt: pack.checkedAt,
        expiresAt: pack.expiresAt,
        ruleVersion: pack.ruleVersion,
        status: pack.status
      })),
      candidateStateChanged: false,
      dispatchesCreated: 0,
      platformWrites: 0
    });
  }

  /**
   * 「重新读一次费用证据」——主人点一次，只提交新的证据包，别的什么都不动。
   *
   * 这件商品的规格、货价、重量、包装、线路、运费、供货确认全部冻在 SKU 包里，这一步一个都不碰：
   * 它只把佣金和 Schema（以及过期了的汇率）按**这件商品自己已经冻结的适用范围**重读一遍，交进
   * `data.evidencePacks`。候选记录逐字节不变——包括 `dataRevision`，下面那道不变量当场兜住。
   *
   * 版本号必须原地不动，因为紧接着那一步（用更好的费用证据重算）把三件事钉死在当前这一版上：
   * 停止记录的 `sourceRevision`、运行时的 `inputRevision/outputRevision`，以及官方费表命中行里
   * 那个 `officialCommissionBinding.candidateRevision`。版本一涨，这三件当场全部过期，重读出来的
   * 证据自己把自己顶没了。所以这条路不写候选、不落线路比较（`appendGuooRouteComparison` 会涨一格）。
   *
   * 结论也不在这里改：重读只换证据，利润仍然是那份 conditional。要不要用新证据重算，是主人的第二次
   * 点击，那是另一个决定，不并到这一次里。
   */
  const lifecycleBEvidenceRefreshRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/b-evidence\/refresh$/);
  if (req.method === "POST" && lifecycleBEvidenceRefreshRoute) {
    const candidateId = lifecycleBEvidenceRefreshRoute[1];
    const input = await readJsonRequestBody(req, { maxBytes: 8192, requireJsonContentType: true });
    const fields = ["candidateId", "expectedRevision"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(input, field)) || input.candidateId !== candidateId ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return json(res, 400, { code: "B_EVIDENCE_REFRESH_INPUT_INVALID", message: "请从当前商品卡提交一次费用证据重读。", platformWrites: 0 });
    }
    // 只主人触发，绝不自动：没有登录身份的调用到不了任何只读提供器。
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "B_EVIDENCE_REFRESH_OWNER_REQUIRED", message: "请先登录主人身份后重读费用证据。", platformWrites: 0 });
    }
    const snapshot = await readData();
    const candidate = snapshot.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw httpError(404, "候选不存在");
    if (candidate.dataRevision !== input.expectedRevision) throw httpError(409, "商品资料已变化，请刷新后重新读取一次费用证据");
    if (activeDispatchForCandidate(snapshot, candidate.id)) {
      throw httpError(409, "当前SKU已有负责人任务，不能同时重读费用证据");
    }
    assertCandidateStoreBinding(candidate, runtimeConfiguration.storeBindings);
    try {
      assertGuooComparisonFrozenForEvidenceRefresh(candidate, runtimeConfiguration.guooTariffRuleVersion);
    } catch (error) {
      if (!(error instanceof GuooRouteComparisonError)) throw error;
      throw httpError(422, `${error.message}: 这件商品不满足重读费用证据的条件，未调用任何只读证据提供器。`);
    }
    const plannedAt = now();
    const costReadiness = inspectLifecycleBCostReadiness({ candidate, rules: snapshot.rules, asOf: plannedAt });
    if (!costReadiness.ready) throw httpError(422, `B_COST_POLICY_REQUIRED: ${costReadiness.missing.join("、")}`, { costPolicyReadiness: costReadiness });
    const preparedCosts = buildLifecycleBExplicitOtherCosts(candidate, resolveLifecycleBProfitRule(candidate, snapshot.rules), { asOf: plannedAt });
    // 不传 commissionEstimate：这条路只找比估算更好的证据。店里读不到实收、官方费表也命不中时，
    // 它就地失败、什么都不提交，绝不把主人签过的同一个估算再签一次当成「读到了新证据」。
    const providers = createLifecycleBRealEvidenceProviderRegistry({
      ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl,
      guooFilePath: runtimeConfiguration.guooTariffFile,
      cbrSourceUrl: process.env.SELECTION_REVIEW_CBR_FX_URL,
      ozonCommissionReference: runtimeConfiguration.ozonCommissionReference,
    });
    const run = await runLifecycleBEvidencePreparation({
      candidate,
      evidencePacks: snapshot.evidencePacks || [],
      currentCommissionCatalogs: snapshot.currentCommissionCatalogs ?? [],
      providers,
      plannedAt,
    });
    if (run.status !== "completed") {
      throw httpError(422, `重读费用证据已停止：${run.failure?.reason || "未知失败"}`, { evidencePreparation: run });
    }
    const committed = run.evidencePacksToCommit.length === 0 ? [] : await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (current.dataRevision !== input.expectedRevision) throw httpError(409, "重读期间商品资料已变化，本轮证据未保存");
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "重读期间SKU已被负责人领取，本轮证据未保存");
      assertCandidateStoreBinding(current, runtimeConfiguration.storeBindings);
      try { assertLifecycleBCostsCurrent({ candidate: current, rules: data.rules, otherCosts: preparedCosts, asOf: now() }); }
      catch (error) {
        if (error.code !== "B_EVIDENCE_COST_POLICY_INCOMPLETE" && !error.code?.startsWith("B_COST_POLICY_")) throw error;
        throw httpError(409, error.message);
      }
      // 已冻结的那一份记录在这一步里逐字节不变，版本号也在里面。这不是一句承诺：真被改了就抛，整笔回滚。
      return commitLifecycleBFeeEvidenceRefresh(data, candidateId, run.evidencePacksToCommit, {
        createdAt: now(),
        currentCommissionCatalogs: data.currentCommissionCatalogs ?? [],
        createdBy: "owner_b_evidence_refresh"
      });
    });
    const savedSnapshot = await readData();
    const savedCandidate = savedSnapshot.candidates.find((item) => item.id === candidateId);
    if (!savedCandidate) throw httpError(500, "重读结果待核对：未取得当前商品独立回读。");
    return json(res, committed.length === 0 ? 200 : 201, {
      evidencePreparation: run,
      evidencePacks: committed.map((pack) => ({
        id: pack.id,
        kind: pack.kind,
        scope: pack.scope,
        summary: pack.summary,
        sourceType: pack.sourceType,
        sourceRef: pack.sourceRef,
        checkedAt: pack.checkedAt,
        expiresAt: pack.expiresAt,
        ruleVersion: pack.ruleVersion,
        status: pack.status
      })),
      candidateStateChanged: false,
      platformWrites: 0,
      candidate: publicCandidate(savedCandidate, savedSnapshot.rules, {}, savedSnapshot.evidencePacks || [], savedSnapshot.currentCommissionCatalogs ?? [])
    });
  }

  if (req.method === "POST" && pathname === "/api/evidence-packs") {
    const input = await requestBody(req);
    if (!input.kind?.trim() || !input.summary?.trim() || !input.checkedAt || !input.sourceType?.trim()) {
      throw httpError(400, "共享证据包必须包含类型、摘要、来源类型和取得时间");
    }
    if (!input.scope || typeof input.scope !== "object" || Array.isArray(input.scope)) {
      throw httpError(400, "共享证据包必须包含明确适用范围");
    }
    if (Number.isNaN(new Date(input.checkedAt).getTime())) throw httpError(400, "共享证据取得时间无效");
    if (input.expiresAt && Number.isNaN(new Date(input.expiresAt).getTime())) throw httpError(400, "共享证据失效时间无效");
    if (/token|cookie|password|secret/i.test(JSON.stringify(input))) {
      throw httpError(400, "共享证据包不得包含Token、Cookie、密码或密钥字段");
    }
    const result = await mutateData((data) => {
      const kind = input.kind.trim();
      if (!data.rules.evidenceReuse?.reusableKinds?.includes(kind)) {
        throw httpError(422, "该证据类型不能跨SKU复用");
      }
      let scope;
      try { scope = normalizeEvidenceScope(kind, input.scope); }
      catch (error) {
        if (error.code !== "EVIDENCE_SCOPE_INVALID") throw error;
        throw httpError(422, error.message);
      }
      const requiredScope = {
        commission: ["platform", "store", "category", "salesScheme"],
        exchange_rate: ["pair"],
        logistics_tariff: ["route", "ruleVersion"],
        schema: ["platform", "store", "category", "ruleVersion"],
        electrical_rule: ["platform", "route", "ruleVersion"]
      }[kind] || [];
      const missingScope = requiredScope.filter((key) => !scope[key]);
      if (missingScope.length) throw httpError(422, `共享${kind}证据缺适用范围：${missingScope.join("、")}`);
      let evidenceData = null;
      if (input.evidenceData !== undefined) {
        if (!String(input.sourceRef || "").trim()) {
          throw httpError(422, `共享${kind}结构化数据必须包含可追溯来源`);
        }
        if (!input.expiresAt) {
          throw httpError(422, `共享${kind}结构化数据必须包含失效时间`);
        }
        if (Date.parse(input.expiresAt) <= Date.parse(input.checkedAt)) {
          throw httpError(422, `共享${kind}结构化数据失效时间必须晚于取得时间`);
        }
        const validation = validateLifecycleEvidenceData(kind, input.evidenceData);
        if (!validation.valid) {
          throw httpError(422, `共享${kind}结构化数据无效：${validation.errors.map((item) => `${item.path} ${item.message}`).join("；")}`);
        }
        evidenceData = structuredClone(input.evidenceData);
      }
      const scopeKey = evidenceScopeKey(kind, scope);
      const timestamp = now();
      const existing = (data.evidencePacks || []).find((pack) => pack.kind === kind && evidenceScopeMatches(kind, pack.scope, scope) && pack.status === "active");
      if (existing) existing.status = "superseded";
      const pack = {
        id: `EP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind,
        scope,
        scopeKey,
        summary: input.summary.trim(),
        sourceType: input.sourceType.trim(),
        sourceRef: String(input.sourceRef || "").trim(),
        checkedAt: new Date(input.checkedAt).toISOString(),
        expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
        ruleVersion: String(input.ruleVersion || "").trim(),
        evidenceData,
        status: "active",
        createdAt: timestamp,
        createdBy: String(input.createdBy || "task").trim()
      };
      data.evidencePacks.push(pack);
      return pack;
    });
    return json(res, 201, { evidencePack: result });
  }

  // 平台和店铺：录入页和上架关口的「平台 → 店铺」选择用。只读，只说身份配没配，不带卖家号等身份字段。
  if (req.method === "GET" && pathname === "/api/stores") {
    return json(res, 200, listStores({ storeBindings: runtimeConfiguration.storeBindings }));
  }

  // 商品中立核心：一款商品（原商品＋各颜色候选）的事实、变体组和素材集，以及按它算出的 Ozon / WB 上架缺口。只读，不写任何状态。
  const productCoreRoute = pathname.match(/^\/api\/product-core\/([^/]+)$/);
  if (req.method === "GET" && productCoreRoute) {
    const snapshot = await readData();
    try {
      const assembled = assembleProductCoreForFamily({ document: snapshot, candidateId: decodeURIComponent(productCoreRoute[1]), builtAt: now() });
      const profiles = { ozon: await loadPlatformProfile("ozon"), wb: await loadPlatformProfile("wb") };
      // ?wbSubject=734 按已保存的 WB 类目映射取属性；类目由人选定，这里不猜。
      const wbSubject = new URL(req.url, `http://${host}:${port}`).searchParams.get("wbSubject");
      const wbMapping = wbSubject ? await loadPlatformMapping("wb", wbSubject) : null;
      return json(res, 200, { ...assembled, listings: buildFamilyListingDrafts({ assembled, document: snapshot, profiles, wbMapping }), externalRequests: 0, platformWrites: 0 });
    } catch (error) {
      if (!(error instanceof ProductCoreFamilyError || error instanceof ProductCoreError || error instanceof PlatformProjectionError)) throw error;
      return json(res, /_MISSING$/.test(error.code) ? 404 : 409, { code: error.code, message: error.message, externalRequests: 0, platformWrites: 0 });
    }
  }

  if (req.method === "GET" && pathname === "/api/three-store-map") {
    return json(res, 200, buildThreeStoreMapView({
      runtimeArchitecture,
      seerfarSoftwareExecutionEnabled
    }));
  }

  // Legacy dispatch/comment compatibility only. This candidate progress view is
  // not the user-facing 全店能力地图 and must not be used as code-health evidence.
  if (req.method === "GET" && pathname === "/api/workflow-map") {
    const requestUrl = new URL(req.url, `http://${host}:${port}`);
    const selectedCandidateId = requestUrl.searchParams.get("candidateId") || "";
    const data = await readData();
    const state = responseState(data, req);
    const map = await readWorkflowMap(workflowMapFile);
    return json(res, 200, workflowMapView(map, data, state.candidates, selectedCandidateId));
  }

  if (req.method === "POST" && pathname === "/api/node-comments") {
    const input = await requestBody(req);
    if (!input.nodeId?.trim() || !input.message?.trim()) {
      throw httpError(400, "节点留言必须包含节点和内容");
    }
    if (input.action !== "record") {
      throw httpError(409, "小地图只保存节点留言；请回到商品评审主界面派发当前SKU");
    }
    const map = await readWorkflowMap(workflowMapFile);
    const node = map.nodes.find((item) => item.id === input.nodeId.trim());
    const result = await mutateData((data) => {
      const scope = input.scope === "workflow" ? "workflow" : "candidate";
      const candidate = scope === "candidate"
        ? data.candidates.find((item) => item.id === input.candidateId)
        : null;
      validateNodeExecution(node, scope, candidate);
      if (candidate && Number(candidate.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "商品资料已变化，请刷新小地图后重新提交");
      }
      const timestamp = now();
      const comment = {
        id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        actor: "user",
        message: input.message.trim(),
        nodeId: node.id,
        scope,
        dispatchId: null,
        requiresResponse: false,
        status: "recorded",
        replyTo: null,
        at: timestamp
      };
      if (scope === "workflow") data.workflowComments.push(comment);
      else {
        candidate.comments ||= [];
        candidate.comments.push(comment);
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = "user";
        addHistory(candidate, "user", "nodeCommented", `在${node.id} ${node.title}提交记录留言`, timestamp);
      }
      return { comment, dispatch: null };
    });
    json(res, 201, result);
    return;
  }

  const candidateDispatchRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/dispatch$/);
  if (req.method === "POST" && candidateDispatchRoute) {
    const input = await requestBody(req);
    if (input.trigger === "automatic_stage_continuation") {
      throw httpError(409, "B阶段通过后应进入待上架准备，不再由选品任务自动继续C阶段");
    }
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "派发必须提供当前数据修订号");
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const candidate = data.candidates.find((item) => item.id === candidateDispatchRoute[1]);
      if (!candidate) throw httpError(404, "候选不存在");
      if (Number(candidate.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已变化，请刷新后重新派发");
      }
      if (candidate.lifecycleV11?.opportunityPackage || candidate.lifecycleV11?.skuPackage) {
        throw httpError(409, "新版生命周期商品不能使用旧通用派发入口；A确认后自动进入B，B通过后自动进入C1，商品状态未改变");
      }
      if (candidate.workflowStatus === "codex_processing") {
        if (candidate.processing?.state !== "queued" || candidate.processing?.manualHold === true) {
          throw httpError(409, "当前商品尚未获得派发许可；已停止商品必须先在主界面选择恢复方式");
        }
      } else if (candidate.workflowStatus === "listing_preparation") {
        throw httpError(409, "请使用主界面的开始上架准备按钮启动C阶段");
      } else if (candidate.workflowStatus === "ready_to_list") {
        throw httpError(409, "可上架商品必须先完成精确生产确认卡，不能普通派发");
      } else {
        throw httpError(409, "当前业务阶段不能直接派发");
      }
      const nodeId = candidateActiveNode(candidate);
      const node = map.nodes.find((item) => item.id === nodeId);
      validateNodeExecution(node, "candidate", candidate);
      const timestamp = now();
      const comment = {
        id: `NC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        actor: "user",
        message: "主人从商品评审主界面明确派发当前SKU一次",
        nodeId: node.id,
        scope: "candidate",
        dispatchId: null,
        requiresResponse: true,
        status: "pending",
        replyTo: null,
        at: timestamp
      };
      candidate.comments ||= [];
      candidate.comments.push(comment);
      candidate.updatedAt = timestamp;
      candidate.lastModifiedBy = "user";
      const dispatch = createDispatchRecord(data, {
        node,
        scope: "candidate",
        candidate,
        message: comment.message,
        commentId: comment.id,
        trigger: "review_ui_dispatch"
      });
      comment.dispatchId = dispatch.id;
      dispatchId = dispatch.id;
      addHistory(
        candidate,
        "user",
        "reviewUiDispatched",
        `从商品评审主界面向${dispatch.assigneeTitle || dispatch.assigneeRole}派发当前SKU一次`,
        timestamp
      );
      return { candidate: publicCandidate(candidate, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 201, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("主界面一次性派发失败", error)), 0);
    return;
  }

  const dispatchContinueRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/continue$/);
  if (req.method === "POST" && dispatchContinueRoute) {
    const input = await requestBody(req);
    if (!input.message?.trim()) throw httpError(400, "继续原派发必须提供本轮纠正说明");
    if (!input.candidateId?.trim() || !Number.isInteger(input.dataRevision)) {
      throw httpError(400, "继续原派发必须锁定当前SKU和数据修订号");
    }
    let dispatchId = null;
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchContinueRoute[1]);
      if (!dispatch) throw httpError(404, "原派发不存在");
      if (isDisabledLegacyCDispatch(dispatch)) {
        throw httpError(409, "旧C阶段派发只保留为历史记录，不能继续或重新领取");
      }
      if (!["responded_unverified", "blocked", "needs_decision", "failed"].includes(dispatch.status)) {
        throw httpError(409, "原派发当前不是可继续的终止状态");
      }
      if (dispatch.candidateId !== input.candidateId.trim()) {
        throw httpError(409, "原派发与指定SKU不一致");
      }
      const candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
      if (!candidate) throw httpError(404, "原派发对应商品不存在");
      const gate = codexDispatchGate(candidate);
      if (!gate.allowed) throw httpError(409, gate.reason);
      if (Number(candidate.dataRevision) !== input.dataRevision || Number(dispatch.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料或原派发修订号已变化，不能继续旧派发", {
          currentRevision: candidate.dataRevision,
          dispatchRevision: dispatch.dataRevision
        });
      }
      const duplicate = data.dispatches.find((item) =>
        item.id !== dispatch.id &&
        item.candidateId === candidate.id &&
        ACTIVE_DISPATCH_STATES.has(item.status) &&
        !isDisabledLegacyCDispatch(item)
      );
      if (duplicate) throw httpError(409, "同一SKU已有其他工作正在等待或执行", { dispatchId: duplicate.id });

      const timestamp = now();
      dispatch.continuationHistory ||= [];
      dispatch.continuationHistory.push({
        turnId: dispatch.turnId || null,
        runId: dispatch.runId || null,
        status: dispatch.status,
        agentReply: dispatch.agentReply || "",
        failureLayer: dispatch.failureLayer || "",
        error: dispatch.error || "",
        completedAt: dispatch.turnCompletedAt || dispatch.lastEventAt || null,
        archivedAt: timestamp
      });
      dispatch.continuationCount = dispatch.continuationHistory.length;
      dispatch.continuedAt = timestamp;
      dispatch.continuationReason = input.reason?.trim() || "总控按主人纠正继续同一B阶段工作";
      dispatch.message = input.message.trim();
      dispatch.trigger = "control_continue_dispatch";
      dispatch.status = "queued";
      dispatch.runId = null;
      dispatch.turnId = null;
      dispatch.lastEventAt = timestamp;
      dispatch.pendingApproval = null;
      dispatch.agentReply = "";
      dispatch.completionEvidence = "";
      dispatch.deliveryAttemptedAt = null;
      dispatch.deliveryDetail = "";
      dispatch.deliveredAt = null;
      dispatch.startedAt = null;
      dispatch.turnCompletedAt = null;
      dispatch.turnStatus = null;
      dispatch.error = "";
      dispatch.failureLayer = "";
      dispatch.replyCommentId = null;
      dispatch.candidateSnapshot = dispatchCandidateSnapshot(candidate);
      candidate.processing = queueUserDispatch(candidate.processing, timestamp, "control_continue_dispatch");
      candidate.updatedAt = timestamp;
      candidate.lastModifiedBy = "control_task";
      addHistory(candidate, "control", "oneShotContinued", `原派发${dispatch.id}按主人纠正继续，不创建新派发`, timestamp);
      dispatchId = dispatch.id;
      return { candidate: publicCandidate(candidate, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("原派发继续失败", error)), 0);
    }
    return;
  }

  const productionAuthorizationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/production-authorization$/);

  /**
   * 读一次这个 Ozon 商品页 —— 主人在算利润那一步按下的那个按钮。
   *
   * 封闭输入：只有当前数据修订号。目标地址不接受主人或页面传进来，一律取候选自己已经保存的 Ozon 地址
   * （先看最新的销售快照，再看候选自身字段），规范化之后与商品编号核对；保存的地址指向不止一个商品编号时
   * 这里停下来说明冲突，不替主人挑一个去读。
   *
   * 建立的是一次受控作业，不是一次采集：服务端自己从不访问 www.ozon.ru。页面只能由主人自己的浏览器经插件打开，
   * 遇到验证码或登录墙由收集器如实回报 site_verification_required / site_login_required 并停下，不重试、不绕过、
   * 不伪造快照。落盘的快照 collectorMode 只能是 real_page_read_only，且只在插件真的回传了结果时才产生。
   */
  const salesCaptureStartRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/sales-capture\/start$/);
  if (req.method === "POST" && salesCaptureStartRoute) {
    const input = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
    // 不带 productUrl = 读这件商品自己的页面（原样）；带了 = 主人指名读一个对标页面。
    // 对标必须由主人指名：软件不替他从类目里挑「像的」商品当可比样本。
    if (!input || typeof input !== "object" || Array.isArray(input) || !Number.isInteger(input.dataRevision) ||
        Object.keys(input).some((field) => !["dataRevision", "productUrl"].includes(field)) ||
        (Object.hasOwn(input, "productUrl") && (typeof input.productUrl !== "string" || !input.productUrl.trim()))) {
      throw httpError(400, "读这个 Ozon 页面只接受当前数据修订号，以及可选的一个 Ozon 商品页地址",
        { code: "ozon_page_read_input_invalid" });
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后再读这个 Ozon 页面。", { code: "ozon_page_read_owner_required" });
    }
    const queued = await enqueueOzonPageReadJob({
      candidateId: decodeURIComponent(salesCaptureStartRoute[1]),
      requestRevision: input.dataRevision,
      requestedProductUrl: Object.hasOwn(input, "productUrl") ? input.productUrl.trim() : null
    });
    // The same receipt shape the 1688 capture request returns, so the page reuses its one start-signal path.
    return json(res, queued.duplicate ? 200 : 202, {
      status: "ozon_page_read_job_queued",
      candidate: queued.candidate,
      captureJob: queued.captureJob,
      duplicate: queued.duplicate,
      dispatch: null
    });
  }

  const salesCaptureResultRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/sales-capture\/result$/);
  if (req.method === "POST" && salesCaptureResultRoute) {
    const input = await requestBody(req);
    const session = salesCaptureSession(salesCaptureResultRoute[1], String(input.captureId || ""));
    if (!session || session.candidateId !== salesCaptureResultRoute[1]) throw httpError(409, "Ozon采集会话不存在或已失效");
    assertClaimedCaptureResultOrigin(session, req, "Ozon采集");
    if (!validCaptureToken(session.token, input.token)) throw httpError(403, "Ozon采集令牌无效");
    if (!Number.isInteger(input.dataRevision) || input.dataRevision !== session.dataRevision) throw httpError(409, "Ozon采集修订号不一致");
    if (!["captured", "failed"].includes(input.status)) throw httpError(400, "Ozon采集状态无效");

    let candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === session.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== session.dataRevision) throw httpError(409, "商品资料已变化，本次Ozon采集结果已拒绝");
      // "capturing" is what a claimed page-read record says; assertClaimedCaptureResultOrigin above already refuses
      // any result whose session was never claimed, so this only widens the record states that can still be settled.
      if (current.salesCapture?.captureId !== session.captureId ||
          !["waiting_extension", "capturing"].includes(current.salesCapture?.status)) {
        throw httpError(409, "当前商品不再等待这次Ozon采集结果");
      }
      const timestamp = now();
      if (input.status === "failed") {
        const code = String(input.failureCode || "system_error").trim();
        const observedAt = Number.isFinite(new Date(input.observedAt).getTime()) ? new Date(input.observedAt).toISOString() : timestamp;
        current.salesCapture = {
          ...current.salesCapture,
          status: "failed",
          // The record must also say the job itself is over. Left at "claimed" by the spread above, it would block
          // every later read through ozonPageReadAllowed and be closed a second time as lost on the next restart.
          jobStatus: "failed",
          technicalStatus: salesCaptureTechnicalStatus(code),
          failureCode: code,
          reason: ozonCaptureFailureMessage(code),
          observedAt,
          stoppedAt: timestamp,
          businessStateEffect: "unchanged",
          retryAttempted: false,
          writeOccurred: false
        };
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "system";
        addHistory(current, "system", "ozonSalesCaptureFailed", `Ozon只读采集已停止：${ozonCaptureFailureMessage(code)}；商品业务状态未改变`, timestamp);
        return publicCandidate(current, data.rules);
      }

      let snapshot;
      try {
        const validated = sanitizeOzonCaptureEvidence(input.evidence, session.expectedProductId, {
          captureId: session.captureId,
          snapshotId: `sales-snapshot:ozon:${session.expectedProductId}:${session.captureId}`
        });
        snapshot = {
          ...structuredClone(validated),
          sourceCandidateId: current.id,
          sourceDataRevision: session.requestRevision,
          productId: session.expectedProductId,
          captureId: session.captureId
        };
      } catch (error) {
        const code = String(error?.message || "invalid_capture");
        current.salesCapture = {
          ...current.salesCapture,
          status: "failed",
          // The record must also say the job itself is over. Left at "claimed" by the spread above, it would block
          // every later read through ozonPageReadAllowed and be closed a second time as lost on the next restart.
          jobStatus: "failed",
          technicalStatus: salesCaptureTechnicalStatus(code),
          failureCode: code,
          reason: ozonCaptureFailureMessage(code),
          observedAt: timestamp,
          stoppedAt: timestamp,
          businessStateEffect: "unchanged",
          retryAttempted: false,
          writeOccurred: false
        };
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "system";
        addHistory(current, "system", "ozonSalesCaptureRejected", "Ozon采集结果未通过服务端校验；商品业务状态未改变", timestamp);
        return publicCandidate(current, data.rules);
      }

      const snapshots = Array.isArray(current.salesSnapshotsV11) ? current.salesSnapshotsV11 : [];
      const stored = session.comparable === true ? { ...snapshot, comparable: true } : snapshot;
      if (!snapshots.some((item) => item.captureId === session.captureId)) snapshots.push(stored);
      current.salesSnapshotsV11 = snapshots;
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.salesCapture = {
        ...current.salesCapture,
        status: "verified",
        jobStatus: "completed",
        technicalStatus: "completed",
        snapshotId: snapshot.snapshotId,
        productId: snapshot.productId,
        title: snapshot.title,
        currentPrice: snapshot.currentPrice,
        currency: snapshot.currency,
        imageCount: snapshot.imageRefs.length,
        sellerType: snapshot.sellerType,
        marketScope: snapshot.marketScope,
        observedAt: snapshot.collectedAt,
        completedAt: timestamp,
        businessStateEffect: "unchanged",
        retryAttempted: false,
        writeOccurred: false
      };
      // 这一段原本假设「读页面发生在 A 确认之前」——那时候候选还没有真正的生命周期，
      // 用遗留适配器现造一个机会包是对的。2026-09-17 加了对标采集之后，读页面也会发生在 C 阶段，
      // 而这时候候选身上那份机会包是 A 确认真正冻下来的（带 marketAssessment 和 opportunity: 前缀的
      // parentOpportunityId）。照旧覆盖会把它换成遗留形态、marketAssessment 丢失、
      // lifecycleV11.status 被退回 opportunity_sales_snapshot_captured——已经实际损坏过主人的数据。
      // 已经有 skuPackage 就说明 A 早就确认过了：这时候读页面只记录快照和这次读取的回执，
      // 不重建机会包、也不动生命周期状态。
      const lifecycleStarted = !shouldRebuildOpportunityFromLegacy(current);
      const opportunityPackage = lifecycleStarted ? null : adaptLegacyCandidateToOpportunity(current);
      current.lifecycleV11 = {
        ...(current.lifecycleV11 || {}),
        ...(lifecycleStarted ? {} : {
          status: "opportunity_sales_snapshot_captured",
          opportunityPackage: structuredClone(opportunityPackage)
        }),
        sourceCandidateId: current.id,
        sourceCandidateRevision: current.dataRevision,
        platformWrites: Number(current.lifecycleV11?.platformWrites || 0),
        externalAccesses: [
          ...(Array.isArray(current.lifecycleV11?.externalAccesses) ? current.lifecycleV11.externalAccesses : []),
          {
            platform: "ozon",
            mode: "read_only_sales_snapshot",
            captureId: session.captureId,
            productId: session.expectedProductId,
            accessedAt: snapshot.collectedAt,
            writeOccurred: false
          }
        ]
      };
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "ozonSalesSnapshotCaptured", `已保存Ozon商品${session.expectedProductId}的当前销售快照；未推进业务阶段`, timestamp);
      return publicCandidate(current, data.rules);
    });
    // The lease ends the moment the result is durably recorded, before anything optional runs on top of it. Held open
    // across the Terra step, a throw there would leave the session alive and its timer would later close this very
    // record as "no result received" — overwriting the snapshot that had in fact just been saved.
    session.consumedAt = Date.now();
    clearSourceCaptureJobTimer(session.captureId);
    salesCaptureSessions.delete(session.captureId);
    if (input.status === "captured" && candidate.salesCapture?.status === "verified" && candidate.salesCapture?.snapshotId) {
      candidate = await enrichCapturedSalesSnapshotWithTerra(
        candidate.id,
        candidate.dataRevision,
        candidate.salesCapture.snapshotId
      );
    }
    return json(res, 200, { candidate, dispatch: null }, chromeExtensionCors(req));
  }

  /**
   * 录入页：贴链接、看「找货中」、对一件点「重跑」、对整页提示点「接着找」。都只建立或改 candidate.intake，排作业的是录入泵；
   * 主人贴链接这一下就是让软件把这几条读一遍、找一遍的授权，只读，不确认同款，不确认货源，不写任何平台。
   */
  if (req.method === "POST" && pathname === "/api/intake/links") {
    const input = await readJsonRequestBody(req, { maxBytes: 64 * 1024, requireJsonContentType: true });
    const attachTo = input?.attachTo;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((field) => !["links", "targetStore", "attachTo"].includes(field)) ||
        !Array.isArray(input.links) || input.links.some((link) => typeof link !== "string" || link.length > 4000) ||
        (Object.hasOwn(input, "targetStore") && !["miska", "dandanshu"].includes(input.targetStore)) ||
        (Object.hasOwn(input, "attachTo") && !(attachTo && typeof attachTo === "object" && !Array.isArray(attachTo) &&
          Object.keys(attachTo).length === 2 && typeof attachTo.candidateId === "string" && attachTo.candidateId.length > 0 &&
          attachTo.candidateId.length <= 200 && Number.isSafeInteger(attachTo.dataRevision) && attachTo.dataRevision >= 0))) {
      throw httpError(400, "贴链接的请求字段无效", { code: "intake_input_invalid" });
    }
    const actor = intakeOwner(req, "intake_owner_required");
    const parsed = parseIntakeLinks(input.links);
    if (parsed.tooMany) {
      throw httpError(400, `一次最多贴 ${INTAKE_MAX_LINKS_PER_PASTE} 条，请分几次贴`, { code: "intake_too_many_links" });
    }
    if (!parsed.links.length) {
      throw httpError(422, "没认出拼多多或 1688 的商品链接", { code: "intake_links_unrecognized", rejected: parsed.rejected });
    }
    if (attachTo) {
      // 「贴货源链接」：一条链接接到一件还没有能用货源的商品上，这件从读货源页重新走，不另建一件。
      if (parsed.links.length !== 1) throw httpError(400, "给一件商品贴货源时一次只贴一条链接", { code: "intake_attach_one_link" });
      const [link] = parsed.links;
      const busyCandidateId = captureControlSnapshot().candidateId;
      const item = await mutateData((data) => {
        const target = data.candidates.find((candidate) => candidate.id === attachTo.candidateId);
        if (!target) throw httpError(404, "要接货源的商品不存在", { code: "intake_attach_target_missing" });
        if (Number(target.dataRevision) !== attachTo.dataRevision) {
          throw httpError(409, "商品资料已变化，请刷新后再贴", { code: "revision_conflict" });
        }
        if (sourceCaptureAwaitsOwnerReview(target.sourceCapture)) {
          throw httpError(409, "这件上一次读货源页的结果未知，先重跑或核实那一次", { code: "intake_attach_needs_review" });
        }
        const submittedAt = now();
        const plan = intakeAttachPlan(target, link, { candidates: data.candidates, requestedAt: submittedAt, requestedBy: actor.userId,
          batchId: `INB-${randomUUID()}`, stillOpen: intakeStillBeforeGate1,
          busy: busyCandidateId === target.id || Boolean(activeDispatchForCandidate(data, target.id)) });
        if (!plan.ok) {
          throw httpError(409, INTAKE_ATTACH_MESSAGES[plan.code] ?? "这件现在不能接货源链接", { code: plan.code,
            ...(plan.duplicate ? { duplicateOfCandidateId: plan.duplicate.id, duplicateEliminated: plan.duplicate.workflowStatus === "eliminated" } : {}) });
        }
        target.intakeSourceHistory = [...(Array.isArray(target.intakeSourceHistory) ? target.intakeSourceHistory : []), plan.previous];
        target.sourceUrl = link.sourceUrl;
        target.intake = plan.intake;
        target.dataRevision = Number(target.dataRevision || 0) + 1;
        target.updatedAt = submittedAt;
        target.lastModifiedBy = "user";
        addHistory(target, "user", "intakeSourceAttached", `主人给这件贴了${INTAKE_SOURCE_LABELS[link.sourceKind]}货源链接；` +
          (plan.previous.sourceUrl ? "原来的货源链接和记录原样留在 intakeSourceHistory；" : "") +
          "软件会从读货源页开始重新找同款、粗算，不替主人确认同款或货源", submittedAt);
        return { candidateId: target.id, created: false, attached: true, duplicateOfCandidateId: null, duplicateEliminated: false,
          sourceKind: link.sourceKind };
      });
      scheduleIntakePump(0);
      return json(res, 200, { items: [item], rejected: parsed.rejected });
    }
    const items = await mutateData((data) => {
      const submittedAt = now();
      const batchId = `INB-${randomUUID()}`;
      const seen = parsed.links.map((link) => ({ link, duplicate: intakeDuplicateOf(data.candidates, link) }));
      const fresh = seen.filter((entry) => !entry.duplicate);
      return seen.map(({ link, duplicate }) => {
        if (duplicate) {
          return { candidateId: duplicate.id, created: false, duplicateOfCandidateId: duplicate.id,
            duplicateEliminated: duplicate.workflowStatus === "eliminated", sourceKind: link.sourceKind };
        }
        const created = createInitialCandidate({ input: { targetStore: input.targetStore ?? "miska", productName: INTAKE_PLACEHOLDER_NAME,
          sourceUrl: link.sourceUrl }, source: "user", id: nextCandidateId(data.candidates, "USR"), timestamp: submittedAt,
          storeBindings: runtimeConfiguration.storeBindings });
        created.intake = newIntakeRecord({ link, submittedAt, submittedBy: actor.userId, batchId,
          batchIndex: fresh.findIndex((entry) => entry.link === link), batchSize: fresh.length });
        addHistory(created, "user", "intakeSubmitted", `主人在录入页贴了这条${INTAKE_SOURCE_LABELS[link.sourceKind]}链接；软件会按顺序读货源页、` +
          "在 1688 和 Ozon 用首图找同款、粗算利润。只读不写，不替主人确认同款或货源，停下的步骤不会自动重跑", submittedAt);
        data.candidates.unshift(created);
        return { candidateId: created.id, created: true, duplicateOfCandidateId: null, duplicateEliminated: false, sourceKind: link.sourceKind };
      });
    });
    scheduleIntakePump(0);
    return json(res, items.some((item) => item.created) ? 201 : 200, { items, rejected: parsed.rejected });
  }

  if (req.method === "GET" && pathname === "/api/intake/queue") {
    // 工作台页面的开始信号桥每隔几秒来看一眼；它来过，排着的才有人把作业编号递给插件。
    if (new URL(req.url, runtimeConfiguration.publicOrigin).searchParams.get("bridge") === "1") {
      intakeBridgeSeenAt = Date.now();
      if (intakeHasOpenWork) scheduleIntakePump(0);
    }
    const data = await readData();
    const entries = intakeQueue(data.candidates);
    // 重启前排着、还没开始的商品接着往下走；停下的照旧停着，等主人点「重跑」。
    if (!intakePumpPrimed && entries.length > 0) {
      intakePumpPrimed = true;
      scheduleIntakePump(0);
    }
    // 同一次贴的里面已经找完的也列出来（「第 2 / 8 条 · 找完了」），整批都找完以后就只在「需要你处理」里了。
    const openBatches = new Set(entries.map(({ candidate }) => candidate.intake.batch?.id).filter(Boolean));
    const finished = data.candidates.filter((candidate) => candidate.intake?.stage === "ready" && candidate.workflowStatus !== "eliminated" &&
      openBatches.has(candidate.intake.batch?.id)).map((candidate) => ({ candidate, progress: intakeProgress(candidate), queue: null,
      batch: { position: candidate.intake.batch.index + 1, total: candidate.intake.batch.size } }));
    const extension = intakeExtensionState();
    return json(res, 200, {
      items: [...entries, ...finished].map(({ candidate, progress, queue, batch }) => ({
        candidateId: candidate.id, title: candidate.productName, imageUrl: candidate.imageUrl || null, sourceKind: candidate.intake.sourceKind,
        sourceUrl: candidate.intake.sourceUrl, submittedAt: candidate.intake.submittedAt, dataRevision: Number(candidate.dataRevision),
        stage: progress.stage, blocker: progress.blocker ?? null, queue, batch, roughProfit: candidate.roughProfit ?? null })),
      pause: intakePause(data.candidates),
      pendingStart: intakePendingStart(data.candidates),
      extension: { online: extension.online, versionOk: extension.versionOk, version: extension.version, requiredVersion: extension.requiredVersion,
        bridge: extension.bridge, login1688: intakeLogin1688State(data.candidates), lastStart: intakeLastStart }
    });
  }

  /** 页面把开始信号递给插件后，插件的回执（领了，或者为什么没领）。只记在内存里给「找货中」显示，不改任何商品。 */
  if (req.method === "POST" && pathname === "/api/intake/start-ack") {
    const input = await readJsonRequestBody(req, { maxBytes: 1024, requireJsonContentType: true });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "accepted,captureId,code,kind" ||
        typeof input.captureId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(input.captureId) || typeof input.accepted !== "boolean" ||
        typeof input.code !== "string" || !/^[a-z0-9_]{0,60}$/.test(input.code) ||
        !["supplier_capture", "supplier_image_match", "ozon_image_match"].includes(input.kind)) {
      throw httpError(400, "开始信号回执的字段无效", { code: "intake_start_ack_invalid" });
    }
    intakeOwner(req, "intake_owner_required");
    // 多个标签页都会递同一个编号；已经记下「领了」的，后来的「插件正忙」不盖掉它。
    if (!(intakeLastStart?.captureId === input.captureId && intakeLastStart.accepted)) {
      intakeLastStart = { captureId: input.captureId, kind: input.kind, accepted: input.accepted, code: input.code, at: now() };
    }
    return json(res, 200, { recorded: true });
  }

  const intakeRetryRoute = pathname.match(/^\/api\/intake\/([^/]+)\/retry$/);
  if (req.method === "POST" && intakeRetryRoute) {
    const input = await readJsonRequestBody(req, { maxBytes: 1024, requireJsonContentType: true });
    if (!input || typeof input !== "object" || Array.isArray(input) || !Number.isInteger(input.dataRevision) ||
        Object.keys(input).some((field) => field !== "dataRevision")) {
      throw httpError(400, "重跑只接受当前数据修订号", { code: "intake_retry_input_invalid" });
    }
    const actor = intakeOwner(req, "intake_owner_required");
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === intakeRetryRoute[1]);
      if (!current?.intake) throw httpError(404, "这件不是从录入页贴进来的", { code: "intake_not_found" });
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后再点重跑", { code: "revision_conflict" });
      if (current.workflowStatus === "eliminated") throw httpError(409, "这件已经不做了", { code: "candidate_eliminated" });
      const timestamp = now();
      const plan = intakeRetryPlan(current, { requestedAt: timestamp, requestedBy: actor.userId });
      if (!plan.ok) {
        throw httpError(409, plan.code === "intake_not_retryable" ? "这一步重跑也没用：请换一个货源链接，或者不做这件" : "这件没有停下，不用重跑",
          { code: plan.code });
      }
      applyIntakeRestart(current, plan, timestamp, `主人点了「重跑」：从「${INTAKE_STEP_LABELS[plan.step]}」这一步重新开始，只排一次，不会自动补跑`);
      return publicCandidate(current, data.rules);
    });
    scheduleIntakePump(0);
    return json(res, 202, { candidate, dispatch: null });
  }

  if (req.method === "POST" && pathname === "/api/intake/resume") {
    const input = await readJsonRequestBody(req, { maxBytes: 1024, requireJsonContentType: true });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
      throw httpError(400, "「接着找」不带任何字段", { code: "intake_resume_input_invalid" });
    }
    const actor = intakeOwner(req, "intake_owner_required");
    const resumed = await mutateData((data) => {
      const timestamp = now();
      const plans = intakeResumePlan(data.candidates, { requestedAt: timestamp, requestedBy: actor.userId, stillOpen: intakeStillBeforeGate1 });
      if (!plans.length) throw httpError(409, "现在没有停着等你的，不用接着找", { code: "intake_nothing_to_resume" });
      for (const plan of plans) {
        const current = data.candidates.find((item) => item.id === plan.candidateId);
        applyIntakeRestart(current, plan, timestamp, `主人在整页提示上点了「接着找」：从「${INTAKE_STEP_LABELS[plan.intake.lastRetry.step]}」` +
          "这一步接着往下，只排一次，不会自动补跑");
      }
      return plans.map((plan) => plan.candidateId);
    });
    scheduleIntakePump(0);
    return json(res, 202, { resumed, dispatch: null });
  }

  /**
   * 找同款（在 1688 用首图搜，或在 Ozon 用俄文词搜）：开始、插件回传、重新比对首图、主人逐条判断。这四步之外的任何事
   * （选 SKU、确认供货、改货源链接）都不在这里发生。开始只接受当前修订号，以及上次结果未知时主人「已知道」的那一声确认；
   * 在 Ozon 找还要带上这次搜的词。
   */
  const imageMatchRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/(image-match|ozon-match)\/(start|result|compare|judgement)$/);
  if (req.method === "POST" && imageMatchRoute && imageMatchRoute[3] !== "result") {
    const [, candidateId, routeName, action] = imageMatchRoute;
    const kind = routeName === "ozon-match" ? IMAGE_MATCH_KINDS.ozon : IMAGE_MATCH_KINDS.supplier;
    const prefix = kind.key === "ozon" ? "ozon_match" : "image_match";
    const fields = { start: ["dataRevision", "acknowledgeUnknownOutcome", ...(kind.key === "ozon" ? ["query", "searchBy"] : [])],
      compare: ["dataRevision", "captureId"], judgement: ["dataRevision", "captureId", kind.idField, "judgement"] }[action];
    const input = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
    if (!input || typeof input !== "object" || Array.isArray(input) || !Number.isInteger(input.dataRevision) ||
        Object.keys(input).some((field) => !fields.includes(field)) ||
        (Object.hasOwn(input, "acknowledgeUnknownOutcome") && typeof input.acknowledgeUnknownOutcome !== "boolean") ||
        // 在 Ozon 找同款：以图搜不带词；词搜（不写 searchBy 时也是词搜）必须带词。
        (action === "start" && kind.key === "ozon" && (Object.hasOwn(input, "searchBy") && !["image", "text"].includes(input.searchBy) ||
          (input.searchBy === "image" ? Object.hasOwn(input, "query") : typeof input.query !== "string" || input.query.length > 400))) ||
        (action !== "start" && (typeof input.captureId !== "string" || !new RegExp(`^${kind.idPrefix}-[A-Za-z0-9-]{1,80}$`).test(input.captureId))) ||
        (action === "judgement" && (typeof input[kind.idField] !== "string" || typeof input.judgement !== "string"))) {
      throw httpError(400, "找同款请求的字段无效", { code: `${prefix}_input_invalid` });
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后再找同款。",
        kind.key === "ozon" ? { code: "ozon_match_owner_required" } : { code: "image_match_owner_required" });
    }
    if (action === "start") {
      const queued = await enqueueImageMatchJob(kind, { candidateId, requestRevision: input.dataRevision,
        acknowledgeUnknownOutcome: input.acknowledgeUnknownOutcome === true, actor, input });
      // The same receipt shape as the other two capture requests, so the page reuses its one start-signal path.
      return json(res, queued.duplicate ? 200 : 202, {
        status: kind.key === "ozon" ? "ozon_image_match_job_queued" : "supplier_image_match_job_queued", candidate: queued.candidate,
        captureJob: queued.captureJob, duplicate: queued.duplicate, dispatch: null });
    }
    if (action === "compare" && imageMatchComparisonsInFlight.has(input.captureId)) {
      throw httpError(409, "这次找同款的首图正在比对，等它比完再说", { code: `${prefix}_comparison_in_flight` });
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已变化，请刷新后再操作", { code: "revision_conflict" });
      }
      if (current[kind.field]?.captureId !== input.captureId) {
        throw httpError(409, "这不是这件商品最近一次找同款的结果，请刷新后再操作", { code: `${prefix}_not_current` });
      }
      const timestamp = now();
      if (action === "compare") {
        try { current[kind.field] = kind.rules.comparisonRequested(current[kind.field]); }
        catch { throw httpError(409, "这次找同款还没有读回结果，没有首图可以比对", { code: `${prefix}_not_comparable` }); }
        addHistory(current, "user", `${kind.historyPrefix}CompareRequested`,
          `主人要求把这次 ${kind.site} 找同款的结果重新比对一次首图；结果和判断都不动`, timestamp);
      } else {
        const itemId = input[kind.idField];
        try {
          current[kind.field] = kind.rules.judged(current[kind.field], {
            itemId, judgement: input.judgement, judgedAt: timestamp, judgedBy: actor.userId });
        } catch (error) {
          const code = String(error?.message || "");
          if (code === `${prefix}_judgement_invalid`) throw httpError(400, "判断只能是 是同款 / 近似款 / 不是，或撤回", { code });
          if (code === (kind.key === "ozon" ? "ozon_match_product_unknown" : "image_match_offer_unknown")) {
            throw httpError(409, `这次找同款的结果里没有这个 ${kind.site} 商品`, { code });
          }
          throw httpError(409, "这次找同款还没有读回结果，不能判断", { code: `${prefix}_not_judgeable` });
        }
        const label = input.judgement === "clear" ? "撤回了判断" : `判断为「${SUPPLIER_IMAGE_MATCH_JUDGEMENT_LABELS[input.judgement]}」`;
        addHistory(current, "user", `${kind.historyPrefix}Judged`,
          `主人把 ${kind.itemLabel(itemId)} ${label}；这只是同款判断，不是供货确认，业务状态没有改变`, timestamp);
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      return publicCandidate(current, data.rules);
    });
    if (action === "compare") void runImageMatchComparison(kind, candidateId, input.captureId);
    return json(res, action === "compare" ? 202 : 200, { candidate, dispatch: null });
  }

  if (req.method === "POST" && imageMatchRoute) {
    const [, candidateId, routeName] = imageMatchRoute;
    const kind = routeName === "ozon-match" ? IMAGE_MATCH_KINDS.ozon : IMAGE_MATCH_KINDS.supplier;
    const input = await requestBody(req);
    const session = imageMatchSessionFor(kind, candidateId, String(input.captureId || ""));
    if (!session || session.candidateId !== candidateId) throw httpError(409, "找同款会话不存在或已失效", { code: "capture_session_invalid" });
    assertClaimedCaptureResultOrigin(session, req, kind.logLabel);
    if (!validCaptureToken(session.token, input.token)) throw httpError(403, "找同款令牌无效", { code: "capture_token_invalid" });
    if (!Number.isInteger(input.dataRevision) || input.dataRevision !== session.dataRevision) {
      throw httpError(409, "找同款修订号不一致", { code: "revision_conflict" });
    }
    if (session.jobStatus !== "claimed" || session.attempt !== 1) {
      throw httpError(409, "找同款作业尚未由插件原子领取，不能回传结果", { code: "capture_job_not_claimed" });
    }
    if (!["captured", "failed"].includes(input.status)) throw httpError(400, "找同款回传状态无效", { code: "capture_result_invalid" });
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === session.candidateId);
      if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
      // The record is bound by its captureId and the picture (and words) locked when the job was queued. Unlike a supplier
      // capture nothing else on the product feeds this read, so an unrelated save during the search must not throw the
      // result away and leave the record to be closed later as "结果未知".
      if (current[kind.field]?.captureId !== session.captureId || current[kind.field].status !== "searching") {
        throw httpError(409, "当前商品不再等待这次找同款结果", { code: "capture_job_state_conflict" });
      }
      const timestamp = now();
      const observedAt = Number.isFinite(new Date(input.observedAt).getTime()) ? new Date(input.observedAt).toISOString() : timestamp;
      if (input.status === "failed") {
        markImageMatchFailure(kind, current, kind.rules.failureCode(input.failureCode), { observedAt, timestamp });
        return publicCandidate(current, data.rules);
      }
      let evidence;
      try {
        evidence = kind.sanitize(input.evidence, session, current[kind.field]);
      } catch (error) {
        markImageMatchFailure(kind, current, kind.rules.failureCode(error?.message), { observedAt, timestamp });
        return publicCandidate(current, data.rules);
      }
      current[kind.field] = kind.rules.resultsRecorded(current[kind.field], evidence, timestamp);
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", `${kind.historyPrefix}ResultsSaved`, kind.resultsHistory(current[kind.field], evidence), timestamp);
      return publicCandidate(current, data.rules);
    });
    session.consumedAt = Date.now();
    clearSourceCaptureJobTimer(session.captureId);
    imageMatchSessions.delete(session.captureId);
    if (candidate[kind.field]?.status === "comparing") void runImageMatchComparison(kind, candidate.id, session.captureId);
    return json(res, 200, { candidate, dispatch: null }, chromeExtensionCors(req));
  }

  /**
   * The owner settles one capture record whose outcome this server never learned. It records exactly that — his own
   * acknowledgement that no result arrived — and nothing else: no capture evidence is invented, writeOccurred is not
   * touched, and workflowStatus, the lifecycle and every dispatch stay exactly as they were. The original failureCode
   * and reason stay on the record as history; jobStatus reaches a terminal value and reviewedAt lifts the
   * previous_capture_requires_review guard, so the owner can request a fresh capture for this product.
   */
  const sourceCaptureReviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-capture\/review$/);
  if (req.method === "POST" && sourceCaptureReviewRoute) {
    const input = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
    // Closed input: one revision, one fixed acknowledgement from a list. No free text ever reaches a saved record.
    if (!input || typeof input !== "object" || Array.isArray(input) || !Number.isInteger(input.dataRevision) ||
        Object.keys(input).some(field => !["dataRevision", "acknowledgement"].includes(field)) ||
        (Object.hasOwn(input, "acknowledgement") && !OWNER_CAPTURE_REVIEW_ACKNOWLEDGEMENTS.includes(input.acknowledgement))) {
      throw httpError(400, "核实历史采集记录只接受当前数据修订号和一个固定的确认选项", { code: "source_capture_review_input_invalid" });
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后核实这条采集记录。", { code: "source_capture_review_owner_required" });
    }
    const acknowledgement = input.acknowledgement ?? "no_result_received";
    const reviewedCandidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === sourceCaptureReviewRoute[1]);
      if (!current) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已变化，请刷新后再核实这条采集记录", { code: "revision_conflict" });
      }
      const capture = current.sourceCapture;
      if (!sourceCaptureOutcomeUnknown(capture)) {
        throw httpError(409, capture
          ? `这条采集记录的结果不是“未知”，不需要核实；当前采集状态：${capture.status || "未取得"}／作业状态：${capture.jobStatus || "未取得"}`
          : "这件商品没有需要核实的历史采集记录", { code: "source_capture_review_not_applicable" });
      }
      if (capture.reviewedAt) {
        throw httpError(409, "这条采集记录已经核实过，可以直接重新申请采集", { code: "source_capture_already_reviewed" });
      }
      const timestamp = now();
      current.sourceCapture = {
        ...capture,
        jobStatus: "failed",
        reviewedAt: timestamp,
        reviewedBy: "owner",
        acknowledgement
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "aSupplierCaptureReviewed",
        "主人确认这次1688采集没有可用结果：服务端没有收到任何采集证据，业务状态没有改变，也没有派发任务；现在可以重新申请一次采集",
        timestamp);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate: reviewedCandidate, sourceCapture: reviewedCandidate.sourceCapture, dispatch: null });
  }

  /**
   * 重新采集 — the owner asks for this same 1688 page to be read once more.
   *
   * This is the third time this project has demanded a precondition the application itself could not reach: after
   * `waiting_extension` deadlock and `unknown_outcome` with no exit, a capture that succeeded became its own dead end.
   * 申请插件采集 goes through /lifecycle/a-confirm, which stops creating jobs once a capture for the same link is
   * waiting on the owner's choice, so the only product captured before r17 kept its weightless specifications forever.
   *
   * The route is deliberately narrow: it accepts only a capture that is 已采到、等你选规格, it re-queues through
   * enqueueASupplierCaptureJob (same candidate, same saved 1688 link, same guards, same lease — there is no second
   * capture path), and it is honest about the price of a second read: the specifications this product is showing, and
   * any supply plan the owner had already frozen out of them, are voided in the same write that queues the new job.
   * It orders nothing, contacts no supplier and writes nothing to any platform.
   */
  const sourceCaptureRecaptureRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-capture\/recapture$/);
  if (req.method === "POST" && sourceCaptureRecaptureRoute) {
    const input = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
    // Closed input: one revision, and at most one fixed reason from a list. No free text ever reaches a saved record.
    if (!input || typeof input !== "object" || Array.isArray(input) || !Number.isInteger(input.dataRevision) ||
        Object.keys(input).some(field => !["dataRevision", "reason"].includes(field)) ||
        (Object.hasOwn(input, "reason") && !OWNER_CAPTURE_RECAPTURE_REASONS.includes(input.reason))) {
      throw httpError(400, "重新采集只接受当前数据修订号和一个固定的理由选项", { code: "source_capture_recapture_input_invalid" });
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后重新采集这个1688页面。", { code: "source_capture_recapture_owner_required" });
    }
    const candidateId = decodeURIComponent(sourceCaptureRecaptureRoute[1]);
    const snapshot = await readData();
    const snapshotCandidate = snapshot.candidates.find((item) => item.id === candidateId);
    if (!snapshotCandidate) throw httpError(404, "候选不存在", { code: "candidate_not_found" });
    if (Number(snapshotCandidate.dataRevision) !== input.dataRevision) {
      throw httpError(409, "商品资料已变化，请刷新后再重新采集", { code: "revision_conflict" });
    }
    const capture = snapshotCandidate.sourceCapture;
    // Only a finished capture waiting on the owner can be read again. A job still queued or running would be replaced
    // mid-flight, and a failed or unknown record has its own exits (申请插件采集 / source-capture/review).
    if (capture?.status !== "captured_waiting_owner_selection") {
      throw httpError(409, capture
        ? `只有已经采到、正等你选规格的商品才能重新采集；当前采集状态：${capture.status || "未取得"}／作业状态：${capture.jobStatus || "未取得"}`
        : "这件商品还没有采到过这个1688页面，请先申请一次插件采集", { code: "source_capture_recapture_not_applicable" });
    }
    if (activeDispatchForCandidate(snapshot, snapshotCandidate.id)) {
      throw httpError(409, "当前商品已有任务等待或运行，不能重新采集", { code: "candidate_busy" });
    }
    // The page this capture actually read, not a link the owner may have edited afterwards: a changed link already has
    // its own route, because a-confirm stops matching captureReadyForSameSource and queues a fresh job on its own.
    const queued = await enqueueASupplierCaptureJob({
      candidateId: snapshotCandidate.id,
      requestRevision: input.dataRevision,
      requestedSourceUrl: capture.sourceUrl || snapshotCandidate.sourceUrl || "",
      ownerRecapture: { reason: input.reason ?? null }
    });
    // The same receipt shape the capture request already returns, so the page reuses its one start-signal path.
    return json(res, queued.duplicate ? 200 : 202, {
      status: "supplier_capture_job_queued",
      candidate: queued.candidate,
      captureJob: queued.captureJob,
      duplicate: queued.duplicate,
      dispatch: null,
      bStarted: false,
      c1Created: false
    });
  }

  const sourceCaptureStartRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-capture\/start$/);
  if (req.method === "POST" && sourceCaptureStartRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "1688采集必须提供当前数据修订号");
    if (input.mode && !["listed_evidence_recovery", "a_supplier_capture"].includes(input.mode)) throw httpError(400, "1688采集模式无效");
    if (input.mode === "a_supplier_capture") {
      throw httpError(409, "A阶段独立采集按钮已停用：请在新版A确认卡保存供应链接，服务端会建立单候选作业并由插件后台自动领取", {
        code: "manual_a_supplier_capture_retired"
      });
    }
    if (input.mode === "listed_evidence_recovery") {
      throw httpError(409, "已上架1688补采等待插件后台claim协议接线，本次没有创建采集会话或业务写入", {
        code: "listed_source_capture_claim_protocol_required"
      });
    }
    if (!input.mode) {
      throw httpError(409, "旧1688上架采集入口已停用：新版流程必须在A阶段的一张确认卡内确认供应链接、具体SKU、价格、国内运费、采购成本、重量和尺寸；该入口不会创建旧C阶段派发");
    }
    const candidateId = sourceCaptureStartRoute[1];
    const existing = captureSession(candidateId);
    if (existing && existing.mode === input.mode && [existing.requestRevision, existing.dataRevision].includes(input.dataRevision)) {
      const data = await readData();
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      return json(res, 200, { candidate: publicCandidate(current, data.rules), ...captureSessionPublic(existing) });
    }
    ensureCaptureControlAvailable(candidateId);

    const session = {
      captureId: `SC-${randomUUID()}`,
      token: randomBytes(32).toString("base64url"),
      candidateId,
      requestRevision: input.dataRevision,
      dataRevision: null,
      expectedOfferId: "",
      sourceUrl: "",
      originalSourceUrl: "",
      createdAt: Date.now(),
      expiresAt: Date.now() + SOURCE_CAPTURE_TTL_MS,
      recoverySuggestion: String(input.recoverySuggestion || "").trim().slice(0, 1500),
      mode: input.mode
    };
    sourceCaptureSessions.set(session.captureId, session);
    let candidate;
    try {
      candidate = await mutateData((data) => {
        const current = data.candidates.find((item) => item.id === candidateId);
        if (!current) throw httpError(404, "候选不存在");
        if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后再采集1688");
        if (!sourceCaptureAllowed(current, session.mode)) throw httpError(409, "当前商品状态不能启动1688采集");
        if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务正在等待或运行");
        const source = normalize1688CaptureSource(current.sourceUrl);
        if (source.type === "invalid") throw httpError(422, "当前货源不是允许的1688精确链接或qr.1688.com短链");
        if (session.mode !== "a_supplier_capture" && source.type !== "detail") {
          throw httpError(422, "当前模式只接受可识别的1688精确商品链接");
        }
        const offerId = source.offerId;
        const timestamp = now();
        session.expectedOfferId = offerId;
        session.sourceUrl = source.sourceUrl;
        session.originalSourceUrl = source.sourceUrl;
        current.sourceCapture = {
          captureId: session.captureId,
          status: "waiting_extension",
          offerId,
          sourceUrl: session.sourceUrl,
          originalSourceUrl: session.originalSourceUrl,
          mode: session.mode,
          startedAt: timestamp,
          writeOccurred: false
        };
        if (session.mode === "listing_preparation") {
          current.workflowStatus = "listing_preparation";
          current.listingPreparation = {
            ...(current.listingPreparation || {}),
            status: "capturing_source",
            sourceCaptureId: session.captureId,
            requestedAt: timestamp,
            requestedBy: "user"
          };
          current.listingHandoff = {
            ...(current.listingHandoff || {}),
            state: "capturing_source",
            owner: "listing_task",
            runId: null,
            currentStep: "等待本机Chrome扩展读取当前1688商品",
            blockReason: null,
            defaultStock: 100
          };
        }
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        session.dataRevision = current.dataRevision;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "user";
        const startAction = session.mode === "listed_evidence_recovery"
          ? "listedSourceCaptureStarted"
          : session.mode === "a_supplier_capture"
            ? "aSupplierCaptureStarted"
            : "sourceCaptureStarted";
        const startDetail = session.mode === "listed_evidence_recovery"
          ? "主人为已上架商品启动一次性1688只读补采；原上架记录保持不变，尚未派发任务"
          : session.mode === "a_supplier_capture"
            ? "主人在A阶段启动一次性1688供应采集；只等待结构化证据，不自动选择SKU、确认供应方案、运行B/C1或派发任务"
            : "主人从评审台启动当前SKU的一次性1688只读采集；尚未派发任务";
        addHistory(current, "user", startAction, startDetail, timestamp);
        return publicCandidate(current, data.rules);
      });
    } catch (error) {
      sourceCaptureSessions.delete(session.captureId);
      throw error;
    }
    return json(res, 201, { candidate, ...captureSessionPublic(session) });
  }

  const sourceCaptureResultRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-capture\/result$/);
  if (req.method === "POST" && sourceCaptureResultRoute) {
    const input = await requestBody(req);
    const session = captureSession(sourceCaptureResultRoute[1], String(input.captureId || ""));
    if (!session || session.candidateId !== sourceCaptureResultRoute[1]) throw httpError(409, "1688采集会话不存在或已失效", { code: "capture_session_invalid" });
    assertClaimedCaptureResultOrigin(session, req, "1688采集");
    if (!validCaptureToken(session.token, input.token)) throw httpError(403, "1688采集令牌无效", { code: "capture_token_invalid" });
    if (!Number.isInteger(input.dataRevision) || input.dataRevision !== session.dataRevision) throw httpError(409, "1688采集修订号不一致", { code: "revision_conflict" });
    if (session.mode === "a_supplier_capture" && session.jobStatus &&
      (session.jobStatus !== "claimed" || session.attempt !== 1)) {
      throw httpError(409, "A阶段采集作业尚未由插件原子领取，不能回传结果", { code: "capture_job_not_claimed" });
    }
    if (!['captured', 'failed'].includes(input.status)) throw httpError(400, "1688采集状态无效", { code: "capture_result_invalid" });
    let failedResult = null;
    if (input.status === "failed") {
      try {
        failedResult = sanitizeSourceCaptureFailureResult(input);
      } catch {
        throw httpError(400, "1688采集失败分类不符合脱敏白名单", { code: "capture_failure_diagnostics_invalid" });
      }
    }
    let dispatchId = null;
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === session.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== session.dataRevision) throw httpError(409, "商品资料已变化，本次采集结果已拒绝", { code: "revision_conflict" });
      if (current.sourceCapture?.captureId !== session.captureId || current.sourceCapture?.status !== "waiting_extension") {
        if (!(session.mode === "a_supplier_capture" && current.sourceCapture?.captureId === session.captureId && current.sourceCapture?.status === "capturing")) {
          throw httpError(409, "当前SKU不再等待这次采集结果", { code: "capture_job_state_conflict" });
        }
      }
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务，不能接收采集结果");

      if (input.status === "failed") {
        markSourceCaptureFailure(
          current,
          session,
          failedResult.failureCode,
          "",
          failedResult.observedAt,
          failedResult.failureDiagnostics
        );
        return publicCandidate(current, data.rules);
      }

      let evidence;
      try {
        const resolvedSourceUrl = String(input.resolvedSourceUrl || session.sourceUrl || "").trim();
        // The platform is fixed by the link the owner saved, never by where the extension says it landed.
        const pinduoduo = session.mode === "a_supplier_capture" && supplierCapturePlatform(session.sourceUrl) === "pinduoduo";
        const resolvedOfferId = pinduoduo ? extractPinduoduoGoodsId(resolvedSourceUrl) : extract1688OfferId(resolvedSourceUrl);
        if (!resolvedOfferId) throw new Error(session.mode === "a_supplier_capture" ? "short_link_resolution_failed" : "wrong_offer");
        if (session.expectedOfferId && session.expectedOfferId !== resolvedOfferId) throw new Error("wrong_offer");
        evidence = pinduoduo ? sanitizePinduoduoEvidence(input.evidence, resolvedOfferId) : sanitize1688Evidence(input.evidence, resolvedOfferId);
      } catch (error) {
        const code = String(error?.message || "invalid_capture");
        markSourceCaptureFailure(current, session, code, "扩展回传未通过服务端校验");
        return publicCandidate(current, data.rules);
      }
      if (session.mode === "a_supplier_capture") {
        markAStageCaptureNeedsOwnerSelection(current, session, evidence);
        return publicCandidate(current, data.rules);
      }
      const suggested = resolveCapturedSku(current, evidence);
      markSourceCaptureNeedsSelection(current, session, evidence, {
        choices: evidence.skus,
        matchTerms: suggested.matchTerms || [],
        matches: suggested.selected ? [suggested.selected] : suggested.matches || []
      });
      return publicCandidate(current, data.rules);
    });
    session.consumedAt = Date.now();
    session.jobStatus = input.status === "captured" ? "completed" : "failed";
    clearSourceCaptureJobTimer(session.captureId);
    sourceCaptureSessions.delete(session.captureId);
    const data = await readData();
    const dispatch = dispatchId ? data.dispatches.find((item) => item.id === dispatchId) : null;
    json(res, 200, { candidate, dispatch: dispatchPublic(dispatch) }, chromeExtensionCors(req));
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("1688采集后派发失败", error)), 0);
    }
    return;
  }

  const sourceCaptureSelectRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-capture\/select-sku$/);
  if (req.method === "POST" && sourceCaptureSelectRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "选择1688 SKU必须提供当前数据修订号");
    if (!Array.isArray(input.sourceSkuIds) || !input.sourceSkuIds.length) throw httpError(400, "请至少选择一个1688 SKU");
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === sourceCaptureSelectRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新选择SKU");
      if (current.sourceCapture?.mode === "a_supplier_capture") {
        throw httpError(409, "新版A阶段确认卡当前只提供本地临时多选，不通过旧接口保存、确认供应方案或进入B/C1");
      }
      if (current.sourceCapture?.status !== "needs_sku_selection") throw httpError(409, "当前商品不在等待选择1688 SKU");
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务正在等待或运行");
      if (current.sourceCapture.mode !== "listed_evidence_recovery") {
        throw httpError(409, "旧1688选择入口只保留历史读取，不再创建C阶段派发；请使用新版A阶段确认卡");
      }
      const evidence = {
        offerId: current.sourceCapture.offerId,
        sourceUrl: current.sourceCapture.sourceUrl,
        title: current.sourceCapture.title,
        observedAt: current.sourceCapture.observedAt,
        collectionMethod: current.sourceCapture.collectionMethod,
        titleSource: current.sourceCapture.titleSource,
        offerIdSource: current.sourceCapture.offerIdSource,
        priceRanges: current.sourceCapture.priceRanges || [],
        supplierAttributes: current.sourceCapture.supplierAttributes || {},
        skus: current.sourceCapture.skuChoices || []
      };
      const resolution = resolveCapturedSkus(evidence, input.sourceSkuIds);
      if (resolution.status === "invalid_selection") throw httpError(422, "选择的SKU不在本次采集结果中");
      if (current.sourceCapture.mode === "listed_evidence_recovery") {
        saveListedSourceEvidence(current, evidence, resolution);
        return publicCandidate(current, data.rules);
      }
      const sessionLike = { captureId: current.sourceCapture.captureId };
      const dispatch = queueCapturedListingPreparation(data, map, current, sessionLike, evidence, resolution, "listing_preparation_source_capture_skus_selected");
      dispatchId = dispatch.id;
      return publicCandidate(current, data.rules);
    });
    const data = await readData();
    const dispatch = data.dispatches.find((item) => item.id === dispatchId);
    json(res, 200, { candidate, dispatch: dispatchPublic(dispatch) });
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("选择1688 SKU后派发失败", error)), 0);
    }
    return;
  }

  const listingPreparationStartRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/start-listing-preparation$/);
  if (req.method === "POST" && listingPreparationStartRoute) {
    await requestBody(req);
    throw httpError(409, "旧“开始上架准备”入口已停用：awaiting_user_start只作为历史状态读取；新版商品必须由B通过后自动进入C1，调用本接口不会改变商品状态");
  }

  // 「做这件」确认卡的三条写入路：POST /api/candidates/:id/gate1/(accept|skip|shortfall)。
  if (await gate1Route(req, res, pathname)) return;

  /**
   * The owner drops one product from wherever it is, and takes it back when that was a mistake.
   * Owner rule 2026-09-11: every list must offer this, so the desk, the board, the inbox and the product page all send
   * the same request. It is deliberately the smallest possible write: the status the existing queues already know
   * ("eliminated"), the instant, one optional reason from the same five words the desk already offers, and one history
   * line. No dispatch is created, no platform is touched, and no other saved record is rewritten — which is why
   * restoring can put the product back exactly where it was, from the status kept beside the elimination.
   */
  const workflowEliminationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/workflow\/(eliminate|restore)$/);
  if (req.method === "POST" && workflowEliminationRoute) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后淘汰或恢复商品。");
    }
    const candidateId = decodeURIComponent(workflowEliminationRoute[1]);
    const eliminating = workflowEliminationRoute[2] === "eliminate";
    const input = await readJsonRequestBody(req, { maxBytes: 2048, requireJsonContentType: true });
    const allowedKeys = eliminating ? ["dataRevision", "reason"] : ["dataRevision"];
    if (input === null || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => !allowedKeys.includes(key))) {
      throw httpError(400, eliminating ? "淘汰只接受当前数据修订号和一个理由" : "恢复只接受当前数据修订号");
    }
    if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) {
      throw httpError(400, eliminating ? "淘汰商品必须提供当前数据修订号" : "恢复商品必须提供当前数据修订号");
    }
    // The same five words the desk already offers; free text is not accepted anywhere in this flow.
    const reason = input.reason === undefined || input.reason === null ? null : input.reason;
    if (reason !== null && !A_DISCOVERY_DECLINE_REASONS.includes(reason)) {
      throw httpError(400, "淘汰理由必须是给定的几个选项之一");
    }
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, eliminating ? "商品资料已变化，请刷新后重新淘汰" : "商品资料已变化，请刷新后重新恢复",
          { currentRevision: current.dataRevision });
      }
      const timestamp = now();
      if (eliminating) {
        if (current.workflowStatus === "eliminated") throw httpError(409, "这件商品已经在已淘汰里了");
        current.eliminatedFromStatus = current.workflowStatus;
        current.workflowStatus = "eliminated";
        current.eliminatedAt = timestamp;
        current.eliminationReason = reason === null ? "主人淘汰" : `主人淘汰：${reason}`;
        // Idle plus manual hold is how the A card's own 淘汰 leaves a product: nothing is queued, nothing resumes by itself.
        current.processing = { ...queuedProcessing(current.processing), state: "idle", manualHold: true };
        addHistory(current, "user", "ownerEliminated",
          `主人在列表里淘汰当前商品${reason === null ? "" : `：${reason}`}；未派发任务、未访问平台，可随时恢复`, timestamp);
      } else {
        if (current.workflowStatus !== "eliminated") throw httpError(409, "这件商品不在已淘汰里，不需要恢复");
        const previous = typeof current.eliminatedFromStatus === "string" &&
          OWNER_RESTORABLE_STATUSES.includes(current.eliminatedFromStatus) ? current.eliminatedFromStatus : null;
        current.workflowStatus = previous ?? "needs_user_data";
        current.eliminatedAt = null;
        current.eliminationReason = "";
        current.eliminatedFromStatus = null;
        current.processing = { ...queuedProcessing(current.processing), state: "idle", manualHold: true };
        addHistory(current, "user", "ownerRestored",
          previous === null
            ? "主人恢复当前商品；淘汰前的状态没有可靠记录，已放回「需你补资料」，没有自动继续任何步骤"
            : "主人恢复当前商品，回到淘汰前的状态；没有自动继续任何步骤", timestamp);
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      assertSafeBusinessMutationCandidate(current, "businessMutation.candidate");
      return { candidate: publicCandidate(current, data.rules), dispatch: null };
    });
    return json(res, 200, result);
  }

  const supplierDraftRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/supplier-draft$/);
  if (supplierDraftRoute && ["GET", "POST"].includes(req.method)) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后填写找货资料。");
    }
    const candidateId = decodeURIComponent(supplierDraftRoute[1]);
    try {
      if (req.method === "GET") {
        // Opening 找货 derives the market snapshot once from the already-saved discovery receipt; it reads nothing external.
        const prepared = await mutateDataWhenChanged((data) => {
          const current = data.candidates.find((item) => item.id === candidateId);
          if (!current) throw httpError(404, "候选不存在");
          const outcome = ensureDiscoveryMarketSalesSnapshot({ document: data, candidate: current });
          if (!outcome.changed) return { changed: false, result: null };
          assertSafeBusinessMutationCandidate(current, "businessMutation.candidate");
          current.updatedAt = now();
          addHistory(current, "system", "discoveryMarketSnapshotDerived",
            "已按本次查询回执保存市场快照（只读引用服务商记录，未访问平台、未改变阶段）", current.updatedAt);
          return { changed: true, result: outcome.snapshot.snapshotId };
        });
        void prepared;
        const document = await readData();
        const candidate = document.candidates.find((item) => item.id === candidateId);
        if (!candidate) throw httpError(404, "候选不存在");
        return json(res, 200, await supplierDraftView(document, candidate));
      }
      const input = await readJsonRequestBody(req, { maxBytes: 8192, requireJsonContentType: true });
      const normalized = normalizeSupplierDraftInput(input);
      const snapshot = await readData();
      const snapshotCandidate = snapshot.candidates.find((item) => item.id === candidateId);
      if (!snapshotCandidate) throw httpError(404, "候选不存在");
      if (Number(snapshotCandidate.dataRevision) !== normalized.dataRevision) {
        throw httpError(409, "商品资料已变化，请刷新后重新保存找货资料", { currentRevision: snapshotCandidate.dataRevision });
      }
      const timestamp = now();
      const draft = buildSupplierDraftV1(normalized, { declaredAt: timestamp });
      const estimate = await supplierDraftEstimate(snapshot, snapshotCandidate, draft);
      await mutateData((data) => {
        const current = data.candidates.find((item) => item.id === candidateId);
        if (!current) throw httpError(404, "候选不存在");
        if (Number(current.dataRevision) !== normalized.dataRevision) {
          throw httpError(409, "商品资料已变化，请刷新后重新保存找货资料", { currentRevision: current.dataRevision });
        }
        current.supplierDraftV1 = structuredClone(draft);
        current.supplierDraftEstimateV1 = estimate === null ? null : structuredClone(estimate);
        // The same declaration also fills the per-field owner columns the older cards already read, so nothing regresses.
        current.sourceUrl = draft.sourceUrl;
        current.purchasePriceRmb = draft.allInPurchaseRmb;
        current.domesticShippingRmb = draft.domesticShippingRmb;
        current.packedWeightKg = draft.packedWeightKg;
        current.dimensionsCm = { ...draft.dimensionsCm };
        current.expectedPriceRub = draft.targetSalePriceRub;
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "user";
        assertSafeBusinessMutationCandidate(current, "businessMutation.candidate");
        addHistory(current, "user", "supplierDraftDeclared",
          "主人填写的找货方案已保存为主人声明资料；未确认供货、未开始采集、未形成正式利润结论。", timestamp);
        return current.dataRevision;
      });
      const savedDocument = await readData();
      const savedCandidate = savedDocument.candidates.find((item) => item.id === candidateId);
      if (!savedCandidate) throw httpError(404, "候选不存在");
      return json(res, 200, await supplierDraftView(savedDocument, savedCandidate));
    } catch (error) {
      if (error instanceof SupplierDraftError) throw httpError(error.status, error.message, { code: error.code });
      throw error;
    }
  }

  /**
   * 选定 — the owner picks which of the captured specifications this product will be listed with.
   *
   * Why this is not the older /source-capture/select-sku route: that route carries a different business meaning. It
   * only accepts a capture in `needs_sku_selection` + `listed_evidence_recovery`, it refuses `a_supplier_capture`
   * outright, and its whole point is to verify the capture and hand a C-stage dispatch to the listing task. This step
   * hands nothing to anyone. It records which specifications the owner chose and freezes them into this product's
   * supply plan through the same `adapt1688CaptureToSupplierOption` the A card already uses — no dispatch, no
   * supplier contact, no platform write, and the capture keeps the status the A confirmation still reads.
   */
  const skuChoiceRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/sku-choice$/);
  if (req.method === "POST" && skuChoiceRoute) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后选规格。");
    }
    const candidateId = decodeURIComponent(skuChoiceRoute[1]);
    const input = await readJsonRequestBody(req, { maxBytes: 16384, requireJsonContentType: true });
    if (input === null || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => !["dataRevision", "sourceSkuIds"].includes(key))) {
      throw httpError(400, "选规格只接受当前数据修订号和你勾选的规格");
    }
    if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) {
      throw httpError(400, "选规格必须提供当前数据修订号");
    }
    if (!Array.isArray(input.sourceSkuIds) || input.sourceSkuIds.length === 0 || input.sourceSkuIds.length > 200 ||
        input.sourceSkuIds.some(id => typeof id !== "string" || id.trim() === "" || id.length > 160)) {
      throw httpError(400, "请至少勾选一个规格");
    }
    const requestedSkuIds = [...new Set(input.sourceSkuIds.map(id => id.trim()))];
    const timestamp = now();
    await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已变化，请刷新后重新选规格", { currentRevision: current.dataRevision });
      }
      const capture = current.sourceCapture;
      if (!capture || capture.status !== "captured_waiting_owner_selection" ||
          !Array.isArray(capture.skuChoices) || capture.skuChoices.length === 0) {
        throw httpError(409, "这件商品现在没有等你挑的规格", { code: "sku_choice_not_available" });
      }
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前商品已有任务正在等待或运行");
      const resolution = resolveCapturedSkus({ skus: capture.skuChoices }, requestedSkuIds);
      if (resolution.status !== "matched") {
        throw httpError(422, "勾选的规格不在这次采到的结果里", { code: "sku_choice_invalid" });
      }
      let supplierOption;
      try {
        supplierOption = adapt1688CaptureToSupplierOption({ ...capture, skus: resolution.selected },
          { evidenceRef: `source-capture:${capture.captureId}` });
      } catch (error) {
        throw httpError(422, `这些规格还不能锁进供货方案：${error instanceof Error ? error.message : String(error)}`,
          { code: "sku_choice_supply_plan_invalid" });
      }
      const selectedSkuIds = resolution.selected.map((sku) => sku.sourceSkuId);
      const missingWeightSkuIds = resolution.selected
        .filter((sku) => !(Number(sku?.weight?.value) > 0)).map((sku) => sku.sourceSkuId);
      current.sourceCapture = {
        ...capture,
        selectedSkuIds,
        // The frozen supply plan for exactly the chosen specifications, beside the capture that evidenced them.
        skuSelection: {
          schemaVersion: "source-capture-sku-selection-v1",
          selectedBy: "owner",
          selectedAt: timestamp,
          selectedSkuIds,
          missingWeightSkuIds,
          missingDirectPriceSkuIds: resolution.missingDirectPriceSkuIds || [],
          supplierOption: structuredClone(supplierOption)
        }
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      assertSafeBusinessMutationCandidate(current, "businessMutation.candidate");
      const gapText = missingWeightSkuIds.length ? `；其中${missingWeightSkuIds.length}个规格页面没有给出重量，运费与利润留空未补` : "";
      addHistory(current, "user", "aSupplierSkuChoiceSaved",
        `主人选定了${selectedSkuIds.length}个1688规格并锁进本商品的供货方案：${resolution.selected.map(capturedSkuLabel).join("；")}${gapText}；未派发任务、未联系供应商、未向平台写入任何内容`,
        timestamp);
      return current.dataRevision;
    });
    const savedDocument = await readData();
    const savedCandidate = savedDocument.candidates.find((item) => item.id === candidateId);
    if (!savedCandidate) throw httpError(404, "候选不存在");
    return json(res, 200, await supplierDraftView(savedDocument, savedCandidate));
  }

  /**
   * 运输属性 — the owner's own declaration of what this product is, for transport.
   *
   * This is the entrance that was missing. `compareGuooRoutes` answers `unknown` for every line while the cargo
   * facts are absent, so `transportVerified` stays false and B refuses — correctly, because a worked-out freight
   * figure is not a checked transport method. Nothing in the product page could state those facts, so the refusal
   * landed on every product. This route records them, and only records them: no dispatch, no supplier contact,
   * no platform write, and no profit conclusion — 算利润 is still a separate click afterwards.
   *
   * The software proposes from evidence it holds and saves that proposal beside the owner's answer, so the record
   * says which of the two the values came from. It never signs for him: the five values written here are the five
   * he confirmed, and the history line says so.
   */
  const cargoFactsRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/cargo-facts$/);
  if (req.method === "POST" && cargoFactsRoute) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后确认运输属性。");
    }
    const candidateId = decodeURIComponent(cargoFactsRoute[1]);
    const input = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
    const accepted = ["dataRevision", ...CARGO_FACT_KEYS];
    if (input === null || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== accepted.length || accepted.some(key => !Object.hasOwn(input, key))) {
      throw httpError(400, "确认运输属性只接受当前数据修订号和这五项：带不带电、电池瓦时、是不是普货、个人自用还是商业用、是不是异形件");
    }
    if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) {
      throw httpError(400, "确认运输属性必须提供当前数据修订号");
    }
    const { dataRevision: _revision, ...declared } = input;
    const validation = validateOwnerCargoFactsDeclaration(declared);
    if (!validation.valid) {
      throw httpError(422, `这份运输属性不能保存：${validation.errors.map(item => item.message).join("；")}`,
        { code: "cargo_facts_invalid", errors: validation.errors });
    }
    const timestamp = now();
    await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已变化，请刷新后重新确认运输属性", { currentRevision: current.dataRevision });
      }
      if (current.lifecycleV11?.skuPackage) {
        throw httpError(409, "这件商品的供货方案已经冻结，运输属性不能再改", { code: "cargo_facts_frozen" });
      }
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前商品已有任务正在等待或运行");
      const record = buildOwnerCargoFactsRecord({ candidate: current, facts: declared, declaredAt: timestamp });
      current.cargoFactsV1 = record;
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      assertSafeBusinessMutationCandidate(current, "businessMutation.candidate");
      // 存档那句话要同时说清两件事：这是主人签的，以及软件当初凭什么这么提议、主人有没有照着签。
      const detail = record.basis.length === 0
        ? "软件当时一项也没敢提议，这几项全由主人自己选。"
        : `${record.matchesProposal ? "主人原样采纳了软件的提议" : "主人改过软件提议里的至少一项，最终以他确认的为准"}。` +
          `软件当时的依据：${record.basis.map(item => `${item.label}——${item.because}`).join(" ")}`;
      addHistory(current, "user", "ownerCargoFactsDeclared",
        `主人确认了本商品的运输属性：${record.headline}${detail}这一步只记录这份声明，未派发任务、未联系供应商、未向平台写入任何内容，也未形成利润结论。`,
        timestamp);
      return current.dataRevision;
    });
    const savedDocument = await readData();
    const savedCandidate = savedDocument.candidates.find((item) => item.id === candidateId);
    if (!savedCandidate) throw httpError(404, "候选不存在");
    return json(res, 200, await supplierDraftView(savedDocument, savedCandidate));
  }

  /**
   * 每单额外操作费 — the owner's own declaration of what this one product costs to get out of the door.
   *
   * This is the second entrance that was missing, and it cost him two walks to the last button. `packagingCostRmb`
   * is `null` on every candidate that arrived through discovery, and `buildLifecycleBExplicitOtherCosts` refuses
   * without it — correctly, because a cost the software invented is not a cost. Nothing on the product page could
   * state it, so 「确认，进入文案素材」 answered with `B_EVIDENCE_COST_POLICY_INCOMPLETE` and the only way on was a
   * hand-written PATCH.
   *
   * Owner's ruling 2026-09-15: it is not one fixed number and not always called 包材费 — 拆单费, 合包费, 额外材料费
   * are the same money under other names — so it is a list of 名目 + 金额 lines; and the default is nothing at all,
   * with lines added by hand where the goods actually need them. An empty list is therefore ¥0.00 AND a declaration.
   *
   * Two things are written here and they are written together: the detail (`extraHandlingFeesV1`) and the one
   * authoritative total the rest of the money reads (`packagingCostRmb`). The total is derived from the lines, so
   * they cannot be saved disagreeing. No dispatch, no supplier contact, no platform write, no profit conclusion.
   */
  const extraHandlingFeesRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/extra-handling-fees$/);
  if (req.method === "POST" && extraHandlingFeesRoute) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, `请先登录主人身份后确认${EXTRA_HANDLING_FEE_LABEL}。`);
    }
    const candidateId = decodeURIComponent(extraHandlingFeesRoute[1]);
    const input = await readJsonRequestBody(req, { maxBytes: 8192, requireJsonContentType: true });
    if (input === null || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 2 || !Object.hasOwn(input, "dataRevision") || !Object.hasOwn(input, "items")) {
      throw httpError(400, `确认${EXTRA_HANDLING_FEE_LABEL}只接受当前数据修订号和一份清单；一行都没有就是 ¥0.00`);
    }
    if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) {
      throw httpError(400, `确认${EXTRA_HANDLING_FEE_LABEL}必须提供当前数据修订号`);
    }
    const validation = validateOwnerExtraHandlingFees(input.items);
    if (!validation.valid) {
      throw httpError(422, `这份${EXTRA_HANDLING_FEE_LABEL}不能保存：${validation.errors.map(item => item.message).join("；")}`,
        { code: "extra_handling_fees_invalid", errors: validation.errors });
    }
    const timestamp = now();
    await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, `商品资料已变化，请刷新后重新确认${EXTRA_HANDLING_FEE_LABEL}`, { currentRevision: current.dataRevision });
      }
      if (current.lifecycleV11?.skuPackage) {
        throw httpError(409, `这件商品的供货方案已经冻结，${EXTRA_HANDLING_FEE_LABEL}不能再改`, { code: "extra_handling_fees_frozen" });
      }
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前商品已有任务正在等待或运行");
      const record = buildOwnerExtraHandlingFeesRecord({ candidate: current, items: input.items, declaredAt: timestamp });
      current.extraHandlingFeesV1 = record;
      // 总额和明细一起写，永远由同一次计算得出；利润链路读的还是 packagingCostRmb 这一个数，一个字都不用改。
      current.packagingCostRmb = record.totalRmb;
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      assertSafeBusinessMutationCandidate(current, "businessMutation.candidate");
      addHistory(current, "user", "ownerExtraHandlingFeesDeclared",
        `主人确认了本商品的${EXTRA_HANDLING_FEE_LABEL}：${record.headline}` +
        `这一步只记录这份声明并把合计写进本商品的成本事实，未派发任务、未联系供应商、未向平台写入任何内容，也未形成利润结论。`,
        timestamp);
      return current.dataRevision;
    });
    const savedDocument = await readData();
    const savedCandidate = savedDocument.candidates.find((item) => item.id === candidateId);
    if (!savedCandidate) throw httpError(404, "候选不存在");
    return json(res, 200, await supplierDraftView(savedDocument, savedCandidate));
  }

  /**
   * 同重同价声明 — 主人对某一次采集说的一句话：「这些规格是同一件货的不同规格，缺的重量和货价按我在找货里填的算」。
   *
   * 2026-09-16 那件小猫战术背心：采回来 5 个规格全是「均码」，只差颜色，重量和货价一个都没采到，整张表整列「待补」，
   * 而他在「找货」里早就填了 0.2 公斤和 ¥18。软件不能自己去借那个数——2026-09-13 的狗雨衣八个尺码 103 克到 240 克，
   * 借一个数会把小码的运费全算错——所以这里做的是把签字权交给他，而不是把借数的口子开给软件。
   *
   * 这条路只写一份声明：写的是「按我在找货里填的算」，不是把数字抄成事实。所以「找货」改了那张表跟着改，两处永远是
   * 同一个数；采到了真实重量的规格永远用采到的；重新采过之后这份声明自动失效，他重新看一眼再签。
   * uniform:false 就是撤回。不派任务、不联系供应商、不向平台写任何东西，也不形成利润结论。
   */
  const skuUniformSupplyRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/sku-uniform-supply$/);
  if (req.method === "POST" && skuUniformSupplyRoute) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, `请先登录主人身份后声明${SKU_UNIFORM_SUPPLY_LABEL}。`);
    }
    const candidateId = decodeURIComponent(skuUniformSupplyRoute[1]);
    const input = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
    if (input === null || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 2 || !Object.hasOwn(input, "dataRevision") || !Object.hasOwn(input, "uniform")) {
      throw httpError(400, `${SKU_UNIFORM_SUPPLY_LABEL}只接受当前数据修订号和一个「声明／撤回」`);
    }
    if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) {
      throw httpError(400, `${SKU_UNIFORM_SUPPLY_LABEL}必须提供当前数据修订号`);
    }
    if (typeof input.uniform !== "boolean") {
      throw httpError(400, `${SKU_UNIFORM_SUPPLY_LABEL}要么声明、要么撤回，没有第三种`);
    }
    const timestamp = now();
    await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, `商品资料已变化，请刷新后重新声明${SKU_UNIFORM_SUPPLY_LABEL}`, { currentRevision: current.dataRevision });
      }
      if (current.lifecycleV11?.skuPackage) {
        throw httpError(409, `这件商品的供货方案已经冻结，${SKU_UNIFORM_SUPPLY_LABEL}不能再改`, { code: "sku_uniform_supply_frozen" });
      }
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前商品已有任务正在等待或运行");
      let line;
      if (input.uniform === false) {
        if (readSkuUniformSupplyDeclaration(current).status === "absent") {
          throw httpError(409, `这件商品没有${SKU_UNIFORM_SUPPLY_LABEL}可以撤回`, { code: "sku_uniform_supply_absent" });
        }
        delete current.skuUniformSupplyV1;
        line = `主人撤回了本商品的${SKU_UNIFORM_SUPPLY_LABEL}：没采到重量和货价的规格重新回到「待补」，运费和利润不再按他填的算。`;
      } else {
        let record;
        try { record = buildOwnerSkuUniformSupplyRecord({ candidate: current, declaredAt: timestamp }); }
        catch (error) {
          throw httpError(422, String(error?.message ?? error).replace(/^SKU_UNIFORM_SUPPLY_[A-Z_]+: /u, ""),
            { code: "sku_uniform_supply_invalid" });
        }
        current.skuUniformSupplyV1 = record;
        line = `主人声明了本商品这一次采集（${record.captureId}）的 ${record.sourceSkuIds.length} 个规格同重同价：` +
          `${record.headline}采到了真实重量或货价的规格仍按采到的算，这份声明只补页面没给的那一半；重新采集之后它自动失效。`;
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      assertSafeBusinessMutationCandidate(current, "businessMutation.candidate");
      addHistory(current, "user", "ownerSkuUniformSupplyDeclared",
        `${line}这一步只记录这份声明，未派发任务、未联系供应商、未向平台写入任何内容，也未形成利润结论。`, timestamp);
      return current.dataRevision;
    });
    const savedDocument = await readData();
    const savedCandidate = savedDocument.candidates.find((item) => item.id === candidateId);
    if (!savedCandidate) throw httpError(404, "候选不存在");
    return json(res, 200, await supplierDraftView(savedDocument, savedCandidate));
  }

  const realAConfirmationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/a-confirm$/);
  if (req.method === "POST" && realAConfirmationRoute) {
    const input = await requestBody(req);
    if (!["confirm", "reject"].includes(input.decision)) throw httpError(400, "请选择确认或淘汰");
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "A确认必须提供当前数据修订号");
    const snapshot = await readData();
    const snapshotCandidate = snapshot.candidates.find((item) => item.id === realAConfirmationRoute[1]);
    if (!snapshotCandidate) throw httpError(404, "候选不存在");
    if (Number(snapshotCandidate.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认A阶段");
    if (input.sourceCandidateId !== snapshotCandidate.id || input.sourceDataRevision !== snapshotCandidate.dataRevision) {
      throw httpError(409, "确认卡候选身份或源修订不一致");
    }
    if (input.decision !== "reject") {
      assertCandidateStoreBinding(snapshotCandidate, runtimeConfiguration.storeBindings);
      const bindingValidation = validateRealAConfirmationSubmission(buildRealAConfirmationCard(snapshotCandidate), input);
      if (bindingValidation.errors.some(item => item.field === "storeRef")) throw httpError(409, "确认卡平台或店铺绑定不一致");
    }
    if (activeDispatchForCandidate(snapshot, snapshotCandidate.id)) throw httpError(409, "当前SKU已有任务等待或运行，不能同时确认A阶段");
    if (input.decision !== "reject" && snapshotCandidate.executionRuntime?.exceptionCase?.status === "open") {
      throw httpError(409, "当前SKU存在尚未解决的有证据异常；业务结论未改变，不能继续进入B");
    }
    if (input.decision !== "reject") {
      const requestedSourceUrl = String(input.supplierConfirmation?.productUrl || snapshotCandidate.sourceUrl || "").trim();
      const requestedSource = normalizeSupplierCaptureSource(requestedSourceUrl);
      const capture = snapshotCandidate.sourceCapture;
      const detailEvidence = readAProductDetailSupplierEvidence(snapshotCandidate);
      if (detailEvidence && requestedSource.sourceUrl !== detailEvidence.supplierOption.productUrl) {
        throw httpError(409, '请在当前A卡核对本轮详情保存的精确供货来源。');
      }
      const captureReadyForSameSource = capture?.mode === "a_supplier_capture" &&
        capture?.status === "captured_waiting_owner_selection" &&
        normalizeSupplierCaptureSource(capture.sourceUrl).sourceUrl === requestedSource.sourceUrl;
      if (requestedSource.type !== "invalid" && !captureReadyForSameSource && !detailEvidence) {
        const queued = await enqueueASupplierCaptureJob({
          candidateId: snapshotCandidate.id,
          requestRevision: input.dataRevision,
          requestedSourceUrl
        });
        return json(res, queued.duplicate ? 200 : 202, {
          status: "supplier_capture_job_queued",
          candidate: queued.candidate,
          captureJob: queued.captureJob,
          duplicate: queued.duplicate,
          dispatch: null,
          bStarted: false,
          c1Created: false
        });
      }
    }
    const timestamp = now();
    let providers = {};
    let profitRule;
    let commissionEstimate = null;
    if (input.decision !== "reject") {
      if (input.commissionEstimate !== undefined) {
        const rate = input.commissionEstimate?.commissionRate;
        if (input.commissionEstimate?.authorized !== true || input.commissionEstimate?.confirmedBy !== "owner") {
          throw httpError(400, "估算佣金必须由主人对当前SKU明确授权");
        }
        if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
          throw httpError(400, "估算佣金率必须在0到1之间");
        }
        const contextual = applyLifecycleBEvidenceContext(snapshotCandidate, {
          submission: input, guooFilePath: runtimeConfiguration.guooTariffFile
        });
        const estimateContext = resolveLifecycleEvidenceContext(contextual.candidate);
        if (!estimateContext.ready) throw httpError(422, "当前SKU费用适用范围不完整，不能进行条件测算。");
        commissionEstimate = {
          authorized: true,
          confirmedBy: "owner",
          commissionRate: rate,
          authorizationRef: `owner-a-confirmation:commission-estimate:${snapshotCandidate.id}:${snapshotCandidate.dataRevision}`,
          candidateId: snapshotCandidate.id,
          candidateRevision: snapshotCandidate.dataRevision,
          scope: buildExpectedEvidenceScope("commission", estimateContext.values)
        };
      }
      try {
        profitRule = resolveLifecycleBProfitRule(snapshotCandidate, snapshot.rules);
      } catch (error) {
        throw httpError(422, error instanceof Error ? error.message : String(error));
      }
      providers = createLifecycleBRealEvidenceProviderRegistry({
        ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl,
        guooFilePath: runtimeConfiguration.guooTariffFile,
        cbrSourceUrl: process.env.SELECTION_REVIEW_CBR_FX_URL,
        ozonCommissionReference: runtimeConfiguration.ozonCommissionReference,
        commissionEstimate
      });
    }
    let orchestration;
    try {
      orchestration = await runRealAConfirmationWithSystemEvidence({
        candidate: snapshotCandidate,
        submission: input,
        evidencePacks: snapshot.evidencePacks || [],
        currentCommissionCatalogs: snapshot.currentCommissionCatalogs ?? [],
        profitRule,
        providers,
        confirmedAt: timestamp,
        guooFilePath: runtimeConfiguration.guooTariffFile
      });
    } catch (error) {
      throw httpError(422, error instanceof Error ? error.message : String(error));
    }
    if (orchestration.status !== "completed") {
      // 这一次停下来的事实要落盘，主人刷新之后才找得回那条出路。物流比较能不能一起落盘是另一回事，两支都存。
      const comparisonToSave = orchestration.guooRouteComparison || null;
      await mutateData((data) => {
        const current = data.candidates.find(item => item.id === snapshotCandidate.id);
        if (!current || current.dataRevision !== input.dataRevision) {
          throw httpError(409, comparisonToSave
            ? "商品资料已变化，本轮物流比较未保存，请刷新。"
            : "商品资料已变化，本轮确认停在哪一步未保存，请刷新。");
        }
        assertCandidateStoreBinding(current, runtimeConfiguration.storeBindings);
        if (activeDispatchForCandidate(data, current.id)) {
          throw httpError(409, comparisonToSave
            ? "当前SKU已有任务，不能同时保存物流比较。"
            : "当前SKU已有任务，不能同时保存本轮确认停在哪一步。");
        }
        if (comparisonToSave) Object.assign(current, appendGuooRouteComparison(current, comparisonToSave, { recordedAt: timestamp }));
        // 这一次是不是「精确佣金读不到、只差主人授权」那一类，记成事实。上一行的物流比较落盘会把 dataRevision
        // 顶高一格，所以这里用的是顶高之后的 current.dataRevision——用顶高之前的值，这条记录一存进去就过期，
        // 页面上那一块还没渲染就没了（2026-09-14 现场实测：27→28→29，每失败一次涨一格）。
        //
        // 物流比较没有落盘的那一支不自己涨版本：涨了会把这件商品已经存着的那份物流比较判成过期（时效性判的是
        // resultRevision === dataRevision），也会让主人手上那一版号当场作废，白白逼他多刷一次。不涨版本时这条
        // 记录记的就是当前这一版，照样是当期的。
        current.commissionEstimateSignalV1 = buildCommissionEstimateSignal({
          evidencePreparation: orchestration.evidencePreparation,
          recordedAt: timestamp,
          sourceRevision: input.dataRevision,
          resultRevision: current.dataRevision
        });
        current.updatedAt = timestamp;
        addHistory(current, "system", comparisonToSave ? "guooRouteComparisonBlocked" : "aConfirmationEvidenceBlocked",
          comparisonToSave
            ? "已保存指定版本的物流比较及证据缺口；未形成利润结论或进入C1。"
            : "已记下本轮确认停在B证据准备的哪一步；未保存物流比较、未形成利润结论或进入C1。",
          timestamp);
      });
      throw httpError(422, `A确认后的B系统证据准备已停止：${orchestration.evidencePreparation?.failure?.reason || "未知失败"}`, {
        evidencePreparation: orchestration.evidencePreparation,
        guooRouteComparison: orchestration.guooRouteComparison || null
      });
    }
    const result = orchestration.result;
    if (result.idempotentReplay === true) {
      return json(res, 200, {
        candidate: publicCandidate(snapshotCandidate, snapshot.rules, {}, snapshot.evidencePacks || [], snapshot.currentCommissionCatalogs ?? []),
        idempotentReplay: true
      });
    }
    if (result.decision === "confirm" && result.profitModel.commissionMode === "estimated") {
      const binding = result.systemEvidenceBundle.platformFeeEvidence.commissionEstimateAuthorization;
      if (!commissionEstimate || !isCommissionEstimateAuthorizationForScope(binding, {
        candidateId: snapshotCandidate.id, candidateRevision: input.dataRevision,
        commissionRate: commissionEstimate.commissionRate
      }) || binding.authorizationRef !== commissionEstimate.authorizationRef ||
          result.profitModel.commissionRate !== commissionEstimate.commissionRate) {
        throw httpError(422, "条件测算缺少本轮当前SKU、修订号和相同费率的明确授权；未保存结果。");
      }
    }
    const originalEvidencePacks = JSON.stringify(snapshot.evidencePacks || []);
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === realAConfirmationRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认A阶段");
      if (input.decision !== "reject") assertCandidateStoreBinding(current, runtimeConfiguration.storeBindings);
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务等待或运行，不能同时确认A阶段");
      if (JSON.stringify(data.evidencePacks || []) !== originalEvidencePacks) {
        throw httpError(409, "B证据在本轮读取期间发生变化，本轮结果未保存；请刷新后重新确认一次");
      }
      if (result.decision === "confirm") {
        try {
          assertLifecycleBCostsCurrent({ candidate: { ...current, lifecycleEvidenceContextV11: orchestration.evidenceContext },
            rules: data.rules, asOf: now(), otherCosts: { ...result.systemEvidenceBundle.platformFeeEvidence.otherCosts,
              costPolicySnapshot: result.systemEvidenceBundle.platformFeeEvidence.costPolicySnapshot } });
        } catch (error) {
          if (error.code !== "B_EVIDENCE_COST_POLICY_INCOMPLETE" && !error.code?.startsWith("B_COST_POLICY_")) throw error;
          throw httpError(409, error.message);
        }
        try {
          assertCurrentBCommissionEvidence({ bundle: result.systemEvidenceBundle,
            evidencePacks: [...(data.evidencePacks || []), ...orchestration.evidencePacksToCommit],
            currentCommissionCatalogs: data.currentCommissionCatalogs ?? [], asOf: now() });
        } catch (error) {
          if (!error.code?.startsWith("B_COMMISSION_")) throw error;
          throw httpError(409, error.message);
        }
      }
      commitLifecycleBEvidencePacks(data, orchestration.evidencePacksToCommit, {
        createdAt: timestamp,
        currentCommissionCatalogs: data.currentCommissionCatalogs ?? [],
        createdBy: "real_a_confirmation_system_evidence"
      });

      if (result.decision === "reject") {
        current.lifecycleV11 = {
          ...(current.lifecycleV11 || {}),
          schemaVersion: "product-lifecycle-v1.1",
          status: "a_rejected_by_owner",
          aConfirmationReceipt: {
            receiptId: result.confirmationReceiptId,
            decision: "reject",
            sourceCandidateRevision: result.sourceCandidateRevision,
            confirmedAt: timestamp
          },
          opportunityPackage: null,
          skuPackage: null,
          c1Handoffs: [],
          externalAccesses: [],
          platformWrites: 0
        };
        current.workflowStatus = "eliminated";
        current.eliminatedAt = timestamp;
        current.eliminationReason = "主人在A阶段完整确认卡选择淘汰";
        current.processing = { ...queuedProcessing(current.processing), state: "idle", manualHold: true };
        current.dataRevision += 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "user";
        addHistory(current, "user", "realARejected", "主人在一张A确认卡淘汰当前商品；未启动B、未派发任务、零平台访问和写入", timestamp);
        return publicCandidate(current, data.rules);
      }

      const bPassed = result.profitModel.result === "passed";
      if (orchestration.guooRouteComparison) {
        current.guooRouteComparisonsV1 = appendGuooRouteComparison(current, orchestration.guooRouteComparison, {
          recordedAt: timestamp
        }).guooRouteComparisonsV1;
      }
      const bConditional = result.profitModel.calculationType === "conditional";
      const usedCommissionEstimate = result.profitModel.commissionMode === "estimated";
      if (usedCommissionEstimate) {
        current.acceptedEstimatedCommission = true;
        current.estimatedCommissionAuthorization = {
          ...structuredClone(result.systemEvidenceBundle.platformFeeEvidence.commissionEstimateAuthorization),
          confirmedBy: "owner",
          confirmedAt: timestamp,
          sourceCandidateRevision: input.dataRevision,
          exactCommissionRequiredForFormalB: true
        };
      }
      current.lifecycleEvidenceContextV11 = structuredClone(orchestration.evidenceContext);
      current.lifecycleV11 = {
        ...(current.lifecycleV11 || {}),
        schemaVersion: "product-lifecycle-v1.1",
        status: bPassed ? "b_passed_auto_c1" : bConditional ? "b_conditional_awaiting_exact_commission" : "b_rejected",
        aConfirmationReceipt: {
          receiptId: result.confirmationReceiptId,
          decision: "confirm",
          sourceCandidateRevision: result.sourceCandidateRevision,
          confirmedAt: timestamp
        },
        opportunityPackage: structuredClone(result.opportunityPackage),
        ownerSupplyConfirmation: structuredClone(result.ownerSupplyConfirmation),
        bSystemEvidenceBundle: structuredClone(result.systemEvidenceBundle),
        skuPackage: structuredClone(result.skuPackage),
        c1Handoffs: result.c1Handoff ? [structuredClone(result.c1Handoff)] : [],
        externalAccesses: structuredClone(orchestration.externalAccesses),
        platformWrites: 0
      };
      const runtimeBase = current.executionRuntime || createSoftwareExecutionRuntime({
        candidateId: current.id,
        dataRevision: current.dataRevision,
        businessPhase: "A",
        stepId: "A_CONFIRMATION",
        at: timestamp
      });
      const bRuntime = startSoftwareStep(runtimeBase, {
        stepId: "B_DETERMINISTIC_PROFIT",
        inputRevision: current.dataRevision,
        at: timestamp
      });
      current.executionRuntime = completeExecutionStep(bRuntime, {
        outputRevision: current.dataRevision + 1,
        at: timestamp
      });
      current.executionRuntime.businessPhase = bPassed ? "C1" : "B";
      current.bPassedAt = bPassed ? timestamp : null;
      current.processing = { ...queuedProcessing(current.processing), state: "idle", manualHold: false };
      if (bPassed) {
        current.workflowStatus = "listing_preparation";
        current.listingPreparation = {
          status: "c1_inputs_ready",
          reason: "主人一次确认A阶段后，B已只读冻结证据自动计算并通过；C1输入已原子创建。",
          decisionItems: [],
          writeOccurred: false,
          platformWrites: 0
        };
        current.listingHandoff = {
          state: "created",
          owner: "listing_task",
          runId: null,
          currentStep: "B利润通过，C1输入已自动创建",
          blockReason: null,
          userAction: "无需再次点击开始上架准备",
          inheritedInputRevision: result.c1Handoff.inheritedSkuRevision,
          handoffId: result.c1Handoff.handoffId,
          realTaskDispatched: false
        };
      } else if (bConditional) {
        current.workflowStatus = "needs_user_data";
        current.neededFields = ["系统待取得当前店铺、类目和销售模式的精确佣金；现有结果仅为条件测算，未通过正式B。"];
        current.listingPreparation = null;
        current.listingHandoff = null;
        current.executionRuntime = blockExecutionForTechnicalFailure(current.executionRuntime, {
          failureId: `b-exact-commission-required:${current.id}:${current.dataRevision + 1}`,
          kind: "external_dependency", errorCode: "B_EXACT_COMMISSION_REQUIRED",
          failureLayer: "b_commission_evidence", sourceRevision: current.dataRevision + 1,
          evidenceRefs: [result.systemEvidenceBundle.platformFeeEvidence.evidenceId], at: timestamp
        });
      } else if (applyGate1Shortfall(current, { profitModel: result.profitModel, at: timestamp })) {
        // 做过「做这件」的商品不直接淘汰：回到「需要你处理」，写明差多少，由主人选换货源、改售价或不做（lib/gate1-decision.mjs）。
        current.listingPreparation = null;
        current.listingHandoff = null;
      } else {
        current.workflowStatus = "eliminated";
        current.eliminatedAt = timestamp;
        current.eliminationReason = `B阶段利润未达到当前门槛：单件利润${result.profitModel.unitProfitRmb}元，利润率${(result.profitModel.profitMargin * 100).toFixed(1)}%`;
        current.listingPreparation = null;
        current.listingHandoff = null;
      }
      current.dataRevision += 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(
        current,
        "system",
        bPassed ? "realAAutoBPassedAndC1Created" : bConditional ? "realABConditionalEstimateSaved" : "realAAutoBRejected",
        bPassed
          ? `A确认后系统只读准备B证据并自动通过，创建唯一C1交接${result.c1Handoff.handoffId}；负责人切换为上架任务；未派发真实任务、零平台写入`
          : bConditional ? "A供货确认与条件测算已保存，缺精确佣金；未形成正式B通过、未淘汰、未创建C1。"
          : `A确认后系统只读准备B证据并自动计算，未通过当前利润门槛；未创建C1、未派发任务、零平台写入`,
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    const completedCandidate = result.decision === "confirm" && result.profitModel?.result === "passed"
      ? await continueC1SoftwareWhenEvidenceReady(candidate.id, candidate.dataRevision)
      : candidate;
    return json(res, 200, { candidate: completedCandidate });
  }

  const listingPreparationReviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/listing-preparation-review$/);
  const finalPricingReviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/final-pricing\/review$/);
  if (req.method === "POST" && finalPricingReviewRoute) {
    const input = await readJsonRequestBody(req, { maxBytes: 65536, requireJsonContentType: true });
    if (input?.candidateId !== finalPricingReviewRoute[1]) return json(res, 400, { code: "FINAL_PRICING_INPUT_INVALID", message: "商品身份不一致。" });
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "FINAL_PRICING_OWNER_REQUIRED", message: "请登录主人身份后提交最终定价复核。", externalRequests: 0 });
    }
    let transaction;
    try { transaction = await finalPricingReviewUseCase.review({ actor, input }); }
    catch (error) {
      if (error.message?.startsWith("REAL_A_SYSTEM_EVIDENCE_GAP:") || error.message?.startsWith("B_INPUT_GAP:")) {
        return json(res, 409, { code: "FINAL_PRICING_SOURCE_EVIDENCE_REQUIRED", message: "当前费用或冻结商品证据未通过校验，未保存本次定价。", externalRequests: 0, platformWrites: 0 });
      }
      if (typeof error.code === "string" && (error.code.startsWith("FINAL_PRICING_") || error.code.startsWith("B_COST_POLICY_") ||
          ["B_EVIDENCE_COST_POLICY_INCOMPLETE", "BUSINESS_MUTATION_REVISION_CONFLICT", "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT"].includes(error.code))) {
        return json(res, error.code.endsWith("INPUT_INVALID") ? 400 : 409, { code: error.code,
          message: "最终定价资料、当前成本或商品版本尚不满足复核条件；原价格和利润未改变。", externalRequests: 0, platformWrites: 0 });
      }
      throw error;
    }
    const saved = await readData();
    const current = saved.candidates.find(candidate => candidate.id === input.candidateId);
    if (!current) throw httpError(500, "最终定价保存结果待核对：未取得当前商品回读。");
    return json(res, 200, { pricingStatus: transaction.result.status, transactionStatus: transaction.status,
      candidate: publicCandidate(current, saved.rules), externalRequests: 0, platformWrites: 0 });
  }
  const bExactRecalculationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/b\/exact-commission\/recalculate$/);
  if (req.method === "POST" && bExactRecalculationRoute) {
    const input = await readJsonRequestBody(req, { maxBytes: 8192, requireJsonContentType: true });
    const fields = ["candidateId", "expectedRevision", "skuPackageId", "failureId", "idempotencyKey", "auditEventId"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length ||
        fields.some(field => !Object.hasOwn(input, field)) || input.candidateId !== bExactRecalculationRoute[1] ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
        fields.filter(field => field !== "expectedRevision").some(field => typeof input[field] !== "string" || !input[field].trim())) {
      return json(res, 400, { code: "B_EXACT_RECALCULATION_INPUT_INVALID", message: "请从当前商品卡提交正式复算。", externalRequests: 0 });
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "B_EXACT_RECALCULATION_OWNER_REQUIRED", message: "请先登录主人身份后复算。", externalRequests: 0 });
    }
    let transaction;
    try { transaction = await bExactCommissionRecalculation.recalculate({ actor, input }); }
    catch (error) {
      if (error.code === "B_EVIDENCE_COST_POLICY_INCOMPLETE" || error.code?.startsWith("B_COST_POLICY_")) return json(res, 409, {
        code: error.code, message: "当前商品成本或店铺规则不完整，原利润结果未改变。", externalRequests: 0
      });
      if (error instanceof BExactCommissionRecalculationError) return json(res,
        error.code === "B_EXACT_RECALCULATION_INPUT_INVALID" ? 400 : error.code === "B_EXACT_RECALCULATION_AUTHENTICATED_OWNER_REQUIRED" ? 403 : 409, {
        code: error.code, message: "当前费用证据或保存的商品记录尚不满足正式复算，原结果未改变。", externalRequests: 0
      });
      if (["BUSINESS_MUTATION_REVISION_CONFLICT", "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT"].includes(error.code ?? error.message)) {
        return json(res, 409, { code: error.code ?? error.message, message: "商品记录已变化，请刷新核对；未重复计算。", externalRequests: 0 });
      }
      throw error;
    }
    if (transaction.status === "committed" && transaction.result.status === "passed") {
      await continueC1SoftwareWhenEvidenceReady(input.candidateId, transaction.candidate.dataRevision);
    }
    const saved = await readData();
    const candidate = saved.candidates.find(value => value.id === input.candidateId);
    if (!candidate) throw httpError(500, "正式复算结果待核对：未取得当前商品独立回读。");
    return json(res, 200, { recalculationStatus: transaction.status, result: transaction.result,
      candidate: publicCandidate(candidate, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []) });
  }
  const c1KeywordHandoffRetryRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/keyword-handoff\/retry$/);
  if (req.method === "POST" && c1KeywordHandoffRetryRoute) {
    const input = await readJsonRequestBody(req, { maxBytes: 8192, requireJsonContentType: true });
    const fields = ["candidateId", "expectedRevision", "keywordJobId", "failureId", "idempotencyKey", "auditEventId"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length ||
        fields.some(field => !Object.hasOwn(input, field)) || input.candidateId !== c1KeywordHandoffRetryRoute[1] ||
        !Number.isInteger(input.expectedRevision) || fields.filter(field => field !== "expectedRevision").some(field => typeof input[field] !== "string" || !input[field].trim())) {
      return json(res, 400, { code: "C1_KEYWORD_HANDOFF_RETRY_INPUT_INVALID", message: "请从当前商品卡继续准备文案。", externalRequests: 0 });
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_DRAFT_AUTHENTICATED_OWNER_REQUIRED", message: "请先登录主人身份后继续准备文案。", externalRequests: 0 });
    }
    let transaction;
    try { transaction = await c1DraftRuntimeServices.retryKeywordHandoff({ actor, input }); }
    catch (error) {
      if (error instanceof C1DraftRuntimeUnavailableError) return json(res, 503, {
        code: error.code, message: "文案配置尚未就绪，交接保持停止，未发起任何付费调用。", externalRequests: 0
      });
      const code = error.code ?? error.message;
      const conflicts = ["BUSINESS_MUTATION_REVISION_CONFLICT", "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT",
        "C1_KEYWORD_HANDOFF_RETRY_SOURCE_CONFLICT",
        "C1_PAID_KEYWORD_CONTINUATION_SOURCE_CONFLICT", "C1_KEYWORD_HANDOFF_RECOVERY_REJECTED",
        "C1_DRAFT_CURRENT_JOB_UNRESOLVED", "C1_DRAFT_EVIDENCE_REQUIRED", "C1_DRAFT_EVIDENCE_NOT_CURRENT"];
      if (conflicts.includes(code)) return json(res, 409, {
        code, message: "当前证据或交接记录未通过核对，未再次查询关键词或调用文案服务。", externalRequests: 0
      });
      throw error;
    }
    const saved = await readData();
    const candidate = saved.candidates.find(value => value.id === input.candidateId);
    if (!candidate) throw httpError(500, "交接结果待核对：未取得当前商品独立回读。");
    return json(res, 200, { handoffStatus: transaction.status,
      candidate: { ...publicCandidate(candidate, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []),
        c1DraftRuntimeView: buildC1DraftRuntimeView({ candidate, runtime: saved.runtime,
          serviceBindings: runtimeConfiguration.c1DraftServiceBindings, observedAt: now() }) } });
  }
  const c1DraftResultReadRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/paid-draft\/reconcile-result$/);
  if (req.method === "POST" && c1DraftResultReadRoute) {
    const input = await requestBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 3 ||
        !["candidateId", "expectedRevision", "jobId"].every(field => Object.hasOwn(input, field)) ||
        input.candidateId !== c1DraftResultReadRoute[1] || !Number.isInteger(input.expectedRevision) ||
        typeof input.jobId !== "string" || !input.jobId.trim()) {
      return json(res, 400, { code: "C1_DRAFT_RESULT_READ_INPUT_INVALID", message: "读取结果必须准确引用当前已保存任务。", externalRequests: 0 });
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_DRAFT_AUTHENTICATED_OWNER_REQUIRED", message: "请先登录主人身份后读取本次文案结果。", externalRequests: 0 });
    }
    const snapshot = await readData();
    const candidate = snapshot.candidates.find(value => value.id === input.candidateId);
    if (!candidate || candidate.dataRevision !== input.expectedRevision) throw httpError(409, "当前商品资料已变化，未读取旧任务。");
    const view = buildC1DraftRuntimeView({ candidate, runtime: snapshot.runtime,
      serviceBindings: runtimeConfiguration.c1DraftServiceBindings, observedAt: now() });
    const savedReceipt = view?.status === "completed" && view.canContinueSaved;
    if ((!view?.canReadOriginalResult && !savedReceipt) || view.jobId !== input.jobId || view.jobRevision !== input.expectedRevision) {
      return json(res, 409, { code: "C1_DRAFT_RESULT_READ_BLOCKED", message: view?.message || "当前没有可以读取的原文案结果。", externalRequests: 0 });
    }
    // Read only the already accepted gateway job; never re-authorize or regenerate.
    let execution;
    try { execution = await c1DraftRuntimeServices.reconcileSavedCurrent(input); }
    catch (error) {
      const code = error.code ?? error.message;
      if (["BUSINESS_MUTATION_REVISION_CONFLICT", "C1_DRAFT_CANDIDATE_REVISION_CONFLICT",
        "C1_DRAFT_RECONCILIATION_LEASE_CONFLICT", "C1_DRAFT_RECONCILIATION_NOT_ELIGIBLE"].includes(code)) {
        return json(res, 409, { code, message: "读取期间商品或原任务状态已变化，未覆盖商品资料。请刷新查看保存结果。" });
      }
      throw error;
    }
    const saved = await readData();
    const current = saved.candidates.find(value => value.id === input.candidateId);
    if (!current) throw httpError(500, "结果读取后未取得当前商品独立回读，请核对记录。");
    return json(res, 200, { executionStatus: execution.status,
      candidate: { ...publicCandidate(current, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []),
        c1ContentReviewView: buildC1ContentReviewView(current),
        c1DraftRuntimeView: buildC1DraftRuntimeView({ candidate: current, runtime: saved.runtime,
          serviceBindings: runtimeConfiguration.c1DraftServiceBindings, observedAt: now() }) } });
  }
  const c1SavedDraftContinuationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/paid-draft\/continue-saved$/);
  if (req.method === "POST" && c1SavedDraftContinuationRoute) {
    const input = await requestBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 3 ||
        !["candidateId", "expectedRevision", "jobId"].every(field => Object.hasOwn(input, field)) ||
        input.candidateId !== c1SavedDraftContinuationRoute[1] || !Number.isInteger(input.expectedRevision)) {
      return json(res, 400, { code: "C1_DRAFT_SAVED_CONTINUATION_INPUT_INVALID", message: "继续请求必须准确引用当前已保存任务。", externalRequests: 0 });
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_DRAFT_AUTHENTICATED_OWNER_REQUIRED", message: "请先登录主人身份后继续已许可任务。", externalRequests: 0 });
    }
    const snapshot = await readData();
    const candidate = snapshot.candidates.find(value => value.id === input.candidateId);
    if (!candidate || candidate.dataRevision !== input.expectedRevision) throw httpError(409, "当前商品资料已变化，未继续旧任务。");
    const view = buildC1DraftRuntimeView({ candidate, runtime: snapshot.runtime,
      serviceBindings: runtimeConfiguration.c1DraftServiceBindings, observedAt: now() });
    if (!view?.canContinueSaved || view.jobId !== input.jobId || view.jobRevision !== input.expectedRevision) {
      return json(res, 409, { code: "C1_DRAFT_SAVED_CONTINUATION_BLOCKED", message: view?.message || "本任务当前不可继续，请核对已有结果和卡点。", externalRequests: 0 });
    }
    // This consumes the existing permission/job. It creates no new authorization,
    // and the use case rereads admission and claims once under its transaction.
    const execution = await c1DraftRuntimeServices.continueSavedCurrent(input);
    const saved = await readData();
    const current = saved.candidates.find(value => value.id === input.candidateId);
    if (!current) throw httpError(500, "继续结果待核对：未取得当前商品独立回读。");
    return json(res, 200, { executionStatus: execution.status,
      candidate: { ...publicCandidate(current, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []),
        c1DraftRuntimeView: buildC1DraftRuntimeView({ candidate: current, runtime: saved.runtime,
          serviceBindings: runtimeConfiguration.c1DraftServiceBindings, observedAt: now() }) } });
  }
  const c1PaidDraftAuthorizationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/paid-draft\/authorize$/);
  if (req.method === "POST" && c1PaidDraftAuthorizationRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1PaidDraftAuthorizationRoute[1]) throw httpError(400, "许可与当前商品不一致，未保存");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_DRAFT_AUTHENTICATED_OWNER_REQUIRED", message: "请先登录主人身份，再确认本件商品的一次付费调用。", externalRequests: 0 });
    }
    let transaction;
    try { transaction = await c1DraftRuntimeServices.authorizeAndEnqueue({ actor, input }); }
    catch (error) {
      if (error instanceof C1AiGatewayError && error.code === "C1_AI_GATEWAY_INPUT_TOO_LARGE") return json(res, 422, {
        code: error.code, message: "文案输入超过服务容量，本次许可未保存、没有发起调用。请调整资料传输后继续。", externalRequests: 0
      });
      if (error instanceof C1DraftRuntimeUnavailableError) return json(res, 503, {
        code: error.code, message: "文案服务尚未配置，本次许可未保存，也没有发起付费调用。", externalRequests: 0
      });
      const code = error.code ?? error.message;
      const invalidInput = ["C1_DRAFT_AUTHORIZE_INPUT_INVALID", "C1_DRAFT_PAID_CONFIRMATION_INVALID"];
      const currentConflict = ["BUSINESS_MUTATION_REVISION_CONFLICT", "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT",
        "C1_DRAFT_SAVED_REQUEST_CONFLICT", "C1_DRAFT_REQUEST_SOURCE_CONFLICT", "C1_DRAFT_EXECUTION_BINDING_PROVIDER_CONFLICT"];
      const prerequisite = ["C1_DRAFT_SAVED_REQUEST_REQUIRED", "C1_DRAFT_REQUEST_INVALID", "C1_DRAFT_EVIDENCE_REQUIRED",
        "C1_DRAFT_EVIDENCE_NOT_CURRENT", "C1_DRAFT_AUTHORIZATION_EXPIRED", "C1_DRAFT_WORKER_NOT_CURRENT",
        "C1_DRAFT_RESTRICTED_AUTHORIZATION_UNSUPPORTED", ...C1_LOCAL_DRAFT_FAILURE_CODES];
      if (invalidInput.includes(code) || currentConflict.includes(code) || prerequisite.includes(code)) return json(res,
        invalidInput.includes(code) ? 400 : currentConflict.includes(code) ? 409 : 422,
        { code, message: "本次许可未保存：请核对当前请求、证据、已有许可限制与服务配置。", externalRequests: 0 });
      throw error;
    }
    const ref = transaction.result.softwareJobRef;
    const execution = await c1DraftRuntimeServices.continueSavedCurrent({
      candidateId: input.candidateId, expectedRevision: ref.revision, jobId: ref.jobId
    });
    const saved = await readData();
    const candidate = saved.candidates.find(value => value.id === input.candidateId);
    if (!candidate) throw httpError(500, "许可或执行结果待核对：未取得当前商品独立回读");
    return json(res, 200, { authorizationStatus: transaction.status, executionStatus: execution.status,
      candidate: { ...publicCandidate(candidate, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []),
        c1DraftRuntimeView: buildC1DraftRuntimeView({ candidate, runtime: saved.runtime,
          serviceBindings: runtimeConfiguration.c1DraftServiceBindings, observedAt: now() }) } });
  }
  const c1EditorialReviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/confirm-editorial-content$/);
  if (req.method === "POST" && c1EditorialReviewRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1EditorialReviewRoute[1]) throw httpError(400, "修订确认与当前商品不一致，未保存");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_EDITORIAL_REVIEW_AUTHENTICATED_OWNER_REQUIRED", message: "请先登录主人身份，再确认修订文案。" });
    }
    let transaction;
    try { transaction = await c1EditorialReviewUseCase.confirm({ actor, input }); }
    catch (error) {
      const code = error.code ?? error.message;
      if (error instanceof C1EditorialReviewError || (typeof code === "string" && code.startsWith("C1_FINAL_REVISION_")) || ["BUSINESS_MUTATION_REVISION_CONFLICT", "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT"].includes(code)) {
        return json(res, code === "C1_EDITORIAL_REVIEW_INPUT_INVALID" ? 400 : 409,
          { code, message: "修订文案未确认，请刷新并核对当前商品与修订版本。", paidCalls: 0, platformWrites: 0 });
      }
      throw error;
    }
    const saved = await readData();
    const candidate = saved.candidates.find(value => value.id === input.candidateId);
    if (!candidate) throw httpError(500, "修订确认结果尚未取得商品独立回读");
    return json(res, 200, { status: transaction.status, result: transaction.result,
      candidate: { ...publicCandidate(candidate, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []),
        c1ContentReviewView: buildC1ContentReviewView(candidate), c1EditorialReviewView: c1EditorialView(candidate, saved.runtime) } });
  }
  const c1ContentReviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/confirm-content$/);
  if (req.method === "POST" && c1ContentReviewRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1ContentReviewRoute[1]) throw httpError(400, "确认与当前商品不一致，未保存");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_CONTENT_REVIEW_AUTHENTICATED_OWNER_REQUIRED", message: "请先登录主人身份，再确认商品内容。" });
    }
    if (c1EditorialProposalBundle?.request?.sourceIdentity?.candidateId === input.candidateId) {
      return json(res, 409, { code: "C1_CONTENT_REVIEW_EDITORIAL_REQUIRED",
        message: "本商品已有待采用的修订版，请在修订文案入口核对并确认。", paidCalls: 0, platformWrites: 0 });
    }
    let transaction;
    try { transaction = await c1ContentReviewUseCase.confirm({ actor, input }); }
    catch (error) {
      const code = error.code ?? error.message;
      if (error instanceof C1ContentReviewError || (typeof code === "string" && code.startsWith("C1_FINAL_REVISION_")) || ["BUSINESS_MUTATION_REVISION_CONFLICT", "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT"].includes(code)) {
        return json(res, code === "C1_CONTENT_REVIEW_INPUT_INVALID" ? 400 : 409,
          { code, message: "商品内容确认未保存，请刷新并核对当前文案与回执。", paidCalls: 0, platformWrites: 0 });
      }
      throw error;
    }
    const saved = await readData();
    const candidate = saved.candidates.find(value => value.id === input.candidateId);
    return json(res, 200, { status: transaction.status, result: transaction.result,
      candidate: { ...publicCandidate(candidate, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []),
        c1ContentReviewView: buildC1ContentReviewView(candidate) } });
  }
  const c1RightsReviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/rights-review$/);
  if (req.method === "POST" && c1RightsReviewRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1RightsReviewRoute[1]) throw httpError(400, "声明与当前商品不一致，未保存");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_RIGHTS_OWNER_REQUIRED", message: "请先登录主人身份后保存本件商品声明", externalRequests: 0 });
    }
    let transaction;
    try { transaction = await c1SkuRightsReviewUseCase.submit({ actor, input }); }
    catch (error) {
      if (error instanceof C1SkuRightsReviewError) {
        const status = /INPUT_INVALID/.test(error.code) ? 400 : /CONFLICT|REPLACEMENT|ACTIVE_JOB|SCOPE_MISMATCH/.test(error.code) ? 409 : 422;
        return json(res, status, { code: error.code, message: "声明未保存：请核对当前商品、权利情况与有效期；冻结计划须明确生成替代版本。", externalRequests: 0 });
      }
      if (["BUSINESS_MUTATION_REVISION_CONFLICT", "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT"].includes(error.code)) {
        return json(res, 409, { code: error.code, message: "当前商品资料或本次提交已经变化，请刷新并核对已保存声明。", externalRequests: 0 });
      }
      throw error;
    }
    const saved = await readData();
    const candidate = saved.candidates.find(item => item.id === input.candidateId);
    if (!candidate) throw httpError(500, "声明保存结果待核对：未取得当前商品独立回读");
    return json(res, 200, { status: transaction.status, result: transaction.result,
      candidate: publicCandidate(candidate, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []), externalRequests: 0, platformWrites: 0 });
  }
  // 权利声明只是一次声明，它不驱动状态机（这条边界由 local-owner-access-api 那条测试守着）。
  // 但在 2026-09-17 之前，**没有任何入口能在签完声明之后再推一把**：C1 准备链只由 a-confirm 和
  // 正式复算触发，而 a-confirm 那一刻声明还不可能存在（签声明的面板本身要 businessPhase 已是 C1），
  // 于是事实核验必然停住，之后界面上三个 can* 全是 false。这里补上那个缺掉的显式动作。
  // 它是免费的：只产生本机的关键词准备证据并保存文案请求，付费调用仍要主人在面板上另外授权
  // （见 continueC1SoftwareWhenEvidenceReady 里 "Planning alone grants no paid permission"）。
  const c1SiblingColorRevisionRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/revise-sibling-color$/);
  if (req.method === "POST" && c1SiblingColorRevisionRoute) {
    const input = await requestBody(req);
    if (!input || input.candidateId !== c1SiblingColorRevisionRoute[1] ||
        Object.keys(input).sort().join(',') !== 'candidateId,dataRevision,skuPackageId' ||
        !Number.isSafeInteger(input.dataRevision) || typeof input.skuPackageId !== 'string') {
      throw httpError(400, '颜色修订只接受当前商品、SKU及修订号');
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    try {
      const transaction = await c1SiblingColorRevisionUseCase.prepare({ actor, input: {
        candidateId: input.candidateId, skuPackageId: input.skuPackageId,
        expectedRevision: input.dataRevision } });
      const saved = await readData();
      const candidate = saved.candidates.find(item => item.id === input.candidateId);
      if (!candidate) throw httpError(500, '颜色修订结果回读失败');
      return json(res, 200, { status: transaction.status, result: transaction.result,
        candidate: publicCandidate(candidate, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []),
        externalRequests: 0, paidCalls: 0, platformWrites: 0 });
    } catch (error) {
      const code = error.code ?? error.message;
      if (error instanceof C1SiblingColorRevisionError ||
          ['BUSINESS_MUTATION_REVISION_CONFLICT', 'BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT'].includes(code)) {
        return json(res, code.endsWith('OWNER_REQUIRED') ? 403 : 409, { code,
          message: '当前颜色映射缺口无法安全修订；请核对状态，已发送或结果未知的作业须先对账。',
          externalRequests: 0, paidCalls: 0, platformWrites: 0 });
      }
      throw error;
    }
  }
  const c1FinalPlanRevisionRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/revise-final-plan$/);
  if (req.method === "POST" && c1FinalPlanRevisionRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1FinalPlanRevisionRoute[1] || Object.keys(input).some(key => !["candidateId", "skuPackageId", "dataRevision"].includes(key))) throw httpError(400, "新方案准备只接受当前商品、SKU及修订号");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_FINAL_REVISION_OWNER_REQUIRED", message: "请先登录主人身份后准备新版方案。",
        paidCalls: 0, externalRequests: 0, platformWrites: 0 });
    }
    const current = (await businessStateRepository.readSnapshot()).candidates.find(item => item.id === input.candidateId);
    if (!current || !Number.isSafeInteger(input.dataRevision) || current.dataRevision !== input.dataRevision ||
        current.lifecycleV11?.skuPackage?.skuPackageId !== input.skuPackageId) throw httpError(409, "商品资料已变化，请刷新后准备新版方案。");
    if (!current.lifecycleV11.skuPackage.productionConfirmationCard || current.lifecycleV11.skuPackage.productionAuthorization) {
      throw httpError(409, "只有尚未授权上架的方案卡可以准备新版本。");
    }
    if (hasUnsettledC1ColorDictionaryRead(current.lifecycleV11)) return json(res, 409, {
      code: 'C1_COLOR_DICTIONARY_READ_UNSETTLED',
      message: '颜色字典读取已发出或结果未知，须先核对，不能通过方案修订清除本次请求。',
      externalRequests: 0, paidCalls: 0, platformWrites: 0 });
    try {
      const extracted = await c1ImageTextUseCase.extract({ actor, input: { candidateId: input.candidateId, expectedRevision: input.dataRevision } });
      if (extracted.result.status !== "completed") return json(res, 409, {
        code: "C1_IMAGE_TEXT_FAILED", message: "图片文字读取失败，已保存失败记录；新版方案尚未生成。",
        dataRevision: extracted.candidate.dataRevision, paidCalls: 0, externalRequests: 0, platformWrites: 0 });
      const prepared = await c1FinalPlanRevisionUseCase.prepare({ actor, input: {
        candidateId: input.candidateId, skuPackageId: input.skuPackageId, expectedRevision: extracted.candidate.dataRevision } });
      return json(res, 200, { status: prepared.status, result: prepared.result, dataRevision: prepared.candidate.dataRevision,
        candidateId: input.candidateId, paidCalls: 0, externalRequests: 0, platformWrites: 0 });
    } catch (error) {
      const code = error.code ?? error.message;
      if ((error instanceof OwnerProductFactsError && ["OWNER_PRODUCT_FACTS_SOURCE_MISMATCH", "OWNER_PRODUCT_FACTS_RECORD_INVALID"].includes(code)) ||
          (error instanceof ConfirmedSupplierInputError && ["C1_SUPPLIER_FACT_REVISION_OWNER_SOURCE_MISMATCH",
            "C1_SUPPLIER_FACT_REVISION_OWNER_TIME_INVALID", "C1_SUPPLIER_FACT_REVISION_OWNER_PROJECTION_CHANGED"].includes(code))) {
        return json(res, 409, { code, message: "保存的主人商品声明与当前规格或来源不一致，新版方案准备已停止；请核对声明。",
          paidCalls: 0, externalRequests: 0, platformWrites: 0 });
      }
      if (typeof code === "string" && /^(C1_IMAGE_TEXT_|C1_FINAL_REVISION_)/.test(code)) return json(res,
        code === "C1_IMAGE_TEXT_SERVICE_UNAVAILABLE" ? 503 : code.endsWith("OWNER_REQUIRED") ? 403 : 409,
        { code, message: code === "C1_IMAGE_TEXT_SERVICE_UNAVAILABLE" ? "本地图片文字服务尚未配置，需要完成工程配置。" :
          "新版方案准备未通过资料核对，已停止；请查看具体错误。", paidCalls: 0, externalRequests: 0, platformWrites: 0 });
      throw error;
    }
  }
  const c1ImageTextRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/image-text$/);
  if (req.method === "POST" && c1ImageTextRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1ImageTextRoute[1] || Object.keys(input).some(key => !["candidateId", "dataRevision"].includes(key))) throw httpError(400, "图片文字准备只接受当前商品及修订号");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    try {
      const extracted = await c1ImageTextUseCase.extract({ actor, input: { candidateId: input.candidateId, expectedRevision: input.dataRevision } });
      return json(res, 200, { status: extracted.result?.status ?? extracted.status, candidateId: input.candidateId,
        dataRevision: extracted.candidate.dataRevision, paidCalls: 0, externalRequests: 0 });
    } catch (error) {
      const code = error.code ?? error.message;
      if (typeof code === "string" && code.startsWith("C1_IMAGE_TEXT_")) {
        return json(res, code === "C1_IMAGE_TEXT_SERVICE_UNAVAILABLE" ? 503 : code === "C1_IMAGE_TEXT_OWNER_REQUIRED" ? 403 : 409,
          { code, message: code === "C1_IMAGE_TEXT_SERVICE_UNAVAILABLE" ? "本地图片文字服务尚未配置，需要工程配置。" : "图片文字准备未通过当前资料核对；软件已停止，请查看该任务的具体错误。", paidCalls: 0, externalRequests: 0 });
      }
      throw error;
    }
  }
  const c1ContinuePreparationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/continue-preparation$/);
  if (req.method === "POST" && c1ContinuePreparationRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1ContinuePreparationRoute[1]) throw httpError(400, "请求与当前商品不一致，未执行");
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "继续准备必须提供当前数据修订号");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_CONTINUE_OWNER_REQUIRED", message: "请先登录主人身份后继续准备文案素材", externalRequests: 0 });
    }
    const snapshot = await readData();
    const current = snapshot.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(404, "候选不存在");
    if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重试");
    const sku = current.lifecycleV11?.skuPackage;
    if (sku?.businessPhase !== "C1") throw httpError(409, "只有处于C1的商品可以继续准备文案素材");
    if (input.mode === "saved_material_only") {
      if (Object.keys(input).some(key => !["candidateId", "dataRevision", "mode"].includes(key))) {
        throw httpError(400, "本地准备只能提交当前商品、修订号和准备方式");
      }
      let prepared;
      try {
        prepared = await persistC1KeywordPlanningLocalMaterial({
          repository: businessStateRepository, runtimeMode: runtimeConfiguration.deploymentMode,
          actor, candidateId: current.id, expectedRevision: current.dataRevision,
          producedAt: now(), codexOffline: true, producer: produceC1LocalPreparation
        });
      } catch (error) {
        const code = error.code ?? error.message;
        if (["C1_KEYWORD_LOCAL_MATERIAL_REVISION_CONFLICT", "BUSINESS_MUTATION_REVISION_CONFLICT",
          "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT"].includes(code)) {
          return json(res, 409, { code, message: "当前商品资料或本次提交已变化，请刷新并核对已保存的准备结果。",
            externalRequests: 0, platformWrites: 0, paidCalls: 0 });
        }
        throw error;
      }
      return json(res, 200, { status: prepared.status, result: prepared.result,
        candidate: publicCandidate(prepared.candidate, snapshot.rules, {}, snapshot.evidencePacks || [], snapshot.currentCommissionCatalogs ?? []),
        externalRequests: 0, platformWrites: 0, paidCalls: 0 });
    }
    if (input.mode === "prepare_copy") {
      if (Object.keys(input).some(key => !["candidateId", "dataRevision", "mode"].includes(key))) {
        throw httpError(400, "文案准备只能提交当前商品、修订号和准备方式");
      }
      let prepared;
      try {
        prepared = await c1DraftRuntimeServices.prepareLocal({ actor, input: {
          candidateId: current.id, expectedRevision: input.dataRevision,
          idempotencyKey: `c1-local-draft:${current.id}:${input.dataRevision}`,
          auditEventId: `c1-local-draft-audit:${current.id}:${input.dataRevision}`
        } });
      } catch (error) {
        if (error instanceof C1DraftRuntimeUnavailableError) return json(res, 503, {
          code: error.code, message: "文案服务尚未配置，准备请求未保存，也没有付费调用。", paidCalls: 0, platformWrites: 0
        });
        const code = error.code ?? error.message;
        if (["BUSINESS_MUTATION_REVISION_CONFLICT", "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT",
          "C1_LOCAL_DRAFT_REQUEST_ALREADY_SAVED", "C1_DRAFT_CURRENT_JOB_UNRESOLVED"].includes(code)) {
          return json(res, 409, { code, message: "商品资料或文案任务已变化，请刷新后核对已有任务。", paidCalls: 0, platformWrites: 0 });
        }
        if (error instanceof C1AiGatewayError && code === "C1_AI_GATEWAY_INPUT_TOO_LARGE") return json(res, 422, {
          code, message: "文案输入超过服务容量，请调整资料传输后继续。未保存请求，也没有付费调用。",
          externalRequests: 0, paidCalls: 0, platformWrites: 0
        });
        if (C1_LOCAL_DRAFT_FAILURE_CODES.includes(code)) return json(res, 422, {
          code, message: "保存的属性、关键词或权利证据未通过核对，请先修正准备资料。未生成文案请求，也没有付费调用。",
          externalRequests: 0, paidCalls: 0, platformWrites: 0
        });
        throw error;
      }
      const saved = await readData();
      const candidate = saved.candidates.find(value => value.id === input.candidateId);
      return json(res, 200, { status: prepared.status, result: prepared.result, paidCalls: 0, platformWrites: 0,
        candidate: { ...publicCandidate(candidate, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []),
          c1DraftRuntimeView: buildC1DraftRuntimeView({ candidate, runtime: saved.runtime,
            serviceBindings: runtimeConfiguration.c1DraftServiceBindings, observedAt: now() }) } });
    }
    if (input.mode !== undefined) throw httpError(400, "不支持这个准备方式");
    // 先按主人签下的声明冻结事实。少了这一步整条链动不了：本地素材生产器要求计划已经是
    // facts_checked（它只拒绝、不自己核验），而会核验的编排器排在它后面——2026-09-17 实测的死锁。
    // 已经冻过就跳过，这一步幂等；缺声明时照实回一句话，不在这里替主人签。
    let revision = current.dataRevision;
    if (sku.c1ProductPlan?.status === "inputs_ready") {
      try {
        const frozen = await c1FactsVerificationUseCase.verify({ actor, input: {
          candidateId: input.candidateId, expectedRevision: revision, skuPackageId: sku.skuPackageId,
          idempotencyKey: `c1-verify-facts:${input.candidateId}:${revision}`,
          auditEventId: `c1-verify-facts-audit:${input.candidateId}:${revision}`
        } });
        if (frozen.status === "committed") revision = frozen.candidate.dataRevision;
      } catch (error) {
        if (error.message === 'SIBLING_COLOR_BINDING_INVALID') return json(res, 409, {
          code: error.message,
          message: '本规格 10096 商品颜色和 10097 颜色名称须分别绑定已确认的供应颜色；请在 C1 商品属性区查看事实、核对官方字典并保存两项映射。当前事实未冻结。',
          requiredAttributeIds: ['10096', '10097'], ownerAction: 'complete_c1_color_mapping',
          mappingRoute: `/api/candidates/${encodeURIComponent(input.candidateId)}/lifecycle/c1/ozon-attributes`,
          externalRequests: 0, paidCalls: 0, platformWrites: 0
        });
        if (error instanceof C1FactsVerificationError) {
          const message = error.code === "C1_FACTS_VERIFICATION_RIGHTS_REQUIRED"
            ? "请先保存本件商品的品牌与权利声明，再继续准备文案素材"
            : "当前商品还不满足冻结C1事实的条件，未做任何改动";
          return json(res, 409, { code: error.code, message, externalRequests: 0, platformWrites: 0, paidCalls: 0 });
        }
        throw error;
      }
    }
    const candidate = await continueC1SoftwareWhenEvidenceReady(input.candidateId, revision, { reportConfigurationBlock: true });
    return json(res, 200, { candidate, platformWrites: 0, paidCalls: 0 });
  }
  // 同一次 1688 采集里已经采到、当时却没搬进冻结快照的供应商属性（面料、适合季节、颜色…）。
  // 免费、只补不改：已冻过的键值必须逐字相同，价格、重量、身份一律不碰。
  // 冻结事实里没有这些，Ozon 那边的俄文属性和关键词就没有中文那一端可绑。
  const c1SupplyAttributeBackfillRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/supply-attribute-backfill$/);
  if (req.method === "POST" && c1SupplyAttributeBackfillRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1SupplyAttributeBackfillRoute[1]) throw httpError(400, "请求与当前商品不一致，未执行");
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "补齐供应属性必须提供当前数据修订号");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_SUPPLY_ATTRIBUTE_BACKFILL_OWNER_REQUIRED", message: "请先登录主人身份后再补齐供应属性", externalRequests: 0 });
    }
    const snapshot = await readData();
    const current = snapshot.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(404, "候选不存在");
    const skuPackageId = current.lifecycleV11?.skuPackage?.skuPackageId;
    if (!skuPackageId) throw httpError(409, "当前商品还没有C1的SKU生命周期包");
    try {
      const result = await c1SupplyAttributeBackfillUseCase.backfill({ actor, input: {
        candidateId: input.candidateId, expectedRevision: input.dataRevision, skuPackageId,
        idempotencyKey: `c1-supply-attribute-backfill:${input.candidateId}:${input.dataRevision}`,
        auditEventId: `c1-supply-attribute-backfill-audit:${input.candidateId}:${input.dataRevision}`
      } });
      return json(res, 200, { candidate: result.candidate, result: result.result, platformWrites: 0, paidCalls: 0 });
    } catch (error) {
      if (error instanceof C1SupplyAttributeBackfillError) {
        return json(res, 409, { code: error.code, message: supplyBackfillMessage(error.code), externalRequests: 0, platformWrites: 0, paidCalls: 0 });
      }
      throw error;
    }
  }

  // 重读这个类目的 Schema，把计划里冻结的那一份换成新的。
  // 为什么需要：9-17 冻结时证据服务的读取把 47 个属性筛成了 4 个必填、还丢掉字典号，
  // 于是冻结副本里没有属性表，主人在界面上挑不了属性。事实尚未冻结，换的是「冻之前的输入」。
  // 证据包和计划里那份**同一次写入**：只提交其中一个，引用就会指向一个不存在的包。
  const c1RefreshSchemaRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/refresh-category-schema$/);
  if (req.method === "POST" && c1RefreshSchemaRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1RefreshSchemaRoute[1]) throw httpError(400, "请求与当前商品不一致，未执行");
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "重读类目资料必须提供当前数据修订号");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_FROZEN_SCHEMA_REFRESH_OWNER_REQUIRED", message: "请先登录主人身份后再重读类目资料", externalRequests: 0 });
    }
    const snapshot = await readData();
    const current = snapshot.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(404, "候选不存在");
    if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重试");
    const rules = current.lifecycleV11?.skuPackage?.c1ProductPlan?.inputSnapshots?.platformSchemaRules;
    if (!rules?.evidenceId) throw httpError(409, "本件商品还没有冻结的平台类目资料");
    const providers = createLifecycleBRealEvidenceProviderRegistry({
      ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl,
      guooFilePath: runtimeConfiguration.guooTariffFile,
      cbrSourceUrl: process.env.SELECTION_REVIEW_CBR_FX_URL,
      ozonCommissionReference: runtimeConfiguration.ozonCommissionReference
    });
    if (typeof providers.schema !== "function") throw httpError(503, "Schema证据读取未配置，未做任何改动");
    const requestedAt = now();
    let pack;
    try {
      pack = await providers.schema({
        requestVersion: "c1-frozen-schema-refresh-v1",
        candidateId: current.id,
        candidateRevision: current.dataRevision,
        kind: "schema",
        scope: {
          platform: rules.platform, store: rules.store,
          category: `ozon:${rules.descriptionCategoryId}:${rules.typeId}`,
          ruleVersion: "ozon-current", storeRef: structuredClone(rules.storeRef)
        },
        relatedSchemaScope: null, commissionReferenceScope: null,
        maximumAttempts: 1, readOnly: true, platformWritesAllowed: false, requestedAt
      });
    } catch (error) {
      throw httpError(422, `重读类目资料失败，未做任何改动：${error instanceof Error ? error.message : String(error)}`);
    }
    let change = null;
    const candidate = await mutateData((data) => {
      const target = data.candidates.find(item => item.id === input.candidateId);
      if (!target) throw httpError(404, "候选不存在");
      if (Number(target.dataRevision) !== input.dataRevision) throw httpError(409, "读取期间商品资料已变化，本轮没有保存任何证据");
      let refreshed;
      try {
        refreshed = refreshC1FrozenPlatformSchema({
          skuPackage: target.lifecycleV11.skuPackage, freshPack: pack, refreshedAt: requestedAt
        });
      } catch (error) {
        if (error instanceof C1FrozenSchemaRefreshError) throw httpError(409, frozenSchemaRefreshMessage(error.code));
        throw error;
      }
      // 证据包和计划里那一份必须同一次落盘。
      commitLifecycleBEvidencePacks(data, [pack], { createdAt: requestedAt,
        currentCommissionCatalogs: data.currentCommissionCatalogs ?? [] });
      target.lifecycleV11.skuPackage = refreshed.skuPackage;
      target.dataRevision = Number(target.dataRevision) + 1;
      target.updatedAt = requestedAt;
      target.lastModifiedBy = "software";
      change = refreshed.change;
      addHistory(target, "system", "c1CategorySchemaRefreshed",
        `已重读Ozon类目资料：${change.attributeCount}个属性（${change.dictionaryBackedCount}个带字典）。未访问供应端、未改价格、未冻结事实。`, requestedAt);
      return target;
    });
    return json(res, 200, { candidate, change, platformWrites: 0, paidCalls: 0 });
  }

  // 让软件把这张属性表**填好**再给主人看：他只做判断，不做录入。
  //
  // 2026-09-18 主人原话——「你这个让我填？那我干嘛不自己去上架呢？」。他说得对。
  // 三层分工：模型只在**字典真实候选**里挑（实测给候选做选择题是 5 对 1 弃权 0 错，
  // 而让它凭空写俄文是 7 条对 1 条）；Ozon 字典做裁决，编不出平台上没有的值；主人点头。
  // 这一步**会花 AI 调用的钱**，所以必须是主人主动点，不能自动跑。
  const c1OzonAttributeProposalRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/ozon-attribute-proposal$/);
  if (req.method === "POST" && c1OzonAttributeProposalRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1OzonAttributeProposalRoute[1]) throw httpError(400, "请求与当前商品不一致，未执行");
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "生成属性建议必须提供当前数据修订号");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_OZON_ATTRIBUTE_PROPOSAL_OWNER_REQUIRED", message: "请先登录主人身份后再生成属性建议", externalRequests: 0 });
    }
    const snapshot = await readData();
    const current = snapshot.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(404, "候选不存在");
    if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重试");
    const sku = current.lifecycleV11?.skuPackage;
    const plan = sku?.c1ProductPlan;
    if (!plan || plan.status !== "inputs_ready") throw httpError(409, "只有C1事实尚未冻结的商品可以生成属性建议");
    const schema = plan.inputSnapshots?.platformSchemaRules;
    if (!Array.isArray(schema?.attributes) || schema.attributes.length === 0) {
      throw httpError(409, "冻结的类目资料里还没有属性表，请先重读一次类目资料");
    }
    // 中文那一端要对着**核验之后**的事实取，所以先在内存里冻一份，不落盘。
    const rights = resolveC1SkuRightsReviewForFacts({ skuPackage: sku, observedAt: now() });
    let verifiedPlan;
    try {
      verifiedPlan = verifyC1ProductFacts({ skuPackage: structuredClone(sku), skuRightsReview: rights.review, verifiedAt: now() }).skuPackage.c1ProductPlan;
    } catch (error) {
      throw httpError(409, `当前商品还不满足冻结C1事实的条件，未做任何改动：${error instanceof Error ? error.message : String(error)}`);
    }
    const facts = collectConfirmedStringFacts(verifiedPlan);
    if (facts.length === 0) throw httpError(409, "本件商品还没有可当依据的已确认事实");
    const category = `ozon:${schema.descriptionCategoryId}:${schema.typeId}`;
    // 对标页面上同名属性的值，按属性名对齐；它们是备选，默认不勾选。
    const labels = new Set(schema.attributes.map(item => item.label));
    const comparableAttributes = new Map();
    const comparableSnapshots = [...(current.lifecycleV11?.opportunityPackage?.salesSnapshots ?? []), ...(current.salesSnapshotsV11 ?? [])];
    // 对标页面的全部俄语属性是模型的主要素材（主人2026-10-09定的做法），同一页面只送一次。
    const comparableListings = [];
    const listedFrom = new Set();
    for (const item of comparableSnapshots) {
      const from = String(item?.platformProductId ?? item?.snapshotId ?? "");
      if (!from || listedFrom.has(from)) continue;
      const attributes = Object.fromEntries(Object.entries(item?.attributes ?? {}).filter(([, value]) => typeof value === "string"));
      if (Object.keys(attributes).length === 0) continue;
      listedFrom.add(from);
      comparableListings.push({ from, attributes });
    }
    const supplierReference = typeof current.sourceCapture?.title === "string" && current.sourceCapture.title.trim()
      ? { platform: /yangkeduo\.com|pinduoduo\.com/i.test(String(current.sourceCapture.sourceUrl ?? current.sourceUrl ?? "")) ? "pinduoduo" : "1688",
        title: current.sourceCapture.title } : null;
    for (const item of comparableSnapshots) {
      for (const [key, value] of Object.entries(item?.attributes ?? {})) {
        if (!labels.has(key) || typeof value !== "string") continue;
        for (const one of value.split(",")) {
          const term = one.trim();
          if (!term) continue;
          if (!comparableAttributes.has(key)) comparableAttributes.set(key, []);
          const list = comparableAttributes.get(key);
          if (!list.some(entry => entry.value === term)) list.push({ value: term, from: String(item.platformProductId ?? item.snapshotId) });
        }
      }
    }
    const proposer = createC1OzonAttributeProposer({
      gatewayUrl: runtimeConfiguration.aiGatewayUrl,
      readDictionaryValue: createOzonDictionaryValueReader({ ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl }),
      readDictionaryValues: createOzonDictionaryValuesReader({ ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl }),
      gatewayDeploymentMode: runtimeConfiguration.deploymentMode
    });
    try {
      // 已经由主人签过的权利声明确认下来的必填属性（品牌就是这样），**不要摆进这张表**。
      // 2026-09-18 真踩到：品牌本来已由声明确认，却还是被列进去让模型配对，
      // 它抓了个字面像的「专利类型=无」填上去——「没有专利」推不出「没有品牌」。
      // 那条假依据虽然没被采用（必填项用的是声明），但留在数据里迟早有人当真。
      const settledByDeclaration = new Set((verifiedPlan.productAttributes?.requiredPlatformFields ?? [])
        .filter(item => item.fact?.verificationStatus === "confirmed" && item.resolvedFromOwnerAttributeMapping !== true)
        .flatMap(item => [String(item.fieldKey), ...(Array.isArray(item.sourceAttributeKeys) ? item.sourceAttributeKeys.map(String) : [])]));
      const proposal = await proposer.propose({
        attributes: schema.attributes
          .filter(item => Number(item.dictionaryId) > 0 || item.required === true)
          .filter(item => !settledByDeclaration.has(String(item.fieldKey)))
          .slice(0, OZON_ATTRIBUTE_PROPOSAL_MAX_ATTRIBUTES),
        facts, categoryLabel: schema.categoryName ?? category, store: schema.store, category,
        candidateId: current.id, skuPackageId: sku.skuPackageId, dataRevision: String(current.dataRevision),
        comparableAttributes, comparableListings, supplierReference
      });
      // 主人签字定下的值（品牌就是这样）——它不缺依据，只缺「平台给这个值的编号」。
      // 这一步**不经过模型**：拿声明里的那个值去字典里逐字搜，搜到就把编号补上，
      // 依据仍然记成那条声明。搜不到就不加这一行，照实缺着。
      //
      // 为什么非补不可：`ozon-seller-api-production-adapter.mjs` 对字典属性要求正整数
      // dictionaryValueId，声明给的是 null，真发 import 会直接报
      // OZON_ADAPTER_DICTIONARY_VALUE_REQUIRED（2026-09-18 实测）。
      const declaredRows = [];
      for (const field of (verifiedPlan.productAttributes?.requiredPlatformFields ?? [])) {
        if (field.fact?.verificationStatus !== "confirmed") continue;
        const attribute = schema.attributes.find(item => String(item.fieldKey) === String(field.fieldKey));
        if (!attribute || !(Number(attribute.dictionaryId) > 0)) continue;
        const current = field.fact.value;
        if (!current || typeof current !== "object") continue;
        if (Number.isInteger(current.dictionaryValueId) && current.dictionaryValueId > 0) continue;
        const text = typeof current.value === "string" ? current.value.trim() : "";
        if (!text) continue;
        const declarationPath = "platformCompliance.skuRightsReview.brand";
        const declaration = declarationPath.split(".").reduce((node, key) => node?.[key], verifiedPlan);
        if (!declaration || declaration.verificationStatus !== "confirmed") continue;
        let hit = null;
        try {
          const read = await createOzonDictionaryValueReader({ ozonServiceUrl: runtimeConfiguration.ozonEvidenceServiceUrl })(
            { store: schema.store, category, attributeId: String(field.fieldKey), value: text });
          const exact = read?.evidenceData?.exactMatch ?? null;
          if (exact && exact.value === text && Number.isInteger(exact.dictionaryValueId) && exact.dictionaryValueId > 0) hit = { ...exact, sourceRef: read.sourceRef ?? null };
        } catch { hit = null; }
        if (!hit) continue;
        declaredRows.push({
          attributeId: String(field.fieldKey), label: attribute.label ?? null, labelZh: attribute.labelZh ?? null,
          required: true, dictionaryId: Number(attribute.dictionaryId), rejectedByDictionary: null, alternatives: [],
          suggestion: { value: hit.value, valueZh: hit.valueZh ?? null, dictionaryValueId: hit.dictionaryValueId,
            sourceFactPath: declarationPath,
            // **比较用的值一个字不动**：漂移守卫要拿它和事实当前值逐字对比，
            // 换成人话就会永远判成漂移（差点在这里引入刚修完的那个毛病）。
            sourceFactValue: structuredClone(declaration.value),
            // 另给一句只用于显示的话。声明那条事实的值是对象（{status,name}），
            // 界面直接渲染对象会整页白屏——2026-09-18 真让主人白屏了一次。
            sourceFactText: typeof declaration.value === "object" && declaration.value !== null
              ? `主人声明：${declaration.value.status === "unbranded" ? "无品牌" : String(declaration.value.status ?? "")}`
              : String(declaration.value ?? ""),
            origin: "declared_value_dictionary_lookup", dictionaryEvidenceRef: hit.sourceRef }
        });
      }
      const merged = declaredRows.length === 0 ? proposal : {
        ...proposal,
        rows: [...declaredRows, ...proposal.rows],
        suggestedCount: proposal.suggestedCount + declaredRows.length
      };
      return json(res, 200, { proposal: merged, platformWrites: 0, paidCalls: proposal.jobIds.length });
    } catch (error) {
      if (error instanceof C1OzonAttributeProposalError) {
        return json(res, 422, { code: error.code, message: `生成属性建议失败，没有改动任何数据：${error.detail ?? error.code}`,
          externalRequests: 0, platformWrites: 0 });
      }
      throw error;
    }
  }

  // 颜色字典先保存主人一次性授权，再原子标记请求已发，才调用本机只读证据服务。
  const c1ColorDictionaryRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/color-dictionary\/(authorize|continue)$/);
  if (req.method === 'POST' && c1ColorDictionaryRoute) {
    const input = await requestBody(req);
    const action = c1ColorDictionaryRoute[2];
    const keys = action === 'authorize'
      ? 'attributeId,candidateId,dataRevision,skuPackageId'
      : 'attributeId,authorizationId,candidateId,dataRevision,skuPackageId';
    if (!input || input.candidateId !== c1ColorDictionaryRoute[1] ||
        Object.keys(input).sort().join(',') !== keys ||
        !Number.isSafeInteger(input.dataRevision) || !['10096', '10097'].includes(input.attributeId) ||
        typeof input.skuPackageId !== 'string' ||
        (action === 'continue' && typeof input.authorizationId !== 'string')) {
      throw httpError(400, '颜色字典读取只接受当前商品、SKU、属性及修订号');
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    const common = { candidateId: input.candidateId, skuPackageId: input.skuPackageId,
      attributeId: input.attributeId, expectedRevision: input.dataRevision };
    try {
      const transaction = action === 'authorize'
        ? await c1ColorDictionaryReadUseCase.authorize({ actor, input: common })
        : await c1ColorDictionaryReadUseCase.continueSaved({ actor,
          input: { ...common, authorizationId: input.authorizationId } });
      const saved = await readData();
      return json(res, 200, { status: transaction.status, result: transaction.result,
        candidate: publicCandidate(transaction.candidate, saved.rules, {}, saved.evidencePacks || [], saved.currentCommissionCatalogs ?? []),
        platformWrites: 0, paidCalls: 0 });
    } catch (error) {
      const code = error.code ?? error.message;
      if (error instanceof C1ColorDictionaryReadError ||
          ['BUSINESS_MUTATION_REVISION_CONFLICT', 'BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT'].includes(code)) {
        const requestSent = error instanceof C1ColorDictionaryReadError && error.requestSent === true;
        return json(res, code.endsWith('OWNER_REQUIRED') ? 403 : 409, { code,
          message: requestSent
            ? '字典读取作业已发出，但结果未能安全保存；须先核对已保存请求，不能再次读取。'
            : code === 'C1_COLOR_DICTIONARY_SCHEMA_NOT_CURRENT'
            ? '当前冻结类目资料缺少有效的同范围官方证据，请先使用现有类目资料刷新入口。'
            : code === 'C1_COLOR_DICTIONARY_HISTORY_CAPACITY_REACHED'
              ? '本规格已保留的颜色字典读取历史达到安全容量；旧记录未删除，请先做技术核对。'
            : '颜色字典读取授权、范围或结果不满足当前规格；请求未重发，请核对已保存状态。',
          requestState: requestSent ? 'unknown_outcome' : 'not_sent',
          ownerAction: requestSent ? 'reconcile_color_dictionary_read' : 'review_color_dictionary_scope',
          externalRequests: requestSent ? 1 : 0, platformWrites: 0, paidCalls: 0 });
      }
      throw error;
    }
  }
  // 这个类目的全部属性、可以当依据的已确认事实、以及已经签过的映射。只读，不查字典。
  const c1OzonAttributesRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/ozon-attributes$/);
  if (req.method === "GET" && c1OzonAttributesRoute) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_OZON_ATTRIBUTE_MAPPING_OWNER_REQUIRED", message: "请先登录主人身份后再查看Ozon属性", externalRequests: 0 });
    }
    const snapshot = await readData();
    const current = snapshot.candidates.find(item => item.id === c1OzonAttributesRoute[1]);
    if (!current) throw httpError(404, "候选不存在");
    const skuPackageId = current.lifecycleV11?.skuPackage?.skuPackageId;
    if (!skuPackageId) throw httpError(409, "当前商品还没有C1的SKU生命周期包");
    try {
      const proposal = await c1OzonAttributeMappingUseCase.propose({ actor, input: {
        candidateId: current.id, expectedRevision: current.dataRevision, skuPackageId
      } });
      return json(res, 200, { proposal, platformWrites: 0, paidCalls: 0 });
    } catch (error) {
      if (error instanceof C1OzonAttributeMappingError) {
        return json(res, 409, { code: error.code, message: ozonMappingMessage(error.code), externalRequests: 0, platformWrites: 0, paidCalls: 0 });
      }
      throw error;
    }
  }

  // 主人签下「这条中文事实，在 Ozon 上就是这个俄文字典值」。软件只核实能核实的：
  // 属性号在当前冻结 schema 里、字典值逐字命中、中文那端确实是一条已确认事实。
  const c1OzonAttributeMappingRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/ozon-attribute-mapping$/);
  if (req.method === "POST" && c1OzonAttributeMappingRoute) {
    const input = await requestBody(req);
    if (input?.candidateId !== c1OzonAttributeMappingRoute[1]) throw httpError(400, "请求与当前商品不一致，未执行");
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "保存属性映射必须提供当前数据修订号");
    if (!Array.isArray(input.mappings) || input.mappings.length === 0) throw httpError(400, "至少要有一条属性映射");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C1_OZON_ATTRIBUTE_MAPPING_OWNER_REQUIRED", message: "请先登录主人身份后再保存属性映射", externalRequests: 0 });
    }
    const snapshot = await readData();
    const current = snapshot.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(404, "候选不存在");
    const skuPackageId = current.lifecycleV11?.skuPackage?.skuPackageId;
    if (!skuPackageId) throw httpError(409, "当前商品还没有C1的SKU生命周期包");
    try {
      const result = await c1OzonAttributeMappingUseCase.map({ actor, input: {
        candidateId: input.candidateId, expectedRevision: input.dataRevision, skuPackageId,
        mappings: input.mappings,
        idempotencyKey: `c1-ozon-attribute-mapping:${input.candidateId}:${input.dataRevision}`,
        auditEventId: `c1-ozon-attribute-mapping-audit:${input.candidateId}:${input.dataRevision}`
      } });
      return json(res, 200, { candidate: result.candidate, result: result.result, platformWrites: 0, paidCalls: 0 });
    } catch (error) {
      if (error instanceof C1OzonAttributeMappingError || error instanceof C1ColorDictionaryReadError) {
        return json(res, 409, { code: error.code,
          message: error instanceof C1ColorDictionaryReadError
            ? '本规格颜色缺少当前完整的已授权字典候选；请先在 C1 读取并选择官方候选。'
            : ozonMappingMessage(error.code, error.detail),
          externalRequests: 0, platformWrites: 0, paidCalls: 0 });
      }
      throw error;
    }
  }

  const retiredFireTrainC1Route = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1-owner-facts$/);
  const retiredFireTrainFinalAssetsRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/final-assets$/);
  const legacyFireTrainC1Route = pathname.match(/^\/api\/legacy\/fire-train\/candidates\/([^/]+)\/lifecycle\/c1-owner-facts$/);
  const legacyFireTrainFinalAssetsRoute = pathname.match(/^\/api\/legacy\/fire-train\/candidates\/([^/]+)\/lifecycle\/final-assets$/);
  const genericC1CompleteRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/complete$/);
  const c1FactKeywordPipelineRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/fact-keyword-pipeline$/);
  const c1KeywordEvidenceReadyRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/keyword-evidence-ready$/);
  const c1KeywordEvidenceSoftwareRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/keyword-evidence-software-run$/);
  const c1SoftwareEvidenceStageRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c1\/software-evidence$/);
  const genericC2FinalAssetUploadRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c2\/final-assets\/upload$/);
  const genericC2FinalAssetsRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c2\/final-assets$/);
  const realProductionOwnerDecisionRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/production-owner-decision$/);
  const productionOwnerPreparationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/production-owner-preparation$/);
  const realProductionAuthorizationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/production-authorization$/);
  const realProductionAuthorizationRevisionRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/production-authorization\/revise$/);
  const realProductionAuthorizationPriceRepairRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/production-authorization\/repair-price-semantics$/);
  const realDAssetTransportRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/d\/asset-transport$/);
  const savedDEContinuationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/d-e\/continue-saved$/);
  const dProductionRoundRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/d\/production-round$/);
  const productionAuthorizationRollbackRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/d\/authorization-rollback$/);
  const dInitialImportRecoveryRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/d\/initial-import-recovery$/);
  const dUnknownOutcomeReobservationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/d\/unknown-outcome-reobservation$/);
  const dPlatformStateReconciliationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/d\/platform-state-reconciliation$/);
  const accountReadRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/account-read\/(authorize|continue)$/);
  if (req.method === "POST" && accountReadRoute) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw httpError(415, "账户核验只接受当前确认卡提交");
    const origin = String(req.headers.origin || "");
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, "账户核验拒绝其他网页来源");
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后确认本次账户读取");
    }
    const input = await requestBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input) || input.candidateId !== accountReadRoute[1]) {
      throw httpError(400, "账户读取必须准确对应当前商品");
    }
    let execution;
    try {
      execution = accountReadRoute[2] === "authorize"
        ? await ozonAccountReadServices.authorizeAndRun({ actor, input })
        : await ozonAccountReadServices.continueSavedRead(input);
    } catch (error) {
      if (!(error instanceof OzonAccountReadError)) throw error;
      const status = /NOT_CONFIGURED/.test(error.code) ? 503 : /CHANGED|CONFLICT|EXPIRED|AMBIGUOUS/.test(error.code) ? 409 : 422;
      return json(res, status, { code: error.code, message: "账户读取未完成，请核对当前确认范围及已保存作业。" });
    }
    const document = await readData(), candidate = document.candidates.find(value => value.id === input.candidateId);
    if (!candidate) throw httpError(500, "账户读取结果待核对：当前商品独立回读缺失");
    return json(res, 200, { ...execution, candidate: publicSavedDECandidate(candidate, document) });
  }
  if (req.method === "POST" && dInitialImportRecoveryRoute) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw httpError(415, "对账恢复只接受当前页面的确认提交");
    const origin = String(req.headers.origin || "");
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, "对账恢复拒绝其他网页来源");
    const input = await requestBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input) || input.candidateId !== dInitialImportRecoveryRoute[1]) {
      throw httpError(400, "对账恢复请求必须准确对应当前商品");
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    let execution;
    try { execution = await dInitialImportRecoveryUseCase.recover({ actor, input }); }
    catch (error) {
      if (!(error instanceof DInitialImportRecoveryError)) throw error;
      const status = error.code === "OWNER_REQUIRED" ? 403 : error.code === "CANDIDATE_NOT_FOUND" || error.code === "JOB_NOT_FOUND" ? 404
        : error.code === "CANDIDATE_CHANGED" || error.code === "ALREADY_RECOVERED" ? 409 : error.code === "INPUT_INVALID" ? 400 : 422;
      return json(res, status, { code: error.code, message: error.message, externalRequests: 0, platformWrites: 0 });
    }
    const after = await readData(), current = after.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(500, "对账恢复结果待核对：当前商品独立回读缺失");
    return json(res, 200, { ...execution, candidate: publicSavedDECandidate(current, after) });
  }
  if (req.method === "POST" && dUnknownOutcomeReobservationRoute) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw httpError(415, "重新观察只接受当前页面的确认提交");
    const origin = String(req.headers.origin || "");
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, "重新观察拒绝其他网页来源");
    const input = await requestBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input) || input.candidateId !== dUnknownOutcomeReobservationRoute[1]) {
      throw httpError(400, "重新观察请求必须准确对应当前商品");
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    let execution;
    try { execution = await dUnknownOutcomeReobservationUseCase.reobserve({ actor, input }); }
    catch (error) {
      if (!(error instanceof DUnknownOutcomeReobservationError)) throw error;
      const status = error.code === "OWNER_REQUIRED" ? 403 : error.code === "CANDIDATE_NOT_FOUND" || error.code === "JOB_NOT_FOUND" ? 404
        : error.code === "CANDIDATE_CHANGED" || error.code === "ALREADY_REOBSERVED" ? 409 : error.code === "INPUT_INVALID" ? 400 : 422;
      return json(res, status, { code: error.code, message: error.message, externalRequests: 0, platformWrites: 0 });
    }
    const after = await readData(), current = after.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(500, "重新观察结果待核对：当前商品独立回读缺失");
    return json(res, 200, { ...execution, candidate: publicSavedDECandidate(current, after) });
  }
  if (req.method === "POST" && dPlatformStateReconciliationRoute) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw httpError(415, "按平台现状收口只接受当前页面的确认提交");
    const origin = String(req.headers.origin || "");
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, "按平台现状收口拒绝其他网页来源");
    const input = await requestBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input) || input.candidateId !== dPlatformStateReconciliationRoute[1]) {
      throw httpError(400, "收口请求必须准确对应当前商品");
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    let execution;
    try { execution = await dPlatformStateReconciliationUseCase.reconcile({ actor, input }); }
    catch (error) {
      if (!(error instanceof DPlatformStateReconciliationError)) throw error;
      const status = error.code === "OWNER_REQUIRED" ? 403 : error.code === "CANDIDATE_NOT_FOUND" || error.code === "JOB_NOT_FOUND" ? 404
        : ["CANDIDATE_CHANGED", "ALREADY_RECONCILING", "RECONCILE_LIMIT_REACHED"].includes(error.code) ? 409 : error.code === "INPUT_INVALID" ? 400 : 422;
      return json(res, status, { code: error.code, message: error.message, externalRequests: 0, platformWrites: 0 });
    }
    const after = await readData(), current = after.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(500, "收口结果待核对：当前商品独立回读缺失");
    return json(res, 200, { ...execution, candidate: publicSavedDECandidate(current, after) });
  }
  if (req.method === "POST" && productionAuthorizationRollbackRoute) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw httpError(415, "作废生产授权只接受当前页面的确认提交");
    const origin = String(req.headers.origin || "");
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, "作废生产授权拒绝其他网页来源");
    const input = await requestBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input) || input.candidateId !== productionAuthorizationRollbackRoute[1]) {
      throw httpError(400, "作废请求必须准确对应当前商品");
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    let execution;
    try { execution = await productionAuthorizationRollbackUseCase.rollback({ actor, input }); }
    catch (error) {
      if (!(error instanceof ProductionAuthorizationRollbackError)) throw error;
      const status = error.code === "OWNER_REQUIRED" ? 403 : error.code === "CANDIDATE_NOT_FOUND" ? 404
        : error.code === "CANDIDATE_CHANGED" ? 409 : error.code === "INPUT_INVALID" ? 400 : 422;
      return json(res, status, { code: error.code, message: error.message, externalRequests: 0, platformWrites: 0 });
    }
    const after = await readData(), current = after.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(500, "作废结果待核对：当前商品独立回读缺失");
    return json(res, 200, { ...execution, candidate: publicSavedDECandidate(current, after) });
  }
  if (req.method === "POST" && dProductionRoundRoute) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw httpError(415, "重派生产作业只接受当前页面的确认提交");
    const origin = String(req.headers.origin || "");
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, "重派生产作业拒绝其他网页来源");
    const input = await requestBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input) || input.candidateId !== dProductionRoundRoute[1]) {
      throw httpError(400, "重派请求必须准确对应当前商品");
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    let execution;
    try { execution = await dProductionRoundUseCase.dispatch({ actor, input }); }
    catch (error) {
      if (!(error instanceof DProductionRoundError)) throw error;
      const status = error.code === "OWNER_REQUIRED" ? 403 : error.code === "CANDIDATE_NOT_FOUND" ? 404
        : error.code === "CANDIDATE_CHANGED" ? 409 : error.code === "INPUT_INVALID" ? 400 : 422;
      return json(res, status, { code: error.code, message: error.message, externalRequests: 0, platformWrites: 0 });
    }
    const after = await readData(), current = after.candidates.find(item => item.id === input.candidateId);
    if (!current) throw httpError(500, "重派结果待核对：当前商品独立回读缺失");
    return json(res, 200, { ...execution, candidate: publicSavedDECandidate(current, after) });
  }
  if (req.method === "POST" && savedDEContinuationRoute) {
    const input = await requestBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 3 ||
        !["candidateId", "expectedRevision", "jobId"].every(field => Object.hasOwn(input, field)) ||
        input.candidateId !== savedDEContinuationRoute[1] || !Number.isSafeInteger(input.expectedRevision)) {
      throw httpError(400, "继续请求必须准确引用当前已保存任务");
    }
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      throw httpError(403, "请先登录主人身份后继续已保存任务");
    }
    const before = await readData(), candidate = before.candidates.find(item => item.id === input.candidateId);
    if (!candidate || candidate.dataRevision !== input.expectedRevision) throw httpError(409, "商品资料已变化，请核对当前记录");
    const view = savedDEJobView(candidate, before.runtime);
    if (!view?.canContinueSaved || view.continueJobId !== input.jobId) {
      throw httpError(409, view?.message || "当前任务不可继续，请核对已保存结果和卡点");
    }
    try {
      const execution = await ozonAccountReadServices.continueProduction(input);
      const after = await readData(), current = after.candidates.find(item => item.id === input.candidateId);
      if (!current) throw httpError(500, "执行结果待核对：当前商品独立回读缺失");
      return json(res, 200, { executionStatus: execution.status, candidate: publicSavedDECandidate(current, after) });
    } catch (error) {
      if (error instanceof DERuntimeUnavailableError) throw httpError(503, "执行服务配置尚未齐备，已保存任务保持原状态");
      throw error;
    }
  }
  if (req.method === "POST" && (retiredFireTrainC1Route || retiredFireTrainFinalAssetsRoute)) {
    await requestBody(req);
    throw httpError(410, "旧火车专属C阶段入口已隔离，不得用于新版生命周期；请使用通用C1/C2入口");
  }
  if (req.method === "POST" && c1FactKeywordPipelineRoute) {
    await requestBody(req);
    throw httpError(410, "旧C1事实关键词注入入口已停用；新版流程只接受服务端按当前revision生成的单次软件计划");
  }
  if (req.method === "POST" && c1KeywordEvidenceReadyRoute) {
    await requestBody(req);
    throw httpError(410, "旧关键词就绪事件注入入口已停用；外部事件只能由当前服务端单次作业内部接续");
  }
  if (req.method === "GET" && pathname === "/api/integrations/seerfar/runtime-status") {
    return json(res, 200, {
      connectorVersion: SEERFAR_RUNTIME_CONNECTOR_VERSION,
      configured: null,
      credentialStatus: "not_checked",
      softwareExecutionEnabled: keywordEvidenceRuntimeServices.status === "running",
      softwareJobQueueEnabled: c1PaidKeywordGenericQueueEnabled,
      consumerConnected: keywordEvidenceRuntimeServices.status === "running",
      serviceStatus: keywordEvidenceRuntimeServices.status,
      executionBlocker: keywordEvidenceRuntimeServices.status === "running" ? null
        : keywordEvidenceRuntimeServices.status === "failed" ? "runtime_failed" : "awaiting_runtime_binding",
      directProviderExecutionEnabled: false,
      automaticRetries: 0,
      browserFallbackEnabled: false,
      secretExposed: false
    });
  }
  if (req.method === "POST" && c1KeywordEvidenceSoftwareRoute) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw httpError(415, "关键词软件作业只接受application/json");
    const origin = String(req.headers.origin || "");
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, "关键词软件作业拒绝非评审台页面来源");
    const input = await requestBody(req);
    const candidate = await runC1KeywordEvidenceSoftwareJob(c1KeywordEvidenceSoftwareRoute[1], input, req);
    return json(res, 200, { candidate });
  }
  if (req.method === "POST" && c1SoftwareEvidenceStageRoute) {
    await requestBody(req);
    throw httpError(410, "旧C1软件证据手工冻结入口已停用；新版流程只读取服务端冻结证据");
  }
  if (req.method === "POST" && genericC1CompleteRoute && !legacyManualC1InputEnabled) {
    await requestBody(req);
    throw httpError(410, "旧手工提交Schema、竞品文字和关键词的C1入口已停用；新版C1只读取A/B冻结数据与已保存证据并由软件自动执行");
  }
  if (req.method === "POST" && genericC1CompleteRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "C1完成必须提供当前数据修订号");
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === genericC1CompleteRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新完成C1");
      const opportunityPackage = current.lifecycleV11?.opportunityPackage;
      const skuPackage = current.lifecycleV11?.skuPackage;
      if (!opportunityPackage || !skuPackage) throw httpError(409, "当前商品缺少新版A/B冻结数据包");
      if (current.lifecycleV11.c1LocalDraftSourceV1 || current.lifecycleV11.c1AiDraftRequestV1?.keywordEvidence.collectionMode === "local_preparation") {
        throw httpError(409, "本次商品内容需要在新版页面核对确认，不能通过旧入口跳过确认");
      }
      if (skuPackage.productionAuthorization || skuPackage.productionRecord) {
        throw httpError(409, "当前SKU已经生产授权或执行，不能重建C1/C2");
      }
      const timestamp = now();
      let result;
      try {
        result = completeC1AndStartC2({
          opportunityPackage,
          skuPackage,
          platformSchemaEvidence: input.platformSchemaEvidence,
          competitorTextSnapshot: input.competitorTextSnapshot,
          keywordEvidence: input.keywordEvidence,
          collectedAssets: Array.isArray(input.collectedAssets) ? input.collectedAssets : [],
          completedAt: timestamp
        });
      } catch (error) {
        throw httpError(422, error.message);
      }
      if (current.siblingSourceV1) {
        try { assertSiblingSkuColorProjection({ ...current, lifecycleV11: { ...current.lifecycleV11, skuPackage: result.skuPackage } }); }
        catch (error) {
          if (error.message !== 'SIBLING_COLOR_BINDING_INVALID') throw error;
          throw httpError(422, `${error.message}: 请返回 C1 补齐 10096 商品颜色和 10097 颜色名称的主人映射`);
        }
      }
      current.lifecycleV11 = {
        ...current.lifecycleV11,
        status: "awaiting_final_assets",
        skuPackage: structuredClone(result.skuPackage),
        externalAccesses: [],
        platformWrites: 0
      };
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "awaiting_final_assets",
        reason: "通用C1已仅使用A/B冻结数据完成事实、Schema和SEO草稿，当前等待主人确认最终上传素材。",
        decisionItems: ["提供并确认当前SKU的最终图片/视频及顺序"],
        writeOccurred: false,
        platformWrites: 0
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "needs_decision",
        owner: "listing_task",
        runId: null,
        currentStep: "C1完成，C2等待最终素材",
        blockReason: null,
        userAction: "请确认当前SKU的最终素材；采集素材和AI草稿不会自动进入D。",
        decisionItems: ["确认最终上传素材"],
        stoppedAt: null
      };
      current.processing = { ...queuedProcessing(current.processing), state: "idle" };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "genericC1CompletedAndC2Started", `通用C1完成；锁定供应SKU ${result.skuPackage.supplierSkuId}；C2等待最终素材；零外部访问、零平台写入`, timestamp);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }
  const c2UploadDraftRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c2\/upload-draft$/);
  const c2LinkedAssetRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c2\/final-assets\/link$/);
  const c2LocalAssetPreviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/c2\/local-assets\/([^/]+)$/);
  if (req.method === "GET" && c2LocalAssetPreviewRoute) {
    const data = await readData();
    const current = data.candidates.find(item => item.id === c2LocalAssetPreviewRoute[1]);
    const asset = current?.lifecycleV11?.c2UploadDraft?.uploads.find(item => item.assetId === c2LocalAssetPreviewRoute[2] && item.status === "ready");
    if (!asset) throw httpError(404, "当前商品没有该本地素材");
    const file = await c2LocalAssetStore.read(asset);
    res.writeHead(200, { "Content-Type": file.contentType, "Content-Length": file.body.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(file.body);
    return;
  }
  if (req.method === "POST" && c2UploadDraftRoute) {
    const input = await requestBody(req);
    const draft = await mutateData(data => {
      const current = data.candidates.find(item => item.id === c2UploadDraftRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      const saved = saveC2UploadSelection(current, input);
      current.lifecycleV11.c2UploadDraft = saved;
      return structuredClone(current.lifecycleV11.c2UploadDraft);
    });
    return json(res, 200, { candidateId: draft.candidateId, dataRevision: draft.sourceCandidateRevision, draft, businessPhaseChanged: false, platformWrites: 0 });
  }
  if (req.method === "POST" && c2LinkedAssetRoute) {
    const origin = String(req.headers.origin || '');
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, '共享素材拒绝其他网页来源');
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human" || !actor.roles.includes("owner")) {
      return json(res, 403, { code: "C2_LINK_OWNER_REQUIRED", message: "只有主人可以选择同批已上传素材", platformWrites: 0 });
    }
    if (c2UploadInProgress) throw httpError(409, "本机正在处理另一份素材", { code: "c2_upload_busy" });
    const input = await requestBody(req);
    if (!input || Object.keys(input).sort().join() !== "dataRevision,draftRevision,role,sourceAssetId,sourceCandidateId,sourceDataRevision" ||
        !Number.isSafeInteger(input.dataRevision) || !Number.isSafeInteger(input.draftRevision) ||
        !Number.isSafeInteger(input.sourceDataRevision) || typeof input.sourceAssetId !== "string" ||
        typeof input.sourceCandidateId !== "string" || !["main_image", "gallery_image"].includes(input.role)) {
      throw httpError(400, "共享素材输入缺少当前商品、来源或顺序");
    }
    c2UploadInProgress = true;
    try {
      const targetId = c2LinkedAssetRoute[1];
      const uploadId = randomUUID();
      const { sourceAsset, reserved } = await mutateData(data => {
        const sources = data.candidates.filter(item => item.id === input.sourceCandidateId);
        const targets = data.candidates.filter(item => item.id === targetId);
        if (sources.length !== 1 || targets.length !== 1 || input.sourceCandidateId === targetId) {
          throw httpError(409, "共享素材来源或目标不唯一", { code: "c2_link_identity_invalid" });
        }
        const [source] = sources, [target] = targets;
        const family = data.candidates.filter(item => item.id === source.siblingSourceV1?.parentCandidateId);
        const selected = family.length === 1 ? family[0].sourceCapture?.selectedSkuIds : null;
        if (!source.siblingSourceV1 || !target.siblingSourceV1 ||
            source.siblingSourceV1.parentCandidateId !== target.siblingSourceV1.parentCandidateId ||
            !Array.isArray(selected) || !selected.includes(source.siblingSourceV1.supplierSkuId) ||
            !selected.includes(target.siblingSourceV1.supplierSkuId) ||
            source.siblingSourceV1.supplierSkuId === family[0].lifecycleV11?.skuPackage?.supplierSkuId ||
            target.siblingSourceV1.supplierSkuId === family[0].lifecycleV11?.skuPackage?.supplierSkuId ||
            source.sourceCapture?.skuChoices?.[0]?.sourceSkuId !== source.siblingSourceV1.supplierSkuId ||
            target.sourceCapture?.skuChoices?.[0]?.sourceSkuId !== target.siblingSourceV1.supplierSkuId ||
            source.dataRevision !== input.sourceDataRevision || target.dataRevision !== input.dataRevision ||
            source.targetPlatform !== target.targetPlatform || !sameStoreRef(source.storeRef, target.storeRef)) {
          throw httpError(409, "只可引用同批同店当前规格已上传的素材", { code: "c2_link_identity_invalid" });
        }
        const sourceDraft = assertCurrentC2UploadDraft(source, { dataRevision: input.sourceDataRevision,
          draftRevision: source.lifecycleV11?.c2UploadDraft?.revision ?? 0 }).draft;
        const sourceAsset = sourceDraft?.uploads.filter(item => item.assetId === input.sourceAssetId && item.status === "ready");
        const targetDraft = assertCurrentC2UploadDraft(target, { dataRevision: input.dataRevision,
          draftRevision: input.draftRevision }).draft;
        if (sourceAsset?.length !== 1 || targetDraft?.uploads.some(item => item.status === "uploading") ||
            (input.role === "gallery_image" && !targetDraft?.selection?.length) ||
            (input.role === "main_image" && Boolean(targetDraft?.selection?.length))) {
          throw httpError(409, "请先确定本色主图，并核对来源文件登记", { code: "c2_link_selection_invalid" });
        }
        const sourceColor = source.sourceCapture?.skuChoices?.[0]?.attributes?.颜色;
        const targetColor = target.sourceCapture?.skuChoices?.[0]?.attributes?.颜色;
        if ((input.role === "main_image" || sourceDraft.selection?.[0]?.assetId === input.sourceAssetId) &&
            (!sourceColor || sourceColor !== targetColor)) {
          throw httpError(409, "不同颜色不能共用主图", { code: "c2_link_main_color_mismatch" });
        }
        const asset = sourceAsset[0];
        const draft = reserveC2Upload(target, { dataRevision: input.dataRevision,
          draftRevision: input.draftRevision, uploadId, fileName: asset.fileName,
          mediaType: asset.mediaType, contentType: asset.contentType, startedAt: now() });
        target.lifecycleV11.c2UploadDraft = draft;
        return { sourceAsset: structuredClone(asset), reserved: structuredClone(draft.uploads.find(item => item.uploadId === uploadId)) };
      });
      let linked;
      try { linked = await c2LocalAssetStore.linkExisting(sourceAsset, reserved); }
      catch (error) {
        await mutateData(data => {
          const target = data.candidates.find(item => item.id === targetId);
          target.lifecycleV11.c2UploadDraft = settleC2Upload(target.lifecycleV11.c2UploadDraft,
            { uploadId, failureCode: "file_storage_unconfirmed", settledAt: now() });
          return null;
        });
        throw error;
      }
      const draft = await mutateData(data => {
        const target = data.candidates.find(item => item.id === targetId);
        if (!target || target.dataRevision !== input.dataRevision) {
          throw httpError(409, "引用文件已建立但目标修订变化，请核对素材登记", { code: "c2_link_receipt_conflict" });
        }
        target.lifecycleV11.c2UploadDraft = settleC2Upload(target.lifecycleV11.c2UploadDraft,
          { uploadId, asset: linked, settledAt: now() });
        return structuredClone(target.lifecycleV11.c2UploadDraft);
      });
      return json(res, 201, { candidateId: targetId, dataRevision: input.dataRevision,
        asset: linked, draft, businessPhaseChanged: false, platformWrites: 0 });
    } finally { c2UploadInProgress = false; }
  }
  if (req.method === "POST" && genericC2FinalAssetUploadRoute) {
    if (c2UploadInProgress) throw httpError(409, "本机正在接收另一份素材，请在其结束后上传", { code: "c2_upload_busy" });
    c2UploadInProgress = true;
    try {
      const requestUrl = new URL(req.url, `http://${host}:${port}`);
      const revisionText = requestUrl.searchParams.get("dataRevision");
      const draftRevisionText = requestUrl.searchParams.get("draftRevision");
      if (!/^\d+$/.test(revisionText || "") || !/^\d+$/.test(draftRevisionText || "")) throw httpError(400, "上传必须提供商品和素材清单的当前修订号");
      const dataRevision = Number(revisionText);
      const draftRevision = Number(draftRevisionText);
      const metadata = normalizeC2LocalUpload(requestUrl.searchParams.get("fileName"), req.headers["content-type"]);
      const candidateId = genericC2FinalAssetUploadRoute[1];
      const uploadId = randomUUID();
      const reserved = await mutateData(data => {
        const current = data.candidates.find(item => item.id === candidateId);
        if (!current) throw httpError(404, "候选不存在");
        const draft = reserveC2Upload(current, { dataRevision, draftRevision, uploadId, ...metadata, startedAt: now() });
        current.lifecycleV11.c2UploadDraft = draft;
        return draft.uploads.find(item => item.uploadId === uploadId);
      });
      let asset;
      let failureCode = "upload_incomplete";
      try {
        const body = await requestBinaryBody(req, LOCAL_UPLOAD_MAX_BYTES);
        failureCode = "file_storage_unconfirmed";
        asset = await c2LocalAssetStore.write(reserved, body);
      } catch (error) {
        const rejectedCode = ["c2_upload_content_invalid", "c2_video_validation_unavailable", "c2_upload_animation_unsupported", "c2_upload_decoder_busy"].includes(error.extra?.code) ? error.extra.code : null;
        if (rejectedCode) failureCode = "upload_rejected";
        await mutateData(data => {
          const current = data.candidates.find(item => item.id === candidateId);
          if (!current?.lifecycleV11?.c2UploadDraft) throw httpError(409, "上传失败且原登记已变化，需要核对本地文件", { code: "c2_upload_receipt_conflict" });
          current.lifecycleV11.c2UploadDraft = settleC2Upload(current.lifecycleV11.c2UploadDraft, { uploadId, failureCode, rejectedCode, settledAt: now() });
          return null;
        });
        throw error;
      }
      const draft = await mutateData(data => {
        const current = data.candidates.find(item => item.id === candidateId);
        if (!current?.lifecycleV11?.c2UploadDraft) throw httpError(409, "文件已保存但上传登记已变化，需要核对", { code: "c2_upload_receipt_conflict" });
        current.lifecycleV11.c2UploadDraft = settleC2Upload(current.lifecycleV11.c2UploadDraft, { uploadId, asset, settledAt: now() });
        return structuredClone(current.lifecycleV11.c2UploadDraft);
      });
      return json(res, 201, { candidateId, dataRevision, asset, draft, businessPhaseChanged: false, platformWrites: 0 });
    } finally { c2UploadInProgress = false; }
  }
  if (req.method === "POST" && genericC2FinalAssetsRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "C2素材确认必须提供当前数据修订号");
    if (input.confirmed !== true) throw httpError(400, "必须由主人明确确认当前SKU的最终素材清单和顺序");
    if (!Array.isArray(input.finalUploadAssets) || input.finalUploadAssets.length === 0) {
      throw httpError(400, "必须提供当前SKU的最终上传素材");
    }
    if (!Array.isArray(input.approvedAssetIds) || input.approvedAssetIds.length === 0) {
      throw httpError(400, "必须提供主人确认的素材ID顺序");
    }
    const confirmationSnapshot = await readData();
    const confirmationCandidate = confirmationSnapshot.candidates.find((item) => item.id === genericC2FinalAssetsRoute[1]);
    if (!confirmationCandidate) throw httpError(404, "候选不存在");
    if (Number(confirmationCandidate.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认素材");
    const verifiedFinalUploadAssets = await verifyAndAuthorizeStagedC2Assets({
      candidate: confirmationCandidate,
      dataRevision: input.dataRevision,
      draftRevision: input.draftRevision,
      assets: input.finalUploadAssets
    });
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === genericC2FinalAssetsRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认素材");
      assertCurrentC2UploadDraft(current, { dataRevision: input.dataRevision, draftRevision: input.draftRevision });
      const skuPackage = current.lifecycleV11?.skuPackage;
      if (!skuPackage) throw httpError(409, "当前商品缺少新版SKU生命周期包");
      if (skuPackage.productionAuthorization || skuPackage.productionRecord) {
        throw httpError(409, "当前SKU已经生产授权或执行，不能覆盖素材");
      }
      const timestamp = now();
      let result;
      try {
        const manifest = prepareC2FinalUploadManifest({
          skuPackage,
          expectedDataRevision: skuPackage.dataRevision,
          finalUploadAssets: verifiedFinalUploadAssets,
          preparedAt: timestamp
        });
        if (JSON.stringify(input.approvedAssetIds) !== JSON.stringify(manifest.approvedAssetIds)) {
          throw new Error("C2_SOFTWARE_OWNER_CONFIRMATION_REQUIRED: 主人确认的素材ID及顺序必须与冻结清单完全一致");
        }
        if (input.approvedMainImageAssetId !== manifest.mainImageAssetId || input.approvedVideoDisposition !== manifest.videoDisposition) {
          throw new Error("C2_SOFTWARE_OWNER_CONFIRMATION_REQUIRED: 主人必须明确确认清单首图与视频处置");
        }
        const confirmed = confirmC2SoftwareFinalUploads({
          skuPackage,
          expectedDataRevision: skuPackage.dataRevision,
          finalManifest: manifest,
          ownerDecision: {
            status: "confirmed",
            confirmedBy: "owner",
            approvedManifestVersion: manifest.schemaVersion,
            approvedManifestSha256: manifest.manifestSha256,
            approvedAssetIds: manifest.approvedAssetIds,
            approvedAuthorizedMediaFingerprint: manifest.authorizedMediaFingerprint,
            approvedMainImageAssetId: input.approvedMainImageAssetId,
            approvedVideoDisposition: input.approvedVideoDisposition,
            confirmationNote: input.confirmationNote || null
          },
          confirmedAt: timestamp
        });
        const card = createFinalProductPlanConfirmationCard({
          skuPackage: confirmed.skuPackage,
          createdAt: timestamp
        });
        assertSiblingSkuFinalCard({ ...current, lifecycleV11: { ...current.lifecycleV11, skuPackage: card.skuPackage } });
        result = {
          skuPackage: card.skuPackage,
          confirmationCard: card.confirmationCard,
          finalManifest: manifest
        };
      } catch (error) {
        throw httpError(422, error.message);
      }
      current.lifecycleV11 = {
        ...current.lifecycleV11,
        status: "awaiting_owner_business_confirmation",
        skuPackage: structuredClone(result.skuPackage),
        platformWrites: 0
      };
      current.listingPreparation = {
        ...(current.listingPreparation || {}),
        status: "awaiting_owner_business_confirmation",
        reason: "C2最终素材已按主人确认顺序锁定，最终商品方案卡已生成；尚未生产授权。",
        decisionItems: ["审核最终商品方案卡并决定通过、退回C阶段或淘汰"],
        writeOccurred: false,
        platformWrites: 0
      };
      current.listingHandoff = {
        ...(current.listingHandoff || {}),
        state: "needs_decision",
        owner: "listing_task",
        runId: null,
        currentStep: "C1+C2完成，等待主人审核最终商品方案卡",
        blockReason: null,
        userAction: "请核对精确SKU、利润、事实、SEO、风险和最终素材后决定是否进入生产授权。",
        decisionItems: ["通过进入生产授权", "退回C阶段修改", "淘汰商品"]
      };
      current.processing = { ...queuedProcessing(current.processing), state: "idle" };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      const runtime = current.executionRuntime || createSoftwareExecutionRuntime({
        candidateId: current.id, dataRevision: input.dataRevision, businessPhase: "C2", at: timestamp
      });
      if (runtime.candidateId !== current.id) throw httpError(409, "执行记录与当前商品不一致，请先核对原记录");
      current.executionRuntime = waitForOwner({ ...runtime, businessPhase: "C2", dataRevision: current.dataRevision }, {
        stepId: "C2_OWNER_BUSINESS_CONFIRMATION", inputRevision: current.dataRevision, at: timestamp,
        detail: "最终素材与商品方案卡已保存，等待主人确认准确生产范围"
      });
      addHistory(current, "user", "c2SoftwareFinalAssetsConfirmed", `主人确认${result.confirmationCard.c2Assets.finalUploads.length}个最终素材及清单指纹${result.finalManifest.manifestSha256}；已生成通用确认卡；未创建生产授权，零平台写入`, timestamp);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }
  if (req.method === "POST" && realDAssetTransportRoute) {
    const input = await requestBody(req);
    const currentSnapshot = await readData();
    const savedCandidate = currentSnapshot.candidates.find(item => item.id === realDAssetTransportRoute[1]);
    if (savedCandidate?.lifecycleV11?.skuPackage?.dHandoff?.schemaVersion === "c2-d-handoff-v2" ||
        currentSnapshot.runtime?.softwareJobs?.some(job => job.jobType === "d_production_execution" && job.candidateId === savedCandidate?.id)) {
      throw httpError(409, "素材传输属于已保存的生产任务，请查看该任务的当前进展");
    }
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "OSS素材准备必须提供当前数据修订号");
    if (input.confirmed !== true) throw httpError(400, "必须由主人明确确认当前授权素材执行一次OSS准备");
    if (!input.authorizationId || !Array.isArray(input.finalUploadAssetIds) || input.finalUploadAssetIds.length === 0) {
      throw httpError(400, "必须锁定当前生产授权和完整最终素材顺序");
    }

    const persisted = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === realDAssetTransportRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，请刷新后重新确认OSS素材准备");
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务正在等待或运行");
      const skuPackage = current.lifecycleV11?.skuPackage;
      if (!skuPackage?.productionAuthorization || skuPackage.productionRecord) throw httpError(409, "当前SKU缺少有效生产授权或已经生产");
      if (skuPackage.dAssetTransport?.assetTransport?.status === "verified") throw httpError(409, "当前授权素材已经取得OSS稳定地址，禁止重复上传");
      if (["in_flight", "unknown_outcome"].includes(skuPackage.dAssetTransport?.intent?.status)) {
        throw httpError(409, "当前授权素材已有执行中或结果未知的OSS记录，禁止重复上传");
      }
      const timestamp = now();
      let intent;
      try {
        assertCurrentProductionExecutionBinding({ productionAuthorization: skuPackage.productionAuthorization,
          currentProductionBinding: currentProductionBinding(current), checkedAt: timestamp });
        intent = createPersistableAliyunOssAssetIntent({
          candidate: current,
          expectedDataRevision: input.dataRevision,
          ownerDecision: {
            confirmed: true,
            confirmedBy: "owner",
            authorizationId: input.authorizationId,
            skuPackageId: skuPackage.skuPackageId,
            finalUploadAssetIds: input.finalUploadAssetIds
          },
          startedAt: timestamp
        });
      } catch (error) {
        throw httpError(422, error.message);
      }
      const persistedCandidateRevision = Number(current.dataRevision) + 1;
      const persistedIntent = markAliyunOssAssetIntentPersisted({
        intent,
        persistedAt: timestamp,
        persistedCandidateRevision
      });
      skuPackage.dAssetTransport = {
        schemaVersion: "aliyun-oss-d-asset-state-v1",
        status: "in_flight",
        executionRevision: 1,
        intent: structuredClone(persistedIntent),
        assetTransport: null,
        automaticRetry: false,
        platformWrites: 0
      };
      current.dataRevision = persistedCandidateRevision;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(current, "system", "ossAssetTransportIntentPersisted", `已持久化当前授权${input.finalUploadAssetIds.length}个最终素材的一次OSS传输意图；尚未写Ozon`, timestamp);
      return { candidate: structuredClone(current), intent: structuredClone(persistedIntent) };
    });

    const result = await executeAliyunOssAssetIntent({
      persistedIntent: persisted.intent,
      candidate: persisted.candidate,
      currentProductionBinding: currentProductionBinding(persisted.candidate),
      resolveLocalAsset: asset => c2LocalAssetStore.read(resolveRegisteredC2FinalAsset(persisted.candidate, asset), { verifyContent: true }),
      serverClock: now
    });

    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === realDAssetTransportRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      const timestamp = now();
      const settled = settleAliyunOssAssetIntent({ candidate: current, persistedIntent: persisted.intent, result, settledAt: timestamp });
      current.lifecycleV11.skuPackage.dAssetTransport = settled.lifecycleV11.skuPackage.dAssetTransport;
      current.dataRevision = Number(current.dataRevision) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "system";
      addHistory(
        current,
        "system",
        result.status === "verified" ? "ossAssetTransportVerified"
          : result.status === "failed" ? "ossAssetTransportNotAttempted" : "ossAssetTransportUnknownOutcome",
        result.status === "verified"
          ? `当前授权${result.assetTransport.resolvedAssets.length}个最终素材已取得稳定HTTPS地址；Ozon写入仍为0`
          : result.status === "failed"
            ? "OSS素材执行条件检查未通过，本轮未发起上传；Ozon写入仍为0"
            : "OSS素材传输结果未知，已停止且禁止自动重试；Ozon写入仍为0",
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, result.status === "verified" ? 200 : result.status === "failed" ? 422 : 502,
      { candidate, assetTransportStatus: result.status });
  }
  if (req.method === "POST" && (realProductionAuthorizationPriceRepairRoute || realProductionAuthorizationRevisionRoute)) {
    await requestBody(req);
    return json(res, 410, {
      message: "ProductionAuthorization不可变；修订或价格修复必须由后续独立版本化批次设计，当前不覆盖原授权。",
      externalRequests: 0,
      platformWrites: 0
    });
  }
  if (req.method === "GET" && productionOwnerPreparationRoute) {
    const data = await readData();
    const candidate = data.candidates.find(item => item.id === productionOwnerPreparationRoute[1]);
    if (!candidate) throw httpError(404, "候选不存在");
    return json(res, 200, buildProductionOwnerPreparationView({
      candidate, configuration: runtimeConfiguration, evidencePacks: data.evidencePacks,
      currentCommissionCatalogs: data.currentCommissionCatalogs, observedAt: now()
    }));
  }
  const preparationRoute=pathname.match(/^\/api\/sibling-batches\/([^/]+)\/(preparation|preparation-draft|preparation-assets\/([^/]+))$/);
  if(preparationRoute && ['GET','POST'].includes(req.method)) {
    const actor=runtimeIdentityProvider.resolveActor({request:req});
    if(actor.source!=='authenticated_identity_provider' || actor.actorType!=='human' || !actor.roles.includes('owner'))throw httpError(403,'请先登录主人身份读取或保存整批草稿');
    const origin=String(req.headers.origin||'');
    if(origin && !allowedReviewOrigins.has(origin))throw httpError(403,'整批草稿拒绝其他网页来源');
    const parentId=decodeURIComponent(preparationRoute[1]);
    const reader=createLocalSiblingCatalogReader({directory:process.env.SELECTION_REVIEW_BATCH_CATALOG_DIRECTORY || fileURLToPath(new URL('./lib/batch-catalogs/s1-v4-2/',import.meta.url))});
    const catalog=await reader.readCatalog();
    const document=req.method==='GET'?await readData():null;
    if(req.method==='GET' && preparationRoute[2]==='preparation') {
      const parent=document.candidates.find(c=>c.id===parentId);
      if(parent?.sourceCapture?.offerId!==catalog.offerId)return json(res,200,{configured:false});
    }
    try {
      if(req.method==='GET') preparationFamily(document,parentId,catalog);
      if(req.method==='GET' && preparationRoute[2]==='preparation') {
        const draft=(document.runtime.siblingPreparationDrafts??[]).filter(r=>r.parentCandidateId===parentId).at(-1)??null;
        const family = preparationFamily(document,parentId,catalog);
        return json(res,200,{configured:true,catalog,draft,supplyPreparation:siblingSupplyPreparation(family.parent,family.members),externalRequests:0,platformWrites:0});
      }
      if(req.method==='GET' && preparationRoute[3]) {
        const result=await reader.readAsset(catalog,decodeURIComponent(preparationRoute[3]));
        res.writeHead(200,{'Content-Type':result.contentType,'Content-Length':result.body.length,'Cache-Control':'no-store'});res.end(result.body);return;
      }
      if(req.method==='POST' && preparationRoute[2]==='preparation-draft') {
        const input=await readJsonRequestBody(req,{maxBytes:65536,requireJsonContentType:true});
        if(input?.parentCandidateId!==parentId)throw new Error('SIBLING_PREPARATION_INPUT_INVALID');
        return json(res,200,await saveSiblingPreparationDraft({repository:businessStateRepository,runtimeMode:runtimeConfiguration.deploymentMode,actor,input,catalog,serverClock:now}));
      }
      throw httpError(405,'该草稿动作不支持此请求方式');
    }catch(error){
      const code=String(error.code||error.message).split(':',1)[0];
      if(/^(SIBLING_PREPARATION_|SIBLING_CATALOG_)/.test(code))return json(res,/CHANGED|CONFLICT|FROZEN/.test(code)?409:422,{code,message:code==='SIBLING_PREPARATION_MEMBERS_CHANGED'?'本批规格的平台、店铺、采集或成员身份不一致；不能读取或确认。当前输入保留，不退回重复供货表单。':'本批草稿、来源或版本不匹配；未推进阶段、未写店铺。请核对当前保存版本。',externalRequests:0,platformWrites:0});
      throw error;
    }
  }
  if (req.method === 'POST' && pathname === '/api/sibling-batches/commercial-drafts') {
    const origin = String(req.headers.origin || '');
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, '批量经营草稿拒绝其他网页来源');
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份保存本批库存');
    }
    const input = await readJsonRequestBody(req, { maxBytes: 65536, requireJsonContentType: true });
    try {
      const result = await saveSiblingBatchCommercialDrafts({ repository: businessStateRepository,
        runtimeMode: runtimeConfiguration.deploymentMode, actor, input, serverClock: now });
      return json(res, 200, result);
    } catch (error) {
      const code = String(error.code || error.message).split(':', 1)[0];
      if (/^(?:SIBLING_BATCH_COMMERCIAL_|PRODUCTION_COMMERCIAL_DRAFT_|RUNTIME_OPERATION_)/.test(code)) {
        return json(res, /CHANGED|CONFLICT/.test(code) ? 409 : 422,
          { code, message: '本批库存草稿未保存；请刷新清单后核对每个规格。', externalRequests: 0, platformWrites: 0 });
      }
      throw error;
    }
  }
  const siblingExecutionRoute = pathname.match(/^\/api\/sibling-batches\/([^/]+)\/execution$/);
  if (req.method === 'GET' && siblingExecutionRoute) {
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份查看本批执行结果');
    }
    let parentId;
    try { parentId = decodeURIComponent(siblingExecutionRoute[1]); }
    catch { throw httpError(400, '批次来源身份无效'); }
    const saved = await readData();
    const parent = saved.candidates.find(candidate => candidate.id === parentId);
    if (!parent) throw httpError(404, '批次来源不存在');
    const selected = parent.sourceCapture?.selectedSkuIds?.filter(id => id !== parent.lifecycleV11?.skuPackage?.supplierSkuId);
    if (!Array.isArray(selected) || selected.length === 0) return json(res, 200, { executionView: null });
    const siblingBySkuId = new Map();
    for (const candidate of saved.candidates) {
      if (candidate.siblingSourceV1?.parentCandidateId !== parentId) continue;
      const id = candidate.siblingSourceV1.supplierSkuId;
      const matches = siblingBySkuId.get(id) ?? [];
      matches.push(candidate);
      siblingBySkuId.set(id, matches);
    }
    const children = selected.map(id => siblingBySkuId.get(id) ?? []);
    if (children.some(matches => matches.length !== 1)) return json(res, 200, { executionView: null });
    const ids = children.map(matches => matches[0].id);
    const matches = (saved.runtime?.dProductionBatches ?? []).filter(batch =>
      batch.members.length === ids.length && batch.members.every((member, index) => member.candidateId === ids[index]));
    if (matches.length > 1) throw httpError(409, '本批执行记录不唯一，需要人工核对');
    return json(res, 200, { executionView: matches.length === 1 ? projectDBatchExecutionView(saved, matches[0].batchId) : null });
  }
  const batchExecutionRoute=pathname.match(/^\/api\/d-batches\/([^/]+)$/);
  if(req.method==='GET'&&batchExecutionRoute){
    const actor=runtimeIdentityProvider.resolveActor({request:req});
    if(actor.source!=='authenticated_identity_provider'||actor.actorType!=='human'||
        !actor.roles.includes('owner'))throw httpError(403,'请先登录主人身份查看生产批次');
    let batchId;
    try{batchId=decodeURIComponent(batchExecutionRoute[1]);}
    catch{throw httpError(400,'生产批次身份无效');}
    if(!/^d-batch:[A-Za-z0-9:_-]{1,180}$/.test(batchId))throw httpError(400,'生产批次身份无效');
    const saved=await readData();
    try{return json(res,200,projectDBatchExecutionView(saved,batchId));}
    catch(error){if(error.message==='D_BATCH_VIEW_BATCH_NOT_FOUND')throw httpError(404,'生产批次不存在');
      throw error;}
  }
  const batchResumeRoute=pathname.match(/^\/api\/d-batches\/([^/]+)\/resume$/);
  if(req.method==='POST'&&batchResumeRoute){
    const origin=String(req.headers.origin||'');
    if(origin&&!allowedReviewOrigins.has(origin))throw httpError(403,'生产批次拒绝其他网页来源');
    const actor=runtimeIdentityProvider.resolveActor({request:req});
    if(actor.source!=='authenticated_identity_provider'||actor.actorType!=='human'||
        !actor.roles.includes('owner'))throw httpError(403,'请先登录主人身份恢复未发出的库存续作');
    let batchId;
    try{batchId=decodeURIComponent(batchResumeRoute[1]);}
    catch{throw httpError(400,'生产批次身份无效');}
    if(!/^d-batch:[A-Za-z0-9:_-]{1,180}$/.test(batchId))throw httpError(400,'生产批次身份无效');
    const input=await readJsonRequestBody(req,{maxBytes:1024,requireJsonContentType:true});
    if(!input||Object.keys(input).length!==1||input.confirmUnsentStockContinuation!==true)
      throw httpError(400,'必须明确确认只恢复未发出的库存续作');
    try{
      const continuation=await deRuntimeServices.resumeAuthorizedBatchContinuations({batchId});
      return json(res,200,{continuation,
        executionView:projectDBatchExecutionView(await readData(),batchId)});
    }catch(error){
      const code=String(error.code||error.message).split(':',1)[0];
      if(/^(?:D_BATCH_SERVICE_|DE_RUNTIME_UNAVAILABLE_BATCH_IMPORT)/.test(code))
        return json(res,/NOTHING_UNSENT|SCOPE_INVALID/.test(code)?409:422,
          {code,message:'仅能恢复当前批次明确未发出的库存续作；请查看逐项结果。',
            externalRequests:0,platformWrites:0});
      throw error;
    }
  }
  if (req.method === 'POST' && pathname === '/api/d-batches/authorize') {
    const origin = String(req.headers.origin || '');
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, '生产批次拒绝其他网页来源');
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后确认整批准确范围');
    }
    const input = await readJsonRequestBody(req, { maxBytes: 65536, requireJsonContentType: true });
    let batch;
    try {
      batch = await commitBatchOwnerProductionAuthorization({ repository: businessStateRepository,
        runtimeMode: runtimeConfiguration.deploymentMode, actor, input,
        configuration: runtimeConfiguration, serverClock: now });
    } catch (error) {
      if (error instanceof ExactCommissionRequiredForProductionError) {
        return json(res, 422, { code: error.code, ownerNextStep: error.ownerNextStep,
          message: '批次中有规格仍需使用精确佣金完成正式利润复算；整批授权未保存。',
          externalRequests: 0, platformWrites: 0 });
      }
      if (error instanceof ProductionOwnerPreparationError) {
        return json(res, /CHANGED|EXPIRED/.test(error.code) ? 409 : 422,
          { code: error.code, message: error.message, externalRequests: 0, platformWrites: 0 });
      }
      const code = String(error.code || error.message).split(':', 1)[0];
      if (/^(?:D_BATCH|SIBLING_PREPARATION|PRODUCTION_OWNER|PRODUCTION_AUTHORIZATION|BUSINESS_MUTATION|RUNTIME_OPERATION)_[A-Z_]+$/.test(code)) {
        const status = code === 'D_BATCH_AUTHORIZATION_INPUT_INVALID' ? 400 :
          /FORBIDDEN|AUTHENTICATED|AUTHORIZER/.test(code) ? 403 :
          /NOT_FOUND/.test(code) ? 404 : /CONFLICT|DRIFT|GATE_REJECTED|ALREADY_STARTED|RESERVED/.test(code) ? 409 : 422;
        return json(res, status,
          { code, gaps:error.gaps??[], message: '批次授权未保存；请刷新规格清单并核对每项资料与历史任务。', externalRequests: 0, platformWrites: 0 });
      }
      throw error;
    }
    let execution;
    try {
      execution = await deRuntimeServices.continueAuthorizedBatchImport({ batchId: batch.batchId });
    } catch (error) {
      const code = String(error.code || error.message).split(':', 1)[0];
      if (!/^(?:D_BATCH_SERVICE_|DE_RUNTIME_UNAVAILABLE_BATCH_IMPORT)/.test(code)) throw error;
      const saved = await readData();
      const job = saved.runtime?.dBatchImportJobs?.find(value => value.batchId === batch.batchId);
      if (job?.chunks.some(chunk => chunk.status !== 'not_sent')) throw error;
      const current = saved.runtime?.dProductionBatches?.find(value => value.batchId === batch.batchId);
      return json(res, 200, { batch: current ?? batch,
        executionView:projectDBatchExecutionView(saved,batch.batchId),executionStatus: 'prewrite_blocked',
        reasonCode: code, externalRequests: 0, platformWrites: 0 });
    }
    const saved = await readData();
    return json(res, 200, { batch: saved.runtime?.dProductionBatches?.find(value => value.batchId === batch.batchId) ?? batch,
      executionView:projectDBatchExecutionView(saved,batch.batchId),
      executionStatus: execution.status, job: execution.job });
  }
  if (req.method === "POST" && (realProductionOwnerDecisionRoute || realProductionAuthorizationRoute)) {
    const input = await requestBody(req);
    if (input?.contractVersion !== PRODUCTION_AUTHORIZATION_VERSION) {
      return json(res, 409, { code: "production_authorization_reconfirmation_required",
        message: "生产确认方式已更新，请刷新最终确认卡并重新核对本件商品的准确范围。旧商业意见不会自动成为新授权。",
        externalRequests: 0, platformWrites: 0 });
    }
    const allowed = ["contractVersion", "dataRevision", "skuRevision", "cardId", "cardRevision",
      "sourcePreparationFingerprint", "sourceFinalCardInputFingerprint", "bindingId", "configurationVersion", "merchantSku", "confirmExactScope"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== allowed.length ||
        allowed.some(field => !Object.hasOwn(input, field)) || !Number.isInteger(input.dataRevision) || !Number.isInteger(input.cardRevision)) {
      throw httpError(400, "确认请求字段不完整或包含未经允许的字段");
    }
    const candidateId = (realProductionOwnerDecisionRoute || realProductionAuthorizationRoute)[1];
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== "authenticated_identity_provider" || actor.actorType !== "human") {
      return json(res, 503, { message: "正式主人身份来源尚未接通，当前不能保存生产授权。", code: "production_identity_unavailable", externalRequests: 0, platformWrites: 0 });
    }
    let transaction;
    try {
      transaction = await commitSingleOwnerProductionAuthorization({ repository: businessStateRepository,
        runtimeMode: runtimeConfiguration.deploymentMode, actor, candidateId, input, serverClock: now,
        resolveProductionAuthorizationDecision: context => resolveProductionOwnerPreparation({
          ...context, configuration: runtimeConfiguration
        }) });
    } catch (error) {
      // 钱的闸门。佣金还是估算的时候这一次授权没有落盘，原利润结论也没变——主人要做的就一件事：先复算。
      // 页面认的是 code 和 ownerNextStep 这两个 ASCII 标记，不靠下面那句中文。
      if (error instanceof ExactCommissionRequiredForProductionError) {
        return json(res, 422, { code: error.code, ownerNextStep: error.ownerNextStep,
          commissionMode: error.commissionMode, exactCommissionRequiredForProduction: true,
          message: "这件商品的平台佣金还是估算的，所以现在的利润结论只是条件测算，不能提交上架。" +
            "请先在这件商品上做一次「使用精确费用复算」，软件会用平台实际收的那个费率把利润重算一遍；" +
            "正式 B 通过之后再提交生产授权。本次没有保存任何授权，也没有往平台写任何东西。",
          externalRequests: 0, platformWrites: 0 });
      }
      if (error instanceof ProductionOwnerPreparationError) {
        const status = /CHANGED|EXPIRED/.test(error.code) ? 409 : /NOT_CONFIGURED/.test(error.code) ? 503 : 422;
        return json(res, status, { code: error.code, message: error.message, externalRequests: 0, platformWrites: 0 });
      }
      const code = String(error.code || error.message).split(":", 1)[0];
      if (!/^(?:PRODUCTION_OWNER|PRODUCTION_AUTHORIZATION|BUSINESS_MUTATION|RUNTIME_OPERATION)_[A-Z_]{1,100}$/.test(code)) {
        throw Object.assign(httpError(500, "生产确认保存失败，须核对当前保存记录"), {
          failureCode: /^[A-Z][A-Z0-9_]{1,100}$/.test(code) ? code : "UNCLASSIFIED_FAILURE"
        });
      }
      const status = /FORBIDDEN|AUTHENTICATED|AUTHORIZER/.test(code) ? 403 : /NOT_FOUND/.test(code) ? 404 : /CONFLICT|DRIFT|GATE_REJECTED/.test(code) ? 409 : 422;
      throw httpError(status, `生产确认未保存：${code}`);
    }
    let executionStatus = "not_started";
    if (transaction.status === "committed" && transaction.result.softwareJobCreated === true) {
      try {
        const execution = await ozonAccountReadServices.continueProduction({ candidateId,
          expectedRevision: transaction.candidate.dataRevision, jobId: transaction.result.softwareJobRef.jobId });
        executionStatus = execution.status;
      } catch (error) {
        if (!(error instanceof DERuntimeUnavailableError)) throw error;
        executionStatus = "not_configured";
      }
    }
    let data;
    try { data = await readData(); }
    catch { throw httpError(500, "生产确认保存结果待核对，当前未取得独立回读"); }
    const committed = data.candidates.find(item => item.id === candidateId);
    if (!committed) throw httpError(500, "生产确认保存结果待核对，当前商品独立回读缺失");
    const sku = committed.lifecycleV11?.skuPackage;
    const job = data.runtime?.softwareJobs?.find(item => item.jobId === transaction.result.softwareJobRef?.jobId);
    return json(res, 200, {
      status: transaction.status, executionStatus, candidate: publicSavedDECandidate(committed, data),
      productionAuthorization: transaction.result.productionAuthorization, dHandoff: transaction.result.dHandoff,
      productionPlanCreated: Boolean(sku?.dAssetTransport || sku?.dSoftwareExecution || job?.preparationEvidence),
      executionIntentCreated: Boolean(sku?.dAssetTransport || sku?.dSoftwareExecution),
      softwareJobCreated: transaction.result.softwareJobCreated,
      softwareJobRef: transaction.result.softwareJobRef ?? null,
      dWritePermissionGranted: false, externalRequests: job?.externalRequestState === "not_sent" ? 0 : job?.attempt === 1 ? "unknown" : 0,
      platformWrites: sku?.dSoftwareExecution?.platformWrites ?? 0
    });
  }
  if (req.method === "POST" && legacyFireTrainFinalAssetsRoute) {
    throw httpError(410, "历史火车素材入口已退役；请使用当前SKU的正式C2素材流程");
  }
  if (req.method === "POST" && legacyFireTrainC1Route) {
    throw httpError(410, "历史火车C1入口已退役；正式C1必须使用已准入且已保存的provider回执");
  }

  if (req.method === "POST" && listingPreparationReviewRoute) {
    const input = normalizeListingPreparationReviewInput(await requestBody(req));
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === listingPreparationReviewRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (isTrustedInternalApiRequest(req.headers, internalApiRequestToken)) assertCurrentMaintenanceWrite(data, current.id, input.runId);
      if (current.workflowStatus !== "listing_preparation") throw httpError(409, "只有待上架准备商品可以回写C阶段");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "商品资料已变化，旧C阶段结果不得覆盖新数据");
      if (input.runId && current.listingHandoff?.runId && current.listingHandoff.runId !== input.runId) {
        throw httpError(409, "C阶段runId与当前上架准备任务不一致");
      }
      const timestamp = now();
      if (Object.keys(input.candidateData).length) {
        const inheritedFields = listingPreparationInheritedFields();
        const conflictingField = inheritedFields.find((field) =>
          Object.hasOwn(input.candidateData, field) &&
          JSON.stringify(input.candidateData[field]) !== JSON.stringify(current[field])
        );
        if (conflictingField) {
          throw httpError(422, `C阶段发现前期继承字段冲突：${conflictingField}；不得静默覆盖，请返回needs_decision让主人确认`);
        }
        for (const field of listingPreparationCStageFields()) {
          if (Object.hasOwn(input.candidateData, field)) current[field] = input.candidateData[field];
        }
      }
      const evidencePackIds = input.evidencePackIds;
      const unknownPack = evidencePackIds.find((id) => !(data.evidencePacks || []).some((pack) => pack.id === id && pack.status === "active"));
      if (unknownPack) throw httpError(422, `共享证据包不存在或已失效：${unknownPack}`);
      if (input.status === "prepared") {
        const expectedOfferId = extract1688OfferId(current.sourceUrl);
        if (expectedOfferId) {
          if (current.sourceCapture?.status !== "verified") {
            throw httpError(422, "精确1688链接尚无已校验采集结果，C阶段不能通过");
          }
          if (input.sourceCaptureId !== current.sourceCapture.captureId) {
            throw httpError(422, "C阶段结果没有带回当前1688采集编号，不能通过");
          }
        }
        const preparation = input.preparation;
        const missing = ["exactSourceSku", "category", "schemaEvidence", "finalPrice"].filter((field) => !String(preparation[field] || "").trim());
        if (missing.length || !Array.isArray(preparation.assets) || !preparation.assets.filter((item) => String(item).trim()).length) {
          throw httpError(422, "C阶段通过必须包含精确货源SKU、类目、Schema证据、最终价格和素材清单");
        }
        const gate = approvalGate(current, data.rules);
        if (!gate.passed) throw httpError(422, "C阶段尚未满足可上架门槛", { blockers: gate.blockers });
        current.workflowStatus = "ready_to_list";
        current.readyAt = timestamp;
        current.cCompletedAt = timestamp;
        current.defaultStock = 100;
        current.evidencePackIds = evidencePackIds;
        current.listingPreparation = {
          ...(current.listingPreparation || {}),
          ...preparation,
          status: "prepared",
          defaultStock: 100,
          evidencePackIds,
          sourceCaptureId: current.sourceCapture?.captureId || null,
          completedAt: timestamp
        };
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: "prepared",
          owner: "listing_task",
          runId: null,
          currentStep: "C阶段完成，等待主人确认并开始上架",
          preparedAt: timestamp,
          defaultStock: 100,
          blockReason: null
        };
        addHistory(current, "listing_task", "listingPreparationCompleted", "上架任务已完成C阶段；库存100仅为待确认默认值，尚未写店", timestamp);
      } else {
        const reason = input.reason;
        const decisionItems = input.decisionItems;
        const userAction = input.userAction || (
          input.status === "needs_decision"
            ? "请确认页面列出的必要事实；确认前不会重新采集或继续上架"
            : "本次已停止；只有主人明确选择后才会再次执行"
        );
        current.listingPreparation = {
          ...(current.listingPreparation || {}),
          status: input.status,
          evidencePackIds,
          decisionItems,
          stoppedAt: timestamp,
          failureLayer: input.failureLayer,
          reason,
          writeOccurred: input.writeOccurred === true
        };
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: input.status === "needs_decision" ? "needs_decision" : "blocked",
          runId: null,
          currentStep: input.status === "needs_decision" ? "C阶段只读核验完成，等待主人确认必要事实" : "C阶段已停止",
          blockReason: reason,
          userAction,
          decisionItems,
          stoppedAt: timestamp
        };
        addHistory(current, "listing_task", "listingPreparationStopped", `C阶段已停止：${reason}；系统不会自动重试`, timestamp);
      }
      current.processing = { ...queuedProcessing(current.processing), state: "idle" };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "listing_task";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && productionAuthorizationRoute) {
    return json(res, 410, {
      message: "旧生产确认入口已永久停用；只能使用绑定C2冻结快照的生命周期原子授权接口。",
      dispatchesCreated: 0,
      externalRequests: 0,
      platformWrites: 0
    });
  }

  const dispatchClaimRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/claim$/);
  if (req.method === "POST" && dispatchClaimRoute) {
    const input = await requestBody(req);
    if (!explicitDispatchDeliveryEnabled) throw httpError(409, LEGACY_DISPATCH_CHANNEL_DISABLED);
    if (!input.runId?.trim() || !input.currentStep?.trim()) {
      throw httpError(400, "领取一次性派发必须提供runId和当前真实步骤");
    }
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchClaimRoute[1]);
      if (!dispatch) throw httpError(404, "一次性派发不存在");
      if (isDisabledLegacyCDispatch(dispatch)) {
        throw httpError(409, "旧C阶段派发只保留为历史记录，不能领取");
      }
      if (!["received", "permission_required"].includes(dispatch.status)) {
        throw httpError(409, "该派发尚未被目标任务接收或已经结束");
      }
      const timestamp = now();
      dispatch.status = "running";
      dispatch.runId = input.runId.trim();
      dispatch.currentStep = input.currentStep.trim();
      dispatch.startedAt = timestamp;
      dispatch.lastProgressAt = timestamp;
      dispatch.lastEventAt = timestamp;
      dispatch.pendingApproval = null;
      let candidate = null;
      if (dispatch.candidateId) {
        candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
        if (!candidate) throw httpError(404, "派发对应商品不存在");
        if (Number(candidate.dataRevision) !== Number(dispatch.dataRevision)) {
          throw httpError(409, "商品资料已变化，本次派发失效");
        }
        if (["listing_preparation", "ready_to_list"].includes(candidate.workflowStatus)) {
          if (candidate.listingHandoff?.runId && candidate.listingHandoff.runId !== dispatch.runId) {
            throw httpError(409, "同一SKU已有另一个负责人正在运行");
          }
          candidate.listingHandoff = {
            ...(candidate.listingHandoff || {}),
            state: "running",
            runId: dispatch.runId,
            startedAt: timestamp,
            currentStep: dispatch.currentStep,
            lastProgressAt: timestamp
          };
        } else {
          if (candidate.processing?.state === "running" && candidate.processing?.runId !== dispatch.runId) {
            throw httpError(409, "同一SKU已有另一个负责人正在运行");
          }
          candidate.processing = {
            ...queuedProcessing(candidate.processing),
            state: "running",
            runId: dispatch.runId,
            startedAt: timestamp,
            currentStep: dispatch.currentStep,
            lastProgressAt: timestamp,
            claimRevision: candidate.dataRevision,
            dispatchState: "claimed",
            manualHold: false,
            attempts: Number(candidate.processing?.attempts || 0) + 1,
            progressEvents: []
          };
        }
        candidate.updatedAt = timestamp;
        candidate.lastModifiedBy = dispatch.assigneeRole;
        addHistory(candidate, "codex", "oneShotClaimed", `一次性派发${dispatch.id}已开始：${dispatch.currentStep}`, timestamp);
      }
      return { dispatch: dispatchPublic(dispatch), candidate: candidate ? publicCandidate(candidate, data.rules) : null };
    });
    return json(res, 200, result);
  }

  const desktopTurnRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/desktop-turn$/);
  if (req.method === "POST" && desktopTurnRoute) {
    const input = await requestBody(req);
    if (!explicitDispatchDeliveryEnabled) throw httpError(409, LEGACY_DISPATCH_CHANNEL_DISABLED);
    if (!input.turnId?.trim() || !Number.isInteger(input.dataRevision)) {
      throw httpError(400, "接管Codex桌面端运行必须提供真实运行编号和当前修订号");
    }
    const snapshot = await readData();
    const original = snapshot.dispatches.find((item) => item.id === desktopTurnRoute[1]);
    if (!original) throw httpError(404, "原派发不存在");
    if (!['queued', 'waiting_assignee'].includes(original.status)) {
      throw httpError(409, "原派发已经运行或结束，不能重复接管");
    }
    if (Number(original.dataRevision) !== input.dataRevision) {
      throw httpError(409, "原派发修订号已变化，不能接管旧运行");
    }
    const route = snapshot.taskRoutes[original.assigneeRole];
    await codexDispatcher.verifyDesktopTurn(route, input.turnId.trim(), original.id);
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === desktopTurnRoute[1]);
      const candidate = dispatch?.candidateId
        ? data.candidates.find((item) => item.id === dispatch.candidateId)
        : null;
      if (!dispatch || !candidate) throw httpError(404, "原派发或商品不存在");
      if (!['queued', 'waiting_assignee'].includes(dispatch.status)) {
        throw httpError(409, "原派发已经运行或结束，不能重复接管");
      }
      if (Number(candidate.dataRevision) !== input.dataRevision || Number(dispatch.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已变化，本次运行不能接管");
      }
      const timestamp = now();
      dispatch.status = "running";
      dispatch.turnId = input.turnId.trim();
      dispatch.runId = input.turnId.trim();
      dispatch.deliveryDetail = "负责人任务已由Codex桌面端启动，已核验真实运行编号";
      dispatch.deliveryMode = "codex_desktop_host";
      dispatch.attachedSkills = (dispatch.requiredSkills || []).map((skill) => skill.name).filter(Boolean);
      dispatch.skillsAttachedAt = timestamp;
      dispatch.deliveredAt = timestamp;
      dispatch.startedAt = timestamp;
      dispatch.lastEventAt = timestamp;
      dispatch.failureLayer = "";
      dispatch.error = "";
      candidate.listingHandoff = {
        ...(candidate.listingHandoff || {}),
        state: "running",
        owner: dispatch.assigneeRole,
        runId: dispatch.runId,
        startedAt: timestamp,
        currentStep: dispatch.nodeId === "M07" ? "上架任务已开始C阶段" : "上架负责人任务已启动",
        requiredSkills: dispatch.requiredSkills || [],
        attachedSkills: dispatch.attachedSkills,
        skillsAttachedAt: timestamp,
        sourceCaptureId: dispatch.capabilityPlan?.sourceCapture?.captureId || null
      };
      candidate.updatedAt = timestamp;
      candidate.lastModifiedBy = dispatch.assigneeRole;
      addHistory(candidate, "system", "desktopTurnAdopted", `原派发已核验Codex桌面端真实运行编号：${dispatch.runId}`, timestamp);
      const taskRoute = data.taskRoutes[dispatch.assigneeRole];
      taskRoute.status = "verified";
      taskRoute.verifiedAt = timestamp;
      taskRoute.lastError = "";
      return { candidate: publicCandidate(candidate, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    return json(res, 200, result);
  }

  const dispatchProgressRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/progress$/);
  if (req.method === "POST" && dispatchProgressRoute) {
    if (!isTrustedInternalApiRequest(req.headers, internalApiRequestToken)) {
      throw httpError(403, "实质进展只能由当前受控任务提交", { code: "trusted_progress_required" });
    }
    const input = maintenanceProgressInput(await requestBody(req));
    const result = await mutateData((data) => {
      const dispatch = data.dispatches.find((item) => item.id === dispatchProgressRoute[1]);
      if (!dispatch) throw httpError(404, "一次性派发不存在");
      const candidate = data.candidates.find((item) => item.id === dispatch.candidateId);
      if (!candidate) throw httpError(404, "派发对应商品不存在");
      const active = activeDispatchForCandidate(data, candidate.id);
      if (!active || active.id !== dispatch.id) throw httpError(409, "该派发不是本次正式领取的有效任务");
      applyMaintenanceProgress(candidate, dispatch, input, now());
      return { dispatch: dispatchPublic(dispatch), candidate: publicCandidate(candidate, data.rules) };
    });
    return json(res, 200, result);
  }

  const dispatchCompleteRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/complete$/);
  if (req.method === "POST" && dispatchCompleteRoute) {
    if (!isTrustedInternalApiRequest(req.headers, internalApiRequestToken)) {
      throw httpError(403, "执行结果只能由当前受控任务提交", { code: "trusted_completion_required" });
    }
    const input = maintenanceCompletionInput(await requestBody(req));
    const result = await mutateData(data => completeCurrentMaintenanceDispatch(data, dispatchCompleteRoute[1], input));
    return json(res, 200, result);
  }

  const dispatchApprovalRoute = pathname.match(/^\/api\/dispatches\/([^/]+)\/approval$/);
  if (req.method === "POST" && dispatchApprovalRoute) {
    const input = await requestBody(req);
    if (!explicitDispatchDeliveryEnabled) throw httpError(409, LEGACY_DISPATCH_CHANNEL_DISABLED);
    if (!input.requestId || !["accept", "decline", "cancel"].includes(input.decision)) {
      throw httpError(400, "权限决定必须是允许、拒绝或取消本次");
    }
    const data = await readData();
    const dispatch = data.dispatches.find((item) => item.id === dispatchApprovalRoute[1]);
    if (!dispatch?.pendingApproval || String(dispatch.pendingApproval.requestId) !== String(input.requestId)) {
      throw httpError(409, "权限请求已失效，请刷新");
    }
    try {
      codexDispatcher.resolveApproval(dispatch.id, String(input.requestId), input.decision);
    } catch (error) {
      throw httpError(409, error.message);
    }
    const updated = await mutateData((currentData) => {
      const current = currentData.dispatches.find((item) => item.id === dispatch.id);
      current.pendingApproval = null;
      current.status = input.decision === "accept" ? "running" : "blocked";
      current.permissionDecision = { decision: input.decision, at: now() };
      current.lastEventAt = now();
      return dispatchPublic(current);
    });
    return json(res, 200, { dispatch: updated });
  }

  if (req.method === "GET" && pathname === "/api/control/alerts") {
    const data = await readData();
    const alerts = (data.controlAlerts || []).filter((item) => !item.acknowledgedAt);
    return json(res, 200, { alerts });
  }

  const controlAlertAckRoute = pathname.match(/^\/api\/control\/alerts\/([^/]+)\/ack$/);
  if (req.method === "POST" && controlAlertAckRoute) {
    await requestBody(req);
    const alertId = controlAlertAckRoute[1];
    const alert = await mutateData((data) => {
      const current = (data.controlAlerts || []).find((item) => item.id === alertId);
      if (!current) throw httpError(404, "总控提醒不存在");
      if (!current.acknowledgedAt) current.acknowledgedAt = now();
      return current;
    });
    return json(res, 200, { alert });
  }

  if (req.method === "POST" && pathname === "/api/control/reconcile-stopped") {
    const input = await requestBody(req);
    const map = await readWorkflowMap(workflowMapFile);
    if (input.confirm !== true) {
      const data = await readData();
      const preview = data.candidates
        .filter((item) => item.workflowStatus === "codex_processing")
        .map((candidate) => ({
          candidateId: candidate.id,
          productName: candidate.productName,
          ...classifyStoppedCandidate(candidate, latestDispatchForCandidate(data, candidate.id))
        }));
      return json(res, 200, { policyVersion: RECOVERY_POLICY_VERSION, dryRun: true, preview });
    }
    const dispatchIds = [];
    const result = await mutateData((data) => {
      if (data.meta?.recoveryPolicyVersion === RECOVERY_POLICY_VERSION) {
        return { alreadyApplied: true, policyVersion: RECOVERY_POLICY_VERSION, changes: [] };
      }
      const timestamp = now();
      const changes = [];
      for (const current of data.candidates) {
        if (current.workflowStatus !== "codex_processing") continue;
        if (activeDispatchForCandidate(data, current.id)) continue;
        const latest = latestDispatchForCandidate(data, current.id);
        const classification = classifyStoppedCandidate(current, latest);
        if (latest && RECOVERABLE_TERMINAL_DISPATCH_STATES.has(latest.status)) {
          latest.status = "superseded";
          latest.supersededAt = timestamp;
          latest.supersededReason = `由${RECOVERY_POLICY_VERSION}按真实失败类型重新分类`;
        }
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        current.updatedAt = timestamp;
        current.lastModifiedBy = "system";
        if (classification.kind === "needs_data") {
          current.workflowStatus = "needs_user_data";
          current.processing = {
            ...queuedProcessing(current.processing),
            state: "idle",
            manualHold: false,
            dispatchState: "needs_data",
            currentStep: classification.summary,
            blockReason: null,
            userAction: "请直接填写页面列出的缺失字段",
            recoveryDecision: null
          };
          addHistory(current, "system", "recoveryClassifiedNeedsData", classification.summary, timestamp);
        } else if (classification.kind === "business_decision") {
          current.processing = {
            ...queuedProcessing(current.processing),
            state: "blocked",
            manualHold: true,
            dispatchState: "needs_decision",
            currentStep: "等待主人选择固定处理方式",
            blockReason: classification.summary,
            userAction: "请在UI选择固定处理方式",
            recoveryDecision: fixedRecoveryDecision(
              "business_decision",
              classification.summary,
              ["allow_estimated_commission", "keep_stopped"]
            )
          };
          addHistory(current, "system", "recoveryClassifiedDecision", classification.summary, timestamp);
        } else if (classification.kind === "system_recovery") {
          current.processing = {
            ...queuedProcessing(current.processing),
            state: "blocked",
            manualHold: true,
            dispatchState: "legacy_read_only",
            currentStep: "旧执行记录已收口为历史只读",
            blockReason: classification.summary,
            userAction: "当前无需操作；新版商品由软件状态机重新建立执行上下文",
            recoveryDecision: null
          };
          addHistory(current, "system", "legacyExecutionArchived", "旧系统恢复记录只作历史读取，未创建Codex派发", timestamp);
        } else {
          current.processing = {
            ...queuedProcessing(current.processing),
            state: "blocked",
            manualHold: true,
            dispatchState: "blocked",
            currentStep: "一次真实技术失败后已停止",
            blockReason: classification.summary,
            userAction: "请在UI选择固定处理方式",
            recoveryDecision: fixedRecoveryDecision(
              "external_failure",
              classification.summary,
              ["retry_current_stage_once", "keep_stopped"]
            )
          };
          addHistory(current, "system", "recoveryClassifiedExternalFailure", classification.summary, timestamp);
        }
        changes.push({ candidateId: current.id, kind: classification.kind, dataRevision: current.dataRevision });
      }
      data.meta.recoveryPolicyVersion = RECOVERY_POLICY_VERSION;
      data.meta.lastRecoveryClassification = {
        at: timestamp,
        policyVersion: RECOVERY_POLICY_VERSION,
        changedCount: changes.length,
        automationStarted: false
      };
      data.meta.automationStarted = false;
      return { alreadyApplied: false, policyVersion: RECOVERY_POLICY_VERSION, changes, dispatchIds: [...dispatchIds] };
    });
    json(res, 200, result);
    if (dispatchIds.length && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchIds[0]).catch((error) => console.error("系统恢复首条派发失败", error)), 0);
    }
    return;
  }

  const recoveryActionRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/recovery-action$/);
  if (req.method === "POST" && recoveryActionRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) throw httpError(400, "恢复选择必须提供当前数据修订号");
    if (!Object.hasOwn(RECOVERY_ACTION_LABELS, input.action)) throw httpError(400, "恢复选择无效");
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === recoveryActionRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) throw httpError(409, "候选已变化，请刷新后重新选择");
      const decision = current.workflowStatus === "codex_processing"
        ? current.processing?.recoveryDecision
        : current.listingHandoff?.recoveryDecision;
      if (!decision?.actions?.some((item) => item.id === input.action)) {
        throw httpError(409, "当前状态不允许这个恢复选择");
      }
      if (activeDispatchForCandidate(data, current.id)) throw httpError(409, "当前SKU已有任务等待或运行，不能重复派发");
      const timestamp = now();
      if (input.action === "keep_stopped") {
        if (current.workflowStatus === "codex_processing") {
          current.processing.currentStep = "主人选择保持停止，等待精确证据";
          current.processing.userAction = "当前无需操作";
        } else {
          current.listingHandoff.currentStep = "主人选择保持停止，等待精确证据";
        }
        current.updatedAt = timestamp;
        addHistory(current, "user", "keptStopped", "主人选择保持停止，等待精确证据", timestamp);
        return { candidate: publicCandidate(current, data.rules), dispatch: null };
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      if (input.action === "allow_estimated_commission") current.acceptedEstimatedCommission = true;
      const nodeId = current.workflowStatus === "codex_processing" ? "M04" : "M07";
      if (current.workflowStatus === "codex_processing") {
        current.processing = {
          ...queueUserDispatch({ ...(current.processing || {}), manualHold: false }, timestamp, `fixed_recovery_${input.action}`),
          currentStep: "已选择固定处理方式，等待选品负责人",
          recoveryDecision: null
        };
      } else {
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: "queued",
          owner: "listing_task",
          runId: null,
          currentStep: "已选择固定处理方式，等待上架负责人",
          blockReason: null,
          recoveryDecision: null
        };
      }
      const message = input.action === "allow_estimated_commission"
        ? "主人已明确允许当前SKU使用清楚标注的估算佣金；继续当前B阶段，估算不得冒充精确事实"
        : "主人只允许重试当前阶段一次；只处理上次真实失败点，再次失败立即停止";
      const dispatch = createCandidateDispatch(data, map, current, {
        nodeId,
        message,
        trigger: `fixed_recovery_${input.action}`,
        actor: "user"
      });
      dispatchId = dispatch.id;
      addHistory(current, "user", "fixedRecoverySelected", `${RECOVERY_ACTION_LABELS[input.action]}：${dispatch.id}`, timestamp);
      return { candidate: publicCandidate(current, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("固定恢复选择派发失败", error)), 0);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/control/resume") {
    const input = await requestBody(req);
    if (!input.candidateId || !input.recoveryPath?.trim()) {
      throw httpError(400, "按建议重试必须指定candidateId和本次执行建议");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "总控恢复必须提供当前数据修订号");
    }
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选数据已变化，请刷新后重新确认恢复方式");
      }
      const activeDispatch = activeDispatchForCandidate(data, current.id);
      if (activeDispatch) {
        throw httpError(409, "当前SKU已有一次派发正在等待或运行，不能重复派发", { dispatchId: activeDispatch.id });
      }
      const latestDispatch = latestDispatchForCandidate(data, current.id);
      const terminalDispatchCanRecover = Boolean(
        latestDispatch && RECOVERABLE_TERMINAL_DISPATCH_STATES.has(latestDispatch.status)
      );
      const stoppedSelectionCanRecover = Boolean(
        current.workflowStatus === "codex_processing" &&
        ["blocked", "queued", "deferred"].includes(current.processing?.state) &&
        (current.processing?.manualHold === true || terminalDispatchCanRecover)
      );
      const stoppedListingCanRecover = Boolean(
        current.workflowStatus === "listing_preparation" &&
        ["paused_user_stopped", "blocked", "needs_decision"].includes(current.listingHandoff?.state)
      );
      if (!stoppedSelectionCanRecover && !stoppedListingCanRecover) {
        throw httpError(409, "只有本次处理已停止的候选可以按建议重试");
      }
      const timestamp = now();
      const existingBPass = Boolean(
        current.bPassedAt ||
        current.codexReview?.selectionStage === "B_profit_passed_C_pending" ||
        current.codexReview?.profitCalculation?.directionalStatus === "passed"
      );
      if (stoppedSelectionCanRecover && existingBPass) {
        current.workflowStatus = "listing_preparation";
        current.processing = {
          ...queuedProcessing(current.processing),
          state: "idle",
          runId: null,
          manualHold: false,
          blockReason: null,
          userAction: ""
        };
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: "queued",
          owner: "listing_task",
          runId: null,
          currentStep: "已有B阶段通过证据，按主人建议等待上架任务重试C阶段",
          recoveryPath: input.recoveryPath.trim(),
          defaultStock: 100,
          resumedAt: timestamp,
          blockReason: null
        };
        current.listingPreparation = {
          ...(current.listingPreparation || {}),
          status: "queued",
          retrySuggestion: input.recoveryPath.trim(),
          retriedAt: timestamp
        };
      } else if (stoppedSelectionCanRecover) {
        current.processing = {
          ...queuedProcessing(current.processing),
          state: "queued",
          runId: null,
          startedAt: null,
          currentStep: "",
          lastProgressAt: null,
          progressEvents: [],
          attemptLedger: [],
          manualHold: false,
          dispatchState: "requested",
          dispatchPriority: "user_retry",
          dispatchRequestedAt: timestamp,
          dispatchTrigger: "user_guided_retry",
          recoveryPath: input.recoveryPath.trim(),
          blockReason: null,
          userAction: "",
          stoppedAt: null,
          stopReason: "",
          controlAlertKey: ""
        };
      } else {
        current.listingHandoff = {
          ...(current.listingHandoff || {}),
          state: "queued",
          owner: "listing_task",
          runId: null,
          currentStep: "",
          recoveryPath: input.recoveryPath.trim(),
          blockReason: null,
          resumedAt: timestamp,
          currentStep: "按主人建议等待重试C阶段"
        };
        current.listingPreparation = {
          ...(current.listingPreparation || {}),
          status: "queued",
          retrySuggestion: input.recoveryPath.trim(),
          retriedAt: timestamp
        };
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      addHistory(current, "user", "userGuidedRetry", `主人给出执行建议并只重试当前SKU一次：${input.recoveryPath.trim()}`, timestamp);
      const nodeId = candidateActiveNode(current);
      const node = map.nodes.find((item) => item.id === nodeId);
      if (!node || node.executionOwner === "control_task") {
        throw httpError(409, "无法确定当前SKU的最终选品或上架负责人，已停止派发");
      }
      const dispatch = createDispatchRecord(data, {
        node,
        scope: "candidate",
        candidate: current,
        message: `只按主人本次建议重试当前SKU一次：${input.recoveryPath.trim()}；再次失败立即停止，不得自动换路径或重试`,
        trigger: "user_guided_retry"
      });
      dispatchId = dispatch.id;
      return { candidate: publicCandidate(current, data.rules), dispatch: dispatchPublic(dispatch) };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("恢复派发失败", error)), 0);
    return;
  }

  if (req.method === "GET" && pathname === "/api/automation/work") {
    const data = await readData();
    const state = responseState(data, req);
    const publicById = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
    const automationEnabled = data.meta?.automationStarted === true;
    const dispatchQueue = automationEnabled ? sortDispatchQueue(data.candidates) : [];
    return json(res, 200, {
      automationEnabled,
      disabledReason: automationEnabled ? "" : "自动化已关闭；等待总控明确开启",
      notificationPolicy: "健康检查、队列不变和重复证据保持静默",
      summary: state.summary,
      queued: dispatchQueue.map((candidate) => publicById.get(candidate.id)),
      urgent: dispatchQueue
        .filter((candidate) => candidate.processing?.dispatchState === "requested")
        .map((candidate) => publicById.get(candidate.id)),
      wbReassessment: state.candidates.filter(
        () => false
      ),
      handoffPending: state.candidates.filter(
        (candidate) =>
          candidate.workflowStatus === "ready_to_list" &&
          candidate.listingHandoff?.state === "queued"
      ),
      avoidanceFeedback: recentAvoidanceFeedback(data.candidates),
      rules: state.rules
    });
  }

  if (req.method === "POST" && pathname === "/api/automation/claim") {
    const input = await requestBody(req);
    if (!input.runId?.trim()) throw httpError(400, "自动审核必须提供runId");
    if (!input.initialStep?.trim()) throw httpError(400, "自动审核必须提供当前执行步骤");
    const result = await mutateData((data) => {
      if (data.meta?.automationStarted !== true) {
        throw httpError(409, "自动化已关闭，只有总控明确开启后才能领取任务");
      }
      const running = data.candidates.filter(
        (candidate) => candidate.workflowStatus === "codex_processing" && isActualProcessingRun(candidate.processing)
      ).sort((a, b) => {
        const timeDifference = new Date(a.processing.startedAt).getTime() - new Date(b.processing.startedAt).getTime();
        return timeDifference || a.id.localeCompare(b.id);
      });
      const alreadyRunning = input.candidateId
        ? running.find((candidate) => candidate.id === input.candidateId)
        : null;
      if (alreadyRunning) {
        return {
          candidate: null,
          alreadyRunning: {
            candidateId: alreadyRunning.id,
            runId: alreadyRunning.processing.runId,
            startedAt: alreadyRunning.processing.startedAt
          }
        };
      }
      const duplicateRunId = running.find(
        (candidate) => candidate.processing?.runId === input.runId.trim()
      );
      if (duplicateRunId) {
        throw httpError(409, "runId已被另一条运行中候选使用", {
          candidateId: duplicateRunId.id
        });
      }
      if (running.length >= automationConcurrencyLimit) {
        return {
          candidate: null,
          busy: {
            candidateId: running[0].id,
            candidateIds: running.map((candidate) => candidate.id),
            startedAt: running[0].processing.startedAt,
            concurrencyLimit: automationConcurrencyLimit,
            availableSlots: 0
          }
        };
      }
      const queue = sortDispatchQueue(data.candidates).filter(
        (candidate) =>
          candidate.processing?.deferredRunId !== input.runId.trim() &&
          (!input.candidateId || candidate.id === input.candidateId)
      );
      const candidate = queue[0];
      if (!candidate) return { candidate: null };
      const claimTime = now();
      const sameBusinessDate = candidate.processing?.lastAttemptBusinessDate === businessDate(claimTime);
      candidate.processing = {
        ...candidate.processing,
        state: "running",
        runId: input.runId.trim(),
        startedAt: claimTime,
        currentStep: input.initialStep.trim(),
        lastProgressAt: claimTime,
        progressEvents: [],
        attemptLedger: [],
        lastAttemptAt: claimTime,
        claimRevision: candidate.dataRevision,
        attempts: Number(candidate.processing?.attempts || 0) + 1,
        attemptsToday: sameBusinessDate ? Number(candidate.processing?.attemptsToday || 0) + 1 : 1,
        lastAttemptBusinessDate: businessDate(claimTime),
        lastError: null,
        blockReason: null,
        userAction: "",
        readAttempts: [],
        deferredUntil: null,
        deferredRunId: null,
        dispatchState: "claimed",
        manualHold: false,
        stoppedAt: null,
        stopReason: "",
        controlAlertKey: ""
      };
      candidate.updatedAt = candidate.processing.startedAt;
      candidate.lastModifiedBy = "automation";
      addHistory(candidate, "codex", "claimed", `自动审核开始：${input.runId.trim()}`);
      return {
        candidate: publicCandidate(candidate, data.rules),
        claimRevision: candidate.dataRevision
      };
    });
    return json(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/automation/attempt") {
    const input = await requestBody(req);
    if (!input.runId?.trim() || !input.candidateId || !input.evidenceLayer?.trim() || !input.target?.trim()) {
      throw httpError(400, "登记读取尝试必须提供runId、candidateId、证据层和目标");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "候选资料已更新，本轮读取尝试已失效");
      }
      try {
        current.processing = registerProcessingAttempt(current.processing, input, now());
      } catch (error) {
        throw httpError(/本轮已尝试/.test(error.message) ? 409 : 400, error.message);
      }
      current.updatedAt = now();
      current.lastModifiedBy = "automation";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && pathname === "/api/automation/progress") {
    if (!isTrustedInternalApiRequest(req.headers, internalApiRequestToken)) {
      throw httpError(403, "实质进展只能由当前受控任务提交", { code: "trusted_progress_required" });
    }
    const input = maintenanceProgressInput(await requestBody(req), { candidateRequired: true });
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      const dispatch = activeDispatchForCandidate(data, current.id);
      if (!dispatch) throw httpError(409, "当前商品没有本次正式领取的有效任务");
      applyMaintenanceProgress(current, dispatch, input, now());
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && pathname === "/api/automation/release") {
    if (!isTrustedInternalApiRequest(req.headers, internalApiRequestToken)) {
      throw httpError(403, "执行结果只能由当前受控任务提交", { code: "trusted_completion_required" });
    }
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision) || input.dataRevision < 0) throw httpError(400, "释放任务必须提供准确资料修订号");
    if (!input.runId?.trim() || !input.candidateId || !input.error?.trim()) {
      throw httpError(400, "释放自动审核任务必须提供runId、candidateId和具体错误");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === input.candidateId);
      if (!current) throw httpError(404, "候选不存在");
      const active = activeDispatchForCandidate(data, current.id);
      if (!active || active.status !== "running" || active.runId !== input.runId.trim()) {
        throw httpError(409, "只能释放本次进程中同一运行编号的维护任务");
      }
      if (
        current.processing?.state !== "running" ||
        current.processing.runId !== input.runId.trim()
      ) {
        throw httpError(409, "只能释放当前runId实际领取的审核任务");
      }
      if (Number(current.dataRevision) !== Number(input.dataRevision)) {
        throw httpError(409, "候选资料已更新，当前任务无需再释放");
      }
      const timestamp = now();
      const failureScope = String(input.failureScope || "supplier_link").trim();
      let disposition;
      try {
        disposition = technicalFailureDisposition({
          attemptsToday: Number(current.processing?.attemptsToday || 0),
          readAttempts: input.readAttempts,
          explicitSafetyBlock: input.explicitSafetyBlock === true
        });
      } catch (error) {
        throw httpError(400, error.message);
      }
      const userAction =
        input.userAction?.trim() ||
        "请让总控明确是否按一个恢复路径重新开始；恢复前不再自动重试";
      const stoppedRunId = input.runId.trim();
      const dedupeKey = `technical-block|${current.id}|${stoppedRunId}|${failureScope}`;
      current.processing = {
        ...queuedProcessing(current.processing),
        state: "blocked",
        runId: null,
        startedAt: null,
        currentStep: "已停止：等待总控确认",
        lastRunId: stoppedRunId,
        lastError: input.error.trim(),
        blockReason: input.error.trim(),
        userAction,
        readAttempts: disposition.readAttempts,
        deferredRunId: null,
        deferredUntil: null,
        lastAttemptRevision: Number(input.dataRevision),
        lastAttemptBusinessDate: businessDate(timestamp),
        dispatchState: "blocked",
        manualHold: true,
        failureScope,
        stoppedAt: timestamp,
        stopReason: "evidence_bearing_technical_failure",
        controlAlertKey: dedupeKey,
        recoveryOptions: disposition.recoveryOptions || []
      };
      current.codexReview = {
        ...(current.codexReview || {}),
        technicalBlock: {
          reason: input.error.trim(),
          failureScope,
          stoppedAt: timestamp,
          runId: stoppedRunId,
          readAttempts: disposition.readAttempts
        }
      };
      const alert = {
        id: dedupeKey,
        dedupeKey,
        candidateId: current.id,
        runId: stoppedRunId,
        type: "evidence_bearing_technical_failure",
        message: input.error.trim(),
        createdAt: timestamp,
        acknowledgedAt: null,
        recoveryOptions: disposition.recoveryOptions || []
      };
      appendControlAlert(data, alert);
      addHistory(
        current,
        "codex",
        "blockedAfterTechnicalFailure",
        `一次证据化技术失败后已停止：${input.error.trim()}；下一步：${userAction}`,
        timestamp
      );
      current.updatedAt = timestamp;
      current.lastModifiedBy = "automation";
      active.status = "blocked";
      active.completedAt = timestamp;
      active.lastEventAt = timestamp;
      active.pendingApproval = null;
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const sourceAttemptRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/source-search-attempt$/);
  if (req.method === "POST" && sourceAttemptRoute) {
    throw httpError(409, "该旧接口已停用：B阶段不得核1688；精确货源SKU只在主人启动待上架准备后由上架任务完成C阶段核验");
    /* c8 ignore start -- 保留旧数据迁移读取逻辑，不再允许新调用 */
    const input = await requestBody(req);
    if (!["found", "not_found"].includes(input.result)) {
      throw httpError(400, "找货结果必须是found或not_found；技术失败请释放任务重试");
    }
    if (!input.checkedAt || !input.searchQuery?.trim()) {
      throw httpError(400, "找货记录必须包含查询词和查询时间");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "找货记录必须提供领取时的数据修订号");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === sourceAttemptRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.source !== "codex" || current.workflowStatus !== "codex_processing") {
        throw httpError(409, "只有已认可且正在处理的Codex方向候选可记录自动找货");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已更新，旧找货结果不得覆盖新数据");
      }
      if (input.runId && current.processing?.runId !== input.runId) {
        throw httpError(409, "找货runId与当前领取任务不一致");
      }
      current.sourceSearchHistory ||= [];
      current.sourceSearchHistory.push({
        result: input.result,
        searchQuery: input.searchQuery.trim(),
        evidenceUrl: input.evidenceUrl?.trim() || "",
        checkedAt: input.checkedAt
      });
      const timestamp = now();
      if (input.result === "found") {
        if (!input.sourceUrl?.trim()) throw httpError(400, "找到货源时必须保存精确货源链接");
        const duplicate = duplicateCandidate(data.candidates, [input.sourceUrl], current.id);
        if (duplicate) {
          throw httpError(409, `该货源链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
        }
        current.sourceUrl = input.sourceUrl.trim();
        current.workflowStatus = "codex_processing";
        current.processing = queuedProcessing(current.processing);
        addHistory(current, "codex", "sourceFound", "已找到精确货源，自动进入利润审核", timestamp);
      } else {
        current.sourceSearchAttempts = Number(current.sourceSearchAttempts || 0) + 1;
        current.sourceSearchAttemptLimit = Number(current.sourceSearchAttemptLimit || 3);
        if (current.sourceSearchAttempts >= current.sourceSearchAttemptLimit) {
          current.workflowStatus = "eliminated";
          current.processing = { ...queuedProcessing(current.processing), state: "idle" };
          current.eliminatedAt = timestamp;
          current.eliminationReason = `Codex已完成${current.sourceSearchAttempts}轮精确找货，仍未找到可审核货源`;
          addHistory(current, "codex", "sourceSearchExhausted", current.eliminationReason, timestamp);
        } else {
          current.processing = queuedProcessing(current.processing);
          addHistory(
            current,
            "codex",
            "sourceNotFound",
            `第${current.sourceSearchAttempts}/${current.sourceSearchAttemptLimit}轮精确找货未找到，保留后续重试`,
            timestamp
          );
        }
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "codex";
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
    /* c8 ignore stop */
  }

  const siblingBatchRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/sibling-sku-batch$/);
  const siblingBatchAConfirmRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/sibling-batch-a-confirm$/);
  const siblingBatchC1Route = pathname.match(/^\/api\/candidates\/([^/]+)\/sibling-batch-c1-confirm$/);
  const siblingBatchC1PreviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/sibling-batch-c1-preview$/);
  const siblingBatchC2Route = pathname.match(/^\/api\/candidates\/([^/]+)\/sibling-batch-c2-confirm$/);
  if (req.method === 'POST' && (siblingBatchC1Route || siblingBatchC1PreviewRoute)) {
    const origin = String(req.headers.origin || '');
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, '整批颜色事实确认拒绝其他网页来源');
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后确认整批颜色事实');
    }
    const input = await readJsonRequestBody(req, { maxBytes: 65536, requireJsonContentType: true });
    if (input?.parentCandidateId !== decodeURIComponent((siblingBatchC1Route || siblingBatchC1PreviewRoute)[1])) {
      throw httpError(400, '整批颜色事实商品身份不一致');
    }
    try {
      if (siblingBatchC1PreviewRoute) {
        return json(res, 200, previewSiblingBatchC1Preparation({ document: await readData(),
          actor, input, serverClock: now }));
      }
      return json(res, 200, await commitSiblingBatchC1Preparation({ repository: businessStateRepository,
        runtimeMode: runtimeConfiguration.deploymentMode, actor, input, serverClock: now }));
    } catch (error) {
      const code = String(error.code || error.message).split(':', 1)[0];
      if (/^(?:SIBLING_BATCH_C1|C1_SIBLING_SHARED|C1_SIBLING_NEUTRAL|C1_CONTENT_REVIEW|C1_COLOR_DICTIONARY|C1_SKU_RIGHTS|C1_G1|C2_C1)/.test(code)) {
        const specific = {
          SIBLING_BATCH_C1_COLOR_COLLECTION_SCHEMA_REQUIRED: '当前冻结类目Schema缺少基础色多选能力或有效上限；先取得并修订正式Schema证据，不能使用历史字典查询代替。',
          SIBLING_BATCH_C1_COPY_REVIEW_REQUIRED: '编辑文案尚未通过正式语义复核；采用已核验预览文案，或先完成现有C1编辑复核。',
          SIBLING_BATCH_C1_SUPPLIER_COLOR_REQUIRED: '供应原色缺失；请先修订该规格的 A 阶段供应事实，再在本页重新预览。',
          SIBLING_BATCH_C1_OFFICIAL_COLOR_REQUIRED: '10096 官方颜色尚未逐行选择；请在本页补齐并重新预览。',
          SIBLING_BATCH_C1_COLOR_NAME_REQUIRED: '10097 准确颜色名称尚未逐行填写；请在本页补齐并重新预览。',
          SIBLING_BATCH_C1_COLOR_FACT_MISSING: '供应原色事实未确认或与当前规格不一致；请先修订该规格的 A 阶段供应事实。',
          SIBLING_BATCH_C1_PREVIEW_CHANGED: '批量预览已过期，当前事实或内容已变化；请在本页重新预览。',
          SIBLING_BATCH_C1_PARENT_CHANGED: '首件 revision 或文案已变化；旧批次确认不能重放。',
          SIBLING_BATCH_C1_SCOPE_MISMATCH: '当前已选规格与批量身份不一致；旧确认不能重放。',
          C1_SIBLING_NEUTRAL_COLOR_ALIAS_REQUIRES_REVISION: '首件文案使用了无法由已确认颜色事实安全清理的别称；请先集中修订首件文案。'
        };
        return json(res, 409, { code, message: specific[code] ?? '整批 C1 未保存；请核对官方颜色、逐行事实、权利和共用草稿。',
          externalRequests: 0, paidCalls: 0, platformWrites: 0 });
      }
      throw error;
    }
  }
  if (req.method === 'POST' && siblingBatchC2Route) {
    const origin = String(req.headers.origin || '');
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, '整批素材确认拒绝其他网页来源');
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后确认整批素材');
    }
    const input = await readJsonRequestBody(req, { maxBytes: 65536, requireJsonContentType: true });
    if (input?.parentCandidateId !== decodeURIComponent(siblingBatchC2Route[1]) || !Array.isArray(input.members)) {
      throw httpError(400, '整批素材商品身份不一致');
    }
    const snapshot = await readData();
    const parent = snapshot.candidates.find(item => item.id === input.parentCandidateId);
    if (!parent || parent.dataRevision !== input.parentRevision) throw httpError(409, '原商品规格清单已变化，请刷新核对');
    const verifiedAssets = new Map();
    if (!isSiblingBatchC2Replay(snapshot, input, actor)) for (const member of input.members) {
      const child = snapshot.candidates.find(item => item.id === member.candidateId);
      if (!child || child.siblingSourceV1?.parentCandidateId !== parent.id || child.dataRevision !== member.candidateRevision) {
        throw httpError(409, '整批素材包含过期或不属于本批的规格');
      }
      verifiedAssets.set(child.id, await verifyAndAuthorizeStagedC2Assets({ candidate: child,
        dataRevision: member.candidateRevision, draftRevision: member.draftRevision,
        assets: member.approvedAssetIds?.map((assetId, index) => ({ assetId, order: index + 1 })) }));
    }
    try {
      return json(res, 200, await commitSiblingBatchC2Final({ repository: businessStateRepository,
        runtimeMode: runtimeConfiguration.deploymentMode, actor, input, verifiedAssets, serverClock: now }));
    } catch (error) {
      const code = String(error.code || error.message).split(':', 1)[0];
      if (/^(?:SIBLING_BATCH_C2|C2_|FINAL_PLAN_CARD|SIBLING_COLOR|SIBLING_CARD|SIBLING_MAIN_IMAGE)/.test(code)) {
        return json(res, 409, { code, message: '整批 C2 确认未保存；请核对每色主图、官方颜色事实和素材权利。',
          externalRequests: 0, platformWrites: 0 });
      }
      throw error;
    }
  }
  if (req.method === 'POST' && siblingBatchAConfirmRoute) {
    const origin = String(req.headers.origin || '');
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, '批量供应确认拒绝其他网页来源');
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后确认整批供应规格');
    }
    const parentCandidateId = decodeURIComponent(siblingBatchAConfirmRoute[1]);
    const input = await readJsonRequestBody(req, { maxBytes: 65536, requireJsonContentType: true });
    if (input?.parentCandidateId !== parentCandidateId) throw httpError(409, '批量确认的原商品身份不一致');
    let result;
    try {
      result = await commitSiblingBatchABAndC1({ repository: businessStateRepository,
        runtimeMode: runtimeConfiguration.deploymentMode, actor, input, serverClock: now,
        guooFilePath: runtimeConfiguration.guooTariffFile });
    } catch (error) {
      const code = String(error.code || error.message).split(':', 1)[0];
      if (/^(?:SIBLING_BATCH_A|REAL_A|B_EVIDENCE|B_COMMISSION|B_COST_POLICY|C1_PRODUCT_PLAN|SUPPLIER_OPTION)_[A-Z_]+$/.test(code)) {
        return json(res, /INPUT_INVALID/.test(code) ? 400 : 409,
          { code, message: code==='SIBLING_BATCH_A_QUANTITY_ONE_EVIDENCE_MISSING'?'当前采集的一件起订报价或本规格同价依据不足，不能沿用其他颜色的确认；整批未推进，当前输入保留。':'整批 A/B/C1 未保存；请核对当前规格清单与完整证据。', externalRequests: 0, platformWrites: 0 });
      }
      throw error;
    }
    return json(res, 200, result);
  }
  if (req.method === 'POST' && siblingBatchRoute) {
    const origin = String(req.headers.origin || '');
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, '追加规格拒绝其他网页来源');
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后准备规格清单');
    }
    const parentCandidateId = decodeURIComponent(siblingBatchRoute[1]);
    const body = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
    let result;
    try {
      result = await mutateDataWhenChanged(data => {
        const outcome = createSiblingSkuCandidatesBatch({ document: data, parentCandidateId, input: body,
          nextId: candidates => nextCandidateId(candidates, 'USR'), timestamp: now(), storeBindings: runtimeConfiguration.storeBindings });
        for (const candidate of outcome.candidates) if (outcome.createdIds.includes(candidate.id)) {
          addHistory(candidate, 'user', 'siblingSkuBatchPrepared',
            `规格清单一次建立供应 SKU ${candidate.siblingSourceV1.supplierSkuId} 的 A 记录；B/C1/C2 与生产授权尚待逐项软件核验`, now());
        }
        return { changed: outcome.createdCount > 0, result: {
          candidates: outcome.candidates.map(candidate => publicCandidate(candidate, data.rules)),
          createdCount: outcome.createdCount, status: 'a_preparation_only', platformWrites: 0
        } };
      });
    } catch (error) {
      if (error instanceof SiblingSkuCandidateError) throw httpError(error.code === 'SIBLING_BATCH_INPUT_INVALID' ? 400 : 409, error.message, { code: error.code });
      throw error;
    }
    return json(res, result.createdCount > 0 ? 201 : 200, result);
  }

  const siblingSkuRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/sibling-sku$/);
  if (req.method === 'POST' && siblingSkuRoute) {
    const origin = String(req.headers.origin || '');
    if (origin && !allowedReviewOrigins.has(origin)) throw httpError(403, '追加规格拒绝其他网页来源');
    const actor = runtimeIdentityProvider.resolveActor({ request: req });
    if (actor.source !== 'authenticated_identity_provider' || actor.actorType !== 'human' || !actor.roles.includes('owner')) {
      throw httpError(403, '请先登录主人身份后追加规格');
    }
    const parentCandidateId = decodeURIComponent(siblingSkuRoute[1]);
    const body = await readJsonRequestBody(req, { maxBytes: 4096, requireJsonContentType: true });
    let result;
    try {
      const input = siblingSkuCandidateInput(body);
      result = await mutateDataWhenChanged(data => {
        const outcome = createSiblingSkuCandidate({ document: data, parentCandidateId, input,
          id: nextCandidateId(data.candidates, 'USR'), timestamp: now(), storeBindings: runtimeConfiguration.storeBindings });
        if (outcome.created) addHistory(outcome.candidate, 'user', 'siblingSkuCreated',
          `已从原商品的只读证据建立供应 SKU ${input.supplierSkuId} 的独立 A 阶段；未继承利润、素材或生产授权`, now());
        return { changed: outcome.created, result: { candidate: publicCandidate(outcome.candidate, data.rules), created: outcome.created } };
      });
    } catch (error) {
      if (error instanceof SiblingSkuCandidateError) {
        throw httpError(error.code === 'SIBLING_INPUT_INVALID' ? 400 : 409, error.message, { code: error.code });
      }
      throw error;
    }
    return json(res, result.created ? 201 : 200, result);
  }

  if (req.method === "POST" && pathname === "/api/candidates") {
    const input = normalizeCandidateUserCreateInput(await requestBody(req));
    const result = await mutateData((data) => {
      const duplicate = duplicateCandidate(data.candidates, [input.productUrl, input.sourceUrl, input.competitorUrl]);
      if (duplicate) {
        throw httpError(409, `该链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
      }
      const timestamp = now();
      const created = createInitialCandidate({ input, source: "user", id: nextCandidateId(data.candidates, "USR"), timestamp, storeBindings: runtimeConfiguration.storeBindings });
      addHistory(created, "user", "created", "用户添加候选，已进入软件状态机；未派发Codex任务", timestamp);
      data.candidates.unshift(created);
      return { candidate: publicCandidate(created, data.rules), dispatch: null };
    });
    json(res, 201, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/codex/candidates") {
    const input = normalizeCandidateCodexCreateInput(await requestBody(req));
    if (![true, false].includes(input.powered)) throw httpError(400, "Codex候选必须确认是否带电");
    if (!input.purchaseCeiling || !["verified", "estimated", "unavailable"].includes(input.purchaseCeiling.status)) {
      throw httpError(400, "Codex候选必须提供含国内邮费采购区间，或明确标记尚无法反算");
    }
    const ceiling = purchaseCeilingSummary(input, DEFAULT_RULES);
    if (
      ["verified", "estimated"].includes(input.purchaseCeiling.status) &&
      input.purchaseCeiling.pricingPolicyVersion !== resolveLifecycleBProfitRule(input, DEFAULT_RULES).pricingPolicyVersion
    ) {
      throw httpError(400, "新采购上限必须按折后成交价计算利润，并保存20%、25%、30%促销对应建议标价");
    }
    if (input.purchaseCeiling.status === "verified" && ceiling.status !== "verified") {
      throw httpError(400, "采购上限证据不完整，不能标记为已验证", { missing: ceiling.missing });
    }
    if (
      input.purchaseCeiling.status === "estimated" && ceiling.status !== "estimated"
    ) {
      throw httpError(400, "方向采购区间证据不足，不能标记为已估算", { missing: ceiling.missing });
    }
    if (
      input.purchaseCeiling.status === "unavailable" &&
      (!Array.isArray(input.purchaseCeiling.missing) || !input.purchaseCeiling.missing.length)
    ) {
      throw httpError(400, "尚无法反算时必须写明Codex的技术缺口");
    }
    const candidate = await mutateData((data) => {
      const duplicate = duplicateCandidate(data.candidates, [input.productUrl, input.sourceUrl, input.competitorUrl]);
      if (duplicate) {
        throw httpError(409, `该链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
      }
      const summary = dailySummary(data.candidates, data.rules);
      const storeSummary = summary.stores[input.targetStore];
      if (storeSummary && storeSummary.automaticAdditionEnabled === false) {
        throw httpError(429, storeSummary.automaticAdditionPauseReason);
      }
      if (summary.combined.profitPassed >= summary.combined.target) {
        throw httpError(429, "全店今日B阶段利润通过已达到10个，无需继续自动补充候选");
      }
      if (storeSummary && storeSummary.remainingCodexAdditionCapacity <= 0) {
        throw httpError(429, `${input.targetStore} 今日Codex新增候选已达到30条上限`);
      }
      const timestamp = now();
      const created = createInitialCandidate({ input, source: "codex", id: nextCandidateId(data.candidates, "CX"), timestamp, storeBindings: runtimeConfiguration.storeBindings });
      addHistory(created, "codex", "created", "Codex自动补充候选，等待用户判断方向", timestamp);
      data.candidates.unshift(created);
      return publicCandidate(created, data.rules);
    });
    return json(res, 201, { candidate });
  }

  const candidateRoute = pathname.match(/^\/api\/candidates\/([^/]+)$/);
  if (req.method === "PATCH" && candidateRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "保存候选资料必须提供当前数据修订号");
    }
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === candidateRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已被更新，请刷新后再保存", {
          currentRevision: current.dataRevision
        });
      }
      if (["ready_to_list", "listed", "eliminated"].includes(current.workflowStatus)) {
        throw httpError(409, "终态候选不可直接修改；请保留历史结论并创建新候选");
      }
      const normalizedInput = normalizeCandidateUserPatchInput(input, current, { storeBindings: runtimeConfiguration.storeBindings });
      const duplicate = duplicateCandidate(
        data.candidates,
        [normalizedInput.productUrl, normalizedInput.sourceUrl, normalizedInput.competitorUrl],
        current.id
      );
      if (duplicate) {
        throw httpError(409, `该链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
      }
      for (const field of USER_FIELDS) {
        if (Object.hasOwn(normalizedInput, field)) current[field] = normalizedInput[field];
      }
      if (Object.hasOwn(normalizedInput, "storeRef")) current.storeRef = normalizedInput.storeRef;
      if (Object.hasOwn(normalizedInput, "purchasePriceRmb") && !Object.hasOwn(normalizedInput, "domesticShippingRmb")) {
        current.domesticShippingRmb = null;
      }
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = now();
      current.lastModifiedBy = "user";
      addHistory(current, "user", "updated", "用户补充资料；技术阻塞不会自动解除，是否恢复由总控决定");
      return { candidate: publicCandidate(current, data.rules), dispatch: null };
    });
    json(res, 200, result);

    return;
  }

  const evaluationRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/user-evaluation$/);
  if (req.method === "POST" && evaluationRoute) {
    const input = await requestBody(req);
    if (!["viable", "reject", "unsure"].includes(input.decision)) {
      throw httpError(400, "请选择你的判断");
    }
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === evaluationRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.lifecycleV11?.opportunityPackage || current.lifecycleV11?.skuPackage) {
        throw httpError(409, "新版生命周期商品不能使用旧方向确认入口；请使用A阶段完整确认卡，商品状态未改变");
      }
      if (!Number.isInteger(input.dataRevision)) {
        throw httpError(400, "提交判断必须提供当前数据修订号");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已被更新，请刷新后再判断", {
          currentRevision: current.dataRevision
        });
      }
      const timestamp = now();
      const profitInputs = input.candidateData || {};
      if (input.decision === "unsure" && Object.keys(profitInputs).length) {
        if (profitInputs.sourceUrl?.trim()) {
          const duplicate = duplicateCandidate(data.candidates, [profitInputs.sourceUrl], current.id);
          if (duplicate) {
            throw httpError(409, `该采购链接已存在于候选 ${duplicate.id}`, { duplicateId: duplicate.id });
          }
        }
        for (const field of ["productName", "sourceUrl", "purchasePriceRmb", "packedWeightKg", "dimensionsCm"]) {
          if (Object.hasOwn(profitInputs, field)) current[field] = profitInputs[field];
        }
        if (Object.hasOwn(profitInputs, "purchasePriceRmb") && !Object.hasOwn(profitInputs, "domesticShippingRmb")) {
          current.domesticShippingRmb = null;
        }
      }
      current.userEvaluation = {
        decision: input.decision,
        reason: input.reason?.trim() || "",
        at: timestamp
      };
      current.dataRevision = Number(current.dataRevision || 0) + 1;
      current.updatedAt = timestamp;
      current.lastModifiedBy = "user";
      if (input.decision === "reject") {
        current.workflowStatus = "eliminated";
        current.processing = { ...queuedProcessing(current.processing), state: "idle" };
        current.eliminatedAt = timestamp;
        current.eliminationReason = `用户判断不行${current.userEvaluation.reason ? `：${current.userEvaluation.reason}` : ""}`;
      } else {
        current.workflowStatus = "codex_processing";
        current.processing = queueUserDispatch(current.processing, timestamp, "user_evaluation");
        current.eliminatedAt = null;
        current.eliminationReason = "";
        const dispatch = createCandidateDispatch(data, map, current, {
          nodeId: "M04",
          message: "主人已确认该方向继续，请自动完成当前SKU的A/B利润处理；B阶段不得打开1688精确页",
          trigger: "direction_confirmed_auto",
          actor: "system"
        });
        dispatchId = dispatch.id;
      }
      const labels = { viable: "可做，交给Codex核算", reject: "不行，立即淘汰", unsure: "待确认，交给Codex核算" };
      const inputNote =
        input.decision === "unsure" && Object.keys(profitInputs).length
          ? "；已同时补充采购链接、含国内邮费的采购总价和包装规格"
          : "";
      addHistory(current, "user", "evaluated", `用户判断：${labels[input.decision]}${inputNote}`, timestamp);
      return { candidate: publicCandidate(current, data.rules), dispatch: dispatchId ? dispatchPublic(data.dispatches.find((item) => item.id === dispatchId)) : null };
    });
    json(res, 200, result);
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("方向确认自动派发失败", error)), 0);
    }
    return;
  }

  const commentRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/comments$/);
  if (req.method === "POST" && commentRoute) {
    const input = normalizeCandidateCommentInput(await requestBody(req), {
      actor: isTrustedInternalApiRequest(req.headers, internalApiRequestToken) ? "codex" : "user"
    });
    const result = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === commentRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "留言保存时商品资料已变化，请刷新后重试", {
          currentRevision: current.dataRevision
        });
      }
      const comment = {
        id: `C-${randomUUID()}`,
        actor: input.actor,
        message: input.message,
        category: input.category,
        requiresResponse: false,
        status: "recorded",
        replyTo: input.replyTo,
        at: now()
      };
      current.comments ||= [];
      current.comments.push(comment);
      if (comment.actor === "codex" && comment.replyTo) {
        const original = current.comments.find((item) => item.id === comment.replyTo);
        if (original?.actor === "user") {
          original.status = "responded";
          original.respondedAt = comment.at;
          original.responseCommentId = comment.id;
        }
      }
      current.updatedAt = comment.at;
      current.lastModifiedBy = comment.actor;
      addHistory(
        current,
        comment.actor,
        "commented",
        comment.category === "elimination_feedback"
          ? "新增后续选品避坑原因"
          : "新增双方记录留言",
        comment.at
      );
      return { comment, candidate: publicCandidate(current, data.rules) };
    });
    return json(res, 201, result);
  }

  const reviewRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/codex-review$/);
  if (req.method === "POST" && reviewRoute) {
    const input = await requestBody(req);
    if (!["approved", "needsInfo", "eliminated"].includes(input.decision)) {
      throw httpError(400, "Codex判断无效");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "Codex审核必须提供领取时的数据修订号");
    }
    const map = await readWorkflowMap(workflowMapFile);
    let dispatchId = null;
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === reviewRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (isTrustedInternalApiRequest(req.headers, internalApiRequestToken)) assertCurrentMaintenanceWrite(data, current.id, input.runId);
      if (current.lifecycleV11?.opportunityPackage || current.lifecycleV11?.skuPackage) {
        throw httpError(409, "新版生命周期商品不能使用旧B审核入口；请使用新版B利润模型，商品状态未改变");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已更新，旧审核结果不得覆盖新数据", {
          currentRevision: current.dataRevision
        });
      }
      if (
        current.processing?.state === "running" &&
        input.runId &&
        current.processing.runId !== input.runId
      ) {
        throw httpError(409, "自动审核runId与当前领取任务不一致");
      }
      const reviewInput = { ...input };
      const wbAssessment = reviewInput.wbAssessment;
      delete reviewInput.wbAssessment;
      const autoElimination = codexAutoEliminationGate(
        { ...current, codexReview: reviewInput },
        data.rules
      );
      if (autoElimination.shouldEliminate && reviewInput.decision !== "eliminated") {
        reviewInput.decision = "eliminated";
        reviewInput.reason = autoElimination.reason;
        reviewInput.autoElimination = autoElimination;
      }
      if (
        reviewInput.decision === "approved" &&
        !["suitable", "notSuitable"].includes(wbAssessment?.status)
      ) {
        throw httpError(400, "进入待上架前必须同时给出WB适合或不适合的明确结论");
      }
      if (
        reviewInput.decision === "approved" &&
        wbAssessment?.status === "notSuitable" &&
        !wbAssessment.reason?.trim()
      ) {
        throw httpError(400, "WB不适合必须写明当前判断依据");
      }
      if (reviewInput.decision === "approved") {
        const scenarioGate = promotionPricingGate(
          reviewInput.profitCalculation,
          resolveLifecycleBProfitRule(current, data.rules)
        );
        if (!scenarioGate.passed) {
          throw httpError(422, "Ozon利润必须保存20%、25%、30%促销对应建议标价，促销率不得从折后成交价二次扣除", {
            blockers: scenarioGate.blockers
          });
        }
        const wbScenarioGate = promotionPricingGate(
          wbAssessment?.profitCalculation,
          data.rules.wbCrossListing
        );
        if (!wbScenarioGate.passed) {
          throw httpError(422, "WB利润必须保存20%、25%、30%促销对应建议标价，促销率不得从折后成交价二次扣除", {
            blockers: wbScenarioGate.blockers
          });
        }
      }
      if (reviewInput.decision === "needsInfo" && !effectiveNeeds({
        ...current,
        workflowStatus: "needs_user_data",
        codexReview: reviewInput
      }).length) {
        throw httpError(400, "待补资料必须明确列出用户需要补什么");
      }
      if (reviewInput.decision === "needsInfo" && !effectiveNeededFields({
        ...current,
        workflowStatus: "needs_user_data",
        codexReview: reviewInput
      }).length) {
        throw httpError(400, "待补资料必须指向明确且可填写的字段，不能退回整套表单");
      }
      const reviewedAt = now();
      current.codexReview = { ...reviewInput, reviewedAt };
      if (reviewInput.decision === "approved") {
        const gate = profitReviewGate(current, data.rules);
        if (!gate.passed) {
          throw httpError(422, "不满足B阶段利润通过门槛，只能标为待补资料或淘汰", {
            blockers: gate.blockers
          });
        }
        current.workflowStatus = "listing_preparation";
        const assessedWb = { ...wbAssessment, assessedAt: reviewedAt };
        const wbGate = wbAssessmentDecisionGate(assessedWb, current, data.rules);
        if (!wbGate.passed) {
          throw httpError(422, "WB市场与利润判断不满足新规则", {
            blockers: wbGate.blockers
          });
        }
        current.wbAssessment = assessedWb;
        current.bPassedAt = reviewedAt;
        current.readyAt = null;
        current.cCompletedAt = null;
        current.defaultStock = 100;
        current.listingPreparation = {
          status: "queued",
          bCommissionMode: gate.commissionMode,
          startedAt: reviewedAt,
          completedAt: null,
          evidencePackIds: Array.isArray(reviewInput.evidencePackIds) ? reviewInput.evidencePackIds : []
        };
        current.evidencePackIds = Array.isArray(reviewInput.evidencePackIds) ? reviewInput.evidencePackIds : [];
        current.listingHandoff = {
          state: "queued",
          owner: "listing_task",
          handedOffAt: reviewedAt,
          queuedAt: reviewedAt,
          currentStep: "B阶段通过，已自动进入C1，等待上架任务领取",
          defaultStock: 100
        };
        current.eliminatedAt = null;
        current.eliminationReason = "";
      } else if (reviewInput.decision === "eliminated") {
        current.workflowStatus = "eliminated";
        current.readyAt = null;
        current.eliminatedAt = reviewedAt;
        current.eliminationReason = reviewInput.reason?.trim() || "Codex判断不可做";
      } else {
        current.workflowStatus = "needs_user_data";
        current.readyAt = null;
      }
      current.processing = {
        ...queuedProcessing(current.processing),
        state: "idle",
        lastError: null,
        blockReason: null,
        userAction: "",
        dispatchState: "completed"
      };
      current.reviewedAt = reviewedAt;
      current.updatedAt = reviewedAt;
      current.lastModifiedBy = "codex";
      if (reviewInput.decision === "approved") {
        current.dataRevision = Number(current.dataRevision || 0) + 1;
        const dispatch = createCandidateDispatch(data, map, current, {
          nodeId: "M07",
          message: "B阶段已按统一门槛通过。请只继承A/B冻结数据完成当前SKU的C1事实、合规、Schema和SEO方案；不得重新访问Ozon/WB/1688，不得重新选择供应商，不得执行店铺写入",
          trigger: "b_passed_auto_c1",
          actor: "system"
        });
        dispatchId = dispatch.id;
      }
      const labels = { approved: "B阶段通过并自动进入C1", needsInfo: "需要用户补资料", eliminated: "淘汰" };
      addHistory(current, "codex", "reviewed", `Codex判断：${labels[reviewInput.decision]}`, reviewedAt);
      return publicCandidate(current, data.rules);
    });
    const data = dispatchId ? await readData() : null;
    const dispatch = dispatchId ? data.dispatches.find((item) => item.id === dispatchId) : null;
    json(res, 200, { candidate, dispatch: dispatchPublic(dispatch) });
    if (dispatchId && explicitDispatchDeliveryEnabled) {
      setTimeout(() => deliverDispatch(dispatchId).catch((error) => console.error("B通过后自动派发C1失败", error)), 0);
    }
    return;
  }

  const wbRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/wb-assessment$/);
  const listingReadbackRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/listing-readback$/);
  const lifecycleEReadbackRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/lifecycle\/e-readback$/);
  if (req.method === "POST" && lifecycleEReadbackRoute) {
    const input = await requestBody(req);
    const fields = ["dataRevision", "path", "sourceRecordId"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length ||
        fields.some(field => !Object.hasOwn(input, field)) || !Number.isInteger(input.dataRevision) ||
        !["system_created", "external_discovered"].includes(input.path) || typeof input.sourceRecordId !== "string" || !input.sourceRecordId.trim()) {
      throw httpError(400, "E请求只能引用已保存的来源记录；浏览器不能提交平台观察或验证结论");
    }
    if (input.path !== "system_created") return json(res, 503, { code: "trusted_e_readback_runtime_unavailable",
      message: "外部发现商品的可信回读尚未接通，已有记录保持原样。", externalRequests: 0, platformWrites: 0 });
    const before = await readData();
    const current = before.candidates.find(item => item.id === lifecycleEReadbackRoute[1]);
    const sku = current?.lifecycleV11?.skuPackage;
    if (sku?.dHandoff?.schemaVersion === "c2-d-handoff-v2" ||
        before.runtime?.softwareJobs?.some(job => job.candidateId === lifecycleEReadbackRoute[1] &&
          ["d_production_execution", "e_independent_readback"].includes(job.jobType))) {
      throw httpError(409, "当前商品已有保存的生产或核验任务，请查看原任务状态；旧回读入口不能重新执行。");
    }
    try {
      const outcome = await eReadbackSoftwareRuntime.run({ actor: runtimeIdentityProvider.resolveActor({ request: req }),
        input: { candidateId: lifecycleEReadbackRoute[1], expectedCandidateRevision: input.dataRevision, sourceRecordId: input.sourceRecordId } });
      const data = await readData();
      const status = { verified: 200, not_verified: 422, unknown_outcome: 502, not_applied: 409, idempotent_replay: 200 }[outcome.status];
      if (!status) throw new Error("E_READBACK_RUNTIME_RESULT_INVALID");
      return json(res, status, { candidate: publicCandidate(outcome.candidate, data.rules, {}, data.evidencePacks || [], data.currentCommissionCatalogs ?? []),
        readbackStatus: outcome.status, platformWrites: 0 });
    } catch (error) {
      if (error instanceof EReadbackRuntimeUnavailableError) return json(res, 503, { code: "trusted_e_readback_runtime_unavailable",
        message: "可信平台回读尚未接通，当前不能产生E验证记录。已有记录保持原样。", externalRequests: 0, platformWrites: 0 });
      throw error;
    }
  }
  if (req.method === "POST" && listingReadbackRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "自动上架回写必须提供当前数据修订号");
    }
    let listingRecord;
    try {
      listingRecord = validateListingReadback(input);
    } catch (error) {
      throw httpError(400, error.message);
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === listingReadbackRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.workflowStatus === "listed") {
        const existing = current.listingRecord || {};
        if (
          existing.platform === listingRecord.platform &&
          existing.productId === listingRecord.productId &&
          existing.merchantSku === listingRecord.merchantSku
        ) {
          return publicCandidate(current, data.rules);
        }
        throw httpError(409, "该候选已记录为另一个平台商品，不能自动覆盖");
      }
      if (current.workflowStatus !== "ready_to_list") {
        throw httpError(409, "只有待上架商品可以接收上架回读");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "候选资料已更新，旧上架回读不得覆盖新数据", {
          currentRevision: current.dataRevision
        });
      }
      if (current.listingHandoff?.owner && current.listingHandoff.owner !== "listing_task") {
        throw httpError(409, "该SKU尚未交给上架任务，不能自动标记已上架");
      }
      if (listingRecord.store !== current.targetStore) {
        throw httpError(409, "回读店铺与候选目标店铺不一致");
      }
      const expectedPlatform = current.targetStore === "wb" ? "wb" : "ozon";
      if (listingRecord.platform !== expectedPlatform) {
        throw httpError(409, "回读平台与候选目标平台不一致");
      }
      const timestamp = now();
      completeListing(current, listingRecord, "listing_task", timestamp);
      addHistory(
        current,
        "system",
        "listingReadbackCompleted",
        `上架任务真实回读完成：${listingRecord.platform.toUpperCase()} ${listingRecord.productId} · ${listingRecord.moderationStatus} · ${listingRecord.saleStatus}`,
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  const listedRoute = pathname.match(/^\/api\/candidates\/([^/]+)\/mark-listed$/);
  if (req.method === "POST" && listedRoute) {
    const input = await requestBody(req);
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "标记已上架必须提供当前数据修订号");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === listedRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      const explicitlyConfirmedAlreadyListed = input.confirmedAlreadyListed === true;
      const stateOnlyManualConfirmation = explicitlyConfirmedAlreadyListed &&
        ["ready_to_list", "listing_preparation"].includes(current.workflowStatus);
      if (current.workflowStatus !== "ready_to_list" && !stateOnlyManualConfirmation) {
        throw httpError(409, "只有待上架商品可以标记为已上架");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "商品资料已更新，请刷新后再确认已上架");
      }
      let listingRecord;
      try {
        listingRecord = validateListingRecord({
          ...input,
          store: input.store || current.targetStore
        }, { allowMissingIdentity: stateOnlyManualConfirmation });
        if (stateOnlyManualConfirmation) {
          listingRecord.confirmationSource = "user_explicit_confirmation";
          listingRecord.stateOnly = true;
        }
      } catch (error) {
        throw httpError(400, error.message);
      }
      const timestamp = now();
      completeListing(current, listingRecord, "user", timestamp);
      addHistory(
        current,
        "user",
        "markedListed",
        `自动回读不可用，手动确认上架：${listingRecord.platform.toUpperCase()} ${listingRecord.productId || listingRecord.productUrl}`,
        timestamp
      );
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  if (req.method === "POST" && wbRoute) {
    const input = await requestBody(req);
    if (!isTrustedInternalApiRequest(req.headers, internalApiRequestToken)) {
      throw httpError(403, "WB独立判断只能由受控内部回写提交");
    }
    if (!Number.isInteger(input.dataRevision)) {
      throw httpError(400, "WB判断必须提供当前数据修订号");
    }
    if (!["suitable", "notSuitable"].includes(input.status)) {
      throw httpError(400, "WB判断状态无效");
    }
    if (input.status === "notSuitable" && !input.reason?.trim()) {
      throw httpError(400, "WB不适合必须写明当前判断依据");
    }
    const candidate = await mutateData((data) => {
      const current = data.candidates.find((item) => item.id === wbRoute[1]);
      if (!current) throw httpError(404, "候选不存在");
      if (current.workflowStatus !== "ready_to_list") {
        throw httpError(409, "只有待上架商品才进行WB独立复算");
      }
      if (Number(current.dataRevision) !== input.dataRevision) {
        throw httpError(409, "WB判断时商品资料已变化，请刷新后重试", {
          currentRevision: current.dataRevision
        });
      }
      const assessment = { ...input, assessedAt: now() };
      const scenarioGate = promotionPricingGate(
        assessment.profitCalculation,
        data.rules.wbCrossListing
      );
      if (!scenarioGate.passed) {
        throw httpError(422, "WB利润必须保存20%、25%、30%促销对应建议标价，促销率不得从折后成交价二次扣除", {
          blockers: scenarioGate.blockers
        });
      }
      const gate = wbAssessmentDecisionGate(assessment, current, data.rules);
      if (!gate.passed) {
        throw httpError(422, "WB市场与利润判断不满足新规则", { blockers: gate.blockers });
      }
      current.wbAssessment = assessment;
      current.updatedAt = assessment.assessedAt;
      current.lastModifiedBy = "codex";
      addHistory(current, "codex", "wbAssessed", `WB独立判断：${input.status}`, assessment.assessedAt);
      return publicCandidate(current, data.rules);
    });
    return json(res, 200, { candidate });
  }

  return json(res, 404, { message: "接口不存在" });
}

async function serveFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  };
  let content;
  try {
    content = await fs.readFile(filePath);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
      throw httpError(404, "文件不存在", { code: "static_file_not_found" });
    }
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": types[extension] || "application/octet-stream",
    // This dashboard is an operational surface: serving a stale JavaScript bundle
    // can make a valid form submit without its current dataRevision. Always ask
    // the browser to revalidate app assets instead of retaining an old UI.
    "Cache-Control": extension === ".html" ? "no-cache" : "no-cache"
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = parseHttpRequestTarget(req.url, req.headers.host, {
      fallbackHost: `${host}:${port}`
    });
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
    if (pathname.startsWith("/product-images/")) {
      const filename = path.basename(pathname);
      return await serveFile(res, path.join(imagesDir, filename));
    }
    if (apiOnly) return json(res, 404, { message: "API服务仅处理/api和/product-images" });
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(distDir, requested);
    if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) {
      return json(res, 403, { message: "禁止访问" });
    }
    try {
      return await serveFile(res, filePath);
    } catch {
      return await serveFile(res, path.join(distDir, "index.html"));
    }
  } catch (error) {
    if (error instanceof OwnerIdentityError) {
      return json(res, error.statusCode, { code: error.code, message: error.message });
    }
    if (error.message === 'SIBLING_COLOR_BINDING_INVALID') {
      return json(res, 409, { code: error.message,
        message: '本规格的 10096 商品颜色或 10097 颜色名称未通过当前供应颜色绑定；请返回 C1 商品属性区补齐映射。',
        requiredAttributeIds: ['10096', '10097'], ownerAction: 'complete_c1_color_mapping',
        externalRequests: 0, paidCalls: 0, platformWrites: 0 });
    }
    return respondWithError(req, res, error);
  }
});

// Explicit consumers handle only persisted jobs. No configuration grants an external action.
await softwareJobStore.reconcileAfterRestart({jobTypes:['a_product_discovery','a_product_detail_read',
  'd_production_execution','e_d_platform_observation','e_independent_readback']});
// Before the first request is served, so no other write competes with it and no page can read a job that is already lost.
const lostCaptureJobs = await reconcileSourceCaptureJobsAfterRestart();
if (lostCaptureJobs?.length) {
  console.log(`1688采集作业已随服务重启收口为失败（不会再有结果，需要重新申请）：${lostCaptureJobs.join("、")}`);
}
// The same closure for the Ozon page read: its session also lived only in the process that is gone, and an open
// record would refuse every later read of that product through ozonPageReadAllowed.
const lostOzonPageReads = await reconcileOzonPageReadJobsAfterRestart();
if (lostOzonPageReads?.length) {
  console.log(`Ozon读页面作业已随服务重启收口为失败（不会再有结果，需要重新读一次）：${lostOzonPageReads.join("、")}`);
}
// The same closure for 找同款 (1688 and Ozon): a record still waiting on the extension would refuse every later search of that product.
const lostImageMatches = await reconcileImageMatchJobsAfterRestart();
const lostSeerfarWebRounds = await seerfarWebRounds.reconcileRoundsAfterRestart();
await storeSalesSeeds.reconcileReadsAfterRestart();
if (lostSeerfarWebRounds?.length) {
  console.log(`Seerfar 榜单作业已随服务重启收口为失败（不会再有结果，需要重新收一轮）：${lostSeerfarWebRounds.join("、")}`);
}
if (lostImageMatches?.length) {
  console.log(`找同款作业已随服务重启收口为失败（不会再有结果，需要重新找一次）：${lostImageMatches.join("、")}`);
}
server.listen(port, host, () => {
  if (runtimeConfiguration.dPlatformObservation.pumpIntervalMs !== null ||
      (runtimeConfiguration.eReadbackPumpIntervalMs !== null && runtimeConfiguration.deServiceBindings.length > 0)) deRuntimeServices.start();
  if (runtimeConfiguration.keywordEvidenceServiceBindings.length > 0) keywordEvidenceRuntimeServices.start();
  if (runtimeConfiguration.aDiscoveryServiceBindings.length > 0) aDiscoveryRuntime.start();
  if (runtimeConfiguration.aProductDetailServiceBindings.length > 0) aProductDetailRuntime.start();
  runtimeHealth.markListening();
  console.log(`全店经营工作台${apiOnly ? " API" : ""}：http://${host}:${port}`);
});

function closeServer() {
  codexDispatcher?.close();
  Promise.allSettled([runtimeHealth.close(), deRuntimeServices.stop(), keywordEvidenceRuntimeServices.stop(), aDiscoveryRuntime.stop(), aProductDetailRuntime.stop(), c1ImageTextUseCase.stop()]).then(results => {
    const failed = results.some(result => result.status === "rejected");
    if (failed) console.error("SOFTWARE_RUNTIME_SHUTDOWN_FAILED: 作业停止结果需要核对。");
    server.close(() => process.exit(failed ? 1 : 0));
  });
}

process.once("SIGTERM", closeServer);
process.once("SIGINT", closeServer);

export { server };
