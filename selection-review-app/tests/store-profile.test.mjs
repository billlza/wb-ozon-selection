import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSeerfarSelectionConfig } from '../lib/seerfar-selection-config.mjs';
import { DEFAULT_PRESALE_MAX_DAYS, SKIP_REASONS, StoreProfileError, readPresaleMaxDays, readStoreProfile, readStoreProfiles, recordSkipReason,
  skipReasonSummary, storeProfileView, updateStoreProfile } from '../lib/store-profile.mjs';

const owner = { userId: 'user:owner' };
const AT = '2026-10-10T05:00:00.000Z';
const fails = (fn, code) => assert.throws(fn, error => error instanceof StoreProfileError && error.code === code);

test('the shipped defaults: Miska for girls (home, ornaments, small odd things, pet items), 蛋蛋鼠 toys, 14 days of presale', async () => {
  const config = await loadSeerfarSelectionConfig();
  const document = { runtime: {} };
  const miska = readStoreProfile(document, 'miska', { config });
  assert.equal(miska.source, 'config');
  assert.match(miska.positioning, /女生用户/);
  assert.match(miska.positioning, /宠物用品/);
  assert.ok(miska.categoryPaths.some(path => path.startsWith('宠物用品 > ')));
  assert.equal(readStoreProfile(document, 'dandanshu', { config }).positioning, '玩具大类');
  assert.equal(readPresaleMaxDays(document, 'miska', { config }), 14);
  assert.equal(readPresaleMaxDays(document, 'wb', { config }), DEFAULT_PRESALE_MAX_DAYS);
  assert.equal(readStoreProfile(document, 'wb', { config }), null);
});

test('an owner edit is a new version on top of the defaults; a stale version is refused and history is kept', async () => {
  const config = await loadSeerfarSelectionConfig();
  const document = { runtime: {} };
  const base = readStoreProfile(document, 'miska', { config }).version;
  const edited = updateStoreProfile(document, { targetStore: 'miska', baseVersion: base, values: { presaleMaxDays: 7, priceRub: { min: 600, max: 4000 } },
    actor: owner, at: AT, config });
  assert.equal(edited.source, 'owner_edit');
  assert.equal(edited.version, 'miska-owner-1');
  assert.equal(readPresaleMaxDays(document, 'miska', { config }), 7);
  // Fields not edited still come from the defaults, and the Seerfar plan reads the edited profile.
  assert.equal(edited.maxWeightGrams, 2000);
  assert.deepEqual(readStoreProfiles(document, { config }).miska.priceRub, { min: 600, max: 4000 });
  fails(() => updateStoreProfile(document, { targetStore: 'miska', baseVersion: base, values: { presaleMaxDays: 3 }, actor: owner, at: AT, config }), 'VERSION_CONFLICT');
  const second = updateStoreProfile(document, { targetStore: 'miska', baseVersion: 'miska-owner-1', values: { maxWeightGrams: 1500 }, actor: owner, at: AT, config });
  assert.equal(second.presaleMaxDays, 7);
  assert.deepEqual(storeProfileView(document, 'miska', { config }).history.map(entry => entry.version), ['miska-owner-1', 'miska-owner-2']);
  for (const values of [{ seedPolicy: {} }, { presaleMaxDays: 91 }, { priceRub: { min: 900, max: 800 } }, {}]) {
    fails(() => updateStoreProfile(document, { targetStore: 'miska', baseVersion: 'miska-owner-2', values, actor: owner, at: AT, config }), 'INPUT_INVALID');
  }
  fails(() => updateStoreProfile(document, { targetStore: 'wb', baseVersion: 'x', values: { presaleMaxDays: 3 }, actor: owner, at: AT, config }), 'STORE_UNKNOWN');
});

test('不做 reasons come from one fixed set, are appended with the profile version, and are only summarized', async () => {
  const config = await loadSeerfarSelectionConfig();
  const document = { runtime: {}, candidates: [] };
  assert.deepEqual(Object.values(SKIP_REASONS), ['尺寸太大', '利润太薄', '品牌风险', '不想做这类', '其他']);
  const saved = recordSkipReason(document, { targetStore: 'miska', candidateId: 'candidate:1', dataRevision: 3, reason: 'thin_profit', actor: owner, at: AT, config });
  assert.equal(saved.reasonLabel, '利润太薄');
  assert.equal(saved.profileVersion, readStoreProfile(document, 'miska', { config }).version);
  recordSkipReason(document, { targetStore: 'miska', candidateId: 'candidate:2', dataRevision: 1, reason: 'other', note: '颜色太丑', actor: owner,
    at: '2026-10-10T06:00:00.000Z', config });
  fails(() => recordSkipReason(document, { targetStore: 'miska', candidateId: 'candidate:3', dataRevision: 1, reason: 'other', actor: owner, at: AT, config }), 'NOTE_REQUIRED');
  fails(() => recordSkipReason(document, { targetStore: 'miska', candidateId: 'candidate:3', dataRevision: 1, reason: 'too_cheap', actor: owner, at: AT, config }), 'REASON_INVALID');
  const summary = skipReasonSummary(document, 'miska');
  assert.equal(summary.total, 2);
  assert.equal(summary.counts.thin_profit, 1);
  assert.equal(summary.recent[0].note, '颜色太丑');
  assert.equal(skipReasonSummary(document, 'dandanshu').total, 0);
  // Recording a reason never touches the candidate list.
  assert.deepEqual(document.candidates, []);
});
