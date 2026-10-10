import { normalizeSupplierCaptureSource } from "./source-capture.mjs";

/**
 * 新录入页（主人 2026-10-10 拍板的找同款草稿第 1 页）：主人贴一条或几条拼多多 / 1688 链接，软件自己往下跑——
 * 读货源页 → 用首图在 1688 找同款 → 用首图在 Ozon 以图搜 → 粗算利润 → 放进「需要你处理」等主人点「做这件」。
 *
 * 这个文件只做判断，不碰网络、不写数据：看一件商品此刻的记录，说出它走到了哪一步、卡在哪、下一步该排哪个作业。
 * 真正排作业、收结果的是 server.mjs 里的录入泵；三个作业（货源采集、1688 找同款、Ozon 找同款）都是早就有的那几条，
 * 这里只是把它们按顺序接起来。
 *
 * 几条不变的规矩：
 *   - 插件一次只跑一个作业，所以泵每次只推进一件；后面的按贴进来的先后排队。
 *   - 停下来的作业一律等主人点「重跑」或整页提示上的「接着找」，从不自动补跑（AGENTS.md §8.3）。插件没连上时，
 *     排着的根本不开始，所以不算停下；打开 Chrome 以后它们照常往下走。
 *   - 滑块、拼多多要登录、插件没领这类整页的事，停在一件上，整条队就先停着（下一件多半也会碰上），只在页面最上面提示一次。
 *   - 1688 找同款碰上没登录，不拦这件：贴拼多多或 1688 链接的本来就有自己的货源价，照常往下粗算；之后排到的也先跳过
 *     1688 这一步，等主人登录后点「接着找」再补。
 *   - 找同款只列候选、不替主人确认；1688 或 Ozon 没找到，照样往下走，不当成"没有同款"。
 *   - 每件商品的 intake.jobs 记着这一轮由录入泵排过的作业编号；商品页上主人手动搜的那几次不算在这一轮里。
 */
export const INTAKE_SCHEMA_VERSION = "intake-v1";
export const INTAKE_MAX_LINKS_PER_PASTE = 20;
export const INTAKE_STAGES = Object.freeze(["queued", "reading_source", "searching_1688", "searching_ozon", "estimating", "ready", "blocked"]);
export const INTAKE_SOURCE_KINDS = Object.freeze(["pinduoduo", "1688", "seerfar"]);
export const INTAKE_STEPS = Object.freeze(["capture_source", "search_1688", "search_ozon", "estimate"]);
const STEP_STAGE = Object.freeze({ capture_source: "reading_source", search_1688: "searching_1688", search_ozon: "searching_ozon", estimate: "estimating" });
const STEP_JOB = Object.freeze({ capture_source: "sourceCaptureId", search_1688: "supplierMatchId", search_ozon: "ozonMatchId" });
/** 不用插件的步骤：整条队停着、或者插件正忙时也可以做。 */
const OFFLINE_STEPS = new Set(["estimate", "skip_1688"]);

/**
 * 每种停下的原话。scope 是 page 的是整页的事：页面最上面提示一次，整条队先停着；item 只拦这一件。
 * retryable 表示主人处理完外面的事（过滑块、登录、打开 Chrome）后点「重跑」/「接着找」就能接着走；
 * 不能重跑的要主人换一个货源链接，或者不做这件。
 */
