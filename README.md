# omp mobile

从手机远程启动并操控电脑上的 [omp](https://github.com/can1357/oh-my-pi)。

- **Bridge**：跑在电脑上的小服务。用 tmux 启动 omp，取 omp Collab 的加密房间链接，管理会话和可选 Shell。
- **Chat**：omp Collab 的浏览器客户端。实时看流式回复、thinking、工具卡片、子代理，并直接输入提示词/打断。
- **Shell**：可选的 PTY 终端（xterm.js），用来跑任意命令或 attach 到 omp 所在的 tmux。
- **Android**：`dist/omp-mobile-0.1.0.apk`（WebView 壳），也可以直接把 bridge 页面装成 PWA。

> 安全边界：full-control Collab 链接等同于电脑的远程执行权限。bridge 默认只监听 `127.0.0.1`，必须通过 Tailscale 私有网访问，并启用 API token。

## 架构

```text
Android APK / PWA
  ├── Chat:  WebView/iframe ──WSS E2E──> my.omp.sh relay ──> 电脑上的 omp
  ├── API:   HTTPS + Bearer ──────────> bridge (127.0.0.1:8787)
  └── Shell: WSS + one-time ticket ──> bridge ──PTY──> tmux / bash
```

启动链路：

1. 手机 `POST /api/sessions {cwd}`。
2. bridge 在 tmux 里运行 `omp --config <overlay> --cwd <cwd>`；overlay 设置 `collab.autoStart: control`。
3. bridge 轮询 `omp collab list --json`，找到对应 host。
4. bridge 调 `omp collab link <instanceId> --json`，拿到 control/view URL。
5. 手机在 WebView/iframe 中打开该链接，后续提示词和打断都走 Collab 的 E2E 房间。
6. 会话 `/new`、`/resume` 会轮换 generation；链接过期时 bridge 自动重新获取。

本机已验证：Linux + tmux + 本地 relay 的完整 start/list/link/stop，PTY 终端，以及通过手机 UI 向真实 Collab 房间发送 `Reply with exactly OK` 并收到 `OK`。

## 快速开始（Linux）

要求：Node.js 20+、`omp`、`tmux`。

```bash
cd omp-mobile
npm install
OMP_REMOTE_ROOTS="$HOME/projects" OMP_REMOTE_PORT=8787 npm start
```

首次启动会在 `~/.config/omp-remote/token` 生成 token 并打印一次。浏览器打开 `http://127.0.0.1:8787`，输入 token。

### Tailscale

1. 手机、电脑加入同一个 tailnet，开启 MagicDNS 和 HTTPS 证书。
2. 让 bridge 继续只监听 `127.0.0.1`。
3. 用 Tailscale Serve 把 `127.0.0.1:8787` 发布为 tailnet HTTPS（示例；子命令以本机 `tailscale serve --help` 为准）：

```bash
tailscale serve --bg 8787
tailscale serve status
```

4. 手机访问 `https://<host>.<tailnet>.ts.net/`。
5. ACL 只允许手机 tag 访问该主机的 443；**不要**用 `tailscale funnel`，也不要把 8787 端口映射到公网。

### 作为用户服务运行

`deploy/omp-mobile.service.example` 是 systemd user unit 示例：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/omp-mobile.service.example ~/.config/systemd/user/omp-mobile.service
# 改成你的路径/用户后
systemctl --user daemon-reload
systemctl --user enable --now omp-mobile
loginctl enable-linger "$USER"
```

## Windows（WSL2）

omp 和 tmux 跑在 WSL2 里，bridge 跑在 Windows 原生 Node 上，通过 `wsl.exe` 操作；Tailscale 也跑在 Windows 上。这样不需要处理 WSL 的网络转发。

1. Windows 安装 WSL2 + Ubuntu，在发行版里安装 `omp`、`tmux`、`node`（可选）。
2. Windows 安装 Node.js 20+，`npm install`。
3. 设置环境变量（用户级即可）：

```bat
set OMP_REMOTE_ADAPTER=wsl
set OMP_REMOTE_WSL_DISTRO=Ubuntu
set OMP_REMOTE_ROOTS=/home/youruser/projects
set OMP_REMOTE_PORT=8787
node src\index.js
```

4. 用 Task Scheduler 创建“登录时”任务，运行当前用户的 `node.exe src\index.js`，起始目录为项目目录。**不要**用 SYSTEM 账户，否则拿不到 WSL 用户和 omp 凭据。
5. Tailscale Serve 指向 Windows 上的 `127.0.0.1:8787`。

说明：

- WSL 里的 omp 可以调用 `powershell.exe`/`cmd.exe` 执行 Windows 命令；但 omp 的 `computer` GUI 捕获只作用于 WSL/Linux 侧，控制 Windows 桌面 GUI 需要 Windows 原生 omp + ConPTY 或另一个 agent。
- `node-pty` 在 Windows 上需要可用的 ConPTY；安装失败时 bridge 仍可启动/聊天，只是没有 Shell 标签。

## Android APK / PWA

### APK

`dist/omp-mobile-0.1.0.apk` 已用本地 release key 签名。安装：

```bash
adb install -r dist/omp-mobile-0.1.0.apk
# 或把 APK 拷到手机，允许“未知来源”后安装
```

首次打开填入 bridge 的 Tailscale HTTPS 地址，例如 `https://host.tailnet.ts.net/`。进入后**长按页面**可重新设置地址；token 在页面右上角设置里输入。

签名 key 默认在 `~/.config/omp-mobile/android.keystore`。请备份；以后升级 APK 必须用同一把 key，否则需要先卸载旧版。

构建：

```bash
ANDROID_HOME=/path/to/android-sdk ./scripts/build-android.sh
```

需要 Android SDK：build-tools（`aapt2`、`d8`、`zipalign`、`apksigner`）、platform `android.jar`、JDK 的 `javac`/`keytool`。

### PWA

不装 APK 也可以：Chrome 打开 bridge 地址，菜单里“安装应用/添加到主屏幕”。`public/manifest.webmanifest` 和 `sw.js` 提供 standalone 壳和静态缓存。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OMP_REMOTE_HOST` | `127.0.0.1` | bridge 监听地址；保持 loopback |
| `OMP_REMOTE_PORT` | `8787` | 端口 |
| `OMP_REMOTE_TOKEN` | 自动生成 | API token；也可写入 `~/.config/omp-remote/token` |
| `OMP_REMOTE_STATE_DIR` | `~/.config/omp-remote` | token、overlay 配置 |
| `OMP_REMOTE_ROOTS` | `$HOME` | 允许启动的工作目录；逗号或分号分隔 |
| `OMP_REMOTE_ADAPTER` | 自动 | `linux` 或 `wsl` |
| `OMP_REMOTE_WSL_DISTRO` | 空 | WSL 发行版名，如 `Ubuntu` |
| `OMP_REMOTE_WSL` | `wsl.exe` | WSL 可执行文件 |
| `OMP_REMOTE_OMP` | `omp` | omp 路径/命令 |
| `OMP_REMOTE_TMUX` | `tmux` | tmux 路径 |
| `OMP_REMOTE_RELAY` | `wss://my.omp.sh` | Collab relay |
| `OMP_REMOTE_WEB` | 空 | Collab web UI；空则从 relay 推导 |
| `OMP_REMOTE_NAME` | 主机名 | 手机端显示名 |
| `OMP_REMOTE_TERMINAL` | `1` | `0` 关闭 Shell |
| `OMP_REMOTE_START_TIMEOUT_MS` | `30000` | 等待 Collab host 的超时 |
| `OMP_PROFILE` | 空 | 传给 omp 的 profile；用于隔离会话/凭据 |

## API

所有 `/api/*` 需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | bridge/omp/tmux 状态 |
| GET | `/api/state` | 会话、host、roots、health |
| POST | `/api/sessions` | `{cwd}`，启动 tmux + omp |
| DELETE | `/api/sessions/:name` | 停止会话 |
| GET | `/api/sessions/:name/link?access=control\|view` | 取 Collab 链接 |
| GET | `/api/sessions/:name/output?lines=100` | tmux 最近输出 |
| POST | `/api/terminal/ticket` | `{session?}` 或 `{cwd?}`，一次性终端 ticket |
| WS | `/ws/terminal?ticket=...` | PTY 输出（binary）和输入（JSON） |

`/healthz` 不需要 token，只返回 `{"ok":true}`，方便 Tailscale/监控探活。

## 安全

- **不要把 bridge 直接暴露公网。** 默认 loopback + Tailscale Serve；不要用 Funnel 或路由器端口映射。
- API token 是第二道门；手机端存在 localStorage，建议配合手机锁屏/生物识别。
- Collab **control link 等于远程执行权限**。只读监控用 `?access=view`；手机 UI 默认取 control。
- 建议 `tools.approvalMode: write` 或 `always-ask`，不要长期 `--auto-approve`；用 `bash.patterns` deny 高危命令。
- bridge 日志不记录 token 和 Collab URL；终端 ticket 30 秒过期且一次性。
- 生产页 `my.omp.sh` 有第三方 analytics（已设置 `data-exclude-hash`）；要求更严时自托管 MIT 的 `collab-web`，并与控制台使用**不同 origin**，避免同源 iframe 读取父页 token。

## 已知边界

- 电脑休眠时无法远程冷启动；Tailscale 不能唤醒。需要常开、Wake-on-LAN 或路由器唤醒。
- Collab guest 不能执行 host-only 命令（`/model`、`/compact`、`/resume`、`!`、`$` 等）；需要时用 Shell 标签。
- `/new`、`/resume` 后 room generation 会轮换；UI 里重新点“聊天”即可让 bridge 取新链接。
- 没有内置推送；手机锁屏后 WebSocket 可能断开，重新打开页面即可。需要后台通知时接 ntfy/FCM。
- 当前 UI 一次管理一个 bridge 地址；多主机可通过浏览器/PWA 切换 URL，APK 用长按改地址。
- APK 未在真机/模拟器上运行验证（构建环境无 Android 设备）；已验证 manifest、签名、资源打包，Web UI 在 Chromium 移动视口验证。

## 开发与测试

```bash
npm test        # 单元 + API 测试（不需要真实 omp）
npm run smoke   # 真实 omp + tmux + 本地 relay；会创建并清理临时 profile/session
```

`npm run smoke` 需要本机有 `omp`、`tmux`，会启动一个隔离的 `OMP_PROFILE=omp-mobile-smoke`，测试 start/list/link/stop 和 PTY。

## 目录

```text
src/            bridge（Node ESM）
public/         PWA 控制台 + xterm 资源
android/        Android WebView 壳
scripts/        本地 relay、smoke、Android 构建
test/           node:test
dist/           已签名 APK
deploy/         systemd 示例
```
