import test from "node:test";
import assert from "node:assert/strict";
import { createSavedConditionalBFixture, currentOtherCosts, savedGuooRouteComparison,
  FIXTURE_FROZEN_ROUTE, FIXTURE_LOGISTICS_RULE_VERSION } from "./fixtures/real-a-b-flow-fixture.mjs";
import { GuooRouteComparisonError, assertGuooComparisonReadyForEvidence,
  assertGuooComparisonFrozenForEvidenceRefresh } from "../lib/guoo-route-comparison.mjs";
import { runLifecycleBEvidencePreparation } from "../lib/lifecycle-b-evidence-preparation.mjs";
import { commitLifecycleBFeeEvidenceRefresh } from "../lib/lifecycle-b-evidence-runtime.mjs";
import { createLifecycleBEvidenceProviderRegistry } from "../lib/lifecycle-b-evidence-providers.mjs";
import { buildExpectedEvidenceScope, evidenceScopeMatches } from "../lib/lifecycle-evidence-scope.mjs";
import { prepareSavedConditionalBExactInputs, BExactCommissionRecalculationError } from "../lib/real-a-b-c1-flow.mjs";

/**
 * 主人第一件真货停在的那个位置，和把它拉出来的那两次点击。
 *
 * 现场（`candidate:f2e447df-…`，dataRevision 33）：类目已经冻成平台身份 `ozon:17028966:96063`，可它
 * 唯一那份佣金证据还挂在读取时的类目路径上，Schema 也一样——两份都成了孤儿。于是「用更好的费用证据
 * 重算」永远是 `B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE`，而软件按设计不会自己去读。
 *
 * 这里用合成夹具复现同一个形状（冻结之后把类目换成平台身份键，证据留在旧路径上），然后走完那两步：
 * 先重读一次费用证据，再复算。钉住的是四件事：新证据和候选同键、已冻结的东西一个字节都没动、
 * 利润结论没变、以及**重读完了复算是 ready 而不是当场过期**。
 */

const RULE_VERSION = FIXTURE_LOGISTICS_RULE_VERSION;
const FROZEN_ROUTE = FIXTURE_FROZEN_ROUTE;
/** r24 冻下来的那一种键：平台身份，不是类目路径。证据包还挂在读取时的路径上，就成了孤儿。 */
const PLATFORM_CATEGORY_TOKEN = "ozon:17028966:96063";
const REFRESHED_AT = "2026-08-18T03:00:00.000Z";
const CATALOG_SHA256 = "be7832ff".repeat(8);
const CATALOG_EFFECTIVE_FROM = "2025-12-01";

/**
 * 现场那件商品的形状：已冻结、停在条件测算、线路比较就落在当前这一版上，而佣金和 Schema 是孤儿。
 */
async function strandedScenario() {
  const fixture = await createSavedConditionalBFixture();
  const candidate = fixture.candidate;
  candidate.guooRouteComparisonsV1 = [savedGuooRouteComparison(candidate.id, candidate.dataRevision - 1)];
  candidate.lifecycleEvidenceContextV11.category = PLATFORM_CATEGORY_TOKEN;
  assert.equal(fixture.document.candidates[0], candidate);
  return fixture;
}

const FIXTURE_OTHER_COSTS = Object.freeze({
  packagingRmb: 1.5, labelRmb: 1.5, fixedOtherRmb: 0, advertisingRate: 0, returnReserveRate: 0,
  damageReserveRate: 0.05, withdrawalFeeRate: 0.02, targetMarginRate: 0.15, minimumUnitProfitRmb: 20,
  priceIncrementCny: 1, thresholdLogic: "any",
  pricingPolicyVersion: "ozon-wb-global-pricing-2026-08-21-v3-project-or-threshold-v1"
});

