import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Replaceable local development artifact reader. Domain code receives only DTOs and verified bytes. */
export function createLocalSiblingCatalogReader({ directory }) {
  if (!path.isAbsolute(directory)) throw new Error('SIBLING_CATALOG_DIRECTORY_REQUIRED');
  return Object.freeze({
    async readCatalog() {
      let catalog;
      try{catalog=JSON.parse(await fs.readFile(path.join(directory,'catalog.json'),'utf8'));}
      catch(error){if(error.code==='ENOENT')throw new Error('SIBLING_CATALOG_UNAVAILABLE');if(error instanceof SyntaxError)throw new Error('SIBLING_CATALOG_INVALID');throw error;}
      if (catalog.schemaVersion !== 'sibling-preparation-catalog-v1' || !catalog.catalogId || !Number.isSafeInteger(catalog.version) || catalog.version<1 || !Array.isArray(catalog.supplierSkuIds) || !Array.isArray(catalog.excludedSupplierSkuIds) || !catalog.defaults || !catalog.colors || !Array.isArray(catalog.assets) ||
          catalog.assets.length > 100 || new Set(catalog.assets.map(a=>a.assetId)).size !== catalog.assets.length ||
          catalog.assets.some(a=>typeof a.assetId!=='string' || !/^[A-Za-z0-9:-]{1,160}$/.test(a.assetId) || !['image/png','image/jpeg'].includes(a.contentType) || !['finished','owner_color_exception'].includes(a.kind) || !/^[a-f0-9]{64}$/.test(a.sha256) ||
            !/^[a-zA-Z0-9.-]+$/.test(a.storageKey) || !Number.isSafeInteger(a.byteSize) || a.byteSize <= 0 || a.byteSize > 100*1024*1024 ||
            a.kind === 'owner_color_exception' && !catalog.supplierSkuIds.includes(a.onlySourceSkuId))) throw new Error('SIBLING_CATALOG_INVALID');
      return catalog;
    },
    async readAsset(catalog, assetId) {
      const a = catalog.assets.find(x=>x.assetId===assetId);
      if (!a) throw new Error('SIBLING_CATALOG_ASSET_NOT_ALLOWED');
      const root = await fs.realpath(directory), target = path.join(root,a.storageKey);
      if (await fs.realpath(target) !== target) throw new Error('SIBLING_CATALOG_ASSET_PATH_CHANGED');
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size !== a.byteSize) throw new Error('SIBLING_CATALOG_ASSET_CHANGED');
      const body = await fs.readFile(target);
      if (createHash('sha256').update(body).digest('hex') !== a.sha256) throw new Error('SIBLING_CATALOG_ASSET_CHANGED');
      return { body, contentType: a.contentType };
    }
  });
}
