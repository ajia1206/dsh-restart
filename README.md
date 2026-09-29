# dsh-restart

一键重启正在运行的 DSH 进程，并且**把这次重启留下可核验的证据**——不是发个信号就完事。

## 为什么需要它

DSH 对 profile 配置保持热监听：**新增或移除一个 bundle 会当场挂载，工具立刻可用，不需要重启**。但 `hmr` 默认以 `root: []` 启用——**只监听配置，不监听源码模块**——所以**改动一个已经挂载的插件源码不会生效**，必须重启。而重启 DSH 意味着当前浏览器连接断开，如果重启失败，服务就再也起不来了。这个插件把这件事做成一次工具调用，并保证两件事：

1. **优雅退出**：走 DSH 自己的 ctx.appExit，先 dispose 整棵插件树（会话落盘、HTTP 服务关闭），再让进程自然结束——不是 kill。
2. **退出前先确认"有人会把它拉起来"**：launchd 有 KeepAlive 就直接退出；没有托管就派一个 detached supervisor 并等它完成握手，握手失败就**取消退出**，服务保持运行。

## 三种策略

插件先探测自己是被谁托管的，再决定怎么做：

| 策略 | 触发条件 | 行为 |
|---|---|---|
| launchd | 本进程或**直接父进程**出现在 launchctl 的某个 job 里，且该 job 有 KeepAlive | 调 ctx.appExit(0) 优雅退出，launchd 立即拉起 |
| supervisor | 没有可确认的 KeepAlive 托管（手动 pnpm dsh 启动等） | 派 detached supervisor：等旧 pid 退出 → 等端口释放 → 用同一 execPath/execArgv/argv/cwd/env 拉起 → 健康检查 → 结果写日志 |
| none | 没有托管且 superviseFallback=false | 拒绝重启，服务保持运行 |

supervisor 的握手是关键：它在被杀之前会先往重启日志写一条 supervisor 记录，插件等这条记录出现才允许自己退出；8 秒内没等到就写 aborted 并取消退出。

## 三个工具

**dsh_restart** — 安排一次重启。

参数：delaySeconds（默认 10）、reason（写进日志）、dryRun（只看计划不安排）。

默认延迟 10 秒，是为了让工具结果和最终回复先送达浏览器；退出本身是优雅的，会话会被 dispose 流程落盘。调用后应当只回一句短话，不要再调其他工具。

**dsh_restart_status** — 看托管方式、当前是否已安排重启、以及重启历史。

这是**核验**手段：每次启动都会写一条 boot 记录（带 pid），和之前的 armed/exiting 记录配对后就能算出这次重启的停机时长。

**dsh_restart_cancel** — 在触发前取消。误触发时用。

## 浏览器控件

web 界面**右下角**有一个悬浮的「↻ 重启」按钮，点开是确认弹窗：显示当前托管方式、进程与端口、上一次重启的停机时长；可以选延迟（立即 / 10s / 30s / 60s）、填一句原因（写进重启日志），再点「确认重启」。确认后弹窗变成倒计时，并提示本页连接即将断开。

它落在 ui-layout 声明的 **shell.overlay** 座位上——那是整个框架的浮层，本身**点击穿透**，只有控件自己开启 pointer events，所以不会挡住下面的界面。

控件走三条宿主路由（同源 fetch，鉴权由 cookie 承载）：

| 路由 | 方法 | 作用 |
|---|---|---|
| /dsh-restart/status | GET | 托管方式、端口、是否已安排、重启历史 |
| /dsh-restart/arm | POST | 安排重启，body 为 {delaySeconds?, reason?} |
| /dsh-restart/cancel | POST | 取消已安排的重启 |

这三条路由和三个工具**共用同一套实现**（index.js 里的 armRestart / cancelRestart / readStatus），不存在两套逻辑。路由只在有 webServer 服务的载体上注册（用 ctx.inject(['webServer'], ...) 可选注入），headless 等载体只有工具，不会卡在等 web 服务。

客户端半边是**手写的** lib/client.js，直接写成客户端模块加载器要求的 lazy-CJS 形状（window.__ModuleLoader__.load({id, factory})），因此这个包**不需要任何构建步骤**，也没有 tsdown 依赖。它只 require react 这一个基座模块，配色全部走 --dsw-* 主题 token。

## 重启日志

默认 ~/.dsh/logs/dsh-restart.log，JSONL，一条一行：

