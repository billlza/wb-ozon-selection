import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialStoreError, createFakeCredentialStore } from '../lib/credential-store.mjs';
import { SEERFAR_ACCOUNT_KEYCHAIN_ACCOUNT, SEERFAR_ACCOUNT_KEYCHAIN_SERVICE, createSeerfarAccountVault, isSeerfarAccountIdentityStatus,
  maskSeerfarAccountIdentity, pickSeerfarAccountIdentity, seerfarAccountIdentityFailure } from '../lib/seerfar-account-identity.mjs';
import { SEERFAR_KEYCHAIN_SERVICE } from '../lib/seerfar-runtime-connector.mjs';

// Every account ID, phone number and mail address below is synthetic.
const AT = '2026-10-15T09:30:00.000Z';
const ENTRY = { service: SEERFAR_ACCOUNT_KEYCHAIN_SERVICE, account: SEERFAR_ACCOUNT_KEYCHAIN_ACCOUNT };
const stored = store => JSON.parse(Buffer.from(store.value, 'base64').toString('utf8'));
// A fake store that also lets the test read what the vault wrote.
function keychain(entries = []) {
  const fake = createFakeCredentialStore(entries);
  const view = { calls: fake.calls, backend: 'macos_keychain', value: null,
    readSecret: (...args) => fake.readSecret(...args),
    writeSecret: async (entry, value, options) => { await fake.writeSecret(entry, value, options); view.value = value; } };
  return view;
}
const encode = identity => Buffer.from(JSON.stringify({ schemaVersion: 'seerfar-web-account-v1', ...identity, savedAt: AT })).toString('base64');

test('the keychain entry sits next to the Seerfar open API key under its own account name', () => {
  assert.equal(SEERFAR_ACCOUNT_KEYCHAIN_SERVICE, SEERFAR_KEYCHAIN_SERVICE);
  assert.equal(SEERFAR_ACCOUNT_KEYCHAIN_ACCOUNT, 'seerfar-web-account');
});

test('the three fields are found wherever the request keeps them, and only when they look like what their key says', () => {
  assert.deepEqual(pickSeerfarAccountIdentity({ pageNum: 1, memberId: 80012345, data: { userPhone: '138 1234 5678', contact: { Email: ' Owner.Test@QQ.com ' } } }),
    { accountId: '80012345', phone: '13812345678', email: 'owner.test@qq.com' });
  // The most specific account key wins wherever it sits; a bare "user" only when nothing better is there.
  assert.equal(pickSeerfarAccountIdentity({ user: 'fallback', nested: { accountId: 'acc-9' } }).accountId, 'acc-9');
  assert.equal(pickSeerfarAccountIdentity({ user: 'fallback' }).accountId, 'fallback');
  assert.equal(pickSeerfarAccountIdentity({ mobile: '+7 (912) 345-67-89' }).phone, '+79123456789');
  // Nothing is read under a credential key, and values of the wrong shape are not identities.
  assert.deepEqual(pickSeerfarAccountIdentity({ token: { accountId: 'hidden' }, sessionUser: 'x', authEmail: 'a@b.cn', signPhone: '13800000000' }),
    { accountId: null, phone: null, email: null });
  assert.deepEqual(pickSeerfarAccountIdentity({ userId: 'eyJhbGciOiJIUzI1NiJ9.e30.sig', phone: 'call me', email: 'not-a-mail', mail: 'x@y' }),
    { accountId: null, phone: null, email: null });
  assert.deepEqual(pickSeerfarAccountIdentity({ userId: 'has space', uid: -3, account: 'x'.repeat(65) }), { accountId: null, phone: null, email: null });
  assert.deepEqual(pickSeerfarAccountIdentity(null), { accountId: null, phone: null, email: null });
  assert.deepEqual(pickSeerfarAccountIdentity('accountId=1'), { accountId: null, phone: null, email: null });
  // Deeper than four levels is not looked at.
  assert.equal(pickSeerfarAccountIdentity({ a: { b: { c: { d: { e: { phone: '13812345678' } } } } } }).phone, null);
});

