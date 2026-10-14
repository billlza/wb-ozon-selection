import test from "node:test";
import assert from "node:assert/strict";
import { collectOzonPage } from "../extension/1688-capture/collector-ozon.js";
import { sanitizeOzonCaptureEvidence } from "../lib/ozon-sales-capture.mjs";
import { installOzonHtmlPage } from "./helpers/ozon-page-dom.mjs";
import {
  OZON_PRICE_PAGE_LINE_THROUGH_TEXTS,
  OZON_PRICE_PAGE_PSEUDO_STRUCK_TEXTS,
  OZON_PRICE_PAGE_PRODUCT_ID,
  OZON_PRICE_PAGE_URL,
  OZON_PRICE_PAGE_WIDGETS
} from "./fixtures/ozon-price-widget-fixture.mjs";

function node(textContent, options = {}) {
  return {
    textContent,
    currentSrc: options.currentSrc || "",
    src: options.src || "",
    children: options.children || [],
    closest(selector) { return selector === "button" && options.inButton ? {} : null; },
    getAttribute(name) { return name === "src" ? options.src || "" : null; }
  };
}

function widget(textContent = "", options = {}) {
  return {
    textContent,
    children: options.children || [],
    querySelectorAll(selector) {
      if (selector === "span") return options.spans || [];
      if (selector === "img") return options.images || [];
      if (selector === "a") return options.links || [];
      return [];
    }
  };
}

function priceElement(tagName, ...children) {
  const element = { nodeType: 1, tagName, shadowRoot: null, childNodes: children.map(child => typeof child === "string" ? { nodeType: 3, textContent: child } : child),
    get children() { return this.childNodes.filter(child => child.nodeType === 1); },
    get textContent() { return this.childNodes.map(child => child.textContent).join(""); } };
  for (const child of element.childNodes) { child.parentNode = element; child.parentElement = element; }
  return element;
}

function installPage({ href = "https://www.ozon.ru/product/test-product-9999000002/", widgets = {} } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = { location: { href } };
  globalThis.document = {
    body: { innerText: "Карточка товара" },
    querySelectorAll(selector) {
      return selector === '[data-widget="webPrice"]' && widgets.webPrice ? [widgets.webPrice] : [];
    },
    querySelector(selector) {
      const match = selector.match(/^\[data-widget="(.+)"\]$/);
      if (match) return widgets[match[1]] || null;
      return selector === "h1" ? { textContent: "Музыкальная швейная машинка" } : null;
    }
  };
  globalThis.fetch = async () => { throw new Error("collector must not fetch"); };
  return () => {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
  };
}

function syntheticWidgets({ includePrice = true } = {}) {
  const attributeRows = [
    node("", { children: [node("Тип"), node("Музыкальная шкатулка")] }),
    node("", { children: [node("Материал"), node("Пластик")] }),
    node("", { children: [node("Страна-изготовитель"), node("Китай")] })
  ];
  return {
    webProductHeading: widget("Музыкальная шарманка швейная машинка"),
    webPrice: priceElement("DIV", ...(includePrice ? [
      priceElement("BUTTON", priceElement("SPAN", "1 316 ₽"), " с картой Ozon"),
      priceElement("DIV", priceElement("SPAN", "1 462 ₽"), " без карты Ozon"),
      priceElement("S", priceElement("SPAN", "2 548 ₽"))
    ] : [])),
    webGallery: widget("", {
      images: [
        node("", { src: "https://ir.ozone.ru/s3/multimedia/wc50/main.jpg" }),
        node("", { src: "https://ir.ozone.ru/s3/multimedia/wc1000/main.jpg" }),
        node("", { src: "https://ir.ozone.ru/s3/multimedia/wc1000/two.jpg" })
      ]
    }),
    webShortCharacteristics: widget("", { children: [node(""), node("", { children: attributeRows })] }),
    breadCrumbs: widget("", { links: [node("Дом и сад"), node("Шкатулки")] })
  };
}

test("Ozon collector reads already-loaded widgets without network requests or defaults", async () => {
  const restore = installPage({ widgets: syntheticWidgets() });
  try {
    const result = await collectOzonPage("9999000002");
    assert.equal(result.status, "captured");
    assert.equal(result.evidence.productId, "9999000002");
    assert.equal(result.evidence.currentPrice, 1462, "普通买家价格不能被银行卡专享价替代");
    assert.equal(result.evidence.currency, "RUB");
    assert.equal(result.evidence.attributes["Тип"], "Музыкальная шкатулка");
    assert.equal(result.evidence.attributes["Материал"], "Пластик");
    assert.equal(result.evidence.attributes["Ozon bank price"], "1316 RUB");
    assert.deepEqual(result.evidence.imageRefs, [
      "https://ir.ozone.ru/s3/multimedia/wc1000/main.jpg",
      "https://ir.ozone.ru/s3/multimedia/wc1000/two.jpg"
    ]);
    assert.equal(result.evidence.source, "ozon_loaded_page_widgets");

    const snapshot = sanitizeOzonCaptureEvidence(result.evidence, "9999000002", {
      captureId: "OSC-test",
      snapshotId: "sales-snapshot:ozon:test"
    });
    assert.equal(snapshot.sellerType, "unknown");
    assert.equal(snapshot.currentPrice, 1462);
    assert.equal(snapshot.collectorMode, "real_page_read_only");
  } finally {
    restore();
  }
});

test("Ozon collector rejects another product before reading widgets", async () => {
  const restore = installPage({ widgets: syntheticWidgets() });
  try {
    const result = await collectOzonPage("9999000003");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "wrong_product");
  } finally {
    restore();
  }
});

