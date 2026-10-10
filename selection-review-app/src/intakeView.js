/**
 * 录入页（贴拼多多 / 1688 链接）的纯显示逻辑。
 *
 * 这一层只认链接、翻译状态、排队列，不决定任何业务结论：哪条链接算重复、排第几、卡在哪，都以录入后台
 * （POST /api/intake/links、GET /api/intake/queue）回来的保存记录为准。页面自己认出来的来源只用来在提交前
 * 告诉主人「认出了几条」，提交后的 sourceKind 一律用后台给的。
 */

export const INTAKE_SOURCE_LABELS = Object.freeze({
  pinduoduo: "拼多多",
  "1688": "1688",
  seerfar: "Seerfar"
});

/** 录入流水线的阶段，按先后顺序。 */
export const INTAKE_STAGE_LABELS = Object.freeze({
  queued: "排队中",
  reading_source: "正在读货源页",
  searching_1688: "正在 1688 找同款",
  searching_ozon: "正在 Ozon 找同款",
  estimating: "正在粗算利润",
  ready: "找完了，等你确认",
  blocked: "停下来了"
});

/**
 * 停下来的原因。后台（lib/intake-pipeline.mjs）每个 blocker 都带一句 message，页面优先用它；这里只在后台没给时兜底。
 * 重跑与否看后台给的 retryable 和 scope，不在这里猜：scope 为 page 的是整页的事，用整页提示上的「接着找」。
 */
export const INTAKE_BLOCKER_HINTS = Object.freeze({
  slider_required: "要你在自己的 Chrome 里拖一下滑块，过了再点「接着找」。",
  login_pinduoduo_required: "拼多多要你先在 Chrome 里登录，登好了再点「接着找」。",
  login_1688_required: "1688 登录过期了，在 Chrome 里重新登录一次再点「接着找」。",
  plugin_offline: "插件没领这一步（Chrome 关着或插件没开），打开后点「接着找」。",
  share_link_unresolved: "这条分享链接没打开到商品页，把商品页的链接重新贴一次。",
  source_out_of_stock: "货源所有规格都没货了，换一个货源，或者不做这件。",
  source_delisted: "货源已经下架了，换一个货源，或者不做这件。",
  presale_too_late: "货源是预售，发货比店铺档案里允许的晚。",
  no_source_price: "货源页面上的价没读到，贴一个能一件起订的货源链接，或者不做这件。",
  source_image_missing: "货源页面没读到首图，没法拿图找同款；点「重跑」再读一次。",
  unknown_outcome: "上一次读货源页没等到结果；点「重跑」就当你知道了，再读一次。",
  source_unreadable: "这次没读成货源页，点「重跑」再读一次。",
  step_not_started: "这一步没能开始，点「重跑」再试一次。"
});

/** 后台一次最多收这么多条（intake_too_many_links）。 */
export const INTAKE_MAX_LINKS = 20;

const ACTIVE_STAGES = Object.freeze(["queued", "reading_source", "searching_1688", "searching_ozon", "estimating"]);

/** 平台和店铺在 GET /api/stores 上线前的写死名单；只放已经确认存在的两家 Ozon 店。 */
export const FALLBACK_STORES = Object.freeze([
  Object.freeze({ platform: "ozon", storeKey: "miska", label: "Miska" }),
  Object.freeze({ platform: "ozon", storeKey: "dandanshu", label: "蛋蛋鼠" })
]);
export const PLATFORM_LABELS = Object.freeze({ ozon: "Ozon", wb: "WB" });

const text = value => (typeof value === "string" ? value.trim() : "");

/** 一条链接属于哪家；认不出来返回 null。只看域名，不看路径。 */
export function linkSourceKind(link) {
  let host;
  try { host = new URL(link).hostname.toLowerCase(); } catch { return null; }
  const under = domain => host === domain || host.endsWith(`.${domain}`);
  if (under("yangkeduo.com") || under("pinduoduo.com") || under("pdd.com")) return "pinduoduo";
  if (under("1688.com")) return "1688";
  return null;
}

