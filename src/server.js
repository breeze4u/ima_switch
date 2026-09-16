import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VaultStore } from './vault/store.js';
import { captureAccount, resaveAccount, switchAccount } from './vault/snapshot.js';
import { exportAccount, importAccount, saveExportFile } from './vault/exportImport.js';
import { discoverIma } from './ima/discover.js';
import { readIdentityFromUserData } from './ima/identity.js';
import { isImaRunning, stopIma, startIma } from './ima/process.js';
import { OauthManager } from './ima/oauth.js';
import { exchangeWxCode, buildWxQrUrl, imaScanRedirectUri, IMA_WX_APPID } from './ima/wxLogin.js';
import {
  readAuthFromUserData,
  listCopilotActivities,
  claimDailyLoginBenefits,
  claimAllAccounts,
} from './ima/benefit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('multipart boundary missing');
  const boundary = `--${(m[1] || m[2]).trim()}`;
  const parts = [];
  const str = buf.toString('binary');
  const chunks = str.split(boundary);
  for (const chunk of chunks) {
    if (!chunk || chunk === '--\r\n' || chunk === '--') continue;
    let body = chunk;
    if (body.startsWith('\r\n')) body = body.slice(2);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const headerEnd = body.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerText = body.slice(0, headerEnd);
    let data = body.slice(headerEnd + 4);
    if (data.endsWith('\r\n')) data = data.slice(0, -2);
    const nameMatch = /name="([^"]+)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: fileMatch ? fileMatch[1] : '',
      contentType: typeMatch ? typeMatch[1].trim() : '',
      data: Buffer.from(data, 'binary'),
    });
  }
  return parts;
}

