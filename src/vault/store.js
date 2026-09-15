import path from 'node:path';
import fs from 'node:fs/promises';
import {
  defaultVaultRoot,
  ensureDir,
  readJson,
  writeJson,
  pathExists,
  copyPath,
  removePath,
} from '../util/fsx.js';
import { makeAccountId, slugifyName } from '../ima/identity.js';

export class VaultStore {
  constructor(root = defaultVaultRoot()) {
    this.root = root;
    this.accountsDir = path.join(root, 'accounts');
    this.trashDir = path.join(root, '.trash');
    this.configPath = path.join(root, 'config.json');
    this.exportsDir = path.join(root, 'exports');
  }

  async init() {
    await ensureDir(this.accountsDir);
    await ensureDir(this.trashDir);
    await ensureDir(this.exportsDir);
    return this;
  }

  async loadConfig(overrides = {}) {
    const base = await readJson(this.configPath, {
      imaUserData: null,
      webPort: 17321,
      openBrowser: true,
      keepTrash: 3,
    });
    return { ...base, ...overrides };
  }

  async saveConfig(config) {
    await writeJson(this.configPath, config);
  }

  accountDir(id) {
    return path.join(this.accountsDir, id);
  }

  accountMetaPath(id) {
    return path.join(this.accountDir(id), 'meta.json');
  }

  accountDataPath(id) {
    return path.join(this.accountDir(id), 'data');
  }

  async listAccounts() {
    await this.init();
    let names;
    try {
      names = await fs.readdir(this.accountsDir);
    } catch {
      return [];
    }
    const accounts = [];
    for (const name of names) {
      const meta = await readJson(this.accountMetaPath(name), null);
      if (meta) accounts.push(meta);
    }
    accounts.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return accounts;
  }

  async getAccount(idOrName) {
    const accounts = await this.listAccounts();
    const exact = accounts.find((a) => a.id === idOrName);
    if (exact) return exact;
    const byName = accounts.filter((a) => a.name === idOrName);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new Error(`multiple accounts named "${idOrName}", use id instead`);
    }
    return null;
  }

  async writeAccount(meta, dataDirSrc) {
    await this.init();
    const dir = this.accountDir(meta.id);
    const dataDir = this.accountDataPath(meta.id);
    await ensureDir(dir);
    await removePath(dataDir);
    if (dataDirSrc) {
      await ensureDir(path.dirname(dataDir));
      await fs.cp(dataDirSrc, dataDir, { recursive: true, force: true });
    } else {
      await ensureDir(dataDir);
    }
    await writeJson(this.accountMetaPath(meta.id), meta);
    return meta;
  }

  async updateMeta(id, patch) {
    const meta = await readJson(this.accountMetaPath(id), null);
    if (!meta) throw new Error(`account not found: ${id}`);
    const next = { ...meta, ...patch, updatedAt: new Date().toISOString() };
    await writeJson(this.accountMetaPath(id), next);
    return next;
  }

  async deleteAccount(id) {
    const dir = this.accountDir(id);
    if (!(await pathExists(dir))) throw new Error(`account not found: ${id}`);
    await removePath(dir);
  }

  async uniqueName(name) {
    const clean = slugifyName(name) || 'account';
    const accounts = await this.listAccounts();
    if (!accounts.some((a) => a.name === clean)) return clean;
    let i = 2;
    while (accounts.some((a) => a.name === `${clean} (${i})`)) i++;
    return `${clean} (${i})`;
  }

  async createMeta({ name, note = '', identity = null, source = 'capture' }) {
    const now = new Date().toISOString();
    return {
      id: makeAccountId(),
      name: await this.uniqueName(name),
      userId: identity?.userId || '',
      nickname: identity?.nickname || '',
      avatarUrl: identity?.avatarUrl || '',
      source,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      note,
    };
  }

  async rotateTrash(prefix = 'pre-switch') {
    await this.init();
    const keep = (await this.loadConfig()).keepTrash ?? 3;
    const items = (await fs.readdir(this.trashDir))
      .filter((n) => n.startsWith(prefix))
      .sort();
    while (items.length > keep) {
      const oldest = items.shift();
      await removePath(path.join(this.trashDir, oldest));
    }
  }

  async createTrashDir(prefix = 'pre-switch') {
    await this.init();
    const name = `${prefix}-${Date.now().toString(36)}-${process.pid}`;
    const dir = path.join(this.trashDir, name);
    await ensureDir(dir);
    await this.rotateTrash(prefix);
    return dir;
  }
}
