import { createHash } from "node:crypto";

import { assertNormalProductionCodexIndependent, CODEX_OFFLINE_MODE, NORMAL_PRODUCTION_PATH } from "./codex-independence.mjs";
import { executeBusinessMutation } from "./business-mutation-transaction.mjs";
import { produceC1KeywordPlanningLocalMaterial } from "./c1-keyword-planning-local-material.mjs";
import { authorizeOperation } from "./runtime-identity.mjs";

export const C1_KEYWORD_PLANNING_LOCAL_MATERIAL_PERSISTENCE_VERSION = "c1-keyword-planning-local-material-persistence-v1";

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }

export async function persistC1KeywordPlanningLocalMaterial({
  repository,
  runtimeMode,
  actor,
  candidateId,
  expectedRevision,
  producedAt,
  codexOffline = true,
  producer = produceC1KeywordPlanningLocalMaterial
}) {
  if (!repository || !nonEmpty(candidateId) || !Number.isInteger(expectedRevision) || expectedRevision < 0 ||
      !nonEmpty(producedAt) || Number.isNaN(Date.parse(producedAt)) || typeof producer !== "function") {
    throw new Error("C1_KEYWORD_LOCAL_MATERIAL_PERSISTENCE_INPUT_INVALID");
  }
  authorizeOperation({ actor, requiredRoles: ["operator", "owner"] });
  const snapshot = await repository.readSnapshot();
  const observed = snapshot.candidates?.find((entry) => entry.id === candidateId);
  if (!observed) throw new Error("C1_KEYWORD_LOCAL_MATERIAL_CANDIDATE_NOT_FOUND");
  if (observed.dataRevision !== expectedRevision) throw new Error("C1_KEYWORD_LOCAL_MATERIAL_REVISION_CONFLICT");
  const preview = producer({ candidate: observed, expectedRevision, producedAt });
  const existing = observed.lifecycleV11?.c1KeywordPlanningLocalMaterialProductionV1;
  if (isObject(existing) && existing.inputFingerprint === preview.production.inputFingerprint &&
      existing.resultCandidateRevision === observed.dataRevision) {
    return Object.freeze({ status: "already_current", candidate: structuredClone(observed), result: structuredClone(existing), externalCallsPerformed: 0, codexDispatchesPerformed: 0 });
  }
  const skuPackageId = observed.lifecycleV11?.skuPackage?.skuPackageId;
  if (!nonEmpty(skuPackageId)) throw new Error("C1_KEYWORD_LOCAL_MATERIAL_SKU_PACKAGE_MISSING");
  if (codexOffline) assertNormalProductionCodexIndependent({ executionMode: CODEX_OFFLINE_MODE, pathType: NORMAL_PRODUCTION_PATH, skuPackageId, codexDependencies: [] });
  const idempotencyKey = `c1-keyword-local-material:${candidateId}:${expectedRevision}:${preview.production.inputFingerprint}`;
  return executeBusinessMutation({
    repository,
    runtimeMode,
    actor,
    requiredRoles: ["operator", "owner"],
    action: "produce_c1_keyword_planning_local_material",
    candidateId,
    skuPackageId,
    expectedRevision,
    idempotencyKey,
    inputFingerprint: preview.production.inputFingerprint,
    auditEventId: `audit:${digest(idempotencyKey)}`,
    externalRequestState: "not_sent",
    serverTime: producedAt,
    mutate: ({ candidate }) => {
      const produced = producer({ candidate, expectedRevision, producedAt });
      if (produced.production.inputFingerprint !== preview.production.inputFingerprint) throw new Error("C1_KEYWORD_LOCAL_MATERIAL_INPUT_DRIFT");
      const next = structuredClone(candidate);
      next.lifecycleV11 = { ...structuredClone(next.lifecycleV11 || {}) };
      const previous = next.lifecycleV11.c1KeywordPlanningLocalMaterialV1;
      if (previous && previous.materialFingerprint !== produced.material?.materialFingerprint) {
        next.lifecycleV11.c1KeywordPlanningLocalMaterialHistoryV1 = [
          ...(next.lifecycleV11.c1KeywordPlanningLocalMaterialHistoryV1 ?? []), structuredClone(previous)
        ];
      }
      next.lifecycleV11.c1KeywordPlanningLocalMaterialProductionV1 = structuredClone(produced.production);
      if (produced.material) next.lifecycleV11.c1KeywordPlanningLocalMaterialV1 = structuredClone(produced.material);
      else delete next.lifecycleV11.c1KeywordPlanningLocalMaterialV1;
      next.updatedAt = producedAt;
      next.lastModifiedBy = "software";
      return {
        candidate: next,
        result: {
          schemaVersion: C1_KEYWORD_PLANNING_LOCAL_MATERIAL_PERSISTENCE_VERSION,
          status: produced.status,
          candidateId,
          skuPackageId,
          sourceCandidateRevision: expectedRevision,
          resultCandidateRevision: expectedRevision + 1,
          inputFingerprint: produced.production.inputFingerprint,
          materialFingerprint: produced.production.materialFingerprint,
          gaps: structuredClone(produced.production.gaps),
          sideEffects: { externalCalls: 0, aiCalls: 0, browserActions: 0, codexDispatches: 0, softwareJobsCreated: 0 }
        }
      };
    }
  });
}
