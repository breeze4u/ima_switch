import path from 'node:path';
import os from 'node:os';
import { pathExists } from '../util/fsx.js';

export const IMA_PROCESS_NAME = 'ima.copilot';

export function defaultImaRoot(localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')) {
  return path.join(localAppData, 'ima.copilot');
}

export function defaultUserDataPath(imaRoot = defaultImaRoot()) {
  return path.join(imaRoot, 'User Data');
}

export function defaultExePath(imaRoot = defaultImaRoot()) {
  return path.join(imaRoot, 'Application', 'ima.copilot.exe');
}

export async function discoverIma({ imaRoot, userData, exe } = {}) {
  const root = imaRoot || defaultImaRoot();
  const resolvedUserData = userData || path.join(root, 'User Data');
  const resolvedExe = exe || path.join(root, 'Application', 'ima.copilot.exe');
  const userDataExists = await pathExists(resolvedUserData);
  const exeExists = await pathExists(resolvedExe);
  return {
    imaRoot: root,
    userData: resolvedUserData,
    exe: resolvedExe,
    userDataExists,
    exeExists,
    found: userDataExists,
  };
}

/**
 * Relative paths (from User Data) that constitute a login-state snapshot.
 * Missing entries are skipped at capture/restore time.
 */
export function managedRelPaths() {
  return [
    'Local State',
    'key_info',
    'imsdk',
    path.join('Default', 'Preferences'),
    path.join('Default', 'Secure Preferences'),
    path.join('Default', 'Network', 'Cookies'),
    path.join('Default', 'Network', 'Cookies-journal'),
    path.join('Default', 'Network', 'Device Bound Sessions'),
    path.join('Default', 'Network', 'Device Bound Sessions-journal'),
    path.join('Default', 'Extension Cookies'),
    path.join('Default', 'Local Storage'),
    path.join('Default', 'Session Storage'),
    path.join('Default', 'Account Web Data'),
    path.join('Default', 'Account Web Data-journal'),
  ];
}

export async function expandManagedPaths(userDataDir, { readdir, pathExists: exists = pathExists } = {}) {
  const fsMod = await import('node:fs/promises');
  const read = readdir || ((p) => fsMod.readdir(p, { withFileTypes: true }));
  const check = exists || pathExists;
  const base = managedRelPaths();
  const extra = [];
  const defaultDir = path.join(userDataDir, 'Default');

  if (await check(defaultDir)) {
    const items = await read(defaultDir);
    for (const item of items) {
      const name = typeof item === 'string' ? item : item.name;
      if (name.startsWith('IMA_')) {
        extra.push(path.join('Default', name));
      }
    }
    const idb = path.join(defaultDir, 'IndexedDB');
    if (await check(idb)) {
      const origins = await read(idb);
      for (const item of origins) {
        const name = typeof item === 'string' ? item : item.name;
        if (name.includes('ima.qq.com')) {
          const rel = path.join('Default', 'IndexedDB', name);
          if (!extra.includes(rel) && !base.includes(rel)) extra.push(rel);
        }
      }
    }
  }

  return [...new Set([...base, ...extra])];
}
