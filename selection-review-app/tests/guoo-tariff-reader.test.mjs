import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { DEFAULT_GUOO_TARIFF_PATH, GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS, readCurrentGuooTariff, readGuooTariffCatalog, parseWorksheetRows, selectGuooTariffRow } from '../lib/guoo-tariff-reader.mjs';
import { calculateFreight } from '../lib/lifecycle-b-input-bundle.mjs';

test('adopted workbook keeps original bytes and all real tariff rows with exact source references', async () => {
  const manifest = JSON.parse(await readFile(new URL('../data/logistics/guoo-2026-08-19.source.json', import.meta.url), 'utf8'));
  const bytes = await readFile(DEFAULT_GUOO_TARIFF_PATH);
  assert.equal(bytes.length, manifest.byteLength);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
  assert.equal(manifest.officialLatestVerified, false);
  const catalog = await readGuooTariffCatalog({ now: () => new Date('2026-09-09T04:00:00.000Z') });
  assert.equal(catalog.ruleVersion, manifest.ruleVersion);
  assert.deepEqual(catalog.rows.map(row => row.rowNumber), Array.from({ length: 15 }, (_, index) => index + 10));
  for (const [rowNumber, perKg, perParcel] of [[12,28.1,3.37],[14,19.1,25.83],[17,28.1,17.97],[19,19.1,40.44]]) {
    const row = catalog.rows.find(value => value.rowNumber === rowNumber);
    assert.equal(row.evidenceData.perKgRmb, perKg);
    assert.equal(row.evidenceData.perParcelRmb, perParcel);
    assert.equal(row.sourceRefs.perKgRmb.cellRef, `K${rowNumber}`);
    assert.equal(row.sourceRefs.perParcelRmb.cellRef, `L${rowNumber}`);
  }
  assert.equal(catalog.rows[0].evidenceData.sizeLimitSources.length, 2);
  assert.equal(catalog.rows[13].evidenceData.sizeLimitSources.length, 2);
  assert.equal(catalog.rows.every(row => row.feeCoverage.status === 'complete' && row.feeCoverage.additionalPerParcelRmb === 0), true);
});