export const INTAKE_BLOCKERS = Object.freeze({
  slider_required: { scope: "page", retryable: true, message: "要你在自己的 Chrome 里拖一下滑块，过了再点「接着找」" },
  login_pinduoduo_required: { scope: "page", retryable: true, message: "拼多多要你先在 Chrome 里登录，登好了再点「接着找」" },
  login_1688_required: { scope: "page", retryable: true, message: "1688 登录过期了，在 Chrome 里重新登录一次再点「接着找」" },
  plugin_offline: { scope: "page", retryable: true, message: "插件没领这一步（Chrome 关着或插件没开），打开后点「接着找」" },
  share_link_unresolved: { scope: "item", retryable: false, message: "这条分享链接没打开到商品页，请把浏览器地址栏里的商品页链接重新贴一次" },
  source_out_of_stock: { scope: "item", retryable: false, message: "货源所有规格都没货了，换一个货源，或者不做这件" },
  source_delisted: { scope: "item", retryable: false, message: "货源已经下架了，换一个货源，或者不做这件" },
  presale_too_late: { scope: "item", retryable: false, message: "货源是预售，发货比店铺档案里允许的晚，换有现货的或者你决定照样做" },
  no_source_price: { scope: "item", retryable: false, message: "货源页面上的价没读到，请贴一个能一件起订的货源链接，或者不做这件" },
  source_image_missing: { scope: "item", retryable: true, message: "货源页面没读到首图，没法拿图找同款；点「重跑」再读一次货源页" },
  unknown_outcome: { scope: "item", retryable: true, message: "上一次读货源页没等到结果，软件不知道读没读成；你点「重跑」就当知道了，再读一次" },
  source_unreadable: { scope: "item", retryable: true, message: "这次没读成货源页，点「重跑」再读一次" },
  step_not_started: { scope: "item", retryable: true, message: "这一步没能开始，点「重跑」再试一次" }
});
export const INTAKE_BLOCKER_CODES = Object.freeze(Object.keys(INTAKE_BLOCKERS));

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

export function intakeBlocker(code, { step = null, detail = "" } = {}) {
  const known = INTAKE_BLOCKERS[code] ? code : "source_unreadable";
  const rule = INTAKE_BLOCKERS[known];
  return { code: known, message: detail ? `${rule.message}（${text(detail, 200)}）` : rule.message, retryable: rule.retryable,
    scope: rule.scope, step: INTAKE_STEPS.includes(step) ? step : null };
}

