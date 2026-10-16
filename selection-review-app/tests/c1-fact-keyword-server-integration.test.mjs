import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("4317只允许服务端单SKU软件作业进入事实关键词原子保存并续接4318 C1编排", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const useCase = await readFile(new URL("../lib/c1-keyword-software-use-case.mjs", import.meta.url), "utf8");
  assert.match(server, /prepareC1FactKeywordRuntime/);
  assert.match(server, /buildC1FactKeywordAtomicPatch/);
  assert.match(useCase, /prepareC1KeywordSoftwareExecution\(\{/);
  assert.match(server, /enqueueC1PaidKeywordEvidenceJob\(\{/);
  assert.match(server, /runC1KeywordEvidenceSoftwareJob\(c1KeywordEvidenceSoftwareRoute\[1\], input, req\)/);
  assert.match(server, /prepareAndContinueC1FactKeywordEvidence\(candidateId, outcome\.reuseInput\)/);
  assert.match(server, /current\.lifecycleV11 = patch\.lifecycleV11/);
  assert.match(server, /continueC1SoftwareWhenEvidenceReady\(candidateId, staged\.nextRevision\)/);
  assert.match(server, /旧C1事实关键词注入入口已停用/);
  assert.doesNotMatch(server, /runKeywordEvidenceSoftwareJob|keywordSoftwareCompletion:/);
  assert.match(server, /onEvidenceReady: \(candidateId, revision\) => continueC1SoftwareWhenEvidenceReady\(candidateId, revision, \{ reportConfigurationBlock: true \}\)/);
});

test("B交接后的C1续接由服务端先生产关键词准备证据，客户端不能注入来源证据", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const helperStart = server.indexOf("async function continueC1SoftwareWhenEvidenceReady");
  const helperEnd = server.indexOf("\nasync function prepareAndContinueC1FactKeywordEvidence", helperStart);
  const helper = server.slice(helperStart, helperEnd);
  assert.match(helper, /runC1KeywordPlanningEvidenceProduction\(\{/);
  assert.match(helper, /repository: businessStateRepository/);
  assert.match(helper, /codexOffline: true/);
  assert.match(server, /readinessReceipt\.gaps/);
  assert.match(server, /readinessReceipt\.resultCandidateRevision === candidate\.dataRevision/);
  assert.ok(helper.indexOf("runC1KeywordPlanningEvidenceProduction") < helper.indexOf("c1DraftRuntimeServices.prepareCurrent"));
  assert.match(helper, /source\.lifecycleV11\?\.c1SoftwareEvidenceV1/);
  assert.match(helper, /C1KeywordContinuationRevisionConflictError/);
  assert.doesNotMatch(helper, /req\.|input\.serverEvidence|queueUserDispatch|playwright|control-chrome|computer-use/);
});

test("K1/K2软件结果只由当前服务端作业内部续接，不接受外部就绪事件注入", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /acceptC1KeywordEvidenceReadyEvent/);
  assert.match(server, /continueC1FromKeywordEvidenceReadyEvent\(candidateId, event\)/);
  assert.match(server, /prepareAndContinueC1FactKeywordEvidence\(candidateId, accepted\.runtimeInput, \{/);
  assert.match(server, /旧关键词就绪事件注入入口已停用/);
  const helperStart = server.indexOf("async function continueC1FromKeywordEvidenceReadyEvent");
  const helperEnd = server.indexOf("\nfunction responseState", helperStart);
  const helper = server.slice(helperStart, helperEnd);
  assert.doesNotMatch(helper, /keywordSoftwareCompletion:|queueUserDispatch|deliverDispatch|automationStarted\s*=\s*true|playwright|control-chrome/);
});

test("不完整证据在共享数据写入前停止，完整结果才一次保存五个关联对象", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const persistence = await readFile(new URL("../lib/c1-fact-keyword-persistence.mjs", import.meta.url), "utf8");
  const helperStart = server.indexOf("async function prepareAndContinueC1FactKeywordEvidence");
  const helperEnd = server.indexOf("\nfunction responseState", helperStart);
  const helper = server.slice(helperStart, helperEnd);
  const notReady = helper.indexOf('prepared.result.status !== "ready_for_atomic_persist"');
  const mutation = helper.indexOf("const staged = await mutateCandidateData(candidateId,");
  assert.ok(notReady >= 0 && mutation > notReady);
  for (const field of [
    "skuPackage",
    "keywordEvidencePreparationV1",
    "k3KeywordEvidenceSnapshotV1",
    "k3CurrentBindingV1",
    "c1SoftwareEvidenceV1",
    "c1FactKeywordRuntimeReceiptV1"
  ]) assert.ok(persistence.includes(field), field);
  assert.match(helper, /current\.dataRevision = patch\.nextRevision/);
  assert.doesNotMatch(helper, /queueUserDispatch|createPlatformDraft|automationStarted\s*=\s*true/);
});

test("活动接缝没有火车、固定SKU、件数、价格或浏览器兜底", async () => {
  const sources = await Promise.all([
    "../lib/c1-fact-keyword-pipeline.mjs",
    "../lib/c1-fact-keyword-runtime.mjs",
    "../lib/c1-fact-keyword-persistence.mjs"
  ].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  const combined = sources.join("\n");
  for (const forbidden of ["CX-20260803-010", "4993364145574", "282件", "Паровоз", "1831", "151.78", "playwright", "control-chrome", "computer-use"]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
});
