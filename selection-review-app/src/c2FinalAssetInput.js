// 槽位合同已废止：平台从没交出过槽位、角色或张数上限，真实 import 只写
// primary_image = urls[0] 和 images = urls.slice(1)。主人排第一张的就是主图，
// 其余按主人给的顺序进图库；软件不重排，也不替主人挑图。
export function buildC2FinalAssetInput({ candidate, sourceRevision, draftRevision, assets, ownerChecked }) {
  if (!Number.isInteger(sourceRevision) || sourceRevision !== candidate.dataRevision) throw new Error("商品修订已变化，未提交旧素材。");
  if (!Number.isSafeInteger(draftRevision) || draftRevision < 1) throw new Error("素材清单尚未持久保存，不能确认。");
  if (!ownerChecked) throw new Error("请明确确认最终素材、首图、顺序和视频处置。");
  if (!assets.length || new Set(assets.map(asset => asset.assetId)).size !== assets.length) throw new Error("最终素材清单为空或重复。");
  if (assets[0].mediaType !== "image") throw new Error("排在第1位的必须是图片，它就是主图。");
  const finalUploadAssets = assets.map((asset, index) => {
    const result = {};
    for (const key of ["assetId", "mediaType", "assetRef", "fileName", "assetVersion", "sha256", "byteSize", "sourceEvidenceRef", "sourceType", "stagedAt", "stableUrlEvidenceRef", "usageAuthorization", "width", "height"]) {
      if (asset[key] !== undefined) result[key] = structuredClone(asset[key]);
    }
    return { ...result, role: index === 0 ? "main_image" : "gallery_image", order: index + 1, addedAt: asset.stagedAt };
  });
  const includesVideo = finalUploadAssets.some(asset => asset.mediaType === "video");
  const c2 = candidate.lifecycleV11.skuPackage.c2FinalAssets;
  if (!includesVideo && c2.ownerVideoRequirement?.required === true) {
    throw new Error("主人已要求视频，缺少视频不能确认。");
  }
  return {
    dataRevision: sourceRevision,
    draftRevision,
    finalUploadAssets: finalUploadAssets.map(({ assetId, order }) => ({ assetId, order })),
    approvedAssetIds: finalUploadAssets.map(asset => asset.assetId),
    approvedMainImageAssetId: finalUploadAssets[0].assetId,
    approvedVideoDisposition: includesVideo ? "includes_video" : "excludes_video",
    confirmationNote: null
  };
}
