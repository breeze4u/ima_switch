import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createZip,
  readZip,
  encryptPayload,
  decryptPayload,
  isEncryptedPackage,
} from '../src/util/archive.js';
import { parseIdentityFromPreferences, makeAccountId, slugifyName } from '../src/ima/identity.js';
import { managedRelPaths, expandManagedPaths } from '../src/ima/discover.js';
import { defaultUserDataPath, defaultExePath, discoverIma } from '../src/ima/discover.js';

test('zip roundtrip', () => {
  const entries = [
    { name: 'meta.json', data: Buffer.from('{"a":1}') },
    { name: 'data/Default/Preferences', data: Buffer.from('hello world '.repeat(50)) },
  ];
  const zip = createZip(entries);
  const files = readZip(zip);
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'meta.json');
  assert.equal(files[0].data.toString(), '{"a":1}');
  assert.ok(files[1].data.toString().includes('hello world'));
});

test('encrypt roundtrip and wrong password', () => {
  const plain = Buffer.from('secret-login-state');
  const blob = encryptPayload(plain, 'pw123');
  assert.ok(isEncryptedPackage(blob));
  assert.deepEqual(decryptPayload(blob, 'pw123'), plain);
  assert.throws(() => decryptPayload(blob, 'wrong'), /wrong password/);
});

test('parse identity from preferences', () => {
  const prefs = {
    tencent: {
      wxlogin: {
        account_meta: JSON.stringify({
          is_login: true,
          user_id: '001a7c61884037e7',
          user_info: {
            open_info: {
              nickname: '测试昵称',
              avatar_url: 'https://example.com/a.png',
              openid: 'oz_x',
              uid: '001a7c61884037e7',
            },
          },
        }),
      },
    },
  };
  const id = parseIdentityFromPreferences(prefs);
  assert.equal(id.userId, '001a7c61884037e7');
  assert.equal(id.nickname, '测试昵称');
  assert.equal(id.avatarUrl, 'https://example.com/a.png');
  assert.equal(id.isLoggedIn, true);
});

test('slugify and account id', () => {
  assert.equal(slugifyName('工作/号:x'), '工作_号_x');
  assert.match(makeAccountId(), /^acc_\d{14}_[a-z0-9]+$/);
});

test('managed paths include base list', () => {
  const paths = managedRelPaths();
  assert.ok(paths.includes('Local State'));
  assert.ok(paths.includes('key_info'));
  assert.ok(paths.some((p) => p.endsWith('Preferences')));
});

test('expand managed paths finds IMA_* and ima.qq.com idb', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-switch-test-'));
  const userData = path.join(root, 'User Data');
  await fs.mkdir(path.join(userData, 'Default', 'IMA_abc'), { recursive: true });
  await fs.mkdir(path.join(userData, 'Default', 'IndexedDB', 'https_ima.qq.com_0.indexeddb.leveldb'), {
    recursive: true,
  });
  await fs.writeFile(path.join(userData, 'Local State'), '{}');
  const expanded = await expandManagedPaths(userData);
  assert.ok(expanded.includes('Local State'));
  assert.ok(expanded.some((p) => p.includes('IMA_abc')));
  assert.ok(expanded.some((p) => p.includes('ima.qq.com')));
  await fs.rm(root, { recursive: true, force: true });
});

test('discover paths defaults', () => {
  const ud = defaultUserDataPath('C:\\Users\\u\\AppData\\Local\\ima.copilot');
  assert.ok(ud.endsWith(pathJoin('User Data')));
  const exe = defaultExePath('C:\\Users\\u\\AppData\\Local\\ima.copilot');
  assert.ok(exe.endsWith(pathJoin('Application', 'ima.copilot.exe')));
});

function pathJoin(...parts) {
  return parts.join('\\').replace(/\\\\+/g, '\\');
}

test('import rejects path traversal entries', async () => {
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const { importAccount } = await import('../src/vault/exportImport.js');
  const { VaultStore } = await import('../src/vault/store.js');
  const { createZip } = await import('../src/util/archive.js');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-switch-trav-'));
  const vault = await new VaultStore(path.join(root, 'vault')).init();
  const evil = createZip([
    { name: 'meta.json', data: Buffer.from(JSON.stringify({ id: 'x', name: 'evil' })) },
    { name: 'data/../escape.txt', data: Buffer.from('pwned') },
  ]);
  await assert.rejects(() => importAccount(vault, evil), /invalid path|escapes/);
  assert.equal(await fs.access(path.join(root, 'escape.txt')).then(() => true).catch(() => false), false);

  const evilAbs = createZip([
    { name: 'meta.json', data: Buffer.from(JSON.stringify({ id: 'y', name: 'evil2' })) },
    { name: 'data/C:/Windows/evil.txt', data: Buffer.from('pwned') },
  ]);
  await assert.rejects(() => importAccount(vault, evilAbs), /invalid path|escapes/);
  await fs.rm(root, { recursive: true, force: true });
});

test('import always allocates a fresh account id', async () => {
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const { importAccount, exportAccount } = await import('../src/vault/exportImport.js');
  const { VaultStore } = await import('../src/vault/store.js');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-switch-id-'));
  const vault = await new VaultStore(path.join(root, 'vault')).init();
  const { captureAccount } = await import('../src/vault/snapshot.js');
  const userData = path.join(root, 'User Data');
  await fs.mkdir(path.join(userData, 'Default'), { recursive: true });
  await fs.writeFile(
    path.join(userData, 'Default', 'Preferences'),
    JSON.stringify({ tencent: { wxlogin: { account_meta: JSON.stringify({ is_login: true, user_id: 'u1', user_info: { open_info: { nickname: 'n1' } } }) } } }),
  );
  const saved = await captureAccount({ vault, userDataDir: userData, name: 'orig' });
  const exp = await exportAccount(vault, saved.account.id);
  const again = await importAccount(vault, exp.buffer, { name: 'orig-copy' });
  assert.notEqual(again.id, saved.account.id);
  const list = await vault.listAccounts();
  assert.equal(list.length, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test('discoverIma missing does not throw', async () => {
  const info = await discoverIma({ imaRoot: 'C:\\definitely\\missing\\ima' });
  assert.equal(info.found, false);
  assert.equal(info.userDataExists, false);
});
