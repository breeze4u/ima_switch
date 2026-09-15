import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../util/fsx.js';

/**
 * Parse IMA Preferences JSON for wxlogin account_meta identity.
 */
export function parseIdentityFromPreferences(preferences) {
  try {
    const tencent = preferences?.tencent || {};
    const wxlogin = tencent.wxlogin || {};
    let meta = wxlogin.account_meta;
    if (typeof meta === 'string' && meta) {
      meta = JSON.parse(meta);
    }
    if (!meta || typeof meta !== 'object') return null;
    const openInfo = meta.user_info?.open_info || {};
    const nick =
      openInfo.nickname ||
      meta.user_info?.knowledge_matrix_info?.nickname ||
      meta.user_info?.custom_info?.txdoc_nick_name ||
      '';
    return {
      userId: meta.user_id || openInfo.uid || '',
      nickname: nick,
      avatarUrl: openInfo.avatar_url || '',
      openid: openInfo.openid || '',
      isLoggedIn: meta.is_login === true || meta.is_login === 'true',
    };
  } catch {
    return null;
  }
}

export async function readIdentityFromUserData(userDataDir) {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  if (!(await pathExists(prefsPath))) return null;
  const raw = await fs.readFile(prefsPath, 'utf8');
  let prefs;
  try {
    prefs = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseIdentityFromPreferences(prefs);
}

export function makeAccountId(date = new Date()) {
  const ts = date
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `acc_${ts}_${rand}`;
}

export function slugifyName(name) {
  return String(name || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 64);
}
