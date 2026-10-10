export function detailOfferId(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "detail.1688.com" || url.username || url.password || url.port) return "";
    return url.pathname.match(/^\/offer\/(\d+)\.html$/)?.[1] || "";
  } catch {
    return "";
  }
}

const LOGIN_HOSTS = new Set(["login.1688.com", "passport.1688.com"]);
const VERIFICATION_HOSTS = new Set(["sec.1688.com", "punish.1688.com"]);

function is1688Host(host) {
  return host === "1688.com" || host.endsWith(".1688.com");
}

/**
 * 将跳转结果压缩成固定枚举。返回值不包含完整URL、路径内容、查询参数或跳转令牌。
 */
export function classify1688NavigationOutcome(value, options = {}) {
  const navigationStage = ["redirect_observed", "page_complete", "timeout"].includes(options.navigationStage)
    ? options.navigationStage
    : "redirect_observed";
  const expectedOfferId = /^\d+$/.test(String(options.expectedOfferId || ""))
    ? String(options.expectedOfferId)
    : "";
  try {
    if (typeof value !== "string") throw new TypeError("invalid_navigation_url");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new TypeError("invalid_navigation_url");
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    const observedOfferId = detailOfferId(url.href);
    if (observedOfferId) {
      return {
        finalHostClass: "detail_1688",
        finalPathType: "offer_detail",
        redirectClassification: expectedOfferId && expectedOfferId !== observedOfferId
          ? "different_offer"
          : "allowed_detail",
        navigationStage,
        observedOfferId
      };
    }
    if (is1688Host(host) && (LOGIN_HOSTS.has(host) || /(?:^|\/)(?:login|signin|passport)(?:\/|$)/.test(pathname))) {
      return {
        finalHostClass: "login_1688",
        finalPathType: "login",
        redirectClassification: "login_required",
        navigationStage,
        observedOfferId: null
      };
    }
    if (is1688Host(host) && (VERIFICATION_HOSTS.has(host) || /(?:captcha|verify|verification|punish|security)/.test(pathname))) {
      return {
        finalHostClass: "verification_1688",
        finalPathType: "verification",
        redirectClassification: "verification_required",
        navigationStage,
        observedOfferId: null
      };
    }
    if (host === "m.1688.com" || host.endsWith(".m.1688.com")) {
      return {
        finalHostClass: "mobile_1688",
        finalPathType: pathname.includes("/offer/") ? "mobile_offer" : "other",
        redirectClassification: "mobile_page",
        navigationStage,
        observedOfferId: null
      };
    }
    if (is1688Host(host)) {
      const isIntermediate = host === "qr.1688.com" || pathname === "/" || pathname === "";
      return {
        finalHostClass: "other_1688",
        finalPathType: isIntermediate ? "redirect_intermediate" : "other",
        redirectClassification: isIntermediate ? "intermediate_page" : "non_whitelisted_destination",
        navigationStage,
        observedOfferId: null
      };
    }
    return {
      finalHostClass: "external",
      finalPathType: "other",
      redirectClassification: "non_whitelisted_destination",
      navigationStage,
      observedOfferId: null
    };
  } catch {
    return {
      finalHostClass: "invalid",
      finalPathType: "other",
      redirectClassification: "non_whitelisted_destination",
      navigationStage,
      observedOfferId: null
    };
  }
}

/**
 * Chrome 在导航未完成时可能同时提供旧的 url 与新的 pendingUrl。
 * 这里优先读取仍在加载的 pendingUrl；返回的原始地址只在扩展内存中使用，
 * 绝不能写入评审台或失败记录。
 */
