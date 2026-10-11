import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { parseWorksheetRows } from "./guoo-tariff-reader.mjs";

/**
 * CEL 产品资费表里的 WB 那一页（主人 2026-10-11 在项目里上传了 V7.24）。只读这一页，Ozon 那几页本项目仍用 GUOO 表。
 *
 * 表是物流商给的原文，这里只按它写死的版式读三行：陆空联运 Wb-Express、陆运 Wb-Economy 的 ≤0.3kg 和 ＞0.3kg≤20kg 两档。
 * 版式对不上（多一行、少一档、费用写法变了）就报错停下，不猜。读出来的行和 GUOO 目录同一个形状，粗算直接能用；
 * 它只是物流商报价，不是正式利润证据，也不说明这是 CEL 当前最新的表。
 *
 * 文件不进代码仓库（仓库是公开的）：默认放在 data/logistics/ 下（已在 .gitignore 里），也可以用
 * SELECTION_REVIEW_CEL_TARIFF_FILE 指到别处。
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CEL_TARIFF_PATH = path.join(PROJECT_ROOT, "data", "logistics", "CEL产品资费表V7.24.xlsx");
export const CEL_WB_SHEET_NAME = "WB";
export const CEL_WB_TARIFF_CATALOG_SCHEMA = "cel-wb-tariff-catalog-v1";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const HEADER = Object.freeze({ 1: "渠道", 2: "网点", 3: "时效（天）", 4: "产品", 5: "包裹限重（kg）", 6: "尺寸限制", 7: "费用" });
const ROUNDING_HEADER = "百克进位计费重量（kg）";

export class CelTariffError extends Error {
  constructor(code, detail = "", cause) {
    super(`CEL_TARIFF_${code}${detail ? `: ${detail}` : ""}`, cause === undefined ? undefined : { cause });
    this.name = "CelTariffError";
    this.code = `CEL_TARIFF_${code}`;
  }
}
const fail = (code, detail) => { throw new CelTariffError(code, detail); };

/** 「CEL产品资费表 V7.24.xlsx」→「cel-v7.24」；文件名里没有版本号就不认。 */
export function celTariffRuleVersionFromPath(filePath = DEFAULT_CEL_TARIFF_PATH) {
  const match = path.basename(String(filePath)).match(/V\s*(\d+(?:\.\d+)+)/i);
  if (!match) fail("VERSION_MISSING", "文件名没有资费表版本号");
  return `cel-v${match[1]}`;
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** xlsx 就是一个 zip。和 GUOO 读表一样只用 Node 自带的 zlib，不调外部 unzip。 */
function readArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ARCHIVE_BYTES) fail("ARCHIVE_INVALID");
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65535); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) fail("ARCHIVE_INVALID");
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count > 10000 || offset + size > eocd) fail("ARCHIVE_INVALID");
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) fail("ARCHIVE_INVALID");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (!name || entries.has(name)) fail("ARCHIVE_INVALID");
    entries.set(name, { method: buffer.readUInt16LE(offset + 10), compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24), localOffset: buffer.readUInt32LE(offset + 42) });
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return entries;
}

function entryText(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) fail("ARCHIVE_ENTRY_MISSING", name);
  const local = entry.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50 || entry.uncompressedSize > MAX_ENTRY_BYTES) fail("ARCHIVE_INVALID");
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  if (compressed.length !== entry.compressedSize) fail("ARCHIVE_INVALID");
  const data = entry.method === 0 ? compressed : entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES }) : fail("ARCHIVE_INVALID");
  if (data.length !== entry.uncompressedSize) fail("ARCHIVE_INVALID");
  return data.toString("utf8");
}

