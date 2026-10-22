# @yefengr/pi-task-efficiency

[yefengr](https://github.com/yefengr) 维护的 [Pi](https://pi.dev) 任务效率复盘扩展。它在独立会话中复盘已经完成的任务，输出可核验的时间、Token、费用、工具和子代理指标，并把改进建议落到具体文件或规则上。

## 安装

要求 Node >= 22.19、Pi 1.x。

```bash
pi install npm:@yefengr/pi-task-efficiency
```

安装后运行 `/reload` 或重启 Pi。包内同时提供 package-bundled skill `analyze-task-efficiency`，Pi 会在安装后自动发现。

## 使用

```text
/task-efficiency
```

该命令新建独立复盘会话，不替换当前工作会话。复盘流程固定为四步：

1. `task_efficiency_read_scope_page` 读取最新的紧凑任务范围页。
2. `task_efficiency_propose_scope` 提交完整候选范围，等待用户确认或修正。
3. 边界仍有歧义时用 `task_efficiency_expand_scope` 读取有界详细片段。
4. 用户确认后调用 `task_efficiency_analyze`，只依据返回的确定性报告撰写复盘。

模型不自行计算指标，也不把模型文字当作确认。范围未确认前不能生成报告。

## 指标口径

- 时间为父会话、子代理与合并后的确定性区间，不使用模型估算。
- `usage` 分别展示 `parent`、`children` 与 `combined`；`reasoning` 是 output 的子集，不重复累计。
- 费用只汇总 Pi 会话 JSONL 中已持久化的 `usage.cost`，不维护价格表。
- 复盘会话自身开销与源任务成本隔离，不混入源任务指标。
- `coverage.complete` 只表示报告要求的核心字段完整，不包含可选字段。

## 只读边界

扩展只读取 Pi 已持久化的会话记录，不修改项目、配置、memory、sample 或 observation。复盘产出的改进建议只作为建议，不直接写入文件。

## 开发

```bash
npm ci
npm run typecheck
npm test
```

TUI smoke：

```bash
npm run test:tui-smoke
```

## 许可

MIT，见 [LICENSE](./LICENSE)。