test("Ozon collector stops when loaded price widget has no ordinary buyer price", async () => {
  const restore = installPage({ widgets: syntheticWidgets({ includePrice: false }) });
  try {
    const result = await collectOzonPage("9999000002");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "precise_price_missing");
  } finally {
    restore();
  }
});

function syntheticPricePage({ lineThroughTexts = OZON_PRICE_PAGE_LINE_THROUGH_TEXTS,
  pseudoStruckTexts = OZON_PRICE_PAGE_PSEUDO_STRUCK_TEXTS } = {}) {
  return installOzonHtmlPage({
    href: OZON_PRICE_PAGE_URL,
    widgets: OZON_PRICE_PAGE_WIDGETS,
    lineThroughTexts,
    pseudoStruckTexts
  });
}

test("Ozon collector reads the ordinary bank price out of a synthetic three-price card", async () => {
  const restore = syntheticPricePage();
  try {
    const result = await collectOzonPage(OZON_PRICE_PAGE_PRODUCT_ID);
    assert.equal(result.status, "captured", result.message);
    assert.equal(result.evidence.currentPrice, 2112, "多价并存时取С другими банками的普通银行卡价");
    assert.equal(result.evidence.currency, "RUB");
    assert.equal(result.evidence.title, "Синтетический товар для проверки цены SYNTHETIC-XL");
    assert.equal(result.evidence.categoryPath, "Синтетическая категория A > Синтетическая категория B > Синтетическая категория C");
    assert.equal(result.evidence.attributes["Ozon bank price"], "1777 RUB", "联名卡价只作为附加属性留档");
    assert.equal(result.evidence.attributes["Размер одежды/аксессуара для животных"], "SYNTHETIC-XL");

    // 服务端脱敏不需要改：同一形状的证据照旧收得下。
    const snapshot = sanitizeOzonCaptureEvidence(result.evidence, OZON_PRICE_PAGE_PRODUCT_ID, {
      captureId: "OSC-synthetic-price",
      snapshotId: "sales-snapshot:ozon:synthetic-price"
    });
    assert.equal(snapshot.currentPrice, 2112);
    assert.equal(snapshot.currency, "RUB");
    assert.equal(snapshot.collectorMode, "real_page_read_only");
  } finally {
    restore();
  }
});

test("Ozon collector never sells from the co-branded, crossed-out or points price", async () => {
  const restore = syntheticPricePage();
  try {
    const result = await collectOzonPage(OZON_PRICE_PAGE_PRODUCT_ID);
    assert.equal(result.status, "captured", result.message);
    assert.notEqual(result.evidence.currentPrice, 1777, "1 777 ₽ 是С банками联名卡价");
    assert.notEqual(result.evidence.currentPrice, 5634, "5 634 ₽ 是划线原价");
    assert.notEqual(result.evidence.currentPrice, 3, "webPricePerStars的Купить за 3 ₽是积分促销，不在价格组件里");
    assert.equal(JSON.stringify(result.evidence).includes("5634"), false, "划线原价不进入任何证据字段");
  } finally {
    restore();
  }
});

test("Ozon collector stops instead of guessing when the crossed-out price cannot be told apart", async () => {
  // 同一份合成页面，这次没有删除线证据：三个数并存又分不出哪个是当前价。
  const restore = syntheticPricePage({ lineThroughTexts: [], pseudoStruckTexts: [] });
  try {
    const result = await collectOzonPage(OZON_PRICE_PAGE_PRODUCT_ID);
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "precise_price_missing");
    assert.match(result.message, /没有唯一的普通买家当前价格/);
    for (const amount of ["2 112 ₽", "5 634 ₽", "1 777 ₽"]) {
      assert.equal(result.message.includes(amount), true, `失败说明要写清看到了${amount}`);
    }
    assert.equal(result.evidence, undefined, "分不出来就不能凑一个最小或最大值");
  } finally {
    restore();
  }
});

test("Ozon collector keeps using a single unlabelled current price", async () => {
  const restore = installPage({
    widgets: { ...syntheticWidgets(), webPrice: priceElement("DIV", priceElement("SPAN", "1 299 ₽")) }
  });
  try {
    const result = await collectOzonPage("9999000002");
    assert.equal(result.status, "captured", result.message);
    assert.equal(result.evidence.currentPrice, 1299);
    assert.equal(result.evidence.attributes["Ozon bank price"], undefined);
  } finally {
    restore();
  }
});

test("Ozon collector stops when several unlabelled prices sit side by side", async () => {
  const restore = installPage({
    widgets: {
      ...syntheticWidgets(),
      webPrice: priceElement("DIV", priceElement("SPAN", "1 299 ₽"), priceElement("SPAN", "1 490 ₽"))
    }
  });
  try {
    const result = await collectOzonPage("9999000002");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "precise_price_missing");
    assert.match(result.message, /没有唯一的普通买家当前价格/);
  } finally {
    restore();
  }
});

test("Ozon collector stops when unknown wording sits next to the only current price", async () => {
  const restore = installPage({
    widgets: {
      ...syntheticWidgets(),
      webPrice: priceElement("DIV",
        priceElement("DIV", priceElement("SPAN", "1 777 ₽"), " с картой Ozon"),
        priceElement("DIV", priceElement("SPAN", "2 112 ₽"), " со скидкой по промокоду"))
    }
  });
  try {
    const result = await collectOzonPage("9999000002");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "precise_price_missing");
  } finally {
    restore();
  }
});
