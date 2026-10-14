import { executeBusinessMutation } from './business-mutation-transaction.mjs';
import { authorizeOperation } from './runtime-identity.mjs';
import { fingerprintCanonicalRecord } from './production-contract-primitives.mjs';
import { sameStoreRef } from './store-binding.mjs';
import { isDeepStrictEqual } from 'node:util';
import { C1_SCHEMA_CONTENT_FIELDS, validateLifecycleEvidenceData } from './lifecycle-b-input-bundle.mjs';
import { evidenceScopeMatches } from './lifecycle-evidence-scope.mjs';
import { inspectLifecycleEvidenceValidity } from './lifecycle-evidence-validity.mjs';

const IDS = new Set(['10096', '10097']);
const MAX_RETAINED_COLOR_READS = 16;
const nonEmpty = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const fail = code => { throw new C1ColorDictionaryReadError(code); };

export class C1ColorDictionaryReadError extends Error {
  constructor(code, { requestSent = false, cause = null } = {}) {
    super(code, cause ? { cause } : undefined);
    this.name = 'C1ColorDictionaryReadError'; this.code = code;
    this.requestSent = requestSent;
  }
}

function owner(actor) {
  authorizeOperation({ actor, requiredRoles: ['owner'] });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') {
    fail('C1_COLOR_DICTIONARY_OWNER_REQUIRED');
  }
}

function scope(candidate, skuPackageId, attributeId) {
  const sku = candidate.lifecycleV11?.skuPackage;
  const plan = sku?.c1ProductPlan;
  const schema = plan?.inputSnapshots?.platformSchemaRules;
  const attributes = schema?.attributes?.filter(item => String(item.fieldKey) === attributeId) ?? [];
  if (!candidate.siblingSourceV1 || sku?.supplierSkuId !== candidate.siblingSourceV1.supplierSkuId ||
      sku?.skuPackageId !== skuPackageId || sku.businessPhase !== 'C1' || plan?.status !== 'inputs_ready' ||
      schema?.platform !== 'ozon' || schema.store !== candidate.targetStore ||
      !sameStoreRef(schema.storeRef, candidate.storeRef) || !nonEmpty(schema.schemaRevision) ||
      !/^\d+$/.test(String(schema.descriptionCategoryId)) || !/^\d+$/.test(String(schema.typeId)) ||
      attributes.length !== 1 || !Number.isSafeInteger(attributes[0].dictionaryId) ||
      attributes[0].dictionaryId <= 0) fail('C1_COLOR_DICTIONARY_SCOPE_INVALID');
  if (!nonEmpty(schema.ruleVersion)) fail('C1_COLOR_DICTIONARY_SCHEMA_NOT_CURRENT');
  return { sku, plan, schema, attribute: attributes[0],
    category: `ozon:${schema.descriptionCategoryId}:${schema.typeId}` };
}

function assertCurrentFrozenSchema(candidate, schema, evidencePacks, observedAt) {
  if (!Array.isArray(evidencePacks)) fail('C1_COLOR_DICTIONARY_SCHEMA_NOT_CURRENT');
  const matches = evidencePacks.filter(pack => pack.id === schema.evidenceId);
  const pack = matches[0];
  if (matches.length !== 1 || pack.kind !== 'schema' || pack.status !== 'active' ||
      !evidenceScopeMatches('schema', pack.scope, { platform: schema.platform,
        store: schema.store, storeRef: schema.storeRef,
        category: `ozon:${schema.descriptionCategoryId}:${schema.typeId}`,
        ruleVersion: schema.ruleVersion }) ||
      pack.checkedAt !== schema.collectedAt ||
      ![...C1_SCHEMA_CONTENT_FIELDS, 'schemaRevision', 'requiredFields'].every(field =>
        isDeepStrictEqual(pack.evidenceData?.[field], schema[field])) ||
      !validateLifecycleEvidenceData('schema', pack.evidenceData).valid ||
      inspectLifecycleEvidenceValidity(pack, { asOf: observedAt }).usable !== true) {
    fail('C1_COLOR_DICTIONARY_SCHEMA_NOT_CURRENT');
  }
}

