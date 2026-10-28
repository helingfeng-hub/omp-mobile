# AGENTS.md

omp mobile：把电脑里的 omp 搬到手机上。bridge 在本机运行，手机经 Tailscale 私有网络接入，可启动 omp 会话、查看流式回复与工具调用、发提示词、打断、回答确认弹窗，需要时开一个 shell。会话由 tmux 托管，聊天走 omp Collab 的端到端加密房间。仓库包含 bridge（Node ESM）、PWA 控制台、Android WebView 壳三部分。

## 架构与数据流

- `src/index.js` 是入口。`src/config.js` 的 `loadConfig` 读取环境变量并准备 token 与 roots 白名单，然后由 `src/server.js` 的 `createServer` 装配 HTTP 服务、WebSocket 与会话管理器。会话启动时由 `src/sessions.js` 的 `buildOverlay` 生成 overlay 配置并写入 stateDir 下的 overlays 目录。
- `src/server.js` 提供 `/api/*`（Bearer 鉴权）、`/healthz`、`/ws/terminal`，并从 `public/` 提供 PWA 静态资源。所有响应都带安全头，CSP 默认只允许同源资源，frame-src 放行 HTTPS 与 localhost 页面供 Collab iframe 使用。
- `src/auth.js` 用常量时间比较校验 token。token 首次启动生成并写入 `~/.config/omp-remote/token`（权限 0600），可用 `OMP_REMOTE_TOKEN` 覆盖。
- `src/host.js` 定义适配器。Linux 适配器直接执行 `tmux` 与 `omp`，WSL 适配器把命令转进 WSL 发行版。适配器负责把工作目录限制在 `OMP_REMOTE_ROOTS` 内、启动与停止 tmux 会话、抓取最近输出。终端启用时 `createAdapter` 才动态导入 node-pty，导入失败只让终端功能降级，不影响聊天。
- `src/sessions.js` 管理会话生命周期。启动会话后轮询 `omp collab list --json` 等待 Collab host 出现，再取 control 或 view 链接。
- `src/collab.js` 解析 collab 输出、挑选 host、校验链接协议，只接受 HTTPS 或 localhost 的 HTTP。
- `src/terminal.js` 发放一次性 ticket 并挂接 PTY，输入输出走 WebSocket。
- `public/app.js` 是控制台前端，包含会话列表与聊天 iframe。`android/` 只提供 WebView 壳与 APK 自更新检查，页面与 PWA 共用同一套静态资源。
- 系统服务样例在 `deploy/omp-mobile.service.example`，本地 relay、冒烟脚本与 APK 构建脚本在 `scripts/`。

## 目录

| 路径 | 用途 |
|---|---|
| `src/` | bridge 服务端（Node ESM） |
| `public/` | PWA 控制台 |
| `android/` | WebView 壳与 APK 更新检查 |
| `scripts/` | 本地 relay、冒烟脚本、APK 构建 |
| `test/` | `node:test` 单元与 API 测试 |
| `deploy/` | systemd user 服务样例 |

## 开发命令

```bash
npm install
OMP_REMOTE_ROOTS="$HOME/projects" npm start   # 前台启动 bridge
npm test                                      # 单元与 API 测试，不需要真实 omp
npm run smoke                                 # 需要本机 omp 与 tmux，会创建并清理临时会话
```

构建 APK 需要 Android SDK 的 build-tools 与 platform，以及 JDK，版本参数与命令见 README 的“自己构建 APK”一节。完整环境变量、API 与部署说明同样以 README 为准。

## 项目约定

- 服务端与前端脚本都是 ESM。服务端只用 `node:` 内置模块与现有依赖，不引入构建步骤。`public/` 静态资源由 bridge 直接提供，不使用打包器。
- 错误统一抛 `src/util.js` 的 `AppError`，带状态码与机器可读的 code，接口层转成 JSON 响应。
- 配置集中在 `src/config.js` 的 `loadConfig`，环境变量优先，`stateDir/config.json` 兜底，再取默认值。新增配置项要同步更新 README 的配置表。
- 路径先过 `isWithinRoots`，不能假设 `OMP_REMOTE_ROOTS` 之外安全。拼接 shell 命令一律用 `shellQuote`。
- 外部命令经适配器统一执行，Linux 适配器走 `execFile`，WSL 适配器走 `runWsl`。测试注入 fake adapter，不在测试里起真实 omp、tmux 或 WSL。
- node-pty 保持可选依赖语义，导入失败只降级终端。
- 不提交 `public/update.json`、`public/omp-mobile-latest.apk`、个人 APK 与 keystore，规则见 `.gitignore`。个人 APK 内嵌 bridge 地址与 token，不能分享。

## 重要文件

