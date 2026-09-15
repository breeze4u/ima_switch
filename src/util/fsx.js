import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const HOME_IMA = '.ima-switch';

export function defaultVaultRoot(home = os.homedir()) {
  return path.join(home, HOME_IMA);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function copyPath(src, dest) {
  const st = await fs.stat(src);
  if (st.isDirectory()) {
    await fs.cp(src, dest, { recursive: true, force: true });
  } else {
    await ensureDir(path.dirname(dest));
    await fs.copyFile(src, dest);
  }
}

export async function removePath(p) {
  await fs.rm(p, { recursive: true, force: true });
}

export function formatError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}
