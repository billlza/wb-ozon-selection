/**
 * 店铺档案：每家店卖什么、价格带、重量上限、货源预售最多能等几天，以及主人说「不做」时选的原因。
 * Seerfar 自动选品、录入流水线（预售上限）和「做这件」确认卡（记不做原因）都只经这里读写，不各自另存一份。
 *
 * 默认值是 data/seerfar-selection/store-profiles.json 里的版本化配置；主人在工作台里改的，追加成新版本存进
 * document.runtime.storeProfileEdits，最新一版优先生效，旧版本保留。不做原因追加进 document.runtime.storeSkipReasons，
 * 只记录、只汇总，不会自动改档案或淘汰别的商品（AGENTS.md §3.4、§11）。
 */
import { randomUUID } from 'node:crypto';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';
import { assertStoreSelectionProfile } from './seerfar-selection-plan.mjs';

export const STORE_PROFILE_EDIT_COLLECTION = 'storeProfileEdits';
export const STORE_SKIP_REASON_COLLECTION = 'storeSkipReasons';
export const DEFAULT_PRESALE_MAX_DAYS = 14;
/** 主人可以在工作台里改的字段；Seerfar 的销量线、每轮收几个和爆款门槛仍只在配置里改。 */
export const EDITABLE_PROFILE_FIELDS = Object.freeze(['positioning', 'categoryPaths', 'excludedCategoryPaths', 'priceRub', 'maxWeightGrams', 'presaleMaxDays']);
/** 「做这件」确认卡和录入页共用的同一组不做原因（2026-10-10 各线程对齐）。 */
export const SKIP_REASONS = Object.freeze({ too_large: '尺寸太大', thin_profit: '利润太薄', brand_risk: '品牌风险', not_this_kind: '不想做这类', other: '其他' });

export class StoreProfileError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'StoreProfileError';
    this.code = code;
    this.status = status;
    this.publicMessage = message;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const collection = (document, name) => {
  document.runtime ||= {};
  document.runtime[name] ||= {};
  return document.runtime[name];
};
const edits = (document, targetStore) => Object.values(document.runtime?.[STORE_PROFILE_EDIT_COLLECTION] || {})
  .filter(edit => edit.targetStore === targetStore).sort((left, right) => left.sequence - right.sequence);

/**
 * The profile in force for one store: the config default with the newest owner edit on top. Returns the full Seerfar
 * selection profile shape, plus where it came from, or null for a store with no profile.
 */
export function readStoreProfile(document, targetStore, { config }) {
  const base = config?.profiles?.[targetStore];
  if (!base) return null;
  const latest = edits(document, targetStore).at(-1);
  if (!latest) return { ...structuredClone(base), source: 'config', editedBy: null, editedAt: null };
  const merged = assertStoreSelectionProfile({ ...structuredClone(base), ...structuredClone(latest.values), version: latest.version });
  return { ...merged, source: 'owner_edit', editedBy: latest.editedBy, editedAt: latest.editedAt };
}

/** Every store's profile in force, keyed by store, in the shape planSeerfarQueries reads. */
export function readStoreProfiles(document, { config }) {
  return Object.fromEntries(Object.keys(config?.profiles || {}).map(store => {
    const { source, editedBy, editedAt, ...profile } = readStoreProfile(document, store, { config });
    return [store, profile];
  }));
}

/** The intake pipeline's presale limit: a source that ships later than this many days is not worth waiting for. */
export function readPresaleMaxDays(document, targetStore, { config }) {
  return readStoreProfile(document, targetStore, { config })?.presaleMaxDays ?? DEFAULT_PRESALE_MAX_DAYS;
}

/**
 * The owner changes some of a store's editable fields. `baseVersion` is the version the owner was looking at, so two
 * edits from two tabs never silently overwrite each other. Saves a new version and keeps every earlier one.
 */
