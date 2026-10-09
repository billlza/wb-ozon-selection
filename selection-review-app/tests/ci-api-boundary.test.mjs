import assert from "node:assert/strict";
import test from "node:test";
import { assertIsolatedApiTestEnvironment } from "../scripts/ci-api-boundary.mjs";
import { API_PROCESS_TESTS, SOURCE_CONTRACT_TESTS, SUBPROCESS_TESTS, ISOLATED_TESTS } from "../scripts/ci-test-suites.mjs";

function isolatedEnvironment() {
  return {
    platform: "linux", uid: 1000,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", CI: "true", GITHUB_ACTIONS: "true",
      CI_API_TESTS: "isolated-container", NODE_OPTIONS: "--throw-deprecation",
      SELECTION_REVIEW_AUTO_DELIVER: "off", SELECTION_REVIEW_CODEX_DISPATCH: "off",
    },
    interfaces: { lo: [{ address: "127.0.0.1", internal: true }, { address: "::1", internal: true }] },
  };
}

test("API test inventory contains every separately isolated suite once", () => {
  assert.deepEqual([...API_PROCESS_TESTS].sort(), [
    "a-discovery-api-boundary.test.mjs", "a-product-detail-api-boundary.test.mjs", "a-supplier-image-search-api.test.mjs",
    "b-exact-commission-recalculation-http.test.mjs", "c1-completed-editorial-api.test.mjs",
    "c1-draft-result-read-api.test.mjs", "c1-editorial-review-api.test.mjs", "c1-keyword-handoff-retry-http.test.mjs",
    "c1-local-content-flow-api.test.mjs", "c1-local-preparation-api.test.mjs", "c1-paid-draft-owner-api.test.mjs",
    "c2-upload-api.test.mjs", "collaboration-api.test.mjs", "d-batch-import-api.test.mjs", "d-e-saved-continuation-api.test.mjs", "dispatch-api.test.mjs",
    "dispatch-delivery-integration.test.mjs", "extension-heartbeat-api.test.mjs", "final-pricing-review-api.test.mjs",
    "keyword-evidence-runtime-http.test.mjs",
    "lifecycle-c-stage-generic-api.test.mjs", "lifecycle-e-readback-generic-api.test.mjs",
    "local-owner-access-api.test.mjs", "ozon-account-preparation-api-boundary.test.mjs", "ozon-account-read-api-boundary.test.mjs",
    "ozon-sales-capture-api.test.mjs", "phase-2a-api-guards.test.mjs", "production-owner-decision-api.test.mjs", "real-a-b-c1-api.test.mjs",
    "recovery-classification.test.mjs", "runtime-health-api.test.mjs", "runtime-package-api.test.mjs", "seerfar-software-api-guard.test.mjs", "sibling-batch-c1-preview-api.test.mjs", "sibling-batch-commercial-api.test.mjs", "sibling-c1-color-api.test.mjs", "sibling-sku-api.test.mjs",
    "source-capture-api.test.mjs", "source-capture-job-api.test.mjs", "source-capture-recapture-api.test.mjs",
    "source-capture-restart-reconciliation.test.mjs", "source-capture-review-api.test.mjs",
    "store-binding-api.test.mjs", "structured-dispatch-integration.test.mjs",
    "supplier-draft-api.test.mjs", "sibling-preparation-api.test.mjs"
  ].sort());
  assert.equal(new Set(ISOLATED_TESTS).size, API_PROCESS_TESTS.length + SOURCE_CONTRACT_TESTS.length + SUBPROCESS_TESTS.length);
  assert.equal(Object.isFrozen(API_PROCESS_TESTS), true);
});

test("minimal non-root isolated Linux test environment is accepted", () => {
  assert.doesNotThrow(() => assertIsolatedApiTestEnvironment(isolatedEnvironment()));
});

test("API runner rejects local, root, unapproved and missing identity environments", () => {
  for (const change of [{ platform: "darwin" }, { uid: 0 }, { uid: undefined }, { env: {} }]) {
    assert.throws(() => assertIsolatedApiTestEnvironment({ ...isolatedEnvironment(), ...change }), /REQUIRE_ISOLATED_GITHUB_RUNNER/);
  }
  const value = isolatedEnvironment();
  delete value.env.CI_API_TESTS;
  assert.throws(() => assertIsolatedApiTestEnvironment(value), /REQUIRE_ISOLATED_GITHUB_RUNNER/);
});

test("API runner rejects inherited environment and enabled production defaults", () => {
  for (const change of [{ EXTRA_VALUE: "unexpected" }, { SELECTION_REVIEW_AUTO_DELIVER: "on" },
    { SELECTION_REVIEW_CODEX_DISPATCH: "on" }, { NODE_OPTIONS: "" }]) {
    const value = isolatedEnvironment();
    Object.assign(value.env, change);
    assert.throws(() => assertIsolatedApiTestEnvironment(value), /ENVIRONMENT_NOT_MINIMAL/);
  }
});

test("API runner rejects external interfaces even with otherwise correct flags", () => {
  for (const interfaces of [{}, { eth0: [{ address: "172.17.0.2", internal: false }] },
    { lo: [{ address: "10.0.0.1", internal: true }] }]) {
    assert.throws(() => assertIsolatedApiTestEnvironment({ ...isolatedEnvironment(), interfaces }), /NETWORK_NOT_ISOLATED/);
  }
});
