import { resolveC2FinalConfirmationTargetContract } from "./c2-asset-lifecycle.mjs";
import { isDeepStrictEqual } from "node:util";
import { assertC1PricingResultReuse } from "./c1-pricing-result-reuse.mjs";
import { C2_UPLOAD_DRAFT_VERSION, MAX_UPLOAD_RECORDS, c2DraftError, settleC2Upload, assertCurrentC2UploadDraft, saveC2UploadSelection } from "./c2-upload-draft.mjs";

function targetBinding(targetContext) {
  const { sourceDataRevision, sourceC1Fingerprint, ...binding } = targetContext;
  return binding;
}

// Rebind only a recorded pricing revision; files remain in the existing local asset store.
export function rebaseC2UploadDraftAfterPricing(candidate, { historyRevisionId, resultCandidateRevision }) {
  const life = candidate.lifecycleV11;
  const matches = (life?.finalPricingRevisionHistory ?? []).filter(entry => entry.revisionId === historyRevisionId);
  if (matches.length !== 1 || resultCandidateRevision !== candidate.dataRevision + 1) {
    throw c2DraftError("c2_upload_rebase_source_invalid", "调价历史或提交修订不一致，未复用旧素材清单");
  }
  const history = matches[0];
  const old = history.previousC1References?.c2UploadDraft;
  if (old === undefined || old === null) return null;
  const previous = history.previousSkuPackage;
  const sku = life.skuPackage;
  const record = sku.c1ProductPlan?.draftOnlySeo?.pricingReuseRecord;
  if (life.c1PricingReuse?.status !== "reused" || !record || life.c2UploadDraft ||
      previous?.skuPackageId !== sku.skuPackageId || old.candidateId !== candidate.id || old.skuPackageId !== sku.skuPackageId ||
      old.schemaVersion !== C2_UPLOAD_DRAFT_VERSION || !Number.isSafeInteger(old.revision) || old.revision < 1 ||
      !Number.isSafeInteger(old.sourceCandidateRevision) || old.sourceCandidateRevision < 1 || old.sourceCandidateRevision > history.sourceCandidateRevision ||
      old.sourceSkuRevision !== (previous.c2FinalAssets?.status === "completed"
        ? previous.c2FinalAssets.productionAuthorizationPreparation?.sourceDataRevision : previous.dataRevision) ||
      old.sourceC1Fingerprint !== previous.c2FinalAssets?.softwareState?.sourceC1Fingerprint ||
      old.schemaEvidenceRef !== previous.c2FinalAssets?.targetContext?.schemaEvidenceRef ||
      !previous.c2FinalAssets?.targetContext || !sku.c2FinalAssets?.targetContext ||
      !isDeepStrictEqual(targetBinding(previous.c2FinalAssets.targetContext), targetBinding(sku.c2FinalAssets.targetContext)) ||
      !isDeepStrictEqual(record.sourcePlan, previous.c1ProductPlan?.draftOnlySeo?.pricingReuseRecord?.sourcePlan ?? previous.c1ProductPlan)) {
    throw c2DraftError("c2_upload_rebase_source_invalid", "旧素材清单、SKU、已复用C1或目标绑定不一致");
  }
  resolveC2FinalConfirmationTargetContract(previous);
  resolveC2FinalConfirmationTargetContract(sku);
  assertC1PricingResultReuse({ plan: sku.c1ProductPlan, resultSkuRevision: record.resultSkuRevision });
  if (!Array.isArray(old.uploads) || old.uploads.length > MAX_UPLOAD_RECORDS || !Array.isArray(old.selection) ||
      new Set(old.uploads.map(upload => upload.uploadId)).size !== old.uploads.length ||
      new Set(old.uploads.map(upload => upload.assetId)).size !== old.uploads.length) {
    throw c2DraftError("c2_upload_receipt_invalid", "旧素材上传回执或清单不完整");
  }
  for (const upload of old.uploads) {
    if (upload.status !== "ready") throw c2DraftError("c2_upload_unfinished", "旧素材仍有未完成或失败的上传，需先处理原上传记录");
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(upload.uploadId) ||
        upload.assetId !== `c2-local:${upload.uploadId}` || typeof upload.fileName !== "string" || !upload.fileName ||
        !["image", "video"].includes(upload.mediaType) || typeof upload.contentType !== "string" || !upload.contentType ||
        !Number.isFinite(Date.parse(upload.stagedAt)) || !Number.isFinite(Date.parse(upload.settledAt))) {
      throw c2DraftError("c2_upload_receipt_invalid", "旧素材本地回执缺少完整文件身份");
    }
    settleC2Upload({ uploads: [{ ...upload, status: "uploading" }], selection: [], revision: 0 },
      { uploadId: upload.uploadId, asset: upload, settledAt: upload.settledAt });
  }
  const projected = { ...candidate, dataRevision: resultCandidateRevision, lifecycleV11: { ...life } };
  const { source } = assertCurrentC2UploadDraft(projected, { dataRevision: resultCandidateRevision, draftRevision: 0 });
  projected.lifecycleV11.c2UploadDraft = { schemaVersion: C2_UPLOAD_DRAFT_VERSION, ...source, revision: 0,
    uploads: structuredClone(old.uploads), selection: [] };
  return saveC2UploadSelection(projected, { dataRevision: resultCandidateRevision, draftRevision: 0, selection: old.selection });
}
