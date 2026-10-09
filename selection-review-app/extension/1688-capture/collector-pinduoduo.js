export async function collectPinduoduoPage(expectedGoodsId) {
  const limitText = (value, limit = 800) => (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) ? String(value).trim().slice(0, limit) : "";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const first = (...values) => values.find((value) => limitText(value) !== "");
  // Yuan with at most two decimals, written as a number or as the plain digits of one. Nothing else is a price here.
  const yuanFrom = (value) => {
    const scalar = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/^[¥￥]\s*/, "") : "";
    if (!/^\d+(?:\.\d{1,2})?$/.test(scalar)) return null;
    const parsed = Number(scalar);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : null;
  };
  // Pinduoduo's own APIs carry money as integer fen under snake_case names; the page model's camelCase names carry yuan.
  // A fen field is accepted only as a whole number, so a yuan value can never be divided by a hundred by mistake.
  const fenToYuan = (value) => {
    const scalar = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    return Number.isSafeInteger(scalar) && scalar > 0 && scalar <= 100_000_000 ? Math.round(scalar) / 100 : null;
  };
  const countFrom = (value) => {
    const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const imageUrlFrom = (value) => {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !/(^|\.)(?:pddpic\.com|yangkeduo\.com)$/.test(url.hostname)) return null;
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  };

  let pageGoodsId = "";
  try {
    const url = new URL(window.location.href);
    const ids = url.searchParams.getAll("goods_id");
    if (url.protocol === "https:" && ["mobile.yangkeduo.com", "mobile.pinduoduo.com"].includes(url.hostname) &&
        ["/goods.html", "/goods1.html", "/goods2.html"].includes(url.pathname) && !url.username && !url.password && !url.port &&
        ids.length === 1 && /^\d{1,40}$/.test(ids[0])) pageGoodsId = ids[0];
  } catch { /* Invalid page identity fails below, without returning its URL. */ }
  if (!pageGoodsId || pageGoodsId !== String(expectedGoodsId)) {
    return { status: "failed", failureCode: "wrong_offer", message: "页面goods_id与当前候选不一致", offerId: pageGoodsId };
  }

  const pageBlocker = () => {
    if (document.querySelector?.('iframe[src*="captcha"], [id="captcha"], [id^="captcha-"], [data-widget="captcha"]')) return "site_verification_required";
    if (document.querySelector?.('form[action*="login"] input[type="password"], [data-widget="loginForm"]')) return "site_login_required";
    return null;
  };
  // The goods page carries its model as an ordinary inline assignment (window.rawData={"store":{"initDataObj":…}}).
  // The object is sliced out of the script text by its own key names — the script is never executed and no
  // MAIN-world global is ever read, so the page cannot decide what this collector sees.
  const balancedJsonObject = (source, from) => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = from; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(from, index + 1);
        if (depth < 0) return "";
      }
    }
    return "";
  };
  const parseEvidenceJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const goodsFrom = (parsed) => {
    const init = parsed?.store?.initDataObj || parsed?.initDataObj || null;
    const goods = init?.goods;
    if (!goods || typeof goods !== "object" || Array.isArray(goods)) return null;
    return { goods, init };
  };
  const readPageData = () => {
    const models = [];
    const seenPayloads = new Set();
    for (const script of Array.from(document.querySelectorAll?.("script") || []).slice(0, 80)) {
      const content = script.textContent;
      if (typeof content !== "string" || !content || content.length > 5_000_000 || !content.includes('"initDataObj"')) continue;
      for (const anchor of ['{"store":', '{"initDataObj":']) {
        const start = content.indexOf(anchor);
        if (start < 0) continue;
        const sliced = balancedJsonObject(content, start);
        if (!sliced) continue;
        if (seenPayloads.has(sliced)) break; // The same payload emitted twice is one statement, not two.
        const found = goodsFrom(parseEvidenceJson(sliced));
        if (found) { seenPayloads.add(sliced); models.push(found); break; }
      }
    }
    // Two differing copies of the model are not evidence; one page must speak with one voice.
    return models.length === 1 ? models[0] : null;
  };

  // 20s of in-page polling: the model on a throttled background tab can arrive well after the first paint.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !pageBlocker() && !readPageData()) await sleep(250);

  const blocker = pageBlocker();
  if (blocker) return { status: "failed", failureCode: blocker, offerId: pageGoodsId };
  const pageData = readPageData();
  if (!pageData) return { status: "failed", failureCode: "structured_data_unavailable", message: "页面没有可核验的商品结构化数据", offerId: pageGoodsId };
  const { goods } = pageData;
  // Every place the model states its own identity must agree with the address; one dissenting copy means another goods.
  const declared = [[goods.goodsID, "goodsID"], [goods.goodsId, "goodsId"], [goods.goods_id, "goods_id"]]
    .map(([value, field]) => [limitText(value, 40), field]).filter(([value]) => value !== "");
  if (!declared.length || declared.some(([value]) => value !== String(expectedGoodsId))) {
    return { status: "failed", failureCode: "wrong_offer", offerId: pageGoodsId };
  }

  const supplierAttributes = {};
  for (const item of Array.isArray(goods.goodsProperty) ? goods.goodsProperty.slice(0, 120) : []) {
    const key = limitText(first(item?.key, item?.name), 120);
    const values = Array.isArray(item?.values) ? item.values.map((value) => limitText(value, 200)).filter(Boolean) : [limitText(first(item?.value, item?.values), 500)].filter(Boolean);
    if (key && values.length) supplierAttributes[key] = values.join("，").slice(0, 500);
  }

  const priceOf = (rawSku, path) => {
    // 拼单价 is what a supplier order is placed at, so it is the price this capture reports; 单独购买价 is not a fallback.
    for (const [field, read] of [["groupPrice", yuanFrom], ["group_price", fenToYuan]]) {
      if (!Object.prototype.hasOwnProperty.call(rawSku, field)) continue;
      const value = read(rawSku[field]);
      return value === null ? { value: null, source: null } : { value, source: `${path}.${field}` };
    }
    return { value: null, source: null };
  };

  const rawSkus = Array.isArray(goods.skus) ? goods.skus : [];
  if (rawSkus.length > 200) return { status: "failed", failureCode: "sku_limit_exceeded", message: `页面包含${rawSkus.length}个SKU，未截断`, offerId: pageGoodsId };
  const skus = [];
  const seen = new Set();
  rawSkus.forEach((rawSku, index) => {
    if (!rawSku || typeof rawSku !== "object") return;
    const sourceSkuId = limitText(first(rawSku.skuId, rawSku.skuID, rawSku.sku_id), 160);
    if (!sourceSkuId || seen.has(sourceSkuId)) return;
    seen.add(sourceSkuId);
    const path = `rawData.goods.skus[${index}]`;
    const attributes = {};
    for (const spec of Array.isArray(rawSku.specs) ? rawSku.specs.slice(0, 30) : []) {
      const key = limitText(first(spec?.spec_key, spec?.specKey, spec?.key), 120);
      const value = limitText(first(spec?.spec_value, spec?.specValue, spec?.value), 300);
      if (key && value) attributes[key] = value;
    }
    const price = priceOf(rawSku, path);
    const stock = countFrom(rawSku.quantity);
    skus.push({
      sourceSkuId,
      propPath: null,
      attributes,
      priceCny: price.value,
      priceSource: price.source,
      stock,
      stockSource: stock === null ? null : `${path}.quantity`,
      inStock: stock === null ? null : stock > 0,
      imageUrl: imageUrlFrom(first(rawSku.thumbUrl, rawSku.thumb_url, rawSku.skuThumbUrl)),
      weight: null,
      weightSource: null
    });
  });
  if (!skus.length) return { status: "failed", failureCode: "structured_data_unavailable", message: "未取得带SKU ID的规格数据", offerId: pageGoodsId };

  const titleChoice = [
    [goods.goodsName, "rawData.goods.goodsName"],
    [goods.goods_name, "rawData.goods.goods_name"],
    [document.querySelector?.('meta[property="og:title"]')?.content, "dom.meta.og:title"],
    [document.title, "document.title"]
  ].map(([value, source]) => [limitText(value, 800).replace(/\s*[-_|]\s*拼多多.*$/, "").trim(), source])
    .find(([value]) => value) || ["", null];
  const onSale = goods.isOnSale ?? goods.is_on_sale;

  return {
    status: "captured",
    evidence: {
      offerId: pageGoodsId,
      sourceUrl: `https://mobile.yangkeduo.com/goods.html?goods_id=${pageGoodsId}`,
      title: titleChoice[0],
      offerStatus: typeof onSale === "boolean" || onSale === 0 || onSale === 1 ? (onSale === true || onSale === 1 ? "on_sale" : "off_sale") : null,
      observedAt: new Date().toISOString(),
      titleSource: titleChoice[1],
      offerIdSource: `rawData.goods.${declared[0][1]}`,
      pageSelectedSkuId: null,
      priceRanges: [],
      pageFields: {
        unitProductPriceCny: null,
        unitProductPriceSource: null,
        unitDomesticFreightCny: null,
        unitDomesticFreightSource: null
      },
      supplierAttributes,
      skus
    }
  };
}
