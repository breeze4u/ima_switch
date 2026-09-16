import crypto from 'node:crypto';

/** Production WeChat appid used by ima.qq.com login page. */
export const IMA_WX_APPID = 'wx0d63f5de059f1d52';
export const IMA_LOGIN_API = 'https://ima.qq.com/cgi-bin/auth_login/login';
export const ACCOUNT_TYPE_WX = 2;

function randomGuid() {
  return `guid-${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`;
}

/**
 * Exchange a WeChat OAuth code for IMA login tokens.
 * Mirrors the web client: POST /cgi-bin/auth_login/login
 */
export async function exchangeWxCode(code, { appid = IMA_WX_APPID, fetchImpl = fetch } = {}) {
  if (!code || typeof code !== 'string') {
    throw new Error('wx code is required');
  }
  const body = {
    account_type: ACCOUNT_TYPE_WX,
    code,
    auth_appid: appid,
    client_info: {
      guid: randomGuid(),
      platform: 4,
      qimei36: `q36-${crypto.randomBytes(8).toString('hex')}`,
    },
  };
  const res = await fetchImpl(IMA_LOGIN_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://ima.qq.com',
      referer: 'https://ima.qq.com/',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`login API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.code !== 0 && json.code !== undefined && json.code !== null) {
    // code 0 is success; some responses use 0 implicitly
    if (json.code !== 0) {
      throw new Error(json.msg || `login failed with code ${json.code}`);
    }
  }
  if (!json.data && !json.token && !json.user_id && !json.userId) {
    // try nested
    if (json.code === 0) return normalizeLoginResponse(json);
    throw new Error(json.msg || 'login response missing token');
  }
  return normalizeLoginResponse(json);
}

/**
 * Normalize various response shapes into account_meta-like object.
 */
export function normalizeLoginResponse(json) {
  const root = json.data && typeof json.data === 'object' ? json.data : json;
  const userId = root.user_id || root.userId || '';
  const token = root.token || '';
  const refreshToken = root.refresh_token || root.refreshToken || '';
  const tokenValidTime = String(root.token_valid_time ?? root.tokenValidTime ?? '');
  const refreshTokenValidTime = String(
    root.refresh_token_valid_time ?? root.refreshTokenValidTime ?? '',
  );
  const idType = String(root.id_type ?? root.idType ?? '2');
  const tokenType = root.token_type ?? root.tokenType ?? 14;
  const userInfo = root.user_info || root.userInfo || {};

  if (!userId && !token) {
    throw new Error('login response missing userId/token');
  }

  const openInfo = userInfo.open_info || userInfo.openInfo || {};
  const accountMeta = {
    credential_id: 'ima_account_default',
    id_type: idType,
    is_login: true,
    refresh_token_valid_time: refreshTokenValidTime,
    storage_state: 'normal_v3',
    token_type: tokenType,
    token_valid_time: tokenValidTime,
    user_id: userId,
    user_info: userInfo,
    version: 3,
    token,
    refresh_token: refreshToken,
  };

  return {
    userId,
    nickname: openInfo.nickname || userInfo.custom_info?.nick || '',
    avatarUrl: openInfo.avatar_url || '',
    openid: openInfo.openid || '',
    token,
    refreshToken,
    tokenValidTime,
    refreshTokenValidTime,
    raw: json,
    accountMeta,
  };
}

/** Build WeChat qrconnect URL for embedding in WebUI. */
export function buildWxQrUrl({
  appid = IMA_WX_APPID,
  redirectUri,
  state = 'ima-switch',
  selfRedirect = true,
} = {}) {
  const params = new URLSearchParams({
    appid,
    scope: 'snsapi_login',
    redirect_uri: redirectUri,
    state,
    login_type: 'jssdk',
    self_redirect: selfRedirect ? 'true' : 'false',
    styletype: '',
    sizetype: '',
    bgcolor: '',
    rst: '',
    ts: String(Date.now()),
    stylelite: '1',
    fast_login: '1',
    lang: 'cn',
  });
  return `https://open.weixin.qq.com/connect/qrconnect?${params.toString()}`;
}

/**
 * Default redirect back to ima.qq.com scan-confirm page (authorized domain).
 * WeChat will navigate the iframe here after a successful scan when self_redirect=true.
 */
export function imaScanRedirectUri(retrySession = 'default', flowSource = 'first') {
  const q = new URLSearchParams({ retrySession, flowSource });
  return `https://ima.qq.com/login/#/qr-code-scanned/?${q.toString()}`;
}
