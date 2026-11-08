# Monitor 与 Worktree 原生 Windows 支持调整方案

状态：本地实现、Linux 完整回归及独立审查已完成。Windows CI 已配置但尚未运行，Windows 10/11 客户端仍待实机验收；本文不表示当前 npm 发布版本已经支持 Windows。

## 1. 方案结论

为 `pi-monitor` 和 `pi-worktree` 增加原生 Windows 支持，核心流程不依赖 WSL 或 Git Bash。共享业务逻辑使用 TypeScript、Node.js 和 Git；必须区分操作系统的部分收敛到包内的小型适配层，不复制整套 PowerShell 业务实现。

已确定的取舍：

- **Windows 监控进程采用 best-effort（尽力而为）回收。** 使用 Windows 进程树终止能力处理正常取消、超时等情况，不引入 Job Objects 或原生守护进程，不承诺异常退出后零残留。
- **工作树核心创建流程从 Bash 迁入 TypeScript。** 无钩子流程不需要 Bash；`setup.sh` 只保留 macOS/Linux 行为。Windows 发现该钩子时，在创建目录、分支或工作树前明确拒绝，不静默跳过。
- **保留现有 POSIX 行为与测试要求。** 不为了与 Windows 使用同一实现而弱化 macOS/Linux 的进程组回收能力。
- **用真实 Windows CI 验证支持范围。** Linux 上模拟 Windows 路径不能替代 Windows 上的进程、文件系统、会话切换和打包验证。

best-effort 描述的是回收保证，不是检查调度：检查仍按明确的时机执行；回收仍须处理已知错误，不能把“已请求停止”表述为“全部后代已退出”。

## 2. 目标与范围

目标客户端为原生 **Windows 10 和 Windows 11**，使用 Windows 版 Node.js、Pi，以及工作树扩展所需的 Git for Windows。Node.js、Pi 的版本下限沿用项目和各包的既有声明；具体 Windows 版本覆盖以实际验证结果为准，不凭 CI runner 名称扩大承诺。WSL 中运行 Linux 版 Node.js、Pi 和 Git，属于 Linux 使用路径，不作为原生 Windows 验收证据。

本轮不包含：

- Pi 退出后继续执行检查的常驻服务，或异常退出后的自动进程回收服务。
- Job Objects、原生进程托管组件，以及根据持久化 PID 在重启后补杀进程。
- 新增 `setup.mjs`、`setup.ps1` 或多种钩子的选择协议；这些可按后续独立需求设计。
- 调整其他扩展的 Windows 支持、改变现有自动执行权限、强制删除工作树，或执行发布。

## 3. 实施前的限制

| 部分 | 当前实现与影响 |
|---|---|
| Monitor 平台检查 | 基线 `runtime.ts` 和 `executor.ts` 明确拒绝 `win32`，不是仅缺少使用说明。 |
| Monitor 执行器 | 使用独立 POSIX 进程组，通过负 PID 发送信号；不能直接照搬为 Windows 进程树回收。 |
| Worktree 创建 | `core.ts` 通过 `env` 调用 `create-worktree.sh`；脚本依赖 Bash、Unix 工具及 Unix 绝对路径判断。 |
| Worktree 其他流程 | 列表、删除、切换和迁移已主要使用 Node.js、Git 和 Pi 原生能力，可保留主体逻辑；路径比较仍需统一核对。 |
| 测试与 CI | CI 仅在 Ubuntu 运行；工作树测试仍包含必跑 Bash、Unix 执行位断言和平台相关的命令入口。 |

现有机制见 [Monitor README](../../packages/pi-monitor/README.md)、[Worktree README](../../packages/pi-worktree/README.md) 与 [CI 工作流](../../.github/workflows/ci.yml)。

## 4. Monitor 调整

### 4.1 分离启动与回收，保持检查协议

保留现有调度、状态、回执和结果投递逻辑，将命令启动及进程回收的平台差异从执行器中分离。

