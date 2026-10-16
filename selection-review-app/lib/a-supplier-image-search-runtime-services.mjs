import { authorizeOperation, teamOperationRoles } from './runtime-identity.mjs';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';

export class SupplierImageSearchPreparationError extends Error {
  constructor(code) {
    super(`A_SUPPLIER_IMAGE_SEARCH_${code}`);
    this.name = 'SupplierImageSearchPreparationError';
    this.code = code;
  }
}

/** No production page adapter is installed. A detail heartbeat cannot satisfy this boundary. */
export function supplierImageSearchAvailability() {
  return {
    schemaVersion: 'a-supplier-image-search-availability-v1',
    status: 'not_configured',
    canAuthorize: false,
    pageContractStatus: 'unverified',
    browserWorkerStatus: 'unverified',
    blockCode: 'PAGE_CONTRACT_UNCONFIGURED'
  };
}

function assertPreparationInput({ document, actor, candidateId, expectedRevision }) {
  authorizeOperation({ actor, requiredRoles: teamOperationRoles(actor) });
  if (actor.actorType !== 'human' || actor.source !== 'authenticated_identity_provider') {
    throw new SupplierImageSearchPreparationError('AUTHENTICATED_OWNER_REQUIRED');
  }
  if (!isCanonicalFrozenRef(candidateId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new SupplierImageSearchPreparationError('INPUT_INVALID');
  }
  if (!Array.isArray(document.candidates)) throw new SupplierImageSearchPreparationError('REPOSITORY_INVALID');
  const candidates = document.candidates.filter(candidate => candidate.id === candidateId);
  if (candidates.length !== 1) throw new SupplierImageSearchPreparationError('CANDIDATE_REQUIRED');
  if (candidates[0].dataRevision !== expectedRevision) throw new SupplierImageSearchPreparationError('CANDIDATE_CHANGED');
}

/** This read-only boundary exposes readiness without inventing authorizations, jobs or browser health. */
export function readSupplierImageSearchPreparation(input) {
  assertPreparationInput(input);
  return { ...supplierImageSearchAvailability(), candidateId: input.candidateId, revision: input.expectedRevision };
}

export function requireSupplierImageSearchPreparation(input) {
  const preparation = readSupplierImageSearchPreparation(input);
  throw new SupplierImageSearchPreparationError(preparation.blockCode);
}
