async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  let body;
  try { body = await response.json(); }
  catch {
    const error = new Error(`服务返回了无效JSON（HTTP ${response.status}），结果未确认；请核对后再操作。`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body?.message || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function uploadFile(path, file) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file
  });
  let body;
  try { body = await response.json(); }
  catch {
    const error = new Error(`素材暂存返回无效JSON（HTTP ${response.status}），结果未确认；请核对后再操作。`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body?.message || `素材上传失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  getC2UploadDraft: id => request(`/api/candidates/${encodeURIComponent(id)}/lifecycle/c2/upload-draft`),
  getSiblingPreparation: id => request(`/api/sibling-batches/${encodeURIComponent(id)}/preparation`),
  saveSiblingPreparation: (id,payload) => request(`/api/sibling-batches/${encodeURIComponent(id)}/preparation-draft`, {method:'POST',body:JSON.stringify(payload)}),
  getSiblingCatalogFile: async (id,assetId) => {
    const response=await fetch(`/api/sibling-batches/${encodeURIComponent(id)}/preparation-assets/${encodeURIComponent(assetId)}`);
    if(!response.ok)throw new Error('本批原始素材读取失败，已停止暂存');
    return response.blob();
  },

  reviseC1FinalPlan: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/revise-final-plan`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  confirmC1EditorialContent: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/confirm-editorial-content`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  confirmC1Content: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/confirm-content`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  getProductDetails: (candidateId,revision,signal) => request(`/api/candidates/${encodeURIComponent(candidateId)}/product-details?revision=${revision}`,{signal}),
  authorizeProductDetails: payload => request(`/api/candidates/${encodeURIComponent(payload.candidateId)}/product-details/authorize`,{method:'POST',body:JSON.stringify(payload)}),
  continueProductDetails: payload => request(`/api/candidates/${encodeURIComponent(payload.candidateId)}/product-details/continue`,{method:'POST',body:JSON.stringify(payload)}),
  getProductDiscovery: signal => request('/api/product-discovery',{signal}),
  createProductDiscovery: payload => request('/api/product-discovery/create',{method:'POST',body:JSON.stringify(payload)}),
  // One request starts one round: the desk never sends a create that a second request has to finish.
  startProductDiscovery: payload => request('/api/product-discovery/start',{method:'POST',body:JSON.stringify(payload)}),
  authorizeProductDiscovery: payload => request('/api/product-discovery/authorize',{method:'POST',body:JSON.stringify(payload)}),
  continueProductDiscovery: payload => request('/api/product-discovery/continue',{method:'POST',body:JSON.stringify(payload)}),
  selectProductDiscovery: payload => request('/api/product-discovery/select',{method:'POST',body:JSON.stringify(payload)}),
  declineProductDiscovery: payload => request('/api/product-discovery/decline',{method:'POST',body:JSON.stringify(payload)}),
  translateProductDiscovery: payload => request('/api/product-discovery/translate',{method:'POST',body:JSON.stringify(payload)}),
  estimateProductDiscovery: payload => request('/api/product-discovery/estimate',{method:'POST',body:JSON.stringify(payload)}),
  recalculateBWithExactCommission: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/b/exact-commission/recalculate`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  refreshBFeeEvidence: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/b-evidence/refresh`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  saveFinalPricingReview: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/final-pricing/review`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  continueC1Preparation: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/continue-preparation`, {
    method: 'POST', body: JSON.stringify(payload)
  }),
  retryC1KeywordHandoff: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/keyword-handoff/retry`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  // 同一次1688采集里已采到、却没搬进冻结快照的供应商属性（面料、适合季节、颜色…）。免费。
  backfillC1SupplyAttributes: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/supply-attribute-backfill`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  // 这个类目的全部属性、可当依据的已确认事实、已经签过的映射。只读，不查字典。
  getC1OzonAttributes: (candidateId, signal) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/ozon-attributes`, { signal }),
  // 重读这个类目的 Schema，把计划里冻结的那一份换成新的（只读、免费）。
  refreshC1CategorySchema: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/refresh-category-schema`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  // 让软件把属性表填好（会花一次 AI 调用的钱，所以是主人主动点）。
  proposeC1OzonAttributes: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/ozon-attribute-proposal`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  // 主人签下「这条中文事实，在Ozon上就是这个俄文字典值」。
  saveC1OzonAttributeMapping: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/ozon-attribute-mapping`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  reviseSiblingColor: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/revise-sibling-color`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  authorizeC1ColorDictionary: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/color-dictionary/authorize`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  continueC1ColorDictionary: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/color-dictionary/continue`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  getAccountPreparations: signal => request('/api/account-preparations',{signal}),
  createAccountPreparation: payload => request('/api/account-preparations/create',{method:'POST',body:JSON.stringify(payload)}),
  authorizeAccountDiscovery: payload => request('/api/account-preparations/authorize',{method:'POST',body:JSON.stringify(payload)}),
  continueAccountDiscovery: payload => request('/api/account-preparations/continue',{method:'POST',body:JSON.stringify(payload)}),
  selectAccountWarehouse: payload => request('/api/account-preparations/select-warehouse',{method:'POST',body:JSON.stringify(payload)}),
  readOriginalC1DraftResult: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/paid-draft/reconcile-result`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  continueSavedC1Draft: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/paid-draft/continue-saved`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  authorizeC1PaidDraft: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/paid-draft/authorize`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  saveC1RightsReview: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c1/rights-review`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  getOwnerAccess: signal => request("/api/owner-access", { signal }),
  setupOwnerAccess: ({ password }) => request("/api/owner-access/setup", { method: "POST", body: JSON.stringify({ password }) }),
  loginOwnerAccess: ({ password }) => request("/api/owner-access/login", { method: "POST", body: JSON.stringify({ password }) }),
  logoutOwnerAccess: () => request("/api/owner-access/logout", { method: "POST", body: JSON.stringify({}) }),
  getSeerfarRuntimeStatus: () => request("/api/integrations/seerfar/runtime-status"),
  getPhase2ASimulation: () => request("/api/simulations/phase-2a"),
  confirmPhase2ASimulation: (payload) =>
    request("/api/simulations/phase-2a/confirm", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  confirmRealAStage: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/a-confirm`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 主人亲自核实一条「结果未知」的采集记录。只记下他的确认，不写采集结果，也不动业务状态。
  reviewSourceCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/source-capture/review`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 重新去读一次同一个1688页面。回执与申请采集时一模一样，所以页面接着走同一条开始信号；这次采到的规格会被作废。
  recaptureSourceCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/source-capture/recapture`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getSupplierDraft: (candidateId, signal) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/supplier-draft`, { signal }),
  saveSupplierDraft: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/supplier-draft`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 选定 the captured specifications of one product. It only records the owner's choice and freezes it into this
  // product's supply plan: no dispatch, no supplier contact, no platform write.
  chooseSourceSkus: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/sku-choice`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 运输属性 — the owner's own statement of what this product is for transport. It only records that statement:
  // no dispatch, no supplier contact, no platform write, and no profit conclusion.
  declareCargoFacts: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/cargo-facts`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 每单额外操作费 — 包材／拆单费／合包费／额外材料费这一类，每单要另外花的钱。一行都没有就是 ¥0.00，而且那是
  // 主人的一次明确声明。它只记录这份声明并把合计写进本商品的成本事实：不派任务、不联系供应商、不碰平台。
  declareExtraHandlingFees: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/extra-handling-fees`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 同重同价声明 — 主人对某一次采集说的一句话：「这些规格是同一件货的不同规格，缺的重量和货价按我在找货里填的算」。
  // 它只记录这句话：采到了真实重量或货价的规格仍按采到的算，重新采集之后它自动失效。uniform:false 就是撤回。
  // 不派任务、不联系供应商、不碰平台。
  declareSkuUniformSupply: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/sku-uniform-supply`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 淘汰 / 恢复 are the owner's own soft delete: one status, one instant, one history line, no dispatch, no platform.
  eliminateCandidate: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/workflow/eliminate`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  restoreCandidate: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/workflow/restore`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getState: (signal) => request("/api/state", { signal }),
  getThreeStoreMap: () => request("/api/three-store-map"),
  dispatchCandidate: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/dispatch`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  confirmProductionAuthorization: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/production-authorization`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  confirmLifecycleFinalAssets: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c2/final-assets`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  saveC2UploadDraft: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c2/upload-draft`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  uploadLifecycleFinalAsset: (candidateId, { dataRevision, draftRevision, file }) =>
    uploadFile(
      `/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c2/final-assets/upload?dataRevision=${encodeURIComponent(dataRevision)}&draftRevision=${encodeURIComponent(draftRevision)}&fileName=${encodeURIComponent(file.name)}`,
      file
    ),
  linkSiblingC2Asset: (candidateId, payload) => request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/c2/final-assets/link`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  confirmSiblingBatchC2: (parentCandidateId, payload) => request(`/api/candidates/${encodeURIComponent(parentCandidateId)}/sibling-batch-c2-confirm`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  confirmSiblingBatchC1: (parentCandidateId, payload) => request(`/api/candidates/${encodeURIComponent(parentCandidateId)}/sibling-batch-c1-confirm`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  previewSiblingBatchC1: (parentCandidateId, payload) => request(`/api/candidates/${encodeURIComponent(parentCandidateId)}/sibling-batch-c1-preview`, {
    method: "POST", body: JSON.stringify(payload)
  }),
  saveProductionOwnerDecision: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/production-owner-decision`, {
      method: "POST", body: JSON.stringify(payload)
    }),
  continueSavedDE: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/d-e/continue-saved`, {
      method: "POST", body: JSON.stringify({ candidateId, ...payload })
    }),
  rollbackProductionAuthorization: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/d/authorization-rollback`, {
      method: "POST", body: JSON.stringify({ candidateId, confirmNothingWasSentToPlatform: true, ...payload })
    }),
  reobserveDUnknownOutcome: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/d/unknown-outcome-reobservation`, {
      method: "POST", body: JSON.stringify({ candidateId, confirmPlatformAlreadyCreatedProduct: true, ...payload })
    }),
  reconcileDFromPlatformState: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/d/platform-state-reconciliation`, {
      method: "POST", body: JSON.stringify({ candidateId, confirmPlatformStateMatchesThisRound: true, ...payload })
    }),
  recoverDInitialImport: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/d/initial-import-recovery`, {
      method: "POST", body: JSON.stringify({ candidateId, confirmImportAlreadyAcceptedByPlatform: true, ...payload })
    }),
  dispatchDProductionRound: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/d/production-round`, {
      method: "POST", body: JSON.stringify({ candidateId, confirmPreviousRoundSentNothing: true, ...payload })
    }),
  authorizeAccountRead: payload => request(`/api/candidates/${encodeURIComponent(payload.candidateId)}/lifecycle/account-read/authorize`, {
    method: 'POST', body: JSON.stringify(payload)
  }),
  continueAccountRead: payload => request(`/api/candidates/${encodeURIComponent(payload.candidateId)}/lifecycle/account-read/continue`, {
    method: 'POST', body: JSON.stringify(payload)
  }),
  productionOwnerPreparation: candidateId =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/production-owner-preparation`),
  reviseLifecycleProductionAuthorization: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/lifecycle/production-authorization/revise`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  startSourceCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/source-capture/start`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 读一次这个 Ozon 商品页。只送当前数据修订号：要读哪个页面由服务端从这件商品自己已经保存的地址里取，
  // 页面不传目标。回执与 1688 申请采集一模一样，所以接着走 captureStart.js 里同一条开始信号。
  // 用首图在 1688 找一次同款（拼多多、1688 货源首图或 Ozon 主图）。回执与申请采集同形，接着走 captureStart.js 里同一条开始信号（换成找同款那一条）。
  startSupplierImageMatch: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/image-match/start`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 把这次找同款的结果重新比对一次首图；结果和主人的判断都不动。
  compareSupplierImageMatch: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/image-match/compare`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 主人对其中一条的判断：是同款 / 近似款 / 不是，或撤回。只是同款判断，不是供货确认。
  judgeSupplierImageMatch: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/image-match/judgement`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 在 Ozon 找同款：带上这次搜的俄文词。回执与申请采集同形，接着走 captureStart.js 里同一条开始信号（换成 Ozon 找同款那一条）。
  startOzonImageMatch: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/ozon-match/start`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  compareOzonImageMatch: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/ozon-match/compare`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  judgeOzonImageMatch: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/ozon-match/judgement`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  startOzonSalesCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/sales-capture/start`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  completeOzonSalesCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/sales-capture/result`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  completeSourceCapture: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/source-capture/result`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  selectSourceCaptureSku: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/source-capture/select-sku`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  resumeCandidate: (payload) =>
    request("/api/control/resume", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  chooseRecoveryAction: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/recovery-action`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  addCandidate: (payload) =>
    request("/api/candidates", { method: "POST", body: JSON.stringify(payload) }),
  createSiblingSku: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/sibling-sku`, {
      method: 'POST', body: JSON.stringify(payload)
    }),
  createSiblingSkuBatch: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/sibling-sku-batch`, {
      method: 'POST', body: JSON.stringify(payload)
    }),
  confirmSiblingBatchA: (candidateId, payload) =>
    request(`/api/candidates/${encodeURIComponent(candidateId)}/sibling-batch-a-confirm`, {
      method: 'POST', body: JSON.stringify(payload)
    }),
  authorizeProductionBatch: payload => request('/api/d-batches/authorize', {
    method: 'POST', body: JSON.stringify(payload)
  }),
  saveSiblingBatchCommercialDrafts: payload => request('/api/sibling-batches/commercial-drafts', {
    method: 'POST', body: JSON.stringify(payload)
  }),
  getProductionBatch: batchId => request(`/api/d-batches/${encodeURIComponent(batchId)}`),
  getSiblingBatchExecution: parentId => request(`/api/sibling-batches/${encodeURIComponent(parentId)}/execution`),
  resumeProductionBatchStock: batchId => request(`/api/d-batches/${encodeURIComponent(batchId)}/resume`, {
    method: 'POST', body: JSON.stringify({ confirmUnsentStockContinuation: true })
  }),
  updateCandidate: (id, payload) =>
    request(`/api/candidates/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  saveUserEvaluation: (id, payload) =>
    request(`/api/candidates/${id}/user-evaluation`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  addComment: (id, payload) =>
    request(`/api/candidates/${encodeURIComponent(id)}/comments`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  markListed: (id, payload) =>
    request(`/api/candidates/${id}/mark-listed`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  applyListingReadback: (id, payload) =>
    request(`/api/candidates/${id}/listing-readback`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  // 录入页：贴链接、看「找货中」、对一件点「重跑」、整页提示上点「接着找」，以及开始信号桥的回执。
  submitIntakeLinks: (links) => request("/api/intake/links", { method: "POST", body: JSON.stringify({ links }) }),
  getIntakeQueue: ({ bridge = false } = {}) => request(`/api/intake/queue${bridge ? "?bridge=1" : ""}`),
  retryIntake: (candidateId, dataRevision) =>
    request(`/api/intake/${encodeURIComponent(candidateId)}/retry`, { method: "POST", body: JSON.stringify({ dataRevision }) }),
  resumeIntake: () => request("/api/intake/resume", { method: "POST", body: "{}" }),
  reportIntakeStart: (ack) => request("/api/intake/start-ack", { method: "POST", body: JSON.stringify(ack) })
};