命令启动采用 `cross-spawn`，准确版本由 Monitor 的 `package.json` 与根锁文件维护，不增加两个扩展之间的运行时依赖。保持以下契约：

- `command` 与 `args` 分离，不全局开启 `shell: true`。Windows 的 `.cmd/.bat`、命令查找和参数转义由明确的适配策略处理；确需 Shell 语法时显式使用对应解释器。
- stdin 仍提供一行包含 `monitorId` 与 `cursor` 的 JSON，例如 `{"monitorId":"...","cursor":null}`；stdout 仍须是一个 UTF-8 JSON 对象，诊断输出与其分离。
- stdout 与 stderr 合计输出上限、取消、超时、输出超限以及非零退出的现有语义不变。
- Windows 启动与清理检查进程时不弹出额外控制台窗口。

当前 Pi 公开的 `pi.exec()` 不提供此协议所需的 stdin 输入，也不具备与现有执行器等价的进程树回收语义，不能直接用它替换整个检查执行器。

### 4.2 Windows best-effort 回收边界

Windows 后端从系统目录调用 `taskkill.exe /T /F` 尝试结束当前检查进程树。POSIX 后端保留现有进程组及信号升级逻辑。

Windows 后端须满足以下要求：

1. 仅对当前运行器持有、尚未观察到退出的根进程发起回收。根进程已经退出时，不盲目使用旧 PID 重复补杀；这也意味着不能保证此时仍能找到其后代。
2. 处理清理命令的启动错误、退出结果和执行超时，有界等待，而不是启动清理命令后忽略结果。
3. 取消、超时、输出超限，或根进程退出但后代仍持有管道时，执行器均须有界收口，释放本地管道、计时器和监听器，不能无限等待 `close` 事件而占住检查队列。
4. 检查结果、取消原因与清理诊断分开处理。已知清理失败应记录或提示；无法确认后代状态时，不报告“整个进程树已清理”。
5. 不持久化 PID，不在 Pi 重启后尝试根据历史 PID 终止进程。

有界收口不是证明后代已经退出：它保证的是本地执行器不会因遗留进程或管道而无限阻塞。发现新事件、是否完成 one-shot 等业务判断，仍按现有检查协议处理。

### 4.3 调度与终端关闭

回收策略不改变正常调度：注册后立即安排首次检查；同一监听不重叠；正常情况下本轮结束后等待配置间隔再执行。共享并发、失败退避与暂停、`once`/`continuous`、模型忙时结果解释排队的现有行为保留。

| 情况 | 调整后的承诺 |
|---|---|
| 用户停止监听 | 停止后续检查，对当前检查发起 best-effort 回收。 |
| 检查超时或输出超限 | 本轮按检查失败处理并尝试回收；后续执行沿用既有退避与暂停规则，不因此宣称监听已经完成。 |
| Pi 正常执行会话关闭流程 | 请求取消当前检查并尝试回收，不把退出回调视为零残留保证。 |
| 关闭终端且 Pi 随之退出、Pi 崩溃或被强制结束 | 不再安排下一轮；当前检查及其后代可能残留。Pi 内部的超时计时器也随之消失，不能再承担后续清理。 |
| 仅终端窗口关闭，Pi 仍由其他进程管理工具保留 | 只要 Pi 仍在运行，监听可以继续，不能仅凭窗口关闭判定调度已停止。 |

停止本地检查不停止它所查询的远端 CI、构建或部署任务。本扩展不因此变成跨 Pi 进程存活的后台服务。

## 5. Worktree 调整

### 5.1 原生创建流程

将 `scripts/create-worktree.sh` 的核心逻辑迁入包内 TypeScript，直接使用 Node.js 文件和路径 API，以及现有 Git 参数数组执行入口：

