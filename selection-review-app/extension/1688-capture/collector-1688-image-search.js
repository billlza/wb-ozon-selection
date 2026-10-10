/**
 * Reads one 1688 image-search result page (air.1688.com) after a search by a Pinduoduo first picture.
 *
 * Runs in the ISOLATED world and must stay self-contained: chrome.scripting serializes this function alone. Every card
 * carries its offer as JSON in data-ftk-fiber-props and its search echo in data-aplus-report; only the product facts
 * named below are copied out. The account, member, session and ad-click fields on the same objects are never read, and
 * the ad redirect address is never followed — the service rebuilds each offer's address from its id.
 *
 * Zero cards is never "no match": 1688 shows the same empty page to a browser that is not logged in.
 */
export async function collect1688ImageSearchPage(expectedImageUrl, maxResults = 20) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const plain = (value, limit) => (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  // Same hosts as canonicalImageSearchSourceUrl in source-routing.js: Pinduoduo, 1688 (alicdn) and Ozon product pictures.
  const canonicalSearchImage = (value) => {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      const host = url.hostname;
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !(host === "pddpic.com" || host.endsWith(".pddpic.com") || host.endsWith(".yangkeduo.com") ||
            host === "alicdn.com" || host.endsWith(".alicdn.com") || host === "ir.ozone.ru")) return null;
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  };
  const alicdnImage = (value) => {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value);
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !(url.hostname === "alicdn.com" || url.hostname.endsWith(".alicdn.com"))) return null;
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  };
  const yuan = (value) => {
    const scalar = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/^[¥￥]\s*/, "") : "";
    if (!/^\d+(?:\.\d{1,2})?$/.test(scalar)) return null;
    const parsed = Number(scalar);
    return parsed > 0 && parsed <= 1_000_000 ? parsed : null;
  };
  // 1688 writes sales as 120, "120", "1000+" or "1.2万+"; anything else stays unknown.
  const count = (value) => {
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
    const match = typeof value === "string" ? value.trim().match(/^(\d+(?:\.\d+)?)(万)?\+?$/) : null;
    if (!match) return null;
    const parsed = Math.round(Number(match[1]) * (match[2] ? 10000 : 1));
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const decodeRepeatedly = (value) => {
    let current = value;
    for (let round = 0; round < 3 && /%[0-9A-Fa-f]{2}/.test(current); round += 1) {
      try { current = decodeURIComponent(current); } catch { return ""; }
    }
    return current;
  };
  // Decodes every readable %XX run and leaves a broken one as it is, so one stray "%" cannot hide the rest of a report.
  const looseDecode = (value) => {
    let current = value;
    for (let round = 0; round < 3 && /%[0-9A-Fa-f]{2}/.test(current); round += 1) {
      current = current.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => { try { return decodeURIComponent(run); } catch { return run; } });
    }
    return current;
  };
  // data-aplus-report is a ^-separated string; inside its sp_expo_data segment the fields are ;-separated, e.g.
  // "…;query_url:https%3A%2F%2Fimg.pddpic.com%2F….jpeg;queryEngine:…;relevanceScores:%7B…". The searched picture comes
  // back as query_url and ends at the next separator; the score may sit inside an encoded object.
  const searchedImage = (report) => {
    for (const text of [report, looseDecode(report)]) {
      const raw = text.match(/(?:^|[\^&{,;"\s@=])query_url["']?\s*[:=]\s*["']?([^\^&"'\s,;}]+)/)?.[1];
      if (raw) return canonicalSearchImage(decodeRepeatedly(raw).split(/[;\s"'^,}]/)[0]);
    }
    return null;
  };
  const vendorSimilarity = (report) => {
    for (const text of [report, looseDecode(report)]) {
      const raw = text.match(/cosScore["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/)?.[1];
      const parsed = raw === undefined ? NaN : Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
    }
    return null;
  };
  // The offer object may sit at the top of the props or one level down.
  const offerModel = (props) => [props, props?.data, props?.item, props?.offer, props?.props?.data]
    .find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.offerId !== undefined) || null;
  // 起批量: a "N件起批" sentence anywhere in the price notes, else the first quantity step ("≥2件", "1~99件").
  const quantityBegin = (model) => {
    const strings = [];
    const collect = (value, depth = 0) => {
      if (depth > 3 || value === null || value === undefined) return;
      if (typeof value === "string" || typeof value === "number") { strings.push(String(value)); return; }
      if (Array.isArray(value)) { value.slice(0, 10).forEach((entry) => collect(entry, depth + 1)); return; }
      if (typeof value === "object") Object.values(value).slice(0, 20).forEach((entry) => collect(entry, depth + 1));
    };
    collect(model.priceDesc);
    collect(model.priceInfo?.priceDescription);
    for (const text of strings) {
      const match = text.match(/(\d{1,6})\s*(?:件|个|套|双|条|只|台|包|箱|对|张|把|本|盒|瓶|袋)?\s*起(?:批|订|售)/);
      if (match) return Number(match[1]);
    }
    for (const key of ["quantityBegin", "beginAmount", "minOrderQuantity"]) {
      const direct = count(typeof model[key] === "string" ? model[key].trim() : model[key]);
      if (direct !== null && direct >= 1) return direct;
    }
    const steps = Array.isArray(model.quantityPrices) ? model.quantityPrices : [];
    for (const value of steps[0] && typeof steps[0] === "object" ? Object.values(steps[0]) : []) {
      const match = typeof value === "string" ? value.trim().match(/^[≥>=]*\s*(\d{1,6})\s*(?:[~～-]\s*\d+)?\s*(?:件|个|套|双|条|只)?$/) : null;
      if (match) return Number(match[1]);
    }
    return null;
  };
  const pageBlocker = () => {
    if (document.querySelector?.('iframe[src*="punish"], .baxia-dialog, [id^="nc_"][id$="_wrapper"], #nocaptcha')) return "site_verification_required";
    if (document.querySelector?.('iframe[src*="login.1688.com"], iframe[src*="passport.1688.com"], iframe[src*="login.taobao.com"]')) return "site_login_required";
    return null;
  };
  const emptyStateShown = () => /No search results|没有找到|暂无(?:相关)?(?:结果|商品)|未找到/.test(String(document.body?.innerText || "").slice(0, 20000));
  const failed = (failureCode) => ({ status: "failed", failureCode });

  const readCards = () => {
    const offers = new Map();
    for (const card of Array.from(document.querySelectorAll?.("[data-renderkey]") || [])) {
      const keyOffer = String(card.getAttribute("data-renderkey") || "").match(/_(\d{6,20})$/)?.[1];
      if (!keyOffer || offers.has(keyOffer)) continue;
      const propsHost = card.hasAttribute?.("data-ftk-fiber-props") ? card : card.querySelector?.("[data-ftk-fiber-props]");
      let props = null;
      try { props = JSON.parse(propsHost?.getAttribute("data-ftk-fiber-props") || "null"); } catch { props = null; }
      const reportHost = card.hasAttribute?.("data-aplus-report") ? card : card.querySelector?.("[data-aplus-report]");
      const index = Number(card.getAttribute("data-index"));
      offers.set(keyOffer, { model: offerModel(props), report: String(reportHost?.getAttribute("data-aplus-report") || ""),
        index: Number.isSafeInteger(index) && index >= 0 ? index : offers.size });
    }
    return offers;
  };

  // The results arrive after the page script runs; wait until the card count holds still, within the job's own deadline.
  const startedAt = Date.now();
  let offers = new Map();
  let stableSince = 0;
  while (true) {
    const blocker = pageBlocker();
    if (blocker) return failed(blocker);
    const next = readCards();
    if (next.size > 0 && next.size === offers.size) {
      if (Date.now() - stableSince >= 1500) { offers = next; break; }
    } else {
      stableSince = Date.now();
    }
    offers = next;
    if (next.size === 0 && Date.now() - startedAt >= 4000 && emptyStateShown()) return failed("results_unverifiable");
    if (Date.now() - startedAt >= 18000) break;
    await sleep(300);
  }
  if (offers.size === 0) return failed("results_unverifiable");

  const queries = new Set([...offers.values()].map((entry) => searchedImage(entry.report)).filter(Boolean));
  if (queries.size > 1) return failed("wrong_query");
  let searchImageUrl = [...queries][0] || null;
  if (!searchImageUrl) {
    try { searchImageUrl = canonicalSearchImage(new URL(window.location.href).searchParams.get("imageAddress") || ""); }
    catch { searchImageUrl = null; }
  }
  if (!searchImageUrl) return failed("structured_data_unavailable");
  if (searchImageUrl !== expectedImageUrl) return failed("wrong_query");

  const items = [];
  for (const [offerId, entry] of offers) {
    const model = entry.model;
    if (!model || String(model.offerId) !== offerId) continue;
    const location = [plain(model.province, 20), plain(model.city, 20)].filter(Boolean).join(" ");
    items.push({
      offerId,
      title: plain(model.title, 300),
      imageUrl: alicdnImage(model.offerPicUrl) || alicdnImage(model.odPicUrl) || alicdnImage(model.imgUrl),
      priceCny: yuan(model.priceInfo?.price ?? model.price),
      priceNote: plain(model.priceInfo?.priceDescription, 60) || null,
      quantityBegin: quantityBegin(model),
      saleQuantity: count(typeof model.saleQuantity === "string" ? model.saleQuantity.trim() : model.saleQuantity),
      shopName: plain(model.shopName, 80) || null,
      location: location || null,
      isAd: model.isAd === true || model.isAd === "true" || model.type === "fm",
      superFactory: model.superFactory === true || model.superFactory === "true",
      vendorSimilarity: vendorSimilarity(entry.report),
      rank: entry.index
    });
  }
  if (!items.length) return failed("structured_data_unavailable");
  // Most similar first by 1688's own score; cards without a score keep their place on the page after the scored ones.
  items.sort((left, right) => (right.vendorSimilarity ?? -1) - (left.vendorSimilarity ?? -1) || left.rank - right.rank);
  return {
    status: "captured",
    evidence: {
      searchImageUrl,
      observedAt: new Date().toISOString(),
      cardCount: offers.size,
      items: items.slice(0, Math.max(1, Math.min(20, Number(maxResults) || 20)))
    }
  };
}
