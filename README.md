# dsh-restart

一键重启正在运行的 DSH 进程，并且**把这次重启留下可核验的证据**——不是发个信号就完事。

## 为什么需要它

DSH 对 profile 配置保持热监听：**新增或移除一个 bundle 会当场挂载，工具立刻可用，不需要重启**。但 `hmr` 默认以 `root: []` 启用——**只监听配置，不监听源码模块**——所以**改动一个已经挂载的插件源码不会生效**，必须重启。而重启 DSH 意味着当前浏览器连接断开，如果重启失败，服务就再也起不来了。这个插件把这件事做成一次工具调用，并保证两件事：

1. **优雅退出**：走 DSH 自己的 ctx.appExit，先 dispose 整棵插件树（会话落盘、HTTP 服务关闭），再让进程自然结束——不是 kill。（两条例外：桌面版走 macOS 应用退出入口；万一 launcher 没提供 appExit，才退化成给自己发 SIGTERM。）
2. **退出前先确认"有人会把它拉起来"**：确认 launchd 有 KeepAlive 才直接退出；没有可确认的托管就派一个 detached supervisor 并等它完成握手，握手失败就**取消退出**，服务保持运行。

## 四种策略

插件先探测自己是被谁托管的，再决定怎么做：

| 策略 | 触发条件 | 行为 |
|---|---|---|
| desktop | 识别为 macOS 桌面版（有主进程与 IPC 连接） | 通过 macOS 应用退出/重新打开走一遍，等新的 shell 与 Host 重新连上 |
| launchd | **本进程自己**是某个 launchctl job 的主进程，且该 job 有 KeepAlive | 调 ctx.appExit(0) 优雅退出，launchd 立即拉起 |
| supervisor | 没有可确认的 KeepAlive 托管（手动启动、或任务主进程只是本进程的父进程） | 派 detached supervisor：等旧 pid 退出 → 确认端口释放 → 用同一 execPath/execArgv/argv/cwd/env 拉起 → 健康检查 + 身份确认 → 结果写日志 |
| none | 没有托管且 superviseFallback=false | 拒绝重启，服务保持运行 |

supervisor 的握手是关键：它在被杀之前会先往重启日志写一条 supervisor 记录，插件等这条记录出现才允许自己退出；8 秒内没等到就写 aborted 并取消退出。握手只能证明"supervisor 已经起来了"，**不能**证明"新进程一定能起来"——后者发生在旧进程退出之后，只能由 supervisor 记录下来，日志里会如实区分。

desktop 这一行不是凑数：`lib/plan.js` 在探测到桌面事实时**最先**选它，Web 的 launchd/supervisor 判定根本不会走到。

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

控件走三条宿主路由（同源 fetch）：

| 路由 | 方法 | 作用 |
|---|---|---|
| /dsh-restart/status | GET | 托管方式、端口、是否已安排、重启历史 |
| /dsh-restart/arm | POST | 安排重启，body 为 {delaySeconds?, reason?} |
| /dsh-restart/cancel | POST | 取消已安排的重启 |

鉴权说明（这条别想当然）：注册路由本身**不带鉴权**，所以每条请求都会先交给宿主的 connection 服务判定。宿主没有这个服务时，插件不会直接放行，而是**强制只接受回环来源**（127.0.0.0/8、::1、::ffff:127.x），非回环一律 403；取不到来源地址也按非回环处理。也就是说这三条路由不会因为"反正是本机"而对外网开放——但反过来说，在只有回环的机器上它们确实等同于"本机进程都能调"。

这三条路由和三个工具**共用同一套实现**（index.js 里的 armRestart / cancelRestart / readStatus），不存在两套逻辑。路由只在有 webServer 服务的载体上注册（用 ctx.inject(['webServer'], ...) 可选注入），headless 等载体只有工具，不会卡在等 web 服务。

客户端半边是**手写的** lib/client.js，直接写成客户端模块加载器要求的 lazy-CJS 形状（window.__ModuleLoader__.load({id, factory})），因此这个包**不需要任何构建步骤**，也没有 tsdown 依赖。它只 require react 这一个基座模块，配色全部走 --dsw-* 主题 token。

## 重启日志

默认 `<home>/.dsh/logs/dsh-restart.log`，JSONL，一条一行（文件以 0600 创建，因为 `boot`/`armed` 会记录进程命令行）：

