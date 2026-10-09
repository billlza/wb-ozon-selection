import test from "node:test";
import assert from "node:assert/strict";

import { createOzonDictionaryValueReader, createOzonDictionaryValuesReader } from "../lib/ozon-dictionary-value-reader.mjs";

/*
 * 这个读取器最危险的失败方式是**把别处的读数当成本轮的答案**——
 * 换了店铺、换了类目、换了属性号的一份回复，如果照单全收，
 * 主人就会拿着另一个类目的字典号去发商品。作用域逐字校验守的就是这一条。
 */

const OK = {
  ok: true,
  evidence: {
    current: true,
    scope: { platform: "ozon", store: "miska", category: "ozon:17028966:96063", attributeId: "4967" },
    sourceRef: "ozon-seller-api:/v1/description-category/attribute/values/search:17028966:96063:4967",
    checkedAt: "2026-09-17T15:00:00.000Z",
    evidenceData: {
      attributeId: "4967", query: "Оксфорд",
      exactMatch: { dictionaryValueId: 61979, value: "Оксфорд" },
      matches: [{ dictionaryValueId: 61979, value: "Оксфорд" }],
      descriptionCategoryId: 17028966, typeId: 96063
    }
  }
};
const QUERY = { store: "miska", category: "ozon:17028966:96063", attributeId: "4967", value: "Оксфорд" };

function readerWith(payload, { status = 200, capture = [] } = {}) {
  return createOzonDictionaryValueReader({
    ozonServiceUrl: "http://127.0.0.1:4173",
    fetchImpl: async (url, options) => {
      capture.push({ url, body: JSON.parse(options.body) });
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
    }
  });
}

test("读回本轮问的那个店、类目和属性时，原样交出字典读数", async () => {
  const capture = [];
  const read = readerWith(OK, { capture });
  const result = await read(QUERY);
  assert.equal(capture.length, 1);
  assert.equal(capture[0].url, "http://127.0.0.1:4173/api/read-only/evidence/ozon");
  assert.deepEqual(capture[0].body, { kind: "schema_dictionary_value", platform: "ozon",
    store: "miska", category: "ozon:17028966:96063", attributeId: "4967", value: "Оксфорд" });
  assert.deepEqual(result.evidenceData.exactMatch, { dictionaryValueId: 61979, value: "Оксфорд" });
  assert.match(result.sourceRef, /attribute\/values\/search/);
});

test("作用域对不上就拒收——那是别处的读数，不是本轮的答案", async () => {
  for (const drift of [
    { store: "dandanshu" }, { category: "ozon:17028665:92935" }, { attributeId: "5949" }, { platform: "wb" }
  ]) {
    const payload = structuredClone(OK);
    Object.assign(payload.evidence.scope, drift);
    await assert.rejects(readerWith(payload)(QUERY), /OZON_DICTIONARY_SCOPE_UNPROVEN/);
  }
});

test("回的不是本轮那个查询词，同样拒收", async () => {
  const payload = structuredClone(OK);
  payload.evidence.evidenceData.query = "Хлопок";
  await assert.rejects(readerWith(payload)(QUERY), /OZON_DICTIONARY_EVIDENCE_SHAPE_INVALID/);
});

test("不是当前读数就拒收", async () => {
  const payload = structuredClone(OK);
  payload.evidence.current = false;
  await assert.rejects(readerWith(payload)(QUERY), /OZON_DICTIONARY_NOT_CURRENT/);
});