function current(candidate, authorizationId, attributeId) {
  const record = candidate.lifecycleV11?.c1ColorDictionaryReadsV1?.[attributeId];
  if (record?.schemaVersion !== 'c1-color-dictionary-read-v1' ||
      record.authorizationId !== authorizationId || record.candidateId !== candidate.id ||
      record.attributeId !== attributeId) fail('C1_COLOR_DICTIONARY_AUTHORIZATION_MISSING');
  const { sku, plan, schema, category } = scope(candidate, record.skuPackageId, attributeId);
  if (record.supplierSkuId !== sku.supplierSkuId || record.sourceSkuRevision !== sku.dataRevision ||
      record.c1PlanId !== plan.c1PlanId || record.schemaRevision !== schema.schemaRevision ||
      record.schemaEvidenceId !== schema.evidenceId ||
      record.schemaRuleVersion !== schema.ruleVersion ||
      record.store !== schema.store || !sameStoreRef(record.storeRef, schema.storeRef) ||
      record.category !== category || record.dictionaryId !== schema.attributes.find(item =>
        String(item.fieldKey) === attributeId)?.dictionaryId) fail('C1_COLOR_DICTIONARY_SCOPE_CHANGED');
  return record;
}

function valuesFromRead(read, observedAt) {
  const data = read?.evidenceData;
  if (!nonEmpty(read?.sourceRef) || !nonEmpty(read?.checkedAt) || !nonEmpty(read?.expiresAt) ||
      !Number.isFinite(Date.parse(read.checkedAt)) || !Number.isFinite(Date.parse(read.expiresAt)) ||
      Date.parse(read.checkedAt) > Date.parse(observedAt) || Date.parse(read.expiresAt) <= Date.parse(observedAt) ||
      typeof data?.complete !== 'boolean' || !Array.isArray(data.values) || data.values.length > 200) {
    fail('C1_COLOR_DICTIONARY_EVIDENCE_INVALID');
  }
  if (!data.complete) return { status: 'incomplete', evidence: null };
  const values = data.values.map(item => {
    if (!nonEmpty(item?.value) || !Number.isSafeInteger(item.dictionaryValueId) ||
        item.dictionaryValueId <= 0 || (item.valueZh != null && !nonEmpty(item.valueZh))) {
      fail('C1_COLOR_DICTIONARY_EVIDENCE_INVALID');
    }
    return { value: item.value, dictionaryValueId: item.dictionaryValueId,
      valueZh: item.valueZh ?? null };
  });
  if (new Set(values.map(item => item.value)).size !== values.length ||
      new Set(values.map(item => item.dictionaryValueId)).size !== values.length) {
    fail('C1_COLOR_DICTIONARY_EVIDENCE_INVALID');
  }
  return { status: 'succeeded', evidence: { sourceRef: read.sourceRef, checkedAt: read.checkedAt,
    expiresAt: read.expiresAt, complete: true, values } };
}

/** Exact local lookup replaces a second external dictionary request when mapping sibling colors. */
export function resolveSavedC1ColorDictionaryValue({ candidate, evidencePacks, attributeId, value, observedAt }) {
  const record = candidate.lifecycleV11?.c1ColorDictionaryReadsV1?.[attributeId];
  if (!record) fail('C1_COLOR_DICTIONARY_AUTHORIZATION_MISSING');
  current(candidate, record.authorizationId, attributeId);
  const schema = candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules;
  assertCurrentFrozenSchema(candidate, schema, evidencePacks, observedAt);
  if (record.status !== 'succeeded' || record.useCount !== 1 ||
      record.evidence?.complete !== true || !Array.isArray(record.evidence.values) ||
      Date.parse(record.evidence.expiresAt) <= Date.parse(observedAt)) {
    fail('C1_COLOR_DICTIONARY_CANDIDATES_NOT_CURRENT');
  }
  const matches = record.evidence.values.filter(item => item.value === value);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].dictionaryValueId) ||
      matches[0].dictionaryValueId <= 0) fail('C1_COLOR_DICTIONARY_VALUE_NOT_FOUND');
  return { dictionaryValueId: matches[0].dictionaryValueId, sourceRef: record.evidence.sourceRef };
}

