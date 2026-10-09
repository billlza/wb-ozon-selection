import { useState } from "react";
import { useSubmit } from "./FormRevisionNotice.jsx";
import { selectedC2DraftAssets } from "../../lib/c2-upload-draft.mjs";
import { buildC2FinalAssetInput } from "../c2FinalAssetInput.js";
import { acceptC2DraftReceipt, c2ReferenceFailureMessage, isExternalFileDrag, uploadC2Files } from "../c2UploadInput.js";

function formatAssetSize(byteSize) {
  if (!Number.isFinite(byteSize) || byteSize < 0) return "大小未取得";
  const bytes = byteSize;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function assetRoleLabel(index) {
  return index === 0 ? "主图" : "图库图";
}

export default function C2FinalAssetsPanel({ candidate, onUpload, onSave, onConfirm }) {
  const [lastReceipt, setLastReceipt] = useState(null);
  const [ownerChecked, setOwnerChecked] = useState(false);
  const operation = useSubmit();
  const saved = candidate.lifecycleV11?.c2UploadDraft;
  const draft = lastReceipt?.candidateId === candidate.id && lastReceipt.revision > (saved?.revision ?? 0) ? lastReceipt : saved;
  const assets = selectedC2DraftAssets(draft);
  const dataRevision = draft?.sourceCandidateRevision ?? candidate.dataRevision;
  const draftRevision = draft?.revision ?? 0;
  const sourceChanged = dataRevision !== candidate.dataRevision || (draft && (
    draft.skuPackageId !== candidate.lifecycleV11?.skuPackage?.skuPackageId ||
    draft.sourceSkuRevision !== candidate.lifecycleV11?.skuPackage?.dataRevision ||
    draft.schemaEvidenceRef !== candidate.lifecycleV11?.skuPackage?.c2FinalAssets?.targetContext?.schemaEvidenceRef));
  const unfinished = draft?.uploads.filter(upload => upload.status !== "ready") || [];
  const disabled = operation.saving || sourceChanged || unfinished.some(upload => upload.status === "uploading");
  const identity = `${candidate.id}:${dataRevision}:${draftRevision}`;
  const [checkedIdentity, setCheckedIdentity] = useState("");
  // 「移出清单」只把文件从 selection 拿掉，它仍留在 draft.uploads 里——但界面从来不显示这一层，
  // 于是拿出来就放不回去。这里把池子显示出来：传一次，按变体各挑各的子集。
  const selectedIds = new Set(assets.map(asset => asset.assetId));
  const pool = (draft?.uploads || []).filter(upload => upload.status === "ready" && !selectedIds.has(upload.assetId));
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);

  function receiveDraft(nextDraft) {
    setLastReceipt(nextDraft);
    setOwnerChecked(false);
  }

  function chooseFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    return uploadFiles(files);
  }

  function uploadFiles(files) {
    if (!files.length || disabled || !onUpload) return;
    return operation.run(() => {
      setOwnerChecked(false);
      return uploadC2Files(files, { candidateId: candidate.id, dataRevision, draftRevision,
        upload: onUpload, receive: receiveDraft,
        progress: next => setUploadProgress({ ...next, candidateId: candidate.id }) });
    });
  }

  function dragFilesOver(event) {
    if (!isExternalFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled || !onUpload ? "none" : "copy";
    setFileDragActive(!disabled && Boolean(onUpload));
  }

  function dropFiles(event) {
    if (!isExternalFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setFileDragActive(false);
    setDragIndex(null);
    setDropIndex(null);
    if (disabled || !onUpload) return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return operation.run(() => { throw new Error("未读取到可上传的文件，请拖入图片文件，不要拖入文件夹或网页链接。"); });
    return uploadFiles(files);
  }

  function saveSelection(next) {
    return operation.run(async () => {
      setOwnerChecked(false);
      const selection = next.map((asset, index) => ({ assetId: asset.assetId, order: index + 1 }));
      receiveDraft(acceptC2DraftReceipt(await onSave({ dataRevision, draftRevision, selection }),
        { candidateId: candidate.id, dataRevision, draftRevision, revisionAdvance: 1 }));
    });
  }

  // 拖动过程中只动本地高亮；放手才存一次，避免每移一格就打一次服务端。
  function dropAsset(from, to) {
    setDragIndex(null);
    setDropIndex(null);
    if (from === null || to === null || from === to || disabled || !onSave) return undefined;
    const next = [...assets];
    next.splice(to, 0, next.splice(from, 1)[0]);
    return saveSelection(next);
  }

  function moveAsset(index, delta) {
    const next = [...assets];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    return saveSelection(next);
  }

  let preview = null;
  let requirementsError = "";
  try { preview = buildC2FinalAssetInput({ candidate, sourceRevision: dataRevision, draftRevision, assets, ownerChecked: true }); }
  catch (failure) { requirementsError = failure.message; }
  const canConfirm = preview !== null && ownerChecked && checkedIdentity === identity && !disabled && Boolean(onConfirm);
  function confirmAssets() {
    if (!canConfirm) return;
    return operation.run(() => onConfirm(buildC2FinalAssetInput({ candidate, sourceRevision: dataRevision, draftRevision, assets, ownerChecked })));
  }

  return (
    <div className="c2-final-assets-panel" onDragEnter={dragFilesOver} onDragOver={dragFilesOver}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFileDragActive(false); }}
      onDrop={dropFiles}>
      {sourceChanged && <p role="alert">商品或C1资料已变化。旧素材清单已保留，请先核对绑定；不会自动挪到新SKU。</p>}
      {operation.error && <p role="alert">{c2ReferenceFailureMessage(operation.error) || operation.error}；本轮已停止，没有自动重试。已保存的文件可刷新查看。</p>}
      {uploadProgress?.candidateId === candidate.id && <p role="status" className="c2-upload-progress">
        本批已保存 {uploadProgress.saved} / {uploadProgress.total} 张。
        {uploadProgress.failed ? `在“${uploadProgress.current}”处停止，结果请核对下方登记；其后 ${uploadProgress.total - uploadProgress.saved - 1} 张尚未上传。`
          : uploadProgress.current ? `正在上传“${uploadProgress.current}”…` : "全部上传完成，请核对首图和顺序。"}
      </p>}
      <div className="c2-final-assets-heading">
        <div><b>C2 最终上传素材</b><span>上传和顺序会保存在本地；排第一张的就是主图，最后一次确认才锁定最终素材。可以直接拖动调整顺序，也可以用「上移／下移」。</span></div>
        <span className="c2-asset-count">{assets.length}</span>
      </div>
      {candidate.siblingSourceV1 ? <p role="status">本规格需要自己的首图：请上传并把体现当前颜色的图片排第一。首图不得与父卡任何已确认图片相同；现有上传入口就在下方。</p> : null}
      <label className={`c2-file-picker ${disabled || !onUpload ? "disabled" : ""}${fileDragActive ? " is-file-drop-target" : ""}`}>
        <input type="file" multiple accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" disabled={disabled || !onUpload} onChange={chooseFiles} />
        <b>{operation.saving ? "正在保存素材清单…" : "添加最终图片"}</b>
        <span>{fileDragActive ? "松开即可添加图片" : "把图片拖到此素材区域，或点击选择文件"}</span>
        <small>可一次多选JPG、PNG、WEBP静态图片；每文件不超过100MB、2000万像素。视频内容校验尚未配置。平台最终要求另行核验。</small>
      </label>
      {unfinished.map(upload => <p key={upload.uploadId} role="alert">{upload.fileName}：{upload.status === "uploading" ? "尚未取得完整上传回执，需要核对本地记录" : upload.failureCode === "upload_rejected" ? "内容校验未通过，未保存为可用素材" : "上传未完成，登记已保留"}。</p>)}
      {assets.length ? (
        <ol className="c2-final-asset-list">
          {assets.map((asset, index) => (
            <li key={asset.assetId} className={`${index === 0 ? "is-main" : ""}${dropIndex === index && dragIndex !== index ? " is-drop-target" : ""}${dragIndex === index ? " is-dragging" : ""}`}
              draggable={!disabled && Boolean(onSave)}
              onDragStart={event => { event.dataTransfer.effectAllowed = "move"; setDragIndex(index); }}
              onDragOver={event => { if (isExternalFileDrag(event.dataTransfer) || dragIndex === null) return; event.preventDefault(); event.stopPropagation(); setDropIndex(index); }}
              onDragLeave={() => setDropIndex(current => (current === index ? null : current))}
              onDrop={event => { if (isExternalFileDrag(event.dataTransfer) || dragIndex === null) return; event.preventDefault(); event.stopPropagation(); return dropAsset(dragIndex, index); }}
              onDragEnd={() => { setDragIndex(null); setDropIndex(null); }}>
              <div className="c2-final-asset-order">{index + 1}</div>
              {asset.mediaType === "image" && <img className="c2-local-preview" src={`/api/candidates/${encodeURIComponent(candidate.id)}/lifecycle/c2/local-assets/${encodeURIComponent(asset.assetId)}`} alt={asset.fileName} />}
              <div className="c2-final-asset-copy">
                <b>{asset.fileName}</b>
                <span>{assetRoleLabel(index)} · {formatAssetSize(asset.byteSize)}</span>
              </div>
              <div className="c2-final-asset-actions">
                <button type="button" className="button secondary" disabled={index === 0 || disabled || !onSave} onClick={() => moveAsset(index, -1)}>上移</button>
                <button type="button" className="button secondary" disabled={index === assets.length - 1 || disabled || !onSave} onClick={() => moveAsset(index, 1)}>下移</button>
                <button type="button" className="button secondary danger" disabled={disabled || !onSave} onClick={() => saveSelection(assets.filter(item => item.assetId !== asset.assetId))}>移出清单</button>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="c2-empty-assets">尚未选择最终素材。当前商品仍停在C2，不会自动进入生产。</p>}
      {pool.length ? (
        <div className="c2-asset-pool">
          <div className="c2-asset-pool-heading">
            <b>已上传、这次没用上</b>
            <span>{pool.length} 个。文件还在本机，没有删除；随时可以加回清单。</span>
          </div>
          <ul>
            {pool.map(upload => (
              <li key={upload.assetId}>
                {upload.mediaType === "image" && <img className="c2-local-preview" src={`/api/candidates/${encodeURIComponent(candidate.id)}/lifecycle/c2/local-assets/${encodeURIComponent(upload.assetId)}`} alt={upload.fileName} />}
                <span>{upload.fileName}</span>
                <button type="button" className="button secondary" disabled={disabled || !onSave}
                  onClick={() => saveSelection([...assets, upload])}>加入清单</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {requirementsError && assets.length > 0 && <p className="field-error">{requirementsError}</p>}
      <label className="c2-owner-confirmation">
        <input type="checkbox" checked={ownerChecked && checkedIdentity === identity} disabled={!assets.length || disabled} onChange={event => { setOwnerChecked(event.target.checked); setCheckedIdentity(identity); }} />
        <span>我确认以上文件属于当前SKU，并确认所选用途、唯一首图、顺序和本次{assets.some(asset => asset.mediaType === "video") ? "包含视频" : "不含视频"}。</span>
      </label>
      <button type="button" className="button primary" disabled={!canConfirm} onClick={confirmAssets}>{operation.saving ? "正在保存…" : "确认最终素材并生成方案卡"}</button>
      <small>这次确认只完成C2并生成最终商品方案卡，不创建生产授权、不派发任务、不访问或写入店铺。需要公开转存的素材将在取得精确生产授权后由软件处理。</small>
    </div>
  );
}
