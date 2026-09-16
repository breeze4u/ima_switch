import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const RES_SLOT_COPILOT_TOKEN = 10;
export const ACTIVITY_DAILY_LOGIN = 1005;
export const ACTIVITY_DAILY_LOGIN_ALT = 1010;
export const USER_ACT_FINISHED = 4;

const API_BASE = 'https://ima.qq.com/cgi-bin';

/** Classic Tencent bkn-style hash of IMA-TOKEN (JS-safe). */
export function computeBkn(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) {
    h += (h << 5) + token.charCodeAt(i);
  }
  return String(h & 0x7fffffff);
}

export function buildImaCookie({ userId, token, refreshToken, idType = '2', tokenType = '14' }) {
  return [
    `IMA-UID=${userId}`,
    `IMA-TOKEN=${token}`,
    `IMA-REFRESH-TOKEN=${refreshToken}`,
    `UID-TYPE=${idType}`,
    `TOKEN-TYPE=${tokenType}`,
    'PLATFORM=H5',
    'CLIENT-TYPE=3',
    'WEB-VERSION=999.999.999',
  ].join('; ');
}

export function buildImaHeaders(auth) {
  return {
    'x-ima-cookie': buildImaCookie(auth),
    'from_browser_ima': '1',
    'x-ima-bkn': auth.token ? computeBkn(auth.token) : '',
    'content-type': 'application/json',
    origin: 'https://ima.qq.com',
    referer: 'https://ima.qq.com/',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  };
}

async function postJson(url, body, headers, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 160)}`);
  }
  return json;
}

/** Decrypt Chromium DPAPI blob (base64) as current Windows user. */
export async function dpapiDecrypt(b64) {
  if (process.platform !== 'win32') throw new Error('DPAPI decrypt requires Windows');
  const script = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${b64}')
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($dec))
`;
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  return stdout;
}

/** Read auth from live IMA Preferences + DPAPI secret. */
export async function readAuthFromUserData(userDataDir) {
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  const prefsRaw = await fs.readFile(prefsPath, 'utf8');
  const prefs = JSON.parse(prefsRaw);
  const wx = prefs?.tencent?.wxlogin || {};
  let meta = wx.account_meta;
  if (typeof meta === 'string' && meta) meta = JSON.parse(meta);
  if (!meta?.user_id) return null;

  const secretB64 = wx.account_secret_encrypted;
  if (!secretB64) {
    throw new Error('account_secret_encrypted missing; IMA may not be logged in');
  }
  const secretText = await dpapiDecrypt(secretB64);
  const secret = JSON.parse(secretText);
  if (!secret.token) throw new Error('token missing in decrypted secret');
  return {
    userId: meta.user_id,
    idType: String(meta.id_type ?? '2'),
    tokenType: String(meta.token_type ?? '14'),
    token: secret.token,
    refreshToken: secret.refresh_token || '',
    tokenValidTime: secret.token_valid_time || '',
    nickname: meta.user_info?.open_info?.nickname || '',
  };
}