/** 一行里的链接：拼多多的分享文案常常是「【拼多多】……」加一段地址，只取那段地址。 */
function linkIn(line) {
  const found = line.match(/https?:\/\/[^\s"'<>，。、；！）)】]+/i);
  return (found ? found[0] : line).replace(/[.,;!?]+$/, "");
}

/** 货源身份：有商品号的按「平台:商品号」认，分享短链按规范后的地址认（读过页面才知道商品号）。 */
export function intakeSourceIdentity(url) {
  const source = normalizeSupplierCaptureSource(text(url, 2000));
  if (!source.platform || source.type === "invalid") return null;
  return source.offerId ? `${source.platform}:${source.offerId}` : `url:${source.sourceUrl}`;
}

/**
 * 一次粘贴：一行一条，空行和重复的跳过；拼多多和 1688 可以混着贴，软件自己认。认不出来的原样退回，说明为什么。
 * 返回的 sourceUrl 是规范后的地址，offerId 是拼多多 goods_id 或 1688 offer 号（分享短链要读过页面才知道，先是空的）。
 */
export function parseIntakeLinks(input) {
  const lines = (Array.isArray(input) ? input : typeof input === "string" ? input.split(/\r?\n/) : [])
    .map((line) => (typeof line === "string" ? line.trim() : "")).filter(Boolean);
  if (lines.length > INTAKE_MAX_LINKS_PER_PASTE) return { links: [], rejected: [], tooMany: true };
  const links = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of lines) {
    const url = linkIn(raw.slice(0, 2000));
    const source = normalizeSupplierCaptureSource(url);
    if (!["pinduoduo", "1688"].includes(source.platform) || source.type === "invalid") {
      rejected.push({ raw: raw.slice(0, 300), code: "link_unrecognized" });
      continue;
    }
    const identity = intakeSourceIdentity(source.sourceUrl);
    if (seen.has(identity)) continue;
    seen.add(identity);
    links.push({ raw: url, sourceKind: source.platform, sourceUrl: source.sourceUrl, offerId: source.offerId || "", identity });
  }
  return { links, rejected, tooMany: false };
}

/** 一件商品认的货源身份：保存的几条链接，加上读过页面以后才知道的商品号（分享短链读完才有）。 */
export function candidateSourceIdentities(candidate) {
  const identities = new Set();
  const urls = [candidate?.productUrl, candidate?.sourceUrl, candidate?.competitorUrl, candidate?.sourceCapture?.sourceUrl,
    candidate?.sourceCapture?.originalSourceUrl, candidate?.intake?.sourceUrl, candidate?.intake?.originalUrl];
  for (const url of urls) {
    const identity = intakeSourceIdentity(url);
    if (identity) identities.add(identity);
  }
  const platform = normalizeSupplierCaptureSource(text(candidate?.sourceCapture?.sourceUrl, 2000)).platform;
  const resolved = text(candidate?.sourceCapture?.offerId, 80);
  if (platform && resolved) identities.add(`${platform}:${resolved}`);
  return identities;
}

/**
 * 这条链接是不是已经有一件商品了（之前贴过，或者 Seerfar 今天也挑到了同一件）。有就返回那一件，不新建、不再找一遍。
 * 淘汰过的也算：留着它就是为了查重（AGENTS.md §3.5），要不要重新看由主人另外决定，这里不会悄悄复活它。
 */
export function intakeDuplicateOf(candidates, link) {
  const wanted = link?.identity || intakeSourceIdentity(link?.sourceUrl);
  if (!wanted) return null;
  return (Array.isArray(candidates) ? candidates : []).find((candidate) => candidateSourceIdentities(candidate).has(wanted)) || null;
}

export function newIntakeRecord({ link, submittedAt, submittedBy, batchId, batchIndex, batchSize }) {
  return {
    schemaVersion: INTAKE_SCHEMA_VERSION,
    sourceKind: link.sourceKind,
    sourceUrl: link.sourceUrl,
    originalUrl: link.raw,
    submittedAt,
    submittedBy,
    batch: { id: batchId, index: batchIndex, size: batchSize },
    stage: "queued",
    blocker: null,
    jobs: { sourceCaptureId: null, supplierMatchId: null, ozonMatchId: null },
    skips: {},
    lastRetry: null,
    resumedAt: null,
    startedAt: null,
    finishedAt: null
  };
}

const SOURCE_IN_FLIGHT = new Set(["waiting_extension", "capturing", "extension_version_mismatch"]);
const MATCH_IN_FLIGHT = new Set(["waiting_extension", "searching", "comparing"]);
const JOB_IN_FLIGHT = new Set(["queued", "claimed", "claim_pending"]);
/** 作业排了却没被领取、或者服务重启丢了：插件那头的事，整页提示。 */
const PLUGIN_CODES = new Set(["extension_job_unclaimed", "capture_job_lost", "service_restarted_before_claim", "extension_not_installed",
  "extension_background_unavailable", "extension_version_mismatch", "capture_job_expired"]);

/** 货源页没读成时说什么。滑块、登录这种主人处理完能接着走；分享链接打不开、没价，要主人换链接。 */
function sourceCaptureBlocker(record, sourceKind) {
  const step = "capture_source";
  if (record?.jobStatus === "unknown_outcome" || record?.failureCode === "unknown_outcome") return intakeBlocker("unknown_outcome", { step });
  const code = record?.failureCode;
  if (code === "site_verification_required") return intakeBlocker("slider_required", { step, detail: sourceKind === "pinduoduo" ? "拼多多" : "1688" });
  if (code === "site_login_required") return intakeBlocker(sourceKind === "pinduoduo" ? "login_pinduoduo_required" : "login_1688_required", { step });
  if (code === "short_link_resolution_failed") return intakeBlocker("share_link_unresolved", { step });
  if (code === "exact_price_unavailable") return intakeBlocker("no_source_price", { step });
  if (PLUGIN_CODES.has(code)) return intakeBlocker("plugin_offline", { step });
  return intakeBlocker("source_unreadable", { step, detail: text(record?.reason, 120) });
}

/** 读回来的货源页本身说明做不了：下架、所有规格都没货、一个价都没有、没有首图可以拿去找同款。 */
function capturedSourceBlocker(record) {
  const step = "capture_source";
  if (record?.offerStatus === "off_sale") return intakeBlocker("source_delisted", { step });
  const skus = Array.isArray(record?.skuChoices) ? record.skuChoices : [];
  if (skus.length > 0 && skus.every((sku) => sku?.inStock === false)) return intakeBlocker("source_out_of_stock", { step });
  const prices = skus.map((sku) => sku?.priceCny).filter((value) => typeof value === "number" && value > 0);
  const ranges = Array.isArray(record?.priceRanges) ? record.priceRanges : [];
  if (prices.length === 0 && ranges.length === 0) return intakeBlocker("no_source_price", { step });
  if (!text(record?.mainImageUrl, 2000)) return intakeBlocker("source_image_missing", { step });
  return null;
}

/** 1688 / Ozon 找同款只有这几种停下要等主人；别的（没搜到、上传框没找到、页面读不出、结果未知）照样往下走。 */
function matchBlocker(record, step) {
  if (record?.status !== "failed" || record?.jobStatus === "unknown_outcome") return null;
  if (record.failureCode === "site_verification_required") return intakeBlocker("slider_required", { step, detail: step === "search_1688" ? "1688" : "Ozon" });
  if (PLUGIN_CODES.has(record.failureCode)) return intakeBlocker("plugin_offline", { step });
  return null;
}

/** 这一件的 1688 找同款是不是因为没登录而没搜成（不拦这件，只记下来，等主人登录后补）。 */
export function supplierMatchNeedsLogin(candidate) {
  const record = candidate?.supplierImageMatch;
  const jobs = candidate?.intake?.jobs;
  return Boolean(jobs?.supplierMatchId && record?.captureId === jobs.supplierMatchId && record.status === "failed" &&
    record.failureCode === "site_login_required");
}

/**
 * 这件商品此刻在哪一步、下一步做什么。next 只会是 capture_source / search_1688 / skip_1688 / search_ozon / estimate 之一或 null；
 * null 表示在等插件（作业已排、还没回来）、已经停下等主人、或者已经算完。login1688Expired 为真时 1688 这一步先跳过。
 */
export function intakeProgress(candidate, { login1688Expired = false } = {}) {
  const intake = candidate?.intake;
  if (!isObject(intake)) return null;
  const idle = (stage, extra = {}) => ({ stage, blocker: null, step: null, next: null, waiting: false, ...extra });
  if (candidate.workflowStatus === "eliminated") return idle(intake.stage, { blocker: intake.blocker ?? null, closed: true });
  // 主人在「做这件」卡上做过决定（candidate.gate1），这件就不归录入流水线管了：不再排作业、不再改它的记录。
  if (isObject(candidate.gate1)) return idle(intake.stage, { blocker: intake.blocker ?? null, closed: true });
  if (intake.stage === "ready") return idle("ready");
  if (intake.stage === "blocked" && isObject(intake.blocker)) return idle("blocked", { blocker: intake.blocker, step: intake.blocker.step ?? null });
  const jobs = isObject(intake.jobs) ? intake.jobs : {};
  const skips = isObject(intake.skips) ? intake.skips : {};
  const blocked = (blocker) => idle("blocked", { blocker, step: blocker.step });

  if (!jobs.sourceCaptureId) return idle("queued", { next: "capture_source" });
  const source = candidate.sourceCapture;
  if (source?.captureId !== jobs.sourceCaptureId) {
    return blocked(intakeBlocker("source_unreadable", { step: "capture_source", detail: "货源记录被另一次采集换掉了" }));
  }
  if (SOURCE_IN_FLIGHT.has(source.status) || JOB_IN_FLIGHT.has(source.jobStatus)) return idle("reading_source", { waiting: true });
  if (source.status === "failed" || source.jobStatus === "unknown_outcome") return blocked(sourceCaptureBlocker(source, intake.sourceKind));
  if (source.status !== "captured_waiting_owner_selection") {
    return blocked(intakeBlocker("source_unreadable", { step: "capture_source", detail: `采集停在 ${text(source.status, 40) || "未知状态"}` }));
  }
  const capturedBlocker = capturedSourceBlocker(source);
  if (capturedBlocker) return blocked(capturedBlocker);

  if (!jobs.supplierMatchId && !skips.supplierMatch) return idle("searching_1688", { next: login1688Expired ? "skip_1688" : "search_1688" });
  const supplier = candidate.supplierImageMatch;
  if (jobs.supplierMatchId && supplier?.captureId === jobs.supplierMatchId) {
    if (MATCH_IN_FLIGHT.has(supplier.status) || JOB_IN_FLIGHT.has(supplier.jobStatus)) return idle("searching_1688", { waiting: true });
    const blocker = matchBlocker(supplier, "search_1688");
    if (blocker) return blocked(blocker);
  }

  if (!jobs.ozonMatchId && !skips.ozonMatch) return idle("searching_ozon", { next: "search_ozon" });
  const ozon = candidate.ozonImageMatch;
  if (jobs.ozonMatchId && ozon?.captureId === jobs.ozonMatchId) {
    if (MATCH_IN_FLIGHT.has(ozon.status) || JOB_IN_FLIGHT.has(ozon.jobStatus)) return idle("searching_ozon", { waiting: true });
    const blocker = matchBlocker(ozon, "search_ozon");
    if (blocker) return blocked(blocker);
  }
  return idle("estimating", { next: "estimate" });
}

const time = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * 1688 现在算不算没登录：录入泵排的 1688 找同款里，最近一次结束的那次说要登录，而且之后主人没点过「接着找」。
 * 返回 "expired" / "ok" / "unknown"（还没搜过）。
 */
export function intakeLogin1688State(candidates) {
  let latest = null;
  let resumedAt = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const intake = candidate?.intake;
    if (!isObject(intake)) continue;
    resumedAt = Math.max(resumedAt, time(intake.resumedAt));
    const record = candidate.supplierImageMatch;
    if (!intake.jobs?.supplierMatchId || record?.captureId !== intake.jobs.supplierMatchId) continue;
    if (!["failed", "compared", "comparing"].includes(record.status)) continue;
    const at = time(record.completedAt);
    if (!latest || at > latest.at) latest = { at, record };
  }
  if (!latest) return "unknown";
  if (latest.record.status === "failed" && latest.record.failureCode === "site_login_required") return latest.at > resumedAt ? "expired" : "unknown";
  return latest.record.status === "failed" ? "unknown" : "ok";
}

