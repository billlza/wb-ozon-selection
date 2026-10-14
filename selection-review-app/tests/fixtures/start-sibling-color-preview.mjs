import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { siblingColorState } from './sibling-color-state.mjs';
import { createLocalOwnerIdentityProvider, createPrivateOwnerCredentialRepository } from '../../lib/local-owner-identity.mjs';

const appDir = fileURLToPath(new URL('../..', import.meta.url));
const appPort = Number(process.argv[2] ?? 60740);
const evidencePort = Number(process.argv[3] ?? 60741);
if (![appPort, evidencePort].every(value => Number.isSafeInteger(value) && value > 0 && value < 65536 &&
    ![4317, 4318, 4173].includes(value)) || appPort === evidencePort) {
  throw new Error('PREVIEW_REQUIRES_DISTINCT_ISOLATED_PORTS');
}
const directory = await mkdtemp(path.join(tmpdir(), 'sibling-color-preview-'));
const businessDirectory = path.join(directory, 'business');
const dataFile = path.join(businessDirectory, 'state.json');
const privateDirectory = path.join(directory, 'private');
await mkdir(businessDirectory);
await mkdir(privateDirectory, { mode: 0o700 });
const ownerIdentityFile = path.join(privateDirectory, 'owner.json');
const syntheticOwnerPassword = randomBytes(18).toString('base64url');
const ownerProvider = createLocalOwnerIdentityProvider({ credentialRepository:
  createPrivateOwnerCredentialRepository({ filePath: ownerIdentityFile,
    protectedPaths: [appDir, businessDirectory] }) });
await ownerProvider.initialize();
await ownerProvider.setup({ password: syntheticOwnerPassword });
const state = siblingColorState();
await writeFile(dataFile, JSON.stringify(state));
const storeRef = state.candidates[0].storeRef;
const schema = state.candidates[1].lifecycleV11.skuPackage.c1ProductPlan.inputSnapshots.platformSchemaRules;

// A single synthetic dictionary answer makes the manual mapping path testable
// without any Ozon account. Every other dependency request is rejected.
const evidence = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  let query;
  try { query = JSON.parse(body); } catch { query = null; }
  const valid = request.method === 'POST' && request.url === '/api/read-only/evidence/ozon' &&
    query?.kind === 'schema_dictionary_values' && query.platform === 'ozon' &&
    query.store === schema.store && query.category === `ozon:${schema.descriptionCategoryId}:${schema.typeId}` &&
    query.attributeId === '10096' && query.limit === 200;
  response.setHeader('Content-Type', 'application/json');
  if (!valid) {
    response.writeHead(503);
    response.end(JSON.stringify({ error: 'preview_only_synthetic_dictionary_query_allowed' }));
    return;
  }
  const value = { value: 'synthetic-broad-color', valueZh: '合成广义颜色', dictionaryValueId: 910096 };
  const checkedAt = new Date();
  response.end(JSON.stringify({ ok: true, evidence: {
    current: true, scope: { platform: query.platform, store: query.store,
      category: query.category, attributeId: query.attributeId },
    sourceRef: 'synthetic:dictionary:10096', checkedAt: checkedAt.toISOString(),
    expiresAt: new Date(checkedAt.getTime() + 24 * 60 * 60_000).toISOString(),
    evidenceData: { attributeId: '10096', complete: true, values: [value] }
  } }));
});
await new Promise((resolve, reject) => {
  evidence.once('error', reject);
  evidence.listen(evidencePort, '127.0.0.1', resolve);
});

const origin = `http://127.0.0.1:${appPort}`;
const env = {
  PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(),
  SELECTION_REVIEW_PORT: String(appPort), SELECTION_REVIEW_BIND_HOST: '127.0.0.1',
  SELECTION_REVIEW_DATA_FILE: dataFile, SELECTION_REVIEW_PUBLIC_ORIGIN: origin,
  SELECTION_REVIEW_ALLOWED_ORIGINS: origin,
  SELECTION_REVIEW_IDENTITY_PROVIDER: 'local_owner_password',
  SELECTION_REVIEW_OWNER_IDENTITY_FILE: ownerIdentityFile,
  SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{
    targetStore: storeRef.stableStoreId, platform: 'ozon', storeRef
  }]),
  SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: '[]',
  SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: '[]',
  SELECTION_REVIEW_D_PLATFORM_OBSERVATION_JSON: '{"policies":[],"pumpIntervalMs":null}',
  SELECTION_REVIEW_OZON_EVIDENCE_SERVICE_URL: `http://127.0.0.1:${evidencePort}`,
  SELECTION_REVIEW_CODEX_DISPATCH: 'off', SELECTION_REVIEW_AUTO_DELIVER: 'off'
};
const app = spawn(process.execPath, [path.join(appDir, 'server.mjs')], {
  cwd: appDir, env, stdio: 'inherit'
});
const stop = () => {
  app.kill('SIGTERM');
  evidence.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
app.once('exit', code => { evidence.close(); process.exitCode = code ?? 1; });
console.log(`Synthetic sibling preview: ${origin}`);
console.log(`State: ${dataFile}`);
console.log(`Synthetic owner password for this preview only: ${syntheticOwnerPassword}`);
console.log('Candidates: SYNTHETIC-COLOR-FROZEN, SYNTHETIC-COLOR-EDITABLE');
console.log('Dictionary query: 10096 = synthetic-broad-color; text: 10097 = synthetic-exact-color');
