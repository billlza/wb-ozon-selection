import { createInternalEvidenceValidity } from "./lifecycle-evidence-validity.mjs";

function normalized(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function xmlValue(block, tag) {
  return block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, "u"))?.[1] || "";
}

function parseCbrDate(value) {
  const match = String(value || "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

export async function readCurrentCbrExchangeRate({
  scope,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  sourceUrl = "https://www.cbr.ru/scripts/XML_daily.asp",
} = {}) {
  if (normalized(scope?.pair) !== "RUB/CNY") {
    throw new Error("CBR_FX_PAIR_UNSUPPORTED: 当前只支持RUB/CNY");
  }
  const response = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`CBR_FX_READ_FAILED: HTTP ${response.status}`);
  const xml = new TextDecoder("windows-1251").decode(Buffer.from(await response.arrayBuffer()));
  const rateDate = parseCbrDate(xml.match(/<ValCurs\b[^>]*Date="([^"]+)"/u)?.[1]);
  const block = xml.match(/<Valute ID="R01375">([\s\S]*?)<\/Valute>/u)?.[1] || "";
  const nominal = Number(xmlValue(block, "Nominal"));
  const value = Number(xmlValue(block, "Value").replace(",", "."));
  if (!rateDate || !(nominal > 0) || !(value > 0)) {
    throw new Error("CBR_FX_DATA_INVALID: 俄罗斯央行未返回有效人民币汇率");
  }
  const checkedAt = now().toISOString();
  return {
    current: true,
    scope: { pair: String(scope.pair).trim() },
    sourceType: "bank_of_russia_official_daily_xml",
    sourceRef: `cbr-xml-daily:R01375:${rateDate}`,
    checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + 24 * 60 * 60 * 1000).toISOString(),
    validity: createInternalEvidenceValidity("exchange_rate"),
    evidenceData: {
      rubPerCny: Number((value / nominal).toFixed(6)),
      rateDate,
      nominal,
      officialValueRub: value,
    },
  };
}
