#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { VaultStore } from './vault/store.js';
import {
  captureAccount,
  resaveAccount,
  switchAccount,
} from './vault/snapshot.js';
import { exportAccount, importAccount, saveExportFile } from './vault/exportImport.js';
import { discoverIma } from './ima/discover.js';
import { isImaRunning, stopIma, startIma } from './ima/process.js';
import { startWebUi } from './server.js';
import { defaultVaultRoot } from './util/fsx.js';
import {
  readAuthFromUserData,
  listCopilotActivities,
  claimDailyLoginBenefits,
  claimAllAccounts,
} from './ima/benefit.js';

const pkg = JSON.parse(
  await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

function printHelp() {
  console.log(`ima-switch v${pkg.version}

腾讯 IMA 电脑端账号切换工具

Usage:
  ima-switch                         启动 WebUI
  ima-switch start [--port N] [--no-open] [--ima-data <path>] [--vault <path>]
  ima-switch status
  ima-switch list [--json]
  ima-switch save <name> [--note ""] [--ima-data <path>]
  ima-switch resave <id|name>
  ima-switch switch <id|name> [--yes] [--no-launch]
  ima-switch oauth [name]              # 打开独立窗口扫码添加账号
  ima-switch benefit                   # 查看当前账号每日登录福利/算力活动
  ima-switch benefit --claim           # 领取当前账号每日登录算力
  ima-switch benefit --claim --all     # 遍历账号库+当前登录，多账号自动领取
  ima-switch delete <id|name> [--yes]
  ima-switch export <id|name> [-o <file>] [--password <pw>]
  ima-switch import <file> [--password <pw>] [--name <name>]
  ima-switch launch
  ima-switch --help
  ima-switch --version
`);
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.flags.help = true;
    else if (a === '--version' || a === '-v') args.flags.version = true;
    else if (a === '--json') args.flags.json = true;
    else if (a === '--yes' || a === '-y') args.flags.yes = true;
    else if (a === '--claim') args.flags.claim = true;
    else if (a === '--all') args.flags.all = true;
    else if (a === '--no-open') args.flags.noOpen = true;
    else if (a === '--no-launch') args.flags.noLaunch = true;
    else if (a === '--port') args.flags.port = Number(argv[++i]);
    else if (a === '--note') args.flags.note = String(argv[++i] || '');
    else if (a === '--ima-data') args.flags.imaData = String(argv[++i] || '');
    else if (a === '--vault') args.flags.vault = String(argv[++i] || '');
    else if (a === '--password') args.flags.password = String(argv[++i] || '');
    else if (a === '--name') args.flags.name = String(argv[++i] || '');
    else if (a === '-o' || a === '--out') args.flags.out = String(argv[++i] || '');
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) args.flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else args._.push(a);
  }
  return args;
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