1. 核对仓库、目标根目录、名称、分支、基准引用及钩子执行前提。
2. 执行已批准的 `before-create` 钩子（如有）。
3. 按 `new-branch`、`existing-branch` 或 `detached` 模式调用 `git worktree add`。
4. 在 linked worktree 的 Git 管理目录写入原格式的 Pi 所有权标记。
5. 执行已批准的 `after-create` 钩子（如有），复核 Git 登记、分支与标记，然后才安排会话迁移。

移除核心流程中的 `env`、Bash 和临时状态文件中转；失败阶段直接由 TypeScript 返回。`ownership` 或 `after-create` 失败仍保留已创建工作树供诊断，失败不迁移会话，不额外强制回滚用户分支或工作区。

Git 操作继续复用现有 `CommandRunner` 和适用的 Pi 公开能力；不另建 Git 管理系统，也不为本次改造增加两个包之间的运行时依赖。

### 5.2 POSIX 保留钩子，Windows 提前拒绝

首轮继续识别 `.pi/worktree/setup.sh`，不扩大钩子协议。用户已确认 Windows 可以不支持此钩子：

- 没有钩子的项目不需要 Bash，三种创建模式均走原生 Node.js/Git。
- Windows 发现钩子时，在创建工作树根目录、分支、目标工作树或执行钩子前明确报错，不探测 Bash，不静默跳过；安装 Git Bash 也不会改变这条边界。
- macOS/Linux 有钩子时仍须明确批准，并在每个执行阶段核对批准的内容标识，保留符号链接目标审查。
- POSIX 的 `before-create` 阶段先尝试运行 Bash；Bash 缺失时在 `git worktree add` 前失败。
- 保留阶段参数、`PI_WORKTREE_*` 环境、各阶段工作目录和不直接回显钩子输出的约定。

钩子需要自定义环境变量时，使用范围限定的执行适配器传入环境；不通过临时修改全局 `process.env` 影响其他并发操作。跨平台 Node 钩子如有实际需求，再另行明确入口、优先级和批准规则。

### 5.3 路径与持久兼容

统一创建、列表、删除、切换和迁移中的目录身份比较，覆盖：