/** 本机只读来源的桩：读回来的就是官方费率表上那条类目的公开费率，不碰任何外部接口。 */
function stubProviders({ requests = [] } = {}) {
  const otherCosts = structuredClone(FIXTURE_OTHER_COSTS);
  return createLifecycleBEvidenceProviderRegistry({
    commission: async (request) => {
      requests.push(structuredClone(request));
      return {
        current: true,
        scope: structuredClone(request.scope),
        sourceType: "ozon_official_commission_table",
        sourceRef: `ozon-official-commission:${CATALOG_EFFECTIVE_FROM}:sha256:${CATALOG_SHA256}:le1500`,
        checkedAt: REFRESHED_AT,
        expiresAt: "2026-08-19T03:00:00.000Z",
        commissionCatalogRef: { effectiveFrom: CATALOG_EFFECTIVE_FROM, fileSha256: CATALOG_SHA256,
          sourceUrl: "https://cdn.ozone.ru/s3/utils-common/Tarifs_CN_01_12_2025_1761720496.xlsx", priceTier: "le1500",
          matchedRow: { typeRu: "Одежда для животных", typeZh: "宠物服装", mpCategoryZh: "宠物用品" } },
        evidenceData: {
          commissionRate: 0.12,
          commissionEvidenceMode: "official_reference",
          officialCommissionBinding: { schemaVersion: "ozon-official-commission-binding-v1",
            candidateId: request.candidateId, candidateRevision: request.candidateRevision, priceRub: 1455 },
          estimateAuthorized: false,
          exactCommissionRequiredAtC: true,
          descriptionCategoryId: 17028966,
          typeId: 96063,
          otherCosts: structuredClone(otherCosts)
        }
      };
    },
    schema: async (request) => {
      requests.push(structuredClone(request));
      return {
        current: true,
        scope: structuredClone(request.scope),
        sourceType: "ozon_local_evidence_service",
        sourceRef: "ozon-schema:refresh",
        checkedAt: REFRESHED_AT,
        expiresAt: "2026-08-19T03:00:00.000Z",
        evidenceData: { schemaRevision: "2026-08-18", requiredFields: [], descriptionCategoryId: 17028966, typeId: 96063 }
      };
    }
  });
}

/** 重读那一步在服务端做的全部事情：跑一遍只读准备，然后只往 evidencePacks 里提交。候选记录一个字都不碰。 */
async function refreshFeeEvidence(document, { plannedAt = REFRESHED_AT, providers } = {}) {
  const candidate = document.candidates[0];
  assertGuooComparisonFrozenForEvidenceRefresh(candidate, RULE_VERSION);
  const run = await runLifecycleBEvidencePreparation({
    candidate, evidencePacks: document.evidencePacks, currentCommissionCatalogs: document.currentCommissionCatalogs ?? [],
    providers, plannedAt, preparedAt: plannedAt
  });
  assert.equal(run.status, "completed", JSON.stringify(run.failure));
  // 服务端在事务里调用的就是这一个函数：它自己保证候选记录逐字节不变，改了就抛。
  const committed = run.evidencePacksToCommit.length === 0 ? [] : commitLifecycleBFeeEvidenceRefresh(document,
    candidate.id, run.evidencePacksToCommit, { createdAt: plannedAt,
      currentCommissionCatalogs: document.currentCommissionCatalogs ?? [], createdBy: "owner_b_evidence_refresh" });
  return { run, committed };
}

function recalculationReadiness(document, { processedAt = REFRESHED_AT } = {}) {
  const candidate = document.candidates[0];
  try {
    prepareSavedConditionalBExactInputs({ candidate, evidencePacks: document.evidencePacks,
      currentCommissionCatalogs: document.currentCommissionCatalogs ?? [],
      otherCosts: currentOtherCosts(candidate), processedAt });
    return "ready";
  } catch (error) {
    if (!(error instanceof BExactCommissionRecalculationError)) throw error;
    return error.code;
  }
}

