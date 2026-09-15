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
    if (await isImaRunning()) fail('IMA is running; close it before save');
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
    if (await isImaRunning()) fail('IMA is running; close it before resave');
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
    const running = await isImaRunning();
    if (running) {
      if (!args.flags.yes) {
        const ok = await confirm('IMA is running. Stop it and switch account?');
        if (!ok) fail('cancelled', 2);
      }
      const stop = await stopIma();
      if (!stop.stopped) fail('failed to stop IMA');
    } else if (!args.flags.yes) {
      const ok = await confirm(`Switch to account "${id}"?`);
      if (!ok) fail('cancelled', 2);
    }
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
