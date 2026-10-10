/**
 * 主人点"读本店销量"（或以后由启用的每日计划触发）→ 先落一条 running 记录 → 本机只读 Seller API 读近 8 周按 SKU
 * 汇总 → 按店铺档案的 seedPolicy 挑出找相似的种子 → 原子保存成一份追加的销量快照。Seerfar 今天的"本店爆款找相似"
 * 只读这家店最新一份成功的快照。
 *
 * 一家店一个业务日只读一次（失败的不算）；同一时刻只跑一次；失败只记失败层和是否发过请求，不重试。读的全是
 * 只读接口，重启时把卡在 running 的记录收口成"被打断"，不会产生半套写入。
 */
import { randomUUID } from 'node:crypto';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { readStoreProfile } from './store-profile.mjs';
import { OzonStoreSalesReadError, STORE_SALES_FAILURES } from './ozon-store-sales-reader.mjs';
import { STORE_SALES_SNAPSHOT_SCHEMA, pickStoreSeeds, planSeed, storeSalesWindows } from './store-sales-seeds.mjs';

export const STORE_SALES_COLLECTION = 'storeSalesSnapshots';
const FAILURES = Object.freeze({ ...STORE_SALES_FAILURES, exchange_rate_missing: '没有可用的卢布兑人民币汇率，定不了找相似的价格带',
  interrupted: '读到一半服务重启了，这次没有结果', system_error: '读取时出了没预料到的错误' });
const httpFail = (status, code, message) => Object.assign(new Error(message), { code, status, publicMessage: message });

export function storeSalesSnapshots(document) {
  document.runtime ||= {};
  document.runtime[STORE_SALES_COLLECTION] ||= {};
  return document.runtime[STORE_SALES_COLLECTION];
}

const byNewest = (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt);

/** The newest completed snapshot per store; Seerfar's similar-search reads only this. */
export function latestStoreSalesSnapshot(document, targetStore) {
  return Object.values(document.runtime?.[STORE_SALES_COLLECTION] || {})
    .filter(record => record.targetStore === targetStore && record.status === 'completed').sort(byNewest)[0] || null;
}

export function storeSeedsForPlan(document, targetStore) {
  return (latestStoreSalesSnapshot(document, targetStore)?.seeds || []).map(planSeed);
}

function publicSnapshot(record) {
  if (!record) return null;
  const totals = (record.rows || []).reduce((sum, row) => ({ recentUnits: sum.recentUnits + row.recent.units, priorUnits: sum.priorUnits + row.prior.units }),
    { recentUnits: 0, priorUnits: 0 });
  return { snapshotId: record.snapshotId, targetStore: record.targetStore, businessDate: record.businessDate, status: record.status,
    startedAt: record.startedAt, completedAt: record.completedAt, windows: record.windows, skuCount: (record.rows || []).length, ...totals,
    rubPerCny: record.rubPerCny ?? null, profileVersion: record.profileVersion, seeds: record.seeds || [], skipped: record.skipped || [],
    failure: record.failure };
}

