import { createInternalEvidenceValidity, createSourceDeclaredEvidenceValidity, isLifecycleEvidenceValidityMetadataValid } from "./lifecycle-evidence-validity.mjs";
import { readWbCommissionReference } from './wb-commission-reference-reader.mjs';
import { readOzonCommissionReference } from './ozon-commission-reference-reader.mjs';
import { normalizeEvidenceScope, normalizeRelatedSchemaScope, evidenceScopeMatches, evidenceScopeKey } from "./lifecycle-evidence-scope.mjs";
import { readCurrentGuooTariff } from "./guoo-tariff-reader.mjs";
import { createLifecycleBEvidenceProviderRegistry } from "./lifecycle-b-evidence-providers.mjs";
import { readCurrentCbrExchangeRate } from "./official-fx-reader.mjs";
import { OZON_EVIDENCE_COMMISSION_UNAVAILABLE, remoteEvidenceReasonCode } from "./commission-estimate-authorization.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCommissionEstimate(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || value.authorized !== true || value.confirmedBy !== "owner") {
    throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED: 估算佣金必须由主人对当前SKU明确授权");
  }
  const rate = value.commissionRate;
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
    throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_INVALID: 估算佣金率必须在0到1之间");
  }
  return Object.freeze({
    authorized: true,
    confirmedBy: "owner",
    commissionRate: rate,
    authorizationRef: typeof value.authorizationRef === "string" ? value.authorizationRef.trim() : null,
    candidateId: value.candidateId,
    candidateRevision: value.candidateRevision,
    scope: value.scope === undefined ? null : structuredClone(value.scope),
    effectiveFrom: value.effectiveFrom,
    effectiveTo: value.effectiveTo,
  });
}

function assertEstimateScopeAndValidity(estimate, request, currentTime) {
  if (!Number.isFinite(currentTime) || !estimate || !estimate.authorizationRef || estimate.candidateId !== request.candidateId ||
      estimate.candidateRevision !== request.candidateRevision || !evidenceScopeMatches("commission", estimate.scope, request.scope)) {
    throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_NOT_AUTHORIZED: 缺少当前候选、revision和精确范围的单次估算授权");
  }
  if (estimate.effectiveFrom !== undefined || estimate.effectiveTo !== undefined) {
    const from = Date.parse(estimate.effectiveFrom), to = Date.parse(estimate.effectiveTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || currentTime < from || currentTime >= to) {
      throw new Error("B_EVIDENCE_COMMISSION_ESTIMATE_EXPIRED: 估算授权不在明确有效时间窗内");
    }
  }
}

function assertExactCommissionUnavailable(result, request, currentTime) {
  if (!Number.isFinite(currentTime) || result.current !== false || result.reasonCode !== "exact_commission_unavailable" ||
      result.evidenceData?.commissionRate !== undefined ||
      typeof result.sourceType !== "string" || !result.sourceType.trim() || typeof result.sourceRef !== "string" || !result.sourceRef.trim() ||
      /token|cookie|password|secret|authorization/i.test(`${result.sourceType} ${result.sourceRef}`) ||
      !Number.isFinite(Date.parse(result.checkedAt)) || !Number.isFinite(Date.parse(request.requestedAt)) ||
      Date.parse(result.checkedAt) < Date.parse(request.requestedAt) || Date.parse(result.checkedAt) > currentTime) {
    throw new Error("B_EVIDENCE_COMMISSION_UNAVAILABLE_INVALID: 不可用必须是本轮同范围明确结果，不能保留佣金数值");
  }
}

export const OZON_OFFICIAL_COMMISSION_SOURCE = "ozon_official_commission_table";
const OFFICIAL_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeOzonCommissionReferenceOption(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || typeof value.catalogPath !== "string" || !value.catalogPath.trim() || value.sellerRegion !== "CN") {
    throw new Error("B_EVIDENCE_OZON_COMMISSION_REFERENCE_INVALID: 官方佣金表配置必须提供本地目录路径和CN卖家范围");
  }
  return value;
}