| kind | 含义 |
|---|---|
| boot | 插件在启动就绪后写入，带 pid/ppid/模式/端口/启动命令 |
| armed | dsh_restart 安排了重启，带 fireAt 与原因 |
| supervisor | detached supervisor 已启动并完成握手 |
| exiting | 进程即将优雅退出（写完后才调 appExit） |
| supervised | supervisor 拉起新进程后的结果（ok/新 pid/健康检查详情） |
| cancelled / aborted | 取消或中止，带原因 |

只有 armed + exiting + boot 三者齐全，才算一次**完成的重启**；进程意外崩溃不会被误报成重启成功。日志里可能出现一行被写坏的 JSON（崩溃时），读取时会跳过它，不影响其余记录。

## 配置

    - id: dsh-restart
      name: dsh-restart
      config:
        logPath: ~/.dsh/logs/dsh-restart.log
        childLogPath: ~/.dsh/logs/dsh-restart-child.log
        defaultDelaySeconds: 10
        maxDelaySeconds: 600
        superviseFallback: true
        healthUrl: ''
        healthTimeoutMs: 60000
        healthIntervalMs: 500
        exitTimeoutMs: 45000
        bootHistoryLimit: 5

| 字段 | 默认值 | 含义 |
|---|---|---|
| logPath | ~/.dsh/logs/dsh-restart.log | 重启记录（JSONL） |
| childLogPath | ~/.dsh/logs/dsh-restart-child.log | supervisor 拉起的新进程的 stdout/stderr |
| defaultDelaySeconds | 10 | 默认延迟秒数 |
| maxDelaySeconds | 600 | delaySeconds 上限 |
| superviseFallback | true | 无托管时是否派 supervisor 兜底 |
| healthUrl | 空 | 留空则用 --port 推导 http://127.0.0.1:端口/ |
| healthTimeoutMs | 60000 | supervisor 等端口恢复的上限 |
| healthIntervalMs | 500 | 健康检查轮询间隔 |
| exitTimeoutMs | 45000 | supervisor 等旧进程退出的上限，超过升级 SIGTERM/SIGKILL |
| bootHistoryLimit | 5 | 状态里保留的最近重启次数 |

端口是从 DSH 自己的 cmdlineArgs 里读 --port 得来的，不靠猜；读不到才退回 lsof。

## 安装（第三方用户）

装进任意 profile，两个来源二选一：

    dsh plugin --profile web add github:ajia1206/dsh-restart     # 仓库公开后可用
    dsh plugin --profile web add @ajia1206/dsh-restart           # npm 包（发布后可用）

装完**服务端半边当场生效**（新增 bundle 立即挂载，三个工具马上可用）；**右下角的按钮要重启一次才出现**——客户端 bundle 是宿主在启动时快照进启动图的，运行中新增的客户端半边不会被补扫。用 dsh_restart 重启一次即可。

## 安装（本机开发）

**必须用 file: 前缀装成 profile 内的真实目录**（裸目录会被 pnpm 装成软链，裸包名解析不到共享层，插件会静默不激活）：

    cd /path/to/dsh-restart
    dsh plugin --profile web add file:"$PWD"
    dsh --profile web --dump-config | grep -A2 dsh-restart

之后**改这个插件自己的源码也需要重启**（源码模块不在热监听范围内）。想先只读确认，可以调 dsh_restart_status，它会报告托管方式、端口和重启历史。

如果插件本身装坏了、连工具都起不来，就得手动兜底：

    # launchd 托管时，换成你自己 job 的 label
    launchctl kickstart -k gui/$(id -u)/<你的 launchd label>

卸载：

    dsh plugin --profile web remove dsh-restart

dsh 不在 PATH 上时，用共享层入口（路径随安装位置变化）：

    node <共享层 node_modules>/@deepseek-ai/dsh/lib/bin.js

