import fs from 'node:fs/promises';
import path from 'node:path';
import { createZip, readZip, encryptPayload, decryptPayload, isEncryptedPackage } from '../util/archive.js';
import { ensureDir, pathExists, removePath } from '../util/fsx.js';

function makeImportId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `acc_${ts}_${rand}`;
}

function isSafeRelativePath(rel) {
  if (!rel || typeof rel !== 'string') return false;
  const normalized = rel.replace(/\\/g, '/');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    return false;
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) return false;
  return true;
}

async function resolveContained(baseDir, rel) {
  if (!isSafeRelativePath(rel)) {
    throw new Error(`invalid path in package: ${rel}`);
  }
  const dest = path.resolve(baseDir, rel.replace(/\\/g, '/'));
  const base = path.resolve(baseDir);
  if (dest !== base && !dest.startsWith(base + path.sep)) {
    throw new Error(`path escapes extract dir: ${rel}`);
  }
  return dest;
}

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
  }
  const files = readZip(zipBuf);
  const metaEntry = files.find((f) => f.name === 'meta.json' || f.name.endsWith('/meta.json'));
  if (!metaEntry) throw new Error('invalid package: meta.json missing');
  const meta = JSON.parse(metaEntry.data.toString('utf8'));
  const now = new Date().toISOString();
  // Always allocate a fresh id so re-import never overwrites an existing account.
  const id = makeImportId();
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
  const dataRoot = path.join(tmpRoot, 'data');
  await removePath(tmpRoot);
  await ensureDir(dataRoot);
  try {
    for (const f of files) {
      if (f.name === 'meta.json' || f.name.endsWith('/meta.json')) continue;
      let rel = f.name;
      if (rel.startsWith('data/')) rel = rel.slice('data/'.length);
      const dest = await resolveContained(dataRoot, rel);
      await ensureDir(path.dirname(dest));
      await fs.writeFile(dest, f.data);
    }
    const account = await vault.writeAccount(
      nextMeta,
      (await pathExists(dataRoot)) ? dataRoot : null,
    );
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
