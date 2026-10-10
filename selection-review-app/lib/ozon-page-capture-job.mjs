import { validateSalesSnapshot } from "./sales-snapshot.mjs";

/**
 * 读一次 Ozon 商品页 —— 发起那一半。
 *
 * 结果回传、插件收集器、开始信号和 1688 供应采集的整条受控作业链路早就在了；缺的一直只是「谁来建立这次作业」。
 * 在这之前 POST /api/candidates/:id/sales-capture/start 是一行写死的 409，于是这件商品的类目只能停在 Seerfar
 * 接口给的那一条上，算利润那一步永远拿不到「真实读过的页面」这个前提（主人 2026-09-14 在商品页撞上）。
 *
 * 这个文件只负责三件小事，都不碰网络、不碰业务状态：
 *   1. 把候选已经保存的 Ozon 地址规范成插件肯接受的那一个地址；
 *   2. 判断这次作业到底要读哪个商品编号，判不出来就如实说判不出来，绝不替主人挑一个；
 *   3. 给出插件期望的作业形状（不带 mode、不带 sourceUrl）。
 *
 * www.ozon.ru 只能由主人自己的浏览器经插件读取。这里不发任何请求，也不产生任何快照。
 */
export const OZON_PAGE_CAPTURE_JOB_VERSION = "ozon-page-capture-job-v1";
export const OZON_PAGE_CAPTURE_REQUEST_TYPE = "SELECTION_REVIEW_OZON_CAPTURE_REQUEST";

/**
 * 与插件 extension/1688-capture/capture-request.js 里的 canonicalOzonCaptureSource 逐条一致：
 * 只认 https、只认 www.ozon.ru、不认端口和账号密码、路径只认 /product/<可选短语->数字。
 * 插件在领取时会用它自己的那一份再判一次，两边判得不一样的作业会被插件当场拒掉，
 * 所以 tests/ozon-page-capture-job.test.mjs 用同一张输入表把两个实现逐个比对。
 * 服务端不能直接 import 插件那份：打包进本机运行包的只有 lib/schema/dist，extension 不在里面。
 */
/**
 * 这次读页面，要不要用遗留适配器重建一份机会包。
 *
 * 读页面原本只发生在 A 确认之前——那时候候选还没有生命周期，现造一个机会包是对的。
 * 2026-09-17 加了对标采集之后，读页面也会发生在 C 阶段，而这时候候选身上那份机会包是
 * A 确认真正冻下来的（带 marketAssessment、parentOpportunityId 是 opportunity: 前缀）。
 * 照旧重建会把它换成遗留形态、marketAssessment 丢失、lifecycleV11.status 被退回
 * opportunity_sales_snapshot_captured——**这已经实际损坏过主人的数据，不是假设**。
 *
 * 判据是 skuPackage 在不在：它一存在就说明 A 早就确认过了。
 */
export function shouldRebuildOpportunityFromLegacy(candidate) {
  const sku = candidate?.lifecycleV11?.skuPackage;
  return !(sku !== null && typeof sku === "object" && !Array.isArray(sku));
}

export function canonicalOzonCapturePageUrl(value, expectedProductId) {
  if (typeof value !== "string" || typeof expectedProductId !== "string" || !/^\d{7,}$/.test(expectedProductId)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.ozon.ru" || url.username || url.password || url.port) return null;
    const productId = url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{7,})\/?$/)?.[1];
    return productId === expectedProductId ? `https://www.ozon.ru/product/${productId}/` : null;
  } catch {
    return null;
  }
}

/** 从一个地址里读出 Ozon 商品编号，规则与上面同一套：读不出来就是读不出来，不放宽也不猜。 */
export function ozonCapturePageProductId(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.ozon.ru" || url.username || url.password || url.port) return "";
    return url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{7,})\/?$/)?.[1] || "";
  } catch {
    return "";
  }
}

/** 这件商品身上所有能当成 Ozon 商品页的地址，新的销售快照在前，候选自己保存的地址在后。 */
export function ozonCapturePageAddresses(candidate) {
  const snapshots = (Array.isArray(candidate?.salesSnapshotsV11) ? candidate.salesSnapshotsV11 : [])
    // 对标是别的商品，不参与「这件商品自己的页面是哪一个」。不跳过它们的话，挂上第一个对标之后
    // 这件商品就再也读不了自己的页面——会被判成身份冲突。而「候选自己声明的商品和它自己的快照
    // 对不上」那一条冲突判定必须原样保留：读错商品比读不到更糟。
    .filter(snapshot => snapshot?.comparable !== true)
    .filter(snapshot => validateSalesSnapshot(snapshot).valid)
    .sort((left, right) => Date.parse(right.collectedAt) - Date.parse(left.collectedAt));
  const addresses = snapshots.map(snapshot => ({
    value: typeof snapshot.productUrl === "string" ? snapshot.productUrl : "",
    from: `sales_snapshot:${snapshot.snapshotId}`
  }));
  if (typeof candidate?.productUrl === "string") addresses.push({ value: candidate.productUrl, from: "candidate_product_url" });
  return addresses;
}