/** Read auth from vault account data (auth_login.json / account_meta.json / Preferences snapshot). */
export async function readAuthFromVaultAccount(accountDataDir) {
  const authPath = path.join(accountDataDir, 'auth_login.json');
  try {
    const raw = JSON.parse(await fs.readFile(authPath, 'utf8'));
    const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    if (data.token && (data.user_id || data.userId)) {
      return {
        userId: data.user_id || data.userId,
        idType: String(data.id_type ?? data.idType ?? '2'),
        tokenType: String(data.token_type ?? data.tokenType ?? '14'),
        token: data.token,
        refreshToken: data.refresh_token || data.refreshToken || '',
        source: 'auth_login.json',
      };
    }
  } catch {
    // fall through
  }
  const metaPath = path.join(accountDataDir, 'account_meta.json');
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    if (meta.token && meta.user_id) {
      return {
        userId: meta.user_id,
        idType: String(meta.id_type ?? '2'),
        tokenType: String(meta.token_type ?? '14'),
        token: meta.token,
        refreshToken: meta.refresh_token || '',
        nickname: meta.user_info?.open_info?.nickname || meta.nickname || '',
        source: 'account_meta.json',
      };
    }
  } catch {
    // ignore
  }
  // Selective snapshot may include Default/Preferences with DPAPI secret (same Windows user).
  const prefsPath = path.join(accountDataDir, 'Default', 'Preferences');
  try {
    await fs.access(prefsPath);
    const auth = await readAuthFromUserData(path.join(accountDataDir));
    if (auth) {
      auth.source = 'Preferences+DPAPI';
      return auth;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Resolve auth for every unique account: live IMA profile + vault accounts.
 * Dedupes by userId. Each entry: { key, label, auth } or { key, label, error }.
 */
export async function collectAccountAuths({ vault, userDataDir, includeLive = true }) {
  const seen = new Set();
  const items = [];

  async function push(label, loader) {
    try {
      const auth = await loader();
      if (!auth?.userId || !auth.token) {
        items.push({ key: label, label, error: 'no usable token' });
        return;
      }
      if (seen.has(auth.userId)) return;
      seen.add(auth.userId);
      items.push({
        key: auth.userId,
        label: auth.nickname || label,
        userId: auth.userId,
        auth,
      });
    } catch (err) {
      items.push({ key: label, label, error: err.message });
    }
  }

  if (includeLive && userDataDir) {
    await push('当前登录', () => readAuthFromUserData(userDataDir));
  }

  const accounts = await vault.listAccounts();
  for (const acc of accounts) {
    const dataDir = vault.accountDataPath(acc.id);
    await push(acc.name || acc.id, () => readAuthFromVaultAccount(dataDir));
  }
  return items;
}

/**
 * Claim daily login benefits for all resolvable accounts.
 */
export async function claimAllAccounts({ vault, userDataDir, includeLive = true, fetchImpl = fetch } = {}) {
  const targets = await collectAccountAuths({ vault, userDataDir, includeLive });
  const results = [];
  for (const t of targets) {
    if (t.error) {
      results.push({ label: t.label, userId: null, ok: false, error: t.error, claimed: [] });
      continue;
    }
    try {
      const r = await claimDailyLoginBenefits(t.auth, { fetchImpl });
      const okClaimed = r.claimed.filter((c) => c.ok);
      const failClaimed = r.claimed.filter((c) => !c.ok);
      const daily = r.dailyInfo;
      results.push({
        label: t.label,
        userId: t.userId,
        ok: failClaimed.length === 0,
        claimed: r.claimed,
        alreadyDone: r.alreadyDone.length,
        dailyInfo: daily || null,
        message: okClaimed.length
          ? `领取成功${daily ? ` · 签到${daily.checkinDays}天` : ''}`
          : daily?.claimedToday || r.alreadyDone.length
            ? `今日已领取${daily ? ` · 签到${daily.checkinDays}天` : ''}`
            : '无待领取项',
      });
    } catch (err) {
      results.push({ label: t.label, userId: t.userId, ok: false, error: err.message, claimed: [] });
    }
  }
  return results;
}

function parseResInfo(slotData) {
  const slot = slotData?.find?.((s) => s?.basic_info?.type === RES_SLOT_COPILOT_TOKEN) || slotData?.[0];
  const resInfo = slot?.content?.res_info || [];
  return resInfo.map((item) => {
    const act = item?.activity || {};
    return {
      id: String(item?.id ?? ''),
      title: item?.title || '',
      description: item?.description || '',
      activityType: act.activity_type ?? null,
      userActStatus: act.user_act_status ?? null,
      finished: act.user_act_status === USER_ACT_FINISHED,
      raw: item,
    };
  });
}

/** Status codes from daily_login_activity/get_activity_info */
export const DAY_STATUS = {
  EXPIRED: 1,
  CLAIMED: 2,
  LOCKED: 4,
};

/**
 * Query official daily login activity (每日登录福利).
 * POST https://ima.qq.com/cgi-bin/daily_login_activity/get_activity_info
 */
export async function getDailyLoginInfo(auth, { fetchImpl = fetch } = {}) {
  const headers = buildImaHeaders(auth);
  const json = await postJson(
    `${API_BASE}/daily_login_activity/get_activity_info`,
    {},
    headers,
    fetchImpl,
  );
  if (json.code !== 0) throw new Error(json.msg || `get_activity_info failed: ${json.code}`);
  const infos = (json.infos || []).map((item, index) => {
    const top = item?.top || '';
    const isToday = top === '今日' || item?.status === DAY_STATUS.CLAIMED && index === 2;
    return {
      index,
      top,
      button: item?.button || '',
      reward: item?.reward || '',
      status: item?.status ?? null,
      isToday: top === '今日',
      claimed: item?.status === DAY_STATUS.CLAIMED,
      expired: item?.status === DAY_STATUS.EXPIRED,
      locked: item?.status === DAY_STATUS.LOCKED,
    };
  });
  const today = infos.find((x) => x.isToday) || null;
  return {
    checkinDays: json.checkin_days ?? 0,
    totalRewardPoints: json.total_reward_points ?? 0,
    infos,
    today,
    claimedToday: !!today?.claimed,
  };
}

/**
 * Claim today's daily login reward.
 * POST https://ima.qq.com/cgi-bin/daily_login_activity/check_in
 */
export async function claimDailyLogin(auth, { fetchImpl = fetch } = {}) {
  const headers = buildImaHeaders(auth);
  try {
    const json = await postJson(
      `${API_BASE}/daily_login_activity/check_in`,
      {},
      headers,
      fetchImpl,
    );
    if (json.code !== 0) throw new Error(json.msg || `check_in failed: ${json.code}`);
    return { ok: true, raw: json };
  } catch (err) {
    // Already claimed / forbidden when today is done — treat as non-fatal if info says claimed.
    const info = await getDailyLoginInfo(auth, { fetchImpl });
    if (info.claimedToday) {
      return { ok: true, already: true, info, error: err.message };
    }
    throw err;
  }
}

/**
 * Claim daily login benefits only (type 1005 kept for compatibility; uses official daily_login API).
 */
export async function claimDailyLoginBenefits(auth, { fetchImpl = fetch } = {}) {
  const info = await getDailyLoginInfo(auth, { fetchImpl });
  if (info.claimedToday) {
    return {
      activities: [],
      claimed: [],
      alreadyDone: [{ title: '每日登录福利', finished: true }],
      dailyInfo: info,
    };
  }
  const result = await claimDailyLogin(auth, { fetchImpl });
  const after = result.info || (await getDailyLoginInfo(auth, { fetchImpl }).catch(() => null));
  return {
    activities: [],
    claimed: [
      {
        id: 'daily_login',
        title: '每日登录福利',
        ok: !!result.ok,
        activityType: 1005,
        already: !!result.already,
      },
    ],
    alreadyDone: [],
    dailyInfo: after || info,
  };
}

/** List — only 每日登录福利 via official API. */
export async function listCopilotActivities(auth, { fetchImpl = fetch } = {}) {
  const info = await getDailyLoginInfo(auth, { fetchImpl });
  return [
    {
      id: 'daily_login',
      title: '每日登录福利',
      description:
        info.today?.reward ||
        `签到 ${info.checkinDays} 天 · 累计 ${info.totalRewardPoints} 算力`,
      activityType: ACTIVITY_DAILY_LOGIN,
      userActStatus: info.claimedToday ? USER_ACT_FINISHED : 0,
      finished: info.claimedToday,
      dailyInfo: info,
    },
  ];
}
