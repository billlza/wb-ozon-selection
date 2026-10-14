export function isExternalFileDrag(transfer) {
  return Array.from(transfer?.types || []).includes("Files");
}

export function acceptC2DraftReceipt(result, { candidateId, dataRevision, draftRevision, revisionAdvance }) {
  if (result?.candidateId !== candidateId || result.dataRevision !== dataRevision ||
      result.draft?.candidateId !== candidateId || result.draft.sourceCandidateRevision !== dataRevision ||
      !Number.isSafeInteger(result.draft.revision) || result.draft.revision !== draftRevision + revisionAdvance) {
    throw new Error("素材保存回执与本次商品或修订不一致，请刷新核对；不会自动重复提交。");
  }
  return result.draft;
}

export async function uploadC2Files(files, { candidateId, dataRevision, draftRevision, upload, receive, progress }) {
  let revision = draftRevision;
  for (const [index, file] of files.entries()) {
    progress({ total: files.length, saved: index, current: file.name, failed: false });
    try {
      const result = await upload(file, { dataRevision, draftRevision: revision });
      const draft = acceptC2DraftReceipt(result, { candidateId, dataRevision, draftRevision: revision, revisionAdvance: 2 });
      receive(draft);
      revision = draft.revision;
    } catch (error) {
      progress({ total: files.length, saved: index, current: file.name, failed: true });
      throw error;
    }
  }
  progress({ total: files.length, saved: files.length, current: "", failed: false });
}

export function c2ReferenceFailureMessage(message) {
  const code = "C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED";
  return typeof message === "string" && (message === code || message.startsWith(`${code}:`))
    ? "方案卡暂未生成：已确认文案的证据引用与素材确认规则不一致，需要修复。已上传文件已保留，请勿重复上传。"
    : null;
}
