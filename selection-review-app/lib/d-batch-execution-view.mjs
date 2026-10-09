const clone=value=>structuredClone(value);

/** Read-only per-offer projection; a batch aggregate never overwrites a member's result. */
export function projectDBatchExecutionView(document,batchId){
  const batches=document?.runtime?.dProductionBatches?.filter(value=>value.batchId===batchId)??[];
  if(batches.length===0)throw new Error('D_BATCH_VIEW_BATCH_NOT_FOUND');
  if(batches.length!==1)throw new Error('D_BATCH_VIEW_BATCH_NOT_UNIQUE');
  const batch=batches[0];
  const imports=document.runtime.dBatchImportJobs?.filter(value=>value.batchId===batchId)??[];
  if(imports.length>1)throw new Error('D_BATCH_VIEW_IMPORT_NOT_UNIQUE');
  const job=imports[0]??null;
  const stockJobs=document.runtime.dBatchStockJobs??[];
  const eJobs=document.runtime.dBatchEJobs??[];
  const eResults=document.runtime.dBatchEReadbacks??[];
  if(![stockJobs,eJobs,eResults].every(Array.isArray))throw new Error('D_BATCH_VIEW_STORE_INVALID');
  const members=batch.members.map(member=>{
    const chunks=job?.chunks.filter(chunk=>chunk.offerIds.includes(member.offerId))??[];
    if(chunks.length>1)throw new Error('D_BATCH_VIEW_CHUNK_NOT_UNIQUE');
    const chunk=chunks[0]??null;
    const results=chunk?.results?.filter(result=>result.offerId===member.offerId)??[];
    const stocks=stockJobs.filter(value=>value.batchId===batchId&&value.offerId===member.offerId);
    const e=eJobs.filter(value=>value.batchId===batchId&&value.offerId===member.offerId);
    const readbacks=eResults.filter(value=>value.batchId===batchId&&value.offerId===member.offerId);
    if(results.length>1||stocks.length>1||e.length>1||readbacks.length>1)
      throw new Error('D_BATCH_VIEW_MEMBER_RESULT_NOT_UNIQUE');
    const result=results[0]??null,stock=stocks[0]??null,readback=readbacks[0]??null;
    if((stock||readback)&&result?.classification!=='imported'||
        readback&&(!e[0]||e[0].resultId!==readback.readbackId))
      throw new Error('D_BATCH_VIEW_RESULT_SOURCE_CONFLICT');
    return {candidateId:member.candidateId,skuPackageId:member.skuPackageId,
      offerId:member.offerId,memberStatus:member.status,
      chunkIndex:chunk?.index??null,taskId:chunk?.taskId??null,
      productId:result?.importObservation?.productId??null,
      importStatus:result?.classification??chunk?.status??'not_started',
      importGapCode:result?.gapCode??chunk?.prewriteReasonCode??null,
      inventoryAction:batch.postImportScope?.inventoryAction??null,
      inventoryStatus:stock?.status??'not_started',
      inventoryReason:stock?.ownerReason??stock?.unknownReason??stock?.failureReason??null,
      eStatus:readback?.status??e[0]?.status??'not_started',
      eGaps:readback?.gaps??[],listedVerified:readback?.listedVerified??false};
  });
  return Object.freeze({schemaVersion:'d-batch-execution-view-v1',batchId,
    status:batch.status,externalRequestState:batch.externalRequestState,
    excludedOfferIds:clone(batch.excludedOfferIds),members:clone(members)});
}