/**
 * 这次要读哪一个 Ozon 页面。
 *
 * 保存的地址指向不止一个商品编号时，这里停下来说明冲突，而不是挑第一个去读：读错商品比读不到更糟，
 * 因为读回来的快照会被当成这件商品的真实证据存档。
 */
export function ozonCapturePageTarget(candidate, requestedProductUrl = null) {
  // 主人自己指名了要读哪个页面时，这里没有「挑」这回事：读的就是他给的那一个。
  // 这条是给对标用的——一个候选身上要挂好几个可比商品，反推目标那套只在「只有一个商品」时成立。
  if (requestedProductUrl !== null) {
    // 读不出编号的地址，canonicalOzonCapturePageUrl 自己就会回 null（它要求编号是 7 位以上数字），
    // 所以这里不再单独判一次——多一个分支就多一段没人走过的代码。
    const requestedId = ozonCapturePageProductId(requestedProductUrl);
    const canonical = canonicalOzonCapturePageUrl(requestedProductUrl, requestedId);
    if (canonical === null) {
      return Object.freeze({ ok: false, code: "ozon_product_url_invalid",
        reason: "给的 Ozon 地址不是一个可以直接打开的商品页，软件不改写它去凑一个。" });
    }
    return Object.freeze({ ok: true, productId: requestedId, productUrl: canonical, from: "owner_requested_url", reason: "" });
  }
  const resolved = ozonCapturePageAddresses(candidate)
    .map(entry => ({ ...entry, productId: ozonCapturePageProductId(entry.value) }))
    .filter(entry => entry.productId !== "");
  if (resolved.length === 0) {
    return Object.freeze({
      ok: false,
      code: "ozon_product_url_missing",
      reason: "这件商品还没有保存一个能直接打开的 Ozon 商品页地址，软件没有页面可读。"
    });
  }
  const productIds = [...new Set(resolved.map(entry => entry.productId))];
  if (productIds.length > 1) {
    return Object.freeze({
      ok: false,
      code: "ozon_product_identity_conflict",
      reason: `这件商品身上保存了不止一个 Ozon 商品编号（${productIds.join("、")}），软件不替你挑一个去读。`
    });
  }
  const productId = productIds[0];
  const productUrl = canonicalOzonCapturePageUrl(resolved[0].value, productId);
  if (productUrl === null) {
    return Object.freeze({
      ok: false,
      code: "ozon_product_url_invalid",
      reason: "保存的 Ozon 地址不是一个可以直接打开的商品页，软件不改写它去凑一个。"
    });
  }
  return Object.freeze({ ok: true, productId, productUrl, from: resolved[0].from, reason: "" });
}

/**
 * 插件领取这次作业时拿到的东西。
 *
 * 形状由插件的 validateOzonCaptureRequest 说了算：带 expectedProductId 和 productUrl，
 * 并且不能带 mode、不能带 sourceUrl —— 带了就会被判成 capture_mode_invalid 当场退回。
 */
export function ozonCapturePageJobPayload(session) {
  return {
    captureId: session.captureId,
    jobId: session.captureId,
    candidateId: session.candidateId,
    dataRevision: session.dataRevision,
    expectedProductId: session.expectedProductId,
    productUrl: session.productUrl,
    requiredExtensionVersion: session.requiredExtensionVersion,
    attempt: session.attempt,
    token: session.token
  };
}

/**
 * 一次读页面没读成，给主人的那句话。
 *
 * 租约到期、服务重启这几种结局不是页面本身的问题，Ozon 采集器自己那张失败表里没有它们；
 * 落到那张表的兜底句会说成「采集器发生系统错误」，那是编出来的因果。这里各给一句实话。
 */
const STOP_MESSAGES = Object.freeze({
  extension_job_unclaimed: "这次读页面的作业在等待期限内没有被插件领取，已经停下，软件不会自动重试",
  unknown_outcome: "插件领取了这次读页面，但在执行期限内没有回传可验证结果，这次的结果未知",
  capture_job_lost: "评审台服务重启了，这次读页面不会再有结果，需要重新读一次",
  extension_version_mismatch: "本次读页面要求的插件版本与当前插件版本不一致"
});

export function ozonPageReadStopMessage(code, detail = "") {
  const base = STOP_MESSAGES[code] || "这次读 Ozon 页面已经停下";
  return detail ? `${base}：${String(detail).slice(0, 800)}` : base;
}

/** 页面拿到的回执：同一次作业，没有一次性令牌。 */
export function ozonCapturePageJobPublic(session) {
  return {
    jobId: session.captureId,
    candidateId: session.candidateId,
    requestRevision: session.requestRevision,
    dataRevision: session.dataRevision,
    expectedProductId: session.expectedProductId,
    productUrl: session.productUrl,
    status: session.jobStatus,
    attempt: session.attempt,
    requiredExtensionVersion: session.requiredExtensionVersion,
    createdAt: new Date(session.createdAt).toISOString(),
    claimedAt: session.claimedAt ? new Date(session.claimedAt).toISOString() : null,
    expiresAt: new Date(session.expiresAt).toISOString()
  };
}
