import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect1688Page } from "../extension/1688-capture/collector.js";
import {
  classify1688TimeoutOutcome,
  classify1688NavigationOutcome,
  classify1688Source,
  isAllowed1688NavigationHost,
  observed1688TabAddress,
  shouldWaitFor1688Destination,
  validateResolved1688Source
} from "../extension/1688-capture/source-routing.js";
import {
  normalize1688CaptureSource,
  extract1688OfferId,
  resolveCapturedSku,
  resolveCapturedSkus,
  sanitize1688Evidence,
  sanitizeSourceCaptureFailureDiagnostics,
  sanitizeSourceCaptureFailureResult,
  sourceCaptureFailureDestinationLabel
} from "../lib/source-capture.mjs";
import { toggleLocalSupplierSkuSelection } from "../src/aSupplierCaptureSelection.js";
import { harness, idle, message, startCapture, supplierJob, SUPPLIER_URL, PING, START } from "./helpers/extension-runtime-fixture.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A real querySelectorAll("script") returns typed scripts too, so the fixture answers the broad selector and
// lets the collector read each node's own type attribute, exactly as it must on the page.
function fakeDocument(json = null) {
  return {
    title: "机械发条木质火车",
    body: { innerText: "商品详情" },
    querySelector(selector) {
      return selector === "h1" ? { textContent: "机械发条木质火车" } : null;
    },
    querySelectorAll(selector) {
      if (selector === "script" && json) {
        return [{ textContent: JSON.stringify(json), getAttribute: (name) => (name === "type" ? "application/json" : null) }];
      }
      return [];
    }
  };
}