export function createStoreSalesSeedService({ readData, mutateData, mutateDataWhenChanged, now, businessDate, reader, config, estimateInputs, log = () => {} }) {
  if ([readData, mutateData, mutateDataWhenChanged, now, businessDate].some(fn => typeof fn !== 'function') ||
      typeof estimateInputs?.resolveExchangeRate !== 'function') throw new TypeError('STORE_SALES_SEED_SERVICE_DEPENDENCY_INVALID');
  const running = new Set();

  function view(document) {
    const stores = Object.keys(config?.profiles || {});
    return Object.fromEntries(stores.map(store => {
      const records = Object.values(document.runtime?.[STORE_SALES_COLLECTION] || {}).filter(record => record.targetStore === store).sort(byNewest);
      const latest = records[0] || null;
      return [store, { configured: Boolean(reader?.stores().includes(store)), running: running.has(store),
        readToday: records.some(record => record.businessDate === businessDate() && record.status === 'completed'),
        latest: publicSnapshot(latest), latestCompleted: publicSnapshot(records.find(record => record.status === 'completed') || null) }];
    }));
  }

  async function finish(snapshotId, apply) {
    return mutateDataWhenChanged(document => {
      const records = storeSalesSnapshots(document);
      const record = records[snapshotId];
      if (!record || record.status !== 'running') return { changed: false };
      const next = apply(structuredClone(record));
      assertSafeRuntimeRecord(next);
      records[snapshotId] = next;
      return { changed: true, result: next };
    });
  }

  const failWith = (snapshotId, code, facts = {}) => finish(snapshotId, record => ({ ...record, status: 'failed', completedAt: now(),
    failure: { code, reason: FAILURES[code] || FAILURES.system_error, requestsSent: facts.requestsSent ?? null, httpStatus: facts.httpStatus ?? null } }));

  async function run(record, profile) {
    try {
      const body = await reader.read({ targetStore: record.targetStore, windows: record.windows, readAt: now() });
      const fx = await estimateInputs.resolveExchangeRate(await readData(), now());
      if (!(fx?.rubPerCny > 0)) return await failWith(record.snapshotId, 'exchange_rate_missing', { requestsSent: body.requestsSent });
      const picked = pickStoreSeeds({ rows: body.rows, policy: profile.seedPolicy, rubPerCny: fx.rubPerCny });
      return await finish(record.snapshotId, current => ({ ...current, status: 'completed', completedAt: now(), source: body.source,
        requestsSent: body.requestsSent, rows: body.rows, rubPerCny: fx.rubPerCny, rateDate: fx.rateDate ?? null,
        seeds: picked.seeds, skipped: picked.skipped, failure: null }));
    } catch (error) {
      if (error instanceof OzonStoreSalesReadError) return failWith(record.snapshotId, error.code, error);
      log('STORE_SALES_READ_FAILED', error?.name || 'Error');
      return failWith(record.snapshotId, 'system_error');
    } finally {
      running.delete(record.targetStore);
    }
  }

  /** Starts one read and returns as soon as its running record is saved; the page polls the view. */
  async function startRead({ actor, targetStore }) {
    const profile = readStoreProfile(await readData(), targetStore, { config });
    if (!profile) throw httpFail(400, 'STORE_UNKNOWN', '这家店没有选品档案。');
    if (!reader?.stores().includes(targetStore)) throw httpFail(409, 'NOT_CONFIGURED', `${FAILURES.not_configured}，没有读。`);
    if (running.has(targetStore)) throw httpFail(409, 'ALREADY_RUNNING', '这家店的销量正在读，不会再读一次。');
    running.add(targetStore);
    let record;
    try {
      record = await mutateData(document => {
        const records = storeSalesSnapshots(document);
        const date = businessDate();
        if (Object.values(records).some(value => value.targetStore === targetStore && value.businessDate === date && value.status === 'completed')) {
          throw httpFail(409, 'ALREADY_READ_TODAY', '这家店今天已经读过销量，同一天不重复读。');
        }
        const created = { snapshotId: `store-sales:${randomUUID()}`, schemaVersion: STORE_SALES_SNAPSHOT_SCHEMA, targetStore, businessDate: date,
          status: 'running', requestedBy: actor?.userId ?? null, startedAt: now(), completedAt: null, windows: storeSalesWindows(date),
          profileVersion: profile.version, failure: null };
        assertSafeRuntimeRecord(created);
        records[created.snapshotId] = created;
        return created;
      });
    } catch (error) {
      running.delete(targetStore);
      throw error;
    }
    void run(record, profile);
    return publicSnapshot(record);
  }

  /** A read that was in flight when the process stopped has no result; reads change nothing, so it simply closes. */
  async function reconcileAfterRestart() {
    return mutateDataWhenChanged(document => {
      const closed = [];
      for (const [id, record] of Object.entries(storeSalesSnapshots(document))) {
        if (record.status !== 'running' || running.has(record.targetStore)) continue;
        storeSalesSnapshots(document)[id] = { ...record, status: 'failed', completedAt: now(),
          failure: { code: 'interrupted', reason: FAILURES.interrupted, requestsSent: null, httpStatus: null } };
        closed.push(id);
      }
      return { changed: closed.length > 0, result: closed };
    });
  }

  return Object.freeze({ view, startRead, reconcileAfterRestart, isRunning: store => running.has(store) });
}
