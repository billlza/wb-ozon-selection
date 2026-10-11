import test from "node:test";
import assert from "node:assert/strict";
import { buildGate1RightsDeclaration, gate1RightsDeclarationCurrent, gate1RightsInputProblem, gate1RightsLine,
  gate1RightsOwnerDeclaration } from "../lib/gate1-rights-declaration.mjs";

const AT = "2026-10-11T08:00:00.000Z";
const decision = { decision: "accept", decidedAt: AT, roundIndex: 0 };
const input = { brandStatus: "unbranded", brandName: null, rights: "no_third_party_rights_identified", validMonths: 12 };
const build = (extra = {}) => buildGate1RightsDeclaration({ candidateId: "cand-1", sourceRevision: 4, input, decision,
  declaredByUserId: "owner-1", declaredAt: AT, ...extra });

test("卡上那组选择：只收能让商品往下走的声明，搭配不对就说哪儿不对", () => {
  assert.equal(gate1RightsInputProblem(input), null);
  assert.equal(gate1RightsInputProblem({ brandStatus: "branded", brandName: "Miska", rights: "licensed", validMonths: 3 }), null);
  for (const [bad, code] of [
    [{ ...input, extra: true }, "gate1_rights_invalid"],
    [{ ...input, brandStatus: "unknown" }, "gate1_rights_invalid"],
    [{ ...input, brandStatus: "branded" }, "gate1_rights_brand_name"],
    [{ ...input, brandStatus: "branded", brandName: "a\nb" }, "gate1_rights_brand_name"],
    [{ ...input, brandName: "Miska" }, "gate1_rights_invalid"],
    [{ ...input, rights: "requires_authorization" }, "gate1_rights_invalid"],
    [{ ...input, rights: "unknown" }, "gate1_rights_invalid"],
    [{ brandStatus: "branded", brandName: "Miska", rights: "no_third_party_rights_identified", validMonths: 12 }, "gate1_rights_mismatch"],
    [{ ...input, validMonths: 24 }, "gate1_rights_invalid"]
  ]) assert.equal(gate1RightsInputProblem(bad)?.code, code, JSON.stringify(bad));
});

test("存下的那一份绑在那一次「做这件」上：核对时间就是点下去的那一刻，有效期从那一刻按月算", () => {
  const declaration = build();
  assert.deepEqual(declaration, { schemaVersion: "gate1-rights-declaration-v1", declarationId: "gate1-rights:cand-1:4", candidateId: "cand-1",
    sourceRevision: 4, gate1DecidedAt: AT, gate1RoundIndex: 0, scope: "this_product_any_spec",
    brand: { status: "unbranded", name: null }, rights: { status: "verified", basis: "no_third_party_rights_identified" },
    validMonths: 12, reviewedAt: AT, expiresAt: "2027-10-11T08:00:00.000Z", declaredByUserId: "owner-1", declaredAt: AT });
  assert.equal(build({ declaredAt: "2026-08-31T08:00:00.000Z", input: { ...input, validMonths: 6 } }).expiresAt, "2027-02-28T08:00:00.000Z", "月底不溢出到下个月");
  assert.equal(build({ input: { brandStatus: "branded", brandName: "  Miska ", rights: "owned", validMonths: 3 } }).brand.name, "Miska");
  assert.throws(() => build({ declaredByUserId: null }), /GATE1_RIGHTS_DECLARATION_INVALID/);
  assert.throws(() => build({ decision: { ...decision, decision: "skip" } }), /GATE1_RIGHTS_DECLARATION_INVALID/);
  assert.throws(() => build({ input: { ...input, rights: "unknown" } }), /GATE1_RIGHTS_DECLARATION_INVALID/);
  assert.deepEqual(gate1RightsOwnerDeclaration(declaration), { brand: { status: "unbranded", name: null },
    rights: { status: "verified", basis: "no_third_party_rights_identified" }, reviewedAt: AT, expiresAt: "2027-10-11T08:00:00.000Z" });
  assert.equal(gate1RightsLine(declaration), "品牌与权利：明确无品牌，已核对，未发现第三方权利，一年内有效");
});

test("还算不算数：同一次「做这件」、在有效期内；换了一轮、过期或内容被改坏就不算", () => {
  const declaration = build();
  const candidate = { id: "cand-1", gate1DecisionV1: decision, gate1RightsDeclarationV1: declaration };
  assert.equal(gate1RightsDeclarationCurrent(candidate), declaration);
  assert.equal(gate1RightsDeclarationCurrent(candidate, "2026-12-01T00:00:00.000Z"), declaration);
  assert.equal(gate1RightsDeclarationCurrent(candidate, "2027-10-11T08:00:00.000Z"), null, "到期那一刻起不算");
  assert.equal(gate1RightsDeclarationCurrent(candidate, "2026-10-11T07:59:59.999Z"), null, "声明之前的时刻不算");
  assert.equal(gate1RightsDeclarationCurrent({ ...candidate, gate1DecisionV1: { ...decision, decidedAt: "2026-10-12T00:00:00.000Z" } }), null);
  assert.equal(gate1RightsDeclarationCurrent({ ...candidate, id: "cand-2" }), null);
  assert.equal(gate1RightsDeclarationCurrent({ ...candidate, gate1RightsDeclarationV1: { ...declaration, rights: { status: "unknown", basis: null } } }), null);
  assert.equal(gate1RightsDeclarationCurrent({ ...candidate, gate1RightsDeclarationV1: { ...declaration, brand: { status: "branded", name: "X" } } }), null);
  assert.equal(gate1RightsDeclarationCurrent({ ...candidate, gate1RightsDeclarationV1: null }), null);
});
