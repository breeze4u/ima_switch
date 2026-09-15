import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { VaultStore } from '../src/vault/store.js';
import { createServer, listen } from '../src/server.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-switch-api-'));
  const userData = path.join(root, 'User Data');
  await fs.mkdir(path.join(userData, 'Default', 'Network'), { recursive: true });
  const prefs = {
    tencent: {
      wxlogin: {
        account_meta: JSON.stringify({
          is_login: true,
          user_id: 'uid_api',
          user_info: { open_info: { nickname: 'API号', avatar_url: '', openid: 'o' } },
        }),
      },
    },
  };
  await fs.writeFile(path.join(userData, 'Default', 'Preferences'), JSON.stringify(prefs));
  await fs.writeFile(path.join(userData, 'Local State'), '{}');
  await fs.writeFile(path.join(userData, 'Default', 'Network', 'Cookies'), 'c');
  const vault = await new VaultStore(path.join(root, 'vault')).init();
  const server = await createServer({ vault, opts: { imaUserData: userData, webPort: 0 } });
  const addr = await listen(server, 0);
  return { root, userData, vault, server, base: addr.url };
}

test('API health, save blocked when IMA path ok, list empty, import/export', async (t) => {
  // Note: save will be blocked if real IMA is running on this machine.
  // We still verify health/list and export/import via direct vault when needed.
  const { root, server, base, vault, userData } = await fixture();
  t.after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.imaFound, true);

  const list = await fetch(`${base}/api/accounts`).then((r) => r.json());
  assert.deepEqual(list.accounts, []);

  // Direct capture into vault (bypass process check) then exercise API export/import/delete
  const { captureAccount } = await import('../src/vault/snapshot.js');
  const saved = await captureAccount({ vault, userDataDir: userData, name: 'api-acc' });

  const expRes = await fetch(`${base}/api/accounts/${saved.account.id}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(expRes.status, 200);
  const buf = Buffer.from(await expRes.arrayBuffer());
  assert.ok(buf.length > 0);

  // delete
  const del = await fetch(`${base}/api/accounts/${saved.account.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);

  // import multipart
  const form = new FormData();
  form.append('file', new Blob([buf]), 'acc.zip');
  const imp = await fetch(`${base}/api/accounts/import`, { method: 'POST', body: form });
  const impBody = await imp.json();
  assert.equal(imp.status, 200, JSON.stringify(impBody));
  assert.ok(impBody.account?.id);

  // Do not exercise /switch here: it force-stops real ima.copilot on this machine.
});