test("孤儿证据的已冻结商品能重读一次费用证据，新证据和这件商品自己的适用范围同键", async () => {
  const { document } = await strandedScenario();
  const candidate = document.candidates[0];
  // 重读之前：那份佣金证据挂在旧类目上，复算根本无路可走。
  assert.equal(recalculationReadiness(document), "B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE");

  const requests = [];
  const { run, committed } = await refreshFeeEvidence(document, { providers: stubProviders({ requests }) });

  // 只读了该读的那两样：佣金和 Schema。线路资费和汇率还是当期的，原样复用，没有重新读过。
  assert.deepEqual(run.plan.actions.filter(a => a.action === "prepare_once").map(a => a.kind).sort(), ["commission", "schema"]);
  assert.deepEqual(run.plan.actions.filter(a => a.action === "reuse").map(a => a.kind).sort(), ["exchange_rate", "logistics_tariff"]);
  assert.deepEqual(run.providerCalls.map(call => call.kind).sort(), ["commission", "schema"]);
  assert.equal(run.platformWrites, 0);
  assert.equal(committed.length, 2);

  // 这一条就是 r25 立下的不变量：读回来的每一份都必须和候选自己的适用范围同键，否则又是一份孤儿。
  const context = candidate.lifecycleEvidenceContextV11;
  for (const pack of committed) {
    const expected = buildExpectedEvidenceScope(pack.kind, {
      platform: "ozon", store: candidate.targetStore, storeRef: candidate.storeRef,
      category: context.category, salesScheme: context.salesScheme, schemaRuleVersion: context.schemaRuleVersion
    });
    assert.ok(evidenceScopeMatches(pack.kind, pack.scope, expected), `${pack.kind} 必须和候选同键`);
    assert.equal(pack.scope.category, PLATFORM_CATEGORY_TOKEN);
    assert.equal(pack.createdBy, "owner_b_evidence_refresh");
  }
  // 提供器拿到的适用范围也是候选自己的那一份——同键是在读之前就定死的，不是读回来之后再修。
  for (const request of requests) assert.equal(request.scope.category, PLATFORM_CATEGORY_TOKEN);

  // 旧的那两份孤儿没有被改写成别的范围，也没有被删：它们是历史，只是再也选不中。
  const orphans = document.evidencePacks.filter(pack => pack.scope?.category === "music-box");
  assert.equal(orphans.length, 2);
  assert.ok(orphans.every(pack => pack.status === "active"));
});

test("重读不改动任何已冻结的东西：SKU包、供货确认、线路比较、版本号，逐字节不变", async () => {
  const { document } = await strandedScenario();
  const before = JSON.parse(JSON.stringify(document.candidates[0]));
  const frozenBytes = JSON.stringify(before);

  await refreshFeeEvidence(document, { providers: stubProviders() });

  const after = document.candidates[0];
  assert.equal(JSON.stringify(after), frozenBytes, "整条候选记录逐字节不变");
  // 逐项再点一次名，坏掉的时候能一眼看出坏在哪一项上。
  assert.deepEqual(after.lifecycleV11.skuPackage, before.lifecycleV11.skuPackage);
  assert.deepEqual(after.lifecycleV11.ownerSupplyConfirmation, before.lifecycleV11.ownerSupplyConfirmation);
  assert.deepEqual(after.lifecycleV11.bSystemEvidenceBundle, before.lifecycleV11.bSystemEvidenceBundle);
  assert.deepEqual(after.guooRouteComparisonsV1, before.guooRouteComparisonsV1, "线路比较没有重跑，也没有多出一条");
  assert.equal(after.guooRouteComparisonsV1.length, 1);
  assert.deepEqual(after.executionRuntime, before.executionRuntime);
  assert.equal(after.dataRevision, before.dataRevision, "重读绝不涨版本号");
  // 已冻结的运费和线路：它们是从 SKU 包里读出来的，重读一次之后还是同一个数。
  assert.equal(after.lifecycleV11.bSystemEvidenceBundle.logisticsEvidence.route, FROZEN_ROUTE);
  assert.deepEqual(after.lifecycleV11.skuPackage.selectedSupplySnapshot, before.lifecycleV11.skuPackage.selectedSupplySnapshot);
});

