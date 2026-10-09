export async function collect1688Page(expectedOfferId) {
  const limitText = (value, limit = 800) => (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) ? String(value).trim().slice(0, limit) : "";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const numberFrom = (value, kind = "money") => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && (kind !== "count" || Number.isInteger(value)) ? value : null;
    if (typeof value !== "string") return null;
    // Parse the complete scalar, never the first number of a range, tier or SKU label.
    let scalar = kind === "count"
      ? value.trim().replace(/^库存\s*/, "").replace(/\s*件$/, "")
      : value.trim().replace(/^(?:[¥￥]|CNY)\s*/i, "").replace(/\s*(?:元|CNY)$/i, "");
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(scalar)) scalar = scalar.replace(/,/g, "");
    else if (/^\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?$/.test(scalar)) scalar = scalar.replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
    else if (/^\d+,\d{1,2}$/.test(scalar)) scalar = scalar.replace(",", ".");
    if (!/^\d+(?:\.\d{1,2})?$/.test(scalar)) return null;
    const parsed = Number(scalar);
    return Number.isFinite(parsed) && parsed <= Number.MAX_SAFE_INTEGER && (kind !== "count" || Number.isInteger(parsed)) ? parsed : null;
  };
  const imageUrlFrom = (value) => {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !/(^|\.)alicdn\.com$/.test(url.hostname)) return null;
      return `${url.origin}${url.pathname}`;
    } catch { return null; }
  };
  const first = (...values) => values.find((value) => limitText(value) !== "");
  const firstObject = (...values) => values.find((value) => value !== null && typeof value === "object");
  // 1688 ships SKU labels HTML-escaped ("黑色&gt;4XL"); the owner must read the specification, not the markup.
  const plainText = (value, limit = 800) => limitText(value, limit)
    .replace(/&(?:amp|lt|gt|quot|#0*39|apos|nbsp);/g, (entity) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[entity] || (/^&#0*39;$/.test(entity) ? "'" : entity))
    .trim();
  // Shipping weight is kilograms in the page model and is neither money nor a count, so it keeps its own range check.
  const weightKgFrom = (value) => {
    const parsed = typeof value === "number" ? value : (typeof value === "string" && /^\d+(?:\.\d{1,6})?$/.test(value.trim()) ? Number(value.trim()) : NaN);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1000 ? parsed : null;
  };
  let pageOfferId = "";
  try {
    const url = new URL(window.location.href);
    if (url.protocol === "https:" && url.hostname === "detail.1688.com" && !url.username && !url.password && !url.port) pageOfferId = url.pathname.match(/^\/offer\/(\d+)\.html$/)?.[1] || "";
  } catch { /* Invalid page identity fails below, without returning its URL. */ }
  if (!pageOfferId || pageOfferId !== String(expectedOfferId)) {
    return { status: "failed", failureCode: "wrong_offer", message: "页面offerId与当前候选不一致", offerId: pageOfferId };
  }
  // ISOLATED protects built-ins, not the website-controlled DOM. JSON is evidence,
  // not trusted authority; never execute scripts or read MAIN-world globals.
  const pageBlocker = () => {
    if (document.querySelector?.('[id="nc_1_wrapper"], [id="captcha"], [data-widget="captcha"], iframe[src*="captcha"]')) return "site_verification_required";
    if (document.querySelector?.('form[action*="login"] input[type="password"], [data-widget="loginForm"]')) return "site_login_required";
    return null;
  };
  // Since 2026-09-12 detail.1688.com ships zero script[type="application/json"]; the model travels as the second
  // argument of an ordinary inline IIFE (window.context=(function(b,d){…})(window.contextPath,{"result":…})).
  // Reading it means slicing that argument out of the script text — the script itself is never executed and no
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
  // The argument is not valid JSON: 1688 emits bare numeric keys ({5846845077743:0.2400}), which is exactly why it
  // can no longer live in an application/json script. Quoting them needs string awareness, or a digit sequence that
  // merely looks like a key inside a product description would be rewritten. Only a parse failure pays this cost.
  const quoteBareNumericKeys = (source) => {
    const blank = (character) => character === " " || character === "\t" || character === "\n" || character === "\r";
    let output = "";
    let inString = false;
    let escaped = false;
    let index = 0;
    while (index < source.length) {
      const character = source[index];
      if (inString) {
        output += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        index += 1;
        continue;
      }
      if (character === '"') {
        inString = true;
        output += character;
        index += 1;
        continue;
      }
      if (character === "{" || character === ",") {
        let start = index + 1;
        while (start < source.length && blank(source[start])) start += 1;
        let end = start;
        while (end < source.length && source[end] >= "0" && source[end] <= "9") end += 1;
        let colon = end;
        while (colon < source.length && blank(source[colon])) colon += 1;
        // A JSON value can never be followed by ":", so digits + ":" after "{" or "," is unambiguously a bare key.
        if (end > start && end - start <= 40 && source[colon] === ":") {
          output += `${source.slice(index, start)}"${source.slice(start, end)}"`;
          index = end;
          continue;
        }
      }
      output += character;
      index += 1;
    }
    return output;
  };
  const parseEvidenceJson = (text) => {
    try { return JSON.parse(text); } catch { /* Fall through to the bare-key repair below. */ }
    try { return JSON.parse(quoteBareNumericKeys(text)); } catch { return null; }
  };
  const modelFrom = (parsed) => {
    const model = parsed?.result?.global?.globalData?.model || parsed?.globalData;
    if (!model || typeof model !== "object" || Array.isArray(model)) return null;
    const data = parsed?.result?.data;
    // The legacy offerBaseInfo/skuModel/orderParamModel/tempModel shape survived the move; it is now a widget payload.
    const dataJson = data?.Root?.fields?.dataJson;
    return { model, data, init: parsed, dataJson: dataJson && typeof dataJson === "object" && !Array.isArray(dataJson) ? dataJson : null };
  };
  const readPageData = () => {
    const models = [];
    const seenPayloads = new Set();
    for (const script of Array.from(document.querySelectorAll?.("script") || []).slice(0, 60)) {
      const content = script.textContent;
      if (typeof content !== "string" || !content || content.length > 3_000_000) continue;
      const scriptType = limitText(script.getAttribute?.("type"), 80).toLowerCase();
      const candidates = [];
      if (scriptType === "application/json" || scriptType === "application/ld+json") candidates.push(content);
      else if (content.includes('"globalData"')) {
        // Anchored on the payload's own key names, never on 1688's wrapper syntax, which is minified per release.
        for (const anchor of ['{"result":', '{"globalData"', '{"data":']) {
          const start = content.indexOf(anchor);
          if (start < 0) continue;
          const sliced = balancedJsonObject(content, start);
          if (sliced) candidates.push(sliced);
        }
      }
      for (const candidate of candidates) {
        if (seenPayloads.has(candidate)) break; // The same payload emitted twice is one statement, not two.
        const found = modelFrom(parseEvidenceJson(candidate));
        if (found) { seenPayloads.add(candidate); models.push(found); break; }
      }
    }
    // Two *differing* copies of the model are not evidence; one page must speak with one voice.
    return models.length === 1 ? models[0] : null;
  };
  // The 2026-09 specification table dropped .ant-table-tbody and tr[data-row-key] alike, so presence is judged by the
  // widget id the page model itself declares (result.data.skuSelection.id) plus a plain table row — no styling classes.
  const skuTableScopes = () => Array.from(document.querySelectorAll?.('#skuSelection, [data-tag="skuSelection"], [data-widget-id="skuSelection"]') || []).slice(0, 5);
  const skuTableRows = () => {
    const rows = [];
    for (const scope of skuTableScopes()) rows.push(...Array.from(scope.querySelectorAll?.("tbody tr") || []));
    return rows.slice(0, 400);
  };
  const skuRowsPresent = () => skuTableRows().length > 0;

  // 20s of in-page polling: the model JSON on a throttled background tab arrives well after the first paint.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !pageBlocker() && !readPageData() && !skuRowsPresent()) await sleep(250);

  const blocker = pageBlocker();
  if (blocker) return { status: "failed", failureCode: blocker, offerId: pageOfferId };
  const pageData = readPageData();
  const root = pageData?.model;
  const dataRoot = pageData?.dataJson || null;
  const offerBaseInfo = root?.offerBaseInfo || dataRoot?.offerBaseInfo || null;
  const offerDetail = root?.offerDetail || dataRoot?.offerDetail || null;
  const tradeModel = root?.tradeModel || dataRoot?.tradeModel || null;
  const skuModel = root?.skuModel || dataRoot?.skuModel || null;
  const tempModel = dataRoot?.tempModel || root?.tempModel || null;
  // Every place the page states its own identity must agree; one dissenting copy means the tab is not this offer.
  const offerIdCandidates = [
    [offerBaseInfo?.offerId, "offerBaseInfo.offerId"],
    [offerDetail?.offerId, "offerDetail.offerId"],
    [tradeModel?.offerId, "tradeModel.offerId"],
    [tempModel?.offerId, "tempModel.offerId"],
    [pageData?.data?.offerId, "data.offerId"]
  ].map(([value, source]) => [limitText(value, 40), source]).filter(([value]) => value !== "");
  const declaredOfferIds = offerIdCandidates.map(([value]) => value);
  if (root && (!declaredOfferIds.length || declaredOfferIds.some((value) => value !== String(expectedOfferId)))) {
    return { status: "failed", failureCode: "wrong_offer", offerId: pageOfferId };
  }
  const structuredOfferId = offerIdCandidates[0]?.[0] || "";
  const structuredOfferIdSource = offerIdCandidates[0]?.[1] || null;
  const actualOfferId = structuredOfferId || pageOfferId;
  if (!actualOfferId || actualOfferId !== String(expectedOfferId) || (pageOfferId && pageOfferId !== String(expectedOfferId))) {
    return { status: "failed", failureCode: "wrong_offer", message: "页面offerId与当前候选不一致", offerId: actualOfferId || pageOfferId };
  }

  if (!root && !skuRowsPresent()) {
    return { status: "failed", failureCode: "structured_data_unavailable", message: "页面没有可核验的SKU结构化数据", offerId: actualOfferId };
  }

  const supplierAttributes = {};
  const attributeLists = [
    root?.offerAttributeModel?.offerAttrs,
    offerDetail?.featureAttributes,
    pageData?.data?.productAttributes?.fields?.attributes
  ];
  for (const list of attributeLists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const key = plainText(first(item?.name, item?.attrName, item?.title, item?.key), 120);
      const value = plainText(first(item?.value, item?.attrValue, item?.content, item?.text), 500);
      if (key && value) supplierAttributes[key] = value;
    }
  }

  const skuProps = [skuModel?.skuProps, root?.skuProps, offerDetail?.skuProps]
    .find((list) => Array.isArray(list) && list.length) || [];
  const propLookup = new Map();
  // Declared order and declared value names: the only basis on which a combined specification label may be split.
  const orderedProps = [];
  for (const prop of skuProps) {
    const propId = limitText(first(prop?.fid, prop?.propId, prop?.id, prop?.pid), 80);
    const propName = plainText(first(prop?.prop, prop?.propName, prop?.name, "规格"), 120);
    const valueNames = new Set();
    for (const item of Array.isArray(prop?.value) ? prop.value : []) {
      const valueId = limitText(first(item?.vid, item?.valueId, item?.id, item?.propValueId), 80);
      const valueName = plainText(first(item?.name, item?.value, item?.displayName, item?.text), 300);
      if (!valueName) continue;
      valueNames.add(valueName);
      if (propId && valueId) propLookup.set(`${propId}:${valueId}`, [propName, valueName]);
    }
    if (propName && valueNames.size) orderedProps.push([propName, valueNames]);
  }
  const splitSpecLabel = (label) => {
    if (!orderedProps.length) return null;
    const parts = label.split(">").map((part) => part.trim()).filter((part) => part !== "");
    if (parts.length !== orderedProps.length) return null;
    return parts.every((part, index) => orderedProps[index][1].has(part))
      ? parts.map((part, index) => [orderedProps[index][0], part])
      : null;
  };

  const attributesForSku = (rawSku) => {
    const attributes = {};
    const direct = firstObject(rawSku?.specAttrs, rawSku?.specAttr, rawSku?.attributes) || first(rawSku?.specAttrs, rawSku?.specAttr, rawSku?.attributes);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      for (const [key, value] of Object.entries(direct)) {
        const cleaned = plainText(value, 300);
        if (cleaned) attributes[plainText(key, 120)] = cleaned;
      }
    } else if (Array.isArray(direct)) {
      for (const item of direct) {
        const key = plainText(first(item?.name, item?.key, item?.propName), 120);
        const value = plainText(first(item?.value, item?.text, item?.valueName), 300);
        if (key && value) attributes[key] = value;
      }
    } else if (direct && !/^\d+:\d+(?:[;,]\d+:\d+)*$/.test(String(direct).replace(/\s+/g, ""))) {
      const label = plainText(direct, 500);
      attributes["规格"] = label;
      for (const [propName, value] of splitSpecLabel(label) || []) attributes[propName] = value;
    }
    const propPath = limitText(first(rawSku?.propPath, rawSku?.specId, rawSku?.specAttrs), 600);
    for (const token of propPath.match(/\d+:\d+/g) || []) {
      const mapped = propLookup.get(token);
      if (mapped) attributes[mapped[0]] = mapped[1];
    }
    return { attributes, propPath: propPath || null };
  };

  const directField = (object, fields, positiveOnly = false, kind = "money") => {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(object || {}, field)) continue;
      const parsed = numberFrom(object[field], kind);
      return parsed !== null && (!positiveOnly || parsed > 0) ? { value: parsed, source: field } : { value: null, source: null };
    }
    return { value: null, source: null };
  };

  const explicitScalarField = (entries, positiveOnly = false) => {
    for (const [source, value] of entries) {
      if (value === null || value === undefined || value === "") continue;
      const parsed = numberFrom(value);
      return parsed !== null && (!positiveOnly || parsed > 0) ? { value: parsed, source } : { value: null, source: null };
    }
    return { value: null, source: null };
  };

  const rawSkuEntries = [];
  const addEntries = (value, source) => {
    if (Array.isArray(value)) value.forEach((item, index) => rawSkuEntries.push({ item, source: `${source}[${index}]` }));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => rawSkuEntries.push({ item, source: `${source}.${key}` }));
  };
  addEntries(tradeModel?.skuMap, "tradeModel.skuMap");
  addEntries(tradeModel?.skuInfoMap, "tradeModel.skuInfoMap");
  addEntries(tradeModel?.skuInfos, "tradeModel.skuInfos");
  addEntries(tradeModel?.skuList, "tradeModel.skuList");
  addEntries(tradeModel?.skuItems, "tradeModel.skuItems");
  addEntries(skuModel?.skuInfoMap, "skuModel.skuInfoMap");
  addEntries(skuModel?.skuMap, "skuModel.skuMap");
  addEntries(skuModel?.skuInfos, "skuModel.skuInfos");
  addEntries(skuModel?.skuList, "skuModel.skuList");
  addEntries(skuModel?.skuItems, "skuModel.skuItems");
  addEntries(skuModel?.skus, "skuModel.skus");
  addEntries(root?.skuMap, "root.skuMap");
  addEntries(root?.skuInfoMap, "root.skuInfoMap");
  addEntries(root?.skuInfos, "root.skuInfos");
  addEntries(root?.skuList, "root.skuList");
  addEntries(root?.offerSkuModel?.skuInfoMap, "root.offerSkuModel.skuInfoMap");
  addEntries(root?.offerSkuModel?.skuMap, "root.offerSkuModel.skuMap");
  addEntries(pageData?.init?.skuModel?.skuInfoMap, "json.skuModel.skuInfoMap");
  addEntries(pageData?.init?.skuModel?.skuMap, "json.skuModel.skuMap");
  addEntries(pageData?.init?.skuModel?.skuInfos, "json.skuModel.skuInfos");
  addEntries(pageData?.init?.skuModel?.skuList, "json.skuModel.skuList");

  // Per-SKU shipping weight in kilograms. It never creates a SKU, it only annotates one the SKU maps already declare.
  const skuWeightSources = [
    [root?.detailDescription?.freightInfo?.skuWeight, "detailDescription.freightInfo.skuWeight"],
    [pageData?.data?.shippingServices?.fields?.freightInfo?.skuWeight, "shippingServices.freightInfo.skuWeight"],
    [pageData?.data?.submitOrder?.fields?.freightInfo?.skuWeight, "submitOrder.freightInfo.skuWeight"],
    [root?.freightModel?.skuWeight, "freightModel.skuWeight"]
  ];
  const skuWeights = new Map();
  for (const [map, source] of skuWeightSources) {
    // A $ref placeholder yields no numbers, so an aliased copy simply contributes nothing.
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map).slice(0, 400)) {
      const id = limitText(key, 160);
      const weightKg = weightKgFrom(value);
      if (id && weightKg !== null && !skuWeights.has(id)) skuWeights.set(id, { value: weightKg, unit: "kg", source });
    }
  }
  const weightFor = (id) => (skuWeights.has(id) ? { value: skuWeights.get(id).value, unit: "kg" } : null);
  const weightSourceFor = (id) => (skuWeights.has(id) ? skuWeights.get(id).source : null);

  const skus = [];
  const skuById = new Map();
  for (const entry of rawSkuEntries) {
    const rawSku = entry.item;
    if (!rawSku || typeof rawSku !== "object") continue;
    // specId and map keys may be property combinations, not a supplier SKU ID.
    const sourceSkuId = limitText(first(rawSku?.skuId, rawSku?.id), 160);
    if (!sourceSkuId) continue;
    const price = directField(rawSku, ["price", "discountPrice", "currentPrice", "priceDisplay", "unitPrice"], true);
    const stock = directField(rawSku, ["canBookCount", "canBookedAmount", "amountOnSale", "stock", "quantity"], false, "count");
    const details = attributesForSku(rawSku);
    const imageUrl = limitText(first(rawSku?.imageUrl, rawSku?.imgUrl, rawSku?.image), 2000);
    const incoming = {
      sourceSkuId,
      propPath: details.propPath,
      attributes: details.attributes,
      priceCny: price.value !== null && price.value > 0 ? price.value : null,
      priceSource: price.value !== null && price.value > 0 ? `${entry.source}.${price.source}` : null,
      stock: stock.value !== null && stock.value >= 0 ? stock.value : null,
      stockSource: stock.value !== null && stock.value >= 0 ? `${entry.source}.${stock.source}` : null,
      inStock: typeof rawSku.inStock === "boolean" ? rawSku.inStock : stock.value === null ? null : stock.value > 0,
      imageUrl: imageUrlFrom(imageUrl),
      weight: weightFor(sourceSkuId),
      weightSource: weightSourceFor(sourceSkuId)
    };
    const existing = skuById.get(sourceSkuId);
    if (!existing) {
      skuById.set(sourceSkuId, incoming);
      skus.push(incoming);
      continue;
    }
    if ((existing.priceCny !== null && incoming.priceCny !== null && existing.priceCny !== incoming.priceCny) ||
        (existing.stock !== null && incoming.stock !== null && existing.stock !== incoming.stock) ||
        Object.entries(incoming.attributes).some(([key, value]) => existing.attributes[key] !== undefined && existing.attributes[key] !== value)) {
      return { status: "failed", failureCode: "structured_data_unavailable", offerId: actualOfferId };
    }
    existing.propPath ||= incoming.propPath;
    existing.attributes = { ...existing.attributes, ...incoming.attributes };
    if (existing.priceCny === null && incoming.priceCny !== null) {
      existing.priceCny = incoming.priceCny;
      existing.priceSource = incoming.priceSource;
    }
    if (existing.stock === null && incoming.stock !== null) {
      existing.stock = incoming.stock;
      existing.stockSource = incoming.stockSource;
    }
    if (existing.inStock === null && incoming.inStock !== null) existing.inStock = incoming.inStock;
    existing.imageUrl ||= incoming.imageUrl;
    existing.weight ||= incoming.weight;
    existing.weightSource ||= incoming.weightSource;
  }

  // DOM fallback only. A table row is usable evidence solely when it still carries a supplier SKU ID, and price and
  // stock are located through the table's own header text rather than through release-specific styling classes.
  const headers = [];
  for (const scope of skuTableScopes()) {
    if (headers.length) break;
    headers.push(...Array.from(scope.querySelectorAll?.("thead th") || []).map((node) => plainText(node.textContent, 120)));
  }
  const headerIndex = (pattern) => headers.findIndex((header) => pattern.test(header));
  const priceColumn = headerIndex(/价格|单价/);
  const stockColumn = headerIndex(/库存|可售|可订/);
  for (const row of skuTableRows()) {
      const sourceSkuId = limitText(first(row.getAttribute?.("data-row-key"), row.getAttribute?.("data-sku-id"), row.getAttribute?.("data-skuid")), 160);
      if (!sourceSkuId) continue;
      const attributes = {};
      const cells = Array.from(row.querySelectorAll?.("td") || []);
      cells.forEach((cell, index) => {
        const key = headers[index];
        if (!key || /价格|单价|库存|可售|可订|进货数量/.test(key)) return;
        const value = plainText(cell.textContent, 300);
        if (value) attributes[key] = value;
      });
      const priceValue = priceColumn >= 0 ? numberFrom(plainText(cells[priceColumn]?.textContent, 120)) : null;
      const stockValue = stockColumn >= 0 ? numberFrom(plainText(cells[stockColumn]?.textContent, 120), "count") : null;
      const domSku = {
        sourceSkuId,
        propPath: null,
        attributes,
        priceCny: priceValue !== null && priceValue > 0 ? priceValue : null,
        priceSource: priceValue !== null && priceValue > 0 ? "dom.sku_table.price" : null,
        stock: stockValue !== null && stockValue >= 0 ? stockValue : null,
        stockSource: stockValue !== null && stockValue >= 0 ? "dom.sku_table.stock" : null,
        inStock: stockValue === null ? null : stockValue > 0,
        imageUrl: null,
        weight: weightFor(sourceSkuId),
        weightSource: weightSourceFor(sourceSkuId)
      };
      const existing = skuById.get(sourceSkuId);
      if (!existing) {
        skus.push(domSku);
        skuById.set(sourceSkuId, domSku);
        continue;
      }
      if ((existing.priceCny !== null && domSku.priceCny !== null && existing.priceCny !== domSku.priceCny) ||
          (existing.stock !== null && domSku.stock !== null && existing.stock !== domSku.stock) ||
          Object.entries(domSku.attributes).some(([key, value]) => existing.attributes[key] !== undefined && existing.attributes[key] !== value)) {
        return { status: "failed", failureCode: "structured_data_unavailable", offerId: actualOfferId };
      }
      existing.propPath ||= domSku.propPath;
      existing.attributes = { ...existing.attributes, ...domSku.attributes };
      if (existing.priceCny === null && domSku.priceCny !== null) {
        existing.priceCny = domSku.priceCny;
        existing.priceSource = domSku.priceSource;
      }
      if (existing.stock === null && domSku.stock !== null) {
        existing.stock = domSku.stock;
        existing.stockSource = domSku.stockSource;
      }
      if (existing.inStock === null && domSku.inStock !== null) existing.inStock = domSku.inStock;
      existing.weight ||= domSku.weight;
      existing.weightSource ||= domSku.weightSource;
    }

  const pageSelectedSkuId = limitText(first(
    skuModel?.selectedSkuId,
    skuModel?.currentSkuId,
    skuModel?.defaultSkuId,
    skuModel?.skuId,
    skuModel?.selectedSku?.skuId,
    skuModel?.currentSku?.skuId,
    tradeModel?.selectedSkuId,
    tradeModel?.defaultSkuId,
    tradeModel?.skuId,
    tradeModel?.currentSku?.skuId,
    offerBaseInfo?.skuId,
    pageData?.data?.skuId
  ), 160);
  if (!skus.length && pageSelectedSkuId) {
    const rawSku = firstObject(skuModel?.selectedSku, skuModel?.currentSku, tradeModel?.currentSku) || {};
    const price = directField(rawSku, ["price", "discountPrice", "currentPrice", "priceDisplay", "unitPrice"], true);
    const stock = directField(rawSku, ["canBookCount", "canBookedAmount", "amountOnSale", "stock", "quantity"], false, "count");
    const details = attributesForSku(rawSku);
    skus.push({
      sourceSkuId: pageSelectedSkuId,
      propPath: details.propPath,
      attributes: details.attributes,
      priceCny: price.value !== null && price.value > 0 ? price.value : null,
      priceSource: price.value !== null && price.value > 0 ? `singleSku.${price.source}` : null,
      stock: stock.value !== null && stock.value >= 0 ? stock.value : null,
      stockSource: stock.value !== null && stock.value >= 0 ? `singleSku.${stock.source}` : null,
      inStock: typeof rawSku.inStock === "boolean" ? rawSku.inStock : stock.value === null ? null : stock.value > 0,
      imageUrl: imageUrlFrom(first(rawSku?.imageUrl, rawSku?.imgUrl, rawSku?.image)),
      weight: weightFor(pageSelectedSkuId),
      weightSource: weightSourceFor(pageSelectedSkuId)
    });
  }

  if (skus.length > 200) return { status: "failed", failureCode: "sku_limit_exceeded", message: `页面包含${skus.length}个SKU，未截断`, offerId: actualOfferId };
  if (!skus.length) return { status: "failed", failureCode: "structured_data_unavailable", message: "未取得带SKU ID的规格数据", offerId: actualOfferId };

  const priceRanges = [];
  for (const [field, list] of [
    ["tradeModel.offerPriceRanges", tradeModel?.offerPriceRanges],
    ["tradeModel.currentPrices", tradeModel?.currentPrices],
    ["tradeModel.disPriceRanges", tradeModel?.disPriceRanges],
    ["tradeModel.offerPriceModel.currentPrices", tradeModel?.offerPriceModel?.currentPrices]
  ]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const priceCny = numberFrom(first(item?.price, item?.value, item?.unitPrice, item));
      const minimumQuantity = numberFrom(first(item?.beginAmount, item?.startQuantity, item?.minQuantity, item?.amount), "count");
      if (priceCny !== null && priceCny > 0) priceRanges.push({ minimumQuantity, priceCny, source: field });
    }
  }

  const rawTitleCandidates = [
    [offerBaseInfo?.subject, "offerBaseInfo.subject"],
    [offerBaseInfo?.title, "offerBaseInfo.title"],
    [offerBaseInfo?.productTitle, "offerBaseInfo.productTitle"],
    [offerDetail?.subject, "offerDetail.subject"],
    [tempModel?.offerTitle, "tempModel.offerTitle"],
    [pageData?.data?.gallery?.fields?.subject, "data.gallery.subject"],
    [root?.offerModel?.subject, "offerModel.subject"],
    [document.querySelector?.('meta[property="og:title"]')?.content, "dom.meta.og:title"],
    [document.title, "document.title"],
    [document.querySelector?.("h1")?.textContent, "dom.h1"]
  ].map(([value, source]) => [plainText(value, 800).replace(/\s*[-_|]\s*阿里巴巴.*$/i, "").trim(), source])
    .filter(([value]) => value);
  const titleChoice = rawTitleCandidates.find(([value]) => !/(?:有限责任公司|有限公司|个体工商户|经营部)$/.test(value)) || rawTitleCandidates[0] || ["", null];
  const pageProductPrice = explicitScalarField([
    ["offerBaseInfo.offerPrice", offerBaseInfo?.offerPrice],
    ["offerBaseInfo.price", offerBaseInfo?.price],
    ["tradeModel.offerPrice", tradeModel?.offerPrice],
    ["tradeModel.unitPrice", tradeModel?.unitPrice],
    ["tradeModel.currentPrice", tradeModel?.currentPrice]
  ], true);
  const pageDomesticFreight = explicitScalarField([
    ["tradeModel.freightPrice", tradeModel?.freightPrice],
    ["tradeModel.postFee", tradeModel?.postFee],
    ["tradeModel.freight", tradeModel?.freight],
    ["freightModel.freightPrice", root?.freightModel?.freightPrice],
    ["freightModel.postFee", root?.freightModel?.postFee],
    ["freightModel.price", root?.freightModel?.price]
  ]);

  return {
    status: "captured",
    evidence: {
      offerId: actualOfferId,
      sourceUrl: `https://detail.1688.com/offer/${actualOfferId}.html`,
      title: titleChoice[0],
      offerStatus: limitText(first(offerBaseInfo?.status, offerBaseInfo?.offerStatus, offerDetail?.status, tradeModel?.status), 120) || null,
      observedAt: new Date().toISOString(),
      titleSource: titleChoice[1],
      offerIdSource: structuredOfferId ? structuredOfferIdSource : "location.pathname",
      pageSelectedSkuId: pageSelectedSkuId || null,
      priceRanges,
      pageFields: {
        unitProductPriceCny: pageProductPrice.value,
        unitProductPriceSource: pageProductPrice.source,
        unitDomesticFreightCny: pageDomesticFreight.value,
        unitDomesticFreightSource: pageDomesticFreight.source
      },
      supplierAttributes,
      skus
    }
  };
}
