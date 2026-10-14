export async function collectOzonPage(expectedProductId) {
  const observedAt = new Date().toISOString();
  const fail = (failureCode, message) => ({ status: "failed", failureCode, message, observedAt });
  const cleanText = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const productIdFromUrl = (value) => {
    try {
      if (typeof value !== "string") return "";
      const url = new URL(value);
      if (url.protocol !== "https:" || !["ozon.ru", "www.ozon.ru"].includes(url.hostname) || url.username || url.password || url.port) return "";
      return url.pathname.match(/^\/product\/(?:[^/]*-)?(\d{7,})\/?$/i)?.[1] || "";
    } catch {
      return "";
    }
  };
  const currentProductId = productIdFromUrl(window.location.href);
  if (!currentProductId || currentProductId !== String(expectedProductId)) {
    return fail("wrong_product", "当前Ozon页面与评审台商品ID不一致");
  }

  // DOM remains website-controlled evidence even in ISOLATED; no claim of authenticity.
  if (document.querySelector?.('[id="captcha"], [data-widget="captcha"], iframe[src*="captcha"]')) {
    return fail("site_verification_required", "Ozon页面要求人工完成验证");
  }
  if (document.querySelector?.('form[action*="login"] input[type="password"], [data-widget="loginForm"]')) return fail("site_login_required", "Ozon页面要求先登录");

  const widget = (name) => document.querySelector?.(`[data-widget="${name}"]`) || null;
  // An Ozon product page loads in the background tab this capture opens, and Chrome throttles that tab: waiting for the
  // whole page to report complete timed out at 25s on the owner's own machine (2026-09-14), the same way the 1688 page
  // did. So the capture now starts as soon as the product document has committed and the collector waits here instead,
  // for the two components it actually needs. A page that never renders them stops on its own deadline and says so.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const blocked = () => document.querySelector?.('[id="captcha"], [data-widget="captcha"], iframe[src*="captcha"]') ||
    document.querySelector?.('form[action*="login"] input[type="password"], [data-widget="loginForm"]');
  const renderDeadline = Date.now() + 20000;
  while (Date.now() < renderDeadline && !blocked() && !(widget("webProductHeading") && widget("webPrice"))) {
    await sleep(250);
  }
  if (document.querySelector?.('[id="captcha"], [data-widget="captcha"], iframe[src*="captcha"]')) {
    return fail("site_verification_required", "Ozon页面要求人工完成验证");
  }
  if (document.querySelector?.('form[action*="login"] input[type="password"], [data-widget="loginForm"]')) {
    return fail("site_login_required", "Ozon页面要求先登录");
  }
  const headingWidget = widget("webProductHeading");
  const priceWidget = widget("webPrice");
  const galleryWidget = widget("webGallery");
  const aspectsWidget = widget("webShortCharacteristics") || widget("webCharacteristics") || widget("webAspects");
  const breadcrumbsWidget = widget("breadCrumbs") || widget("webBreadCrumbs");
  const title = cleanText(headingWidget?.textContent || document.querySelector?.("h1")?.textContent);
  if (!title) return fail("structured_data_unavailable", "Ozon已加载页面中没有商品标题组件");

  const parsePrice = (value) => {
    let normalized = cleanText(value).replace(/\s*(?:₽|руб\.?|RUB)$/i, "");
    if (/^\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?$/.test(normalized)) normalized = normalized.replace(/ /g, "").replace(",", ".");
    // RUB uses a decimal comma. A lone comma plus three digits (3,999) is
    // ambiguous, so only unambiguous multi-groups or explicit decimal-dot
    // grouping are accepted; never silently turn that lone comma into 3999.
    else if (/^\d{1,3}(?:(?:,\d{3}){2,}|(?:,\d{3})+\.\d{1,2})$/.test(normalized)) normalized = normalized.replace(/,/g, "");
    else if (/^\d+,\d{1,2}$/.test(normalized)) normalized = normalized.replace(",", ".");
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
  };
  const currencyFrom = (value) => {
    const text = cleanText(value);
    if (/(?:₽|руб\.?|RUB)$/i.test(text)) return "RUB";
    return "";
  };
  // The sole webPrice component is the boundary, not document.body or a nearby
  // product/recommendation block. Multiple components cannot be disambiguated.
  const priceWidgets = document.querySelectorAll?.('[data-widget="webPrice"]');
  if (priceWidgets?.length !== 1 || priceWidgets[0] !== priceWidget) return fail("precise_price_missing", "Ozon价格组件边界不明确");
  const maxPriceNodes = 512;
  const maxPriceDepth = 16;
  const maxPriceText = 16000;
  const priceElements = [];
  const priceTexts = [];
  const visited = new Set();
  const pending = [{ node: priceWidget, depth: 0 }];
  const allowedPriceTags = new Set(["DIV", "SPAN", "P", "SECTION", "BUTTON", "S", "DEL", "SMALL", "STRONG", "B", "EM", "I", "A", "IMG"]);
  // Payment-method icons sit next to the prices. An SVG root keeps its lower-case
  // tagName in an HTML document, so it is recognised without trusting attributes,
  // read as opaque, and required to display no text: a price or a purchase
  // condition can never hide inside one.
  const isIconRoot = (node) => typeof node.tagName === "string" && node.tagName.toLowerCase() === "svg";
  let textLength = 0;
  // Traverse childNodes (including direct sibling/ancestor text), not an
  // unbounded querySelectorAll followed by a sliced sample. No partial scans.
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (!node || visited.has(node) || visited.size >= maxPriceNodes || depth > maxPriceDepth) return fail("precise_price_missing", "Ozon价格组件结构或读取预算不明确");
    visited.add(node);
    if (node.nodeType === 3) {
      if (typeof node.textContent !== "string") return fail("precise_price_missing", "Ozon价格组件文字无效");
      textLength += node.textContent.length;
      if (textLength > maxPriceText) return fail("precise_price_missing", "Ozon价格组件超出文字预算");
      priceTexts.push(node);
      continue;
    }
    if (node.nodeType === 8) continue; // Comments are not displayed price conditions.
    if (node.nodeType !== 1 || node.shadowRoot || !node.childNodes) return fail("precise_price_missing", "Ozon价格组件含未支持结构");
    if (isIconRoot(node)) {
      if (cleanText(node.textContent)) return fail("precise_price_missing", "Ozon价格组件图标里有文字");
      continue;
    }
    if (!allowedPriceTags.has(node.tagName)) return fail("precise_price_missing", "Ozon价格组件含未支持结构");
    priceElements.push(node);
    if (node.childNodes.length + pending.length + visited.size > maxPriceNodes) return fail("precise_price_missing", "Ozon价格组件超出节点预算");
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const child = node.childNodes[index];
      if (child?.parentNode !== node || child?.parentElement !== node) return fail("precise_price_missing", "Ozon价格组件父链不一致");
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  const hasPriceAncestor = (node, predicate) => {
    for (let current = node; current && visited.has(current); current = current.parentElement) if (predicate(current)) return true;
    return false;
  };
  const priceSpans = priceElements.filter((node) => node !== priceWidget && visited.has(node.parentElement) && node.tagName === "SPAN" && node.children.length === 0 && currencyFrom(node.textContent));
  // A crossed-out former price is read the way it is displayed, never inferred
  // from being the largest amount: either the <s>/<del> markup, or the rendered
  // text decoration. In an ISOLATED world getComputedStyle is this world's own
  // function, so the page cannot redefine what "crossed out" means. When no
  // decoration can be read at all, nothing is assumed to be crossed out, and a
  // component that then shows several current prices stops below.
  let decorationReadable = true;
  const declaresLineThrough = (node) => {
    let style = null;
    try {
      const view = node?.ownerDocument?.defaultView || (typeof window === "object" ? window : null);
      if (typeof view?.getComputedStyle === "function") style = view.getComputedStyle(node);
    } catch { style = null; }
    const declarations = [style?.textDecorationLine, style?.webkitTextDecorationLine, style?.textDecoration]
      .filter((value) => typeof value === "string" && value);
    if (!declarations.length) { decorationReadable = false; return false; }
    return declarations.some((value) => value.toLowerCase().includes("line-through"));
  };
  // Ozon does not strike its former price with text-decoration: measured on the live page 2026-09-14, the 5 172 ₽ span
  // reports decoration "none" and paints the line with an ::after box — content "", the text's own colour as
  // background, height 0.99px, width 43.25px, absolutely positioned over the middle of the line. A generated box that
  // is painted, thin and wide is a line drawn across the text, and nothing else looks like that; reading it costs one
  // more computed style per price node. Missing it is what let the former price be read as a current one.
  const STRIKE_MAX_THICKNESS_PX = 3;
  const STRIKE_MIN_LENGTH_PX = 6;
  const transparent = (value) => typeof value !== "string" || value === "" ||
    /^(?:transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(value.trim());
  const pixels = (value) => {
    const parsed = typeof value === "string" ? Number.parseFloat(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const drawsStrikeLine = (node) => {
    const view = node?.ownerDocument?.defaultView || (typeof window === "object" ? window : null);
    if (typeof view?.getComputedStyle !== "function") return false;
    for (const pseudo of ["::after", "::before"]) {
      let style = null;
      try { style = view.getComputedStyle(node, pseudo); } catch { style = null; }
      if (!style) continue;
      const content = typeof style.content === "string" ? style.content.trim().toLowerCase() : "";
      if (!content || content === "none" || content === "normal") continue;
      const thickness = pixels(style.height);
      const length = pixels(style.width);
      if (thickness === null || length === null) continue;
      if (thickness <= 0 || thickness > STRIKE_MAX_THICKNESS_PX || length < STRIKE_MIN_LENGTH_PX) continue;
      if (!transparent(style.backgroundColor)) return true;
    }
    return false;
  };
  const isCrossedOut = (node) => hasPriceAncestor(node, (ancestor) =>
    ancestor.tagName === "S" || ancestor.tagName === "DEL" || declaresLineThrough(ancestor) || drawsStrikeLine(ancestor));

  // Purchase conditions are matched as whole word runs over the collapsed text,
  // so ordinary spaces, non-breaking and thin spaces read the same, and
  // "с банками" can never match inside "с другими банками".
  const conditionTokens = (value) => cleanText(value).toLowerCase().split(" ").filter(Boolean);
  const tokensContain = (tokens, phrase) => {
    const needle = phrase.split(" ");
    for (let start = 0; start + needle.length <= tokens.length; start += 1) {
      let matched = true;
      for (let index = 0; index < needle.length && matched; index += 1) matched = tokens[start + index] === needle[index];
      if (matched) return true;
    }
    return false;
  };
  // The price most buyers actually pay: the current card writes it
  // "С другими банками", the older one "без карты Ozon".
  const ordinaryLabels = ["с другими банками", "без карты ozon", "без ozon карты"];
  // Co-branded / partner-bank price. Recorded as an attribute, never sold from.
  const bankLabels = ["с банками", "с картой ozon", "с ozon картой"];
  const labelKind = (element) => {
    const tokens = conditionTokens(element.textContent);
    const ordinary = ordinaryLabels.some((phrase) => tokensContain(tokens, phrase));
    const bank = bankLabels.some((phrase) => tokensContain(tokens, phrase));
    if (ordinary && bank) return "mixed";
    if (ordinary) return "ordinary";
    if (bank) return "bank";
    return "";
  };
  // The nearest labelled ancestor owns this price. Stopping at the first one is
  // what keeps the two amounts apart when one component shows both conditions.
  const labelledGroup = (node) => {
    for (let current = node; current && visited.has(current); current = current.parentElement) {
      const kind = labelKind(current);
      if (kind) return { kind, element: current };
    }
    return { kind: "", element: null };
  };
  const readings = priceSpans.map((node) => ({
    node,
    value: parsePrice(node.textContent),
    crossedOut: isCrossedOut(node),
    ...labelledGroup(node)
  }));
  const describeReading = (reading) => {
    const kindText = { ordinary: "普通价", bank: "银行卡价", mixed: "标签冲突" }[reading.kind] || "无标签";
    return `${cleanText(reading.node.textContent)}(${kindText}${reading.crossedOut ? "·划线" : ""})`;
  };
  const seen = () => `${readings.slice(0, 12).map(describeReading).join("、") || "没有金额"}${decorationReadable ? "" : "；删除线样式读不到"}`;
  if (readings.some((reading) => reading.kind === "mixed" && !reading.crossedOut)) {
    return fail("precise_price_missing", `Ozon价格组件同一处标签同时写着银行卡价和普通价：${seen()}`);
  }
  // A recognised label must account for every word beside its prices. Any extra
  // wording (starting price, installments, quantity or coupon conditions) leaves
  // tokens over and stops here instead of being read as an ordinary sale price.
  const tokenBag = (tokens) => {
    const bag = new Map();
    for (const token of tokens) bag.set(token, (bag.get(token) || 0) + 1);
    return bag;
  };
  const groupFullyUnderstood = (element) => {
    const tokens = conditionTokens(element.textContent);
    const expected = [];
    for (const node of priceSpans) if (hasPriceAncestor(node, (ancestor) => ancestor === element)) expected.push(...conditionTokens(node.textContent));
    for (const phrase of [...ordinaryLabels, ...bankLabels]) if (tokensContain(tokens, phrase)) expected.push(...phrase.split(" "));
    const left = tokenBag(expected);
    const right = tokenBag(tokens);
    return left.size === right.size && [...left].every(([token, count]) => right.get(token) === count);
  };
  for (const reading of readings) {
    if (reading.element && !groupFullyUnderstood(reading.element)) {
      return fail("precise_price_missing", `Ozon价格组件里价格旁边还有没读懂的条件文字：${seen()}`);
    }
  }
  const ordinaryPrices = readings.filter((reading) => reading.kind === "ordinary" && !reading.crossedOut);
  // Prefer the labelled ordinary price. Only a card that shows no ordinary label
  // anywhere falls back to a single unlabelled current price, which is the older
  // single-price shape. A component that shows nothing but a bank-conditioned
  // price has no ordinary price and stops.
  const saleReadings = readings.some((reading) => reading.kind === "ordinary")
    ? ordinaryPrices
    : readings.filter((reading) => !reading.kind && !reading.crossedOut);
  const values = saleReadings.map((reading) => reading.value);
  const distinctValues = new Set(values);
  if (!saleReadings.length || values.includes(null) || distinctValues.size !== 1) {
    return fail("precise_price_missing", `Ozon已加载价格组件中没有唯一的普通买家当前价格：${seen()}`);
  }
  const currentPrice = values[0];
  const currency = "RUB";
  const bankNodes = readings.filter((reading) => reading.kind === "bank" && !reading.crossedOut && reading.value !== null);
  const understoodLabels = new Set();
  for (const reading of readings) {
    if (reading.element) understoodLabels.add(reading.element);
    else if (reading.value !== null) understoodLabels.add(reading.node);
  }
  // Every displayed text fragment in this bounded component must belong to a
  // complete understood price label. Thus any outer/sibling quantity, coupon,
  // installment or unknown condition fails closed, regardless of its wording.
  // Text outside this component is never consulted or allowed to alter price.
  if (priceTexts.some((node) => cleanText(node.textContent) && !hasPriceAncestor(node, (ancestor) => understoodLabels.has(ancestor)))) return fail("precise_price_missing", "Ozon价格组件存在未确认条件或文字");
  const bankValues = new Set(bankNodes.map((reading) => reading.value));
  const bankPrice = bankValues.size === 1 ? [...bankValues][0] : null;

  const imageByKey = new Map();
  // /wcN/ denotes a width variant on the observed Ozon CDN, not a product ID.
  const imageScore = (value) => Number(value.match(/\/wc(\d+)\//i)?.[1] || 0);
  for (const image of Array.from(galleryWidget?.querySelectorAll?.("img") || [])) {
    const rawSrc = cleanText(image?.currentSrc || image?.src || image?.getAttribute?.("src"));
    let url;
    try { url = new URL(rawSrc); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "ir.ozone.ru" || url.username || url.password || url.port) continue;
    const src = `${url.origin}${url.pathname}`;
    const key = url.pathname.replace(/\/wc\d+\//i, "/");
    const previous = imageByKey.get(key);
    if (!previous || imageScore(src) > imageScore(previous)) imageByKey.set(key, src);
  }
  const imageRefs = [...imageByKey.values()].slice(0, 40);

  const attributes = {};
  const directRows = Array.from(aspectsWidget?.children || []).flatMap((container) => Array.from(container?.children || []));
  for (const row of directRows) {
    const parts = Array.from(row?.children || []);
    if (parts.length < 2) continue;
    const name = cleanText(parts[0]?.textContent);
    const value = cleanText(parts[1]?.textContent);
    if (!name || !value || name === value || name.length > 160 || value.length > 1000) continue;
    if (/^(о товаре|характеристики)$/i.test(name) || /перейти к описанию/i.test(value)) continue;
    attributes[name] = value;
    if (Object.keys(attributes).length >= 120) break;
  }
  if (bankPrice) attributes["Ozon bank price"] = `${bankPrice} ${currency}`;

  const categoryPath = Array.from(breadcrumbsWidget?.querySelectorAll?.("a") || [])
    .map((node) => cleanText(node?.textContent))
    .filter(Boolean)
    .join(" > ") || "unknown";

  return {
    status: "captured",
    evidence: {
      productId: currentProductId,
      productUrl: `https://www.ozon.ru/product/${currentProductId}/`,
      title,
      imageRefs,
      currentPrice,
      currency,
      categoryPath,
      attributes,
      // No supported seller identity source is implemented. Country of manufacture
      // and product text cannot establish seller country; retain unknown downstream.
      sellerIdentitySignals: [],
      marketScope: "ozon_general_market",
      observedAt,
      source: "ozon_loaded_page_widgets"
    }
  };
}