test("重读不改利润结论：仍然是那份估算佣金算出来的条件测算", async () => {
  const { document } = await strandedScenario();
  const candidate = document.candidates[0];
  const before = structuredClone(candidate.lifecycleV11.skuPackage.profitModels);

  await refreshFeeEvidence(document, { providers: stubProviders() });

  assert.deepEqual(candidate.lifecycleV11.skuPackage.profitModels, before, "利润记录不许多一份，也不许改一份");
  const active = candidate.lifecycleV11.skuPackage.profitModels.at(-1);
  assert.equal(active.calculationType, "conditional");
  assert.equal(active.commissionMode, "estimated");
  assert.equal(candidate.lifecycleV11.status, "b_conditional_awaiting_exact_commission");
  assert.equal(candidate.executionRuntime.businessPhase, "B");
  assert.equal(candidate.executionRuntime.technicalFailure.status, "stopped");
  assert.equal(candidate.lifecycleV11.c1Handoffs.length, 0, "没有进C1");
  // 结论要变，只能是主人再点一次重算——那是下一条测试的事。
});

/**
 * 这一条最重要：重读完了，复算必须是 ready，不是当场过期。
 *
 * 版本号在这两步之间有两处钉死：`technicalFailure.sourceRevision`/`executionRuntime` 的那一组必须
 * 等于当前 `dataRevision`；官方费率表命中行里的 `officialCommissionBinding.candidateRevision` 也必须
 * 等于当前 `dataRevision`。所以重读这一步**必须**原地不涨版本——涨一格，这两处同时失效，刚读回来的
 * 证据会把自己顶过期。下面正反两边都钉：不涨版本时 ready，涨了版本就当场不可用。
 */
test("重读之后复算是 ready；把版本顶高一格，刚读回来的证据当场把自己顶过期", async () => {
  const { document } = await strandedScenario();
  const candidate = document.candidates[0];
  const revision = candidate.dataRevision;

  await refreshFeeEvidence(document, { providers: stubProviders() });

  assert.equal(candidate.dataRevision, revision, "重读这一步原地不涨版本");
  assert.equal(recalculationReadiness(document), "ready", "重读完了，复算这一步必须当场可用");

  // 反过来：如果重读那一步把版本顶高了一格（昨天栽的就是这个），复算立刻不可用。
  const bumped = structuredClone(document);
  bumped.candidates[0].dataRevision = revision + 1;
  assert.equal(recalculationReadiness(bumped), "B_EXACT_RECALCULATION_NOT_AVAILABLE");

  // 就算把停止记录和运行时那一组也一起顶上去，官方费表那份绑定仍然钉在读它的那一版上。
  const rekeyed = structuredClone(bumped);
  const runtime = rekeyed.candidates[0].executionRuntime;
  runtime.technicalFailure.sourceRevision = revision + 1;
  runtime.inputRevision = revision;
  runtime.outputRevision = revision + 1;
  assert.equal(recalculationReadiness(rekeyed), "B_EXACT_RECALCULATION_EVIDENCE_UNAVAILABLE");
});

test("重读之后真的复算得动：正式B通过，进C1，用的是官方费率表那条公开费率", async () => {
  const { document } = await strandedScenario();
  const candidate = document.candidates[0];
  await refreshFeeEvidence(document, { providers: stubProviders() });

  const prepared = prepareSavedConditionalBExactInputs({ candidate, evidencePacks: document.evidencePacks,
    otherCosts: currentOtherCosts(candidate), processedAt: REFRESHED_AT });
  assert.equal(prepared.evidence.platformFeeEvidence.commissionEvidenceMode, "official_reference");
  assert.equal(prepared.evidence.platformFeeEvidence.commissionRate, 0.12);
  // 复算用的是新读回来的那一份，不是那份孤儿。
  assert.notEqual(prepared.evidence.platformFeeEvidence.evidenceId,
    candidate.lifecycleV11.bSystemEvidenceBundle.platformFeeEvidence.evidenceId);
  // 冻结的线路和运费原样带进新输入包：重读没有换过线路。
  assert.equal(prepared.evidence.logisticsEvidence.route, FROZEN_ROUTE);
  assert.equal(prepared.evidence.logisticsEvidence.amountRmb,
    candidate.lifecycleV11.bSystemEvidenceBundle.logisticsEvidence.amountRmb);
  assert.equal(prepared.skuPackage.businessPhase, "B");
});