test("1688 collector keeps direct SKU prices and leaves missing stock or price null", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    location: { href: "https://detail.1688.com/offer/712421624571.html", pathname: "/offer/712421624571.html" },
    context: {
      result: {
        global: {
          globalData: {
            model: {
              offerBaseInfo: { offerId: "712421624571", subject: "瑞安市初刻工艺品有限公司" },
              tradeModel: {
                freightPrice: 6,
                offerPriceRanges: [{ beginAmount: 2, price: 12 }],
                skuMap: [
                  { skuId: "sku-320", specAttrs: "片数:320片" },
                  { skuId: "sku-100", specAttrs: "片数:100片", canBookCount: 9 }
                ]
              },
              skuModel: {
                skuProps: [],
                skuInfoMap: {
                  "sku-320": { skuId: "sku-320", price: 41 },
                  "sku-100": { skuId: "sku-100", price: 35 }
                }
              },
              offerAttributeModel: { offerAttrs: [{ name: "材质", value: "木质" }] }
            }
          }
        }
      }
    }
  };
  globalThis.document = fakeDocument(globalThis.window.context);
  delete globalThis.window.context;
  try {
    const result = await collect1688Page("712421624571");
    assert.equal(result.status, "captured");
    assert.equal(result.evidence.title, "机械发条木质火车");
    assert.equal(result.evidence.skus.length, 2);
    assert.equal(result.evidence.skus[0].priceCny, 41);
    assert.equal(result.evidence.skus[0].stock, null);
    assert.equal(result.evidence.skus[1].priceCny, 35);
    assert.equal(result.evidence.skus[1].stock, 9);
    assert.equal(result.evidence.priceRanges[0].priceCny, 12);
    assert.equal(result.evidence.pageFields.unitProductPriceCny, null);
    assert.equal(result.evidence.pageFields.unitDomesticFreightCny, 6);
    assert.equal(result.evidence.pageFields.unitDomesticFreightSource, "tradeModel.freightPrice");

    const evidence = sanitize1688Evidence(result.evidence, "712421624571");
    assert.equal(evidence.pageFields.unitProductPriceCny, null);
    assert.equal(evidence.pageFields.unitDomesticFreightCny, 6);
    const resolved = resolveCapturedSku({
      productName: "机械发条木质火车320片3D拼图",
      codexReview: { sourceSku: { sku: "机械发条木质火车320片3D拼图" } }
    }, evidence);
    assert.equal(resolved.status, "matched");
    assert.equal(resolved.selected.sourceSkuId, "sku-320");
    assert.equal(resolved.selected.stock, null);

    const multi = resolveCapturedSkus(evidence, ["sku-320", "sku-100"]);
    assert.equal(multi.status, "matched");
    assert.deepEqual(multi.selected.map((sku) => sku.sourceSkuId), ["sku-320", "sku-100"]);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("A supplier routing accepts only exact detail links or the narrow qr short-link allowlist", () => {
  assert.deepEqual(normalize1688CaptureSource("https://qr.1688.com/s/7OnLCakq?ignored=1"), {
    type: "short",
    sourceUrl: "https://qr.1688.com/s/7OnLCakq",
    offerId: ""
  });
  assert.deepEqual(classify1688Source("https://qr.1688.com/s/7OnLCakq"), {
    type: "short",
    sourceUrl: "https://qr.1688.com/s/7OnLCakq",
    offerId: ""
  });
  assert.deepEqual(validateResolved1688Source(
    "https://qr.1688.com/s/7OnLCakq",
    "https://detail.1688.com/offer/876240928352.html?from=qr"
  ), {
    offerId: "876240928352",
    sourceUrl: "https://detail.1688.com/offer/876240928352.html"
  });
  assert.equal(validateResolved1688Source("https://qr.1688.com/s/7OnLCakq", "https://example.com/offer/876240928352.html"), null);
  assert.equal(isAllowed1688NavigationHost("https://qr.1688.com/s/7OnLCakq"), true);
  assert.equal(isAllowed1688NavigationHost("https://detail.1688.com/offer/876240928352.html"), true);
  assert.equal(isAllowed1688NavigationHost("https://m.1688.com/offer/876240928352.html"), false);
  assert.equal(isAllowed1688NavigationHost("https://example.com/offer/876240928352.html"), false);
  assert.equal(validateResolved1688Source(
    "https://detail.1688.com/offer/712421624571.html",
    "https://detail.1688.com/offer/876240928352.html",
    "712421624571"
  ), null);
  assert.equal(normalize1688CaptureSource("https://qr.1688.com/other/7OnLCakq").type, "invalid");
});

test("offer identity rejects untrusted URL text and recognizes mobile only for capture-required gates", () => {
  for (const url of ["evil.example.com/offer/712421624571.html", "/offer/712421624571.html", "https://evil.example.com/offer/712421624571.html", "https://detail.1688.com.evil.test/offer/712421624571.html", "http://detail.1688.com/offer/712421624571.html", "https://user:pass@detail.1688.com/offer/712421624571.html", "https://detail.1688.com:8080/offer/712421624571.html"]) {
    assert.equal(extract1688OfferId(url), "", url);
    assert.equal(normalize1688CaptureSource(url).type, "invalid", url);
  }
  assert.equal(extract1688OfferId("https://m.1688.com/offer/123.html"), "123");
  assert.equal(normalize1688CaptureSource("https://m.1688.com/offer/123.html").type, "invalid");
});

function syntheticCapture(overrides = {}) {
  return { offerId: "712421624571", sourceUrl: "https://detail.1688.com/offer/712421624571.html", observedAt: "2026-09-03T00:00:00.000Z", title: "Synthetic product", skus: [{ sourceSkuId: "sku-five", attributes: { size: "5cm" }, priceCny: 20, priceSource: "fixture.price", stock: 1000, stockSource: "fixture.stock" }], ...overrides };
}

test("capture sanitizer never converts a fabricated offer or URL into an authoritative detail URL", () => {
  for (const sourceUrl of [undefined, "evil.test/offer/712421624571.html", "https://evil.test/offer/712421624571.html", "https://m.1688.com/offer/712421624571.html", "https://detail.1688.com/offer/123.html"])
    assert.throws(() => sanitize1688Evidence(syntheticCapture({ sourceUrl }), "712421624571"), /wrong_offer/);
  for (const offerId of ["123?x", " 712421624571", {}, 712421624571])
    assert.throws(() => sanitize1688Evidence(syntheticCapture({ offerId }), offerId), /wrong_offer/);
});

test("capture prices require exact scalar decimals, stock requires nonnegative integer", () => {
  for (const value of [true, false, [], [1], {}, "1,234.56", "12.50-15.00", "库存1000件", "1e3", "9007199254740993", Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    const evidence = syntheticCapture();
    evidence.skus[0].priceCny = value;
    evidence.skus[0].stock = value;
    const sanitized = sanitize1688Evidence(evidence, evidence.offerId);
    assert.equal(sanitized.skus[0].priceCny, null);
    assert.equal(sanitized.skus[0].stock, null);
    assert.equal(resolveCapturedSku({}, sanitized, "sku-five").status, "exact_price_unavailable");
  }
  const evidence = syntheticCapture();
  evidence.skus[0].stock = 1.5;
  assert.equal(sanitize1688Evidence(evidence, evidence.offerId).skus[0].stock, null);
});

// 每个规格自己的重量是它自己运费的唯一依据，所以它必须活着穿过脱敏边界，而不是在这里被丢掉。
test("每个规格的发货重量按公斤保留下来，并带上页面里的来源", () => {
  const evidence = syntheticCapture();
  evidence.skus[0].weight = { value: 0.103, unit: "kg" };
  evidence.skus[0].weightSource = "detailDescription.freightInfo.skuWeight";
  const sanitized = sanitize1688Evidence(evidence, evidence.offerId);
  assert.deepEqual(sanitized.skus[0].weight, { value: 0.103, unit: "kg" });
  assert.equal(sanitized.skus[0].weightSource, "detailDescription.freightInfo.skuWeight");
  // A bare number of kilograms is the same fact, normalized to the same shape. So is an exact scalar decimal in a
  // string, which is exactly what the capture boundary already accepts for a price and for a stock count.
  for (const raw of [0.24, "0.24", { value: "0.24", unit: "kg" }, { value: 0.24, unit: "KG" }]) {
    const bare = syntheticCapture();
    bare.skus[0].weight = raw;
    bare.skus[0].weightSource = "freightModel.skuWeight";
    assert.deepEqual(sanitize1688Evidence(bare, bare.offerId).skus[0].weight, { value: 0.24, unit: "kg" }, JSON.stringify(raw));
  }
});

test("不合法的规格重量只被丢掉，不报错、不四舍五入、也不改写其他事实", () => {
  for (const [weight, weightSource] of [
    [{ value: 103, unit: "g" }, "page.grams"],
    [{ value: 0, unit: "kg" }, "page.zero"],
    [{ value: -1, unit: "kg" }, "page.negative"],
    [{ value: 1001, unit: "kg" }, "page.absurd"],
    [{ value: 0.103 }, "page.unitless"],
    [{ value: "0.1公斤", unit: "kg" }, "page.text"],
    [{ value: "0.10-0.15", unit: "kg" }, "page.range"],
    [{ value: Infinity, unit: "kg" }, "page.infinite"],
    [[0.103], "page.array"],
    [true, "page.boolean"],
    ["1e-1", "page.exponent"],
    // A weight the page never told us where it came from is not evidence either.
    [{ value: 0.103, unit: "kg" }, ""],
    [{ value: 0.103, unit: "kg" }, undefined]
  ]) {
    const evidence = syntheticCapture();
    evidence.skus[0].weight = weight;
    evidence.skus[0].weightSource = weightSource;
    const sanitized = sanitize1688Evidence(evidence, evidence.offerId);
    assert.equal(sanitized.skus[0].weight, null, JSON.stringify(weight));
    assert.equal(sanitized.skus[0].weightSource, null, JSON.stringify(weight));
    // The specification is still a specification: its price and stock are untouched.
    assert.equal(sanitized.skus[0].priceCny, 20);
    assert.equal(sanitized.skus[0].stock, 1000);
  }
  // No weight at all is the normal case for a page that never declares one.
  const plain = sanitize1688Evidence(syntheticCapture(), "712421624571");
  assert.equal(plain.skus[0].weight, null);
  assert.equal(plain.skus[0].weightSource, null);
});

test("采到的重量能直接接上供货方案的重量字段", async () => {
  const { adapt1688CaptureToSupplierOption } = await import("../lib/supplier-option.mjs");
  const evidence = syntheticCapture();
  evidence.skus[0].weight = { value: 0.103, unit: "kg" };
  evidence.skus[0].weightSource = "detailDescription.freightInfo.skuWeight";
  const option = adapt1688CaptureToSupplierOption(sanitize1688Evidence(evidence, evidence.offerId),
    { evidenceRef: "source-capture:SCJ-synthetic" });
  assert.deepEqual(option.supplierSkus[0].weight, { value: 0.103, unit: "kg" });
  // A specification without a declared weight stays explicitly unknown; nothing is filled in for it.
  const missing = adapt1688CaptureToSupplierOption(sanitize1688Evidence(syntheticCapture(), "712421624571"),
    { evidenceRef: "source-capture:SCJ-synthetic" });
  assert.equal(missing.supplierSkus[0].weight, "unknown");
});

test("automatic SKU matching retains ambiguity across different supplier SKUs", () => {
  const exact = { sourceSkuId: "exact", attributes: { size: "5cm" }, priceCny: 20 };
  for (const size of ["5–15cm", "5-15cm", "5~15cm", "5到15cm"]) {
    const range = { sourceSkuId: "range", attributes: { size }, priceCny: 10 };
    for (const skus of [[exact, range], [range, exact]]) {
      const evidence = { skus };
      const before = structuredClone(evidence);
      const result = resolveCapturedSku({ productName: "5cm" }, evidence);
      assert.equal(result.status, "needs_selection", `must retain ${size} in either SKU order`);
      assert.equal(result.selected, undefined, "不得因过滤歧义SKU而自动选中另一条");
      assert.deepEqual(result.choices, skus, "所有SKU仍作为人工选择证据保留");
      assert.deepEqual(evidence, before);
    }
  }
});

test("unambiguous other SKUs do not block exact matching and explicit selection stays explicit", () => {
  const exact = { sourceSkuId: "exact", attributes: { size: "5cm" }, priceCny: 20 };
  const other = { sourceSkuId: "other", attributes: { size: "15cm" }, priceCny: 30 };
  assert.equal(resolveCapturedSku({ productName: "5cm" }, { skus: [exact, other] }).selected.sourceSkuId, "exact");
  const evidence = { skus: [exact, { ...other, attributes: { size: "5–15cm" } }] };
  const explicit = resolveCapturedSku({ productName: "5cm" }, evidence, "exact");
  assert.equal(explicit.status, "matched");
  assert.equal(explicit.selected.sourceSkuId, "exact");
  assert.deepEqual(explicit.matchTerms, [], "显式选择不能被称为自动规格推断");
});

test("SKU quantity/unit matching cannot select a substring specification or mine IDs", () => {
  for (const [wanted, actual] of [["5cm", "15cm"], ["20片", "320片"], ["5cm", "5mm"], ["0.5kg", "10.5kg"], ["5cm", "5cmm"], ["5cm", "-5cm"], ["15cm", "10-15cm"], ["15cm", "5×15cm"], ["5cm", "1e5cm"], ["15cm", "10到15cm"], ["5cm", "x-5cm"], ["5cm", "1,5cm"]]) {
    const evidence = { skus: [{ sourceSkuId: `contains-${wanted}`, propPath: wanted, attributes: { size: actual }, priceCny: 20 }] };
    assert.equal(resolveCapturedSku({ productName: `商品${wanted}` }, evidence).status, "needs_selection", `${wanted}/${actual}`);
  }
  const exact = { skus: [{ sourceSkuId: "a", attributes: { size: "5 cm", quantity: "20片" }, priceCny: 20 }] };
  assert.equal(resolveCapturedSku({ productName: "5cm商品20片" }, exact).status, "matched");
  const ambiguous = { skus: [...exact.skus, { ...exact.skus[0], sourceSkuId: "b" }] };
  assert.equal(resolveCapturedSku({ productName: "5cm商品20片" }, ambiguous).status, "needs_selection");
  assert.equal(resolveCapturedSku({ productName: "5cm商品20片", codexReview: { sourceSku: { variant: "5-15cm" } } }, exact).status, "needs_selection", "ambiguous source cannot disappear behind another candidate field");
  assert.equal(resolveCapturedSku({ productName: "5cm商品20片" }, { skus: [{ ...exact.skus[0], attributes: { size: "5cm", quantity: "20片", alternatives: "10-15cm" } }] }).status, "needs_selection", "ambiguous SKU field cannot disappear behind an exact one");
});

test("supplier image evidence cannot retain untrusted hosts, credentials or secret query strings", () => {
  for (const imageUrl of ["https://user:pass@evil.invalid/a.jpg?token=SYNTHETIC_ONLY", "https://cbu01.alicdn.com.evil.invalid/a.jpg", "https://user:pass@cbu01.alicdn.com/a.jpg"]) {
    const raw = syntheticCapture();
    raw.skus[0].imageUrl = imageUrl;
    const result = sanitize1688Evidence(raw, raw.offerId);
    assert.equal(result.skus[0].imageUrl, null);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_ONLY|user:pass/);
  }
  const raw = syntheticCapture();
  raw.skus[0].imageUrl = "https://cbu01.alicdn.com/a.jpg?token=SYNTHETIC_ONLY";
  assert.equal(sanitize1688Evidence(raw, raw.offerId).skus[0].imageUrl, "https://cbu01.alicdn.com/a.jpg");
});

test("short-link navigation failures become fixed enums without leaking URLs, queries or tokens", () => {
  const cases = [
    ["https://login.1688.com/member/signin.htm?token=secret-login", "login_1688", "login", "login_required", "登录页"],
    ["https://sec.1688.com/verify/captcha?session=secret-check", "verification_1688", "verification", "verification_required", "人机验证页"],
    ["https://m.1688.com/offer/876240928352.html?share=secret-mobile", "mobile_1688", "mobile_offer", "mobile_page", "移动页"],
    ["https://qr.1688.com/s/secret-redirect?token=hidden", "other_1688", "redirect_intermediate", "intermediate_page", "中间跳转页"],
    ["https://example.com/path?cookie=secret-cookie", "external", "other", "non_whitelisted_destination", "其他非白名单页面"],
    ["https://detail.1688.com/offer/999999.html?token=hidden", "detail_1688", "offer_detail", "different_offer", "不同商品"]
  ];
  for (const [url, finalHostClass, finalPathType, redirectClassification, label] of cases) {
    const diagnostics = classify1688NavigationOutcome(url, {
      expectedOfferId: redirectClassification === "different_offer" ? "876240928352" : "",
      navigationStage: "page_complete"
    });
    assert.equal(diagnostics.finalHostClass, finalHostClass);
    assert.equal(diagnostics.finalPathType, finalPathType);
    assert.equal(diagnostics.redirectClassification, redirectClassification);
    assert.equal(sourceCaptureFailureDestinationLabel(diagnostics), label);
    const serialized = JSON.stringify(diagnostics);
    assert.doesNotMatch(serialized, /https?:|secret-|[?&](?:token|cookie|session)=/i);
  }
  const safeDifferentOffer = classify1688NavigationOutcome(
    "https://detail.1688.com/offer/999999.html?token=hidden",
    { expectedOfferId: "876240928352", navigationStage: "page_complete" }
  );
  assert.equal(safeDifferentOffer.observedOfferId, "999999");
  assert.deepEqual(sanitizeSourceCaptureFailureDiagnostics(safeDifferentOffer), safeDifferentOffer);
  assert.throws(() => sanitizeSourceCaptureFailureDiagnostics({
    ...safeDifferentOffer,
    finalUrl: "https://detail.1688.com/offer/999999.html?token=hidden"
  }), /capture_failure_diagnostics_invalid/);
});

test("mobile offer is only an intermediate while redirect is still loading", () => {
  const mobileRedirect = classify1688NavigationOutcome(
    "https://m.1688.com/offer/876240928352.html?share=secret-mobile",
    { navigationStage: "redirect_observed" }
  );
  assert.equal(shouldWaitFor1688Destination(mobileRedirect, "loading"), true);

  const mobileComplete = classify1688NavigationOutcome(
    "https://m.1688.com/offer/876240928352.html?share=secret-mobile",
    { navigationStage: "page_complete" }
  );
  assert.equal(shouldWaitFor1688Destination(mobileComplete, "complete"), false);

  const mobileTimeout = classify1688NavigationOutcome(
    "https://m.1688.com/offer/876240928352.html?share=secret-mobile",
    { navigationStage: "timeout" }
  );
  assert.equal(shouldWaitFor1688Destination(mobileTimeout, "loading"), false);

  const allowedDetailLoading = classify1688NavigationOutcome(
    "https://detail.1688.com/offer/876240928352.html",
    { navigationStage: "redirect_observed" }
  );
  assert.equal(shouldWaitFor1688Destination(allowedDetailLoading, "loading"), true);
  assert.equal(shouldWaitFor1688Destination(allowedDetailLoading, "complete"), false);
});

test("loading tab prefers pending URL and timeout diagnostics stay sanitized", () => {
  const observation = observed1688TabAddress({
    status: "loading",
    url: "https://qr.1688.com/s/secret-token",
    pendingUrl: "https://detail.1688.com/offer/876240928352.html?token=hidden"
  });
  assert.equal(observation.tabObservation, "pending_url");
  assert.match(observation.value, /detail\.1688\.com\/offer\/876240928352\.html/);

  const timeout = classify1688TimeoutOutcome({
    status: "loading",
    url: "about:blank",
    pendingUrl: "https://detail.1688.com/offer/876240928352.html?token=hidden"
  }, "876240928352", {
    redirectClassification: "mobile_page"
  });
  assert.equal(timeout.redirectClassification, "detail_load_timeout");
  assert.equal(timeout.navigationStage, "timeout");
  assert.equal(timeout.tabObservation, "pending_url");
  assert.equal(timeout.lastObservedClassification, "mobile_page");
  assert.equal(sourceCaptureFailureDestinationLabel(timeout), "商品详情页加载超时");
  assert.doesNotMatch(JSON.stringify(timeout), /https?:|secret-|[?&](?:token|cookie|session)=/i);
  assert.deepEqual(sanitizeSourceCaptureFailureDiagnostics(timeout), timeout);
});

test("timeout distinguishes missing tab from missing address and retains only safe last state", () => {
  const missingTab = classify1688TimeoutOutcome(null, "", {
    redirectClassification: "mobile_page"
  });
  assert.equal(missingTab.redirectClassification, "tab_unavailable");
  assert.equal(missingTab.tabObservation, "tab_unavailable");
  assert.equal(missingTab.lastObservedClassification, "mobile_page");
  assert.equal(sourceCaptureFailureDestinationLabel(missingTab), "采集标签已关闭或不可读取");
  assert.deepEqual(sanitizeSourceCaptureFailureDiagnostics(missingTab), missingTab);

  const missingAddress = classify1688TimeoutOutcome({ status: "loading", url: "about:blank" }, "", {
    redirectClassification: "intermediate_page"
  });
  assert.equal(missingAddress.redirectClassification, "address_unavailable");
  assert.equal(missingAddress.tabObservation, "address_unavailable");
  assert.equal(missingAddress.lastObservedClassification, "intermediate_page");
  assert.equal(sourceCaptureFailureDestinationLabel(missingAddress), "页面地址仍未就绪");
  assert.deepEqual(sanitizeSourceCaptureFailureDiagnostics(missingAddress), missingAddress);
});

test("failed capture reports accept only the strict sanitized payload shape", () => {
  const report = sanitizeSourceCaptureFailureResult({
    captureId: "SCJ-safe",
    token: "one-time-token-not-persisted",
    dataRevision: 24,
    status: "failed",
    failureCode: "site_login_required",
    observedAt: "2026-08-19T08:00:00.000Z",
    failureDiagnostics: {
      finalHostClass: "login_1688",
      finalPathType: "login",
      redirectClassification: "login_required",
      navigationStage: "page_complete",
      observedOfferId: null
    }
  });
  assert.equal(report.failureDiagnostics.redirectClassification, "login_required");
  assert.equal("token" in report, false);
  assert.equal("captureId" in report, false);
  assert.throws(() => sanitizeSourceCaptureFailureResult({
    captureId: "SCJ-unsafe",
    token: "one-time-token",
    dataRevision: 24,
    status: "failed",
    failureCode: "wrong_offer",
    observedAt: "2026-08-19T08:00:00.000Z",
    finalUrl: "https://example.com/?token=must-not-pass"
  }), /capture_failure_diagnostics_invalid/);
  assert.throws(() => sanitizeSourceCaptureFailureResult({
    captureId: "SCJ-unsafe-code",
    token: "one-time-token",
    dataRevision: 24,
    status: "failed",
    failureCode: "https://example.com/?token=must-not-pass",
    observedAt: "2026-08-19T08:00:00.000Z"
  }), /capture_failure_diagnostics_invalid/);
});

test("A confirmation card supplier multi-selection is local, defaults empty, and can check or uncheck without an API contract", async () => {
  assert.deepEqual(toggleLocalSupplierSkuSelection([], "sku-a", true), ["sku-a"]);
  assert.deepEqual(toggleLocalSupplierSkuSelection(["sku-a"], "sku-b", true), ["sku-a", "sku-b"]);
  assert.deepEqual(toggleLocalSupplierSkuSelection(["sku-a", "sku-b"], "sku-a", false), ["sku-b"]);
  const component = await readFile(path.join(appDir, "src", "components", "RealAConfirmationCard.jsx"), "utf8");
  assert.match(component, /useCandidateForm\(record, \{ form: initial, localSelectedSkuIds: \[\] \}\)/);
  assert.match(component, /id: card\.sourceCandidateId, dataRevision: card\.sourceDataRevision/);
  assert.match(component, /guard\.assertCurrent\(\)/);
  assert.match(component, /type="checkbox"/);
  assert.match(component, /toggleLocalSupplierSkuSelection/);
  assert.match(component, /不会调用接口、保存选择、确认供应方案或进入B\/C1/);
  assert.doesNotMatch(component, /selectSourceCaptureSku|completeSourceCapture|api\./);
});

test("1688 collector rejects a different offer before returning SKU evidence", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { location: { href: "https://detail.1688.com/offer/999.html", pathname: "/offer/999.html" } };
  globalThis.document = fakeDocument();
  try {
    const result = await collect1688Page("712421624571");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "wrong_offer");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("1688 collector accepts a real top-level SKU ID on a single-specification offer", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    location: { href: "https://detail.1688.com/offer/728389288187.html", pathname: "/offer/728389288187.html" },
    context: {
      result: {
        global: {
          globalData: {
            model: {
              offerBaseInfo: { offerId: "728389288187", subject: "发光木质3D鬼屋拼图" },
              tradeModel: { offerPriceRanges: [{ beginAmount: 1, price: 53 }] },
              skuModel: {
                skuProps: [],
                defaultSkuId: "ghost-house-sku",
                currentSku: { skuId: "ghost-house-sku", price: 53, canBookCount: 8 }
              }
            }
          }
        }
      }
    }
  };
  globalThis.document = fakeDocument(globalThis.window.context);
  delete globalThis.window.context;
  try {
    const result = await collect1688Page("728389288187");
    assert.equal(result.status, "captured");
    assert.equal(result.evidence.pageSelectedSkuId, "ghost-house-sku");
    assert.equal(result.evidence.skus.length, 1);
    assert.equal(result.evidence.skus[0].sourceSkuId, "ghost-house-sku");
    assert.equal(result.evidence.skus[0].priceCny, 53);
    assert.equal(result.evidence.skus[0].stock, 8);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("extension manifest stays limited to the 1688 short-link/detail allowlist, Ozon product pages and the local review app", async () => {
  const manifest = JSON.parse(await readFile(path.join(appDir, "extension", "1688-capture", "manifest.json"), "utf8"));
  assert.equal(manifest.version, "1.2.7");
  assert.equal(manifest.name, "全店经营工作台 · 商品只读采集器");
  assert.equal(manifest.action.default_title, "全店经营工作台 · 商品只读采集器");
  assert.match(manifest.description, /本机全店经营工作台/);
  assert.deepEqual(manifest.permissions.sort(), ["alarms", "scripting"]);
  assert.equal(manifest.minimum_chrome_version, "120");
  assert.deepEqual(manifest.host_permissions.sort(), [
    "http://127.0.0.1:4317/*",
    "https://detail.1688.com/offer/*",
    "https://qr.1688.com/s/*",
    "https://www.ozon.ru/product/*"
  ]);
  assert.equal(manifest.permissions.includes("cookies"), false);
});

test("extension background resolves an A-stage short link once and never auto-selects a supplier SKU", async () => {
  const job = supplierJob({ sourceUrl: "https://qr.1688.com/s/fixture", expectedOfferId: "", allowShortLinkResolution: true });
  const h = harness({ job, destination: SUPPLIER_URL });
  const receipt = await startCapture(h.runtime, job.captureId);
  assert.equal(receipt.accepted, true);
  await idle(h.runtime);
  assert.deepEqual(h.calls.created, [{ url: job.sourceUrl, active: false }]);
  assert.equal(h.calls.executions[0].world, "ISOLATED");
  const result = h.calls.requests[1].body;
  assert.equal(result.resolvedSourceUrl, SUPPLIER_URL);
  assert.equal(result.evidence.offerId, "876240928352");
  for (const key of ["selectedSkuIds", "ownerSupplyConfirmed", "finalUrl"]) assert.equal(Object.hasOwn(result, key), false);
  assert.deepEqual(h.calls.removed, [7]);
});

test("page bridge and extension background preserve precise capture rejection codes", async () => {
  const h = harness({ heartbeat: async () => ({ ok: false, status: 403 }) });
  assert.equal(message(h.runtime, { type: START, payload: supplierJob() }).response.code, "start_signal_invalid");
  assert.equal(message(h.runtime, { type: START, captureId: "job-1" }, { url: "https://evil.test/" }).response.code, "request_origin_invalid");
  assert.equal(h.calls.requests.length, 0);
  const status = await h.runtime.heartbeat();
  assert.equal(status.accepted, false);
  assert.equal(status.code, "extension_identity_rejected");
  assert.equal(h.calls.created.length, 0);
});

test("extension status handshake verifies the background worker instead of only the page bridge", async () => {
  const h = harness();
  assert.equal(message(h.runtime, { type: PING }).response.accepted, false);
  assert.equal(h.calls.requests.length, 0);
  await h.runtime.heartbeat();
  assert.equal(message(h.runtime, { type: PING }).response.accepted, true);
  assert.equal(h.calls.requests.length, 1, "status ping must not claim or call transport");
  assert.equal(h.calls.created.length, 0);
  assert.equal(h.calls.executions.length, 0);
});

test("startup, alarms and heartbeat never execute returned historical jobs", async () => {
  const h = harness({ job: supplierJob() });
  h.runtime.install();
  h.chromeApi.runtime.onStartup.emit();
  await h.runtime.heartbeat();
  h.chromeApi.alarms.onAlarm.emit({ name: "selection-review-extension-heartbeat" });
  await h.runtime.heartbeat();
  assert.equal(message(h.runtime, { type: PING }).response.accepted, true);
  assert.equal(h.calls.created.length, 0);
  assert.equal(h.calls.executions.length, 0);
  assert.ok(h.calls.requests.every((request) => request.url.endsWith("/heartbeat")));
});

test("explicit capture claims only the requested ID and rejects mismatched or repeated jobs", async () => {
  const mismatch = harness({ job: supplierJob({ captureId: "different-job" }) });
  assert.equal((await startCapture(mismatch.runtime, "job-1")).code, "capture_job_invalid");
  assert.equal(mismatch.calls.created.length, 0);
  assert.match(mismatch.calls.requests[0].url, /capture-jobs\/job-1\/claim$/);
  assert.deepEqual(mismatch.calls.requests[0].body, { version: "1.2.7" });
  assert.equal((await startCapture(mismatch.runtime, "job-1")).code, "capture_replay_rejected");
  assert.equal(mismatch.calls.requests.length, 1);

  const valid = harness({ job: supplierJob() });
  assert.equal((await startCapture(valid.runtime, "job-1")).accepted, true);
  await idle(valid.runtime);
  assert.equal((await startCapture(valid.runtime, "job-1")).code, "capture_replay_rejected");
  assert.equal(valid.calls.created.length, 1);
});

test("uncertain claim transport cannot be repeated by a second page signal", async () => {
  const h = harness({ claim: async () => { throw new Error("connection interrupted"); } });
  assert.equal((await startCapture(h.runtime, "job-1")).code, "capture_claim_unconfirmed");
  assert.equal((await startCapture(h.runtime, "job-1")).code, "capture_replay_rejected");
  assert.equal(h.calls.requests.length, 1);
  assert.equal(h.calls.created.length, 0);
});
