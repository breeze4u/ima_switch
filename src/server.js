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
  const { vault, opts } = ctx;

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
    if (await isImaRunning()) {
      return sendError(res, 409, 'IMA_RUNNING', 'IMA is running; close it before save');
    }
    const body = await readJsonBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendError(res, 400, 'NAME_REQUIRED', 'name is required');
    const result = await captureAccount({
      vault,
      userDataDir: ima.userData,
      name,
      note: String(body.note || ''),
    });
    return sendJson(res, 200, { account: result.account, copied: result.snapshot.copied.length });
  }

  const switchMatch = /^\/api\/accounts\/([^/]+)\/switch$/.exec(p);
  if (switchMatch && method === 'POST') {
    if (!ima.found) {
      return sendError(res, 400, 'IMA_NOT_FOUND', `IMA User Data not found: ${ima.userData}`);
    }
    const id = decodeURIComponent(switchMatch[1]);
    const body = await readJsonBody(req);
    const running = await isImaRunning();
    if (running && body.confirmProcess !== true) {
      return sendError(res, 409, 'IMA_RUNNING', 'IMA is running; confirmProcess required');
    }
    if (running) {
      const stop = await stopIma();
      if (!stop.stopped) {
        return sendError(res, 500, 'STOP_FAILED', 'failed to stop IMA');
      }
    }
    const result = await switchAccount({
      vault,
      userDataDir: ima.userData,
      idOrName: id,
    });
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
    if (await isImaRunning()) {
      return sendError(res, 409, 'IMA_RUNNING', 'IMA is running; close it before resave');
    }
    const id = decodeURIComponent(resaveMatch[1]);
    const result = await resaveAccount({ vault, userDataDir: ima.userData, idOrName: id });
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
  const server = http.createServer(async (req, res) => {
    try {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      if (p.startsWith('/api/')) {
        if (req.method !== 'GET' && !isAllowedOrigin(req)) {
          return sendError(res, 403, 'ORIGIN_FORBIDDEN', 'cross-origin API calls are not allowed');
        }
        await handleApi(req, res, { vault, opts });
      } else {
        await serveStatic(req, res);
      }
    } catch (err) {
      const message = err?.message || 'internal error';
      const status = /not found/i.test(message) ? 404 : 500;
      sendError(res, status, 'ERROR', message);
    }
  });
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