export function observed1688TabAddress(tab) {
  if (!tab || typeof tab !== "object") {
    return { value: "", tabObservation: "tab_unavailable" };
  }
  const currentUrl = typeof tab.url === "string" ? tab.url : "";
  const pendingUrl = typeof tab.pendingUrl === "string" ? tab.pendingUrl : "";
  if (tab.status !== "complete" && pendingUrl) {
    return { value: pendingUrl, tabObservation: "pending_url" };
  }
  if (currentUrl && currentUrl !== "about:blank") {
    return { value: currentUrl, tabObservation: "current_url" };
  }
  if (pendingUrl) {
    return { value: pendingUrl, tabObservation: "pending_url" };
  }
  return { value: "", tabObservation: "address_unavailable" };
}

const SAFE_REDIRECT_CLASSIFICATIONS = new Set([
  "allowed_detail",
  "login_required",
  "verification_required",
  "mobile_page",
  "intermediate_page",
  "non_whitelisted_destination",
  "different_offer",
  "detail_load_timeout",
  "tab_unavailable",
  "address_unavailable"
]);

/**
 * 为超时收口生成固定枚举诊断。完整URL、查询参数和令牌不会进入返回值。
 */
export function classify1688TimeoutOutcome(tab, expectedOfferId = "", lastDiagnostics = null) {
  const observation = observed1688TabAddress(tab);
  const lastObservedClassification = SAFE_REDIRECT_CLASSIFICATIONS.has(lastDiagnostics?.redirectClassification)
    ? lastDiagnostics.redirectClassification
    : null;
  if (!observation.value) {
    const tabUnavailable = observation.tabObservation === "tab_unavailable";
    return {
      finalHostClass: "invalid",
      finalPathType: "other",
      redirectClassification: tabUnavailable ? "tab_unavailable" : "address_unavailable",
      navigationStage: "timeout",
      observedOfferId: null,
      tabObservation: observation.tabObservation,
      lastObservedClassification
    };
  }
  const diagnostics = classify1688NavigationOutcome(observation.value, {
    expectedOfferId,
    navigationStage: "timeout"
  });
  return {
    ...diagnostics,
    redirectClassification: diagnostics.redirectClassification === "allowed_detail"
      ? "detail_load_timeout"
      : diagnostics.redirectClassification,
    tabObservation: observation.tabObservation,
    lastObservedClassification
  };
}

/**
 * 只把仍在加载中的已知跳转状态视为“继续等待”。移动版 offer 可能只是
 * qr 短链到桌面详情页之间的中间地址；页面完成或超时后仍停在移动页时，
 * 必须由调用方按失败收口，不能在移动页采集或自动改写链接。
 */
export function shouldWaitFor1688Destination(diagnostics, tabStatus = "loading") {
  if (!diagnostics || typeof diagnostics !== "object") return false;
  const expectedIntermediate = diagnostics.finalHostClass === "other_1688" &&
    diagnostics.finalPathType === "redirect_intermediate";
  const waitingForAllowedDetail = diagnostics.redirectClassification === "allowed_detail" &&
    tabStatus !== "complete";
  const waitingForMobileOfferRedirect = diagnostics.finalHostClass === "mobile_1688" &&
    diagnostics.finalPathType === "mobile_offer" &&
    diagnostics.navigationStage === "redirect_observed" &&
    tabStatus !== "complete";
  return expectedIntermediate || waitingForAllowedDetail || waitingForMobileOfferRedirect;
}

export function classify1688Source(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const offerId = detailOfferId(url.href);
    if (offerId) {
      return { type: "detail", sourceUrl: `https://detail.1688.com/offer/${offerId}.html`, offerId };
    }
    if (url.hostname !== "qr.1688.com") return null;
    const token = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,160})\/?$/)?.[1] || "";
    return token ? { type: "short", sourceUrl: `https://qr.1688.com/s/${token}`, offerId: "" } : null;
  } catch {
    return null;
  }
}

export function validateResolved1688Source(originalSource, finalUrl, expectedOfferId = "") {
  const original = classify1688Source(originalSource);
  const resolvedOfferId = detailOfferId(finalUrl);
  if (!original || !resolvedOfferId) return null;
  if (original.type === "detail" && original.offerId !== resolvedOfferId) return null;
  if (expectedOfferId && String(expectedOfferId) !== resolvedOfferId) return null;
  return {
    offerId: resolvedOfferId,
    sourceUrl: `https://detail.1688.com/offer/${resolvedOfferId}.html`
  };
}