test("那道 FROZEN_CANDIDATE_REVIEW_REQUIRED 守卫在它本该守的场景里仍然拦得住", async () => {
  const { document } = await strandedScenario();
  const candidate = document.candidates[0];

  // 一、已冻结的商品照旧走不了那条会重算线路的老路——这道闸门一个字都没松。
  assert.throws(() => assertGuooComparisonReadyForEvidence(candidate, RULE_VERSION),
    (error) => error instanceof GuooRouteComparisonError && error.code === "FROZEN_CANDIDATE_REVIEW_REQUIRED");

  // 二、老路对没冻结的商品照旧放行，别的检查也照旧全在。
  const unfrozen = structuredClone(candidate);
  unfrozen.lifecycleV11.skuPackage = null;
  assert.equal(assertGuooComparisonReadyForEvidence(unfrozen, RULE_VERSION).selectedRoute, FROZEN_ROUTE);
  for (const [mutate, code] of [
    [c => { c.guooRouteComparisonsV1 = []; }, "COMPARISON_REQUIRED"],
    [c => { c.dataRevision += 1; }, "SAVED_RESULT_STALE"],
    [c => { c.guooRouteComparisonsV1 = [savedGuooRouteComparison(c.id, c.dataRevision - 1, { declared: false })]; }, "TRANSPORT_EVIDENCE_REQUIRED"]
  ]) {
    const broken = structuredClone(unfrozen);
    mutate(broken);
    assert.throws(() => assertGuooComparisonReadyForEvidence(broken, RULE_VERSION),
      (error) => error.code === code, code);
    assert.throws(() => assertGuooComparisonReadyForEvidence(broken, "guoo-other"),
      (error) => error instanceof GuooRouteComparisonError);
  }

  // 三、新的这条路反过来要求已冻结、且停在条件测算；没冻结的、或者已经不在条件测算上的，一律不给走。
  assert.throws(() => assertGuooComparisonFrozenForEvidenceRefresh(unfrozen, RULE_VERSION),
    (error) => error.code === "FROZEN_CANDIDATE_REQUIRED");
  const passed = structuredClone(candidate);
  passed.lifecycleV11.status = "b_passed_auto_c1";
  assert.throws(() => assertGuooComparisonFrozenForEvidenceRefresh(passed, RULE_VERSION),
    (error) => error.code === "CONDITIONAL_B_REQUIRED");

  // 四、新路也没把线路那一组检查扔掉：比较过期、规则版本对不上、运输没核实，照样停。
  for (const [mutate, code] of [
    [c => { c.guooRouteComparisonsV1 = []; }, "COMPARISON_REQUIRED"],
    [c => { c.dataRevision += 1; }, "SAVED_RESULT_STALE"],
    [c => { c.guooRouteComparisonsV1 = [savedGuooRouteComparison(c.id, c.dataRevision - 1, { declared: false })]; }, "TRANSPORT_EVIDENCE_REQUIRED"]
  ]) {
    const broken = structuredClone(candidate);
    mutate(broken);
    assert.throws(() => assertGuooComparisonFrozenForEvidenceRefresh(broken, RULE_VERSION),
      (error) => error.code === code, code);
  }
  assert.throws(() => assertGuooComparisonFrozenForEvidenceRefresh(candidate, "guoo-other"),
    (error) => error.code === "RULE_VERSION_CONFLICT");

  // 五、最要紧的那一条：已冻结的线路/运费和这份比较对不上时，绝不拿一条说不清来路的线路去取资费。
  for (const mutate of [
    c => { c.lifecycleV11.bSystemEvidenceBundle.logisticsEvidence.route = "guoo-express-small"; },
    c => { c.lifecycleV11.bSystemEvidenceBundle.logisticsEvidence.ruleVersion = "guoo-2026-08-19"; },
    c => { c.lifecycleEvidenceContextV11.route = "guoo-express-small"; },
    c => { c.lifecycleEvidenceContextV11.logisticsRuleVersion = "guoo-2026-08-19"; },
    c => { delete c.lifecycleV11.bSystemEvidenceBundle.logisticsEvidence; }
  ]) {
    const broken = structuredClone(candidate);
    mutate(broken);
    assert.throws(() => assertGuooComparisonFrozenForEvidenceRefresh(broken, RULE_VERSION),
      (error) => error.code === "FROZEN_ROUTE_CONFLICT");
  }

  // 六、大小写不算冲突：适用范围留着主人那一版的大小写，冻结运费和证据键已经规范化过，比的是同一条线路。
  const cased = structuredClone(candidate);
  cased.lifecycleEvidenceContextV11.route = FROZEN_ROUTE.toUpperCase();
  assert.equal(assertGuooComparisonFrozenForEvidenceRefresh(cased, RULE_VERSION).selectedRoute, FROZEN_ROUTE);
});

