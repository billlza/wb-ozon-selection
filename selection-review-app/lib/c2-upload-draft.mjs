export const C2_UPLOAD_DRAFT_VERSION = "c2-upload-draft-v1";
export const LOCAL_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_RECORDS = 100;

export function c2DraftError(code, message, status = 409) {
  return Object.assign(new Error(message), { status, extra: { code } });
}

function currentSource(candidate, expectedRevision) {
  if (!candidate || candidate.dataRevision !== expectedRevision) throw c2DraftError("c2_upload_source_changed", "商品资料已变化，请先核对当前修订");
  const sku = candidate.lifecycleV11?.skuPackage;
  const c2 = sku?.c2FinalAssets;
  if (sku?.businessPhase !== "C2" || c2?.status !== "awaiting_final_uploads" || !c2.softwareState ||
      sku.productionAuthorization || sku.productionRecord) throw c2DraftError("c2_upload_stage_invalid", "当前商品不是等待最终素材的C2状态");
  const source = {
    candidateId: candidate.id,
    skuPackageId: sku.skuPackageId,
    sourceCandidateRevision: expectedRevision,
    sourceSkuRevision: sku.dataRevision,
    sourceC1Fingerprint: c2.softwareState.sourceC1Fingerprint,
    schemaEvidenceRef: c2.targetContext?.schemaEvidenceRef
  };
  if (!Number.isSafeInteger(source.sourceSkuRevision) ||
      [source.candidateId, source.skuPackageId, source.sourceC1Fingerprint, source.schemaEvidenceRef].some(value => typeof value !== "string" || !value)) {
    throw c2DraftError("c2_upload_source_incomplete", "当前C2缺少素材绑定所需的完整来源记录");
  }
  return source;
}

export function assertCurrentC2UploadDraft(candidate, { dataRevision, draftRevision }) {
  const source = currentSource(candidate, dataRevision);
  const draft = candidate.lifecycleV11.c2UploadDraft;
  if (!Number.isSafeInteger(draftRevision) || draftRevision < 0 || draftRevision !== (draft?.revision ?? 0)) {
    throw c2DraftError("c2_upload_draft_conflict", "素材清单已变化，请核对保存后的清单");
  }
  if (draft && (draft.schemaVersion !== C2_UPLOAD_DRAFT_VERSION ||
      Object.entries(source).some(([key, value]) => draft[key] !== value))) {
    throw c2DraftError("c2_upload_source_changed", "已保存的素材属于旧SKU或旧C1资料，不能自动换绑");
  }
  return { source, draft };
}

// 槽位合同已废止：平台从没给过槽位或张数上限，选几张、按什么顺序由主人自己定，第一张就是主图。

export function reserveC2Upload(candidate, { dataRevision, draftRevision, uploadId, fileName, mediaType, contentType, startedAt }) {
  const { source, draft: existing } = assertCurrentC2UploadDraft(candidate, { dataRevision, draftRevision });
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uploadId)) throw c2DraftError("c2_upload_id_invalid", "上传编号无效", 400);
  const draft = existing ? structuredClone(existing) : { schemaVersion: C2_UPLOAD_DRAFT_VERSION, ...source, revision: 0, uploads: [], selection: [] };
  if (draft.uploads.some(upload => upload.uploadId === uploadId)) throw c2DraftError("c2_upload_duplicate", "该上传编号已经登记，不能重复写入");
  if (draft.uploads.some(upload => upload.status === "uploading")) throw c2DraftError("c2_upload_unfinished", "本清单仍有未确认结果的上传，请先处理该记录");
  if (draft.uploads.length >= MAX_UPLOAD_RECORDS) throw c2DraftError("c2_upload_storage_limit", "本草稿已达到本地上传记录上限，需要先归整素材");
  const assetId = `c2-local:${uploadId}`;
  draft.uploads.push({ uploadId, assetId, fileName, mediaType, contentType, status: "uploading", stagedAt: startedAt });
  draft.revision += 1;
  return draft;
}

