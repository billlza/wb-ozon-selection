import test from "node:test";
import assert from "node:assert/strict";

import { phase7PassedState, platformSchemaEvidence } from "./fixtures/formal-c1-flow-fixture.mjs";
import { createMemoryBusinessStateRepository } from "../lib/business-state-repository.mjs";
import { createC1ProductPlan } from "../lib/c1-product-plan.mjs";
import { createC1FactsVerificationUseCase, C1FactsVerificationError } from "../lib/c1-facts-verification-use-case.mjs";
import { createActorContext } from "../lib/runtime-identity.mjs";

/*
 * 这一组守的是**拒绝路径**：什么情况下绝不把 C1 事实冻下来。
 *
 * 成功那一条不在这里：它要一份与计划完全同源的权利声明，合成夹具装不出来而不失真。
 * 它由 2026-09-17 在主人真实候选上的端到端实跑覆盖（inputs_ready → facts_checked，
 * 声明绑进 platformCompliance.skuRightsReview），`verifyC1ProductFacts` 本身也另有测试。
 * 这里补的正是当时没人守的那几条：缺声明、不在C1、已经冻过、身份不对、入参不对。
 */

const NOW = "2026-09-17T10:00:00.000Z";
const REVISION = 40;

function owner() {
  return createActorContext({ userId: "local-owner:test", sessionId: "facts-verification", actorType: "human",
    roles: ["owner"], source: "authenticated_identity_provider", authenticatedAt: NOW });
}

async function candidateWithoutRights() {
  const state = await phase7PassedState();
  const plan = createC1ProductPlan({ ...state, platformSchemaEvidence: platformSchemaEvidence(), createdAt: NOW });
  return { id: state.candidate.id, dataRevision: REVISION, lifecycleV11: { skuPackage: structuredClone(plan.skuPackage) } };
}

function useCaseFor(candidate) {
  return {
    useCase: createC1FactsVerificationUseCase({
      repository: createMemoryBusinessStateRepository({ candidates: [candidate] }),
      runtimeMode: "local_development", serverClock: () => new Date(NOW)
    }),
    input: {
      candidateId: candidate.id, expectedRevision: candidate.dataRevision,
      skuPackageId: candidate.lifecycleV11.skuPackage.skuPackageId,
      idempotencyKey: `c1-verify-facts:${candidate.id}:${candidate.dataRevision}`,
      auditEventId: `c1-verify-facts-audit:${candidate.id}:${candidate.dataRevision}`
    }
  };
}

test("没有主人签下的权利声明时拒绝，绝不替他把事实冻下来", async () => {
  const { useCase, input } = useCaseFor(await candidateWithoutRights());
  await assert.rejects(() => useCase.verify({ actor: owner(), input }),
    (error) => error instanceof C1FactsVerificationError && error.code === "C1_FACTS_VERIFICATION_RIGHTS_REQUIRED");
});

test("不在C1阶段、或计划已经冻过，都拒绝而不是冻第二份事实", async () => {
  const notC1 = await candidateWithoutRights();
  notC1.lifecycleV11.skuPackage.businessPhase = "C2";
  const phase = useCaseFor(notC1);
  await assert.rejects(() => phase.useCase.verify({ actor: owner(), input: phase.input }),
    (error) => error.code === "C1_FACTS_VERIFICATION_PHASE_REJECTED");

  for (const status of ["facts_checked", "seo_draft_ready"]) {
    const frozen = await candidateWithoutRights();
    frozen.lifecycleV11.skuPackage.c1ProductPlan.status = status;
    const already = useCaseFor(frozen);
    await assert.rejects(() => already.useCase.verify({ actor: owner(), input: already.input }),
      (error) => error.code === "C1_FACTS_VERIFICATION_ALREADY_FROZEN", `${status} 不该再冻一次`);
  }
});

test("只有已认证的主人本人能冻结事实：缺owner角色、来源不是已认证身份提供方都拒绝", async () => {
  const candidate = await candidateWithoutRights();

  // 角色这一层由 authorizeOperation 挡：它只看角色。
  const reviewer = createActorContext({ userId: "local-owner:test", sessionId: "s", actorType: "human",
    roles: ["reviewer"], source: "authenticated_identity_provider", authenticatedAt: NOW });
  const roleCase = useCaseFor(candidate);
  await assert.rejects(() => roleCase.useCase.verify({ actor: reviewer, input: roleCase.input }),
    (error) => error.code === "RUNTIME_OPERATION_FORBIDDEN");

  // 来源这一层 authorizeOperation **不看**，必须由用例自己挡下来：否则状态机拿着 owner 角色
  // 就能绕过主人把事实冻掉——而冻结事实要消费的正是主人亲笔签的那份声明。
  const machine = createActorContext({ userId: "local-owner:test", sessionId: "s", actorType: "human",
    roles: ["owner"], source: "selection_review_state_machine", authenticatedAt: NOW });
  const sourceCase = useCaseFor(candidate);
  await assert.rejects(() => sourceCase.useCase.verify({ actor: machine, input: sourceCase.input }),
    (error) => error instanceof C1FactsVerificationError && error.code === "C1_FACTS_VERIFICATION_AUTHENTICATED_OWNER_REQUIRED");
});

test("入参多一项、少一项、revision非法，一律整笔拒绝", async () => {
  const candidate = await candidateWithoutRights();
  const { useCase, input } = useCaseFor(candidate);
  const cases = [
    ["多一项", { ...input, extra: "x" }],
    ["少一项", (() => { const copy = { ...input }; delete copy.auditEventId; return copy; })()],
    ["revision 为 0", { ...input, expectedRevision: 0 }],
    ["revision 非整数", { ...input, expectedRevision: 1.5 }],
    ["空字符串ID", { ...input, candidateId: "  " }]
  ];
  for (const [why, bad] of cases) {
    await assert.rejects(() => useCase.verify({ actor: owner(), input: bad }),
      (error) => error.code === "C1_FACTS_VERIFICATION_INPUT_INVALID", `${why} 必须拒绝`);
  }
});

test("构造依赖不合法时当场拒绝，不等到有人来调用才炸", () => {
  const repository = createMemoryBusinessStateRepository({ candidates: [] });
  assert.throws(() => createC1FactsVerificationUseCase({ repository, runtimeMode: "production", serverClock: () => new Date() }), TypeError);
  assert.throws(() => createC1FactsVerificationUseCase({ repository, runtimeMode: "local_development", serverClock: null }), TypeError);
});
