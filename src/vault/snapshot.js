import path from 'node:path';
import fs from 'node:fs/promises';
import { pathExists, copyPath, removePath, ensureDir } from '../util/fsx.js';
import { expandManagedPaths } from '../ima/discover.js';
import { readIdentityFromUserData } from '../ima/identity.js';

/**
 * Copy managed login-state paths from userDataDir into destDir (relative structure).
 */
export async function captureSnapshot(userDataDir, destDir) {
  const relPaths = await expandManagedPaths(userDataDir);
  const copied = [];
  const skipped = [];
  await ensureDir(destDir);
  for (const rel of relPaths) {
    const src = path.join(userDataDir, rel);
    if (!(await pathExists(src))) {
      skipped.push(rel);
      continue;
    }
    const dest = path.join(destDir, rel);
    await copyPath(src, dest);
    copied.push(rel);
  }
  return { copied, skipped, relPaths };
}

/**
 * Restore snapshot from srcDir into userDataDir.
 * Removes managed paths present in live data but missing from snapshot.
 */
export async function restoreSnapshot(srcDir, userDataDir) {
  const liveManaged = await expandManagedPaths(userDataDir);
  const snapManaged = await expandManagedPaths(srcDir);

  // Remove live managed paths that are not in snapshot
  const toRemove = liveManaged.filter((rel) => !snapManaged.includes(rel));
  for (const rel of toRemove) {
    await removePath(path.join(userDataDir, rel));
  }

  // Also remove base managed files that exist live but not in snapshot
  // (expandManagedPaths already covers base list)

  const restored = [];
  for (const rel of snapManaged) {
    const src = path.join(srcDir, rel);
    if (!(await pathExists(src))) continue;
    const dest = path.join(userDataDir, rel);
    await removePath(dest);
    await copyPath(src, dest);
    restored.push(rel);
  }
  return { restored, removed: toRemove };
}

/**
 * Move managed paths from userDataDir into trashDir (for rollback).
 */
export async function moveManagedToTrash(userDataDir, trashDir) {
  const relPaths = await expandManagedPaths(userDataDir);
  const moved = [];
  for (const rel of relPaths) {
    const src = path.join(userDataDir, rel);
    if (!(await pathExists(src))) continue;
    const dest = path.join(trashDir, rel);
    await ensureDir(path.dirname(dest));
    await fs.rename(src, dest).catch(async () => {
      await copyPath(src, dest);
      await removePath(src);
    });
    moved.push(rel);
  }
  return moved;
}

export async function backupCurrentToTrash(vault, userDataDir) {
  const trashDir = await vault.createTrashDir('pre-switch');
  const moved = await moveManagedToTrash(userDataDir, trashDir);
  return { trashDir, moved };
}

export async function restoreFromTrash(trashDir, userDataDir) {
  return restoreSnapshot(trashDir, userDataDir);
}

export async function captureAccount({ vault, userDataDir, name, note = '' }) {
  const identity = await readIdentityFromUserData(userDataDir);
  const meta = await vault.createMeta({ name, note, identity, source: 'capture' });
  // persist meta first so account dir exists, then capture into data/
  await vault.writeAccount(meta, null);
  const snap = await captureSnapshot(userDataDir, vault.accountDataPath(meta.id));
  const finalMeta = await vault.getAccount(meta.id);
  return { account: finalMeta, snapshot: snap, identity };
}

export async function resaveAccount({ vault, userDataDir, idOrName }) {
  const existing = await vault.getAccount(idOrName);
  if (!existing) throw new Error(`account not found: ${idOrName}`);
  const identity = await readIdentityFromUserData(userDataDir);
  const dataDir = vault.accountDataPath(existing.id);
  const snap = await captureSnapshot(userDataDir, dataDir);
  const updated = await vault.updateMeta(existing.id, {
    userId: identity?.userId || existing.userId,
    nickname: identity?.nickname || existing.nickname,
    avatarUrl: identity?.avatarUrl || existing.avatarUrl,
  });
  return { account: updated, snapshot: snap };
}

export async function switchAccount({ vault, userDataDir, idOrName }) {
  const account = await vault.getAccount(idOrName);
  if (!account) throw new Error(`account not found: ${idOrName}`);
  const snapDir = vault.accountDataPath(account.id);
  if (!(await pathExists(snapDir))) throw new Error(`account data missing: ${account.id}`);

  const backup = await backupCurrentToTrash(vault, userDataDir);
  try {
    const result = await restoreSnapshot(snapDir, userDataDir);
    const updated = await vault.updateMeta(account.id, {
      lastUsedAt: new Date().toISOString(),
    });
    return { account: updated, backup, restore: result };
  } catch (err) {
    // rollback
    await restoreFromTrash(backup.trashDir, userDataDir);
    throw err;
  }
}
