import { validateSalesSnapshot } from './sales-snapshot.mjs';

function validCopy(candidate, snapshotId) {
  if (typeof snapshotId !== 'string' || snapshotId.trim() === '') return null;
  return (Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [])
    .find(snapshot => snapshot?.snapshotId === snapshotId && validateSalesSnapshot(snapshot).valid) ?? null;
}

/**
 * The market snapshot every colour of one card is priced on: the one the parent's own A confirmation reviewed and its
 * B froze. A newer snapshot copied along with it never decides a colour's price basis (owner decision 2026-10-11, vest
 * run: the newest copy said 475 RUB, the khaki parent was priced on 801 RUB). Null when the parent froze none.
 */
export function siblingFamilySalesSnapshot(parent) {
  const frozen = parent?.lifecycleV11?.opportunityPackage?.salesSnapshots;
  const refs = parent?.lifecycleV11?.skuPackage?.inheritedSalesSnapshotRefs;
  if (!Array.isArray(frozen) || frozen.length !== 1 || !Array.isArray(refs) || !refs.includes(frozen[0]?.snapshotId)) return null;
  return validCopy(parent, frozen[0].snapshotId);
}

/** The snapshot a colour's own record says it is priced on (`siblingSourceV1.salesSnapshotId`), while it is still a valid copy on that colour. */
export function siblingReferencedSalesSnapshot(candidate) {
  return validCopy(candidate, candidate?.siblingSourceV1?.salesSnapshotId);
}
