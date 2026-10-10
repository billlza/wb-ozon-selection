/**
 * Reads one Ozon search result page (www.ozon.ru/search/?text=…, or the category page Ozon may redirect that search to,
 * which keeps the same text parameter) for 在 Ozon 找同款.
 *
 * Runs in the ISOLATED world and must stay self-contained: chrome.scripting serializes this function alone. Ozon renders
 * the result grid from a widget state that it also writes into the page as JSON (data-state on a "state-searchResultsV2-…"
 * element). That state is read first; when it is not in the page, the rendered tiles are read instead. Either way only the
 * product facts named below are copied out — the tile's tracking and click parameters are never read, and the service
 * rebuilds each product address from its id.
 *
 * Zero cards is never "no same product on Ozon": it only says these words found nothing.
 */
export async function collectOzonSearchPage(expectedQuery, maxResults = 36) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const failed = (failureCode) => ({ status: "failed", failureCode });
  const plain = (value, limit) => (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/[\u0000-\u001f\u007f\u00a0\u2009\u202f]/g, " ").replace(/\s+/g, " ")
    .trim().slice(0, limit);
  // The same rule as normalizeOzonSearchQuery in source-routing.js; compared without regard to letter case.
  const fold = (value) => {
    if (typeof value !== "string") return null;
    const query = value.normalize("NFC").replace(/[\u0000-\u001f\u007f\u00a0\u2000-\u200b\u2028\u2029\u202f\u3000]/g, " ")
      .replace(/\s+/g, " ").trim();
    return query.length >= 2 && query.length <= 100 ? query.toLowerCase() : null;
  };
  const productIdFrom = (link) => {
    if (typeof link !== "string" || !link) return null;
    try {
      const url = new URL(link, "https://www.ozon.ru");
      if (url.protocol !== "https:" || !["www.ozon.ru", "ozon.ru"].includes(url.hostname) || url.username || url.password || url.port) return null;
      return url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{5,20})\/?$/)?.[1] || null;
    } catch { return null; }
  };
  const ozonImage = (value) => {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value);
      if (url.protocol !== "https:" || url.hostname !== "ir.ozone.ru" || url.username || url.password || url.port) return null;
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  };
  // "1 299 ₽", "1 299,50 ₽" or a bare number; anything ambiguous stays unknown.
  const rubles = (value) => {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
    const text = plain(value, 40).replace(/\s*(?:₽|руб\.?|RUB)$/i, "");
    let normalized = text;
    if (/^\d{1,3}(?: \d{3})+(?:,\d{1,2})?$/.test(text)) normalized = text.replace(/ /g, "").replace(",", ".");
    else if (/^\d+,\d{1,2}$/.test(text)) normalized = text.replace(",", ".");
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return parsed > 0 && parsed <= 10_000_000 ? parsed : null;
  };
  const rating = (value) => {
    const match = plain(value, 20).match(/^([0-5](?:[.,]\d{1,2})?)$/);
    const parsed = match ? Number(match[1].replace(",", ".")) : NaN;
    return parsed > 0 && parsed <= 5 ? parsed : null;
  };
  // "1 234 отзыва", "57 отзывов", "1 отзыв".
  const reviews = (value) => {
    const match = plain(value, 40).match(/^(\d{1,3}(?: \d{3})*|\d+)\s*отзыв/i);
    const parsed = match ? Number(match[1].replace(/ /g, "")) : NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };

  const pageQuery = () => {
    try {
      const url = new URL(window.location.href);
      if (url.hostname !== "www.ozon.ru" || !/^\/(?:search|category\/[^/]+)\/?$/.test(url.pathname)) return null;
      return url.searchParams.get("text");
    } catch { return null; }
  };
  const pageBlocker = () => {
    if (document.querySelector?.('[id="captcha"], [data-widget="captcha"], iframe[src*="captcha"], #challenge-form, .challenge-form')) {
      return "site_verification_required";
    }
    if (/antibot|Доступ ограничен|Access denied/i.test(String(document.title || ""))) return "site_verification_required";
    if (document.querySelector?.('[data-widget="loginForm"]')) return "site_login_required";
    return null;
  };
  const emptyStateShown = () => /ничего не (?:нашлось|найдено)|товаров сейчас нет|не нашлось|По вашему запросу товаров/i
    .test(String(document.body?.innerText || "").slice(0, 20000));

  // Ozon's widget state: one tile per entry, the product link in action.link, the facts in mainState atoms.
  const atomsOf = (entry) => (Array.isArray(entry?.mainState) ? entry.mainState : []).map((atom) => atom?.atom ?? atom)
    .filter((atom) => atom && typeof atom === "object");
  const fromState = (entry, index) => {
    const linkId = productIdFrom(entry?.action?.link ?? entry?.link);
    const skuId = /^\d{5,20}$/.test(String(entry?.skuId ?? entry?.sku ?? "")) ? String(entry.skuId ?? entry.sku) : null;
    if (linkId && skuId && linkId !== skuId) return null;
    const productId = linkId || skuId;
    if (!productId) return null;
    let named = "";
    let fallbackTitle = "";
    let priceRub = null;
    let originalPriceRub = null;
    let ratingValue = null;
    let reviewCount = null;
    let isAd = entry?.isAdv === true || entry?.isAd === true;
    for (const atom of atomsOf(entry)) {
      const body = atom[atom.type] ?? {};
      if (atom.type === "textAtom") {
        const value = plain(body.text, 300);
        if (atom.id === "name") named = value;
        else if (!fallbackTitle && value.length > 12) fallbackTitle = value;
        if (value === "Реклама") isAd = true;
      } else if (atom.type === "priceV2" || atom.type === "price") {
        const prices = Array.isArray(body.price) ? body.price : [];
        for (const price of prices) {
          if (price?.textStyle === "PRICE" && priceRub === null) priceRub = rubles(price.text);
          if (price?.textStyle === "ORIGINAL_PRICE" && originalPriceRub === null) originalPriceRub = rubles(price.text);
        }
        if (priceRub === null && typeof body.price === "string") priceRub = rubles(body.price);
        if (originalPriceRub === null && typeof body.originalPrice === "string") originalPriceRub = rubles(body.originalPrice);
      } else if (atom.type === "labelList") {
        for (const label of Array.isArray(body.items) ? body.items : []) {
          const icon = String(label?.icon?.image || "");
          if (ratingValue === null && /star/i.test(icon)) ratingValue = rating(label.title);
          if (reviewCount === null) reviewCount = reviews(label.title);
          if (plain(label?.title, 20) === "Реклама") isAd = true;
        }
      }
    }
    const pictures = [
      ...(Array.isArray(entry?.tileImage?.items) ? entry.tileImage.items.map((item) => item?.image?.link) : []),
      ...(Array.isArray(entry?.tileImage?.images) ? entry.tileImage.images : []),
      entry?.tileImage?.image?.link
    ];
    return { productId, title: named || fallbackTitle, imageUrl: pictures.map(ozonImage).find(Boolean) || null, priceRub, originalPriceRub,
      rating: ratingValue, reviewCount, isAd, rank: index };
  };
  const readState = () => {
    const products = new Map();
    const hosts = Array.from(document.querySelectorAll?.('[id^="state-searchResultsV2-"], [id^="state-searchResultsV3-"], [id^="state-tileGridDesktop-"]') || []);
    for (const host of hosts) {
      let state = null;
      try { state = JSON.parse(host.getAttribute("data-state") || "null"); } catch { state = null; }
      for (const entry of Array.isArray(state?.items) ? state.items : []) {
        const item = fromState(entry, products.size);
        if (item && !products.has(item.productId)) products.set(item.productId, item);
      }
    }
    return products;
  };

  // The rendered tiles: inside the search-results widget, each product's links share one tile, the highest ancestor that
  // holds no other product's link.
  const readTiles = () => {
    const products = new Map();
    const roots = Array.from(document.querySelectorAll?.('[data-widget="searchResultsV2"], [data-widget="searchResultsV3"], [data-widget="tileGridDesktop"]') || []);
    for (const root of roots) {
      const anchors = Array.from(root.querySelectorAll?.('a[href*="/product/"]') || []);
      const idOf = (anchor) => productIdFrom(anchor.getAttribute?.("href"));
      for (const anchor of anchors) {
        const productId = idOf(anchor);
        if (!productId || products.has(productId)) continue;
        let tile = anchor;
        while (tile.parentElement && tile.parentElement !== root &&
          Array.from(tile.parentElement.querySelectorAll?.('a[href*="/product/"]') || []).every((other) => [productId, null].includes(idOf(other)))) {
          tile = tile.parentElement;
        }
        const ownAnchors = Array.from(tile.querySelectorAll?.('a[href*="/product/"]') || []).filter((other) => idOf(other) === productId);
        const title = ownAnchors.map((other) => plain(other.textContent, 300)).sort((left, right) => right.length - left.length)[0] || "";
        const picture = Array.from(tile.querySelectorAll?.("img") || []).map((image) => ozonImage(image.getAttribute?.("src")) ||
          ozonImage(String(image.getAttribute?.("srcset") || "").split(/\s+/)[0])).find(Boolean) || null;
        const lines = String(tile.innerText || tile.textContent || "").split(/\n+/).map((line) => plain(line, 80)).filter(Boolean);
        const priceLines = lines.filter((line) => /^\d[\d ]*(?:,\d{1,2})? ?₽$/.test(line)).map(rubles).filter((value) => value !== null);
        products.set(productId, { productId, title, imageUrl: picture, priceRub: priceLines[0] ?? null,
          originalPriceRub: priceLines.length > 1 && priceLines[1] > priceLines[0] ? priceLines[1] : null,
          rating: lines.map(rating).find((value) => value !== null) ?? null, reviewCount: lines.map(reviews).find((value) => value !== null) ?? null,
          isAd: lines.includes("Реклама"), rank: products.size });
      }
    }
    return products;
  };

  if (fold(pageQuery()) === null || fold(pageQuery()) !== fold(expectedQuery)) return failed("wrong_query");
  // The grid fills in after the page script runs; wait until the count holds still, within the job's own deadline.
  const startedAt = Date.now();
  let products = new Map();
  let readFrom = "state";
  let stableSince = 0;
  while (true) {
    const blocker = pageBlocker();
    if (blocker) return failed(blocker);
    let next = readState();
    let source = "state";
    if (!next.size) { next = readTiles(); source = "dom"; }
    if (next.size > 0 && next.size === products.size && source === readFrom) {
      if (Date.now() - stableSince >= 1500) break;
    } else {
      stableSince = Date.now();
    }
    products = next;
    readFrom = source;
    if (next.size === 0 && Date.now() - startedAt >= 4000 && emptyStateShown()) return failed("results_empty");
    if (Date.now() - startedAt >= 18000) break;
    await sleep(300);
  }
  if (products.size === 0) return failed(emptyStateShown() ? "results_empty" : "results_unverifiable");
  // The address is read once more after the wait: a page that moved to another search in the meantime is not this one.
  if (fold(pageQuery()) !== fold(expectedQuery)) return failed("wrong_query");
  const items = [...products.values()].filter((item) => item.title || item.imageUrl);
  if (!items.length) return failed("structured_data_unavailable");
  return {
    status: "captured",
    evidence: {
      query: expectedQuery,
      observedAt: new Date().toISOString(),
      cardCount: products.size,
      readFrom,
      items: items.slice(0, Math.max(1, Math.min(36, Number(maxResults) || 36)))
    }
  };
}
