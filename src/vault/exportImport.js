import fs from 'node:fs/promises';
import path from 'node:path';
import { createZip, readZip, encryptPayload, decryptPayload, isEncryptedPackage } from '../util/archive.js';
import { ensureDir, pathExists, removePath } from '../util/fsx.js';
import { readJson } from '../util/fsx.js';

async function walkFiles(dir, base = dir) {
  const out = [];
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) {
      out.push(...(await walkFiles(abs, base)));
    } else if (item.isFile()) {
      const rel = path.relative(base, abs).replace(/\\/g, '/');
      out.push({ rel, abs });
    }
  }
  return out;
}

export async function exportAccount(vault, idOrName, { password } = {}) {
  const account = await vault.getAccount(idOrName);
  if (!account) throw new Error(`account not found: ${idOrName}`);
  const metaPath = vault.accountMetaPath(account.id);
  const dataDir = vault.accountDataPath(account.id);
  const entries = [];
  entries.push({ name: 'meta.json', data: await fs.readFile(metaPath) });
  if (await pathExists(dataDir)) {
    const files = await walkFiles(dataDir);
    for (const f of files) {
      entries.push({ name: `data/${f.rel}`, data: await fs.readFile(f.abs) });
    }
  }
  const zip = createZip(entries);
  if (password) {
    return { buffer: encryptPayload(zip, password), ext: 'ima-switch.enc', account };
  }
  return { buffer: zip, ext: 'zip', account };
}

export async function importAccount(vault, fileBuffer, { password, name } = {}) {
  let zipBuf = fileBuffer;
  if (isEncryptedPackage(fileBuffer)) {
    zipBuf = decryptPayload(fileBuffer, password || '');
  } else if (password) {
    // plain zip with password provided — ignore password? treat as plain
  }
  const files = readZip(zipBuf);
  const metaEntry = files.find((f) => f.name === 'meta.json' || f.name.endsWith('/meta.json'));
  if (!metaEntry) throw new Error('invalid package: meta.json missing');
  const meta = JSON.parse(metaEntry.data.toString('utf8'));
  const now = new Date().toISOString();
  const id = meta.id || `acc_${Date.now().toString(36)}_imp`;
  const finalName = name ? await vault.uniqueName(name) : await vault.uniqueName(meta.name || 'imported');
  const nextMeta = {
    ...meta,
    id,
    name: finalName,
    source: 'import',
    createdAt: meta.createdAt || now,
    updatedAt: now,
    lastUsedAt: meta.lastUsedAt || null,
  };

  const tmpRoot = path.join(vault.root, '.tmp-import', `${id}-${process.pid}`);
  await removePath(tmpRoot);
  await ensureDir(tmpRoot);
  try {
    for (const f of files) {
      if (f.name === 'meta.json' || f.name.endsWith('/meta.json')) continue;
      let rel = f.name;
      if (rel.startsWith('data/')) rel = rel.slice('data/'.length);
      if (rel.includes('..')) throw new Error('invalid path in package');
      const dest = path.join(tmpRoot, 'data', rel);
      await ensureDir(path.dirname(dest));
      await fs.writeFile(dest, f.data);
    }
    const dataSrc = path.join(tmpRoot, 'data');
    const account = await vault.writeAccount(nextMeta, (await pathExists(dataSrc)) ? dataSrc : null);
    return account;
  } finally {
    await removePath(tmpRoot);
  }
}

export async function saveExportFile(vault, buffer, ext, preferredName) {
  await ensureDir(vault.exportsDir);
  const safe = String(preferredName || 'account').replace(/[\\/:*?"<>|]+/g, '_');
  const file = path.join(vault.exportsDir, `${safe}-${Date.now().toString(36)}.${ext}`);
  await fs.writeFile(file, buffer);
  return file;
}
