# Pi 本地终端通知扩展

这是 [yefengr](https://github.com/yefengr) 维护的 Pi 本地终端通知扩展。它只通过当前终端支持的通知协议发送桌面通知，不调用 `terminal-notifier`、`notify-send` 或其他系统通知 Helper。

## 支持范围

当前只考虑宿主机直接运行的 Pi，不处理容器、SSH、tmux、screen 或 zellij。

| 终端 | 协议 | 标题和正文 |
|------|------|------------|
| Ghostty | OSC 777 | 独立 |
| WezTerm | OSC 777 | 独立 |
| kitty | OSC 99 | 独立 |
| iTerm2 | OSC 9 | 合并为一段文本 |

Apple Terminal.app、Linux 默认终端以及其他未列入白名单的终端不会发送通知。扩展不会使用固定系统图标作为回退，也不会猜测未知终端是否兼容某个协议。

终端协议写入成功只表示序列已提交给终端，不代表系统已经展示通知。终端本身的桌面通知设置仍然有效。

## 通知级别

扩展使用三个语义级别，并按级别设置默认显示时长：

| 级别 | 典型场景 | 默认时长 |
|------|----------|----------|
| `info` | 正常完成、会话结束、测试通知 | 5 秒 |
| `warning` | 输出达到长度上限、需要关注但非致命的状态 | 8 秒 |
| `error` | Agent、Provider 或工具异常 | 12 秒 |

kitty 的 OSC 99 会把级别编码为 `u=0/1/2`，并通过 `w=5000/8000/12000` 请求自动关闭；发送结果中的 `timeoutMs` 只在该协议实际携带时返回。Ghostty、WezTerm 和 iTerm2 使用的 OSC 777/9 不支持统一的级别和时长参数，因此仍服从终端及操作系统通知策略。扩展不发送常驻通知。

## 命令

| 命令 | 说明 |
|------|------|
| `/notify:settings` | 配置全局开关、Pi 生命周期事件和 recap |
| `/notify:recap-model` | 从当前 Pi 可用模型中选择 recap 模型 |
| `/notify:test` | 发送测试通知并显示 `sent`、`unsupported`、`disabled` 或 `failed` |

所有配置通过命令维护，不要求手动编辑 JSON。实际配置保存在：

```text
~/.pi/agent/config/notify.json
```

## 生命周期事件

扩展只监听 Pi 原生生命周期，不依赖其他扩展发出的事件。

| 事件 | 默认状态 | 说明 |
|------|----------|------|
| `agent_end` | 关闭 | 单次 Agent 运行结束，重试时可能重复触发 |
| `agent_settled` | 开启 | Agent 在重试、压缩和排队续接全部结束后完成 |
| `session_shutdown` | 关闭 | 会话结束 |

`/notify:settings` 可以修改全局开关和上述事件开关。关闭全局开关后，生命周期事件会静默跳过，并返回 `disabled` 状态。

`agent_settled` 会根据最终运行结果使用不同级别：正常完成发送 `info`，输出达到长度上限发送 `warning`，其他异常发送 `error`。明确的手动中止不会发送桌面通知。

## Agent 工具

工具名：`notify_user`

```ts
notify_user({
  title: "构建失败",
  message: "TypeScript 编译失败，请检查构建日志。",
  level: "error"
})
```

工具接受 `message`、可选的 `title` 和可选的 `level`；`level` 可为 `info`、`warning` 或 `error`，默认 `info`。工具同步返回以下状态：

- `sent`：通知序列已写入当前终端；
- `unsupported`：当前终端不在支持白名单中，或标准输出不是 TTY；
- `disabled`：全局通知已关闭；
- `failed`：终端协议序列写入失败。

只有 `sent` 会触发 `pi-notify:sent` 事件。返回详情和发送事件包含实际级别；仅 kitty OSC 99 包含已应用的 `timeoutMs`。

## Recap

Recap 默认关闭，只对正常完成的 `agent_end` 和 `agent_settled` 通知生效。开启后，扩展会把最后一条 Assistant 回复发送给通过 `/notify:recap-model` 选择的模型，并生成一句通知摘要。异常终止直接使用实际错误，不调用 recap 模型；明确的手动中止不发送通知，也不调用 recap 模型。

在调用模型前会先检测当前终端是否支持通知协议。不支持时不会调用模型，也不会产生额外费用。模型请求失败、没有 API Key 或返回空内容时，会回退到确定性的生命周期消息。

开启 recap 会产生额外模型调用，并可能把 Assistant 回复中的内容发送给所选模型服务。请通过 `/notify:settings` 明确开启。

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