/** One owner-authorized, one-request C1 read. The claim is durable before the network call. */
export function createC1ColorDictionaryReadUseCase({ repository, runtimeMode, serverClock, readDictionaryValues }) {
  if (!repository || typeof serverClock !== 'function' || typeof readDictionaryValues !== 'function') {
    throw new TypeError('C1_COLOR_DICTIONARY_DEPENDENCY_INVALID');
  }
  return Object.freeze({
    async authorize({ actor, input }) {
      owner(actor);
      if (!input || Object.keys(input).sort().join(',') !== 'attributeId,candidateId,expectedRevision,skuPackageId' ||
          !IDS.has(input.attributeId) || !nonEmpty(input.candidateId) || !nonEmpty(input.skuPackageId) ||
          !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        fail('C1_COLOR_DICTIONARY_INPUT_INVALID');
      }
      const key = `c1-color-dictionary:${input.candidateId}:${input.attributeId}:${input.expectedRevision}`;
      return executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'],
        action: 'authorize_c1_color_dictionary_read', candidateId: input.candidateId,
        skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: key, inputFingerprint: fingerprintCanonicalRecord(input),
        auditEventId: `${key}:audit`, serverClock,
        mutate: ({ candidate, evidencePacks, observedAt }) => {
          const { sku, plan, schema, attribute, category } = scope(candidate, input.skuPackageId, input.attributeId);
          assertCurrentFrozenSchema(candidate, schema, evidencePacks, observedAt);
          const records = candidate.lifecycleV11.c1ColorDictionaryReadsV1 ?? {};
          const previous = records[input.attributeId];
          if (previous) {
            const scopeChanged = previous.c1PlanId !== plan.c1PlanId ||
              previous.schemaRevision !== schema.schemaRevision || previous.schemaEvidenceId !== schema.evidenceId ||
              previous.schemaRuleVersion !== schema.ruleVersion ||
              previous.dictionaryId !== attribute.dictionaryId;
            const unusedExpired = previous.status === 'authorized' && previous.useCount === 0 &&
              Date.parse(previous.expiresAt) <= Date.parse(observedAt);
            const settledUnavailable = previous.useCount === 1 && previous.settledAt &&
              (previous.status === 'incomplete' ||
              previous.status === 'succeeded' && (scopeChanged ||
                Date.parse(previous.evidence?.expiresAt) <= Date.parse(observedAt)));
            if (!unusedExpired && !settledUnavailable) fail('C1_COLOR_DICTIONARY_ALREADY_AUTHORIZED');
            if ((candidate.lifecycleV11.c1ColorDictionaryReadHistoryV1?.length ?? 0) >= MAX_RETAINED_COLOR_READS) {
              fail('C1_COLOR_DICTIONARY_HISTORY_CAPACITY_REACHED');
            }
            candidate.lifecycleV11.c1ColorDictionaryReadHistoryV1 = [
              ...(candidate.lifecycleV11.c1ColorDictionaryReadHistoryV1 ?? []),
              { ...structuredClone(previous), supersededAt: observedAt }
            ];
          }
          const record = {
            schemaVersion: 'c1-color-dictionary-read-v1', authorizationId: key,
            status: 'authorized', candidateId: candidate.id, skuPackageId: sku.skuPackageId,
            supplierSkuId: sku.supplierSkuId, sourceCandidateRevision: candidate.dataRevision,
            sourceSkuRevision: sku.dataRevision, c1PlanId: plan.c1PlanId,
            schemaRevision: schema.schemaRevision, schemaEvidenceId: schema.evidenceId,
            schemaRuleVersion: schema.ruleVersion, store: schema.store,
            storeRef: structuredClone(schema.storeRef), category,
            attributeId: input.attributeId, dictionaryId: attribute.dictionaryId,
            authorizedByUserId: actor.userId, authorizedAt: observedAt,
            expiresAt: new Date(Date.parse(observedAt) + 10 * 60_000).toISOString(),
            maxUses: 1, useCount: 0, externalRequestRef: null, requestedAt: null,
            settledAt: null, evidence: null, failureCode: null
          };
          candidate.lifecycleV11.c1ColorDictionaryReadsV1 = { ...records, [input.attributeId]: record };
          return { candidate, result: { authorizationId: key, status: record.status,
            attributeId: input.attributeId, externalRequests: 0, platformWrites: 0, paidCalls: 0 } };
        } });
    },
    async continueSaved({ actor, input }) {
      owner(actor);
      if (!input || Object.keys(input).sort().join(',') !== 'attributeId,authorizationId,candidateId,expectedRevision,skuPackageId' ||
          !IDS.has(input.attributeId) || !nonEmpty(input.authorizationId) || !nonEmpty(input.candidateId) ||
          !nonEmpty(input.skuPackageId) || !Number.isSafeInteger(input.expectedRevision)) {
        fail('C1_COLOR_DICTIONARY_INPUT_INVALID');
      }
      const claimKey = `${input.authorizationId}:claim`;
      const claim = await executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'],
        action: 'claim_c1_color_dictionary_read', candidateId: input.candidateId,
        skuPackageId: input.skuPackageId, expectedRevision: input.expectedRevision,
        idempotencyKey: claimKey, inputFingerprint: fingerprintCanonicalRecord(input),
        auditEventId: `${claimKey}:audit`, serverClock,
        mutate: ({ candidate, evidencePacks, observedAt }) => {
          const record = current(candidate, input.authorizationId, input.attributeId);
          assertCurrentFrozenSchema(candidate,
            candidate.lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules,
            evidencePacks, observedAt);
          if (record.status !== 'authorized' || record.useCount !== 0 || record.maxUses !== 1 ||
              candidate.dataRevision !== record.sourceCandidateRevision + 1 ||
              actor.userId !== record.authorizedByUserId || Date.parse(observedAt) >= Date.parse(record.expiresAt)) {
            fail('C1_COLOR_DICTIONARY_AUTHORIZATION_NOT_CURRENT');
          }
          record.status = 'request_sent'; record.useCount = 1;
          record.externalRequestRef = `${record.authorizationId}:request`;
          record.requestedAt = observedAt;
          return { candidate, result: { authorizationId: record.authorizationId,
            status: record.status, externalRequests: 0, platformWrites: 0, paidCalls: 0 } };
        } });
      if (claim.status !== 'committed') return claim;
      const record = current(claim.candidate, input.authorizationId, input.attributeId);
      let outcome;
      try {
        const read = await readDictionaryValues({ store: record.store, category: record.category,
          attributeId: record.attributeId, limit: 200 });
        outcome = valuesFromRead(read, new Date(serverClock()).toISOString());
      } catch {
        // The request was durably marked sent. A failed or malformed response
        // cannot prove whether the external service completed the read.
        outcome = { status: 'unknown_outcome', evidence: null };
      }
      const settleKey = `${input.authorizationId}:settle`;
      try {
        return await executeBusinessMutation({ repository, runtimeMode, actor, requiredRoles: ['owner'],
          action: 'settle_c1_color_dictionary_read', candidateId: input.candidateId,
          skuPackageId: input.skuPackageId, expectedRevision: claim.candidate.dataRevision,
          idempotencyKey: settleKey, inputFingerprint: fingerprintCanonicalRecord(outcome),
          auditEventId: `${settleKey}:audit`, serverClock,
          mutate: ({ candidate, observedAt }) => {
            const saved = current(candidate, input.authorizationId, input.attributeId);
            if (saved.status !== 'request_sent' || saved.useCount !== 1 ||
                candidate.dataRevision !== saved.sourceCandidateRevision + 2 ||
                saved.externalRequestRef !== `${saved.authorizationId}:request`) {
              fail('C1_COLOR_DICTIONARY_SETTLEMENT_CONFLICT');
            }
            saved.status = outcome.status; saved.evidence = outcome.evidence;
            saved.settledAt = observedAt;
            saved.failureCode = outcome.status === 'succeeded' ? null :
              outcome.status === 'incomplete' ? 'C1_COLOR_DICTIONARY_INCOMPLETE' : 'C1_COLOR_DICTIONARY_UNKNOWN_OUTCOME';
            return { candidate, result: { authorizationId: saved.authorizationId,
              status: saved.status, attributeId: saved.attributeId,
              candidateCount: saved.evidence?.values.length ?? 0,
              externalRequests: 1, platformWrites: 0, paidCalls: 0 } };
          } });
      } catch (error) {
        // The service call already happened. A settlement failure cannot be
        // reported as zero requests or silently retried under the old grant.
        throw new C1ColorDictionaryReadError('C1_COLOR_DICTIONARY_SETTLEMENT_UNCONFIRMED',
          { requestSent: true, cause: error });
      }
    }
  });
}