/**
 * 「找货中」那一栏的顺序和排位：按贴进来的先后（同一次贴的按行序）。queue 只给还没开始的（第几 / 共几条在排）；
 * batch 是这一次粘贴里的第几条，每一件都有，页面写「第 3 / 8 条」用它。
 */
export function intakeQueue(candidates) {
  const login1688Expired = intakeLogin1688State(candidates) === "expired";
  const active = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => isObject(candidate?.intake) && candidate.workflowStatus !== "eliminated")
    .map((candidate) => ({ candidate, progress: intakeProgress(candidate, { login1688Expired }) }))
    .filter(({ progress }) => progress && progress.stage !== "ready" && !progress.closed);
  active.sort((left, right) => time(left.candidate.intake.submittedAt) - time(right.candidate.intake.submittedAt) ||
    (left.candidate.intake.batch?.index ?? 0) - (right.candidate.intake.batch?.index ?? 0));
  const waiting = active.filter(({ progress }) => progress.stage === "queued");
  return active.map(({ candidate, progress }) => {
    const position = progress.stage === "queued" ? waiting.findIndex((entry) => entry.candidate === candidate) + 1 : null;
    const batch = candidate.intake.batch;
    return { candidate, progress, queue: position ? { position, total: waiting.length } : null,
      batch: Number.isInteger(batch?.index) && Number.isInteger(batch?.size) ? { position: batch.index + 1, total: batch.size } : null };
  });
}