/**
 * 把文本框里的内容拆成链接。拼多多和 1688 的分享文案常常是「一段话 + 链接」，所以按行取出里面的 http(s) 链接；
 * 同一条链接贴两次只提交一次。认不出来的行原样列出，不提交。
 */
export function parseIntakeLinks(textValue) {
  const links = [];
  const unrecognized = [];
  const seen = new Set();
  for (const rawLine of String(textValue ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const urls = line.match(/https?:\/\/[^\s"'<>，。；、【】）（]+/giu) ?? [];
    const recognized = urls.filter(url => linkSourceKind(url) !== null);
    if (recognized.length === 0) {
      unrecognized.push(line);
      continue;
    }
    for (const url of recognized) {
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ url, sourceKind: linkSourceKind(url) });
    }
  }
  const counts = { pinduoduo: 0, "1688": 0 };
  for (const link of links) counts[link.sourceKind] += 1;
  return { links, unrecognized, counts };
}

/** 提交前的一句话：认出了几条、哪几行认不出。 */
export function intakePreviewLine(parsed) {
  if (parsed.links.length === 0 && parsed.unrecognized.length === 0) return "";
  const parts = [];
  if (parsed.links.length > 0) {
    // 「1688」这种数字键在对象里总排在最前，所以按固定顺序列。
    const kinds = ["pinduoduo", "1688"].filter(kind => parsed.counts[kind] > 0)
      .map(kind => `${INTAKE_SOURCE_LABELS[kind]} ${parsed.counts[kind]}`);
    parts.push(`认出 ${parsed.links.length} 条：${kinds.join("、")}`);
  }
  if (parsed.unrecognized.length > 0) parts.push(`${parsed.unrecognized.length} 行不是拼多多或 1688 链接，不会提交`);
  if (parsed.links.length > INTAKE_MAX_LINKS) parts.push(`一次最多 ${INTAKE_MAX_LINKS} 条，请分开贴`);
  return parts.join("；");
}

/**
 * POST /api/intake/links 的回执，逐条变成一句话。重复链接不新建，给出原来那件的 candidateId，页面用它跳过去。
 * 后台没认出来的（rejected）也逐条列出。
 */
export function intakeSubmitResults(response, submitted = []) {
  const items = Array.isArray(response?.items) ? response.items : [];
  const results = items.map((item, index) => {
    const candidateId = text(item?.candidateId);
    const duplicateOf = text(item?.duplicateOfCandidateId);
    const sourceKind = text(item?.sourceKind);
    const link = text(submitted[index]?.url ?? submitted[index]);
    const source = INTAKE_SOURCE_LABELS[sourceKind] ?? "链接";
    if (item?.created === true && candidateId !== "") {
      return { key: `created:${candidateId}`, kind: "created", candidateId, link, sentence: `${source} 已加入找货队列` };
    }
    if (item?.created === false && (duplicateOf !== "" || candidateId !== "")) {
      return { key: `duplicate:${duplicateOf || candidateId}:${index}`, kind: "duplicate", candidateId: duplicateOf || candidateId, link,
        sentence: item?.duplicateEliminated === true ? `${source} 这条以前录过，已经淘汰了，没有重复新建`
          : `${source} 这条以前录过，没有重复新建` };
    }
    return { key: `unknown:${index}`, kind: "unknown", candidateId: null, link,
      sentence: `${source} 这条的结果没认出来，请刷新后核对，不要重复提交` };
  });
  const rejected = Array.isArray(response?.rejected) ? response.rejected : [];
  return [...results, ...rejected.map((item, index) => ({ key: `rejected:${index}`, kind: "unknown", candidateId: null,
    link: text(item?.raw), sentence: `没认出来，没有提交：${text(item?.raw).slice(0, 80) || "空行"}` }))];
}

function positionOf(value) {
  const position = Number(value?.position);
  const total = Number(value?.total);
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(total) || position < 1 || total < position) return null;
  return { position, total };
}

