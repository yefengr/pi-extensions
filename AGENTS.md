# pi-extensions — Monorepo

本仓库包含 yefengr 维护的 Pi 扩展。每个包是独立的 npm 包，可以单独安装。

## 项目结构

| 目录 | 职责 |
|---|---|
| `packages/pi-notify` | 通过终端 OSC 协议发送本地通知 |
| `packages/pi-monitor` | 后台命令监听与一次性/持续检查 |
| `packages/pi-task-efficiency` | 任务效率复盘、固定范围确认与确定性指标 |
| `packages/pi-subagents` | 进程内子代理运行时，含后台执行、steering、resume 与生命周期事件 |
| `scripts/` | 发布计划、产物校验、GitHub Release 和文档链接检查 |
| `.github/workflows/` | CI、npm 待审发布、发布后创建 Release |

`scripts/release.mjs` 中的 `PACKAGES` 是发布包清单的唯一真源；新增、删除或重命名包时同步修改它和本文件的结构表。

## 常用命令

```bash
npm install
npm run verify        # typecheck + lint + 全部测试 + 文档链接 + 打包内容
npm run typecheck
npm run lint
npm test
npm run check:docs
npm run pack:dry-run
```

单包验证使用 `npm test -w @yefengr/<包名>`、`npm run typecheck -w @yefengr/<包名>`、`npm run lint -w @yefengr/<包名>`；`pi-subagents` 的测试使用 vitest，其余包使用 Node 内置测试运行器。所有包继承根 `tsconfig.base.json` 和 `biome.json`，局部配置只保留文件范围、别名和必要的互操作选项，不重复覆盖共享选项。保留各包适合其职责的内部结构，不为统一目录而搬迁源码。

跨包记录变更必须同步直接消费者，并在 `scripts/contracts/` 用真实生产函数的序列化输出验证解析、投影和统计；使用 `npm run test:contracts` 单独运行，该验证也包含在根 `npm test` 中。历史数据的读取兼容须明确保留，不能只修改生产端。只运行与当前改动相关的命令，跨包协议、共享脚本或发布配置变更时运行 `npm run verify`。

## CI

`.github/workflows/ci.yml` 按改动类型拆分：

- `changes` 判断是否只有文档改动；
- `docs` 检查改动中的空白错误和已跟踪文档的站内链接；
- `checks` 在代码改动时于 `.node-version` 运行时上运行 `npm run verify`；
- `compat` 在 Node 22.19（根 `package.json` 的 `engines` 下限）上运行同一套 `npm run verify`；
- `verify` 汇总以上任务，是 `main` 分支保护要求的唯一检查。

调整根 `verify` 或包脚本时同步修改工作流。`release.yml` 通过 `workflow_call` 复用同一套检查。

## 发布

发布使用手动语义化版本和 npm Trusted Publishing（GitHub Actions OIDC），不需要 npm token。`.node-version` 是日常开发、CI 主流程与发布打包的主版本；Node 22.19 是 `engines` 声明的最低支持版本，由 CI 的 `compat` 作业单独验证。推送 `main` 且某个包的 `package.json` 版本变化时，`release.yml` 会：

1. 比较版本并查询 npm registry，跳过版本未变或已公开的包；
2. 运行可复用的 CI 检查和包的 `prepublishOnly`，打出 tarball 并校验身份；
3. 用 `npm stage publish` 把 tarball 提交到 npm 待审区；
4. 为本次提交创建 `<包目录>-v<版本>` 注解标签，例如 `pi-notify-v0.3.4`。

提交待审不等于公开上线；维护者需在 npmjs.com 的 Staged Packages 中核对并用 2FA 批准。批准后由 `.github/workflows/github-release.yml` 定时检查 npm，版本上线后基于已有标签创建 GitHub Release；定时运行时标签缺失会输出警告并跳过，手动运行会失败并提示先补打标签。完整步骤与故障处理见 README 的 Publishing 部分。

发布顺序：先发布被其他包依赖的包，再发布消费者；同一版本不要重复提交，已存在待审条目时先处理旧条目。

## 依赖更新

Dependabot 每周为 npm 依赖和 GitHub Actions 开升级 PR，不自动合并。安全告警按以下顺序处理：

1. 用 `npm ls <包>` 或 `npm explain <包>` 找到引入路径，判断是否进入发布产物；
2. 优先在现有版本范围内更新锁文件：`npm update <包>`；
3. 仍不满足修复版本时，在根 `package.json` 的 `overrides` 中设修复后的最低版本，不跨大版本；
4. 确认锁文件不再包含漏洞版本，运行 `npm run verify` 后提交 PR。

## 文档

- `README.md` 是项目入口，面向使用者；`CONTRIBUTING.md` 面向贡献者；`SECURITY.md` 说明漏洞报告范围。
- 本文件只记录项目协作、命令、发布和验证规范，不复制全局协作规范。
- 同一事实只保留一个权威来源；改动文档后运行 `npm run check:docs`。
- `.pi/` 只存放当前任务的临时产物，不进入版本库。
