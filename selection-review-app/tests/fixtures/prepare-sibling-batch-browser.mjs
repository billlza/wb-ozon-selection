import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readyAuthorizationFamily, secondReadyMember } from './sibling-batch-final-fixture.mjs';

const { parent, child } = readyAuthorizationFamily();
const second = secondReadyMember(parent);
const third = secondReadyMember(parent, { candidateId: 'candidate:synthetic-third',
  supplierSkuId: 'SHELF-THIRD', color: '蓝色', merchantSku: 'MERCHANT-THIRD' });
const target = fileURLToPath(new URL('./sibling-batch-browser-data.json', import.meta.url));
await writeFile(target, JSON.stringify({ parent, siblings: [child, second, third] }));
process.stdout.write(`${target}\n`);