test("服务失败或返回非JSON都照实报错", async () => {
  await assert.rejects(readerWith({ ok: false, error: "boom" }, { status: 500 })(QUERY), /OZON_DICTIONARY_READ_FAILED/);
  const broken = createOzonDictionaryValueReader({ ozonServiceUrl: "http://127.0.0.1:4173",
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not json" }) });
  await assert.rejects(broken(QUERY), /OZON_DICTIONARY_INVALID_JSON/);
});

test("凭证服务只允许本机地址", () => {
  for (const url of ["https://example.com", "http://evil.example.com:4173", "http://user:pw@127.0.0.1:4173"]) {
    assert.throws(() => createOzonDictionaryValueReader({ ozonServiceUrl: url }), /OZON_DICTIONARY_SERVICE_NOT_LOCAL/);
  }
  assert.doesNotThrow(() => createOzonDictionaryValueReader({ ozonServiceUrl: "http://localhost:4173" }));
});

test("查询四项缺一不可，缺了就不发请求", async () => {
  let sent = 0;
  const read = createOzonDictionaryValueReader({ ozonServiceUrl: "http://127.0.0.1:4173",
    fetchImpl: async () => { sent += 1; return { ok: true, status: 200, text: async () => JSON.stringify(OK) }; } });
  for (const bad of [{ store: "" }, { category: "" }, { attributeId: "" }, { value: "" }]) {
    await assert.rejects(read({ ...QUERY, ...bad }), /OZON_DICTIONARY_QUERY_INCOMPLETE/);
  }
  assert.equal(sent, 0);
});

/*
 * 列字典值这条路是给模型做选择题用的。它最危险的失败方式是
 * **把截断的一段当完整候选交出去**——模型会在残缺集合里被迫挑一个错的。
 */
const LIST_OK = {
  ok: true,
  evidence: {
    current: true,
    scope: { platform: "ozon", store: "miska", category: "ozon:17028966:96063", attributeId: "5954" },
    sourceRef: "ozon-seller-api:/v1/description-category/attribute/values:17028966:96063:5954",
    checkedAt: "2026-09-18T15:00:00.000Z",
    expiresAt: "2026-09-19T15:00:00.000Z",
    evidenceData: { attributeId: "5954", complete: true,
      values: [{ dictionaryValueId: 30937, value: "На любой сезон" }, { dictionaryValueId: 30940, value: "Лето" }],
      descriptionCategoryId: 17028966, typeId: 96063 }
  }
};
const LIST_QUERY = { store: "miska", category: "ozon:17028966:96063", attributeId: "5954" };

function listReaderWith(payload, { status = 200, capture = [] } = {}) {
  return createOzonDictionaryValuesReader({
    ozonServiceUrl: "http://127.0.0.1:4173",
    fetchImpl: async (url, options) => {
      capture.push({ url, body: JSON.parse(options.body) });
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
    }
  });
}

test("列字典值：原样交出候选，并带上完整性标记", async () => {
  const capture = [];
  const result = await listReaderWith(LIST_OK, { capture })(LIST_QUERY);
  assert.equal(capture[0].body.kind, "schema_dictionary_values");
  assert.equal(capture[0].body.attributeId, "5954");
  assert.equal(result.evidenceData.values.length, 2);
  assert.equal(result.evidenceData.complete, true);
  assert.equal(result.expiresAt, LIST_OK.evidence.expiresAt);
});

test("列字典值：来源有效期缺失时拒收", async () => {
  const payload = structuredClone(LIST_OK);
  delete payload.evidence.expiresAt;
  await assert.rejects(listReaderWith(payload)(LIST_QUERY), /OZON_DICTIONARY_EXPIRY_UNPROVEN/);
});

test("列字典值：作用域对不上一律拒收", async () => {
  for (const drift of [{ store: "dandanshu" }, { category: "ozon:1:2" }, { attributeId: "4967" }, { platform: "wb" }]) {
    const payload = structuredClone(LIST_OK);
    Object.assign(payload.evidence.scope, drift);
    await assert.rejects(listReaderWith(payload)(LIST_QUERY), /OZON_DICTIONARY_SCOPE_UNPROVEN/);
  }
});

test("列字典值：缺 complete 标记就拒收——分不清完整还是截断，就不能拿去做选择题", async () => {
  const payload = structuredClone(LIST_OK);
  delete payload.evidence.evidenceData.complete;
  await assert.rejects(listReaderWith(payload)(LIST_QUERY), /OZON_DICTIONARY_EVIDENCE_SHAPE_INVALID/);
});

test("列字典值：属性号缺失就不发请求", async () => {
  let sent = 0;
  const read = createOzonDictionaryValuesReader({ ozonServiceUrl: "http://127.0.0.1:4173",
    fetchImpl: async () => { sent += 1; return { ok: true, status: 200, text: async () => JSON.stringify(LIST_OK) }; } });
  await assert.rejects(read({ ...LIST_QUERY, attributeId: "" }), /OZON_DICTIONARY_QUERY_INCOMPLETE/);
  assert.equal(sent, 0);
});
