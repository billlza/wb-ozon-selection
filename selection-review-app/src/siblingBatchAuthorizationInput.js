import { productionAuthorizationInputFromCard } from './productionAuthorizationInput.js';
import { siblingBatchReview } from './siblingBatchReview.js';

/** Compose a single owner decision from current server preparations only. */
export function siblingBatchAuthorizationInput(parent, candidates, bindingId, options = {}) {
  if (typeof parent?.id !== 'string' || parent.id.trim() === '' ||
      !Number.isSafeInteger(parent.dataRevision) || parent.dataRevision < 1) {
    return { ready: false, reason: '父卡身份或当前版本缺失，请刷新批次清单。', input: null };
  }
  const review = siblingBatchReview(parent, candidates);
  if (!review?.ready) return { ready: false, reason: '批次成员还有 A/B/C1/C2 或当前价格、库存缺项。', input: null };
  if (!['create_only', 'write_authorized_stock'].includes(options.inventoryAction)) {
    return { ready: false, reason: '请选择仅创建商品或写入已授权库存的明确范围。', input: null };
  }
  const commonBinding = review.executionBindings.find(item => item.bindingId === bindingId);
  if (!commonBinding) return { ready: false, reason: '请选择本批所有规格共同有效的仓库绑定。', input: null };
  const excluded = parent.lifecycleV11?.skuPackage?.productionAuthorization?.lockedScope?.merchantSku;
  if (typeof excluded !== 'string' || excluded.trim() === '') {
    return { ready: false, reason: '首件历史商家货号缺失，不能证明该商品已从本批排除。', input: null };
  }
  const members = [];
  for (const row of review.rows) {
    const candidate = candidates.find(item => item.id === row.candidateId);
    const preparation = candidate?.productionOwnerPreparation;
    const decision = productionAuthorizationInputFromCard(candidate, candidate?.lifecycleV11?.skuPackage?.productionConfirmationCard);
    const commercial = preparation?.commercialDraft;
    const binding = preparation?.executionBindings?.find(item => item.bindingId === commonBinding.bindingId &&
      item.configurationVersion === commonBinding.configurationVersion &&
      item.warehouseName === commonBinding.warehouseName);
    if (!decision.ready || !commercial || !binding || !commercial.merchantSku ||
        !Number.isSafeInteger(commercial.stock) || commercial.stock < 0) {
      return { ready: false, reason: `${row.color} 的最终卡、经营数据或仓库绑定已变化。`, input: null };
    }
    members.push({ candidateId: candidate.id, ownerInput: { ...decision.input,
      bindingId: binding.bindingId, configurationVersion: binding.configurationVersion,
      merchantSku: commercial.merchantSku, confirmExactScope: true } });
  }
  return { ready: true, reason: '', input: { confirmAll: true,
    parentCandidateId: parent.id, parentRevision: parent.dataRevision,
    excludedOfferIds: [excluded], members,
    postImportScope: { schemaVersion: 'd-batch-post-import-scope-v1', inventoryAction: options.inventoryAction,
      eReadbackOfferIds: members.map(member => member.ownerInput.merchantSku) } } };
}
