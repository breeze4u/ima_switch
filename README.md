# ima-switch

腾讯 IMA 电脑端账号切换工具：npm 安装，终端启动，带 WebUI，支持账号导入 / 导出 / 备份。

## 功能

- 将当前 IMA 登录态保存为可命名的账号档案
- 一键在多个账号之间切换（**强制关闭并重启 IMA**，无需手动退出）
- **扫码添加账号**：打开独立 IMA 登录窗口，扫码后自动入库
- 导出 / 导入账号备份（可选密码，AES-256-GCM）
- 本机 WebUI 管理界面 + CLI

## 安装

```bash
# 从 npm（发布后）
npm install -g ima-switch

# 本地开发
cd ima-switch
npm install -g .
```

需要 Node.js >= 18，以及 Windows 上的腾讯 IMA 电脑端。

## 快速开始

```bash
# 启动 WebUI（默认 http://127.0.0.1:17321）
ima-switch

# 查看状态
ima-switch status

# 保存当前登录（需先退出 IMA）
ima-switch save 工作号

# 列出账号
ima-switch list

# 切换账号（强制关闭 IMA 并重启，无需手动退出）
ima-switch switch 工作号

# 扫码添加账号（打开独立登录窗口，不影响当前账号）
ima-switch oauth 小号
# 或在 WebUI 点「扫码添加账号」

# 导出 / 导入
ima-switch export 工作号 -o work.zip
ima-switch export 工作号 --password mypass
ima-switch import work.zip
ima-switch import backup.ima-switch.enc --password mypass
```

## 账号库位置

默认：`%USERPROFILE%\.ima-switch\`

```
.ima-switch/
  config.json
  accounts/<id>/meta.json
  accounts/<id>/data/...
  .trash/pre-switch-.../
  exports/
```

可通过 `--vault` 或 `config.json` 修改。

## 工作原理

IMA 是 Chromium 架构应用，数据在 `%LOCALAPPDATA%\ima.copilot\User Data`。

本工具**选择性快照**登录相关文件（而非整份 User Data）：

- `Local State`、`key_info/`、`imsdk/`
- `Default/Preferences`、`Secure Preferences`
- Cookies、Local Storage、ima.qq.com IndexedDB
- `Default/IMA_*` 账号目录

切换前会把当前状态备份到 `.trash/`，失败可回滚。

> 注意：Chromium 的 DPAPI 加密在同一 Windows 用户下有效。跨机器导入后若无法自动登录，请重新扫码登录，再 `save` 覆盖该档案。

## 安全说明

- 本机账号库为明文文件夹，请勿分享本机目录
- 导出时建议设置密码（AES-256-GCM）
- WebUI 仅监听 `127.0.0.1`
- 导出包含登录态 token，等同账号凭证

## CLI

```
ima-switch                         # = start WebUI
ima-switch start [--port N] [--no-open] [--ima-data <path>] [--vault <path>]
ima-switch status
ima-switch list [--json]
ima-switch save <name> [--note ""]
ima-switch resave <id|name>
ima-switch switch <id|name> [--yes] [--no-launch]
ima-switch delete <id|name> [--yes]
ima-switch export <id|name> [-o <file>] [--password <pw>]
ima-switch import <file> [--password <pw>] [--name <name>]
ima-switch launch
```

## 开发

```bash
npm test
node src/cli.js status
```

规格文档：`docs/compose/spec/ima-account-switcher.md`

## License

MIT