export function settleC2Upload(draft, { uploadId, asset, failureCode, rejectedCode = null, settledAt }) {
  const next = structuredClone(draft);
  const upload = next.uploads.find(item => item.uploadId === uploadId);
  if (!upload || upload.status !== "uploading") throw c2DraftError("c2_upload_receipt_conflict", "当前清单不再等待这次上传结果");
  if (asset) {
    if (asset.assetId !== upload.assetId || asset.fileName !== upload.fileName || asset.mediaType !== upload.mediaType ||
        asset.assetRef !== `local-asset:${upload.assetId}` || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !Number.isSafeInteger(asset.byteSize) || asset.byteSize <= 0 || asset.byteSize > LOCAL_UPLOAD_MAX_BYTES) {
      throw c2DraftError("c2_upload_receipt_invalid", "本地文件回执与登记不一致");
    }
    Object.assign(upload, asset, { status: "ready", settledAt });
    next.selection.push({ assetId: upload.assetId, order: next.selection.length + 1 });
  } else {
    if (!["upload_incomplete", "file_storage_unconfirmed", "upload_rejected"].includes(failureCode)) throw c2DraftError("c2_upload_failure_invalid", "上传失败类型未明确");
    if (failureCode === "upload_rejected") {
      if (!["c2_upload_content_invalid", "c2_video_validation_unavailable", "c2_upload_animation_unsupported", "c2_upload_decoder_busy"].includes(rejectedCode)) throw c2DraftError("c2_upload_failure_invalid", "文件拒绝原因未明确");
      upload.rejectedCode = rejectedCode;
    }
    Object.assign(upload, { status: "failed", failureCode, settledAt });
  }
  next.revision += 1;
  return next;
}

export function saveC2UploadSelection(candidate, { dataRevision, draftRevision, selection }) {
  const { draft } = assertCurrentC2UploadDraft(candidate, { dataRevision, draftRevision });
  if (!draft || !Array.isArray(selection)) throw c2DraftError("c2_upload_selection_invalid", "素材选择清单无效", 400);
  if (draft.uploads.some(upload => upload.status === "uploading")) throw c2DraftError("c2_upload_unfinished", "尚有上传未结束，不能修改清单");
  if (new Set(selection.map(item => item?.assetId)).size !== selection.length) throw c2DraftError("c2_upload_selection_invalid", "素材不能重复", 400);
  for (const [index, item] of selection.entries()) {
    const asset = draft.uploads.find(upload => upload.assetId === item?.assetId && upload.status === "ready");
    if (!asset || Object.keys(item).some(key => !["assetId", "order"].includes(key)) || item.order !== index + 1) {
      throw c2DraftError("c2_upload_selection_invalid", "素材身份或顺序不属于当前清单", 400);
    }
  }
  if (selection.length > 0 && draft.uploads.find(upload => upload.assetId === selection[0].assetId)?.mediaType !== "image") {
    throw c2DraftError("c2_upload_selection_invalid", "主人排第一张的必须是图片，它就是主图", 400);
  }
  return { ...structuredClone(draft), revision: draft.revision + 1, selection: structuredClone(selection) };
}

export function selectedC2DraftAssets(draft) {
  if (!draft) return [];
  return draft.selection.map(item => {
    const asset = draft.uploads.find(upload => upload.assetId === item.assetId && upload.status === "ready");
    if (!asset) throw c2DraftError("c2_upload_selection_invalid", "已保存清单引用了未完成的文件");
    return { ...structuredClone(asset), order: item.order };
  });
}

// Resolve by the persisted candidate/SKU registration; opaque asset refs are never filesystem paths.
export function resolveRegisteredC2FinalAsset(candidate, finalAsset) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  const authorization = sku?.productionAuthorization;
  const draft = candidate?.lifecycleV11?.c2UploadDraft;
  const scope = authorization?.lockedScope;
  // 不再比对登记时的 C1 版本：C1 改版后主人可以复用原来那次素材确认
  // （审计事件 c2_final_uploads_confirmation_reused），此时上传登记仍指向旧 C1，而授权、
  // 素材域和当前 C1 都已刷新，这条比对必然失败。文件身份由下面十个字段对 draft 登记和授权
  // 冻结清单双向逐字段比对保证，其中含 sha256，比来源指纹更硬。
  if (!draft || draft.candidateId !== candidate.id || draft.skuPackageId !== sku.skuPackageId ||
      draft.schemaEvidenceRef !== scope.schemaEvidenceRef) {
    throw c2DraftError("c2_final_registration_mismatch", "最终素材登记不属于当前授权的商品或Schema证据");
  }
  const registered = selectedC2DraftAssets(draft).find(asset => asset.assetId === finalAsset?.assetId);
  const frozen = scope.finalUploads.find(asset => asset.assetId === finalAsset?.assetId);
  const fields = ["assetId", "assetRef", "fileName", "mediaType", "assetVersion", "sha256", "byteSize", "width", "height", "order"];
  if (!registered || !frozen || fields.some(field => registered[field] !== finalAsset[field] || frozen[field] !== finalAsset[field])) {
    throw c2DraftError("c2_final_registration_mismatch", "最终素材文件或顺序与已确认登记不一致");
  }
  return registered;
}