function sheetXml(buffer, sheetName) {
  const entries = readArchive(buffer);
  const workbook = entryText(buffer, entries, "xl/workbook.xml");
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)].map(match => match[1])
    .filter(attributes => decodeXmlEntities(attributes.match(/\bname="([^"]+)"/)?.[1]) === sheetName);
  if (sheets.length !== 1) fail("SHEET_MISSING", `找不到唯一的「${sheetName}」工作表`);
  const id = sheets[0].match(/\br:id="([^"]+)"/)?.[1];
  const relation = [...entryText(buffer, entries, "xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*)\/?\s*>/g)]
    .map(match => match[1]).filter(attributes => attributes.match(/\bId="([^"]+)"/)?.[1] === id);
  const target = relation.length === 1 ? decodeXmlEntities(relation[0].match(/\bTarget="([^"]+)"/)?.[1]) : "";
  if (!id || !/^(?:\/xl\/|(?:\.\/)?)worksheets\/sheet[1-9][0-9]*\.xml$/u.test(target)) fail("SHEET_RELATION_INVALID");
  const strings = entries.has("xl/sharedStrings.xml")
    ? [...entryText(buffer, entries, "xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
      .map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(part => decodeXmlEntities(part[1].replace(/<[^>]+>/g, ""))).join(""))
    : [];
  const entry = target.startsWith("/xl/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  return { xml: entryText(buffer, entries, entry), strings };
}

const cellText = value => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : null);
const flat = value => (typeof value === "string" ? value.replace(/\s+/g, "") : "");
const number = text => Number(String(text).replace(/[＞>≤<=]/g, ""));

/** 「≤20kg」→ 0 到 20；「＞0.3kg≤20kg」→ 下限不含 0.3。和 GUOO 一样写成「最小-最大KG」，下限不含时另外标出来。 */
function weightBand(text) {
  const value = flat(text).toLowerCase();
  let match = value.match(/^≤(\d+(?:\.\d+)?)kg$/u);
  if (match) return { weightLimit: `0-${match[1]}KG`, weightMinExclusive: false };
  match = value.match(/^[＞>](\d+(?:\.\d+)?)kg≤(\d+(?:\.\d+)?)kg$/u);
  if (match && number(match[1]) < number(match[2])) return { weightLimit: `${match[1]}-${match[2]}KG`, weightMinExclusive: true };
  return fail("LAYOUT_UNSUPPORTED", `包裹限重「${text}」认不出来`);
}

/** 「三边之和不超过200厘米 单边不超过115厘米」→ 粗算认的写法「三边之和不超200CM，单边最大尺寸不超115CM」。 */
function sizeLimit(text) {
  const value = flat(text);
  const sum = value.match(/三边之和不超过(\d+(?:\.\d+)?)厘米/u)?.[1];
  const side = value.match(/单边不超过(\d+(?:\.\d+)?)厘米/u)?.[1];
  if (!sum || !side) fail("LAYOUT_UNSUPPORTED", `尺寸限制「${text}」认不出来`);
  return `三边之和不超${sum}CM，单边最大尺寸不超${side}CM`;
}

/** 「43元/kg+8元/票」→ 每公斤 43、每票 8。 */
function fee(text) {
  const match = flat(text).match(/^(\d+(?:\.\d+)?)元\/kg\+(\d+(?:\.\d+)?)元\/票$/iu);
  if (!match) fail("LAYOUT_UNSUPPORTED", `费用「${text}」认不出来`);
  return { perKgRmb: Number(match[1]), perParcelRmb: Number(match[2]) };
}

/** 「陆运\n（Wb-Economy)」→「Wb-Economy」。 */
function service(text) {
  const match = String(text || "").match(/[（(]\s*(Wb-[A-Za-z]+)\s*[)）]/u);
  if (!match) fail("LAYOUT_UNSUPPORTED", `渠道「${cellText(text)}」认不出来`);
  return match[1];
}

/** WB 那一页的三档报价，行的形状和 readGuooTariffCatalog 的 rows 一致。 */
export async function readCelWbTariffCatalog({ filePath = DEFAULT_CEL_TARIFF_PATH, readFileImpl = readFile, now = () => new Date() } = {}) {
  const ruleVersion = celTariffRuleVersionFromPath(filePath);
  const buffer = await readFileImpl(filePath);
  const { xml, strings } = sheetXml(buffer, CEL_WB_SHEET_NAME);
  let rows;
  try { rows = parseWorksheetRows(xml, strings); }
  catch (error) { throw new CelTariffError("WORKSHEET_INVALID", "", error); }
  const title = cellText(rows[1]?.[1]) ?? "";
  if (!/wildberries/i.test(title) || !title.includes("CEL")) fail("LAYOUT_UNSUPPORTED", "第一行不是 wildberries 的 CEL 运费表");
  for (const [column, label] of Object.entries(HEADER)) {
    if (cellText(rows[2]?.[column]) !== label) fail("LAYOUT_UNSUPPORTED", `表头第 ${column} 列应为「${label}」`);
  }
  if (cellText(rows[2]?.[9]) !== ROUNDING_HEADER) fail("LAYOUT_UNSUPPORTED", "没有「百克进位」那一列，计费重量的进位方式不明");
  const sourceRef = `cel-xlsx:${path.basename(filePath)}:sha256:${createHash("sha256").update(buffer).digest("hex")}`;
  const catalog = [];
  const sourceNotes = [];
  for (let rowNumber = 3; rowNumber < rows.length; rowNumber += 1) {
    const row = rows[rowNumber];
    if (!row) continue;
    const feeText = cellText(row[7]);
    if (feeText === null) {
      const note = cellText(row[1]);
      if (note !== null) sourceNotes.push({ sheetName: CEL_WB_SHEET_NAME, cellRef: `A${rowNumber}`, text: note });
      continue;
    }
    const days = row[3];
    if (!(typeof days === "number" && Number.isInteger(days) && days > 0)) fail("LAYOUT_UNSUPPORTED", `第 ${rowNumber} 行时效不是天数`);
    const name = service(row[1]);
    const network = cellText(row[2]);
    if (network === null) fail("LAYOUT_UNSUPPORTED", `第 ${rowNumber} 行没有网点`);
    catalog.push({
      rowNumber,
      route: `CEL ${name}`,
      service: name,
      network,
      // 「珲春仓备货」是先把货备到珲春仓再发，单件从国内直发的粗算不该用它。
      requiresPrestock: network.includes("备货"),
      transitDays: days,
      delivery: cellText(row[4]),
      evidenceData: {
        chargeableWeightRule: "actual_weight",
        ...fee(feeText),
        minimumChargeableWeightKg: 0,
        weightRoundingRule: "step",
        weightRoundingKg: 0.1,
        ...weightBand(cellText(row[5]) ?? ""),
        sizeLimit: sizeLimit(cellText(row[6]) ?? ""),
        declaredValueLimitRub: null,
        tariffText: feeText
      },
      sourceRefs: { route: `A${rowNumber}`, weightLimit: `E${rowNumber}`, sizeLimit: `F${rowNumber}`, fee: `G${rowNumber}` }
    });
  }
  const services = catalog.map(row => `${row.service}:${row.evidenceData.weightLimit}`).sort();
  if (catalog.length !== 3 || services.join("|") !== ["Wb-Economy:0-0.3KG", "Wb-Economy:0.3-20KG", "Wb-Express:0-20KG"].join("|")) {
    fail("LAYOUT_UNSUPPORTED", "WB 页应当正好是 Express 一档、Economy 两档");
  }
  return { schemaVersion: CEL_WB_TARIFF_CATALOG_SCHEMA, ruleVersion, sourceRef, sheetName: CEL_WB_SHEET_NAME,
    quoteScope: "cel_wb_sheet_quote", quoteScopeDescription: "CEL 资费表 WB 页的报价原文；不含平台佣金、退货等费用，也不说明是 CEL 当前最新的表。",
    observedAt: now().toISOString(), sourceNotes, rows: catalog };
}