test('masking keeps only the ends of each value', () => {
  assert.deepEqual(maskSeerfarAccountIdentity({ accountId: '80012345', phone: '13812345678', email: 'owner.test@qq.com' }),
    { accountId: '80****45', phone: '138****5678', email: 'o***@qq.com' });
  assert.deepEqual(maskSeerfarAccountIdentity({ accountId: 'ab123', phone: '+79123456789', email: null }),
    { accountId: 'a****3', phone: '+791****6789', email: null });
  assert.equal(maskSeerfarAccountIdentity({ accountId: '1234', phone: '1234567', email: null }).accountId, '****');
  assert.equal(maskSeerfarAccountIdentity({ accountId: '1234', phone: '1234567', email: null }).phone, '12****67');
  assert.equal(maskSeerfarAccountIdentity({ accountId: 'me@mail.ru', phone: null, email: null }).accountId, 'm***@mail.ru');
});

test('the first save writes the full values to the keychain and the round keeps only masks', async () => {
  const store = keychain();
  const vault = createSeerfarAccountVault({ credentialStore: store });
  const status = await vault.save({ accountId: '80012345', phone: '13812345678', email: 'owner.test@qq.com' }, { at: AT });
  assert.deepEqual(status, { schemaVersion: 'seerfar-web-account-identity-v1', status: 'saved', fields: ['accountId', 'phone', 'email'],
    masked: { accountId: '80****45', phone: '138****5678', email: 'o***@qq.com' }, sameAsPrevious: null, location: 'macos_keychain', failure: null });
  assert.equal(isSeerfarAccountIdentityStatus(status), true);
  assert.deepEqual(stored(store), { schemaVersion: 'seerfar-web-account-v1', accountId: '80012345', phone: '13812345678',
    email: 'owner.test@qq.com', savedAt: AT });
  assert.deepEqual(store.calls.map(call => [call.mode, call.service, call.account]), [['read', ...Object.values(ENTRY)], ['write', ...Object.values(ENTRY)]]);
  const shown = JSON.stringify(status);
  for (const full of ['80012345', '13812345678', 'owner.test@qq.com']) assert.equal(shown.includes(full), false, full);
});

test('the same account keeps its older fields and is not rewritten when nothing changed; another account replaces it whole', async () => {
  const store = keychain([{ ...ENTRY, value: encode({ accountId: '80012345', phone: '13812345678', email: null }) }]);
  const vault = createSeerfarAccountVault({ credentialStore: store });
  let status = await vault.save({ accountId: '80012345', phone: null, email: null }, { at: AT });
  assert.equal(status.sameAsPrevious, true);
  assert.deepEqual(status.fields, ['accountId']);
  assert.deepEqual(status.masked, { accountId: '80****45', phone: '138****5678', email: null });
  assert.equal(store.calls.filter(call => call.mode === 'write').length, 0, 'nothing new: no write');

  status = await vault.save({ accountId: '80012345', phone: null, email: 'owner.test@qq.com' }, { at: AT });
  assert.equal(status.sameAsPrevious, true);
  assert.deepEqual(stored(store), { schemaVersion: 'seerfar-web-account-v1', accountId: '80012345', phone: '13812345678',
    email: 'owner.test@qq.com', savedAt: AT });

  status = await vault.save({ accountId: '90000001', phone: null, email: null }, { at: AT });
  assert.equal(status.sameAsPrevious, false);
  assert.deepEqual(stored(store), { schemaVersion: 'seerfar-web-account-v1', accountId: '90000001', phone: null, email: null, savedAt: AT });

  // Nothing in common to compare: the new values replace the old ones, never mixed in with them.
  status = await vault.save({ accountId: null, phone: null, email: 'other@163.com' }, { at: AT });
  assert.equal(status.sameAsPrevious, null);
  assert.deepEqual(stored(store), { schemaVersion: 'seerfar-web-account-v1', accountId: null, phone: null, email: 'other@163.com', savedAt: AT });

  // An unreadable older entry is replaced, not trusted.
  const broken = keychain([{ ...ENTRY, value: 'bm90LWpzb24=' }]);
  status = await createSeerfarAccountVault({ credentialStore: broken }).save({ accountId: '80012345', phone: null, email: null }, { at: AT });
  assert.equal(status.status, 'saved');
  assert.equal(status.sameAsPrevious, null);
  assert.equal(stored(broken).accountId, '80012345');
});