/**
 * 官方费表只按“本轮已冻结的成交价 + Ozon类型名称”查询：两项来自本轮请求，
 * 任一缺失都记成缺口回到主人授权估算路径，绝不按类目选择器或市场行情猜测。
 *
 * 平台大类（mpCategoryZh）有就一起带上，当费表自己的消歧键：Full ChinaHK 里有 298 个重名类型，
 * 不带大类时重名行费率不一致就只能记成 TYPE_AMBIGUOUS 缺口。带上去只会让匹配更严，永远不会更松。
 */
function officialReferenceQuery(request, scope, reference) {
  const gaps = [];
  const inputs = isObject(request.commissionReferenceScope) ? request.commissionReferenceScope : {};
  const priceRub = inputs.priceRub;
  if (!Number.isFinite(priceRub) || priceRub <= 0) gaps.push("OFFICIAL_TABLE_PRICE_MISSING");
  const typeName = typeof inputs.typeName === "string" ? inputs.typeName.trim() : "";
  const field = !typeName ? null
    : /\p{Script=Han}/u.test(typeName) ? "typeZh"
    : /\p{Script=Cyrillic}/u.test(typeName) ? "typeRu" : "typeEn";
  if (!field) gaps.push("OFFICIAL_TABLE_TYPE_IDENTITY_MISSING");
  const mpCategoryZh = typeof inputs.mpCategoryZh === "string" ? inputs.mpCategoryZh.trim() : "";
  if (!["rfbs", "fbp"].includes(scope.salesScheme)) gaps.push("OFFICIAL_TABLE_SALES_SCHEME_UNSUPPORTED");
  if (!isObject(reference.versionState)) gaps.push("OFFICIAL_TABLE_VERSION_STATE_MISSING");
  if (gaps.length) return { gaps, query: null };
  return {
    gaps,
    query: {
      catalogPath: reference.catalogPath,
      versionState: structuredClone(reference.versionState),
      scope: {
        platform: "ozon", sellerRegion: reference.sellerRegion, salesScheme: scope.salesScheme, priceRub,
        typeIdentity: { [field]: typeName },
        ...(mpCategoryZh ? { mpCategoryZh } : {}),
      },
    },
  };
}

function assertLocalOzonService(value) {
  const url = new URL(value);
  if (url.username || url.password || url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("B_EVIDENCE_OZON_SERVICE_NOT_LOCAL: Ozon凭证服务只允许本机地址");
  }
  return url.origin;
}

/**
 * 证据服务失败时那句话必须原样上来。
 *
 * 它自己已经脱过敏（失败回体是 `{"ok":false,"error":"<已脱敏的原因>"}`），把 error 丢掉，就把「这个店在这条
 * 类目还没有商品，读不到同类商品的真实佣金」说成了一个光秃秃的 HTTP 500——那种话只会让主人一直重试，而这
 * 件事重试多少次都一样。除了那句原话，错误对象上还挂着机器可读的那一份：上层判断「是不是精确佣金读不到」
 * 靠 remoteCode，不靠那句中文。error 不是字符串或者根本没有时只报状态码，不再抛第二个异常。
 */
function localEvidenceFailure(status, payload) {
  const remoteError = typeof payload?.error === "string" && payload.error.trim().length > 0
    ? payload.error.trim().slice(0, 500) : null;
  const remoteCode = remoteEvidenceReasonCode(remoteError);
  return Object.assign(
    new Error(`OZON_LOCAL_EVIDENCE_FAILED: HTTP ${status}${remoteError === null ? "" : `: ${remoteError}`}`),
    {
      code: "OZON_LOCAL_EVIDENCE_FAILED",
      httpStatus: status,
      remoteError,
      remoteCode,
      exactCommissionUnavailable: remoteCode === OZON_EVIDENCE_COMMISSION_UNAVAILABLE,
    }
  );
}

