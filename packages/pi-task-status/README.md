# Task Status

`@yefengr/pi-task-status`：从 agent-tools 本地扩展迁入的独立 Pi package，目前尚未发布。需要 Pi >= 1.5.1 和 Node.js >= 22.19.0；发布后再安装使用，开发阶段不接入当前 Pi。

## 提示词与子代理

扩展通过命名的 `systemPromptOptions.sections.task_status` 集中注入任务维护规则，工具元数据只说明用途和参数，不重复注入更新时机策略。扩展不返回完整 `systemPrompt`；规则随每轮可用工具更新，未启用 `update_task_status` 或进入效率复盘时移除该区块。

总体任务状态由主代理维护。发布后，在全局或项目的 `subagents.json` 中使用现有 `excludedExtensionPackages` 排除此包，避免子代理加载扩展、恢复任务状态或执行会话命名。例如，Pi 的 `settings.json` 中安装来源为 `npm:@yefengr/pi-task-status@0.1.0` 时，对应配置为：

```json
{
  "excludedExtensionPackages": ["npm:@yefengr/pi-task-status@0.1.0"]
}
```

排除值必须与 `settings.json` 的 `packages` 来源字符串完全一致，包括版本；已有其他排除项时追加到原列表。配置说明见 [Subagents 包排除规则](../pi-subagents/docs/configuration.md#excluding-package-extensions-from-children)。

包排除与提示词继承分别处理：子代理没有 `update_task_status` 时，配套的 Subagents 继承逻辑会移除父会话的 `task_status` 区块；工具描述与工具指导语由 SDK 按子会话工具集生成。仅移除提示词不会阻止扩展加载，因此仍需配置包排除。该兼容调整包含在 Subagents 0.4.1 中；发布后使用 Task Status 时需同时安装 Subagents >= 0.4.1，0.4.0 不会清理继承区块。

## 功能

由模型通过 `update_task_status` 维护当前任务的名称、状态、阶段和整体进度，并把同一份信息使用与 Pi footer 一致的 `dim` 主题色展示在状态栏（key 为 `task-status`）。扩展在接受任务状态更新后，使用同一份规范化任务名称自动命名未被手动接管的会话。项目目录由 Pi 自身的 footer 和终端标题展示，Git 分支由 footer 展示。工具正常结果默认折叠，展开提示与结果位于同一行，使用 `Ctrl+O` 可展开完整更新信息。

扩展把每次有效更新作为 `task-status-state` custom entry 写入当前会话 branch，写入成功后再更新扩展内存状态、状态栏和会话名称；写入失败可重试，不消耗扩展的更新计数。恢复会话、切换 branch 或 fork 时，从活动 branch 中最后一个有效状态恢复。

尚无有效任务时，状态栏显示“尚无任务”。进行中、等待用户或阻塞时，进度表示模型对整个任务的粗略估计，例如“修复扩展 · 进行中（实现，估计 40%）”；完成后显示“已完成（交付，100%）”。这些文案不改变持久化的进度数值。

## 工具参数

`taskTransition`、`status` 和 `progressPercent` 每次必填。首次创建任务时，无论使用 `new` 还是 `continue`，都必须提供 `taskName` 和 `phase`；已有任务使用 `continue` 时，可以省略未变化的名称和阶段，扩展会沿用当前任务的值。例如：

```json
{
  "taskTransition": "continue",
  "status": "completed",
  "phase": "交付",
  "progressPercent": 100
}
```

上例沿用已有任务名称，将阶段改为“交付”。`continue` 也可以显式修改名称；`new` 必须重新提供名称和阶段，不继承旧任务字段。名称和阶段须为非空字符串，显式空白会被拒绝；可选字段的 `null` 按 SDK 参数归一化规则视为省略。原有每次提供完整参数的调用仍然有效。

参数 schema 列举允许的进度值 `0, 10, …, 100`，运行时进一步校验：非 `completed` 状态只能使用 `0–90`，`completed` 必须为 `100`。省略字段后的有效内容若没有变化，不增加更新计数。

## 更新时机

预计 10 分钟内完成的短任务通常只在首次识别任务和完成前更新；等待用户输入或外部问题解决时立即进入 `waiting_for_user` 或 `blocked`，恢复工作时立即回到 `in_progress`。已完成的交付目标因用户反馈继续处理时，沿用 `taskTransition=continue`、原任务 ID 和更新计数，并重新估算进度；只有主要交付目标变化后才使用 `taskTransition=new`。长任务只在状态、任务范围或整体进度显著变化时更新，不为普通读取、编辑、测试、暂存或提交阶段单独更新。

## 会话名称

自动名称跟随当前主要任务，`continue` 修正任务名称也会同步；同名、仅状态或进度变化不会追加名称记录。扩展使用原生 `setSessionName` / `getSessionName`，通过独立的 `task-status-session-name` custom entry（`version: 1`、`sessionInfoId`、`name`）关联原生名称记录 ID，不改变 `task-status-state` v1。

用户或其他扩展改名优先，包括改成同名或清空名称；已有名称但无法证明自动归属时不覆盖。首次无名称且无清空历史的会话才可自动命名。归属从全会话记录核验，不随任务 branch 回退；启动、恢复、`/reload` 和切换 branch 只恢复任务状态，不读写名称。

非法或超限更新不会改名。名称更新失败时返回明确警告，保留已成功持久化的任务状态；不额外调用模型或增加工具。

## 配置

可选配置文件：`~/.pi/agent/task-status.json`

```json
{
  "maxUpdatesPerTask": 20
}
```

`maxUpdatesPerTask` 默认 `20`，允许 `1–1000` 的整数；配置缺失、无效或读取失败时使用默认值。设置了 `PI_CODING_AGENT_DIR` 时，配置文件位于该目录下。配置在会话启动和 `/reload` 时读取，不支持项目级覆盖。

该值限制每个任务的普通更新。达到阈值后，同一状态下修改名称、阶段或进度会被拒绝，实际状态切换仍然允许，包括反复等待、阻塞、恢复、完成及重新打开已完成任务。因此有效更新总数可能超过配置值；内容未变化的调用不增加计数。同一任务使用 `continue` 保留计数，创建新任务时才重置。

## 任务效率复盘

带有 `task-efficiency:source` custom entry 的独立复盘会话不维护任务状态。扩展会停用 `update_task_status`，跳过状态栏提示注入、状态恢复和会话名称读写，并清除该扩展的 footer 状态；普通会话行为不变。