test('without any field, or outside local development, the keychain is not touched', async () => {
  const store = keychain();
  let status = await createSeerfarAccountVault({ credentialStore: store }).save({ accountId: null, phone: 'call me', email: null }, { at: AT });
  assert.deepEqual(status, { schemaVersion: 'seerfar-web-account-identity-v1', status: 'not_in_request', fields: [],
    masked: { accountId: null, phone: null, email: null }, sameAsPrevious: null, location: null, failure: null });
  status = await createSeerfarAccountVault({ credentialStore: store, runtimeMode: 'central_test' }).save({ accountId: '80012345', phone: null, email: null }, { at: AT });
  assert.equal(status.status, 'not_saved');
  assert.equal(status.failure.code, 'not_local');
  assert.equal(status.masked.accountId, '80****45');
  assert.equal(store.calls.length, 0);
  assert.equal(isSeerfarAccountIdentityStatus(status), true);
  assert.throws(() => createSeerfarAccountVault({ credentialStore: { readSecret: async () => '' } }), /SEERFAR_ACCOUNT_VAULT_CONFIGURATION_INVALID/);
});

test('a keychain that refuses or fails is recorded with its reason and nothing is retried', async () => {
  const identity = { accountId: '80012345', phone: null, email: null };
  const denied = keychain([{ ...ENTRY, failure: 'credential_access_denied' }]);
  let status = await createSeerfarAccountVault({ credentialStore: denied }).save(identity, { at: AT });
  assert.deepEqual(status.failure, { code: 'access_denied', reason: '系统钥匙串没允许（可能点了「拒绝」）' });
  assert.equal(denied.calls.length, 1, 'stopped at the read, no write and no second read');
  const unreadable = keychain([{ ...ENTRY, failure: 'credential_read_failed' }]);
  status = await createSeerfarAccountVault({ credentialStore: unreadable }).save(identity, { at: AT });
  assert.equal(status.failure.code, 'read_failed');
  const unwritable = { backend: 'linux_secret_service', calls: 0, readSecret: async () => { throw new CredentialStoreError('credential_missing'); },
    writeSecret: async () => { unwritable.calls += 1; throw new CredentialStoreError('credential_write_failed'); } };
  status = await createSeerfarAccountVault({ credentialStore: unwritable }).save(identity, { at: AT });
  assert.deepEqual([status.status, status.failure.code, status.location, unwritable.calls], ['not_saved', 'write_failed', 'linux_secret_service', 1]);
  const absent = { backend: null, readSecret: async () => { throw new CredentialStoreError('credential_store_unavailable'); },
    writeSecret: async () => assert.fail('must not write') };
  status = await createSeerfarAccountVault({ credentialStore: absent }).save(identity, { at: AT });
  assert.deepEqual([status.failure.code, status.location], ['store_unavailable', null]);
  // A defect is not a store failure: it surfaces to the caller, which records it as a system error.
  const defect = new TypeError('synthetic defect');
  await assert.rejects(createSeerfarAccountVault({ credentialStore: { backend: 'x', readSecret: async () => { throw defect; }, writeSecret: async () => {} } })
    .save(identity, { at: AT }), error => error === defect);
  assert.deepEqual(seerfarAccountIdentityFailure(identity).failure, { code: 'system_error', reason: '程序出错了' });
  assert.equal(seerfarAccountIdentityFailure({ accountId: null, phone: null, email: null }).status, 'not_in_request');
});

test('a round status that is not the vault\'s own shape is refused', () => {
  const good = seerfarAccountIdentityFailure({ accountId: '80012345', phone: null, email: null }, 'write_failed');
  assert.equal(isSeerfarAccountIdentityStatus(good), true);
  for (const bad of [null, { ...good, extra: 1 }, { ...good, masked: { ...good.masked, accountId: '80012345' } },
    { ...good, failure: { code: 'write_failed', reason: '别的话' } }, { ...good, status: 'saved' }, { ...good, fields: [] },
    { ...good, location: 'Mac Keychain' }]) {
    assert.equal(isSeerfarAccountIdentityStatus(bad), false, JSON.stringify(bad));
  }
});