export function isAllowed1688NavigationHost(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "qr.1688.com" || url.hostname === "detail.1688.com");
  } catch {
    return false;
  }
}

const PINDUODUO_GOODS_HOSTS = new Set(["mobile.yangkeduo.com", "mobile.pinduoduo.com"]);
const PINDUODUO_GOODS_PATHS = new Set(["/goods.html", "/goods1.html", "/goods2.html"]);

function isPinduoduoHost(host) {
  return host === "yangkeduo.com" || host.endsWith(".yangkeduo.com") || host === "pinduoduo.com" || host.endsWith(".pinduoduo.com");
}

/** A Pinduoduo goods page names exactly one numeric goods_id; anything else is not a product identity. */
export function pinduoduoGoodsId(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    if (!PINDUODUO_GOODS_HOSTS.has(url.hostname) || !PINDUODUO_GOODS_PATHS.has(url.pathname)) return "";
    const ids = url.searchParams.getAll("goods_id");
    return ids.length === 1 && /^\d{1,40}$/.test(ids[0]) ? ids[0] : "";
  } catch {
    return "";
  }
}

/** Mirrors the service's normalizePinduoduoCaptureSource: the same link must mean the same goods on both sides. */
export function classifyPinduoduoSource(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (PINDUODUO_GOODS_HOSTS.has(url.hostname) && PINDUODUO_GOODS_PATHS.has(url.pathname)) {
      const offerId = pinduoduoGoodsId(url.href);
      if (offerId) return { type: "detail", sourceUrl: `https://mobile.yangkeduo.com/goods.html?goods_id=${offerId}`, offerId };
      const token = url.searchParams.getAll("ps");
      return token.length === 1 && /^[A-Za-z0-9_-]{1,160}$/.test(token[0])
        ? { type: "short", sourceUrl: `https://mobile.yangkeduo.com${url.pathname}?ps=${token[0]}`, offerId: "" }
        : null;
    }
    if (url.hostname !== "p.pinduoduo.com") return null;
    const token = url.pathname.match(/^\/([A-Za-z0-9_-]{1,160})\/?$/)?.[1] || "";
    return token ? { type: "short", sourceUrl: `https://p.pinduoduo.com/${token}`, offerId: "" } : null;
  } catch {
    return null;
  }
}

export function validateResolvedPinduoduoSource(originalSource, finalUrl, expectedOfferId = "") {
  const original = classifyPinduoduoSource(originalSource);
  const resolvedOfferId = pinduoduoGoodsId(finalUrl);
  if (!original || !resolvedOfferId) return null;
  if (original.type === "detail" && original.offerId !== resolvedOfferId) return null;
  if (expectedOfferId && String(expectedOfferId) !== resolvedOfferId) return null;
  return {
    offerId: resolvedOfferId,
    sourceUrl: `https://mobile.yangkeduo.com/goods.html?goods_id=${resolvedOfferId}`
  };
}

/**
 * Where a Pinduoduo tab has got to, as one fixed word. A share link passes through p.pinduoduo.com or a goods2 token
 * page before the goods page; the login and verification pages are where Pinduoduo stops a browser it does not trust.
 */
export function classifyPinduoduoNavigation(value, expectedOfferId = "") {
  try {
    if (typeof value !== "string") return "invalid";
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "invalid";
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    const goodsId = pinduoduoGoodsId(url.href);
    if (goodsId) return expectedOfferId && String(expectedOfferId) !== goodsId ? "different_offer" : "allowed_detail";
    if (!isPinduoduoHost(host)) return "non_whitelisted_destination";
    if (/(?:^|\/)(?:login|passport)[^/]*$/.test(pathname)) return "login_required";
    if (/(?:captcha|verif|risk|punish|security)/.test(pathname)) return "verification_required";
    if (host === "p.pinduoduo.com" || (PINDUODUO_GOODS_HOSTS.has(host) && PINDUODUO_GOODS_PATHS.has(pathname))) return "intermediate_page";
    return "non_whitelisted_destination";
  } catch {
    return "invalid";
  }
}