/** 整条队为什么停着：排在最前、停在整页那类事上的那一件。没有就是 null。 */
export function intakePause(candidates) {
  const entry = intakeQueue(candidates).find(({ progress }) => progress.stage === "blocked" && progress.blocker?.scope === "page");
  return entry ? { code: entry.progress.blocker.code, message: entry.progress.blocker.message, candidateId: entry.candidate.id } : null;
}

/**
 * 泵下一件要推进的。要用插件的步骤：整条队停着、插件没连上、或者已经有作业在等插件（插件一次一个）时都不开始；
 * 不用插件的（粗算、跳过 1688）照常做。返回 { candidate, step, stage } 或 null。
 */
export function nextIntakeWork(candidates, { extensionReady = true } = {}) {
  const entries = intakeQueue(candidates);
  const pluginFree = extensionReady && !entries.some(({ progress }) => progress.waiting) &&
    !entries.some(({ progress }) => progress.stage === "blocked" && progress.blocker?.scope === "page");
  const next = entries.find(({ progress }) => progress.next && (pluginFree || OFFLINE_STEPS.has(progress.next)));
  return next ? { candidate: next.candidate, step: next.progress.next, stage: next.progress.stage } : null;
}

/** 泵每一轮要写回商品的 stage / blocker（读的人只看 candidate.intake，不用自己再推一遍）。没变就是 null。 */
export function intakeStageUpdate(candidate, { login1688Expired = false } = {}) {
  const progress = intakeProgress(candidate, { login1688Expired });
  if (!progress || progress.closed || progress.stage === "ready") return null;
  const intake = candidate.intake;
  const blocker = progress.blocker ?? null;
  if (intake.stage === progress.stage && JSON.stringify(intake.blocker ?? null) === JSON.stringify(blocker)) return null;
  return { stage: progress.stage, blocker };
}