| kind | 含义 |
|---|---|
| boot | 插件就绪后写入，带 pid/ppid/模式/端口/profile/启动命令。宿主没提供就绪信号时**立即**写；写入失败被静默吞掉，所以"没有 boot"不等于"没启动" |
| armed | dsh_restart 安排了重启，带 armId、fireAt 与原因 |
| supervisor | detached supervisor 已启动并完成握手 |
| supervisor-ready | supervisor 的恢复资源预检通过了。**宿主等到这条才允许自己退出**：只有握手不够，预检失败时退出会被取消 |
| exiting | 进程即将优雅退出（写完后才调 appExit），带同一个 armId 与 pid |
| supervised | supervisor 拉起新进程后的结果（ok/新 pid/健康检查详情/端口是否确认释放/新进程身份是否确认） |
| spec-cleanup-failed | spec 文件删不掉（不影响重启，只记一笔） |
| cancelled / aborted | 取消或中止，带原因 |

**什么才算一次完成的重启**：`armed` 与 `exiting` 的 armId 相同、随后出现的 `boot` 来自**另一个 pid**、且该 armId 没有失败记录。只靠"armed 后面跟着 boot"是不够的——默认日志被所有 profile 共用，别人的 boot、或者热挂载同一个进程写下的 boot，都不该被算成你这次重启成功。崩溃不会被误报成重启成功。

supervisor 路径判 `ok` 也很严：**必须同时**观测到"旧端点先停止应答"（`portReleased`）**和**"新进程自己写下了 pid 相同的 boot 记录"（`bootMatched`）。少任何一个都报 `ok:false` 并写明原因——宁可误报失败，也不假报成功。代价是：如果某个宿主根本不写 boot 记录，它的 supervisor 兜底会持续报失败（而服务其实活着）。

`downtimeMs` 量的是**从写 `exiting` 到新进程写 `boot` 的间隔**，包含优雅退出（会话落盘等）耗时，**不等于** HTTP 不可用时长。

崩溃可能留下一行没写完的 JSON：读取时跳过它；下一次写入前会先补一个换行，避免把新记录粘到那行残骸上一起被丢掉。

## 配置

    - id: dsh-restart
      name: dsh-restart
      config:
        logPath: /绝对路径/.dsh/logs/dsh-restart.log
        childLogPath: /绝对路径/.dsh/logs/dsh-restart-child.log
        defaultDelaySeconds: 10
        maxDelaySeconds: 600
        superviseFallback: true
        trustParentJob: false
        healthUrl: ''
        healthTimeoutMs: 60000
        healthIntervalMs: 500
        exitTimeoutMs: 45000
        bootHistoryLimit: 5

> 路径必须是**绝对路径**：这两个值会被原样使用，**不展开 `~`，也不展开环境变量**。写 `~/.dsh/...` 会在当前工作目录下真的建一个名叫 `~` 的目录。不想手写路径就不要配这两项，用默认值——默认值由 `homedir()` 拼出来，是正确的。

| 字段 | 默认值 | 含义 |
|---|---|---|
| logPath | `<home>/.dsh/logs/dsh-restart.log` | 重启记录（JSONL） |
| childLogPath | `<home>/.dsh/logs/dsh-restart-child.log` | supervisor 拉起的新进程的 stdout/stderr |
| defaultDelaySeconds | 10 | 默认延迟秒数 |
| maxDelaySeconds | 600 | delaySeconds 上限 |
| superviseFallback | true | 无托管时是否派 supervisor 兜底 |
| trustParentJob | false | 见下方"launchd 与父进程" |
| healthUrl | 空 | 留空则用 --port 推导 `http://127.0.0.1:<端口>/` |
| healthTimeoutMs | 60000 | supervisor 等端口恢复的上限 |
| healthIntervalMs | 500 | 健康检查轮询间隔 |
| exitTimeoutMs | 45000 | supervisor 等旧进程退出的上限；超时不强制终止任何进程，直接如实报失败 |
| bootHistoryLimit | 5 | 状态里保留的最近重启次数 |

端口是从 DSH 自己的 cmdlineArgs 里读 --port 得来的，不靠猜；读不到才退回 lsof。两者都拿不到且 `healthUrl` 为空时，重启仍然会执行，但"服务是否恢复"无法被证明——结果会如实标注为未确认，不会假报成功。

### launchd 与父进程

判断"launchd 会不会把我拉回来"时，只认两种情况之一：本进程**就是**某个 KeepAlive 任务的主进程（`job.pid === pid`），或者该任务的主进程是**本进程的直接父进程**（`job.pid === ppid`）。

只有第一种能证明 launchd 会重启我。第二种依赖一个额外假设——父进程会随本进程一起退出——而这个假设无法在本地证明：如果父进程是个不随子进程退出的包装进程，本进程退出后就没有任何人拉起它。