async function postOzonEvidence({ request, kind, fetchImpl, ozonServiceUrl }) {
  const scope = normalizeEvidenceScope(kind, request.scope);
  const response = await fetchImpl(`${assertLocalOzonService(ozonServiceUrl)}/api/read-only/evidence/ozon`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...scope, kind }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("OZON_LOCAL_EVIDENCE_INVALID_JSON");
  }
  if (!response.ok || payload?.ok !== true || !isObject(payload?.evidence)) {
    throw localEvidenceFailure(response.status, payload);
  }
  if (Object.hasOwn(payload, "status") || (Object.hasOwn(payload.evidence, "status") &&
      !(kind === "commission" && payload.evidence.status === "data_unavailable"))) {
    throw new Error("OZON_LOCAL_EVIDENCE_STATUS_INVALID: 显式失败或未知状态不能作为成功证据");
  }
  if (!evidenceScopeMatches(kind, payload.evidence.scope, scope)) throw new Error("OZON_LOCAL_EVIDENCE_STORE_SCOPE_UNPROVEN");
  if (!(kind === "commission" && payload.evidence.status === "data_unavailable") && payload.evidence.current !== true) throw new Error("OZON_LOCAL_EVIDENCE_NOT_CURRENT");
  return payload.evidence;
}

export function createLifecycleBRealEvidenceReaders({
  fetchImpl = globalThis.fetch,
  ozonServiceUrl,
  guooFilePath,
  cbrSourceUrl,
  commissionEstimate,
  wbCommissionReference,
  ozonCommissionReference,
  readOzonCommissionReferenceImpl = readOzonCommissionReference,
  now = () => new Date(),
  ...remainingOptions
} = {}) {
  if (Object.hasOwn(remainingOptions, "otherCosts")) {
    throw new Error("B_EVIDENCE_COST_POLICY_MISPLACED: 商品成本必须在当前SKU输入包中冻结，不能传入可复用佣金reader");
  }
  const authorizedEstimate = normalizeCommissionEstimate(commissionEstimate);
  const officialReference = normalizeOzonCommissionReferenceOption(ozonCommissionReference);
  if (!ozonServiceUrl) throw new Error("B_EVIDENCE_OZON_SERVICE_URL_REQUIRED: Ozon证据连接器地址必须由运行配置提供");
  const schemaCache = new Map();
  const readSchema = async (request) => {
    const scope = (request.kind === "commission" ? normalizeRelatedSchemaScope(request.scope, request.relatedSchemaScope) : normalizeEvidenceScope("schema", request.scope));
    const key = evidenceScopeKey("schema", scope);
    if (!schemaCache.has(key)) {
      if (schemaCache.size >= 32) throw new Error("B_EVIDENCE_SCHEMA_CACHE_LIMIT");
      schemaCache.set(key, postOzonEvidence({ request: { scope }, kind: "schema", fetchImpl, ozonServiceUrl }));
    }
    const result = await schemaCache.get(key);
    // This connector currently generates its own 24-hour cache hint. Only its
    // reviewed DTO shape can acquire that meaning at this adapter boundary.
    if (Object.hasOwn(result, "validity")) throw new Error("B_EVIDENCE_SCHEMA_REMOTE_VALIDITY_UNSUPPORTED");
    const declared = { ...result, kind: "schema", validity: createInternalEvidenceValidity("schema") };
    return isLifecycleEvidenceValidityMetadataValid(declared) ? { ...result, validity: declared.validity } : result;
  };
  /**
   * 店铺自身没有同类目在售商品时，改读主人保存的官方佣金表版本；
   * 只要有一个阻断缺口就返回缺口清单，由调用处退回原有主人授权估算路径。
   */
  const readOfficialCommission = async (request, scope) => {
    const { gaps, query } = officialReferenceQuery(request, scope, officialReference);
    if (!query) return { pack: null, gaps };
    let read;
    try {
      read = await readOzonCommissionReferenceImpl({ ...query, asOf: now().toISOString() });
    } catch (error) {
      const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "UNREADABLE";
      return { pack: null, gaps: [`OFFICIAL_TABLE_${code}`] };
    }
    const blocking = (Array.isArray(read?.gaps) ? read.gaps : [])
      .filter((gap) => gap?.blocking !== false)
      .map((gap) => (typeof gap?.code === "string" && gap.code.trim() ? gap.code.trim() : "OFFICIAL_TABLE_GAP"));
    const rate = read?.commissionRate;
    if (blocking.length || !Number.isFinite(rate) || rate <= 0 || rate >= 1) {
      return { pack: null, gaps: blocking.length ? blocking : ["OFFICIAL_TABLE_RATE_UNUSABLE"] };
    }
    const source = isObject(read.source) ? read.source : {};
    const row = Array.isArray(read.matchedRows) ? read.matchedRows[0] : null;
    const text = (value) => typeof value === "string" && value.trim().length > 0;
    if (!isObject(row) || !["typeRu", "typeZh", "mpCategoryZh"].every((key) => text(row[key])) ||
        ![source.effectiveFrom, source.fileSha256, source.sourceUrl, read.priceTier].every(text)) {
      return { pack: null, gaps: ["OFFICIAL_TABLE_SOURCE_INCOMPLETE"] };
    }
    const schema = await readSchema(request);
    normalizeRelatedSchemaScope(request.scope, schema.scope);
    const checkedAt = now();
    const sourceExpiry = read.expiresAt == null ? null : createSourceDeclaredEvidenceValidity("commission", read.expiresAt);
    const expiry = [checkedAt.getTime() + OFFICIAL_REFERENCE_TTL_MS, ...(sourceExpiry ? [Date.parse(read.expiresAt)] : [])];
    return {
      gaps: [],
      pack: {
        current: true,
        scope: structuredClone(request.scope),
        sourceType: OZON_OFFICIAL_COMMISSION_SOURCE,
        sourceRef: `ozon-official-commission:${source.effectiveFrom}:sha256:${source.fileSha256}:${read.priceTier}`,
        checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(Math.min(...expiry)).toISOString(),
        validity: sourceExpiry ?? createInternalEvidenceValidity("commission"),
        commissionCatalogRef: {
          effectiveFrom: source.effectiveFrom,
          fileSha256: source.fileSha256,
          sourceUrl: source.sourceUrl,
          priceTier: read.priceTier,
          matchedRow: { typeRu: row.typeRu, typeZh: row.typeZh, mpCategoryZh: row.mpCategoryZh },
        },
        evidenceData: {
          commissionRate: rate,
          commissionEvidenceMode: "official_reference",
          officialCommissionBinding: {
            schemaVersion: "ozon-official-commission-binding-v1",
            candidateId: request.candidateId,
            candidateRevision: request.candidateRevision,
            priceRub: query.scope.priceRub,
          },
          estimateAuthorized: false,
          exactCommissionRequiredAtC: true,
          descriptionCategoryId: schema.evidenceData.descriptionCategoryId,
          typeId: schema.evidenceData.typeId,
        },
      },
    };
  };
  return {
    commission: async (request) => {
      const scope = normalizeEvidenceScope('commission', request.scope);
      if (scope.platform === 'wb') {
        const match = /^wb:subject:([1-9]\d*)$/.exec(scope.category);
        if (!match || !Number.isSafeInteger(Number(match[1]))) throw Object.assign(new Error('B_EVIDENCE_WB_SUBJECT_ID_REQUIRED: 缺少已核实的WB精确subjectID，不能按类目名称或Ozon编号猜测'), { code:'B_EVIDENCE_WB_SUBJECT_ID_REQUIRED' });
        if (!wbCommissionReference || typeof wbCommissionReference.readVersionState !== 'function') {
          throw Object.assign(new Error('B_EVIDENCE_WB_COMMISSION_REFERENCE_REQUIRED: 尚未配置本地官方费表及当前版本状态'), { code:'B_EVIDENCE_WB_COMMISSION_REFERENCE_REQUIRED' });
        }
        const reference = await readWbCommissionReference({catalogPath:wbCommissionReference.catalogPath,sourcePath:wbCommissionReference.sourcePath,
          scope:{platform:'wb',sellerRegion:wbCommissionReference.sellerRegion,subjectId:Number(match[1]),salesScheme:scope.salesScheme},
          versionState:await wbCommissionReference.readVersionState(),asOf:now().toISOString()});
        // The saved source proves the reference percentage, not WB sales-mode/price
        // applicability. Keep this diagnostic separate from the dated B pack contract.
        throw Object.assign(new Error(`B_EVIDENCE_WB_COMMISSION_NOT_FORMAL: 本地费表尚不能形成正式利润证据，缺口：${reference.gaps.filter(gap=>gap.blocking).map(gap=>gap.code).join('、')}`), {
          code:'B_EVIDENCE_WB_COMMISSION_NOT_FORMAL',reference
        });
      }
      if (scope.platform !== 'ozon') throw Object.assign(new Error('B_EVIDENCE_COMMISSION_PLATFORM_UNSUPPORTED'), { code:'B_EVIDENCE_COMMISSION_PLATFORM_UNSUPPORTED' });
      const result = await postOzonEvidence({ request, kind: "commission", fetchImpl, ozonServiceUrl });
      if (result.status === "data_unavailable") {
        assertExactCommissionUnavailable(result, request, now().getTime());
        let officialGaps = null;
        if (officialReference) {
          const attempt = await readOfficialCommission(request, scope);
          if (attempt.pack) return attempt.pack;
          officialGaps = attempt.gaps;
        }
        try {
          assertEstimateScopeAndValidity(authorizedEstimate, request, now().getTime());
        } catch (error) {
          if (!officialGaps?.length) throw error;
          throw new Error(`${error.message}；官方佣金表未能成交：${officialGaps.join("、")}`);
        }
        const schema = await readSchema(request);
        const estimateTime = now();
        assertEstimateScopeAndValidity(authorizedEstimate, request, estimateTime.getTime());
        normalizeRelatedSchemaScope(request.scope, schema.scope);
        return {
          current: true,
          scope: structuredClone(request.scope),
          sourceType: "owner_authorized_commission_estimate",
          sourceRef: `${authorizedEstimate.authorizationRef}:${request.candidateId}:${request.candidateRevision}`,
          checkedAt: estimateTime.toISOString(),
          expiresAt: authorizedEstimate.effectiveTo === undefined ? schema.expiresAt :
            new Date(Math.min(Date.parse(schema.expiresAt), Date.parse(authorizedEstimate.effectiveTo))).toISOString(),
          evidenceData: {
            commissionRate: authorizedEstimate.commissionRate,
            commissionEvidenceMode: "estimated",
            commissionEstimateAuthorization: {
              schemaVersion: "commission-estimate-authorization-v1",
              candidateId: request.candidateId,
              candidateRevision: request.candidateRevision,
              authorizationRef: authorizedEstimate.authorizationRef,
              commissionRate: authorizedEstimate.commissionRate,
            },
            estimateAuthorized: true,
            exactCommissionRequiredAtC: true,
            descriptionCategoryId: schema.evidenceData.descriptionCategoryId,
            typeId: schema.evidenceData.typeId,
          },
        };
      }
      if (isObject(result.evidenceData) && Object.hasOwn(result.evidenceData, "otherCosts")) {
        throw new Error("B_EVIDENCE_COMMISSION_COSTS_UNEXPECTED: 佣金来源不得携带商品成本");
      }
      const exactTime = now().getTime();
      if (!Number.isFinite(exactTime) || result.evidenceData?.estimateAuthorized === true || result.evidenceData?.exactCommissionRequiredAtC === true ||
          (Object.hasOwn(result.evidenceData || {}, "commissionEvidenceMode") && result.evidenceData.commissionEvidenceMode !== "exact") ||
          !Number.isFinite(result.evidenceData?.commissionRate) || result.evidenceData.commissionRate < 0 || result.evidenceData.commissionRate >= 1 ||
          !Number.isFinite(Date.parse(result.checkedAt)) || Date.parse(result.checkedAt) > exactTime ||
          !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= exactTime) {
        throw new Error("B_EVIDENCE_COMMISSION_INVALID: 精确佣金数值、模式或时效无效");
      }
      return {
        ...result,
        evidenceData: {
          ...structuredClone(result.evidenceData),
          commissionEvidenceMode: "exact",
          estimateAuthorized: false,
          exactCommissionRequiredAtC: false,
        },
      };
    },
    schema: (request) => readSchema(request),
    logistics_tariff: (request) => readCurrentGuooTariff({
      scope: request.scope,
      filePath: guooFilePath,
      now,
    }),
    exchange_rate: (request) => readCurrentCbrExchangeRate({
      scope: request.scope,
      fetchImpl,
      now,
      sourceUrl: cbrSourceUrl,
    }),
  };
}

export function createLifecycleBRealEvidenceProviderRegistry(options) {
  return createLifecycleBEvidenceProviderRegistry(createLifecycleBRealEvidenceReaders(options));
}