/** Which supplier site a job's saved link belongs to. 1688 is tried first and its rules are unchanged. */
export function classifySupplierSource(value) {
  const alibaba = classify1688Source(value);
  if (alibaba) return { platform: "1688", ...alibaba };
  const pinduoduo = classifyPinduoduoSource(value);
  return pinduoduo ? { platform: "pinduoduo", ...pinduoduo } : null;
}

// ---- 1688 找同款：用首图在 1688 搜一次图 ----

function canonicalPlatformImageUrl(value, allowedHost) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHost(url.hostname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/** Mirrors canonicalPinduoduoImageUrl in lib/capture-evidence-sanitization.mjs: https, a Pinduoduo image host, no query. */
export function canonicalPinduoduoImageUrl(value) {
  return canonicalPlatformImageUrl(value, host => host === "pddpic.com" || host.endsWith(".pddpic.com") || host.endsWith(".yangkeduo.com"));
}

/**
 * Mirrors canonicalImageSearchSourceUrl in lib/capture-evidence-sanitization.mjs: a product picture from Pinduoduo, 1688
 * (alicdn) or Ozon (ir.ozone.ru) image hosts, https, no query. These are the only pictures a search may be run with.
 */
export function canonicalImageSearchSourceUrl(value) {
  return canonicalPinduoduoImageUrl(value) ??
    canonicalPlatformImageUrl(value, host => host === "alicdn.com" || host.endsWith(".alicdn.com")) ??
    canonicalPlatformImageUrl(value, host => host === "ir.ozone.ru");
}

/** Mirrors supplierImageMatchSearchUrl in lib/supplier-image-match.mjs, character for character. */
export function imageSearchUrl(imageUrl) {
  const canonical = canonicalImageSearchSourceUrl(imageUrl);
  if (!canonical || canonical !== imageUrl) return null;
  return `https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress=${encodeURIComponent(canonical)}`;
}

const IMAGE_SEARCH_RESULT_PATHS = ["/kapp/1688-search/pc-image-search", "/kapp/1688-global/sales/search"];

/**
 * Where a 1688 image-search tab has got to, as one fixed word. s.1688.com/youyuan is only the entry address: 1688 sends
 * the browser on to its air.1688.com result page, which is the one page the collector may read. Login and verification
 * pages stop the job with their own reason; anything else is not this search.
 */
export function classify1688ImageSearchNavigation(value) {
  try {
    if (typeof value !== "string") return "invalid";
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "invalid";
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase().replace(/\/+$/, "");
    if (host === "s.1688.com" && pathname === "/youyuan/index.htm") return "entry";
    if (host === "air.1688.com" && IMAGE_SEARCH_RESULT_PATHS.includes(pathname)) return "results";
    if (!is1688Host(host)) return "non_whitelisted_destination";
    if (LOGIN_HOSTS.has(host) || /(?:^|\/)(?:login|signin|passport)(?:\/|$)/.test(pathname)) return "login_required";
    if (VERIFICATION_HOSTS.has(host) || /(?:captcha|verify|verification|punish|security)/.test(pathname)) return "verification_required";
    return "non_whitelisted_destination";
  } catch {
    return "invalid";
  }
}

/** The result page as a fixed marker (host and path only), so the address read after extraction can be compared. */
export function imageSearchResultPage(value) {
  if (classify1688ImageSearchNavigation(value) !== "results") return null;
  const url = new URL(value);
  return `https://${url.hostname.toLowerCase()}${url.pathname.toLowerCase().replace(/\/+$/, "")}`;
}