// Actual deflated XLSX bytes; production unzip and the public reader are exercised.
function zip(entries) {
  const bodies = [], directory = []; let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const filename = Buffer.from(name), raw = Buffer.from(content), payload = deflateRawSync(raw);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42); bodies.push(local, filename, payload); directory.push(central, filename);
    offset += local.length + filename.length + payload.length;
  }
  const catalog = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(catalog.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, catalog, end]);
}
const weightFormula = 'IF(OR(AND(D5>=2.001,D5<=30,D7>1501,D7<7000,SUM(H5:H7)<=310,H5<=150,H6<=80,H7<=80),AND(D5>=5.001,D5<=30,D7>7001,D7<250000,SUM(H5:H7)<=310,H5<=150,H6<=80,H7<=80)),MAX(H5*H6*H7/12000,D5),D5)';
const formulaXml = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
// The single-row reader now checks the same two quote cells the catalog checks, so every fixture
// that expects a reading to succeed has to carry this row's real quote expression.
const smallQuote = rowNumber => `IF(OR(D5>2,D7<1501,D7>7000,AND(SUM(H5:H7)>150),H5>60,H6>60,H7>60),"",IF(OR($D$5=0,$D$7=0,$H$5=0,$H$6=0,$H$7=0),"",F5*K${rowNumber}+L${rowNumber}))`;
const quoteCell = rowNumber => `<c r="E${rowNumber}"><f>${formulaXml(smallQuote(rowNumber))}</f><v>0</v></c>`;
const weightRow = `<row r="5"><c r="F5"><f>${formulaXml(weightFormula)}</f></c></row>`;
const row = `<row r="17"><c r="B17" t="inlineStr"><is><t>Small</t></is></c><c r="C17" t="inlineStr"><is><t>GUOO Economy Small PUDO</t></is></c><c r="D17" t="inlineStr"><is><t>land</t></is></c><c r="G17" t="inlineStr"><is><t>0.001-2KG</t></is></c><c r="K17"><v>28.1</v></c><c r="L17"><v>17.97</v></c>${quoteCell(17)}</row>`;
function workbook(transform = value => value, transformEntries = entries => entries) {
  return zip(transformEntries({
    'xl/workbook.xml': '<workbook><sheets><sheet name="GUOO realFBS资费试算表" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst/>',
    'xl/worksheets/sheet1.xml': transform(`<worksheet><sheetData>${row}${weightRow}</sheetData></worksheet>`)
  }));
}
async function readBytes(bytes) {
  const directory = await mkdtemp(path.join(tmpdir(), 'guoo-formula-'));
  const filePath = path.join(directory, 'GUOO-2026.9.3.xlsx');
  try {
    await writeFile(filePath, bytes);
    return await readCurrentGuooTariff({ filePath, scope: { route: 'GUOO Economy Small', ruleVersion: 'guoo-2026-09-03' },
      now: () => new Date('2026-09-03T02:00:00.000Z') });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test('real XLSX reader accepts direct numbers and ignores unrelated formula cells', async () => {
  const result = await readBytes(workbook(xml => xml.replace('</sheetData>', '<row r="30"><c r="Z30"><f>99</f><v>0.1</v></c></row></sheetData>')));
  assert.equal(result.evidenceData.perKgRmb, 28.1); assert.equal(result.evidenceData.perParcelRmb, 17.97);
});
test('real XLSX reader rejects ordinary empty shared array and namespaced formula caches', async () => {
  for (const formula of ['<f>99</f>', '<f/>', '<f t="shared" si="0"/>', '<f t="array" ref="K17">99</f>',
    '<x:f xmlns:x="urn:sheet">99</x:f>', '<公式:f xmlns:公式="urn:sheet">99</公式:f>']) {
    await assert.rejects(readBytes(workbook(xml => xml.replace('<c r="K17"><v>28.1</v>', `<c r="K17">${formula}<v>0.1</v>`))),
      /GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED/);
  }
});
test('shared array ranges and merged formula anchors cannot launder a tariff cache', async () => {
  for (const type of ['shared', 'array']) {
    await assert.rejects(readBytes(workbook(xml => xml.replace('<row r="17">',
      `<row r="16"><c r="K16"><f t="${type}" ref="K16:K17">99</f><v>0.1</v></c></row><row r="17">`))), /GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED/);
  }
  await assert.rejects(readBytes(workbook(xml => xml.replace('<row r="17">', '<row r="16"><c r="K16"><f>99</f><v>0.1</v></c></row><row r="17">')
    .replace('<c r="K17"><v>28.1</v></c>', '<c r="K17"/>').replace('</worksheet>', '<mergeCells><mergeCell ref="K16:K17"/></mergeCells></worksheet>'))), /GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED/);
});
test('malformed formula ranges and duplicate cells fail without exposing formula text', async () => {
  for (const ref of ['', 'K17:XFD1048576', 'K17:K16', 'A1:A2', 'bad']) {
    await assert.rejects(readBytes(workbook(xml => xml.replace('<c r="K17">', `<c r="K17"><f t="array" ref="${ref}">private-formula</f>`))),
      error => /GUOO_TARIFF_WORKSHEET_INVALID/.test(error.message) && !error.message.includes('private-formula'));
  }
  await assert.rejects(readBytes(workbook(xml => xml.replace('</row>', '<c r="K17"><v>0.1</v></c></row>'))), /GUOO_TARIFF_WORKSHEET_INVALID/);
});
test('broken XLSX and missing files remain explicit failures', async () => {
  await assert.rejects(readBytes(Buffer.from('not a ZIP')));
  await assert.rejects(readCurrentGuooTariff({ filePath: '/nonexistent/synthetic/GUOO-2026.9.3.xlsx',
    scope: { route: 'GUOO Economy Small', ruleVersion: 'guoo-2026-09-03' } }));
});

test('missing numeric tariff cannot become a zero fee and inherited rule formulas remain blocked', async () => {
  for (const replacement of ['<c r="K17"/>', '<c r="K17" t="str"><v>0.1</v></c>']) {
    await assert.rejects(readBytes(workbook(xml => xml.replace('<c r="K17"><v>28.1</v></c>', replacement))), /GUOO_TARIFF_FIELD_INVALID/);
  }
  for (const column of ['B', 'C', 'D', 'G']) {
    await assert.rejects(readBytes(workbook(xml => xml.replace(`<c r="${column}17" t="inlineStr">`, `<c r="${column}17" t="inlineStr"><f>99</f>`))), /GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED/);
  }
});

test('display formula cached text never becomes a pricing fact or blocks direct tariff cells', async () => {
  const result = await readBytes(workbook(xml => xml.replace('</row>', '<c r="F17" t="str"><f>CONCAT(K17,L17)</f><v>private-stale-display-cache</v></c></row>')));
  assert.equal(result.evidenceData.perKgRmb, 28.1);
  assert.equal(result.evidenceData.perParcelRmb, 17.97);
  assert.equal(result.evidenceData.tariffFormula, null);
  assert.equal(result.evidenceData.tariffFormulaSourceStatus, 'display_formula_not_evaluated');
  assert.equal(JSON.stringify(result).includes('private-stale-display-cache'), false);
});

const sizeText = '三边之和不超150CM，单边不超60CM';
function sizeReferenceWorkbook({ formula = "'GUOO FBP资费试算表'!J12", targetCell = `<c r="J12" t="inlineStr"><is><t>${sizeText}</t></is></c>`, relationship = 'Target="worksheets/sheet2.xml"', omitTarget = false, targetPrefix = '' } = {}) {
  return workbook(xml => xml.replace('</row>', `<c r="I17" t="str"><f>${formula}</f><v>private-stale-size-cache</v></c></row>`), entries => ({
    ...entries,
    'xl/workbook.xml': '<workbook><sheets><sheet name="GUOO realFBS资费试算表" r:id="rId1"/><sheet name="GUOO FBP资费试算表" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" ${relationship}/></Relationships>`,
    ...(omitTarget ? {} : { 'xl/worksheets/sheet2.xml': `<worksheet><sheetData>${targetPrefix}<row r="12">${targetCell}</row></sheetData></worksheet>` })
  }));
}

test('single approved same-workbook size reference resolves direct text with source identity', async () => {
  const result = await readBytes(sizeReferenceWorkbook());
  assert.equal(result.evidenceData.sizeLimit, sizeText);
  assert.deepEqual(result.evidenceData.sizeLimitSource, { sheetName: 'GUOO FBP资费试算表', cellRef: 'J12' });
  assert.equal(JSON.stringify(result).includes('private-stale-size-cache'), false);
  const literal = await readBytes(workbook(xml => xml.replace('</row>', `<c r="I17" t="inlineStr"><is><t>${sizeText}</t></is></c></row>`)));
  assert.equal(literal.evidenceData.sizeLimit, sizeText);
  assert.deepEqual(literal.evidenceData.sizeLimitSource, { sheetName: 'GUOO realFBS资费试算表', cellRef: 'I17' });
});

test('size formulas reject expressions external workbooks multiple cells and nonapproved sheets', async () => {
  for (const formula of ["'GUOO FBP资费试算表'!J12&amp;\"suffix\"", "'[external.xlsx]GUOO FBP资费试算表'!J12", "'GUOO FBP资费试算表'!J12:J13", "'Other sheet'!J12", 'INDIRECT("J12")']) {
    await assert.rejects(readBytes(sizeReferenceWorkbook({ formula })), error =>
      /GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED/.test(error.message) && !error.message.includes('private-stale-size-cache') && !error.message.includes('external.xlsx'));
  }
});

test('size references reject missing numeric empty and formula-derived target cells', async () => {
  for (const targetCell of ['', '<c r="J12"><v>150</v></c>', '<c r="J12" t="inlineStr"><is><t></t></is></c>']) {
    await assert.rejects(readBytes(sizeReferenceWorkbook({ targetCell })), /GUOO_TARIFF_FIELD_INVALID/);
  }
  await assert.rejects(readBytes(sizeReferenceWorkbook({ targetCell:
    '<c r="J12" t="str"><f>"private-derived-text"</f><v>private-derived-text</v></c>' })), error =>
    /GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED/.test(error.message) && !error.message.includes('private-derived-text'));
  await assert.rejects(readBytes(sizeReferenceWorkbook({ omitTarget: true })), /GUOO_TARIFF_SHEET_RELATION_MISSING/);
});

test('worksheet relationships reject external targets and traversal instead of resolving another source', async () => {
  for (const relationship of ['Target="https://example.test/private.xlsx" TargetMode="External"', 'Target="../outside.xml"',
    'Target="worksheets/../sheet2.xml"', 'Target="/etc/passwd"']) {
    await assert.rejects(readBytes(sizeReferenceWorkbook({ relationship })), error => /GUOO_TARIFF_SHEET_RELATION_REJECTED/.test(error.message) && !error.message.includes('private.xlsx'));
  }
});

test('unmerged blanks never inherit previous product type weight declared value or size rules', async () => {
  const xml = `<worksheet><sheetData>
    <row r="16"><c r="B16" t="inlineStr"><is><t>Big</t></is></c><c r="G16" t="inlineStr"><is><t>0.1-30KG</t></is></c><c r="H16" t="inlineStr"><is><t>100-1000</t></is></c><c r="I16" t="inlineStr"><is><t>previous-size</t></is></c></row>
    <row r="17"><c r="C17" t="inlineStr"><is><t>GUOO Economy Small PUDO</t></is></c><c r="K17"><v>28.1</v></c><c r="L17"><v>17.97</v></c>${quoteCell(17)}</row>
    ${weightRow}
  </sheetData></worksheet>`;
  const selected = selectGuooTariffRow(parseWorksheetRows(xml), 'GUOO Economy Small');
  for (const field of ['productType', 'weightLimit', 'declaredValueLimit', 'sizeLimit']) assert.equal(selected[field], '', field);
  await assert.rejects(readBytes(workbook(() => xml)), /GUOO_TARIFF_PRODUCT_TYPE_UNSUPPORTED/);
  const merged = xml.replace('</worksheet>', '<mergeCells><mergeCell ref="B16:B17"/><mergeCell ref="G16:G17"/><mergeCell ref="H16:H17"/><mergeCell ref="I16:I17"/></mergeCells></worksheet>');
  const inherited = selectGuooTariffRow(parseWorksheetRows(merged), 'GUOO Economy Small');
  assert.deepEqual([inherited.productType, inherited.weightLimit, inherited.declaredValueLimit, inherited.sizeLimit], ['Big', '0.1-30KG', '100-1000', 'previous-size']);
  const mergedResult = await readBytes(workbook(() => merged));
  assert.equal(mergedResult.evidenceData.sizeLimit, 'previous-size');
  assert.deepEqual(mergedResult.evidenceData.sizeLimitSource, { sheetName: 'GUOO realFBS资费试算表', cellRef: 'I16' });
});

test('shared strings are optional only when ZIP member is absent; declared member read failure propagates', async () => {
  const result = await readBytes(workbook(undefined, entries => {
    const withoutSharedStrings = { ...entries }; delete withoutSharedStrings['xl/sharedStrings.xml']; return withoutSharedStrings;
  }));
  assert.equal(result.evidenceData.perKgRmb, 28.1);
  const original = new Error('synthetic ZIP member cannot be read');
  const requested = [];
  await assert.rejects(readCurrentGuooTariff({ filePath: '/synthetic/GUOO-2026.9.3.xlsx',
    scope: { route: 'GUOO Economy Small', ruleVersion: 'guoo-2026-09-03' }, readFileImpl: async () => Buffer.from('synthetic'),
    execFileImpl: async (_command, args) => {
      if (args[0] === '-Z1') return { stdout: 'xl/workbook.xml\nxl/_rels/workbook.xml.rels\nxl/sharedStrings.xml\nxl/worksheets/sheet1.xml\n' };
      const entry = args.at(-1); requested.push(entry);
      if (entry === 'xl/sharedStrings.xml') throw original;
      if (entry === 'xl/workbook.xml') return { stdout: '<workbook><sheets><sheet name="GUOO realFBS资费试算表" r:id="rId1"/></sheets></workbook>' };
      if (entry === 'xl/_rels/workbook.xml.rels') return { stdout: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' };
      if (entry === 'xl/worksheets/sheet1.xml') return { stdout: `<worksheet><sheetData>${row}</sheetData></worksheet>` };
      throw new Error('UNEXPECTED_SYNTHETIC_ZIP_READ');
    }
  }), error => error === original);
  assert.equal(requested.filter(entry => entry === 'xl/sharedStrings.xml').length, 1);
});

test('empty self-closing worksheet rows cannot capture cells from later rows', async () => {
  const result = await readBytes(sizeReferenceWorkbook({ targetPrefix: '<row r="1" ht="7" customHeight="1"/>' }));
  assert.equal(result.evidenceData.sizeLimit, sizeText);
  assert.deepEqual(result.evidenceData.sizeLimitSource, { sheetName: 'GUOO FBP资费试算表', cellRef: 'J12' });
  for (const xml of ['<worksheet><sheetData><row r="1"/><row r="1"/></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1"/><row r="12"><c r="J11"><v>1</v></c></row></sheetData></worksheet>']) {
    assert.throws(() => parseWorksheetRows(xml), /GUOO_TARIFF_WORKSHEET_INVALID/);
  }
});

test('size reference formula rejects nested XML and preserves entity-only text semantics', async () => {
  for (const formula of ["<nested>'GUOO FBP资费试算表'!J12</nested>", "&lt;nested&gt;'GUOO FBP资费试算表'!J12&lt;/nested&gt;"]) {
    await assert.rejects(readBytes(sizeReferenceWorkbook({ formula })), /GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED/);
  }
  const result = await readBytes(sizeReferenceWorkbook({ formula: '&apos;GUOO FBP资费试算表&apos;!$J$12' }));
  assert.equal(result.evidenceData.sizeLimit, sizeText);
  assert.deepEqual(result.evidenceData.sizeLimitSource, { sheetName: 'GUOO FBP资费试算表', cellRef: 'J12' });
});

test('missing or unrecognized product type cannot default to actual weight despite complete numeric tariffs', async () => {
  for (const replacement of ['<c r="B17"/>', '<c r="B17" t="inlineStr"><is><t>Unrecognized synthetic type</t></is></c>']) {
    await assert.rejects(readBytes(workbook(xml => xml.replace('<c r="B17" t="inlineStr"><is><t>Small</t></is></c>', replacement))),
      /GUOO_TARIFF_PRODUCT_TYPE_UNSUPPORTED/);
  }
});

test('only supported workbook product types select their explicit chargeable-weight rule', async () => {
  for (const [type, rule] of [['Extra Small', 'actual_weight'], ['Budget', 'actual_weight'], ['Small', 'actual_weight'],
    ['Big', 'max_actual_volume'], ['Premium Small', 'actual_weight'], ['Premium Big', 'max_actual_volume']]) {
    const result = await readBytes(workbook(xml => xml.replace('<t>Small</t>', `<t>${type}</t>`)));
    assert.equal(result.evidenceData.chargeableWeightRule, rule, type);
    if (rule === 'max_actual_volume') assert.equal(result.evidenceData.volumeDivisorCm3PerKg, 12000);
    else assert.equal(Object.hasOwn(result.evidenceData, 'volumeDivisorCm3PerKg'), false);
  }
});

function catalogEntries() {
  const labels = [
    ['Extra Small', ['Express', 'Standard', 'Economy']], ['Budget', ['Standard', 'Economy']],
    ['Small', ['Express', 'Standard', 'Economy']], ['Big', ['Standard', 'Economy']],
    ['Premium Small', ['Express', 'Standard', 'Economy']], ['Premium Big', ['Standard', 'Economy']],
  ];
  const literal = (ref, value) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const rows = []; let rowNumber = 10;
  for (const [type, speeds] of labels) for (const speed of speeds) {
    const weight = type === 'Budget' ? '0.501-30KG' : type === 'Big' ? '2.001-30KG' : '0.001-2KG';
    const formula = type === 'Extra Small' ? "'GUOO FBP资费试算表'!I10&amp;'GUOO FBP资费试算表'!J10" :
      type === 'Premium Big' ? "'GUOO FBP资费试算表'!I20&amp;'GUOO FBP资费试算表'!J20" : "'GUOO FBP资费试算表'!J12";
    const conditions = {
      'Extra Small':'D5>0.5,D7>1500,AND(SUM(H5:H7)>90),H5>60,H6>60,H7>60',
      Budget:'D5<0.5,D5>30,D7>1500,AND(SUM(H5:H7)>150),H5>60,H6>60,H7>60',
      Small:'D5>2,D7<1501,D7>7000,AND(SUM(H5:H7)>150),H5>60,H6>60,H7>60',
      Big:'D5<2,D5>30,D7<1501,D7>7000,AND(SUM(H5:H7)>310),H5>150,H6>80,H7>80',
      'Premium Small':'D5<0.001,D5>5,D7<7001,D7>250000,AND(SUM(H5:H7)>250),H5>150,H6>80,H7>80',
      'Premium Big':'D5<5.001,D5>30,D7<7001,D7>250000,AND(SUM(H5:H7)>310),H5>150,H6>80,H7>80'
    };
    const conflicting = formulaXml(`IF(OR(${conditions[type]})," ",IF(OR($D$5=0,$D$7=0,$H$5=0,$H$6=0,$H$7=0),"  ",F5*K${rowNumber}+L${rowNumber}))`);
    rows.push(`<row r="${rowNumber}">${literal(`B${rowNumber}`,type)}${literal(`C${rowNumber}`,`GUOO ${speed} ${type} PUDO&#10;GUOO ${speed} ${type} Courier`)}${literal(`D${rowNumber}`,'Synthetic transport')}${literal(`G${rowNumber}`,weight)}${literal(`H${rowNumber}`,'1501-7000₽')}${literal(`J${rowNumber}`,'Synthetic unresolved battery rule')}<c r="E${rowNumber}"><f>${conflicting}</f><v>0</v></c><c r="F${rowNumber}"><f>cached_display</f><v>999</v></c><c r="I${rowNumber}"><f>${formula}</f><v>999</v></c><c r="K${rowNumber}"><v>28.1</v></c><c r="L${rowNumber}"><v>17.97</v></c></row>`);
    rowNumber++;
  }
  for (let index=25;index<=29;index++) rows.push(`<row r="${index}">${literal(`B${index}`,`Synthetic source note ${index}`)}</row>`);
  return {
    'xl/workbook.xml':'<workbook><sheets><sheet name="GUOO realFBS资费试算表" r:id="rId1"/><sheet name="GUOO FBP资费试算表" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':`<worksheet><sheetData><row r="5"><c r="F5"><f>${formulaXml(weightFormula)}</f></c></row>${rows.join('')}</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml':`<worksheet><sheetData><row r="10">${literal('I10','Synthetic context 10 ')}${literal('J10','Synthetic size 10')}</row><row r="12">${literal('J12',sizeText)}</row><row r="20">${literal('I20','Synthetic context 20 ')}${literal('J20','Synthetic size 20')}</row></sheetData></worksheet>`,
  };
}

async function readCatalog(entries, reads = []) {
  return readGuooTariffCatalog({filePath:'/synthetic/GUOO-2026.8.19.xlsx',now:()=>new Date('2026-09-09T12:00:00.000Z'),
    readFileImpl:async()=>Buffer.from('synthetic-workbook-source'),execFileImpl:async(_command,args)=>{
      if(args[0]==='-Z1'){reads.push('catalog');return {stdout:Object.keys(entries).join('\n')+'\n'};}
      const entry=args.at(-1);reads.push(entry);if(!Object.hasOwn(entries,entry))throw new Error('SYNTHETIC_MISSING_ENTRY');return {stdout:entries[entry]};
    }});
}

test('catalog reads all 15 tariff rows once, preserves delivery identities, source text and bounded main-sheet quote rules',async()=>{
  const reads=[],catalog=await readCatalog(catalogEntries(),reads);
  assert.equal(catalog.rows.length,15);assert.equal(Object.hasOwn(catalog,'current'),false);assert.equal(Object.hasOwn(catalog,'expiresAt'),false);
  assert.equal(catalog.rows[0].route,'GUOO Express Extra Small');
  assert.deepEqual(catalog.rows[0].deliveryMethods,['GUOO Express Extra Small PUDO','GUOO Express Extra Small Courier']);
  assert.equal(catalog.rows[0].evidenceData.sizeLimit,'Synthetic context 10 Synthetic size 10');
  assert.deepEqual(catalog.rows[0].evidenceData.sizeLimitSources,[{sheetName:'GUOO FBP资费试算表',cellRef:'I10'},{sheetName:'GUOO FBP资费试算表',cellRef:'J10'}]);
  assert.equal(catalog.rows[13].evidenceData.sizeLimit,'Synthetic context 20 Synthetic size 20');
  assert.equal(catalog.sourceNotes[0].cellRef,'B25');assert.equal(catalog.sourceNotes[0].text,'Synthetic source note 25');
  for(const row of catalog.rows){assert.equal(row.evidenceData.minimumChargeableWeightKg,0);assert.equal(row.evidenceData.weightRoundingRule,'none');
    assert.deepEqual(row.feeCoverage,{status:'complete',additionalPerParcelRmb:0,evidenceRef:`${catalog.sourceRef}:realfbs-main-quote:E${row.rowNumber}`});assert.equal(row.evidenceData.tariffFormula,null);}
  assert.equal(catalog.rows[3].unresolvedRules.some(rule=>rule.code==='WEIGHT_LOWER_BOUND_CONFLICT'),true);
  assert.equal(catalog.rows[8].unresolvedRules.some(rule=>rule.code==='WEIGHT_LOWER_BOUND_CONFLICT'),true);
  assert.equal(catalog.rows[8].evidenceData.volumeDivisorCm3PerKg,12000);
  assert.deepEqual(catalog.unresolvedRules,[]); assert.equal(catalog.quoteScope,'realfbs_main_sheet_quote');
  assert.deepEqual(catalog.rows[5].unresolvedRules,[]);
  assert.equal(catalog.rows[8].unresolvedRules.some(rule=>rule.code==='VOLUME_RULE_BOUNDARY_CONFLICT'),true);
  assert.equal(reads.length,5);assert.equal(new Set(reads).size,reads.length);
});

test('catalog cannot silently drop missing routes or convert arbitrary concatenations and derived cells to text',async()=>{
  const missing=catalogEntries();missing['xl/worksheets/sheet1.xml']=missing['xl/worksheets/sheet1.xml'].replace(/<row r="24">[\s\S]*?<\/row>/u,'');
  await assert.rejects(readCatalog(missing),/GUOO_TARIFF_CATALOG_INCOMPLETE/);
  for(const expression of ["'GUOO FBP资费试算表'!J10&amp;'GUOO FBP资费试算表'!I10", "'GUOO FBP资费试算表'!I10&amp;'GUOO FBP资费试算表'!J12",
    "'GUOO FBP资费试算表'!I10&amp;'GUOO FBP资费试算表'!J10&amp;'GUOO FBP资费试算表'!J12"]){
    const entries=catalogEntries();entries['xl/worksheets/sheet1.xml']=entries['xl/worksheets/sheet1.xml'].replace("'GUOO FBP资费试算表'!I10&amp;'GUOO FBP资费试算表'!J10",expression);
    await assert.rejects(readCatalog(entries),/GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED/);
  }
  const derived=catalogEntries();derived['xl/worksheets/sheet2.xml']=derived['xl/worksheets/sheet2.xml'].replace('<c r="I10" t="inlineStr">','<c r="I10" t="inlineStr"><f>hidden-derived-value</f>');
  await assert.rejects(readCatalog(derived),error=>/GUOO_TARIFF_FORMULA_CELL_UNSUPPORTED/.test(error.message)&&!error.message.includes('hidden-derived-value'));
});


test('catalog rejects changed weight or quote formulas rather than promoting caches to approved billing rules',async()=>{
  for (const [before,after] of [['/12000','/6000'],['F5*K15+L15','ROUND(F5*K15+L15,0)']]) {
    const entries=catalogEntries(); entries['xl/worksheets/sheet1.xml']=entries['xl/worksheets/sheet1.xml'].replace(before,after);
    await assert.rejects(readCatalog(entries),/GUOO_TARIFF_MAIN_QUOTE_FORMULA_UNSUPPORTED/);
  }
});

test('adopted 8/19 original main sheet exposes Small tariffs for 1kg 20x20x8 2000 RUB quotes',async()=>{
  const filePath = new URL(`../data/logistics/${path.basename(DEFAULT_GUOO_TARIFF_PATH)}`,import.meta.url);
  const catalog=await readGuooTariffCatalog({filePath:fileURLToPath(filePath)});
  assert.equal(catalog.ruleVersion,'guoo-2026-08-19'); assert.equal(catalog.rows.length,15);
  assert.equal(catalog.calculationContractVersion,'guoo-realfbs-five-input-quote-v1');
  assert.equal(catalog.quoteScope,'realfbs_main_sheet_quote'); assert.equal(Object.hasOwn(catalog,'current'),false);
  const expected=[['Express',50.5,17.97,68.47],['Standard',39.3,17.97,57.27],['Economy',28.1,17.97,46.07]];
  for(const [speed,perKg,perParcel,total] of expected) {
    const row=catalog.rows.find(value=>value.route===`GUOO ${speed} Small`); assert.ok(row);
    assert.equal(row.evidenceData.perKgRmb,perKg); assert.equal(row.evidenceData.perParcelRmb,perParcel);
    assert.equal(row.evidenceData.chargeableWeightRule,'actual_weight');
    assert.equal(row.evidenceData.minimumChargeableWeightKg,0); assert.equal(row.evidenceData.weightRoundingRule,'none');
    assert.equal(Math.round((perKg+perParcel)*100)/100,total);
    assert.deepEqual(row.unresolvedRules,[]); assert.equal(row.feeCoverage.status,'complete');
    assert.equal(row.feeCoverage.additionalPerParcelRmb,0);
    assert.deepEqual(row.sourceRefs.calculation.map(value=>value.cellRef),['F5',`E${row.rowNumber}`]);
    assert.equal(row.evidenceData.tariffFormula,null); assert.equal(row.evidenceData.tariffFormulaSourceStatus,'display_formula_not_evaluated');
  }
});

/**
 * 两种读法必须给同一个数。
 *
 * 路线比较按整表目录（`readGuooTariffCatalog`）给主人报运费；B 阶段的正式利润按单行读取
 * （`readCurrentGuooTariff`）计费。`assertSelectedFreightBinding` 要求这两个数逐分相同，
 * 所以它们的计费字段必须逐字段相同——这条测试就是把那个要求钉在真表上。
 *
 * 顺带钉住已经退役的那条历史推定：旧读法把「重量档文字下限」当最低计费重量。下面对每条线路
 * 都取它自己档位内的包裹，证明那个下限永远咬不到计费重量（计费重 ≥ 实重 ≥ 档下限），
 * 并且用一个档位外的包裹证明这条测试不是空转——档外确实会差钱，只是档外的包裹走不了这条线路。
 */
test('整表目录读法与单行读法对真表 15 条线路逐字段同值，退役的档位下限咬不到任何档内包裹', async () => {
  const filePath = fileURLToPath(new URL(`../data/logistics/${path.basename(DEFAULT_GUOO_TARIFF_PATH)}`, import.meta.url));
  const catalog = await readGuooTariffCatalog({ filePath });
  assert.equal(catalog.rows.length, 15);
  let outsideDifferences = 0;
  for (const catalogRow of catalog.rows) {
    const single = await readCurrentGuooTariff({ filePath, scope: { route: catalogRow.route, ruleVersion: catalog.ruleVersion },
      now: () => new Date('2026-09-14T00:00:00.000Z') });
    assert.equal(single.current, true, catalogRow.route);
    assert.equal(single.sourceRef, `${catalog.sourceRef}:row-${catalogRow.rowNumber}`, catalogRow.route);
    assert.deepEqual(single.evidenceData,
      { ...catalogRow.evidenceData, calculationRuleStatus: GUOO_MAIN_QUOTE_CALCULATION_RULE_STATUS }, catalogRow.route);
    assert.equal(single.evidenceData.minimumChargeableWeightKg, 0, catalogRow.route);

    // 这一行自己的重量档文字：档下限就是旧读法会填进 minimumChargeableWeightKg 的那个数。
    const limit = catalogRow.evidenceData.weightLimit.replace(/\s+/gu, '').match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)KG(?:收抛)?$/u);
    assert.ok(limit, `${catalogRow.route} 的重量档文字必须能解析：${JSON.stringify(catalogRow.evidenceData.weightLimit)}`);
    const [minKg, maxKg] = [Number(limit[1]), Number(limit[2])];
    assert.ok(minKg > 0 && minKg <= maxKg, catalogRow.route);
    const retired = { ...single.evidenceData, minimumChargeableWeightKg: minKg };
    const pack = data => ({ id: 'x', scope: { route: catalogRow.route, ruleVersion: catalog.ruleVersion }, evidenceData: data });
    // `calculateFreight` 会把整份计费规则原样带回来，两份规则本来就差这一个字段；这里比的是算出来的数。
    const billed = (data, packaging) => {
      const { tariff, ...computed } = calculateFreight(pack(data), packaging);
      return computed;
    };
    // 体积重可能远大于实重，也可能几乎为 0：两头都取，因为最低计费重量是压在「计费重」上的。
    for (const dimensionsCm of [{ length: 25, width: 35, height: 2 }, { length: 1, width: 1, height: 1 },
      { length: 30, width: 20, height: 20 }, { length: 150, width: 80, height: 80 }]) {
      for (const weightKg of [minKg, minKg + 1e-9, (minKg + maxKg) / 2, maxKg - 1e-9, maxKg]) {
        const packaging = { weightKg, dimensionsCm };
        assert.deepEqual(billed(retired, packaging), billed(single.evidenceData, packaging),
          `${catalogRow.route} ${weightKg}kg ${JSON.stringify(dimensionsCm)}`);
      }
      // 档外（比下限还轻）的包裹两种读法确实不同——这条线路根本不收它，所以差价不属于任何真实报价。
      const below = { weightKg: minKg / 2, dimensionsCm };
      if (billed(retired, below).amountRmb !== billed(single.evidenceData, below).amountRmb) outsideDifferences += 1;
    }
  }
  assert.ok(outsideDifferences > 0, '档外包裹必须能看出差别，否则这条等价性测试是空转的');
});