/**
 * 那道不变量本身：落盘这一步只允许往 evidencePacks 里写，候选记录逐字节不变，版本号也在里面。
 *
 * 它是事务里的最后一道：提交完了当场回头比一遍，对不上就抛出去让整笔回滚。宁可这一次白读，
 * 也不让重读顺手动了规格、运费或版本号——昨天栽的就是版本被顶高那一种。
 */
test("落盘只写证据：候选记录和版本号原地不动，落盘失败时一份证据都不留下", async () => {
  const { document } = await strandedScenario();
  const candidate = document.candidates[0];
  const run = await runLifecycleBEvidencePreparation({
    candidate, evidencePacks: document.evidencePacks, currentCommissionCatalogs: [],
    providers: stubProviders(), plannedAt: REFRESHED_AT, preparedAt: REFRESHED_AT });
  assert.equal(run.status, "completed");
  const options = { createdAt: REFRESHED_AT, currentCommissionCatalogs: [], createdBy: "owner_b_evidence_refresh" };
  const packs = () => run.evidencePacksToCommit.map(pack => structuredClone(pack));

  const clean = structuredClone(document);
  const frozenBefore = JSON.stringify(clean.candidates[0]);
  const committed = commitLifecycleBFeeEvidenceRefresh(clean, candidate.id, packs(), options);
  assert.equal(committed.length, 2);
  assert.equal(JSON.stringify(clean.candidates[0]), frozenBefore, "落盘只写证据，候选记录一个字节都不动");
  assert.equal(clean.candidates[0].dataRevision, candidate.dataRevision);

  // 认不出这件商品就不落盘：宁可这一次白读，也不把证据写到一份说不清是谁的记录旁边。
  assert.throws(() => commitLifecycleBFeeEvidenceRefresh(structuredClone(document), "candidate:not-here", packs(), options),
    /B_EVIDENCE_REFRESH_CANDIDATE_MISSING/u);

  // 提交本身不成立时（这里是一份坏证据），一份都不写进去，候选也照样不动。
  const broken = structuredClone(document);
  const badPacks = packs();
  badPacks[0].evidenceData = { commissionRate: 2 };
  assert.throws(() => commitLifecycleBFeeEvidenceRefresh(broken, candidate.id, badPacks, options), /B_EVIDENCE_COMMIT_/u);
  assert.deepEqual(broken.evidencePacks, document.evidencePacks);
  assert.equal(JSON.stringify(broken.candidates[0]), frozenBefore);
});
