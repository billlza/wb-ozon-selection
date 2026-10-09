import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";

const execFile = promisify(execFileCallback);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_GUOO_TARIFF_PATH = path.join(
  PROJECT_ROOT,
  "data",
  "logistics",
  "GUOO产品资费测算表【2026.8.19更新】.xlsx",
);
const SHEET_NAME = "GUOO realFBS资费试算表";
const SIZE_SOURCE_SHEET = "GUOO FBP资费试算表";
const MAX_WORKSHEET_ROWS = 100_000;
const MAX_WORKSHEET_CELLS = 200_000;
const FORMULA_CELL = Symbol("unsupported Excel formula cell");

function decodeXml(value) {
  return decodeXmlEntities(String(value || "").replace(/<[^>]+>/g, ""));
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

function routeIdentity(value) {
  return normalized(value).replace(/\b(?:pudo|courier)\b/g, "").replace(/\s+/g, " ").trim();
}

function chargeableWeightRuleForProductType(productType) {
  // Explicit historical workbook product labels only. This keeps the existing
  // calculation mapping bounded; it does not attest current tariff validity.
  const knownTypes = new Map([
    ["extra small", "actual_weight"], ["extra small 超级轻小件", "actual_weight"],
    ["budget", "actual_weight"], ["budget 低客单轻小件", "actual_weight"],
    ["small", "actual_weight"], ["small 小件", "actual_weight"],
    ["big", "max_actual_volume"], ["big 大件", "max_actual_volume"],
    ["premium small", "actual_weight"], ["premium small 高客单轻小件", "actual_weight"],
    ["premium big", "max_actual_volume"], ["premium big 高客单大件", "max_actual_volume"],
  ]);
  const rule = knownTypes.get(normalized(productType));
  if (rule === undefined) throw new Error("GUOO_TARIFF_PRODUCT_TYPE_UNSUPPORTED: 产品类型缺失或未识别，不能推定计费规则");
  return rule;
}

function columnNumber(reference) {
  const letters = String(reference).match(/^[A-Z]+/)?.[0] || "";
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
}

function sharedStrings(xml) {
  return [...String(xml || "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((match) => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((part) => decodeXml(part[1]))
      .join(""));
}

function cellValue(cellXml, type, strings) {
  if (type === "inlineStr") {
    return [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
  }
  const raw = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (raw === undefined) return null;
  if (type === "s") return strings[Number(raw)] ?? null;
  if (type === "str") return decodeXml(raw);
  const number = Number(raw);
  return Number.isFinite(number) ? number : decodeXml(raw);
}

function parseWorksheet(xml, strings = []) {
  const rows = [];
  const formulasByCell = new Map();
  const originsByCell = new Map();
  const formulaRanges = [];
  let cellCount = 0;
  for (const rowMatch of String(xml || "").matchAll(/<row\b[^>]*\br="(\d+)"[^>]*?(?:\/\s*>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(rowMatch[1]);
    if (rowNumber < 1 || rowNumber > MAX_WORKSHEET_ROWS || rows[rowNumber]) {
      throw new Error("GUOO_TARIFF_WORKSHEET_INVALID: 重复或超出范围的行");
    }
    const cells = {};
    for (const cellMatch of (rowMatch[2] || "").matchAll(/<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1];
      const reference = attributes.match(/\br="([A-Z]+\d+)"/)?.[1];
      if (!reference) continue;
      const type = attributes.match(/\bt="([^"]+)"/)?.[1] || "";
      const column = columnNumber(reference);
      cellCount += 1;
      if (Number(reference.match(/\d+$/)[0]) !== rowNumber || column > 16384 ||
          Object.hasOwn(cells, column) || cellCount > MAX_WORKSHEET_CELLS) {
        throw new Error("GUOO_TARIFF_WORKSHEET_INVALID: 重复、错行或超出范围的单元格");
      }
      const cellXml = cellMatch[2] || "";
      originsByCell.set(`${rowNumber}:${column}`, reference);
      const formulas = cellXml.matchAll(/<(?:[^\s<>/:]+:)?f(?=[\s/>])([^>]*)>/gu);
      const formula = formulas.next().value;
      if (formula) {
        if (!formulas.next().done) throw new Error("GUOO_TARIFF_WORKSHEET_INVALID: 单格不能有多个公式元素");
        // Never interpret a formula or its cached value as a direct workbook fact.
        cells[column] = FORMULA_CELL;
        // Only an ordinary, explicit formula can be considered for a bounded
        // same-workbook reference. Shared, array and namespaced formulas stay opaque.
        const directFormula = cellXml.match(/<f\s*>([^<]*)<\/f>/u);
        if (directFormula) formulasByCell.set(reference, decodeXmlEntities(directFormula[1]));
        const referenceRange = formula[1].match(/\bref\s*=\s*(["'])(.*?)\1/)?.[2];
        if (referenceRange !== undefined) {
          const range = referenceRange.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
          if (!range) throw new Error("GUOO_TARIFF_WORKSHEET_INVALID: 公式范围无效");
          const firstColumn = columnNumber(range[1]), lastColumn = columnNumber(range[3] || range[1]);
          const firstRow = Number(range[2]), lastRow = Number(range[4] || range[2]);
          const size = (lastRow - firstRow + 1) * (lastColumn - firstColumn + 1);
          if (firstRow < 1 || lastRow < firstRow || lastRow > MAX_WORKSHEET_ROWS || lastColumn < firstColumn || lastColumn > 16384 ||
              rowNumber < firstRow || rowNumber > lastRow || column < firstColumn || column > lastColumn ||
              size + cellCount > MAX_WORKSHEET_CELLS) {
            throw new Error("GUOO_TARIFF_WORKSHEET_INVALID: 公式范围无效或超出上限");
          }
          cellCount += size;
          formulaRanges.push({ firstColumn, lastColumn, firstRow, lastRow });
        }
      } else {
        cells[column] = cellValue(cellXml, type, strings);
      }
    }
    rows[rowNumber] = cells;
  }
  // Shared/array formulas also own covered cells that contain only cached values.
  for (const range of formulaRanges) {
    for (let row = range.firstRow; row <= range.lastRow; row += 1) {
      rows[row] ||= {};
      for (let column = range.firstColumn; column <= range.lastColumn; column += 1) rows[row][column] = FORMULA_CELL;
    }
  }
  // Inherit only explicit XLSX merged cells, never a blank cell in an unrelated row.
  const mergedCells = new Set();
  for (const match of String(xml || "").matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*\/?\s*>/g)) {
    const firstColumn = columnNumber(match[1]), lastColumn = columnNumber(match[3]);
    const firstRow = Number(match[2]), lastRow = Number(match[4]);
    if (firstRow < 1 || lastRow < firstRow || lastRow > MAX_WORKSHEET_ROWS || lastColumn < firstColumn || lastColumn > 16384 ||
        (lastRow - firstRow + 1) * (lastColumn - firstColumn + 1) + cellCount > MAX_WORKSHEET_CELLS) {
      throw new Error("GUOO_TARIFF_WORKSHEET_INVALID: 合并范围无效");
    }
    const anchor = rows[firstRow]?.[firstColumn];
    for (let row = firstRow; row <= lastRow; row += 1) {
      rows[row] ||= {};
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const key = `${row}:${column}`;
        if (mergedCells.has(key) || (rows[row][column] != null && rows[row][column] !== anchor)) {
          throw new Error("GUOO_TARIFF_WORKSHEET_INVALID: 合并单元格重叠或值冲突");
        }
        mergedCells.add(key);
        cellCount += 1;
        rows[row][column] = anchor;
        originsByCell.set(key, originsByCell.get(`${firstRow}:${firstColumn}`) || `${match[1]}${firstRow}`);
      }
    }
  }
  return { rows, formulasByCell, originsByCell };
}

export function parseWorksheetRows(xml, strings = []) {
  return parseWorksheet(xml, strings).rows;
}

export function guooTariffRuleVersionFromPath(filePath = DEFAULT_GUOO_TARIFF_PATH) {
  const match = path.basename(filePath).match(/(20\d{2})[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (!match) throw new Error("GUOO_TARIFF_VERSION_MISSING: 文件名没有可验证的资费日期");
  return `guoo-${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function numeric(value, label) {
  const number = value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new Error(`GUOO_TARIFF_FIELD_INVALID: ${label}不是有效数字`);
  return number;
}

const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024;

// The workbook is a plain ZIP container. Reading it with Node's own zlib keeps the reader identical on every host
// (the CI container has no /usr/bin/unzip); an injected execFileImpl keeps the historical unzip-emulating tests valid.
async function readWorkbookArchive(filePath, readFileImpl = readFile) {
  const buffer = await readFileImpl(filePath);
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65535); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > 10000 || directoryOffset + directorySize > eocd) throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
  const entries = new Map();
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (!name || entries.has(name) || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
    }
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { buffer, entries };
}

function archiveEntryText(archive, name) {
  const entry = archive.entries.get(name);
  if (!entry) throw new Error(`GUOO_TARIFF_ARCHIVE_ENTRY_MISSING: ${name}`);
  const { buffer } = archive, local = entry.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length || entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
  const compressed = buffer.subarray(start, end);
  let data;
  if (entry.method === 0) data = compressed;
  else if (entry.method === 8) data = inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_ENTRY_BYTES });
  else throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
  if (data.length !== entry.uncompressedSize) throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
  return data.toString("utf8");
}

async function unzipEntry(filePath, entry, execFileImpl, archive) {
  if (typeof execFileImpl !== "function") return archiveEntryText(archive, entry);
  const { stdout } = await execFileImpl("/usr/bin/unzip", ["-p", filePath, entry], {
    encoding: "utf8",
    maxBuffer: MAX_ARCHIVE_ENTRY_BYTES,
  });
  return stdout;
}

async function workbookParts(filePath, execFileImpl, readFileImpl = readFile) {
  let members, archive = null;
  if (typeof execFileImpl === "function") {
    const { stdout } = await execFileImpl("/usr/bin/unzip", ["-Z1", filePath], {
      encoding: "utf8", maxBuffer: MAX_ARCHIVE_ENTRY_BYTES,
    });
    if (typeof stdout !== "string") throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
    const entries = stdout.split(/\r?\n/u).filter(Boolean);
    if (entries.length > 10000 || new Set(entries).size !== entries.length) throw new Error("GUOO_TARIFF_ARCHIVE_INVALID");
    members = new Set(entries);
  } else {
    archive = await readWorkbookArchive(filePath, readFileImpl);
    members = new Set(archive.entries.keys());
  }
  const [workbook, relations, stringsXml] = await Promise.all([
    unzipEntry(filePath, "xl/workbook.xml", execFileImpl, archive),
    unzipEntry(filePath, "xl/_rels/workbook.xml.rels", execFileImpl, archive),
    members.has("xl/sharedStrings.xml") ? unzipEntry(filePath, "xl/sharedStrings.xml", execFileImpl, archive) : "",
  ]);
  return { workbook, relations, strings: sharedStrings(stringsXml), members, archive };
}

async function worksheetData(filePath, parts, sheetName, execFileImpl) {
  if (![SHEET_NAME, SIZE_SOURCE_SHEET].includes(sheetName)) throw new Error("GUOO_TARIFF_SHEET_REJECTED");
  const sheets = [...parts.workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)]
    .map(match => match[1]).filter(attributes => decodeXmlEntities(attributes.match(/\bname="([^"]+)"/)?.[1]) === sheetName);
  if (sheets.length !== 1) throw new Error("GUOO_TARIFF_SHEET_MISSING: 找不到唯一资费工作表");
  const id = sheets[0].match(/\br:id="([^"]+)"/)?.[1];
  const relations = [...parts.relations.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)]
    .map((match) => match[1])
    .filter(attributes => attributes.match(/\bId="([^"]+)"/)?.[1] === id);
  if (!id || relations.length !== 1) throw new Error("GUOO_TARIFF_SHEET_RELATION_MISSING");
  const attributes = relations[0], target = decodeXmlEntities(attributes.match(/\bTarget="([^"]+)"/)?.[1]);
  const targetMode = attributes.match(/\bTargetMode="([^"]+)"/)?.[1];
  const relationType = attributes.match(/\bType="([^"]+)"/)?.[1];
  if ((targetMode !== undefined && targetMode !== "Internal") ||
      (relationType !== undefined && relationType !== "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet") ||
      !/^(?:\/xl\/|(?:\.\/)?)(?:worksheets\/sheet[1-9][0-9]*\.xml)$/u.test(target)) {
    throw new Error("GUOO_TARIFF_SHEET_RELATION_REJECTED");
  }
  const entry = target.startsWith("/xl/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  if (!parts.members.has(entry)) throw new Error("GUOO_TARIFF_SHEET_RELATION_MISSING");
  return parseWorksheet(await unzipEntry(filePath, entry, execFileImpl, parts.archive), parts.strings);
}

export function selectGuooTariffRow(rows, requestedRoute) {
  const requested = routeIdentity(requestedRoute);
  if (!requested) throw new Error("GUOO_TARIFF_ROUTE_MISSING");
  const candidates = [];
  for (let rowNumber = 10; rowNumber <= 24; rowNumber += 1) {
    const row = rows[rowNumber] || {};
    if (row[3] === FORMULA_CELL) throw new Error("GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED: 线路定位不能使用公式缓存");
    const routeCell = String(row[3] || "").trim();
    if (!routeCell) continue;
    const firstEnglishLine = routeCell.split(/\r?\n/).find((line) => /^GUOO\s+/i.test(line.trim())) || "";
    if (routeIdentity(firstEnglishLine) !== requested) continue;
    if ([2, 4, 7, 8, 9, 10, 11, 12].some(column => row[column] === FORMULA_CELL)) {
      throw new Error("GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED: 当前线路资费或规则不能使用公式缓存");
    }
    const productType = String(row[2] ?? "").trim();
    const weightLimit = String(row[7] ?? "").trim();
    const declaredValueLimit = String(row[8] ?? "").trim();
    const sizeLimit = String(row[9] ?? "").trim();
    candidates.push({ rowNumber, row, productType, weightLimit, declaredValueLimit, sizeLimit, routeCell });
  }
  if (candidates.length !== 1) {
    throw new Error(candidates.length
      ? "GUOO_TARIFF_ROUTE_AMBIGUOUS: 当前线路匹配到多条资费"
      : "GUOO_TARIFF_ROUTE_NOT_FOUND: 当前表格没有该精确线路");
  }
  return candidates[0];
}

function sizeTextReferences(formula) {
  if (typeof formula !== "string" || formula.length > 160) throw new Error("GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED: 尺寸规则不是允许的文本引用");
  const terms = formula.split("&");
  if (terms.length < 1 || terms.length > 2) throw new Error("GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED: 尺寸规则引用数量不支持");
  const references = terms.map(term => {
    const match = term.match(/^'GUOO FBP资费试算表'!\$?([A-Z]{1,3})\$?([1-9][0-9]{0,4})$/u);
    if (!match || columnNumber(match[1]) > 16384) throw new Error("GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED: 尺寸规则不是允许的单格文本引用");
    return { cellRef: `${match[1]}${match[2]}`, column: columnNumber(match[1]), row: Number(match[2]) };
  });
  // These two ordered concatenations are present in the adopted workbook. This
  // is text assembly, not an Excel evaluator or an arbitrary reference chain.
  if (references.length === 2 && !["I10,J10", "I20,J20"].includes(references.map(value => value.cellRef).join(","))) {
    throw new Error("GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED: 尺寸规则文本拼接未在表内确认");
  }
  return references;
}

async function resolveSelectedSizeReference({ filePath, parts, worksheet, requestedRoute = null, execFileImpl }) {
  const requested = requestedRoute === null ? null : routeIdentity(requestedRoute);
  const sources = new Map();
  let referenceSheet = null;
  for (let rowNumber = 10; rowNumber <= 24; rowNumber += 1) {
    const row = worksheet.rows[rowNumber];
    if (!row || typeof row[3] !== "string") continue;
    const route = row[3].split(/\r?\n/u).find(line => /^GUOO\s+/i.test(line.trim()));
    if (requested !== null && routeIdentity(route) !== requested) continue;
    const origin = worksheet.originsByCell.get(`${rowNumber}:9`);
    if (row[9] !== FORMULA_CELL) {
      if (typeof row[9] === "string" && row[9].trim()) sources.set(rowNumber, [{ sheetName: SHEET_NAME, cellRef: origin }]);
      continue;
    }
    const formula = worksheet.formulasByCell.get(origin);
    const references = sizeTextReferences(formula);
    if (referenceSheet === null) referenceSheet = await worksheetData(filePath, parts, SIZE_SOURCE_SHEET, execFileImpl);
    const fragments = references.map(reference => {
      const key = `${reference.row}:${reference.column}`;
      const value = referenceSheet.rows[reference.row]?.[reference.column];
      if (value === FORMULA_CELL) throw new Error("GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED: 尺寸规则引用不能包含公式");
      if (typeof value !== "string" || !value.trim() || value.length > 4000) {
        throw new Error("GUOO_TARIFF_FIELD_INVALID: 尺寸规则引用不是直接文本");
      }
      if (referenceSheet.originsByCell.get(key) !== reference.cellRef) {
        throw new Error("GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED: 尺寸规则引用必须指向直接文本单元格");
      }
      return value;
    });
    row[9] = fragments.join("");
    sources.set(rowNumber, references.map(reference => ({ sheetName: SIZE_SOURCE_SHEET, cellRef: reference.cellRef })));
  }
  return sources;
}

function projectTariffFields(selected, sizeSources) {
  const chargeableWeightRule = chargeableWeightRuleForProductType(selected.productType);
  const sizeLimitSources = sizeSources.get(selected.rowNumber) ?? [];
  return {
    chargeableWeightRule,
    perKgRmb: numeric(selected.row[11], "每公斤资费"),
    perParcelRmb: numeric(selected.row[12], "每票资费"),
    // The adopted main-sheet quote has no minimum billing weight and no rounding: the
    // cell-checked E-column expression bills F5 (the chargeable weight) straight at K/L.
    minimumChargeableWeightKg: 0,
    weightRoundingRule: "none",
    weightRoundingKg: null,
    ...(chargeableWeightRule === "max_actual_volume" ? { volumeDivisorCm3PerKg: 12000 } : {}),
    productType: selected.productType,
    weightLimit: selected.weightLimit,
    declaredValueLimitRub: selected.declaredValueLimit,
    sizeLimit: selected.sizeLimit,
    sizeLimitSource: sizeLimitSources.length === 1 ? sizeLimitSources[0] : null,
    sizeLimitSources,
    batteryTransportRule: String(selected.row[10] || "").trim(),
    transportMethod: String(selected.row[4] || "").trim(),
    tariffFormula: selected.row[6] === FORMULA_CELL || selected.row[6] == null ? null : String(selected.row[6]).trim(),
    tariffFormulaSourceStatus: selected.row[6] === FORMULA_CELL ? "display_formula_not_evaluated" :
      selected.row[6] == null ? "missing" : "direct_literal",
  };
}

function catalogRowSources(worksheet, rowNumber, sizeSources) {
  const source = column => {
    const cellRef = worksheet.originsByCell.get(`${rowNumber}:${column}`);
    return cellRef === undefined ? null : { sheetName: SHEET_NAME, cellRef };
  };
  return { productType: source(2), weightLimit: source(7), salePriceLimit: source(8),
    sizeLimit: sizeSources.get(rowNumber) ?? [], batteryTransportRule: source(10), perKgRmb: source(11), perParcelRmb: source(12) };
}

function catalogUnresolvedRules(worksheet, selected) {
  const sourceCell = cellRef => ({ sheetName: SHEET_NAME, cellRef });
  const rules = [];
  const priceFormula = worksheet.formulasByCell.get(`E${selected.rowNumber}`);
  const weight = selected.weightLimit;
  if (typeof priceFormula === "string" && /^0\.501-/u.test(weight) && /(?:^|[, (])D5<0\.5[,)]/u.test(priceFormula)) {
    rules.push({ code: "WEIGHT_LOWER_BOUND_CONFLICT", sourceCells: [sourceCell(`E${selected.rowNumber}`), sourceCell(worksheet.originsByCell.get(`${selected.rowNumber}:7`))],
      message: "重量文字下限为0.501kg，但试算表达式允许0.5kg。" });
  }
  if (typeof priceFormula === "string" && /^2\.001-/u.test(weight) && /(?:^|[, (])D5<2[,)]/u.test(priceFormula)) {
    rules.push({ code: "WEIGHT_LOWER_BOUND_CONFLICT", sourceCells: [sourceCell(`E${selected.rowNumber}`), sourceCell(worksheet.originsByCell.get(`${selected.rowNumber}:7`))],
      message: "重量文字下限为2.001kg，但试算表达式允许2kg。" });
  }
  if (chargeableWeightRuleForProductType(selected.productType) === "max_actual_volume") {
    const formula = worksheet.formulasByCell.get("F5");
    const knownBoundaryConflict = typeof formula === "string" && /D7>1501,D7<7000/u.test(formula) && /D7>7001,D7<250000/u.test(formula);
    rules.push({ code: knownBoundaryConflict ? "VOLUME_RULE_BOUNDARY_CONFLICT" : "VOLUME_RULE_EVIDENCE_UNRESOLVED",
      sourceCells: [sourceCell("F5"), sourceCell(worksheet.originsByCell.get(`${selected.rowNumber}:8`))],
      message: knownBoundaryConflict ? "体积计费表达式有货值及包装条件，边界与文字区间不能直接视为一致；不得无条件套用体积系数。" :
        "尚未归一化此线路的完整体积计费依据，不得自动填充体积系数。" });
  }
  return rules;
}

// Stamped on a reading only after assertMainSheetQuoteFormula has checked that row's own
// quote cells. An evidence pack without it was projected by a reader that never checked them.
export const GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS = "main_sheet_quote_verified";

// This is a finite contract for the adopted 8/19 main sheet, not a formula evaluator.
const MAIN_WEIGHT_FORMULA = 'IF(OR(AND(D5>=2.001,D5<=30,D7>1501,D7<7000,SUM(H5:H7)<=310,H5<=150,H6<=80,H7<=80),AND(D5>=5.001,D5<=30,D7>7001,D7<250000,SUM(H5:H7)<=310,H5<=150,H6<=80,H7<=80)),MAX(H5*H6*H7/12000,D5),D5)';
function assertMainSheetQuoteFormula(worksheet, rowNumber) {
  const exclusions = rowNumber <= 12 ? 'D5>0.5,D7>1500,AND(SUM(H5:H7)>90),H5>60,H6>60,H7>60' :
    rowNumber <= 14 ? 'D5<0.5,D5>30,D7>1500,AND(SUM(H5:H7)>150),H5>60,H6>60,H7>60' :
    rowNumber <= 17 ? 'D5>2,D7<1501,D7>7000,AND(SUM(H5:H7)>150),H5>60,H6>60,H7>60' :
    rowNumber <= 19 ? 'D5<2,D5>30,D7<1501,D7>7000,AND(SUM(H5:H7)>310),H5>150,H6>80,H7>80' :
    rowNumber <= 22 ? 'D5<0.001,D5>5,D7<7001,D7>250000,AND(SUM(H5:H7)>250),H5>150,H6>80,H7>80' :
    'D5<5.001,D5>30,D7<7001,D7>250000,AND(SUM(H5:H7)>310),H5>150,H6>80,H7>80';
  const expected = `IF(OR(${exclusions}),"",IF(OR($D$5=0,$D$7=0,$H$5=0,$H$6=0,$H$7=0),"",F5*K${rowNumber}+L${rowNumber}))`;
  const weightFormula = worksheet.formulasByCell.get('F5');
  const quoteFormula = worksheet.formulasByCell.get(`E${rowNumber}`);
  if (weightFormula !== MAIN_WEIGHT_FORMULA || typeof quoteFormula !== 'string' || quoteFormula.replace(/" +"/gu, '""') !== expected) {
    throw new Error(`GUOO_TARIFF_MAIN_QUOTE_FORMULA_UNSUPPORTED: F5/E${rowNumber}`);
  }
  return [{ sheetName: SHEET_NAME, cellRef: 'F5', formula: weightFormula },
    { sheetName: SHEET_NAME, cellRef: `E${rowNumber}`, formula: quoteFormula }];
}

/** Adopted main-sheet quote only; not latest official validity or total procurement cost. */
export async function readGuooTariffCatalog({ filePath = DEFAULT_GUOO_TARIFF_PATH, execFileImpl, readFileImpl = readFile,
  now = () => new Date() } = {}) {
  const ruleVersion = guooTariffRuleVersionFromPath(filePath);
  const [parts, bytes] = await Promise.all([workbookParts(filePath, execFileImpl, readFileImpl), readFileImpl(filePath)]);
  const worksheet = await worksheetData(filePath, parts, SHEET_NAME, execFileImpl);
  const sizeSources = await resolveSelectedSizeReference({ filePath, parts, worksheet, execFileImpl });
  const sourceRef = `guoo-xlsx:${path.basename(filePath)}:sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const rows = [];
  for (let rowNumber = 10; rowNumber <= 24; rowNumber += 1) {
    const row = worksheet.rows[rowNumber];
    if (!row || typeof row[3] !== "string" || !row[3].trim()) throw new Error("GUOO_TARIFF_CATALOG_INCOMPLETE: 缺少预期线路行");
    const deliveryMethods = row[3].split(/\r?\n/u).map(value => value.trim()).filter(value => /^GUOO\s+/i.test(value));
    if (deliveryMethods.length !== 2 || !deliveryMethods[0].endsWith(" PUDO") || !deliveryMethods[1].endsWith(" Courier") ||
        routeIdentity(deliveryMethods[0]) !== routeIdentity(deliveryMethods[1])) throw new Error("GUOO_TARIFF_ROUTE_AMBIGUOUS: 线路配送方式身份不完整");
    const selected = selectGuooTariffRow(worksheet.rows, deliveryMethods[0]);
    if (selected.rowNumber !== rowNumber) throw new Error("GUOO_TARIFF_ROUTE_AMBIGUOUS: 线路与表行不一致");
    const calculation = assertMainSheetQuoteFormula(worksheet, rowNumber);
    rows.push({ rowNumber, route: deliveryMethods[0].replace(/ PUDO$/u, ""), deliveryMethods, routeText: row[3],
      evidenceData: projectTariffFields(selected, sizeSources),
      sourceRefs: { ...catalogRowSources(worksheet, rowNumber, sizeSources), calculation }, unresolvedRules: catalogUnresolvedRules(worksheet, selected),
      feeCoverage: { status: "complete", additionalPerParcelRmb: 0, evidenceRef: `${sourceRef}:realfbs-main-quote:E${rowNumber}` } });
  }
  const sourceNotes = [];
  for (let rowNumber = 25; rowNumber <= 29; rowNumber += 1) {
    const value = worksheet.rows[rowNumber]?.[2];
    if (typeof value !== "string" || !value.trim()) throw new Error("GUOO_TARIFF_CATALOG_INCOMPLETE: 缺少表格说明");
    sourceNotes.push({ sheetName: SHEET_NAME, cellRef: `B${rowNumber}`, text: value });
  }
  return { schemaVersion: "guoo-tariff-catalog-v1", ruleVersion, sourceRef,
    quoteScope: "realfbs_main_sheet_quote", calculationContractVersion: "guoo-realfbs-five-input-quote-v1",
    quoteScopeDescription: "仅按指定版本realFBS主表五输入计算K/L报价；不含其他工作表费用或采购总成本，不宣称官方最新资费。",
    observedAt: now().toISOString(), sourceNotes, rows, unresolvedRules: [] };
}

/**
 * One adopted main-sheet row, for the B evidence pack. "Current" means exactly this: the
 * file named by the scope's rule version, that row's quote cells checked, K/L read literally.
 * It is not a claim that GUOO has published no newer table, nor a total procurement cost.
 */
export async function readCurrentGuooTariff({
  scope,
  filePath = DEFAULT_GUOO_TARIFF_PATH,
  execFileImpl,
  readFileImpl = readFile,
  now = () => new Date(),
} = {}) {
  const currentRuleVersion = guooTariffRuleVersionFromPath(filePath);
  if (normalized(scope?.ruleVersion) !== normalized(currentRuleVersion)) {
    throw new Error(`GUOO_TARIFF_VERSION_MISMATCH: 当前文件是${currentRuleVersion}`);
  }
  const [parts, bytes] = await Promise.all([
    workbookParts(filePath, execFileImpl, readFileImpl),
    readFileImpl(filePath),
  ]);
  const worksheet = await worksheetData(filePath, parts, SHEET_NAME, execFileImpl);
  const sizeSources = await resolveSelectedSizeReference({ filePath, parts, worksheet, requestedRoute: scope?.route, execFileImpl });
  const selected = selectGuooTariffRow(worksheet.rows, scope?.route);
  // Same cell-by-cell check the catalog runs: this row's own quote expression must be the
  // adopted five-input contract billing F5 at K/L. A row whose formula reads otherwise is
  // refused here rather than projected into a formal profit number.
  assertMainSheetQuoteFormula(worksheet, selected.rowNumber);
  const checkedAt = now().toISOString();
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  return {
    current: true,
    scope: { route: String(scope.route).trim(), ruleVersion: String(scope.ruleVersion).trim() },
    sourceType: "guoo_current_tariff_xlsx",
    sourceRef: `guoo-xlsx:${path.basename(filePath)}:sha256:${fileHash}:row-${selected.rowNumber}`,
    checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + 7 * 24 * 60 * 60 * 1000).toISOString(),
    evidenceData: { ...projectTariffFields(selected, sizeSources),
      calculationRuleStatus: GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS },
  };
}