/**
 * 主人点「重跑」：只对停下、而且能重跑的那一件生效；把停下那一步的作业编号清掉，泵就会重新排那一步。
 * 读货源页结果未知时，这一下同时算主人知道了（server 那边按 source-capture/review 同样的方式记下）。
 */
export function intakeRetryPlan(candidate, { requestedAt, requestedBy } = {}) {
  const progress = intakeProgress(candidate);
  if (!progress || progress.stage !== "blocked" || !progress.blocker) return { ok: false, code: "intake_not_blocked" };
  if (!progress.blocker.retryable) return { ok: false, code: "intake_not_retryable" };
  const step = INTAKE_STEPS.includes(progress.blocker.step) ? progress.blocker.step : "capture_source";
  const jobs = { ...(isObject(candidate.intake.jobs) ? candidate.intake.jobs : {}) };
  // 货源那一步重跑，后面几步跟着重来：新读的货源页可能换了首图。
  const reset = step === "capture_source" ? ["capture_source", "search_1688", "search_ozon"] : [step];
  for (const name of reset) if (STEP_JOB[name]) jobs[STEP_JOB[name]] = null;
  const skips = { ...(isObject(candidate.intake.skips) ? candidate.intake.skips : {}) };
  if (step === "capture_source") { delete skips.supplierMatch; delete skips.ozonMatch; }
  const source = candidate.sourceCapture;
  return {
    ok: true,
    step,
    acknowledgeSourceUnknown: step === "capture_source" && source?.captureId === candidate.intake.jobs?.sourceCaptureId &&
      (source?.jobStatus === "unknown_outcome" || source?.failureCode === "unknown_outcome") && !source?.reviewedAt,
    intake: { ...candidate.intake, stage: step === "capture_source" ? "queued" : STEP_STAGE[step], blocker: null, jobs, skips,
      finishedAt: null, lastRetry: { step, code: progress.blocker.code, requestedAt, requestedBy } }
  };
}

/**
 * 整页提示上的「接着找」：停在整页那类事上的每一件都重跑那一步；因为 1688 没登录而跳过 1688 的，还没过「做这件」的也补搜一次。
 * 返回要改的 [{ candidateId, intake, acknowledgeSourceUnknown }]，空数组表示没有可以接着的。
 */
export function intakeResumePlan(candidates, { requestedAt, requestedBy, stillOpen = () => true } = {}) {
  const plans = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const intake = candidate?.intake;
    if (!isObject(intake) || candidate.workflowStatus === "eliminated") continue;
    const progress = intakeProgress(candidate);
    if (progress?.stage === "blocked" && progress.blocker?.scope === "page" && progress.blocker.retryable) {
      const plan = intakeRetryPlan(candidate, { requestedAt, requestedBy });
      if (plan.ok) plans.push({ candidateId: candidate.id, acknowledgeSourceUnknown: plan.acknowledgeSourceUnknown,
        intake: { ...plan.intake, resumedAt: requestedAt } });
      continue;
    }
    const skippedForLogin = intake.skips?.supplierMatch === "login_1688_required" || supplierMatchNeedsLogin(candidate);
    if (skippedForLogin && stillOpen(candidate)) {
      const skips = { ...intake.skips };
      delete skips.supplierMatch;
      plans.push({ candidateId: candidate.id, acknowledgeSourceUnknown: false,
        intake: { ...intake, stage: "searching_1688", blocker: null, skips, jobs: { ...intake.jobs, supplierMatchId: null },
          finishedAt: null, resumedAt: requestedAt, lastRetry: { step: "search_1688", code: "login_1688_required", requestedAt, requestedBy } } });
    }
  }
  return plans;
}