async function handleApi(req, res, ctx) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method || 'GET';
  const { vault, opts, oauth } = ctx;

  const ima = await discoverIma({
    userData: opts.imaUserData || undefined,
  });

  if (p === '/api/health' && method === 'GET') {
    const running = await isImaRunning();
    let current = null;
    if (ima.found) {
      current = await readIdentityFromUserData(ima.userData).catch(() => null);
    }
    return sendJson(res, 200, {
      ok: true,
      imaRunning: running,
      imaUserData: ima.userData,
      imaExe: ima.exe,
      imaFound: ima.found,
      vaultRoot: vault.root,
      current,
    });
  }

  if (p === '/api/oauth' && method === 'GET') {
    return sendJson(res, 200, { sessions: oauth.list() });
  }

  if (p === '/api/benefit' && method === 'GET') {
    if (!ima.found) return sendError(res, 400, 'IMA_NOT_FOUND', `IMA User Data not found: ${ima.userData}`);
    try {
      const auth = await readAuthFromUserData(ima.userData);
      if (!auth) return sendError(res, 401, 'NO_AUTH', '未能读取当前登录 token');
      const activities = await listCopilotActivities(auth);
      return sendJson(res, 200, {
        userId: auth.userId,
        nickname: auth.nickname,
        activities: activities.map((a) => ({
          id: a.id,
          title: a.title,
          description: a.description,
          activityType: a.activityType,
          finished: a.finished,
          userActStatus: a.userActStatus,
        })),
      });
    } catch (err) {
      return sendError(res, 502, 'BENEFIT_ERROR', err.message);
    }
  }

  if (p === '/api/benefit/claim-all' && method === 'POST') {
    if (!ima.found) return sendError(res, 400, 'IMA_NOT_FOUND', `IMA User Data not found: ${ima.userData}`);
    try {
      const results = await claimAllAccounts({
        vault,
        userDataDir: ima.userData,
        includeLive: true,
      });
      return sendJson(res, 200, { results });
    } catch (err) {
      return sendError(res, 502, 'BENEFIT_ERROR', err.message);
    }
  }

  if (p === '/api/benefit/claim' && method === 'POST') {
    if (!ima.found) return sendError(res, 400, 'IMA_NOT_FOUND', `IMA User Data not found: ${ima.userData}`);
    try {
      const auth = await readAuthFromUserData(ima.userData);
      if (!auth) return sendError(res, 401, 'NO_AUTH', '未能读取当前登录 token');
      const result = await claimDailyLoginBenefits(auth);
      return sendJson(res, 200, {
        userId: auth.userId,
        nickname: auth.nickname,
        claimed: result.claimed,
        activities: result.activities.map((a) => ({
          id: a.id,
          title: a.title,
          description: a.description,
          activityType: a.activityType,
          finished: a.finished,
          userActStatus: a.userActStatus,
        })),
      });
    } catch (err) {
      return sendError(res, 502, 'BENEFIT_ERROR', err.message);
    }
  }

  if (p === '/api/oauth/qr' && method === 'GET') {
    const retrySession = `rs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const redirectUri = imaScanRedirectUri(retrySession, 'first');
    return sendJson(res, 200, {
      appid: IMA_WX_APPID,
      retrySession,
      qrUrl: buildWxQrUrl({
        appid: IMA_WX_APPID,
        redirectUri,
        state: retrySession,
        selfRedirect: true,
      }),
      // Official IMA wrapper (posts code only to ima.qq.com whitelist)
      imaQrUrl: `https://ima.qq.com/login/#/universal-login-qr-only/?targetOrigin=${encodeURIComponent('https://ima.qq.com')}&retrySession=${encodeURIComponent(retrySession)}&flowSource=first`,
      note: 'WeChat OAuth code is only postMessage\'d to ima.qq.com origins; localhost cannot receive it directly.',
    });
  }

  if (p === '/api/oauth/wx' && method === 'POST') {
    const body = await readJsonBody(req);
    const code = String(body.code || '').trim();
    if (!code) return sendError(res, 400, 'CODE_REQUIRED', 'code is required');
    try {
      const login = await exchangeWxCode(code);
      // Save into vault as a new account (metadata only; full profile still via isolated capture)
      const now = new Date().toISOString();
      const meta = await vault.createMeta({
        name: body.name || login.nickname || '扫码账号',
        note: body.note || '微信扫码登录（token）',
        identity: {
          userId: login.userId,
          nickname: login.nickname,
          avatarUrl: login.avatarUrl,
        },
        source: 'oauth',
      });
      const account = await vault.writeAccount(meta, null);
      const dataDir2 = vault.accountDataPath(account.id);
      await fs.mkdir(dataDir2, { recursive: true });
      await fs.writeFile(
        path.join(dataDir2, 'auth_login.json'),
        JSON.stringify(login.raw, null, 2),
        'utf8',
      );
      await fs.writeFile(
        path.join(dataDir2, 'account_meta.json'),
        JSON.stringify(login.accountMeta, null, 2),
        'utf8',
      );
      return sendJson(res, 200, {
        ok: true,
        account,
        login: {
          userId: login.userId,
          nickname: login.nickname,
          openid: login.openid,
        },
      });
    } catch (err) {
      return sendError(res, 502, 'WX_LOGIN_FAILED', err.message);
    }
  }

  if (p === '/api/oauth/start' && method === 'POST') {
    if (!ima.exeExists) {
      return sendError(res, 400, 'IMA_EXE_MISSING', `IMA exe not found: ${ima.exe}`);
    }
    const body = await readJsonBody(req);
    try {
      const session = await oauth.start({ nameHint: String(body.name || '') });
      return sendJson(res, 200, { session });
    } catch (err) {
      return sendError(res, 409, 'OAUTH_BUSY', err.message);
    }
  }

  const oauthCancel = /^\/api\/oauth\/([^/]+)\/cancel$/.exec(p);
  if (oauthCancel && method === 'POST') {
    const id = decodeURIComponent(oauthCancel[1]);
    try {
      const session = await oauth.cancel(id);
      return sendJson(res, 200, { session });
    } catch (err) {
      return sendError(res, 404, 'NOT_FOUND', err.message);
    }
  }

  const oauthStatus = /^\/api\/oauth\/([^/]+)$/.exec(p);
  if (oauthStatus && method === 'GET') {
    const id = decodeURIComponent(oauthStatus[1]);
    const session = oauth.get(id);
    if (!session) return sendError(res, 404, 'NOT_FOUND', `oauth session not found: ${id}`);
    return sendJson(res, 200, { session: oauth.publicView(session) });
  }

  if (p === '/api/current' && method === 'GET') {
    const running = await isImaRunning();
    let current = null;
    if (ima.found) {
      current = await readIdentityFromUserData(ima.userData).catch(() => null);
    }
    const accounts = await vault.listAccounts();
    const matched =
      current?.userId && accounts.find((a) => a.userId === current.userId)
        ? accounts.find((a) => a.userId === current.userId)
        : null;
    return sendJson(res, 200, {
      imaRunning: running,
      imaFound: ima.found,
      current,
      matchedAccount: matched,
    });
  }

  if (p === '/api/accounts' && method === 'GET') {
    const accounts = await vault.listAccounts();
    let current = null;
    if (ima.found) {
      current = await readIdentityFromUserData(ima.userData).catch(() => null);
    }
    const running = await isImaRunning();
    return sendJson(res, 200, {
      accounts,
      current,
      imaRunning: running,
    });
  }

  if (p === '/api/accounts/save' && method === 'POST') {
    if (!ima.found) {
      return sendError(res, 400, 'IMA_NOT_FOUND', `IMA User Data not found: ${ima.userData}`);
    }
    const body = await readJsonBody(req);
    const running = await isImaRunning();
    if (running) {
      if (body.confirmProcess !== true && body.forceStop !== true) {
        return sendError(
          res,
          409,
          'IMA_RUNNING',
          'IMA is running; confirmProcess/forceStop required to auto-close it',
        );
      }
      const stop = await stopIma();
      if (!stop.stopped) return sendError(res, 500, 'STOP_FAILED', 'failed to stop IMA');
    }
    const name = String(body.name || '').trim();
    if (!name) return sendError(res, 400, 'NAME_REQUIRED', 'name is required');
    const result = await captureAccount({
      vault,
      userDataDir: ima.userData,
      name,
      note: String(body.note || ''),
    });
    if (body.launch === true && ima.exeExists) {
      try {
        await startIma(ima.exe);
      } catch {
        // non-fatal
      }
    }
    return sendJson(res, 200, { account: result.account, copied: result.snapshot.copied.length });
  }

  const switchMatch = /^\/api\/accounts\/([^/]+)\/switch$/.exec(p);
  if (switchMatch && method === 'POST') {
    if (!ima.found) {
      return sendError(res, 400, 'IMA_NOT_FOUND', `IMA User Data not found: ${ima.userData}`);
    }
    const id = decodeURIComponent(switchMatch[1]);
    const body = await readJsonBody(req);
    // Always force-close IMA before switch — no manual exit required.
    const stop = await stopIma();
    if (!stop.stopped) {
      return sendError(res, 500, 'STOP_FAILED', 'failed to stop IMA (try closing it manually)');
    }
    let result;
    try {
      result = await switchAccount({
        vault,
        userDataDir: ima.userData,
        idOrName: id,
      });
    } catch (err) {
      // best-effort relaunch previous state
      if (ima.exeExists) {
        try {
          await startIma(ima.exe);
        } catch {
          // ignore
        }
      }
      return sendError(res, 500, 'SWITCH_FAILED', err.message);
    }
    if (body.launch !== false && ima.exeExists) {
      try {
        await startIma(ima.exe);
      } catch {
        // launch failure is non-fatal after switch
      }
    }
    return sendJson(res, 200, { ok: true, account: result.account });
  }

  const resaveMatch = /^\/api\/accounts\/([^/]+)\/resave$/.exec(p);
  if (resaveMatch && method === 'POST') {
    if (!ima.found) {
      return sendError(res, 400, 'IMA_NOT_FOUND', `IMA User Data not found: ${ima.userData}`);
    }
    const body = await readJsonBody(req);
    if (await isImaRunning()) {
      if (body.confirmProcess !== true && body.forceStop !== true) {
        return sendError(
          res,
          409,
          'IMA_RUNNING',
          'IMA is running; confirmProcess/forceStop required to auto-close it',
        );
      }
      const stop = await stopIma();
      if (!stop.stopped) return sendError(res, 500, 'STOP_FAILED', 'failed to stop IMA');
    }
    const id = decodeURIComponent(resaveMatch[1]);
    const result = await resaveAccount({ vault, userDataDir: ima.userData, idOrName: id });
    if (body.launch === true && ima.exeExists) {
      try {
        await startIma(ima.exe);
      } catch {
        // non-fatal
      }
    }
    return sendJson(res, 200, { account: result.account });
  }

  const exportMatch = /^\/api\/accounts\/([^/]+)\/export$/.exec(p);
  if (exportMatch && method === 'POST') {
    const id = decodeURIComponent(exportMatch[1]);
    const body = await readJsonBody(req);
    const { buffer, ext, account } = await exportAccount(vault, id, {
      password: body.password ? String(body.password) : undefined,
    });
    const filename = `${(account.name || account.id).replace(/[\\/:*?"<>|]+/g, '_')}.${ext}`;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
      'X-Account-Id': account.id,
    });
    return res.end(buffer);
  }

  if (p === '/api/accounts/import' && method === 'POST') {
    const ctype = req.headers['content-type'] || '';
    let fileBuf = null;
    let password;
    let name;
    if (ctype.includes('multipart/form-data')) {
      const raw = await readBody(req);
      const parts = parseMultipart(raw, ctype);
      for (const part of parts) {
        if (part.name === 'file' && part.data.length) fileBuf = part.data;
        if (part.name === 'password') password = part.data.toString('utf8');
        if (part.name === 'name') name = part.data.toString('utf8');
      }
    } else {
      return sendError(res, 400, 'MULTIPART_REQUIRED', 'multipart/form-data with file field required');
    }
    if (!fileBuf) return sendError(res, 400, 'FILE_REQUIRED', 'file is required');
    const account = await importAccount(vault, fileBuf, {
      password: password || undefined,
      name: name || undefined,
    });
    return sendJson(res, 200, { account });
  }

  if (p === '/api/ima/launch' && method === 'POST') {
    if (!ima.exeExists) return sendError(res, 400, 'IMA_EXE_MISSING', `IMA exe not found: ${ima.exe}`);
    if (await isImaRunning()) return sendJson(res, 200, { ok: true, alreadyRunning: true });
    await startIma(ima.exe);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/ima/restart' && method === 'POST') {
    if (!ima.exeExists) return sendError(res, 400, 'IMA_EXE_MISSING', `IMA exe not found: ${ima.exe}`);
    const stop = await stopIma();
    if (!stop.stopped) return sendError(res, 500, 'STOP_FAILED', 'failed to stop IMA');
    await startIma(ima.exe);
    return sendJson(res, 200, { ok: true });
  }

  const delMatch = /^\/api\/accounts\/([^/]+)$/.exec(p);
  if (delMatch && method === 'DELETE') {
    const id = decodeURIComponent(delMatch[1]);
    const account = await vault.getAccount(id);
    if (!account) return sendError(res, 404, 'NOT_FOUND', `account not found: ${id}`);
    await vault.deleteAccount(account.id);
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 404, 'NOT_FOUND', 'no route');
}

