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

/** Read auth from vault account data (auth_login.json / account_meta.json). */
export async function readAuthFromVaultAccount(accountDataDir) {
  const authPath = path.join(accountDataDir, 'auth_login.json');
  try {
    const raw = JSON.parse(await fs.readFile(authPath, 'utf8'));
    const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    if (data.token && data.user_id) {
      return {
        userId: data.user_id,
        idType: String(data.id_type ?? '2'),
        tokenType: String(data.token_type ?? '14'),
        token: data.token,
        refreshToken: data.refresh_token || '',
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
      };
    }
  } catch {
    // ignore
  }
  return null;
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

/** List copilot token activities (daily login benefit etc.). */
export async function listCopilotActivities(auth, { fetchImpl = fetch } = {}) {
  const headers = buildImaHeaders(auth);
  const json = await postJson(
    `${API_BASE}/activity_tab/query_res_slots`,
    { res_slot_types: [RES_SLOT_COPILOT_TOKEN] },
    headers,
    fetchImpl,
  );
  if (json.code !== 0) throw new Error(json.msg || `query_res_slots failed: ${json.code}`);
  return parseResInfo(json.slot_data);
}

/** Claim one activity by id (complete_activity). */
export async function completeActivity(auth, activityId, { fetchImpl = fetch } = {}) {
  const headers = buildImaHeaders(auth);
  const json = await postJson(
    `${API_BASE}/activity_center/complete_activity`,
    { activity_id: String(activityId) },
    headers,
    fetchImpl,
  );
  if (json.code !== 0) throw new Error(json.msg || `complete_activity failed: ${json.code}`);
  return json;
}

/**
 * Claim daily login benefits (activity type 1005 when not finished).
 * Type 1010 is a navigate-only activity in the official client and is not claimed via complete_activity.
 */
export async function claimDailyLoginBenefits(auth, { fetchImpl = fetch } = {}) {
  const activities = await listCopilotActivities(auth, { fetchImpl });
  const daily = activities.filter(
    (a) => a.activityType === ACTIVITY_DAILY_LOGIN && !a.finished && a.id,
  );
  const results = [];
  for (const a of daily) {
    try {
      await completeActivity(auth, a.id, { fetchImpl });
      results.push({ id: a.id, title: a.title, ok: true, activityType: a.activityType });
    } catch (err) {
      results.push({
        id: a.id,
        title: a.title,
        ok: false,
        activityType: a.activityType,
        error: err.message,
      });
    }
  }
  return { activities, claimed: results, alreadyDone: activities.filter((a) => a.finished) };
}
