import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { c1CopyFields } from '../../lib/sibling-preparation-consistency.mjs';

const finishedAssetIds = ['17', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '31', '32', '33'];
const whiteAssetIds = ['16', '30', '18'];
const functionalAssetIds = ['19', '27', '29'];

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
  return Buffer.concat([length, name, payload, checksum]);
}

/** Small, distinct RGB images that a browser can decode; no product imagery is used. */
function syntheticImage(assetId, ordinal) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(14), white = whiteAssetIds.includes(assetId);
  const rgb = [(ordinal * 37) % 256, (ordinal * 71) % 256, (ordinal * 113) % 256];
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const offset = row * 7 + 1 + column * 3;
      const color = white && (row !== 1 || column !== 1) ? [255, 255, 255] : rgb;
      for (let channel = 0; channel < 3; channel += 1) pixels[offset + channel] = color[channel];
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Complete synthetic DTO for the existing one-member and three-member family fixtures. */
export function syntheticCatalog(document) {
  const parent = document.candidates[0], members = document.candidates.slice(1);
  if (![1, 3].includes(members.length)) throw new Error('SYNTHETIC_CATALOG_REQUIRES_ONE_OR_THREE_MEMBERS');
  const supplierSkuIds = members.map(candidate => candidate.siblingSourceV1.supplierSkuId);
  if (new Set(supplierSkuIds).size !== supplierSkuIds.length) throw new Error('SYNTHETIC_CATALOG_DUPLICATE_SUPPLIER_SKU');
  // The single-member gate tests retain all three exceptions, bound to that one member.
  const exceptionSkuIds = members.length === 1 ? Array(3).fill(supplierSkuIds[0]) : supplierSkuIds;
  const assetIds = [...finishedAssetIds, ...whiteAssetIds];
  const assets = assetIds.map((assetId, index) => {
    const body = syntheticImage(assetId, index + 1), exceptionIndex = whiteAssetIds.indexOf(assetId);
    return { assetId, kind: exceptionIndex < 0 ? 'finished' : 'owner_color_exception',
      name: exceptionIndex < 0 ? `合成测试图 ${assetId}` : `合成本色例外 ${assetId}`,
      contentType: 'image/png', storageKey: `synthetic-${assetId}.png`, byteSize: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      onlySourceSkuId: exceptionIndex < 0 ? null : exceptionSkuIds[exceptionIndex],
      functionalCandidate: functionalAssetIds.includes(assetId),
      previewSrc: `/api/sibling-batches/${encodeURIComponent(parent.id)}/preparation-assets/${assetId}` };
  });
  return { schemaVersion: 'sibling-preparation-catalog-v1', catalogId: 'synthetic-workspace', version: 1,
    offerId: parent.sourceCapture.offerId, platform: parent.targetPlatform, supplierSkuIds,
    excludedSupplierSkuIds: [parent.lifecycleV11.skuPackage.supplierSkuId],
    defaults: { goods: '18', freight: '6.5', other: '0', packaging: '0', weight: '0.2', price: '848',
      length: '20', width: '30', height: '5', stock: '100', route: 'synthetic', ...c1CopyFields(null),
      quantityOneEvidenceSourceNote: '', rightsExpiresAt: '' },
    colors: Object.fromEntries(members.map((candidate, index) => [supplierSkuIds[index], {
      name: candidate.sourceCapture.skuChoices?.[0]?.attributes?.颜色 ?? '合成色', colorRu: `synthetic-${index}`,
      platformColors: ['synthetic-broad-color'], sourceRef: 'synthetic-capture',
      defaultOrder: [whiteAssetIds[index], '17'] }])), functionalAssetIds: [...functionalAssetIds], assets };
}

/** Writes only into the caller's explicitly supplied, already-created temporary directory. */
export async function writeSyntheticSiblingPreparationCatalog({ document, tempDir }) {
  if (typeof tempDir !== 'string' || !path.isAbsolute(tempDir)) throw new Error('SYNTHETIC_CATALOG_TEMP_DIRECTORY_REQUIRED');
  const catalog = syntheticCatalog(document);
  for (const [index, asset] of catalog.assets.entries()) {
    await writeFile(path.join(tempDir, asset.storageKey), syntheticImage(asset.assetId, index + 1));
  }
  await writeFile(path.join(tempDir, 'catalog.json'), JSON.stringify(catalog));
  return catalog;
}
