import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);
import { IMA_PROCESS_NAME } from './discover.js';

export async function isImaRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFile('tasklist', [
      '/FI',
      `IMAGENAME eq ${IMA_PROCESS_NAME}.exe`,
      '/FO',
      'CSV',
      '/NH',
    ]);
    return stdout.includes(IMA_PROCESS_NAME);
  } catch {
    return false;
  }
}

export async function listImaPids() {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFile('tasklist', [
      '/FI',
      `IMAGENAME eq ${IMA_PROCESS_NAME}.exe`,
      '/FO',
      'CSV',
      '/NH',
    ]);
    const pids = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(IMA_PROCESS_NAME)) continue;
      const parts = line.replace(/^"|"$/g, '').split('","');
      if (parts.length >= 2) {
        const pid = Number(parts[1]);
        if (Number.isFinite(pid)) pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

export async function isPidAlive(pid) {
  if (!pid || process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFile('tasklist', [
      '/FI',
      `PID eq ${pid}`,
      '/FO',
      'CSV',
      '/NH',
    ]);
    return stdout.includes(String(pid));
  } catch {
    return false;
  }
}

async function waitPidsGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let any = false;
    for (const pid of pids) {
      if (await isPidAlive(pid)) {
        any = true;
        break;
      }
    }
    if (!any) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export async function stopPids(pids, { timeoutMs = 10000 } = {}) {
  if (process.platform !== 'win32') return { stopped: false, reason: 'unsupported-platform' };
  const targets = (pids || []).filter((p) => Number.isFinite(p) && p > 0);
  if (targets.length === 0) return { stopped: true, pids: [] };
  for (const pid of targets) {
    try {
      await execFile('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      // process may already be gone
    }
  }
  const gone = await waitPidsGone(targets, timeoutMs);
  return gone
    ? { stopped: true, pids: targets }
    : { stopped: false, pids: targets, reason: 'timeout' };
}

/** Force-stop every ima.copilot process (used by switch). */
export async function stopIma({ timeoutMs = 12000 } = {}) {
  if (process.platform !== 'win32') return { stopped: false, reason: 'unsupported-platform' };
  let pids = await listImaPids();
  if (pids.length === 0) return { stopped: true, pids: [] };
  for (const pid of pids) {
    try {
      await execFile('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      // ignore
    }
  }
  // second pass: some child processes may respawn or appear late
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const still = await listImaPids();
    if (still.length === 0) return { stopped: true, pids };
    for (const pid of still) {
      try {
        await execFile('taskkill', ['/PID', String(pid), '/T', '/F']);
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { stopped: false, pids: await listImaPids(), reason: 'timeout' };
}

/**
 * Start IMA. Optionally with an isolated Chromium user-data-dir (for OAuth QR login).
 * Returns { pid }.
 */
export async function startIma(exePath, { detached = true, userDataDir = null } = {}) {
  if (process.platform !== 'win32') throw new Error('IMA launch is Windows-only in v1');
  const args = [];
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
  }
  const child = spawn(exePath, args, {
    detached,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (detached) child.unref();
  return { pid: child.pid };
}

/** Force-stop IMA then start it again (default path for switch). */
export async function restartIma(exePath, { timeoutMs = 12000 } = {}) {
  const stop = await stopIma({ timeoutMs });
  if (!stop.stopped) return { ok: false, stop };
  const start = await startIma(exePath);
  return { ok: true, stop, start };
}