/** 「第 3 / 8 条」是这一次粘贴里的第几条；排队时再加上在整条队里排第几。 */
function positionLine(item, stage) {
  const batch = positionOf(item?.batch);
  const queue = stage === "queued" ? positionOf(item?.queue) : null;
  const parts = [];
  if (batch !== null && batch.total > 1) parts.push(`第 ${batch.position} / ${batch.total} 条`);
  if (queue !== null) parts.push(`排第 ${queue.position} / ${queue.total}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

function moneyLine(value) {
  return Number.isFinite(value) ? `¥${value.toFixed(2)}` : null;
}

/** 粗算永远是估算：只说约多少一件，或者亏、或者还缺什么。 */
export function roughProfitLine(roughProfit) {
  if (!roughProfit || typeof roughProfit !== "object") return null;
  if (roughProfit.status === "ok") {
    const money = moneyLine(roughProfit.profitPerUnitRmb);
    if (money === null) return null;
    return roughProfit.passes === false ? { tone: "warning", label: `粗算 约 ${money}/件，不过线` }
      : { tone: "ok", label: `粗算 约 ${money}/件` };
  }
  if (roughProfit.status === "negative") {
    const money = moneyLine(roughProfit.profitPerUnitRmb);
    return { tone: "warning", label: money === null ? "粗算 亏钱" : `粗算 约 ${money}/件，不过线` };
  }
  if (roughProfit.status === "incomplete") {
    const missing = Array.isArray(roughProfit.missing) ? roughProfit.missing.filter(item => text(item) !== "") : [];
    return { tone: "muted", label: missing.length === 0 ? "粗算 还缺资料" : `粗算 还缺：${missing.join("、")}` };
  }
  return null;
}

/**
 * GET /api/intake/queue 的每一条变成一行。dataRevision 和粗算以队列回执为准，回执里没有才看候选商品上保存的。
 * 「重跑」只给只拦这一件、后台说能重跑、并且有当前 dataRevision 的；整页那类事（滑块、登录、插件）用整页的「接着找」。
 */
export function intakeQueueRows(queueResponse, candidates = []) {
  const items = Array.isArray(queueResponse?.items) ? queueResponse.items : [];
  const byId = new Map((Array.isArray(candidates) ? candidates : []).map(candidate => [candidate?.id, candidate]));
  return items.map(item => {
    const candidateId = text(item?.candidateId);
    const candidate = byId.get(candidateId) ?? null;
    const stage = text(item?.stage);
    const blocker = stage === "blocked" && item?.blocker && typeof item.blocker === "object" ? item.blocker : null;
    const blockerCode = text(blocker?.code);
    const revision = Number.isSafeInteger(item?.dataRevision) ? item.dataRevision : candidate?.dataRevision;
    const dataRevision = Number.isSafeInteger(revision) ? revision : null;
    const pageBlocked = blocker !== null && blocker.scope === "page";
    const imageUrl = text(item?.imageUrl);
    return {
      candidateId,
      title: text(item?.title) || text(candidate?.productName) || "标题还没读到",
      imageUrl: /^https:\/\//u.test(imageUrl) ? imageUrl : null,
      sourceLabel: INTAKE_SOURCE_LABELS[text(item?.sourceKind)] ?? "来源未知",
      stage,
      stageLabel: INTAKE_STAGE_LABELS[stage] ?? "状态没认出来",
      active: ACTIVE_STAGES.includes(stage),
      ready: stage === "ready",
      blocked: stage === "blocked",
      positionLine: positionLine(item, stage),
      blockerLine: blocker === null ? null : text(blocker.message) || INTAKE_BLOCKER_HINTS[blockerCode] || "停下来的原因没认出来",
      pageBlocked,
      canRetry: blocker?.retryable === true && !pageBlocked && dataRevision !== null,
      dataRevision,
      roughProfit: roughProfitLine(item?.roughProfit ?? candidate?.roughProfit)
    };
  });
}

/** 整页暂停（滑块、登录、插件没领）：整条队先停着，只在最上面提示一次，带「接着找」。 */
export function intakePauseView(queueResponse) {
  const pause = queueResponse?.pause;
  if (!pause || typeof pause !== "object") return null;
  const code = text(pause.code);
  const message = text(pause.message) || INTAKE_BLOCKER_HINTS[code] || "处理好后点「接着找」";
  return { code, message: message.replace(/[。.]+$/u, ""),
    candidateId: text(pause.candidateId) || null };
}

/** 队列分成三组：等你确认、还在找、停下来了。 */
export function intakeQueueGroups(rows) {
  return {
    ready: rows.filter(row => row.ready),
    running: rows.filter(row => row.active),
    blocked: rows.filter(row => row.blocked),
    unknown: rows.filter(row => !row.ready && !row.active && !row.blocked)
  };
}

/** 队列里还有东西在跑，页面才继续轮询。 */
export function intakeQueueHasActive(queueResponse) {
  return Array.isArray(queueResponse?.items) && queueResponse.items.some(item => ACTIVE_STAGES.includes(text(item?.stage)));
}

/**
 * 插件和 1688 登录这两条，给顶栏用。后台没给就是不知道，不当成正常。
 */
export function intakeExtensionIssues(queueResponse) {
  const extension = queueResponse?.extension;
  if (!extension || typeof extension !== "object") return [];
  const issues = [];
  if (extension.online === false) issues.push({ code: "plugin_offline", tone: "error", sentence: "插件没连上，贴的链接会先排着" });
  if (extension.online === true && extension.versionOk === false) {
    issues.push({ code: "plugin_version", tone: "warning", sentence: "插件版本不对，贴的链接会先排着；要在浏览器里重新加载插件" });
  }
  if (extension.online === true && (extension.login1688 === "expired" || extension.login1688 === false)) {
    issues.push({ code: "login_1688_required", tone: "warning", sentence: "1688 登录过期，要用 1688 的商品先排着" });
  }
  return issues;
}

/**
 * GET /api/stores 的回执变成平台 + 店铺两个下拉。接口还没上线、读失败或格式不认识时，用写死的两家 Ozon 店。
 * 认的格式（lib/store-registry.mjs listStores）：{ platforms: [{ platform, label }], stores: [{ storeId, platform, label,
 * labelConfirmed, identityConfigured }] }。显示名没确认的店在名字后面标「名字待定」，它只是占位，不是店铺身份。
 */
export function storeOptions(storesResponse) {
  const raw = Array.isArray(storesResponse?.stores) ? storesResponse.stores : null;
  const stores = (raw ?? []).map(store => {
    const label = text(store?.label) || text(store?.displayName);
    return {
      platform: text(store?.platform).toLowerCase(),
      storeKey: text(store?.storeKey) || text(store?.storeId),
      label: label !== "" && store?.labelConfirmed === false ? `${label}（名字待定）` : label
    };
  }).filter(store => store.platform !== "" && store.storeKey !== "" && store.label !== "");
  const list = stores.length > 0 ? stores : FALLBACK_STORES.map(store => ({ ...store }));
  const platformLabels = new Map((Array.isArray(storesResponse?.platforms) ? storesResponse.platforms : [])
    .map(item => [text(item?.platform).toLowerCase(), text(item?.label)]).filter(([key, label]) => key !== "" && label !== ""));
  const platforms = [...new Set(list.map(store => store.platform))]
    .map(platform => ({ value: platform, label: platformLabels.get(platform) ?? PLATFORM_LABELS[platform] ?? platform }));
  return { platforms, stores: list, fallback: stores.length === 0 };
}

export function storesOfPlatform(options, platform) {
  return options.stores.filter(store => store.platform === platform);
}

export function platformOfStore(options, storeKey) {
  return options.stores.find(store => store.storeKey === storeKey)?.platform ?? options.platforms[0]?.value ?? null;
}

/** 录入后台还没上线（404）时的说法：页面在，后台不在，什么也不会被提交。 */
export const INTAKE_UNAVAILABLE_MESSAGE = "录入后台还没上线，链接暂时提交不了；页面上什么都没有保存。";