- `~/` 与 `~\` 展开，盘符、斜杠、跨盘及 UNC 路径。
- Windows 保留设备名称，例如 `con`、`nul`，以及目标目录边界校验。
- 真实路径、大小写、符号链接和 junction 的行为。

这些项目既包含已发现的判断差异，也包含待实机验证的风险，不能据此声称它们当前全部会失败。不得一律将路径转为小写，也不得用简单字符串前缀比较替代目录边界判断。

保持默认工作树根目录及 `PI_CODING_AGENT_DIR` 推导方式、Git `--porcelain -z` 的 NUL 分隔解析，以及以下兼容约束：

- Git 管理目录内的 `pi-worktree-manager.json` 不改名，保留 `schemaVersion: 1` 与 ISO 格式 `createdAt`，已有工作树无需转换。
- 公开工具、命令和结果字段保持兼容；保留脏工作树、locked、当前会话目录及未合并关联分支的删除保护。
- 会话迁移继续使用 Pi 原生 fork/switch 能力，不调用 `process.chdir()`、不改写旧会话冒充新目录，也不创建第二套会话状态系统。

## 6. 实施顺序与直接影响范围

按以下顺序收口，不在兼容改造中夹带独立功能：

1. 固定命令执行、回收和路径比较契约，建立 Windows 测试入口及基础 fixture。
2. 迁移 Worktree 创建器，完成无钩子流程、Bash 钩子前置检查、失败阶段和持久格式验证。
3. 调整 Monitor 启动与 Windows 回收后端，保留 POSIX 行为，闭合正常失败与有界收口测试。
4. 收口 Windows CI、实际 tarball smoke 和使用文档，验证完成后才声明对应支持范围。

| 范围 | 实施时需同步的直接文件与消费者 |
|---|---|
| Monitor | `src/executor.ts`、`src/runtime.ts` 的平台限制及必要执行适配；执行器/生命周期测试；包依赖清单；README 与 `skills/wait-monitor/SKILL.md` 中的命令示例和回收边界。调度、状态与回执仅在直接受影响时调整。 |
| Worktree | `src/core.ts`、创建器和阶段错误；`worktree-repository.ts`、`worktree-utils.ts`、`worktree-ownership.ts`、`worktree-switch.ts`、`session.ts` 等路径消费者；原 Shell 集成测试、`run-smokes.mjs`、自动迁移与打包测试；包清单、打包文件列表和 README。 |
| 仓库 | `.github/workflows/ci.yml` 及其汇总门禁、可复用发布调用的必要适配；共享工程测试或脚本仅修改实际受影响的约束；根 README 的入口说明。 |

表中源码、测试路径分别相对于对应包目录。创建器迁移后，不再把 `.sh` 创建器作为必需运行资产；项目可选钩子的兼容性与包内创建器的移除分开处理。

## 7. 验证矩阵与完成标准

保留现有 Ubuntu 完整验证，新增 Windows 目标作业，先覆盖这两个包，而不是直接宣称整个仓库支持 Windows。Windows 分别使用 `.node-version` 的日常运行时与根 `package.json` `engines` 的最低支持版本。新增作业须进入现有 `verify` 汇总门禁，并核对 `release.yml` 对可复用 CI 的调用；不能新增一个失败也不阻止交付的旁路作业。

| 验证范围 | 必须覆盖 |
|---|---|
| 命令与协议 | 实际可执行文件、Windows 脚本入口、空格和中文路径、参数边界、stdin 游标、UTF-8 JSON、stdout/stderr 分离、合计输出上限。 |
| Monitor 生命周期 | 正常结果、非零退出、启动失败、取消、超时、输出超限、会话切换/关闭；清理命令失败和后代持管道时执行器仍有界返回。 |
| 平台回收差异 | POSIX 保留现有父进程退出后回收后代的断言；Windows 验证根进程存活时的正常树回收，以及根已退出时的有界返回和边界呈现，不强行宣称零残留。 |
| Worktree 核心 | 三种创建模式、名称与引用校验、所有权标记、旧工作树识别、列表/删除保护、会话切换和自动继续。 |
| 项目钩子 | 无钩子不需 Bash；Windows 有钩子提前拒绝且没有创建副作用；POSIX 无 Bash 提前失败、未批准或内容变化不执行，两阶段 cwd/环境及失败保留行为不变。 |
| 平台与打包 | Windows 路径和目录身份、symlink/junction 条件、真实 tarball 加载及创建/移除；不能只验证源码可加载。 |

测试调整要求：

- 将创建器的核心 Shell 集成案例迁为 Node 测试，不以跳过全部 Windows smoke 代替迁移。
- 用跨平台方式启动 npm 测试入口；核对外部解包工具的可用性。Unix 执行位断言仅在适用平台保留，不能因此跳过打包功能验证。
- 自动迁移 smoke 使用 Node 报告真实 cwd，避免以 Bash `pwd` 或 MSYS 路径作为统一预期。
- 符号链接权限等能力差异单独记录或按能力处理；不可整批跳过执行器或工作树安全测试。
- 允许产品在异常退出时残留，不代表允许测试污染宿主：fixture 进程必须由测试自身在清理阶段处理，不能任其在 CI 或开发机存活。

实施阶段按包执行 `typecheck`、`lint`、`test` 与打包验证，例如：

```bash
npm run typecheck -w @yefengr/pi-monitor
npm run lint -w @yefengr/pi-monitor
npm test -w @yefengr/pi-monitor
npm run typecheck -w @yefengr/pi-worktree
npm run lint -w @yefengr/pi-worktree
npm test -w @yefengr/pi-worktree
npm pack --dry-run -w @yefengr/pi-monitor
npm pack --dry-run -w @yefengr/pi-worktree
npm run check:docs
```

上述命令不能替代真实 tarball smoke。实施涉及 CI 或共享配置时，交付前还需按仓库规范运行 `npm run verify`，并取得 Windows 作业的实际结果。仅类型检查通过、注册成功或本机 Linux 测试通过，都不能作为 Windows 功能验收完成的依据。

命令启动库与 Windows 钩子边界已经落实。剩余平台证据须来自真实 Windows 作业和客户端，不能用 Linux 模拟补齐。

### 本轮实施验证记录

| 范围 | 实际状态 |
|---|---|
| Linux 本地完整验证 | Node 24.21.0 下 `npm run verify` 通过，涵盖所有包的类型、lint、测试、跨包契约、文档链接和打包内容。仅在验证子进程中移除了本机的 `PI_CODING_AGENT_DIR`，避免其他包的 HOME 隔离测试读入全局代理；未修改个人配置。 |
| 真实打包与会话 | 两包均完成真实 tarball 加载/执行；Worktree 包含创建/删除及真实 Pi 会话迁移后相对 `read` 的 cwd 验证，不只验证源码入口。 |
| 独立审查 | 通用与 Windows 专项审查完成；钩子 agent 目录环境兼容回退已修复，新增断言修前失败、修后通过。RPC 测试等待真实保存的回执确认，保留原断言。 |
| Windows Server CI | 主 Node 与最低 Node 的两包验证作业已接入 `verify` 门禁和可复用发布流程，尚未取得远端运行结果。 |
| Windows 10 / Windows 11 | 两个平台均待原生客户端实测；UNC、8.3 短名、junction 等路径能力按实际环境单独记录，不扩大承诺。 |

实现与本地验证阶段未执行提交、push 或 npm 发布；后续 Git 交付按用户授权单独执行。远端 Windows 作业与客户端验收不以本地通过替代。

## 8. Windows 10/11 客户端验收

Windows Server CI 与客户端分开记录。分别在 Windows 10、Windows 11 使用原生 PowerShell/终端，不借助 WSL 或 Git Bash：

1. 记录系统版本、构建号、Node/Pi/Git 版本，并核对命令均为 Windows 原生入口。
2. 在包含空格、中文的本地工作目录运行 `npm ci`，再运行两个包的 `typecheck`、`lint`、`test`（命令见上一节）；分别验证主 Node 与最低 Node。包测试已包含真实 tarball 加载和执行，不能只运行源码单元测试。
3. 在持久 Pi 会话检查 Monitor 的 `once`/`continuous`、停止/恢复、会话切换和正常关闭。检查 UTF-8 事件、stdin 游标、`.cmd/.bat` 与参数边界；清理失败时应有诊断，不应声称所有后代均已退出。
4. 分别创建、列出、迁移并移除三种模式的工作树；确认所有权识别、相对文件操作 cwd、脏目录/locked/未合并分支保护。需要 UNC、跨盘、大小写敏感目录或 junction 的使用环境，应单独验证并记录具体覆盖范围。
5. 准备含 `.pi/worktree/setup.sh` 的隔离项目，确认创建提前报错，没有新增分支、工作树或工作树根目录，也没有执行钩子；不用安装 Bash 绕过。
6. 终端关闭或 Pi 被强制结束时，只验证“不再调度下一轮”与诊断说明，不要求零残留。测试自行跟踪并清理 fixture，不使用历史业务 PID 补杀。

记录每个平台的通过、失败、跳过与原因；未执行的客户端、网络路径或权限场景保持待验收。本方案不包含自动发布，后续 Git 提交、push 或远端 CI 按单独授权执行。

## 9. 机制参考

- [Node.js：Windows 的 .bat/.cmd 启动要求](https://nodejs.org/docs/latest-v22.x/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
- [VS Code：通用进程树终止的平台分支](https://github.com/microsoft/vscode/blob/main/src/vs/base/node/processes.ts)
- [Execa：后代进程终止及 best-effort 边界](https://github.com/sindresorhus/execa/blob/main/docs/termination.md#killing-descendant-processes)

这些资料用于说明机制与取舍，不代表本项目已经采用对应库或完成 Windows 改造。
