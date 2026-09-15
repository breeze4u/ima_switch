---
feature: ima-account-switcher
status: in-progress
updated: 2026-09-15
branch: feat/ima-account-switcher
commits: c8b3bf3..c8b3bf3
---

# IMA Account Switcher

## Report

## [S1] Problem

腾讯 IMA 电脑端是 Chromium 架构应用（`%LOCALAPPDATA%\ima.copilot`），单机默认一份 `User Data`。用户需要在多个 IMA 账号之间快速切换，并在本机备份、导出、导入登录态，但官方客户端没有提供完整的外部账号库与跨机备份能力。

当前用户可见痛点：

1. 多账号只能靠客户端内切换或反复退出登录，无法作为可管理的“账号档案”。
2. 重装/换机时登录态难以可靠迁出。
3. 没有可通过 npm 安装、终端启动、带 WebUI 的统一管理入口。

## [S2] Design

### 2.1 Product shape

- npm 包名：`ima-switch`
- CLI 入口：`ima-switch`（`bin` 指向 `src/cli.js`）
- 默认行为：启动本地 WebUI（`127.0.0.1`，默认端口 `17321`，冲突则自动递增）
- 平台：Windows first；路径与进程逻辑可扩展，但 v1 只实现 Windows
- 本机账号库：`%USERPROFILE%\.ima-switch\accounts\<accountId>\`
- 导出包：可选密码加密；未加密时为 zip

### 2.2 IMA on-disk contract (Windows)

| 用途 | 路径 |
| --- | --- |
| 安装目录 | `%LOCALAPPDATA%\ima.copilot\Application` |
| 可执行文件 | `...\Application\ima.copilot.exe` |
| User Data | `%LOCALAPPDATA%\ima.copilot\User Data` |
| 当前身份 | `User Data\Default\Preferences` → `tencent.wxlogin.account_meta`（JSON 字符串） |
| 加密密钥 | `User Data\Local State` → `os_crypt.encrypted_key` |
| Cookie | `User Data\Default\Network\Cookies` |
| Web 存储 | `User Data\Default\Local Storage\`、`IndexedDB\https_ima.qq.com_...` |
| 账号目录 | `User Data\Default\IMA_<uid>\`、`User Data\imsdk\<appId>_<hex(uid)>\` |
| 密钥库 | `User Data\key_info\` |

`account_meta` 解析字段（用于列表展示）：

- `user_id`
- `open_info.nickname`
- `open_info.avatar_url`
- `open_info.openid`
- `is_login` / token 过期时间（仅作提示，不作为强校验）

### 2.3 Selective login-state snapshot

每个账号档案目录结构：

```
~/.ima-switch/accounts/<accountId>/
  meta.json          # 元数据，不包含明文 token 专有字段之外的额外密钥
  data/              # 从 User Data 相对路径镜像复制的登录态子集
```

`meta.json`：

```json
{
  "id": "acc_20260915_abc123",
  "name": "工作号",
  "userId": "001a7c61884037e7",
  "nickname": "…",
  "avatarUrl": "…",
  "source": "capture|import",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "lastUsedAt": null,
  "note": ""
}
```

**Capture 时复制的相对路径（相对 `User Data`）**：

1. `Local State`
2. `key_info/`（整目录）
3. `imsdk/`（整目录，排除 `crash_report_dir` 可选；v1 整目录复制）
4. `Default/Preferences`
5. `Default/Secure Preferences`
6. `Default/Network/Cookies`
7. `Default/Network/Cookies-journal`（若存在）
8. `Default/Network/Device Bound Sessions`
9. `Default/Network/Device Bound Sessions-journal`（若存在）
10. `Default/Extension Cookies`
11. `Default/Local Storage/`（整目录）
12. `Default/IndexedDB/https_ima.qq.com_0.indexeddb.leveldb/` 及同前缀变体
13. `Default/Session Storage/`
14. `Default/Account Web Data`
15. `Default/Account Web Data-journal`（若存在）
16. `Default/IMA_*/`（所有匹配目录）

复制规则：

- 文件/目录不存在则跳过，不视为失败
- 复制前确保 IMA 未运行（见 2.5）
- 使用 `fs.cp` / 逐文件复制，保留相对路径结构
- 目标已存在同名账号时：`save` 要求新 name/id，`resave` 覆盖同 id

**Switch 规则**：

1. 确认目标档案存在
2. 将当前 User Data 中上述路径先备份到 `~/.ima-switch/.trash/pre-switch-<ts>/`（可配置保留最近 N=3 份）
3. 从目标 `data/` 恢复到 User Data
4. 删除 User Data 中“源存在但目标快照没有”的受管路径（避免残留旧 Cookies）
5. 更新 `meta.lastUsedAt`
6. 若用户确认且允许，重启 IMA

**Why selective**：体积小、可导出；Chromium DPAPI 在同一 Windows 用户下可继续解密随快照一并保存的 `Local State.encrypted_key` 与 Cookies。跨机导入在同一用户域不可保证自动登录，导入后若无法登录则引导用户重新扫码登录并 `save`。

### 2.4 Vault & process

```
~/.ima-switch/
  config.json
  accounts/
    acc_xxx/meta.json
    acc_xxx/data/...
  .trash/pre-switch-.../
  exports/          # 默认导出落点（可改）