async function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://127.0.0.1').pathname;
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.resolve(path.join(PUBLIC_DIR, safe));
  const publicRoot = path.resolve(PUBLIC_DIR) + path.sep;
  if (file !== path.resolve(PUBLIC_DIR) && !file.startsWith(publicRoot)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigation / curl
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

export async function createServer({ vault, opts }) {
  const imaInfo = await discoverIma({ userData: opts.imaUserData || undefined });
  const oauth = new OauthManager({
    vault,
    exePath: imaInfo.exeExists ? imaInfo.exe : null,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      if (p.startsWith('/api/')) {
        if (req.method !== 'GET' && !isAllowedOrigin(req)) {
          return sendError(res, 403, 'ORIGIN_FORBIDDEN', 'cross-origin API calls are not allowed');
        }
        await handleApi(req, res, { vault, opts, oauth });
      } else {
        await serveStatic(req, res);
      }
    } catch (err) {
      const message = err?.message || 'internal error';
      const status = /not found/i.test(message) ? 404 : 500;
      sendError(res, status, 'ERROR', message);
    }
  });
  server.oauth = oauth;
  return server;
}

export async function listen(server, preferredPort, host = '127.0.0.1') {
  let port = preferredPort;
  for (let i = 0; i < 50; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      return { port: actualPort, host, url: `http://${host}:${actualPort}` };
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        port += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error('no available port');
}

export async function startWebUi({ vault, opts }) {
  await vault.init();
  const server = await createServer({ vault, opts });
  const addr = await listen(server, opts.webPort || 17321);
  return { server, ...addr };
}
