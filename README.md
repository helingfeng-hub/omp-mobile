# omp mobile

[![release](https://img.shields.io/github/v/release/helingfeng-hub/omp-mobile?sort=semver)](https://github.com/helingfeng-hub/omp-mobile/releases)
[![license](https://img.shields.io/github/license/helingfeng-hub/omp-mobile)](LICENSE)
[![platform](https://img.shields.io/badge/computer-Linux%20%C2%B7%20WSL2-4b5563)](#你需要什么)

**把电脑里的 [omp](https://github.com/can1357/oh-my-pi) 搬到手机上。**

omp mobile 是 omp 的远程控制面板：电脑上跑一个 bridge，手机经 Tailscale 私有网络连进来，启动 omp 会话、看流式回复和工具调用、发提示词、打断、回答问题，必要时开一个 shell。不开放公网端口；聊天内容走 omp Collab 的端到端加密房间。

适合已经在电脑上用 omp 写代码、但人经常不在工位的人：地铁上补一句需求、夜里盯长任务、出门前审一眼 diff。

> 第一次听说 omp？omp 是终端里的 AI 编码 agent——读仓库、改文件、跑命令、开子代理、跑测试，自带 LSP/DAP 和计划模式。一条命令安装：
>
> ```bash
> curl -fsSL https://omp.sh/install | sh
> ```
>
> omp mobile 不替代它，也不自带模型。模型、凭据、代码始终留在你的电脑上；手机只是一块远程屏幕。

## 能做什么

| 功能 | 说明 |
| --- | --- |
| 启动会话 | 在允许的目录里新建 omp 会话；bridge 用 tmux 托管，手机断网/锁屏不会中断任务 |
| 实时对话 | 流式文本、thinking、工具卡片、子代理进度、模型与上下文状态 |
| 远程控制 | 发提示词、打断、回答 omp 的确认/选择弹窗 |
| 会话管理 | 会话列表、最近 tmux 输出、一键停止 |
| Shell | 独立 PTY（xterm.js），可开登录 shell，也可 attach 到某个 omp 会话的 tmux；带 Esc/Tab/Ctrl+C/方向键 |
| 两种壳 | Android APK 或 PWA（添加到主屏幕），同一套深色移动端 UI |
| 只读分享 | 生成 view-only 链接给朋友围观进度，不给执行权限 |

## 它不是什么

- **不是云服务**：没有服务器托管你的会话、代码或凭据；bridge 跑在你自己电脑上。
- **不是公网入口**：bridge 默认只监听 `127.0.0.1`，靠 Tailscale Serve 暴露给同一个 tailnet。不要用 Funnel，也不要做端口映射。
- **不是多租户平台**：一个 bridge 一个 token，适合个人或“每人各自部署一套”。不要拿它给互不信任的人共用。

## 你需要什么

| 项 | 要求 |
| --- | --- |
| 电脑 | Linux（已验证）或 Windows + WSL2；macOS 理论可用但未验证 |
| 常开 | 电脑休眠时手机连不上，Tailscale 也无法远程唤醒 |
| Node.js | 20 或更高（`node -v`） |
| omp | 已安装并完成模型登录（`omp --version`） |
| tmux | 用于托管会话，`tmux -V` |
| 模型账号 | 你自己的 provider API key 或 OAuth；费用由各自账号承担 |
| 网络 | 电脑和手机加入同一个 Tailscale tailnet，开启 HTTPS 证书 |
| 手机 | Android 8+；或支持 PWA 的浏览器（iOS 未验证） |

## 15 分钟上手

以 Linux 为例，Windows/WSL2 见[常见问题](#windows--wsl2)。

### 1. 电脑：安装并登录 omp

```bash
curl -fsSL https://omp.sh/install | sh
omp --version
omp login          # 选择 provider；也可以直接运行 omp 走首次引导
```

验证：终端里 `omp` 能正常对话。

**先完成这一步。** 否则手机上启动的会话会停在 omp 的登录/选模型界面。

### 2. 电脑：启动 bridge

```bash
mkdir -p ~/projects
git clone https://github.com/helingfeng-hub/omp-mobile.git
cd omp-mobile
npm install
OMP_REMOTE_ROOTS="$HOME/projects" npm start
```

- 首次启动会生成并打印一次 API token，之后从 `~/.config/omp-remote/token` 读取（权限 `0600`）。
- `OMP_REMOTE_ROOTS` 是手机能启动会话的目录白名单，别设成 `/` 或整个 `$HOME`。
- 验证：电脑浏览器打开 `http://127.0.0.1:8787`，输入 token，能看到控制台和 HOST 信息。

### 3. 电脑：发布到 tailnet

电脑和手机安装 [Tailscale](https://tailscale.com/download) 并登录同一账号；在 tailnet 管理页开启 MagicDNS 和 HTTPS 证书。

```bash
tailscale serve --bg 8787
tailscale serve status
```

手机访问 `https://<host>.<tailnet>.ts.net/`。

验证：手机浏览器能打开控制台登录页。

> 不要用 `tailscale funnel`。不要把 8787 映射到公网。ACL 只放行需要的设备。

### 4. 手机：安装壳

两种任选：

- **APK**：从 [Releases](https://github.com/helingfeng-hub/omp-mobile/releases) 下载 `omp-mobile-0.1.1.apk`，允许“未知来源”后安装。
- **PWA**：Chrome 打开 bridge 地址 → 菜单 → 添加到主屏幕。

首次打开填 bridge 地址（例如 `https://host.tailnet.ts.net/`）；进入后在右上角 ⚙ 填 API token。APK 里**长按页面**可重新设置地址。

### 5. 启动第一个会话

工作目录填 roots 内的路径（例如 `/home/you/projects/demo`）→ **启动会话** → **打开**。

bridge 会最多等 30 秒，直到 omp 发布 Collab host；超时会返回 tmux 输出帮助定位。

验证：手机发一句“这个仓库是做什么的？”，同时在电脑上 `tmux attach -t omp-xxxx`，能看到同一个会话。

## 和朋友一起用

推荐**各自部署一套**：每人自己的电脑、自己的 omp 账号和模型费用、自己的 tailnet。代码相同，互不影响。

想互相看进度时，在自己电脑上执行：

```bash
omp collab list                          # 找 instanceId / pid
omp collab link <instanceId|pid> --view  # 只读链接
omp collab link <instanceId|pid>         # control 链接（等于执行权限）
```

也可以从 bridge 取：`GET /api/sessions/<name>/link?access=view`（需要 token）。

分享 **view** 链接就够了。**不要把带 token 的个人 APK 发给别人**——它内嵌了你的 bridge 地址和 API token。

## 架构

```mermaid
flowchart LR
  P["手机 APK / PWA"] -->|"HTTPS + Bearer"| B["bridge 127.0.0.1:8787"]
  P -->|"WSS 端到端加密"| R["my.omp.sh relay"] --> O["omp"]
  P -.->|"WSS + 一次性 ticket"| B -->|"PTY"| T["tmux / shell"]
  B -->|"tmux new-session"| O
  O --> F["你的项目 / 命令 / 子代理"]
```

启动链路：

1. 手机 `POST /api/sessions {cwd}`。
2. bridge 在 tmux 里运行 `omp --config <overlay> --cwd <cwd>`；overlay 设置 `collab.autoStart: control`。
3. bridge 轮询 `omp collab list --json`，找到对应 host。
4. bridge 调 `omp collab link <instanceId> --json`，拿到 control/view URL。
5. 手机在 WebView/iframe 中打开该链接，后续提示词和打断都走 Collab 的 E2E 房间。
6. `/new`、`/resume` 会轮换 generation；链接过期时 bridge 自动重新获取。

## 安全（务必读）

- **bridge 只监听 loopback**，外层用 Tailscale Serve；不要把 8787 暴露到公网。
- **API token 是第二道门**。它保存在手机 localStorage；共用设备或录屏时注意。
- **Collab control 链接等于电脑的远程执行权限。** 只围观就用 view 链接；手机 UI 默认取 control。
- **远程使用时收紧 omp 审批**：

  ```bash
  omp config set tools.approvalMode write   # always-ask | always-ask-cached | write | yolo
  omp config get bash.patterns              # 可追加 deny 规则
  ```

  不要长期 `yolo`。
- **个人 APK 内嵌 token**，只在自己设备上安装。构建脚本的默认签名口令是公开的；自己发布 APK 前用 `OMP_ANDROID_KEYSTORE_PASS` 换掉，并备份 `~/.config/omp-mobile/android.keystore`（升级必须用同一把 key）。
- **`update.json` 无鉴权**（仅 tailnet 可达），不要往里放敏感信息。

## 常见问题

### 手机打不开 bridge 地址

1. `tailscale status` 看两端是否在线、是否同一 tailnet。
2. `tailscale serve status` 确认代理到 `127.0.0.1:8787`。
3. 确认 tailnet 已开启 HTTPS 证书；证书未就绪时 `*.ts.net` 会握手失败。
4. 在电脑上 `curl -I http://127.0.0.1:8787/healthz`，排除 bridge 自身问题。

### 返回 401

手机里的 token 和电脑不一致：

```bash
cat ~/.config/omp-remote/token
```

在 App 的 ⚙ 里重新粘贴；或网页端“清除 token”后重连。

### 启动会话失败 / 504

- 控制台 HOST 卡片里的 `adapter`、`omp`、`tmux` 应该是正常状态。
- 工作目录必须在 `OMP_REMOTE_ROOTS` 内且真实存在。
- 报错里会附 tmux 最近输出；常见原因是 omp 未登录模型，或 `omp collab` 连不上 relay。
- 首次启动慢可以调大 `OMP_REMOTE_START_TIMEOUT_MS`。

### 聊天区域空白

聊天面板是 `my.omp.sh` 的 iframe。点右上角 ↗ 在浏览器打开；或在手机上确认能访问 `https://my.omp.sh`。企业网络/广告拦截器可能拦掉 WebSocket。

### 锁屏后不动了

手机挂起会断开 WebSocket，但电脑上的 tmux 会话和任务继续跑。重新打开页面即可补齐历史；当前没有推送通知。

### 电脑休眠 / 关机

无法远程冷启动，Tailscale 不能唤醒。需要常开、Wake-on-LAN 或智能插座。

### Windows / WSL2

omp 和 tmux 跑在 WSL2，bridge 跑在 Windows 原生 Node，通过 `wsl.exe` 操作；Tailscale 也装在 Windows 上，避免 WSL 网络转发。

```bat
set OMP_REMOTE_ADAPTER=wsl
set OMP_REMOTE_WSL_DISTRO=Ubuntu
set OMP_REMOTE_ROOTS=/home/youruser/projects
node src\index.js
```

用“登录时”的 Task Scheduler 任务运行，**不要**用 SYSTEM 账户（拿不到 WSL 用户和 omp 凭据）。`node-pty` 需要可用的 ConPTY；装不上时 bridge 仍可聊天，只是没有 Shell 标签。

### 想换端口 / 管多台电脑

改 `OMP_REMOTE_PORT` 并同步改 `tailscale serve` 的目标端口。APK 只记一个地址，长按页面可切换；多台电脑建议分别用 PWA 图标。

## 进阶

### 配置

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

### 常驻运行（systemd user）

```bash
mkdir -p ~/.config/systemd/user
cp deploy/omp-mobile.service.example ~/.config/systemd/user/omp-mobile.service
# 按需修改路径/用户/环境变量；ExecStart 的 node 换成 `which node` 的输出
systemctl --user daemon-reload
systemctl --user enable --now omp-mobile
loginctl enable-linger "$USER"      # 注销后继续运行
```

### API

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

`/healthz` 不需要 token，只返回 `{"ok":true}`，方便监控探活。

### 自己构建 APK

需要 Android SDK：build-tools（`aapt2`、`d8`、`zipalign`、`apksigner`）、platform `android.jar`、JDK 的 `javac`/`keytool`。

通用包（首次启动手填地址和 token）：

```bash
ANDROID_HOME=/path/to/android-sdk \
VERSION="0.1.1" VERSION_NAME="0.1.1" VERSION_CODE=3 \
./scripts/build-android.sh
```

个人包（内嵌地址和 token，**不要提交或分享**）：

```bash
OMP_MOBILE_URL="https://host.tailnet.ts.net/" \
OMP_MOBILE_TOKEN="$(cat ~/.config/omp-remote/token)" \
VERSION="0.1.2-personal" VERSION_NAME="0.1.2" VERSION_CODE=4 \
OMP_MOBILE_UPDATE_NOTES="修复..." \
./scripts/build-android.sh
```

只有设置 `OMP_MOBILE_URL` 时才会生成 `public/update.json` 和 `public/omp-mobile-latest.apk`，供自建 bridge 的**应用内更新**使用。公开 Release 的 APK 不依赖它们，更新方式见 Release 页。

签名 key 默认在 `~/.config/omp-mobile/android.keystore`。升级必须用同一把 key，否则要先卸载旧版。

### 开发与测试

```bash
npm test        # 单元 + API 测试（不需要真实 omp）
npm run smoke   # 真实 omp + tmux + 本地 relay；创建并清理临时 profile/session
```

`npm run smoke` 需要本机有 `omp`、`tmux`，会启动隔离的 `OMP_PROFILE=omp-mobile-smoke`，覆盖 start/list/link/stop 和 PTY。

### 目录

```text
src/            bridge（Node ESM）
public/         PWA 控制台 + xterm 资源
android/        Android WebView 壳
scripts/        本地 relay、smoke、Android 构建
test/           node:test
deploy/         systemd 示例
```

## 已知边界

- 电脑休眠/关机时无法远程冷启动。
- Collab guest 不能执行 host-only 命令（`/model`、`/compact`、`/resume`、`!`、`$` 等）；需要时用 Shell 标签。
- `/new`、`/resume` 后 room generation 会轮换；在 UI 里重新点“聊天”即可让 bridge 取新链接。
- 没有内置推送；锁屏后 WebSocket 可能断开，重开页面恢复。
- APK 只保存一个 bridge 地址；多主机用 PWA 分别添加。
- macOS 未验证；iOS/PWA 未验证。

## License

[MIT](LICENSE) © 2026 helingfeng

感谢 [omp](https://github.com/can1357/oh-my-pi) 及其 Collab 协议、[Tailscale](https://tailscale.com)、[xterm.js](https://xtermjs.org)、[node-pty](https://github.com/microsoft/node-pty) 和 [ws](https://github.com/websockets/ws)。
