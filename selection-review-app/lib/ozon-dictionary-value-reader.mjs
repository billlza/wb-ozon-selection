export const OZON_DICTIONARY_VALUE_KIND = "schema_dictionary_value";
export const OZON_DICTIONARY_VALUES_KIND = "schema_dictionary_values";

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }

/** 凭证只许留在本机的 Ozon 证据服务里。和 lifecycle-b-real-evidence-readers.mjs 同一条边界。 */
function assertLocalOzonService(value) {
  const url = new URL(value);
  if (url.username || url.password || url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("OZON_DICTIONARY_SERVICE_NOT_LOCAL: Ozon凭证服务只允许本机地址");
  }
  return url.origin;
}

/**
 * 按值查 Ozon 类目字典，拿真实 dictionaryValueId。只读、免费（Ozon 自家 Seller API）。
 *
 * 为什么单独写一个而不复用 B 阶段那套读取器：那套的作用域校验（normalizeEvidenceScope /
 * evidenceScopeMatches）是按 commission / schema / exchange_rate 三种证据逐字段写死的，
 * 为了一次字典查询去改它，等于动一条正在承载真实上架的合同。这里只做自己这一件事。
 *
 * **不整包拉字典**：/attribute/values 对 Материал 返回正好 200 条且 has_next: true，
 * 整包会截断，把截断的一段当完整列表就是在骗下游（2026-09-17 实测）。
 */
export function createOzonDictionaryValueReader({ ozonServiceUrl, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!nonEmpty(ozonServiceUrl)) throw new Error("OZON_DICTIONARY_SERVICE_URL_REQUIRED");
  const origin = assertLocalOzonService(ozonServiceUrl);
  if (typeof fetchImpl !== "function") throw new TypeError("OZON_DICTIONARY_FETCH_REQUIRED");
  return async function readDictionaryValue({ store, category, attributeId, value }) {
    if (!nonEmpty(store) || !nonEmpty(category) || !nonEmpty(String(attributeId ?? "")) || !nonEmpty(value)) {
      throw new Error("OZON_DICTIONARY_QUERY_INCOMPLETE: 需要店铺、类目、属性号和要查的值");
    }
    const response = await fetchImpl(`${origin}/api/read-only/evidence/ozon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: OZON_DICTIONARY_VALUE_KIND, platform: "ozon", store, category,
        attributeId: String(attributeId), value
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error("OZON_DICTIONARY_INVALID_JSON"); }
    if (!response.ok || payload?.ok !== true || !isObject(payload.evidence)) {
      throw new Error(`OZON_DICTIONARY_READ_FAILED: ${response.status} ${nonEmpty(payload?.error) ? payload.error : raw.slice(0, 200)}`);
    }
    const evidence = payload.evidence;
    if (evidence.current !== true) throw new Error("OZON_DICTIONARY_NOT_CURRENT");
    // 作用域必须逐字对上本轮请求：读回来的是不是我们问的那个店、那个类目、那个属性。
    if (evidence.scope?.platform !== "ozon" || evidence.scope?.store !== store ||
        evidence.scope?.category !== category || evidence.scope?.attributeId !== String(attributeId)) {
      throw new Error("OZON_DICTIONARY_SCOPE_UNPROVEN");
    }
    const data = evidence.evidenceData;
    if (!isObject(data) || data.query !== value || !Array.isArray(data.matches) ||
        !(data.exactMatch === null || isObject(data.exactMatch))) {
      throw new Error("OZON_DICTIONARY_EVIDENCE_SHAPE_INVALID");
    }
    return { sourceRef: evidence.sourceRef, checkedAt: evidence.checkedAt, evidenceData: data };
  };
}

/**
 * 列出某个属性的字典值。**给模型做选择题用**——只让它在真实候选里挑，它就编不出平台上没有的值。
 *
 * 2026-09-18 实测：同一批属性，让模型凭空写俄文是 7 条对 1 条；给它真实候选去挑是 5 对 1 弃权 0 错。
 * 差别就在它看不看得见候选。而搜索接口最少要 2 个字符、`Зима` 和 `сезон` 没有公共子串，
 * 靠搜索凑不出完整列表，所以必须有这条。
 *
 * `complete` 为 false 表示平台还有下一页——**那就不能当完整候选用**，
 * 让模型在残缺集合里挑，等于逼它从错的里面选一个。
 */
export function createOzonDictionaryValuesReader({ ozonServiceUrl, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!nonEmpty(ozonServiceUrl)) throw new Error("OZON_DICTIONARY_SERVICE_URL_REQUIRED");
  const origin = assertLocalOzonService(ozonServiceUrl);
  if (typeof fetchImpl !== "function") throw new TypeError("OZON_DICTIONARY_FETCH_REQUIRED");
  return async function readDictionaryValues({ store, category, attributeId, limit = 200 }) {
    if (!nonEmpty(store) || !nonEmpty(category) || !nonEmpty(String(attributeId ?? ""))) {
      throw new Error("OZON_DICTIONARY_QUERY_INCOMPLETE: 需要店铺、类目和属性号");
    }
    const response = await fetchImpl(`${origin}/api/read-only/evidence/ozon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: OZON_DICTIONARY_VALUES_KIND, platform: "ozon", store, category,
        attributeId: String(attributeId), limit
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error("OZON_DICTIONARY_INVALID_JSON"); }
    if (!response.ok || payload?.ok !== true || !isObject(payload.evidence)) {
      throw new Error(`OZON_DICTIONARY_READ_FAILED: ${response.status} ${nonEmpty(payload?.error) ? payload.error : raw.slice(0, 200)}`);
    }
    const evidence = payload.evidence;
    if (evidence.current !== true) throw new Error("OZON_DICTIONARY_NOT_CURRENT");
    if (!nonEmpty(evidence.expiresAt) || !Number.isFinite(Date.parse(evidence.expiresAt)) ||
        Date.parse(evidence.expiresAt) <= Date.parse(evidence.checkedAt)) {
      throw new Error("OZON_DICTIONARY_EXPIRY_UNPROVEN");
    }
    if (evidence.scope?.platform !== "ozon" || evidence.scope?.store !== store ||
        evidence.scope?.category !== category || evidence.scope?.attributeId !== String(attributeId)) {
      throw new Error("OZON_DICTIONARY_SCOPE_UNPROVEN");
    }
    const data = evidence.evidenceData;
    if (!isObject(data) || !Array.isArray(data.values) || typeof data.complete !== "boolean") {
      throw new Error("OZON_DICTIONARY_EVIDENCE_SHAPE_INVALID");
    }
    return { sourceRef: evidence.sourceRef, checkedAt: evidence.checkedAt,
      expiresAt: evidence.expiresAt, evidenceData: data };
  };
}
