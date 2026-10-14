import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { allocatedTestPorts } from '../helpers/api-process-lifecycle.mjs';

/** One bounded receipt fault, after the real isolated API has handled the request. */
export function s1WorkspaceFaultProxy() {
  if (process.env.SELECTION_REVIEW_S1_BROWSER_FIXTURE !== '1') return null;
  const { api, second } = allocatedTestPorts();
  const stateFile = process.env.SELECTION_REVIEW_S1_BROWSER_STATE_FILE;
  if (!stateFile?.endsWith('/business/state.json')) throw new Error('S1_BROWSER_STATE_FILE_REQUIRED');
  let loseNextReceipt = false, original = null;
  const counts = { postRequests: 0, transmittedRequests: 0, lostReceipts: 0, upstreamErrors: 0 };
  const business = document => ({ candidates: document.candidates.map(candidate => {
    const copy = structuredClone(candidate); delete copy.siblingPreparationDraftRefV1; return copy;
  }), jobs: document.runtime.softwareJobs, idempotency: document.runtime.idempotencyRecords, dispatches: document.dispatches });
  return { name: 's1-workspace-isolated-receipt', async configureServer(server) {
    original = business(JSON.parse(await readFile(stateFile, 'utf8')));
    server.middlewares.use((request, response, next) => {
      if (request.url === '/__s1-fixture/lost-receipt' && request.method === 'POST') {
        if (request.headers.origin !== `http://127.0.0.1:${second}`) {
          response.writeHead(403); response.end('S1_FIXTURE_ORIGIN_REQUIRED'); return;
        }
        loseNextReceipt = true;
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"armed":true}'); return;
      }
      if (request.url === '/__s1-fixture/evidence' && request.method === 'GET') {
        readFile(stateFile, 'utf8').then(text => {
          const document = JSON.parse(text);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ...counts, armed: loseNextReceipt,
            businessUnchanged: isDeepStrictEqual(business(document), original),
            drafts: (document.runtime.siblingPreparationDrafts ?? []).map(draft => ({
              draftRevision: draft.draftRevision, idempotencyKey: draft.idempotencyKey, values: draft.values
            })) }));
        }).catch(next);
        return;
      }
      if (request.method !== 'POST' || !/^\/api\/sibling-batches\/[^/]+\/preparation-draft$/u.test(request.url)) { next(); return; }
      const loseReceipt = loseNextReceipt; loseNextReceipt = false; counts.postRequests += 1;
      const upstream = http.request({ hostname: '127.0.0.1', port: api, path: request.url,
        method: 'POST', headers: request.headers }, received => {
        const chunks = []; let size = 0;
        received.on('data', chunk => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) upstream.destroy(new Error('S1_FIXTURE_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        received.once('end', () => {
          let body = Buffer.concat(chunks);
          if (loseReceipt && received.statusCode === 200) {
            counts.lostReceipts += 1; body = Buffer.from('{"synthetic_lost_receipt":');
          }
          const headers = { ...received.headers, 'content-length': String(body.length) };
          delete headers['transfer-encoding'];
          response.writeHead(received.statusCode, headers); response.end(body);
        });
      });
      counts.transmittedRequests += 1;
      upstream.setTimeout(6000, () => upstream.destroy(new Error('S1_FIXTURE_UPSTREAM_TIMEOUT')));
      upstream.once('error', () => {
        counts.upstreamErrors += 1;
        if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' });
        if (!response.writableEnded) response.end('{"code":"S1_FIXTURE_UPSTREAM_FAILED"}');
      });
      request.once('aborted', () => upstream.destroy(new Error('S1_FIXTURE_CLIENT_ABORTED')));
      request.pipe(upstream);
    });
  } };
}