async function resolveIma(flags) {
  return discoverIma({
    userData: flags.imaData || undefined,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'start';

  if (args.flags.help) {
    printHelp();
    return;
  }
  if (args.flags.version) {
    console.log(pkg.version);
    return;
  }

  const vault = new VaultStore(args.flags.vault || defaultVaultRoot());
  await vault.init();
  const overrides = {};
  if (args.flags.imaData) overrides.imaUserData = args.flags.imaData;
  if (args.flags.port) overrides.webPort = args.flags.port;
  const config = await vault.loadConfig(overrides);

  if (cmd === 'start' || cmd === 'web' || cmd === 'ui') {
    const opts = {
      imaUserData: config.imaUserData,
      webPort: config.webPort || 17321,
      openBrowser: !args.flags.noOpen && config.openBrowser !== false,
    };
    const { url } = await startWebUi({ vault, opts });
    console.log(`ima-switch WebUI: ${url}`);
    console.log(`Vault: ${vault.root}`);
    if (opts.openBrowser) {
      try {
        const { spawn } = await import('node:child_process');
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } catch {
        // ignore
      }
    }
    // keep process alive
    return;
  }

  if (cmd === 'status') {
    const ima = await resolveIma(args.flags);
    const running = await isImaRunning();
    const accounts = await vault.listAccounts();
    if (args.flags.json) {
      console.log(
        JSON.stringify(
          {
            ima: { ...ima, running },
            vault: vault.root,
            accountCount: accounts.length,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`IMA User Data: ${ima.userData} (${ima.found ? 'found' : 'MISSING'})`);
    console.log(`IMA exe:       ${ima.exe} (${ima.exeExists ? 'found' : 'MISSING'})`);
    console.log(`IMA running:   ${running ? 'yes' : 'no'}`);
    console.log(`Vault:         ${vault.root}`);
    console.log(`Accounts:      ${accounts.length}`);
    return;
  }

  if (cmd === 'list') {
    const accounts = await vault.listAccounts();
    if (args.flags.json) {
      console.log(JSON.stringify(accounts, null, 2));
      return;
    }
    if (!accounts.length) {
      console.log('No accounts yet. Use: ima-switch save <name>');
      return;
    }
    for (const a of accounts) {
      const mark = a.lastUsedAt ? '*' : ' ';
      console.log(
        `${mark} ${a.id}  ${a.name}  ${a.nickname || '-'}  ${a.userId || '-'}  updated=${a.updatedAt}`,
      );
    }
    return;
  }

  if (cmd === 'save') {
    const name = args._[1];
    if (!name) fail('usage: ima-switch save <name>');
    const ima = await resolveIma(args.flags);
    if (!ima.found) fail(`IMA User Data not found: ${ima.userData}`);
    if (await isImaRunning()) {
      if (!args.flags.yes && !process.stdin.isTTY) {
        fail('IMA is running; non-interactive save requires --yes to force-close', 2);
      }
      if (!args.flags.yes) {
        const ok = await confirm('IMA 正在运行。强制关闭后保存当前登录？');
        if (!ok) fail('cancelled', 2);
      }
      const stop = await stopIma();
      if (!stop.stopped) fail('failed to stop IMA');
    }
    const result = await captureAccount({
      vault,
      userDataDir: ima.userData,
      name,
      note: args.flags.note || '',
    });
    console.log(`Saved account ${result.account.id} (${result.account.name})`);
    console.log(`  files: ${result.snapshot.copied.length}`);
    if (result.identity?.nickname) console.log(`  nickname: ${result.identity.nickname}`);
    return;
  }

  if (cmd === 'resave') {
    const id = args._[1];
    if (!id) fail('usage: ima-switch resave <id|name>');
    const ima = await resolveIma(args.flags);
    if (!ima.found) fail(`IMA User Data not found: ${ima.userData}`);
    if (await isImaRunning()) {
      if (!args.flags.yes && !process.stdin.isTTY) {
        fail('IMA is running; non-interactive resave requires --yes to force-close', 2);
      }
      if (!args.flags.yes) {
        const ok = await confirm('IMA 正在运行。强制关闭后覆盖保存？');
        if (!ok) fail('cancelled', 2);
      }
      const stop = await stopIma();
      if (!stop.stopped) fail('failed to stop IMA');
    }
    const result = await resaveAccount({ vault, userDataDir: ima.userData, idOrName: id });
    console.log(`Updated account ${result.account.id} (${result.account.name})`);
    return;
  }

  if (cmd === 'switch') {
    const id = args._[1];
    if (!id) fail('usage: ima-switch switch <id|name>');
    const ima = await resolveIma(args.flags);
    if (!ima.found) fail(`IMA User Data not found: ${ima.userData}`);
    if (!args.flags.yes && !process.stdin.isTTY) {
      fail('non-interactive switch requires --yes', 2);
    }
    if (!args.flags.yes) {
      const ok = await confirm(`强制关闭 IMA 并切换到「${id}」？`);
      if (!ok) fail('cancelled', 2);
    }
    const stop = await stopIma();
    if (!stop.stopped) fail('failed to stop IMA (try closing it manually)');
    const result = await switchAccount({
      vault,
      userDataDir: ima.userData,
      idOrName: id,
    });
    console.log(`Switched to ${result.account.name} (${result.account.id})`);
    if (!args.flags.noLaunch && ima.exeExists) {
      await startIma(ima.exe);
      console.log('IMA launched');
    }
    return;
  }

  if (cmd === 'oauth' || cmd === 'qr' || cmd === 'add-qr') {
    // CLI OAuth helper: start isolated IMA window, wait for login, save account.
    const ima = await resolveIma(args.flags);
    if (!ima.exeExists) fail(`IMA exe not found: ${ima.exe}`);
    const { OauthManager } = await import('./ima/oauth.js');
    const oauth = new OauthManager({ vault, exePath: ima.exe });
    const nameHint = args.flags.name || args._[1] || '';
    console.log('正在打开独立登录窗口，请扫码…');
    const session = await oauth.start({ nameHint });
    console.log(`会话 ${session.id}，临时目录 ${session.userDataDir}`);
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = oauth.get(session.id);
      if (!s) break;
      const view = oauth.publicView(s);
      if (view.status === 'done') {
        console.log(`完成：${view.account?.name} (${view.account?.id})`);
        return;
      }
      if (view.status === 'failed' || view.status === 'cancelled') {
        fail(view.message || 'oauth failed');
      }
      process.stdout.write('.');
    }
    await oauth.cancel(session.id);
    fail('oauth timeout');
  }

  if (cmd === 'benefit') {
    const ima = await resolveIma(args.flags);
    if (!ima.found) fail(`IMA User Data not found: ${ima.userData}`);
    const wantClaim = args.flags.claim || args._[1] === 'claim';
    const wantAll = args.flags.all || args._.includes('--all');

    if (wantClaim && wantAll) {
      console.log('多账号领取每日登录算力…');
      const results = await claimAllAccounts({
        vault,
        userDataDir: ima.userData,
        includeLive: true,
      });
      let okCount = 0;
      for (const r of results) {
        const mark = r.ok ? '✓' : '✗';
        console.log(`  ${mark} ${r.label}${r.userId ? ` (${r.userId})` : ''}: ${r.error || r.message}`);
        for (const c of r.claimed || []) {
          console.log(`      ${c.ok ? '✓' : '✗'} ${c.title}${c.error ? ` — ${c.error}` : ''}`);
        }
        if (r.ok) okCount++;
      }
      console.log(`完成：${okCount}/${results.length} 个账号处理成功`);
      if (!okCount && results.length) fail('所有账号领取均失败', 1);
      return;
    }

    const auth = await readAuthFromUserData(ima.userData);
    if (!auth) fail('未能读取当前登录 token，请先登录 IMA');
    console.log(`账号 ${auth.nickname || auth.userId}`);
    if (wantClaim) {
      const result = await claimDailyLoginBenefits(auth);
      console.log(`活动列表 ${result.activities.length} 项，本次领取 ${result.claimed.length} 项`);
      for (const c of result.claimed) {
        console.log(c.ok ? `  ✓ ${c.title} (${c.id})` : `  ✗ ${c.title} (${c.id}): ${c.error}`);
      }
      if (!result.claimed.length) {
        console.log('今日没有可领取的每日登录福利（可能已领完）');
        for (const a of result.activities) {
          if (a.activityType === 1005 || a.activityType === 1010) {
            console.log(`  - ${a.title} status=${a.userActStatus}${a.finished ? ' [已完成]' : ''}`);
          }
        }
      }
      return;
    }
    const acts = await listCopilotActivities(auth);
    if (!acts.length) {
      console.log('没有每日登录福利活动');
    }
    for (const a of acts) {
      const tag = a.finished ? '已完成' : '可领取';
      console.log(`  [${tag}] ${a.title} id=${a.id} ${a.description}`);
    }
    console.log('领取：ima-switch benefit --claim');
    console.log('多账号：ima-switch benefit --claim --all');
    return;
  }

  if (cmd === 'delete') {
    const id = args._[1];
    if (!id) fail('usage: ima-switch delete <id|name>');
    const account = await vault.getAccount(id);
    if (!account) fail(`account not found: ${id}`);
    if (!args.flags.yes) {
      const ok = await confirm(`Delete account "${account.name}" (${account.id})?`);
      if (!ok) fail('cancelled', 2);
    }
    await vault.deleteAccount(account.id);
    console.log(`Deleted ${account.id}`);
    return;
  }

  if (cmd === 'export') {
    const id = args._[1];
    if (!id) fail('usage: ima-switch export <id|name> [-o file]');
    const { buffer, ext, account } = await exportAccount(vault, id, {
      password: args.flags.password,
    });
    let out = args.flags.out;
    if (!out) {
      out = await saveExportFile(vault, buffer, ext, account.name);
    } else {
      await fs.writeFile(out, buffer);
    }
    console.log(`Exported ${account.name} -> ${out}`);
    return;
  }

  if (cmd === 'import') {
    const file = args._[1];
    if (!file) fail('usage: ima-switch import <file>');
    const buf = await fs.readFile(file);
    const account = await importAccount(vault, buf, {
      password: args.flags.password,
      name: args.flags.name,
    });
    console.log(`Imported ${account.name} (${account.id})`);
    return;
  }

  if (cmd === 'launch') {
    const ima = await resolveIma(args.flags);
    if (!ima.exeExists) fail(`IMA exe not found: ${ima.exe}`);
    const running = await isImaRunning();
    if (running) {
      console.log('IMA already running');
      return;
    }
    await startIma(ima.exe);
    console.log('IMA launched');
    return;
  }

  printHelp();
  fail(`unknown command: ${cmd}`);
}

main().catch((err) => {
  fail(err?.message || String(err));
});
