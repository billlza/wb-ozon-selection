/**
 * A small stand-in for the CEL 产品资费表 WB sheet, built in memory: same cells, merges and shared strings as the
 * V7.24 workbook the owner uploaded, so the reader can be tested without the vendor file in the repository.
 */
const TITLE = "            wildberries平台—CEL运费测算表";
const SIZE = "三边之和不超过200厘米                单边不超过115厘米";

export const CEL_WB_CELLS = Object.freeze({
  A1: TITLE,
  A2: "渠道", B2: "网点", C2: "时效（天）", D2: "产品", E2: "包裹限重（kg）", F2: "尺寸限制", G2: "费用",
  H2: "试算运费(元）", I2: "百克进位计费重量（kg）", J2: "包裹实际重量（kg）", K2: "价格试算",
  A3: "陆空联运\n（Wb-Express)", B3: "珲春仓备货", C3: 10, D3: "到达取货点", E3: "≤20kg", F3: SIZE, G3: "48元/kg+9元/票",
  H3: 13.8, I3: 0.1, J3: 0.01, K3: "←输入重量/kg",
  A4: "陆运\n（Wb-Economy)", B4: "前端仓库", C4: 20, E4: "≤0.3kg", G4: "58元/kg+2元/票", H4: 7.8,
  E5: "＞0.3kg≤20kg", G5: "43元/kg+8元/票",
  A6: "注意：包裹送仓地址需要与平台出单仓库一致；珲春仓备货单件包裹密度需大于70kg/m³",
  A7: "退货服务：派送失败退回WB官方仓我司不承运不收费；清关失败退货42元/票"
});
export const CEL_WB_MERGES = Object.freeze(["A1:K1", "A4:A5", "B4:B5", "C4:C5", "D3:D5", "F3:F5", "I3:I5", "J3:J5", "K3:K5"]);

const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function sheetXml(cells, merges) {
  const strings = [];
  const byRow = new Map();
  for (const [ref, value] of Object.entries(cells)) {
    const row = Number(ref.match(/\d+$/)[0]);
    if (!byRow.has(row)) byRow.set(row, []);
    if (typeof value === "number") byRow.get(row).push(`<c r="${ref}"><v>${value}</v></c>`);
    else { strings.push(value); byRow.get(row).push(`<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`); }
  }
  const rows = [...byRow.entries()].sort(([a], [b]) => a - b).map(([row, list]) => `<row r="${row}">${list.join("")}</row>`).join("");
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>` : "";
  return {
    sheet: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${mergeXml}</worksheet>`,
    strings: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map(value => `<si><t xml:space="preserve">${escape(value)}</t></si>`).join("")}</sst>`
  };
}

/** Uncompressed ZIP (method 0); the reader does not check CRCs, so they are left at zero. */
function storedZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name), data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** The workbook bytes; pass changed cells or merges to test a layout the reader must refuse. */
export function celWbWorkbook({ cells = CEL_WB_CELLS, merges = CEL_WB_MERGES, sheetName = "WB" } = {}) {
  const { sheet, strings } = sheetXml(cells, merges);
  return storedZip([
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="OZON-rFBS" sheetId="2" r:id="rId1"/><sheet name="${escape(sheetName)}" sheetId="7" r:id="rId5"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet5.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", strings],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData/></worksheet>`],
    ["xl/worksheets/sheet5.xml", sheet]
  ]);
}