## 开发

    node --test test/*.test.mjs    # 52 项：进程探测、计划决策、日志历史、HTTP 路由、客户端 bundle、supervisor 真实拉起、桌面版退出路径
    node scripts/smoke.mjs <pid>   # 对任意 pid 只读打印探测结果与重启计划

lib/proc.js、lib/plan.js、lib/log.js、lib/http.js 不 import 任何 @deepseek-ai/*，也不碰 DSH 运行时，所以单测不需要启动 DSH；只有 index.js 依赖 dsh-tools 与 schemastery。supervisor.mjs 是独立进程，可以单独跑。

test/client.test.mjs 把 lib/client.js 放进一个假的 window.__ModuleLoader__ 里求值，用 React 桩渲染组件，因此改坏客户端半边（比如引用未声明的变量、写错座位名、请求非基座模块）会直接测试失败，不必开浏览器才发现。

改完代码后同步到 profile（pnpm 的 file: 目录依赖是硬链接，编辑器常见的"写临时文件再改名"会断开链接）：

    dsh plugin --profile web remove dsh-restart
    dsh plugin --profile web add file:"$PWD"

## 已知边界

- **Web 只管当前进程；macOS 桌面版重启整个应用与 Host**。桌面版必须确认主进程身份与 IPC 连接，退出经由系统应用退出入口，保留任务确认；取消或超时不强杀、不启动独立 Host。其他桌面平台或脱离主进程的 Host 拒绝重启。
- **supervisor 兜底路径的停机时间更长**：要等旧进程退出 + 端口释放 + 新进程起来，通常 2-5 秒；launchd 路径由 launchd 直接拉起，通常 1-2 秒。
- **不等待"当前回合结束"**。DSH 只暴露了 cmdlineArgs / appExit / appReady 三个启动期服务，没有回合级钩子，所以重启是在固定延迟后触发。延迟内如果模型还在输出，那条消息可能来不及落盘——默认 10 秒就是为这个留的余量，必要时用 delaySeconds 调大。
- **健康检查把 4xx 当作"已恢复"**：DSH web 在没有 token 时返回 401，这已经说明服务起来了。
- **supervisor 拉起用的是当前进程的 env**，env 不会写进 spec 文件（只有命令行和路径落盘），避免把凭据写到磁盘。
- **不校验新进程真的是"新版本"**。它只是用同样的命令再拉一次；如果新代码本身启动失败，launchd 会看到非零退出并反复重试（本机 ThrottleInterval 未设置，默认 10 秒）。

## 验证记录

本机实测（2026-09-18，北京时间）：

| 检查 | 结果 |
|---|---|
| 单测 node --test | 46/46 通过 |
| supervisor 真实拉起（集成测试） | 杀掉旧进程 → 等端口释放 → 拉起新进程 → 健康检查 ok，新 pid 存活并重新服务端口 |
| supervisor 失败路径 | 新进程起不来时记录 ok:false 与原因，不谎报成功 |
| 真实端到端重启（scratch web profile，临时端口） | 三个工具全部注册；日志依次出现 boot → armed → supervisor 握手 → exiting → supervised ok:true → 新进程 boot；停机 3317ms；原 pid 消失，新 pid 重新服务端口（401） |
| 重启保留启动上下文 | 重启后的命令行仍是 --profile <name> --patch ... --host 127.0.0.1 --port <port> --no-open |
| 对活 web 进程的只读探测 | pid <pid> → 父进程 <ppid> → job <label>，KeepAlive=true，端口 <port>，判定 launchd，无告警 |
| 误判回归（重要） | 从 DSH 会话里启动的进程（launchd job 只是远祖）曾被误判成 launchd——那会导致退出后再也起不来；已改为只认本进程或直接父进程，回归测试覆盖 |
| 在活的 web 进程里调用工具 | dsh_restart dryRun 返回 strategy=launchd、label=<label>、port=<port>、restartable=true；dsh_restart_status 返回 uptimeSeconds=23092、portResponds=true |
| 热挂载行为 | 安装进 web profile 后，正在运行的宿主进程当场挂载了本插件并写下 boot 记录，工具立刻可用，无需重启 |
| 浏览器控件（真实 Chromium 实测） | 右下角渲染出「↻ 重启」；点开后弹窗正确显示托管方式、pid 与运行时长、端口与响应、上次停机时长，延迟选项与原因输入均可用 |
| 从 GUI 触发的真实重启 | 点「确认重启」→ 弹窗变倒计时 → 日志出现 armed → supervisor 握手 → exiting → supervised ok:true → 新进程 boot（停机 2.0s）→ 端口重新响应（401） |
| 主题适配回归 | 深色主题下主按钮填充是近白色，文字必须用 --dsw-alias-label-primary-foreground；曾因硬编码 #fff 变成白底白字，已修并有渲染测试覆盖 |

### 2026-09-25 桌面版修复

旧 supervisor 直接重建 Host 会丢失 Electron IPC，即使 HTTP 端口恢复也不能证明桌面恢复。现在桌面策略通过 macOS 退出/打开应用，并等待新 shell 与 Host 的连接启动记录；Web 的 launchd/supervisor 策略保留。源码通过 desktop profile 的 link 依赖生效，首次加载修改需要正常退出并重新打开桌面应用。

本机验证：52 项测试通过；通过桌面右下角插件按钮实际重启两次，均恢复原会话界面。最终一次 shell/Host 从 55467/55504 更换为 58814/58846，日志记录 `desktopConnected: true`、`supervised.ok: true`，耗时 13.7 秒。尚未实测有运行中任务时的原生确认交互；单元测试覆盖取消/超时不重新启动。
