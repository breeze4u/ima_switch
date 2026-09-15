import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultVaultRoot } from '../util/fsx.js';
import { ensureDir, removePath } from '../util/fsx.js';
import { startIma, stopPids, isPidAlive } from './process.js';
import { readIdentityFromUserData } from './identity.js';
import { captureAccount } from '../vault/snapshot.js';

/**
 * In-memory OAuth QR sessions.
 * Launch IMA with an isolated --user-data-dir so the user can scan a new account
 * without touching the main profile, then capture that profile into the vault.
 */
export class OauthManager {
  constructor({ vault, exePath, vaultRoot = vault?.root || defaultVaultRoot() }) {
    this.vault = vault;
    this.exePath = exePath;
    this.vaultRoot = vaultRoot;
    this.sessions = new Map();
    this.tmpRoot = path.join(vaultRoot, 'oauth-tmp');
  }

  list() {
    return [...this.sessions.values()].map((s) => this.publicView(s));
  }

  publicView(s) {
    return {
      id: s.id,
      status: s.status,
      startedAt: s.startedAt,
      userDataDir: s.userDataDir,
      pid: s.pid,
      message: s.message,
      identity: s.identity || null,
      account: s.account || null,
    };
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  async start({ nameHint = '' } = {}) {
    if (!this.exePath) throw new Error('IMA exe not found');
    // only one active QR session at a time
    for (const s of this.sessions.values()) {
      if (s.status === 'waiting' || s.status === 'checking') {
        throw new Error('another OAuth session is already running');
      }
    }
    const id = `oauth_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const userDataDir = path.join(this.tmpRoot, id);
    await removePath(userDataDir);
    await ensureDir(userDataDir);

    const session = {
      id,
      status: 'waiting',
      startedAt: new Date().toISOString(),
      userDataDir,
      pid: null,
      message: '请在弹出的 IMA 窗口中扫码登录新账号',
      identity: null,
      account: null,
      nameHint,
      captured: false,
    };
    this.sessions.set(id, session);

    try {
      const { pid } = await startIma(this.exePath, { userDataDir, detached: true });
      session.pid = pid;
      // start polling
      session.timer = setInterval(() => {
        this.tick(session).catch(() => {});
      }, 1500);
    } catch (err) {
      session.status = 'failed';
      session.message = err.message || 'failed to start IMA';
      await removePath(userDataDir).catch(() => {});
    }
    return this.publicView(session);
  }

  async tick(session) {
    if (session.status === 'cancelled' || session.status === 'done' || session.status === 'failed') {
      this.clearTimer(session);
      return;
    }

    const alive = session.pid ? await isPidAlive(session.pid) : false;
    if (!alive && session.status !== 'logged_in' && session.status !== 'capturing') {
      // window closed before login
      if (session.status === 'waiting' || session.status === 'checking') {
        session.status = 'failed';
        session.message = '登录窗口已关闭，未完成扫码';
        this.clearTimer(session);
        await removePath(session.userDataDir).catch(() => {});
      }
      return;
    }

    const identity = await readIdentityFromUserData(session.userDataDir).catch(() => null);
    if (identity?.userId && identity.isLoggedIn) {
      session.identity = identity;
      if (session.status === 'waiting' || session.status === 'checking') {
        session.status = 'capturing';
        session.message = '登录成功，正在保存账号…';
        this.clearTimer(session);
        try {
          const name = session.nameHint || identity.nickname || '扫码账号';
          const result = await captureAccount({
            vault: this.vault,
            userDataDir: session.userDataDir,
            name,
            note: 'OAuth 扫码添加',
          });
          session.account = result.account;
          session.status = 'done';
          session.message = `已添加账号 ${result.account.name}`;
          // close QR window
          if (session.pid) await stopPids([session.pid]).catch(() => {});
          await removePath(session.userDataDir).catch(() => {});
        } catch (err) {
          session.status = 'failed';
          session.message = err.message || 'capture failed';
        }
      }
    } else {
      if (session.status === 'waiting') {
        session.message = '等待扫码登录…';
      }
    }
  }

  clearTimer(session) {
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
  }

  async cancel(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`oauth session not found: ${id}`);
    this.clearTimer(session);
    session.status = 'cancelled';
    session.message = '已取消';
    if (session.pid) {
      await stopPids([session.pid]).catch(() => {});
    }
    await removePath(session.userDataDir).catch(() => {});
    return this.publicView(session);
  }

  async cleanupAll() {
    for (const s of this.sessions.values()) {
      this.clearTimer(s);
      if (s.pid) await stopPids([s.pid]).catch(() => {});
      await removePath(s.userDataDir).catch(() => {});
    }
  }
}
