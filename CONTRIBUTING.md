# 贡献指南

感谢关注 omp mobile，报告问题、提出功能建议、改进文档与测试、提交代码都欢迎。

omp mobile 是 omp 的远程 Android 与 PWA 控制面板，bridge 跑在你自己电脑上，手机通过 Tailscale 私有网络连接。参与前请读完本指南，它说明开发环境、提交消息、Issue 与 PR 的写法。技术讨论就事论事，对事不对人。提交即表示你同意以 MIT 许可（与仓库一致）授权你的贡献。

## 开发环境

- Node.js 20 或更高，用 `node -v` 确认。npm 随 Node 一起安装。
- Linux（已验证），或 Windows + WSL2（omp 与 tmux 跑在 WSL2 里，bridge 在 Windows 原生 Node 上运行）。
- `npm run smoke` 需要本机有 `omp` 与 `tmux`。
- 构建 APK 需要 Android SDK（build-tools 与 platform）和 JDK。

## 开发流程

1. Fork 仓库并克隆到本地，在仓库根目录执行 `npm install`。
2. 修改代码并补充测试。
3. 提交前至少运行 `npm test`。
4. 改动涉及 omp 会话、Collab 链接或 PTY 时，再跑一次 `npm run smoke`。它需要真实的 omp、tmux 与本地 relay，不是每次提交的必需项。
5. 提交消息按下面的格式写，推送到自己的分支后开 PR。

## 提交消息格式

```text
type(scope): 中文简述
```

类型取 `feat`、`fix`、`docs`、`test`、`chore`、`ci`、`refactor`，scope 可选，用来注明影响范围。标题之外写正文时，正文用完整段落讲清楚做了什么和为什么，不用条目罗列。改动很小时可以只有标题。

## 提 Issue

提之前先搜索现有 Issue 与 PR，避免重复。按模板开单，Bug 用 Bug 模板，功能建议用 Feature 模板。标题以类型标签开头，后接一句中文行动或结果句，Bug 用 `[BUG]`，功能建议用 `[FEAT]`。AI 生成的 Issue 在标题最前面加 `[AI Generated]`，正文首行注明生成工具与执行者身份。

## 提 PR

1. 修复与功能类 PR 一般先开 Issue 并关联。写 `Fixes #NN` 表示合并即自动关闭对应 Issue，只关联不关闭写 `Related to #NN`。错别字、修法唯一的明显 bug 等小改动，以及纯文档小修，可以直接提 PR。
2. 从 `main` 建分支，分支名用 `fix/<简述>` 或 `feat/<简述>`。
3. 一个 PR 只做一件事，本地至少跑 `npm test`。
4. 开 PR 指向 `main`。标题以意图标签开头，可选 `[FEAT]`、`[FIX]`、`[DOCS]`、`[TEST]`、`[CLEANUP]`、`[DEP]`，AI 生成的标题在最前面加 `[AI Generated]`。正文按模板的五个部分写：Summary 一段话讲做了什么，Motivation 讲为什么值得做，Changes 逐个文件讲改动脉络，Why this is safe 讲不改动的不变量与退路，Test plan 逐项报告验证结果。段落顺序与 `docs/agents/issue-tracker.md` 的 PR 格式一致。
5. CI 通过、评审通过后由维护者合并。

## 正文写作约定

Issue、PR 与评论都是写给协作者读的，不是写给程序或作者自己读的。默认读者了解 omp 与移动端控制面板的领域，但不了解这条改动的来龙去脉，只读正文就应该明白发生了什么、为什么、自己接下来能做什么。

正文要回答一组固定的问题，而不是堆砌参数和决策名。PR 正文回答：这个改动解决什么问题，为什么值得做。为什么采用这个方案，否决过哪些替代做法。实际改了什么，按协作者阅读代码的顺序讲清楚来龙去脉。怎么验证的，跑了哪些命令和测试，结果是什么。协作者从哪里继续读，关键文件和后续工作在哪。Issue 正文回答：现状是什么，期望是什么，为什么重要，已经做过哪些排查或有过哪些想法。模板以提问的形式给出了这组问题，逐段回答即可，不必把问题本身抄进正文。

行文用平实的中文陈述句，一段话说完一个完整的意思，段落之间按逻辑承接。少用特殊符号，反引号只用于需要逐字精确的东西，比如命令、文件路径与代码片段，不用加粗或引号做叙述性强调。细节不收进折叠区，人写的文字全部放在正文可见区，折叠区只用于长日志等原始机器输出。AI 生成的 Issue、PR 与评论要按上文的标记规则标识。这些约定由评审把关，缺项的 PR 由作者在合并前补正。

## 测试

`test/` 下是 `node:test` 编写的单元测试与 API 测试，覆盖工具函数、HTTP 接口与 WSL 适配器，不需要真实的 omp 与 tmux，运行 `npm test` 即可。`npm run smoke` 使用真实的 omp、tmux 与本地 relay，覆盖会话启动、列表、链接、停止与 PTY，需要本机装好 omp 与 tmux。新增或改变行为时要补对应测试。Windows 上运行 `npm test` 需要 PATH 中有 `bash`，可以使用 Git Bash 提供的 `bash`。

## CI

`.github/workflows/ci.yml` 在向 `main` 推送和开 PR 时运行，在 Linux（ubuntu-24.04）上依次执行 `npm ci` 与 `npm test`，Node 版本为 22。`package.json` 的 `engines` 要求 Node 20 以上，CI 用 22 作为验证基线。workflow 不加 `paths-ignore`，这样每次 PR 都会跑同一套检查。合并前 CI 必须通过。
