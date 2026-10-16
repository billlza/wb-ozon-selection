import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createFormalC1C2Fixture } from "./fixtures/formal-c1-flow-fixture.mjs";

test("C1当前持久回执由唯一事务原子合并并创建C2软件容器，不停在旧C1状态", async () => {
  const [server, runtime, usecase, transaction] = await Promise.all([
    "../server.mjs", "../lib/c1-draft-software-runtime.mjs", "../lib/c1-draft-software-use-case.mjs", "../lib/business-mutation-transaction.mjs"
  ].map(relative => readFile(new URL(relative, import.meta.url), "utf8")));
  assert.match(server, /await c1DraftRuntimeServices\.continueSavedCurrent\(\{ candidateId, expectedRevision: savedJobRef\.resultRevision, jobId: savedJobRef\.jobId \}\)/);
  assert.match(runtime, /return useCase\.runSaved\(/);
  assert.match(usecase, /await useCase\.apply\(/);
  assert.match(usecase, /softwareJobApplicationEffect: effect/);
  const start = transaction.indexOf("function applySavedC1Draft(");
  const end = transaction.indexOf("function assertC1PaidKeywordExecution(", start);
  assert.ok(start >= 0 && end > start);
  const application = transaction.slice(start, end);
  assert.match(application, /job\.revision !== candidate\.dataRevision/);
  assert.match(application, /readCompletedC1AiSoftwareJobResult\(job\)/);
  assert.match(application, /assertCurrentC1AiDraftRequest\(\{ skuPackage, request \}\)/);
  assert.match(application, /mergeC1AiDraftReceipt\(/);
  assert.match(application, /createC2SoftwareContainer\(\{/);
  assert.match(application, /assetRegions: \{ collected: \[\], aiDrafts: \[\], finalUploads: \[\] \}/);
  assert.match(application, /job\.resultEnvelope\.applicationDisposition = "applied"/);
  assert.match(transaction, /const transaction = includeMerchantSkuClaims \? work => repository\.transact\(work\)\s*: work => repository\.transactCandidates\(\[targetCandidateId\], work\);\s*return transaction\(async \(document\) => \{[\s\S]*applySavedC1Draft\(document, current, applicationEffect/);
  assert.doesNotMatch(application, /createProductionAuthorization|createProductionPlan|createCandidateDispatch|fetch\(/);
  assert.doesNotMatch(server, /current\.lifecycleV11\.status = "c1_ai_draft_ready"/);

  const { c2 } = createFormalC1C2Fixture();
  assert.equal(c2.state, "c2_waiting_final_uploads");
  assert.equal(c2.skuPackage.businessPhase, "C2");
  assert.equal(c2.ownerAction, "provide_final_assets");
  assert.equal(c2.productionAuthorizationCreated, false);
  assert.equal(c2.dHandoffCreated, false);
  assert.equal(c2.skuPackage.productionAuthorization, null);
  assert.deepEqual(c2.c2AssetLifecycle.assets, { collected: [], aiDrafts: [], finalUploads: [] });
});

test("主人一次确认最终素材时锁定manifest并生成确认卡，但不创建生产授权", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /prepareC2FinalUploadManifest\(\{/);
  assert.match(server, /confirmC2SoftwareFinalUploads\(\{/);
  assert.match(server, /approvedManifestSha256: manifest\.manifestSha256/);
  assert.match(server, /createFinalProductPlanConfirmationCard\(\{/);
  assert.match(server, /未创建生产授权，零平台写入/);
});

test("活动C2软件模块没有火车、固定SKU、件数、价格或图片路径默认值", async () => {
  const sources = await Promise.all([
    "../lib/c2-asset-lifecycle.mjs",
    "../lib/c2-software-orchestrator.mjs"
  ].map((relative) => readFile(new URL(relative, import.meta.url), "utf8")));
  const combined = sources.join("\n");
  for (const forbidden of ["CX-20260803-010", "4993364145574", "282件", "Паровоз", "1831", "151.78", "小猴子做图产出物"]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
});
