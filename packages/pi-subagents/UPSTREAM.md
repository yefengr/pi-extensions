# 上游来源

`packages/subagents/` 由 agent-tools 独立维护，不在运行时依赖第三方 npm 包。

## 基线

- 上游仓库：[`gotgenes/pi-packages`](https://github.com/gotgenes/pi-packages)
- 上游目录：`packages/pi-subagents`
- npm 包：`@gotgenes/pi-subagents@19.3.4`
- Git 标签：`pi-subagents-v19.3.4`
- Git 提交：`b330769ec96928479941543d196eeafcbc6489d0`
- npm tarball SHA-1：`43fc057ead921e33b9fd544df81d1f2d257b0b01`
- 许可证：MIT，原始版权声明保留在 [`LICENSE`](./LICENSE)

GitHub 标签、npm Registry 的 SLSA provenance 和 npm tarball 均指向或验证了上述提交。本地迁移前还逐文件核对了 npm tarball 与已安装的 `19.3.4`：两者均为 95 个文件且内容完全一致。tarball 与上游提交的共同文件中，除发布流程生成的 `package.json` 外内容一致；`dist/public.d.ts` 和 `dist/settings.d.ts` 是构建产物。

## 迁入范围

迁入：

- 完整 `src/` 与 `test/`。
- npm 发布范围内的 README、CHANGELOG、配置、架构与决策文档。
- 类型声明构建、公开类型验证和 Vitest 配置。
- 原始 MIT LICENSE。

不迁入：

- 上游仓库级配置、workspace、lockfile 和共享脚本。
- 上游 `.pi/`、`AGENTS.md` 等开发 harness 配置。
- 上游 `docs/plans/`、`docs/retro/`、媒体文件及其他历史开发产物。
- `node_modules/` 与生成的 `dist/`。

## 本地适配

- 包名改为 `agent-tools-subagents`，版本从 `0.1.0` 独立演进，并设置为 private，避免误发布。
- 使用 npm 和 package-local lockfile，不依赖上游 pnpm workspace 或 catalog。
- `tsconfig.json`、Biome 配置和测试入口改为自包含；不迁入上游 monorepo 的 ESLint、rumdl、fallow 与 release 工具链，本地门禁为 Biome、TypeScript、完整 Vitest、声明构建和打包后消费者类型检查。
- Pi 核心包以 peer dependency 声明，开发验证固定到当前仓库使用的 Pi `0.85.1`。
- 工具 schema 从旧 `@sinclair/typebox` 切换到 Pi 当前提供的 `typebox` peer。
- Pi `0.85.1` 已以 `ModelRuntime` 取代 `createAgentSession()` 的旧 `modelRegistry` 参数；本地实现创建独立 child runtime，并参考后续上游修复提交 [`f805ffc4a6ae1849c4d396cd7697f09ea38b6ec6`](https://github.com/gotgenes/pi-packages/commit/f805ffc4a6ae1849c4d396cd7697f09ea38b6ec6) 复制父会话运行时 provider 注册。
- 跨扩展 service key 与文档示例使用本地包身份，不提供旧包名兼容入口。
- 生命周期公共事件与 `subagents:record` 持久化改为本项目唯一支持的 v2 契约：稳定 `sessionId`、逐调用身份、逐调用 usage/tool-use 窗口和 lifetime 累计分层，不兼容旧 payload。
- fresh/resume 的父工具调用分别记录当次 `toolCallId`；service 调用使用显式 `invocationSource: "service"`，不伪造工具调用 ID。
- 公开类型验证改用 npm，并在临时消费者中验证打包后的声明文件。

后续同步上游时必须重新核对许可证、来源提交、实际差异和本地契约；不得直接用上游最新 HEAD 覆盖本地实现。
- 2026-10 迁出 agent-tools，作为 `@yefengr/pi-subagents` 发布到 npm，取消 private；版本从 `0.1.0` 继续独立演进，跨扩展服务身份同步改为 `@yefengr/pi-subagents:service`。
- 开发验证基线升级到 Pi `1.4.0` 与 `typebox` `1.3.27`，与当前运行环境一致；host 包仍以 `*` 声明 peer。