export function updateStoreProfile(document, { targetStore, baseVersion, values, actor, at, config }) {
  const current = readStoreProfile(document, targetStore, { config });
  if (!current) throw new StoreProfileError('STORE_UNKNOWN', '这家店没有店铺档案。');
  if (baseVersion !== current.version) throw new StoreProfileError('VERSION_CONFLICT', '店铺档案刚被改过，请刷新后再改。', 409);
  if (!isObject(values) || !Object.keys(values).length || Object.keys(values).some(key => !EDITABLE_PROFILE_FIELDS.includes(key))) {
    throw new StoreProfileError('INPUT_INVALID', '店铺档案里只能改定位、类目、价格带、重量上限和预售天数。');
  }
  const sequence = edits(document, targetStore).length + 1;
  const version = `${targetStore}-owner-${sequence}`;
  const previous = edits(document, targetStore).at(-1)?.values || {};
  const kept = { ...previous, ...structuredClone(values) };
  try { assertStoreSelectionProfile({ ...structuredClone(config.profiles[targetStore]), ...kept, version }); }
  catch { throw new StoreProfileError('INPUT_INVALID', '店铺档案的值不对（类目不能重复，价格带下限不能高于上限，预售天数 0 到 90）。'); }
  const edit = { editId: `store-profile-edit:${randomUUID()}`, targetStore, sequence, version, baseVersion, values: kept,
    editedBy: actor?.userId ?? null, editedAt: at };
  assertSafeRuntimeRecord(edit);
  collection(document, STORE_PROFILE_EDIT_COLLECTION)[edit.editId] = edit;
  return readStoreProfile(document, targetStore, { config });
}

/**
 * The「做这件」card's 不做: one record per decision, with the profile version it was made under. Called inside the
 * card's own transaction, which owns the candidate's state and revision; this only appends the reason.
 */
export function recordSkipReason(document, { targetStore, candidateId, dataRevision, reason, note = null, actor, at, config }) {
  const profile = readStoreProfile(document, targetStore, { config });
  if (!profile) throw new StoreProfileError('STORE_UNKNOWN', '这家店没有店铺档案。');
  if (!Object.hasOwn(SKIP_REASONS, reason)) throw new StoreProfileError('REASON_INVALID', '不做的原因只能选：尺寸太大、利润太薄、品牌风险、不想做这类、其他。');
  if (note !== null && (typeof note !== 'string' || note.trim() !== note || note.length > 200 || /\p{Cc}/u.test(note))) {
    throw new StoreProfileError('NOTE_INVALID', '补充说明最多 200 个字。');
  }
  if (reason === 'other' && !note) throw new StoreProfileError('NOTE_REQUIRED', '选「其他」时请写一句原因。');
  if (typeof candidateId !== 'string' || !candidateId || !Number.isSafeInteger(dataRevision)) throw new StoreProfileError('INPUT_INVALID', '缺少商品或商品版本。');
  const record = { skipId: `store-skip:${randomUUID()}`, targetStore, candidateId, dataRevision, reason, reasonLabel: SKIP_REASONS[reason], note,
    profileVersion: profile.version, decidedBy: actor?.userId ?? null, decidedAt: at };
  assertSafeRuntimeRecord(record);
  collection(document, STORE_SKIP_REASON_COLLECTION)[record.skipId] = record;
  return structuredClone(record);
}

/** How often each reason was picked for one store, newest first; for the profile page, never an automatic rule. */
export function skipReasonSummary(document, targetStore, { limit = 20 } = {}) {
  const records = Object.values(document.runtime?.[STORE_SKIP_REASON_COLLECTION] || {}).filter(record => record.targetStore === targetStore)
    .sort((left, right) => Date.parse(right.decidedAt) - Date.parse(left.decidedAt));
  const counts = Object.fromEntries(Object.keys(SKIP_REASONS).map(reason => [reason, 0]));
  for (const record of records) counts[record.reason] += 1;
  return { total: records.length, counts, recent: records.slice(0, limit).map(record => structuredClone(record)) };
}

/** What the workbench shows for one store's profile. */
export function storeProfileView(document, targetStore, { config }) {
  const profile = readStoreProfile(document, targetStore, { config });
  if (!profile) return null;
  return { targetStore, version: profile.version, source: profile.source, editedBy: profile.editedBy, editedAt: profile.editedAt,
    ...Object.fromEntries(EDITABLE_PROFILE_FIELDS.map(field => [field, structuredClone(profile[field])])),
    history: edits(document, targetStore).map(edit => ({ version: edit.version, editedBy: edit.editedBy, editedAt: edit.editedAt })),
    skipReasons: skipReasonSummary(document, targetStore) };
}
