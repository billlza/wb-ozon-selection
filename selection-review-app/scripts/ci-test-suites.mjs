export const API_PROCESS_TESTS = Object.freeze([
  "runtime-health-api.test.mjs",
  "sibling-preparation-api.test.mjs",
  "c1-completed-editorial-api.test.mjs",
  "c1-editorial-review-api.test.mjs",
  "c1-draft-result-read-api.test.mjs",
  "c1-local-content-flow-api.test.mjs",
  "c1-local-preparation-api.test.mjs",
  "sibling-c1-color-api.test.mjs",
  "sibling-batch-c1-preview-api.test.mjs",
  "sibling-sku-api.test.mjs",
  "sibling-batch-commercial-api.test.mjs",
  "a-discovery-api-boundary.test.mjs",
  "a-product-detail-api-boundary.test.mjs",
  "a-supplier-image-search-api.test.mjs",
  "b-exact-commission-recalculation-http.test.mjs",
  "c1-keyword-handoff-retry-http.test.mjs",
  "keyword-evidence-runtime-http.test.mjs",
  "c1-paid-draft-owner-api.test.mjs",
  "local-owner-access-api.test.mjs",
  "production-owner-decision-api.test.mjs",
  "ozon-account-read-api-boundary.test.mjs",
  "ozon-account-preparation-api-boundary.test.mjs",
  "d-e-saved-continuation-api.test.mjs",
  "d-batch-import-api.test.mjs",
  "final-pricing-review-api.test.mjs",
  "runtime-package-api.test.mjs",
  "store-binding-api.test.mjs",
  "supplier-draft-api.test.mjs",
  "c2-upload-api.test.mjs",
  "collaboration-api.test.mjs",
  "dispatch-api.test.mjs",
  "dispatch-delivery-integration.test.mjs",
  "extension-heartbeat-api.test.mjs",
  "lifecycle-c-stage-generic-api.test.mjs",
  "lifecycle-e-readback-generic-api.test.mjs",
  "ozon-sales-capture-api.test.mjs",
  "phase-2a-api-guards.test.mjs",
  "real-a-b-c1-api.test.mjs",
  "recovery-classification.test.mjs",
  "seerfar-software-api-guard.test.mjs",
  "source-capture-api.test.mjs",
  "source-capture-job-api.test.mjs",
  "source-capture-recapture-api.test.mjs",
  "source-capture-restart-reconciliation.test.mjs",
  "source-capture-review-api.test.mjs",
  "structured-dispatch-integration.test.mjs",
  "supplier-image-match-api.test.mjs",
  "intake-api.test.mjs",
]);

export const SOURCE_CONTRACT_TESTS = Object.freeze([
  "c1-attribute-routes-source-contract.test.mjs",
  "c1-fact-keyword-server-integration.test.mjs",
  "c1-k3-runtime-bridge.test.mjs",
  "c2-stable-asset-transport-use-case.test.mjs",
  "cross-stage-contract-schema.test.mjs",
  "multi-user-central-runtime.test.mjs",
  "phase3-ab-deployment-boundary.test.mjs",
  "phase4-c1-deployment-boundary.test.mjs",
  "phase4-c1-software-boundary.test.mjs",
  "phase5-c2-deployment-boundary.test.mjs",
  "phase5-c2-software-boundary.test.mjs",
  "phase5b-c2-ui-deployment-boundary.test.mjs",
  "runtime-configuration.test.mjs",
  "seerfar-software-server-integration.test.mjs",
  "store-registry-api.test.mjs",
  "three-store-map-api.test.mjs",
  "three-store-map-ui-contract.test.mjs",
  "three-store-map.test.mjs"
]);

export const SUBPROCESS_TESTS = Object.freeze([
  "runtime-preflight-api.test.mjs",
  "aliyun-oss-runtime-deployment-boundary.test.mjs",
  "c2-software-orchestrator.test.mjs",
  "launch-command-script.test.mjs"
]);

export const ISOLATED_TESTS = Object.freeze([...API_PROCESS_TESTS, ...SOURCE_CONTRACT_TESTS, ...SUBPROCESS_TESTS]);

export const BUILT_RUNTIME_TESTS = Object.freeze([
  "runtime-package-api.test.mjs", "runtime-preflight-api.test.mjs", "aliyun-oss-runtime-deployment-boundary.test.mjs"
]);
