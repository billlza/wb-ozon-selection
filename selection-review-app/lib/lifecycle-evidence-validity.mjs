// Time validity only. Scope, source contents, costs and authorization remain the
// caller's separate checks; a usable result never grants production permission.
const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION = "lifecycle-evidence-validity-v1";
const PROVIDER_VERSION = "lifecycle-b-evidence-provider-v1.1";
const GENERATORS = Object.freeze({
  exchange_rate: "official-fx-reader:cbr-daily-v1",
  commission: "lifecycle-b-real-evidence-readers:official-commission-v1",
  schema: "ozon-evidence-connectors:current-schema-v1",
  logistics_tariff: "guoo-tariff-reader:2026-08-19-main-quote-v1"
});
// These identify historical producer arithmetic, not a newly approved refresh schedule.
const INTERNAL_REFRESH_INTERVALS = Object.freeze({ exchange_rate: DAY_MS, commission: DAY_MS, schema: DAY_MS,
  logistics_tariff: 7 * DAY_MS });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const time = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
  return new Date(parsed).toISOString() === canonical ? parsed : NaN;
};
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
function officialCommissionSource(value) {
  return typeof value === "string" && (/^https:\/\/docs\.ozon\.ru\/[^?#\s]+$/.test(value) ||
    /^https:\/\/cdn\.ozone\.ru\/s3\/ozon-disk-api\/global-education\/ru\/commissions\/ozon-fees\/comissions\/Tarifs_CN_[0-9_]+\.xlsx$/.test(value));
}

function knownGenerator(pack) {
  const data = pack.evidenceData;
  if (!object(data) || !object(pack.scope)) return null;
  if (pack.kind === "exchange_rate" && pack.sourceType === "bank_of_russia_official_daily_xml" &&
      String(pack.scope.pair).toUpperCase() === "RUB/CNY" && /^\d{4}-\d{2}-\d{2}$/.test(data.rateDate) &&
      Number.isFinite(time(`${data.rateDate}T00:00:00.000Z`)) &&
      pack.sourceRef === `cbr-xml-daily:R01375:${data.rateDate}` && positive(data.nominal) &&
      positive(data.officialValueRub) && data.rubPerCny === Number((data.officialValueRub / data.nominal).toFixed(6))) {
    return GENERATORS.exchange_rate;
  }
  // readCurrentGuooTariff assigns checkedAt + 7 days itself; the workbook does not
  // supply that expiry. Recognize only the reviewed workbook version and verified quote contract.
  if (pack.kind === "logistics_tariff" && pack.sourceType === "guoo_current_tariff_xlsx" &&
      pack.scope.ruleVersion === "guoo-2026-08-19" && pack.ruleVersion === pack.scope.ruleVersion &&
      typeof pack.scope.route === "string" && /^guoo [a-z][a-z ]*$/.test(pack.scope.route) &&
      /^guoo-xlsx:GUOO产品资费测算表【2026\.8\.19更新】\.xlsx:sha256:[a-f0-9]{64}:row-[1-9][0-9]{0,5}$/.test(pack.sourceRef) &&
      data.calculationRuleStatus === "main_sheet_quote_verified" &&
      ["actual_weight", "max_actual_volume"].includes(data.chargeableWeightRule) &&
      Number.isFinite(data.perKgRmb) && data.perKgRmb >= 0 && Number.isFinite(data.perParcelRmb) && data.perParcelRmb >= 0 &&
      data.minimumChargeableWeightKg === 0 && data.weightRoundingRule === "none" && data.weightRoundingKg === null) {
    return GENERATORS.logistics_tariff;
  }
  if (pack.scope.platform !== "ozon") return null;
  if (pack.kind === "schema" && pack.sourceType === "ozon_seller_api_current_schema" &&
      Number.isSafeInteger(data.descriptionCategoryId) && data.descriptionCategoryId > 0 &&
      Number.isSafeInteger(data.typeId) && data.typeId > 0 &&
      pack.scope.category === `ozon:${data.descriptionCategoryId}:${data.typeId}` &&
      pack.sourceRef === `ozon-seller-api:/v1/description-category/attribute:${data.descriptionCategoryId}:${data.typeId}` &&
      /^ozon-schema-[0-9a-f]{20}$/.test(data.schemaRevision) && Array.isArray(data.requiredFields) && Array.isArray(data.attributes)) {
    return GENERATORS.schema;
  }
  const ref = pack.commissionCatalogRef;
  if (pack.kind === "commission" && pack.sourceType === "ozon_official_commission_table" && object(ref) &&
      /^\d{4}-\d{2}-\d{2}$/.test(ref.effectiveFrom) && /^[0-9a-f]{64}$/.test(ref.fileSha256) &&
      officialCommissionSource(ref.sourceUrl) &&
      ["le1500", "1500_5000", "gt5000"].includes(ref.priceTier) &&
      object(ref.matchedRow) && ["typeRu", "typeZh", "mpCategoryZh"].every(key => typeof ref.matchedRow[key] === "string" && ref.matchedRow[key].trim()) &&
      pack.sourceRef === `ozon-official-commission:${ref.effectiveFrom}:sha256:${ref.fileSha256}:${ref.priceTier}` &&
      data.commissionEvidenceMode === "official_reference" && positive(data.commissionRate) &&
      data.officialCommissionBinding?.schemaVersion === "ozon-official-commission-binding-v1") {
    return GENERATORS.commission;
  }
  return null;
}

/** New producers declare why their existing expiry timestamp was assigned. */
export function createInternalEvidenceValidity(kind) {
  if (!Object.hasOwn(GENERATORS, kind)) throw new TypeError("EVIDENCE_VALIDITY_GENERATOR_UNSUPPORTED");
  return { schemaVersion: VERSION, expiryBasis: "internal_refresh_hint", generator: GENERATORS[kind] };
}

export function createSourceDeclaredEvidenceValidity(kind, sourceExpiresAt) {
  if (!Number.isFinite(time(sourceExpiresAt))) throw new TypeError("EVIDENCE_SOURCE_EXPIRY_INVALID");
  return { ...createInternalEvidenceValidity(kind), expiryBasis: "source_declared_limit", sourceExpiresAt: new Date(time(sourceExpiresAt)).toISOString() };
}

/** Recognize only the reviewed legacy generators, without rewriting their records. */
function expiryProvenance(pack) {
  const generator = knownGenerator(pack);
  const interval = time(pack.expiresAt) - time(pack.checkedAt);
  const internalInterval = INTERNAL_REFRESH_INTERVALS[pack.kind];
  if (Object.hasOwn(pack, "validity")) {
    const value = pack.validity;
    if (!object(value) || value.schemaVersion !== VERSION || value.generator !== generator || !generator) return null;
    const keys = value.expiryBasis === "source_declared_limit"
      ? ["schemaVersion", "expiryBasis", "generator", "sourceExpiresAt"] : ["schemaVersion", "expiryBasis", "generator"];
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return null;
    if (value.expiryBasis === "internal_refresh_hint" && interval === internalInterval) return { expiryBasis: value.expiryBasis, provenance: "declared_generator" };
    if (value.expiryBasis === "source_declared_limit" && time(value.sourceExpiresAt) > time(pack.checkedAt) &&
        time(pack.expiresAt) === Math.min(time(pack.checkedAt) + internalInterval, time(value.sourceExpiresAt))) {
      return { expiryBasis: value.expiryBasis, provenance: "declared_source", limit: time(value.sourceExpiresAt) };
    }
    return null;
  }
  if (generator && interval === internalInterval && pack.providerVersion === PROVIDER_VERSION &&
      new RegExp(`^b-evidence:${pack.kind}:[0-9a-f]{20}$`).test(pack.id)) {
    return { expiryBasis: "internal_refresh_hint", provenance: "recognized_legacy_generator" };
  }
  return { expiryBasis: "unclassified_limit", provenance: "legacy_unclassified", limit: time(pack.expiresAt) };
}

export function isLifecycleEvidenceValidityMetadataValid(pack) {
  return object(pack) && (!Object.hasOwn(pack, "validity") || expiryProvenance(pack) !== null);
}

/** Pure, repeatable interpretation. No network calls, mutation or invented lifetime. */
export function inspectLifecycleEvidenceValidity(pack, { asOf } = {}) {
  const result = (usable, status, reason, details = {}) => ({ usable, status, reason, expiryBasis: null, provenance: null, ...details });
  if (!object(pack)) return result(false, "invalid", "证据记录无效");
  if (pack.status !== "active" || pack.current === false || pack.invalidatedAt != null || pack.changedAt != null) {
    return result(false, "invalidated", "证据已失效、被替代或已记录变化");
  }
  const checked = time(pack.checkedAt), at = typeof asOf === "number" ? asOf : time(asOf), expires = time(pack.expiresAt);
  if (!Number.isFinite(checked) || !Number.isFinite(at) || checked > at) return result(false, "invalid", "取得时间或检查时间无效");
  const provenance = expiryProvenance(pack);
  if (!provenance || pack.expiresAt !== null && (!Number.isFinite(expires) || expires <= checked)) return result(false, "invalid", "证据期限来源或时间合同无效");
  // Existing WB catalog records explicitly permit an unknown source end date;
  // the catalog-version check remains mandatory in its domain validator.
  if (pack.expiresAt === null) {
    return pack.kind === "commission" && pack.sourceType === "wb_official_commission_reference" && !Object.hasOwn(pack, "validity")
      ? result(true, "current", "来源未声明结束时间，仍须核对当前目录版本", provenance)
      : result(false, "invalid", "证据结束时间缺失", provenance);
  }
  if (provenance.expiryBasis === "internal_refresh_hint") return expires <= at
    ? result(true, "refresh_due", "已到软件复查提示时间；主动复查周期尚未决定，不能据此判定来源失效", provenance)
    : result(true, "current", "软件复查提示时间尚未到达，仍须核对来源及适用范围", provenance);
  return provenance.limit <= at
    ? result(false, "expired", "已超过来源明确期限或尚未识别来源的保守期限", provenance)
    : result(true, "current", "尚未超过证据期限，仍须核对来源及适用范围", provenance);
}