所以第二种默认**不走** launchd，改用 supervisor 兜底（慢一点，但不会把自己关在门外）。只有你明确知道自己的父进程会随子进程退出时，才把 `trustParentJob` 打开；打开后 warning 仍会保留，因为那条链路上 KeepAlive 重启的毕竟是 job 主进程，比自持多两个不确定环节。

KeepAlive 的读法也按这个原则收紧：只在 `launchctl print` 输出的 `properties = { ... }` 块内找 `keepalive` 键，**不对整段输出做关键字匹配**——否则 job label、环境变量值或 endpoint 名里出现 "keepalive" 就会被误判成有人托管。读不到 properties 块时按"无法确认"处理，同样倒向 supervisor。

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

    node --test test/*.test.mjs    # 94 项：进程探测、launchd/KeepAlive 解析、计划决策、日志历史与配对、HTTP 路由与鉴权、客户端 bundle、恢复预检与 supervisor 启动、supervisor 真实拉起、桌面版退出路径
    node scripts/smoke.mjs <pid>   # 对任意 pid 只读打印探测结果与重启计划

lib/proc.js、lib/plan.js、lib/log.js、lib/http.js 不 import 任何 @deepseek-ai/*，也不碰 DSH 运行时，所以单测不需要启动 DSH；只有 index.js 依赖 dsh-tools 与 schemastery。supervisor.mjs 是独立进程，可以单独跑。

test/client.test.mjs 把 lib/client.js 放进一个假的 window.__ModuleLoader__ 里求值，用 React 桩渲染组件，因此改坏客户端半边（比如引用未声明的变量、写错座位名、请求非基座模块）会直接测试失败，不必开浏览器才发现。

改完代码后同步到 profile（pnpm 的 file: 目录依赖是硬链接，编辑器常见的"写临时文件再改名"会断开链接）：

    dsh plugin --profile web remove dsh-restart
    dsh plugin --profile web add file:"$PWD"

## 已知边界

- **Web 只管当前进程；macOS 桌面版重启整个应用与 Host**。桌面版必须确认主进程身份与 IPC 连接，退出经由系统应用退出入口，保留任务确认；取消或超时不强杀、不启动独立 Host。其他桌面平台或脱离主进程的 Host 拒绝重启。
- **超时不做强制终止**。旧进程超过 `exitTimeoutMs` 还没退出时，supervisor 只如实记录失败（`ok:false`）；它不会发 SIGTERM/SIGKILL，也不会替你"解决"卡住的进程。
- **supervisor 兜底路径的停机时间更长**：要等旧进程退出 + 端口释放 + 新进程起来，本机实测 2-5 秒；launchd 路径由 launchd 直接拉起，本机实测 1-2 秒。这两个数字是本机测量，不是跨机器的承诺——实际取决于你的 launchd 配置与机器负载。
- **不等待"当前回合结束"**。DSH 只暴露了 cmdlineArgs / appExit / appReady 三个启动期服务，没有回合级钩子，所以重启是在固定延迟后触发。延迟内如果模型还在输出，那条消息可能来不及落盘——默认 10 秒就是为这个留的余量，必要时用 delaySeconds 调大。
- **健康检查把 4xx 当作"已恢复"**：DSH web 在没有 token 时返回 401，这已经说明服务起来了。另外，健康检查只能证明"那个端口上有人应答"，所以判定成功还要加上新进程自己的 boot 记录作为身份确认。
- **env 不落盘，但 argv 会**。supervisor 拉起用的是当前进程的 env，env 不写进 spec 文件；但 spec 文件里有进程命令行（`boot`/`armed` 记录里也有），所以**命令行里带的凭据会落到磁盘上**。插件为此把日志与 spec 都写成 0600，并在 supervisor 读完后删除 spec；如果你把 token 直接写在命令行里，仍请注意这一点。
- **不校验新进程真的是"新版本"**。它只是用同样的命令再拉一次；如果新代码本身启动失败，launchd 会看到非零退出并反复重试（本机 ThrottleInterval 未设置，默认 10 秒）。supervisor 路径不会自动重试。
- **本 README 里关于 DSH 宿主行为的话，都是实测口径**。热监听只覆盖配置、运行中新增的客户端半边不会被补扫、启动期只有那三个服务——这些是在本机 0.2.0-rc.1 运行时上观察到的行为，不是对任意版本的保证；换版本请重新验证。
- **桌面版判定依赖 profile 名与工作目录**。桌面就绪判定要求 profile 名是 `desktop` 且 cwd 不变；`scripts/smoke.mjs` 不提供桌面事实，所以它只覆盖 Web 的重启计划。

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
| 又一次误判回归（2026-09-29） | KeepAlive 原先是拿 `/keepalive/i` 扫 `launchctl print` 全文，job label / 环境变量 / endpoint 名里出现这个词就会被误判为有人托管；已改为只在 `properties = {}` 块内读键，且"任务主进程只是父进程"不再默认走 launchd（改用 supervisor 兜底），回归测试覆盖 |
| 在活的 web 进程里调用工具（2026-09-18 当时口径） | dsh_restart dryRun 返回 strategy=launchd、label=<label>、port=<port>、restartable=true；dsh_restart_status 返回 uptimeSeconds=23092、portResponds=true。**注意**：该形态下 job 主进程是 DSH 的父进程（pnpm），按 2026-09-29 收紧后的规则，同一场景现在会返回 strategy=supervisor |
| 热挂载行为 | 安装进 web profile 后，正在运行的宿主进程当场挂载了本插件并写下 boot 记录，工具立刻可用，无需重启 |
| 浏览器控件（真实 Chromium 实测） | 右下角渲染出「↻ 重启」；点开后弹窗正确显示托管方式、pid 与运行时长、端口与响应、上次停机时长，延迟选项与原因输入均可用 |
| 从 GUI 触发的真实重启 | 点「确认重启」→ 弹窗变倒计时 → 日志出现 armed → supervisor 握手 → exiting → supervised ok:true → 新进程 boot（停机 2.0s）→ 端口重新响应（401） |
| 主题适配回归 | 深色主题下主按钮填充是近白色，文字必须用 --dsw-alias-label-primary-foreground；曾因硬编码 #fff 变成白底白字，已修并有渲染测试覆盖 |

### 2026-09-25 桌面版修复

旧 supervisor 直接重建 Host 会丢失 Electron IPC，即使 HTTP 端口恢复也不能证明桌面恢复。现在桌面策略通过 macOS 退出/打开应用，并等待新 shell 与 Host 的连接启动记录；Web 的 launchd/supervisor 策略保留。源码通过 desktop profile 的 link 依赖生效，首次加载修改需要正常退出并重新打开桌面应用。

本机验证：52 项测试通过；通过桌面右下角插件按钮实际重启两次，均恢复原会话界面。最终一次 shell/Host 从 55467/55504 更换为 58814/58846，日志记录 `desktopConnected: true`、`supervised.ok: true`，耗时 13.7 秒。尚未实测有运行中任务时的原生确认交互；单元测试覆盖取消/超时不重新启动。

### 2026-09-29 复审修复回合

第三方复审（Codex，只读模式）指出：KeepAlive 判定是拿正则扫 `launchctl print` 全文（label/环境变量里出现该词即误判）、鉴权 fail-open、两处 `spawn` 无异步错误处理、健康检查把"端口没释放"也报成功、重启历史不按 armId 配对（跨 profile 会拼出假重启）、arm 先起定时器后写记录、恢复资源在退出后才发现不可写、日志/spec 无权限保护且 spec 不删、崩溃残行会吞掉下一条记录、路由内请求流读取出错会逃逸、客户端把 `armed:false`/`cancelled:false` 显示成成功、`forceStop` 是死代码且写了假的 `forced:true`、README 有几处承诺强于实现。

以上全部修复，并补了对应回归测试（含"label/环境变量里含 keepalive 必须是 null"这类误判回归，以及对每处修复做变异回退、确认新测试真会失败）。

| 检查 | 结果 |
|---|---|
| 全套单测 | **94/94 通过**（`node --test test/*.test.mjs`，约 36s，含真实拉起 supervisor 的集成测试） |
| 实机只读探测 | `node scripts/smoke.mjs <pid>` 对活着的宿主返回 `keepAlive=null`（RunningBoard 提交的桌面 app job 没有 properties 块）并给出"无法确认 KeepAlive"warning，策略判为 supervisor，不误判为 launchd |
| 实机 HTTP 鉴权 | 真 socket：无 connection 服务时 `127.0.0.1` 的 status/arm 正常 200（本机 web profile 不受影响）；伪造非回环来源的 arm 得 403 且 handler 未执行 |
| 无 unhandled rejection | 客户端中途断流时进程挂 `unhandledRejection` 监听、退出码 0；handler resolve 出结构化 500 JSON |

> 这一轮改动的**跨文件协议**：supervisor 在预检通过后才写 `supervisor-ready`（带 armId），宿主必须等到"握手 + ready"两条才允许退出——否则预检刚失败、宿主仍会照常退出。两侧都有测试；宿主的等待逻辑在 `index.js` 的 `waitForSupervisor()`，supervisor 侧在 `lib/supervisor.mjs` 的 `preflightOutLog()`。
