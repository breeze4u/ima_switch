import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { VaultStore } from '../src/vault/store.js';
import {
  captureAccount,
  resaveAccount,
  switchAccount,
} from '../src/vault/snapshot.js';
import { exportAccount, importAccount } from '../src/vault/exportImport.js';

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-switch-rt-'));
  const userData = path.join(root, 'User Data');
  const vaultRoot = path.join(root, 'vault');
  await fs.mkdir(path.join(userData, 'Default', 'Network'), { recursive: true });
  await fs.mkdir(path.join(userData, 'key_info'), { recursive: true });
  const prefsA = {
    tencent: {
      wxlogin: {
        account_meta: JSON.stringify({
          is_login: true,
          user_id: 'uid_aaa',
          user_info: { open_info: { nickname: '账号A', avatar_url: '', openid: 'oA' } },
        }),
      },
    },
  };
  await fs.writeFile(path.join(userData, 'Default', 'Preferences'), JSON.stringify(prefsA));
  await fs.writeFile(path.join(userData, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'KEYA' } }));
  await fs.writeFile(path.join(userData, 'Default', 'Network', 'Cookies'), 'cookies-A');
  await fs.writeFile(path.join(userData, 'key_info', 'k.ldb'), 'keyA');
  return { root, userData, vaultRoot, prefsA };
}

async function setAccountB(userData, prefsA) {
  const prefsB = JSON.parse(JSON.stringify(prefsA));
  const meta = JSON.parse(prefsB.tencent.wxlogin.account_meta);
  meta.user_id = 'uid_bbb';
  meta.user_info.open_info.nickname = '账号B';
  prefsB.tencent.wxlogin.account_meta = JSON.stringify(meta);
  await fs.writeFile(path.join(userData, 'Default', 'Preferences'), JSON.stringify(prefsB));
  await fs.writeFile(path.join(userData, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'KEYB' } }));
  await fs.writeFile(path.join(userData, 'Default', 'Network', 'Cookies'), 'cookies-B');
  await fs.writeFile(path.join(userData, 'key_info', 'k.ldb'), 'keyB');
}

test('save / switch / restore / export-import', async () => {
  const { root, userData, vaultRoot } = await makeFixture();
  const vault = await new VaultStore(vaultRoot).init();

  const savedA = await captureAccount({ vault, userDataDir: userData, name: 'A' });
  assert.equal(savedA.account.name, 'A');
  assert.equal(savedA.account.userId, 'uid_aaa');
  assert.ok(savedA.snapshot.copied.includes('Local State'));
  assert.ok(savedA.snapshot.copied.includes(path.join('Default', 'Network', 'Cookies')));

  await setAccountB(userData, JSON.parse(await fs.readFile(path.join(userData, 'Default', 'Preferences'), 'utf8')));
  const savedB = await captureAccount({ vault, userDataDir: userData, name: 'B' });
  assert.equal(savedB.account.userId, 'uid_bbb');

  // currently B; switch to A
  const sw = await switchAccount({ vault, userDataDir: userData, idOrName: 'A' });
  assert.equal(sw.account.name, 'A');
  const cookies = await fs.readFile(path.join(userData, 'Default', 'Network', 'Cookies'), 'utf8');
  assert.equal(cookies, 'cookies-A');
  const ls = JSON.parse(await fs.readFile(path.join(userData, 'Local State'), 'utf8'));
  assert.equal(ls.os_crypt.encrypted_key, 'KEYA');

  // switch back to B
  await switchAccount({ vault, userDataDir: userData, idOrName: savedB.account.id });
  const cookiesB = await fs.readFile(path.join(userData, 'Default', 'Network', 'Cookies'), 'utf8');
  assert.equal(cookiesB, 'cookies-B');

  // resave A from current B would overwrite — instead switch to A and resave
  await switchAccount({ vault, userDataDir: userData, idOrName: 'A' });
  await fs.writeFile(path.join(userData, 'Default', 'Network', 'Cookies'), 'cookies-A2');
  const re = await resaveAccount({ vault, userDataDir: userData, idOrName: 'A' });
  assert.equal(re.account.name, 'A');

  // export/import A
  const exp = await exportAccount(vault, 'A', { password: 's3cret' });
  assert.equal(exp.ext, 'ima-switch.enc');
  const imported = await importAccount(vault, exp.buffer, { password: 's3cret', name: 'A-imported' });
  assert.equal(imported.name, 'A-imported');
  assert.equal(imported.userId, 'uid_aaa');
  const list = await vault.listAccounts();
  assert.ok(list.some((a) => a.id === imported.id));

  // wrong password
  await assert.rejects(() => importAccount(vault, exp.buffer, { password: 'nope' }), /wrong password/);

  await fs.rm(root, { recursive: true, force: true });
});

test('plain zip export import', async () => {
  const { root, userData, vaultRoot } = await makeFixture();
  const vault = await new VaultStore(vaultRoot).init();
  await captureAccount({ vault, userDataDir: userData, name: 'plain' });
  const exp = await exportAccount(vault, 'plain');
  assert.equal(exp.ext, 'zip');
  const imported = await importAccount(vault, exp.buffer, { name: 'plain2' });
  assert.equal(imported.nickname, '账号A');
  await fs.rm(root, { recursive: true, force: true });
});
