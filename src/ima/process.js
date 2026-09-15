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
      // name, pid, session, session#, mem
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

export async function stopIma({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') return { stopped: false, reason: 'unsupported-platform' };
  const pids = await listImaPids();
  if (pids.length === 0) return { stopped: true, pids: [] };
  for (const pid of pids) {
    try {
      await execFile('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      // try next / ignore
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const still = await listImaPids();
    if (still.length === 0) return { stopped: true, pids };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { stopped: false, pids, reason: 'timeout' };
}

export async function startIma(exePath, { detached = true } = {}) {
  if (process.platform !== 'win32') throw new Error('IMA launch is Windows-only in v1');
  const child = spawn(exePath, [], {
    detached,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (detached) child.unref();
  return { pid: child.pid };
}