```

`config.json` 默认：

```json
{
  "imaUserData": null,
  "webPort": 17321,
  "openBrowser": true,
  "keepTrash": 3
}
```

`imaUserData` 为空时自动发现：`%LOCALAPPDATA%\ima.copilot\User Data`；不存在则 WebUI/CLI 报可读错误。

### 2.5 Process control

- 进程匹配：`ima.copilot`（含子进程）
- `isRunning()`：`tasklist` 或 `wmic` 查询
- `stop()`：对匹配 PID 发送终止；Windows 下 `taskkill /PID <pid> /T /F`，等待锁文件释放
- `start()`：启动 `Application\ima.copilot.exe`
- 切换前：若运行中，WebUI/CLI 必须先展示确认；用户同意后 stop → switch → start
- CLI 无 `--yes` 时，交互确认；非 TTY 且未 `--yes` 则拒绝切换

### 2.6 CLI

```
ima-switch                         # = start
ima-switch start [--port 17321] [--no-open] [--ima-data <path>]
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
```

退出码：成功 0；用户取消 2；业务错误 1。

### 2.7 WebUI

本地 HTTP，仅绑定 `127.0.0.1`。静态页由 `public/` 提供，无构建步骤（原生 HTML/CSS/JS）。

页面能力：

1. 顶部：IMA 路径、运行状态、刷新
2. 账号卡片列表：头像、昵称、userId、上次使用、操作
3. 「保存当前账号」：输入名称 → `POST /api/accounts/save`
4. 「切换」：二次确认（若 IMA 运行）→ `POST /api/accounts/:id/switch`
5. 「删除」确认
6. 「导出」：下载 zip；可选密码
7. 「导入」：上传 zip + 可选密码
8. 错误 toast / 空状态引导

### 2.8 HTTP API

| Method | Path | Body / Query | Response |
| --- | --- | --- | --- |
| GET | `/api/health` | | `{ok,imaRunning,imaUserData,imaExe}` |
| GET | `/api/accounts` | | `{accounts:[meta...]}` |
| POST | `/api/accounts/save` | `{name,note?}` | `{account}` |
| POST | `/api/accounts/:id/resave` | | `{account}` |
| POST | `/api/accounts/:id/switch` | `{confirmProcess:boolean,launch:boolean}` | `{ok,account}` |
| DELETE | `/api/accounts/:id` | | `{ok}` |
| POST | `/api/accounts/:id/export` | `{password?}` | zip binary |
| POST | `/api/accounts/import` | multipart zip + `password?` | `{account}` |

错误统一：`{error:{code,message}}`，HTTP 4xx/5xx。

### 2.9 Export format

- 未加密：zip，内含 `meta.json` + `data/**`
- 加密：`ima-switch.enc` = `magic(8) | salt(16) | iv(12) | authTag(16) | ciphertext`
  - magic：`IMASW1\n\0`
  - KDF：scrypt(password, salt, N=16384, r=8, p=1, 32 bytes)
  - cipher：AES-256-GCM；明文为上述 zip 字节
- Import 自动识别 magic；解密失败给出明确错误

### 2.10 Error behavior

| 场景 | 行为 |
| --- | --- |
| 未找到 IMA User Data | 明确路径提示与可配置项 |
| IMA 运行中且用户拒绝关闭 | 取消，不改数据 |
| 目标账号不存在 | 404 / exit 1 |
| 复制中途失败 | 尽量回滚 pre-switch 备份 |
| 导出密码错误 | 拒绝导入，不改库 |
| 端口占用 | 自动 port+1，直到成功或超范围 |

### 2.11 Testing boundaries

- 单元：路径发现、meta 解析、export/import 往返、加密包往返、受管路径列表
- 集成：用临时目录模拟 User Data（fixtures），验证 save/switch/delete
- 不测：真实 IMA 进程杀启（提供 mock/spawn 注入点；本机可手工验证）
- 不引入真实账号密钥进仓库 fixtures

### 2.12 Dependencies

- Node.js >= 18
- 运行时依赖尽量少：优先 Node 内置 `http`/`fs`/`crypto`/`zlib`
- 可用：`yargs`（CLI）；zip 使用 Node 内置能力或最小自实现（store/deflate）
- 不引入前端框架与打包器

## [S3] Out of Scope

- macOS / Linux 完整实现（可留 path adapter 接口）
- 自动解密/重加密 Chromium Cookies 以保证跨机免登录
- 修改 IMA 客户端二进制或注入扩展
- 云端同步账号库
- 多开 IMA 实例（仅单实例切换）
- 自动抓取验证码/破解登录

## Tasks

- [ ] T1: 脚手架与 package.json/bin — acceptance: `node src/cli.js --help` 可用，包名与 bin 正确 (covers: S2.1)
- [ ] T2: IMA 路径发现 + 进程检测/停止/启动模块 — acceptance: 对真实机器能解析路径并报告 running 状态；单测覆盖发现逻辑 (covers: S2.2, S2.5)
- [ ] T3: 身份解析与受管路径列表 — acceptance: 从 Preferences 解析 nickname/userId；路径列表可序列化 (covers: S2.2, S2.3)
- [ ] T4: Vault save/resave/switch/delete + trash 回滚 — acceptance: fixture User Data 上 save→switch→restore 全流程通过 (covers: S2.3, S2.4)
- [ ] T5: export/import（含 AES 加密包）— acceptance: 明文 zip 与加密包往返一致，错误密码被拒 (covers: S2.9)
- [ ] T6: CLI 命令接线 — acceptance: list/save/switch/export/import/delete/status 参数与退出码符合规格 (covers: S2.6)
- [ ] T7: WebUI + HTTP API — acceptance: 浏览器可完成保存/切换/导入导出；API 错误格式统一 (covers: S2.7, S2.8)
- [ ] T8: 文档 README 与手工验证记录 — acceptance: 安装启动步骤可跟做；本机手工验证记录写入 Report (covers: S2.1)