- `src/server.js`：路由、静态资源、安全头、WebSocket。
- `src/host.js`：Linux 与 WSL 适配器，外部命令执行与 PTY。
- `src/sessions.js`、`src/collab.js`：会话启动与 Collab 链接。
- `src/terminal.js`：终端 ticket 与 PTY 挂接。
- `test/api.test.js`：鉴权、路径穿越、CSP 与会话超时。
- `README.md`：用户文档、API 表、环境变量与 APK 构建说明。

## 测试与 CI

- `npm test` 用 `node:test`。`test/api.test.js` 用 fake adapter 覆盖鉴权、路径穿越、CSP 与会话启动超时。`test/util.test.js` 覆盖命令转义、roots 校验、tmux 输出解析与 Collab 链接校验。`test/wsl.test.js` 覆盖 WSL 适配器的参数拼装。
- 测试按 POSIX 路径编写。Windows 本机跑 `npm test` 时 `normalizeRoots` 的用例会因盘符前缀失败，`shellQuote` 用例要求 PATH 中有 `bash`，Linux 与 CI 上通过，跨平台结论以 CI 为准。
- `.github/workflows/ci.yml` 在推送 `main` 与 PR 时跑 `npm ci` 与 `npm test`，环境为 Node 22 与 ubuntu-24.04。本机没有 omp 与 tmux 时不要用 `npm run smoke` 代替 `npm test`。

## 写作要求

所有供人阅读的文本（注释、CONTEXT.md、ADR、issue 评论、PR 描述、agent brief、分诊记录、文档、Agent 回复）应当：

- 准确、清楚、简洁。先理解材料，再提炼结论。
- 按逻辑组织，区分相近概念。不用空泛、夸大的修饰语。
- 面向实际读者，从已知事实推到陌生结论。用分析说服，不装腔作势，不堆砌辞藻。
- 语言统一中文，不中英混用。命令、代码、路径、专有名词保留原文。
- 概念不直译。没有通行译名的概念用功能描述，不生造译名。同一概念全文只用一个词：用“标准”不用“规范”，用“任务要求”不用“规格”，测试结果用“通过、失败”不用“红、绿”。
- 标点符号：中文语境用全角中文标点（句号“。”、逗号“，”、顿号“、”）。纯英文句子用英文标点。行内代码、文件名、命令后的标点根据所在句子语境选择。引号：中文用弯引号“”，英文用直引号""。列举用顿号（“、”）分隔，最后一项前不加“和”或“与”。
- 不用破折号（“——”、“—”）、分号、箭头（“→”）、markdown 加粗和表情符号。补充说明用括号，并列与分支写成独立句子，顺序与对应关系用文字表达。
- 单位用国标：带单位的数值用 GB 3100～3102 的法定计量单位。写单位符号时，数值与符号之间留一个空格（`200 ms`、`5 min`、`64 MB`），不写 `200MS`、`64MB` 这类变体。中文行文里用汉字单位名称（30 秒、5 分钟）同样合规。

## 编码准则

- 先理解再改动：完整阅读目标文件、相似实现和相关测试。不确定 API 或惯例时查源码或文档，不猜。
- 明确目标与决策：需求或验收条件不明确时先澄清。架构选择、假设和关键取舍要说明。
- 保持简单：只实现当前需求。复用已有模式。不为单一用例过早抽象、配置化或引入依赖。
- 精准修改：只改与任务直接相关的代码，贴合既有风格。删掉本次修改产生的废弃代码，不重新格式化无关内容。
- 注释不留历史：删掉只对读过旧版本的人有意义的注释（“原来是 X”“改成 Y 是为了修 Z”）。注释解释当前代码为什么这样写，变更过程由 git 记录。
- 完整迁移：变更接口或行为时更新所有调用方、测试和文档。不保留无需求的兼容层。
- 按根因修复：先复现并读完整错误信息。一次处理一个原因，不靠吞异常或特判掩盖问题。
- 验证行为：按影响范围运行相关检查。测试可观察行为、边界和错误路径，不测试实现细节。无法测试时说明原因并做可行的烟雾验证。
- 审慎依赖：优先现有依赖和标准库。新增依赖前确认必要性、维护状态和成本，并说明理由。
- 清楚沟通：说明做了什么、为什么、验证结果和已知风险。对不确定性给出具体事实，提交信息描述实际改动。

## Agent 协议

- `docs/agents/issue-tracker.md`：issue 与 PR 的读取、创建、评论、标签流程，以及 PR 是否作为分诊渠道。`/code-review`、`/triage`、`/to-spec` 读取，`/github-project`、`/open-pr`、`/merge-pr` 读取其中的 GitHub Project 配置。
- `docs/agents/triage-labels.md`：分诊角色到本仓库标签的映射。`/triage` 与 `/to-spec` 读取。
- `docs/agents/domain.md`：领域文档的位置与用法。`/domain-modeling`、`/grill-with-docs` 写 `CONTEXT.md` 与 ADR，`/codebase-design`、`/diagnosing-bugs` 探索前读取它们。
